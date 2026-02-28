---
title: Getting Started with minastro
description: A quick overview of what's included in this Astro starter and how to make it your own.
date: 2025-01-15
tags: [astro, template, guide]
---

Welcome to your new Astro site. This post is here to show you what a basic Markdown post looks like and to point you toward the things you'll want to change first.

## What you should do first

Open `src/site.config.ts` and fill in your own details. Every piece of identity in this site — your name, bio, location, social links, analytics, and nav — is controlled from that one file. Change it once and it propagates everywhere.

## Content

Posts live in `src/content/posts/`. Each file is a Markdown or MDX file with frontmatter at the top. The required fields are:

- `title` — displayed in the post list and post header
- `description` — shown as a subtitle and used for SEO meta
- `date` — used for sorting; format as `YYYY-MM-DD`
- `tags` — optional array of strings displayed as badges

Projects live in `src/content/projects/`. See the example project files for the available frontmatter fields.

## Writing in Markdown

Markdown renders with full prose styles. You can use headings, lists, blockquotes, inline code, and fenced code blocks.

```typescript
const greeting = (name: string): string => {
  return `Hello, ${name}`;
};
```

> A blockquote looks like this. Use them for callouts or pull quotes.

**Bold text** and _italic text_ work as expected. Links [look like this](https://astro.build).

## Deleting this post

Once you've read through it, delete this file and add your own writing. That's the whole point.
