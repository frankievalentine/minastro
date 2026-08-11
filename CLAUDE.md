# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev              # Start dev server at localhost:4321
bun run build            # Build production SSR output to ./dist/
bun run preview          # Preview production build locally
bun run cf:dev           # Run full Workers stack locally via Wrangler (D1, R2, secrets)
bun run cf:deploy        # Deploy worker + assets to Cloudflare
bun run cf:deploy:production  # Deploy to the production environment
bun run check            # Type-check and lint (astro check + ESLint)
bun run fix              # Auto-fix ESLint issues
bun run migrate:generate # Parse Markdown/MDX content and generate EmDash migration manifest
bun run migrate:dry-run  # Parse and validate without writing files
```

**Important**: Search is powered by EmDash runtime search (FTS indexes maintained by database triggers). No build-time index is needed. The admin panel is at `/_emdash/admin`.

There is no test suite.

## Architecture

Astro 7 SSR site deployed to Cloudflare Workers. All output is server-rendered (`output: 'server'`). The Cloudflare adapter runs the Astro server inside a Cloudflare Worker, with D1 for storage and R2 for media.

### Entry Point

`src/worker.ts` is a single re-export from `@emdash-cms/cloudflare/worker` which owns the `fetch()` and `scheduled()` handlers. Wrangler config sets `main: "./src/worker.ts"` and `triggers.crons` for scheduled publishing.

### Layout & Navigation

`src/layouts/Layout.astro` is the single shared layout for every page. It renders a persistent left sidebar with nav links, a user popover with social links and theme toggle, and a mobile top bar. All pages pass `currentPage` to this layout to drive `aria-current` on nav items.

**Identity and navigation use a two-layer model:**
- At runtime, `Layout.astro` fetches `getSiteSettings()` and `getMenu("primary")` from EmDash CMS. CMS title, tagline, logo, and primary menu items take precedence when available.
- `src/site.config.ts` provides the fallback values for title, tagline/description, avatar, and nav when the CMS is unreachable or not yet seeded.
- Social links (GitHub, X/Twitter, LinkedIn, email), newsletter config, and analytics config are read exclusively from `site.config.ts` -- they have no CMS equivalent.

### Styling

Tailwind CSS 4 (via `@tailwindcss/vite`) + [basecoat-css](https://basecoat-css.com/) for UI primitives (sidebar, card, badge, btn, command-dialog, popover). Global styles live in `src/styles/global.css` — it's just two imports and a single override. Component-scoped styles use `<style is:global>` with `@reference` to pull in Tailwind.

### View Transitions & basecoat

The site uses Astro's `<ClientRouter />` for client-side navigation. Because View Transitions replace the `<body>`, basecoat's MutationObserver disconnects on each navigation. `Layout.astro` re-initializes it on every `astro:page-load` event via `window.basecoat?.stop() / initAll() / start()`. Event listeners for theme toggle, search trigger, and the mobile scroll lock are attached to `document` (not body) so they survive swaps.

### Dark Mode

Toggled by adding/removing the `.dark` class on `<html>`. The current state is persisted in `localStorage.theme`. An inline script in `<head>` applies the class before paint to prevent flash.

### Search

`src/components/Search.astro` implements a `<dialog>` using the basecoat `command-dialog` pattern. EmDash runtime search is used via the `/_emdash/api/search` endpoint. FTS indexes are created once and maintained by database triggers — no periodic rebuild is required. Opened via CMD+K / CTRL+K or the sidebar search button.

### Content

Blog posts live in `src/content/posts/` as `.md` or `.mdx`. Projects live in `src/content/projects/` as `.md`. Both use the glob loader and have schemas defined in `src/content.config.ts`. Posts require `title`, `description`, and `date`; `tags` is optional. Projects require `title` and `description`; `featured`, `status`, `tags`, `github`, `url`, and `date` are optional. Slugs for posts are derived from filenames — the `post.id` is used in `getStaticPaths`.

### Code Highlighting

`astro-expressive-code` with Catppuccin Mocha (dark) and Catppuccin Latte (light) themes. Theme switching is driven by `.dark` / `:root:not(.dark)` CSS selectors.

### Analytics

Optional analytics loaded via `@astrojs/partytown` (offloaded to a web worker). Disabled by default. Enable by setting `siteConfig.analytics.enabled = true` and providing `analytics.url` and `analytics.domain`. The script tag uses `type="text/partytown"`.

### Sitemap

EmDash provides a built-in runtime sitemap at `/sitemap.xml` (index) and `/sitemap-{collection}.xml` (per-collection). No build-time sitemap generation is needed.

### Utilities

`src/utils.ts` exports two functions used across pages: `formatDate(date: Date)` and `readingTime(content: string)`.

### Deployment

Pushes to `main` trigger automatic Cloudflare Workers deploys. Manual deploy: `bunx wrangler login && bun run cf:deploy`. Wrangler runs `bun run build` automatically before deploying (configured via `build.command` in `wrangler.jsonc`).
