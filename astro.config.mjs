// @ts-check

import cloudflare from "@astrojs/cloudflare";
import mdx from "@astrojs/mdx";
import partytown from "@astrojs/partytown";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import expressiveCode from "astro-expressive-code";
import pagefind from "astro-pagefind";
import { siteConfig } from "./src/site.config.ts";

/** @type {import('vite').Plugin} */
const pagefindExternalPlugin = {
  name: "pagefind-external",
  enforce: "pre",
  // Mark /pagefind/pagefind.js as external at Vite's resolution layer so neither
  // the dev server nor the production build tries to bundle it. The file is
  // generated post-build by pagefind and served at runtime.
  resolveId(id) {
    if (id === "/pagefind/pagefind.js") {
      return { id, external: true };
    }
  },
};

// https://astro.build/config
export default defineConfig({
  site: siteConfig.url,
  integrations: [
    pagefind(),
    expressiveCode({
      themes: ["catppuccin-mocha", "catppuccin-latte"],
      useDarkModeMediaQuery: false,
      themeCssSelector: (theme) =>
        theme.type === "dark" ? ".dark" : ":root:not(.dark)",
    }),
    mdx(),
    sitemap(),
    partytown({
      config: {
        forward: ["dataLayer.push"],
      },
    }),
  ],
  output: "static",
  adapter: cloudflare({
    platformProxy: { enabled: true },
    imageService: "passthrough",
  }),
  vite: {
    plugins: [tailwindcss(), pagefindExternalPlugin],
  },
});
