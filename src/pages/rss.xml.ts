import { getEmDashCollection, getSiteSettings } from "emdash";
import rss from "@astrojs/rss";
import type { APIContext } from "astro";

export async function GET(context: APIContext) {
  interface RssItem {
    title: string;
    description: string;
    pubDate: Date;
    link: string;
  }

  // Settings failures must surface, not fall back silently.
  // Runtime identity is CMS-owned only; there is no local fallback.
  const settings = await getSiteSettings();
  const rssTitle =
    typeof settings?.title === "string" && settings.title.trim()
      ? settings.title
      : null;
  if (!rssTitle) {
    throw new Error(
      "CMS site settings are missing a title. Set one in EmDash → Settings; there is no local identity fallback.",
    );
  }
  const rssDescription =
    typeof settings?.tagline === "string" && settings.tagline.trim()
      ? settings.tagline
      : "";

  if (!context.site) {
    throw new Error(
      "Astro site config is missing `site`; RSS requires a canonical URL.",
    );
  }

  const { entries: posts, error } = await getEmDashCollection("posts", {
    status: "published",
  });

  if (error) {
    return new Response("Server error", { status: 500 });
  }

  const items: RssItem[] = posts
    .sort(
      (a, b) =>
        (b.data.publishedAt?.getTime() ?? 0) -
        (a.data.publishedAt?.getTime() ?? 0),
    )
    .flatMap((post) => {
      const { publishedAt, slug } = post.data;
      if (!(publishedAt instanceof Date) || !slug) {
        return [];
      }

      return [{
        title: post.data.title,
        description: post.data.description,
        pubDate: publishedAt,
        link: `/posts/${slug}/`,
      }];
    });

  return rss({
    title: rssTitle,
    description: rssDescription,
    site: context.site,
    items,
    customData: "<language>en-us</language>",
  });
}
