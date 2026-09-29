# Operations Guide

Repository-specific runbook for the Workers-only EmDash deployment: Astro SSR on
Cloudflare Workers, D1 (`DB`) for content, R2 (`MEDIA`) for media, KV
(`SESSION`) for sessions. See `AGENTS.md` and `docs/newsletter.md` for context.

Placeholders used throughout:

- `<WORKER_NAME>` — Worker name from `wrangler.jsonc` after provisioning
- `<D1_DATABASE_NAME>` / `<D1_DATABASE_ID>` — D1 database name/id from `wrangler.jsonc`
- `<R2_BUCKET_NAME>` — R2 bucket name from `wrangler.jsonc`
- `<HOSTNAME>` — final canonical hostname (e.g. `https://example.com`)
- `<STAGING_HOSTNAME>` — staging origin; must be a separate Worker + separate D1/R2/KV

## Scope: local vs. production

This guide covers deployment and production operations only. Local development
needs none of it: `bun run cf:dev` runs `wrangler dev --local --port 8787`,
simulating D1/R2/KV with state in `.wrangler/state`, and requires no configured
remote bindings, no Cloudflare account, and no provisioning. The committed
`siteConfig.url` is `http://localhost:8787` — a functional local default, not a
missing hostname — and must be replaced with your canonical HTTPS URL before
any production deployment. Do not run any step in this guide to make local
development work.

`bun run cf:dev` provides its own temporary local bootstrap secret and opens the
authorized setup page, so local first-admin setup needs no manual step and no
`.dev.vars` entry. The bootstrap URL redirects to a clean setup URL before the
wizard loads, so you do not need to keep the initial URL; the credential stays
reusable until the secret is changed or removed, or - for the temporary local
secret - until the local Worker restarts.

`.dev.vars` remains optional and is only for pinning your own local values (a
fixed `EMDASH_BOOTSTRAP_SECRET`, an `EMDASH_ENCRYPTION_KEY`, newsletter keys) or
for trying other local options. Presence of the file is what matters: while a
`.dev.vars` file exists, `cf:dev` does not mint its own secret, so the file must
contain a usable 32+ byte `EMDASH_BOOTSTRAP_SECRET` and you open the setup URL
with that value yourself. An empty or too-short value leaves local setup
unavailable (HTTP 503) until you either set a valid value or delete the file, and
deleting the file restores the automatic handoff.

## 0. Provisioning gate (read before any setup)

Never provision, attach a domain, or deploy without explicit approval.

1. Confirm the intended Cloudflare account. Setup discovers the accounts your
   Wrangler login can reach, asks when more than one matches, shows the chosen
   account in the printed plan, and accepts `--account <id>` to pin the
   32-character account ID up front.
