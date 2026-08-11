# minastro

A minimal Astro personal site template powered by [EmDash CMS](https://emdashcms.com), deployed on Cloudflare Workers with D1 and R2.

Built on Astro 7, Tailwind CSS 4, and basecoat-css.

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed via `bun install`)
- A Cloudflare account with D1 and R2 enabled

## Quick start (local)

```bash
bun install
cp .dev.vars.example .dev.vars
bun run dev
```

Open `http://localhost:4321`. The admin panel is at `http://localhost:4321/_emdash/admin`.

## Configuration

Configuration is split across two layers. EmDash CMS values at runtime take precedence for identity and navigation; `site.config.ts` owns everything else and serves as the resilient fallback.

### Layer 1: EmDash CMS (runtime, takes precedence)

Once EmDash is seeded and running, these values are managed in the admin panel at `/_emdash/admin` and override their `site.config.ts` counterparts:

| Setting | CMS source | Used for |
|---|---|---|
| Site title | Settings > title | Page `<title>`, sidebar site name, Open Graph `site_name` |
| Tagline | Settings > tagline | Sidebar subtitle, page description fallback |
| Logo | Settings > logo (image) | Sidebar avatar |
| Primary menu | Menus > Primary Navigation | Sidebar nav links |

These are fetched at runtime by `Layout.astro` via `getSiteSettings()` and `getMenu("primary")`. If the CMS is unreachable or not yet seeded, the layout falls back to `site.config.ts` values.

### Layer 2: `src/site.config.ts` (build-time, fallback)

```typescript
export const siteConfig: SiteConfig = {
  name: "Your Name",
  title: "Your Name",              // fallback for CMS title
  description: "Your Name's personal website.",  // fallback for CMS tagline
  url: "https://your-domain.com",  // canonical URL, passed to EmDash as siteUrl
  avatar: "/avatar.svg",           // fallback for CMS logo
  location: "Your City",           // fallback for sidebar subtitle when no CMS tagline
  roles: ["Software Engineer", "Open Source", "Builder"],
  bio: "I'm a software engineer...",
  social: {                        // NOT managed in CMS — edit here only
    github: "https://github.com/yourusername",
    twitter: "https://x.com/yourusername",
    email: "hello@your-domain.com",
  },
  newsletter: {                    // NOT managed in CMS — edit here only
    enabled: true,
    formUrl: "https://...",
    description: "...",
  },
  analytics: {                     // NOT managed in CMS — edit here only
    enabled: false,
    url: "https://...",
    domain: "your-domain.com",
  },
  nav: [                           // fallback for CMS primary menu
    { label: "About", href: "/" },
    { label: "Posts", href: "/posts" },
    { label: "Projects", href: "/projects" },
    { label: "Newsletter", href: "/newsletter" },
  ],
};
```

**What `site.config.ts` owns exclusively** (no CMS equivalent):
- `url` -- canonical domain; read by `astro.config.mjs` and passed to EmDash as `siteUrl`
- `location`, `roles`, `bio` -- personal info rendered on the home page
- `social` -- GitHub, X/Twitter, LinkedIn, email links in the sidebar popover
- `newsletter` -- toggle and form endpoint URL
- `analytics` -- toggle, script URL, and domain for Partytown

**What `site.config.ts` provides as fallback** (overridden by CMS when available):
- `title`, `description` -- overridden by CMS title/tagline
- `avatar` -- overridden by CMS logo
- `nav` -- overridden by CMS primary menu

The `url` field must be set to your production domain before deploying. Change it in `site.config.ts`.

### `.emdash/seed.json` -- one-time initialization

The seed file at `.emdash/seed.json` defines the EmDash content model (collections, fields, taxonomies) and initializes default values for CMS settings (title, tagline, URL, social links) and the primary menu. It is applied once via `bunx emdash seed apply .emdash/seed.json` after the admin account is created.

**What seed.json is**: a one-time bootstrap that populates the CMS with template defaults so you don't start from a blank admin panel.

**What seed.json is not**: a bidirectional sync mechanism. After seeding, all CMS values (title, tagline, logo, menu, social) are managed exclusively through the EmDash admin UI. Editing `seed.json` post-deploy has no effect unless you re-apply it, which would overwrite any changes made in the admin.

### What to edit before first deploy

Before deploying, edit these files:

| File | What to change |
|---|---|
| `src/site.config.ts` | `url` (your domain), `name`, `title`, `description`, `avatar`, `location`, `roles`, `bio`, `social` links, `newsletter.formUrl`, `analytics` config |
| `.emdash/seed.json` | `settings.title`, `settings.tagline`, `settings.url`, `settings.social` (initial CMS values), `menus` items if you want different default nav |
| `astro.config.mjs` | `allowedOrigins` (add your production URL) |
| `public/avatar.svg` | Replace with your own avatar |
| `public/favicon.svg`, `public/favicon.ico` | Replace with your own favicon |
| `public/manifest.webmanifest` | Update name and icons |

