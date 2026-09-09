import { fingerprintCredential } from "./newsletter";
import { logNewsletterEvent, newsletterErrorClass } from "./newsletter-observability";

const RESEND_API_URL = "https://api.resend.com";
const BATCH_SIZE = 10;
const REQUEST_TIMEOUT_MS = 10_000;
const LEASE_SECONDS = 120;

interface ResendConfig {
  apiKey: string;
  segmentId: string;
  credentialFingerprint: string;
}

type OutboxState = "ready" | "running" | "uncertain" | "remote_deleted";
type OutboxOperation = "sync" | "erase";
type FailureDisposition = "definitive" | "retryable" | "uncertain";

interface OutboxRow {
  subscriber_id: number;
  operation: OutboxOperation;
  desired_active: number;
  revision: number;
  attempt_count: number;
  state: OutboxState;
  lease_token: string | null;
  lease_expires_at: string | null;
  claimed_operation: OutboxOperation | null;
  claimed_revision: number | null;
  resend_contact_id: string | null;
  resend_credential_fingerprint: string | null;
  erasure_path: "resend" | "local_only";
  remote_state: "none" | "remote_deleted" | "initial_absent" | "local_only";
  last_http_status?: number | null;
  last_error_code?: string | null;
}

interface SubscriberRow {
  id: number;
  email: string;
  name: string | null;
  status: "pending" | "active" | "unsubscribed" | "erasure_pending";
}

class ResendRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly disposition: FailureDisposition,
  ) {
    super(code);
  }
}

class ErasureRemoteError extends Error {
  constructor(
    readonly code: string,
    readonly retryableBeforeMutation: boolean,
  ) {
    super(code);
  }
}

class ErasureCredentialError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type ErasureRecoveryDisposition = "lookup_retry" | "delete_retry" | "remote_deleted";

export async function recoverErasure(
  db: D1Database,
  input: {
    subscriberId: number;
    ownerToken: string;
    claimedRevision: number;
    contactId: string | null;
    credentialFingerprint: string;
    disposition: ErasureRecoveryDisposition;
  },
): Promise<boolean> {
  const state = input.disposition === "remote_deleted" ? "remote_deleted" : "ready";
  const remoteState = input.disposition === "remote_deleted" ? "remote_deleted" : "none";
  const contactCondition = input.disposition === "lookup_retry"
    ? "resend_contact_id IS NULL"
    : "resend_contact_id = ?";
  const parameters = input.disposition === "lookup_retry"
    ? [state, remoteState, input.subscriberId, input.ownerToken, input.claimedRevision, input.credentialFingerprint]
    : [state, remoteState, input.subscriberId, input.ownerToken, input.claimedRevision, input.credentialFingerprint, input.contactId];
  const result = await db.prepare(
    `UPDATE resend_sync_outbox
     SET state = ?,
         remote_state = ?,
         lease_token = NULL,
         lease_expires_at = NULL,
         claimed_operation = NULL,
         claimed_revision = NULL,
         next_attempt_at = datetime('now'),
         last_error_code = NULL,
         updated_at = datetime('now')
     WHERE subscriber_id = ?
       AND operation = 'erase'
       AND state = 'uncertain'
       AND lease_token = ?
       AND claimed_operation = 'erase'
       AND claimed_revision = ?
       AND resend_credential_fingerprint = ?
       AND remote_state = 'none'
       AND ${contactCondition}`,
  ).bind(...parameters).run();
  if ((result.meta?.changes ?? 0) === 1) await resumeAdmissionsIfSafe(db);
  return result.success === true && (result.meta?.changes ?? 0) === 1;
}

async function getResendConfig(env: Record<string, unknown>): Promise<ResendConfig | null> {
  const apiKey = env.RESEND_API_KEY;
  const segmentId = env.RESEND_SEGMENT_ID;
  if (typeof apiKey !== "string" || typeof segmentId !== "string" || !apiKey || !segmentId) {
    return null;
  }
  return { apiKey, segmentId, credentialFingerprint: await fingerprintCredential(apiKey) };
}

function leaseToken(): string {
  return crypto.randomUUID();
}

