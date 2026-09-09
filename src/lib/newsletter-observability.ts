export type NewsletterOperation = "confirmation" | "sync" | "erase" | "maintenance" | "outbox";

export type NewsletterErrorClass =
  | "admission"
  | "configuration"
  | "credential"
  | "database"
  | "invalid_response"
  | "lease"
  | "network"
  | "provider"
  | "rate_limit"
  | "remote_state"
  | "unknown";

export type NewsletterEventName =
  | "newsletter_confirmation_delivery"
  | "newsletter_outbox_retry"
  | "newsletter_outbox_quarantine"
  | "newsletter_outbox_finalization"
  | "newsletter_scheduled_maintenance_failure";

interface NewsletterEventFields {
  operation: NewsletterOperation;
  state: string;
  revision?: number;
  error_class?: NewsletterErrorClass;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code.toLowerCase();
  }
  if (error instanceof Error) return error.name.toLowerCase();
  return "";
}

export function newsletterErrorClass(error: unknown): NewsletterErrorClass {
  const code = errorCode(error);
  if (code.includes("admission")) return "admission";
  if (code.includes("credential") || code.includes("account")) return "credential";
  if (code.includes("config")) return "configuration";
  if (code.includes("lease")) return "lease";
  if (code.includes("rate") || code.includes("429")) return "rate_limit";
  if (code.includes("network") || code.includes("timeout") || code.includes("408")) return "network";
  if (code.includes("http_3") || code.includes("http_4") || code.includes("http_5") || code.includes("unavailable")) return "provider";
  if (code.includes("invalid") || code.includes("malformed") || code.includes("redirect") || code.includes("unexpected")) {
    return "invalid_response";
  }
  if (code.includes("contact") || code.includes("remote") || code.includes("presence")) return "remote_state";
  if (code.includes("database") || code.includes("local_erasure") || code.includes("checkpoint") || code.includes("sync_error") || code.includes("erase_error")) {
    return "database";
  }
  return "unknown";
}

export function logNewsletterEvent(event: NewsletterEventName, fields: NewsletterEventFields): void {
  const payload: Record<string, string | number> = {
    event,
    operation: fields.operation,
    state: fields.state,
  };
  if (Number.isSafeInteger(fields.revision) && fields.revision !== undefined) payload.revision = fields.revision;
  if (fields.error_class) payload.error_class = fields.error_class;
  console.log(JSON.stringify(payload));
}
