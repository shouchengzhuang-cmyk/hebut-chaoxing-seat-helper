import assert from 'node:assert/strict';
import test from 'node:test';
import { DailyReservationController } from '../src/daily-controller.js';
import { SeatState } from '../src/state-machine.js';
import { shanghaiEpoch, tomorrowShanghai } from '../src/clock.js';
import { MemoryStore } from './target-frame-fixture.mjs';
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ now = shanghaiEpoch('2026-09-20', '22:00'), autoArm = true, state = SeatState.IDLE, plan = null, successDays = [], attemptDays = [], sessionExpired = true } = {}) {
  const local = new MemoryStore(); const settings = { autoArm, mode: 'dry-run' }; const events = new Map(); let listener;
  const storage = { getSettings: () => settings, getSuccess: (day) => successDays.includes(day) ? { at: 1 } : null, getAttempt: (day) => attemptDays.includes(day) ? { state: 'SUBMITTED_UNVERIFIED' } : null };
  const clock = { now: () => now }; const calls = { arm: 0, fire: 0, reset: 0, refresh: 0, fail: 0 };
  const engine = { machine: { state }, plan, adapter: { isSessionExpired: () => sessionExpired }, subscribeState: (fn) => { listener = fn; return () => { listener = null; }; }, status: () => ({ state: engine.machine.state, plan: engine.plan, metrics: {} }), refreshClock: async () => { calls.refresh += 1; }, arm: async () => { calls.arm += 1; engine.machine.state = SeatState.WAITING_FOR_OPEN; engine.plan = { targetDay: tomorrowShanghai(now), fireAt: now + 60_000 }; }, fire: async () => { calls.fire += 1; }, resetForNextDay: () => { calls.reset += 1; engine.machine.state = SeatState.IDLE; engine.plan = null; }, fail: () => { calls.fail += 1; engine.machine.state = SeatState.ERROR; } };
  const documentRef = { visibilityState: 'visible', addEventListener: (name, fn) => events.set(`d:${name}`, fn), removeEventListener: (name) => events.delete(`d:${name}`) }; const windowRef = { document: documentRef, addEventListener: (name, fn) => events.set(`w:${name}`, fn), removeEventListener: (name) => events.delete(`w:${name}`) }; const timers = [];
  const controller = new DailyReservationController({ engine, storage, clock, logger: { log() {} }, documentRef, windowRef, setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimer() {} });
  return { controller, engine, calls, events, timers, setNow: (value) => { now = value; }, emit: (name) => listener?.({ to: name }) };
}

test('autoArm=true starts a daily target lifecycle before 22:30', async () => {
  const f = fixture(); f.controller.start(); await settle(); assert.equal(f.calls.arm, 1); assert.equal(f.engine.plan.targetDay, '2026-09-21'); assert.ok(f.timers.length);
});
test('late starts at 22:30:05 and 23:30 still arm immediately rather than reporting a missed window', async () => {
  for (const time of ['22:30:05', '23:30:00']) { const f = fixture({ now: shanghaiEpoch('2026-09-20', time) }); f.controller.start(); await settle(); assert.equal(f.calls.arm, 1); }
});
test('a background-delayed wake sixty seconds after open immediately fires the existing plan', async () => {
  const now = shanghaiEpoch('2026-09-20', '22:31:00'); const f = fixture({ now, state: SeatState.WAITING_FOR_OPEN, plan: { targetDay: '2026-09-21', fireAt: now - 60_000 } }); f.controller.start(); await settle(); assert.equal(f.calls.fire, 1); assert.equal(f.calls.arm, 0);
});
test('success and unverified ledgers block another daily submit lifecycle', async () => {
  const success = fixture({ successDays: ['2026-09-21'] }); success.controller.start(); await settle(); assert.equal(success.calls.arm, 0);
  const attempt = fixture({ attemptDays: ['2026-09-21'] }); attempt.controller.start(); await settle(); assert.equal(attempt.calls.arm, 0);
});
test('visibility and focus wakeups reconcile and refresh the clock', async () => {
  const f = fixture(); f.controller.start(); await settle(); const initial = f.calls.refresh; f.events.get('d:visibilitychange')(); await settle(); f.events.get('w:focus')(); await settle(); assert.ok(f.calls.refresh >= initial + 2);
});
test('rollover resets a terminal old target and creates the next target lifecycle', async () => {
  const f = fixture({ now: shanghaiEpoch('2026-09-21', '00:00:01'), state: SeatState.SUCCESS, plan: { targetDay: '2026-09-21', fireAt: 0 } }); f.controller.start(); await settle(); assert.equal(f.calls.reset, 1); assert.equal(f.calls.arm, 1); assert.equal(f.engine.plan.targetDay, '2026-09-22');
});
test('simulated 48-hour running page creates independent target-day cycles', async () => {
  const f = fixture(); f.controller.start(); await settle(); assert.equal(f.engine.plan.targetDay, '2026-09-21'); f.engine.machine.state = SeatState.SUCCESS; f.setNow(shanghaiEpoch('2026-09-21', '00:01:00')); await f.controller.reconcile('48h day 2'); assert.equal(f.engine.plan.targetDay, '2026-09-22'); f.engine.machine.state = SeatState.SUCCESS; f.setNow(shanghaiEpoch('2026-09-22', '00:01:00')); await f.controller.reconcile('48h day 3'); assert.equal(f.engine.plan.targetDay, '2026-09-23'); assert.equal(f.calls.reset, 2);
});
test('needs-human and session-expired states pause automatic re-submission', async () => {
  for (const state of [SeatState.NEEDS_HUMAN, SeatState.SESSION_EXPIRED]) { const f = fixture({ state }); f.controller.start(); await settle(); assert.equal(f.calls.arm, 0); }
});
test('restored login exits SESSION_EXPIRED and resumes the daily lifecycle once', async () => {
  const f = fixture({ state: SeatState.SESSION_EXPIRED, sessionExpired: false }); f.controller.start(); await settle(); assert.equal(f.calls.reset, 1); assert.equal(f.calls.arm, 1);
});
test('autoArm=false never starts the daily loop', () => { const f = fixture({ autoArm: false }); f.controller.start(); assert.equal(f.controller.running, false); assert.equal(f.calls.arm, 0); });
