export interface Env {
  CHAOOXING_COOKIE?: string;
  CHAOOXING_RESERVE_PAGE_URL?: string;
  ADMIN_TOKEN?: string;
  ROOM_ID?: string;
  SEAT_NUM?: string;
  START_TIME?: string;
  END_TIME?: string;
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
  | { kind: "AUTH_EXPIRED" | "AUTH_OR_PAGE_INVALID" | "MANUAL_VERIFICATION_REQUIRED" | "RESERVATION_FAILED"; targetDay?: string; message: string };

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
