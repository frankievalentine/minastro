import { mkdir, open, readFile, readdir, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export const JOURNAL_VERSION = 3;
export const JOURNAL_DIRECTORY = ".wrangler/provisioning";

export type CommandOptions = {
  input?: string;
  quiet?: boolean;
  env?: Record<string, string | undefined>;
};

export interface ProvisioningFileSystem {
  read(path: string): Promise<string | null>;
  list(path: string): Promise<string[]>;
  writeAtomic(path: string, contents: string): Promise<void>;
  acquireExclusive(path: string): Promise<() => Promise<void>>;
}

export interface ResourceJournal {
  intendedName: string;
  id?: string;
  status: "pending" | "verified" | "ambiguous";
  createAttempted: boolean;
  adopted: boolean;
}

export interface BindingJournal {
  name: string;
  type: string;
  resourceId?: string;
}

export type SecretState = "unknown" | "verified" | "custody_pending" | "upload_pending";

export interface DeploymentJournal {
  versionId: string;
  deploymentId?: string;
  revision: number;
  bindings: BindingJournal[];
  verifiedAt: string;
}

export interface PreparedVersionJournal {
  versionId: string;
  tag: string;
  createdOn: string;
  revision: number;
}

export interface ProvisioningJournal {
  version: number;
  target: {
    accountId: string;
    workerName: string;
    canonicalOrigin: string;
  };
  plan: Record<string, unknown>;
  resources: Record<string, ResourceJournal>;
  secrets: Record<string, SecretState>;
  milestones: Record<string, boolean>;
  pending: {
    deployment: boolean;
    triggers: boolean;
    bootstrapHandoff: boolean;
  };
  deployment: DeploymentJournal | null;
  preparedVersion: PreparedVersionJournal | null;
  deploymentRevision: number;
  updatedAt: string;
}

export function defaultProvisioningFileSystem(): ProvisioningFileSystem {
  return {
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async list(path) {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    },
    async writeAtomic(path, contents) {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, path);
      } finally {
        try {
          await unlink(temporaryPath);
        } catch {
          // The atomic rename may already have removed the temporary path.
        }
      }
    },
    async acquireExclusive(path) {
      await mkdir(dirname(path), { recursive: true });
      let handle: FileHandle;
      try {
        handle = await open(path, "wx");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new Error(`The provisioning lock ${path} already exists. Inspect the running process and remove the lock manually only after confirming it is safe.`);
        }
        throw error;
      }
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close();
        await unlink(path);
      };
    },
  };
}

export function sanitizeJournalPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function provisioningJournalPath(root: string, accountId: string, workerName: string): string {
  return join(root, `${sanitizeJournalPart(accountId)}--${sanitizeJournalPart(workerName)}.json`);
}

export function provisioningLockPath(root: string, accountId: string, workerName: string): string {
  return join(root, `${sanitizeJournalPart(accountId)}--${sanitizeJournalPart(workerName)}.lock`);
}

