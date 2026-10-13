import { SerialJournal, type AccountJournal, type Operation } from "./journal.ts";
import { prepareReservation, submitOnce, type ReservationDependencies } from "./reservation.ts";
import { targetFromEnv, validDay } from "./seat-api.ts";
import { queryStatus, type Snapshot } from "./status.ts";
import { safeLog } from "./safe-log.ts";
import { getTomorrowInShanghai } from "./time.ts";
import type { Env, RunResult } from "./types.ts";

const MAX_ATTEMPTS = 3;
const BACKOFF = [60_000, 300_000, 900_000];
function nowOf(deps: ReservationDependencies): number { return (deps.now?.() ?? new Date()).getTime(); }
function keyFor(env: Env, day: string, generation = "initial"): string {
  const t = targetFromEnv(env); return [day, t.roomId, t.seatNum, t.startTime, t.endTime, generation].join("|");
}
function failure(kind: "RESERVATION_FAILED" | "SUBMITTED_UNVERIFIED" | "LIFECYCLE_BLOCKED", day: string, message: string): RunResult { return { kind, targetDay: day, message }; }
function active(snapshot: Snapshot): boolean { return snapshot.state === "RESERVED_PENDING" || snapshot.state === "SIGNED_IN"; }
function confirmed(env: Env, day: string, id: string, kind: "ALREADY_RESERVED" | "RESERVATION_SUCCESS" = "ALREADY_RESERVED"): RunResult { return { kind, targetDay: day, ...targetFromEnv(env), reserveId: id }; }
function pollInterval(env: Env): number {
  const seconds = Number(env.POLL_SECONDS ?? 60); return Math.max(60, Math.min(900, Number.isFinite(seconds) ? seconds : 60)) * 1000;
}
function isFuture(env: Env, day: string, now: number): boolean { return Date.parse(`${day}T${targetFromEnv(env).startTime}:00+08:00`) > now; }

export class LifecycleCoordinator {
  private readonly env: Env;
  private readonly journal: SerialJournal;
  private readonly deps: ReservationDependencies;
  constructor(env: Env, journal: SerialJournal, deps: ReservationDependencies = {}) { this.env = env; this.journal = journal; this.deps = deps; }

  private transition(state: AccountJournal, snapshot: Snapshot, day: string): void {
    const previous = state.snapshot;
    if (state.day === day && previous?.record && !snapshot.record && snapshot.state === "UNKNOWN") snapshot = { ...snapshot, record: previous.record };
    state.snapshot = snapshot; state.day = day;
    if (snapshot.state === "REVIEW_REQUIRED") {
      if (!state.reviewPending) {
        const at = nowOf(this.deps), id = `review:${snapshot.record?.id ?? day}:${at}`;
        state.events.push({ id, kind: "REVIEW_REQUIRED", at });
      }
      state.reviewPending = true;
    }
    // Clear a latch only from a subsequently verified, affirmative server policy, never from disappearance.
    if (snapshot.state !== "UNKNOWN" && snapshot.state !== "REVIEW_REQUIRED" && snapshot.policy?.supervisionPending === false && snapshot.policy.blacklisted === false) state.reviewPending = false;
    state.events = state.events.slice(-50);
    if (!previous || previous.state !== snapshot.state || previous.record?.id !== snapshot.record?.id || previous.reason !== snapshot.reason) {
      safeLog("STATE_TRANSITION", { from: previous?.state ?? "UNINITIALIZED", to: snapshot.state, reason: snapshot.reason, day });
    }
  }

  async run(commit: boolean, day = getTomorrowInShanghai(this.deps.now?.() ?? new Date()), submitAt?: number): Promise<RunResult> {
    if (!validDay(day)) return failure("LIFECYCLE_BLOCKED", day, "INVALID_TARGET_DAY");
    if (!commit) {
      const prepared = await prepareReservation(this.env, this.deps, day);
      return { kind: "DRY_RUN", tokenFound: true, targetDay: day, ...prepared.target, encGenerated: true };
    }
    if (this.env.WRITES_ENABLED !== "true") return { kind: "WRITES_DISABLED", message: "WRITES_DISABLED" };
    return this.journal.exclusive(async () => {
      const state = await this.journal.load();
      // Do not allow an initial run to reset a released/review/unresolved generation on the same day.
      if (state.day && state.day !== day && state.snapshot?.state !== "COMPLETED" && state.snapshot?.state !== "UNRESERVED") return failure("LIFECYCLE_BLOCKED", day, "CURRENT_LIFECYCLE_ACTIVE");
      if (state.reviewPending) return failure("LIFECYCLE_BLOCKED", day, "REVIEW_PENDING");
      if (state.day === day && ["RELEASED", "COMPLETED"].includes(state.snapshot?.state ?? "")) return failure("LIFECYCLE_BLOCKED", day, "USE_LIFECYCLE_POLICY");
      return this.reserveLocked(state, day, "initial", submitAt);
    });
  }