### What to edit in the EmDash admin after deploy

After seeding, manage these through the admin UI at `/_emdash/admin`:

- Site title, tagline, logo image
- Primary navigation menu (add/remove/reorder links)
- Social links in Settings (these are CMS-level; note the sidebar popover reads from `site.config.ts` -- see note above)
- Blog posts and projects as content entries
- Tags taxonomy

### EmDash WebAuthn origins

In `astro.config.mjs`, the `allowedOrigins` array is intentionally empty:

```js
emdash({
  siteUrl: siteConfig.url,
  allowedOrigins: [],  // <-- add production origins here
  database: d1({ binding: "DB" }),
  storage: r2({ binding: "MEDIA" }),
})
```

For production, add your site URL and any other WebAuthn origins:

```js
allowedOrigins: ["https://your-domain.com", "https://preview.your-domain.com"],
```

### Local secrets

Copy `.dev.vars.example` to `.dev.vars` and fill in:

| Variable | Purpose |
|---|---|
| `EMDASH_SITE_URL` | Public browser-facing origin (default `http://localhost:4321`) |
| `EMDASH_ALLOWED_ORIGINS` | Comma-separated additional WebAuthn origins (optional) |
| `EMDASH_ENCRYPTION_KEY` | Key for encrypting plugin secrets at rest (64+ random chars) |
| `EMDASH_PREVIEW_SECRET` | Override for auto-generated preview HMAC secret (optional) |
| `EMDASH_IP_SALT` | Override for auto-generated commenter-IP hash salt (optional) |
| `EMDASH_AUTH_SECRET` | Legacy IP-salt source; only needed for existing installs upgrading |

`.dev.vars` is git-ignored. For production, set these via `bunx wrangler secret put`.

## Project structure

| Path | Description |
|---|---|
| `src/site.config.ts` | Build-time config: canonical URL, social, newsletter, analytics, bio, roles, location; fallback for CMS title/tagline/logo/nav |
| `src/worker.ts` | EmDash Cloudflare Worker entry point (single re-export) |
| `src/live.config.ts` | EmDash live collection definition |
| `src/content/posts/` | Blog posts (`.md` and `.mdx`) |
| `src/content/projects/` | Project entries (`.md`) |
| `src/layouts/Layout.astro` | Sidebar shell used by all pages |
| `src/pages/` | Routes: index, posts, projects, newsletter, rss, 404 |
| `src/components/` | Search dialog, BackToTop button |
| `src/styles/global.css` | Tailwind + basecoat imports |
| `src/utils.ts` | `formatDate`, `readingTime` utilities |
| `public/` | Static assets: favicon, avatar, manifest, robots.txt |
| `.emdash/seed.json` | EmDash schema seed (collections, taxonomies, menus) |
| `.emdash/migration/` | Generated content migration manifest and Portable Text files |
| `scripts/migrate-content.ts` | Content migration generator (Markdown/MDX to EmDash) |

## Commands

### Local development

| Command | Action |
|---|---|
| `bun run dev` | Start Astro dev server at `localhost:4321` |
| `bun run build` | Build for production (SSR output) |
| `bun run preview` | Preview the production build locally |
| `bun run cf:dev` | Run the full Workers stack locally via Wrangler (D1, R2, secrets) |
| `bun run check` | Type-check and lint (`astro check` + ESLint) |
| `bun run fix` | Auto-fix ESLint issues |

### Deployment

| Command | Action |
|---|---|
| `bun run cf:deploy` | Deploy worker + assets to Cloudflare (default environment) |
| `bun run cf:deploy:production` | Deploy to the `production` environment |

### Content migration

| Command | Action |
|---|---|
| `bun run migrate:generate` | Parse Markdown/MDX content and generate EmDash migration manifest |
| `bun run migrate:dry-run` | Parse and validate without writing files |

## Cloudflare resource setup

These steps require a Cloudflare account and are **deploy-required** (not needed for local dev).

### 1. Create D1 database

```bash
bunx wrangler d1 create minastro
```

Copy the returned `database_id` into `wrangler.jsonc`:

```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "minastro",
  "database_id": "<paste-id-here>"
}]
```

### 2. Create R2 bucket

```bash
bunx wrangler r2 bucket create minastro-media
```

Set the returned bucket name in `wrangler.jsonc`:

```jsonc
"r2_buckets": [{
  "binding": "MEDIA",
  "bucket_name": "minastro-media"
}]
```

### 3. Set production secrets

```bash
bunx wrangler secret put EMDASH_SITE_URL
bunx wrangler secret put EMDASH_ENCRYPTION_KEY
```

Each command prompts for the value. Use a strong random key (64+ characters) for `EMDASH_ENCRYPTION_KEY`.

