import { apiPrefix, indexForm, jsonObject, OFFICE_ORIGIN, requestText, type ApiDependencies, validTime, validDay } from "./seat-api.ts";
import type { Env, ReservationTarget } from "./types.ts";

export const STATES = ["UNRESERVED", "RESERVED_PENDING", "SIGNED_IN", "REVIEW_REQUIRED", "RELEASED", "COMPLETED", "UNKNOWN"] as const;
export type LifecycleState = typeof STATES[number];
export interface ReservationRecord { id: string; roomId: string; seatNum: string; day: string; startTime: string; endTime: string; rawStatus: string }
export interface Snapshot { state: LifecycleState; reason: string; record?: ReservationRecord; policy?: RebookPolicy }
export interface RebookPolicy { allowed: boolean; supervisionPending: boolean; blacklisted: boolean; seatAvailable: boolean }
interface Profile { states: Record<string, LifecycleState>; policyFields?: Record<keyof RebookPolicy, string> }
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
  if (!id || id === "0" || !roomId || !seatNum || typeof day !== "string" || !validDay(day)) return;
  const startTime = time(r.startTime, day), endTime = time(r.endTime, day);
  if (!startTime || !endTime || startTime >= endTime) return;
  const rawStatus = typeof r.status === "string" || typeof r.status === "number" && Number.isFinite(r.status) ? String(r.status) : "";
  return { id, roomId, seatNum, day, startTime, endTime, rawStatus };
}
export function matches(record: ReservationRecord, target: ReservationTarget, day: string): boolean {
  return record.roomId === target.roomId && record.seatNum === target.seatNum && record.day === day && record.startTime === target.startTime && record.endTime === target.endTime;
}
function profile(env: Env): Profile | undefined {
  if (env.STATUS_PROFILE_VERIFIED !== "true" || !env.STATUS_PROFILE_JSON) return;
  try {
    const parsed = JSON.parse(env.STATUS_PROFILE_JSON) as Profile;
    if (!object(parsed) || !object(parsed.states) || Object.values(parsed.states).some(state => !STATES.includes(state) || state === "UNRESERVED")) return;
    return parsed;
  } catch { return; }
}
// Policy paths must be configured from school evidence; absent or mistyped fields never grant permission.
function field(body: Record<string, unknown>, path: string): unknown {
  if (!/^data(?:\.[A-Za-z][A-Za-z0-9_]*){1,4}$/.test(path)) return;
  return path.split(".").reduce<unknown>((current, key) => object(current)?.[key], body);
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
  const state = states && Object.hasOwn(states, record.rawStatus) ? states[record.rawStatus] : "UNKNOWN";
  return { state, reason: state === "UNKNOWN" ? "UNMAPPED_STATUS" : "VERIFIED_STATUS_PROFILE", record };
}
export function parseIndex(body: Record<string, unknown>, env: Env, target: ReservationTarget, day: string): Snapshot {
  const data = object(body.data);
  if (body.success !== true || !data || !Array.isArray(data.curReserves) || !Array.isArray(data.nearReserves)) return { state: "UNKNOWN", reason: "INVALID_INDEX_SCHEMA" };
  const raw = [...data.curReserves, ...data.nearReserves];
  const records = raw.map(parseRecord);
  if (records.some(record => !record)) return { state: "UNKNOWN", reason: "INVALID_RESERVATION_RECORD" };
  const found = records.filter((record): record is ReservationRecord => Boolean(record && matches(record, target, day)));
  // A history item must not override an active reservation with a different id.
  if (new Set(found.map(record => record.id)).size > 1) return { state: "UNKNOWN", reason: "MULTIPLE_MATCHES" };
  if (found.length > 1 && new Set(found.map(record => record.rawStatus)).size > 1) return { state: "UNKNOWN", reason: "CONFLICTING_STATUS" };
  if (found[0]) return { ...classifyRecord(found[0], env), policy: policyOf(body, env) };
  if (records.some(record => record!.day === day)) return { state: "UNKNOWN", reason: "OTHER_RESERVATION_PRESENT" };
  return { state: "UNRESERVED", reason: "ABSENT_FROM_INDEX", policy: policyOf(body, env) };
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
    const body = jsonObject(detail.text), record = parseRecord(object(body.data)?.seatReserve);
    if (body.success !== true || !record || record.id !== knownId || !matches(record, target, day)) return { state: "UNKNOWN", reason: "MISSING_KNOWN_RESERVATION" };
    return { ...classifyRecord(record, env), policy: policyOf(body, env) };
  } catch (error) {
    return { state: "UNKNOWN", reason: (error as { code?: string }).code === "AUTH_EXPIRED" ? "AUTH_EXPIRED" : "STATUS_API_ERROR" };
  }
}
