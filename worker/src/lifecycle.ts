import { SerialJournal, type AccountJournal, type Operation, type AuthorizationSource } from "./journal.ts";
import { prepareReservation, submitOnce, type ReservationDependencies } from "./reservation.ts";
import { targetFromEnv, validDay } from "./seat-api.ts";
import { queryStatus, type Snapshot } from "./status.ts";
import { safeLog } from "./safe-log.ts";
import { checkinWindow, reservationEnd, type CheckinWindow } from "./checkin-window.ts";
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
function authorizationReason(intent: { submitAt?: number; authorizationSource?: AuthorizationSource }): string | undefined {
  // A persisted finite time from the previous version is affirmative Cron evidence.
  if (!intent.authorizationSource && Number.isFinite(intent.submitAt)) intent.authorizationSource = "CRON";
  if (intent.authorizationSource === "CRON" && Number.isFinite(intent.submitAt)) return;
  if ((intent.authorizationSource === "MANUAL" || intent.authorizationSource === "REBOOK") && intent.submitAt === undefined) return;
  return "AUTHORIZATION_EVIDENCE_REQUIRED";
}

export class LifecycleCoordinator {
  private readonly env: Env;
  private readonly journal: SerialJournal;
  private readonly deps: ReservationDependencies;
  constructor(env: Env, journal: SerialJournal, deps: ReservationDependencies = {}) { this.env = env; this.journal = journal; this.deps = deps; }

