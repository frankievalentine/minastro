import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 3_000;
const PROCESS_TERMINATION_TIMEOUT_MS = 5_000;

const SMOKE_D1_ID = "00000000-0000-0000-0000-000000000001";
const SMOKE_KV_ID = "00000000000000000000000000000001";

interface SmokeResponse {
  status: number;
  location: string | null;
  setCookie: string | null;
  body: string;
}

export interface SmokeWranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  rules: [{ type: "ESModule"; globs: string[] }];
  assets: { directory: string; binding: string };
  no_bundle: true;
  send_metrics: false;
  d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
  kv_namespaces: Array<{ binding: string; id: string }>;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function createSmokeWranglerConfig(repoRoot: string): SmokeWranglerConfig {
  void repoRoot;
  return {
    name: "minastro-worker-smoke",
    main: "entry.mjs",
    compatibility_date: "2026-03-02",
    compatibility_flags: ["nodejs_compat"],
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    assets: {
      directory: "../client",
      binding: "ASSETS",
    },
    no_bundle: true,
    send_metrics: false,
    d1_databases: [
      {
        binding: "DB",
        database_name: "minastro-worker-smoke-db",
        database_id: SMOKE_D1_ID,
      },
    ],
    r2_buckets: [{ binding: "MEDIA", bucket_name: "minastro-worker-smoke-media" }],
    kv_namespaces: [{ binding: "SESSION", id: SMOKE_KV_ID }],
  };
}

export function createUnavailableCmsWranglerConfig(repoRoot: string): SmokeWranglerConfig {
  const config = createSmokeWranglerConfig(repoRoot);
  return {
    ...config,
    name: "minastro-worker-smoke-no-cms",
    d1_databases: [],
  };
}

export function assertSmokeWranglerConfig(config: SmokeWranglerConfig | Record<string, unknown>): void {
  requireCondition(config.name === "minastro-worker-smoke", "Smoke config has an unexpected Worker name.");
  requireCondition(
    typeof config.main === "string" && (config.main === "entry.mjs" || config.main.endsWith("/dist/server/entry.mjs")),
    "Smoke config must point at the built Worker entrypoint.",
  );
  requireCondition(config.no_bundle === true, "Smoke config must run the built Worker without rebundling Astro virtual modules.");
  requireCondition(config.send_metrics === false, "Smoke config must disable Wrangler metrics.");
  requireCondition(!("routes" in config), "Smoke config must not contain deployment routes.");
  requireCondition(!("vars" in config) && !("secrets" in config), "Smoke config must not contain deployment variables or secrets.");
  requireCondition(
    JSON.stringify(config.d1_databases) ===
      JSON.stringify([{ binding: "DB", database_name: "minastro-worker-smoke-db", database_id: SMOKE_D1_ID }]),
    "Smoke config must use only its isolated simulated D1 binding.",
  );
  requireCondition(
    JSON.stringify(config.r2_buckets) ===
      JSON.stringify([{ binding: "MEDIA", bucket_name: "minastro-worker-smoke-media" }]),
    "Smoke config must use only its isolated simulated R2 binding.",
  );
  requireCondition(
    JSON.stringify(config.kv_namespaces) === JSON.stringify([{ binding: "SESSION", id: SMOKE_KV_ID }]),
    "Smoke config must use only its isolated simulated KV binding.",
  );
}

const PROVIDER_CREDENTIAL_NAME = /^(?:CLOUDFLARE|CF_|WRANGLER|RESEND|TURNSTILE|AWS_|AZURE_|GOOGLE_|GCP_|VERCEL_|NETLIFY_|FLY_)/i;
const LOCAL_EMDASH_SECRET_NAME = /^EMDASH_(?:ENCRYPTION_KEY|BOOTSTRAP_SECRET)$/;

