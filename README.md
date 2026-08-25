# minastro

A personal-site template built with Astro and [EmDash](https://emdashcms.com), running server-side on Cloudflare Workers. EmDash is a Git-free CMS that stores your content in Cloudflare D1 and media in R2, so everything — posts, projects, pages, settings — is editable from a built-in admin at `/_emdash/admin`. Out of the box you get a blog, a project portfolio, CMS-managed pages, search, RSS, tags, comments, and an optional newsletter.

## Quick start

No Cloudflare account needed:

```bash
git clone https://github.com/frankievalentine/minastro.git
cd minastro
bun install
bun run cf:dev
```

This builds the site and runs the Worker locally on `http://localhost:8787` with simulated D1/R2/KV bindings. Open the URL and complete the one-time setup wizard at `/_emdash/admin/setup`.

- The committed `siteConfig.url` is `http://localhost:8787`, which matches this origin exactly — including for WebAuthn passkeys.
- Local content persists in `.wrangler/state` across restarts. To start over, delete only that directory; the next run re-applies the seed.
- Passkeys registered on localhost do not transfer to production. Register your production passkey later on your final deployed hostname.
- On the first setup screen you choose whether to include sample content. Both choices are supported; either way the schema, initial settings, and navigation are applied.

`bun run dev` runs Astro alone and does not provide the bindings EmDash needs — use `cf:dev` for full-stack work.

## Set up with an agent

Open a coding agent in this clone and paste:

```text
Set up Minastro from this clone. Read AGENTS.md first, and use the emdash-docs
MCP server if available for current EmDash questions. Work locally first:
bun install, bun run check, bun run seed:validate, bun run build. Do not create
Cloudflare resources, secrets, or deployments without my explicit approval.
Before any production provisioning, ask me for my final canonical hostname and
confirm it lives in an active Cloudflare zone owned by the authenticated
account (bunx wrangler whoami). After I approve, follow AGENTS.md to configure
and deploy, then complete /_emdash/admin/setup on that final origin only —
never register the production passkey on a workers.dev origin.
```

You remain responsible for account choice, resource approval, domain/zone ownership, passkey registration, and any optional third-party credentials. See [Deployment](#deployment) below or hand the agent `AGENTS.md` and `docs/operations.md` for the full runbook.

## How content works

EmDash is the sole source of runtime content. Editors work in the admin; there are no local-content fallbacks for CMS routes, so missing content fails visibly rather than silently rendering something else.

**CMS-owned (edit in `/_emdash/admin`):**

- **Site identity and settings** — title, tagline, logo, posts-per-page pagination, date format, and timezone.
- **Primary Navigation** — the sidebar menu. An absent or empty menu renders no navigation items.
- **Posts** — Portable Text body, description, featured flag, featured image, tags, and optional comments.
- **Projects** — like posts plus status, live URL, and GitHub link.
- **Pages** — root-level pages rendered at `/{slug}`; add them to Primary Navigation to place them in the sidebar.
- **Tags** — a shared taxonomy across Posts and Projects.
- **Home editorial fields** — homepage headline, section titles/descriptions, highlight cards, and newsletter CTA copy.
- **Listing headers and newsletter page copy** — optional singleton overrides for listing labels/icons and public newsletter-page text.

**Developer-owned (`src/site.config.ts`):** presentation values with no CMS equivalent — bio, avatar, location, roles, social links, analytics, and newsletter integration settings. Site identity and navigation have no local fallbacks here; they come from the CMS only.

The bundled `.emdash/seed.json` initializes empty databases only — it never updates an existing site's schema or content. On the first setup screen, keeping sample content gives you demo posts, projects, and pages; clearing **Include sample content (recommended for new sites)** starts clean while retaining schema, settings, and navigation.

## Use the template

Common edits:

- **Change text and content** — do it in the admin. No rebuild needed.
- **Change presentation values** (bio, social links, analytics) — edit `src/site.config.ts`.
- **Change the content model** — edit `.emdash/seed.json`, then regenerate types:

  ```bash
  bun run types:generate
  ```

  This regenerates `.emdash/types.ts` and `.emdash/schema.json` offline from the seed; commit both. Collection typing comes from these generated artifacts — never hand-maintain field definitions in `src/emdash-types.d.ts`.

Local development uses `bun run cf:dev`; production deploys use `bun run cf:deploy`. Never deploy with bare `wrangler deploy`/`wrangler dev` — they skip the Astro SSR build.

| Command | Action |
| --- | --- |
| `bun run cf:dev` | Build and run the Worker locally with simulated D1/R2/KV bindings |
| `bun run dev` | Astro-only frontend dev server |
| `bun run build` | Build production SSR output |
| `bun run check` | Type-check and lint |
| `bun run seed:validate` | Validate `.emdash/seed.json` |
| `bun run types:generate` | Regenerate `.emdash/types.ts` and `.emdash/schema.json` |
| `bun run cloudflare:setup` | Provision D1/R2/KV and deploy the configured Worker |
| `bun run cf:deploy` | Build and deploy an already configured Worker |

## Deployment

Deployment is optional — you can develop locally indefinitely. When you are ready, see [AGENTS.md](AGENTS.md) for provisioning requirements and responsibilities, and [docs/operations.md](docs/operations.md) for the full runbook: backups, restores, staging isolation, post-cutover checks, and production passkey setup.

## Newsletter

The newsletter page is visible by default, but signup stays disabled until its opt-in integration is provisioned (verified Email Sending domain, Turnstile keys, and a Rate Limiting namespace). See [docs/newsletter.md](docs/newsletter.md) for architecture, configuration, and operations.

## Advanced integrations

### EmDash MCP

This repository commits one project MCP server, `emdash-docs` (`.mcp.json`), pointing at the official public EmDash documentation. It is read-only and requires no token.

Your deployed site also exposes `<your-deployment-origin>/_emdash/api/mcp`, which can access live content. Configure it per user and per client — never commit it to this repository. Authenticate with OAuth/device flow or a locally stored personal access token, starting with the least-privilege `content:read` scope. Never commit PATs or write/admin credentials here, and verify the endpoint after deployment before relying on it.
