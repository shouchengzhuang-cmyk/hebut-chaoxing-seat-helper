export interface Env {
  CHAOOXING_COOKIE?: string;
  CHAOOXING_RESERVE_PAGE_URL?: string;
  ADMIN_TOKEN?: string;
  ROOM_ID?: string;
  SEAT_NUM?: string;
  START_TIME?: string;
  END_TIME?: string;
  CHECKIN_EARLY_MINUTES?: string;
  CHECKIN_LATE_MINUTES?: string;
  SEAT_ACCOUNT?: DurableObjectNamespace;
  WRITES_ENABLED?: string;
  MONITOR_ENABLED?: string;
  AUTO_REBOOK_ENABLED?: string;
  REBOOK_RULES_VERIFIED?: string;
  API_STYLE?: string;
  FID_ENC?: string;
  SEAT_ID?: string;
  SEAT_ID_ENC?: string;
  STATUS_PROFILE_JSON?: string;
  STATUS_PROFILE_VERIFIED?: string;
  POLL_SECONDS?: string;
  CHAOOXING_HALL_URL?: string;
  RESERVATION_RULES_VERIFIED?: string;
  RESERVATION_RULES_JSON?: string;
  // Internal scoped coordinator requirement; never accepted from management JSON.
  REQUIRE_RESERVATION_POLICY?: boolean;
  SUBMIT_CONFLICT_PROFILE_VERIFIED?: string;
  SUBMIT_CONFLICT_PROFILE_JSON?: string;
}

export interface ReservationParams {
  roomId: string;
  day: string;
  startTime: string;
  endTime: string;
  seatNum: string;
  captcha: string;
  wyToken: string;
}

export interface ReservationTarget {
  roomId: string;
  seatNum: string;
  startTime: string;
  endTime: string;
}

export interface ReservationSuccess {
  reserveId: string | number | null;
  day: string;
  roomId: string;
  seatNum: string;
}

export type RunResult =
  | { kind: "DRY_RUN"; tokenFound: true; targetDay: string; roomId: string; seatNum: string; startTime: string; endTime: string; encGenerated: true }
  | { kind: "RESERVATION_SUCCESS" | "ALREADY_RESERVED"; targetDay: string; roomId: string; seatNum: string; startTime: string; endTime: string; reserveId: string | number | null }
  | { kind: "AUTH_EXPIRED" | "AUTH_OR_PAGE_INVALID" | "MANUAL_VERIFICATION_REQUIRED" | "RESERVATION_FAILED" | "SUBMITTED_UNVERIFIED" | "WRITES_DISABLED" | "STATE_STORE_REQUIRED" | "LIFECYCLE_BLOCKED"; targetDay?: string; message: string };

export class AppError extends Error {
  public readonly code: RunResult["kind"];
  public readonly status?: number;

  constructor(code: RunResult["kind"], message: string, status?: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}
