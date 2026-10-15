import { targetFromEnv, validDay, validTime } from "./seat-api.ts";
import type { Env, ReservationTarget } from "./types.ts";

export interface TimeTemplate { id: string; name: string; startTime: string; endTime: string }
export interface ReservationPlan {
  planId: string; revision: number; effectiveDay: string; enabled: boolean;
  roomId: string; seatCandidates: string[]; bookingStrategy: "EXACT" | "ORDERED" | "QUERY_ONLY";
  dateMode: "TOMORROW" | "DATE" | "WEEKLY"; date: string; weekdays: number[]; pausedDays: string[];
  templates: TimeTemplate[]; defaultTemplateId: string;
  overrides: { day: string; templateId: string }[];
  checkinMode: "OFFICIAL_PRESENCE"; notifications: boolean;
}
export interface PlanStore { schemaVersion: 1; current: ReservationPlan; history: ReservationPlan[]; audit: { revision: number; at: number; fields: string[] }[] }
export interface RoomRules {
  evidenceId: string; roomId: string; validFrom: string; validThrough: string;
  advanceDays: number; openTime: string; startTime: string; endTime: string;
  stepMinutes: number; minMinutes: number; maxMinutes: number;
}
export class PlanError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
export function shanghaiDay(now: number): string { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
export function addDays(day: string, count: number): string { return new Date(Date.parse(day + "T00:00:00Z") + count * 86400000).toISOString().slice(0, 10); }
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(v);
const numeric = (v: unknown) => typeof v === "string" && /^\d{1,16}$/.test(v);
function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new PlanError("INVALID_FIELDS");
  return value as Record<string, unknown>;
}
function unique<T>(value: T[]): boolean { return new Set(value).size === value.length; }
export function migratePlan(env: Env, now: number): PlanStore {
  const t = targetFromEnv(env), today = shanghaiDay(now);
  return { schemaVersion: 1, current: { planId: "default", revision: 0, effectiveDay: today, enabled: false,
    roomId: t.roomId, seatCandidates: [t.seatNum], bookingStrategy: "QUERY_ONLY", dateMode: "TOMORROW", date: addDays(today, 1),
    weekdays: [0, 1, 2, 3, 4, 5, 6], pausedDays: [], templates: [{ id: "legacy", name: "原部署时段", startTime: t.startTime, endTime: t.endTime }],
    defaultTemplateId: "legacy", overrides: [], checkinMode: "OFFICIAL_PRESENCE", notifications: true }, history: [], audit: [] };
}
export function validatePlan(value: unknown): ReservationPlan {
  const p = exact(value, ["planId", "revision", "effectiveDay", "enabled", "roomId", "seatCandidates", "bookingStrategy", "dateMode", "date", "weekdays", "pausedDays", "templates", "defaultTemplateId", "overrides", "checkinMode", "notifications"]);
  if (!id(p.planId) || !Number.isSafeInteger(p.revision) || Number(p.revision) < 0 || typeof p.effectiveDay !== "string" || !validDay(p.effectiveDay)
    || typeof p.enabled !== "boolean" || !numeric(p.roomId) || !Array.isArray(p.seatCandidates) || p.seatCandidates.length < 1 || p.seatCandidates.length > 10
    || !p.seatCandidates.every(numeric) || !unique(p.seatCandidates) || !["EXACT", "ORDERED", "QUERY_ONLY"].includes(String(p.bookingStrategy))
    || !["TOMORROW", "DATE", "WEEKLY"].includes(String(p.dateMode)) || typeof p.date !== "string" || !validDay(p.date)
    || !Array.isArray(p.weekdays) || !p.weekdays.length || !unique(p.weekdays) || !p.weekdays.every(n => Number.isInteger(n) && n >= 0 && n <= 6)
    || !Array.isArray(p.pausedDays) || p.pausedDays.length > 60 || !unique(p.pausedDays) || !p.pausedDays.every(d => typeof d === "string" && validDay(d))
    || p.checkinMode !== "OFFICIAL_PRESENCE" || typeof p.notifications !== "boolean") throw new PlanError("INVALID_PLAN");
  if (!Array.isArray(p.templates) || p.templates.length < 1 || p.templates.length > 12) throw new PlanError("INVALID_TEMPLATES");
  for (const value of p.templates) {
    const t = exact(value, ["id", "name", "startTime", "endTime"]);
    if (!id(t.id) || typeof t.name !== "string" || !t.name.trim() || t.name.length > 40 || /[<>\x00-\x1f]/.test(t.name)
      || typeof t.startTime !== "string" || typeof t.endTime !== "string" || !validTime(t.startTime) || !validTime(t.endTime) || t.startTime >= t.endTime) throw new PlanError("INVALID_TEMPLATE");
  }
  const ids = p.templates.map(t => t.id);
  if (!unique(ids) || !ids.includes(p.defaultTemplateId)) throw new PlanError("INVALID_DEFAULT_TEMPLATE");
  if (!Array.isArray(p.overrides) || p.overrides.length > 60) throw new PlanError("INVALID_OVERRIDES");
  for (const value of p.overrides) {
    const o = exact(value, ["day", "templateId"]);
    if (typeof o.day !== "string" || !validDay(o.day) || !ids.includes(o.templateId)) throw new PlanError("INVALID_OVERRIDE");
  }
  if (!unique(p.overrides.map(o => o.day))) throw new PlanError("DUPLICATE_OVERRIDE");
  return structuredClone(p) as unknown as ReservationPlan;
}
export function rulesFromEnv(env: Env, roomId: string, day: string): RoomRules | undefined {
  if (env.RESERVATION_RULES_VERIFIED !== "true") return;
  try {
    const rules: unknown = JSON.parse(env.RESERVATION_RULES_JSON ?? "");
    if (!Array.isArray(rules) || rules.length > 20) return;
    const matches = rules.filter(r => r?.roomId === roomId && r.validFrom <= day && r.validThrough >= day);
    if (matches.length !== 1) return;
    const r = exact(matches[0], ["evidenceId", "roomId", "validFrom", "validThrough", "advanceDays", "openTime", "startTime", "endTime", "stepMinutes", "minMinutes", "maxMinutes"]);
    if (!id(r.evidenceId) || !numeric(r.roomId) || typeof r.validFrom !== "string" || typeof r.validThrough !== "string" || !validDay(r.validFrom) || !validDay(r.validThrough)
      || !Number.isInteger(r.advanceDays) || Number(r.advanceDays) < 0 || Number(r.advanceDays) > 30
      || ![r.openTime, r.startTime, r.endTime].every(t => typeof t === "string" && validTime(t)) || String(r.startTime) >= String(r.endTime)
      || ![r.stepMinutes, r.minMinutes, r.maxMinutes].every(n => Number.isInteger(n) && Number(n) > 0 && Number(n) <= 1440) || Number(r.minMinutes) > Number(r.maxMinutes)) return;
    return r as unknown as RoomRules;
  } catch { return; }
}
export function planForDay(store: PlanStore, day: string): ReservationPlan | undefined {
  return [...store.history, store.current].filter(p => p.effectiveDay <= day).sort((a, b) => b.revision - a.revision)[0];
}
export function targetForPlan(plan: ReservationPlan, day: string, seat = plan.seatCandidates[0]): ReservationTarget {
  const template = plan.templates.find(t => t.id === (plan.overrides.find(o => o.day === day)?.templateId ?? plan.defaultTemplateId))!;
  return { roomId: plan.roomId, seatNum: seat, startTime: template.startTime, endTime: template.endTime };
}
export function envForTarget(env: Env, t: ReservationTarget): Env { return { ...env, ROOM_ID: t.roomId, SEAT_NUM: t.seatNum, START_TIME: t.startTime, END_TIME: t.endTime }; }
export function previewPlan(plan: ReservationPlan, day: string, env: Env, now: number) {
  if (!validDay(day)) throw new PlanError("INVALID_TARGET_DAY");
  const target = targetForPlan(plan, day), reasons: string[] = [], today = shanghaiDay(now);
  if (!plan.enabled) reasons.push("PLAN_DISABLED");
  if (day < plan.effectiveDay || day < today) reasons.push("DAY_BEFORE_EFFECTIVE_OR_TODAY");
  if (plan.dateMode === "DATE" && day !== plan.date || plan.dateMode === "TOMORROW" && day !== addDays(today, 1)
    || plan.dateMode === "WEEKLY" && !plan.weekdays.includes(new Date(day + "T00:00:00Z").getUTCDay()) || plan.pausedDays.includes(day)) reasons.push("DAY_EXCLUDED");
  if (Date.parse(`${day}T${target.startTime}:00+08:00`) <= now) reasons.push("START_TIME_PASSED");
  const rule = rulesFromEnv(env, plan.roomId, day);
  let openAt: number | undefined;
  if (!rule) reasons.push("OFFICIAL_RULES_UNVERIFIED");
  else {
    openAt = Date.parse(`${addDays(day, -rule.advanceDays)}T${rule.openTime}:00+08:00`);
    if (day > addDays(today, rule.advanceDays)) reasons.push("ADVANCE_DAYS_EXCEEDED");
    const start = minutes(target.startTime), end = minutes(target.endTime), base = minutes(rule.startTime);
    if (target.startTime < rule.startTime || target.endTime > rule.endTime || (start - base) % rule.stepMinutes || (end - base) % rule.stepMinutes
      || end - start < rule.minMinutes || end - start > rule.maxMinutes) reasons.push("OFFICIAL_TIME_RULE_VIOLATION");
    if (now < openAt) reasons.push("NOT_OPEN_YET");
  }
  return { day, planId: plan.planId, revision: plan.revision, target, openAt, officialRules: rule, evidenceId: rule?.evidenceId, reasons, valid: reasons.length === 0, writesEnabled: env.WRITES_ENABLED === "true" };
}
