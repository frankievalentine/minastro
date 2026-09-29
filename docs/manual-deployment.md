# Manual deployment runbook

This is a self-service runbook for a human operator deploying a Minastro site to
Cloudflare. You run every command yourself in your own interactive terminal; no
agent is involved and no step depends on one. Provisioning uses the supported
`bun run cloudflare:setup` script. Do not hand-create Workers, D1, R2, or KV
resources, and never deploy with a bare `wrangler deploy`.

Replace `<hostname>`, `<HOSTNAME>`, and other angle-bracket examples with your
actual values before running a command.

This runbook contains the deployment steps. For more detail, see:

- [README.md](../README.md) - production prerequisites, token scopes, and the
  secret-generation commands.
- [docs/operations.md](operations.md) - the full operations runbook, including
  backups, restores, post-cutover checks, and bootstrap-secret recovery.

Do not run any step here to make local development work; `bun run cf:dev` needs
none of it.

## Before you start

Have all of these ready:

- A **final HTTPS hostname** (for example `https://example.com`) that already
  lives in an active Cloudflare DNS zone owned by the account you will deploy
  into. Setup rejects `workers.dev`, non-HTTPS, and localhost origins. Registrar
  transfers and DNS hosted outside Cloudflare cannot be automated.
- The **approved 32-character hexadecimal Cloudflare account ID** for that
  account. You choose the account; confirm it before creating anything.
