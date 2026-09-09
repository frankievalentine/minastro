import { describe, expect, mock, test } from "bun:test";

import {
  BODY_READ_TIMEOUT_MS,
  MAX_BODY_BYTES,
  generateSecureToken,
  isSecureToken,
  readJSONBody,
} from "./newsletter";

const encoder = new TextEncoder();

function streamedRequest(
  chunks: Uint8Array[],
  contentType = "application/json",
  contentLength?: string,
) {
  let canceled = false;
  const headers = new Headers({ "content-type": contentType });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  const request = new Request("https://example.test/newsletter", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { request, wasCanceled: () => canceled };
}

function rawJSONRequest(body: string | Uint8Array, contentType = "application/json") {
  return new Request("https://example.test/newsletter", {
    method: "POST",
    headers: { "content-type": contentType },
    body: body as unknown as BodyInit,
  });
}

function jsonRequest(value: unknown, contentType = "application/json") {
  return rawJSONRequest(JSON.stringify(value), contentType);
}

describe("newsletter request safety helpers", () => {
  test("rejects a chunked body that overruns the byte limit and cancels it", async () => {
    const { request, wasCanceled } = streamedRequest([
      encoder.encode('{"token":"'),
      new Uint8Array(MAX_BODY_BYTES),
      encoder.encode('"}'),
    ]);

    expect(request.headers.get("content-length")).toBeNull();
    expect(await readJSONBody(request)).toBeNull();
    expect(wasCanceled()).toBe(true);
  });

  test("rejects an oversized stream even when Content-Length is understated", async () => {
    const { request, wasCanceled } = streamedRequest(
      [encoder.encode('{"token":"'), new Uint8Array(MAX_BODY_BYTES), encoder.encode('"}')],
      "application/json",
      "1",
    );

    expect(await readJSONBody(request)).toBeNull();
    expect(wasCanceled()).toBe(true);
  });

  test("rejects raw malformed JSON bytes and invalid UTF-8", async () => {
    expect(await readJSONBody(rawJSONRequest('{"token":'))).toBeNull();
    expect(
      await readJSONBody(rawJSONRequest(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))),
    ).toBeNull();
  });

  test("accepts exactly 8192 bytes and rejects 8193 bytes", async () => {
    const prefix = '{"value":"';
    const suffix = '"}';
    const exact = prefix + "a".repeat(MAX_BODY_BYTES - encoder.encode(prefix + suffix).byteLength) + suffix;
    const over = `${exact.slice(0, -2)}a${suffix}`;

    expect(encoder.encode(exact).byteLength).toBe(MAX_BODY_BYTES);
    expect(await readJSONBody(streamedRequest([encoder.encode(exact)]).request)).toMatchObject({ value: expect.any(String) });
    expect(encoder.encode(over).byteLength).toBe(MAX_BODY_BYTES + 1);
    expect(await readJSONBody(streamedRequest([encoder.encode(over)]).request)).toBeNull();
  });

  test("counts UTF-8 bytes instead of JavaScript string code units", async () => {
    const prefix = '{"value":"';
    const suffix = '"}';
    const available = MAX_BODY_BYTES - encoder.encode(prefix + suffix).byteLength;
    const body = prefix + "😀".repeat(Math.floor(available / 4) + 1) + suffix;
    const { request } = streamedRequest([encoder.encode(body)]);

    expect(body.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(encoder.encode(body).byteLength).toBeGreaterThan(MAX_BODY_BYTES);
    expect(await readJSONBody(request)).toBeNull();
  });

  test("accepts valid JSON when a multibyte character is split across chunks", async () => {
    const body = '{"value":"😀"}';
    const bytes = encoder.encode(body);
    const emojiStart = encoder.encode('{"value":"').byteLength;
    const { request } = streamedRequest([
      bytes.slice(0, emojiStart + 2),
      bytes.slice(emojiStart + 2),
    ]);

    expect(await readJSONBody(request)).toEqual({ value: "😀" });
  });

  test("times out never-closing and slow streams and cancels them", async () => {
    expect(Number.isFinite(BODY_READ_TIMEOUT_MS)).toBe(true);
    expect(BODY_READ_TIMEOUT_MS).toBeGreaterThan(0);

    let neverCanceled = false;
    const neverClosing = new ReadableStream<Uint8Array>({
      cancel() {
        neverCanceled = true;
      },
    });
    const neverRequest = new Request("https://example.test/newsletter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: neverClosing,
      duplex: "half",
    } as RequestInit);
    expect(await readJSONBody(neverRequest, 10)).toBeNull();
    expect(neverCanceled).toBe(true);

    let slowCanceled = false;
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    const slow = new ReadableStream<Uint8Array>({
      pull(controller) {
        slowTimer = setTimeout(() => {
          if (!slowCanceled) controller.enqueue(encoder.encode("{}"));
        }, 50);
      },
      cancel() {
        slowCanceled = true;
        if (slowTimer !== undefined) clearTimeout(slowTimer);
      },
    });
    const slowRequest = new Request("https://example.test/newsletter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: slow,
      duplex: "half",
    } as RequestInit);
    expect(await readJSONBody(slowRequest, 10)).toBeNull();
    expect(slowCanceled).toBe(true);
  });

  test("does not parse valid JSON when the stream never closes before timeout", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"value":"complete"}'));
      },
      cancel() {
        canceled = true;
      },
    });
    const request = new Request("https://example.test/newsletter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);

    expect(await readJSONBody(request, 10)).toBeNull();
    expect(canceled).toBe(true);
  });

  test("rejects incompatible content types and malformed JSON", async () => {
    expect(await readJSONBody(jsonRequest({ token: "x" }, "text/plain"))).toBeNull();
    expect(await readJSONBody(jsonRequest('{"token":', "application/json"))).toBeNull();
    expect(await readJSONBody(jsonRequest(["not", "an", "object"]))).toBeNull();
  });

  test("accepts valid existing JSON payloads", async () => {
    const token = generateSecureToken();
    expect(await readJSONBody(jsonRequest({ token }))).toEqual({ token });
  });

  test("accepts only the generator's unpadded base64url token shape", () => {
    const token = generateSecureToken();
    expect(token).toHaveLength(43);
    expect(isSecureToken(token)).toBe(true);
    expect(isSecureToken(token.slice(1))).toBe(false);
    expect(isSecureToken(`${token}A`)).toBe(false);
    expect(isSecureToken(`${token.slice(0, -1)}.`)).toBe(false);
    expect(isSecureToken("😀".repeat(43))).toBe(false);
  });
});

