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

## 0. Provisioning gate (read before any setup)

Never provision, attach a domain, or deploy without explicit approval.

1. Confirm `bunx wrangler whoami` targets the intended Cloudflare account.
2. Confirm the final canonical hostname with the site owner and verify it lives
   in an active Cloudflare zone owned by that account.
3. Obtain explicit approval before creating resources, attaching the custom
   domain, or deploying.
4. Only then set `src/site.config.ts` to `https://<HOSTNAME>` and add
   `{ "pattern": "<HOSTNAME>", "custom_domain": true }` to `routes` in
   `wrangler.jsonc`.

Run `bun run cloudflare:setup` only from the deployment clone in an interactive
terminal. Do not deploy while placeholder IDs remain in `wrangler.jsonc`; the
setup script rejects partially configured core bindings. Registrar transfers
and DNS hosted outside Cloudflare cannot be automated here.

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

1. After provisioning and first successful request on `https://<HOSTNAME>`
   (which redirects to `/_emdash/admin/setup`), complete the wizard there.
2. On the first wizard screen, decide whether to include sample content: both
   including and clearing **Include sample content (recommended for new
   sites)** are supported; schema, settings, and navigation are applied either
   way. This choice belongs to the site owner.
3. Register the production passkey only on `<HOSTNAME>`. Never register it on a
   `*.workers.dev` origin — WebAuthn credentials are origin-bound and will not
   transfer.

## 6. Post-cutover checks

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