2. Provide Cloudflare authentication for this setup run. The default is the
   account you signed in with:

   ```sh
   npx wrangler login
   ```

   Setup captures that OAuth session itself and offers to run the login if no
   session exists. No credential file is required.

   An account-scoped `CLOUDFLARE_API_TOKEN` is the alternative. It must have
   only the permissions required for this setup: Account Settings Read, D1
   Edit, Workers R2 Storage Edit, Workers KV Storage Edit, and Workers Scripts
   Edit. Workers Routes Edit is also required for a standard production
   deployment, because setup attaches the custom domain.

   To supply it, create the ignored `.env.cloudflare.local` from the tracked
   example, fill in `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in your
   editor, and let the run load it:

   ```sh
   install -m 600 .env.cloudflare.local.example .env.cloudflare.local
   ```

   ```sh
   bun run --env-file=.env.cloudflare.local cloudflare:setup
   ```

   This is opt-in and stores the account-scoped token in plaintext on disk until
   you delete the file; mode 0600 keeps it readable by your user only. Treat it
   as throwaway state. The file is loaded into that command's environment only.
   Never paste the token into a chat message or a command line, and never let
   the value reach `wrangler.jsonc`, `.dev.vars`, the journal, committed files,
   or logs. The setup script reads the variables from the environment and never
   reads or stores the file itself. Exporting `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` into the terminal for the run remains an accepted
   alternative that writes no file at all.

   Once setup and bootstrap-secret removal succeed and no retry is pending,
   delete `.env.cloudflare.local` and revoke or delete the token in Cloudflare.
3. Confirm the final canonical hostname with the site owner and verify it lives
   in an active Cloudflare zone owned by that account.
4. Obtain explicit approval before creating resources, attaching the custom
   domain, or deploying.
5. Generate both deployment secrets and save the resulting *values* in a
   password manager before the setup run. Save the values themselves, not the
   commands. Setup prompts for each saved value through hidden input; it does
   not generate them for you.

   `EMDASH_ENCRYPTION_KEY` must match EmDash's `emdash_enc_v1_` envelope: the
   prefix followed by 43 unpadded base64url characters (32 random bytes,
   alphabet `A-Z`, `a-z`, `0-9`, `-`, `_`). EmDash's own generator prints a
   correctly formatted value:

   ```sh
   npx emdash secrets generate
   ```

   `EMDASH_BOOTSTRAP_SECRET` is a raw base64url body with no prefix:

   ```sh
   printf '%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
   ```

   Store both values in the password manager. Never commit them, never paste
   them into a chat, and never pass them on a command line. Losing the
   encryption key permanently loses every secret encrypted with it.
6. Only then set `src/site.config.ts` to `https://<HOSTNAME>`, or answer the
   `Canonical HTTPS origin:` prompt during setup, which writes the same value.
   You do not edit `wrangler.jsonc` by hand: setup reconciles `account_id`, the
   Worker name, the D1/R2/KV binding IDs, the newsletter bindings when enabled,
   and the custom-domain `routes` entry, and it refuses to proceed on a
   conflicting configured value.

Run `bun run cloudflare:setup` only from the scaffolded site project being
deployed in an interactive terminal. The command requires the approved account,
verifies it through the Cloudflare API, writes the account ID into the Wrangler
configuration without storing any credential, and binds every Wrangler
operation to that configuration/account. It uses the Wrangler login session by
default and an account-scoped token when one is supplied; it never reads
Wrangler's credential files itself. It uses account APIs for R2 and KV
discovery and never parses unsupported human-oriented list output. Do not deploy
while placeholder IDs remain in `wrangler.jsonc`; the setup script rejects
partial or unrecognized core bindings. Registrar transfers and DNS hosted
outside Cloudflare cannot be automated here.

Before deployment, verify that `src/site.config.ts` contains the final HTTPS
canonical origin. The script refuses to deploy without it and never uses a
`workers.dev` fallback. Deployment runs interactively so Wrangler can show its
normal prompts and output.

Provisioning is resumable. The command writes only non-secret state to an
atomic journal under `.wrangler/provisioning/` and revalidates every remote
resource before continuing. It never generates `EMDASH_ENCRYPTION_KEY` or
`EMDASH_BOOTSTRAP_SECRET` for you: it prompts for the saved values (§0 step 5)
through hidden input and keeps only their journal state, never the values.
Nothing is created until you approve the printed plan; that single approval
covers the account, the derived resource names, the custom domain, the
deployment, and the cron triggers. There is no separate account, deployment, or
trigger re-approval.

On a genuinely new Worker, Wrangler's `versions upload` needs one prior
deployment to exist, so setup first deploys an inert base Worker: a generated
`503` responder whose private bootstrap config sets `workers_dev: false` and
`preview_urls: false` with no routes, triggers, or assets. This one-time step
serves no site content and is never publicly reachable; it is only a
prerequisite for versioning, and setup verifies the deployment exists remotely
before continuing.

It then builds the real Astro output, uploads the prepared version against
`dist/server/wrangler.json` rather than the root template config, adds secrets
through `wrangler versions secret put`, applies and verifies migrations, and
finally deploys exactly that prepared version at 100% traffic. It then runs the
separate interactive `wrangler triggers deploy` phase for the reconciled custom
domain, route, and cron triggers before verifying the deployment identity,
bindings, custom-domain attachment, and canonical origin. An uninitialized site
must return either a same-origin setup redirect at `/_emdash/admin/setup` or a
public homepage with that setup route protected by the bootstrap gate. Setup
does not accept an arbitrary successful or cross-origin response.

