import assert from 'node:assert/strict';
import test from 'node:test';
import { SeatState, SeatStateMachine } from '../src/state-machine.js';
import { ServerClock, addShanghaiDays, calculateOpenAt, durationFor, formatShanghaiDay, shanghaiEpoch, tomorrowShanghai } from '../src/clock.js';
import { redact } from '../src/logger.js';

test('Asia/Shanghai tomorrow remains correct across local UTC midnight', () => {
  const lateShanghai = shanghaiEpoch('2026-09-20', '23:59:59');
  assert.equal(tomorrowShanghai(lateShanghai), '2026-09-21');
  assert.equal(addShanghaiDays('2026-03-01', -1), '2026-02-28');
  assert.equal(formatShanghaiDay(shanghaiEpoch('2026-09-21')), '2026-09-21');
});
test('reserveBeforeDay=1 and 22:30 map to target-day previous night in Shanghai', () => {
  assert.equal(calculateOpenAt('2026-09-21', 1, '22:30'), shanghaiEpoch('2026-09-20', '22:30'));
  assert.deepEqual(durationFor('15:00', '22:00'), { minutes: 420, duration: '7.00' });
  assert.throws(() => durationFor('22:00', '08:00'));
});
test('state machine rejects invalid transitions and SUCCESS is terminal', () => {
  const machine = new SeatStateMachine(); assert.throws(() => machine.transition(SeatState.SUCCESS));
  machine.transition(SeatState.PROBING); machine.transition(SeatState.READY); machine.transition(SeatState.ARMED); machine.transition(SeatState.WAITING_FOR_OPEN); machine.transition(SeatState.LOADING_TARGET_DAY); machine.transition(SeatState.TARGET_READY); machine.transition(SeatState.FIRING); machine.transition(SeatState.VERIFYING); machine.transition(SeatState.SUCCESS);
  assert.equal(machine.isTerminal(), true); assert.throws(() => machine.transition(SeatState.STOPPED));
});
test('HTTP Date clock reports conservative uncertainty and monotonic anchor', async () => {
  let perf = 0; const clock = new ServerClock({ wallNow: () => 1_000_000 + perf, performanceRef: { now: () => perf }, sleep: async () => { perf += 4; }, fetchFn: async () => { perf += 20; return { headers: { get: () => new Date(1_000_500).toUTCString() } }; } });
  const snapshot = await clock.calibrate('https://office.chaoxing.com/front/third/apps/seat/select', 3); assert.equal(snapshot.source, 'HTTP_DATE'); assert.ok(snapshot.uncertaintyMs >= 500); const before = clock.now(); perf += 300; assert.equal(Math.round(clock.now() - before), 300);
});
test('redaction never retains credential-like values', () => {
  const output = redact({ cookie: 'secret', wyToken: 'x', normal: 'token=hidden', nested: { enc: 'nope' } }); assert.deepEqual(output, { cookie: '[REDACTED]', wyToken: '[REDACTED]', normal: 'token=[REDACTED]', nested: { enc: '[REDACTED]' } });
});
