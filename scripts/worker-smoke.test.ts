import { spawn } from "node:child_process";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertBootstrapDenied,
  assertBootstrapRedirect,
  assertEmptyD1Endpoint,
  assertSetupRedirect,
  assertUnavailableCms,
  assertSmokeWranglerConfig,
  cleanupSmokeResources,
  createSmokeWranglerConfig,
  createUnavailableCmsWranglerConfig,
  isPortAvailable,
  availablePort,
  smokeChildEnvironment,
} from "./worker-smoke";

describe("local Worker smoke assertions", () => {
  test("accepts the uninitialized setup redirect", () => {
    expect(() =>
      assertSetupRedirect({
        status: 302,
        location: "http://localhost:8787/_emdash/admin/setup",
      }),
    ).not.toThrow();
  });

  test("requires the generic bootstrap denial", () => {
    expect(() =>
      assertBootstrapDenied({
        status: 403,
        body: "First-admin bootstrap authorization required.",
      }),
    ).not.toThrow();
    expect(() => assertBootstrapDenied({ status: 200, body: "ok" })).toThrow();
  });

  test("accepts valid bootstrap authorization only as a clean redirect with a cookie", () => {
    expect(() =>
      assertBootstrapRedirect({
        status: 303,
        location: "http://localhost:8787/_emdash/admin/setup",
        setCookie: "minastro_bootstrap=temporary-token; HttpOnly",
      }),
    ).not.toThrow();
    expect(() => assertBootstrapRedirect({ status: 303, location: "/_emdash/admin/setup", setCookie: null })).toThrow();
  });

  test("uses endpoint-specific empty-D1 expectations and rejects unexplained 503s", () => {
    expect(() => assertEmptyD1Endpoint("/robots.txt", { status: 200 })).not.toThrow();
    expect(() => assertEmptyD1Endpoint("/_emdash/api/search", { status: 503 })).toThrow();
  });

  test("recognizes the deliberate unavailable-CMS boundary", () => {
    expect(() =>
      assertUnavailableCms({
        status: 503,
        body: "First-admin bootstrap is unavailable.",
      }),
    ).not.toThrow();
    expect(() => assertUnavailableCms({ status: 503, body: "unexpected" })).toThrow();
  });

  test("generates an isolated provisioned-looking config without deployment settings", () => {
    const config = createSmokeWranglerConfig("/repo");
    assertSmokeWranglerConfig(config);
    expect(config.name).toBe("minastro-worker-smoke");
    expect(config.d1_databases[0]?.database_name).toBe("minastro-worker-smoke-db");
    expect(createUnavailableCmsWranglerConfig("/repo").d1_databases).toEqual([]);
    expect(config).not.toHaveProperty("routes");
    expect(config).not.toHaveProperty("vars");
  });

  test("filters inherited provider credentials from the smoke child", () => {
    const environment = smokeChildEnvironment(
      {
        PATH: "/bin",
        CLOUDFLARE_API_TOKEN: "deployment-token",
        AWS_SECRET_ACCESS_KEY: "provider-secret",
        EMDASH_ENCRYPTION_KEY: "site-key",
      },
      12345,
      "/tmp/state",
      "/tmp/wrangler.jsonc",
      "/tmp/cwd",
      "smoke-secret",
    );
    expect(environment.PATH).toBe("/bin");
    expect(environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.EMDASH_ENCRYPTION_KEY).toBeUndefined();
    expect(environment.MINASTRO_CF_DEV_BOOTSTRAP_SECRET).toBe("smoke-secret");
  });

  test("cleans the owned process group, port, and state after interruption", async () => {
    const port = await availablePort();
    const stateRoot = await mkdtemp(join(tmpdir(), "minastro-worker-smoke-test-"));
    await writeFile(join(stateRoot, "owned-state"), "state");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const net = await import("node:net"); const server = net.createServer(); server.listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000);`,
      ],
      { detached: process.platform !== "win32", stdio: "ignore" },
    );
    expect(child.pid).toBeDefined();

    for (let attempt = 0; attempt < 100 && (await isPortAvailable(port)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await isPortAvailable(port)).toBe(false);

    child.kill("SIGINT");
    await cleanupSmokeResources(new Set([child]), [port], stateRoot);
    let stateExists = true;
    try {
      await access(stateRoot);
    } catch {
      stateExists = false;
    }
    expect(stateExists).toBe(false);
    expect(await isPortAvailable(port)).toBe(true);
  });
});