export function smokeChildEnvironment(
  base: NodeJS.ProcessEnv,
  port: number,
  persistTo: string,
  config: string,
  cwd: string,
  secret: string,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(base).filter(([name]) => !PROVIDER_CREDENTIAL_NAME.test(name) && !LOCAL_EMDASH_SECRET_NAME.test(name)),
  );
  return {
    ...environment,
    MINASTRO_CF_DEV_PORT: String(port),
    MINASTRO_CF_DEV_PERSIST_TO: persistTo,
    MINASTRO_CF_DEV_CONFIG: config,
    MINASTRO_CF_DEV_WRANGLER_CWD: cwd,
    MINASTRO_CF_DEV_BOOTSTRAP_SECRET: secret,
  };
}

export function assertSetupRedirect(response: Pick<SmokeResponse, "status" | "location">): void {
  requireCondition(
    response.status >= 300 && response.status < 400,
    `Expected an uninitialized setup redirect, got HTTP ${response.status} (${response.location ?? "no location"}).`,
  );
  requireCondition(response.location !== null, "The setup redirect did not include a Location header.");
  requireCondition(
    new URL(response.location, "http://localhost").pathname === "/_emdash/admin/setup",
    `Expected the setup redirect to target /_emdash/admin/setup, got ${response.location}.`,
  );
}

export function assertBootstrapDenied(response: Pick<SmokeResponse, "status" | "body">): void {
  requireCondition(response.status === 403, `Expected unauthenticated bootstrap denial to return HTTP 403, got ${response.status}.`);
  requireCondition(
    response.body.includes("First-admin bootstrap authorization required."),
    "The bootstrap denial did not contain the expected generic authorization message.",
  );
}

export function assertBootstrapRedirect(response: Pick<SmokeResponse, "status" | "location" | "setCookie">): void {
  requireCondition(response.status === 303, `Expected valid bootstrap authorization to redirect with HTTP 303, got ${response.status}.`);
  requireCondition(
    response.location !== null &&
      new URL(response.location, "http://localhost").pathname === "/_emdash/admin/setup" &&
      new URL(response.location, "http://localhost").search === "",
    `Expected valid bootstrap authorization to redirect to the clean setup URL, got ${response.location ?? "no location"}.`,
  );
  requireCondition(
    response.setCookie?.includes("minastro_bootstrap=") === true,
    "Valid bootstrap authorization did not establish the temporary bootstrap cookie.",
  );
}

export function assertUnavailableCms(response: Pick<SmokeResponse, "status" | "body">): void {
  requireCondition(response.status === 503, `Expected the unavailable-CMS setup boundary to return HTTP 503, got ${response.status}.`);
  requireCondition(
    response.body.includes("First-admin bootstrap is unavailable."),
    "The unavailable-CMS response did not identify the expected bootstrap availability boundary.",
  );
}

const EMPTY_D1_EXPECTED_STATUS: Record<string, number> = {
  "/": 200,
  "/robots.txt": 200,
  "/sitemap.xml": 200,
  "/_emdash/api/search": 200,
};

export function assertEmptyD1Endpoint(pathname: string, response: Pick<SmokeResponse, "status">): void {
  const expectedStatus = EMPTY_D1_EXPECTED_STATUS[pathname];
  requireCondition(expectedStatus !== undefined, `No empty-D1 expectation is defined for ${pathname}.`);
  requireCondition(
    response.status === expectedStatus,
    `${pathname} returned HTTP ${response.status}; expected HTTP ${expectedStatus} for the empty-D1 local Worker.`,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  requireCondition(address && typeof address === "object", "The operating system did not provide an ephemeral port.");
  return address.port;
}

export async function isPortAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return await new Promise<boolean>((resolve) => {
    const finish = (available: boolean) => {
      server.removeAllListeners();
      resolve(available);
    };
    server.once("error", () => finish(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => finish(!error));
    });
  });
}

