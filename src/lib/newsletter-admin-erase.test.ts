import { mock, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const workerEnv: Record<string, unknown> = {
  NEWSLETTER_ADMIN_TOKEN: "admin-token",
};

mock.module("cloudflare:workers", () => ({ env: workerEnv }));

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

const migrations = [
  "0001_initial.sql",
  "0002_resend_outbox.sql",
  "0003_resend_quarantine.sql",
  "0004_newsletter_erasure.sql",
];

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

async function post(POST: (context: never) => Promise<Response>, body: Record<string, unknown>) {
  return POST({
    request: new Request("https://example.test/api/newsletter/admin/erase", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  } as never);
}

describe("newsletter erasure admin request paths", () => {
  test("accepts an explicitly approved local-only request", async () => {
    const db = await database();
    workerEnv.NEWSLETTER_DB = db;
    delete workerEnv.RESEND_API_KEY;
    const { POST } = await import("../pages/api/newsletter/admin/erase");

    const response = await post(POST, {
      subscriber_id: 1,
      mode: "local_only",
      approval: "ERASE_LOCAL_ONLY",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "requested" });
    expect(db.database.query("SELECT erasure_path FROM resend_sync_outbox WHERE subscriber_id = 1").get()).toMatchObject({
      erasure_path: "local_only",
    });
    db.close();
  });

  test("accepts an explicitly approved same-account rebind request", async () => {
    const db = await database();
    workerEnv.NEWSLETTER_DB = db;
    workerEnv.RESEND_API_KEY = "test-key";
    db.database.exec("UPDATE newsletter_subscribers SET status = 'erasure_pending' WHERE id = 1");
    const { POST } = await import("../pages/api/newsletter/admin/erase");

    const response = await post(POST, {
      subscriber_id: 1,
      mode: "rebind",
      approval: "REBIND_SAME_ACCOUNT",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "rebound" });
    expect(db.database.query("SELECT resend_credential_fingerprint FROM resend_sync_outbox WHERE subscriber_id = 1").get()).toMatchObject({
      resend_credential_fingerprint: expect.any(String),
    });
    db.close();
  });
});
