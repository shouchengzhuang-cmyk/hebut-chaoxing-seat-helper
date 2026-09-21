import { makeReservationEnc } from "./enc.ts";
import { extractSubmitEnc } from "./html.ts";
import { safeLog } from "./safe-log.ts";
import { getTomorrowInShanghai } from "./time.ts";
import { AppError, type Env, type ReservationParams, type ReservationSuccess, type ReservationTarget, type RunResult } from "./types.ts";

const OFFICE_ORIGIN = "https://office.chaoxing.com";
const SUBMIT_URL = `${OFFICE_ORIGIN}/data/apps/seat/submit`;
const RESERVE_INFO_URL = `${OFFICE_ORIGIN}/data/apps/seat/reserve/info`;
const RETRY_DELAYS_MS = [300, 700, 1500, 3000];

export interface ReservationDependencies {
  fetchImpl?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

interface PreparedReservation {
  target: ReservationTarget;
  params: ReservationParams;
  submitEnc: string;
  enc: string;
}

function targetFromEnv(env: Env): ReservationTarget {
  return {
    roomId: env.ROOM_ID ?? "3747",
    seatNum: env.SEAT_NUM ?? "216",
    startTime: env.START_TIME ?? "08:30",
    endTime: env.END_TIME ?? "22:00",
  };
}

function cookieHeaders(env: Env, contentType = false): HeadersInit {
  if (!env.CHAOOXING_COOKIE?.trim()) throw new AppError("AUTH_EXPIRED", "CHAOOXING_COOKIE is missing; update the secret");
  return {
    Cookie: env.CHAOOXING_COOKIE,
    ...(contentType ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Origin: OFFICE_ORIGIN,
  };
}

function authOrPageInvalid(response: Response): boolean {
  return response.status === 401 || response.status === 403 || response.redirected || /passport|login/i.test(response.url);
}

function messageOf(body: unknown): string {
  if (!body || typeof body !== "object") return "request failed";
  const source = body as Record<string, unknown>;
  return [source.msg, source.message, (source.error as Record<string, unknown> | undefined)?.message].find((value): value is string => typeof value === "string") ?? "request failed";
}

function needsManualVerification(message: string): boolean { return /captcha|验证码|网易|wyToken|security\s*verify|安全验证|风控/i.test(message); }
function authenticationFailed(message: string): boolean { return /登录|login|认证|session|未登录|失效/i.test(message); }
function retryable(message: string): boolean { return /busy|繁忙|稍后|timeout|超时|系统错误|system error/i.test(message); }
function alreadyReserved(message: string): boolean { return /已经.*预约|已预约|重复预约|already.*reserv/i.test(message); }

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return { message: "response was not JSON" }; }
}

function matchingReservation(candidate: unknown, target: ReservationTarget, day: string): ReservationSuccess | null {
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  const roomId = record.roomId == null ? "" : String(record.roomId);
  const seatNum = record.seatNum == null ? "" : String(record.seatNum);
  const reserveDay = record.today ?? record.day ?? record.reserveDay;
  if (roomId !== target.roomId || seatNum !== target.seatNum || reserveDay !== day) return null;
  return { reserveId: (record.id as string | number | undefined) ?? null, day, roomId, seatNum };
}

function findReservation(value: unknown, target: ReservationTarget, day: string): ReservationSuccess | null {
  const direct = matchingReservation(value, target, day); if (direct) return direct;
  if (Array.isArray(value)) return value.map((item) => findReservation(item, target, day)).find((item): item is ReservationSuccess => item !== null) ?? null;
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).map((item) => findReservation(item, target, day)).find((item): item is ReservationSuccess => item !== null) ?? null;
  return null;
}

export async function prepareReservation(env: Env, dependencies: ReservationDependencies = {}): Promise<PreparedReservation> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const target = targetFromEnv(env);
  if (!env.CHAOOXING_RESERVE_PAGE_URL?.trim()) throw new AppError("AUTH_OR_PAGE_INVALID", "CHAOOXING_RESERVE_PAGE_URL is missing");
  const response = await fetchImpl(env.CHAOOXING_RESERVE_PAGE_URL, { headers: cookieHeaders(env) });
  if (authOrPageInvalid(response)) throw new AppError("AUTH_EXPIRED", "reserve page authentication is invalid", response.status);
  if (!response.ok) throw new AppError("AUTH_OR_PAGE_INVALID", "reserve page request failed", response.status);
  let submitEnc: string;
  try { submitEnc = extractSubmitEnc(await response.text()); } catch { throw new AppError("AUTH_OR_PAGE_INVALID", "reserve page did not provide submit_enc", response.status); }
  const day = getTomorrowInShanghai(dependencies.now?.() ?? new Date());
  const params: ReservationParams = { roomId: target.roomId, day, startTime: target.startTime, endTime: target.endTime, seatNum: target.seatNum, captcha: "", wyToken: "" };
  return { target, params, submitEnc, enc: makeReservationEnc(params, submitEnc) };
}

