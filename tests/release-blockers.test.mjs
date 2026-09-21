import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerClock, shanghaiEpoch } from '../src/clock.js';
import { ChaoxingSeatPageAdapter } from '../src/page-adapter.js';
import { weekdayAllowed } from '../src/userscript.js';
import { SeatState } from '../src/state-machine.js';
import { makeTargetEngine, MemoryStore } from './target-frame-fixture.mjs';

test('LIVE persists SUBMITTED_UNVERIFIED before iframe submit and a later arm is blocked', async () => {
  const f = makeTargetEngine(); await f.engine.arm('live'); await f.engine.fire(); assert.equal(f.storage.getAttempt('2026-09-21').state, 'SUBMITTED_UNVERIFIED'); assert.equal(f.iframeSubmitCalls, 1); assert.equal(f.parentSubmitCalls, 0); f.engine.stop(); await assert.rejects(() => f.engine.arm('live'), /提交账本记录/);
});
test('ambiguous stop leaves the persistent attempt ledger intact until explicit reset', async () => {
  const f = makeTargetEngine(); await f.engine.arm('live'); await f.engine.fire(); f.engine.onSubmitResult({ timeout: true }); assert.equal(f.engine.machine.state, SeatState.NEEDS_HUMAN); assert.equal(f.storage.getAttempt('2026-09-21').state, 'SUBMITTED_UNVERIFIED'); f.engine.resetAttemptForDate('2026-09-21'); assert.equal(f.storage.getAttempt('2026-09-21'), null); f.engine.stop();
});
test('only explicit definitive failure clears an attempt ledger', async () => {
  const f = makeTargetEngine(); await f.engine.arm('live'); await f.engine.fire(); f.engine.onSubmitResult({ success: false, hasJson: true, msg: '预约失败' }); assert.equal(f.engine.machine.state, SeatState.ERROR); assert.equal(f.storage.getAttempt('2026-09-21'), null);
});
test('heartbeat renewals keep a human-verification lease exclusive beyond sixty seconds', () => {
  const shared = new MemoryStore(); const first = makeTargetEngine({ shared }); const second = makeTargetEngine({ shared }); assert.equal(first.storage.tryAcquireFallbackLock('tab-a', 60_000, 0), true); assert.equal(first.storage.renewFallbackLock('tab-a', 60_000, 20_000), true); assert.equal(first.storage.renewFallbackLock('tab-a', 60_000, 40_000), true); assert.equal(first.storage.renewFallbackLock('tab-a', 60_000, 60_000), true); assert.equal(second.storage.tryAcquireFallbackLock('tab-b', 60_000, 61_000), false);
});
test('Chaoxing page server-time source wins over HTTP Date and remains conservatively bounded', async () => {
  let perf = 0; const pageEpoch = Date.UTC(2026, 8, 20, 14, 30, 0, 250); const clock = new ServerClock({ wallNow: () => pageEpoch - 250 + perf, performanceRef: { now: () => perf }, fetchFn: async () => { throw new Error('must not fetch'); } }); const result = await clock.calibrate('https://office.chaoxing.com/x', 3, [pageEpoch]); assert.equal(result.source, 'CHAOXING_SERVER_TIME'); assert.ok(result.uncertaintyMs >= 25);
});
test('stale static page server-time is rejected and falls back to HTTP Date', async () => {
  let perf = 0; const now = Date.UTC(2026, 8, 20, 14, 30, 0); const clock = new ServerClock({ wallNow: () => now + perf, performanceRef: { now: () => perf }, sleep: async () => {}, fetchFn: async () => ({ headers: { get: () => new Date(now).toUTCString() } }) }); const result = await clock.calibrate('https://office.chaoxing.com/x', 1, [now - 120_000]); assert.equal(result.source, 'HTTP_DATE');
});
test('refresh recovery can submit iframe once inside grace but never with unverified ledger', async () => {
  const f = makeTargetEngine({ clockNow: shanghaiEpoch('2026-09-20', '22:30:01') }); f.storage.saveRuntime({ armed: true, targetDay: '2026-09-21', submittedTargetDay: null, plan: { mode: 'live' } }); assert.equal(await f.engine.resumeIfArmed(), true); assert.equal(f.iframeSubmitCalls, 1); assert.equal(f.parentSubmitCalls, 0); f.engine.stop();
  const g = makeTargetEngine({ clockNow: shanghaiEpoch('2026-09-20', '22:30:01') }); g.storage.markSubmittedUnverified('2026-09-21', { owner: 'old', roomId: '3747', seatNum: '216', startTime: '08:00', endTime: '22:00' }); g.storage.saveRuntime({ armed: true, targetDay: '2026-09-21', submittedTargetDay: null, plan: { mode: 'live' } }); assert.equal(await g.engine.resumeIfArmed(), false); assert.equal(g.iframeSubmitCalls, 0);
});
test('recovery beyond the former grace immediately catches up instead of missing the window', async () => {
  const f = makeTargetEngine({ clockNow: shanghaiEpoch('2026-09-20', '22:30:05') }); f.storage.saveRuntime({ armed: true, targetDay: '2026-09-21', submittedTargetDay: null, plan: { mode: 'live' } }); assert.equal(await f.engine.resumeIfArmed(), true); assert.equal(f.iframeSubmitCalls, 1); assert.equal(f.parentSubmitCalls, 0); f.engine.stop();
});
test('autoArm daysOfWeek uses reservation target day rather than current day', () => { assert.equal(weekdayAllowed(['Mon'], '2026-09-21'), true); assert.equal(weekdayAllowed(['Sun'], '2026-09-21'), false); });
test('room DOM fallback is display-only and seat absence hard-fails only for authoritative layouts', () => {
  const vm = { seatConfig: { reserveBeforeDay: 1, reserveBeforeTime: '22:30' }, seatGridList: [{ seatNum: '001' }], seatGridListComplete: true }; const doc = { querySelector: (selector) => selector === '.order' ? { __vue__: vm } : selector === '.room-name' ? { textContent: ' 北辰图书馆二楼 ' } : null, body: { innerText: '' } }; const adapter = new ChaoxingSeatPageAdapter({ documentRef: doc, locationRef: { href: 'https://office.chaoxing.com/front/third/apps/seat/select?id=3747&deptIdEnc=x', hostname: 'office.chaoxing.com' }, windowRef: { performance: { getEntriesByType: () => [] } } }); assert.equal(adapter.getRoomName(vm), '北辰图书馆二楼'); assert.deepEqual(adapter.seatExists('216', vm), { exists: false, authoritative: true, source: 'seatGridList' }); vm.seatGridListComplete = false; assert.equal(adapter.seatExists('216', vm).authoritative, false);
});
test('explicit notification enablement is delegated only through a user-facing engine method', async () => {
  let enabled = 0; const notifier = Object.assign(() => {}, { enable: async () => { enabled += 1; return { permission: 'granted' }; } }); const f = makeTargetEngine({ notifier }); assert.deepEqual(await f.engine.enableNotifications(), { permission: 'granted' }); assert.equal(enabled, 1);
});