- An **account-scoped Cloudflare API token** for that account and zone with
  exactly these permissions:
  - Account: Account Settings Read, D1 Edit, Workers R2 Storage Edit, Workers KV
    Storage Edit, Workers Scripts Edit.
  - Zone: Workers Routes Edit (required for the custom domain).
  - Create it with [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/);
    permission names are in the [API permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
- An **interactive terminal**. Wrangler prompts about custom-domain and DNS
  conflicts, so do not run setup detached, in CI, or through a wrapper that
  cannot show a TTY prompt.
- **OpenSSL** on your computer for generating the two deployment secrets.
- The two **deployment secrets** generated and saved in step 5.

## 1. Create your standalone site project

A Minastro site starts as a standalone project copied from the template with
`create-astro`. You own and edit this new directory; it is separate from the
upstream template source.

```sh
bun create astro@latest my-site --template github:frankievalentine/minastro --no-ai
cd my-site
bun install
```

`npx create-astro@latest my-site --template github:frankievalentine/minastro --no-ai`
works the same way. Keep `--no-ai`: it preserves Minastro's own `AGENTS.md` and
bundled skill guidance instead of letting `create-astro` overwrite them.

## 2. Make the site yours

Two groups of values, in two different places. Do not mix them.

Developer-owned presentation lives in `src/site.config.ts`: avatar, bio,
location, roles, public contact email, social links, and your analytics choice.
Leave the newsletter fields and the custom analytics hook disabled unless you
are opting in (step 6). Do not ship placeholders such as `yourusername` or
`your-domain.com`.

CMS-owned identity (site title, tagline, logo, and the primary navigation menu)
belongs to EmDash at runtime, not to `src/site.config.ts`. Apply the title,
tagline, and primary menu through the bundled seed in `.emdash/seed.json` before
your first deploy, or in `/_emdash/admin` after the wizard. Upload the logo in
`/_emdash/admin`; the seed does not carry uploaded media.

If enabling the newsletter, set its visible page description in the seed's
`newsletter_page` record or later in the admin. The `site.config.ts` newsletter
description is only the fallback when that CMS record is absent.

If you change the content model, edit `.emdash/seed.json` and regenerate the
committed types:

```sh
bun run types:generate
```

The seed initializes only a fresh, empty database; later edits never mutate an
existing site. See the bundled skill at
`.agents/skills/building-emdash-site/SKILL.md` and its schema/seed reference.

## 3. Run the local checks

Confirm the project builds and validates before touching Cloudflare:

```sh
bun run check
bun run seed:validate
bun run build
```

Optionally exercise the full stack locally first with `bun run cf:dev` on
`http://localhost:8787`. Keep `src/site.config.ts` at the local default until
step 7; local passkeys do not transfer to production.

## 4. Confirm the Cloudflare account, zone, and hostname

1. Decide the final canonical hostname and confirm its zone is active in the
   account you will deploy into. Attaching a hostname whose zone lives in a
   different account, or whose DNS is hosted outside Cloudflare, is not
   automatable here.
2. Confirm the account ID matches that account; setup rejects a value the token
   cannot access.
3. Create the token with the scopes listed above. A token missing Workers Routes
   Edit fails during custom-domain attachment.

Provisioning creates a Worker, a D1 database, an R2 bucket, a session KV
namespace, and (if you opt in) the newsletter resources, then attaches the
custom domain and deploys. That is a real, externally visible change: approve it
for your account before you run setup.

## 5. Create the token file and save the two secrets

Provisioning reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the
environment. The intended flow is an ignored, operator-owned file that only that
one command loads.

Create it from the tracked example with owner-only permissions, then fill in the
blank lines in **your own editor**:

```sh
install -m 600 .env.cloudflare.local.example .env.cloudflare.local
```

Open `.env.cloudflare.local` and complete `CLOUDFLARE_API_TOKEN=` and
`CLOUDFLARE_ACCOUNT_ID=`. Leave the tracked example untouched. Never paste the
token into chat, a shell command, or any committed file. Setup never reads or
stores the file itself; `bun run --env-file=` loads it into that one command's
environment only.

Then generate the two deployment secrets and save the resulting **values** (not
the commands) in your password manager:

```sh
# EMDASH_ENCRYPTION_KEY: emdash_enc_v1_ plus 43 unpadded base64url chars.
printf 'emdash_enc_v1_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"

# EMDASH_BOOTSTRAP_SECRET: raw unpadded base64url value, no prefix.
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

Save the first output as `EMDASH_ENCRYPTION_KEY` exactly as printed - the
`emdash_enc_v1_` prefix is part of the value. Save the second as
`EMDASH_BOOTSTRAP_SECRET`. Setup prompts for each through hidden input and never
generates, echoes, logs, or stores them for you. An existing site requires its
original encryption key, so losing it is unrecoverable.

## 6. Optional: newsletter

Skip this unless you want public signups. The newsletter page is visible by
default, but signup stays disabled until this opt-in integration is provisioned.
If you are not enabling it, leave the newsletter fields in `src/site.config.ts`
disabled.

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

Setup reads the Turnstile secret and admin token through masked input and writes
them as Worker secrets. See [docs/newsletter.md](newsletter.md) for architecture
and operations.

## 7. Point the site at the canonical origin

After you have chosen the hostname and approved the deployment, set the
production URL and route.

In `src/site.config.ts`, replace the local default:

```ts
url: "https://<hostname>",
```

In `wrangler.jsonc`, add a top-level `routes` array (or extend the existing one):

```jsonc
"routes": [
  { "pattern": "<hostname>", "custom_domain": true }
],
```

Setup also reconciles `wrangler.jsonc`: it writes `account_id`, the Worker name,
the D1/R2/KV binding IDs, and the canonical route, and it adds the route above if
it is missing. It refuses to proceed if a configured value conflicts with the
approved plan. Leave the placeholder IDs in place until setup replaces them; do
not hand-edit them.

## 8. Run provisioning

Run this from the scaffolded site directory, in an interactive terminal:

```sh
bun run --env-file=.env.cloudflare.local cloudflare:setup
```

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

Answer each prompt in the terminal. The script asks, in this order:

- `Use approved Cloudflare account <id>? [y/N]`
- `Worker name [my-site]:`
- `D1 database name [<worker>-db]:` and `R2 bucket name [<worker>-media]:`
  (fresh Workers only)
- `Canonical HTTPS origin:` - only if `src/site.config.ts` does not already hold
  a valid canonical HTTPS origin
- `Prepare a first-admin bootstrap handoff for this new site? [y/N]` - answer
  `y` for a first deployment so you can register the first administrator
- `Configure the newsletter now? [y/N]` (plus its follow-ups) unless the
  newsletter binding is already configured
- `Approve this complete provisioning plan? [y/N]` - review the printed plan
  summary before you answer
- `Enter the EMDASH_ENCRYPTION_KEY generated with OpenSSL; input is hidden ...`
  and the matching `EMDASH_BOOTSTRAP_SECRET` prompt - paste each saved value;
  input is hidden and requires a real TTY
- `Deploy the prepared final Worker version after verifying its protected
  prerequisites? [y/N]`
- `Apply the approved Worker custom-domain, route, and cron triggers now? [y/N]`

A completed run ends with `Provisioning complete for <worker> at <origin>.`

### Resuming after an interruption

Provisioning is resumable. If any resource create, secret upload, migration, or
deployment is interrupted, rerun the same command. It revalidates remote state
and continues rather than recreating resources or rotating secrets. On resume
you will see `Resume this plan after revalidating remote state? [y/N]`, possibly
a bootstrap-handoff reconfirmation, and any still-pending secret prompt. A
pending secret operation needs the value saved in your password manager. No
automatic rollback or deletion happens. If a lock was left by a terminated
process, confirm no setup process is running before removing it yourself; it is
not cleaned up automatically.

## 9. Complete the wizard and register the passkey on the final origin

Setup opens the bootstrap URL in your default browser, or copies it to the
clipboard, without printing it. Complete setup on the canonical origin only -
never on a `*.workers.dev` origin, because WebAuthn passkeys are origin-bound
and will not transfer.

The bootstrap URL redirects to a clean `/_emdash/admin/setup` URL before the
wizard loads, so do not bookmark or reuse the initial URL. On the first wizard
screen, choose whether to include sample content - both including and clearing
**Include sample content (recommended for new sites)** are supported; schema,
settings, and navigation are applied either way. Register your production
passkey there, then upload your logo in `/_emdash/admin`.

If neither browser nor clipboard handoff works, setup does not print the URL:
use your saved secret for an operator-controlled direct handoff and rerun setup.

## 10. Verify the deployment

Setup itself verifies the canonical origin and that the custom domain is
attached to the approved Worker before it reports completion. The check accepts
the shapes a freshly provisioned site can take: it passes when the canonical
origin returns the same-origin setup redirect, and it also passes when the
origin serves the homepage and the setup route is gated (HTTP 403,
bootstrap-protected). Do not expect a redirect specifically; the script is
checking that the approved site answers on the canonical origin.

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
or config; see the resolver checks in `docs/operations.md` section 0. Do not
work around it with a `workers.dev` fallback.

## 11. Revoke the bootstrap secret

Once the first administrator is initialized and you are done with the wizard,
remove the bootstrap secret so no further first-admin bootstrap is possible:

```sh
bun run --env-file=.env.cloudflare.local wrangler secret delete EMDASH_BOOTSTRAP_SECRET
```

This is the documented revocation in `docs/operations.md` section 5; it revokes
any remaining bootstrap cookies. Run it from the scaffolded project directory so
Wrangler uses the provisioned `wrangler.jsonc` and the still-available setup token.
Confirm the secret is absent with
`bun run --env-file=.env.cloudflare.local wrangler secret list` before removing
the token file. If setup must be recovered
before an administrator exists, follow the rotation flow in
`docs/operations.md` section 5: generate a new secret, store it with Wrangler,
and reopen setup. Changing the secret invalidates previously issued cookies.

## 12. Delete the token file and revoke the token

When setup has succeeded and no retry is pending:

1. Delete the local token file: `rm .env.cloudflare.local`.
2. Revoke or delete the API token in Cloudflare.

The token was only ever a throwaway credential for that provisioning run, and
the file was plaintext on disk until you remove it.

## Later deploys

After initial provisioning, `wrangler.jsonc` is fully configured, so build and
deploy with:

```sh
bun run cf:deploy
```

Authenticate with `bunx wrangler login` first if you no longer have an active
Wrangler session; the setup token was revoked in step 12. The command runs the
Astro SSR build before Wrangler. Never use a bare
`wrangler deploy` or `wrangler dev`, which would skip the build. Rerunning
`cloudflare:setup` is only for provisioning or resuming an interrupted setup,
and it needs the token again.

Before an upgrade, take a remote D1 export and an R2 snapshot; see
[docs/operations.md](operations.md) section 1. Enable Cloudflare Web Analytics
in the dashboard once the site is live on its custom domain, per
[docs/analytics.md](analytics.md).
