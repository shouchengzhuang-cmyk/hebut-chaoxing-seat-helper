import assert from 'node:assert/strict';
import test from 'node:test';
import { ResultKind, classifyResult } from '../src/core.js';
import { SeatState } from '../src/state-machine.js';
import { makeTargetEngine, MemoryStore } from './target-frame-fixture.mjs';

test('CLOSED target gate retries serially and keeps at most one iframe alive', async () => {
  const f = makeTargetEngine({ mode: 'dry-run', gates: ['CLOSED', 'OPEN'] }); await f.engine.dryRun(); await f.engine.fire();
  assert.equal(f.engine.machine.state, SeatState.WAITING_FOR_GATE_RELEASE); assert.equal(f.engine.targetGateAttempts, 1); assert.equal(f.scheduled.length, 1); assert.equal(f.currentLoader.destroyed, true);
  await f.scheduled.shift().work(); assert.equal(f.engine.machine.state, SeatState.STOPPED); assert.equal(f.loaderCreations, 2); assert.equal(f.engine.status().iframeActive, false);
});
test('OPEN waits for iframe Vue, prepares only iframe Vue, and never calls parent submit', async () => {
  const f = makeTargetEngine({ mode: 'dry-run' }); await f.engine.dryRun(); await f.engine.fire();
  assert.equal(f.engine.machine.state, SeatState.STOPPED); assert.equal(f.parentSubmitCalls, 0); assert.equal(f.iframeSubmitCalls, 0); assert.equal(f.engine.metrics.targetPageLoadMs, 280); assert.equal(f.engine.metrics.target_page_load_ms, 280); assert.ok(f.engine.metrics.target_vue_ready_at); assert.ok(f.engine.metrics.target_prepare_at);
});
test('UNKNOWN target gate fails closed without scheduling a submit', async () => {
  const f = makeTargetEngine({ mode: 'live', gates: ['UNKNOWN'] }); await f.engine.arm('live'); await f.engine.fire();
  assert.equal(f.engine.machine.state, SeatState.ERROR); assert.equal(f.parentSubmitCalls, 0); assert.equal(f.iframeSubmitCalls, 0); assert.equal(f.scheduled.length, 0);
});
test('target gate retry is bounded by its configured retry list', async () => {
  const f = makeTargetEngine({ mode: 'dry-run', gates: ['CLOSED'] }); await f.engine.dryRun(); await f.engine.fire(); while (f.scheduled.length) await f.scheduled.shift().work();
  assert.equal(f.engine.machine.state, SeatState.ERROR); assert.equal(f.engine.targetGateAttempts, 6); assert.equal(f.iframeSubmitCalls, 0);
});
test('LIVE calls iframe vm.submit exactly once and its observer confirms success', async () => {
  const f = makeTargetEngine({ mode: 'live' }); await f.engine.arm('live'); await f.engine.fire();
  assert.equal(f.parentSubmitCalls, 0); assert.equal(f.iframeSubmitCalls, 1); assert.equal(f.observerInstances.length, 1); assert.equal(f.observerInstances[0].installed, true); assert.ok(f.engine.metrics.iframe_submit_called_at);
  f.observerInstances[0].onResult({ success: true, hasJson: true, msg: '成功', elapsedMs: 12 }); assert.equal(f.engine.machine.state, SeatState.SUCCESS); assert.equal(f.observerInstances[0].restored, true); assert.equal(f.currentLoader.destroyed, true);
});
test('ambiguous iframe response preserves ledger, does not retry, and reveals iframe for human handling', async () => {
  const f = makeTargetEngine({ mode: 'live' }); await f.engine.arm('live'); await f.engine.fire(); f.observerInstances[0].onResult({ timeout: true });
  assert.equal(f.engine.machine.state, SeatState.NEEDS_HUMAN); assert.equal(f.storage.getAttempt('2026-09-21').state, 'SUBMITTED_UNVERIFIED'); assert.equal(f.currentLoader.shown, true); assert.equal(f.scheduled.length, 0); f.engine.stop();
});
test('captcha result reveals the target iframe overlay for direct official human handling', async () => {
  const f = makeTargetEngine({ mode: 'live' }); await f.engine.arm('live'); await f.engine.fire(); f.observerInstances[0].onResult({ success: false, hasJson: true, msg: '需要验证码' });
  assert.equal(f.engine.machine.state, SeatState.NEEDS_HUMAN); assert.equal(f.currentLoader.shown, true); assert.equal(f.parentSubmitCalls, 0); f.engine.stop();
});
test('success confirmation reads iframe Vue rather than parent Vue', async () => {
  const f = makeTargetEngine({ mode: 'live' }); await f.engine.arm('live'); await f.engine.fire(); f.currentLoader._vm.submitsuccess = true; f.engine.onSubmitResult({ success: false, hasJson: true, msg: '未知文案' });
  assert.equal(f.engine.machine.state, SeatState.SUCCESS); assert.equal(f.parentSubmitCalls, 0); assert.equal(f.currentLoader.destroyed, true);
});
test('classifier keeps unknown outcomes ambiguous and explicit conflicts distinct', () => {
  assert.equal(classifyResult({ success: false, hasJson: true, msg: '座位已被预约' }), ResultKind.SEAT_CONFLICT); assert.equal(classifyResult({ success: false, hasJson: true, msg: '未知新文案' }), ResultKind.AMBIGUOUS);
});
test('single submission lease is still exclusive across target iframe engines', () => {
  const shared = new MemoryStore(); const first = makeTargetEngine({ shared }); const second = makeTargetEngine({ shared }); assert.equal(first.storage.tryAcquireFallbackLock('tab-a', 1000, 100), true); assert.equal(second.storage.tryAcquireFallbackLock('tab-b', 1000, 101), false); first.storage.releaseFallbackLock('tab-a'); assert.equal(second.storage.tryAcquireFallbackLock('tab-b', 1000, 102), true);
});
