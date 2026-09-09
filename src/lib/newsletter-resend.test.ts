import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { drainResendOutbox, recoverErasure } from "./newsletter-resend";
import { fingerprintCredential, requestNewsletterErasure } from "./newsletter";

const MIGRATIONS = [
  "0001_initial.sql",
  "0002_resend_outbox.sql",
  "0003_resend_quarantine.sql",
  "0004_newsletter_erasure.sql",
];
const originalFetch = globalThis.fetch;

class FakeStatement {
  private parameters: unknown[] = [];

  constructor(
    private readonly database: Database,
    private readonly sql: string,
  ) {}

  bind(...parameters: unknown[]) {
    this.parameters = parameters;
    return this;
  }

  private rows() {
    return this.database.query(this.sql).all(...(this.parameters as never[])) as Record<string, unknown>[];
  }

  runSync() {
    const results = this.rows();
    const changes = (this.database.query("SELECT changes() AS changes").get() as { changes: number }).changes;
    return { success: true, meta: { changes }, results };
  }

  async run() {
    return this.runSync();
  }

  async all<T>() {
    return { results: this.rows() as T[] };
  }

  async first<T>() {
    return (this.rows()[0] as T | undefined) ?? null;
  }
}

class FakeD1 {
  readonly database = new Database(":memory:");
  failNextBatch = false;

  prepare(sql: string) {
    return new FakeStatement(this.database, sql);
  }

  async batch(statements: FakeStatement[]) {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error("simulated batch failure");
    }
    let results: ReturnType<FakeStatement["runSync"]>[] = [];
    const transaction = this.database.transaction(() => {
      results = statements.map((statement) => statement.runSync());
    });
    transaction();
    return results;
  }

  exec(sql: string) {
    this.database.exec(sql);
  }

  close() {
    this.database.close();
  }
}

async function applyMigrations(database: FakeD1, migrations = MIGRATIONS) {
  for (const migration of migrations) {
    database.exec(await Bun.file(`newsletter-migrations/${migration}`).text());
  }
}

async function createDatabase(status = "active") {
  const database = new FakeD1();
  await applyMigrations(database, [MIGRATIONS[0]]);
  seedSubscriber(database, status);
  await applyMigrations(database, MIGRATIONS.slice(1));
  database.exec(
    `UPDATE resend_sync_outbox
     SET state = 'ready', lease_token = NULL, lease_expires_at = NULL,
         claimed_operation = NULL, claimed_revision = NULL, next_attempt_at = datetime('now')
     WHERE subscriber_id = 1`,
  );
  return database;
}

function seedSubscriber(database: FakeD1, status = "active") {
  database.exec(
    `INSERT INTO newsletter_subscribers (
       email, status, unsubscribe_token, consent_version
     ) VALUES ('subscriber@example.test', '${status}', 'unsubscribe-token', '1.0')`,
  );
}

function outbox(database: FakeD1, subscriberId = 1) {
  return database.database
    .query("SELECT * FROM resend_sync_outbox WHERE subscriber_id = ?")
    .get(subscriberId) as Record<string, unknown> | null;
}

