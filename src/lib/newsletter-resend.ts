const RESEND_API_URL = "https://api.resend.com";
const BATCH_SIZE = 10;
const REQUEST_TIMEOUT_MS = 10_000;

interface ResendConfig {
  apiKey: string;
  segmentId: string;
}

interface OutboxRow {
  subscriber_id: number;
  desired_active: number;
  revision: number;
  attempt_count: number;
}

interface SubscriberRow {
  id: number;
  email: string;
  name: string | null;
}

class ResendRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function getResendConfig(env: Record<string, unknown>): ResendConfig | null {
  const apiKey = env.RESEND_API_KEY;
  const segmentId = env.RESEND_SEGMENT_ID;
  if (typeof apiKey !== "string" || typeof segmentId !== "string" || !apiKey || !segmentId) {
    return null;
  }
  return { apiKey, segmentId };
}

function leaseToken(): string {
  return crypto.randomUUID();
}

function backoffSeconds(attemptCount: number, status: number) {
  if ([400, 401, 403, 405, 422].includes(status)) return 86_400;
  return Math.min(86_400, 60 * 2 ** Math.min(attemptCount, 10));
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
    throw new ResendRequestError(0, "network_error");
  }

  if (!response.ok) {
    throw new ResendRequestError(response.status, `http_${response.status}`);
  }
  return response;
}

async function listSegmentIds(config: ResendConfig, email: string): Promise<string[] | null> {
  try {
    const response = await resendRequest(config, `/contacts/${encodeURIComponent(email)}/segments`);
    const body = await response.json() as { data?: Array<{ id?: string }> };
    return (body.data ?? []).flatMap((segment) => typeof segment.id === "string" ? [segment.id] : []);
  } catch (error) {
    if (error instanceof ResendRequestError && error.status === 404) return null;
    throw error;
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
    await resendRequest(config, contactPath, { method: "DELETE" });
  }
}

async function claimRow(db: D1Database, candidate: OutboxRow, token: string): Promise<OutboxRow | null> {
  const result = await db.prepare(
    `UPDATE resend_sync_outbox
     SET lease_token = ?, lease_expires_at = datetime('now', '+2 minutes'), updated_at = datetime('now')
     WHERE subscriber_id = ?
       AND revision = ?
       AND next_attempt_at <= datetime('now')
       AND (lease_expires_at IS NULL OR lease_expires_at < datetime('now'))
     RETURNING subscriber_id, desired_active, revision, attempt_count`,
  ).bind(token, candidate.subscriber_id, candidate.revision).run();
  return (result.results as unknown as OutboxRow[] | undefined)?.[0] ?? null;
}

async function completeRow(db: D1Database, row: OutboxRow, token: string) {
  await db.prepare(
    "DELETE FROM resend_sync_outbox WHERE subscriber_id = ? AND revision = ? AND lease_token = ?",
  ).bind(row.subscriber_id, row.revision, token).run();
}

async function failRow(db: D1Database, row: OutboxRow, token: string, error: ResendRequestError) {
  const delay = backoffSeconds(row.attempt_count + 1, error.status);
  await db.prepare(
    `UPDATE resend_sync_outbox
     SET attempt_count = attempt_count + 1,
         next_attempt_at = datetime('now', ?),
         lease_token = NULL,
         lease_expires_at = NULL,
         last_http_status = ?,
         last_error_code = ?,
         updated_at = datetime('now')
     WHERE subscriber_id = ? AND revision = ? AND lease_token = ?`,
  ).bind(`+${delay} seconds`, error.status || null, error.code, row.subscriber_id, row.revision, token).run();
}

/** Drain a bounded batch of coalesced D1 outbox rows. */
export async function drainResendOutbox(env: Record<string, unknown>): Promise<void> {
  const config = getResendConfig(env);
  const db = env.NEWSLETTER_DB;
  if (!config || typeof db !== "object" || db === null) return;

  const newsletterDb = db as D1Database;
  const candidates = await newsletterDb.prepare(
    `SELECT subscriber_id, desired_active, revision, attempt_count
     FROM resend_sync_outbox
     WHERE next_attempt_at <= datetime('now')
       AND (lease_expires_at IS NULL OR lease_expires_at < datetime('now'))
     ORDER BY next_attempt_at ASC
     LIMIT ?`,
  ).bind(BATCH_SIZE).all<OutboxRow>();

  for (const candidate of candidates.results ?? []) {
    const token = leaseToken();
    const row = await claimRow(newsletterDb, candidate, token);
    if (!row) continue;

    try {
      const subscriber = await newsletterDb.prepare(
        "SELECT id, email, name FROM newsletter_subscribers WHERE id = ?",
      ).bind(row.subscriber_id).first<SubscriberRow>();
      if (!subscriber) {
        await completeRow(newsletterDb, row, token);
        continue;
      }
      await syncContact(config, subscriber, row.desired_active === 1);
      await completeRow(newsletterDb, row, token);
    } catch (error) {
      const resendError = error instanceof ResendRequestError
        ? error
        : new ResendRequestError(0, "sync_error");
      console.error(`[newsletter-resend] sync failed for subscriber ${row.subscriber_id}: ${resendError.code}`);
      await failRow(newsletterDb, row, token, resendError);
    }
  }
}
