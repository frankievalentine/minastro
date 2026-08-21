# CLAUDE.md

## Commands

```bash
bun run dev              # Start local development
bun run build            # Build production SSR output
bun run check            # Type-check and lint
bun run seed:validate    # Validate the EmDash bootstrap seed
bun run cloudflare:setup # Provision D1/R2, configure bindings, and deploy once
bun run cf:deploy        # Deploy an already configured Worker
```

## Architecture

Astro 7 runs server-side on Cloudflare Workers. EmDash is the sole source of runtime content, using D1 for data and R2 for media. `src/worker.ts` re-exports the EmDash Worker handler and `PluginBridge`.

On an empty database, EmDash applies core migrations and the bundled `.emdash/seed.json` automatically. The first request redirects to `/_emdash/admin/setup`; after the one-time setup wizard, the seed provides the schema, initial settings/menu, and sample posts/projects. Changed seeds do not mutate existing sites.

All public routes, RSS, layout navigation, and search query EmDash. Do not add a local-content fallback: CMS errors must remain visible. The admin is at `/_emdash/admin`; search uses `/_emdash/api/search`; EmDash provides the runtime sitemap.

`src/site.config.ts` holds presentation values that have no EmDash equivalent: bio, location, roles, social links, optional newsletter settings, and analytics. CMS settings/menu take precedence for identity and navigation.

The newsletter is disabled by default and is an advanced, opt-in integration. Its separate provisioning instructions live in `docs/newsletter.md`.
