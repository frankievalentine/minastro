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

import { logNewsletterEvent, newsletterErrorClass } from "./newsletter-observability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubscriberStatus = "pending" | "active" | "unsubscribed" | "erasure_pending";

export type ErasureRequestResult =
  | { status: "requested" }
  | { status: "already_pending" }
  | { status: "not_found" }
  | { status: "credential_required" }
  | { status: "credential_mismatch" }
  | { status: "local_only_not_verified" };

export type ErasurePath = "resend" | "local_only";

export interface ErasureRequestOptions {
  path?: ErasurePath;
  credentialFingerprint?: string;
}

export type ErasureRebindResult = "rebound" | "not_found" | "not_rebindable";

export interface ErasurePreview {
  subscriber_id: number;
  status: SubscriberStatus;
  audit_row_count: number;
  outbox_row_count: number;
  outbox_operation: "sync" | "erase" | null;
  outbox_state: "ready" | "running" | "uncertain" | "remote_deleted" | null;
  remote_state: "none" | "remote_deleted" | "initial_absent" | "local_only" | null;
  contact_id_saved: boolean;
  erasure_path?: ErasurePath | null;
  credential_bound?: boolean;
}

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

/** Maximum wall-clock time allowed to read one request body. */
export const BODY_READ_TIMEOUT_MS = 5_000;

/** Raw token size produced by generateSecureToken(). */
export const SECURE_TOKEN_BYTES = 32;

/** Base64url length of a 32-byte token without padding. */
export const SECURE_TOKEN_LENGTH = 43;

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

/** Return a non-reversible custody fingerprint for an operator-approved secret. */
export async function fingerprintCredential(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  const bytes = crypto.getRandomValues(new Uint8Array(SECURE_TOKEN_BYTES));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Validate the exact unpadded base64url shape emitted by generateSecureToken. */
export function isSecureToken(value: string): boolean {
  return value.length === SECURE_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Read and parse one JSON request body without buffering beyond MAX_BODY_BYTES.
 * Content-Length is only an early rejection optimization; the stream is always
 * byte-counted when it is read.
 */
export async function readJSONBody(
  request: Request,
  timeoutMs = BODY_READ_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return null;

  if (!request.body) return null;

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";

  const cancel = () => {
    try {
      void reader.cancel().catch(() => {
        // The request stream may already be closed or aborted.
      });
    } catch {
      // The request stream may already be closed or aborted.
    }
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      cancel();
      reject(new Error("request body read timed out"));
    }, timeoutMs);
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (timedOut) return null;
      if (done) {
        text += decoder.decode();
        break;
      }

      if (!(value instanceof Uint8Array)) {
        cancel();
        return null;
      }

      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        cancel();
        return null;
      }

      text += decoder.decode(value, { stream: true });
    }

    if (timedOut) return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    cancel();
    return null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    try {
      reader.releaseLock();
    } catch {
      // A timed-out stream may still have a pending read being interrupted.
    }
  }
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

export type NewsletterRateLimitScope = "subscribe" | "confirm" | "unsubscribe";

