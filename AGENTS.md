# AGENTS.md

## Commands

```bash
bun run cf:dev           # Build and run the Worker locally on port 8787 with simulated D1/R2/KV bindings (wrangler dev --local --port 8787); no Cloudflare account or provisioning required
bun run smoke:worker     # Run isolated local Worker setup/runtime smoke coverage; no credentials or deployment required
bun run dev              # Astro-only frontend development server
bun run build            # Build production SSR output
bun run check            # Type-check and lint
bun run seed:validate    # Validate the EmDash bootstrap seed
bun run types:generate   # Regenerate .emdash/types.ts and .emdash/schema.json from .emdash/seed.json
bun run cloudflare:setup # Provision D1/R2 and deploy the configured Worker once
bun run cf:deploy        # Deploy an already configured Worker
```

`wrangler.jsonc` declares no build command: `bun run cf:dev` and `bun run
cf:deploy` run `bun run build` themselves before invoking Wrangler. Never
deploy with a bare `wrangler deploy`/`wrangler dev`, which would skip the
Astro SSR build.

`bun run cf:dev` uses `wrangler dev --local --port 8787`: D1, R2, and KV are
simulated locally, state persists in `.wrangler/state`, and deleting only that
directory resets local data. The committed `siteConfig.url` is
`http://localhost:8787` — the functional local default that exactly matches
this origin, including for local WebAuthn passkeys. It requires no configured
remote bindings, no Cloudflare account, and no provisioning; localhost
passkeys do not transfer to a deployed origin. A site owner must replace
`siteConfig.url` with their canonical HTTPS URL before any production
deployment; theme installation attaches no domain.

## EmDash agent reference

### Bundled skill (primary)

EmDash ships an official `building-emdash-site` agent skill, bundled into this
template as `.agents/skills/building-emdash-site/SKILL.md` and version-pinned to
the installed EmDash release (`emdash` 1.0.1 in `package.json`). It is the
primary reference for EmDash work here: read it before editing queries, seeds,
Portable Text rendering, menus, taxonomies, widgets, or deployment config.

Read `SKILL.md` first, then the reference it points to for the task at hand:

- `.agents/skills/building-emdash-site/references/configuration.md` — `astro.config.mjs`, `live.config.ts`, deployment targets, type generation
- `.agents/skills/building-emdash-site/references/schema-and-seed.md` — collections, field types, taxonomies, menus, widget areas, the seed format
- `.agents/skills/building-emdash-site/references/querying-and-rendering.md` — content queries, Portable Text, the Image component, caching, page patterns
- `.agents/skills/building-emdash-site/references/site-features.md` — settings, navigation, taxonomies, widgets, search, SEO, comments

The skill describes generic EmDash projects. Where it differs from this
template, follow this repository's conventions and commands:

- Seed path is `.emdash/seed.json` (declared via the `emdash.seed` field in `package.json`), not `seed/seed.json`.
- Regenerate collection types with `bun run types:generate`; it derives `.emdash/types.ts` and `.emdash/schema.json` from the seed offline.
- Run and test locally with `bun run cf:dev` (port 8787, simulated D1/R2/KV), not `pnpm dev`/`npm run dev`.
- Validate the seed with `bun run seed:validate` and type-check with `bun run check`.
- Deployment follows the Cloudflare provisioning section below; do not substitute the skill's generic deploy steps.

Client discovery needs no extra install: Codex and OpenCode both scan
`.agents/skills` directly, Claude Code discovers it through the committed
`.claude/skills` symlink to `.agents/skills`, and this document also points
agents at the same files. Edit the skill only under `.agents/skills`; the
symlink cannot drift because it shares one target.

### Live docs (supplement)

The skill is pinned to 1.0.1, so for anything newer — release notes, changed
APIs, new field types — consult the official documentation. Two project config
files optionally declare the public `emdash-docs` docs MCP server, which is
read-only and needs no token: `.mcp.json` for Claude Code and
`.codex/config.toml` (`[mcp_servers.emdash-docs]`) for Codex. It is a supplement
to the bundled skill, not a replacement, and setup can proceed without it.

If the `emdash-docs` tools are callable in your session, use them. If they are
not callable, do not stop and do not report the EmDash docs as unavailable:
consult the official documentation directly at https://docs.emdashcms.com/ and
continue. Codex loads project-scoped config only for a trusted repository, and a
server added after a session started is not callable until a new session begins.

