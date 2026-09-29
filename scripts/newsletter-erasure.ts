import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { validateOperatorOrigin } from "../src/lib/newsletter-operator";
import { createTerminalUI } from "./terminal-ui";

const ui = createTerminalUI();

const args = process.argv.slice(2);
const mode = args[0] === "--local-only" ? "local_only" : args[0] === "--rebind" ? "rebind" : "resend";
const rawId = mode === "resend" ? args[0] : args[1];
if (!rawId || !/^\d+$/.test(rawId)) {
  console.error("Usage: bun run newsletter:erase -- [--local-only|--rebind] <subscriber-id>");
  process.exit(1);
}

const subscriberId = Number(rawId);
if (!Number.isSafeInteger(subscriberId) || subscriberId < 1) {
  console.error("subscriber-id must be a positive safe integer");
  process.exit(1);
}

const origin = validateOperatorOrigin(process.env.NEWSLETTER_OPERATOR_URL ?? "http://localhost:8787");
const token = process.env.NEWSLETTER_ADMIN_TOKEN;
if (!token) {
  console.error("NEWSLETTER_ADMIN_TOKEN is required");
  process.exit(1);
}

const endpoint = `${origin}/api/newsletter/admin/erase`;
const headers = { Authorization: `Bearer ${token}` };

async function request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      redirect: "error",
    });
  } catch {
    throw new Error("operator endpoint unavailable");
  }
  const expectedUrl = `${endpoint}${path}`;
  if (response.url && response.url !== expectedUrl) throw new Error("operator endpoint redirected or changed origin");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`operator endpoint returned HTTP ${response.status}`);
  }
  if (!response.ok || typeof body !== "object" || body === null) {
    throw new Error(`operator endpoint returned HTTP ${response.status}`);
  }
  return body as Record<string, unknown>;
}

try {
  ui.section("Newsletter erasure");
  ui.note(`Approved operator origin: ${origin}`);
  const preview = await ui.run("Loading erasure preview", () => request(`?subscriber_id=${subscriberId}`));
  ui.section("Impact and approval");
  ui.note(`Subscriber ID: ${subscriberId}`);
  ui.note(`Current status: ${String(preview.status)}`);
  ui.note("Subscriber rows to remove: 1");
  ui.note(`Audit rows to remove: ${String(preview.audit_row_count)}`);
  ui.note(`Outbox rows to remove: ${String(preview.outbox_row_count)}`);
  ui.note(`Outbox operation/state: ${String(preview.outbox_operation)} / ${String(preview.outbox_state)}`);
  ui.note(`Remote checkpoint: ${String(preview.remote_state)}`);
  ui.note(`Remote contact checkpoint saved: ${preview.contact_id_saved === true ? "yes" : "no"}`);
  ui.note("Remote action: resolve the retained contact, delete it by immutable ID, and verify absence.");
  ui.note("Local action: delete subscriber, audit, and outbox rows after remote verification.");

  const readline = createInterface({ input, output });
  const approvalWord = mode === "local_only" ? "ERASE_LOCAL_ONLY" : mode === "rebind" ? "REBIND_SAME_ACCOUNT" : "ERASE";
  const approval = await readline.question(`Type ${approvalWord} to approve this request: `);
  readline.close();
  if (approval !== approvalWord) {
    ui.note("Erasure request cancelled");
    process.exit(0);
  }

  const result = await ui.run("Submitting approved erasure request", () => request("", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscriber_id: subscriberId,
      approval,
      ...(mode === "rebind" ? { mode: "rebind" } : mode === "local_only" ? { mode: "local_only" } : {}),
    }),
  }));
  ui.success(`Erasure request: ${String(result.status)}`);
} catch (error) {
  ui.failure(error instanceof Error ? error.message : "Erasure request failed");
  process.exitCode = 1;
}
