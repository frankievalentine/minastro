# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev          # Start dev server at localhost:4321
bun run build        # Build production site to ./dist/
bun run preview      # Preview production build locally
bun run cfpreview    # Preview via Wrangler against Cloudflare Pages
bun run cfdeploy     # Deploy to Cloudflare Pages
bun run cftypes      # Generate Cloudflare Workers types
```

**Important**: Search is powered by Pagefind, which requires a built index. Always run `bun run build` before `bun run dev` if search functionality is needed.

There is no test suite.

## Architecture

Astro 5 static site deployed to Cloudflare Pages. All output is pre-rendered (`output: 'static'`). The Cloudflare adapter is present for platform proxy support and type generation, not for SSR.

### Layout & Navigation

`src/layouts/Layout.astro` is the single shared layout for every page. It renders a persistent left sidebar with nav links driven by `siteConfig.nav`, a user popover with social links and theme toggle, and a mobile top bar. All pages pass `currentPage` to this layout to drive `aria-current` on nav items. Identity and nav items are configured in `src/site.config.ts`.

### Styling

Tailwind CSS 4 (via `@tailwindcss/vite`) + [basecoat-css](https://basecoat-css.com/) for UI primitives (sidebar, card, badge, btn, command-dialog, popover). Global styles live in `src/styles/global.css` — it's just two imports and a single override. Component-scoped styles use `<style is:global>` with `@reference` to pull in Tailwind.

### View Transitions & basecoat

The site uses Astro's `<ClientRouter />` for client-side navigation. Because View Transitions replace the `<body>`, basecoat's MutationObserver disconnects on each navigation. `Layout.astro` re-initializes it on every `astro:page-load` event via `window.basecoat?.stop() / initAll() / start()`. Event listeners for theme toggle, search trigger, and the mobile scroll lock are attached to `document` (not body) so they survive swaps.

### Dark Mode

Toggled by adding/removing the `.dark` class on `<html>`. The current state is persisted in `localStorage.theme`. An inline script in `<head>` applies the class before paint to prevent flash.

### Search

`src/components/Search.astro` implements a `<dialog>` using the basecoat `command-dialog` pattern. Pagefind is lazy-loaded on first open from `/pagefind/pagefind.js` (generated post-build). A custom Vite plugin (`pagefindExternalPlugin` in `astro.config.mjs`) marks that path as external so it's never bundled. Opened via CMD+K / CTRL+K or the sidebar search button.

### Content

Blog posts live in `src/content/posts/` as `.md` or `.mdx`. Projects live in `src/content/projects/` as `.md`. Both use the glob loader and have schemas defined in `src/content.config.ts`. Posts require `title`, `description`, and `date`; `tags` is optional. Projects require `title` and `description`; `featured`, `status`, `tags`, `github`, `url`, and `date` are optional. Slugs for posts are derived from filenames — the `post.id` is used in `getStaticPaths`.

### Code Highlighting

`astro-expressive-code` with Catppuccin Mocha (dark) and Catppuccin Latte (light) themes. Theme switching is driven by `.dark` / `:root:not(.dark)` CSS selectors.

### Analytics

Optional analytics loaded via `@astrojs/partytown` (offloaded to a web worker). Disabled by default. Enable by setting `siteConfig.analytics.enabled = true` and providing `analytics.url` and `analytics.domain`. The script tag uses `type="text/partytown"`.

### Utilities

`src/utils.ts` exports two functions used across pages: `formatDate(date: Date)` and `readingTime(content: string)`.

### Deployment

Pushes to `main` trigger automatic Cloudflare Pages deploys. Manual deploy: `bunx wrangler login && bun run cfdeploy`.
