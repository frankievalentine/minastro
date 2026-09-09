import type { APIContext } from "astro";
import {
  getWorkerEnv,
  fingerprintCredential,
  previewNewsletterErasure,
  rebindNewsletterErasure,
  requestNewsletterErasure,
} from "../../../../lib/newsletter";

function sameSecret(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function authorize(context: APIContext): Promise<{ db: D1Database } | Response> {
  let env: Record<string, unknown>;
  try {
    env = await getWorkerEnv();
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const token = env.NEWSLETTER_ADMIN_TOKEN;
  const authorization = context.request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (typeof token !== "string" || !token || !sameSecret(provided, token)) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  if (typeof env.NEWSLETTER_DB !== "object" || env.NEWSLETTER_DB === null) {
    return new Response("Service unavailable", { status: 503 });
  }
  return { db: env.NEWSLETTER_DB as D1Database };
}

function subscriberId(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function GET(context: APIContext): Promise<Response> {
  const authorized = await authorize(context);
  if (authorized instanceof Response) return authorized;
  const id = subscriberId(new URL(context.request.url).searchParams.get("subscriber_id"));
  if (id === null) return json({ error: "invalid_subscriber_id" }, 400);
  const preview = await previewNewsletterErasure(authorized.db, id);
  return preview ? json(preview) : json({ error: "not_found" }, 404);
}

export async function POST(context: APIContext): Promise<Response> {
  const authorized = await authorize(context);
  if (authorized instanceof Response) return authorized;

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (typeof body !== "object" || body === null) return json({ error: "invalid_request" }, 400);
  const request = body as Record<string, unknown>;
  const id = typeof request.subscriber_id === "number" && Number.isSafeInteger(request.subscriber_id)
    ? request.subscriber_id
    : null;
  if (request.mode === "rebind") {
    if (id === null || request.approval !== "REBIND_SAME_ACCOUNT") return json({ error: "approval_required" }, 400);
    const apiKey = (await getWorkerEnv()).RESEND_API_KEY;
    if (typeof apiKey !== "string" || !apiKey) return json({ status: "credential_required" }, 503);
    const result = await rebindNewsletterErasure(authorized.db, id, await fingerprintCredential(apiKey));
    if (result === "not_found") return json({ status: result }, 404);
    return json({ status: result }, result === "rebound" ? 200 : 409);
  }

  const path = request.mode === "local_only" ? "local_only" : "resend";
  const expectedApproval = path === "local_only" ? "ERASE_LOCAL_ONLY" : "ERASE";
  if (id === null || id < 1 || request.approval !== expectedApproval) {
    return json({ error: "approval_required" }, 400);
  }

  let credentialFingerprint: string | undefined;
  if (path === "resend") {
    const apiKey = (await getWorkerEnv()).RESEND_API_KEY;
    if (typeof apiKey !== "string" || !apiKey) return json({ status: "credential_required" }, 503);
    credentialFingerprint = await fingerprintCredential(apiKey);
  } else {
    const apiKey = (await getWorkerEnv()).RESEND_API_KEY;
    if (typeof apiKey === "string" && apiKey) return json({ status: "local_only_not_verified" }, 409);
  }
  const result = await requestNewsletterErasure(authorized.db, id, {
    path,
    credentialFingerprint,
  });
  if (result.status === "not_found") return json(result, 404);
  if (result.status === "credential_mismatch" || result.status === "local_only_not_verified") return json(result, 409);
  if (result.status === "credential_required") return json(result, 503);
  return json(result);
}