const rateLimitCalls: string[] = [];
let rateLimitMode: "allowed" | "denied" | "error" = "denied";
const newsletterEnv = {
  NEWSLETTER_DB: {},
  NEWSLETTER_EMAIL: {},
  NEWSLETTER_SUBSCRIBE_LIMITER: {
    limit: async ({ key }: { key: string }) => {
      rateLimitCalls.push(key);
      if (rateLimitMode === "error") throw new Error("limiter unavailable");
      return { success: rateLimitMode === "allowed" };
    },
  },
  TURNSTILE_SECRET_KEY: "test-secret",
};

mock.module("cloudflare:workers", () => ({ env: newsletterEnv }));
mock.module(new URL("../site.config.ts", import.meta.url).pathname, () => ({
  siteConfig: {
    url: "https://example.test",
    newsletter: {
      enabled: true,
      senderAddress: "newsletter@example.test",
      consentVersion: "1.0",
      expectedHostname: "example.test",
    },
  },
}));

test("newsletter endpoints enforce rate limits and preserve public token responses", async () => {
  const { POST: confirm } = await import("../pages/api/newsletter/confirm");
  const { POST: unsubscribe } = await import("../pages/api/newsletter/unsubscribe");
  const { POST: subscribe } = await import("../pages/api/newsletter/subscribe");
  const originalFetch = globalThis.fetch;
  let dbCalls = 0;
  let turnstileCalls = 0;
  let dbResults: Array<{ id: number }> = [];
  newsletterEnv.NEWSLETTER_DB = {
    prepare() {
      dbCalls += 1;
      const statement = {
        bind() {
          return statement;
        },
        async run() {
          return { results: dbResults };
        },
      };
      return statement;
    },
  };
  const request = (path: string, token = generateSecureToken()) => new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.10", "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });

  try {
    rateLimitCalls.length = 0;
    rateLimitMode = "denied";
    const confirmResponse = await confirm({ request: request("/confirm") } as never);
    const unsubscribeResponse = await unsubscribe({ request: request("/unsubscribe") } as never);
    expect(confirmResponse.status).toBe(429);
    expect(unsubscribeResponse.status).toBe(429);

    rateLimitMode = "allowed";
    const allowedResponse = await confirm({
      request: new Request("https://example.test/confirm", { method: "POST" }),
    } as never);
    expect(allowedResponse.status).toBe(400);

    rateLimitMode = "error";
    const unavailableResponse = await unsubscribe({
      request: request("/unsubscribe"),
    } as never);
    expect(unavailableResponse.status).toBe(503);

    rateLimitMode = "allowed";
    dbCalls = 0;
    const malformedConfirm = await confirm({
      request: new Request("https://example.test/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "not-a-token" }),
      }),
    } as never);
    const malformedUnsubscribe = await unsubscribe({
      request: new Request("https://example.test/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "not-a-token" }),
      }),
    } as never);
    expect(malformedConfirm.status).toBe(400);
    expect(malformedUnsubscribe.status).toBe(400);
    expect(dbCalls).toBe(0);

    const publicResponses: Response[] = [];
    for (const token of [generateSecureToken(), generateSecureToken(), generateSecureToken()]) {
      dbResults = [];
      publicResponses.push(await confirm({ request: request("/confirm", token).clone() } as never));
    }
    dbResults = [{ id: 1 }];
    publicResponses.push(await confirm({ request: request("/confirm") } as never));
    for (const token of [generateSecureToken(), generateSecureToken(), generateSecureToken()]) {
      dbResults = [];
      publicResponses.push(await unsubscribe({ request: request("/unsubscribe", token).clone() } as never));
    }
    dbResults = [{ id: 1 }];
    publicResponses.push(await unsubscribe({ request: request("/unsubscribe") } as never));

    const publicBodies = await Promise.all(publicResponses.map((response) => response.clone().text()));
    expect(new Set(publicResponses.map((response) => response.status))).toEqual(new Set([200]));
    expect(new Set(publicBodies)).toEqual(new Set(['{"success":true}']));

    rateLimitMode = "denied";
    dbCalls = 0;
    let bodyPulls = 0;
    const bodyStream = new ReadableStream<Uint8Array>({
      pull() {
        bodyPulls += 1;
      },
    });
    globalThis.fetch = (async () => {
      turnstileCalls += 1;
      throw new Error("Turnstile should not be reached");
    }) as unknown as typeof fetch;
    const subscribeRequest = new Request("https://example.test/subscribe", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.10", "content-type": "application/json" },
      body: bodyStream,
      duplex: "half",
    } as RequestInit);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const pullsBeforeRateLimit = bodyPulls;
    const rejectedSubscribe = await subscribe({
      request: subscribeRequest,
    } as never);
    expect(rejectedSubscribe.status).toBe(429);
    expect(bodyPulls).toBe(pullsBeforeRateLimit);
    expect(turnstileCalls).toBe(0);
    expect(dbCalls).toBe(0);
    expect(rateLimitCalls).toContain("subscribe:203.0.113.10");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
