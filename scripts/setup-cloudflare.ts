import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  JOURNAL_DIRECTORY,
  type CommandOptions,
  createProvisioningJournal,
  defaultProvisioningFileSystem,
  journalIsNonSecret,
  loadProvisioningJournal,
  migrationNamesFromD1ExecuteJson,
  parseJsonc,
  provisioningJournalPath,
  provisioningLockPath,
  reconcileWranglerConfig,
  resolveUniqueResource,
  rowsFromD1ExecuteJson,
  saveProvisioningJournal,
  type ProvisioningFileSystem,
  type ProvisioningJournal,
  type ResourceJournal,
  type BindingJournal,
} from "./setup-cloudflare-lib";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const D1_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const R2_PLACEHOLDER = "minastro-template-media";
const WORKER_PLACEHOLDER = "minastro-template";
const SESSION_PLACEHOLDER = "00000000000000000000000000000000";
const D1_NAME_PLACEHOLDER = "minastro-template-db";

type Prompt = (question: string) => Promise<string>;
type HandoffResult = { opened: boolean; copied: boolean };
type AccountFetch = (url: string, init?: RequestInit) => Promise<Response>;
type SecretTerminal = {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  pause: () => void;
  resume: () => void;
  on: (event: "data", listener: (chunk: Buffer | string) => void) => void;
  removeListener: (event: "data", listener: (chunk: Buffer | string) => void) => void;
};

export interface ReadlineHandle {
  close: () => void;
}

export interface SetupRuntime {
  fs: ProvisioningFileSystem;
  apiToken?: string;
  approvedAccountId?: string;
  apiFetch: AccountFetch;
  originFetch: AccountFetch;
  run: (command: string[], options?: CommandOptions) => Promise<string>;
  runInteractive: (command: string[], options?: CommandOptions) => Promise<void>;
  prompt: Prompt;
  promptSecret: Prompt;
  copySecret: (secret: string) => Promise<boolean>;
  clearClipboard: () => Promise<void>;
  handoff: (origin: string, secret: string) => Promise<HandoffResult>;
  close?: () => void;
}

export interface DatabaseState {
  schemaInitialized: boolean;
  setupComplete: boolean;
  administratorExists: boolean;
  established: boolean;
}

export interface Plan {
  newCore: boolean;
  bootstrapRequested: boolean;
  cmsState: "empty" | "incomplete" | "complete";
  workerName: string;
  d1Name: string;
  r2Name: string;
  kvTitle: string;
  canonicalOrigin: string;
  newsletter: {
    enabled: boolean;
    newFeature: boolean;
    databaseName: string;
    databaseId?: string;
    senderAddress: string;
    turnstileSiteKey: string;
    expectedHostname: string;
    consentVersion: string;
    rateLimitNamespaceId: string;
  };
  resend: {
    enabled: boolean;
    segmentId?: string;
  };
}

type Resource = { id: string; name: string };
type CoreState = "fresh" | "configured";

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
}

function generateBootstrapSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function externalCommand(kind: "open" | "clipboard", value: string): string[] | null {
  if (kind === "open") {
    if (process.platform === "darwin") return ["open", value];
    if (process.platform === "linux") return ["xdg-open", value];
    if (process.platform === "win32") return ["cmd.exe", "/c", "start", "", value];
    return null;
  }
  if (process.platform === "darwin") return ["pbcopy"];
  if (process.platform === "linux") return ["wl-copy"];
  if (process.platform === "win32") return ["clip"];
  return null;
}

async function runExternal(kind: "open" | "clipboard", value: string): Promise<boolean> {
  const command = externalCommand(kind, value);
  if (!command) return false;
  try {
    const child = Bun.spawn({
      cmd: command,
      stdin: kind === "clipboard" ? new Blob([value]) : "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

export async function hiddenPrompt(question: string, terminal: SecretTerminal = input as SecretTerminal, writer: Pick<typeof output, "write"> = output): Promise<string> {
  if (!terminal.isTTY || typeof terminal.setRawMode !== "function") throw new Error("Safe secret input is unavailable because this process is not attached to an interactive TTY.");
  writer.write(question);
  let value = "";
  let finished = false;
  let resolveValue: ((value: string) => void) | undefined;
  let rejectValue: ((error: Error) => void) | undefined;
  const restore = () => {
    if (finished) return;
    finished = true;
    terminal.removeListener("data", onData);
    terminal.setRawMode?.(false);
    terminal.pause();
    writer.write("\n");
  };
  const onData = (chunk: Buffer | string) => {
    for (const character of String(chunk)) {
      if (character === "\u0003") {
        restore();
        rejectValue?.(new Error("Secret input cancelled."));
        return;
      }
      if (character === "\r" || character === "\n") {
        restore();
        resolveValue?.(value);
        return;
      }
      if (character === "\u0008" || character === "\u007f") {
        value = value.slice(0, -1);
        continue;
      }
      if (character >= " ") value += character;
    }
  };
  try {
    return await new Promise<string>((resolve, reject) => {
      resolveValue = resolve;
      rejectValue = reject;
      terminal.setRawMode?.(true);
      terminal.resume();
      terminal.on("data", onData);
    });
  } finally {
    restore();
  }
}

export async function promptSecretDetached(
  question: string,
  session: { get: () => ReadlineHandle; replace: (next: ReadlineHandle) => void },
  recreate: () => ReadlineHandle,
  terminal: SecretTerminal = input as SecretTerminal,
  writer: Pick<typeof output, "write"> = output,
): Promise<string> {
  session.get().close();
  try {
    return await hiddenPrompt(question, terminal, writer);
  } finally {
    session.replace(recreate());
  }
}

function defaultRuntime(readline: ReturnType<typeof createInterface>): SetupRuntime {
  let activeReadline = readline;
  const recreateReadline = () => createInterface({ input, output });
  return {
    fs: defaultProvisioningFileSystem(),
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    approvedAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiFetch: (url, init) => fetch(url, init),
    originFetch: (url, init) => fetch(url, init),
    async run(command, options = {}) {
      const environment: Record<string, string> = { ...process.env } as Record<string, string>;
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === undefined) delete environment[key];
        else environment[key] = value;
      }
      const child = Bun.spawn({
        cmd: command,
        cwd: PROJECT_ROOT,
        env: environment,
        stdin: options.input ? new Blob([options.input]) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, _stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`${command.join(" ")} failed.`);
      if (!options.quiet && stdout.trim()) console.log(stdout.trim());
      return stdout.trim();
    },
    async runInteractive(command, options = {}) {
      const environment: Record<string, string> = { ...process.env } as Record<string, string>;
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === undefined) delete environment[key];
        else environment[key] = value;
      }
      const child = Bun.spawn({ cmd: command, cwd: PROJECT_ROOT, env: environment, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed.`);
    },
    prompt: (question) => activeReadline.question(question),
    promptSecret: (question) => promptSecretDetached(question, {
      get: () => activeReadline,
      replace: (next) => { activeReadline = next as ReturnType<typeof createInterface>; },
    }, recreateReadline),
    copySecret: (secret) => runExternal("clipboard", secret),
    clearClipboard: async () => {
      await runExternal("clipboard", "");
    },
    async handoff(origin, secret) {
      const url = new URL("/_emdash/admin/setup", origin);
      url.searchParams.set("bootstrap", secret);
      const copied = await runExternal("clipboard", url.toString());
      const opened = await runExternal("open", url.toString());
      return { opened, copied };
    },
    close: () => activeReadline.close(),
  };
}

function parseJson<T>(output: string, label: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`${label} did not return valid JSON; refusing to infer remote state.`);
  }
}

function arrayOutput(output: string, label: string): Record<string, unknown>[] {
  const parsed = parseJson<unknown>(output, label);
  const entries = Array.isArray(parsed) ? parsed : (parsed as { result?: unknown }).result;
  if (!Array.isArray(entries)) throw new Error(`${label} returned no usable resource list.`);
  return entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${label} returned an unknown resource shape.`);
    return entry as Record<string, unknown>;
  });
}

function accountId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) throw new Error("The approved Cloudflare account ID must be a 32-character hexadecimal ID.");
  return normalized;
}

