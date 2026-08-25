/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

export {};

declare global {
  interface Window {
    basecoat?: {
      initAll: (options?: { force?: boolean }) => void;
      theme: {
        get: () => "dark" | "light";
        set: (mode: "dark" | "light") => void;
        toggle: () => void;
      };
    };
  }
}

/* Newsletter bindings are optional and are added by cloudflare:setup when
   newsletter provisioning is enabled. Use isNewsletterConfigured() in
   src/lib/newsletter.ts to narrow the runtime env at the call site. */
