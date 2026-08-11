import { getEmDashCollection } from "emdash";
import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { siteConfig } from "../site.config";

export async function GET(context: APIContext) {
  const { entries: posts, error } = await getEmDashCollection("posts", {
    status: "published",
  });

  if (error) {
    return new Response("Server error", { status: 500 });
  }

  return rss({
    title: siteConfig.title,
    description: siteConfig.description,
    site: context.site!,
    items: (posts ?? [])
      .sort(
        (a, b) =>
          (b.data.publishedAt?.getTime() ?? 0) -
          (a.data.publishedAt?.getTime() ?? 0)
      )
      .map((post) => ({
        title: post.data.title,
        description: post.data.description,
        pubDate: post.data.publishedAt ?? new Date(),
        link: `/posts/${post.data.slug}/`,
      })),
    customData: "<language>en-us</language>",
  });
}