  private async reserveLocked(state: AccountJournal, day: string, generation: string, submitAt?: number): Promise<RunResult> {
    const key = keyFor(this.env, day, generation), now = nowOf(this.deps);
    const op: Operation = state.operations[key] ?? { phase: "READY", attempts: 0, nextAttemptAt: 0 };
    state.operations[key] = op;
    // Retain unresolved writes indefinitely. Prune only old acknowledged outcomes to bound storage.
    for (const oldDay of Object.keys(state.rebookCounts)) if (oldDay < day) delete state.rebookCounts[oldDay];
    for (const [oldKey, old] of Object.entries(state.operations)) {
      if (oldKey !== key && oldKey.slice(0, 10) < day && (old.phase === "CONFIRMED" || old.phase === "READY" && old.attempts === 0 || old.phase === "REJECTED" && old.attempts >= MAX_ATTEMPTS)) delete state.operations[oldKey];
    }
    if (Object.entries(state.operations).some(([otherKey, other]) => otherKey !== key && other.phase === "SUBMITTED_UNVERIFIED")) return failure("LIFECYCLE_BLOCKED", day, "OTHER_UNRESOLVED_SUBMISSION");
    if (op.phase === "CONFIRMED" && op.result) return op.result;
    if (op.phase !== "SUBMITTED_UNVERIFIED" && (op.attempts >= MAX_ATTEMPTS || now < op.nextAttemptAt)) return op.result ?? failure("LIFECYCLE_BLOCKED", day, "BACKOFF_OR_ATTEMPT_LIMIT");
    if (!isFuture(this.env, day, now)) return failure("LIFECYCLE_BLOCKED", day, "START_TIME_PASSED");

    const snapshot = await queryStatus(this.env, targetFromEnv(this.env), day, this.deps, state.day === day ? state.snapshot?.record?.id : undefined);
    this.transition(state, snapshot, day);
    await this.journal.save(state);
    if (active(snapshot) && snapshot.record) {
      op.phase = "CONFIRMED"; op.result = confirmed(this.env, day, snapshot.record.id);
      await this.journal.save(state); return op.result;
    }
    if (op.phase === "SUBMITTED_UNVERIFIED") return failure("SUBMITTED_UNVERIFIED", day, "AWAIT_SERVER_CONFIRMATION");
    if (state.reviewPending || snapshot.state === "UNKNOWN" || snapshot.state === "REVIEW_REQUIRED" || snapshot.policy?.blacklisted || snapshot.policy?.supervisionPending) return failure("LIFECYCLE_BLOCKED", day, "UNVERIFIED_OR_RESTRICTED_STATE");
    if (generation === "initial" && snapshot.state !== "UNRESERVED") return failure("LIFECYCLE_BLOCKED", day, "NOT_UNRESERVED");
    if (generation !== "initial" && !this.canRebook(state, snapshot, now, false)) return failure("LIFECYCLE_BLOCKED", day, "REBOOK_POLICY_DENIED");
    // A negative read can authorize retry only after an explicit rejected write, never after ambiguity.
    let prepared;
    try { prepared = await prepareReservation(this.env, this.deps, day); }
    catch { return failure("RESERVATION_FAILED", day, "PREPARE_FAILED"); }
    if (submitAt && submitAt > nowOf(this.deps)) await (this.deps.wait ?? (ms => scheduler.wait(ms)))(submitAt - nowOf(this.deps));
    op.phase = "SUBMITTED_UNVERIFIED"; op.attempts += 1;
    op.result = failure("SUBMITTED_UNVERIFIED", day, "SUBMISSION_INTENT_SAVED");
    await this.journal.save(state); // Persist before sending any write.
    const outcome = await submitOnce(this.env, prepared, this.deps);
    if (outcome.kind === "success") {
      op.phase = "CONFIRMED"; op.result = confirmed(this.env, day, outcome.reserveId, "RESERVATION_SUCCESS");
      this.transition(state, { state: "UNKNOWN", reason: "SUBMITTED_AWAITING_STATUS", record: { id: outcome.reserveId, roomId: prepared.target.roomId, seatNum: prepared.target.seatNum, day, startTime: prepared.target.startTime, endTime: prepared.target.endTime, rawStatus: "" } }, day);
      state.nextPollAt = 0;
    } else if (outcome.kind === "rejected") {
      op.phase = "REJECTED";
      if (!outcome.retryable) op.attempts = MAX_ATTEMPTS;
      op.nextAttemptAt = nowOf(this.deps) + BACKOFF[Math.min(op.attempts - 1, 2)];
      op.result = failure("RESERVATION_FAILED", day, outcome.code);
      if (outcome.code === "MANUAL_VERIFICATION_REQUIRED") {
        this.transition(state, { state: "REVIEW_REQUIRED", reason: "MANUAL_VERIFICATION_REQUIRED" }, day);
      }
    } else {
      // Query after ambiguity for positive confirmation; absence is never proof of failed submission.
      const check = await queryStatus(this.env, prepared.target, day, this.deps);
      this.transition(state, check, day);
      if (active(check) && check.record) { op.phase = "CONFIRMED"; op.result = confirmed(this.env, day, check.record.id); }
      else op.result = failure("SUBMITTED_UNVERIFIED", day, outcome.code);
    }
    await this.journal.save(state);
    return op.result!;
  }

