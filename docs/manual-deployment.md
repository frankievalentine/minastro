# Manual deployment runbook

Self-service runbook for a human operator deploying a Minastro site to
Cloudflare. You run every command yourself in your own interactive terminal.
Provisioning uses the supported `bun run cloudflare:setup` script: do not
hand-create Workers, D1, R2, or KV resources, and never deploy with a bare
`wrangler deploy`.

Replace `<hostname>`, `<worker-name>`, and other angle-bracket examples with
your actual values. For more detail, see:

- [README.md](../README.md) - the condensed setup flow.
- [docs/operations.md](operations.md) - backups, restores, staging isolation,
  post-cutover checks, and bootstrap-secret recovery.

Do not run any step here to make local development work; `bun run cf:dev` needs
none of it.

## Before you start

- A **final HTTPS hostname** (for example `https://example.com`) that already
  lives in an active Cloudflare DNS zone owned by the account you will deploy
  into. Setup rejects `workers.dev`, non-HTTPS, and localhost origins.
  Registrar transfers and DNS hosted outside Cloudflare cannot be automated.
- **A Cloudflare account you can sign in to.** Setup discovers the accounts your
  Wrangler login can reach, asks when more than one matches, and shows the
  chosen account in the printed plan. Pass `--account <id>` with the
  32-character account ID to pin it up front.
- **Explicit approval** to create the Worker, D1, R2, session KV, and (if you
  opt in) newsletter resources, attach the custom domain, and deploy.
