import { AppError, type Env, type ReservationTarget } from "./types.ts";

export const OFFICE_ORIGIN = "https://office.chaoxing.com";
export interface ApiDependencies { fetchImpl?: typeof fetch; now?: () => Date; timeoutMs?: number }
export function targetFromEnv(env: Env): ReservationTarget {
  const target = { roomId: env.ROOM_ID ?? "3747", seatNum: env.SEAT_NUM ?? "216", startTime: env.START_TIME ?? "08:30", endTime: env.END_TIME ?? "22:00" };
  if (!/^\d+$/.test(target.roomId) || !/^\d+$/.test(target.seatNum) || !validTime(target.startTime) || !validTime(target.endTime) || target.startTime >= target.endTime) throw new AppError("AUTH_OR_PAGE_INVALID", "INVALID_TARGET");
  return target;
}
export function validTime(value: string): boolean { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
export function validDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}
export function apiPrefix(env: Env): string {
  const style = env.API_STYLE ?? "seat";
  if (style !== "seat" && style !== "seatengine") throw new AppError("AUTH_OR_PAGE_INVALID", "UNSUPPORTED_API_STYLE");
  return `/data/apps/${style}`;
}
export function officialUrl(raw: string | undefined, kind: "reserve" | "hall", env: Env): string {
  if (!raw) throw new AppError("AUTH_OR_PAGE_INVALID", "OFFICIAL_URL_REQUIRED");
  let url: URL; try { url = new URL(raw); } catch { throw new AppError("AUTH_OR_PAGE_INVALID", "INVALID_OFFICIAL_URL"); }
  const style = (apiPrefix(env).endsWith("seatengine") ? "seatengine" : "seat");
  const root = style === "seat" ? "/front/third/apps/seat/" : "/front/apps/seatengine/";
  const allowed = kind === "reserve" ? ["select", "code"] : ["index", "select", "code"];
  if (url.origin !== OFFICE_ORIGIN || url.username || url.password || !allowed.some(path => url.pathname === root + path)) throw new AppError("AUTH_OR_PAGE_INVALID", "OFFICIAL_URL_NOT_ALLOWED");
  url.hash = ""; return url.toString();
}
function cookieHeaders(env: Env): Record<string, string> {
  if (!env.CHAOOXING_COOKIE?.trim()) throw new AppError("AUTH_EXPIRED", "COOKIE_REQUIRED");
  return { Cookie: env.CHAOOXING_COOKIE, Accept: "application/json, text/html", "X-Requested-With": "XMLHttpRequest", Origin: OFFICE_ORIGIN };
}
// Timeout covers response body consumption as well as headers. Never follow a credentialed redirect.
export async function requestText(env: Env, url: string, body: URLSearchParams | undefined, deps: ApiDependencies = {}): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 8000);
  try {
    const response = await (deps.fetchImpl ?? fetch)(url, { method: body ? "POST" : "GET", redirect: "manual", signal: controller.signal,
      headers: { ...cookieHeaders(env), ...(body ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: officialUrl(env.CHAOOXING_RESERVE_PAGE_URL, "reserve", env) } : {}) }, body: body?.toString() });
    if (response.status === 401 || response.status === 403 || response.status >= 300 && response.status < 400 || response.redirected) throw new AppError("AUTH_EXPIRED", "AUTH_OR_REDIRECT");
    const text = await response.text();
    if (text.length > 1_000_000) throw new AppError("AUTH_OR_PAGE_INVALID", "RESPONSE_TOO_LARGE");
    return { status: response.status, text };
  } finally { clearTimeout(timer); }
}
export function jsonObject(text: string): Record<string, unknown> {
  let body: unknown; try { body = JSON.parse(text); } catch { throw new AppError("AUTH_OR_PAGE_INVALID", "INVALID_JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("AUTH_OR_PAGE_INVALID", "INVALID_JSON_OBJECT");
  return body as Record<string, unknown>;
}
// Parameter mapping adapted from iSeatcx server/cxclient.go; no school defaults are copied.
export function indexForm(env: Env): URLSearchParams {
  if (apiPrefix(env).endsWith("seatengine")) {
    if (!env.SEAT_ID || !env.SEAT_ID_ENC) throw new AppError("AUTH_OR_PAGE_INVALID", "SCHOOL_PARAMETERS_REQUIRED");
    return new URLSearchParams({ seatId: env.SEAT_ID, seatIdEnc: env.SEAT_ID_ENC });
  }
  if (!env.FID_ENC) throw new AppError("AUTH_OR_PAGE_INVALID", "SCHOOL_PARAMETERS_REQUIRED");
  return new URLSearchParams({ fidEnc: env.FID_ENC, r: String(Math.random() * 100) });
}