async function verifyAccount(runtime: SetupRuntime, id: string) {
  if (!runtime.apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required and must be supplied through the environment; setup never stores it.");
  let body: unknown;
  try {
    const response = await runtime.apiFetch(`${CLOUDFLARE_API}/accounts/${id}`, { headers: { Authorization: `Bearer ${runtime.apiToken}` } });
    body = await response.json();
    if (!response.ok) throw new Error();
  } catch {
    throw new Error("The Cloudflare API token could not verify the approved account. Check the token scopes and account ID; the token was not persisted.");
  }
  const result = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
  const returnedId = typeof result === "object" && result !== null ? (result as { id?: unknown }).id : undefined;
  if ((body as { success?: unknown } | null)?.success !== true || returnedId !== id) throw new Error("The Cloudflare API token does not grant access to the approved account ID.");
}

function wranglerCommand(root: string, args: string[]) {
  return ["bunx", "wrangler", "--config", join(root, "wrangler.jsonc"), ...args];
}

function wranglerOptions(runtime: SetupRuntime, account: string, options: CommandOptions = {}): CommandOptions {
  if (!runtime.apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required for Wrangler operations.");
  return { ...options, env: { ...options.env, CLOUDFLARE_API_TOKEN: runtime.apiToken, CLOUDFLARE_ACCOUNT_ID: account } };
}

async function runWrangler(runtime: SetupRuntime, root: string, account: string, args: string[], options: CommandOptions = {}) {
  return runtime.run(wranglerCommand(root, args), wranglerOptions(runtime, account, options));
}

async function runWranglerInteractive(runtime: SetupRuntime, root: string, account: string, args: string[], options: CommandOptions = {}) {
  return runtime.runInteractive(wranglerCommand(root, args), wranglerOptions(runtime, account, options));
}

function canonicalOriginFromSource(source: string): string | null {
  const match = source.match(/\burl:\s*"([^"]+)"/);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    if (url.protocol !== "https:" || url.hostname.endsWith(".workers.dev") || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function requireCanonicalOrigin(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname.endsWith(".workers.dev") || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error();
    return url.origin;
  } catch {
    throw new Error("The canonical origin must be an HTTPS origin and cannot be a workers.dev URL.");
  }
}

function configObject(source: string): Record<string, unknown> {
  return parseJsonc<Record<string, unknown>>(source, "wrangler.jsonc");
}

function objectEntry(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object.`);
  return value as Record<string, unknown>;
}

function bindingEntry(config: Record<string, unknown>, collection: string, property: string, value: string): Record<string, unknown> | undefined {
  const entries = config[collection];
  if (!Array.isArray(entries)) return undefined;
  const match = entries.find((entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)[property] === value);
  return match && typeof match === "object" ? match as Record<string, unknown> : undefined;
}

function textConfigValue(source: string, property: string): string | null {
  return source.match(new RegExp(`\\b${property}:\\s*"([^"]*)"`))?.[1] ?? null;
}

function hostname(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^(localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})$/.test(normalized)) throw new Error("Enter a hostname only, without a protocol, path, or port.");
  return normalized;
}

function emailAddress(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Enter a valid sender email address.");
  return normalized;
}

function positiveInteger(value: string) {
  if (!/^[1-9]\d*$/.test(value.trim())) throw new Error("The rate-limit namespace ID must be a positive integer.");
  return value.trim();
}

function coreConfigurationState(config: Record<string, unknown>): CoreState {
  const d1 = bindingEntry(config, "d1_databases", "binding", "DB");
  const r2 = bindingEntry(config, "r2_buckets", "binding", "MEDIA");
  const kv = bindingEntry(config, "kv_namespaces", "binding", "SESSION");
  if (!d1 || !r2 || !kv) throw new Error("wrangler.jsonc is missing a required core binding; refusing to infer whether this is a fresh clone.");
  const values = [config.name, d1.database_name, d1.database_id, r2.bucket_name, kv.id];
  const placeholders = [WORKER_PLACEHOLDER, D1_NAME_PLACEHOLDER, D1_PLACEHOLDER, R2_PLACEHOLDER, SESSION_PLACEHOLDER];
  const isFresh = values.every((value, index) => value === placeholders[index]);
  if (isFresh) return "fresh";
  const configured = values.every((value) => typeof value === "string" && value.length > 0) && values.every((value, index) => value !== placeholders[index]);
  if (configured) return "configured";
  throw new Error("wrangler.jsonc contains partial or unrecognized core placeholders. Resolve it manually before provisioning to avoid duplicate resources.");
}

function databaseStateLabel(state: DatabaseState): Plan["cmsState"] {
  if (!state.schemaInitialized) return "empty";
  if (state.established) return "complete";
  return "incomplete";
}

function planSummary(plan: Plan) {
  return JSON.stringify({
    workerName: plan.workerName,
    d1Name: plan.d1Name,
    r2Name: plan.r2Name,
    kvTitle: plan.kvTitle,
    canonicalOrigin: plan.canonicalOrigin,
    cmsState: plan.cmsState,
    bootstrapRequested: plan.bootstrapRequested,
    newsletter: plan.newsletter.enabled ? {
      enabled: true,
      newFeature: plan.newsletter.newFeature,
      databaseName: plan.newsletter.databaseName,
      senderAddress: plan.newsletter.senderAddress,
      turnstileSiteKey: plan.newsletter.turnstileSiteKey,
      expectedHostname: plan.newsletter.expectedHostname,
      consentVersion: plan.newsletter.consentVersion,
      rateLimitNamespaceId: plan.newsletter.rateLimitNamespaceId,
    } : { enabled: false },
    resend: plan.resend.enabled ? { enabled: true, segmentId: plan.resend.segmentId } : { enabled: false },
  }, null, 2);
}

async function promptPlan(runtime: SetupRuntime, config: Record<string, unknown>, siteSource: string, existing: ProvisioningJournal | undefined, workerOverride: string, coreState: CoreState, databaseState: DatabaseState | undefined): Promise<Plan> {
  if (existing) {
    const plan = { ...(existing.plan as unknown as Plan) };
    if (databaseState) {
      plan.cmsState = databaseStateLabel(databaseState);
      if (databaseState.established) {
        plan.bootstrapRequested = false;
      } else {
        plan.bootstrapRequested = /^y(es)?$/i.test((await runtime.prompt("The current CMS database is not fully initialized. Prepare a first-admin bootstrap handoff for this current state? [y/N] ")).trim());
      }
    }
    console.log(`Resuming the approved provisioning plan after current-state inspection:\n${planSummary(plan)}`);
    if (!/^y(es)?$/i.test((await runtime.prompt("Resume this plan after revalidating remote state? [y/N] ")).trim())) throw new Error("Provisioning resume cancelled.");
    return plan;
  }

  const currentName = typeof config.name === "string" && config.name !== WORKER_PLACEHOLDER ? config.name : "";
  const workerName = normalizeName(workerOverride || currentName || await runtime.prompt("Worker name [my-site]: ") || "my-site");
  if (!workerName) throw new Error("Worker name must include at least one letter or number.");
  const d1 = bindingEntry(config, "d1_databases", "binding", "DB");
  const r2 = bindingEntry(config, "r2_buckets", "binding", "MEDIA");
  const d1Name = coreState === "fresh" ? normalizeName(await runtime.prompt(`D1 database name [${workerName}-db]: `) || `${workerName}-db`) : String(d1?.database_name);
  const r2Name = coreState === "fresh" ? normalizeName(await runtime.prompt(`R2 bucket name [${workerName}-media]: `) || `${workerName}-media`) : String(r2?.bucket_name);
  const kvTitle = coreState === "fresh" ? `${workerName}-sessions` : `${workerName}-sessions`;
  const canonical = canonicalOriginFromSource(siteSource) ?? requireCanonicalOrigin(await runtime.prompt("Canonical HTTPS origin: "));
  const newCore = coreState === "fresh";
  const cmsState: Plan["cmsState"] = newCore ? "empty" : databaseState ? databaseStateLabel(databaseState) : "incomplete";
  let bootstrapRequested = false;
  if (newCore) bootstrapRequested = /^y(es)?$/i.test((await runtime.prompt("Prepare a first-admin bootstrap handoff for this new site? [y/N] ")).trim());
  else if (databaseState?.established) bootstrapRequested = false;
  else bootstrapRequested = /^y(es)?$/i.test((await runtime.prompt("The current CMS database is not fully initialized. Prepare a first-admin bootstrap handoff? [y/N] ")).trim());

  const newsletterBinding = bindingEntry(config, "d1_databases", "binding", "NEWSLETTER_DB");
  let newsletterEnabled = Boolean(newsletterBinding);
  if (!newsletterEnabled) {
    if (textConfigValue(siteSource, "enabled") === "true") throw new Error("src/site.config.ts enables the newsletter but NEWSLETTER_DB is not configured; opt in to complete setup or disable it manually.");
    newsletterEnabled = /^y(es)?$/i.test((await runtime.prompt("Configure the newsletter now? [y/N] ")).trim());
  }
  const senderCandidate = textConfigValue(siteSource, "senderAddress");
  const hostnameCandidate = textConfigValue(siteSource, "expectedHostname");
  const newsletter = newsletterEnabled ? {
    enabled: true,
    newFeature: !newsletterBinding,
    databaseName: typeof newsletterBinding?.database_name === "string" ? newsletterBinding.database_name : `${workerName}-newsletter`,
    databaseId: typeof newsletterBinding?.database_id === "string" && newsletterBinding.database_id !== D1_PLACEHOLDER ? newsletterBinding.database_id : undefined,
    senderAddress: emailAddress(!senderCandidate || senderCandidate === "newsletter@your-domain.com" ? await runtime.prompt("Verified newsletter sender address: ") : senderCandidate),
    turnstileSiteKey: textConfigValue(siteSource, "turnstileSiteKey") || (await runtime.prompt("Turnstile site key: ")).trim(),
    expectedHostname: hostname(!hostnameCandidate || hostnameCandidate === "your-domain.com" ? await runtime.prompt("Turnstile hostname: ") : hostnameCandidate),
    consentVersion: textConfigValue(siteSource, "consentVersion") || "1.0",
    rateLimitNamespaceId: (() => {
      const rate = bindingEntry(config, "ratelimits", "name", "NEWSLETTER_SUBSCRIBE_LIMITER");
      return typeof rate?.namespace_id === "number" || typeof rate?.namespace_id === "string" ? String(rate.namespace_id) : "";
    })(),
  } : {
    enabled: false,
    newFeature: false,
    databaseName: "",
    senderAddress: "",
    turnstileSiteKey: "",
    expectedHostname: "",
    consentVersion: "1.0",
    rateLimitNamespaceId: "",
  };
  if (newsletter.enabled && !newsletter.rateLimitNamespaceId) newsletter.rateLimitNamespaceId = positiveInteger(await runtime.prompt("Rate-limit namespace ID: "));
  const existingSegment = objectEntry(config.vars ?? {}, "vars").RESEND_SEGMENT_ID;
  let resendEnabled = typeof existingSegment === "string" && existingSegment.length > 0;
  if (!resendEnabled && newsletter.enabled) resendEnabled = /^y(es)?$/i.test((await runtime.prompt("Configure Resend Segment synchronization? [y/N] ")).trim());
  const resend = resendEnabled ? { enabled: true, segmentId: typeof existingSegment === "string" && existingSegment ? existingSegment : (await runtime.prompt("Resend Segment ID: ")).trim() } : { enabled: false };
  if (resend.enabled && !resend.segmentId) throw new Error("A Resend Segment ID is required.");

  const plan: Plan = { newCore, bootstrapRequested, cmsState, workerName, d1Name, r2Name, kvTitle, canonicalOrigin: canonical, newsletter, resend };
  console.log(`\nApproved provisioning creates only explicitly listed resources; no automatic rollback or deletion is performed.\n${planSummary(plan)}`);
  if (!/^y(es)?$/i.test((await runtime.prompt("Approve this complete provisioning plan? [y/N] ")).trim())) throw new Error("Provisioning plan rejected.");
  return plan;
}

