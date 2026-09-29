import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildWranglerDevArgs,
  hasCuratedLocalDevVars,
  resolveLocalBootstrapSecret,
  waitForLocalWorker,
} from "./run-cf-dev";

const GENERATED = "generated-local-bootstrap-secret-value-000000";

async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("local cf:dev bootstrap", () => {
  test("mints a URL-safe local secret of at least the gate's minimum length", () => {
    const first = resolveLocalBootstrapSecret(undefined, false);
    const second = resolveLocalBootstrapSecret(undefined, false);

    expect(first.source).toBe("ephemeral");
    expect(new TextEncoder().encode(first.source === "curated" ? "" : first.secret).byteLength).toBeGreaterThanOrEqual(32);
    expect(first.source === "curated" ? "" : first.secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(second).not.toEqual(first);
  });

  test("prefers an explicit secret over a curated file, honors a curated file, and rejects short explicit secrets", () => {
    const explicit = "e".repeat(40);

    expect(resolveLocalBootstrapSecret(explicit, true)).toEqual({ source: "explicit", secret: explicit });
    expect(resolveLocalBootstrapSecret("", true)).toEqual({ source: "curated" });
    expect(resolveLocalBootstrapSecret("", false, () => GENERATED)).toEqual({ source: "ephemeral", secret: GENERATED });
    expect(() => resolveLocalBootstrapSecret("too-short", true)).toThrow(/at least 32 bytes/);
  });

  test("detects a curated .dev.vars by name only, including a named environment file", () => {
    const checked: string[] = [];
    const exists = (path: string) => {
      checked.push(path);
      return path === join("/site", ".dev.vars.preview");
    };

    expect(hasCuratedLocalDevVars("/site", { MINASTRO_CF_DEV_ENV: "preview" }, exists)).toBe(true);
    expect(checked).toEqual([join("/site", ".dev.vars.preview")]);
    expect(hasCuratedLocalDevVars("/site", {}, () => false)).toBe(false);
    expect(hasCuratedLocalDevVars("/site", {}, () => true)).toBe(true);
  });

  test("binds loopback and injects the temporary secret as a local-only var", () => {
    const secret = "s".repeat(43);
    const args = buildWranglerDevArgs({ port: "8787", bootstrapSecret: secret });

    expect(args.slice(0, 8)).toEqual(["x", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", "8787"]);
    expect(args).toContain(`EMDASH_BOOTSTRAP_SECRET:${secret}`);
  });

  test("forwards isolated-run options and omits the var when a curated file owns the secret", () => {
    const args = buildWranglerDevArgs({
      port: "8788",
      persistTo: "/tmp/minastro-state",
      config: "/tmp/wrangler.jsonc",
      environment: "preview",
    });

    expect(args).toContain("--persist-to");
    expect(args).toContain("/tmp/minastro-state");
    expect(args).toContain("--config");
    expect(args).toContain("/tmp/wrangler.jsonc");
    expect(args).toContain("--env");
    expect(args).toContain("preview");
    expect(args).not.toContain("--var");
  });

  test("waits for the local Worker, and gives up when it exits or never answers", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("First-admin bootstrap authorization required.", { status: 403 }),
    });
    try {
      await waitForLocalWorker(`http://127.0.0.1:${server.port}`, () => true, 5_000);
    } finally {
      await server.stop(true);
    }

    const exited = await rejectionOf(waitForLocalWorker("http://127.0.0.1:1", () => false, 1_000));
    expect(String(exited)).toContain("exited");

    const timedOut = await rejectionOf(waitForLocalWorker("http://127.0.0.1:1", () => true, 200));
    expect(String(timedOut)).toContain("Timed out");
  });
});