  private canRebook(state: AccountJournal, snapshot: Snapshot, now: number, checkBudget = true): boolean {
    const p = snapshot.policy;
    return this.env.WRITES_ENABLED === "true" && this.env.AUTO_REBOOK_ENABLED === "true" && this.env.REBOOK_RULES_VERIFIED === "true"
      && snapshot.state === "RELEASED" && Boolean(snapshot.record) && !state.reviewPending && Boolean(p?.allowed && p.seatAvailable && !p.supervisionPending && !p.blacklisted)
      && Boolean(state.day && isFuture(this.env, state.day, now)) && (!checkBudget || (state.rebookCounts[state.day!] ?? 0) < 2);
  }

  async tick(force = false): Promise<{ skipped?: string; state: AccountJournal; result?: RunResult }> {
    return this.journal.exclusive(async () => {
      const state = await this.journal.load(), now = nowOf(this.deps);
      if (!state.day) return { skipped: "NO_TRACKED_RESERVATION", state };
      if (!force && now < state.nextPollAt) return { skipped: "POLL_BACKOFF", state };
      if (!force && state.snapshot?.state === "COMPLETED") return { skipped: "COMPLETED", state };
      const previousId = state.snapshot?.record?.id;
      const snapshot = await queryStatus(this.env, targetFromEnv(this.env), state.day, this.deps, previousId);
      this.transition(state, snapshot, state.day);
      state.pollFailures = snapshot.state === "UNKNOWN" ? state.pollFailures + 1 : 0;
      state.nextPollAt = now + Math.min(900_000, pollInterval(this.env) * 2 ** Math.min(state.pollFailures, 4));
      await this.journal.save(state);
      // A verified explicit terminal record also resolves a lost submission, without claiming active use.
      if (snapshot.record && snapshot.state !== "UNKNOWN" && snapshot.state !== "UNRESERVED") {
        for (const [key, op] of Object.entries(state.operations)) {
          if (key.startsWith(keyFor(this.env, state.day).replace(/\|initial$/, "|")) && op.phase === "SUBMITTED_UNVERIFIED") {
            op.phase = "CONFIRMED";
            op.result = active(snapshot) ? confirmed(this.env, state.day, snapshot.record.id) : failure("LIFECYCLE_BLOCKED", state.day, "TERMINAL_OR_REVIEW_RECORD_CONFIRMED");
          }
        }
        await this.journal.save(state);
      }
      const generation = snapshot.record ? `released:${snapshot.record.id}` : "";
      const operation = generation ? state.operations[keyFor(this.env, state.day, generation)] : undefined;
      if (this.canRebook(state, snapshot, now, !operation) && (!operation || operation.phase === "REJECTED" && operation.attempts < MAX_ATTEMPTS && now >= operation.nextAttemptAt)) {
        // The same released id can only issue one operation. A new id consumes another daily budget slot.
        if (!operation) { state.rebookCounts[state.day] = (state.rebookCounts[state.day] ?? 0) + 1; await this.journal.save(state); }
        const result = await this.reserveLocked(state, state.day, generation);
        return { state, result };
      }
      const initial = state.operations[keyFor(this.env, state.day)];
      if (this.env.WRITES_ENABLED === "true" && snapshot.state === "UNRESERVED" && !state.reviewPending && initial?.phase === "REJECTED" && initial.attempts < MAX_ATTEMPTS && now >= initial.nextAttemptAt) {
        const result = await this.reserveLocked(state, state.day, "initial");
        return { state, result };
      }
      return { state };
    });
  }
  async track(day: string): Promise<{ state: AccountJournal; skipped?: string }> {
    return this.journal.exclusive(async () => {
      const state = await this.journal.load();
      if (!validDay(day)) return { state, skipped: "INVALID_TARGET_DAY" };
      if (state.day && state.day !== day && (state.reviewPending || state.snapshot?.state !== "COMPLETED" && state.snapshot?.state !== "UNRESERVED" || Object.values(state.operations).some(op => op.phase === "SUBMITTED_UNVERIFIED"))) return { state, skipped: "UNRESOLVED_ACCOUNT_STATE" };
      if (state.day === day && nowOf(this.deps) < state.nextPollAt) return { state, skipped: "POLL_BACKOFF" };
      const snapshot = await queryStatus(this.env, targetFromEnv(this.env), day, this.deps, state.day === day ? state.snapshot?.record?.id : undefined);
      this.transition(state, snapshot, day);
      state.nextPollAt = nowOf(this.deps) + pollInterval(this.env);
      await this.journal.save(state);
      return { state };
    });
  }
  async inspect(): Promise<AccountJournal> { return this.journal.exclusive(() => this.journal.load()); }
}
