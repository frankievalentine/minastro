# minastro

An EmDash-first personal-site template built with Astro and Cloudflare Workers.

## Create a site

```bash
bun install
bun run cloudflare:setup
```

The interactive setup authenticates Wrangler; provisions the required D1, R2,
and session KV resources; writes their bindings to `wrangler.jsonc`; stores
`EMDASH_ENCRYPTION_KEY`; then builds and deploys the Worker.

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
- Posts, projects, tags, and CMS-managed media
- CMS Pages and their sidebar-menu placement

`src/site.config.ts` intentionally owns presentation values without an EmDash
equivalent: the starter avatar, bio, location, roles, social links, analytics,
and newsletter integration settings.

New empty databases receive `.emdash/seed.json`, including representative
posts, projects, and a CMS-managed **Start here** page. Seeds do not update an
existing database. Manage live schema and content in EmDash; use
`emdash export-seed --with-content` only when deliberately updating the starter
seed.

### Add a sidebar page

1. In **EmDash → Pages**, create and publish a page.
2. In **EmDash → Navigation → Primary Navigation**, add a **Page** item that
   references it, then order it where you want in the sidebar.

The menu controls navigation; it does not create page content. Root-level CMS
page routes are rendered by Minastro while fixed routes such as `/posts`,
`/projects`, and `/newsletter` retain precedence.

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
| `bun run cloudflare:setup` | Provision and deploy the initial Cloudflare stack |
| `bun run cf:deploy` | Build and deploy an already configured Worker |

## Stack

- Astro 7
- EmDash CMS with D1 and R2
- Cloudflare Workers
- Tailwind CSS 4 and basecoat-css
