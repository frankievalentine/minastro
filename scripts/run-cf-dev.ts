import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createTerminalUI } from "./terminal-ui";

/**
 * Local Worker launcher for `bun run cf:dev`.
 *
 * The production first-admin gate (src/lib/bootstrap-protection.ts) is
 * fail-closed, so an uninitialized site refuses setup without a bootstrap
 * secret. Local development mints a temporary one, injects it into the local
 * `wrangler dev --local` run only, and hands the authorized setup URL to the
 * browser. The value never reaches disk or a non-interactive run's output.
 */

const ui = createTerminalUI();

const LOOPBACK_HOST = "127.0.0.1";
/** Browser-facing origin. It matches siteConfig.url so localhost passkeys work. */
const LOCAL_ORIGIN_HOST = "localhost";
const SETUP_PATH = "/_emdash/admin/setup";
const BOOTSTRAP_SECRET_ENV = "MINASTRO_CF_DEV_BOOTSTRAP_SECRET";
const BOOTSTRAP_COOKIE_NAME = "minastro_bootstrap";
/** Must satisfy MINIMUM_SECRET_BYTES in src/lib/bootstrap-protection.ts. */
const MIN_SECRET_BYTES = 32;
const READY_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 5_000;
const OPENER_TIMEOUT_MS = 5_000;

type BootstrapHandoffOutcome = "fresh" | "initialized" | "denied" | "unavailable" | "unexpected";
type HandoffChannel = "browser" | "clipboard" | "quiet";

