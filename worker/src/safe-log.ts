const SECRET_NAMES = /cookie|authorization|submit_enc|\benc\b|wfw_token|\buid\b|token|reserveId|rawStatus/i;

export function sanitizeError(error: unknown): { name: string; message: string; status?: number } {
  const source = error instanceof Error ? error.message : String(error ?? "unknown error");
  const message = source.replace(/(cookie|authorization|submit_enc|\benc\b|wfw_token|\buid\b|token)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]").slice(0, 240);
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
  return { name: error instanceof Error ? error.name : "Error", message, ...(status === undefined ? {} : { status }) };
}

export function safeLog(event: string, data: Record<string, unknown> = {}): void {
  const safe = Object.fromEntries(Object.entries(data).filter(([key, value]) => !SECRET_NAMES.test(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)));
  console.log(event, safe);
}
