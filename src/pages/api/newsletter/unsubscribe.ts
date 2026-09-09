import type { APIContext } from "astro";
import { siteConfig } from "../../../site.config";
import {
  getWorkerEnv,
  isNewsletterConfigured,
  isSecureToken,
  unsubscribeSubscriber,
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
 * POST /api/newsletter/unsubscribe
 *
 * Unsubscribe using the stable opaque token from the email footer.
 *
 * The token is delivered as a URL fragment (#token=...) and extracted by the
 * client-side UI.  This endpoint receives the raw token in the POST body.
 *
 * Request body (JSON, size-limited to 8 KB):
 *   { "token": string }
 *
 * Responses:
 *   200 -- Successfully unsubscribed (or token was invalid/replayed)
 *   400 -- Missing or invalid token
 *   429 -- Rate limited per IP
 *   503 -- Service unavailable
 *
 * This endpoint is idempotent and non-enumerating: invalid and replayed
 * tokens always return 200.  No IP, email, or token values are logged.
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
      rateLimitKey(context.request, "unsubscribe"),
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
  //    Uses the raw unsubscribe_token column per canonical schema.
  // -----------------------------------------------------------------------
  try {
    await unsubscribeSubscriber(bindings.NEWSLETTER_DB, tokenRaw);
  } catch {
    return unavailableResponse();
  }

  // Always return 200 -- idempotent and non-enumerating.
  return successResponse();
}
