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
import { createTerminalUI, type TerminalUI } from "./terminal-ui";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ROOT = "/fake-project";
const WORKER = "example";
const WORKER_ID = "aaaaaaaa111122223333444455555666";
const MIGRATIONS = ["0001_newsletter.sql", "0002_resend_outbox.sql", "0003_resend_quarantine.sql", "0004_newsletter_erasure.sql"];

const actualWranglerConfig = await readFile(join(import.meta.dir, "..", "wrangler.jsonc"), "utf8");
const actualSiteConfig = await readFile(join(import.meta.dir, "..", "src/site.config.ts"), "utf8");

describe("setup terminal progress", () => {
  test("prints readable progress without terminal control codes when output is redirected", async () => {
    let text = "";
    const progress = createTerminalUI({ write: (chunk) => { text += chunk; } }, false);
    progress.section("Cloudflare resources");
    progress.note("D1 database ready: example-db");
    expect(await progress.run("Checking Worker versions", async () => 42)).toBe(42);
    expect(text).toContain("Cloudflare resources\n");
    expect(text).toContain("D1 database ready: example-db");
    expect(text).toContain("... Checking Worker versions\n");
    expect(text).toContain("✓ Checking Worker versions\n");
    expect(text).not.toContain("\x1b[");
    expect(text).not.toContain("\r");
  });

  test("clears a TTY spinner and keeps the original error", async () => {
    let text = "";
    const progress = createTerminalUI({ write: (chunk) => { text += chunk; } }, true);
    let caught: unknown;
    try {
      await progress.run("Checking Worker versions", async () => { throw new Error("Wrangler failed"); });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) expect(caught.message).toBe("Wrangler failed");
    expect(text).toContain("⠋ Checking Worker versions");
    expect(text).toContain("! Checking Worker versions failed\n");
    expect(text.endsWith("\n")).toBe(true);
  });
});

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
  failWorkerCreateResponse?: number;
  workerCreateNeverLands?: boolean;
  failBootstrapDeploy?: number;
  bootstrapDeployNeverLands?: boolean;
  failDeploymentsList?: number;
  originMode?: "setup" | "ok" | "cross-origin" | "wrong-path" | "loop" | "bad-status" | "protected-setup";
}

class FakeRuntime implements SetupRuntime {
  progress?: TerminalUI;
  readonly fs = new MemoryFileSystem();
  readonly apiToken = "test-token";
  readonly approvedAccountId = ACCOUNT;
  readonly commands: string[][] = [];
  readonly interactiveCommands: string[][] = [];
  readonly apiUrls: string[] = [];
  readonly writeRequests: Array<{ url: string; method: string }> = [];
  readonly events: string[] = [];
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
  failWorkerCreateResponse: number;
  workerCreateNeverLands: boolean;
  failBootstrapDeploy: number;
  bootstrapDeployNeverLands: boolean;
  failDeploymentsList: number;
  originMode: NonNullable<FakeOptions["originMode"]>;
  triggersDeployed = false;
  workerExists = false;
  scriptExists = false;
  failD1Create: boolean;
  failVersionUpload: number;
  failDeployment: number;
  migrationApplyResponseLoss: boolean;
  databaseEstablished: boolean;
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
    this.failWorkerCreateResponse = options.failWorkerCreateResponse ?? 0;
    this.workerCreateNeverLands = options.workerCreateNeverLands ?? false;
    this.failBootstrapDeploy = options.failBootstrapDeploy ?? 0;
    this.bootstrapDeployNeverLands = options.bootstrapDeployNeverLands ?? false;
    this.failDeploymentsList = options.failDeploymentsList ?? 0;
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
    this.fs.files.set(join(ROOT, "dist/server/wrangler.json"), JSON.stringify({ name: WORKER, main: "entry.mjs" }));
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
      this.workerExists = true;
      this.scriptExists = true;
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

  replaceSecretAnswers(...values: string[]) {
    this.secretAnswers = values;
    return this;
  }

  async prompt() {
    return this.answers.shift() ?? "y";
  }

  async promptSecret(question: string) {
    const value = this.secretAnswers.shift() ?? "saved-secret";
    this.secretPrompts.push(question);
    return value;
  }