If canonical-origin verification fails right after the custom domain is
attached, rule out DNS propagation or a stale local negative cache before
changing Worker code or config. Compare an external resolver against your local
default. These checks are read-only and non-secret:

```sh
dig +short <HOSTNAME> @1.1.1.1
dig +short <HOSTNAME>
curl -sS -o /dev/null -w '%{http_code}\n' --resolve <HOSTNAME>:443:<IP> https://<HOSTNAME>/
```

If the public resolver already returns the Cloudflare anycast IPs while your
local resolver returns nothing or an unrelated address, the Worker, route, and
`siteConfig.url` are likely correct and only local resolution is behind: wait
out the record TTL, or flush your resolver's own cache (macOS:
`sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`; Linux with
systemd-resolved: `resolvectl flush-caches`) and retest. A same-origin setup
redirect is not a substitute for a verified canonical origin: do not relax the
check or deploy with a `workers.dev` fallback to work around this. If both
resolvers already agree on the expected anycast IPs and verification still
fails, treat it as a real Worker or routing problem and continue diagnosing the
deployment.

If a resource create, secret upload, migration, deployment, or browser handoff is
interrupted, rerun `bun run cloudflare:setup`; it will not retry an ambiguous
resource create or silently rotate a secret. A pending secret operation requires
the value saved in the password manager, and an existing encryption key that
cannot be recovered blocks setup rather than being replaced. No automatic
rollback or deletion is performed. A lock left by a terminated process is not
removed automatically; confirm no setup process is running before removing it
manually.

Before uploading `EMDASH_ENCRYPTION_KEY` and, for a first-admin bootstrap,
`EMDASH_BOOTSTRAP_SECRET`, the script prompts for each saved value (§0 step 5)
through hidden input: nothing is echoed, logged, or written to disk, and the
raw base64url is uploaded with `wrangler versions secret put` to the prepared
version. If `EMDASH_ENCRYPTION_KEY` is already set on the approved Worker, setup
inherits it instead of prompting. An empty value is rejected and setup never
invents a replacement.
It opens the bootstrap URL on that canonical origin in the
default browser; if that is unavailable, it copies the URL to the clipboard
without printing it. Complete setup on that canonical origin. The URL redirects
to a clean setup URL before the EmDash wizard loads, so do not bookmark or reuse
the initial URL as a browser location.

That provisioned bootstrap secret is used only when the current CMS database is
not both setup-complete and administrator-initialized. A completed site remains
revoked if its bootstrap secret was manually removed; rerunning setup never
recreates it. The bootstrap URL credential remains reusable while that secret is
configured; only the signed HttpOnly cookie expires after 15 minutes. If browser
and clipboard handoff are unavailable, setup does not print the URL: use the
saved secret for an operator-controlled direct handoff and rerun setup.

## 1. Backups before upgrades

### 1a. Remote D1 export (required before every upgrade/migration)

```sh
mkdir -p backups/d1
bunx wrangler d1 export <D1_DATABASE_NAME> --remote --output backups/d1/<D1_DATABASE_NAME>-$(date +%Y%m%d-%H%M%S).sql
```

Verify the export is non-empty and record its timestamp; this file is the
rollback anchor for any schema or content change.

### 1b. R2 backup via rclone

Configure an rclone remote for the R2 bucket once (credentials live outside the
repository), then sync:

```sh
rclone sync :rclone:<R2_BUCKET_NAME> /path/to/backups/r2/<R2_BUCKET_NAME> --backup-dir /path/to/backups/r2-archive/$(date +%Y%m%d-%H%M%S)
```

Or, with a named remote:

```sh
rclone sync <RCLONE_REMOTE>:<R2_BUCKET_NAME> /path/to/backups/r2/<R2_BUCKET_NAME>
```

Keep at least one pre-upgrade snapshot; never treat the live bucket as the only copy.

## 2. Restore and rollback constraints

- D1 exports restore via import into a **new** database, then re-binding:
  there is no in-place point-in-time restore from a SQL export. Restoring means
  creating `<D1_DATABASE_NAME>-restore`, importing the export, updating
  `database_id` in `wrangler.jsonc`, and redeploying.
