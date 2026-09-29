import type { CommandOptions } from "./setup-cloudflare-lib";

/**
 * Cloudflare credentials resolved from Wrangler itself.
 *
 * `wrangler auth token --json` returns the live OAuth access token (refreshed
 * by Wrangler on use) or the API token Wrangler was configured with. Setup only
 * reads that documented command output: it never opens Wrangler credential
 * files, keychain entries, or logs, and it never prints or stores the value.
 */
export type WranglerCredential = { mode: "oauth" | "api_token"; token: string };

export type WranglerAccount = { id: string; name: string };

export interface AuthRuntime {
  run(command: string[], options?: CommandOptions): Promise<string>;
  runInteractive(command: string[], options?: CommandOptions): Promise<void>;
  prompt(question: string): Promise<string>;
  progress?: { note(message: string): void };
}

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const AUTH_TOKEN_COMMAND = ["bunx", "wrangler", "auth", "token", "--json"];
const WHOAMI_COMMAND = ["bunx", "wrangler", "whoami", "--json"];
const LOGIN_COMMAND = ["bunx", "wrangler", "login"];
const ENVIRONMENT_TOKEN = "CLOUDFLARE_API_TOKEN";
const DISABLE_WRANGLER_LOGS = "WRANGLER_WRITE_LOGS";

/**
 * Wrangler must read its own stored session for these probes, so an inherited
 * token is removed from the child environment, the output stays quiet, and
 * Wrangler's disk log is disabled: it would otherwise persist the raw token
 * returned by `auth token --json`.
 */
function wranglerSessionOptions(): CommandOptions {
  return { quiet: true, env: { [ENVIRONMENT_TOKEN]: undefined, [DISABLE_WRANGLER_LOGS]: "false" } };
}

/**
 * Parse `wrangler auth token --json`. Failures never echo the raw output: the
 * token value must not reach logs or error messages.
 */
export function parseWranglerCredential(output: string): WranglerCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("`wrangler auth token --json` did not return usable JSON; no credentials were read. Run `npx wrangler login` or set CLOUDFLARE_API_TOKEN, then rerun setup.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("`wrangler auth token --json` did not return a credential object; run `npx wrangler login` or set CLOUDFLARE_API_TOKEN, then rerun setup.");
  }
  const { type, token } = parsed as { type?: unknown; token?: unknown };
  if (type === "api_key") {
    throw new Error("Wrangler is authenticated with a legacy API key, which setup does not use. Set an account-scoped CLOUDFLARE_API_TOKEN or run `npx wrangler login`.");
  }
  if ((type !== "oauth" && type !== "api_token") || typeof token !== "string" || token.trim().length === 0) {
    throw new Error("`wrangler auth token --json` did not return an oauth or api_token credential; run `npx wrangler login` or set CLOUDFLARE_API_TOKEN, then rerun setup.");
  }
  return { mode: type, token: token.trim() };
}

export function parseWranglerAccounts(output: string): WranglerAccount[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("`wrangler whoami --json` did not return usable JSON; enter the account ID manually.");
  }
  const accounts = typeof parsed === "object" && parsed !== null ? (parsed as { accounts?: unknown }).accounts : undefined;
  if (!Array.isArray(accounts)) throw new Error("`wrangler whoami --json` returned no account list; enter the account ID manually.");
  const resolved: WranglerAccount[] = [];
  for (const entry of accounts) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const object = entry as { id?: unknown; name?: unknown };
    if (typeof object.id !== "string") continue;
    const id = object.id.trim().toLowerCase();
    if (!ACCOUNT_ID_PATTERN.test(id)) continue;
    if (resolved.some((account) => account.id === id)) continue;
    const name = typeof object.name === "string" && object.name.trim() ? object.name.trim() : id;
    resolved.push({ id, name });
  }
  if (resolved.length === 0) throw new Error("`wrangler whoami --json` listed no usable Cloudflare account; enter the account ID manually.");
  return resolved;
}

/** Resolve a numbered-list answer or a literal 32-character account ID. */
export function selectWranglerAccount(answer: string, accounts: WranglerAccount[]): string {
  const normalized = answer.trim().toLowerCase();
  if (/^[1-9]\d*$/.test(normalized)) {
    const index = Number(normalized) - 1;
    if (index < accounts.length) return accounts[index].id;
  }
  if (ACCOUNT_ID_PATTERN.test(normalized)) return normalized;
  throw new Error("Select a listed Cloudflare account by number or enter a 32-character hexadecimal account ID.");
}

/**
 * Prefer the operator's environment token; otherwise use the existing
 * `wrangler login` session. When no session exists, offer a browser login once.
 */
export async function acquireWranglerCredential(
  runtime: AuthRuntime,
  environment: { CLOUDFLARE_API_TOKEN?: string | undefined } = { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN },
  options: { interactive?: boolean } = {},
): Promise<WranglerCredential> {
  const environmentToken = environment.CLOUDFLARE_API_TOKEN?.trim();
  if (environmentToken) return { mode: "api_token", token: environmentToken };
  try {
    return parseWranglerCredential(await runtime.run(AUTH_TOKEN_COMMAND, wranglerSessionOptions()));
  } catch {
    // Fall through to the guided login below; the original failure is not echoed.
  }
  const guidance = "Set an account-scoped CLOUDFLARE_API_TOKEN, or run `npx wrangler login` yourself, then rerun setup.";
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
  if (!interactive) throw new Error(`No Cloudflare credentials were found and this terminal cannot authenticate interactively. ${guidance}`);
  const approved = (await runtime.prompt("No Cloudflare login was found. Authenticate now with `npx wrangler login` in a browser? [Y/n] ")).trim();
  if (approved && !/^y(es)?$/i.test(approved)) throw new Error(`Cloudflare authentication is required before provisioning. ${guidance}`);
  try {
    await runtime.runInteractive(LOGIN_COMMAND, wranglerSessionOptions());
  } catch {
    throw new Error(`The browser login flow did not complete. ${guidance}`);
  }
  try {
    return parseWranglerCredential(await runtime.run(AUTH_TOKEN_COMMAND, wranglerSessionOptions()));
  } catch {
    throw new Error(`The browser login finished but no usable credential was available. ${guidance}`);
  }
}

/**
 * Pick the account from `wrangler whoami --json`: use the only account
 * automatically, ask which one when several exist, and fall back to a manual
 * ID prompt when Wrangler cannot list accounts.
 */
export async function chooseWranglerAccount(runtime: AuthRuntime): Promise<string> {
  let accounts: WranglerAccount[] = [];
  try {
    accounts = parseWranglerAccounts(await runtime.run(WHOAMI_COMMAND, wranglerSessionOptions()));
  } catch {
    accounts = [];
  }
  if (accounts.length === 0) return selectWranglerAccount(await runtime.prompt("Approved Cloudflare account ID: "), []);
  if (accounts.length === 1) {
    runtime.progress?.note(`Using the only authenticated Cloudflare account: ${accounts[0].name} (${accounts[0].id})`);
    return accounts[0].id;
  }
  runtime.progress?.note("Multiple Cloudflare accounts are available:");
  for (const [index, account] of accounts.entries()) runtime.progress?.note(`  ${index + 1}. ${account.name} (${account.id})`);
  return selectWranglerAccount(await runtime.prompt("Select a Cloudflare account by number or 32-character account ID: "), accounts);
}
