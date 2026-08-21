import { getEmDashCollection } from "emdash";
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
    title: siteConfig.title,
    description: siteConfig.description,
    site: context.site!,
    items,
    customData: "<language>en-us</language>",
  });
}