/** Use separate buckets so a signup burst cannot block a valid token link. */
export function rateLimitKey(
  request: Request,
  scope: NewsletterRateLimitScope,
): string {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return `${scope}:${ip}`;
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
  /** The subscriber row receiving the admitted confirmation send. */
  subscriberId?: number;
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
  /** Unique durable owner for the admitted confirmation send. */
  admissionId?: string;
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
  const admissionId = crypto.randomUUID();

  // Bind order:
  //   1. email                (VALUES)
  //   2. name                 (VALUES)
  //   3. confirmationTokenHash   (VALUES)
  //   4. confirmationExpiresAt   (VALUES)
  //   5. admissionId          (VALUES)
  //   6. unsubscribeToken     (VALUES, raw)
  //   7. consentVersion       (VALUES)
  //   8. name                 (SET COALESCE)
  //   9. confirmationTokenHash   (SET)
  //  10. confirmationExpiresAt   (SET)
  //  11. admissionId          (SET)
  //  12. consentVersion       (SET)
  const stmt = db
    .prepare(
      `INSERT INTO newsletter_subscribers
         (email, name, status, confirmation_token_hash, confirmation_expires_at,
           confirmation_admitted, confirmation_admission_id, unsubscribe_token, last_confirmation_sent_at,
           consent_version, requested_at)
       SELECT ?, ?, 'pending', ?, ?, 1, ?, ?, datetime('now'), ?, datetime('now')
       WHERE EXISTS (
         SELECT 1 FROM newsletter_erasure_controls
         WHERE id = 1 AND admission_state = 'open'
       )
       ON CONFLICT(email) DO UPDATE SET
         name = COALESCE(?, newsletter_subscribers.name),
         status = 'pending',
         confirmation_token_hash = ?,
         confirmation_expires_at = ?,
         confirmation_admitted = 1,
         confirmation_admission_id = ?,
         last_confirmation_sent_at = datetime('now'),
         consent_version = ?,
         requested_at = datetime('now'),
         updated_at = datetime('now')
       WHERE newsletter_subscribers.status NOT IN ('active', 'erasure_pending')
         AND newsletter_subscribers.confirmation_admitted = 0
         AND (newsletter_subscribers.status = 'unsubscribed'
              OR newsletter_subscribers.last_confirmation_sent_at IS NULL
              OR datetime('now') > datetime(newsletter_subscribers.last_confirmation_sent_at, '+15 minutes'))
         AND EXISTS (
           SELECT 1 FROM newsletter_erasure_controls
           WHERE id = 1 AND admission_state = 'open'
         )
       RETURNING id, status, unsubscribe_token, confirmation_token_hash, confirmation_admission_id`,
    )
    .bind(
      email,
      name,
      confirmTokenHash,
      confirmTokenExpiresAt,
      admissionId,
      unsubscribeToken,
      consentVersion,
      name,
      confirmTokenHash,
      confirmTokenExpiresAt,
      admissionId,
      consentVersion,
    );

  const result = await stmt.run();

  // RETURNING returns a row when the INSERT succeeded or the UPDATE matched.
  // No row means the subscriber is active or within cooldown.
  const rows = result.results as
    | Array<{ id: number; status: string; unsubscribe_token: string | null; confirmation_token_hash: string | null; confirmation_admission_id: string | null }>
    | undefined;
  const shouldSend = rows !== undefined && rows.length > 0;

  if (!shouldSend) {
    return { shouldSend: false, email, name };
  }

  // Use the stored unsubscribe_token from RETURNING.  On INSERT this is the
  // newly generated token; on UPDATE (resubscribe) it is the preserved value.
  const storedUnsubscribeToken = rows[0].unsubscribe_token ?? unsubscribeToken;

  return {
    subscriberId: rows[0].id,
    shouldSend: true,
    email,
    name,
    confirmToken,
    confirmationTokenHash: confirmTokenHash,
    admissionId: rows[0].confirmation_admission_id ?? admissionId,
    unsubscribeToken: storedUnsubscribeToken,
  };
}

/**
 * Best-effort release of a confirmation-token reservation after a failed
 * email send.  Clears the token fields so the next subscribe request can
 * generate fresh tokens without waiting for the cooldown.
 *
 * Uses the unique admission owner rather than the replaceable confirmation
 * token hash, so a confirmation completion cannot release another reservation.
 */
