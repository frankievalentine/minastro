/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

export {};

declare global {
  interface Window {
    basecoat?: {
      stop: () => void;
      initAll: () => void;
      start: () => void;
      init: (component: string) => void;
    };
  }
}

/* Newsletter bindings are optional -- only present when the user has
   provisioned them and merged wrangler.newsletter.jsonc into their config.
   Use the isNewsletterConfigured() type guard in src/lib/newsletter.ts
   to narrow the runtime env at the call site. */