Optional secrets (EmDash auto-generates these and persists them in D1):

```bash
bunx wrangler secret put EMDASH_PREVIEW_SECRET
bunx wrangler secret put EMDASH_IP_SALT
```

### 4. (Optional) Create KV namespace for caching

If you want to enable KV-based content/configuration query caching via `kvCache()`:

```bash
bunx wrangler kv namespace create CACHE
```

Then add to `wrangler.jsonc`:

```jsonc
"kv_namespaces": [{
  "binding": "CACHE",
  "id": "<paste-id-here>"
}]
```

KV caching is optional and deferred by default. Start without it and add only after measuring actual traffic.

## EmDash admin setup

### Local dev

1. Start the dev server: `bun run dev`
2. Open `http://localhost:4321/_emdash/admin`
3. The Setup Wizard guides you through creating your admin account with a passkey (Touch ID, Windows Hello, or security key)
4. After setup, you are logged in and redirected to the admin dashboard

### Deploy and admin setup

After deploying (`bun run cf:deploy`):

1. Open `https://your-worker-name.your-subdomain.workers.dev/_emdash/admin`
2. Complete the Setup Wizard to create your admin account and register a passkey
3. The schema seed (collections, taxonomies, menus) is **not** applied automatically. Apply it via the CLI (see below).

### Apply the schema seed

The seed file at `.emdash/seed.json` defines the content model (collections, fields, taxonomies, menus). Apply it after the admin account is created:

```bash
# Validate the seed file
bunx emdash seed validate .emdash/seed.json

# Apply the seed (idempotent — safe to re-run)
bunx emdash seed apply .emdash/seed.json
```

Alternatively, use the programmatic API in a script:

```typescript
import { applySeed, validateSeed } from "emdash/seed";
import seedData from "./.emdash/seed.json";

const { valid, errors } = validateSeed(seedData);
if (!valid) { console.error(errors); process.exit(1); }

await applySeed(db, seedData, {
  includeContent: true,
  onConflict: "skip",
});
```

### Import historical content

If you have existing Markdown/MDX content in `src/content/`:

```bash
# 1. Generate the migration manifest and Portable Text files
bun run migrate:generate

# 2. Authenticate with your EmDash instance and import entries one at a time
#    Each entry must be POSTed individually to the content API.
#    Replace the URL and token below.

# First, get a bearer token from the admin UI or CLI:
npx emdash login

# Then import each entry individually, preserving original dates:
curl -X POST https://your-worker-name.your-subdomain.workers.dev/_emdash/api/content/posts \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "My Post",
    "slug": "my-post",
    "body": [...],  /* Portable Text blocks */
    "publishedAt": "2025-03-01T00:00:00Z",
    "createdAt": "2025-03-01T00:00:00Z"
  }'
```

> **Important**: There is no manifest-wide import endpoint. Each entry must be created individually via `POST /_emdash/api/content/:collection`. Include `publishedAt` and `createdAt` in the request body to preserve historical dates. The admin account must be set up and authenticated before importing content.

## What's included

- **Blog** -- Markdown and MDX posts with reading-time estimates, tag badges, and a back-to-top button
- **Projects** -- a dedicated projects page and a featured projects section on the home page
- **Newsletter** -- a subscribe form wired to a configurable endpoint
- **Search** -- EmDash runtime search via CMD+K dialog (FTS indexes maintained by database triggers)
- **RSS feed** -- at `/rss.xml`, auto-generated from your posts
- **Sitemap** -- EmDash built-in runtime sitemap at `/sitemap.xml` and `/sitemap-{collection}.xml`
- **Dark/light toggle** -- in the sidebar popover, persisted to `localStorage`
- **View Transitions** -- smooth page navigation via Astro's `ClientRouter`
- **Analytics** -- opt-in via Partytown; disabled by default
- **EmDash CMS** -- headless CMS with D1 storage, R2 media, and admin panel at `/_emdash/admin`

## Content

### Blog posts

Create `.md` or `.mdx` files in `src/content/posts/`:

```markdown
---
title: My Post Title
description: A one-sentence summary used for SEO and the post list.
date: 2025-03-01
tags: [engineering, notes]
---

Your content here.
```

### Projects

Create `.md` files in `src/content/projects/`:

```markdown
---
title: my-project
description: What this project does in a sentence or two.
github: https://github.com/you/my-project
url: https://my-project.com
tags: [typescript, cli]
featured: true
status: active
date: 2025-01-01
---
```

## Tech stack

- [Astro 7](https://astro.build/)
- [Tailwind CSS 4](https://tailwindcss.com/)
- [basecoat-css](https://basecoat-css.com/)
- [EmDash CMS](https://emdashcms.com)
- [Expressive Code](https://expressive-code.com/)
- [Cloudflare Workers](https://workers.cloudflare.com/) + D1 + R2
