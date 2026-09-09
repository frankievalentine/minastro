import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface as createLineInterface } from "node:readline";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import {
  createProvisioningJournal,
  defaultProvisioningFileSystem,
  journalIsNonSecret,
  parseJsonc,
  parseProvisioningJournal,
  provisioningJournalPath,
  provisioningLockPath,
  reconcileWranglerConfig,
  resolveUniqueResource,
  serializeProvisioningJournal,
  type ProvisioningFileSystem,
  type ProvisioningJournal,
} from "./setup-cloudflare-lib";
import { promptSecretDetached, runProvisioning, type SetupRuntime } from "./setup-cloudflare";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ROOT = "/fake-project";
const WORKER = "example";
const MIGRATIONS = ["0001_newsletter.sql", "0002_resend_outbox.sql", "0003_resend_quarantine.sql", "0004_newsletter_erasure.sql"];

const actualWranglerConfig = await readFile(join(import.meta.dir, "..", "wrangler.jsonc"), "utf8");
const actualSiteConfig = await readFile(join(import.meta.dir, "..", "src/site.config.ts"), "utf8");

class MemoryFileSystem implements ProvisioningFileSystem {
  readonly files = new Map<string, string>();
  readonly directories = new Map<string, string[]>();
  readonly locks = new Set<string>();
  atomicWrites = 0;

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  async list(path: string) {
    return this.directories.get(path) ?? [];
  }

  async writeAtomic(path: string, contents: string) {
    this.atomicWrites += 1;
    this.files.set(path, contents);
  }

  async acquireExclusive(path: string) {
    if (this.locks.has(path)) throw new Error("lock already held");
    this.locks.add(path);
    return async () => {
      this.locks.delete(path);
    };
  }
}

interface FakeOptions {
  config?: string;
  site?: string;
  coreConfigured?: boolean;
  newsletterConfigured?: boolean;
  resendConfigured?: boolean;
  databaseEstablished?: boolean;
  failD1Create?: boolean;
  failVersionUpload?: number;
  failDeployment?: number;
  migrationApplyResponseLoss?: boolean;
  canonicalAttachment?: "correct" | "missing" | "wrong";
  r2Pagination?: boolean;
  failTriggers?: number;
  originMode?: "setup" | "ok" | "cross-origin" | "wrong-path" | "loop" | "bad-status";
}

class FakeRuntime implements SetupRuntime {
  readonly fs = new MemoryFileSystem();
  readonly apiToken = "test-token";
  readonly approvedAccountId = ACCOUNT;
  readonly commands: string[][] = [];
  readonly interactiveCommands: string[][] = [];
  readonly apiUrls: string[] = [];
  readonly originUrls: string[] = [];
  readonly prompts: string[] = [];
  readonly secretPrompts: string[] = [];
  handoffCount = 0;
  readonly resources = {
    d1: [] as Array<{ uuid: string; name: string }>,
    r2: [] as Array<{ name: string }>,
    kv: [] as Array<{ id: string; title: string }>,
  };
  readonly secrets = new Set<string>();
  readonly migrations = new Set<string>();
  readonly versions: Array<{ id: string; tag: string; createdOn: string; secrets: Set<string> }> = [];
  readonly deployments: Array<{ id: string; createdOn: string; versionId: string }> = [];
  workerDeployed = false;
  version = 0;
  activeVersionId: string | undefined;
  canonicalAttachment: "correct" | "missing" | "wrong";
  r2Pagination: boolean;
  failTriggers: number;
  originMode: NonNullable<FakeOptions["originMode"]>;
  triggersDeployed = false;
  failD1Create: boolean;
  failVersionUpload: number;
  failDeployment: number;
  migrationApplyResponseLoss: boolean;
  databaseEstablished: boolean;
  private generatedKey = "generated-encryption-key";
  private answers: string[];
  private secretAnswers: string[];

