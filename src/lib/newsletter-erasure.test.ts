import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  confirmSubscriber,
  completeConfirmationAdmission,
  fingerprintCredential,
  previewNewsletterErasure,
  requestNewsletterErasure,
  subscribeAtomic,
  unsubscribeSubscriber,
} from "./newsletter";

const migrations = [
  "0001_initial.sql",
  "0002_resend_outbox.sql",
  "0003_resend_quarantine.sql",
  "0004_newsletter_erasure.sql",
];

class Statement {
  private parameters: unknown[] = [];

  constructor(private readonly database: Database, private readonly sql: string) {}

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

  async first<T>() {
    return (this.rows()[0] as T | undefined) ?? null;
  }
}

class FakeD1 {
  readonly database = new Database(":memory:");

  prepare(sql: string) {
    return new Statement(this.database, sql);
  }

  async batch(statements: Statement[]) {
    const transaction = this.database.transaction(() => statements.map((statement) => statement.runSync()));
    return transaction();
  }

  close() {
    this.database.close();
  }
}

async function database() {
  const db = new FakeD1();
  for (const migration of migrations) {
    db.database.exec(await Bun.file(`newsletter-migrations/${migration}`).text());
    if (migration === "0001_initial.sql") {
      db.database.exec(
        `INSERT INTO newsletter_subscribers (
           email, status, unsubscribe_token, consent_version
         ) VALUES ('subscriber@example.test', 'active', 'unsubscribe-token', '1.0')`,
      );
    }
  }
  db.database.exec(
    `UPDATE resend_sync_outbox
     SET state = 'ready', lease_token = NULL, lease_expires_at = NULL,
         claimed_operation = NULL, claimed_revision = NULL, next_attempt_at = datetime('now')
     WHERE subscriber_id = 1`,
  );
  return db;
}

