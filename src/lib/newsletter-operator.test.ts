import { describe, expect, test } from "bun:test";

import { validateOperatorOrigin } from "./newsletter-operator";

describe("newsletter operator origin validation", () => {
  test("accepts HTTPS origins and loopback HTTP development", () => {
    expect(validateOperatorOrigin("https://newsletter.example.test/")).toBe("https://newsletter.example.test");
    expect(validateOperatorOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(validateOperatorOrigin("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
  });

  test("rejects non-loopback HTTP, credentials, query, fragments, and paths", () => {
    for (const origin of [
      "http://newsletter.example.test",
      "https://user:pass@newsletter.example.test",
      "https://newsletter.example.test?token=secret",
      "https://newsletter.example.test/#fragment",
      "https://newsletter.example.test/admin",
    ]) {
      expect(() => validateOperatorOrigin(origin)).toThrow();
    }
  });
});
