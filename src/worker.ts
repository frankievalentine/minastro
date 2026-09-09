import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { protectFirstAdminBootstrap } from "./lib/bootstrap-protection";
import { drainResendOutbox } from "./lib/newsletter-resend";
import { logNewsletterEvent, newsletterErrorClass } from "./lib/newsletter-observability";

export { PluginBridge };

const emdashScheduled = createScheduledHandler();

/** Paths served by the EmDash admin must never be indexed. */
function isAdminPath(pathname: string): boolean {
  return pathname === "/_emdash/admin" || pathname.startsWith("/_emdash/admin/");
}

export default {
  ...handler,
  async fetch(request, env, ctx) {
    const bootstrapResponse = await protectFirstAdminBootstrap(
      request,
      env as { DB?: D1Database; EMDASH_BOOTSTRAP_SECRET?: string },
    );
    if (bootstrapResponse) return bootstrapResponse;

    if (!handler.fetch) {
      throw new Error("EmDash handler does not expose a fetch handler");
    }
    const response = await handler.fetch(request, env, ctx);
    if (!isAdminPath(new URL(request.url).pathname)) return response;

    const headers = new Headers(response.headers);
    headers.set("X-Robots-Tag", "noindex, nofollow");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  scheduled(controller, env, ctx) {
    try {
      emdashScheduled(controller, env, ctx);
    } catch {
      console.error("[scheduled] EmDash maintenance failed");
    }
    ctx.waitUntil(
      drainResendOutbox(env as Record<string, unknown>).catch((error: unknown) => {
        logNewsletterEvent("newsletter_scheduled_maintenance_failure", {
          operation: "maintenance",
          state: "failed",
          error_class: newsletterErrorClass(error),
        });
      }),
    );
  },
} satisfies ExportedHandler;