export async function releaseReservation(
  db: D1Database,
  email: string,
  admissionId: string,
): Promise<void> {
  try {
    await db.batch([
      db.prepare(
        `UPDATE newsletter_subscribers
         SET confirmation_token_hash = NULL,
             confirmation_expires_at = NULL,
             last_confirmation_sent_at = NULL,
             confirmation_admission_id = NULL,
             confirmation_admitted = 0,
             updated_at = datetime('now')
         WHERE email = ? AND confirmation_admission_id = ? AND confirmation_admitted = 1`,
      ).bind(email, admissionId),
      db.prepare(
        `UPDATE newsletter_erasure_controls
         SET active_confirmation_sends = MAX(active_confirmation_sends - 1, 0),
             admission_state = CASE
               WHEN active_confirmation_sends <= 1 AND NOT EXISTS (
                 SELECT 1 FROM resend_sync_outbox
                 WHERE operation = 'erase' AND state IN ('ready', 'running', 'remote_deleted')
               ) THEN 'open'
               ELSE admission_state
             END,
             updated_at = datetime('now')
         WHERE id = 1 AND changes() > 0`,
      ),
    ]);
  } catch {
    // Best-effort; the cooldown will expire naturally.
  }
}

/** Release the admission after a confirmation email was accepted by the provider. */
export async function completeConfirmationAdmission(
  db: D1Database,
  subscriberId: number,
  admissionId: string,
): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE newsletter_subscribers
       SET confirmation_admitted = 0,
           confirmation_admission_id = NULL,
           confirmation_token_hash = CASE WHEN status = 'erasure_pending' THEN NULL ELSE confirmation_token_hash END,
           confirmation_expires_at = CASE WHEN status = 'erasure_pending' THEN NULL ELSE confirmation_expires_at END,
           last_confirmation_sent_at = CASE WHEN status = 'erasure_pending' THEN NULL ELSE last_confirmation_sent_at END,
           updated_at = datetime('now')
       WHERE id = ? AND confirmation_admission_id = ? AND confirmation_admitted = 1`,
    ).bind(subscriberId, admissionId),
    db.prepare(
      `UPDATE newsletter_erasure_controls
       SET active_confirmation_sends = MAX(active_confirmation_sends - 1, 0),
           admission_state = CASE
             WHEN active_confirmation_sends <= 1 AND NOT EXISTS (
               SELECT 1 FROM resend_sync_outbox
               WHERE operation = 'erase' AND state IN ('ready', 'running', 'remote_deleted')
             ) THEN 'open'
             ELSE admission_state
           END,
           updated_at = datetime('now')
       WHERE id = 1 AND changes() > 0`,
    ),
  ]);
}

/**
 * Request a cross-system erasure without exposing subscriber identity. The
 * existing Resend outbox row is reused and its current owner is preserved so
 * an in-flight or uncertain sync must quiesce before erase can run.
 */
export async function requestNewsletterErasure(
  db: D1Database,
  subscriberId: number,
  options: ErasureRequestOptions = {},
): Promise<ErasureRequestResult> {
  if (!Number.isSafeInteger(subscriberId) || subscriberId < 1) return { status: "not_found" };
  const current = await db
    .prepare("SELECT status FROM newsletter_subscribers WHERE id = ?")
    .bind(subscriberId)
    .first<{ status: SubscriberStatus }>();
  if (!current) return { status: "not_found" };

  const path = options.path ?? "resend";
  const control = await db
    .prepare("SELECT admission_state, resend_mode, credential_fingerprint FROM newsletter_erasure_controls WHERE id = 1")
    .first<{ admission_state: "open" | "paused"; resend_mode: "unverified" | "resend" | "local_only"; credential_fingerprint: string | null }>();
  if (!control) return { status: "credential_required" };
  if (path === "resend") {
    if (!options.credentialFingerprint) return { status: "credential_required" };
    if (control.credential_fingerprint && control.credential_fingerprint !== options.credentialFingerprint) {
      return { status: "credential_mismatch" };
    }
  } else if (control.resend_mode === "resend") {
    return { status: "local_only_not_verified" };
  } else {
    const remoteEvidence = await db.prepare(
      `SELECT 1 AS present
       FROM resend_sync_outbox
       WHERE resend_contact_id IS NOT NULL
          OR remote_state != 'none'
          OR state IN ('running', 'uncertain', 'remote_deleted')
       LIMIT 1`,
    ).first<{ present: number }>();
    if (remoteEvidence) return { status: "local_only_not_verified" };
  }

  const wasPending = current.status === "erasure_pending";
  await db.batch([
    db.prepare(
      `UPDATE newsletter_erasure_controls
       SET admission_state = 'paused',
           resend_mode = CASE WHEN ? = 'local_only' THEN 'local_only' ELSE 'resend' END,
           credential_fingerprint = CASE
             WHEN ? = 'local_only' THEN credential_fingerprint
             ELSE COALESCE(credential_fingerprint, ?)
           END,
           updated_at = datetime('now')
       WHERE id = 1`,
    ).bind(path, path, options.credentialFingerprint ?? null),
    db.prepare(
      `UPDATE newsletter_subscribers
       SET status = 'erasure_pending',
           confirmation_token_hash = CASE WHEN confirmation_admitted = 1 THEN confirmation_token_hash ELSE NULL END,
           confirmation_expires_at = CASE WHEN confirmation_admitted = 1 THEN confirmation_expires_at ELSE NULL END,
           confirmation_admission_id = CASE WHEN confirmation_admitted = 1 THEN confirmation_admission_id ELSE NULL END,
           last_confirmation_sent_at = CASE WHEN confirmation_admitted = 1 THEN last_confirmation_sent_at ELSE NULL END,
           updated_at = datetime('now')
       WHERE id = ?
         AND status != 'erasure_pending'`,
    ).bind(subscriberId),
    db.prepare(
      `INSERT INTO resend_sync_outbox (
         subscriber_id, operation, desired_active, revision, attempt_count,
         next_attempt_at, state, lease_token, lease_expires_at,
         claimed_operation, claimed_revision, resend_contact_id,
         resend_credential_fingerprint, erasure_path, remote_state,
         last_http_status, last_error_code, created_at, updated_at
       ) VALUES (?, 'erase', 0, 1, 0, datetime('now'), 'ready', NULL, NULL,
                 NULL, NULL, NULL, ?, ?, 'none', NULL, NULL, datetime('now'), datetime('now'))
       ON CONFLICT(subscriber_id) DO UPDATE SET
         operation = 'erase',
         desired_active = 0,
         revision = CASE
             WHEN resend_sync_outbox.operation = 'erase' THEN resend_sync_outbox.revision
             ELSE resend_sync_outbox.revision + 1
         END,
         next_attempt_at = datetime('now'),
         state = CASE
             WHEN resend_sync_outbox.state IN ('running', 'uncertain', 'remote_deleted') THEN resend_sync_outbox.state
             ELSE 'ready'
         END,
         lease_token = CASE
             WHEN resend_sync_outbox.state IN ('running', 'uncertain') THEN resend_sync_outbox.lease_token
             ELSE NULL
         END,
         lease_expires_at = CASE
             WHEN resend_sync_outbox.state IN ('running', 'uncertain') THEN resend_sync_outbox.lease_expires_at
             ELSE NULL
         END,
         claimed_operation = CASE
             WHEN resend_sync_outbox.state IN ('running', 'uncertain') THEN resend_sync_outbox.claimed_operation
             ELSE NULL
         END,
         claimed_revision = CASE
             WHEN resend_sync_outbox.state IN ('running', 'uncertain') THEN resend_sync_outbox.claimed_revision
             ELSE NULL
         END,
         resend_contact_id = resend_sync_outbox.resend_contact_id,
         resend_credential_fingerprint = CASE
             WHEN resend_sync_outbox.operation = 'erase' AND resend_sync_outbox.resend_credential_fingerprint IS NOT NULL
               THEN resend_sync_outbox.resend_credential_fingerprint
             ELSE excluded.resend_credential_fingerprint
         END,
         erasure_path = CASE
             WHEN resend_sync_outbox.operation = 'erase' AND resend_sync_outbox.state IN ('uncertain', 'remote_deleted')
               THEN resend_sync_outbox.erasure_path
             ELSE excluded.erasure_path
         END,
         remote_state = resend_sync_outbox.remote_state,
         last_http_status = resend_sync_outbox.last_http_status,
         last_error_code = resend_sync_outbox.last_error_code,
         updated_at = datetime('now')`,
    ).bind(subscriberId, options.credentialFingerprint ?? null, path),
  ]);

  return { status: wasPending ? "already_pending" : "requested" };
}

export async function previewNewsletterErasure(
  db: D1Database,
  subscriberId: number,
): Promise<ErasurePreview | null> {
  if (!Number.isSafeInteger(subscriberId) || subscriberId < 1) return null;
  return db.prepare(
    `SELECT
       s.id AS subscriber_id,
       s.status,
       (SELECT COUNT(*) FROM audit_events a WHERE a.subscriber_id = s.id) AS audit_row_count,
       CASE WHEN o.subscriber_id IS NULL THEN 0 ELSE 1 END AS outbox_row_count,
       o.operation AS outbox_operation,
       o.state AS outbox_state,
       o.remote_state,
       CASE WHEN o.resend_contact_id IS NULL THEN 0 ELSE 1 END AS contact_id_saved,
       o.erasure_path,
       CASE WHEN o.resend_credential_fingerprint IS NULL THEN 0 ELSE 1 END AS credential_bound
     FROM newsletter_subscribers s
     LEFT JOIN resend_sync_outbox o ON o.subscriber_id = s.id
     WHERE s.id = ?`,
  ).bind(subscriberId).first<{
    subscriber_id: number;
    status: SubscriberStatus;
    audit_row_count: number;
    outbox_row_count: number;
    outbox_operation: "sync" | "erase" | null;
    outbox_state: ErasurePreview["outbox_state"];
    remote_state: ErasurePreview["remote_state"];
    contact_id_saved: number;
    erasure_path: ErasurePath | null;
    credential_bound: number;
  }>().then((row) => row ? {
    ...row,
    contact_id_saved: row.contact_id_saved === 1,
    credential_bound: row.credential_bound === 1,
  } : null);
}

export async function rebindNewsletterErasure(
  db: D1Database,
  subscriberId: number,
  credentialFingerprint: string,
): Promise<ErasureRebindResult> {
  if (!credentialFingerprint) return "not_rebindable";
  const existing = await db.prepare(
    `SELECT state, operation FROM resend_sync_outbox
     WHERE subscriber_id = ? AND operation = 'erase'`,
  ).bind(subscriberId).first<{ state: string; operation: string }>();
  if (!existing) return "not_found";
  if (!['ready', 'uncertain'].includes(existing.state)) return "not_rebindable";
  const result = await db.batch([
    db.prepare(
      `UPDATE newsletter_erasure_controls
       SET resend_mode = 'resend', credential_fingerprint = ?,
           rebind_revision = rebind_revision + 1, updated_at = datetime('now')
       WHERE id = 1`,
    ).bind(credentialFingerprint),
    db.prepare(
      `UPDATE resend_sync_outbox
       SET resend_credential_fingerprint = ?, updated_at = datetime('now')
       WHERE subscriber_id = ? AND operation = 'erase' AND state IN ('ready', 'uncertain')`,
    ).bind(credentialFingerprint, subscriberId),
  ]);
  return result[1]?.success && (result[1].meta?.changes ?? 0) === 1 ? "rebound" : "not_rebindable";
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
         AND status NOT IN ('unsubscribed', 'erasure_pending')
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

  try {
    await bindings.NEWSLETTER_EMAIL.send({
      from: senderAddress,
      to,
      subject: "Confirm your newsletter subscription",
      text: textBody,
      html: htmlBody,
    });
    logNewsletterEvent("newsletter_confirmation_delivery", {
      operation: "confirmation",
      state: "accepted",
    });
  } catch (error) {
    logNewsletterEvent("newsletter_confirmation_delivery", {
      operation: "confirmation",
      state: "failed",
      error_class: newsletterErrorClass(error),
    });
    throw error;
  }
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
