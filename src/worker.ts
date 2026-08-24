import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { drainResendOutbox } from "./lib/newsletter-resend";

export { PluginBridge };

const emdashScheduled = createScheduledHandler();

/** Paths served by the EmDash admin must never be indexed. */
function isAdminPath(pathname: string): boolean {
  return pathname === "/_emdash/admin" || pathname.startsWith("/_emdash/admin/");
}

export default {
  ...handler,
  async fetch(request, env, ctx) {
    const response = await handler.fetch!(request, env, ctx);
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
    } catch (error) {
      console.error("[scheduled] EmDash maintenance failed:", error);
    }
    ctx.waitUntil(
      drainResendOutbox(env as Record<string, unknown>).catch((error: unknown) => {
        console.error("[scheduled] Resend outbox drain failed:", error);
      }),
    );
  },
} satisfies ExportedHandler;
