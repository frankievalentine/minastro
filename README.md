# minastro

An EmDash-first personal-site template built with Astro and Cloudflare Workers.

## Getting Started

### EmDash MCP servers

This repository commits a single project MCP server, `emdash-docs`
(`.mcp.json`), which points at the official public EmDash documentation MCP.
It is read-only and requires no token.

EmDash also exposes an HTTP MCP endpoint on your deployed site at
`<your-deployment-origin>/_emdash/api/mcp`. Unlike the docs server, it can
access your live content and must not be committed: configure it per user and
per client, authenticate with OAuth/device flow or a locally stored
personal access token (PAT), and start with the least-privilege `content:read`
scope. Never commit PATs or project-wide write/admin credentials to this
repository. Verify the endpoint is available after deployment before relying
on it.

### Local development (no Cloudflare account required)

A fresh clone runs entirely locally with no Cloudflare account, no domain, and
no provisioning:

```bash
git clone https://github.com/frankievalentine/minastro.git
cd minastro
bun install
bun run cf:dev
```

`cf:dev` builds the Astro SSR output and then runs `wrangler dev --local
--port 8787`, so the D1, R2, and KV bindings EmDash needs are simulated
locally. The committed `siteConfig.url` is `http://localhost:8787`, which
exactly matches this origin — including for local WebAuthn passkeys. Open
`http://localhost:8787` and complete the one-time EmDash setup at
`/_emdash/admin/setup`.

- Simulated bindings persist in `.wrangler/state`, so your local content
  survives restarts.
- To reset local state, delete **only** the `.wrangler/state` directory; the
  next `bun run cf:dev` starts from an empty database and re-applies the seed.
- Passkeys you register on localhost are bound to that origin and do not work
  in production. Register the production passkey later on your final deployed
  hostname.
- On the first setup screen you choose whether to include sample content:
  both choices are fully supported. Keeping it demonstrates posts, projects,
  and pages; clearing **Include sample content (recommended for new sites)**
  gives you a clean site while retaining the schema, settings, and navigation.

`bun run dev` is Astro-only and is useful for frontend work, but it does not
provide the D1, R2, or Workers bindings required by EmDash.

### Deploying to Cloudflare (optional)

Deployment is a separate step owned by you, the clone user. Nothing in this
repository provisions on your behalf until you run it. You can develop locally
indefinitely without ever doing this. Installing the theme attaches no domain
and performs no deployment; the committed `siteConfig.url` stays on
`http://localhost:8787` until you deliberately deploy.

Before any production deployment, replace `src/site.config.ts`'s
`siteConfig.url` with your canonical HTTPS URL (for example,
`https://example.com`). The localhost default is functional for local
development only and must not serve production.

#### Agent-guided setup

Open a coding agent in this clone and paste the following prompt:

```text
Set up a new Minastro deployment from this clone. Read README.md and AGENTS.md
first. If an emdash-docs MCP server is available in your client, use it for
current EmDash questions; do not guess EmDash behavior from memory. Run bun
install, bun run check, bun run seed:validate, bun run build,
and bunx wrangler whoami; report any failures and confirm the authenticated
Cloudflare account. Before provisioning anything, ask me for my final
canonical production hostname and confirm with me that it lives in an active
Cloudflare zone owned by that account; never plan to serve production from a
workers.dev address. Do not create Cloudflare resources, attach domains, or
deploy until I approve. After approval, set src/site.config.ts to
https://<hostname> and add { "pattern": "<hostname>", "custom_domain": true }
to a top-level routes array in wrangler.jsonc. Then run bun run
cloudflare:setup from an interactive terminal, use a unique Worker name, and
review any Wrangler conflict prompt rather than bypassing it. Skip the optional
newsletter unless I explicitly provide its Email Sending, Turnstile, and Rate
Limiting prerequisites. Do not expose or commit secrets. Once deployed, verify
the final HTTPS origin responds, then guide me through /_emdash/admin/setup at
that origin only. On the first EmDash setup screen, ask me whether to include
sample content — both including and clearing “Include sample content
(recommended for new sites)” are supported — and apply my choice before
continuing, then smoke-test the public site and CMS routes. Never register the
production passkey on a workers.dev origin.
```

Setup cannot automate everything. You remain responsible for authenticating
Wrangler and choosing the Cloudflare account, approving resource creation,
owning the domain's zone in that account, registering the production passkey,
and supplying any optional newsletter or third-party credentials. Registrar
transfers and DNS hosted outside Cloudflare are outside what this repository
automates.

### Manual deployment setup

```bash
git clone https://github.com/frankievalentine/minastro.git
cd minastro
bun install
bun run cloudflare:setup
```

