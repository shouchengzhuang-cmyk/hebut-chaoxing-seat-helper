import { durationFor, parseClockTime } from './clock.js';

function safeUrl(locationRef) { try { return new URL(locationRef.href); } catch { throw new Error('页面 URL 无法解析'); } }
export class ChaoxingSeatPageAdapter {
  constructor({ windowRef = window, documentRef = document, locationRef = location, logger = null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.window = windowRef; this.document = documentRef; this.location = locationRef; this.logger = logger; this.sleep = sleep;
  }
  getVue() { return this.document.querySelector('.order')?.__vue__ ?? null; }
  async waitForVue(timeoutMs = 30_000, intervalMs = 400) {
    const deadline = Date.now() + timeoutMs; let vm;
    while (!(vm = this.getVue()) && Date.now() < deadline) await this.sleep(intervalMs);
    if (!vm) throw new Error('Vue not found: .order.__vue__ 未在等待窗口内出现'); return vm;
  }
  getUrlContext(vm = this.getVue()) {
    const url = safeUrl(this.location); const roomId = url.searchParams.get('id') ?? vm?.roomId ?? vm?.id ?? null;
    return { url: url.href, roomId: roomId === null ? null : String(roomId), deptIdEnc: url.searchParams.get('deptIdEnc') ?? vm?.deptIdEnc ?? null };
  }
  getConfig(vm = this.getVue()) { if (!vm?.seatConfig || typeof vm.seatConfig !== 'object') throw new Error('seatConfig 不存在'); return vm.seatConfig; }
  getRoomName(vm = this.getVue()) {
    const direct = vm?.roomName ?? vm?.seatConfig?.roomName ?? vm?.seatConfig?.name; if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const fallback = ['.room-name', '.roomName', '.seat-room-name', '.order .title', '.order h1', '.order h2'].map((selector) => this.document.querySelector(selector)?.textContent?.trim()).find(Boolean);
    return typeof fallback === 'string' ? fallback.slice(0, 160) : '';
  }
  getServerTimeCandidates(vm = this.getVue()) { return [{ value: this.window.currentServerTime, dynamic: typeof this.window.currentServerTime === 'function' }, { value: vm?.currentServerTime, dynamic: typeof vm?.currentServerTime === 'function' }, { value: vm?.seatConfig?.currentServerTime, dynamic: typeof vm?.seatConfig?.currentServerTime === 'function' }]; }
  getContext(vm = this.getVue()) {
    const config = this.getConfig(vm); const url = this.getUrlContext(vm);
    return { ...url, currentDay: vm.chosedDay ?? null, roomName: this.getRoomName(vm), seatConfig: config, scriptVersion: this.fingerprint(vm).scriptResource, vueAvailable: Boolean(vm) };
  }
  getCurrentSelection(vm = this.getVue()) { return { day: vm?.chosedDay, seatNum: vm?.chosedSeatNum, ...(vm?.chosedTimeInfo ? { startTime: vm.chosedTimeInfo.startTime, endTime: vm.chosedTimeInfo.endTime, duration: vm.chosedTimeInfo.duration } : {}) }; }
  fingerprint(vm = this.getVue()) {
    const cfg = vm?.seatConfig ?? {}; const resource = this.window.performance?.getEntriesByType?.('resource')?.map((item) => item.name).find((name) => /seat_select_third\.js/i.test(name)) ?? null;
    return { hasVue: Boolean(vm), hasSubmit: typeof vm?.submit === 'function', hasChosedDay: 'chosedDay' in (vm ?? {}), hasChosedSeatNum: 'chosedSeatNum' in (vm ?? {}), hasChosedTimeInfo: Boolean(vm?.chosedTimeInfo), reserveBeforeDay: cfg.reserveBeforeDay, reserveBeforeTime: cfg.reserveBeforeTime, securityVerify: cfg.securityVerify, reserveMode: cfg.reserveMode, scriptResource: resource };
  }
  assertCompatible(vm = this.getVue(), expectedRoomId = null) {
    const fp = this.fingerprint(vm); if (!fp.hasVue || !fp.hasSubmit || !fp.hasChosedDay || !fp.hasChosedSeatNum || !fp.hasChosedTimeInfo) throw new Error('页面关键 Vue 结构缺失');
    const context = this.getContext(vm); if (!context.roomId || !context.deptIdEnc) throw new Error('roomId 或 deptIdEnc 缺失');
    if (expectedRoomId && context.roomId !== String(expectedRoomId)) throw new Error(`roomId 不匹配: ${context.roomId} != ${expectedRoomId}`);
    if (!Number.isInteger(Number(context.seatConfig.reserveBeforeDay)) || !/^\d{2}:\d{2}$/.test(String(context.seatConfig.reserveBeforeTime ?? ''))) throw new Error('页面开放规则异常');
    return { context, fingerprint: fp };
  }
  prepareReservation(target, vm = this.getVue()) {
    this.assertCompatible(vm, target.expectedRoomId); const info = vm.chosedTimeInfo;
    if (!info || typeof info !== 'object' || !('startTime' in info) || !('endTime' in info) || !('duration' in info)) throw new Error('chosedTimeInfo 结构不兼容');
    const { minutes, duration } = durationFor(target.startTime, target.endTime); const cfg = vm.seatConfig;
    if (Number(cfg.reserveDuration) > 0 && minutes > Number(cfg.reserveDuration)) throw new Error('超过房间允许预约时长');
    if (Number(cfg.minReserveDuration) > 0 && minutes < Number(cfg.minReserveDuration)) throw new Error('低于房间最短预约时长');
    if (cfg.startTime && target.startTime < cfg.startTime || cfg.endTime && target.endTime > cfg.endTime) throw new Error('预约时间超出房间开放范围');
    vm.chosedDay = target.day; vm.chosedSeatNum = String(target.seatNum); info.startTime = target.startTime; info.endTime = target.endTime; info.duration = duration;
    const selected = this.getCurrentSelection(vm); if (selected.day !== target.day || String(selected.seatNum) !== String(target.seatNum) || selected.startTime !== target.startTime || selected.endTime !== target.endTime || selected.duration !== duration) throw new Error('Vue 预约状态写入后校验失败');
    return { ...selected, duration, minutes };
  }
  submitOfficial(vm = this.getVue()) { if (typeof vm?.submit !== 'function') throw new Error('vm.submit 不存在'); vm.submit(); }
  observeSuccess(target, vm = this.getVue()) {
    if (vm?.submitsuccess === true) return true; const reservation = vm?.seatReserve; if (!reservation) return false;
    const day = reservation.day ?? reservation.reserveDay; const seat = reservation.seatNum ?? reservation.seatNo;
    return (!day || String(day) === target.day) && (!seat || String(seat) === String(target.seatNum));
  }
  seatExists(seatNum, vm = this.getVue()) {
    const sources = [{ name: 'seatGridList', value: vm?.seatGridList }, { name: 'drawSeatList', value: vm?.drawSeatList }, { name: 'dynamicSeatNums', value: vm?.dynamicSeatNums }].filter((item) => Array.isArray(item.value));
    if (!sources.length) return { exists: null, authoritative: false, source: null };
    const source = sources[0]; const exists = source.value.some((seat) => String(seat.seatNum ?? seat.seatNo ?? seat) === String(seatNum));
    const expectedCount = Number(vm?.seatConfig?.seatCount ?? vm?.seatConfig?.totalSeatCount); const authoritative = source.name === 'seatGridList' && (vm?.seatGridListComplete === true || vm?.seatConfig?.seatGridComplete === true || (Number.isInteger(expectedCount) && expectedCount > 0 && expectedCount === source.value.length));
    return { exists, authoritative, source: source.name };
  }
  isSessionExpired() { return /passport2\.chaoxing\.com/i.test(this.location.hostname) || /登录失效|请先登录|重新登录/.test(this.document.body?.innerText ?? ''); }
}
