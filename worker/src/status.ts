import { apiPrefix, indexForm, jsonObject, OFFICE_ORIGIN, requestText, type ApiDependencies, validTime, validDay } from "./seat-api.ts";
import type { Env, ReservationTarget } from "./types.ts";

export const STATES = ["UNRESERVED", "RESERVED_PENDING", "SIGNED_IN", "REVIEW_REQUIRED", "RELEASED", "COMPLETED", "UNKNOWN"] as const;
export type LifecycleState = typeof STATES[number];
export interface ReservationRecord { id: string; roomId: string; seatNum: string; day: string; startTime: string; endTime: string; rawStatus: string }
export interface Snapshot { state: LifecycleState; reason: string; record?: ReservationRecord; policy?: RebookPolicy }
export interface RebookPolicy { allowed: boolean; supervisionPending: boolean; blacklisted: boolean; seatAvailable: boolean }
export interface Profile { states: Record<string, LifecycleState>; responsePaths?: { current?: string; near?: string; detail?: string }; policyFields?: Record<keyof RebookPolicy, string> }
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function identity(value: unknown): string | undefined { return (typeof value === "string" && /^\d+$/.test(value) || typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ? String(value) : undefined; }
function time(value: unknown, day: string): string | undefined {
  if (typeof value === "string" && validTime(value)) return value;
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d{13}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(numeric)) return;
  const date = new Date(numeric + 8 * 3600000);
  if (!Number.isFinite(date.getTime()) || numeric % 60000 !== 0 || date.toISOString().slice(0, 10) !== day) return;
  return date.toISOString().slice(11, 16);
}
export function parseRecord(value: unknown): ReservationRecord | undefined {
  const r = object(value); if (!r) return;
  const id = identity(r.id), roomId = identity(r.roomId), seatNum = identity(r.seatNum);
  const day = r.today ?? r.day ?? r.reserveDay;
  if ([r.today, r.day, r.reserveDay].some(value => value !== undefined && value !== day)) return;
  if (!id || /^0+$/.test(id) || !roomId || !seatNum || typeof day !== "string" || !validDay(day)) return;
  const startTime = time(r.startTime, day), endTime = time(r.endTime, day);
  if (!startTime || !endTime || startTime >= endTime) return;
  const rawStatus = typeof r.status === "string" || typeof r.status === "number" && Number.isFinite(r.status) ? String(r.status) : "";
  return { id, roomId, seatNum, day, startTime, endTime, rawStatus };
}
export function matches(record: ReservationRecord, target: ReservationTarget, day: string): boolean {
  return record.roomId === target.roomId && record.seatNum === target.seatNum && record.day === day && record.startTime === target.startTime && record.endTime === target.endTime;
}
export function parseStatusProfile(value: unknown): Profile | undefined {
  const parsed = object(value);
  if (!parsed || !object(parsed.states) || Object.values(parsed.states as object).some(state => !STATES.includes(state as LifecycleState) || state === "UNRESERVED")) return;
  if (parsed.responsePaths !== undefined) {
    const paths = object(parsed.responsePaths);
    if (!paths || Object.entries(paths).some(([key, path]) => !["current", "near", "detail"].includes(key) || !validPath(path))) return;
  }
  if (parsed.policyFields !== undefined) {
    const fields = object(parsed.policyFields);
    if (!fields || Object.entries(fields).some(([key, path]) => !["allowed", "supervisionPending", "blacklisted", "seatAvailable"].includes(key) || !validPath(path))) return;
  }
  return parsed as unknown as Profile;
}
function validPath(path: unknown): path is string {
  return typeof path === "string" && /^data(?:\.[A-Za-z][A-Za-z0-9_]*){0,4}$/.test(path) && !path.split(".").some(key => ["__proto__", "constructor", "prototype"].includes(key));
}
function profile(env: Env): Profile | undefined {
  if (env.STATUS_PROFILE_VERIFIED !== "true" || !env.STATUS_PROFILE_JSON) return;
  try { return parseStatusProfile(JSON.parse(env.STATUS_PROFILE_JSON)); } catch { return; }
}
// Policy paths must be configured from school evidence; absent or mistyped fields never grant permission.
function field(body: Record<string, unknown>, path: string): unknown {
  if (!validPath(path)) return;
  return path.split(".").reduce<unknown>((current, key) => (object(current) && Object.hasOwn(current as object, key) ? (current as Record<string, unknown>)[key] : undefined), body);
}
function policyOf(body: Record<string, unknown>, env: Env): RebookPolicy | undefined {
  const fields = profile(env)?.policyFields; if (!fields) return;
  const keys = ["allowed", "supervisionPending", "blacklisted", "seatAvailable"] as const;
  const values = Object.fromEntries(keys.map(key => [key, typeof fields[key] === "string" ? field(body, fields[key]) : undefined]));
  if (keys.some(key => typeof values[key] !== "boolean")) return;
  return values as unknown as RebookPolicy;
}
export function classifyRecord(record: ReservationRecord, env: Env): Snapshot {
  const states = profile(env)?.states;
  const state = record.rawStatus !== "" && states && Object.hasOwn(states, record.rawStatus) ? states[record.rawStatus] : "UNKNOWN";
  return { state, reason: state === "UNKNOWN" ? "UNMAPPED_STATUS" : "VERIFIED_STATUS_PROFILE", record };
}
export function parseIndex(body: unknown, env: Env, target: ReservationTarget, day: string): Snapshot {
  if (!object(body)) return { state: "UNKNOWN", reason: "INVALID_INDEX_SCHEMA" };
  if (env.STATUS_PROFILE_VERIFIED === "true" && !profile(env)) return { state: "UNKNOWN", reason: "INVALID_STATUS_PROFILE" };
  const envelope = body as Record<string, unknown>;
  if (object(envelope.data)?.truncated === true) return { state: "UNKNOWN", reason: "INCOMPLETE_INDEX" };
  const paths = profile(env)?.responsePaths;
  const current = field(envelope, paths?.current ?? "data.curReserves"), near = field(envelope, paths?.near ?? "data.nearReserves");
  if (envelope.success !== true || !Array.isArray(current) || !Array.isArray(near)) return { state: "UNKNOWN", reason: "INVALID_INDEX_SCHEMA" };
  const raw = [...current, ...near];
  const records = raw.map(parseRecord);
  if (records.some(record => !record)) return { state: "UNKNOWN", reason: "INVALID_RESERVATION_RECORD" };
  const found = records.filter((record): record is ReservationRecord => Boolean(record && matches(record, target, day)));
  // A history item must not override an active reservation with a different id.
  if (new Set(found.map(record => record.id)).size > 1) return { state: "UNKNOWN", reason: "MULTIPLE_MATCHES" };
  if (found.length > 1 && new Set(found.map(record => record.rawStatus)).size > 1) return { state: "UNKNOWN", reason: "CONFLICTING_STATUS" };
  if (found[0]) return { ...classifyRecord(found[0], env), policy: policyOf(envelope, env) };
  if (records.some(record => record!.day === day)) return { state: "UNKNOWN", reason: "OTHER_RESERVATION_PRESENT" };
  return { state: "UNRESERVED", reason: "ABSENT_FROM_INDEX", policy: policyOf(envelope, env) };
}
export function parseDetail(body: unknown, env: Env, target: ReservationTarget, day: string, knownId: string): Snapshot {
  if (!object(body)) return { state: "UNKNOWN", reason: "MISSING_KNOWN_RESERVATION" };
  if (env.STATUS_PROFILE_VERIFIED === "true" && !profile(env)) return { state: "UNKNOWN", reason: "INVALID_STATUS_PROFILE" };
  const envelope = body as Record<string, unknown>;
  const record = parseRecord(field(envelope, profile(env)?.responsePaths?.detail ?? "data.seatReserve"));
  if (envelope.success !== true || !record || record.id !== knownId || !matches(record, target, day)) return { state: "UNKNOWN", reason: "MISSING_KNOWN_RESERVATION" };
  return { ...classifyRecord(record, env), policy: policyOf(envelope, env) };
}
export async function queryStatus(env: Env, target: ReservationTarget, day: string, deps: ApiDependencies = {}, knownId?: string): Promise<Snapshot> {
  try {
    const prefix = apiPrefix(env);
    const response = await requestText(env, OFFICE_ORIGIN + prefix + "/index", indexForm(env), deps);
    if (response.status !== 200) return { state: "UNKNOWN", reason: `INDEX_HTTP_${response.status}` };
    const snapshot = parseIndex(jsonObject(response.text), env, target, day);
    if (snapshot.state !== "UNRESERVED" || !knownId) return snapshot;
    // Disappearance is not release. Only an explicit matching record can establish a terminal state.
    const detail = await requestText(env, OFFICE_ORIGIN + prefix + "/getstatus", new URLSearchParams({ reserveId: knownId }), deps);
    if (detail.status !== 200) return { state: "UNKNOWN", reason: "DETAIL_HTTP_ERROR" };
    return parseDetail(jsonObject(detail.text), env, target, day, knownId);
  } catch (error) {
    return { state: "UNKNOWN", reason: (error as { code?: string }).code === "AUTH_EXPIRED" ? "AUTH_EXPIRED" : "STATUS_API_ERROR" };
  }
}
