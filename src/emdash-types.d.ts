/**
 * Bridge between the generated EmDash types and the query helpers.
 *
 * The canonical artifacts are the committed, generated files:
 *   .emdash/types.ts   - collection interfaces (run `bun run types:generate`)
 *   .emdash/schema.json - schema snapshot emitted alongside the types
 *
 * This file contains no field definitions. It maps collection slugs to the
 * generated interfaces so `getEmDashCollection` / `getEmDashEntry` infer
 * typed data, and re-exports the two EmDash helper types that
 * `.emdash/types.ts` references as ambient globals.
 *
 * The ambient declarations exist because the EmDash 0.32 CLI emits
 * `ContentBylineCredit` / `TaxonomyTerm` references in `.emdash/types.ts`
 * without importing them (its dev-server-generated `emdash-env.d.ts` does
 * import them). If a future CLI version fixes the emit, these can be removed.
 */

import type {
  Home,
  HomeHighlight,
  ListingHeader,
  NavigationIcon,
  NewsletterPage,
  Page,
  Post,
  Project,
} from "../.emdash/types";

declare global {
  type ContentBylineCredit = import("emdash").ContentBylineCredit;
  type TaxonomyTerm = import("emdash").TaxonomyTerm;
}

declare module "emdash" {
  interface EmDashCollections {
    posts: Post;
    projects: Project;
    pages: Page;
    home: Home;
    home_highlights: HomeHighlight;
    listing_headers: ListingHeader;
    newsletter_page: NewsletterPage;
    navigation_icons: NavigationIcon;
  }
}

export {};