function backoffSeconds(attemptCount: number, status: number) {
  if ([400, 401, 403, 405, 422].includes(status)) return 86_400;
  return Math.min(86_400, 60 * 2 ** Math.min(attemptCount, 10));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAmbiguousHttpStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

async function resendRequest(
  config: ResendConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${RESEND_API_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ResendRequestError(0, "network_error", "uncertain");
  }

  if (!response.ok) {
    throw new ResendRequestError(
      response.status,
      `http_${response.status}`,
      isAmbiguousHttpStatus(response.status) ? "uncertain" : "definitive",
    );
  }
  return response;
}

async function resendRawRequest(
  config: ResendConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${RESEND_API_URL}${path}`;
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    if (response.status >= 300 && response.status < 400 || response.type === "opaqueredirect") {
      throw new ErasureRemoteError("redirect_response", false);
    }
    if (response.url && response.url !== url) {
      throw new ErasureRemoteError("unexpected_response_origin", false);
    }
    return response;
  } catch (error) {
    if (error instanceof ErasureRemoteError) throw error;
    throw new ErasureRemoteError("network_error", true);
  }
}

async function responseJson(response: Response, code: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/problem+json") {
    throw new ErasureRemoteError(code, false);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ErasureRemoteError(code, true);
  }
  if (!isRecord(body)) throw new ErasureRemoteError(code, true);
  return body;
}

async function isExpectedContactNotFound(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  const body = await responseJson(response, "invalid_contact_not_found");
  return body.statusCode === 404 && body.message === "Contact not found";
}

async function isExpectedContactNotFoundAfterDelete(response: Response): Promise<boolean> {
  try {
    return await isExpectedContactNotFound(response);
  } catch (error) {
    const code = error instanceof ErasureRemoteError ? error.code : "invalid_contact_not_found";
    throw new ErasureRemoteError(code, false);
  }
}

function isRetryableReadStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function resolveResendContact(
  config: ResendConfig,
  email: string,
): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const response = await resendRawRequest(config, `/contacts/${encodeURIComponent(normalizedEmail)}`);
  if (!response.ok) {
    if (await isExpectedContactNotFound(response)) return "";
    if (isRetryableReadStatus(response.status)) {
      throw new ErasureRemoteError(`contact_lookup_http_${response.status}`, true);
    }
    throw new ErasureRemoteError(`contact_lookup_http_${response.status}`, false);
  }

  const body = await responseJson(response, "invalid_contact_lookup");
  const bodyEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const id = typeof body.id === "string" ? body.id : "";
  if (body.object !== "contact" || !id || bodyEmail !== normalizedEmail) {
    throw new ErasureRemoteError("invalid_contact_lookup", false);
  }
  return id;
}

async function deleteAndVerifyResendContact(config: ResendConfig, contactId: string): Promise<void> {
  let deleted: Response;
  try {
    deleted = await resendRawRequest(config, `/contacts/${encodeURIComponent(contactId)}`, {
      method: "DELETE",
    });
  } catch {
    throw new ErasureRemoteError("network_error", false);
  }
  if (deleted.ok) {
    let body: Record<string, unknown>;
    try {
      body = await responseJson(deleted, "invalid_contact_delete");
    } catch {
      throw new ErasureRemoteError("invalid_contact_delete", false);
    }
    const returnedId = typeof body.contact === "string" ? body.contact : typeof body.id === "string" ? body.id : "";
    if (body.object !== "contact" || returnedId !== contactId || body.deleted !== true) {
      throw new ErasureRemoteError("invalid_contact_delete", false);
    }
  } else if (deleted.status === 404) {
    if (!(await isExpectedContactNotFoundAfterDelete(deleted))) {
      throw new ErasureRemoteError("invalid_contact_not_found", false);
    }
  } else {
    throw new ErasureRemoteError(`contact_delete_http_${deleted.status}`, false);
  }

  let verified: Response;
  try {
    verified = await resendRawRequest(config, `/contacts/${encodeURIComponent(contactId)}`);
  } catch {
    throw new ErasureRemoteError("network_error", false);
  }
  if (verified.status === 404) {
    if (await isExpectedContactNotFoundAfterDelete(verified)) return;
    throw new ErasureRemoteError("invalid_contact_not_found", false);
  }
  if (!verified.ok) throw new ErasureRemoteError(`contact_verify_http_${verified.status}`, false);
  throw new ErasureRemoteError("contact_still_present", false);
}

async function listSegmentIds(config: ResendConfig, email: string): Promise<string[] | null> {
  try {
    const response = await resendRequest(config, `/contacts/${encodeURIComponent(email)}/segments`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ResendRequestError(0, "invalid_membership_response", "retryable");
    }

    if (!isRecord(body) || !Array.isArray(body.data) || body.has_more === true) {
      throw new ResendRequestError(0, "invalid_membership_response", "retryable");
    }

    const ids: string[] = [];
    for (const segment of body.data) {
      if (!isRecord(segment) || typeof segment.id !== "string" || segment.id.length === 0) {
        throw new ResendRequestError(0, "invalid_membership_response", "retryable");
      }
      ids.push(segment.id);
    }
    return ids;
  } catch (error) {
    if (error instanceof ResendRequestError && error.status === 404) return null;
    if (error instanceof ResendRequestError) {
      if (error.code === "invalid_membership_response") throw error;
      throw new ResendRequestError(error.status, `membership_${error.code}`, "retryable");
    }
    throw new ResendRequestError(0, "membership_read_error", "retryable");
  }
}

async function syncContact(config: ResendConfig, subscriber: SubscriberRow, desiredActive: boolean) {
  const segments = await listSegmentIds(config, subscriber.email);
  const contactPath = `/contacts/${encodeURIComponent(subscriber.email)}/segments/${encodeURIComponent(config.segmentId)}`;

  if (desiredActive) {
    if (segments === null) {
      await resendRequest(config, "/contacts", {
        method: "POST",
        body: JSON.stringify({
          email: subscriber.email,
          ...(subscriber.name ? { first_name: subscriber.name } : {}),
          segments: [{ id: config.segmentId }],
        }),
      });
      return;
    }
    if (!segments.includes(config.segmentId)) {
      await resendRequest(config, contactPath, { method: "POST" });
    }
    return;
  }

  if (segments?.includes(config.segmentId)) {
    try {
      await resendRequest(config, contactPath, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof ResendRequestError && error.status === 404)) throw error;
    }
  }
}

async function quarantineExpiredLeases(db: D1Database): Promise<void> {
  const result = await db.prepare(
    `UPDATE resend_sync_outbox
     SET state = 'uncertain',
         last_error_code = 'lease_expired',
         updated_at = datetime('now')
     WHERE state = 'running'
       AND (lease_expires_at IS NULL OR datetime(lease_expires_at) <= datetime('now'))`,
  ).run();
  if ((result.meta?.changes ?? 0) > 0) {
    logNewsletterEvent("newsletter_outbox_quarantine", {
      operation: "outbox",
      state: "uncertain",
      error_class: "lease",
    });
  }
}

async function claimRow(db: D1Database, candidate: OutboxRow, token: string): Promise<OutboxRow | null> {
  const result = await db.prepare(
    `UPDATE resend_sync_outbox
     SET state = 'running',
         lease_token = ?,
         lease_expires_at = datetime('now', '+${LEASE_SECONDS} seconds'),
         claimed_operation = operation,
         claimed_revision = revision,
         last_http_status = NULL,
         last_error_code = NULL,
         updated_at = datetime('now')
     WHERE subscriber_id = ?
       AND revision = ?
       AND state = 'ready'
       AND lease_token IS NULL
       AND lease_expires_at IS NULL
       AND claimed_revision IS NULL
       AND next_attempt_at <= datetime('now')
     RETURNING subscriber_id, operation, desired_active, revision, attempt_count,
               state, lease_token, lease_expires_at, claimed_operation,
               claimed_revision, resend_contact_id, resend_credential_fingerprint,
               erasure_path, remote_state, last_http_status, last_error_code`,
  ).bind(token, candidate.subscriber_id, candidate.revision).run();
  return (result.results as unknown as OutboxRow[] | undefined)?.[0] ?? null;
}

async function completeRow(db: D1Database, row: OutboxRow, token: string): Promise<void> {
  const claimedRevision = row.claimed_revision ?? row.revision;
  await db.batch([
    db.prepare(
      `UPDATE resend_sync_outbox
       SET state = 'ready',
           attempt_count = 0,
           lease_token = NULL,
           lease_expires_at = NULL,
           claimed_operation = NULL,
           claimed_revision = NULL,
           next_attempt_at = datetime('now'),
           updated_at = datetime('now')
       WHERE subscriber_id = ?
         AND state = 'running'
         AND lease_token = ?
         AND claimed_operation = 'sync'
         AND claimed_revision = ?
         AND revision != ?`,
    ).bind(row.subscriber_id, token, claimedRevision, claimedRevision),
    db.prepare(
      `DELETE FROM resend_sync_outbox
       WHERE subscriber_id = ?
         AND state = 'running'
         AND lease_token = ?
         AND claimed_operation = 'sync'
         AND claimed_revision = ?
         AND revision = ?`,
    ).bind(row.subscriber_id, token, claimedRevision, claimedRevision),
  ]);
}

async function releaseDefinitiveFailure(
  db: D1Database,
  row: OutboxRow,
  token: string,
  error: ResendRequestError,
): Promise<void> {
  const claimedRevision = row.claimed_revision ?? row.revision;
  const delay = backoffSeconds(row.attempt_count + 1, error.status);
  const result = await db.prepare(
    `UPDATE resend_sync_outbox
     SET state = 'ready',
         attempt_count = CASE WHEN revision = claimed_revision THEN attempt_count + 1 ELSE 0 END,
         next_attempt_at = CASE
             WHEN revision = claimed_revision THEN datetime('now', ?)
             ELSE datetime('now')
         END,
         lease_token = NULL,
         lease_expires_at = NULL,
         claimed_operation = NULL,
         claimed_revision = NULL,
         last_http_status = ?,
         last_error_code = ?,
         updated_at = datetime('now')
     WHERE subscriber_id = ?
       AND state = 'running'
       AND lease_token = ?
       AND claimed_operation = 'sync'
       AND claimed_revision = ?`,
  ).bind(
    `+${delay} seconds`,
    error.status || null,
    error.code,
    row.subscriber_id,
    token,
    claimedRevision,
  ).run();
  if ((result.meta?.changes ?? 0) === 1) {
    logNewsletterEvent("newsletter_outbox_retry", {
      operation: row.operation,
      revision: claimedRevision,
      state: "ready",
      error_class: newsletterErrorClass(error),
    });
  }
}

async function markUncertain(
  db: D1Database,
  row: OutboxRow,
  token: string,
  error: ResendRequestError,
): Promise<void> {
  const claimedRevision = row.claimed_revision ?? row.revision;
  const result = await db.prepare(
    `UPDATE resend_sync_outbox
     SET state = 'uncertain',
         attempt_count = attempt_count + CASE WHEN revision = claimed_revision THEN 1 ELSE 0 END,
         last_http_status = ?,
         last_error_code = ?,
         updated_at = datetime('now')
     WHERE subscriber_id = ?
       AND state = 'running'
       AND lease_token = ?
       AND claimed_revision = ?`,
  ).bind(
    error.status || null,
    error.code,
    row.subscriber_id,
    token,
    claimedRevision,
  ).run();
  if ((result.meta?.changes ?? 0) === 1) {
    logNewsletterEvent("newsletter_outbox_quarantine", {
      operation: row.operation,
      revision: claimedRevision,
      state: "uncertain",
      error_class: newsletterErrorClass(error),
    });
  }
}

async function persistErasureContactId(
  db: D1Database,
  row: OutboxRow,
  token: string,
  contactId: string,
): Promise<string> {
  const claimedRevision = row.claimed_revision ?? row.revision;
  const result = await db.prepare(
    `UPDATE resend_sync_outbox
     SET resend_contact_id = COALESCE(resend_contact_id, ?),
         updated_at = datetime('now')
     WHERE subscriber_id = ?
       AND state = 'running'
       AND lease_token = ?
       AND claimed_operation = 'erase'
       AND claimed_revision = ?
       AND operation = 'erase'
     RETURNING resend_contact_id`,
  ).bind(contactId, row.subscriber_id, token, claimedRevision).run();
  const savedId = (result.results as Array<{ resend_contact_id?: unknown }> | undefined)?.[0]?.resend_contact_id;
  if (!result.success || (result.meta?.changes ?? 0) !== 1 || typeof savedId !== "string" || !savedId) {
    throw new ErasureRemoteError("checkpoint_persist_failed", false);
  }
  return savedId;
}

async function assertErasureCredential(row: OutboxRow, config: ResendConfig): Promise<void> {
  if (row.erasure_path === "local_only") return;
  if (!row.resend_credential_fingerprint) throw new ErasureCredentialError("credential_required");
  if (row.resend_credential_fingerprint !== config.credentialFingerprint) {
    throw new ErasureCredentialError("credential_mismatch");
  }
}

async function resumeAdmissionsIfSafe(db: D1Database): Promise<void> {
  await db.prepare(
    `UPDATE newsletter_erasure_controls
     SET admission_state = 'open', updated_at = datetime('now')
     WHERE id = 1
       AND admission_state = 'paused'
       AND active_confirmation_sends = 0
       AND NOT EXISTS (
         SELECT 1 FROM resend_sync_outbox
         WHERE operation = 'erase' AND state IN ('ready', 'running', 'remote_deleted')
       )`,
  ).run();
}

async function markErasureRetryable(
  db: D1Database,
  row: OutboxRow,
  token: string,
  error: ErasureRemoteError,
): Promise<void> {
  const claimedRevision = row.claimed_revision ?? row.revision;
  const result = await db.prepare(
    `UPDATE resend_sync_outbox
     SET state = 'ready',
         attempt_count = attempt_count + 1,
         next_attempt_at = datetime('now', '+5 minutes'),
         lease_token = NULL,
         lease_expires_at = NULL,
         claimed_operation = NULL,
         claimed_revision = NULL,
         last_error_code = ?,
         updated_at = datetime('now')
     WHERE subscriber_id = ?
       AND state = 'running'
       AND lease_token = ?
       AND claimed_operation = 'erase'
       AND claimed_revision = ?`,
  ).bind(error.code, row.subscriber_id, token, claimedRevision).run();
  if ((result.meta?.changes ?? 0) === 1) {
    logNewsletterEvent("newsletter_outbox_retry", {
      operation: "erase",
      revision: claimedRevision,
      state: "ready",
      error_class: newsletterErrorClass(error),
    });
  }
}

async function markErasureUncertain(
  db: D1Database,
  row: OutboxRow,
  token: string,
  error: ErasureRemoteError,
): Promise<void> {
  const claimedRevision = row.claimed_revision ?? row.revision;
  const result = await db.prepare(
    `UPDATE resend_sync_outbox
     SET state = CASE WHEN remote_state = 'remote_deleted' THEN 'remote_deleted' ELSE 'uncertain' END,
         attempt_count = attempt_count + 1,
         last_error_code = ?,
         updated_at = datetime('now')
     WHERE subscriber_id = ?
       AND state = 'running'
       AND lease_token = ?
       AND claimed_operation = 'erase'
       AND claimed_revision = ?`,
  ).bind(error.code, row.subscriber_id, token, claimedRevision).run();
  if ((result.meta?.changes ?? 0) === 1) {
    logNewsletterEvent("newsletter_outbox_quarantine", {
      operation: "erase",
      revision: claimedRevision,
      state: row.remote_state === "remote_deleted" ? "remote_deleted" : "uncertain",
      error_class: newsletterErrorClass(error),
    });
  }
  await resumeAdmissionsIfSafe(db);
}

async function markErasureCheckpoint(
  db: D1Database,
  row: OutboxRow,
  token: string,
  remoteState: "remote_deleted" | "initial_absent" | "local_only",
): Promise<void> {
  const claimedRevision = row.claimed_revision ?? row.revision;
  const result = await db.prepare(
    `UPDATE resend_sync_outbox
     SET state = 'remote_deleted',
         remote_state = ?,
         lease_token = NULL,
         lease_expires_at = NULL,
         claimed_operation = NULL,
         claimed_revision = NULL,
         last_error_code = NULL,
         updated_at = datetime('now')
     WHERE subscriber_id = ?
       AND state = 'running'
       AND lease_token = ?
       AND claimed_operation = 'erase'
       AND claimed_revision = ?
       AND operation = 'erase'
       AND (resend_credential_fingerprint = ? OR erasure_path = 'local_only')`,
  ).bind(remoteState, row.subscriber_id, token, claimedRevision, row.resend_credential_fingerprint).run();
  if (!result.success || (result.meta?.changes ?? 0) !== 1) {
    throw new ErasureRemoteError("checkpoint_persist_failed", false);
  }
}

async function markErasureRemoteDeleted(
  db: D1Database,
  row: OutboxRow,
  token: string,
): Promise<void> {
  await markErasureCheckpoint(db, row, token, "remote_deleted");
}

async function finalizeErasure(db: D1Database, subscriberId: number, revision: number): Promise<void> {
  try {
    await db.prepare("PRAGMA foreign_keys = ON").run();
    const result = await db.batch([
      db.prepare(
        `DELETE FROM newsletter_subscribers
         WHERE id = ?
           AND status = 'erasure_pending'
           AND EXISTS (
             SELECT 1 FROM resend_sync_outbox
             WHERE subscriber_id = ?
               AND operation = 'erase'
               AND state = 'remote_deleted'
               AND remote_state IN ('remote_deleted', 'initial_absent', 'local_only')
           )`,
      ).bind(subscriberId, subscriberId),
      db.prepare(
        `UPDATE newsletter_erasure_metrics
         SET completed_count = completed_count + 1,
             last_completed_at = datetime('now')
         WHERE id = 1
           AND changes() > 0`,
      ),
    ]);
    if (!result[0]?.success || (result[0].meta?.changes ?? 0) !== 1 || !result[1]?.success) {
      throw new Error("local_erasure_failed");
    }
    await resumeAdmissionsIfSafe(db);
    logNewsletterEvent("newsletter_outbox_finalization", {
      operation: "erase",
      revision,
      state: "completed",
    });
  } catch (error) {
    logNewsletterEvent("newsletter_outbox_finalization", {
      operation: "erase",
      revision,
      state: "failed",
      error_class: newsletterErrorClass(error),
    });
    throw error;
  }
}

async function eraseContact(
  config: ResendConfig | null,
  db: D1Database,
  row: OutboxRow,
  subscriber: SubscriberRow,
  token: string,
): Promise<void> {
  const admissions = await db
    .prepare("SELECT active_confirmation_sends FROM newsletter_erasure_controls WHERE id = 1")
    .first<{ active_confirmation_sends: number }>();
  if ((admissions?.active_confirmation_sends ?? 0) > 0) {
    throw new ErasureRemoteError("confirmation_admissions_active", true);
  }
  if (row.erasure_path === "local_only") {
    await markErasureCheckpoint(db, row, token, "local_only");
    await finalizeErasure(db, row.subscriber_id, row.revision);
    return;
  }
  if (!config) throw new ErasureCredentialError("credential_required");
  await assertErasureCredential(row, config);
  const resolvedId = row.resend_contact_id ?? await resolveResendContact(config, subscriber.email);
  if (!resolvedId) {
    await markErasureCheckpoint(db, row, token, "initial_absent");
    await finalizeErasure(db, row.subscriber_id, row.revision);
    return;
  }
  const contactId = row.resend_contact_id ?? await persistErasureContactId(db, row, token, resolvedId);
  await deleteAndVerifyResendContact(config, contactId);
  await markErasureRemoteDeleted(db, row, token);
  await finalizeErasure(db, row.subscriber_id, row.revision);
}

async function finalizeReadyErasureRows(db: D1Database): Promise<void> {
  const rows = await db.prepare(
    `SELECT subscriber_id, revision
     FROM resend_sync_outbox
     WHERE operation = 'erase'
       AND state = 'remote_deleted'
       AND remote_state IN ('remote_deleted', 'initial_absent', 'local_only')
     LIMIT ?`,
  ).bind(BATCH_SIZE).all<{ subscriber_id: number; revision: number }>();
  for (const row of rows.results ?? []) {
    try {
      await finalizeErasure(db, row.subscriber_id, row.revision);
    } catch {
      // finalizeErasure emits the sanitized failure event; continue the bounded batch.
    }
  }
}

/** Drain a bounded batch of coalesced D1 outbox rows. */
export async function drainResendOutbox(env: Record<string, unknown>): Promise<void> {
  const config = await getResendConfig(env);
  const db = env.NEWSLETTER_DB;
  if (typeof db !== "object" || db === null) return;

  const newsletterDb = db as D1Database;
  await quarantineExpiredLeases(newsletterDb);
  await finalizeReadyErasureRows(newsletterDb);
  const candidates = await newsletterDb.prepare(
    `SELECT subscriber_id, operation, desired_active, revision, attempt_count,
            state, lease_token, lease_expires_at, claimed_operation,
            claimed_revision, resend_contact_id, resend_credential_fingerprint,
            erasure_path, remote_state,
            last_http_status, last_error_code
     FROM resend_sync_outbox
     WHERE state = 'ready'
       AND (? = 1 OR operation = 'erase')
       AND lease_token IS NULL
       AND lease_expires_at IS NULL
       AND claimed_revision IS NULL
       AND (
         operation = 'sync'
         OR erasure_path = 'local_only'
         OR NOT EXISTS (
           SELECT 1 FROM newsletter_erasure_controls
           WHERE id = 1 AND active_confirmation_sends > 0
         )
       )
       AND next_attempt_at <= datetime('now')
     ORDER BY next_attempt_at ASC
     LIMIT ?`,
  ).bind(config ? 1 : 0, BATCH_SIZE).all<OutboxRow>();

  for (const candidate of candidates.results ?? []) {
    const token = leaseToken();
    const row = await claimRow(newsletterDb, candidate, token);
    if (!row) continue;

    try {
      const subscriber = await newsletterDb.prepare(
        "SELECT id, email, name, status FROM newsletter_subscribers WHERE id = ?",
      ).bind(row.subscriber_id).first<SubscriberRow>();
      if (!subscriber) {
        if (row.operation === "sync") await completeRow(newsletterDb, row, token);
        else await markErasureUncertain(newsletterDb, row, token, new ErasureRemoteError("subscriber_missing", false));
        continue;
      }

      if (row.operation === "erase") {
        if (subscriber.status !== "erasure_pending") {
          throw new ErasureRemoteError("erasure_status_changed", false);
        }
        await eraseContact(config, newsletterDb, row, subscriber, token);
      } else {
        if (subscriber.status !== "erasure_pending") {
          if (!config) throw new ResendRequestError(0, "config_missing", "retryable");
          await syncContact(config, subscriber, row.desired_active === 1);
        }
        await completeRow(newsletterDb, row, token);
      }
    } catch (error) {
      if (row.operation === "erase") {
        const erasureError = error instanceof ErasureRemoteError
          ? error
          : error instanceof ErasureCredentialError
            ? new ErasureRemoteError(error.code, false)
          : new ErasureRemoteError("erase_error", false);
        if (erasureError.retryableBeforeMutation) {
          await markErasureRetryable(newsletterDb, row, token, erasureError);
        } else {
          await markErasureUncertain(newsletterDb, row, token, erasureError);
        }
      } else {
        const resendError = error instanceof ResendRequestError
          ? error
          : new ResendRequestError(0, "sync_error", "uncertain");
        if (resendError.disposition === "uncertain") {
          await markUncertain(newsletterDb, row, token, resendError);
        } else {
          await releaseDefinitiveFailure(newsletterDb, row, token, resendError);
        }
      }
    }
  }
}
