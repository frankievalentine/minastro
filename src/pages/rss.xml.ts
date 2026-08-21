import { getEmDashCollection, getSiteSettings } from "emdash";
import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { siteConfig } from "../site.config";

export async function GET(context: APIContext) {
  interface RssItem {
    title: string;
    description: string;
    pubDate: Date;
    link: string;
  }

  // Settings failures must surface, not fall back silently.
  const settings = await getSiteSettings();
  const rssTitle =
    typeof settings?.title === "string" && settings.title.trim()
      ? settings.title
      : siteConfig.title;
  const rssDescription =
    typeof settings?.tagline === "string" && settings.tagline.trim()
      ? settings.tagline
      : siteConfig.description;

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
    site: context.site!,
    items,
    customData: "<language>en-us</language>",
  });
}