  constructor(options: FakeOptions = {}) {
    this.failD1Create = options.failD1Create ?? false;
    this.failVersionUpload = options.failVersionUpload ?? 0;
    this.failDeployment = options.failDeployment ?? 0;
    this.migrationApplyResponseLoss = options.migrationApplyResponseLoss ?? false;
    this.databaseEstablished = options.databaseEstablished ?? false;
    this.canonicalAttachment = options.canonicalAttachment ?? "correct";
    this.r2Pagination = options.r2Pagination ?? false;
    this.failTriggers = options.failTriggers ?? 0;
    this.originMode = options.originMode ?? (this.databaseEstablished ? "ok" : "setup");
    let config = options.config ?? actualWranglerConfig;
    let site = options.site ?? actualSiteConfig;
    if (options.coreConfigured && !options.config) {
      const configured = JSON.parse(config) as {
        name: string;
        account_id?: string;
        d1_databases: Array<Record<string, unknown>>;
        r2_buckets: Array<Record<string, unknown>>;
        kv_namespaces: Array<Record<string, unknown>>;
        send_email?: Array<Record<string, unknown>>;
        ratelimits?: Array<Record<string, unknown>>;
        vars?: Record<string, unknown>;
      };
      configured.name = WORKER;
      configured.account_id = ACCOUNT;
      configured.d1_databases[0] = { binding: "DB", database_name: "example-db", database_id: "core-d1-id" };
      configured.r2_buckets[0] = { binding: "MEDIA", bucket_name: "example-media" };
      configured.kv_namespaces[0] = { binding: "SESSION", id: "session-kv-id" };
      if (options.newsletterConfigured) {
        configured.d1_databases.push({ binding: "NEWSLETTER_DB", database_name: "example-newsletter", database_id: "newsletter-d1-id", migrations_dir: "newsletter-migrations" });
        configured.send_email = [{ name: "NEWSLETTER_EMAIL", remote: true, allowed_sender_addresses: ["newsletter@example.test"] }];
        configured.ratelimits = [{ name: "NEWSLETTER_SUBSCRIBE_LIMITER", namespace_id: 9, simple: { limit: 5, period: 60 } }];
        if (options.resendConfigured) configured.vars = { RESEND_SEGMENT_ID: "segment-id" };
      }
      config = JSON.stringify(configured);
    }
    if (options.coreConfigured && !options.site) site = site.replace('url: "http://localhost:8787"', 'url: "https://example.test"');
    if (options.newsletterConfigured && !options.site) {
      site = site.replace("enabled: false", "enabled: true").replace('senderAddress: "newsletter@your-domain.com"', 'senderAddress: "newsletter@example.test"').replace('expectedHostname: "your-domain.com"', 'expectedHostname: "example.test"').replace('turnstileSiteKey: ""', 'turnstileSiteKey: "site-key"');
    }
    this.fs.files.set(join(ROOT, "wrangler.jsonc"), config);
    this.fs.files.set(join(ROOT, "src/site.config.ts"), site);
    this.fs.files.set(join(ROOT, "src/lib/bootstrap-protection.ts"), "export function protectFirstAdminBootstrap() {}\n");
    this.fs.directories.set(join(ROOT, "newsletter-migrations"), MIGRATIONS);
    this.answers = [];
    this.secretAnswers = [];
    if (options.coreConfigured) {
      this.resources.d1.push({ uuid: "core-d1-id", name: "example-db" });
      this.resources.r2.push({ name: "example-media" });
      this.resources.kv.push({ id: "session-kv-id", title: "example-sessions" });
      this.workerDeployed = true;
      this.version = 1;
      this.activeVersionId = "version-1";
      this.versions.push({ id: "version-1", tag: "existing", createdOn: "2026-01-01T00:00:01Z", secrets: new Set(this.secrets) });
      this.deployments.push({ id: "deployment-1", createdOn: "2026-01-01T00:00:02Z", versionId: "version-1" });
      this.secrets.add("EMDASH_ENCRYPTION_KEY");
    }
    if (options.newsletterConfigured) {
      this.resources.d1.push({ uuid: "newsletter-d1-id", name: "example-newsletter" });
      this.secrets.add("TURNSTILE_SECRET_KEY");
      this.secrets.add("NEWSLETTER_ADMIN_TOKEN");
    }
    if (options.resendConfigured) {
      this.secrets.add("RESEND_API_KEY");
      this.migrations.add("0001_newsletter.sql");
      this.migrations.add("0002_resend_outbox.sql");
    }
    if (this.versions.length > 0) this.versions[0].secrets = new Set(this.secrets);
  }

