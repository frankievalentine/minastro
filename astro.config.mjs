// @ts-check

import cloudflare from "@astrojs/cloudflare";
import mdx from "@astrojs/mdx";
import partytown from "@astrojs/partytown";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import expressiveCode from "astro-expressive-code";
import emdash from "emdash/astro";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { siteConfig } from "./src/site.config.ts";

// https://astro.build/config
export default defineConfig({
  site: siteConfig.url,
  integrations: [
    expressiveCode({
      themes: ["catppuccin-mocha", "catppuccin-latte"],
      useDarkModeMediaQuery: false,
      themeCssSelector: (theme) =>
        theme.type === "dark" ? ".dark" : ":root:not(.dark)",
    }),
    mdx(),
    react(),
    partytown({
      config: {
        forward: ["dataLayer.push"],
      },
    }),
    emdash({
      siteUrl: siteConfig.url,
      allowedOrigins: [],
      database: d1({ binding: "DB" }),
      storage: r2({ binding: "MEDIA" }),
    }),
  ],
  output: "server",
  adapter: cloudflare({
    imageService: "passthrough",
  }),
  vite: {
    plugins: [tailwindcss()],
  },
});