  async handoff() {
    this.handoffCount += 1;
    return { opened: true, copied: false };
  }

  async apiFetch(url: string, init?: RequestInit) {
    this.apiUrls.push(url);
    if (url.includes("/workers/workers") && init?.method === "POST") {
      this.writeRequests.push({ url, method: "POST" });
      if (this.failWorkerCreateResponse > 0) {
        this.failWorkerCreateResponse -= 1;
        if (!this.workerCreateNeverLands) this.workerExists = true;
        throw new Error("simulated Worker create response loss");
      }
      if (this.workerExists) return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 409 });
      this.workerExists = true;
      return Response.json({ success: true, result: { id: WORKER_ID, name: WORKER } });
    }
    if (url.includes("/r2/buckets")) {
      if (this.r2Pagination && !url.includes("cursor=next")) return Response.json({ success: true, result: { buckets: this.resources.r2.slice(0, 1), truncated: true, cursor: "next" } });
      return Response.json({ success: true, result: { buckets: this.r2Pagination ? [...this.resources.r2.slice(1), { name: "other-media" }] : this.resources.r2, truncated: false } });
    }
    if (url.includes("/storage/kv/namespaces")) return Response.json({ success: true, result: this.resources.kv });
    if (url.includes("/workers/workers")) return Response.json({ success: true, result: this.workerExists ? [{ id: WORKER_ID, name: WORKER }] : [] });
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
    if (this.originMode === "protected-setup" && new URL(url).pathname === "/_emdash/admin/setup") {
      return new Response("First-admin bootstrap authorization required.", { status: 403, headers: { "cache-control": "no-store" } });
    }
    if (this.originMode === "protected-setup") return new Response("<html>site</html>", { status: 200 });
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
    if (command.includes("versions") && command.includes("list")) {
      if (!this.scriptExists) throw new Error(`Wrangler versions list failed. [code: 10007]`);
      return JSON.stringify(this.versions.map((entry) => ({ id: entry.id, metadata: { created_on: entry.createdOn }, annotations: { "workers/tag": entry.tag } })));
    }
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
    if (command.includes("deployments") && command.includes("list")) {
      if (this.failDeploymentsList > 0) {
        this.failDeploymentsList -= 1;
        throw new Error("simulated deployments list authentication failure");
      }
      if (!this.scriptExists) {
        this.events.push("deployments:missing");
        throw new Error(`Wrangler deployments list failed. [code: 10007]`);
      }
      this.events.push("deployments:listed");
      return JSON.stringify(this.deployments.slice().reverse().map((entry) => ({ id: entry.id, metadata: { created_on: entry.createdOn }, versions: [{ version_id: entry.versionId, percentage: 100 }] })));
    }
    return "";
  }

  async runInteractive(command: string[]) {
    this.interactiveCommands.push(command);
    if (isBootstrapDeploy(command)) {
      if (this.failBootstrapDeploy > 0) {
        this.failBootstrapDeploy -= 1;
        throw new Error("simulated base Worker deployment failure");
      }
      if (this.bootstrapDeployNeverLands) return;
      this.events.push("bootstrap:deployed");
      this.workerDeployed = true;
      this.scriptExists = true;
      this.version += 1;
      const id = `version-${this.version}`;
      this.versions.push({ id, tag: "bootstrap", createdOn: `2026-01-01T00:00:${String(this.version).padStart(2, "0")}Z`, secrets: new Set() });
      this.deployments.push({ id: `deployment-${this.deployments.length + 1}`, createdOn: `2026-01-01T00:01:${String(this.deployments.length + 1).padStart(2, "0")}Z`, versionId: id });
      return;
    }
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
      this.events.push("version:deployed");
      this.workerDeployed = true;
      this.scriptExists = true;
      this.deployments.push({ id: `deployment-${this.deployments.length + 1}`, createdOn: `2026-01-01T00:01:${String(this.deployments.length + 1).padStart(2, "0")}Z`, versionId: this.activeVersionId ?? "" });
      return;
    }
    if (command.includes("versions") && command.includes("upload")) {
      if (!this.workerDeployed) throw new Error("You cannot upload a new version of a Worker that does not yet exist. Please run the deploy command first.");
      const tag = command[command.indexOf("--tag") + 1];
      const previous = this.versions.at(-1);
      this.version += 1;
      this.events.push("version:uploaded");
      this.scriptExists = true;
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

const base64Url32 = (seed: number) => {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (seed + index) % 256;
  return Buffer.from(bytes).toString("base64url");
};

const OPERATOR_ENCRYPTION_KEY = `emdash_enc_v1_${base64Url32(3)}`;
const OPERATOR_BOOTSTRAP_SECRET = base64Url32(131);

function fullFreshRuntime(options: FakeOptions = {}) {
  return new FakeRuntime(options)
    .answer("y", WORKER, "", "", "https://example.test", "y", "n", "y", "y", "y")
    .secretAnswer(OPERATOR_ENCRYPTION_KEY, OPERATOR_BOOTSTRAP_SECRET);
}

function isBootstrapDeploy(command: string[]) {
  return command.includes("deploy") && command.some((value) => value.endsWith("-bootstrap.jsonc"));
}

describe("full resumable provisioning sequences", () => {
  test("provisions a fresh clone from the real wrangler config and persists the prepared deployment", async () => {
    const runtime = fullFreshRuntime();
    let transcript = "";
    runtime.progress = createTerminalUI({ write: (chunk) => { transcript += chunk; } }, false);
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(transcript).toContain("Cloudflare resources\n");
    expect(transcript).toContain("Worker deployment\n");
    expect(transcript).toContain("Building Astro site (full build output follows)");
    expect(transcript).toContain("Final verification\n");
    expect(runtime.interactiveCommands.some((command) => command.join(" ") === "bun run build")).toBe(true);
    expect(transcript).not.toContain("\x1b[");
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
    runtime.replaceAnswers("y", "y", "y", "y", "y");
    runtime.replaceSecretAnswers(OPERATOR_ENCRYPTION_KEY, OPERATOR_BOOTSTRAP_SECRET);
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("upload")).length).toBe(uploadsBeforeResume);
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(journal.preparedVersion?.versionId).toBeTruthy();
    expect(journal.milestones.triggersDeployed).toBe(true);
  });

  test("creates the missing Worker resource before any version listing on a fresh account", async () => {
    const runtime = fullFreshRuntime();
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.writeRequests).toEqual([{ url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/workers`, method: "POST" }]);
    const listRequest = runtime.apiUrls.find((url) => url.includes(`/accounts/${ACCOUNT}/workers/workers`));
    expect(listRequest).toContain("per_page=100");
    const workerListIndex = runtime.apiUrls.findIndex((url) => url.includes(`/accounts/${ACCOUNT}/workers/workers`));
    expect(runtime.apiUrls.slice(0, workerListIndex).some((url) => url.includes("/storage/kv/namespaces"))).toBe(true);
    expect(runtime.commands.filter((command) => command.includes("d1") && command.includes("create")).length).toBe(1);
    expect(runtime.commands.filter((command) => command.includes("r2") && command.includes("create")).length).toBe(1);
    expect(runtime.commands.filter((command) => command.includes("kv") && command.includes("create")).length).toBe(1);
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("deploy")).length).toBe(1);
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(journal.resources.worker).toEqual({ intendedName: WORKER, id: WORKER_ID, status: "verified", createAttempted: true, adopted: true });
  });

  test("resumes an interrupted Worker create only after discovery confirms it, without recreating resources or redeploying first", async () => {
    const runtime = fullFreshRuntime({ failWorkerCreateResponse: 1 });
    await runProvisioning({ runtime, projectRoot: ROOT });
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(runtime.writeRequests.length).toBe(1);
    expect(journal.resources.worker).toEqual({ intendedName: WORKER, id: WORKER_ID, status: "verified", createAttempted: true, adopted: true });
    expect(runtime.commands.filter((command) => command.includes("d1") && command.includes("create")).length).toBe(1);
    expect(runtime.commands.filter((command) => command.includes("r2") && command.includes("create")).length).toBe(1);
    expect(runtime.commands.filter((command) => command.includes("kv") && command.includes("create")).length).toBe(1);
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("deploy")).length).toBe(1);
    expect(journal.milestones.triggersDeployed).toBe(true);
  });

  test("fails closed and deploys nothing when an interrupted Worker create never appears in discovery", async () => {
    const runtime = fullFreshRuntime({ failWorkerCreateResponse: 1, workerCreateNeverLands: true });
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "create outcome is ambiguous");
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(journal.resources.worker.createAttempted).toBe(true);
    expect(journal.resources.worker.status).toBe("pending");
    expect(runtime.writeRequests.length).toBe(1);
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("upload")).length).toBe(0);
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("deploy")).length).toBe(0);
    const d1Creates = runtime.commands.filter((command) => command.includes("d1") && command.includes("create")).length;
    runtime.replaceAnswers("y", "y");
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "previous Worker create outcome");
    expect(runtime.writeRequests.length).toBe(1);
    expect(runtime.commands.filter((command) => command.includes("d1") && command.includes("create")).length).toBe(d1Creates);
  });

  test("installs an inert base Worker version before the first prepared upload for a fresh Worker", async () => {
    const runtime = fullFreshRuntime();
    await runProvisioning({ runtime, projectRoot: ROOT });
    const missingListingIndex = runtime.events.indexOf("deployments:missing");
    expect(missingListingIndex).toBeGreaterThanOrEqual(0);
    expect(runtime.events.indexOf("bootstrap:deployed")).toBeGreaterThan(missingListingIndex);
    expect(runtime.events.indexOf("version:uploaded")).toBeGreaterThan(runtime.events.indexOf("bootstrap:deployed"));
    const bootstrapIndex = runtime.interactiveCommands.findIndex(isBootstrapDeploy);
    const uploadIndex = runtime.interactiveCommands.findIndex((command) => command.includes("versions") && command.includes("upload"));
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(bootstrapIndex);
    const bootstrap = runtime.interactiveCommands[bootstrapIndex];
    const bootstrapConfig = requiredFile(runtime.fs, join(ROOT, ".wrangler/provisioning", `${WORKER}-bootstrap.jsonc`));
    expect(bootstrap).toContain(join(ROOT, ".wrangler/provisioning", `${WORKER}-bootstrap.jsonc`));
    const parsed = parseJsonc<Record<string, unknown>>(bootstrapConfig, "bootstrap config");
    expect(parsed.name).toBe(WORKER);
    expect(parsed.account_id).toBe(ACCOUNT);
    expect(parsed.workers_dev).toBe(false);
    expect(parsed.preview_urls).toBe(false);
    expect(parsed.routes).toBeUndefined();
    expect(parsed.d1_databases).toBeUndefined();
    expect(parsed.r2_buckets).toBeUndefined();
    expect(parsed.kv_namespaces).toBeUndefined();
    expect(parsed.triggers).toBeUndefined();
    expect(parsed.assets).toBeUndefined();
    expect(typeof parsed.main).toBe("string");
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(journal.milestones.workerBootstrapDeployed).toBe(true);
    expect(journal.pending.deployment).toBe(false);
    expect(runtime.originUrls).toEqual(["https://example.test"]);
  });

  test("uploads the prepared version against the built Astro config, not the root wrangler.jsonc", async () => {
    const runtime = fullFreshRuntime();
    await runProvisioning({ runtime, projectRoot: ROOT });
    const upload = runtime.interactiveCommands.find((command) => command.includes("versions") && command.includes("upload"));
    expect(upload).toBeDefined();
    expect(upload).toContain(join(ROOT, "dist/server/wrangler.json"));
    expect(upload).not.toContain(join(ROOT, "wrangler.jsonc"));
  });

  test("resumes an interrupted base Worker deployment without redeploying or recreating resources", async () => {
    const runtime = fullFreshRuntime({ failBootstrapDeploy: 1 });
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "base Worker deployment");
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const pending = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(pending.milestones.workerBootstrapPending).toBe(true);
    expect(pending.milestones.workerBootstrapDeployed).not.toBe(true);
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("upload")).length).toBe(0);
    const bootstrapDeploys = runtime.interactiveCommands.filter(isBootstrapDeploy).length;
    runtime.replaceAnswers("y", "y", "y", "y", "y", "y");
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.commands.filter((command) => command.includes("d1") && command.includes("create")).length).toBe(1);
    expect(runtime.commands.filter((command) => command.includes("r2") && command.includes("create")).length).toBe(1);
    expect(runtime.commands.filter((command) => command.includes("kv") && command.includes("create")).length).toBe(1);
    expect(runtime.writeRequests.length).toBe(1);
    expect(runtime.interactiveCommands.filter(isBootstrapDeploy).length).toBe(bootstrapDeploys + 1);
    const complete = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(complete.milestones.workerBootstrapPending).toBe(false);
    expect(complete.milestones.workerBootstrapDeployed).toBe(true);
  });

  test("fails closed without bootstrapping when the deployment listing fails for another reason", async () => {
    const runtime = fullFreshRuntime({ failDeploymentsList: 99 });
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "simulated deployments list authentication failure");
    expect(runtime.events).not.toContain("bootstrap:deployed");
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("upload")).length).toBe(0);
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(journal.milestones.workerBootstrapDeployed).not.toBe(true);
  });

  test("keeps the base deployment pending when a reported success is not visible remotely", async () => {
    const runtime = fullFreshRuntime({ bootstrapDeployNeverLands: true });
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "no deployment was verified remotely");
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const pending = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(pending.milestones.workerBootstrapPending).toBe(true);
    expect(pending.milestones.workerBootstrapDeployed).not.toBe(true);
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("upload")).length).toBe(0);
    const bootstrapDeploys = runtime.interactiveCommands.filter(isBootstrapDeploy).length;
    runtime.bootstrapDeployNeverLands = false;
    runtime.replaceAnswers("y", "y", "y", "y", "y", "y");
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.interactiveCommands.filter(isBootstrapDeploy).length).toBe(bootstrapDeploys + 1);
    const complete = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(complete.milestones.workerBootstrapPending).toBe(false);
    expect(complete.milestones.workerBootstrapDeployed).toBe(true);
  });

  test("never bootstraps over a Worker that already has live traffic", async () => {
    const runtime = fullFreshRuntime();
    await runProvisioning({ runtime, projectRoot: ROOT });
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    delete journal.milestones.workerBootstrapDeployed;
    runtime.fs.files.set(journalPath, serializeProvisioningJournal(journal));
    const bootstrapDeploys = runtime.interactiveCommands.filter(isBootstrapDeploy).length;
    runtime.replaceAnswers("y", "y", "y", "y", "y");
    runtime.replaceSecretAnswers(OPERATOR_ENCRYPTION_KEY, OPERATOR_BOOTSTRAP_SECRET);
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.interactiveCommands.filter(isBootstrapDeploy).length).toBe(bootstrapDeploys);
    const complete = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(complete.milestones.workerBootstrapDeployed).toBe(true);
  });

  test("recovers an old overlong pending secret tag from its verified predecessor", async () => {
    const runtime = fullFreshRuntime();
    await runProvisioning({ runtime, projectRoot: ROOT });
    const journalPath = provisioningJournalPath(join(ROOT, ".wrangler/provisioning"), ACCOUNT, WORKER);
    const journal = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    const baseTag = "minastro-setup-1759000000000-aabbccdd";
    const ancestorTag = `${baseTag}-binding-11112222-binding-33334444`;
    const pendingTag = `${ancestorTag}-binding-55556666-binding-77778888`;
    expect(pendingTag.length).toBeGreaterThan(100);
    runtime.versions.push({ id: "version-ancestor", tag: ancestorTag, createdOn: "2026-01-01T00:00:00Z", secrets: new Set(["EMDASH_ENCRYPTION_KEY", "EMDASH_BOOTSTRAP_SECRET"]) });
    journal.preparedVersion = { versionId: "", tag: pendingTag, createdOn: "", revision: journal.preparedVersion?.revision ?? journal.deploymentRevision };
    journal.secrets = { EMDASH_ENCRYPTION_KEY: "verified", EMDASH_BOOTSTRAP_SECRET: "verified" };
    journal.pending.deployment = true;
    runtime.fs.files.set(journalPath, serializeProvisioningJournal(journal));
    runtime.commands.length = 0;
    runtime.interactiveCommands.length = 0;
    runtime.replaceAnswers("y", "y", "y", "y", "y");
    runtime.replaceSecretAnswers(OPERATOR_BOOTSTRAP_SECRET);
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.interactiveCommands.some((command) => command.includes("versions") && command.includes("upload"))).toBe(false);
    const recovered = parseProvisioningJournal(requiredFile(runtime.fs, journalPath));
    expect(recovered.preparedVersion?.versionId).toBe("version-ancestor");
    expect(recovered.preparedVersion?.tag).toBe(ancestorTag);
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

  test("accepts the bootstrap-protected setup route as the pre-setup canonical shape", async () => {
    const runtime = fullFreshRuntime({ originMode: "protected-setup" });
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.handoffCount).toBe(1);
    expect(runtime.originUrls.some((url) => url.endsWith("/_emdash/admin/setup"))).toBe(true);
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
    runtime.answer("y", WORKER, "y", "y", "y", "y").secretAnswer(OPERATOR_ENCRYPTION_KEY, OPERATOR_BOOTSTRAP_SECRET);
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
    expect(runtime.commands.some((command) => command.includes("versions") && command.includes("secret") && command.includes("put"))).toBe(false);
    expect(runtime.secretPrompts).toEqual([]);
  });

  test("handles partial newsletter and Resend prerequisites with migration response loss", async () => {
    const runtime = new FakeRuntime().answer(
      "y", WORKER, "", "", "https://example.test", "n", "y", "newsletter@example.test", "site-key", "example.test", "9", "y", "segment-id", "y", "y", "y",
    ).secretAnswer(OPERATOR_ENCRYPTION_KEY, "turnstile-secret", "admin-secret", "resend-secret");
    runtime.migrationApplyResponseLoss = true;
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.migrations.has("0003_resend_quarantine.sql")).toBe(true);
    expect(runtime.secrets.has("TURNSTILE_SECRET_KEY")).toBe(true);
    expect(runtime.secrets.has("NEWSLETTER_ADMIN_TOKEN")).toBe(true);
    expect(runtime.secrets.has("RESEND_API_KEY")).toBe(true);
    const writtenConfig = parseJsonc<{ ratelimits: Array<{ name: string; namespace_id: string }> }>(requiredFile(runtime.fs, join(ROOT, "wrangler.jsonc")), "reconciled Wrangler config");
    expect(writtenConfig.ratelimits.find((binding) => binding.name === "NEWSLETTER_SUBSCRIBE_LIMITER")?.namespace_id).toBe("9");
    const secretUploads = runtime.commands.filter((command) => command.includes("versions") && command.includes("secret") && command.includes("put"));
    expect(secretUploads).toHaveLength(4);
    const tags = secretUploads.map((command) => command[command.indexOf("--tag") + 1] ?? "");
    expect(tags.every((tag) => tag.length > 0 && tag.length <= 100)).toBe(true);
    expect(new Set(tags).size).toBe(4);
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
      .answer("y", "y", "y", "y", "y", "y", "y", "n");
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "Legacy newsletter");
    runtime.answer("y", "y", "y", "y");
    await expectFailure(() => runProvisioning({ runtime, projectRoot: ROOT }), "Deployment failed");
    runtime.answer("y", "y");
    await runProvisioning({ runtime, projectRoot: ROOT });
    expect(runtime.interactiveCommands.filter((command) => command.includes("versions") && command.includes("deploy")).length).toBe(2);
    const writtenConfig = parseJsonc<{ ratelimits: Array<{ name: string; namespace_id: string }> }>(requiredFile(runtime.fs, join(ROOT, "wrangler.jsonc")), "reconciled Wrangler config");
    expect(writtenConfig.ratelimits.find((binding) => binding.name === "NEWSLETTER_SUBSCRIBE_LIMITER")?.namespace_id).toBe("9");
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