  answer(...values: string[]) {
    this.answers.push(...values);
    return this;
  }

  replaceAnswers(...values: string[]) {
    this.answers = values;
    return this;
  }

  removeSecret(name: string) {
    this.secrets.delete(name);
    for (const version of this.versions) version.secrets.delete(name);
    return this;
  }

  secretAnswer(...values: string[]) {
    this.secretAnswers.push(...values);
    return this;
  }

  async prompt() {
    return this.answers.shift() ?? "y";
  }

  async promptSecret() {
    return this.secretAnswers.shift() ?? "saved-secret";
  }

  async copySecret() {
    return true;
  }

  async clearClipboard() {}

  async handoff() {
    this.handoffCount += 1;
    return { opened: true, copied: false };
  }

  async apiFetch(url: string) {
    this.apiUrls.push(url);
    if (url.includes("/r2/buckets")) {
      if (this.r2Pagination && !url.includes("cursor=next")) return Response.json({ success: true, result: { buckets: this.resources.r2.slice(0, 1), truncated: true, cursor: "next" } });
      return Response.json({ success: true, result: { buckets: this.r2Pagination ? [...this.resources.r2.slice(1), { name: "other-media" }] : this.resources.r2, truncated: false } });
    }
    if (url.includes("/storage/kv/namespaces")) return Response.json({ success: true, result: this.resources.kv });
    if (url.includes("/workers/domains")) {
      const service = this.canonicalAttachment === "wrong" ? "another-worker" : WORKER;
      return Response.json({ success: true, result: this.canonicalAttachment === "missing" ? [] : [{ hostname: "example.test", service, status: "active" }] });
    }
    return Response.json({ success: true, result: { id: ACCOUNT } });
  }

  async originFetch(url: string) {
    this.originUrls.push(url);
    if (this.originMode === "ok") return new Response("ok", { status: 200 });
    if (this.originMode === "bad-status") return new Response("failure", { status: 503 });
    const location = this.originMode === "cross-origin"
      ? "https://other.example/_emdash/admin/setup"
      : this.originMode === "wrong-path"
        ? "https://example.test/not-setup"
        : this.originMode === "loop"
          ? "https://example.test/"
          : "https://example.test/_emdash/admin/setup?bootstrap=fixture";
    return new Response(null, { status: 302, headers: { Location: location } });
  }