The deployed-site MCP at `<your-deployment-origin>/_emdash/api/mcp` requires
authentication and is configured per user/client; never place site MCP
credentials, PATs, or write/admin scope configs in this repository.

## Cloudflare provisioning (deployment only)

Local development never needs this section: `bun run cf:dev` runs fully
locally with simulated bindings. The steps below apply only when deploying a
scaffolded site project to Cloudflare.

For a new deployment, run `bunx wrangler whoami` first. Authenticate with
`bunx wrangler login` if necessary, and confirm it targets the intended
Cloudflare account with permission to create Workers, D1 databases, R2 buckets,
KV namespaces, and Worker secrets.

Before provisioning, ask the user for their final canonical hostname. Confirm
with them that the hostname lives in an active Cloudflare zone owned by that
authenticated account, and obtain explicit approval before creating resources,
attaching the domain, or deploying. After approval, set `src/site.config.ts`
to `https://<hostname>` and add `{ "pattern": "<hostname>",
"custom_domain": true }` to a top-level `routes` array in `wrangler.jsonc`.
Cloudflare handles DNS and TLS for the attached hostname only under those
conditions; registrar transfers and DNS hosted outside Cloudflare cannot be
automated by this repository, so never assume an arbitrary external hostname
can be attached.

Prefer the user's ignored local env file over chat for credentials, since
exported variables remain an accepted alternative: have the user copy the
tracked `.env.cloudflare.local.example` to `.env.cloudflare.local` at mode
0600, fill in `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and run
`bun run --env-file=.env.cloudflare.local cloudflare:setup`. Never ask the user
to paste a token into the conversation or into a command line, and never read,
print, echo, or commit the file's value; the setup script reads the variables
from the process environment. After a successful setup with no retry pending,
have the user delete `.env.cloudflare.local` and revoke or delete the token in
Cloudflare.

Run that setup command only from the scaffolded site project being deployed and
an interactive terminal so Wrangler can show any custom-domain or DNS conflict
prompt. On a fresh Worker it first deploys an inert private base Worker
(`workers_dev: false`, no routes, triggers, or assets; it answers only `503`),
because Wrangler's `versions upload` requires one prior deployment. That step is
a versioning prerequisite, not a public site deployment: the real Astro output
is built and uploaded as a version afterward, then deployed at 100% traffic,
and only the later `wrangler triggers deploy` phase attaches the custom domain.
The command creates the Worker, D1 database, R2 bucket, session KV
namespace, and the `EMDASH_ENCRYPTION_KEY` secret; it then writes the Worker
name and binding IDs to `wrangler.jsonc` and deploys the route/site URL
configured above. Do not deploy while the placeholder IDs remain, and do not
manually replace only some placeholders: the setup script rejects partially
configured core bindings to prevent duplicate resources.

Wrangler 4.120 does not accept a `--json` flag on `wrangler d1 create`.
Do not add that flag to D1 provisioning commands; use the currently supported
machine-readable output or a documented API response instead.

Worker secrets are stored in Cloudflare and never committed.
`.env.cloudflare.local` is a different thing: an ignored, operator-owned
plaintext file holding the account-scoped setup token for the interactive
provisioning run only, which must never be committed or reused as a Worker
binding. `.dev.vars` is ignored and is only for local development; it cannot
create Cloudflare bindings either. The newsletter setup is optional and needs
an onboarded Email Sending domain, Turnstile keys, and a Rate Limiting
namespace. Skip it unless those values are available and the deployment
explicitly includes newsletter signup.

Email Sending domain onboarding is the only sender prerequisite. A domain must
be onboarded (with its required DNS records) before its addresses can send, but
an individual sender mailbox/address is not separately verified: any address at
the onboarded domain may send. `allowed_sender_addresses` on the `send_email`
binding is an optional restriction on which addresses the binding accepts, not
a verification or approval step, and `bun run cloudflare:setup` writes the
chosen `senderAddress` into it automatically. Do not ask the user to verify or
approve an individual sender address, and do not ask them to edit
`allowed_sender_addresses` by hand; confirm only that the sender's domain is
onboarded for Email Sending.

Manual responsibilities remain with the user: authentication and account
choice, resource approval, external domain/zone ownership, domain onboarding
for Email Sending, passkey registration, and any optional third-party
credentials.

After initial provisioning, use `bun run cf:dev` for Worker-compatible local
testing and `bun run cf:deploy` for later deployments.

Production setup is deployment-specific: verify the final HTTPS origin responds
at the canonical hostname, then complete the EmDash setup wizard at
`/_emdash/admin/setup` on that final origin only; register its production
passkey there. `*.workers.dev` URLs are for temporary testing only: they are a
different WebAuthn origin from the custom domain and must not receive the
production passkey. On the first wizard screen, the sample-content choice is
the operator's: both including and clearing **Include sample content
(recommended for new sites)** are supported; schema, settings, and navigation
are applied either way.

## Architecture

Astro 7 runs server-side on Cloudflare Workers. EmDash is the sole source of runtime content, using D1 for data and R2 for media. `src/worker.ts` re-exports the EmDash Worker handler and `PluginBridge`.

On an empty database, EmDash applies core migrations and the bundled `.emdash/seed.json` automatically. The first request redirects to `/_emdash/admin/setup`; after the one-time setup wizard, the seed provides the schema, initial settings/menu, sample posts/projects, and a CMS-managed Pages collection. Changed seeds do not mutate existing sites.

CMS-backed posts, projects, root Pages, RSS, layout navigation, and search query EmDash. The newsletter UI is the only static template exception. Do not add local-content fallbacks for CMS routes: CMS errors must remain visible. The admin is at `/_emdash/admin`; search uses `/_emdash/api/search`. `/robots.txt` and `/sitemap.xml` are owned by the EmDash runtime: do not add static or custom replacements. Do not assume custom collections are automatically included in the sitemap without verifying the installed EmDash runtime.

Collection typing comes from generated artifacts: `.emdash/types.ts` (interfaces) and `.emdash/schema.json` (schema snapshot) are committed defaults describing the seeded model so fresh clones type-check. They are derived deterministically from the declared `.emdash/seed.json` without a running server: after any content-model change, edit the seed and run `bun run types:generate`, then commit both regenerated files. The generator reuses EmDash's own type-generation code, so its output matches what `emdash types` would emit for a database seeded with that file. `src/emdash-types.d.ts` only maps slugs to the generated interfaces via `EmDashCollections`; never hand-maintain field definitions there or duplicate the model elsewhere.

`src/site.config.ts` holds presentation values that have no EmDash equivalent: bio, location, roles, social links, newsletter integration settings, and the optional custom analytics hook. Site identity (title, tagline, logo) and the primary navigation are CMS-owned only: there are no local fallbacks for them, a missing CMS site title fails visibly, and an absent or empty primary menu renders no navigation items. CMS settings also own posts-per-page pagination and visible date preferences (date format and IANA timezone). Seed settings initialize fresh empty databases only. CMS Pages are rendered by `src/pages/[slug].astro`; fixed Astro routes retain precedence.

Rich text is Portable Text; the editor supports headings; bold, italic, underline, and strikethrough marks; links; lists; blockquotes; and code blocks. Minastro overrides only `_type: "code"` block rendering with its server-side Shiki `src/components/CodeBlock.astro` — a template-level override, not an EmDash-native integration. All other built-in Portable Text components are rendered by the EmDash renderer unless locally overridden.

All CMS Pages currently share the presentation in `src/pages/[slug].astro`. Per-page layouts are not auto-discovered: supporting distinct layouts would require an explicit field-to-layout mapping added to that route.

The newsletter page is visible by default, but signup is disabled until its advanced, opt-in integration is provisioned. Its operational instructions live in `docs/newsletter.md`; `bun run cloudflare:setup` is the supported provisioning path.

## Analytics

Cloudflare Web Analytics is the recommended production default, and it is deliberately outside this repository: there is no token, snippet, dependency, API call, or Worker binding for it. The operator enables it in the Cloudflare dashboard once the site is live on its custom domain, and Cloudflare auto-injects the site-wide beacon for the zone (covering `/_emdash/admin` and tracking SPA navigation). Verify the beacon live before treating it as working; do not assume injection applied. Never add a Cloudflare token, account ID, or snippet to the repository for this option.

`siteConfig.analytics` is the generic hook for a *different* provider only — a `text/partytown` script `src` plus optional `data-domain` rendered by `src/layouts/Layout.astro`. `analytics.enabled` is not a Cloudflare switch: keep it `false` with Cloudflare Web Analytics to avoid duplicate or redundant tracking, and enable it only when the operator picks another provider. Provider snippets that need more than a script `src` and `data-domain` require a `Layout.astro` edit. When the operator has no analytics preference, recommend Cloudflare and confirm before dashboard activation — dashboard changes are the operator's explicit call.
