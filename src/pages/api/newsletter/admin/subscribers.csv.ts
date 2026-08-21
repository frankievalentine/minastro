import type { APIContext } from "astro";
import { getWorkerEnv } from "../../../../lib/newsletter";

interface ExportRow {
  email: string;
  name: string | null;
  consent_version: string;
  first_confirmed_at: string | null;
  created_at: string;
}

function sameSecret(actual: string, expected: string) {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function csvCell(value: string | null) {
  return `"${(value ?? "").replace(/"/g, '""').replace(/[\r\n]/g, " ")}"`;
}

export async function GET(context: APIContext): Promise<Response> {
  let env: Record<string, unknown>;
  try {
    env = await getWorkerEnv();
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const db = env.NEWSLETTER_DB;
  const token = env.NEWSLETTER_ADMIN_TOKEN;
  const authorization = context.request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (typeof token !== "string" || !token || !sameSecret(provided, token)) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  if (typeof db !== "object" || db === null) {
    return new Response("Service unavailable", { status: 503 });
  }

  const result = await (db as D1Database).prepare(
    `SELECT email, name, consent_version, first_confirmed_at, created_at
     FROM newsletter_subscribers
     WHERE status = 'active'
     ORDER BY created_at ASC`,
  ).all<ExportRow>();
  const rows = [
    "email,name,consent_version,first_confirmed_at,created_at",
    ...(result.results ?? []).map((row) => [
      csvCell(row.email),
      csvCell(row.name),
      csvCell(row.consent_version),
      csvCell(row.first_confirmed_at),
      csvCell(row.created_at),
    ].join(",")),
  ];

  return new Response(rows.join("\r\n"), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": 'attachment; filename="newsletter-subscribers.csv"',
      "Content-Type": "text/csv; charset=utf-8",
    },
  });
}
