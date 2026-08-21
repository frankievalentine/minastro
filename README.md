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

### Agent-guided setup

Open a coding agent in this clone and paste the following prompt:

```text
Set up a new Minastro deployment from this clone. Read README.md and AGENTS.md
first. If an emdash-docs MCP server is available in your client, use it for
current EmDash questions; do not guess EmDash behavior from memory. Run bun
install, bun run check, bun run seed:validate, bun run build,
and bunx wrangler whoami; report any failures and confirm the authenticated
Cloudflare account. Do not create Cloudflare resources or deploy until I
approve. After approval, run bun run cloudflare:setup, use a unique Worker
name, and skip the optional newsletter unless I explicitly provide its Email
Sending, Turnstile, and Rate Limiting prerequisites. Do not expose or commit
secrets. Once deployed, report the deployment URL, guide me through
/_emdash/admin/setup, and smoke-test the public site and CMS routes.
```

### Manual setup

```bash
git clone https://github.com/frankievalentine/minastro.git
cd minastro
bun install
bun run cloudflare:setup
```

The interactive setup authenticates Wrangler; provisions the required D1, R2,
and session KV resources; writes their bindings to `wrangler.jsonc`; stores
`EMDASH_ENCRYPTION_KEY`; then builds and deploys the Worker.

Setup changes `wrangler.jsonc` with the provisioned resource IDs and Worker
name. Worker secrets are stored in Cloudflare and are never written to the
repository. Use a separate clone when testing an installation without changing
an existing checkout.

Open the deployed URL and complete the one-time EmDash setup at
`/_emdash/admin/setup`. Register the production passkey at the final origin:
`*.workers.dev` and a custom domain are different WebAuthn origins. Connect a
custom domain before completing production setup, or bootstrap it separately.

For Worker-compatible local development **after bindings are configured**:

```bash
bun run cf:dev
```

`bun run dev` is Astro-only and is useful for frontend work, but it does not
guarantee the D1, R2, or Workers bindings required by EmDash.

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

`src/site.config.ts` intentionally owns presentation values without an EmDash
equivalent: the starter avatar, bio, location, roles, social links, analytics,
and newsletter integration settings. It also provides fallbacks for identity
and navigation only when CMS settings or a primary menu are absent.

New empty databases receive `.emdash/seed.json`, including initial site
settings, representative posts, projects, and a CMS-managed **Start here**
page. Seeds initialize fresh databases only; they do not update an existing
database. Manage live schema, content, and settings in EmDash; use
`emdash export-seed --with-content` only when deliberately updating the starter
seed.

### Generated collection types

The committed `.emdash/types.ts` and `.emdash/schema.json` are generated
artifacts describing the default model seeded by this repository, so a fresh
clone gets typed `posts` and `projects` queries out of the box. They reflect a
running schema, not an independent source of truth: after changing the content
model (in the CMS or the seed), regenerate them from a running EmDash instance:

```bash
bun run types:generate -- --url http://localhost:4321
```

Then commit the updated `.emdash/types.ts` and `.emdash/schema.json`. Never
pass or commit auth tokens; generate against a local runtime or an instance you
authenticate with interactively. `src/emdash-types.d.ts` only maps collection
slugs to the generated interfaces — do not hand-maintain field definitions
there.

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
| `bun run cf:dev` | Build and run the Worker locally after bindings are configured |
| `bun run dev` | Start Astro’s frontend-oriented dev server |
| `bun run build` | Build Worker SSR output |
| `bun run check` | Run Astro checks and ESLint |
| `bun run seed:validate` | Validate `.emdash/seed.json` with EmDash |
| `bun run types:generate` | Generate `.emdash/types.ts` and `.emdash/schema.json` from a running EmDash URL (`-- --url <url>`) |
| `bun run cloudflare:setup` | Provision and deploy the initial Cloudflare stack |
| `bun run cf:deploy` | Build and deploy an already configured Worker |

## Stack

- Astro 7
- EmDash CMS with D1 and R2
- Cloudflare Workers
- Tailwind CSS 4 and basecoat-css
