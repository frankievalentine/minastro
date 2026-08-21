# AGENTS.md

## Commands

```bash
bun run cf:dev           # Run the Worker locally after bindings are configured
bun run dev              # Astro-only frontend development server
bun run build            # Build production SSR output
bun run check            # Type-check and lint
bun run seed:validate    # Validate the EmDash bootstrap seed
bun run cloudflare:setup # Provision D1/R2, configure bindings, and deploy once
bun run cf:deploy        # Deploy an already configured Worker
```

## Cloudflare provisioning

For a new deployment, run `bunx wrangler whoami` first. Authenticate with
`bunx wrangler login` if necessary, and confirm it targets the intended
Cloudflare account with permission to create Workers, D1 databases, R2 buckets,
KV namespaces, and Worker secrets.

Run `bun run cloudflare:setup` only from the deployment clone. It is interactive
and creates the Worker, D1 database, R2 bucket, session KV namespace, and the
`EMDASH_ENCRYPTION_KEY` secret; it then writes the Worker name and binding IDs
to `wrangler.jsonc` and deploys. Do not deploy while the placeholder IDs remain,
and do not manually replace only some placeholders: the setup script rejects
partially configured core bindings to prevent duplicate resources.

Secrets are stored in Cloudflare, never committed. `.dev.vars` is ignored and
is only for local development; it cannot create Cloudflare bindings. The
newsletter setup is optional and needs a verified Email Sending domain,
Turnstile keys, and a Rate Limiting namespace. Skip it unless those values are
available and the deployment explicitly includes newsletter signup.

After initial provisioning, use `bun run cf:dev` for Worker-compatible local
testing and `bun run cf:deploy` for later deployments. Complete the EmDash
setup wizard at `/_emdash/admin/setup` on the final deployment origin; connect
a custom domain before registering its production passkey.

## Architecture

Astro 7 runs server-side on Cloudflare Workers. EmDash is the sole source of runtime content, using D1 for data and R2 for media. `src/worker.ts` re-exports the EmDash Worker handler and `PluginBridge`.

On an empty database, EmDash applies core migrations and the bundled `.emdash/seed.json` automatically. The first request redirects to `/_emdash/admin/setup`; after the one-time setup wizard, the seed provides the schema, initial settings/menu, sample posts/projects, and a CMS-managed Pages collection. Changed seeds do not mutate existing sites.

CMS-backed posts, projects, root Pages, RSS, layout navigation, and search query EmDash. Static template examples and newsletter UI are intentional exceptions. Do not add local-content fallbacks for CMS routes: CMS errors must remain visible. The admin is at `/_emdash/admin`; search uses `/_emdash/api/search`. Do not assume custom collections are automatically included in the sitemap without verifying the installed EmDash runtime.

`src/site.config.ts` holds presentation values that have no EmDash equivalent: bio, location, roles, social links, newsletter integration settings, and analytics. CMS settings/menu take precedence for identity and navigation. CMS Pages are rendered by `src/pages/[slug].astro`; fixed Astro routes retain precedence.

The newsletter page is visible by default, but signup is disabled until its advanced, opt-in integration is provisioned. Its operational instructions live in `docs/newsletter.md`; `bun run cloudflare:setup` is the supported provisioning path.
