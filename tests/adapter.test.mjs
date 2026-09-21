import assert from 'node:assert/strict';
import test from 'node:test';
import { ChaoxingSeatPageAdapter } from '../src/page-adapter.js';

function makeAdapter(overrides = {}) {
  const vm = { chosedDay: '2026-09-20', chosedSeatNum: '062', chosedTimeInfo: { startTime: '15:00', endTime: '22:00', duration: '7.00' }, seatConfig: { reserveBeforeDay: 1, reserveBeforeTime: '22:30', reserveDuration: 0, securityVerify: 0, reserveMode: 0 }, submit() { this.called = true; }, seatGridList: [{ seatNum: '216' }] };
  const documentRef = { querySelector: () => ({ __vue__: vm }), body: { innerText: '' } }; const locationRef = { href: 'https://office.chaoxing.com/front/third/apps/seat/select?deptIdEnc=abc&id=3747', hostname: 'office.chaoxing.com' }; const windowRef = { performance: { getEntriesByType: () => [{ name: 'https://office.chaoxing.com/js/seat_select_third.js?t=1' }] } };
  return { vm, adapter: new ChaoxingSeatPageAdapter({ documentRef, locationRef, windowRef, ...overrides }) };
}
test('page adapter fingerprints and prepares existing Vue fields without replacing the object', () => {
  const { vm, adapter } = makeAdapter(); const original = vm.chosedTimeInfo; const check = adapter.assertCompatible(vm, '3747'); assert.equal(check.context.deptIdEnc, 'abc'); assert.equal(check.fingerprint.hasSubmit, true); const selection = adapter.prepareReservation({ expectedRoomId: '3747', day: '2026-09-21', seatNum: '216', startTime: '08:00', endTime: '22:00' }, vm); assert.equal(vm.chosedTimeInfo, original); assert.deepEqual(selection, { day: '2026-09-21', seatNum: '216', startTime: '08:00', endTime: '22:00', duration: '14.00', minutes: 840 }); assert.deepEqual(adapter.seatExists('216', vm), { exists: true, authoritative: false, source: 'seatGridList' });
});
test('page adapter fails closed for room mismatch and missing duration', () => {
  const { vm, adapter } = makeAdapter(); assert.throws(() => adapter.assertCompatible(vm, '999')); delete vm.chosedTimeInfo.duration; assert.throws(() => adapter.prepareReservation({ expectedRoomId: '3747', day: '2026-09-21', seatNum: '216', startTime: '08:00', endTime: '22:00' }, vm));
});