describe("newsletter erasure request", () => {
  test("marks the subscriber pending, creates erase work, and is idempotent", async () => {
    const db = await database();
    const fingerprint = await fingerprintCredential("test-key");
    expect(await requestNewsletterErasure(db as unknown as D1Database, 1, { credentialFingerprint: fingerprint })).toEqual({ status: "requested" });
    expect(db.database.query("SELECT status FROM newsletter_subscribers WHERE id = 1").get()).toMatchObject({
      status: "erasure_pending",
    });
    expect(db.database.query("SELECT operation, state FROM resend_sync_outbox WHERE subscriber_id = 1").get()).toMatchObject({
      operation: "erase",
      state: "ready",
    });
    expect(await requestNewsletterErasure(db as unknown as D1Database, 1, { credentialFingerprint: fingerprint })).toEqual({ status: "already_pending" });
    expect(await subscribeAtomic(db as unknown as D1Database, "subscriber@example.test", "Changed", "1.0")).toMatchObject({
      shouldSend: false,
    });
    expect(await confirmSubscriber(db as unknown as D1Database, "unused-token-hash")).toBe(false);
    expect(await unsubscribeSubscriber(db as unknown as D1Database, "unsubscribe-token")).toBe(false);
    db.close();
  });

  test("returns an ID-only operator preview and does not expose the email or contact ID", async () => {
    const db = await database();
    const preview = await previewNewsletterErasure(db as unknown as D1Database, 1);
    expect(preview).toMatchObject({
      subscriber_id: 1,
      status: "active",
      outbox_row_count: 1,
      outbox_operation: "sync",
      contact_id_saved: false,
    });
    expect(preview).not.toHaveProperty("email");
    expect(preview).not.toHaveProperty("resend_contact_id");
    expect(await previewNewsletterErasure(db as unknown as D1Database, 999)).toBeNull();
    db.close();
  });

  test("pauses new admissions and drains an already-admitted confirmation before erasure", async () => {
    const db = await database();
    db.database.exec("UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE id = 1");
    const admitted = await subscribeAtomic(db as unknown as D1Database, "subscriber@example.test", "Changed", "1.0");
    expect(admitted.shouldSend).toBe(true);
    if (admitted.admissionId === undefined || admitted.subscriberId === undefined) throw new Error("expected an admission owner");
    expect(db.database.query("SELECT active_confirmation_sends FROM newsletter_erasure_controls").get()).toMatchObject({
      active_confirmation_sends: 1,
    });

    db.database.exec("UPDATE newsletter_subscribers SET last_confirmation_sent_at = datetime('now', '-16 minutes') WHERE id = 1");
    expect(await subscribeAtomic(db as unknown as D1Database, "subscriber@example.test", "Overwritten", "1.0")).toMatchObject({
      shouldSend: false,
    });
    expect(db.database.query("SELECT active_confirmation_sends FROM newsletter_erasure_controls").get()).toMatchObject({
      active_confirmation_sends: 1,
    });

    const fingerprint = await fingerprintCredential("test-key");
    expect(await requestNewsletterErasure(db as unknown as D1Database, 1, { credentialFingerprint: fingerprint })).toEqual({
      status: "requested",
    });
    expect(await subscribeAtomic(db as unknown as D1Database, "subscriber@example.test", "Blocked", "1.0")).toMatchObject({
      shouldSend: false,
    });

    if (admitted.subscriberId === undefined) {
      throw new Error("expected an admitted confirmation reservation");
    }
    await completeConfirmationAdmission(db as unknown as D1Database, admitted.subscriberId, admitted.admissionId);
    expect(db.database.query("SELECT active_confirmation_sends FROM newsletter_erasure_controls").get()).toMatchObject({
      active_confirmation_sends: 0,
    });
    db.close();
  });

  test("releases an admission after confirmation consumes its token", async () => {
    const db = await database();
    db.database.exec("UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE id = 1");
    const admitted = await subscribeAtomic(db as unknown as D1Database, "subscriber@example.test", "Confirmed", "1.0");
    if (admitted.admissionId === undefined || admitted.confirmationTokenHash === undefined || admitted.subscriberId === undefined) {
      throw new Error("expected an admitted confirmation reservation");
    }
    expect(await confirmSubscriber(db as unknown as D1Database, admitted.confirmationTokenHash)).toBe(true);
    expect(db.database.query("SELECT confirmation_token_hash, confirmation_admission_id, active_confirmation_sends FROM newsletter_subscribers JOIN newsletter_erasure_controls ON newsletter_erasure_controls.id = 1 WHERE newsletter_subscribers.id = 1").get()).toMatchObject({
      confirmation_token_hash: null,
      confirmation_admission_id: admitted.admissionId,
      active_confirmation_sends: 1,
    });
    await completeConfirmationAdmission(db as unknown as D1Database, admitted.subscriberId, admitted.admissionId);
    expect(db.database.query("SELECT confirmation_admission_id, confirmation_admitted FROM newsletter_subscribers WHERE id = 1").get()).toMatchObject({
      confirmation_admission_id: null,
      confirmation_admitted: 0,
    });
    expect(db.database.query("SELECT active_confirmation_sends FROM newsletter_erasure_controls").get()).toMatchObject({
      active_confirmation_sends: 0,
    });
    db.close();
  });

  test("requires an explicit local-only approval and rejects databases with remote evidence", async () => {
    const db = await database();
    expect(await requestNewsletterErasure(db as unknown as D1Database, 1, { path: "local_only" })).toEqual({
      status: "requested",
    });
    db.close();

    const remoteDb = await database();
    remoteDb.database.exec("UPDATE resend_sync_outbox SET resend_contact_id = 'contact-1' WHERE subscriber_id = 1");
    expect(await requestNewsletterErasure(remoteDb as unknown as D1Database, 1, { path: "local_only" })).toEqual({
      status: "local_only_not_verified",
    });
    remoteDb.close();
  });

  test("keeps foreign keys enabled after 0004 and cascades all identity rows", async () => {
    const db = await database();
    expect(db.database.query("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(() => db.database.exec("INSERT INTO audit_events (subscriber_id, event_type) VALUES (999, 'invalid')")).toThrow();
    db.database.exec("UPDATE newsletter_subscribers SET status = 'erasure_pending' WHERE id = 1");
    db.database.exec("UPDATE resend_sync_outbox SET state = 'remote_deleted', erasure_path = 'local_only', remote_state = 'local_only' WHERE subscriber_id = 1");
    db.database.exec("DELETE FROM newsletter_subscribers WHERE id = 1");
    expect(db.database.query("SELECT * FROM audit_events WHERE subscriber_id = 1").get()).toBeNull();
    expect(db.database.query("SELECT * FROM resend_sync_outbox WHERE subscriber_id = 1").get()).toBeNull();
    db.close();
  });
});