async function save(runtime: SetupRuntime, path: string, journal: ProvisioningJournal) {
  if (!journalIsNonSecret(journal)) throw new Error("Refusing to write secret material to the provisioning journal.");
  await saveProvisioningJournal(runtime.fs, path, journal);
}

async function markDeploymentPending(runtime: SetupRuntime, path: string, journal: ProvisioningJournal) {
  if (!journal.pending.deployment) {
    journal.pending.deployment = true;
    journal.deploymentRevision += 1;
  }
  journal.pending.triggers = true;
  await save(runtime, path, journal);
}

function createResourceJournal(name: string, id?: string): ResourceJournal {
  return { intendedName: name, id, status: "pending", createAttempted: false, adopted: false };
}

async function apiList(runtime: SetupRuntime, account: string, endpoint: string, label: string): Promise<Record<string, unknown>[]> {
  if (!runtime.apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required for account API operations.");
  if (!endpoint.startsWith(`/accounts/${account}/`)) throw new Error(`Cloudflare account API endpoint is outside the approved account for ${label}.`);
  const resources: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page += 1) {
    let body: unknown;
    try {
      const separator = endpoint.includes("?") ? "&" : "?";
      const response = await runtime.apiFetch(`${CLOUDFLARE_API}${endpoint}${separator}page=${page}&per_page=1000`, { headers: { Authorization: `Bearer ${runtime.apiToken}` } });
      body = await response.json();
      if (!response.ok) throw new Error();
    } catch {
      throw new Error(`Cloudflare account API discovery failed for ${label}; remote state was not inferred.`);
    }
    const result = typeof body === "object" && body !== null ? (body as { success?: unknown; result?: unknown; result_info?: unknown }) : {};
    if (result.success !== true || !Array.isArray(result.result)) throw new Error(`Cloudflare account API returned an unusable ${label} response; remote state was not inferred.`);
    resources.push(...result.result.map((entry) => objectEntry(entry, label)));
    const info = typeof result.result_info === "object" && result.result_info !== null ? result.result_info as { total_pages?: unknown } : {};
    if (typeof info.total_pages !== "number" || page >= info.total_pages) return resources;
  }
  throw new Error(`Cloudflare account API returned more than 100 pages for ${label}; refusing to infer complete remote state.`);
}

async function listD1(runtime: SetupRuntime, root: string, account: string): Promise<Resource[]> {
  return arrayOutput(await runWrangler(runtime, root, account, ["d1", "list", "--json"], { quiet: true }), "D1 list").map((entry) => ({ id: String(entry.uuid ?? entry.database_id ?? ""), name: String(entry.name ?? "") }));
}

async function listR2(runtime: SetupRuntime, account: string): Promise<Resource[]> {
  if (!runtime.apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required for account API operations.");
  const resources: Resource[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= 100; page += 1) {
    let body: unknown;
    try {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await runtime.apiFetch(`${CLOUDFLARE_API}/accounts/${account}/r2/buckets${query}`, { headers: { Authorization: `Bearer ${runtime.apiToken}` } });
      body = await response.json();
      if (!response.ok) throw new Error();
    } catch {
      throw new Error("Cloudflare account API discovery failed for R2 buckets; remote state was not inferred.");
    }
    const result = typeof body === "object" && body !== null ? (body as { success?: unknown; result?: unknown }) : {};
    const buckets = typeof result.result === "object" && result.result !== null ? (result.result as { buckets?: unknown }).buckets : undefined;
    if (result.success !== true || !Array.isArray(buckets)) throw new Error("Cloudflare R2 List Buckets returned an unusable response; remote state was not inferred.");
    resources.push(...buckets.map((entry) => {
      const object = objectEntry(entry, "R2 bucket");
      return { id: String(object.name ?? ""), name: String(object.name ?? "") };
    }));
    const resultObject = result.result as { truncated?: unknown; cursor?: unknown };
    if (resultObject.truncated !== true) return resources;
    if (typeof resultObject.cursor !== "string" || !resultObject.cursor) throw new Error("Cloudflare R2 List Buckets reported a truncated page without a cursor.");
    cursor = resultObject.cursor;
  }
  throw new Error("Cloudflare R2 List Buckets returned more than 100 pages; refusing to infer complete remote state.");
}

async function listKv(runtime: SetupRuntime, account: string): Promise<Resource[]> {
  return (await apiList(runtime, account, `/accounts/${account}/storage/kv/namespaces`, "KV namespace list")).map((entry) => ({ id: String(entry.id ?? ""), name: String(entry.title ?? "") }));
}

async function resolveJournalResource(
  runtime: SetupRuntime,
  journal: ProvisioningJournal,
  journalPath: string,
  key: string,
  options: Omit<Parameters<typeof resolveUniqueResource<Resource>>[0], "creationAttempted" | "adoptionApproved" | "create"> & { create: () => Promise<void> },
) {
  const record = journal.resources[key];
  if (!record) throw new Error(`Provisioning journal has no ${key} resource record.`);
  const resolve = (adoptionApproved: boolean) => resolveUniqueResource({
    ...options,
    configuredId: record.id && record.id !== D1_PLACEHOLDER && record.id !== R2_PLACEHOLDER && record.id !== SESSION_PLACEHOLDER ? record.id : undefined,
    creationAttempted: record.createAttempted,
    adoptionApproved,
    async create() {
      record.createAttempted = true;
      await save(runtime, journalPath, journal);
      await options.create();
    },
  });
  let resolved: Resource;
  try {
    resolved = await resolve(record.adopted || record.createAttempted);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("requires explicit adoption")) throw error;
    const approved = await runtime.prompt(`A same-name ${options.kind} already exists remotely. Adopt it for this approved account and plan? [y/N] `);
    if (!/^y(es)?$/i.test(approved.trim())) throw new Error(`Existing ${options.kind} was not adopted; no replacement will be created.`);
    record.adopted = true;
    await save(runtime, journalPath, journal);
    resolved = await resolve(true);
  }
  const identity = options.identity(resolved);
  record.id = identity.id;
  record.status = "verified";
  record.adopted = true;
  await save(runtime, journalPath, journal);
  return resolved;
}