async function checkExistingReservation(env: Env, prepared: PreparedReservation, dependencies: ReservationDependencies): Promise<ReservationSuccess | null> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(RESERVE_INFO_URL, {
    method: "POST",
    headers: { ...cookieHeaders(env, true), Referer: env.CHAOOXING_RESERVE_PAGE_URL! },
    body: new URLSearchParams({ id: prepared.target.roomId, seatNum: prepared.target.seatNum }).toString(),
  });
  if (authOrPageInvalid(response)) throw new AppError("AUTH_EXPIRED", "reservation info authentication is invalid", response.status);
  return response.ok ? findReservation(await responseJson(response), prepared.target, prepared.params.day) : null;
}

async function submitOnce(env: Env, prepared: PreparedReservation, dependencies: ReservationDependencies): Promise<{ success?: ReservationSuccess; retry: boolean; message: string; checkExisting: boolean }> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(SUBMIT_URL, {
      method: "POST",
      headers: { ...cookieHeaders(env, true), Referer: env.CHAOOXING_RESERVE_PAGE_URL! },
      body: new URLSearchParams({ ...prepared.params, enc: prepared.enc }).toString(),
    });
  } catch { return { retry: true, message: "network error", checkExisting: false }; }
  if (authOrPageInvalid(response)) throw new AppError("AUTH_EXPIRED", "submit authentication is invalid", response.status);
  const body = await responseJson(response); const message = messageOf(body);
  if (!response.ok) return { retry: response.status >= 500, message, checkExisting: false };
  if ((body as { success?: unknown })?.success === true) {
    const success = matchingReservation((body as { data?: { seatReserve?: unknown } }).data?.seatReserve, prepared.target, prepared.params.day);
    if (!success) throw new AppError("RESERVATION_FAILED", "successful response did not match requested seat and day");
    return { success, retry: false, message: "", checkExisting: false };
  }
  if (authenticationFailed(message)) throw new AppError("AUTH_EXPIRED", "submit authentication is invalid");
  if (needsManualVerification(message)) throw new AppError("MANUAL_VERIFICATION_REQUIRED", "manual verification is required");
  return { retry: retryable(message), message, checkExisting: alreadyReserved(message) };
}

export async function submitPreparedReservation(env: Env, prepared: PreparedReservation, dependencies: ReservationDependencies = {}): Promise<RunResult> {
  const wait = dependencies.wait ?? ((milliseconds: number) => scheduler.wait(milliseconds));
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const outcome = await submitOnce(env, prepared, dependencies);
    if (outcome.success) return { kind: "RESERVATION_SUCCESS", targetDay: prepared.params.day, ...prepared.target, reserveId: outcome.success.reserveId };
    if (outcome.checkExisting) {
      const existing = await checkExistingReservation(env, prepared, dependencies);
      if (existing) return { kind: "ALREADY_RESERVED", targetDay: prepared.params.day, ...prepared.target, reserveId: existing.reserveId };
      return { kind: "RESERVATION_FAILED", targetDay: prepared.params.day, message: "already-reserved response could not be verified" };
    }
    if (!outcome.retry || attempt === RETRY_DELAYS_MS.length) return { kind: "RESERVATION_FAILED", targetDay: prepared.params.day, message: outcome.message.slice(0, 160) };
    await wait(RETRY_DELAYS_MS[attempt]);
  }
  return { kind: "RESERVATION_FAILED", targetDay: prepared.params.day, message: "retry limit reached" };
}

export async function runReservation(env: Env, commit: boolean, dependencies: ReservationDependencies = {}): Promise<RunResult> {
  const prepared = await prepareReservation(env, dependencies);
  if (!commit) return { kind: "DRY_RUN", tokenFound: true, targetDay: prepared.params.day, ...prepared.target, encGenerated: true };
  return submitPreparedReservation(env, prepared, dependencies);
}

export function logRunResult(result: RunResult): void {
  if (result.kind === "RESERVATION_SUCCESS" || result.kind === "ALREADY_RESERVED") safeLog(result.kind, { day: result.targetDay, roomId: result.roomId, seatNum: result.seatNum, startTime: result.startTime, endTime: result.endTime, reserveId: result.reserveId });
  else if ("message" in result) safeLog(result.kind, { targetDay: result.targetDay ?? null, message: result.message });
}
