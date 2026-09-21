import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { TargetDayFrameLoader, classifyTargetGate, isReserveErrorUrl, isSelectUrl, replaceUrlDay } from '../src/target-day-frame-loader.js';
import { shouldBoot } from '../src/userscript.js';

const selectUrl = 'https://office.chaoxing.com/front/third/apps/seat/select?deptIdEnc=abc&id=3747&day=2026-09-21';

function makeFrameEnvironment({ href = selectUrl, vm = null } = {}) {
  let removed = false;
  const frame = {
    style: {}, setAttribute() {}, remove() { removed = true; },
    contentWindow: { location: { href } },
    contentDocument: { querySelector: (selector) => selector === '.order' && vm ? { __vue__: vm } : null }
  };
  const documentRef = { createElement: () => frame, body: { append: () => queueMicrotask(() => frame.onload?.()) } };
  const windowRef = { location: { href: selectUrl } };
  return { frame, documentRef, windowRef, wasRemoved: () => removed };
}

test('target day URL replacement retains all query context except day', () => {
  const replaced = replaceUrlDay('https://office.chaoxing.com/front/third/apps/seat/select?deptIdEnc=abc&id=3747&day=old', '2026-09-22');
  const url = new URL(replaced);
  assert.equal(url.searchParams.get('deptIdEnc'), 'abc');
  assert.equal(url.searchParams.get('id'), '3747');
  assert.equal(url.searchParams.get('day'), '2026-09-22');
});

test('target gate classifies select and reserve-error final URLs', () => {
  assert.equal(isSelectUrl(selectUrl), true);
  assert.equal(isReserveErrorUrl('https://office.chaoxing.com/front/apps/reserve/error/invalid'), true);
  assert.deepEqual(classifyTargetGate(selectUrl, '2026-09-21'), { gate: 'OPEN', reason: 'SELECT_PAGE_FOR_TARGET_DAY' });
  assert.deepEqual(classifyTargetGate('https://office.chaoxing.com/front/apps/reserve/error/invalid', '2026-09-21'), { gate: 'CLOSED', reason: 'SERVER_REDIRECT_TO_RESERVE_ERROR' });
});

test('iframe loader reads page compatibility without invoking vm.submit', async () => {
  let submitCalls = 0;
  const vm = { chosedDay: '2026-09-21', roomName: '图书馆', roomId: '3747', deptIdEnc: 'abc', seatConfig: { reserveBeforeDay: 1, reserveBeforeTime: '22:30', securityVerify: 0, reserveMode: 0 }, submit() { submitCalls += 1; } };
  const env = makeFrameEnvironment({ vm });
  const loader = new TargetDayFrameLoader({ ...env, now: () => 100 });
  const loaded = await loader.load(selectUrl);
  const inspection = await loader.waitForVue(100, 1);
  assert.equal(loaded.sameOriginAccessible, true);
  assert.equal(inspection.vueFound, true);
  assert.equal(inspection.submitIsFunction, true);
  assert.equal(inspection.roomId, '3747');
  assert.equal(submitCalls, 0);
  loader.destroy();
  assert.equal(env.wasRemoved(), true);
});

test('iframe loader times out while waiting for Vue instead of submitting or retrying network requests', async () => {
  let now = 0;
  const env = makeFrameEnvironment();
  const loader = new TargetDayFrameLoader({ ...env, now: () => now, sleep: async () => { now += 100; } });
  loader.frame = env.frame;
  await assert.rejects(loader.waitForVue(200, 100), /IFRAME_VUE_TIMEOUT/);
});

test('iframe loader detects inaccessible child DOM and exposes no frame after destroy', () => {
  const env = makeFrameEnvironment();
  Object.defineProperty(env.frame.contentWindow, 'location', { get() { const error = new Error('Blocked a frame'); error.name = 'SecurityError'; throw error; } });
  const loader = new TargetDayFrameLoader(env);
  loader.frame = env.frame;
  assert.deepEqual(loader.inspect().sameOriginAccessible, false);
  assert.equal(loader.inspect().error, 'CROSS_ORIGIN_DOM_EXCEPTION');
  loader.destroy();
  assert.equal(loader.frameWindow, null);
  assert.equal(env.wasRemoved(), true);
});

test('iframe loader fails closed when the child changes the parent URL', async () => {
  const env = makeFrameEnvironment();
  env.documentRef.body.append = () => queueMicrotask(() => { env.windowRef.location.href = 'https://office.chaoxing.com/front/apps/reserve/error/frame-bust'; env.frame.onload?.(); });
  const loader = new TargetDayFrameLoader(env);
  await assert.rejects(loader.load(selectUrl), /FRAME_BUSTING_DETECTED/);
  loader.destroy();
  assert.equal(env.wasRemoved(), true);
});

test('iframe loader exposes the target page only for human verification', () => {
  const env = makeFrameEnvironment(); const loader = new TargetDayFrameLoader(env); loader.frame = env.frame;
  loader.showForHuman(); assert.match(env.frame.style.cssText, /z-index:2147483646/); assert.match(env.frame.style.cssText, /pointer-events:auto/);
  loader.hide(); assert.match(env.frame.style.cssText, /left:-10000px/); assert.match(env.frame.style.cssText, /pointer-events:none/);
});

test('top window boot guard rejects iframe execution and metadata declares noframes', async () => {
  const self = {}; const location = { hostname: 'office.chaoxing.com', pathname: '/front/third/apps/seat/select' };
  assert.equal(shouldBoot({ top: self, self, location }), true);
  assert.equal(shouldBoot({ top: {}, self, location }), false);
  const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  const userscript = await readFile(new URL('../src/userscript.js', import.meta.url), 'utf8');
  assert.match(build, /@noframes/);
  assert.match(userscript, /if \(window\.top !== window\.self\) return;/);
});
