import { expect, test } from "bun:test";

import { sendConfirmationEmail } from "./newsletter";
import { logNewsletterEvent } from "./newsletter-observability";

function captureLogs() {
  const lines: unknown[] = [];
  const original = console.log;
  console.log = ((...args: unknown[]) => {
    lines.push(args[0]);
  }) as typeof console.log;
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

test("confirmation delivery observability is structured and excludes sensitive values", async () => {
  const logs = captureLogs();
  const email = "person@example.test";
  const name = "Private Name";
  const token = "private-confirmation-token";
  try {
    await sendConfirmationEmail(
      {
        NEWSLETTER_EMAIL: {
          send: async () => undefined,
        },
      } as never,
      email,
      name,
      token,
      "https://example.test",
      "newsletter@example.test",
    );
  } finally {
    logs.restore();
  }

  expect(logs.lines).toHaveLength(1);
  const line = String(logs.lines[0]);
  expect(JSON.parse(line)).toEqual({
    event: "newsletter_confirmation_delivery",
    operation: "confirmation",
    state: "accepted",
  });
  for (const sensitiveValue of [email, name, token, "newsletter/confirm", "Confirm your newsletter subscription"]) {
    expect(line).not.toContain(sensitiveValue);
  }
});

test("failed confirmation observability records only a stable error class", async () => {
  const logs = captureLogs();
  const sensitiveError = new Error("provider rejected person@example.test token=private-confirmation-token");
  try {
    let rejected: unknown;
    try {
      await sendConfirmationEmail(
        {
          NEWSLETTER_EMAIL: {
            send: async () => {
              throw sensitiveError;
            },
          },
        } as never,
        "person@example.test",
        "Private Name",
        "private-confirmation-token",
        "https://example.test",
        "newsletter@example.test",
      );
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBe(sensitiveError);
  } finally {
    logs.restore();
  }

  expect(JSON.parse(String(logs.lines[0]))).toEqual({
    event: "newsletter_confirmation_delivery",
    operation: "confirmation",
    state: "failed",
    error_class: "unknown",
  });
  expect(String(logs.lines[0])).not.toContain("person@example.test");
  expect(String(logs.lines[0])).not.toContain("private-confirmation-token");
});

test("outbox and maintenance events contain only bounded operational fields", () => {
  const logs = captureLogs();
  try {
    logNewsletterEvent("newsletter_outbox_retry", {
      operation: "erase",
      revision: 7,
      state: "ready",
      error_class: "network",
    });
    logNewsletterEvent("newsletter_outbox_quarantine", {
      operation: "outbox",
      state: "uncertain",
      error_class: "invalid_response",
    });
    logNewsletterEvent("newsletter_outbox_finalization", {
      operation: "erase",
      revision: 7,
      state: "completed",
    });
    logNewsletterEvent("newsletter_scheduled_maintenance_failure", {
      operation: "maintenance",
      state: "failed",
      error_class: "database",
    });
  } finally {
    logs.restore();
  }

  expect(logs.lines).toHaveLength(4);
  for (const line of logs.lines) {
    const event = JSON.parse(String(line)) as Record<string, unknown>;
    expect(Object.keys(event).every((key) => ["event", "operation", "revision", "state", "error_class"].includes(key))).toBe(true);
    expect(String(line)).not.toContain("person@example.test");
    expect(String(line)).not.toContain("private-confirmation-token");
    expect(String(line)).not.toContain("contact-id");
    expect(String(line)).not.toContain("response-body");
  }
});