- EmDash core migrations are forward-only in practice: do not attempt to
  downgrade the Worker against a newer schema. Roll back code **and** data
  together using the pre-upgrade export from §1a.
- Changed `.emdash/seed.json` values do not mutate existing sites; seeds only
  initialize empty databases. Fixing bad CMS content is a data operation, not a
  redeploy.
- R2 restores are per-object syncs from the rclone snapshot; re-upload rather
  than attempting bucket-level versioning assumptions.
- Session KV is ephemeral; never back it up or restore it. Expect all admin
  sessions to be invalidated by a restore.

## 3. Staging vs production isolation

- Staging is a fully separate Worker with its own D1, R2, and session KV. Never
  point a staging Worker at production bindings, and never share a D1 database
  across environments.
- `*.workers.dev` URLs are temporary testing only. They are a different WebAuthn
  origin from the custom domain and must never receive the production passkey.
- Test migrations, seed changes, and EmDash runtime upgrades on staging first,
  including a full §1 backup of staging before touching production.
- Per-environment bindings in one `wrangler.jsonc` must repeat every binding per
  environment (see `docs/newsletter.md`); partial duplication silently binds
  production resources to preview deploys.

## 4. Public R2 media

Media is served through the Worker's `MEDIA` R2 binding (EmDash media routes);
the bucket is not publicly exposed and has no enabled `r2.dev` public access.
Consequences:

- Do not enable public bucket access or `r2.dev` domains; media URLs stay on
  `<HOSTNAME>` so caching, headers, and availability follow the Worker.
- Media availability depends on the Worker being deployed and healthy; a broken
  deploy takes media down with it. Verify media URLs during post-cutover checks.
- Backups/restores of media go through rclone snapshots (§1b), not bucket ACLs.

## 5. Production passkey (custom domain only)

The EmDash setup wizard and its production passkey belong exclusively on the
final canonical hostname:

1. After provisioning, use the browser session opened by the provisioning
   command. If opening the browser was unavailable, use the copied bootstrap URL
   and supply the generated bootstrap value through that initial request only.
   The request redirects to a clean `/_emdash/admin/setup` URL before the
   wizard loads.
2. On the first wizard screen, decide whether to include sample content: both
   including and clearing **Include sample content (recommended for new
   sites)** are supported; schema, settings, and navigation are applied either
   way. This choice belongs to the site owner.
3. Register the production passkey only on `<HOSTNAME>`. Never register it on a
   `*.workers.dev` origin — WebAuthn credentials are origin-bound and will not
   transfer.
4. After the first administrator is initialized, remove the bootstrap secret:

   ```sh
   npx wrangler secret delete EMDASH_BOOTSTRAP_SECRET --name <WORKER_NAME>
   ```

   This revokes any remaining bootstrap cookies and prevents another first-admin
   bootstrap attempt. Always pass the approved `--name`; a bare command targets
   the placeholder Worker name `minastro-template`. Run it before deleting or
   revoking the setup credential; with the optional token file, use
   `bun run --env-file=.env.cloudflare.local wrangler secret delete
   EMDASH_BOOTSTRAP_SECRET --name <WORKER_NAME>`. If setup must be recovered
   before an administrator exists,
   or the site is reset and setup is being reopened, configure a newly generated
   Base64URL secret with Wrangler before reopening setup; changing the secret
   invalidates previously issued cookies. Keep the replacement out of shell
   history and logs. A safe rotation flow is:

   ```sh
   BOOTSTRAP_SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
   if printf '%s\n' "$BOOTSTRAP_SECRET" | bunx wrangler secret put EMDASH_BOOTSTRAP_SECRET --name <WORKER_NAME>; then
     BOOTSTRAP_URL="https://<HOSTNAME>/_emdash/admin/setup?bootstrap=${BOOTSTRAP_SECRET}"
     BOOTSTRAP_HANDOFF_READY=0

     if command -v open >/dev/null 2>&1 && open "$BOOTSTRAP_URL"; then
       BOOTSTRAP_HANDOFF_READY=1
     elif command -v xdg-open >/dev/null 2>&1 && xdg-open "$BOOTSTRAP_URL"; then
       BOOTSTRAP_HANDOFF_READY=1
     elif command -v pbcopy >/dev/null 2>&1 && printf '%s' "$BOOTSTRAP_URL" | pbcopy; then
       BOOTSTRAP_HANDOFF_READY=1
     elif command -v wl-copy >/dev/null 2>&1 && printf '%s' "$BOOTSTRAP_URL" | wl-copy; then
       BOOTSTRAP_HANDOFF_READY=1
     fi

     if [ "$BOOTSTRAP_HANDOFF_READY" -eq 1 ]; then
       unset BOOTSTRAP_SECRET BOOTSTRAP_URL BOOTSTRAP_HANDOFF_READY
     else
       printf '%s\n' "Bootstrap secret was stored, but no browser or clipboard handoff succeeded; variables remain for a secure retry." >&2
     fi
   else
     unset BOOTSTRAP_SECRET
     printf '%s\n' "Bootstrap secret was not stored; no handoff was attempted." >&2
   fi
   ```

   If provisioning reports that the secret was uploaded but deployment or browser
   handoff failed, rerun setup and supply the saved value when prompted. The
   secret cannot be retrieved from Cloudflare and setup never generates or
   silently rotates it. If the value was not saved, stop and perform the
   documented manual recovery flow explicitly. This rotation script clears its
   shell variable after handoff.

