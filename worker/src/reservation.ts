import { makeReservationEnc } from "./enc.ts";
import { extractSubmitEnc } from "./html.ts";
import { apiPrefix, jsonObject, officialUrl, OFFICE_ORIGIN, requestText, targetFromEnv, validDay, type ApiDependencies } from "./seat-api.ts";
import { parseRecord, matches } from "./status.ts";
import { safeLog } from "./safe-log.ts";
import { getTomorrowInShanghai } from "./time.ts";
import { AppError, type Env, type ReservationParams, type ReservationTarget, type RunResult } from "./types.ts";

export interface ReservationDependencies extends ApiDependencies { wait?: (milliseconds: number) => Promise<void> }
export interface PreparedReservation { target: ReservationTarget; params: ReservationParams; enc: string }
export type SubmitOutcome =
  | { kind: "success"; reserveId: string }
  | { kind: "rejected"; retryable: boolean; code: string }
  | { kind: "ambiguous"; code: string };

export async function prepareReservation(env: Env, deps: ReservationDependencies = {}, targetDay?: string): Promise<PreparedReservation> {
  const target = targetFromEnv(env), day = targetDay ?? getTomorrowInShanghai(deps.now?.() ?? new Date());
  if (!validDay(day)) throw new AppError("AUTH_OR_PAGE_INVALID", "INVALID_TARGET_DAY");
  const page = new URL(officialUrl(env.CHAOOXING_RESERVE_PAGE_URL, "reserve", env));
  // Preserve the original page context while requesting the correct day.
  page.searchParams.set("day", day);
  const response = await requestText(env, page.toString(), undefined, deps);
  if (response.status !== 200) throw new AppError("AUTH_OR_PAGE_INVALID", "RESERVE_PAGE_HTTP_ERROR");
  let salt: string;
  try { salt = extractSubmitEnc(response.text); } catch { throw new AppError("AUTH_OR_PAGE_INVALID", "SUBMIT_TOKEN_MISSING"); }
  // Keep the existing school's parameter set; do not transplant type/verifyData or padding from iSeatcx.
  const params: ReservationParams = { roomId: target.roomId, day, startTime: target.startTime, endTime: target.endTime, seatNum: target.seatNum, captcha: "", wyToken: "" };
  return { target, params, enc: makeReservationEnc(params, salt) };
}

// One attempt only. A transport/HTTP/parse error is never proof that a write failed.
export async function submitOnce(env: Env, prepared: PreparedReservation, deps: ReservationDependencies): Promise<SubmitOutcome> {
  try {
    const response = await requestText(env, OFFICE_ORIGIN + apiPrefix(env) + "/submit", new URLSearchParams({ ...prepared.params, enc: prepared.enc }), deps);
    if (response.status !== 200) return { kind: "ambiguous", code: "SUBMIT_HTTP_ERROR" };
    const body = jsonObject(response.text);
    if (body.success === true) {
      const data = body.data as { seatReserve?: unknown } | undefined;
      const record = parseRecord(data?.seatReserve);
      if (record && matches(record, prepared.target, prepared.params.day)) return { kind: "success", reserveId: record.id };
      return { kind: "ambiguous", code: "SUCCESS_RECORD_MISMATCH" };
    }
    if (body.success !== false) return { kind: "ambiguous", code: "INVALID_SUBMIT_SCHEMA" };
    const message = typeof body.msg === "string" ? body.msg : typeof body.message === "string" ? body.message : "";
    if (/验证码|captcha|wyToken|安全验证|风控|监督/i.test(message)) return { kind: "rejected", retryable: false, code: "MANUAL_VERIFICATION_REQUIRED" };
    if (/登录|login|session|认证|失效/i.test(message)) return { kind: "rejected", retryable: false, code: "AUTH_EXPIRED" };
    if (/已预约|已经.*预约|重复预约|already.*reserv/i.test(message)) return { kind: "ambiguous", code: "DUPLICATE_REQUIRES_READBACK" };
    return { kind: "rejected", retryable: /busy|繁忙|稍后/i.test(message), code: "EXPLICIT_REJECTION" };
  } catch { return { kind: "ambiguous", code: "SUBMIT_RESPONSE_LOST" }; }
}

// Compatibility dry-run entry. Production writes go exclusively through the persistent coordinator.
export async function runReservation(env: Env, commit: boolean, deps: ReservationDependencies = {}): Promise<RunResult> {
  if (commit) return { kind: "STATE_STORE_REQUIRED", message: "USE_PERSISTENT_COORDINATOR" };
  const prepared = await prepareReservation(env, deps);
  return { kind: "DRY_RUN", tokenFound: true, targetDay: prepared.params.day, ...prepared.target, encGenerated: true };
}
export function logRunResult(result: RunResult): void {
  safeLog(result.kind, { ...("targetDay" in result ? { day: result.targetDay } : {}), ...("reserveId" in result ? { reserveId: result.reserveId } : {}) });
}
