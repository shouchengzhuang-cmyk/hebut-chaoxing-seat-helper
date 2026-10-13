import { validDay, validTime, targetFromEnv } from "./seat-api.ts";
import type { Env, ReservationTarget } from "./types.ts";
export interface CheckinWindow {
  timeZone: "Asia/Shanghai";
  reservationStart: string;
  earliestCheckin: string;
  latestCheckin: string;
  earlyMinutes: number;
  lateMinutes: number;
  clockPhase: "BEFORE_WINDOW" | "IN_WINDOW" | "AFTER_WINDOW";
  advisoryOnly: true;
}
function offset(value: string | undefined): number {
  if (value === undefined) return 30;
  if (!/^\d+$/.test(value) || Number(value) > 1440) throw new Error("INVALID_CHECKIN_OFFSET");
  return Number(value);
}
function shanghaiIso(timestamp: number): string { return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 19) + "+08:00"; }
export function reservationEnd(day: string, target: ReservationTarget): number {
  if (!validDay(day) || !validTime(target.endTime)) throw new Error("INVALID_INTERVAL");
  return Date.parse(`${day}T${target.endTime}:00+08:00`);
}
export function checkinWindow(env: Env, day: string, now: number, target = targetFromEnv(env)): CheckinWindow {
  if (!validDay(day) || !validTime(target.startTime) || !Number.isFinite(now)) throw new Error("INVALID_CHECKIN_INPUT");
  const earlyMinutes = offset(env.CHECKIN_EARLY_MINUTES), lateMinutes = offset(env.CHECKIN_LATE_MINUTES);
  const start = Date.parse(`${day}T${target.startTime}:00+08:00`), earliest = start - earlyMinutes * 60000, latest = start + lateMinutes * 60000;
  return { timeZone: "Asia/Shanghai", reservationStart: shanghaiIso(start), earliestCheckin: shanghaiIso(earliest), latestCheckin: shanghaiIso(latest), earlyMinutes, lateMinutes,
    clockPhase: now < earliest ? "BEFORE_WINDOW" : now > latest ? "AFTER_WINDOW" : "IN_WINDOW", advisoryOnly: true };
}
