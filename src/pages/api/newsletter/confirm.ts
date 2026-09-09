import type { APIContext } from "astro";
import { siteConfig } from "../../../site.config";
import {
  getWorkerEnv,
  isNewsletterConfigured,
  hashToken,
  isSecureToken,
  confirmSubscriber,
  disabledResponse,
  unavailableResponse,
  badRequestResponse,
  successResponse,
  readJSONBody,
  checkRateLimit,
  rateLimitKey,
  rateLimitedResponse,
} from "../../../lib/newsletter";

/**
 * POST /api/newsletter/confirm
 *
 * Confirm a pending subscription using the token from the confirmation email.
 *
 * The token is delivered as a URL fragment (#token=...) and extracted by the
 * client-side UI.  This endpoint receives the raw token in the POST body.
 *
 * Request body (JSON, size-limited to 8 KB):
 *   { "token": string }
 *
 * Responses:
 *   200 -- Subscription confirmed (or token was invalid/expired/replayed)
 *   400 -- Missing or invalid token
 *   429 -- Rate limited per IP
 *   503 -- Service unavailable
 *
 * This endpoint is non-enumerating for valid-shaped tokens: success and token
 * failure both return 200.
 * No IP, email, or token values are logged.
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

  const bindings = env;

  // -----------------------------------------------------------------------
  // 3. Rate limit by IP (fail-closed: binding error returns 503)
  // -----------------------------------------------------------------------
  let allowed: boolean;
  try {
    allowed = await checkRateLimit(
      bindings.NEWSLETTER_SUBSCRIBE_LIMITER,
      rateLimitKey(context.request, "confirm"),
    );
  } catch {
    return unavailableResponse();
  }
  if (!allowed) return rateLimitedResponse();

  // -----------------------------------------------------------------------
  // 4. Parse request body
  // -----------------------------------------------------------------------
  const body = await readJSONBody(context.request);
  if (body === null) {
    return badRequestResponse("Invalid request");
  }

  const tokenRaw: unknown = body.token;
  if (typeof tokenRaw !== "string" || tokenRaw.length === 0) {
    return badRequestResponse("Token is required");
  }
  if (!isSecureToken(tokenRaw)) {
    return badRequestResponse("Invalid token");
  }

  // -----------------------------------------------------------------------
  // 5. Direct conditional UPDATE ... RETURNING (no preliminary lookup)
  // -----------------------------------------------------------------------
  const tokenHash = await hashToken(tokenRaw);

  try {
    await confirmSubscriber(bindings.NEWSLETTER_DB, tokenHash);
  } catch {
    return unavailableResponse();
  }

  // Always return 200 -- non-enumerating.  The UI shows a generic success
  // message regardless of whether the token was valid, expired, or replayed.
  return successResponse();
}
