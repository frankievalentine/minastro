/**
 * Server-side newsletter consent workflow.
 *
 * Disabled by default -- every API route returns 404 before resolving any
 * Cloudflare binding when `siteConfig.newsletter.enabled` is false.
 *
 * This module owns all D1 queries, token management, Turnstile validation,
 * rate-limit checks, and transactional email dispatch.  It exports types and
 * helpers that the API route layer consumes.  No UI, no config, no worker
 * entry-point changes.
 *
 * Required bindings (wrangler.jsonc / dashboard):
 *   NEWSLETTER_DB               -- D1 database (separate from main EmDash DB)
 *   NEWSLETTER_EMAIL            -- SendEmail binding (verified sender domain)
 *   NEWSLETTER_SUBSCRIBE_LIMITER -- RateLimiter binding (5 req / 60 s)
 *
 * Required env secrets (set via `wrangler secret put`):
 *   TURNSTILE_SECRET_KEY -- Turnstile secret key for server-side verification
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubscriberStatus = "pending" | "active" | "unsubscribed";

/**
 * Shape returned by every newsletter API endpoint.
 * Frontend code should key on `success` and surface `error` when present.
 */
export interface NewsletterApiResponse {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Confirmation token time-to-live (24 hours). */
export const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;

/** Minimum interval before a new confirmation email can be sent (15 minutes). */
export const RESEND_COOLDOWN_MS = 15 * 60 * 1_000;

/** Maximum JSON body size for API requests (8 KB). */
export const MAX_BODY_BYTES = 8_192;

/** Turnstile site-verify endpoint. */
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// ---------------------------------------------------------------------------
// Runtime env type guard
// ---------------------------------------------------------------------------

/**
 * Runtime shape of the newsletter-specific Cloudflare bindings.
 *
 * These are NOT declared in `env.d.ts` -- Cloudflare worker types come from
 * the `@cloudflare/workers-types` reference.  This interface is used only
 * as a narrowing target for the runtime type guard below.
 */
export interface NewsletterEnv {
  NEWSLETTER_DB: D1Database;
  NEWSLETTER_EMAIL: SendEmail;
  NEWSLETTER_SUBSCRIBE_LIMITER: RateLimit;
  TURNSTILE_SECRET_KEY: string;
  [key: string]: unknown;
}

/**
 * Narrow the raw Worker `env` to the newsletter-specific shape.
 *
 * Returns `true` and acts as a TypeScript type guard when all required
 * bindings are present.  All bindings are required when newsletter is
 * enabled -- absence of any binding returns 503.
 */
export function isNewsletterConfigured(
  env: Record<string, unknown>,
): env is NewsletterEnv {
  return (
    typeof env.NEWSLETTER_DB === "object" &&
    env.NEWSLETTER_DB !== null &&
    typeof env.NEWSLETTER_EMAIL === "object" &&
    env.NEWSLETTER_EMAIL !== null &&
    typeof env.NEWSLETTER_SUBSCRIBE_LIMITER === "object" &&
    env.NEWSLETTER_SUBSCRIBE_LIMITER !== null &&
    typeof env.TURNSTILE_SECRET_KEY === "string" &&
    env.TURNSTILE_SECRET_KEY.length > 0
  );
}

/**
 * Resolve the Worker `env` at runtime.
 *
 * Uses the `cloudflare:workers` module which is available when the code runs
 * inside a Cloudflare Worker (deployed or via `wrangler dev`).  Throws when
 * the module is unavailable (e.g. Node.js prerender).
 */
export async function getWorkerEnv(): Promise<Record<string, unknown>> {
  const mod: Record<string, unknown> = await import("cloudflare:workers");
  return mod.env as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lower-case and strip surrounding whitespace. */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Minimal email validation -- checks for an `@` with non-empty local-part and
 * domain, and a dot in the domain.  This is intentionally not RFC 5322
 * exhaustive; the confirmation step provides a stronger guarantee.
 */
export function validateEmail(email: string): boolean {
  if (email.length > 254) return false;
  const atIndex = email.indexOf("@");
  if (atIndex < 1 || atIndex !== email.lastIndexOf("@")) return false;
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (local.length === 0 || local.length > 64) return false;
  if (domain.length < 4 || domain.length > 253) return false;
  if (!domain.includes(".")) return false;
  if (/[\s"(),:;<>[\\\]]/.test(email)) return false;
  return true;
}

/**
 * Generate a cryptographically-random opaque token.
 *
 * Produces 32 random bytes encoded as base64url (43 characters, no padding).
 * Suitable for confirmation and unsubscribe tokens.
 */
export function generateSecureToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 hex digest of the input string. */
export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

/** ISO-8601 datetime string for `now + offsetMs` in SQLite-compatible format. */
export function expiresAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/**
 * Check the rate limiter for the given IP.
 *
 * Returns `true` when the request is allowed, `false` when rate-limited.
 * Throws on binding error so the caller can return 503.
 */
export async function checkRateLimit(
  limiter: RateLimit,
  ip: string,
): Promise<boolean> {
  const outcome = await limiter.limit({ key: ip });
  return outcome.success;
}

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

interface TurnstileVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
  hostname?: string;
  action?: string;
  cdata?: string;
}

/**
 * Server-side Turnstile token verification.
 *
 * @param token           - The Turnstile client response token.
 * @param secretKey       - The Turnstile secret key (from binding/secret).
 * @param remoteIp        - The visitor IP (CF-Connecting-IP) for server-side validation.
 * @param action          - Expected action name (fail-closed if mismatched).
 * @param expectedHostname- Expected hostname (fail-closed if mismatched).
 * @returns               - `true` when the token is valid and passes all checks.
 *
 * Fail-closed: any unexpected response shape or missing field returns `false`.
 */
export async function verifyTurnstile(
  token: string,
  secretKey: string,
  remoteIp: string,
  action: string,
  expectedHostname: string,
): Promise<boolean> {
  if (!token || !secretKey) return false;

  try {
    const formData = new URLSearchParams({
      secret: secretKey,
      response: token,
      remoteip: remoteIp,
    });

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: formData.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    if (!response.ok) return false;

    const data: TurnstileVerifyResponse = await response.json();

    // success must be true
    if (!data.success) return false;

    // action must match exactly
    if (data.action !== action) return false;

    // hostname must match exactly
    if (data.hostname !== expectedHostname) return false;

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Atomic subscribe (INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING)
// ---------------------------------------------------------------------------

export interface SubscribeResult {
  /** Whether a confirmation email should be sent. */
  shouldSend: boolean;
  /** The subscriber's email address (for the email send). */
  email: string;
  /** The subscriber's display name (may be null). */
  name: string | null;
  /** The raw confirmation token (only set when shouldSend is true). */
  confirmToken?: string;
  /** The SHA-256 hash of the confirmation token (for reservation release). */
  confirmationTokenHash?: string;
  /** The raw unsubscribe token (stable, preserved across resubscriptions). */
  unsubscribeToken?: string;
}

/**
 * Atomically insert or update a subscriber, returning whether a confirmation
 * email should be sent.
 *
 * This uses a single `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING`
 * statement to avoid read-then-write races.  The behaviour per status:
 *
 *   - **New email**: inserted as `pending` with fresh tokens.  Email sent.
 *   - **Pending, past cooldown**: tokens refreshed, `consent_version` updated.
 *     Email sent.
 *   - **Pending, within cooldown**: no change.  No email sent (202).
 *   - **Active**: no change.  No email sent (202).
 *   - **Unsubscribed**: moved to `pending` with fresh confirmation token,
 *     `consent_version` updated.  Existing `unsubscribe_token` is preserved.
 *     Email sent.
 *
 * When the email send fails, the caller should call `releaseReservation()` to
 * clear the token fields so the next request can retry without waiting for
 * the cooldown.
 */
export async function subscribeAtomic(
  db: D1Database,
  email: string,
  name: string | null,
  consentVersion: string,
): Promise<SubscribeResult> {
  const confirmToken = generateSecureToken();
  const unsubscribeToken = generateSecureToken();
  const confirmTokenHash = await hashToken(confirmToken);
  const confirmTokenExpiresAt = expiresAt(CONFIRM_TOKEN_TTL_MS);

  // Bind order:
  //   1. email                (VALUES)
  //   2. name                 (VALUES)
  //   3. confirmationTokenHash   (VALUES)
  //   4. confirmationExpiresAt   (VALUES)
  //   5. unsubscribeToken     (VALUES, raw)
  //   6. consentVersion       (VALUES)
  //   7. name                 (SET COALESCE)
  //   8. confirmationTokenHash   (SET)
  //   9. confirmationExpiresAt   (SET)
  //  10. consentVersion       (SET)
  const stmt = db
    .prepare(
      `INSERT INTO newsletter_subscribers
         (email, name, status, confirmation_token_hash, confirmation_expires_at,
           unsubscribe_token, last_confirmation_sent_at,
           consent_version, requested_at)
       VALUES (?, ?, 'pending', ?, ?, ?, datetime('now'), ?, datetime('now'))
       ON CONFLICT(email) DO UPDATE SET
         name = COALESCE(?, newsletter_subscribers.name),
         status = 'pending',
         confirmation_token_hash = ?,
         confirmation_expires_at = ?,
         last_confirmation_sent_at = datetime('now'),
         consent_version = ?,
         requested_at = datetime('now'),
         updated_at = datetime('now')
       WHERE newsletter_subscribers.status != 'active'
         AND (newsletter_subscribers.status = 'unsubscribed'
              OR newsletter_subscribers.last_confirmation_sent_at IS NULL
              OR datetime('now') > datetime(newsletter_subscribers.last_confirmation_sent_at, '+15 minutes'))
       RETURNING status, unsubscribe_token`,
    )
    .bind(
      email,
      name,
      confirmTokenHash,
      confirmTokenExpiresAt,
      unsubscribeToken,
      consentVersion,
      name,
      confirmTokenHash,
      confirmTokenExpiresAt,
      consentVersion,
    );

  const result = await stmt.run();

  // RETURNING returns a row when the INSERT succeeded or the UPDATE matched.
  // No row means the subscriber is active or within cooldown.
  const rows = result.results as
    | Array<{ status: string; unsubscribe_token: string | null }>
    | undefined;
  const shouldSend = rows !== undefined && rows.length > 0;

  if (!shouldSend) {
    return { shouldSend: false, email, name };
  }

  // Use the stored unsubscribe_token from RETURNING.  On INSERT this is the
  // newly generated token; on UPDATE (resubscribe) it is the preserved value.
  const storedUnsubscribeToken = rows[0].unsubscribe_token ?? unsubscribeToken;

  return {
    shouldSend: true,
    email,
    name,
    confirmToken,
    confirmationTokenHash: confirmTokenHash,
    unsubscribeToken: storedUnsubscribeToken,
  };
}

/**
 * Best-effort release of a confirmation-token reservation after a failed
 * email send.  Clears the token fields so the next subscribe request can
 * generate fresh tokens without waiting for the cooldown.
 *
 * Includes both email and the attempted confirmation hash in the WHERE clause
 * to avoid clearing a newer reservation in a concurrent-request race.
 */
export async function releaseReservation(
  db: D1Database,
  email: string,
  confirmationTokenHash: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE newsletter_subscribers
         SET confirmation_token_hash = NULL,
             confirmation_expires_at = NULL,
             last_confirmation_sent_at = NULL,
             updated_at = datetime('now')
         WHERE email = ? AND confirmation_token_hash = ?`,
      )
      .bind(email, confirmationTokenHash)
      .run();
  } catch {
    // Best-effort; the cooldown will expire naturally.
  }
}

// ---------------------------------------------------------------------------
// Confirm (direct conditional UPDATE ... RETURNING)
// ---------------------------------------------------------------------------

/**
 * Atomically confirm a pending subscription.
 *
 * Single-use and expiry-bound: only transitions `pending` -> `active` when
 * the token hash matches and has not expired.  No preliminary lookup --
 * the UPDATE itself is the authoritative check.
 *
 * Returns `true` when a row was actually updated.
 */
export async function confirmSubscriber(
  db: D1Database,
  tokenHash: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE newsletter_subscribers
       SET status = 'active',
           confirmation_token_hash = NULL,
           confirmation_expires_at = NULL,
            first_confirmed_at = COALESCE(first_confirmed_at, datetime('now')),
           last_confirmed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE confirmation_token_hash = ?
         AND status = 'pending'
         AND confirmation_expires_at > datetime('now')
       RETURNING id`,
    )
    .bind(tokenHash)
    .run();

  const rows = result.results as Array<{ id: number }> | undefined;
  return rows !== undefined && rows.length > 0;
}

// ---------------------------------------------------------------------------
// Unsubscribe (direct conditional UPDATE ... RETURNING)
// ---------------------------------------------------------------------------

/**
 * Atomically unsubscribe a subscriber using the raw stable token.
 *
 * Only transitions non-unsubscribed states to `unsubscribed`.  No preliminary
 * lookup -- the UPDATE itself is the authoritative check.
 *
 * Returns `true` when a row was actually updated (idempotent: already
 * unsubscribed returns `false`).
 */
export async function unsubscribeSubscriber(
  db: D1Database,
  token: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE newsletter_subscribers
       SET status = 'unsubscribed',
           last_unsubscribed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE unsubscribe_token = ?
         AND status != 'unsubscribed'
       RETURNING id`,
    )
    .bind(token)
    .run();

  const rows = result.results as Array<{ id: number }> | undefined;
  return rows !== undefined && rows.length > 0;
}

// ---------------------------------------------------------------------------
// Email dispatch
// ---------------------------------------------------------------------------

/**
 * Send a double-opt-in confirmation email via the NEWSLETTER_EMAIL binding.
 *
 * @param bindings    - The narrowed newsletter env.
 * @param to          - Recipient email address.
 * @param name        - Optional recipient name (used for personalisation).
 * @param confirmToken- The raw (unhashed) confirmation token for the link.
 * @param origin      - Trusted site origin for the confirmation link.
 * @param senderAddress- Verified sender address from site config.
 */
export async function sendConfirmationEmail(
  bindings: NewsletterEnv,
  to: string,
  name: string | null,
  confirmToken: string,
  origin: string,
  senderAddress: string,
): Promise<void> {
  const confirmUrl = `${origin}/newsletter/confirm#token=${encodeURIComponent(confirmToken)}`;
  const greeting = name ? `Hi ${name},` : "Hi there,";

  const textBody = [
    greeting,
    "",
    "Thanks for subscribing to the newsletter!",
    "",
    "Please confirm your subscription by clicking the link below:",
    confirmUrl,
    "",
    "This link expires in 24 hours.",
    "",
    "If you did not request this, you can safely ignore this email.",
    "",
    "To unsubscribe at any time, use the link in any future email.",
  ].join("\n");

  const htmlBody = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; max-width: 480px; margin: 0 auto;">
  <p style="font-size: 16px; line-height: 1.5;">${greeting.replace(/</g, "&lt;")}</p>
  <p style="font-size: 16px; line-height: 1.5;">Thanks for subscribing to the newsletter!</p>
  <p style="font-size: 16px; line-height: 1.5;">
    <a href="${confirmUrl.replace(/&/g, "&amp;")}"
       style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
      Confirm subscription
    </a>
  </p>
  <p style="font-size: 14px; color: #6b7280;">This link expires in 24 hours.</p>
  <p style="font-size: 14px; color: #6b7280;">If you did not request this, you can safely ignore this email.</p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
  <p style="font-size: 12px; color: #9ca3af;">&mdash; The Team</p>
</body>
</html>`;

  await bindings.NEWSLETTER_EMAIL.send({
    from: senderAddress,
    to,
    subject: "Confirm your newsletter subscription",
    text: textBody,
    html: htmlBody,
  });
}

// ---------------------------------------------------------------------------
// Generic response factories
// ---------------------------------------------------------------------------

/** 404 -- newsletter disabled. */
export function disabledResponse(): Response {
  return new Response(
    JSON.stringify({ success: false, error: "Not found" }),
    {
      status: 404,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** 503 -- service unavailable (missing bindings or config). */
export function unavailableResponse(): Response {
  return new Response(
    JSON.stringify({ success: false, error: "Service unavailable" }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** 429 -- rate limited. */
export function rateLimitedResponse(): Response {
  return new Response(
    JSON.stringify({ success: false, error: "Too many requests" }),
    {
      status: 429,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** 400 -- bad request. */
export function badRequestResponse(error: string): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/** 202 -- accepted (non-enumerating). */
export function acceptedResponse(): Response {
  return new Response(JSON.stringify({ success: true }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

/** 200 -- success. */
export function successResponse(): Response {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
