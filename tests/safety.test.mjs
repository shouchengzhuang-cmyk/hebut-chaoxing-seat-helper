import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyResult, ResultKind } from '../src/core.js';
import { SubmitObserver, createShadowSubmitProbe } from '../src/submit-observer.js';
import { OpenScheduler } from '../src/scheduler.js';

test('result classifier recognizes all explicit safe branches', () => {
  assert.equal(classifyResult({ success: true }), ResultKind.SUCCESS);
  assert.equal(classifyResult({ hasJson: true, msg: '尚未开始预约' }), ResultKind.GATE_NOT_OPEN);
  assert.equal(classifyResult({ hasJson: true, msg: '操作频繁，请稍后再试' }), ResultKind.RATE_LIMITED);
  assert.equal(classifyResult({ hasJson: true, msg: '登录失效' }), ResultKind.SESSION_EXPIRED);
  assert.equal(classifyResult({ hasJson: true, msg: '预约区域不存在' }), ResultKind.CONFIG_ERROR);
  assert.equal(classifyResult({ hasJson: true, msg: '未知提示' }), ResultKind.AMBIGUOUS);
});
class FakeXHR {
  constructor() { this.listeners = {}; this.status = 200; this.responseText = '{"success":true,"msg":"成功"}'; }
  open(method, url) { this.baseOpened = { method, url }; }
  send() { this.listeners.loadend?.forEach((fn) => fn()); }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
}
test('SubmitObserver transparently observes official XHR without retaining body data', () => {
  const results = []; const dispatched = []; const win = { XMLHttpRequest: FakeXHR, location: { href: 'https://office.chaoxing.com/front/third/apps/seat/select?id=3747' } }; const observer = new SubmitObserver({ windowRef: win, onResult: (r) => results.push(r), onDispatch: (r) => dispatched.push(r) }); observer.install(); const xhr = new win.XMLHttpRequest(); xhr.open('POST', '/data/apps/seat/submit'); xhr.send('captcha=secret&enc=secret'); assert.equal(dispatched.length, 1); assert.equal(results.length, 1); assert.equal(results[0].success, true); assert.equal('body' in results[0], false); observer.restore();
});
test('shadow submit probe blocks one outbound request and records only endpoint shape', () => {
  const seen = []; const win = { XMLHttpRequest: FakeXHR, location: { href: 'https://office.chaoxing.com/front/third/apps/seat/select?id=3747' } }; const probe = createShadowSubmitProbe({ windowRef: win, onObserved: (event) => seen.push(event) }); const xhr = new win.XMLHttpRequest(); xhr.open('POST', '/data/apps/seat/submit'); xhr.send('enc=secret'); assert.deepEqual(seen, [{ method: 'POST', pathname: '/data/apps/seat/submit', parameterNamesOnly: true }]); probe.restore();
});
test('scheduler fires once without a busy polling loop', async () => {
  let serverNow = 0; let fired = 0; const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }; const win = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: (fn) => setTimeout(fn, 1), cancelAnimationFrame: clearTimeout }; const scheduler = new OpenScheduler({ clock: { now: () => serverNow }, documentRef: doc, windowRef: win, onFire: () => { fired += 1; } }); scheduler.start(5); serverNow = 5; await new Promise((resolve) => setTimeout(resolve, 12)); assert.equal(fired, 1); scheduler.stop();
});
test('visibility warning is issued only near the open window', () => {
  let warnings = 0; const doc = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} }; const win = { addEventListener() {}, removeEventListener() {} }; const scheduler = new OpenScheduler({ clock: { now: () => 100 }, documentRef: doc, windowRef: win, onBackground: () => { warnings += 1; } }); scheduler.running = true; scheduler.fireAt = 1_000; scheduler.visibilityHandler(); assert.equal(warnings, 1);
});
