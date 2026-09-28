# minastro

A personal-site theme built with Astro and [EmDash](https://emdashcms.com), running server-side on Cloudflare Workers. EmDash is a Git-free CMS that stores your content in Cloudflare D1 and media in R2, so everything — posts, projects, pages, settings — is editable from a built-in admin at `/_emdash/admin`. Out of the box you get a blog, a project portfolio, CMS-managed pages, search, RSS, tags, comments, and an optional newsletter.

## Quick start

EmDash themes are scaffolded with `create-astro`, which copies the template into
a new standalone site project directory that you own and edit, separate from the
upstream template source. Do that first. No Cloudflare account is needed for
local work:

```bash
bun create astro@latest my-site --template github:frankievalentine/minastro --no-ai
cd my-site
bun install
cp .dev.vars.example .dev.vars
# Set EMDASH_BOOTSTRAP_SECRET in .dev.vars to a generated Base64URL value.
bun run cf:dev
```

`npx create-astro@latest my-site --template github:frankievalentine/minastro --no-ai`
works the same way if you prefer npm. The `--no-ai` flag keeps Minastro's own
`AGENTS.md` and bundled skill guidance instead of letting `create-astro`
overwrite them with its generic AI stub.

This builds the site and runs the Worker locally on `http://localhost:8787` with simulated D1/R2/KV bindings. Before `cf:dev`, set the required `EMDASH_BOOTSTRAP_SECRET` local variable to a generated Base64URL value. Open the setup URL with the `bootstrap` query parameter once; the Worker replaces it with a signed HttpOnly cookie that lasts 15 minutes and redirects to a clean setup URL. The bootstrap URL credential remains reusable until the secret is manually revoked.

- The committed `siteConfig.url` is `http://localhost:8787`, which matches this origin exactly — including for WebAuthn passkeys.
- Local content persists in `.wrangler/state` across restarts. To start over, delete only that directory; the next run re-applies the seed.
- Passkeys registered on localhost do not transfer to production. Register your production passkey later on your final deployed hostname.
- On the first setup screen you choose whether to include sample content. Both choices are supported; either way the schema, initial settings, and navigation are applied.

`bun run dev` runs Astro alone and does not provide the bindings EmDash needs — use `cf:dev` for full-stack work.

## Set up with an agent

Open a coding agent in your scaffolded site directory (the new project
`create-astro` created, not the upstream template source) and paste:

```text
Set up my Minastro site from this scaffold. Operate in this standalone project
directory only — this is my own new site created from the Minastro template,
not the upstream template source directory; never edit or push to the template
source.
Read AGENTS.md first. Then read the bundled EmDash skill at
.agents/skills/building-emdash-site/SKILL.md and follow its references when a
task needs them — it is version-pinned to the EmDash release this template
installs (1.0.1) and is your primary reference for schema, seeds, content
queries, Portable Text, and site features. Where that skill's generic
instructions differ from this template, follow this repository: the seed lives
at .emdash/seed.json, regenerate types with bun run types:generate, and run
locally with bun run cf:dev. For anything newer than the pinned release,
consult the official EmDash documentation at https://docs.emdashcms.com/.

First, interview me so the site reflects my details. Collect and confirm two
groups of information before building, and ask me for BOTH — do not skip either
group and do not assume defaults for either.

1. Developer-owned presentation values for src/site.config.ts: the avatar to
use; my location; my roles or short titles (e.g. "Software Engineer"); a short
bio; my social links (GitHub, X/Twitter, LinkedIn, and a public contact email —
I may skip any I do not use); my analytics choice — Cloudflare Web Analytics
(recommended; the default), a different provider, or none — and whether to
enable the newsletter signup and, if so, its sender address, Turnstile site
key, expected hostname, consent version, and the short public description shown
on the newsletter page. For Cloudflare Web Analytics, keep the custom analytics
hook in src/site.config.ts disabled and set it up in the Cloudflare dashboard
after the site is deployed (see Analytics below); only ask for a script URL and
domain — or provider-specific snippet details — if I pick a different provider.
Leave the custom analytics hook and the newsletter signup disabled (and their
optional sub-fields, including the description, clear) unless I confirm I want
them and give you the values — never invent placeholders like "yourusername" or
"your-domain.com".

2. CMS-owned site details: the site title, tagline, logo, and the primary
navigation menu I want. These are owned by the EmDash CMS at runtime, not
src/site.config.ts — never put them in site.config.ts. Apply the title, tagline,
and primary menu through the bundled seed (which only initializes a fresh, empty
database) or, on an already initialized site, through /_emdash/admin after the
setup wizard; if you use the seed, edit .emdash/seed.json settings/menu and run
bun run types:generate. Set the logo through /_emdash/admin, since the seed does
not carry the uploaded logo media.

Work locally first: bun install, bun run check, bun run seed:validate,
bun run build. Keep site.config.ts at the local default (http://localhost:8787)
until I give you my production hostname. Do not create Cloudflare resources,
secrets, or deployments without my explicit approval. Before any production
provisioning, ask me for my final canonical hostname and the explicitly approved
Cloudflare account ID, then set site.config.ts:url to https://<hostname>.
Require an account-scoped CLOUDFLARE_API_TOKEN with the least-privilege scopes
documented in docs/operations.md; never persist or log it. After I approve,
follow AGENTS.md to configure and deploy, then complete /_emdash/admin/setup on
that final origin only — never register the production passkey on a workers.dev
origin.
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
| `bun run cloudflare:setup` | Provision with an approved account-scoped token and safely resume the prepared-version deployment |
| `bun run test:setup` | Run failure-injection tests for resumable provisioning |
| `bun run smoke:worker` | Start isolated local Worker bindings and smoke-test setup/runtime boundaries |
| `bun run cf:deploy` | Build and deploy an already configured Worker |

## Deployment

Deployment is optional — you can develop locally indefinitely. When you are ready, see [AGENTS.md](AGENTS.md) for provisioning requirements and responsibilities, and [docs/operations.md](docs/operations.md) for the full runbook: backups, restores, staging isolation, post-cutover checks, and production passkey setup.

CI and the isolated local Worker smoke test are documented in [docs/ci.md](docs/ci.md).

## Analytics

Cloudflare Web Analytics is the recommended default for production sites deployed through this template. It needs no script tag, token, or Worker binding in this repository: you enable it in the Cloudflare dashboard once the site is live on its custom domain, and Cloudflare injects the beacon into your responses. The beacon script itself loads from `static.cloudflareinsights.com`, while its measurements post to your own origin at `/cdn-cgi/rum`.

To turn it on, after the site responds on the final HTTPS hostname:

1. In the Cloudflare dashboard for the zone that owns your hostname, open **Web Analytics** and add the site (this is the proxied-hostname flow; it requires the hostname to be proxied through Cloudflare, which is how this template attaches its custom domain).
2. Verify it is live rather than assuming. Load a public page and check the network panel for the beacon script, then navigate within the site or hide the tab and confirm the `POST /cdn-cgi/rum` request fires. Allow some delay for ingestion before the dashboard shows data.
3. Auto-injection covers the whole zone, so it also applies to `/_emdash/admin`. SPA navigation on Minastro is tracked automatically, with no extra configuration. If the beacon never appears, check that responses do not send `Cache-Control: public, no-transform` on the public HTML, which suppresses automatic injection; if they do, remove that directive.

Because Cloudflare injects the site-wide beacon itself, leave the custom analytics hook in `src/site.config.ts` disabled (`analytics.enabled: false`) when you choose Cloudflare Web Analytics. Never put a Cloudflare token, account ID, or snippet into the config for this option, and do not also add a custom script — that only creates duplicate or redundant tracking.

If you prefer a different provider, or none at all, that is fully supported:

- **Another provider:** set `analytics.enabled: true` with its `url`, and set `domain` only if the provider reads a `data-domain` attribute. The template loads it through the Partytown `text/partytown` script in `src/layouts/Layout.astro`, so it is offloaded from the main thread. Provider snippets that need something other than a script `src` plus `data-domain` (extra inline config, a different attribute scheme such as `data-website-id`, an `async` loader) require editing `Layout.astro` — the current hook only covers the plain script-tag case.
- **None:** leave `analytics.enabled: false`, and also disable or skip Cloudflare Web Analytics in the dashboard. Cloudflare injection is independent of this config, so the hook alone does not turn analytics off.

## Newsletter

The newsletter page is visible by default, but signup stays disabled until its opt-in integration is provisioned (verified Email Sending domain, Turnstile keys, and a Rate Limiting namespace). See [docs/newsletter.md](docs/newsletter.md) for architecture, configuration, and operations.

## Advanced integrations

### EmDash agent skill

This template bundles EmDash's official `building-emdash-site` agent skill at
`.agents/skills/building-emdash-site/SKILL.md`, together with its
`references/` documents. It is version-pinned to the EmDash release this
template installs (`emdash` 1.0.1 in `package.json`), so its guidance matches
the runtime you actually get. A fresh scaffold created from this template
contains it already — nothing extra to install.

This is the primary reference for EmDash work in a scaffolded site. Point your
agent at `SKILL.md`, and follow the repository's own conventions where the
skill describes generic EmDash projects: the seed is `.emdash/seed.json`,
types regenerate with `bun run types:generate`, and local runs use
`bun run cf:dev`.

Because the skill is pinned to the installed release, use the official
documentation at https://docs.emdashcms.com/ for anything newer — release
notes, changed APIs, or newly added features.

The skill resolves for each agent client without installing anything: Codex and
OpenCode both discover `.agents/skills` directly, Claude Code discovers it
through the committed `.claude/skills` symlink to `.agents/skills`, and
`AGENTS.md` also points agents at the same files. No skill registry install is
required for any of them.

### EmDash MCP

Optional supplement to the bundled skill, not a replacement; setup never
depends on it. This repository optionally declares the public `emdash-docs`
docs MCP server, which is read-only and needs no token, in:

- `.mcp.json` — Claude Code project scope.
- `.codex/config.toml` — Codex project scope, under `[mcp_servers.emdash-docs]`.

Skill registries such as `skills.sh` install agent skills only — they cannot
install or register an MCP server. Register the server through your client's own
configuration.

Codex loads project-scoped config only for a trusted repository. On first use in
a new project, approve the trust prompt, then start a new session so the server
is picked up; the tools are not callable in a session that was already running
before the config was added. When the MCP tools are not callable, read
https://docs.emdashcms.com/ directly instead of reporting the docs as
unavailable.

Your deployed site also exposes `<your-deployment-origin>/_emdash/api/mcp`, which can access live content. Configure it per user and per client — never commit it to this repository. Authenticate with OAuth/device flow or a locally stored personal access token, starting with the least-privilege `content:read` scope. Never commit PATs or write/admin credentials here, and verify the endpoint after deployment before relying on it.