export function createProvisioningJournal(
  target: ProvisioningJournal["target"],
  plan: Record<string, unknown>,
  resources: Record<string, ResourceJournal>,
): ProvisioningJournal {
  return {
    version: JOURNAL_VERSION,
    target,
    plan,
    resources,
    secrets: {},
    milestones: { planApproved: true },
    pending: { deployment: false, triggers: false, bootstrapHandoff: false },
    deployment: null,
    preparedVersion: null,
    deploymentRevision: 0,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeJournal(parsed: ProvisioningJournal): ProvisioningJournal {
  for (const resource of Object.values(parsed.resources)) {
    resource.adopted ??= false;
  }
  parsed.pending ??= { deployment: false, triggers: false, bootstrapHandoff: false };
  parsed.pending.deployment ??= false;
  parsed.pending.triggers ??= false;
  parsed.pending.bootstrapHandoff ??= false;
  parsed.deployment ??= null;
  parsed.preparedVersion ??= null;
  parsed.deploymentRevision ??= 0;
  return parsed;
}

export function serializeProvisioningJournal(journal: ProvisioningJournal): string {
  if (!journalIsNonSecret(journal)) throw new Error("Provisioning journal contains secret material or a token URL.");
  return `${JSON.stringify({ ...journal, updatedAt: new Date().toISOString() }, null, 2)}\n`;
}

export function parseProvisioningJournal(contents: string): ProvisioningJournal {
  let parsed: ProvisioningJournal;
  try {
    parsed = JSON.parse(contents) as ProvisioningJournal;
  } catch {
    throw new Error("The provisioning journal is invalid JSON.");
  }
  if (parsed.version !== JOURNAL_VERSION || !parsed.target || !parsed.plan || !parsed.resources) {
    throw new Error("The provisioning journal is invalid or from an unsupported version.");
  }
  const normalized = normalizeJournal(parsed);
  if (!journalIsNonSecret(normalized)) throw new Error("The provisioning journal contains secret material or a token URL.");
  return normalized;
}

export function journalIsNonSecret(value: unknown): boolean {
  if (typeof value === "string") {
    return !/(?:api[_-]?key|secret|token|password|authorization)/i.test(value)
      && !/[?&]bootstrap=|#token=/i.test(value);
  }
  if (Array.isArray(value)) return value.every(journalIsNonSecret);
  if (typeof value !== "object" || value === null) return true;
  return Object.entries(value).every(([key, entry]) => {
    if (key === "secrets" && typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      return Object.values(entry).every((state) => state === "unknown" || state === "verified" || state === "custody_pending" || state === "upload_pending");
    }
    if (/(?:secret|token|password|apiKey|api_key|authorization)/i.test(key)) {
      return typeof entry === "string" ? entry.length === 0 : journalIsNonSecret(entry);
    }
    return journalIsNonSecret(entry);
  });
}

export async function loadProvisioningJournal(fs: ProvisioningFileSystem, path: string): Promise<ProvisioningJournal | null> {
  const contents = await fs.read(path);
  return contents === null ? null : parseProvisioningJournal(contents);
}

export async function saveProvisioningJournal(fs: ProvisioningFileSystem, path: string, journal: ProvisioningJournal): Promise<void> {
  await fs.writeAtomic(path, serializeProvisioningJournal(journal));
}

export function parseJsonc<T = unknown>(source: string, label: string): T {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || parsed === undefined) throw new Error(`${label} was not valid JSONC; resolve its configuration conflict manually before provisioning.`);
  return parsed as T;
}

export function editJsoncObject(source: string, next: Record<string, unknown>, label: string): string {
  const current = parseJsonc<Record<string, unknown>>(source, label);
  let output = source;
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const key of keys) {
    if (JSON.stringify(current[key]) === JSON.stringify(next[key])) continue;
    output = applyEdits(output, modify(output, [key], next[key], {
      formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 2 },
    }));
  }
  return output;
}

export interface ResolveResourceOptions<T> {
  kind: string;
  intendedName: string;
  configuredId?: string;
  creationAttempted: boolean;
  adoptionApproved: boolean;
  list: () => Promise<T[]>;
  identity: (resource: T) => { id?: string; name?: string };
  create: () => Promise<void>;
}

/** Resolve one remote resource without retrying an ambiguous create. */
export async function resolveUniqueResource<T>(options: ResolveResourceOptions<T>): Promise<T> {
  const discover = async () => {
    const resources = await options.list();
    for (const resource of resources) {
      const identity = options.identity(resource);
      if (!identity.id || !identity.name) throw new Error(`Could not verify a ${options.kind} discovery result; operator review is required.`);
    }
    return resources;
  };
  const findNamed = (resources: T[]) => resources.filter((resource) => options.identity(resource).name === options.intendedName);
  const findConfigured = (resources: T[]) => resources.filter((resource) => options.identity(resource).id === options.configuredId);

  let resources = await discover();
  if (options.configuredId) {
    const configured = findConfigured(resources);
    if (configured.length !== 1) throw new Error(`${options.kind} ${options.configuredId} could not be uniquely verified; refusing to create or replace it.`);
    const identity = options.identity(configured[0]);
    if (identity.name !== options.intendedName) throw new Error(`Configured ${options.kind} identity conflicts with intended name ${options.intendedName}.`);
    if (!options.adoptionApproved) throw new Error(`Existing ${options.kind} ${identity.name} requires explicit adoption approval.`);
    return configured[0];
  }

  let named = findNamed(resources);
  if (named.length > 1) throw new Error(`Multiple ${options.kind} resources match ${options.intendedName}; operator decision is required.`);
  if (named.length === 1) {
    if (!options.adoptionApproved) throw new Error(`Existing ${options.kind} ${options.intendedName} requires explicit adoption approval.`);
    return named[0];
  }
  if (options.creationAttempted) throw new Error(`The previous ${options.kind} create outcome is unresolved; discover a unique ${options.intendedName} before retrying.`);

  try {
    await options.create();
  } catch (error) {
    resources = await discover();
    named = findNamed(resources);
    if (named.length === 1) return named[0];
    throw new Error(`The ${options.kind} create outcome is ambiguous; no retry will be attempted until discovery resolves it. ${error instanceof Error ? error.message : ""}`.trim());
  }

  resources = await discover();
  named = findNamed(resources);
  if (named.length === 1) return named[0];
  throw new Error(`The ${options.kind} create completed without a unique discovered ${options.intendedName}; operator decision is required.`);
}