export async function waitForPortAvailable(port: number, timeoutMs = PROCESS_TERMINATION_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortAvailable(port)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for port ${port} to be released.`);
}

function rememberOutput(child: ChildProcess): { recent: string } {
  const output = { recent: "" };
  const append = (chunk: Buffer | string) => {
    output.recent = `${output.recent}${chunk.toString()}`.slice(-8_000);
  };
  child.stdout?.on("data", (chunk) => {
    append(chunk);
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    append(chunk);
    process.stderr.write(chunk);
  });
  return output;
}

function processGroupExists(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals, fallbackChild?: ChildProcess): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" && fallbackChild) {
      try {
        fallbackChild.kill(signal);
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") throw fallbackError;
      }
      return false;
    }
    if (code !== "ESRCH") throw error;
    return false;
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(timeoutMs),
  ]);
}

async function waitForProcessGroupGone(pid: number, timeoutMs: number): Promise<void> {
  if (process.platform === "win32") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return;
    await delay(25);
  }
  throw new Error(`Process group ${pid} did not terminate within ${timeoutMs}ms.`);
}

export async function terminateOwnedProcess(child: ChildProcess, timeoutMs = PROCESS_TERMINATION_TIMEOUT_MS): Promise<void> {
  const pid = child.pid;
  requireCondition(pid !== undefined, "Cannot clean up a Worker process without a PID.");

  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child, timeoutMs);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, timeoutMs);
    }
    return;
  }

  const groupSignalled = signalProcessGroup(pid, "SIGTERM", child);
  await waitForExit(child, timeoutMs);
  if (processGroupExists(pid)) {
    signalProcessGroup(pid, "SIGKILL", child);
    await waitForExit(child, timeoutMs);
  }
  if (groupSignalled) await waitForProcessGroupGone(pid, timeoutMs);
}

export async function cleanupSmokeResources(
  children: Set<ChildProcess>,
  ports: Array<number | undefined>,
  stateRoot: string,
  configPaths: string[] = [],
): Promise<void> {
  for (const child of children) await terminateOwnedProcess(child);
  for (const port of ports) {
    if (port !== undefined) await waitForPortAvailable(port);
  }
  await rm(stateRoot, { recursive: true, force: true });
  for (const configPath of configPaths) await rm(configPath, { force: true });
}

async function request(origin: string, pathname: string, options: { cookie?: string } = {}): Promise<SmokeResponse> {
  const response = await fetch(`${origin}${pathname}`, {
    redirect: "manual",
    headers: options.cookie ? { Cookie: options.cookie } : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    setCookie: response.headers.get("set-cookie"),
    body: await response.text(),
  };
}

async function waitForWorker(
  origin: string,
  child: ChildProcess,
  output: { recent: string },
  readinessPathname = "/robots.txt",
): Promise<void> {
  const deadline = Date.now() + Number(process.env.MINASTRO_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  let attempt = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`bun run scripts/run-cf-dev.ts exited before becoming ready.\n${output.recent}`);
    }
    try {
      await request(origin, readinessPathname);
      return;
    } catch {
      await delay(Math.min(1_000, 50 * 2 ** Math.min(attempt, 5)));
      attempt += 1;
    }
  }
  throw new Error(`Timed out waiting for the local Worker at ${origin}.\n${output.recent}`);
}

async function main(): Promise<void> {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const stateRoot = await mkdtemp(join(tmpdir(), "minastro-worker-smoke-"));
  const persistTo = join(stateRoot, "wrangler-state");
  const configToken = randomUUID();
  const buildRoot = join(REPO_ROOT, "dist/server");
  const configPath = join(buildRoot, `.wrangler-smoke-${configToken}.jsonc`);
  const smokeConfig = createSmokeWranglerConfig(REPO_ROOT);
  assertSmokeWranglerConfig(smokeConfig);
  await writeFile(configPath, JSON.stringify(smokeConfig, null, 2));
  const bootstrapSecret = `${randomUUID()}${randomUUID()}`;
  const children = new Set<ChildProcess>();
  let child: ChildProcess | undefined;
  let unavailablePort: number | undefined;
  let unavailableConfigPath: string | undefined;
  let interruptedSignal: NodeJS.Signals | undefined;
  const handleInterrupt = (signal: NodeJS.Signals) => {
    interruptedSignal = signal;
    for (const ownedChild of children) void terminateOwnedProcess(ownedChild).catch(() => undefined);
  };

  try {
    child = spawn(process.execPath, ["run", "scripts/run-cf-dev.ts"], {
      cwd: REPO_ROOT,
      detached: process.platform !== "win32",
      env: smokeChildEnvironment(process.env, port, persistTo, configPath, buildRoot, bootstrapSecret),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    process.once("SIGINT", handleInterrupt);
    process.once("SIGTERM", handleInterrupt);
    const output = rememberOutput(child);
    await waitForWorker(origin, child, output);

    if (interruptedSignal) throw new Error(`Smoke run interrupted by ${interruptedSignal}.`);

    const root = await request(origin, "/");
    assertEmptyD1Endpoint("/", root);
    console.log(`PASS / runtime boundary -> ${root.status}`);

    const setup = await request(origin, "/_emdash/admin/setup");
    assertBootstrapDenied(setup);
    console.log(`PASS /_emdash/admin/setup without bootstrap -> ${setup.status}`);

    const bootstrap = await request(origin, `/_emdash/admin/setup?bootstrap=${encodeURIComponent(bootstrapSecret)}`);
    assertBootstrapRedirect(bootstrap);
    console.log(`PASS valid bootstrap token -> ${bootstrap.status} ${bootstrap.location}`);

    requireCondition(bootstrap.setCookie !== null, "The authorized setup redirect did not issue a bootstrap cookie.");
    const setupWithCookie = await request(origin, "/_emdash/admin/setup", {
      cookie: bootstrap.setCookie.split(";", 1)[0],
    });
    requireCondition(setupWithCookie.status === 200, `Expected the issued bootstrap cookie to authorize the setup UI, got ${setupWithCookie.status}.`);
    requireCondition(!setupWithCookie.body.includes(bootstrapSecret), "The setup UI response exposed the bootstrap secret.");
    console.log(`PASS setup UI with issued cookie -> ${setupWithCookie.status}`);

    const invalidBootstrap = await request(origin, "/_emdash/admin/setup?bootstrap=invalid-smoke-token");
    assertBootstrapDenied(invalidBootstrap);
    console.log(`PASS invalid bootstrap token -> ${invalidBootstrap.status}`);

    for (const pathname of ["/robots.txt", "/sitemap.xml", "/_emdash/api/search?q=smoke"]) {
      const response = await request(origin, pathname);
      assertEmptyD1Endpoint(pathname.split("?", 1)[0], response);
      console.log(`PASS ${pathname} runtime boundary -> ${response.status}`);
    }

    await terminateOwnedProcess(child);
    children.delete(child);
    await waitForPortAvailable(port);
    child = undefined;

    unavailablePort = await availablePort();
    const unavailableConfig = createUnavailableCmsWranglerConfig(REPO_ROOT);
    unavailableConfigPath = join(buildRoot, `.wrangler-smoke-${configToken}-no-cms.jsonc`);
    const unavailablePersistTo = join(stateRoot, "wrangler-no-cms-state");
    await writeFile(unavailableConfigPath, JSON.stringify(unavailableConfig, null, 2));
    const unavailableChild = spawn(process.execPath, ["run", "scripts/run-cf-dev.ts"], {
      cwd: REPO_ROOT,
      detached: process.platform !== "win32",
      env: smokeChildEnvironment(
        process.env,
        unavailablePort,
        unavailablePersistTo,
        unavailableConfigPath,
        buildRoot,
        bootstrapSecret,
      ),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(unavailableChild);
    const unavailableOutput = rememberOutput(unavailableChild);
    const unavailableOrigin = `http://127.0.0.1:${unavailablePort}`;
    await waitForWorker(unavailableOrigin, unavailableChild, unavailableOutput, "/_emdash/admin/setup");
    const unavailableCms = await request(unavailableOrigin, "/_emdash/admin/setup");
    assertUnavailableCms(unavailableCms);
    console.log(`PASS unavailable CMS setup boundary -> ${unavailableCms.status}`);
    await terminateOwnedProcess(unavailableChild);
    children.delete(unavailableChild);
    await waitForPortAvailable(unavailablePort);
    unavailablePort = undefined;
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleInterrupt);
    await cleanupSmokeResources(children, [port, unavailablePort], stateRoot, [configPath, unavailableConfigPath].filter((path): path is string => path !== undefined));
    if (interruptedSignal) process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    if (process.exitCode === undefined) process.exitCode = 1;
  });
}
