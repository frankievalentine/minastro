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
  sendConfirmationEmail,
  disabledResponse,
  unavailableResponse,
  rateLimitedResponse,
  badRequestResponse,
  acceptedResponse,
  MAX_BODY_BYTES,
} from "../../../lib/newsletter";

/**
 * POST /api/newsletter/subscribe
 *
 * Initiate the double-opt-in subscription flow.
 *
 * Request body (JSON, size-limited to 8 KB):
 *   { "email": string, "name"?: string, "turnstileToken": string }
 *
 * Responses (all non-enumerating after valid Turnstile):
 *   202 -- Accepted (email sent, already pending, or already subscribed)
 *   400 -- Validation error (invalid JSON, email, or missing turnstile token)
 *   429 -- Rate limited (per IP via NEWSLETTER_SUBSCRIBE_LIMITER)
 *   503 -- Service unavailable (missing bindings or not configured)
 *
 * This endpoint never reveals whether an email is already subscribed.
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
      ip,
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
  const body = await parseStrictJSON(context.request);
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
  if (result.shouldSend && result.confirmToken && result.confirmationTokenHash) {
    try {
      await sendConfirmationEmail(
        bindings,
        result.email,
        result.name,
        result.confirmToken,
        siteConfig.url,
        siteConfig.newsletter.senderAddress,
      );
    } catch {
      // Email send failed -- release the reservation so the next request
      // can retry without waiting for the cooldown.
      await releaseReservation(
        bindings.NEWSLETTER_DB,
        result.email,
        result.confirmationTokenHash,
      );
    }
  }

  // -----------------------------------------------------------------------
  // 8. Always return 202 (non-enumerating)
  // -----------------------------------------------------------------------
  return acceptedResponse();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON request body with a strict size limit (8 KB).
 * Returns `null` on parse failure.
 */
async function parseStrictJSON(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return null;
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }

  if (text.length > MAX_BODY_BYTES) return null;

  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