async function promptSavedSecret(runtime: SetupRuntime, name: string): Promise<string> {
  const value = (await runtime.promptSecret(`Enter the saved ${name} value; input is hidden and the value is not stored by setup: `)).trim();
  if (!value) throw new Error(`${name} is required to resume the pending secret operation. Recover it from the password manager before continuing.`);
  return value;
}

async function custodySecret(runtime: SetupRuntime, journal: ProvisioningJournal, journalPath: string, name: string, value: string): Promise<string> {
  journal.secrets[name] = "custody_pending";
  await save(runtime, journalPath, journal);
  if (!await runtime.copySecret(value)) throw new Error(`${name} was generated but could not be copied for password-manager custody; no upload was attempted.`);
  const saved = await runtime.prompt(`Save ${name} in the password manager, then type SAVED to continue: `);
  await runtime.clearClipboard();
  if (saved.trim().toUpperCase() !== "SAVED") throw new Error(`${name} was not confirmed saved; no upload was attempted.`);
  return value;
}

async function uploadSecret(
  runtime: SetupRuntime,
  journal: ProvisioningJournal,
  journalPath: string,
  root: string,
  account: string,
  workerName: string,
  plan: Plan,
  expected: BindingExpectation[],
  name: string,
  value: string,
) {
  if (!journal.preparedVersion?.versionId) throw new Error(`${name} cannot be added before a prepared Worker version exists.`);
  await markDeploymentPending(runtime, journalPath, journal);
  journal.secrets[name] = "upload_pending";
  const revision = journal.preparedVersion.revision;
  const bindingTagBytes = crypto.getRandomValues(new Uint8Array(4));
  const tag = `${journal.preparedVersion.tag}-binding-${Array.from(bindingTagBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  journal.preparedVersion = { versionId: "", tag, createdOn: "", revision };
  await save(runtime, journalPath, journal);
  try {
    await runWrangler(runtime, root, account, ["versions", "secret", "put", name, "--name", workerName, "--tag", tag, "--message", tag], { input: `${value}\n`, quiet: true });
  } catch {
    throw new Error(`${name} upload did not complete; rerun setup with the saved value. No replacement was generated.`);
  }
  const versions = versionEntries(await runWrangler(runtime, root, account, ["versions", "list", "--name", workerName, "--json"], { quiet: true }));
  const tagged = versions.filter((entry) => findTag(entry) === tag);
  if (tagged.length !== 1) throw new Error(`${name} upload did not resolve to exactly one prepared version; deployment remains pending.`);
  const id = versionId(tagged[0]);
  if (!id) throw new Error(`${name} upload produced no version identity; deployment remains pending.`);
  journal.preparedVersion = { versionId: id, tag, createdOn: metadataCreatedOn(tagged[0]), revision: journal.preparedVersion.revision };
  await inspectVersion(runtime, root, account, plan, id, expected);
  journal.secrets[name] = "verified";
  await save(runtime, journalPath, journal);
}

export async function ensureSecret(
  runtime: SetupRuntime,
  journal: ProvisioningJournal,
  journalPath: string,
  root: string,
  account: string,
  workerName: string,
  name: string,
  options: { allowGenerate: boolean; generate: () => Promise<string> },
  names: Set<string>,
  plan: Plan,
  expected: BindingExpectation[],
) {
  if (names.has(name)) {
    journal.secrets[name] = "verified";
    await save(runtime, journalPath, journal);
    return;
  }
  if (journal.secrets[name] && journal.secrets[name] !== "unknown") {
    await uploadSecret(runtime, journal, journalPath, root, account, workerName, plan, expected, name, await promptSavedSecret(runtime, name));
    return;
  }
  if (!options.allowGenerate) throw new Error(`${name} is absent or unrecoverable on an established site. Recover it from the password manager; setup will not generate a replacement.`);
  await uploadSecret(runtime, journal, journalPath, root, account, workerName, plan, expected, name, await custodySecret(runtime, journal, journalPath, name, await options.generate()));
}

export async function ensureInteractiveSecret(
  runtime: SetupRuntime,
  journal: ProvisioningJournal,
  journalPath: string,
  root: string,
  account: string,
  workerName: string,
  name: string,
  plan: Plan,
  expected: BindingExpectation[],
) {
  const names = await secretNames(runtime, root, account, plan, journal.preparedVersion?.versionId ?? "", expected);
  if (names.has(name)) {
    journal.secrets[name] = "verified";
    await save(runtime, journalPath, journal);
    return;
  }
  await uploadSecret(runtime, journal, journalPath, root, account, workerName, plan, expected, name, await promptSavedSecret(runtime, name));
}

async function updateCanonicalSite(runtime: SetupRuntime, plan: Plan, path: string, beforeChange: () => Promise<void>): Promise<boolean> {
  const source = await runtime.fs.read(path);
  if (source === null) throw new Error("src/site.config.ts could not be read.");
  const current = canonicalOriginFromSource(source);
  if (current && current !== plan.canonicalOrigin) throw new Error("src/site.config.ts has a different canonical HTTPS origin than the approved plan.");
  if (current === plan.canonicalOrigin) return false;
  const match = source.match(/(\burl:\s*")([^"]+)(")/);
  if (!match) throw new Error("src/site.config.ts has no writable canonical url field.");
  await beforeChange();
  await runtime.fs.writeAtomic(path, source.replace(match[0], `${match[1]}${plan.canonicalOrigin}${match[3]}`));
  return true;
}

async function updateNewsletterSite(runtime: SetupRuntime, plan: Plan, path: string, beforeChange: () => Promise<void>): Promise<boolean> {
  if (!plan.newsletter.enabled) return false;
  const source = await runtime.fs.read(path);
  if (source === null) throw new Error("src/site.config.ts could not be read.");
  const start = source.lastIndexOf("newsletter: {");
  const end = source.indexOf("\n  },", start);
  if (start === -1 || end === -1) throw new Error("Could not find the newsletter configuration in src/site.config.ts.");
  let block = source.slice(start, end);
  const values: Record<string, string | boolean> = {
    enabled: true,
    senderAddress: plan.newsletter.senderAddress,
    turnstileSiteKey: plan.newsletter.turnstileSiteKey,
    consentVersion: plan.newsletter.consentVersion,
    expectedHostname: plan.newsletter.expectedHostname,
  };
  let changed = false;
  for (const [property, value] of Object.entries(values)) {
    const pattern = new RegExp(`(\\b${property}:\\s*)(true|false|"(?:[^"\\\\]|\\\\.)*")`);
    const match = block.match(pattern);
    if (!match) throw new Error(`Could not reconcile newsletter.${property}.`);
    const existing = match[2].replace(/^"|"$/g, "");
    const placeholders = property === "turnstileSiteKey" ? [""] : property === "senderAddress" ? ["newsletter@your-domain.com"] : property === "expectedHostname" ? ["your-domain.com"] : property === "consentVersion" ? ["1.0"] : ["false"];
    if (existing !== String(value) && !placeholders.includes(existing) && property !== "enabled") throw new Error(`newsletter.${property} conflicts with the approved plan.`);
    const replacement = `$1${typeof value === "boolean" ? value : JSON.stringify(value)}`;
    if (match[0] !== match[0].replace(pattern, replacement)) changed = true;
    block = block.replace(pattern, replacement);
  }
  if (!changed) return false;
  await beforeChange();
  await runtime.fs.writeAtomic(path, `${source.slice(0, start)}${block}${source.slice(end)}`);
  return true;
}

async function queryD1(runtime: SetupRuntime, root: string, account: string, database: string, sql: string) {
  return rowsFromD1ExecuteJson(await runWrangler(runtime, root, account, ["d1", "execute", database, "--remote", "--json", "--command", sql], { quiet: true }));
}

