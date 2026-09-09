import type { APIContext } from "astro";
import { siteConfig } from "../../../site.config";
import {
  getWorkerEnv,
  isNewsletterConfigured,
  normalizeEmail,
  validateEmail,
  verifyTurnstile,
  checkRateLimit,
  subscribeAtomic,
  releaseReservation,
  completeConfirmationAdmission,
  sendConfirmationEmail,
  disabledResponse,
  unavailableResponse,
  rateLimitedResponse,
  badRequestResponse,
  acceptedResponse,
  readJSONBody,
  rateLimitKey,
} from "../../../lib/newsletter";

/**
 * POST /api/newsletter/subscribe
 *
 * Initiate the double-opt-in subscription flow.
 *
 * Request body (JSON, size-limited to 8 KB):
 *   { "email": string, "name"?: string, "turnstileToken": string }
 *
 * Responses (after valid JSON, rate limiting, and Turnstile):
 *   202 -- Accepted with {"success":true} (email sent, already pending, or already subscribed)
 *   400 -- Validation error (invalid JSON, email, or missing turnstile token)
 *   429 -- Rate limited (per IP via NEWSLETTER_SUBSCRIBE_LIMITER)
 *   503 -- Service unavailable (missing bindings or not configured)
 *
 * Accepted requests have a uniform public status/body; this does not promise
 * uniform timing. Confirmation email delivery remains synchronous.
 */
export async function POST(context: APIContext): Promise<Response> {
  // -----------------------------------------------------------------------
  // 1. Check enabled -- return 404 before resolving any binding
  // -----------------------------------------------------------------------
  if (!siteConfig.newsletter.enabled) {
    return disabledResponse();
  }

  // -----------------------------------------------------------------------
  // 2. Resolve bindings
  // -----------------------------------------------------------------------
  let env: Record<string, unknown>;
  try {
    env = await getWorkerEnv();
  } catch {
    return unavailableResponse();
  }

  if (!isNewsletterConfigured(env)) {
    return unavailableResponse();
  }

  const bindings = env; // narrowed to NewsletterEnv

  // -----------------------------------------------------------------------
  // 3. Validate sender address is configured
  // -----------------------------------------------------------------------
  if (
    typeof siteConfig.newsletter.senderAddress !== "string" ||
    siteConfig.newsletter.senderAddress.length === 0
  ) {
    return unavailableResponse();
  }

  // -----------------------------------------------------------------------
  // 4. Rate limit by IP (fail-closed: binding error returns 503)
  // -----------------------------------------------------------------------
  const ip =
    context.request.headers.get("CF-Connecting-IP") ?? "unknown";

  let allowed: boolean;
  try {
    allowed = await checkRateLimit(
      bindings.NEWSLETTER_SUBSCRIBE_LIMITER,
      rateLimitKey(context.request, "subscribe"),
    );
  } catch {
    return unavailableResponse();
  }
  if (!allowed) {
    return rateLimitedResponse();
  }

  // -----------------------------------------------------------------------
  // 5. Parse & validate request body (bounded JSON)
  // -----------------------------------------------------------------------
  const body = await readJSONBody(context.request);
  if (body === null) {
    return badRequestResponse("Invalid JSON body");
  }

  const emailRaw: unknown = body.email;
  const nameRaw: unknown = body.name;
  const turnstileTokenRaw: unknown = body.turnstileToken;

  if (typeof emailRaw !== "string" || emailRaw.length === 0) {
    return badRequestResponse("Email is required");
  }
  if (typeof turnstileTokenRaw !== "string" || turnstileTokenRaw.length === 0) {
    return badRequestResponse("Turnstile token is required");
  }

  const email = normalizeEmail(emailRaw);
  if (!validateEmail(email)) {
    return badRequestResponse("Invalid email address");
  }

  const name =
    typeof nameRaw === "string" && nameRaw.length > 0
      ? nameRaw.trim()
      : null;

  // -----------------------------------------------------------------------
  // 5. Verify Turnstile (fail-closed)
  // -----------------------------------------------------------------------
  const turnstileValid = await verifyTurnstile(
    turnstileTokenRaw,
    bindings.TURNSTILE_SECRET_KEY,
    ip,
    "newsletter_subscribe",
    siteConfig.newsletter.expectedHostname,
  );
  if (!turnstileValid) {
    return badRequestResponse("Verification failed");
  }

  // -----------------------------------------------------------------------
  // 6. Atomic subscribe (INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING)
  // -----------------------------------------------------------------------
  let result: Awaited<ReturnType<typeof subscribeAtomic>>;
  try {
    result = await subscribeAtomic(
      bindings.NEWSLETTER_DB,
      email,
      name,
      siteConfig.newsletter.consentVersion,
    );
  } catch {
    return unavailableResponse();
  }

  // -----------------------------------------------------------------------
  // 7. Send confirmation email if the upsert reserved a slot
  // -----------------------------------------------------------------------
  if (result.shouldSend && result.subscriberId && result.confirmToken && result.admissionId) {
    try {
      await sendConfirmationEmail(
        bindings,
        result.email,
        result.name,
        result.confirmToken,
        siteConfig.url,
        siteConfig.newsletter.senderAddress,
      );
      await completeConfirmationAdmission(
        bindings.NEWSLETTER_DB,
        result.subscriberId,
        result.admissionId,
      );
    } catch {
      // Email send failed -- release the reservation so the next request
      // can retry without waiting for the cooldown.
      await releaseReservation(
        bindings.NEWSLETTER_DB,
        result.email,
        result.admissionId,
      );
    }
  }

  // -----------------------------------------------------------------------
  // 8. Always return 202 (non-enumerating)
  // -----------------------------------------------------------------------
  return acceptedResponse();
}
