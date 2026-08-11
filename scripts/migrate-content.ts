#!/usr/bin/env bun
/**
 * minastro → EmDash Content Migration Generator
 *
 * Reads Markdown (.md) and MDX (.mdx) content from src/content/posts and
 * src/content/projects, parses frontmatter and body AST, and produces:
 *
 *   1. .emdash/migration/manifest.json  — API import manifest with status,
 *      slug, data, taxonomies, createdAt, and publishedAt for every entry.
 *   2. .emdash/migration/posts/         — Portable Text JSON per post.
 *   3. .emdash/migration/projects/      — Portable Text JSON per project.
 *
 * Usage:
 *   bun run scripts/migrate-content.ts [--dry-run] [--help]
 *
 * Options:
 *   --dry-run   Parse and validate all content without writing output files.
 *   --help      Show this help text.
 *
 * Portable Text Output
 *   Each content file is converted to Sanity/EmDash Portable Text — a JSON
 *   array of blocks. Supported Markdown constructs and their mapping:
 *
 *     Paragraph        → block (style: "normal")
 *     Heading (h1-h6)  → block (style: "h1"–"h6")
 *     Bullet list      → block (style: "normal", listItem: "bullet", level: N)
 *     Ordered list     → block (style: "normal", listItem: "number", level: N)
 *     Blockquote       → block (style: "blockquote")
 *     Code block       → code block (_type: "code", language, code)
 *     Thematic break   → block (style: "normal", children: [hr marker text])
 *     Image            → image block (_type: "image", alt, asset ref placeholder)
 *     Inline code      → span with mark "code"
 *     Bold             → span with mark "strong"
 *     Italic           → span with mark "em"
 *     Link             → span with mark key referencing markDef (href)
 *     Strikethrough    → span with mark "strike-through"
 *
 * MDX Handling
 *   MDX files may contain JSX components and expressions that have no Portable
 *   Text equivalent. These nodes are replaced with a textual fallback:
 *
 *     <Component />  →  "[MDX component: Component]"
 *     {expression}   →  "[MDX expression]"
 *
 *   The fallback preserves the approximate location in the content flow so
 *   the migrated text remains readable. No JSX is emitted in the output.
 *
 * Constraints
 *   - Makes no remote requests.
 *   - Preserves all source files (read-only).
 *   - Slugs are derived from filenames (without extension).
 *   - Dates from source frontmatter are mapped to createdAt/publishedAt.
 *   - Project business status (active/wip/archived) is stored in the
 *     projectStatus custom field, separate from EmDash lifecycle status.
 *   - Tags are mapped to the "tag" taxonomy.
 */

import { readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { resolve, relative, basename, extname } from "path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import matter from "gray-matter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PortableTextSpan {
  _type: "span";
  _key: string;
  text: string;
  marks?: string[];
}

interface PortableTextBlock {
  _type: "block";
  _key: string;
  style: "normal" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote";
  children: PortableTextSpan[];
  markDefs?: PortableTextMarkDef[];
  level?: number;
  listItem?: "bullet" | "number";
}

interface PortableTextMarkDef {
  _key: string;
  _type: string;
  href?: string;
}

interface PortableTextCode {
  _type: "code";
  _key: string;
  language?: string;
  code: string;
}

interface PortableTextImage {
  _type: "image";
  _key: string;
  alt?: string;
  asset: { _type: "reference"; _ref: string };
}

type PortableTextNode = PortableTextBlock | PortableTextCode | PortableTextImage;

interface ContentEntry {
  collection: "posts" | "projects";
  slug: string;
  frontmatter: Record<string, unknown>;
  body: string;
  filePath: string;
}

interface ManifestEntry {
  status: "published";
  slug: string;
  data: Record<string, unknown>;
  taxonomies?: Record<string, string[]>;
  createdAt: string;
  publishedAt: string;
}

interface Manifest {
  posts: ManifestEntry[];
  projects: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`
minastro → EmDash Content Migration Generator

Reads Markdown (.md) and MDX (.mdx) content from src/content/posts and
src/content/projects, parses frontmatter and body AST, and produces:

  1. .emdash/migration/manifest.json  — API import manifest with status,
     slug, data, taxonomies, createdAt, and publishedAt for every entry.
  2. .emdash/migration/posts/         — Portable Text JSON per post.
  3. .emdash/migration/projects/      — Portable Text JSON per project.

Usage:
  bun run scripts/migrate-content.ts [--dry-run] [--help]

Options:
  --dry-run   Parse and validate all content without writing output files.
  --help      Show this help text.

Portable Text Output
  Each content file is converted to Sanity/EmDash Portable Text — a JSON
  array of blocks. Supported Markdown constructs and their mapping:

    Paragraph        → block (style: "normal")
    Heading (h1-h6)  → block (style: "h1"–"h6")
    Bullet list      → block (style: "normal", listItem: "bullet", level: N)
    Ordered list     → block (style: "normal", listItem: "number", level: N)
    Blockquote       → block (style: "blockquote")
    Code block       → code block (_type: "code", language, code)
    Thematic break   → block (style: "normal", children: [hr marker text])
    Image            → image block (_type: "image", alt, asset ref placeholder)
    Inline code      → span with mark "code"
    Bold             → span with mark "strong"
    Italic           → span with mark "em"
    Link             → span with mark key referencing markDef (href)
    Strikethrough    → span with mark "strike-through"

MDX Handling
  MDX files may contain JSX components and expressions that have no Portable
  Text equivalent. These nodes are replaced with a textual fallback:

    <Component />  →  "[MDX component: Component]"
    {expression}   →  "[MDX expression]"

  The fallback preserves the approximate location in the content flow so
  the migrated text remains readable. No JSX is emitted in the output.

Constraints
  - Makes no remote requests.
  - Preserves all source files (read-only).
  - Slugs are derived from filenames (without extension).
  - Dates from source frontmatter are mapped to createdAt/publishedAt.
  - Project business status (active/wip/archived) is stored in the
    projectStatus custom field, separate from EmDash lifecycle status.
  - Tags are mapped to the "tag" taxonomy.
`);
  process.exit(0);
}