- **Cloudflare authentication.** Sign in with Wrangler:

  ```sh
  npx wrangler login
  ```

  Setup reads that session directly, and offers to run the login for you if it
  finds no session. No credential file is required.

  An account-scoped API token is the alternative. It needs Account Settings
  Read, D1 Edit, Workers R2 Storage Edit, Workers KV Storage Edit, and Workers
  Scripts Edit, plus Workers Routes Edit in the zone that owns your hostname.
  Create it with [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/);
  permission names are in the [API permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
  To use it, create the ignored file with
  `install -m 600 .env.cloudflare.local.example .env.cloudflare.local`, fill in
  the blank `CLOUDFLARE_API_TOKEN=` and `CLOUDFLARE_ACCOUNT_ID=` lines in your
  own editor, and run provisioning with
  `bun run --env-file=.env.cloudflare.local cloudflare:setup`. Delete the file
  and revoke the token when you are done. Exporting the variables for the run is
  an accepted alternative that writes no file.
- **An interactive terminal.** Wrangler prompts about custom-domain and DNS
  conflicts, so do not run setup detached, in CI, or through a wrapper without a
  TTY.
- The two **deployment secrets** saved in step 4.

## 1. Create your standalone site project

```sh
bun create astro@latest my-site --template github:frankievalentine/minastro --no-ai
cd my-site
bun install
```

`npx create-astro@latest my-site --template github:frankievalentine/minastro --no-ai`
works the same way. Keep `--no-ai`: it preserves Minastro's own `AGENTS.md` and
bundled skill guidance instead of letting `create-astro` overwrite them.

## 2. Run the local checks

```sh
bun run check
bun run seed:validate
bun run build
```

Optionally exercise the full stack first with `bun run cf:dev` on
`http://localhost:8787`. Local passkeys do not transfer to production, so keep
`src/site.config.ts` at its local default until step 6.

## 3. Make the site yours

Developer-owned presentation lives in `src/site.config.ts`: avatar, bio,
location, roles, public contact email, social links, and your analytics choice.
Leave the newsletter fields and the custom analytics hook disabled unless you
are opting in (step 5).

CMS-owned identity (site title, tagline, logo, and the primary navigation menu)
belongs to EmDash at runtime, not to `src/site.config.ts`. Apply the title,
tagline, and primary menu through the bundled seed in `.emdash/seed.json` before
your first deploy, or in `/_emdash/admin` after the wizard. The seed does not
carry uploaded media, so upload the logo in the admin.

If you change the content model, edit `.emdash/seed.json`, regenerate the
committed types, and validate:

```sh
bun run types:generate
bun run seed:validate
```

The seed initializes only a fresh, empty database; later edits never mutate an
existing site. See the bundled skill at
`.agents/skills/building-emdash-site/SKILL.md` and its schema/seed reference.

## 4. Generate and save the two deployment secrets

Save the resulting **values** (not the commands) in your password manager. Setup
prompts for each saved value later; it never generates, echoes, logs, or stores
them for you.

`EMDASH_ENCRYPTION_KEY` encrypts plugin settings at rest. Generate it with
EmDash's own generator and save the printed value exactly as-is:

```sh
npx emdash secrets generate
```

`EMDASH_BOOTSTRAP_SECRET` is a first-admin bootstrap credential. It is a raw
base64url value with no prefix:

```sh
printf '%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
```

An established site requires its original encryption key, so losing it is
unrecoverable; keep it separate from your D1 backups. Step 7 uploads both values
to the Worker that setup creates, after the plan is approved.

To set the encryption key yourself on an existing Worker instead, wait until the
approved Worker name is known and always pass it explicitly:

```sh
npx wrangler secret put EMDASH_ENCRYPTION_KEY --name <worker-name>
```

Setup inherits a secret that is already on that Worker without prompting. A bare
`npx wrangler secret put EMDASH_ENCRYPTION_KEY` on a fresh clone targets the
placeholder Worker name `minastro-template` and is wrong.

## 5. Optional: newsletter

Skip this unless you want public signups. The newsletter page is visible by
default, but signup stays disabled until this opt-in integration is provisioned.

To opt in, have ready:

- Your sending domain onboarded in
  [Cloudflare Email Service](https://developers.cloudflare.com/email-service/configuration/domains/)
  with its DNS records. Onboarding the domain is the only sender prerequisite;
  the individual sender address is not separately verified, so pick any address
  at that domain.
- A [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)
  for the final hostname, with its public site key and private secret key.
- A `namespace_id` for `NEWSLETTER_SUBSCRIBE_LIMITER`: any positive integer
  unique for the account; there is no dashboard resource to create.
- A `NEWSLETTER_ADMIN_TOKEN` of at least 32 characters, created in your password
  manager.
- Optionally, a Resend Segment ID and API key for segment synchronization.

Opt in by passing the flag when you provision:

```sh
bun run cloudflare:setup --newsletter
```

Without `--newsletter` the newsletter stays disabled even if you prepared these
values. Setup reads the Turnstile secret and admin token through masked input
and writes them as Worker secrets. See [docs/newsletter.md](newsletter.md) for
architecture and operations.

## 6. Confirm the canonical origin

Confirm the final canonical hostname with the site owner and verify its zone is
active in the account you will deploy into. Attaching a hostname whose zone
lives in a different account, or whose DNS is hosted outside Cloudflare, is not
automatable here.

You can set it yourself in `src/site.config.ts`:

```ts
url: "https://<hostname>",
```

or answer the `Canonical HTTPS origin:` prompt during setup, which writes the
same value. You do not need to edit `wrangler.jsonc` yourself: setup reconciles
it, writing `account_id`, the Worker name, the D1/R2/KV binding IDs, the
newsletter bindings when enabled, and a `{ "pattern": "<hostname>",
"custom_domain": true }` route. It refuses to proceed if a configured value
conflicts with the approved plan. Leave the placeholder IDs in place until
setup replaces them; do not hand-edit them.

## 7. Run provisioning

Run this from the scaffolded site directory, in an interactive terminal:

```sh
bun run cloudflare:setup
```

or, with the optional token file from "Before you start":

```sh
bun run --env-file=.env.cloudflare.local cloudflare:setup
```

Optional flags: `--name <worker>` picks the Worker name without a prompt,
`--account <id>` skips account resolution, and `--newsletter` opts in to the
newsletter resources in step 5.

The script verifies the account through the Cloudflare API, writes only
non-secret state to an atomic journal under `.wrangler/provisioning/`, and
revalidates every remote resource before continuing. It never stores the secret
values.

On a genuinely new Worker it first deploys an inert private base Worker: a
generated `503` responder with `workers_dev` and preview URLs off and no routes,
triggers, or assets. That one-time step is only a prerequisite for Wrangler's
versioned uploads; it serves no content and is never publicly reachable. Setup
then builds the real Astro output, uploads the prepared version against
`dist/server/wrangler.json`, adds secrets, applies migrations, deploys that
version at 100% traffic, attaches the custom domain and cron triggers, and
checks the canonical origin.

### Answering the prompts

Answer each prompt in the terminal. Setup resolves the account and
authentication first, then asks, in this order:

- `Worker name [my-site]:` - only when no name is configured or passed with
  `--name`
- `Canonical HTTPS origin:` - only if `src/site.config.ts` does not already hold
  a valid canonical HTTPS origin
- the printed plan summary, then `Approve this complete Cloudflare provisioning plan (account, resources, custom domain, deployment, and cron triggers)? [y/N]` - review the summary before you answer
- the hidden `EMDASH_ENCRYPTION_KEY` prompt and the matching
  `EMDASH_BOOTSTRAP_SECRET` prompt - paste each saved value; input is hidden and
  requires a real TTY

That single approval covers the account, the D1/R2/KV names derived from the
Worker name, the custom domain, the deployment, and the cron triggers; nothing
is created before it. There is no separate account, deployment, or trigger
re-approval. A completed run ends with `Provisioning complete for <worker> at
<origin>.`

### Resuming after an interruption

Provisioning is resumable. If any resource create, secret upload, migration, or
deployment is interrupted, rerun the same command. It revalidates remote state
and continues rather than recreating resources or rotating secrets. On resume
you will see `Resume this approved plan after revalidating remote state? [y/N]`
and any still-pending secret prompt. A pending secret operation needs the value
saved in your password manager. No automatic rollback or deletion happens. If a
lock was left by a terminated process, confirm no setup process is running
before removing it yourself; it is not cleaned up automatically.

## 8. Complete the wizard and register the passkey on the final origin

Setup opens the bootstrap URL in your default browser, or copies it to the
clipboard, without printing it. Complete setup on the canonical origin only -
never on a `*.workers.dev` origin, because WebAuthn passkeys are origin-bound
and will not transfer.

The bootstrap URL redirects to a clean `/_emdash/admin/setup` URL before the
wizard loads, so you do not need to keep the initial URL. That credential stays
reusable until you remove the secret in step 10; only the signed HttpOnly cookie
it sets expires after 15 minutes. On the first wizard
screen, choose whether to include sample content - both including and clearing
**Include sample content (recommended for new sites)** are supported; schema,
settings, and navigation are applied either way. Register your production
passkey there, then upload your logo in `/_emdash/admin`.

If neither browser nor clipboard handoff works, setup does not print the URL:
use your saved secret for an operator-controlled direct handoff and rerun setup.

## 9. Verify the deployment

Setup itself verifies the canonical origin and that the custom domain is
attached to the approved Worker before it reports completion. The check accepts
the shapes a freshly provisioned site can take: it passes when the canonical
origin returns the same-origin setup redirect, and it also passes when the
origin serves the homepage and the setup route is gated (HTTP 403,
bootstrap-protected). Do not expect a redirect specifically; the script checks
that the approved site answers on the canonical origin.

Once setup reports completion, confirm the public surface yourself against
`https://<hostname>`:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://<hostname>/ https://<hostname>/posts/ https://<hostname>/projects/
curl -sS https://<hostname>/rss.xml | head -c 200
curl -sSI https://<hostname>/_emdash/admin
```

Expect `200` for the public routes, valid XML from RSS, and
`X-Robots-Tag: noindex, nofollow` on the admin response. Also check a known post
or page, media URLs, search from the site dialog, and that drafts stay hidden.
[docs/operations.md](operations.md) has the full post-cutover table, including
signed-preview and sitemap checks.

If canonical verification fails right after the custom domain is attached, rule
out DNS propagation or a stale local resolver cache before changing Worker code
or config; see the resolver checks in `docs/operations.md`. Do not work around
it with a `workers.dev` fallback.

## 10. Revoke the bootstrap secret and the setup credential

Once the first administrator is initialized and you are done with the wizard,
remove the bootstrap secret so no further first-admin bootstrap is possible:

```sh
npx wrangler secret delete EMDASH_BOOTSTRAP_SECRET --name <worker-name>
```

This is the documented revocation in `docs/operations.md`; it revokes any
remaining bootstrap cookies. Confirm the secret is absent by running
`npx wrangler secret list` from the scaffolded project directory, which targets
the Worker name setup wrote into `wrangler.jsonc`. If setup must be recovered
before an administrator exists, follow the rotation flow in
`docs/operations.md`: generate a new secret, store it with Wrangler, and reopen
setup. Changing the secret invalidates previously issued cookies.

Then clean up the credential you used: if you created `.env.cloudflare.local`,
delete it (`rm .env.cloudflare.local`) and revoke the API token in Cloudflare.
If you used the Wrangler login, setup already borrowed that session in-process
and there is no token to revoke; `npx wrangler logout` ends the session if you
want to.

## Later deploys

After initial provisioning, `wrangler.jsonc` is fully configured, so build and
deploy with:

```sh
bun run cf:deploy
```

The command runs the Astro SSR build before Wrangler. Never use a bare
`wrangler deploy` or `wrangler dev`, which would skip the build. Rerunning
`cloudflare:setup` is only for provisioning or resuming an interrupted setup,
and it needs account credentials again.

Before an upgrade, take a remote D1 export and an R2 snapshot; see
[docs/operations.md](operations.md). Enable Cloudflare Web Analytics in the
dashboard once the site is live on its custom domain, per
[docs/analytics.md](analytics.md).
