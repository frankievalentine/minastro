# minastro

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/minastro-dark.webp">
  <source media="(prefers-color-scheme: light)" srcset="images/minastro-light.webp">
  <img alt="Minastro personal-site homepage with navigation, writing, and project sections" src="images/minastro-light.webp">
</picture>

A personal-site theme built with Astro and [EmDash](https://emdashcms.com), running server-side on Cloudflare Workers. EmDash is a Git-free CMS that stores your content in Cloudflare D1 and media in R2, so everything — posts, projects, pages, settings — is editable from a built-in admin at `/_emdash/admin`. Out of the box you get a blog, a project portfolio, CMS-managed pages, search, RSS, tags, comments, and an optional newsletter.

## Features

- **CMS-backed blog and portfolio** — posts and projects are authored in the EmDash admin and queried at runtime; no local content files or rebuilds.
- **CMS-managed pages** — root pages render at `/{slug}` and can be added to the primary navigation.
- **Built-in admin** — author, edit, and publish at `/_emdash/admin`, including tags, featured flags, and optional comments.
- **EmDash comments** — readers can comment on published posts; collection settings control availability and moderation.
- **Content search** — search posts and projects from a dialog, backed by `/_emdash/api/search`.
- **RSS and SEO endpoints** — `/rss.xml`, plus runtime-owned `/robots.txt` and `/sitemap.xml`.
- **Shiki code blocks** — syntax highlighting for Portable Text code blocks in light and dark themes.
- **Presentation config** — bio, avatar, location, roles, and social links in `src/site.config.ts`; navigation stays CMS-managed.
- **Cloudflare-native deployment** — server-rendered on Workers with D1 for content and R2 for media, with scripts for local Worker development and Cloudflare deployment.
- **Analytics** — recommended Cloudflare Web Analytics setup after deployment, or an optional custom provider.
- **Optional newsletter** — a public signup page, confirm/unsubscribe flow, and admin CSV export, enabled only when you provision it.

## Quick start

EmDash themes are scaffolded with `create-astro`, which copies the template into a new standalone site project directory that you own and edit, separate from the upstream template source. Do that first. No Cloudflare account is needed for local work:

```bash
bun create astro@latest my-site --template github:frankievalentine/minastro --no-ai
cd my-site
bun install
cp .dev.vars.example .dev.vars
# Set EMDASH_BOOTSTRAP_SECRET in .dev.vars to a generated Base64URL value.
bun run cf:dev
```

`npx create-astro@latest my-site --template github:frankievalentine/minastro --no-ai` works the same way if you prefer npm. The `--no-ai` flag keeps Minastro's own `AGENTS.md` and bundled skill guidance instead of letting `create-astro` overwrite them with its generic AI stub.

This builds the site and runs the Worker locally on `http://localhost:8787` with simulated D1/R2/KV bindings. Before `cf:dev`, set the required `EMDASH_BOOTSTRAP_SECRET` local variable to a generated Base64URL value (`openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'`). Open the setup URL with the `bootstrap` query parameter once; the Worker replaces it with a signed HttpOnly cookie that lasts 15 minutes and redirects to a clean setup URL. The bootstrap URL credential remains reusable until the secret is manually revoked.

- The committed `siteConfig.url` is `http://localhost:8787`, which matches this origin exactly — including for WebAuthn passkeys.
- Local content persists in `.wrangler/state` across restarts. To start over, delete only that directory; the next run re-applies the seed.
- Passkeys registered on localhost do not transfer to production. Register your production passkey later on your final deployed hostname.
- On the first setup screen you choose whether to include sample content. Both choices are supported; either way the schema, initial settings, and navigation are applied.

`bun run dev` runs Astro alone and does not provide the bindings EmDash needs — use `cf:dev` for full-stack work.

## Production prerequisites

Local work needs Bun and a supported Node.js release: Astro requires Node.js 22.12.0 or later on an even-numbered release line (see [Astro's install and setup guide](https://docs.astro.build/en/install-and-setup/)), and `bun run build` launches Node. Wrangler is a devDependency here, so there is no global install. The Cloudflare items below apply only to deployment, and the newsletter items only if you opt in.

**Cloudflare deployment** — have these ready before you deploy:

- **Final HTTPS hostname** (for example `https://example.com`) that already lives in an active Cloudflare DNS zone owned by the account you will deploy into. Setup rejects `workers.dev`, non-HTTPS, and localhost origins.
- **Approved Cloudflare account ID** — the 32-character hexadecimal ID of the account you explicitly choose.
- **Explicit approval** to create resources (Worker, D1, R2, KV, and newsletter resources if enabled), attach the custom domain, and deploy.
- **Account-scoped Cloudflare API token**, scoped to that account and zone, with exactly these setup permissions:
  - Account: Account Settings Read, D1 Edit, Workers R2 Storage Edit, Workers KV Storage Edit, Workers Scripts Edit.
  - Zone: Workers Routes Edit (required for the production custom domain).
  - Create it with [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/); permission names are in the [API permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
- **Token file workflow.** The agent creates the ignored `.env.cloudflare.local` from the tracked `.env.cloudflare.local.example`, leaves both values blank, and sets mode `0600`. Open `.env.cloudflare.local` in your own editor and fill in the existing `CLOUDFLARE_API_TOKEN=` and `CLOUDFLARE_ACCOUNT_ID=` lines; leave the tracked example untouched. Never put the token in chat or on a command line.

  After you approve the resources, the custom domain, and the deployment, the agent runs `bun run --env-file=.env.cloudflare.local cloudflare:setup`. The file stays plaintext on disk until you delete it and revoke the token after setup, bootstrap-secret removal, and any retries are complete.
- **An interactive terminal** for the setup run — Wrangler prompts about custom-domain and DNS conflicts, so do not run setup detached.
- **Generated secrets, saved before setup.** Produce the two deployment secrets with these commands, then save the resulting values (not the commands) in your password manager:

  ```sh
  # EMDASH_ENCRYPTION_KEY: emdash_enc_v1_ plus 43 unpadded base64url chars.
  printf 'emdash_enc_v1_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"

  # EMDASH_BOOTSTRAP_SECRET: raw unpadded base64url value, no prefix.
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
  ```

  Save the first command's output as `EMDASH_ENCRYPTION_KEY` exactly as printed; the `emdash_enc_v1_` prefix is part of the value. Save the second as `EMDASH_BOOTSTRAP_SECRET`. Setup never generates these for you; it prompts for each saved value through hidden input, so nothing is echoed or written to disk. An existing site requires its original encryption key, so losing it is unrecoverable.

**Site interview** — your agent can propose these and confirm them with you, so you do not need every value decided up front:

- CMS-owned details: site title, tagline, primary navigation, and the logo image. Upload the logo in `/_emdash/admin` after the wizard; the seed does not carry uploaded media.
- Developer-owned details in `src/site.config.ts`: avatar, bio, location, roles, public contact email, social links, and your analytics choice — Cloudflare Web Analytics (recommended), another provider, or none. Cloudflare Web Analytics needs no repo token and is switched on in the dashboard after deployment; any other provider needs its account or site plus the script URL and any snippet details you want loaded.
- Local EmDash setup is **not** a production prerequisite. Run `bun run build` and `bun run check` locally at any time; the production passkey is registered only on the final HTTPS hostname after deployment.

**Newsletter (opt in only)** — skip this unless you want signups:

- Onboard your sending domain in [Cloudflare Email Service](https://developers.cloudflare.com/email-service/configuration/domains/) with its DNS records ready. Onboarding the domain is the only sender prerequisite; the individual sender address is not separately verified, so pick any address at that onboarded domain.
- Choose the sender address, consent version, and public description.
- Create a [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/) for the final hostname and keep both the public site key and the private secret key. Setup reads the secret through masked input and never writes it to the repository.
- Choose a `namespace_id` for `NEWSLETTER_SUBSCRIBE_LIMITER`: any positive integer unique for the account. Per the [Rate Limiting binding docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), there is no dashboard resource to create.
- Create a `NEWSLETTER_ADMIN_TOKEN` of at least 32 characters in your password manager; setup prompts for the saved value.
- Optional: a Resend Segment ID and API key, only if you want Resend segment synchronization.

**After deployment**

- Register the production passkey through `/_emdash/admin/setup` on the final HTTPS hostname. Never register it on a `workers.dev` origin.
- Upload the logo in `/_emdash/admin`.
- Turn on Cloudflare Web Analytics in the dashboard for that zone, or configure the provider you chose.

## Set up with an agent

Open a coding agent in your scaffolded site directory (the new project `create-astro` created, not the upstream template source), copy the prompt below, and paste it:

<details open>
<summary>Copy the agent setup prompt</summary>

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
key, expected hostname, consent version, and a fallback newsletter description.
For Cloudflare Web Analytics, keep the custom analytics
hook in src/site.config.ts disabled and set it up in the Cloudflare dashboard
after the site is deployed (see the Analytics section); only ask for a script
URL and domain — or provider-specific snippet details — if I pick a different
provider. Leave the custom analytics hook and the newsletter signup disabled
(and their optional sub-fields, including the description, clear) unless I
confirm I want them and give you the values — never invent placeholders like
"yourusername" or "your-domain.com".

2. CMS-owned site details: the site title, tagline, logo, and the primary
navigation menu I want; if I enable the newsletter, ask for its visible page
description too. These are owned by the EmDash CMS at runtime, not
src/site.config.ts — never put them in site.config.ts. Apply the title, tagline,
primary menu, and newsletter page description through the bundled seed (which only initializes a fresh, empty
database) or, on an already initialized site, through /_emdash/admin after the
setup wizard; if you use the seed, edit .emdash/seed.json settings/menu and its
newsletter_page record, then run
bun run types:generate. Set the logo through /_emdash/admin, since the seed does
not carry the uploaded logo media.

Work locally first: bun install, bun run check, bun run seed:validate,
bun run build. Keep site.config.ts at the local default (http://localhost:8787)
until I give you my production hostname. Do not create Cloudflare resources,
secrets, or deployments without my explicit approval. Before any production
provisioning, ask me for my final canonical hostname and the explicitly approved
Cloudflare account ID, then set site.config.ts:url to https://<hostname>.
Require an account-scoped CLOUDFLARE_API_TOKEN with the least-privilege scopes
documented in docs/operations.md. Create the ignored .env.cloudflare.local from
the tracked .env.cloudflare.local.example with both values left blank and mode
0600, then ask me to open it in my own editor and fill in the existing token and
account ID lines instead of giving me a shell command that makes the copy. Never
read, print, or commit the value, and never ask me to paste a token into chat or
onto a command line. Only after I have filled the file and explicitly approved
the resources, the custom domain, and the deployment, run provisioning as
`bun run --env-file=.env.cloudflare.local cloudflare:setup`. After the first
admin is registered, use the same token to remove EMDASH_BOOTSTRAP_SECRET as
documented in docs/operations.md; then have me delete the file and revoke the
token once no retry is pending.
Once the site is deployed, complete /_emdash/admin/setup on that final origin
only — never register the production passkey on a workers.dev origin.
```

</details>

You remain responsible for account choice, resource approval, domain/zone ownership, passkey registration, and any optional third-party credentials. Hand the agent `AGENTS.md` and [docs/operations.md](docs/operations.md) for the full runbook.

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

The bundled `.emdash/seed.json` initializes empty databases only — it never updates an existing site's schema or content. To change the content model, edit the seed and run `bun run types:generate`, which regenerates `.emdash/types.ts` and `.emdash/schema.json` offline; commit both. Never hand-maintain field definitions in `src/emdash-types.d.ts`. On the first setup screen, keeping sample content gives you demo posts, projects, and pages; clearing **Include sample content (recommended for new sites)** starts clean while retaining schema, settings, and navigation.

## Commands

| Command | Action |
| --- | --- |
| `bun run cf:dev` | Build and run the Worker locally with simulated D1/R2/KV bindings |
| `bun run dev` | Astro-only frontend dev server |
| `bun run build` | Build production SSR output |
| `bun run check` | Type-check and lint |
| `bun run seed:validate` | Validate `.emdash/seed.json` |
| `bun run types:generate` | Regenerate `.emdash/types.ts` and `.emdash/schema.json` |
| `bun run --env-file=.env.cloudflare.local cloudflare:setup` | Provision with an approved account-scoped token from the ignored `.env.cloudflare.local` and safely resume the prepared-version deployment |
| `bun run preview:setup` | Preview setup progress and run a real local build without contacting Cloudflare |
| `bun run test:setup` | Run failure-injection tests for resumable provisioning |
| `bun run smoke:worker` | Start isolated local Worker bindings and smoke-test setup/runtime boundaries |
| `bun run cf:deploy` | Build and deploy an already configured Worker |

Use `bun run cf:dev` for local work and `bun run cf:deploy` for later production deploys. Never deploy with bare `wrangler deploy`/`wrangler dev` — they skip the Astro SSR build.

## Deployment

Deployment is optional; you can develop locally indefinitely. Follow the [manual deployment guide](docs/manual-deployment.md) to set up a site without an agent. [AGENTS.md](AGENTS.md) covers provisioning requirements, and [docs/operations.md](docs/operations.md) has backups, restores, staging isolation, post-cutover checks, and passkey recovery. CI and the isolated local Worker smoke test are documented in [docs/ci.md](docs/ci.md).

## Advanced integrations

The bundled EmDash skill, the optional `emdash-docs` MCP server, and the deployed-site MCP endpoint are documented in [AGENTS.md](AGENTS.md). A fresh scaffold includes the skill already, and Codex, OpenCode, and Claude Code all discover it without a registry install. Setup never depends on the MCP server; when its tools are not callable, read https://docs.emdashcms.com/ directly.

## Analytics

Cloudflare Web Analytics is the recommended production default: enable it in the Cloudflare dashboard after the site is live on its custom domain, and Cloudflare auto-injects the site-wide beacon. Keep `analytics.enabled: false` in `src/site.config.ts` for that option. For another provider, or to turn analytics off, see [docs/analytics.md](docs/analytics.md).

## Newsletter

The newsletter page is visible by default, but signup stays disabled until its opt-in integration is provisioned (an onboarded Email Sending domain with DNS, a Turnstile site key and secret, a rate-limit namespace ID, and a `NEWSLETTER_ADMIN_TOKEN`). See [Production prerequisites](#production-prerequisites) and [docs/newsletter.md](docs/newsletter.md) for architecture, configuration, and operations.
