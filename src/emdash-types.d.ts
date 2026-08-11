/**
 * EmDash collection type augmentation for the custom schema.
 *
 * Augments the `EmDashCollections` interface from `emdash` so that
 * `getEmDashCollection` and `getEmDashEntry` return properly typed
 * data objects for the `posts` and `projects` collections.
 *
 * System fields hydrated into `data` by the loader:
 *   id, status, authorId, primaryBylineId, createdAt, updatedAt,
 *   publishedAt, scheduledAt, draftRevisionId, liveRevisionId,
 *   locale, translationGroup, slug
 *
 * Hydrated fields:
 *   bylines, byline, terms, seo
 */

import type {
  PortableTextBlock,
  TaxonomyTerm,
  ContentBylineCredit,
  BylineSummary,
  ContentSeo,
} from "emdash";

declare module "emdash" {
  interface EmDashCollections {
    posts: {
      /** Post title */
      title: string;
      /** Post description / excerpt */
      description: string;
      /** URL slug */
      slug: string;
      /** Rich content body (Portable Text) */
      content: PortableTextBlock[];
      /** System status */
      status: string;
      /** Published date */
      publishedAt: Date;
      /** Created date */
      createdAt: Date;
      /** Updated date */
      updatedAt: Date;
      /** Scheduled date */
      scheduledAt: Date | null;
      /** Taxonomy terms hydrated by the loader, keyed by taxonomy name */
      terms: Record<string, TaxonomyTerm[]>;
      /** Byline credits hydrated by the loader */
      bylines: ContentBylineCredit[];
      /** Primary byline summary */
      byline: BylineSummary | null;
      /** SEO metadata */
      seo: ContentSeo | null;
      /** Author ID */
      authorId: string | null;
      /** Primary byline ID */
      primaryBylineId: string | null;
      /** Draft revision ID */
      draftRevisionId: string | null;
      /** Live revision ID */
      liveRevisionId: string | null;
      /** Content locale */
      locale: string;
      /** Translation group ID */
      translationGroup: string | null;
      /** Content ID (ULID) */
      id: string;
    };
    projects: {
      /** Project title */
      title: string;
      /** Project description */
      description: string;
      /** URL slug */
      slug: string;
      /** Rich content body (Portable Text) */
      content: PortableTextBlock[];
      /** Whether the project is featured on the homepage */
      featured: boolean;
      /** Project status (active, wip, archived) */
      projectStatus: string;
      /** GitHub repository URL */
      github: string;
      /** Project URL */
      url: string;
      /** System status */
      status: string;
      /** Published date */
      publishedAt: Date;
      /** Created date */
      createdAt: Date;
      /** Updated date */
      updatedAt: Date;
      /** Scheduled date */
      scheduledAt: Date | null;
      /** Taxonomy terms hydrated by the loader, keyed by taxonomy name */
      terms: Record<string, TaxonomyTerm[]>;
      /** Byline credits hydrated by the loader */
      bylines: ContentBylineCredit[];
      /** Primary byline summary */
      byline: BylineSummary | null;
      /** SEO metadata */
      seo: ContentSeo | null;
      /** Author ID */
      authorId: string | null;
      /** Primary byline ID */
      primaryBylineId: string | null;
      /** Draft revision ID */
      draftRevisionId: string | null;
      /** Live revision ID */
      liveRevisionId: string | null;
      /** Content locale */
      locale: string;
      /** Translation group ID */
      translationGroup: string | null;
      /** Content ID (ULID) */
      id: string;
    };
  }
}

export {};
