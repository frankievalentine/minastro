import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { validateOperatorOrigin } from "../src/lib/newsletter-operator";

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
  console.log(`Approved operator origin: ${origin}`);
  const preview = await request(`?subscriber_id=${subscriberId}`);
  console.log(`Subscriber ID: ${subscriberId}`);
  console.log(`Current status: ${String(preview.status)}`);
  console.log(`Subscriber rows to remove: 1`);
  console.log(`Audit rows to remove: ${String(preview.audit_row_count)}`);
  console.log(`Outbox rows to remove: ${String(preview.outbox_row_count)}`);
  console.log(`Outbox operation/state: ${String(preview.outbox_operation)} / ${String(preview.outbox_state)}`);
  console.log(`Remote checkpoint: ${String(preview.remote_state)}`);
  console.log(`Remote contact checkpoint saved: ${preview.contact_id_saved === true ? "yes" : "no"}`);
  console.log("Remote action: resolve the retained contact, delete it by immutable ID, and verify absence.");
  console.log("Local action: delete subscriber, audit, and outbox rows after remote verification.");

  const readline = createInterface({ input, output });
  const approvalWord = mode === "local_only" ? "ERASE_LOCAL_ONLY" : mode === "rebind" ? "REBIND_SAME_ACCOUNT" : "ERASE";
  const approval = await readline.question(`Type ${approvalWord} to approve this request: `);
  readline.close();
  if (approval !== approvalWord) {
    console.log("Erasure request cancelled.");
    process.exit(0);
  }

  const result = await request("", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscriber_id: subscriberId,
      approval,
      ...(mode === "rebind" ? { mode: "rebind" } : mode === "local_only" ? { mode: "local_only" } : {}),
    }),
  });
  console.log(`Erasure request: ${String(result.status)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Erasure request failed");
  process.exitCode = 1;
}