  async run(command: string[], _options: { input?: string } = {}) {
    this.commands.push(command);
    if (command.includes("d1") && command.includes("list") && !command.includes("migrations")) return JSON.stringify(this.resources.d1);
    if (command.includes("d1") && command.includes("execute")) {
      const sql = command[command.indexOf("--command") + 1] ?? "";
      if (sql.includes("sqlite_master")) return JSON.stringify([{ results: [...(this.databaseEstablished ? [{ name: "options" }, { name: "users" }] : []), ...(this.migrations.size > 0 ? [{ name: "d1_migrations" }] : [])] }]);
      if (sql.includes("emdash:setup_complete")) return JSON.stringify([{ results: this.databaseEstablished ? [{ value: "true" }] : [] }]);
      if (sql.includes("FROM users")) return JSON.stringify([{ results: this.databaseEstablished ? [{ present: 1 }] : [] }]);
      if (sql.includes("FROM d1_migrations")) return JSON.stringify([{ results: [...this.migrations].map((name) => ({ name })) }]);
    }
    if (command.includes("d1") && command.includes("migrations") && command.includes("list")) {
      return JSON.stringify({ pending: MIGRATIONS.filter((name) => !this.migrations.has(name)).map((name) => ({ name })) });
    }
    if (command.includes("migrations") && command.includes("apply")) {
      for (const migration of MIGRATIONS) this.migrations.add(migration);
      if (this.migrationApplyResponseLoss) throw new Error("simulated response loss");
      return "";
    }
    if (command.includes("versions") && command.includes("secret") && command.includes("put")) {
      const name = command[command.indexOf("put") + 1];
      this.secrets.add(name);
      const tag = command[command.indexOf("--tag") + 1];
      const previous = this.versions.at(-1);
      this.version += 1;
      const id = `version-${this.version}`;
      this.versions.push({ id, tag, createdOn: `2026-01-01T00:00:${String(this.version).padStart(2, "0")}Z`, secrets: new Set([...(previous?.secrets ?? []), name]) });
      return "";
    }
    if (command.includes("secret") && command.includes("list")) return JSON.stringify([...this.secrets].map((name) => ({ name })));
    if (command.includes("secret") && command.includes("put")) {
      const name = command[command.indexOf("put") + 1];
      this.secrets.add(name);
      return "";
    }
    if (command.includes("emdash") && command.includes("generate")) return this.generatedKey;
    if (command.includes("d1") && command.includes("create")) {
      if (this.failD1Create) throw new Error("simulated D1 create failure");
      const name = command[command.indexOf("create") + 1];
      this.resources.d1.push({ uuid: `${name}-id`, name });
      return "";
    }
    if (command.includes("r2") && command.includes("create")) {
      const name = command[command.indexOf("create") + 1];
      this.resources.r2.push({ name });
      return "";
    }
    if (command.includes("kv") && command.includes("create")) {
      const title = command[command.indexOf("create") + 1];
      this.resources.kv.push({ id: `${title}-id`, title });
      return "";
    }
    if (command.includes("versions") && command.includes("list")) return JSON.stringify(this.versions.map((entry) => ({ id: entry.id, metadata: { created_on: entry.createdOn }, annotations: { "workers/tag": entry.tag } })));
    if (command.includes("versions") && command.includes("view")) {
      const id = command[command.indexOf("view") + 1];
      const version = this.versions.find((entry) => entry.id === id);
      const core = this.resources.d1.find((entry) => entry.name === "example-db")?.uuid ?? "core-d1-id";
      const media = this.resources.r2.find((entry) => entry.name === "example-media")?.name ?? "example-media";
      const session = this.resources.kv.find((entry) => entry.title === "example-sessions")?.id ?? "session-kv-id";
      const newsletter = this.resources.d1.find((entry) => entry.name === "example-newsletter")?.uuid ?? "newsletter-d1-id";
      return JSON.stringify({ metadata: { created_on: version?.createdOn }, resources: { bindings: [
        { name: "DB", type: "d1", database_id: core },
        { name: "MEDIA", type: "r2_bucket", bucket_name: media },
        { name: "SESSION", type: "kv_namespace", namespace_id: session },
        ...(this.resources.d1.some((entry) => entry.name === "example-newsletter") ? [{ name: "NEWSLETTER_DB", type: "d1", database_id: newsletter }, { name: "NEWSLETTER_EMAIL", type: "send_email" }, { name: "NEWSLETTER_SUBSCRIBE_LIMITER", type: "ratelimit" }] : []),
        ...(version ? [...version.secrets].map((name) => ({ name, type: "secret_text" })) : []),
      ] } });
    }
    if (command.includes("deployments") && command.includes("list")) return JSON.stringify(this.deployments.slice().reverse().map((entry) => ({ id: entry.id, metadata: { created_on: entry.createdOn }, versions: [{ version_id: entry.versionId, percentage: 100 }] })));
    return "";
  }

  async runInteractive(command: string[]) {
    this.interactiveCommands.push(command);
    if (command.includes("triggers") && command.includes("deploy")) {
      if (this.failTriggers > 0) {
        this.failTriggers -= 1;
        throw new Error("simulated trigger deployment failure");
      }
      this.triggersDeployed = true;
      return;
    }
    if (command.includes("deploy")) {
      if (this.failDeployment > 0) {
        this.failDeployment -= 1;
        throw new Error("simulated deployment failure");
      }
      const versionSpec = command.find((value) => value.includes("@100"));
      this.activeVersionId = versionSpec?.split("@")[0];
      this.workerDeployed = true;
      this.deployments.push({ id: `deployment-${this.deployments.length + 1}`, createdOn: `2026-01-01T00:01:${String(this.deployments.length + 1).padStart(2, "0")}Z`, versionId: this.activeVersionId ?? "" });
      return;
    }
    if (command.includes("versions") && command.includes("upload")) {
      const tag = command[command.indexOf("--tag") + 1];
      const previous = this.versions.at(-1);
      this.version += 1;
      this.versions.push({ id: `version-${this.version}`, tag, createdOn: `2026-01-01T00:00:${String(this.version).padStart(2, "0")}Z`, secrets: new Set(previous?.secrets ?? []) });
      if (this.failVersionUpload > 0) {
        this.failVersionUpload -= 1;
        throw new Error("simulated version upload response loss");
      }
    }
  }
}

