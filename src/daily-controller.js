import { tomorrowShanghai } from './clock.js';
import { SeatState } from './state-machine.js';

const ACTIVE_STATES = new Set([SeatState.ARMED, SeatState.WAITING_FOR_OPEN, SeatState.WAITING_FOR_GATE_RELEASE, SeatState.LOADING_TARGET_DAY, SeatState.TARGET_READY, SeatState.FIRING, SeatState.VERIFYING, SeatState.NEEDS_HUMAN]);

// 长期生命周期只编排每天的单轮 Engine；所有提交、账本和租约仍由 Engine 严格把关。
export class DailyReservationController {
  constructor({ engine, storage, clock, logger, documentRef = document, windowRef = window, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() } = {}) {
    this.engine = engine; this.storage = storage; this.clock = clock; this.logger = logger; this.document = documentRef; this.window = windowRef; this.setTimer = setTimer; this.clearTimer = clearTimer; this.now = now;
    this.running = false; this.timer = null; this.reconciling = false; this.lastTargetDay = null; this.lastErrorAt = 0;
    this.wakeHandler = () => { if (this.document.visibilityState === 'hidden' && this.window?.document === this.document) return; this.reconcile('wake', { resyncClock: true }); };
    this.unsubscribe = this.engine.subscribeState?.((event) => this.onEngineState(event)) ?? null;
  }
  status() { return { running: this.running, lastTargetDay: this.lastTargetDay, nextCheckAt: this.nextCheckAt ?? null }; }
  start() {
    if (this.running || !this.storage.getSettings().autoArm) return; this.running = true;
    this.document.addEventListener?.('visibilitychange', this.wakeHandler); this.window.addEventListener?.('focus', this.wakeHandler); this.window.addEventListener?.('pageshow', this.wakeHandler);
    this.reconcile('start', { resyncClock: true });
  }
  stop(reason = 'autoArm disabled') {
    this.running = false; this.clearTimer(this.timer); this.timer = null; this.nextCheckAt = null;
    this.document.removeEventListener?.('visibilitychange', this.wakeHandler); this.window.removeEventListener?.('focus', this.wakeHandler); this.window.removeEventListener?.('pageshow', this.wakeHandler);
    this.logger.log('info', 'DAILY_LOOP_STOPPED', this.engine.machine.state, { reason });
  }
  destroy() { this.stop('controller destroyed'); this.unsubscribe?.(); this.unsubscribe = null; }
  scheduleNext(delayMs = 60_000) {
    if (!this.running) return; this.clearTimer(this.timer); const bounded = Math.max(1_000, Math.min(Number(delayMs) || 60_000, 5 * 60_000)); this.nextCheckAt = this.clock.now() + bounded;
    this.timer = this.setTimer(() => this.reconcile('periodic'), bounded); this.timer?.unref?.();
  }
  async onEngineState(event) {
    if (!this.running) return;
    if (event.to === SeatState.SUCCESS) { this.logger.log('info', 'DAILY_TARGET_COMPLETE', event.to, { targetDay: this.engine.plan?.targetDay }); this.scheduleNext(5 * 60_000); }
    else if (event.to === SeatState.NEEDS_HUMAN || event.to === SeatState.SESSION_EXPIRED) this.scheduleNext(5 * 60_000);
    else if (event.to === SeatState.ERROR) { this.lastErrorAt = this.clock.now(); this.scheduleNext(5 * 60_000); }
  }
  async reconcile(reason, { resyncClock = false } = {}) {
    if (!this.running || this.reconciling) return; if (!this.storage.getSettings().autoArm) return this.stop('autoArm disabled'); this.reconciling = true;
    try {
      if (resyncClock) await this.engine.refreshClock?.();
      const targetDay = tomorrowShanghai(this.clock.now()); let status = this.engine.status(); let state = status.state; const success = this.storage.getSuccess(targetDay); const attempt = this.storage.getAttempt(targetDay);
      this.lastTargetDay = targetDay; this.logger.log('info', 'DAILY_RECONCILE', state, { reason, targetDay, hasSuccess: Boolean(success), attemptState: attempt?.state ?? null });
      if (state === SeatState.NEEDS_HUMAN) return this.scheduleNext(5 * 60_000);
      if (state === SeatState.SESSION_EXPIRED) { if (this.engine.adapter?.isSessionExpired?.()) return this.scheduleNext(5 * 60_000); this.engine.resetForNextDay('session restored'); status = this.engine.status(); state = status.state; }
      if (status.plan?.targetDay && status.plan.targetDay !== targetDay) {
        if ([SeatState.VERIFYING, SeatState.FIRING, SeatState.LOADING_TARGET_DAY, SeatState.TARGET_READY].includes(state)) return this.scheduleNext(5 * 60_000);
        this.engine.resetForNextDay('target day rollover');
      }
      if (success) return this.scheduleNext(5 * 60_000);
      if (attempt) { this.logger.log('warn', 'DAILY_ATTEMPT_LEDGER_BLOCK', state, { targetDay, attemptState: attempt.state }); return this.scheduleNext(5 * 60_000); }
      const refreshed = this.engine.status();
      if (refreshed.plan?.targetDay === targetDay && refreshed.state === SeatState.WAITING_FOR_OPEN && this.clock.now() >= refreshed.plan.fireAt) return this.engine.fire();
      if (ACTIVE_STATES.has(refreshed.state)) return this.scheduleNext(60_000);
      if (refreshed.state === SeatState.ERROR && this.clock.now() - this.lastErrorAt < 5 * 60_000) return this.scheduleNext(5 * 60_000);
      if ([SeatState.SUCCESS, SeatState.ERROR, SeatState.STOPPED, SeatState.MISSED_WINDOW, SeatState.SESSION_EXPIRED].includes(refreshed.state)) this.engine.resetForNextDay('daily reconciliation');
      await this.engine.arm(this.storage.getSettings().mode, { allowLate: true });
      this.scheduleNext(60_000);
    } catch (error) { this.engine.fail(error); this.lastErrorAt = this.clock.now(); this.scheduleNext(5 * 60_000); } finally { this.reconciling = false; }
  }
}
