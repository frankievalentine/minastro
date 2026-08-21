// @ts-check

import cloudflare from "@astrojs/cloudflare";
import partytown from "@astrojs/partytown";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { siteConfig } from "./src/site.config.ts";

// https://astro.build/config
export default defineConfig({
  site: siteConfig.url,
  integrations: [
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
  markdown: {
    shikiConfig: {
      themes: {
        light: "catppuccin-latte",
        dark: "catppuccin-mocha",
      },
      defaultColor: false,
    },
  },
  output: "server",
  adapter: cloudflare({
    imageService: "passthrough",
  }),
  vite: {
    plugins: [tailwindcss()],
  },
});
