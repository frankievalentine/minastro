const BOOTSTRAP_QUERY_PARAMETER = "bootstrap";
const BOOTSTRAP_COOKIE_NAME = "minastro_bootstrap";
const BOOTSTRAP_COOKIE_PATH = "/_emdash/";
const BOOTSTRAP_TOKEN_VERSION = "1";
const BOOTSTRAP_TOKEN_MAX_AGE_SECONDS = 15 * 60;
const MINIMUM_SECRET_BYTES = 32;
const ADMIN_ROLE = 50;
const CHECK_MESSAGE = "minastro first-admin bootstrap secret";

const SETUP_UI_PATH = "/_emdash/admin/setup";
const SETUP_API_PATHS = new Set([
  "/_emdash/api/setup",
  "/_emdash/api/setup/status",
  "/_emdash/api/setup/admin",
  "/_emdash/api/setup/admin/verify",
  "/_emdash/api/setup/dev-bypass",
  "/_emdash/api/setup/dev-reset",
]);

export interface BootstrapEnvironment {
  DB?: D1Database;
  EMDASH_BOOTSTRAP_SECRET?: string;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return encodeBase64Url(bytes);
}

async function importSecret(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function tokenPayload(host: string, expiresAt: number, nonce: string): Uint8Array {
  return new TextEncoder().encode(`${host}\n${BOOTSTRAP_COOKIE_PATH}\n${expiresAt}\n${nonce}`);
}

function cryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

async function createBootstrapToken(secret: string, host: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + BOOTSTRAP_TOKEN_MAX_AGE_SECONDS;
  const nonce = randomBase64Url(18);
  const key = await importSecret(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    cryptoBuffer(tokenPayload(host, expiresAt, nonce)),
  );
  return `${BOOTSTRAP_TOKEN_VERSION}.${expiresAt}.${nonce}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifyBootstrapSecret(secret: string, supplied: string): Promise<boolean> {
  const storedKey = await importSecret(secret);
  const suppliedKey = await importSecret(supplied);
  const suppliedSignature = await crypto.subtle.sign(
    "HMAC",
    suppliedKey,
    cryptoBuffer(new TextEncoder().encode(CHECK_MESSAGE)),
  );

  // Web Crypto verifies the fixed-size HMAC in constant time. The supplied
  // value is never compared as a variable-length string.
  return crypto.subtle.verify(
    "HMAC",
    storedKey,
    cryptoBuffer(new Uint8Array(suppliedSignature)),
    cryptoBuffer(new TextEncoder().encode(CHECK_MESSAGE)),
  );
}

async function verifyBootstrapToken(secret: string, host: string, token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== BOOTSTRAP_TOKEN_VERSION) return false;

  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;

  const nonce = parts[2];
  const signature = decodeBase64Url(parts[3]);
  if (!nonce || !signature) return false;

  const key = await importSecret(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    cryptoBuffer(signature),
    cryptoBuffer(tokenPayload(host, expiresAt, nonce)),
  );
}

function getCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === BOOTSTRAP_COOKIE_NAME) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

type SetupPathKind = "canonical" | "noncanonical" | null;

function decodeValidPercentEscapes(pathname: string): string {
  return pathname.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function collapsePath(pathname: string): string {
  const segments: string[] = [];
  for (const segment of pathname.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function isSetupPathFamily(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return (
    lower === SETUP_UI_PATH ||
    lower.startsWith(`${SETUP_UI_PATH}/`) ||
    lower === "/_emdash/api/setup" ||
    lower.startsWith("/_emdash/api/setup/")
  );
}

function isCanonicalSetupPath(pathname: string): boolean {
  return pathname === SETUP_UI_PATH || SETUP_API_PATHS.has(pathname);
}

function setupPathKind(pathname: string): SetupPathKind {
  const partiallyDecoded = decodeValidPercentEscapes(pathname);
  let fullyDecoded: string | null = null;
  try {
    fullyDecoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is handled by the setup-family checks below.
  }

  const candidates = [pathname, partiallyDecoded, fullyDecoded]
    .filter((candidate): candidate is string => candidate !== null)
    .flatMap((candidate) => [candidate, collapsePath(candidate)]);
  if (!candidates.some(isSetupPathFamily)) {
    const lower = partiallyDecoded.toLowerCase();
    return lower.includes("_emdash") && lower.includes("setup") ? "noncanonical" : null;
  }

  return isCanonicalSetupPath(pathname) ? "canonical" : "noncanonical";
}

function securityHeaders(): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}

function denied(status: number, message: string): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(message, { status, headers });
}

async function tableExists(database: D1Database, tableName: string): Promise<boolean | null> {
  try {
    const table = await database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .bind(tableName)
      .first<{ name: string }>();
    return table !== null;
  } catch {
    return null;
  }
}

async function isSetupComplete(database: D1Database): Promise<boolean | null> {
  const exists = await tableExists(database, "options");
  if (exists === null) return null;
  if (!exists) return false;

  try {
    const setupOption = await database
      .prepare("SELECT value FROM options WHERE name = ? LIMIT 1")
      .bind("emdash:setup_complete")
      .first<{ value: string }>();
    if (!setupOption) return false;

    try {
      const parsed = JSON.parse(setupOption.value);
      return parsed === true || parsed === "true";
    } catch {
      return false;
    }
  } catch {
    return null;
  }
}

async function hasAdministrator(database: D1Database): Promise<boolean | null> {
  const exists = await tableExists(database, "users");
  if (exists === null) return null;
  if (!exists) return false;

  try {
    const administrator = await database
      .prepare("SELECT 1 AS present FROM users WHERE role >= ? LIMIT 1")
      .bind(ADMIN_ROLE)
      .first<{ present: number }>();
    return administrator !== null;
  } catch {
    return null;
  }
}

function setCookieValue(token: string, secure: boolean): string {
  return [
    `${BOOTSTRAP_COOKIE_NAME}=${token}`,
    `Max-Age=${BOOTSTRAP_TOKEN_MAX_AGE_SECONDS}`,
    `Path=${BOOTSTRAP_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Protects the setup UI and all EmDash setup APIs until setup is persisted complete.
 * Returns null when the wrapped EmDash handler should process the request.
 */
export async function protectFirstAdminBootstrap(
  request: Request,
  environment: BootstrapEnvironment,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathKind = setupPathKind(url.pathname);
  const hasBootstrapParameter = url.searchParams.has(BOOTSTRAP_QUERY_PARAMETER);

  if (pathKind === "noncanonical") {
    return denied(400, "Noncanonical EmDash setup path.");
  }
  if (!pathKind) {
    if (hasBootstrapParameter && url.pathname.toLowerCase().startsWith("/_emdash/")) {
      return denied(400, "Bootstrap authorization is not valid for this path.");
    }
    return null;
  }

  if (!environment.DB) return denied(503, "First-admin bootstrap is unavailable.");

  const [setupComplete, administratorExists] = await Promise.all([
    isSetupComplete(environment.DB),
    hasAdministrator(environment.DB),
  ]);
  if (setupComplete === null || administratorExists === null) {
    return denied(503, "First-admin bootstrap is unavailable.");
  }
  const fullyInitialized = setupComplete && administratorExists;

  const secret = environment.EMDASH_BOOTSTRAP_SECRET;
  const host = url.host.toLowerCase();

  if (hasBootstrapParameter) {
    const suppliedValues = url.searchParams.getAll(BOOTSTRAP_QUERY_PARAMETER);
    if (suppliedValues.length !== 1) {
      return denied(400, "Bootstrap authorization is invalid.");
    }
    if (!secret || new TextEncoder().encode(secret).byteLength < MINIMUM_SECRET_BYTES) {
      return denied(503, "First-admin bootstrap is unavailable.");
    }
    if (!(await verifyBootstrapSecret(secret, suppliedValues[0]))) {
      return denied(403, "First-admin bootstrap authorization required.");
    }

    const headers = securityHeaders();
    const cleanUrl = new URL(url);
    cleanUrl.searchParams.delete(BOOTSTRAP_QUERY_PARAMETER);
    headers.set("Location", cleanUrl.toString());
    if (!fullyInitialized) {
      const token = await createBootstrapToken(secret, host);
      headers.set("Set-Cookie", setCookieValue(token, url.protocol === "https:"));
    }
    return new Response(null, { status: 303, headers });
  }

  if (fullyInitialized) return null;
  if (!secret || new TextEncoder().encode(secret).byteLength < MINIMUM_SECRET_BYTES) {
    return denied(503, "First-admin bootstrap is unavailable.");
  }

  const cookie = getCookie(request);
  if (cookie && (await verifyBootstrapToken(secret, host, cookie))) return null;
  return denied(403, "First-admin bootstrap authorization required.");
}
