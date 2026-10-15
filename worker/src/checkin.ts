import type { AccountJournal } from "./journal.ts";
import { matches, type Snapshot } from "./status.ts";

export interface ReservationEvidence { source: "VERIFIED_STATUS_PROFILE"; state: Snapshot["state"]; observedAt: number }
export interface CheckinEvidence extends ReservationEvidence { state: "SIGNED_IN" }
export interface ManualActionRequired { state: "NEEDS_USER_PRESENCE" | "NEEDS_HUMAN"; reason: string }
export interface CheckinAttempt {
  operationId: string; state: "UNKNOWN" | "NEEDS_USER_PRESENCE" | "NEEDS_HUMAN" | "SIGNED_IN" | "NOT_AVAILABLE_UNDER_OFFICIAL_RULES";
  reason: string; observedAt: number; evidence?: CheckinEvidence;
  unattended: "NOT_AVAILABLE_UNDER_OFFICIAL_RULES";
}
// The school has not supplied a permitted unattended checkin contract. This coordinator
// observes the real official flow; it deliberately has no write transport or presence flag.
export class CheckinCoordinator {
  reconcile(state: AccountJournal, now: number): CheckinAttempt {
    const snapshot = state.snapshot;
    const operationId = `checkin:${state.day ?? "none"}:${snapshot?.record?.id ?? "unknown"}`;
    let phase: CheckinAttempt["state"] = "UNKNOWN", reason = "VERIFIED_RESERVATION_REQUIRED";
    if (snapshot?.record && snapshot.reason === "VERIFIED_STATUS_PROFILE" && snapshot.record.day === state.day && (!state.target || matches(snapshot.record, state.target, state.day))) {
      if (snapshot.state === "SIGNED_IN") { phase = "SIGNED_IN"; reason = "OFFICIAL_SIGNED_IN_RECORD"; }
      else if (snapshot.state === "RESERVED_PENDING") { phase = "NEEDS_USER_PRESENCE"; reason = "COMPLETE_OFFICIAL_ONSITE_FLOW"; }
      else if (snapshot.state === "REVIEW_REQUIRED") { phase = "NEEDS_HUMAN"; reason = "OFFICIAL_REVIEW_REQUIRED"; }
      else if (snapshot.state === "RELEASED" || snapshot.state === "COMPLETED") { phase = "NOT_AVAILABLE_UNDER_OFFICIAL_RULES"; reason = "RESERVATION_TERMINAL"; }
    }
    return { operationId, state: phase, reason, observedAt: now, unattended: "NOT_AVAILABLE_UNDER_OFFICIAL_RULES",
      ...(phase === "SIGNED_IN" ? { evidence: { source: "VERIFIED_STATUS_PROFILE" as const, state: "SIGNED_IN" as const, observedAt: now } } : {}) };
  }
}
