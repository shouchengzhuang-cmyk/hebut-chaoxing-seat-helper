import { SerialJournal, type AccountJournal, type JournalStorage } from "./journal.ts";
import { LifecycleCoordinator } from "./lifecycle.ts";
import { CheckinCoordinator } from "./checkin.ts";
import { checkinWindow } from "./checkin-window.ts";
import { PlanError, addDays, envForTarget, migratePlan, planForDay, previewPlan, shanghaiDay, targetForPlan, validatePlan } from "./plans.ts";
import type { ReservationDependencies } from "./reservation.ts";
import type { Env, RunResult } from "./types.ts";

export interface AccountAction { action: string; commit?: boolean; day?: string; submitAt?: number; plan?: unknown; revision?: number; noticeKind?: string; paused?: boolean }
// The outer queue serializes configuration and every legacy lifecycle action together.
// The inner lifecycle retains its existing write-before-send transaction and restart behavior.
export class PlanCoordinator {
  private readonly queue: SerialJournal;
  private readonly inner: SerialJournal;
  private readonly env: Env;
  private readonly deps: ReservationDependencies;
  constructor(env: Env, storage: JournalStorage, deps: ReservationDependencies = {}) {
    this.env = env; this.deps = deps;
    this.queue = new SerialJournal(storage); this.inner = new SerialJournal(storage);
  }
  private now() { return (this.deps.now?.() ?? new Date()).getTime(); }
  private blocked(day: string, message: string): RunResult { return { kind: "LIFECYCLE_BLOCKED", targetDay: day, message }; }
  private async load() {
    const state = await this.queue.load();
    if (state.plans && state.plans.schemaVersion !== 1) throw new PlanError("PLAN_SCHEMA_REQUIRES_REVIEW", 409);
    if (!state.plans) { state.plans = migratePlan(this.env, this.now()); await this.queue.save(state); }
    return state;
  }
  async dispatch(input: AccountAction): Promise<unknown> {
    return this.queue.exclusive(async () => {
      const state = await this.load(), plans = state.plans!;
      const day = input.day ?? addDays(shanghaiDay(this.now()), 1);
      if (input.action === "plans") return plans;
      if (input.action === "pause") {
        if (typeof input.paused !== "boolean") throw new PlanError("INVALID_PAUSE");
        state.paused = input.paused;
        state.events.push({ id: `pause:${this.now()}`, kind: input.paused ? "AUTOMATION_PAUSED" : "AUTOMATION_RESUMED", at: this.now() }); state.events = state.events.slice(-50);
        await this.queue.save(state); return { paused: state.paused };
      }
      if (input.action === "save-plan") {
        const next = validatePlan(input.plan);
        if (input.revision !== plans.current.revision || next.revision !== input.revision || next.planId !== plans.current.planId) throw new PlanError("PLAN_REVISION_CONFLICT", 409);
        if (next.effectiveDay < shanghaiDay(this.now()) || next.effectiveDay < plans.current.effectiveDay) throw new PlanError("EFFECTIVE_DAY_MUST_NOT_MOVE_BACKWARDS", 409);
        // A plan edit never authorizes modifying/canceling a real or uncertain appointment.
        const protectedDays = [state.day, state.pendingRun?.day, ...Object.entries(state.operations).filter(([, op]) => op.attempts > 0).map(([key]) => key.slice(0, 10))].filter((d): d is string => Boolean(d));
        if (state.pendingRun && state.pendingRun.day >= next.effectiveDay || protectedDays.some(d => d >= next.effectiveDay) && Object.values(state.operations).some(op => op.attempts > 0)) throw new PlanError("EXISTING_ATTEMPT_FROZEN_USE_FUTURE_DAY", 409);
        // Future revisions must retain any unresolved/pending target context, including old schedules.
        if (plans.history.length >= 60) {
          const neededDays = [shanghaiDay(this.now()), ...protectedDays];
          const keep = new Set(neededDays.map(d => planForDay(plans, d)?.revision));
          // Preserve the first configuration for restore, active task versions and future changes.
          const compact = plans.history.filter((p, i) => i === 0 || keep.has(p.revision) || p.effectiveDay > shanghaiDay(this.now()));
          if (compact.length >= 60) throw new PlanError("PLAN_HISTORY_REVIEW_REQUIRED", 409);
          plans.history = compact;
        }
        const fields = Object.keys(next).filter(k => JSON.stringify(next[k as keyof typeof next]) !== JSON.stringify(plans.current[k as keyof typeof next]));
        plans.history.push(structuredClone(plans.current)); next.revision += 1; plans.current = next;
        plans.audit.push({ revision: next.revision, at: this.now(), fields }); plans.audit = plans.audit.slice(-100);
        await this.queue.save(state); return { plans, changedFields: fields, effectiveDay: next.effectiveDay, existingReservationChanged: false };
      }
      const plan = planForDay(plans, day);
      if (input.action === "notification-claim") {
        const currentPlan = state.day && planForDay(plans, state.day);
        if (!state.day || day !== state.day || !currentPlan || !currentPlan.notifications || state.checkin?.state !== "NEEDS_USER_PRESENCE"
          || !["EARLY", "DEADLINE"].includes(input.noticeKind ?? "")) return { claimed: false };
        const window = checkinWindow(this.env, state.day, this.now(), state.target);
        const earliest = Date.parse(window.earliestCheckin), latest = Date.parse(window.latestCheckin);
        const from = input.noticeKind === "EARLY" ? earliest - 15 * 60000 : latest - 10 * 60000;
        if (this.now() < from || this.now() > latest) return { claimed: false };
        const id = `reminder:${state.day}:${input.noticeKind}`;
        if (state.notificationIds?.includes(id)) return { claimed: false };
        state.notificationIds = [...(state.notificationIds ?? []), id].slice(-100);
        await this.queue.save(state); return { claimed: true, advisoryOnly: true };
      }
      if (input.action === "preview") return plan ? previewPlan(plan, day, this.env, this.now()) : { day, valid: false, reasons: ["NO_EFFECTIVE_PLAN"] };
      if (input.action === "scheduled") return this.scheduled(state);
      const target = input.action === "run" || input.action === "track" && !state.day ? (plan ? targetForPlan(plan, day) : undefined) : state.target;
      const scopedEnv = { ...(target ? envForTarget(this.env, target) : this.env), REQUIRE_RESERVATION_POLICY: true };
      const lifecycle = new LifecycleCoordinator(scopedEnv, this.inner, this.deps);
      if (input.action === "run") return this.execute(state, day, input.commit === true, input.submitAt);
      if (input.action === "schedule-missed") return lifecycle.scheduleMissed(day);
      if (input.action === "track") {
        if (state.day && state.day !== day) return { skipped: "TRACKED_DAY_FROZEN_USE_RUN_FOR_HANDOFF", state };
        return this.observe(lifecycle, () => lifecycle.track(day));
      }
      if (input.action === "monitor" || input.action === "checkin") {
        // Manual monitoring/checkin never performs a hidden reservation or cancellation.
        const readOnly = new LifecycleCoordinator({ ...scopedEnv, WRITES_ENABLED: "false" }, this.inner, this.deps);
        return this.observe(readOnly, () => readOnly.tick());
      }
      if (input.action === "inspect") {
        const inspected = await lifecycle.inspect();
        const today = shanghaiDay(this.now());
        const plannedDays = [today, addDays(today, 1)].map(day => { const p = planForDay(plans, day); return p ? previewPlan(p, day, this.env, this.now()) : { day, reasons: ["NO_EFFECTIVE_PLAN"] }; });
        const checkin = inspected.snapshot ? new CheckinCoordinator().reconcile(inspected, inspected.snapshotAt ?? inspected.checkin?.observedAt ?? 0) : undefined;
        return { ...inspected, checkin, plannedDays, clock: { source: "WORKER_CLOCK", asOf: this.now(), schoolOffsetVerified: false }, capabilities: { writer: "WORKER_ONLY", unattendedCheckin: "NOT_AVAILABLE_UNDER_OFFICIAL_RULES", cancellation: "NEEDS_HUMAN", candidateFallback: this.env.SUBMIT_CONFLICT_PROFILE_VERIFIED === "true" ? "VERIFIED_PROFILE_REQUIRED" : "CONTRACT_UNVERIFIED" } };
      }
      throw new PlanError("INVALID_ACTION");
    });
  }
  private async execute(state: AccountJournal, day: string, commit: boolean, submitAt?: number): Promise<unknown> {
    const plan = planForDay(state.plans!, day);
    if (!plan) return this.blocked(day, "NO_EFFECTIVE_PLAN");
    const preview = previewPlan(plan, day, this.env, this.now());
    if (!commit) return { kind: "PLAN_DRY_RUN", ...preview, willSubmit: false };
    if (state.paused) return this.blocked(day, "AUTOMATION_PAUSED");
    if (!preview.valid) return this.blocked(day, preview.reasons.join(","));
    if (plan.bookingStrategy === "QUERY_ONLY") return this.blocked(day, "QUERY_ONLY");
    if (this.env.STATUS_PROFILE_VERIFIED !== "true") return this.blocked(day, "STATUS_PROFILE_UNVERIFIED");
    const progress = state.candidateProgress?.day === day && state.candidateProgress.revision === plan.revision ? state.candidateProgress : undefined;
    const candidate = progress?.index ?? 0;
    if (candidate >= plan.seatCandidates.length) return this.blocked(day, "CANDIDATES_EXHAUSTED");
    if (progress && this.now() < progress.nextAt) return this.blocked(day, "CANDIDATE_BACKOFF");
    const target = targetForPlan(plan, day, plan.seatCandidates[candidate]);
    const operationKey = [day, target.roomId, target.seatNum, target.startTime, target.endTime, "initial"].join("|");
    const previous = state.operations[operationKey];
    if (previous?.phase === "CONFIRMED" && previous.result && state.snapshot?.state !== "RELEASED" && !Object.values(state.operations).some(op => op.phase === "SUBMITTED_UNVERIFIED")) return previous.result;
    if (this.now() < (state.nextRunAt ?? 0)) return previous?.phase === "SUBMITTED_UNVERIFIED"
      ? { kind: "SUBMITTED_UNVERIFIED", targetDay: day, message: "READBACK_BACKOFF" } : this.blocked(day, "RUN_BACKOFF");
    if (state.day === day && state.target && JSON.stringify(state.target) !== JSON.stringify(target)) {
      const rejected = progress && state.operations[progress.conflictOperationKey];
      const noAttempt = !state.snapshot?.record && !Object.entries(state.operations).some(([key, op]) => key.startsWith(day + "|") && op.attempts > 0);
      if (!noAttempt && (!rejected || rejected.phase !== "REJECTED" || rejected.result?.kind !== "RESERVATION_FAILED" || rejected.result.message !== "SEAT_CONFLICT_VERIFIED"
        || Object.values(state.operations).some(op => op.phase === "SUBMITTED_UNVERIFIED" || op.phase === "CONFIRMED"))) return this.blocked(day, "EXISTING_TARGET_FROZEN");
      state.target = target; state.snapshot = undefined; await this.queue.save(state);
    }
    const scopedEnv = { ...envForTarget(this.env, target), REQUIRE_RESERVATION_POLICY: true };
    if (this.env.WRITES_ENABLED !== "true") return { kind: "WRITES_DISABLED", message: "WRITES_DISABLED" };
    state.nextRunAt = this.now() + 60000; await this.queue.save(state);
    const lifecycle = new LifecycleCoordinator(scopedEnv, this.inner, this.deps);
    if (state.day === day && state.snapshot?.state === "RELEASED") {
      // Rebooking remains on the pre-existing, separately verified release policy.
      const monitored = await lifecycle.tick();
      return monitored.result ?? this.blocked(day, monitored.skipped ?? "REBOOK_POLICY_DENIED");
    }
    const result = await lifecycle.run(true, day, submitAt);
    if (result.kind === "RESERVATION_FAILED" && result.message === "SEAT_CONFLICT_VERIFIED" && plan.bookingStrategy === "ORDERED") {
      const latest = await this.queue.load();
      latest.candidateProgress = { day, revision: plan.revision, index: candidate + 1, nextAt: this.now() + 60000,
        conflictOperationKey: [day, target.roomId, target.seatNum, target.startTime, target.endTime, "initial"].join("|") };
      await this.queue.save(latest);
    }
    return result;
  }
  private async observe(lifecycle: LifecycleCoordinator, action: () => Promise<unknown>) {
    const result = await action(), latest = await this.queue.load();
    // A cached snapshot keeps the original observation time on backoff, never pretends freshness.
    if (!(result as { skipped?: string }).skipped) {
      latest.checkin = new CheckinCoordinator().reconcile(latest, this.now());
      await this.queue.save(latest);
    }
    return { ...(result as object), checkin: latest.checkin };
  }
  private async scheduled(state: AccountJournal): Promise<unknown> {
    const now = this.now(), today = shanghaiDay(now), plans = state.plans!;
    if (state.paused) return { skipped: "AUTOMATION_PAUSED" };
    if (this.env.WRITES_ENABLED !== "true") return { skipped: "WRITES_DISABLED" };
    if (state.day && state.snapshot?.state === "RELEASED" && this.env.AUTO_REBOOK_ENABLED === "true" && this.env.REBOOK_RULES_VERIFIED === "true") return this.execute(state, state.day, true);
    // A bounded scan covers every legal configured advance range without a permanent 22:30 anchor.
    for (let delta = 0; delta <= 30; delta += 1) {
      const day = addDays(today, delta), plan = planForDay(plans, day);
      if (!plan || plan.bookingStrategy === "QUERY_ONLY") continue;
      const preview = previewPlan(plan, day, this.env, now);
      if (!preview.valid || preview.openAt === undefined) continue;
      if (now > preview.openAt + 15 * 60000) {
        const id = `missed:${day}:${plan.revision}`;
        if (!state.events.some(e => e.id === id)) {
          state.events.push({ id, kind: "CRON_SUBMISSION_WINDOW_MISSED", at: now }); state.events = state.events.slice(-50); await this.queue.save(state);
        }
        continue;
      }
      return this.execute(state, day, true, preview.openAt);
    }
    return { skipped: "NO_OPEN_PLAN" };
  }
}