function expectFailure(action: () => Promise<unknown>, message: string) {
  return action().then(() => {
    throw new Error(`Expected failure containing ${message}`);
  }, (error: unknown) => {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
  });
}

function requiredFile(fs: MemoryFileSystem, path: string) {
  const value = fs.files.get(path);
  if (value === undefined) throw new Error(`Missing test file ${path}`);
  return value;
}

function fullFreshRuntime(options: FakeOptions = {}) {
  return new FakeRuntime(options).answer("y", WORKER, "", "", "https://example.test", "y", "n", "y", "SAVED", "SAVED", "y", "y");
}

describe("full resumable provisioning sequences", () => {
  test("provisions a fresh clone from the real wrangler config and persists the prepared deployment", async () => {
    const runtime = fullFreshRuntime();
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("deploy")).length).toBe(1);
    expect(runtime.commands.some((command) => command.includes("r2") && command.includes("list"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("kv") && command.includes("list"))).toBe(false);
    expect(runtime.apiUrls.some((url) => url.includes(`/accounts/${ACCOUNT}/r2/buckets`))).toBe(true);
    expect(runtime.apiUrls.some((url) => url.includes(`/accounts/${ACCOUNT}/storage/kv/namespaces`))).toBe(true);
    expect(runtime.secrets.has("EMDASH_ENCRYPTION_KEY")).toBe(true);
    expect(runtime.secrets.has("EMDASH_BOOTSTRAP_SECRET")).toBe(true);
    expect(runtime.commands.some((command) => command.includes("versions") && command.includes("secret") && command.includes("put"))).toBe(true);
    expect(runtime.commands.some((command) => command.includes("versions") && command.includes("secret") && command.includes("list"))).toBe(false);
    expect(runtime.interactiveCommands.some((command) => command.includes("triggers") && command.includes("deploy"))).toBe(true);
    const versionDeployIndex = runtime.interactiveCommands.findIndex((command) => command.includes("versions") && command.includes("deploy"));
    const triggerDeployIndex = runtime.interactiveCommands.findIndex((command) => command.includes("triggers") && command.includes("deploy"));
    expect(triggerDeployIndex).toBeGreaterThan(versionDeployIndex);
    expect(runtime.originUrls).toEqual(["https://example.test"]);
    const config = parseJsonc<Record<string, unknown>>(requiredFile(runtime.fs, join(ROOT, "wrangler.jsonc")), "test config");
    expect(config.account_id).toBe(ACCOUNT);
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(journal.pending.deployment).toBe(false);
    expect(journal.milestones.bootstrapHandoff).toBe(true);
    expect(journal.milestones.triggersDeployed).toBe(true);
    expect(journal.deployment?.versionId).toBe(journal.preparedVersion?.versionId);
  });

  test("uses paginated R2 discovery and prepares code before the only first-run deploy", async () => {
    const runtime = fullFreshRuntime({ r2Pagination: true });
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.apiUrls.some((url) => url.includes("cursor=next"))).toBe(true);
    const uploadIndex = runtime.interactiveCommands.findIndex((command) => command.includes("versions") && command.includes("upload"));
    const deployIndex = runtime.interactiveCommands.findIndex((command) => command.includes("versions") && command.includes("deploy"));
    expect(uploadIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(uploadIndex);
    expect(runtime.commands.some((command) => command.includes("secret") && !command.includes("versions"))).toBe(false);
  });

  test("recovers an interrupted version upload from annotations without uploading a duplicate", async () => {
    const runtime = fullFreshRuntime({ failVersionUpload: 1 });
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "Prepared version upload");
    const uploadsBeforeResume = runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("upload")).length;
    runtime.replaceAnswers("y", "y", "y", "SAVED", "SAVED", "y", "y");
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("upload")).length).toBe(uploadsBeforeResume);
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(journal.preparedVersion?.versionId).toBeTruthy();
    expect(journal.milestones.triggersDeployed).toBe(true);
  });

  test("does not complete handoff when the canonical attachment is missing or points to another Worker", async () => {
    for (const attachment of ["missing", "wrong"] as const) {
      const runtime = fullFreshRuntime({ canonicalAttachment: attachment });
      await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "canonical");
      const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
      const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
      expect(journal.milestones.canonicalVerified).not.toBe(true);
      expect(journal.milestones.bootstrapHandoff).not.toBe(true);
      expect(runtime.handoffCount).toBe(0);
    }
  });

  test("accepts only the fresh-site setup redirect at the canonical origin", async () => {
    for (const originMode of ["cross-origin", "wrong-path", "loop", "bad-status"] as const) {
      const runtime = fullFreshRuntime({ originMode });
      await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "expected same-origin response");
      expect(runtime.handoffCount).toBe(0);
    }
  });

  test("reloads a partial journal without retrying an ambiguous D1 create", async () => {
    const runtime = new FakeRuntime({ failD1Create: true }).answer("y", WORKER, "", "", "https://example.test", "y", "n", "y");
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "ambiguous");
    const d1CreateAttempts = runtime.commands.filter((command) => command.includes("d1") && command.includes("create")).length;
    runtime.failD1Create = false;
    runtime.answer("y", WORKER, "y");
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "previous D1 database create outcome");
    expect(runtime.commands.filter((command) => command.includes("d1") && command.includes("create")).length).toBe(d1CreateAttempts);
    runtime.resources.d1.push({ uuid: "example-db-id", name: "example-db" });
    runtime.answer("y", WORKER, "y", "y", "SAVED", "SAVED", "y", "y");
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.commands.filter((command) => command.includes("d1") && command.includes("create")).length).toBe(d1CreateAttempts);
  });

  test("requires explicit adoption for same-name resources and rejects target mismatch", async () => {
    const runtime = new FakeRuntime({ coreConfigured: true }).answer("y", "n", "n", "y", "y", "y", "y", "y");
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.prompts.length).toBe(0);
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    journal.target.accountId = "fedcba9876543210fedcba9876543210";
    runtime.fs.files.set(journalPath, serializeProvisioningJournal(journal));
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "journal target");
  });

  test("does not regenerate a missing encryption key on an established database", async () => {
    const runtime = new FakeRuntime({ coreConfigured: true, databaseEstablished: true }).answer("y", "n", "y", "y", "y", "y");
    runtime.removeSecret("EMDASH_ENCRYPTION_KEY");
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "EMDASH_ENCRYPTION_KEY is absent");
    expect(runtime.commands.some((command) => command.includes("emdash") && command.includes("generate"))).toBe(false);
  });

  test("handles partial newsletter and Resend prerequisites with migration response loss", async () => {
    const runtime = new FakeRuntime().answer(
      "y", WORKER, "", "", "https://example.test", "n", "y", "newsletter@example.test", "site-key", "example.test", "9", "y", "segment-id", "y", "SAVED", "y", "y",
    ).secretAnswer("SAVED", "turnstile-secret", "admin-secret", "resend-secret");
    runtime.migrationApplyResponseLoss = true;
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.migrations.has("0003_resend_quarantine.sql")).toBe(true);
    expect(runtime.secrets.has("TURNSTILE_SECRET_KEY")).toBe(true);
    expect(runtime.secrets.has("NEWSLETTER_ADMIN_TOKEN")).toBe(true);
    expect(runtime.secrets.has("RESEND_API_KEY")).toBe(true);
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("deploy")).length).toBe(1);
  });

  test("keeps legacy cutover blocked until reconfirmed and resumes after deployment failure", async () => {
    const config = JSON.stringify({
      name: WORKER,
      account_id: ACCOUNT,
      d1_databases: [
        { binding: "DB", database_name: "example-db", database_id: "core-d1-id" },
        { binding: "NEWSLETTER_DB", database_name: "example-newsletter", database_id: "newsletter-d1-id", migrations_dir: "newsletter-migrations" },
      ],
      r2_buckets: [{ binding: "MEDIA", bucket_name: "example-media" }],
      kv_namespaces: [{ binding: "SESSION", id: "session-kv-id" }],
      send_email: [{ name: "NEWSLETTER_EMAIL", remote: true, allowed_sender_addresses: ["newsletter@example.test"] }],
      ratelimits: [{ name: "NEWSLETTER_SUBSCRIBE_LIMITER", namespace_id: 9, simple: { limit: 5, period: 60 } }],
      vars: { RESEND_SEGMENT_ID: "segment-id" },
    });
    const site = actualSiteConfig
      .replace('url: "http://localhost:8787"', 'url: "https://example.test"')
      .replace('enabled: false', 'enabled: true')
      .replace('senderAddress: "newsletter@your-domain.com"', 'senderAddress: "newsletter@example.test"')
      .replace('expectedHostname: "your-domain.com"', 'expectedHostname: "example.test"')
      .replace('turnstileSiteKey: ""', 'turnstileSiteKey: "site-key"');
    const runtime = new FakeRuntime({ config, site, coreConfigured: true, newsletterConfigured: true, resendConfigured: true, databaseEstablished: true, failDeployment: 1 })
      .answer("y", "y", "y", "y", "y", "y", "n");
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "Legacy newsletter");
    runtime.answer("y", "y", "y", "y");
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "Deployment failed");
    runtime.answer("y", "y");
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("deploy")).length).toBe(2);
  });

  test("keeps legacy cutover pending when trigger deployment fails after version deployment", async () => {
    const config = JSON.stringify({
      name: WORKER,
      account_id: ACCOUNT,
      d1_databases: [
        { binding: "DB", database_name: "example-db", database_id: "core-d1-id" },
        { binding: "NEWSLETTER_DB", database_name: "example-newsletter", database_id: "newsletter-d1-id", migrations_dir: "newsletter-migrations" },
      ],
      r2_buckets: [{ binding: "MEDIA", bucket_name: "example-media" }],
      kv_namespaces: [{ binding: "SESSION", id: "session-kv-id" }],
      send_email: [{ name: "NEWSLETTER_EMAIL", remote: true, allowed_sender_addresses: ["newsletter@example.test"] }],
      ratelimits: [{ name: "NEWSLETTER_SUBSCRIBE_LIMITER", namespace_id: 9, simple: { limit: 5, period: 60 } }],
      vars: { RESEND_SEGMENT_ID: "segment-id" },
    });
    const site = actualSiteConfig
      .replace('url: "http://localhost:8787"', 'url: "https://example.test"')
      .replace("enabled: false", "enabled: true")
      .replace('senderAddress: "newsletter@your-domain.com"', 'senderAddress: "newsletter@example.test"')
      .replace('expectedHostname: "your-domain.com"', 'expectedHostname: "example.test"')
      .replace('turnstileSiteKey: ""', 'turnstileSiteKey: "site-key"');
    const runtime = new FakeRuntime({ config, site, coreConfigured: true, newsletterConfigured: true, resendConfigured: true, databaseEstablished: true, failTriggers: 1 })
      .answer("y", "y", "y", "y", "y", "y", "y", "y", "y", "y", "y");
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "Trigger deployment failed");
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const pending = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(pending.pending.triggers).toBe(true);
    expect(pending.milestones.triggersDeployed).not.toBe(true);
    expect(pending.milestones.canonicalVerified).not.toBe(true);
    runtime.replaceAnswers("y", "y", "y", "y");
    await runProvisioning({ runtime, projectRoot: ROOT });
    const complete = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(complete.pending.triggers).toBe(false);
    expect(complete.milestones.triggersDeployed).toBe(true);
  });

  test("keeps a completed site's revoked bootstrap secret revoked on a no-op rerun", async () => {
    const runtime = new FakeRuntime({ coreConfigured: true, databaseEstablished: true }).answer("y", "n", "y", "y", "y", "y", "y");
    runtime.removeSecret("EMDASH_BOOTSTRAP_SECRET");
    await runProvisioning({ runtime, projectRoot: ROOT });
    const deploymentsBeforeRerun = runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("deploy")).length;
    runtime.answer("y", "y");
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.secrets.has("EMDASH_BOOTSTRAP_SECRET")).toBe(false);
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("deploy")).length).toBe(deploymentsBeforeRerun);
  });
});

