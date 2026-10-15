import { PlanError } from "./plans.ts";

export async function readManagementJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw new PlanError("JSON_REQUIRED", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new PlanError("INVALID_BODY");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new PlanError("BODY_TOO_LARGE", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new PlanError("INVALID_JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PlanError("INVALID_BODY");
  return body as Record<string, unknown>;
}

// Internal journals keep real IDs for reconciliation; management output keeps presence
// only. No raw school text is needed to render supported business states.
export function publicResult(value: unknown, key = ""): unknown {
  if (key === "rawStatus") return undefined;
  if (key === "reserveId") return value === null ? null : "[present]";
  if (key === "operationId") return "CHECKIN_TRACKED";
  if (Array.isArray(value)) return value.map(v => publicResult(v));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const record = Object.hasOwn(object, "roomId") && Object.hasOwn(object, "day") && Object.hasOwn(object, "id");
  const event = Object.hasOwn(object, "kind") && Object.hasOwn(object, "at") && Object.hasOwn(object, "id");
  return Object.fromEntries(Object.entries(object).filter(([k]) => k !== "rawStatus").map(([k, v]) => [k.replace(/released:\d+/g, "released:[present]"),
    k === "id" && record ? "[present]" : k === "id" && event ? `${object.kind}:${object.at}` : publicResult(v, k)]));
}