## 6. Newsletter observability

Newsletter telemetry is emitted as sanitized JSON from the Worker. Use the
Cloudflare dashboard's Worker Logs/Observability view for the deployed Worker;
this repository does not enable plan-dependent observability settings in
`wrangler.jsonc`, so deployment cost and retention semantics remain explicit.
No third-party service is required.

Alert on:

- sustained `newsletter_confirmation_delivery` failures;
- increasing or old `resend_sync_outbox` rows in `uncertain` state;
- a growing due retry backlog (`state = 'ready'` and `next_attempt_at` in the past);
- any sustained `newsletter_scheduled_maintenance_failure` or failed outbox
  finalization events.

Use the aggregate D1 queries and event field definitions in
`docs/newsletter.md`. Logs contain only event, operation, revision, state, and
bounded error class; never export or alert on subscriber identity, tokens,
contact IDs, request bodies, response bodies, or raw exception text. Restrict
dashboard access and use the account's configured Worker Logs retention.

## 7. Post-cutover checks

Run every check against `https://<HOSTNAME>` after each cutover, upgrade, or
restore:

| Check | Command / method | Expected |
| --- | --- | --- |
| Public routes | `curl -sS -o /dev/null -w '%{http_code}\n' https://<HOSTNAME>/ https://<HOSTNAME>/posts/ https://<HOSTNAME>/projects/` | `200` |
| A known post/page | `curl -sS -o /dev/null -w '%{http_code}\n' https://<HOSTNAME>/posts/<POST_SLUG>/` | `200` |
| Drafts hidden | Fetch a draft slug anonymously | Not rendered / not listed publicly |
| Signed previews | Open the admin preview URL for a draft (`/pages/<id>?_preview=...`) while authenticated | Renders; unauthenticated requests do not |
| Media | `curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://<HOSTNAME>/<MEDIA_PATH>` | `200` with correct MIME type |
| RSS | `curl -sS https://<HOSTNAME>/rss.xml \| head -c 200` | Valid XML, recent pubDate |
| Search | Query `/_emdash/api/search?q=<TERM>` from the site search dialog | Relevant published results |
| Sitemap | `curl -sS https://<HOSTNAME>/sitemap.xml \| head -c 200` | Valid XML; verify custom collections are actually included (do not assume) |
| Admin noindex | `curl -sSI https://<HOSTNAME>/_emdash/admin` | Header includes `X-Robots-Tag: noindex, nofollow` |

Also confirm locally before deploying: `bun run build && bun run check`, and
validate the content model after any seed change with `bun run seed:validate`.
Deploy only with `bun run cf:deploy` (never bare `wrangler deploy`, which skips
the Astro SSR build).
