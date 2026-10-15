import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTargetEngine } from './target-frame-fixture.mjs';
import { SeatStorage, DEFAULT_SETTINGS } from '../src/storage.js';
import { redact } from '../src/logger.js';
import { uiText } from '../src/ui.js';

test('production browser without a durable coordinator refuses LIVE before any page submit', async () => {
  const f = makeTargetEngine(); f.engine.submissionCoordinator = null;
  await assert.rejects(() => f.engine.arm('live'), /WORKER_ONLY/);
  assert.equal(f.iframeSubmitCalls, 0); assert.equal(f.parentSubmitCalls, 0);
});
test('coordinator withdrawal after arming still prevents a browser submit', async () => {
  const f = makeTargetEngine(); await f.engine.arm('live'); f.engine.submissionCoordinator = null; await f.engine.fire();
  assert.equal(f.iframeSubmitCalls, 0); assert.equal(f.storage.getAttempt('2026-09-21'), null);
});
test('plan edits while submitted or waiting for human preserve the old local target', async () => {
  const f = makeTargetEngine(); await f.engine.arm('live'); await f.engine.fire();
  const before = f.storage.getSettings(); assert.throws(() => f.engine.updateSettings({ ...before, seatPriority: ['217'] }), /FROZEN/);
  assert.deepEqual(f.storage.getSettings(), before); f.engine.stop();
});
test('new defaults use 08:30 while existing saved 08:00 preferences survive upgrade', () => {
  const f = makeTargetEngine(); f.storage.saveSettings({ ...f.storage.getSettings(), startTime: '08:00' });
  assert.equal(DEFAULT_SETTINGS.startTime, '08:30'); assert.equal(f.storage.getSettings().startTime, '08:00');
});
test('logs omit private response text, IDs and URL queries, and panel escapes server room names', () => {
  const result = JSON.stringify(redact({ msg: 'PRIVATE_TEXT', reserveId: '987654321', UID: 'PRIVATE_UID', url: 'https://office.chaoxing.com/select?deptIdEnc=SECRET_VALUE&x=PRIVATE_QUERY' }));
  assert.doesNotMatch(result, /PRIVATE_TEXT|987654321|PRIVATE_UID|SECRET_VALUE|PRIVATE_QUERY/);
  assert.equal(uiText('<img src=x onerror="x">'), '&lt;img src=x onerror=&quot;x&quot;&gt;');
});