describe("provisioning safety primitives", () => {
  test("closes competing readline during raw input and recreates it afterward", async () => {
    const terminal = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
    terminal.isTTY = true;
    terminal.setRawMode = () => undefined;
    const outputStream = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    let activeReadline = createLineInterface({ input: terminal, output: outputStream });
    let standardHandledSecret = false;
    activeReadline.on("line", () => { standardHandledSecret = true; });
    const writes: string[] = [];
    const secretPromise = promptSecretDetached("Secret: ", {
      get: () => activeReadline,
      replace: (next) => { activeReadline = next as typeof activeReadline; },
    }, () => createLineInterface({ input: terminal, output: outputStream }), terminal, {
      write: (value: string) => { writes.push(value); return true; },
    });
    terminal.write("not-visible\n");
    expect(await secretPromise).toBe("not-visible");
    expect(standardHandledSecret).toBe(false);
    expect(writes.join("")).toBe("Secret: \n");
    const normalLine = new Promise<string>((resolve) => activeReadline.once("line", resolve));
    terminal.write("ordinary input\n");
    expect(await normalLine).toBe("ordinary input");
    activeReadline.close();
    terminal.destroy();
    outputStream.destroy();
  });

  test("requires adoption and never retries an unresolved create", async () => {
    let creates = 0;
    await expectFailure(() => resolveUniqueResource({
      kind: "R2 bucket",
      intendedName: "example-media",
      creationAttempted: false,
      adoptionApproved: false,
      list: async () => [{ id: "bucket-id", name: "example-media" }],
      identity: (resource) => resource,
      create: async () => { creates += 1; },
    }), "explicit adoption");
    expect(creates).toBe(0);
    await expectFailure(() => resolveUniqueResource({
      kind: "KV namespace",
      intendedName: "example-sessions",
      creationAttempted: true,
      adoptionApproved: false,
      list: async () => [],
      identity: (resource) => resource,
      create: async () => { creates += 1; },
    }), "previous");
    expect(creates).toBe(0);
  });

  test("preserves arbitrary strings containing trailing-comma text while editing real JSONC", () => {
    const source = `{
      "name": "minastro-template",
      "description": "literal ,} and ,] text",
      "d1_databases": [{ "binding": "DB", "database_name": "minastro-template-db", "database_id": "00000000-0000-0000-0000-000000000000" }],
      "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "minastro-template-media" }],
      "kv_namespaces": [{ "binding": "SESSION", "id": "00000000000000000000000000000000" }],
    }`;
    const result = reconcileWranglerConfig(source, {
      accountId: ACCOUNT,
      workerName: WORKER,
      canonicalHostname: "example.test",
      coreD1: { name: "example-db", id: "d1-id" },
      media: { name: "example-media" },
      session: { title: "example-sessions", id: "kv-id" },
    });
    const parsed = parseJsonc<Record<string, unknown>>(result, "edited config");
    expect(parsed.description).toBe("literal ,} and ,] text");
  });

  test("does not remove a lock after a simulated process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minastro-lock-"));
    try {
      const first = defaultProvisioningFileSystem();
      const second = defaultProvisioningFileSystem();
      const path = provisioningLockPath(directory, ACCOUNT, WORKER);
      const release = await first.acquireExclusive(path);
      await expectFailure(() => second.acquireExclusive(path), "already exists");
      await release();
      const releaseAfterRestart = await second.acquireExclusive(path);
      await releaseAfterRestart();
      await writeFile(path, JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }));
      await expectFailure(() => first.acquireExclusive(path), "already exists");
      expect(await readFile(path, "utf8")).toContain("999999");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("never serializes secret values or token URLs", () => {
    const journal = createProvisioningJournal(
      { accountId: ACCOUNT, workerName: WORKER, canonicalOrigin: "https://example.test" },
      { bootstrapRequested: true },
      {},
    );
    journal.secrets = { EMDASH_BOOTSTRAP_SECRET: "verified" };
    expect(journalIsNonSecret(journal)).toBe(true);
    const unsafe = { ...journal, target: { ...journal.target, canonicalOrigin: "https://example.test/_emdash/admin/setup?bootstrap=secret" } } as ProvisioningJournal;
    expect(journalIsNonSecret(unsafe)).toBe(false);
    expect(() => serializeProvisioningJournal(unsafe)).toThrow("secret material");
  });
});