  private transition(state: AccountJournal, snapshot: Snapshot, day: string): void {
    const previous = state.snapshot;
    if (state.day === day && previous?.record && !snapshot.record && snapshot.state === "UNKNOWN") snapshot = { ...snapshot, record: previous.record };
    state.snapshot = snapshot;
    state.snapshotAt = nowOf(this.deps);
    if (state.day !== day || !state.target) state.target = targetFromEnv(this.env);
    state.day = day;
    if (snapshot.state === "REVIEW_REQUIRED" || snapshot.policy?.supervisionPending === true) {
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
      if (state.day && day < state.day) return failure("LIFECYCLE_BLOCKED", day, "BACKWARD_DAY_CHANGE_DENIED");
      let source: AuthorizationSource = submitAt === undefined ? "MANUAL" : "CRON";
      if (state.pendingRun) {
        if (state.pendingRun.day !== day) return failure("LIFECYCLE_BLOCKED", day, "PENDING_RUN_TARGET_CONFLICT");
        const reason = authorizationReason(state.pendingRun);
        if (reason) {
          await this.blockHandoff(state, day, reason);
          return failure("LIFECYCLE_BLOCKED", day, reason);
        }
        submitAt = state.pendingRun.submitAt;
        source = state.pendingRun.authorizationSource!;
      }
      if (state.day && state.day !== day) {
        // Do not replace an existing intent's missing/expired evidence with a new request.
        if (state.pendingRun?.day !== day) state.pendingRun = { day, submitAt, authorizationSource: submitAt === undefined ? "MANUAL" : "CRON" };
        await this.journal.save(state);
        const reason = authorizationReason(state.pendingRun!);
        if (reason) {
          await this.blockHandoff(state, day, reason);
          return failure("LIFECYCLE_BLOCKED", day, reason);
        }
        submitAt = state.pendingRun!.submitAt;
        const blocked = await this.prepareDayLocked(state, day);
        if (blocked) return failure("LIFECYCLE_BLOCKED", day, blocked);
        state.pendingRun = undefined;
        await this.journal.save(state);
      }
      if (state.reviewPending) return failure("LIFECYCLE_BLOCKED", day, "REVIEW_PENDING");
      if (state.day === day && ["RELEASED", "COMPLETED"].includes(state.snapshot?.state ?? "")) return failure("LIFECYCLE_BLOCKED", day, "USE_LIFECYCLE_POLICY");
      return this.reserveLocked(state, day, "initial", submitAt, source);
    });
  }

  private async blockHandoff(state: AccountJournal, day: string, reason: string): Promise<string> {
    const previous = state.handoff;
    const attempts = previous?.targetDay === day && previous.reason === reason ? previous.attempts + 1 : 1;
    const now = nowOf(this.deps);
    state.handoff = { targetDay: day, reason, attempts, nextCheckAt: now + Math.min(900000, 60000 * 2 ** Math.min(attempts - 1, 4)),
      needsHuman: reason !== "OLD_INTERVAL_ACTIVE" };
    const id = `handoff:${state.day ?? "none"}:${day}:${reason}`;
    if (!state.events.some(event => event.id === id)) state.events.push({ id, kind: reason, at: now });
    state.events = state.events.slice(-50);
    safeLog("DAY_HANDOFF_BLOCKED", { day, reason, needsHuman: state.handoff.needsHuman });
    await this.journal.save(state);
    return reason;
  }

  private operationContext(key: string): { day: string; target: ReturnType<typeof targetFromEnv> } | undefined {
    const [day, roomId, seatNum, startTime, endTime, generation, extra] = key.split("|");
    if (!validDay(day) || !generation || extra !== undefined) return;
    try { return { day, target: targetFromEnv({ ...this.env, ROOM_ID: roomId, SEAT_NUM: seatNum, START_TIME: startTime, END_TIME: endTime }) }; } catch { return; }
  }

  private resolveOperations(state: AccountJournal, snapshot: Snapshot, day: string, target = targetFromEnv(this.env)): void {
    if (!snapshot.record || snapshot.state === "UNKNOWN" || snapshot.state === "UNRESERVED") return;
    const expected = [day, target.roomId, target.seatNum, target.startTime, target.endTime].join("|") + "|";
    for (const [key, op] of Object.entries(state.operations)) {
      if (key.startsWith(expected) && op.phase === "SUBMITTED_UNVERIFIED" && (!key.split("|")[5]?.startsWith("released:") || snapshot.record.id !== key.split("|")[5].slice(9))) {
        op.phase = "CONFIRMED";
        op.result = active(snapshot) ? { kind: "ALREADY_RESERVED", targetDay: day, ...target, reserveId: snapshot.record.id }
          : failure("LIFECYCLE_BLOCKED", day, "TERMINAL_OR_REVIEW_RECORD_CONFIRMED");
      }
    }
  }

  // Archive a local task separately from server state. Time alone never means release or completion.
  private async prepareDayLocked(state: AccountJournal, day: string): Promise<string | undefined> {
    if (!state.day || state.day === day) return;
    if (day < state.day) return this.blockHandoff(state, day, "BACKWARD_DAY_CHANGE_DENIED");
    const now = nowOf(this.deps);
    const oldDay = state.day, oldTarget = state.target ?? (state.snapshot?.record ? { roomId: state.snapshot.record.roomId, seatNum: state.snapshot.record.seatNum, startTime: state.snapshot.record.startTime, endTime: state.snapshot.record.endTime } : targetFromEnv(this.env));
    if (state.handoff?.targetDay === day && now < state.handoff.nextCheckAt && !(state.handoff.reason === "OLD_INTERVAL_ACTIVE" && now >= reservationEnd(oldDay, oldTarget))) return state.handoff.reason;
    if (now < reservationEnd(oldDay, oldTarget) && !["COMPLETED", "RELEASED", "UNRESERVED"].includes(state.snapshot?.state ?? "")) {
      return this.blockHandoff(state, day, "OLD_INTERVAL_ACTIVE");
    }
    const observed = await queryStatus(this.env, oldTarget, oldDay, this.deps, state.snapshot?.record?.id);
    this.transition(state, observed, oldDay);
    this.resolveOperations(state, observed, oldDay, oldTarget);
    const unresolved = Object.entries(state.operations).filter(([, op]) => op.phase === "SUBMITTED_UNVERIFIED");
    if (unresolved.length > 5) return this.blockHandoff(state, day, "HISTORY_SUBMISSION_REQUIRES_REVIEW");
    for (const [key, op] of unresolved) {
      const context = this.operationContext(key);
      if (!context) return this.blockHandoff(state, day, "HISTORY_JOURNAL_REQUIRES_REVIEW");
      // Reuse the historical observation when it belongs to this exact operation target.
      const same = context.day === oldDay && JSON.stringify(context.target) === JSON.stringify(oldTarget);
      if (!same) {
        const checked = await queryStatus(this.env, context.target, context.day, this.deps);
        this.resolveOperations(state, checked, context.day, context.target);
        if (checked.state === "REVIEW_REQUIRED" || checked.policy?.supervisionPending === true) state.reviewPending = true;
      }
      if (op.phase === "SUBMITTED_UNVERIFIED") return this.blockHandoff(state, day, "HISTORY_SUBMISSION_UNVERIFIED");
    }
    if (state.reviewPending || observed.policy?.blacklisted || observed.policy?.supervisionPending) return this.blockHandoff(state, day, "HISTORY_REVIEW_PENDING");
    const terminal = observed.state === "COMPLETED" || observed.state === "RELEASED";
    if (!terminal && now < reservationEnd(oldDay, oldTarget) && observed.state !== "UNRESERVED") return this.blockHandoff(state, day, "OLD_INTERVAL_ACTIVE");
    const operations = Object.fromEntries(Object.entries(state.operations).filter(([key]) => key.startsWith(oldDay + "|")));
    state.archives.push({ day: oldDay, target: oldTarget, snapshot: state.snapshot, snapshotAt: state.snapshotAt, archivedAt: now, reason: terminal ? "SERVER_TERMINAL" : "LOCAL_TASK_INTERVAL_ENDED", serverTerminalConfirmed: terminal, operations });
    state.archives = state.archives.slice(-30);
    if (observed.state === "UNKNOWN") {
      state.events.push({ id: `history-unknown:${oldDay}`, kind: "HISTORY_STATUS_UNVERIFIED", at: now });
      state.events = state.events.slice(-50);
    }
    safeLog("DAY_ARCHIVED", { day: oldDay, nextDay: day, serverTerminalConfirmed: terminal });
    state.day = day; state.target = targetFromEnv(this.env); state.snapshot = undefined; state.snapshotAt = undefined; state.checkin = undefined;
    state.nextPollAt = 0; state.pollFailures = 0; state.handoff = undefined;
    await this.journal.save(state);
  }

  async scheduleMissed(day: string): Promise<AccountJournal> {
    return this.journal.exclusive(async () => {
      const state = await this.journal.load();
      if (validDay(day)) await this.blockHandoff(state, day, "CRON_SUBMISSION_WINDOW_MISSED");
      return state;
    });
  }

  private async reserveLocked(state: AccountJournal, day: string, generation: string, submitAt?: number, authorizationSource?: AuthorizationSource): Promise<RunResult> {
    const key = keyFor(this.env, day, generation), now = nowOf(this.deps);
    const op: Operation = state.operations[key] ?? { phase: "READY", attempts: 0, nextAttemptAt: 0, submitAt, authorizationSource };
    // Existing intentions keep their evidence, even if a new request supplies fresh authorization.
    const authorizationError = authorizationReason(op);
    submitAt = op.submitAt;
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
    if (this.env.REQUIRE_RESERVATION_POLICY && !(snapshot.policy?.allowed && snapshot.policy.seatAvailable && !snapshot.policy.blacklisted && !snapshot.policy.supervisionPending)) return failure("LIFECYCLE_BLOCKED", day, "ELIGIBILITY_EVIDENCE_REQUIRED");
    if (generation === "initial" && snapshot.state !== "UNRESERVED") return failure("LIFECYCLE_BLOCKED", day, "NOT_UNRESERVED");
    if (generation !== "initial" && !this.canRebook(state, snapshot, now, false)) return failure("LIFECYCLE_BLOCKED", day, "REBOOK_POLICY_DENIED");
    if (authorizationError) {
      await this.blockHandoff(state, day, authorizationError);
      return failure("LIFECYCLE_BLOCKED", day, authorizationError);
    }
    // A negative read can authorize retry only after an explicit rejected write, never after ambiguity.
    let prepared;
    try { prepared = await prepareReservation(this.env, this.deps, day); }
    catch { return failure("RESERVATION_FAILED", day, "PREPARE_FAILED"); }
    if (submitAt && submitAt > nowOf(this.deps)) await (this.deps.wait ?? (ms => scheduler.wait(ms)))(submitAt - nowOf(this.deps));
    if (submitAt !== undefined && nowOf(this.deps) > submitAt + 15 * 60000) {
      await this.blockHandoff(state, day, "CRON_SUBMISSION_WINDOW_MISSED");
      return failure("LIFECYCLE_BLOCKED", day, "CRON_SUBMISSION_WINDOW_MISSED");
    }
    if (!isFuture(this.env, day, nowOf(this.deps))) return failure("LIFECYCLE_BLOCKED", day, "START_TIME_PASSED");
    if (this.env.REQUIRE_RESERVATION_POLICY) {
      const fresh = await queryStatus(this.env, prepared.target, day, this.deps);
      this.transition(state, fresh, day); await this.journal.save(state);
      if (active(fresh) && fresh.record) {
        op.phase = "CONFIRMED"; op.result = confirmed(this.env, day, fresh.record.id);
        await this.journal.save(state); return op.result;
      }
      const eligibleState = generation === "initial" ? fresh.state === "UNRESERVED" : this.canRebook(state, fresh, nowOf(this.deps), false);
      if (!eligibleState || state.reviewPending || !(fresh.policy?.allowed && fresh.policy.seatAvailable && !fresh.policy.blacklisted && !fresh.policy.supervisionPending)) return failure("LIFECYCLE_BLOCKED", day, "FINAL_ELIGIBILITY_RECHECK_DENIED");
      if (!isFuture(this.env, day, nowOf(this.deps))) return failure("LIFECYCLE_BLOCKED", day, "START_TIME_PASSED");
    }
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
      if (state.pendingRun && this.env.WRITES_ENABLED === "true") {
        const pending = state.pendingRun;
        const reason = authorizationReason(pending);
        if (reason) {
          await this.blockHandoff(state, pending.day, reason);
          return { skipped: reason, state };
        }
        if (pending.submitAt !== undefined && now > pending.submitAt + 15 * 60000) {
          await this.blockHandoff(state, pending.day, "CRON_SUBMISSION_WINDOW_MISSED");
          return { skipped: "CRON_SUBMISSION_WINDOW_MISSED", state };
        }
        const blocked = await this.prepareDayLocked(state, pending.day);
        if (blocked) return { skipped: blocked, state };
        state.pendingRun = undefined;
        await this.journal.save(state);
        return { state, result: await this.reserveLocked(state, pending.day, "initial", pending.submitAt, pending.authorizationSource) };
      }
      if (!state.day) return { skipped: "NO_TRACKED_RESERVATION", state };
      if (!force && now < state.nextPollAt) return { skipped: "POLL_BACKOFF", state };
      if (!force && state.snapshot?.state === "COMPLETED") return { skipped: "COMPLETED", state };
      const previousId = state.snapshot?.record?.id;
      const snapshot = await queryStatus(this.env, targetFromEnv(this.env), state.day, this.deps, previousId);
      this.transition(state, snapshot, state.day);
      state.pollFailures = snapshot.state === "UNKNOWN" ? state.pollFailures + 1 : 0;
      state.nextPollAt = now + Math.min(900_000, pollInterval(this.env) * 2 ** Math.min(state.pollFailures, 4));
      await this.journal.save(state);
      this.resolveOperations(state, snapshot, state.day);
      await this.journal.save(state);
      const generation = snapshot.record ? `released:${snapshot.record.id}` : "";
      const operation = generation ? state.operations[keyFor(this.env, state.day, generation)] : undefined;
      if (this.canRebook(state, snapshot, now, !operation) && (!operation || operation.phase === "REJECTED" && operation.attempts < MAX_ATTEMPTS && now >= operation.nextAttemptAt)) {
        // The same released id can only issue one operation. A new id consumes another daily budget slot.
        if (!operation) { state.rebookCounts[state.day] = (state.rebookCounts[state.day] ?? 0) + 1; await this.journal.save(state); }
        const result = await this.reserveLocked(state, state.day, generation, undefined, "REBOOK");
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
      if (state.day && state.day !== day) {
        const blocked = await this.prepareDayLocked(state, day);
        if (blocked) return { state, skipped: "UNRESOLVED_ACCOUNT_STATE" };
      }
      if (state.day === day && nowOf(this.deps) < state.nextPollAt) return { state, skipped: "POLL_BACKOFF" };
      const snapshot = await queryStatus(this.env, targetFromEnv(this.env), day, this.deps, state.day === day ? state.snapshot?.record?.id : undefined);
      this.transition(state, snapshot, day);
      state.nextPollAt = nowOf(this.deps) + pollInterval(this.env);
      await this.journal.save(state);
      return { state };
    });
  }
  async inspect(): Promise<AccountJournal & { checkinWindow?: CheckinWindow; checkinWindowError?: string }> {
    return this.journal.exclusive(async () => {
      const state = await this.journal.load();
      if (!state.day) return state;
      try { return { ...state, checkinWindow: checkinWindow(this.env, state.day, nowOf(this.deps), state.target) }; }
      catch { return { ...state, checkinWindowError: "INVALID_CHECKIN_CONFIGURATION" }; }
    });
  }
}