export async function inspectDatabaseInitialization(runtime: SetupRuntime, root: string, account: string, database: string): Promise<DatabaseState> {
  const tables = new Set((await queryD1(runtime, root, account, database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('options', 'users')")).flatMap((row) => typeof row.name === "string" ? [row.name] : []));
  let setupComplete = false;
  let administratorExists = false;
  if (tables.has("options")) {
    const option = (await queryD1(runtime, root, account, database, "SELECT value FROM options WHERE name = 'emdash:setup_complete' LIMIT 1"))[0]?.value;
    if (typeof option === "boolean") setupComplete = option;
    else if (typeof option === "string") {
      try {
        const parsed = JSON.parse(option);
        setupComplete = parsed === true || parsed === "true";
      } catch {
        setupComplete = false;
      }
    }
  }
  if (tables.has("users")) administratorExists = (await queryD1(runtime, root, account, database, "SELECT 1 AS present FROM users WHERE role >= 50 LIMIT 1")).length > 0;
  return { schemaInitialized: tables.size > 0, setupComplete, administratorExists, established: setupComplete && administratorExists };
}

async function confirmLegacyCutover(runtime: SetupRuntime, journal: ProvisioningJournal, path: string, plan: Plan, phase: string) {
  if (!plan.newsletter.enabled || !plan.resend.enabled || plan.newsletter.newFeature) return;
  const answer = await runtime.prompt(`Reconfirm legacy newsletter cutover safety before ${phase}: the old drainer is paused, every legacy outbox row is treated as potentially uncertain, and remote mutations are quiescent or explicitly quarantined. [y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error("Legacy newsletter cutover safety was not reconfirmed; no live operation was performed.");
  journal.milestones[`legacyCutover:${phase}`] = true;
  await save(runtime, path, journal);
}

export async function ensureMigrations(runtime: SetupRuntime, journal: ProvisioningJournal, journalPath: string, root: string, account: string, plan: Plan) {
  if (!plan.newsletter.enabled) return;
  const localFiles = (await runtime.fs.list(join(root, "newsletter-migrations"))).filter((name) => name.endsWith(".sql")).sort();
  if (localFiles.length === 0) throw new Error("No newsletter migration files were found; refusing to infer migration state.");
  const migrationTable = await queryD1(runtime, root, account, plan.newsletter.databaseName, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'");
  const applied = migrationNamesFromD1ExecuteJson(JSON.stringify({ results: migrationTable.length === 0 ? [] : await queryD1(runtime, root, account, plan.newsletter.databaseName, "SELECT name FROM d1_migrations ORDER BY id") }));
  const missing = localFiles.filter((file) => !applied.has(file));
  if (missing.length === 0) {
    journal.milestones.newsletterMigration = true;
    journal.milestones.newsletterMigrationPending = false;
    await save(runtime, journalPath, journal);
    return;
  }
  // Wrangler 4.125 exposes no JSON mode for `d1 migrations list`. The local
  // migration directory is therefore the authoritative pending-local set;
  // applied state comes only from the remote D1 ledger above.
  const target = "0004_newsletter_erasure.sql";
  await confirmLegacyCutover(runtime, journal, journalPath, plan, "migration");
  await markDeploymentPending(runtime, journalPath, journal);
  journal.milestones.newsletterMigrationPending = true;
  await save(runtime, journalPath, journal);
  try {
    await runWrangler(runtime, root, account, ["d1", "migrations", "apply", "NEWSLETTER_DB", "--remote"], { quiet: true });
  } catch {
    // The ledger query below is authoritative when the apply response was lost.
  }
  const afterTable = await queryD1(runtime, root, account, plan.newsletter.databaseName, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'");
  const after = migrationNamesFromD1ExecuteJson(JSON.stringify({ results: afterTable.length === 0 ? [] : await queryD1(runtime, root, account, plan.newsletter.databaseName, "SELECT name FROM d1_migrations ORDER BY id") }));
  if (!after.has(target) || localFiles.some((file) => !after.has(file))) throw new Error("The newsletter migrations were not fully confirmed in the remote D1 ledger; deployment remains pending.");
  journal.milestones.newsletterMigration = true;
  journal.milestones.newsletterMigrationPending = false;
  await save(runtime, journalPath, journal);
}

interface BindingExpectation {
  name: string;
  type: string;
  resourceId?: string;
}

interface VerifiedDeployment {
  versionId: string;
  deploymentId?: string;
  bindings: BindingJournal[];
  createdOn: string;
}

function requiredBindings(plan: Plan, resources: { coreD1: Resource; media: Resource; session: Resource; newsletterDb?: Resource }): BindingExpectation[] {
  return [
    { name: "DB", type: "d1", resourceId: resources.coreD1.id },
    { name: "MEDIA", type: "r2_bucket", resourceId: resources.media.name },
    { name: "SESSION", type: "kv_namespace", resourceId: resources.session.id },
    ...(plan.newsletter.enabled && resources.newsletterDb ? [
      { name: "NEWSLETTER_DB", type: "d1", resourceId: resources.newsletterDb.id },
      { name: "NEWSLETTER_EMAIL", type: "send_email" },
      { name: "NEWSLETTER_SUBSCRIBE_LIMITER", type: "ratelimit" },
    ] : []),
  ];
}

function versionEntries(output: string) {
  const parsed = parseJson<unknown>(output, "Wrangler versions list");
  if (Array.isArray(parsed)) return parsed.map((entry) => objectEntry(entry, "Wrangler version"));
  if (typeof parsed === "object" && parsed !== null) {
    const object = parsed as Record<string, unknown>;
    const values = object.result ?? object.versions;
    if (Array.isArray(values)) return values.map((entry) => objectEntry(entry, "Wrangler version"));
  }
  throw new Error("Wrangler versions list returned no usable versions.");
}

function deploymentEntries(output: string) {
  const parsed = parseJson<unknown>(output, "Wrangler deployments list");
  if (Array.isArray(parsed)) return parsed.map((entry) => objectEntry(entry, "Wrangler deployment"));
  if (typeof parsed === "object" && parsed !== null) {
    const object = parsed as Record<string, unknown>;
    const values = object.result ?? object.deployments;
    if (Array.isArray(values)) return values.map((entry) => objectEntry(entry, "Wrangler deployment"));
  }
  throw new Error("Wrangler deployments list returned no usable deployments.");
}

function stringField(object: Record<string, unknown>, ...keys: string[]): string | undefined {
  return keys.map((key) => object[key]).find((value): value is string => typeof value === "string" && value.length > 0);
}

function versionId(entry: Record<string, unknown>): string | undefined {
  return stringField(entry, "id", "version_id", "versionId");
}

function metadataCreatedOn(entry: Record<string, unknown>): string {
  const metadata = typeof entry.metadata === "object" && entry.metadata !== null ? entry.metadata as Record<string, unknown> : {};
  return stringField(metadata, "created_on", "createdOn") ?? stringField(entry, "created_on", "createdOn") ?? "";
}

function findTag(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const object = value as Record<string, unknown>;
  const annotations = typeof object.annotations === "object" && object.annotations !== null ? object.annotations as Record<string, unknown> : {};
  return typeof annotations["workers/tag"] === "string" && annotations["workers/tag"].length > 0
    ? annotations["workers/tag"]
    : undefined;
}

function deploymentCreatedOn(entry: Record<string, unknown>): string {
  return metadataCreatedOn(entry);
}

function deploymentTraffic(entry: Record<string, unknown>): Array<{ versionId: string; percentage: number }> {
  const versions = entry.versions;
  if (!Array.isArray(versions)) throw new Error("Deployment record has no traffic allocation; refusing to infer current traffic.");
  return versions.map((value) => {
    const object = objectEntry(value, "Deployment traffic allocation");
    const id = stringField(object, "version_id", "versionId", "id");
    const percentage = Number(object.percentage);
    if (!id || !Number.isFinite(percentage)) throw new Error("Deployment traffic allocation has an unknown shape; refusing to infer current traffic.");
    return { versionId: id, percentage };
  });
}

function bindingObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(bindingObjects);
  if (typeof value !== "object" || value === null) return [];
  const object = value as Record<string, unknown>;
  const name = stringField(object, "name", "binding");
  if (name && typeof object.type === "string") return [object];
  return Object.values(object).flatMap(bindingObjects);
}

function normalizeBindingType(type: string): string {
  const normalized = type.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.includes("d1")) return "d1";
  if (normalized.includes("r2")) return "r2_bucket";
  if (normalized.includes("kv")) return "kv_namespace";
  if (normalized.includes("secret")) return "secret_text";
  if (normalized.includes("email")) return "send_email";
  if (normalized.includes("rate")) return "ratelimit";
  return normalized;
}

function bindingResourceId(object: Record<string, unknown>): string | undefined {
  return stringField(object, "id", "database_id", "namespace_id", "bucket_name", "bucketName", "script_name", "script");
}

function inspectBindings(view: unknown): BindingJournal[] {
  return bindingObjects(view).map((object) => ({
    name: stringField(object, "name", "binding") ?? "",
    type: normalizeBindingType(String(object.type)),
    resourceId: bindingResourceId(object),
  })).filter((binding) => binding.name.length > 0);
}

function compareBindings(view: unknown, expected: BindingExpectation[]): BindingJournal[] {
  const actual = inspectBindings(view);
  for (const requirement of expected) {
    const found = actual.find((binding) => binding.name === requirement.name);
    if (!found || found.type !== normalizeBindingType(requirement.type)) throw new Error(`The prepared Worker version does not expose the intended ${requirement.name} binding type.`);
    if (requirement.resourceId && found.resourceId !== requirement.resourceId) throw new Error(`The prepared Worker version ${requirement.name} binding targets the wrong resource identity.`);
  }
  return actual;
}

function journalBindings(bindings: BindingJournal[]): BindingJournal[] {
  return bindings.filter((binding) => binding.type !== "secret_text");
}

function secretNamesFromView(view: unknown): Set<string> {
  return new Set(inspectBindings(view)
    .filter((binding) => binding.type === "secret_text")
    .map((binding) => binding.name));
}

async function inspectVersion(runtime: SetupRuntime, root: string, account: string, plan: Plan, version: string, expected: BindingExpectation[]) {
  const view = parseJson<unknown>(await runWrangler(runtime, root, account, ["versions", "view", version, "--name", plan.workerName, "--json"], { quiet: true }), "Wrangler version view");
  const bindings = compareBindings(view, expected);
  return {
    bindings,
    secretNames: secretNamesFromView(view),
    createdOn: metadataCreatedOn(typeof view === "object" && view !== null ? view as Record<string, unknown> : {}),
  };
}

async function secretNames(runtime: SetupRuntime, root: string, account: string, plan: Plan, versionId: string, expected: BindingExpectation[]): Promise<Set<string>> {
  if (!versionId) throw new Error("No prepared Worker version is available for secret verification.");
  return (await inspectVersion(runtime, root, account, plan, versionId, expected)).secretNames;
}

async function verifyDeployment(runtime: SetupRuntime, root: string, account: string, plan: Plan, expected: BindingExpectation[], expectedVersionId?: string): Promise<VerifiedDeployment> {
  const deployments = deploymentEntries(await runWrangler(runtime, root, account, ["deployments", "list", "--name", plan.workerName, "--json"], { quiet: true }));
  if (deployments.length === 0) throw new Error("No Worker deployment was returned; refusing to continue.");
  deployments.sort((left, right) => deploymentCreatedOn(right).localeCompare(deploymentCreatedOn(left)));
  const current = deployments[0];
  const traffic = deploymentTraffic(current);
  const active = traffic.filter((allocation) => allocation.percentage > 0);
  if (active.length !== 1 || active[0].percentage !== 100) throw new Error("Current Worker traffic is split or not fully allocated; refusing to complete provisioning.");
  const currentVersionId = active[0].versionId;
  if (expectedVersionId && currentVersionId !== expectedVersionId) throw new Error("The current Worker traffic does not target the exact intended version.");
  const versions = versionEntries(await runWrangler(runtime, root, account, ["versions", "list", "--name", plan.workerName, "--json"], { quiet: true }));
  const version = versions.find((entry) => versionId(entry) === currentVersionId);
  if (!version) throw new Error("The current deployment version was not found in the version list.");
  const inspected = await inspectVersion(runtime, root, account, plan, currentVersionId, expected);
  return {
    versionId: currentVersionId,
    deploymentId: stringField(current, "id", "deployment_id"),
    bindings: inspected.bindings,
    createdOn: metadataCreatedOn(version),
  };
}

function versionTag(): string {
  const versionTagBytes = crypto.getRandomValues(new Uint8Array(4));
  return `minastro-setup-${Date.now()}-${Array.from(versionTagBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function prepareVersion(runtime: SetupRuntime, journal: ProvisioningJournal, journalPath: string, root: string, account: string, plan: Plan, expected: BindingExpectation[]) {
  if (!journal.preparedVersion) {
    await markDeploymentPending(runtime, journalPath, journal);
    journal.preparedVersion = { versionId: "", tag: versionTag(), createdOn: "", revision: journal.deploymentRevision };
    await save(runtime, journalPath, journal);
  }
  const prepared = journal.preparedVersion;
  if (prepared.versionId) {
    await inspectVersion(runtime, root, account, plan, prepared.versionId, expected);
    return prepared;
  }
  const existing = versionEntries(await runWrangler(runtime, root, account, ["versions", "list", "--name", plan.workerName, "--json"], { quiet: true }))
    .filter((entry) => findTag(entry) === prepared.tag);
  if (existing.length > 1) throw new Error("The persisted prepared version tag resolves to multiple versions; operator review is required before retrying.");
  if (existing.length === 1) {
    const id = versionId(existing[0]);
    if (!id) throw new Error("The persisted prepared version has no version identity; operator review is required before retrying.");
    prepared.versionId = id;
    prepared.createdOn = metadataCreatedOn(existing[0]);
    await inspectVersion(runtime, root, account, plan, id, expected);
    await save(runtime, journalPath, journal);
    return prepared;
  }
  try {
    await runtime.runInteractive(["bun", "run", "build"], { env: { CLOUDFLARE_API_TOKEN: runtime.apiToken, CLOUDFLARE_ACCOUNT_ID: account } });
    await runWranglerInteractive(runtime, root, account, ["versions", "upload", "--name", plan.workerName, "--tag", prepared.tag, "--message", prepared.tag], {});
  } catch {
    throw new Error("Prepared version upload failed or is ambiguous; rerun setup to inspect the persisted version tag before retrying.");
  }
  const versions = versionEntries(await runWrangler(runtime, root, account, ["versions", "list", "--name", plan.workerName, "--json"], { quiet: true }));
  const tagged = versions.filter((entry) => findTag(entry) === prepared.tag);
  if (tagged.length !== 1) throw new Error("The prepared version upload did not resolve to exactly one newly created version by its persisted tag; no duplicate upload will be attempted.");
  const id = versionId(tagged[0]);
  if (!id) throw new Error("The prepared version has no version identity; no duplicate upload will be attempted.");
  prepared.versionId = id;
  prepared.createdOn = metadataCreatedOn(tagged[0]);
  await save(runtime, journalPath, journal);
  await inspectVersion(runtime, root, account, plan, id, expected);
  return prepared;
}

async function deployPreparedVersion(runtime: SetupRuntime, journal: ProvisioningJournal, journalPath: string, root: string, account: string, plan: Plan, expected: BindingExpectation[], phase: string) {
  if (!journal.preparedVersion?.versionId) throw new Error("No prepared Worker version is available for deployment; setup remains pending.");
  await confirmLegacyCutover(runtime, journal, journalPath, plan, `deployment (${phase})`);
  if (!/^y(es)?$/i.test((await runtime.prompt(`Deploy the prepared ${phase} Worker version after verifying its protected prerequisites? [y/N] `)).trim())) throw new Error("Deployment remains pending; rerun setup to resume it.");
  try {
    await runWranglerInteractive(runtime, root, account, ["versions", "deploy", `${journal.preparedVersion.versionId}@100`, "--name", plan.workerName], {});
  } catch {
    throw new Error("Deployment failed and remains pending; rerun setup to retry without recreating resources or secrets.");
  }
  let verified: VerifiedDeployment;
  try {
    verified = await verifyDeployment(runtime, root, account, plan, expected, journal.preparedVersion.versionId);
  } catch {
    throw new Error("Deployment completed but current traffic, version identity, or binding resource identities could not be verified; deployment remains pending.");
  }
  journal.pending.deployment = false;
  journal.milestones.deployed = true;
  journal.milestones.workerEstablished = true;
  journal.deployment = { versionId: verified.versionId, deploymentId: verified.deploymentId, bindings: journalBindings(verified.bindings), revision: journal.deploymentRevision, verifiedAt: new Date().toISOString() };
  await save(runtime, journalPath, journal);
}

async function deployTriggers(runtime: SetupRuntime, journal: ProvisioningJournal, journalPath: string, root: string, account: string, plan: Plan) {
  if (journal.milestones.triggersDeployed && !journal.pending.triggers) return;
  journal.pending.triggers = true;
  await save(runtime, journalPath, journal);
  await confirmLegacyCutover(runtime, journal, journalPath, plan, "trigger deployment");
  if (!/^y(es)?$/i.test((await runtime.prompt("Apply the approved Worker custom-domain, route, and cron triggers now? [y/N] ")).trim())) throw new Error("Trigger deployment remains pending; rerun setup to resume it.");
  try {
    await runWranglerInteractive(runtime, root, account, ["triggers", "deploy", "--name", plan.workerName], {});
  } catch {
    throw new Error("Trigger deployment failed and remains pending; rerun setup to retry before canonical verification.");
  }
  journal.pending.triggers = false;
  journal.milestones.triggersDeployed = true;
  await save(runtime, journalPath, journal);
}

async function establishWorker(runtime: SetupRuntime, journal: ProvisioningJournal, journalPath: string, root: string, account: string, plan: Plan, expected: BindingExpectation[]): Promise<VerifiedDeployment | null> {
  if (journal.milestones.workerEstablished && journal.deployment && !journal.pending.deployment) {
    const verified = await verifyDeployment(runtime, root, account, plan, expected, journal.deployment.versionId);
    journal.deployment = { versionId: verified.versionId, deploymentId: verified.deploymentId, bindings: journalBindings(verified.bindings), revision: journal.deploymentRevision, verifiedAt: new Date().toISOString() };
    await save(runtime, journalPath, journal);
    return verified;
  }
  try {
    const verified = await verifyDeployment(runtime, root, account, plan, expected, journal.deployment?.versionId);
    journal.milestones.workerEstablished = true;
    journal.milestones.deployed = true;
    journal.deployment = { versionId: verified.versionId, deploymentId: verified.deploymentId, bindings: journalBindings(verified.bindings), revision: journal.deploymentRevision, verifiedAt: new Date().toISOString() };
    if (!journal.pending.deployment) await save(runtime, journalPath, journal);
    return verified;
  } catch {
    if (!journal.milestones.deployed && journal.deployment) throw new Error("The existing Worker deployment could not be verified; no application code was deployed automatically.");
    return null;
  }
}

async function verifyCanonicalOrigin(runtime: SetupRuntime, account: string, plan: Plan, path: string, expectSetupRedirect: boolean, triggersDeployed: boolean) {
  const source = await runtime.fs.read(path);
  if (source === null || canonicalOriginFromSource(source) !== plan.canonicalOrigin) throw new Error("The canonical origin was not verified before completion.");
  if (!triggersDeployed) throw new Error("Worker triggers were not deployed before canonical verification.");
  if (!runtime.apiToken) throw new Error("Cloudflare API access is required to verify the canonical Worker attachment.");
  let body: unknown;
  try {
    const hostname = new URL(plan.canonicalOrigin).hostname;
    const response = await runtime.apiFetch(`${CLOUDFLARE_API}/accounts/${account}/workers/domains?hostname=${encodeURIComponent(hostname)}`, {
      headers: { Authorization: `Bearer ${runtime.apiToken}` },
    });
    body = await response.json();
    if (!response.ok) throw new Error();
  } catch {
    throw new Error("The canonical Worker custom-domain attachment could not be verified; completion remains pending.");
  }
  const result = typeof body === "object" && body !== null ? (body as { success?: unknown; result?: unknown }) : {};
  if (result.success !== true || !Array.isArray(result.result)) throw new Error("The canonical Worker custom-domain response was unusable; completion remains pending.");
  const attachment = result.result.find((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const object = entry as Record<string, unknown>;
    const attachedHostname = stringField(object, "hostname");
    const attachedWorker = stringField(object, "service", "script_name", "script", "worker_name", "workerName");
    const status = stringField(object, "status");
    return attachedHostname === new URL(plan.canonicalOrigin).hostname
      && attachedWorker === plan.workerName
      && (!status || status.toLowerCase() === "active");
  });
  if (!attachment) throw new Error("The canonical hostname is not actively attached to the approved Worker; completion remains pending.");
  try {
    const response = await runtime.originFetch(plan.canonicalOrigin, { redirect: "manual" });
    if (expectSetupRedirect) {
      if (response.status < 300 || response.status >= 400) throw new Error();
      const location = response.headers.get("location");
      if (!location) throw new Error();
      const target = new URL(location, plan.canonicalOrigin);
      const origin = new URL(plan.canonicalOrigin);
      if (target.origin !== origin.origin || target.pathname !== "/_emdash/admin/setup" || target.hash) throw new Error();
    } else if (!response.ok) {
      throw new Error();
    }
  } catch {
    throw new Error("The canonical HTTPS origin did not return the expected same-origin response; completion remains pending.");
  }
}

async function completeBootstrapHandoff(runtime: SetupRuntime, journal: ProvisioningJournal, journalPath: string, plan: Plan, bootstrapSecret: string | undefined) {
  if (!plan.bootstrapRequested || !journal.pending.bootstrapHandoff) return;
  let secret = bootstrapSecret;
  if (!secret) secret = await promptSavedSecret(runtime, "EMDASH_BOOTSTRAP_SECRET");
  const result = await runtime.handoff(plan.canonicalOrigin, secret);
  if (!result.opened && !result.copied) throw new Error("Bootstrap handoff could not be opened or copied. No secret was printed or rotated; use the saved secret for an operator-controlled direct handoff and rerun setup.");
  journal.pending.bootstrapHandoff = false;
  journal.milestones.bootstrapHandoff = true;
  await save(runtime, journalPath, journal);
}

export interface ProvisioningOptions {
  runtime: SetupRuntime;
  projectRoot?: string;
}

export async function runProvisioning(options: ProvisioningOptions): Promise<void> {
  const runtime = options.runtime;
  const root = options.projectRoot ?? PROJECT_ROOT;
  if (!runtime.apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required and must be supplied through the environment; setup never stores it.");
  const configPath = join(root, "wrangler.jsonc");
  const sitePath = join(root, "src/site.config.ts");
  const protectionPath = join(root, "src/lib/bootstrap-protection.ts");
  const configSource = await runtime.fs.read(configPath);
  const siteSource = await runtime.fs.read(sitePath);
  const protectionSource = await runtime.fs.read(protectionPath);
  if (configSource === null || siteSource === null || protectionSource === null || !protectionSource.includes("protectFirstAdminBootstrap")) throw new Error("Required configuration or first-admin protection source could not be verified.");
  const config = configObject(configSource);
  const configuredAccount = typeof config.account_id === "string" ? accountId(config.account_id) : undefined;
  const requestedAccount = runtime.approvedAccountId || process.env.CLOUDFLARE_ACCOUNT_ID || configuredAccount || await runtime.prompt("Approved Cloudflare account ID: ");
  const approvedAccount = accountId(requestedAccount);
  if (configuredAccount && configuredAccount !== approvedAccount) throw new Error("wrangler.jsonc account_id conflicts with the approved Cloudflare account.");
  if (!/^y(es)?$/i.test((await runtime.prompt(`Use approved Cloudflare account ${approvedAccount}? [y/N] `)).trim())) throw new Error("Cloudflare account approval was not confirmed.");
  await verifyAccount(runtime, approvedAccount);
  const coreState = coreConfigurationState(config);
  const configuredWorker = typeof config.name === "string" && config.name !== WORKER_PLACEHOLDER ? normalizeName(config.name) : "";
  const workerCandidate = configuredWorker || normalizeName(await runtime.prompt("Worker name [my-site]: ") || "my-site");
  if (!workerCandidate) throw new Error("Worker name must include at least one letter or number.");
  const provisioningRoot = join(root, JOURNAL_DIRECTORY);
  const release = await runtime.fs.acquireExclusive(provisioningLockPath(provisioningRoot, approvedAccount, workerCandidate));
  try {
    const path = provisioningJournalPath(provisioningRoot, approvedAccount, workerCandidate);
    let journal = await loadProvisioningJournal(runtime.fs, path);
    const resumed = Boolean(journal);
    let preflight: DatabaseState | undefined;
    if (coreState === "configured") preflight = await inspectDatabaseInitialization(runtime, root, approvedAccount, String(bindingEntry(config, "d1_databases", "binding", "DB")?.database_name));
    const plan = await promptPlan(runtime, config, siteSource, journal ?? undefined, workerCandidate, coreState, preflight);
    if (journal && (journal.target.accountId !== approvedAccount || journal.target.workerName !== plan.workerName || journal.target.canonicalOrigin !== plan.canonicalOrigin)) throw new Error("The journal target does not match the approved account, Worker, or canonical origin.");
    if (!journal) {
      journal = createProvisioningJournal(
        { accountId: approvedAccount, workerName: plan.workerName, canonicalOrigin: plan.canonicalOrigin },
        plan as unknown as Record<string, unknown>,
        {
          worker: createResourceJournal(plan.workerName),
          coreD1: createResourceJournal(plan.d1Name, coreState === "configured" ? String(bindingEntry(config, "d1_databases", "binding", "DB")?.database_id) : undefined),
          media: createResourceJournal(plan.r2Name, coreState === "configured" ? String(bindingEntry(config, "r2_buckets", "binding", "MEDIA")?.bucket_name) : undefined),
          session: createResourceJournal(plan.kvTitle, coreState === "configured" ? String(bindingEntry(config, "kv_namespaces", "binding", "SESSION")?.id) : undefined),
          ...(plan.newsletter.enabled ? { newsletterDb: createResourceJournal(plan.newsletter.databaseName, plan.newsletter.databaseId) } : {}),
        },
      );
      await save(runtime, path, journal);
    } else {
      journal.plan = plan as unknown as Record<string, unknown>;
      await save(runtime, path, journal);
    }

    const coreD1 = await resolveJournalResource(runtime, journal, path, "coreD1", {
      kind: "D1 database",
      intendedName: plan.d1Name,
      list: () => listD1(runtime, root, approvedAccount),
      identity: (resource) => resource,
      create: () => runWrangler(runtime, root, approvedAccount, ["d1", "create", plan.d1Name], { quiet: true }).then(() => undefined),
    });
    const media = await resolveJournalResource(runtime, journal, path, "media", {
      kind: "R2 bucket",
      intendedName: plan.r2Name,
      list: () => listR2(runtime, approvedAccount),
      identity: (resource) => resource,
      create: () => runWrangler(runtime, root, approvedAccount, ["r2", "bucket", "create", plan.r2Name], { quiet: true }).then(() => undefined),
    });
    const session = await resolveJournalResource(runtime, journal, path, "session", {
      kind: "KV namespace",
      intendedName: plan.kvTitle,
      list: () => listKv(runtime, approvedAccount),
      identity: (resource) => resource,
      create: () => runWrangler(runtime, root, approvedAccount, ["kv", "namespace", "create", plan.kvTitle], { quiet: true }).then(() => undefined),
    });
    let newsletterDb: Resource | undefined;
    if (plan.newsletter.enabled) {
      if (!journal.resources.newsletterDb) {
        journal.resources.newsletterDb = createResourceJournal(plan.newsletter.databaseName, plan.newsletter.databaseId);
        await save(runtime, path, journal);
      }
      newsletterDb = await resolveJournalResource(runtime, journal, path, "newsletterDb", {
        kind: "newsletter D1 database",
        intendedName: plan.newsletter.databaseName,
        list: () => listD1(runtime, root, approvedAccount),
        identity: (resource) => resource,
        create: () => runWrangler(runtime, root, approvedAccount, ["d1", "create", plan.newsletter.databaseName], { quiet: true }).then(() => undefined),
      });
    }

    const nextConfig = reconcileWranglerConfig(configSource, {
      accountId: approvedAccount,
      workerName: plan.workerName,
      canonicalHostname: new URL(plan.canonicalOrigin).hostname,
      coreD1: { name: plan.d1Name, id: coreD1.id },
      media: { name: media.name },
      session: { title: plan.kvTitle, id: session.id },
      ...(plan.newsletter.enabled && newsletterDb ? { newsletter: { databaseName: plan.newsletter.databaseName, databaseId: newsletterDb.id, senderAddress: plan.newsletter.senderAddress, rateLimitNamespaceId: plan.newsletter.rateLimitNamespaceId } } : {}),
      ...(plan.resend.enabled ? { resendSegmentId: plan.resend.segmentId } : {}),
    });
    if (nextConfig !== configSource) {
      await markDeploymentPending(runtime, path, journal);
      await runtime.fs.writeAtomic(configPath, nextConfig);
    }
    journal.milestones.configReconciled = true;
    await save(runtime, path, journal);
    await updateCanonicalSite(runtime, plan, sitePath, () => markDeploymentPending(runtime, path, journal));
    await updateNewsletterSite(runtime, plan, sitePath, () => markDeploymentPending(runtime, path, journal));
    journal.milestones.siteReconciled = true;
    await save(runtime, path, journal);

    const expectedBindings = requiredBindings(plan, { coreD1, media, session, newsletterDb });
    await establishWorker(runtime, journal, path, root, approvedAccount, plan, expectedBindings);
    const currentState = await inspectDatabaseInitialization(runtime, root, approvedAccount, plan.d1Name);
    plan.cmsState = databaseStateLabel(currentState);
    if (currentState.established) {
      plan.bootstrapRequested = false;
      journal.pending.bootstrapHandoff = false;
    } else if (resumed) {
      plan.bootstrapRequested = /^y(es)?$/i.test((await runtime.prompt("The current CMS database is not fully initialized. Reconfirm preparation of a first-admin bootstrap handoff for this current state? [y/N] ")).trim());
      if (!plan.bootstrapRequested) journal.pending.bootstrapHandoff = false;
    }
    journal.plan = plan as unknown as Record<string, unknown>;
    await save(runtime, path, journal);
    const needsDeployment = journal.pending.deployment || plan.newCore || (plan.newsletter.enabled && !journal.milestones.newsletterMigration);
    let bootstrapSecret: string | undefined;
    if (needsDeployment) {
      await prepareVersion(runtime, journal, path, root, approvedAccount, plan, expectedBindings);
      let names = await secretNames(runtime, root, approvedAccount, plan, journal.preparedVersion?.versionId ?? "", expectedBindings);
      const legacy = plan.newsletter.enabled && plan.resend.enabled && !plan.newsletter.newFeature;
      if (legacy) await confirmLegacyCutover(runtime, journal, path, plan, "secret and migration operations");
      await ensureSecret(runtime, journal, path, root, approvedAccount, plan.workerName, "EMDASH_ENCRYPTION_KEY", {
        allowGenerate: plan.newCore && !currentState.schemaInitialized,
        generate: () => runtime.run(["bunx", "emdash", "secrets", "generate"], { quiet: true }),
      }, names, plan, expectedBindings);
      names = await secretNames(runtime, root, approvedAccount, plan, journal.preparedVersion?.versionId ?? "", expectedBindings);
      if (plan.bootstrapRequested && !currentState.established) {
        journal.pending.bootstrapHandoff = true;
        await save(runtime, path, journal);
        if (names.has("EMDASH_BOOTSTRAP_SECRET")) journal.secrets.EMDASH_BOOTSTRAP_SECRET = "verified";
        else {
          const value = journal.secrets.EMDASH_BOOTSTRAP_SECRET && journal.secrets.EMDASH_BOOTSTRAP_SECRET !== "unknown"
            ? await promptSavedSecret(runtime, "EMDASH_BOOTSTRAP_SECRET")
            : await custodySecret(runtime, journal, path, "EMDASH_BOOTSTRAP_SECRET", generateBootstrapSecret());
          bootstrapSecret = value;
          await uploadSecret(runtime, journal, path, root, approvedAccount, plan.workerName, plan, expectedBindings, "EMDASH_BOOTSTRAP_SECRET", value);
        }
        await save(runtime, path, journal);
      }
      await ensureMigrations(runtime, journal, path, root, approvedAccount, plan);
      if (plan.newsletter.enabled) {
        await ensureInteractiveSecret(runtime, journal, path, root, approvedAccount, plan.workerName, "TURNSTILE_SECRET_KEY", plan, expectedBindings);
        await ensureInteractiveSecret(runtime, journal, path, root, approvedAccount, plan.workerName, "NEWSLETTER_ADMIN_TOKEN", plan, expectedBindings);
        if (plan.resend.enabled) await ensureInteractiveSecret(runtime, journal, path, root, approvedAccount, plan.workerName, "RESEND_API_KEY", plan, expectedBindings);
      }
      await deployPreparedVersion(runtime, journal, path, root, approvedAccount, plan, expectedBindings, "final");
    }
    await deployTriggers(runtime, journal, path, root, approvedAccount, plan);
    await verifyCanonicalOrigin(runtime, approvedAccount, plan, sitePath, !currentState.established, journal.milestones.triggersDeployed);
    journal.milestones.canonicalVerified = true;
    await save(runtime, path, journal);
    await completeBootstrapHandoff(runtime, journal, path, plan, bootstrapSecret);
    console.log(`Provisioning complete for ${plan.workerName} at ${plan.canonicalOrigin}.`);
  } finally {
    await release();
  }
}

export function createDefaultRuntime(): SetupRuntime {
  return defaultRuntime(createInterface({ input, output }));
}

if (import.meta.main) {
  const runtime = createDefaultRuntime();
  runProvisioning({ runtime }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }).finally(() => {
    runtime.close?.();
  });
}