export interface ConfigReconcileInput {
  accountId: string;
  workerName: string;
  canonicalHostname: string;
  coreD1: { name: string; id: string };
  media: { name: string };
  session: { title: string; id: string };
  newsletter?: { databaseName: string; databaseId: string; senderAddress: string; rateLimitNamespaceId: string };
  resendSegmentId?: string;
}

type JsonObject = Record<string, unknown>;
const D1_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const R2_PLACEHOLDER = "minastro-template-media";
const SESSION_PLACEHOLDER = "00000000000000000000000000000000";
const D1_NAME_PLACEHOLDER = "minastro-template-db";

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} configuration is not an object.`);
  return value as JsonObject;
}

function ensureD1Entry(config: JsonObject, binding: string, name: string, id: string, migrationsDir?: string) {
  const entries = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const existing = entries.find((entry) => asObject(entry, "D1").binding === binding);
  const desired: JsonObject = { binding, database_name: name, database_id: id };
  if (migrationsDir) desired.migrations_dir = migrationsDir;
  if (existing) {
    const object = asObject(existing, "D1");
    for (const [key, value] of Object.entries(desired)) {
      const current = object[key];
      const placeholder = key === "database_name" ? D1_NAME_PLACEHOLDER : key === "database_id" ? D1_PLACEHOLDER : undefined;
      if (current === undefined) {
        if (key !== "migrations_dir") throw new Error(`D1 binding ${binding} is missing ${key}; refusing to infer its intended resource.`);
        object[key] = value;
        continue;
      }
      if (current !== value && current !== placeholder) throw new Error(`D1 binding ${binding} conflicts with existing ${key}.`);
      object[key] = value;
    }
  } else {
    entries.push(desired);
  }
  config.d1_databases = entries;
}

export function reconcileWranglerConfig(source: string, input: ConfigReconcileInput): string {
  const config = parseJsonc<JsonObject>(source, "wrangler.jsonc");
  if (config.account_id !== undefined && config.account_id !== input.accountId) throw new Error("Configured Cloudflare account ID conflicts with the approved account.");
  config.account_id = input.accountId;
  if (typeof config.name === "string" && config.name !== input.workerName && config.name !== "minastro-template") throw new Error("Configured Worker name conflicts with the approved provisioning plan.");
  config.name = input.workerName;
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const existingRoute = routes.find((entry) => asObject(entry, "Worker route").pattern === input.canonicalHostname);
  if (existingRoute) {
    const object = asObject(existingRoute, "Worker route");
    if (object.custom_domain !== true || (object.script !== undefined && object.script !== input.workerName)) throw new Error("The canonical Worker route conflicts with the approved Worker attachment.");
    object.custom_domain = true;
  } else {
    routes.push({ pattern: input.canonicalHostname, custom_domain: true });
  }
  config.routes = routes;
  ensureD1Entry(config, "DB", input.coreD1.name, input.coreD1.id);
  const r2 = Array.isArray(config.r2_buckets) ? config.r2_buckets : [];
  const existingR2 = r2.find((entry) => asObject(entry, "R2").binding === "MEDIA");
  if (existingR2) {
    const object = asObject(existingR2, "R2");
    if (object.bucket_name !== input.media.name && object.bucket_name !== R2_PLACEHOLDER) throw new Error("R2 MEDIA binding conflicts with the approved bucket.");
    object.bucket_name = input.media.name;
  } else r2.push({ binding: "MEDIA", bucket_name: input.media.name });
  config.r2_buckets = r2;
  const kv = Array.isArray(config.kv_namespaces) ? config.kv_namespaces : [];
  const existingKv = kv.find((entry) => asObject(entry, "KV").binding === "SESSION");
  if (existingKv) {
    const object = asObject(existingKv, "KV");
    if (object.id !== input.session.id && object.id !== SESSION_PLACEHOLDER) throw new Error("KV SESSION binding conflicts with the approved namespace.");
    object.id = input.session.id;
  } else kv.push({ binding: "SESSION", id: input.session.id });
  config.kv_namespaces = kv;

  if (input.newsletter) {
    ensureD1Entry(config, "NEWSLETTER_DB", input.newsletter.databaseName, input.newsletter.databaseId, "newsletter-migrations");
    const sendEmail = Array.isArray(config.send_email) ? config.send_email : [];
    const email = sendEmail.find((entry) => asObject(entry, "Email binding").name === "NEWSLETTER_EMAIL");
    if (email) {
      const object = asObject(email, "Email binding");
      if (object.remote !== undefined && object.remote !== true) throw new Error("NEWSLETTER_EMAIL conflicts with the required remote Email Sending binding.");
      const senders = object.allowed_sender_addresses;
      if (senders !== undefined && (!Array.isArray(senders) || (!senders.includes(input.newsletter.senderAddress)))) throw new Error("NEWSLETTER_EMAIL does not allow the approved sender address.");
      object.remote = true;
      object.allowed_sender_addresses = [input.newsletter.senderAddress];
    } else sendEmail.push({ name: "NEWSLETTER_EMAIL", remote: true, allowed_sender_addresses: [input.newsletter.senderAddress] });
    config.send_email = sendEmail;
    const ratelimits = Array.isArray(config.ratelimits) ? config.ratelimits : [];
    const limiter = ratelimits.find((entry) => asObject(entry, "Rate limiter").name === "NEWSLETTER_SUBSCRIBE_LIMITER");
    const desiredNamespace = Number(input.newsletter.rateLimitNamespaceId);
    if (!Number.isSafeInteger(desiredNamespace) || desiredNamespace <= 0) throw new Error("The approved rate-limit namespace ID is invalid.");
    if (limiter) {
      const object = asObject(limiter, "Rate limiter");
      if (object.namespace_id !== undefined && object.namespace_id !== desiredNamespace) throw new Error("NEWSLETTER_SUBSCRIBE_LIMITER conflicts with the approved namespace.");
      object.namespace_id = desiredNamespace;
      object.simple = object.simple ?? { limit: 5, period: 60 };
    } else ratelimits.push({ name: "NEWSLETTER_SUBSCRIBE_LIMITER", namespace_id: desiredNamespace, simple: { limit: 5, period: 60 } });
    config.ratelimits = ratelimits;
  }

  if (input.resendSegmentId) {
    const vars = asObject(config.vars ?? {}, "vars");
    if (vars.RESEND_SEGMENT_ID !== undefined && vars.RESEND_SEGMENT_ID !== input.resendSegmentId) throw new Error("RESEND_SEGMENT_ID conflicts with the approved provisioning plan.");
    vars.RESEND_SEGMENT_ID = input.resendSegmentId;
    config.vars = vars;
  }
  return editJsoncObject(source, config, "wrangler.jsonc");
}

function parsedJson(output: string, label: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON; refusing to infer remote state.`);
  }
}

export function rowsFromD1ExecuteJson(output: string): Record<string, unknown>[] {
  const parsed = parsedJson(output, "D1 execute");
  const findRows = (value: unknown): unknown[] | null => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const rows = findRows(item);
        if (rows) return rows;
      }
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    const object = value as Record<string, unknown>;
    if (object.success === false) throw new Error("D1 execute reported failure; refusing to infer database state.");
    if (Array.isArray(object.results)) return object.results;
    if (object.result !== undefined) return findRows(object.result);
    return null;
  };
  const rows = findRows(parsed);
  if (!rows) throw new Error("D1 execute returned no result rows; refusing to infer database state.");
  return rows.map((row) => asObject(row, "D1 result row"));
}

function migrationName(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const object = entry as Record<string, unknown>;
  const name = object.name ?? object.Name ?? object.filename ?? object.migration ?? object.migration_name ?? object.migrationName;
  return typeof name === "string" ? name : null;
}

export function migrationNamesFromD1ExecuteJson(output: string): Set<string> {
  return new Set(rowsFromD1ExecuteJson(output).flatMap((row) => {
    const name = migrationName(row);
    return name ? [name] : [];
  }));
}
