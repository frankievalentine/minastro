import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { drainResendOutbox } from "./lib/newsletter-resend";

export { PluginBridge };

const emdashScheduled = createScheduledHandler();

export default {
  ...handler,
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
