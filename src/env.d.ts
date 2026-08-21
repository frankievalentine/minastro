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

/* Newsletter bindings are optional and are added by cloudflare:setup when
   newsletter provisioning is enabled. Use isNewsletterConfigured() in
   src/lib/newsletter.ts to narrow the runtime env at the call site. */