function env(database: FakeD1) {
  return {
    NEWSLETTER_DB: database,
    RESEND_API_KEY: "test-key",
    RESEND_SEGMENT_ID: "segment-id",
  } as Record<string, unknown>;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Resend outbox quarantine protocol", () => {
  test("migrates old leases to uncertainty and preserves ownership across status changes", async () => {
    const database = new FakeD1();
    await applyMigrations(database, [MIGRATIONS[0]]);
    seedSubscriber(database);
    await applyMigrations(database, [MIGRATIONS[1]]);
    database.exec(
      "UPDATE resend_sync_outbox SET lease_token = 'old-owner', lease_expires_at = datetime('now', '+1 minute') WHERE subscriber_id = 1",
    );
    await applyMigrations(database, [MIGRATIONS[2]]);

    expect(outbox(database)).toMatchObject({
      state: "uncertain",
      lease_token: "old-owner",
      claimed_revision: 1,
    });

    database.exec("UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE id = 1");
    expect(outbox(database)).toMatchObject({
      state: "uncertain",
      desired_active: 0,
      revision: 2,
      lease_token: "old-owner",
      claimed_revision: 1,
    });
    database.close();
  });

  test("quarantines legacy rows even when they have no recorded lease", async () => {
    const database = new FakeD1();
    await applyMigrations(database, [MIGRATIONS[0]]);
    seedSubscriber(database);
    await applyMigrations(database, [MIGRATIONS[1]]);
    await applyMigrations(database, [MIGRATIONS[2]]);

    expect(outbox(database)).toMatchObject({
      state: "uncertain",
      lease_token: expect.any(String),
      lease_expires_at: expect.any(String),
      claimed_revision: 1,
    });
    database.close();
  });

  test("turns a stale definitive success into ready current work", async () => {
    const database = await createDatabase();
    let membershipCalls = 0;
    let mutationCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/segments")) {
        membershipCalls += 1;
        database.exec("UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE id = 1");
        return jsonResponse({ data: [] });
      }
      mutationCalls += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(outbox(database)).toMatchObject({
      state: "ready",
      desired_active: 0,
      revision: 2,
      lease_token: null,
      claimed_revision: null,
    });
    expect(membershipCalls).toBe(1);
    expect(mutationCalls).toBe(1);

    await drainResendOutbox(env(database));
    expect(outbox(database)).toBeNull();
    expect(membershipCalls).toBe(2);
    expect(mutationCalls).toBe(1);
    database.close();
  });

  test("releases a stale definitive failure without losing the newer revision", async () => {
    const database = await createDatabase();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/segments")) {
        database.exec("UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE id = 1");
        return jsonResponse({ data: [] });
      }
      return jsonResponse({ error: "rejected" }, 400);
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(outbox(database)).toMatchObject({
      state: "ready",
      desired_active: 0,
      revision: 2,
      attempt_count: 0,
      lease_token: null,
      claimed_revision: null,
      last_http_status: 400,
      last_error_code: "http_400",
    });
    expect(
      database.database
        .query("SELECT datetime(next_attempt_at) > datetime('now') AS delayed FROM resend_sync_outbox WHERE subscriber_id = 1")
        .get(),
    ).toMatchObject({ delayed: 0 });
    database.close();
  });

  test("increases retry backoff across repeated failures of one revision", async () => {
    const database = await createDatabase();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/segments")) return jsonResponse({ data: [] });
      return jsonResponse({ error: "rate_limited" }, 429);
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    const first = database.database
      .query("SELECT attempt_count, unixepoch(next_attempt_at) - unixepoch('now') AS delay FROM resend_sync_outbox WHERE subscriber_id = 1")
      .get() as { attempt_count: number; delay: number };
    expect(first.attempt_count).toBe(1);

    database.exec("UPDATE resend_sync_outbox SET next_attempt_at = datetime('now') WHERE subscriber_id = 1");
    await drainResendOutbox(env(database));
    const second = database.database
      .query("SELECT attempt_count, unixepoch(next_attempt_at) - unixepoch('now') AS delay FROM resend_sync_outbox WHERE subscriber_id = 1")
      .get() as { attempt_count: number; delay: number };
    expect(second.attempt_count).toBe(2);
    expect(second.delay).toBeGreaterThan(first.delay);
    database.close();
  });

  test("retries membership-read timeouts without quarantining work", async () => {
    const database = await createDatabase();
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("timeout");
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    const retryable = outbox(database);
    expect(retryable).toMatchObject({ state: "ready", last_error_code: "membership_network_error" });
    expect(retryable?.lease_token).toBeNull();
    expect(retryable?.claimed_revision).toBeNull();

    await drainResendOutbox(env(database));
    expect(fetchCalls).toBe(1);
    expect(outbox(database)).toMatchObject({ state: "ready" });
    database.close();
  });

  test("keeps malformed membership responses retryable", async () => {
    const database = await createDatabase();
    globalThis.fetch = (async () => jsonResponse({ data: [], has_more: true })) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(outbox(database)).toMatchObject({
      state: "ready",
      last_error_code: "invalid_membership_response",
    });
    database.close();
  });

  test("watchdogs overdue running work into uncertainty without releasing ownership", async () => {
    const database = await createDatabase();
    database.exec(
      `UPDATE resend_sync_outbox
       SET state = 'running', lease_token = 'crashed-owner', claimed_operation = 'sync',
           lease_expires_at = datetime('now', '-1 second'), claimed_revision = revision
       WHERE subscriber_id = 1`,
    );
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(fetchCalls).toBe(0);
    expect(outbox(database)).toMatchObject({
      state: "uncertain",
      lease_token: "crashed-owner",
      claimed_revision: 1,
      last_error_code: "lease_expired",
    });
    database.close();
  });

  test("allows only one of two overlapping drains to request the remote", async () => {
    const database = await createDatabase();
    const requestStarted = deferred<void>();
    const releaseRequest = deferred<void>();
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      requestStarted.resolve();
      await releaseRequest.promise;
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    const first = drainResendOutbox(env(database));
    await requestStarted.promise;
    const second = drainResendOutbox(env(database));
    await second;
    expect(fetchCalls).toBe(1);
    releaseRequest.resolve();
    await first;
    expect(outbox(database)).toBeNull();
    database.close();
  });

  test("finishes a delayed add before allowing the newer revision to delete", async () => {
    const database = await createDatabase();
    const addStarted = deferred<void>();
    const releaseAdd = deferred<void>();
    let remoteMember = false;
    let requests = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;
      const url = String(input);
      if (url.endsWith("/segments")) return jsonResponse({ data: remoteMember ? [{ id: "segment-id" }] : [] });
      if (init?.method === "POST") {
        addStarted.resolve();
        await releaseAdd.promise;
        remoteMember = true;
        return new Response(null, { status: 204 });
      }
      remoteMember = false;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const first = drainResendOutbox(env(database));
    await addStarted.promise;
    database.exec("UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE id = 1");
    await drainResendOutbox(env(database));
    expect(requests).toBe(2);
    releaseAdd.resolve();
    await first;
    expect(outbox(database)).toMatchObject({ state: "ready", desired_active: 0, revision: 2 });

    await drainResendOutbox(env(database));
    expect(remoteMember).toBe(false);
    expect(outbox(database)).toBeNull();
    database.close();
  });

  test("keeps a timed-out mutation quarantined after delayed remote application", async () => {
    const database = await createDatabase();
    let fetchCalls = 0;
    let remoteApplied = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      if (String(input).endsWith("/segments")) return jsonResponse({ data: [] });
      if (init?.method === "POST") {
        setTimeout(() => {
          remoteApplied = true;
        }, 10);
        throw new Error("request timeout");
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(outbox(database)).toMatchObject({ state: "uncertain", last_error_code: "network_error" });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(remoteApplied).toBe(true);
    database.exec("UPDATE resend_sync_outbox SET lease_expires_at = datetime('now', '-1 second') WHERE subscriber_id = 1");
    await drainResendOutbox(env(database));
    expect(fetchCalls).toBe(2);
    expect(outbox(database)).toMatchObject({ state: "uncertain" });
    database.close();
  });

  test("does not accept a late completion after watchdog quarantine", async () => {
    const database = await createDatabase();
    const mutationStarted = deferred<void>();
    const releaseMutation = deferred<void>();
    let fetchCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls += 1;
      if (String(input).endsWith("/segments")) return jsonResponse({ data: [] });
      mutationStarted.resolve();
      await releaseMutation.promise;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const first = drainResendOutbox(env(database));
    await mutationStarted.promise;
    database.exec("UPDATE resend_sync_outbox SET lease_expires_at = datetime('now', '-1 second') WHERE subscriber_id = 1");
    await drainResendOutbox(env(database));
    expect(outbox(database)).toMatchObject({ state: "uncertain" });
    expect(fetchCalls).toBe(2);
    releaseMutation.resolve();
    await first;
    expect(outbox(database)).toMatchObject({ state: "uncertain" });
    database.close();
  });

  test("quarantines work when the completion batch fails", async () => {
    const database = await createDatabase();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/segments")) return jsonResponse({ data: [] });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    database.failNextBatch = true;

    await drainResendOutbox(env(database));
    expect(outbox(database)).toMatchObject({ state: "uncertain", last_error_code: "sync_error" });
    expect(outbox(database)?.lease_token).toEqual(expect.any(String));
    database.close();
  });

  test("preserves diagnostics and same-revision attempt history across claims", async () => {
    const database = await createDatabase();
    database.exec(
      `UPDATE resend_sync_outbox
       SET state = 'running', lease_token = 'diagnostic-owner', claimed_operation = 'sync',
           lease_expires_at = datetime('now', '+1 minute'), claimed_revision = revision,
           attempt_count = 4, last_http_status = 503, last_error_code = 'old-error'
       WHERE subscriber_id = 1`,
    );
    database.exec("UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE id = 1");
    expect(outbox(database)).toMatchObject({
      state: "running",
      attempt_count: 4,
      last_http_status: 503,
      last_error_code: "old-error",
    });
    database.exec("UPDATE resend_sync_outbox SET state = 'uncertain' WHERE subscriber_id = 1");
    database.exec("UPDATE newsletter_subscribers SET status = 'pending' WHERE id = 1");
    expect(outbox(database)).toMatchObject({
      state: "uncertain",
      attempt_count: 4,
      last_http_status: 503,
      last_error_code: "old-error",
    });
    database.exec(
      `UPDATE resend_sync_outbox
       SET state = 'ready', lease_token = NULL, lease_expires_at = NULL, claimed_operation = NULL, claimed_revision = NULL,
           next_attempt_at = datetime('now')
       WHERE subscriber_id = 1`,
    );
    globalThis.fetch = (async () => {
      expect(outbox(database)).toMatchObject({ attempt_count: 4, last_http_status: null, last_error_code: null });
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;
    await drainResendOutbox(env(database));
    database.close();
  });

  test("resets attempts when a new ready revision is created", async () => {
    const database = await createDatabase();
    database.exec(
      `UPDATE resend_sync_outbox
       SET attempt_count = 4, last_http_status = 503, last_error_code = 'old-error'
       WHERE subscriber_id = 1`,
    );
    database.exec("UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE id = 1");
    expect(outbox(database)).toMatchObject({
      state: "ready",
      revision: 2,
      attempt_count: 0,
    });
    database.close();
  });
});

describe("newsletter erasure protocol", () => {
  async function prepareErasureDatabase() {
    const database = await createDatabase();
    database.exec("UPDATE newsletter_subscribers SET status = 'erasure_pending' WHERE id = 1");
    const fingerprint = await fingerprintCredential("test-key");
    database.exec(`UPDATE resend_sync_outbox SET resend_credential_fingerprint = '${fingerprint}' WHERE subscriber_id = 1`);
    database.exec("UPDATE newsletter_erasure_controls SET resend_mode = 'resend', credential_fingerprint = 'bound' WHERE id = 1");
    database.exec(
      `UPDATE resend_sync_outbox
       SET state = 'ready', lease_token = NULL, lease_expires_at = NULL,
           claimed_operation = NULL, claimed_revision = NULL, next_attempt_at = datetime('now')
       WHERE subscriber_id = 1`,
    );
    return database;
  }

  test("resolves by email, persists the immutable ID, deletes by ID, verifies absence, then finalizes locally", async () => {
    const database = await prepareErasureDatabase();
    const requests: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ method: init?.method ?? "GET", url });
      if (init?.method === "DELETE") {
        return jsonResponse({ object: "contact", contact: "contact-1", deleted: true });
      }
      if (url.endsWith("/contacts/contact-1")) return jsonResponse({ statusCode: 404, message: "Contact not found" }, 404);
      return jsonResponse({ object: "contact", id: "contact-1", email: "subscriber@example.test" });
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(requests).toEqual([
      { method: "GET", url: "https://api.resend.com/contacts/subscriber%40example.test" },
      { method: "DELETE", url: "https://api.resend.com/contacts/contact-1" },
      { method: "GET", url: "https://api.resend.com/contacts/contact-1" },
    ]);
    expect(outbox(database)).toBeNull();
    expect(database.database.query("SELECT * FROM newsletter_subscribers WHERE id = 1").get()).toBeNull();
    expect(database.database.query("SELECT completed_count FROM newsletter_erasure_metrics WHERE id = 1").get()).toMatchObject({
      completed_count: 1,
    });
    expect(database.database.query("SELECT admission_state FROM newsletter_erasure_controls WHERE id = 1").get()).toMatchObject({
      admission_state: "open",
    });
    await drainResendOutbox(env(database));
    expect(outbox(database)).toBeNull();
    database.close();
  });

  test("quarantines deletion timeouts with the contact ID retained", async () => {
    const database = await prepareErasureDatabase();
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const url = String(input);
      if (init?.method === "DELETE") throw new Error("timeout after send");
      if (url.endsWith("/contacts/contact-1")) return jsonResponse({ object: "contact", id: "contact-1", email: "subscriber@example.test" });
      return jsonResponse({ object: "contact", id: "contact-1", email: "subscriber@example.test" });
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(calls).toBe(2);
    expect(outbox(database)).toMatchObject({
      operation: "erase",
      state: "uncertain",
      resend_contact_id: "contact-1",
      last_error_code: "network_error",
    });
    expect(database.database.query("SELECT status FROM newsletter_subscribers WHERE id = 1").get()).toMatchObject({
      status: "erasure_pending",
    });
    database.close();
  });

  test("quarantines malformed DELETE responses after the mutation may have been submitted", async () => {
    const database = await prepareErasureDatabase();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/contacts/contact-1")) return jsonResponse({ object: "contact", id: "contact-1", email: "subscriber@example.test" });
      return jsonResponse({ object: "contact", id: "contact-1", email: "subscriber@example.test" });
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(outbox(database)).toMatchObject({
      state: "uncertain",
      resend_contact_id: "contact-1",
      last_error_code: "invalid_contact_delete",
    });
    expect(database.database.query("SELECT id FROM newsletter_subscribers WHERE id = 1").get()).toMatchObject({ id: 1 });
    database.close();
  });

  test("quarantines malformed verification 404 responses after DELETE", async () => {
    const database = await prepareErasureDatabase();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return jsonResponse({ object: "contact", contact: "contact-1", deleted: true });
      if (url.endsWith("/contacts/contact-1")) {
        return new Response("{", { status: 404, headers: { "content-type": "application/json" } });
      }
      return jsonResponse({ object: "contact", id: "contact-1", email: "subscriber@example.test" });
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(outbox(database)).toMatchObject({
      state: "uncertain",
      resend_contact_id: "contact-1",
      last_error_code: "invalid_contact_not_found",
    });
    expect(database.database.query("SELECT id FROM newsletter_subscribers WHERE id = 1").get()).toMatchObject({ id: 1 });
    database.close();
  });

  test("retries a lookup read failure without recording a contact ID or mutating Resend", async () => {
    const database = await prepareErasureDatabase();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("lookup timeout");
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(calls).toBe(1);
    expect(outbox(database)).toMatchObject({
      operation: "erase",
      state: "ready",
      resend_contact_id: null,
      last_error_code: "network_error",
    });
    database.close();
  });

  test("accepts a delete 404 only after an independent confirmed-absence lookup", async () => {
    const database = await prepareErasureDatabase();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return jsonResponse({ statusCode: 404, message: "Contact not found" }, 404);
      if (url.endsWith("/contacts/contact-1")) return jsonResponse({ statusCode: 404, message: "Contact not found" }, 404);
      return jsonResponse({ object: "contact", id: "contact-1", email: "subscriber@example.test" });
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(outbox(database)).toBeNull();
    expect(database.database.query("SELECT * FROM newsletter_subscribers WHERE id = 1").get()).toBeNull();
    database.close();
  });

  test("retries an erase with the saved contact ID without resolving by email again", async () => {
    const database = await prepareErasureDatabase();
    database.exec("UPDATE resend_sync_outbox SET resend_contact_id = 'contact-existing' WHERE subscriber_id = 1");
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "DELETE") return jsonResponse({ object: "contact", id: "contact-existing", deleted: true });
      return jsonResponse({ statusCode: 404, message: "Contact not found" }, 404);
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(requests).toEqual([
      "DELETE https://api.resend.com/contacts/contact-existing",
      "GET https://api.resend.com/contacts/contact-existing",
    ]);
    expect(outbox(database)).toBeNull();
    expect(database.database.query("SELECT * FROM newsletter_subscribers WHERE id = 1").get()).toBeNull();
    database.close();
  });

  test("keeps the checkpoint when local finalization fails and never replays Resend", async () => {
    const database = await prepareErasureDatabase();
    let requests = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;
      const url = String(input);
      if (init?.method === "DELETE") return jsonResponse({ object: "contact", id: "contact-1", deleted: true });
      if (url.endsWith("/contacts/contact-1")) return jsonResponse({ statusCode: 404, message: "Contact not found" }, 404);
      return jsonResponse({ object: "contact", id: "contact-1", email: "subscriber@example.test" });
    }) as unknown as typeof fetch;
    database.failNextBatch = true;

    await drainResendOutbox(env(database));
    expect(requests).toBe(3);
    expect(outbox(database)).toMatchObject({ state: "remote_deleted", remote_state: "remote_deleted" });
    expect(database.database.query("SELECT id FROM newsletter_subscribers WHERE id = 1").get()).toMatchObject({ id: 1 });

    await Promise.all([drainResendOutbox(env(database)), drainResendOutbox(env(database))]);
    expect(requests).toBe(3);
    expect(outbox(database)).toBeNull();
    expect(database.database.query("SELECT completed_count FROM newsletter_erasure_metrics WHERE id = 1").get()).toMatchObject({ completed_count: 1 });
    database.close();
  });

  test("fails closed before any request when the approved credential changes", async () => {
    const database = await prepareErasureDatabase();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ object: "contact", id: "wrong", email: "subscriber@example.test" });
    }) as unknown as typeof fetch;

    await drainResendOutbox({ ...env(database), RESEND_API_KEY: "wrong-account-key" });
    expect(calls).toBe(0);
    expect(outbox(database)).toMatchObject({ state: "uncertain", last_error_code: "credential_mismatch" });
    expect(database.database.query("SELECT id FROM newsletter_subscribers WHERE id = 1").get()).toMatchObject({ id: 1 });
    database.close();
  });

  test("recovery releases all ownership fields only with the exact erase binding", async () => {
    const database = await prepareErasureDatabase();
    const fingerprint = await fingerprintCredential("test-key");
    database.exec(
      `UPDATE resend_sync_outbox
       SET state = 'uncertain', lease_token = 'erase-owner',
           lease_expires_at = datetime('now', '+1 minute'), claimed_operation = 'erase',
           claimed_revision = revision, resend_contact_id = NULL
       WHERE subscriber_id = 1`,
    );
    expect(await recoverErasure(database as unknown as D1Database, {
      subscriberId: 1,
      ownerToken: "wrong-owner",
      claimedRevision: 2,
      contactId: null,
      credentialFingerprint: fingerprint,
      disposition: "lookup_retry",
    })).toBe(false);
    expect(await recoverErasure(database as unknown as D1Database, {
      subscriberId: 1,
      ownerToken: "erase-owner",
      claimedRevision: 2,
      contactId: null,
      credentialFingerprint: fingerprint,
      disposition: "lookup_retry",
    })).toBe(true);
    expect(outbox(database)).toMatchObject({
      state: "ready",
      lease_token: null,
      lease_expires_at: null,
      claimed_operation: null,
      claimed_revision: null,
    });
    database.close();
  });

  test("completes a verified initial contact absence without issuing DELETE", async () => {
    const database = await prepareErasureDatabase();
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonResponse({ statusCode: 404, message: "Contact not found" }, 404);
    }) as unknown as typeof fetch;

    await drainResendOutbox(env(database));
    expect(requests).toEqual(["GET https://api.resend.com/contacts/subscriber%40example.test"]);
    expect(outbox(database)).toBeNull();
    expect(database.database.query("SELECT * FROM newsletter_subscribers WHERE id = 1").get()).toBeNull();
    database.close();
  });

  test("finalizes an explicitly approved local-only job without Resend configuration", async () => {
    const database = await createDatabase();
    const result = await requestNewsletterErasure(database as unknown as D1Database, 1, { path: "local_only" });
    expect(result).toEqual({ status: "requested" });
    database.exec("UPDATE resend_sync_outbox SET next_attempt_at = datetime('now') WHERE subscriber_id = 1");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ object: "contact", id: "unexpected" });
    }) as unknown as typeof fetch;

    await drainResendOutbox({ NEWSLETTER_DB: database });
    expect(calls).toBe(0);
    expect(database.database.query("SELECT * FROM newsletter_subscribers WHERE id = 1").get()).toBeNull();
    expect(outbox(database)).toBeNull();
    database.close();
  });

  test("quarantines generic, HTML, and redirect 404 responses", async () => {
    for (const response of [
      new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } }),
      jsonResponse({ error: "not found" }, 404),
      new Response("", { status: 302, headers: { location: "https://other.example/contacts" } }),
    ]) {
      const database = await prepareErasureDatabase();
      globalThis.fetch = (async () => response.clone()) as unknown as typeof fetch;
      await drainResendOutbox(env(database));
      expect(outbox(database)).toMatchObject({ state: "uncertain", last_error_code: expect.any(String) });
      expect(database.database.query("SELECT id FROM newsletter_subscribers WHERE id = 1").get()).toMatchObject({ id: 1 });
      database.close();
    }
  });
});