function randomBootstrapSecret(): string {
  let binary = "";
  for (const byte of randomBytes(32)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * An explicit caller-supplied secret wins, a curated local file is honored by
 * leaving the secret alone, and only a fully empty variable counts as unset.
 */
export function resolveLocalBootstrapSecret(
  explicit: string | undefined = process.env[BOOTSTRAP_SECRET_ENV],
  curated = false,
  generate: () => string = randomBootstrapSecret,
): { source: "explicit" | "ephemeral"; secret: string } | { source: "curated" } {
  if (explicit !== undefined && explicit.length > 0) {
    const byteLength = new TextEncoder().encode(explicit).byteLength;
    if (byteLength < MIN_SECRET_BYTES) {
      throw new Error(`${BOOTSTRAP_SECRET_ENV} must be at least ${MIN_SECRET_BYTES} bytes; received ${byteLength}.`);
    }
    return { source: "explicit", secret: explicit };
  }
  if (curated) return { source: "curated" };
  return { source: "ephemeral", secret: generate() };
}

/** Name-only check, so a curated secret file is never read into this process. */
export function hasCuratedLocalDevVars(
  baseDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const namedEnvironment = environment.MINASTRO_CF_DEV_ENV;
  const candidates = namedEnvironment ? [`.dev.vars.${namedEnvironment}`, ".dev.vars"] : [".dev.vars"];
  return candidates.some((name) => exists(join(baseDir, name)));
}

export interface WranglerDevOptions {
  readonly port: string;
  readonly persistTo?: string;
  readonly config?: string;
  readonly environment?: string;
  readonly bootstrapSecret?: string;
}

/** Loopback-bound local run; the temporary secret travels as a local `--var`. */
export function buildWranglerDevArgs(options: WranglerDevOptions): string[] {
  const args = ["x", "wrangler", "dev", "--local", "--ip", LOOPBACK_HOST, "--port", options.port];
  if (options.persistTo) args.push("--persist-to", options.persistTo);
  if (options.config) args.push("--config", options.config);
  if (options.environment) args.push("--env", options.environment);
  if (options.bootstrapSecret) args.push("--var", `EMDASH_BOOTSTRAP_SECRET:${options.bootstrapSecret}`);
  return args;
}

function setupHandoffUrl(origin: string, secret: string): string {
  return `${origin}${SETUP_PATH}?bootstrap=${encodeURIComponent(secret)}`;
}

/** Only a 303 that sets the bootstrap cookie proves the injected secret is effective. */
function classifyBootstrapProbe(response: { status: number; setCookie: string | null }): BootstrapHandoffOutcome {
  if (response.status === 503) return "unavailable";
  if (response.status === 403) return "denied";
  if (response.status >= 300 && response.status < 400) {
    return response.setCookie?.includes(`${BOOTSTRAP_COOKIE_NAME}=`) === true ? "fresh" : "initialized";
  }
  return "unexpected";
}

function handoffNotice(
  outcome: BootstrapHandoffOutcome,
  context: { readonly origin: string; readonly channel: HandoffChannel },
): string[] {
  if (outcome === "fresh") {
    if (context.channel === "browser") return ["Opened the first-admin setup page in your browser."];
    if (context.channel === "clipboard") {
      return ["Copied the first-admin setup link to your clipboard. Paste it into your browser."];
    }
    return [
      "Local first-admin setup is ready, but this terminal could not hand off the setup link.",
      "Re-run `bun run cf:dev` in an interactive terminal, or set MINASTRO_CF_DEV_BOOTSTRAP_SECRET to use your own value.",
    ];
  }
  if (outcome === "initialized") {
    return [`The local site is already initialized. Open ${context.origin}/_emdash/admin to sign in.`];
  }
  if (outcome === "denied") {
    return [
      "The local Worker rejected the temporary bootstrap secret, so a .dev.vars value is taking precedence.",
      `Open ${context.origin}${SETUP_PATH}?bootstrap=<your EMDASH_BOOTSTRAP_SECRET> in your browser to continue.`,
    ];
  }
  if (outcome === "unavailable") {
    return [
      "The local first-admin gate reports the bootstrap secret unavailable (HTTP 503).",
      "Set a valid EMDASH_BOOTSTRAP_SECRET in .dev.vars, or delete that file so cf:dev can mint a temporary local secret.",
    ];
  }
  return [`Could not confirm the local setup handoff automatically. Open ${context.origin}${SETUP_PATH} in your browser.`];
}

export async function waitForLocalWorker(origin: string, isAlive: () => boolean, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error("The local Worker exited before setup could be verified.");
    try {
      await fetch(`${origin}${SETUP_PATH}`, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return;
    } catch {
      await new Promise((done) => setTimeout(done, Math.min(1_000, 50 * 2 ** Math.min(attempt, 5))));
      attempt += 1;
    }
  }
  throw new Error(`Timed out waiting for the local Worker at ${origin}.`);
}

async function probeLocalBootstrap(origin: string, secret: string): Promise<BootstrapHandoffOutcome> {
  const response = await fetch(setupHandoffUrl(origin, secret), {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return classifyBootstrapProbe({ status: response.status, setCookie: response.headers.get("set-cookie") });
}

async function runLocalCommand(command: string, args: string[], input?: string): Promise<boolean> {
  return await new Promise<boolean>((resolveResult) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, OPENER_TIMEOUT_MS);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin?.end(input ?? "");
  });
}

async function openLocalUrl(url: string): Promise<boolean> {
  if (process.platform === "darwin") return await runLocalCommand("open", [url]);
  if (process.platform === "win32") return await runLocalCommand("cmd", ["/c", "start", "", url]);
  return await runLocalCommand("xdg-open", [url]);
}

async function copyLocalUrl(url: string): Promise<boolean> {
  if (process.platform === "darwin") return await runLocalCommand("pbcopy", [], url);
  if (process.platform === "win32") return await runLocalCommand("clip", [], url);
  if (await runLocalCommand("wl-copy", [], url)) return true;
  return await runLocalCommand("xclip", ["-selection", "clipboard"], url);
}

async function deliverSetupHandoff(options: {
  readonly probeOrigin: string;
  readonly browserOrigin: string;
  readonly secret: string | undefined;
  readonly isAlive: () => boolean;
}): Promise<void> {
  const { probeOrigin, browserOrigin, secret, isAlive } = options;
  try {
    await waitForLocalWorker(probeOrigin, isAlive);
    if (secret === undefined) {
      const response = await fetch(`${probeOrigin}${SETUP_PATH}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      ui.note(
        response.status === 503
          ? "The local first-admin gate has no usable bootstrap secret: set a 32+ byte EMDASH_BOOTSTRAP_SECRET in .dev.vars, or remove that file so cf:dev can mint a temporary secret."
          : `Using the .dev.vars EMDASH_BOOTSTRAP_SECRET; open ${browserOrigin}${SETUP_PATH}?bootstrap=<your value>.`,
      );
      return;
    }
    const outcome = await probeLocalBootstrap(probeOrigin, secret);
    let channel: HandoffChannel = "quiet";
    if (outcome === "fresh" && process.stdout.isTTY) {
      const handoffUrl = setupHandoffUrl(browserOrigin, secret);
      const allowBrowser = process.env.MINASTRO_CF_DEV_NO_BROWSER !== "1";
      if (allowBrowser && (await openLocalUrl(handoffUrl))) channel = "browser";
      else if (await copyLocalUrl(handoffUrl)) channel = "clipboard";
    }
    for (const line of handoffNotice(outcome, { origin: browserOrigin, channel })) ui.note(line);
  } catch (error) {
    ui.note(error instanceof Error ? error.message : String(error));
  }
}

function configuredPort(): string {
  const value = process.env.MINASTRO_CF_DEV_PORT ?? "8787";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`MINASTRO_CF_DEV_PORT must be an integer between 1 and 65535; received ${value}.`);
  }
  return String(port);
}

async function main(): Promise<void> {
  const port = configuredPort();
  const config = process.env.MINASTRO_CF_DEV_CONFIG;
  const wranglerCwd = process.env.MINASTRO_CF_DEV_WRANGLER_CWD ?? process.cwd();
  const persistTo = process.env.MINASTRO_CF_DEV_PERSIST_TO;
  const wranglerEnvironment = process.env.MINASTRO_CF_DEV_ENV;
  const devVarsBase = config === undefined ? wranglerCwd : dirname(resolve(wranglerCwd, config));
  const bootstrap = resolveLocalBootstrapSecret(process.env[BOOTSTRAP_SECRET_ENV], hasCuratedLocalDevVars(devVarsBase));

  ui.section("Local Cloudflare Worker");
  ui.note(`Starting on http://${LOCAL_ORIGIN_HOST}:${port} (Wrangler output follows)`);
  if (bootstrap.source === "ephemeral") {
    ui.note("Using a temporary local-only first-admin bootstrap secret (never written to disk).");
  }

  const child = spawn(
    process.execPath,
    buildWranglerDevArgs({
      port,
      persistTo,
      config,
      environment: wranglerEnvironment,
      bootstrapSecret: bootstrap.source === "curated" ? undefined : bootstrap.secret,
    }),
    {
      cwd: wranglerCwd,
      env: { ...process.env, WRANGLER_WRITE_LOGS: "false" },
      stdio: "inherit",
    },
  );

  const isAlive = () => child.exitCode === null && child.signalCode === null;
  const handoffEnabled = bootstrap.source !== "explicit" && !config && process.env.MINASTRO_CF_DEV_HANDOFF !== "0";
  if (handoffEnabled) {
    void deliverSetupHandoff({
      probeOrigin: `http://${LOOPBACK_HOST}:${port}`,
      browserOrigin: `http://${LOCAL_ORIGIN_HOST}:${port}`,
      secret: bootstrap.source === "curated" ? undefined : bootstrap.secret,
      isAlive,
    });
  }

  let shuttingDown = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    shuttingDown = true;
    child.kill(signal);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.once("error", (error) => {
    ui.failure(`Could not start Wrangler local development server: ${error.message}`);
    process.exitCode = 1;
  });

  child.once("exit", (code, signal) => {
    if (shuttingDown) {
      process.exitCode = 0;
    } else if (signal) {
      process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
    } else {
      process.exitCode = code ?? 1;
    }
  });
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    ui.failure(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
