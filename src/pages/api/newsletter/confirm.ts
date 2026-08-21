import type { APIContext } from "astro";
import { siteConfig } from "../../../site.config";
import {
  getWorkerEnv,
  isNewsletterConfigured,
  hashToken,
  confirmSubscriber,
  disabledResponse,
  unavailableResponse,
  badRequestResponse,
  successResponse,
  MAX_BODY_BYTES,
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
 *   503 -- Service unavailable
 *
 * This endpoint is non-enumerating: both success and failure return 200.
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
  // 3. Parse request body
  // -----------------------------------------------------------------------
  const body = await parseStrictJSON(context.request);
  if (body === null) {
    return badRequestResponse("Invalid request");
  }

  const tokenRaw: unknown = body.token;
  if (typeof tokenRaw !== "string" || tokenRaw.length === 0) {
    return badRequestResponse("Token is required");
  }

  // -----------------------------------------------------------------------
  // 4. Direct conditional UPDATE ... RETURNING (no preliminary lookup)
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