const DRY_RUN = args.includes("--dry-run");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
const CONTENT_POSTS = resolve(ROOT, "src", "content", "posts");
const CONTENT_PROJECTS = resolve(ROOT, "src", "content", "projects");
const OUT_DIR = resolve(ROOT, ".emdash", "migration");
const OUT_POSTS = resolve(OUT_DIR, "posts");
const OUT_PROJECTS = resolve(OUT_DIR, "projects");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let keyCounter = 0;
function nextKey(): string {
  return `k${(++keyCounter).toString(36).padStart(4, "0")}`;
}

function slugFromFile(filePath: string): string {
  return basename(filePath).replace(extname(filePath), "");
}

function toDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Markdown → Portable Text converter
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MdastNode = any;

function convertMdastToPortableText(
  nodes: MdastNode[],
  parentListType?: "bullet" | "number",
  parentListLevel: number = 0,
): PortableTextNode[] {
  const blocks: PortableTextNode[] = [];
  const markDefs: PortableTextMarkDef[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "paragraph": {
        const { children: spans, defs } = convertInline(node.children || []);
        markDefs.push(...defs);
        blocks.push({
          _type: "block",
          _key: nextKey(),
          style: "normal",
          children: spans,
          markDefs: defs.length > 0 ? defs : undefined,
          ...(parentListType
            ? { listItem: parentListType, level: parentListLevel }
            : {}),
        });
        break;
      }

      case "heading": {
        const depth = Math.min(Math.max(node.depth || 1, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
        const style = `h${depth}` as PortableTextBlock["style"];
        const { children: spans, defs } = convertInline(node.children || []);
        markDefs.push(...defs);
        blocks.push({
          _type: "block",
          _key: nextKey(),
          style,
          children: spans,
          markDefs: defs.length > 0 ? defs : undefined,
        });
        break;
      }

      case "list": {
        const listType: "bullet" | "number" = node.ordered ? "number" : "bullet";
        const level = parentListLevel + 1;
        for (const item of node.children || []) {
          if (item.type === "listItem") {
            const itemChildren = item.children || [];
            // Flatten nested paragraphs inside list items
            for (const child of itemChildren) {
              if (child.type === "paragraph") {
                const { children: spans, defs } = convertInline(child.children || []);
                markDefs.push(...defs);
                blocks.push({
                  _type: "block",
                  _key: nextKey(),
                  style: "normal",
                  children: spans,
                  markDefs: defs.length > 0 ? defs : undefined,
                  listItem: listType,
                  level,
                });
              } else if (child.type === "list") {
                // Nested list
                const nested = convertMdastToPortableText(
                  [child],
                  listType,
                  level,
                );
                blocks.push(...nested);
              } else {
                // Other child types (e.g., plain text in list item)
                const { children: spans, defs } = convertInline(
                  itemChildren,
                );
                markDefs.push(...defs);
                blocks.push({
                  _type: "block",
                  _key: nextKey(),
                  style: "normal",
                  children: spans,
                  markDefs: defs.length > 0 ? defs : undefined,
                  listItem: listType,
                  level,
                });
              }
            }
          }
        }
        break;
      }

      case "blockquote": {
        // Blockquote children are typically paragraphs
        for (const child of node.children || []) {
          if (child.type === "paragraph") {
            const { children: spans, defs } = convertInline(child.children || []);
            markDefs.push(...defs);
            blocks.push({
              _type: "block",
              _key: nextKey(),
              style: "blockquote",
              children: spans,
              markDefs: defs.length > 0 ? defs : undefined,
            });
          } else {
            // Recurse for nested structures
            const nested = convertMdastToPortableText([child]);
            // Wrap in blockquote style
            for (const b of nested) {
              if (b._type === "block") {
                blocks.push({ ...b, style: "blockquote", _key: nextKey() });
              }
            }
          }
        }
        break;
      }

      case "code": {
        blocks.push({
          _type: "code",
          _key: nextKey(),
          language: node.lang || undefined,
          code: node.value || "",
        });
        break;
      }

      case "thematicBreak": {
        blocks.push({
          _type: "block",
          _key: nextKey(),
          style: "normal",
          children: [
            { _type: "span", _key: nextKey(), text: "---" },
          ],
        });
        break;
      }

      case "image": {
        blocks.push({
          _type: "image",
          _key: nextKey(),
          alt: node.alt || undefined,
          asset: {
            _type: "reference",
            _ref: `image-${node.url || "unknown"}`,
          },
        });
        break;
      }

      // MDX nodes — textual fallback
      case "mdxJsxFlowElement": {
        const tagName = node.name || "unknown";
        blocks.push({
          _type: "block",
          _key: nextKey(),
          style: "normal",
          children: [
            {
              _type: "span",
              _key: nextKey(),
              text: `[MDX component: ${tagName}]`,
            },
          ],
        });
        break;
      }

      case "mdxFlowExpression": {
        blocks.push({
          _type: "block",
          _key: nextKey(),
          style: "normal",
          children: [
            {
              _type: "span",
              _key: nextKey(),
              text: "[MDX expression]",
            },
          ],
        });
        break;
      }

      case "mdxjsEsm": {
        // import/export statements — skip entirely
        break;
      }

      default: {
        // Unknown block-level node — try to extract text
        if (node.children) {
          const nested = convertMdastToPortableText(node.children);
          blocks.push(...nested);
        } else if (node.value) {
          blocks.push({
            _type: "block",
            _key: nextKey(),
            style: "normal",
            children: [
              { _type: "span", _key: nextKey(), text: node.value },
            ],
          });
        }
      }
    }
  }

  return blocks;
}

function convertInline(
  nodes: MdastNode[],
): { children: PortableTextSpan[]; defs: PortableTextMarkDef[] } {
  const children: PortableTextSpan[] = [];
  const defs: PortableTextMarkDef[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "text": {
        children.push({
          _type: "span",
          _key: nextKey(),
          text: node.value || "",
        });
        break;
      }

      case "strong": {
        const inner = convertInline(node.children || []);
        defs.push(...inner.defs);
        for (const span of inner.children) {
          children.push({
            ...span,
            marks: [...(span.marks || []), "strong"],
          });
        }
        break;
      }

      case "emphasis": {
        const inner = convertInline(node.children || []);
        defs.push(...inner.defs);
        for (const span of inner.children) {
          children.push({
            ...span,
            marks: [...(span.marks || []), "em"],
          });
        }
        break;
      }

      case "inlineCode": {
        children.push({
          _type: "span",
          _key: nextKey(),
          text: node.value || "",
          marks: ["code"],
        });
        break;
      }

      case "link": {
        const linkKey = nextKey();
        defs.push({
          _key: linkKey,
          _type: "link",
          href: node.url || "",
        });
        const inner = convertInline(node.children || []);
        defs.push(...inner.defs);
        for (const span of inner.children) {
          children.push({
            ...span,
            marks: [...(span.marks || []), linkKey],
          });
        }
        break;
      }

      case "delete": {
        const inner = convertInline(node.children || []);
        defs.push(...inner.defs);
        for (const span of inner.children) {
          children.push({
            ...span,
            marks: [...(span.marks || []), "strike-through"],
          });
        }
        break;
      }

      case "image": {
        // Inline image — emit as text fallback since Portable Text
        // images are block-level
        children.push({
          _type: "span",
          _key: nextKey(),
          text: node.alt ? `[Image: ${node.alt}]` : "[Image]",
        });
        break;
      }

      // MDX inline nodes — textual fallback
      case "mdxJsxTextElement": {
        const tagName = node.name || "unknown";
        children.push({
          _type: "span",
          _key: nextKey(),
          text: `[MDX component: ${tagName}]`,
        });
        break;
      }

      case "mdxTextExpression": {
        children.push({
          _type: "span",
          _key: nextKey(),
          text: "[MDX expression]",
        });
        break;
      }

      default: {
        // Unknown inline node — extract text if possible
        if (node.value) {
          children.push({
            _type: "span",
            _key: nextKey(),
            text: node.value,
          });
        } else if (node.children) {
          const inner = convertInline(node.children);
          defs.push(...inner.defs);
          children.push(...inner.children);
        }
      }
    }
  }

  return { children, defs };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function discoverFiles(): ContentEntry[] {
  const entries: ContentEntry[] = [];

  const postFiles = readdirSync(CONTENT_POSTS).filter(
    (f) => f.endsWith(".md") || f.endsWith(".mdx"),
  );
  for (const file of postFiles) {
    const filePath = resolve(CONTENT_POSTS, file);
    entries.push({
      collection: "posts",
      slug: slugFromFile(file),
      frontmatter: {},
      body: "",
      filePath,
    });
  }

  const projectFiles = readdirSync(CONTENT_PROJECTS).filter(
    (f) => f.endsWith(".md") || f.endsWith(".mdx"),
  );
  for (const file of projectFiles) {
    const filePath = resolve(CONTENT_PROJECTS, file);
    entries.push({
      collection: "projects",
      slug: slugFromFile(file),
      frontmatter: {},
      body: "",
      filePath,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

async function parseEntry(entry: ContentEntry): Promise<{
  portableText: PortableTextNode[];
  manifestEntry: ManifestEntry;
}> {
  const raw = await readFile(entry.filePath, "utf-8");

  // Parse frontmatter with gray-matter
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content;

  // Build the Markdown AST parser
  const isMdx = entry.filePath.endsWith(".mdx");
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(isMdx ? remarkMdx : () => {});

  const mdast = processor.parse(body) as { children: MdastNode[] };
  // Remove frontmatter node from AST if present
  const contentNodes = mdast.children.filter(
    (n: MdastNode) => n.type !== "yaml",
  );

  // Convert to Portable Text
  const portableText = convertMdastToPortableText(contentNodes);

  // Build manifest entry
  const date = fm.date ? toDateString(fm.date) : new Date().toISOString();
  const tags = (fm.tags as string[]) || [];

  const data: Record<string, unknown> = {
    title: fm.title || entry.slug,
    description: fm.description || "",
    content: portableText,
  };

  if (entry.collection === "projects") {
    // Map project status to custom field
    if (fm.status && typeof fm.status === "string") {
      data.projectStatus = fm.status;
    }
    if (fm.url && typeof fm.url === "string") {
      data.url = fm.url;
    }
    if (fm.github && typeof fm.github === "string") {
      data.github = fm.github;
    }
    if (typeof fm.featured === "boolean") {
      data.featured = fm.featured;
    }
  }

  const manifestEntry: ManifestEntry = {
    status: "published",
    slug: entry.slug,
    data,
    createdAt: date,
    publishedAt: date,
  };

  if (tags.length > 0) {
    manifestEntry.taxonomies = { tag: tags };
  }

  return { portableText, manifestEntry };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`minastro → EmDash Content Migration Generator\n`);

  const entries = discoverFiles();
  console.log(`Discovered ${entries.length} content files:`);
  for (const e of entries) {
    console.log(`  ${e.collection}/${e.slug}${extname(e.filePath)}`);
  }
  console.log("");

  const manifest: Manifest = { posts: [], projects: [] };
  let parsedCount = 0;
  let errorCount = 0;

  for (const entry of entries) {
    try {
      const { portableText, manifestEntry } = await parseEntry(entry);
      manifest[entry.collection].push(manifestEntry);

      if (!DRY_RUN) {
        const outDir = entry.collection === "posts" ? OUT_POSTS : OUT_PROJECTS;
        if (!existsSync(outDir)) {
          mkdirSync(outDir, { recursive: true });
        }
        const outPath = resolve(outDir, `${entry.slug}.json`);
        writeFileSync(outPath, JSON.stringify(portableText, null, 2) + "\n");
      }

      parsedCount++;
      console.log(
        `  OK  ${entry.collection}/${entry.slug}` +
          (manifestEntry.taxonomies
            ? ` [tags: ${manifestEntry.taxonomies.tag.join(", ")}]`
            : ""),
      );
    } catch (err) {
      errorCount++;
      console.error(`  ERR ${entry.collection}/${entry.slug}: ${err}`);
    }
  }

  // Write manifest
  if (!DRY_RUN) {
    if (!existsSync(OUT_DIR)) {
      mkdirSync(OUT_DIR, { recursive: true });
    }
    const manifestPath = resolve(OUT_DIR, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }

  console.log("");
  console.log("Summary:");
  console.log(`  Source files:    ${entries.length}`);
  console.log(`  Parsed:          ${parsedCount}`);
  console.log(`  Errors:          ${errorCount}`);
  console.log(`  Manifest posts:  ${manifest.posts.length}`);
  console.log(`  Manifest projs:  ${manifest.projects.length}`);

  if (DRY_RUN) {
    console.log("\nDry-run complete. No files written.");
  } else {
    console.log(`\nOutput written to: ${relative(ROOT, OUT_DIR)}/`);
  }

  process.exit(errorCount > 0 ? 1 : 0);
}

main();