Before setup, choose the production hostname you intend to keep. With explicit
approval, set `src/site.config.ts` to its HTTPS URL and add the hostname as a
Worker custom-domain route in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "example.com", "custom_domain": true }]
```

The interactive setup provisions the required D1, R2, and session KV resources;
writes their bindings to `wrangler.jsonc`; stores `EMDASH_ENCRYPTION_KEY`; and
deploys the configured Worker. Run it from a terminal so Wrangler can show any
custom-domain or DNS conflict prompt.

Cloudflare handles DNS and TLS for the attached hostname only when it lives in
an active zone owned by the authenticated account. Confirm that pairing before
provisioning; owning a domain registered elsewhere does not let this script
transfer the registrar or manage arbitrary external DNS.

Setup changes `wrangler.jsonc` with the provisioned resource IDs and Worker
name. The agent/operator applies the approved canonical route and site URL
before setup. Worker secrets are stored in Cloudflare and are never written to
the repository. Use a separate clone when testing an installation without
changing an existing checkout.

Verify the final HTTPS origin responds at your canonical hostname, then open
it and complete the one-time EmDash setup at `/_emdash/admin/setup`. Register
the production passkey at that final origin: `*.workers.dev` and a custom
domain are different WebAuthn origins. Use `*.workers.dev` only for temporary
testing; it should never receive the production passkey.

Minastro’s seed includes optional example posts, projects, and a page. EmDash
checks **Include sample content (recommended for new sites)** by default; clear
that checkbox on the first setup screen to create a clean site while retaining
the schema, settings, and navigation. Both choices are supported; see
[Local development](#local-development-no-cloudflare-account-required) for the
same choice on localhost.

Deploy later changes with:

```bash
bun run cf:deploy
```

## Customize content

EmDash is the runtime source of truth. It owns:

- Site title, tagline, logo, and primary navigation
- Posts-per-page pagination and visible date preferences (date format and
  IANA timezone)
- Posts, projects, tags, and CMS-managed media
- CMS Pages and their sidebar-menu placement

`/robots.txt` and `/sitemap.xml` are served by the EmDash runtime as well: do
not add static files or custom routes that replace them.

`src/site.config.ts` intentionally owns presentation values without an EmDash
equivalent: the starter avatar, bio, location, roles, social links, analytics,
and newsletter integration settings. Site identity (title, tagline, logo) and
primary navigation have no local fallbacks — they come from the CMS only. A
missing CMS site title fails visibly, and an absent or empty primary menu
renders no navigation items.

New empty databases receive `.emdash/seed.json`, including initial site
settings, representative posts, projects, and a CMS-managed **Start here**
page. Seeds initialize fresh databases only; they do not update an existing
database. Manage live schema, content, and settings in EmDash; use
`emdash export-seed --with-content` only when deliberately updating the starter
seed.

### Generated collection types

The committed `.emdash/types.ts` and `.emdash/schema.json` are generated
artifacts describing the default model seeded by this repository, so a fresh
clone gets typed queries for every seeded collection out of the box. They are
derived deterministically from `.emdash/seed.json`: after changing the content
model in the seed, regenerate them offline (no running server or auth needed):

```bash
bun run types:generate
```

Then commit the updated `.emdash/types.ts` and `.emdash/schema.json`. The
generator reuses EmDash's own type-generation code, so its output matches what
`emdash types` emits for a database seeded with that file.
`src/emdash-types.d.ts` only maps collection slugs to the generated interfaces —
do not hand-maintain field definitions there.

### Add a sidebar page

1. In **EmDash → Pages**, create and publish a page.
2. In **EmDash → Navigation → Primary Navigation**, add a **Page** item that
   references it, then order it where you want in the sidebar.

The menu controls navigation; it does not create page content. Root-level CMS
page routes are rendered by Minastro while fixed routes such as `/posts`,
`/projects`, and `/newsletter` retain precedence.

### Rich text

EmDash stores rich text as Portable Text. The editor supports headings;
bold, italic, underline, and strikethrough marks; links; ordered and unordered
lists; blockquotes; and code blocks. The seeded **Welcome to your site** post
exercises these blocks, including a TypeScript code example.

Minastro overrides only the rendering of Portable Text `_type: "code"` blocks
with its server-side Shiki highlighter (`src/components/CodeBlock.astro`). This
is a template-level override, not an EmDash-native integration. All other
built-in Portable Text components are rendered by the EmDash renderer unless
locally overridden.

### Comments

Comments are enabled on **Posts** via `commentsEnabled` in `.emdash/seed.json`.
EmDash's migration defaults supply the rest of the policy on fresh databases:
first-time-commenter moderation and auto-approval for authenticated EmDash
users. One caveat: as of emdash 0.32 the seed format cannot express the
auto-closure window, which defaults to 90 days. To keep post comments open
indefinitely, set **Auto-close comments** to `0` once per deployment in
**EmDash → Posts → collection settings**.

## Newsletter and Resend

The newsletter page is visible by default so the template demonstrates the
feature, but signup is disabled until configured. The recommended
`cloudflare:setup` newsletter phase provisions its D1 database, bindings,
migrations, and secrets. Before enabling it, verify a sending domain in
Cloudflare Email Sending, create a Turnstile widget, and obtain a Rate Limiting
namespace ID.

Cloudflare Email Sending handles double-opt-in confirmation messages. Optional
Resend synchronization keeps confirmed subscribers in a Resend Segment; create
and send Broadcasts in Resend. See [docs/newsletter.md](docs/newsletter.md) for
the full operational flow.

## Commands

| Command | Action |
| --- | --- |
| `bun run cf:dev` | Build and run the Worker locally with simulated D1/R2/KV bindings (`wrangler dev --local --port 8787`) |
| `bun run dev` | Start Astro’s frontend-oriented dev server |
| `bun run build` | Build Worker SSR output |
| `bun run check` | Run Astro checks and ESLint |
| `bun run seed:validate` | Validate `.emdash/seed.json` with EmDash |
| `bun run types:generate` | Regenerate `.emdash/types.ts` and `.emdash/schema.json` from `.emdash/seed.json` |
| `bun run cloudflare:setup` | Provision and deploy the initial Cloudflare stack |
| `bun run cf:deploy` | Build and deploy an already configured Worker |

## Stack

- Astro 7
- EmDash CMS with D1 and R2
- Cloudflare Workers
- Tailwind CSS 4 and basecoat-css
