# AGENTS.md

## Commands

```bash
bun run cf:dev           # Build and run the Worker locally on port 8787 with simulated D1/R2/KV bindings (wrangler dev --local --port 8787); no Cloudflare account or provisioning required
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
passkeys do not transfer to a deployed origin. A clone user must replace
`siteConfig.url` with their canonical HTTPS URL before any production
deployment; theme installation attaches no domain.

## EmDash MCP

Use the committed `emdash-docs` MCP server (`.mcp.json`, official public docs,
read-only, no token) for current EmDash questions instead of relying on
memory. The deployed-site MCP at `<your-deployment-origin>/_emdash/api/mcp`
requires authentication and is configured per user/client; never place site
MCP credentials, PATs, or write/admin scope configs in this repository.

## Cloudflare provisioning (deployment only)

Local development never needs this section: `bun run cf:dev` runs fully
locally with simulated bindings. The steps below apply only when deploying a
clone to Cloudflare.

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

Run `bun run cloudflare:setup` only from the deployment clone and an interactive
terminal so Wrangler can show any custom-domain or DNS conflict prompt. It
creates the Worker, D1 database, R2 bucket, session KV namespace, and the
`EMDASH_ENCRYPTION_KEY` secret; it then writes the Worker name and binding IDs
to `wrangler.jsonc` and deploys the route/site URL configured above. Do not
deploy while the placeholder IDs remain, and do not manually replace only some
placeholders: the setup script rejects partially configured core bindings to
prevent duplicate resources.

Wrangler 4.120 does not accept a `--json` flag on `wrangler d1 create`.
Do not add that flag to D1 provisioning commands; use the currently supported
machine-readable output or a documented API response instead.

Secrets are stored in Cloudflare, never committed. `.dev.vars` is ignored and
is only for local development; it cannot create Cloudflare bindings. The
newsletter setup is optional and needs a verified Email Sending domain,
Turnstile keys, and a Rate Limiting namespace. Skip it unless those values are
available and the deployment explicitly includes newsletter signup. Manual
responsibilities remain with the user: authentication and account choice,
resource approval, external domain/zone ownership, passkey registration, and
any optional newsletter or third-party credentials.

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

`src/site.config.ts` holds presentation values that have no EmDash equivalent: bio, location, roles, social links, newsletter integration settings, and analytics. Site identity (title, tagline, logo) and the primary navigation are CMS-owned only: there are no local fallbacks for them, a missing CMS site title fails visibly, and an absent or empty primary menu renders no navigation items. CMS settings also own posts-per-page pagination and visible date preferences (date format and IANA timezone). Seed settings initialize fresh empty databases only. CMS Pages are rendered by `src/pages/[slug].astro`; fixed Astro routes retain precedence.

Rich text is Portable Text; the editor supports headings; bold, italic, underline, and strikethrough marks; links; lists; blockquotes; and code blocks. Minastro overrides only `_type: "code"` block rendering with its server-side Shiki `src/components/CodeBlock.astro` — a template-level override, not an EmDash-native integration. All other built-in Portable Text components are rendered by the EmDash renderer unless locally overridden.

All CMS Pages currently share the presentation in `src/pages/[slug].astro`. Per-page layouts are not auto-discovered: supporting distinct layouts would require an explicit field-to-layout mapping added to that route.

The newsletter page is visible by default, but signup is disabled until its advanced, opt-in integration is provisioned. Its operational instructions live in `docs/newsletter.md`; `bun run cloudflare:setup` is the supported provisioning path.
