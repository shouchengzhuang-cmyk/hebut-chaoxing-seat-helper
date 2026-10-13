// ==UserScript==
// @name         HEBUT Chaoxing Seat Helper
// @namespace    hebut-chaoxing-seat-helper
// @version      1.2.0
// @description  河北工业大学超星图书馆座位预约助手
// @match        https://office.chaoxing.com/front/third/apps/seat/select*
// @match        https://office.chaoxing.com/front/third/apps/seat/index*
// @match        https://office.chaoxing.com/front/third/apps/seat/code*
// @match        https://office.chaoxing.com/front/apps/seatengine/index*
// @match        https://office.chaoxing.com/front/apps/seatengine/select*
// @match        https://office.chaoxing.com/front/apps/seatengine/code*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
'use strict';
const SeatState = Object.freeze({
  IDLE: 'IDLE', PROBING: 'PROBING', READY: 'READY', ARMED: 'ARMED',
  WAITING_FOR_OPEN: 'WAITING_FOR_OPEN', WAITING_FOR_GATE_RELEASE: 'WAITING_FOR_GATE_RELEASE',
  LOADING_TARGET_DAY: 'LOADING_TARGET_DAY', TARGET_READY: 'TARGET_READY', FIRING: 'FIRING', VERIFYING: 'VERIFYING', SUCCESS: 'SUCCESS',
  NEEDS_HUMAN: 'NEEDS_HUMAN', SESSION_EXPIRED: 'SESSION_EXPIRED', MISSED_WINDOW: 'MISSED_WINDOW', STOPPED: 'STOPPED', ERROR: 'ERROR'
});

const transitions = Object.freeze({
  IDLE: ['PROBING', 'READY', 'STOPPED', 'ERROR'],
  PROBING: ['READY', 'NEEDS_HUMAN', 'SESSION_EXPIRED', 'STOPPED', 'ERROR'],
  READY: ['PROBING', 'ARMED', 'MISSED_WINDOW', 'STOPPED', 'ERROR'],
  ARMED: ['WAITING_FOR_OPEN', 'LOADING_TARGET_DAY', 'MISSED_WINDOW', 'STOPPED', 'ERROR'],
  WAITING_FOR_OPEN: ['LOADING_TARGET_DAY', 'MISSED_WINDOW', 'STOPPED', 'ERROR'],
  WAITING_FOR_GATE_RELEASE: ['LOADING_TARGET_DAY', 'NEEDS_HUMAN', 'STOPPED', 'ERROR'],
  LOADING_TARGET_DAY: ['TARGET_READY', 'WAITING_FOR_GATE_RELEASE', 'SESSION_EXPIRED', 'STOPPED', 'ERROR'],
  TARGET_READY: ['FIRING', 'STOPPED', 'ERROR'],
  FIRING: ['VERIFYING', 'NEEDS_HUMAN', 'SESSION_EXPIRED', 'STOPPED', 'ERROR'],
  VERIFYING: ['SUCCESS', 'WAITING_FOR_GATE_RELEASE', 'FIRING', 'NEEDS_HUMAN', 'SESSION_EXPIRED', 'STOPPED', 'ERROR'],
  SUCCESS: [], NEEDS_HUMAN: ['SUCCESS', 'STOPPED', 'ERROR'], SESSION_EXPIRED: ['PROBING', 'STOPPED'],
  MISSED_WINDOW: ['PROBING', 'STOPPED'], STOPPED: ['PROBING', 'READY', 'ARMED'], ERROR: ['PROBING', 'STOPPED']
});

class SeatStateMachine {
  constructor(initial = SeatState.IDLE, onTransition = () => {}) {
    this.state = initial;
    this.history = [{ from: null, to: initial, at: Date.now(), reason: 'initial' }];
    this.onTransition = onTransition;
  }
  can(to) { return transitions[this.state]?.includes(to) ?? false; }
  transition(to, reason = '') {
    if (!this.can(to)) throw new Error(`Illegal seat state transition: ${this.state} -> ${to}`);
    const event = { from: this.state, to, at: Date.now(), reason };
    this.state = to;
    this.history.push(event);
    this.onTransition(event);
    return event;
  }
  isTerminal() { return transitions[this.state]?.length === 0; }
}


const SENSITIVE_KEY = /cookie|password|token|captcha|authorization|wyToken|enc|session/i;
const SENSITIVE_TEXT = /(cookie|password|token|captcha|authorization|wyToken|enc|session)\s*[:=]\s*[^,\s&}]+/gi;

function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(SENSITIVE_TEXT, '$1=[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}

class EventLogger {
  constructor({ limit = 800, now = () => new Date().toISOString(), consoleRef = console } = {}) {
    this.limit = limit; this.now = now; this.console = consoleRef; this.events = [];
  }
  log(level, event, state, details = {}) {
    const entry = { timestamp: this.now(), level, event, state, details: redact(details) };
    this.events.push(entry); if (this.events.length > this.limit) this.events.shift();
    this.console?.[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']?.('[HEBUT-SEAT]', event, entry);
    return entry;
  }
  export() { return JSON.stringify(this.events, null, 2); }
  download(filename = `hebut-seat-log-${Date.now()}.json`, documentRef = document) {
    const blob = new Blob([this.export()], { type: 'application/json' }); const url = URL.createObjectURL(blob);
    const a = documentRef.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}


const DEFAULT_SETTINGS = Object.freeze({
  expectedRoomId: '3747', seatPriority: ['216'], startTime: '08:00', endTime: '22:00', fireDelayMs: 100,
  mode: 'dry-run', retryPolicy: { maxTotalSubmits: 4, gateRetryDelaysMs: [180, 260, 400], targetGateRetryDelaysMs: [0, 180, 260, 400, 650, 900], allowSeatFallback: true },
  autoArm: false, daysOfWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], notifications: true, recoveryGraceMs: 3000
});

class SeatStorage {
  constructor(storage = globalThis.localStorage, session = globalThis.sessionStorage, prefix = 'hebut-chaoxing-seat-helper') {
    this.storage = storage; this.session = session; this.prefix = prefix;
  }
  key(name) { return `${this.prefix}:${name}`; }
  read(name, fallback = null, persistent = true) { try { const raw = (persistent ? this.storage : this.session).getItem(this.key(name)); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
  write(name, value, persistent = true) { (persistent ? this.storage : this.session).setItem(this.key(name), JSON.stringify(value)); }
  remove(name, persistent = true) { (persistent ? this.storage : this.session).removeItem(this.key(name)); }
  getSettings() { return { ...DEFAULT_SETTINGS, ...(this.read('settings', {})), retryPolicy: { ...DEFAULT_SETTINGS.retryPolicy, ...(this.read('settings', {})?.retryPolicy ?? {}) } }; }
  saveSettings(settings) { this.write('settings', settings); }
  getRuntime() { return this.read('runtime', {}, false); }
  saveRuntime(runtime) { this.write('runtime', runtime, false); }
  getSuccess(targetDay) { return this.read(`success:${targetDay}`); }
  getLatestSuccess() {
    let latest = null; try { for (let i = 0; i < Number(this.storage.length); i += 1) { const key = this.storage.key(i); const prefix = `${this.key('success:')}`; if (!key?.startsWith(prefix)) continue; const day = key.slice(prefix.length); const value = this.read(`success:${day}`); if (value && (!latest || Number(value.at) > Number(latest.value.at))) latest = { day, value }; } } catch {} return latest;
  }
  markSuccess(targetDay, reservation) { this.write(`success:${targetDay}`, { at: Date.now(), reservation }); }
  getAttempt(targetDay) { return this.read(`attempt:${targetDay}`); }
  markSubmittedUnverified(targetDay, details) { this.write(`attempt:${targetDay}`, { state: 'SUBMITTED_UNVERIFIED', at: Date.now(), owner: details.owner ?? null, details: { roomId: details.roomId, seatNum: details.seatNum, startTime: details.startTime, endTime: details.endTime } }); }
  markAttemptSuccess(targetDay, details) { this.write(`attempt:${targetDay}`, { state: 'SUCCESS_CONFIRMED', at: Date.now(), details: { seatNum: details?.seatNum ?? null } }); }
  clearAttemptForDefinitiveFailure(targetDay, details = {}) { this.remove(`attempt:${targetDay}`); this.write(`attempt-resolution:${targetDay}`, { state: 'DEFINITIVE_FAILURE', at: Date.now(), details: { kind: details.kind ?? 'DEFINITIVE_FAILURE' } }); }
  resetAttemptForDate(targetDay) { this.remove(`attempt:${targetDay}`); this.remove(`attempt-resolution:${targetDay}`); }
  tryAcquireFallbackLock(owner, ttlMs = 30_000, now = Date.now()) {
    const name = 'submit-lock'; const existing = this.read(name);
    if (existing && existing.expiresAt > now && existing.owner !== owner) return false;
    this.write(name, { owner, expiresAt: now + ttlMs });
    return this.read(name)?.owner === owner;
  }
  releaseFallbackLock(owner) { const existing = this.read('submit-lock'); if (existing?.owner === owner) this.remove('submit-lock'); }
  renewFallbackLock(owner, ttlMs = 60_000, now = Date.now()) {
    const existing = this.read('submit-lock'); if (!existing || existing.owner !== owner || existing.expiresAt <= now) return false;
    this.write('submit-lock', { owner, expiresAt: now + ttlMs }); return true;
  }
}


const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function parseClockTime(value, withSeconds = false) {
  const pattern = withSeconds ? /^(\d{2}):(\d{2}):(\d{2})$/ : /^(\d{2}):(\d{2})$/;
  const match = pattern.exec(String(value)); if (!match) throw new Error(`Invalid time: ${value}`);
  const [hour, minute, second = '0'] = match.slice(1).map(Number);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`Invalid time: ${value}`);
  return { hour, minute, second };
}
function shanghaiParts(epochMs = Date.now()) {
  const date = new Date(epochMs + SHANGHAI_OFFSET_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}
function formatShanghaiDay(epochMs = Date.now()) {
  const { year, month, day } = shanghaiParts(epochMs); return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function tomorrowShanghai(epochMs = Date.now()) { return addShanghaiDays(formatShanghaiDay(epochMs), 1); }
function parseShanghaiDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day)); if (!match) throw new Error(`Invalid Shanghai day: ${day}`);
  const [year, month, date] = match.slice(1).map(Number); const probe = new Date(Date.UTC(year, month - 1, date));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== date) throw new Error(`Invalid Shanghai day: ${day}`);
  return { year, month, date };
}
function shanghaiEpoch(day, time = '00:00:00') {
  const { year, month, date } = parseShanghaiDay(day); const { hour, minute, second } = parseClockTime(time.length === 5 ? `${time}:00` : time, true);
  return Date.UTC(year, month - 1, date, hour, minute, second) - SHANGHAI_OFFSET_MS;
}
function addShanghaiDays(day, days) { return formatShanghaiDay(shanghaiEpoch(day) + days * 24 * 60 * 60 * 1000); }
function weekdayForShanghaiDay(day) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(shanghaiEpoch(day) + SHANGHAI_OFFSET_MS).getUTCDay()]; }
function calculateOpenAt(targetDay, reserveBeforeDay, reserveBeforeTime) {
  const before = Number(reserveBeforeDay); if (!Number.isInteger(before) || before < 0 || before > 31) throw new Error('Invalid reserveBeforeDay');
  parseClockTime(reserveBeforeTime);
  return shanghaiEpoch(addShanghaiDays(targetDay, -before), reserveBeforeTime);
}
function durationFor(startTime, endTime) {
  const start = parseClockTime(startTime); const end = parseClockTime(endTime); const minutes = (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute);
  if (minutes <= 0) throw new Error('预约结束时间必须晚于开始时间'); return { minutes, duration: (minutes / 60).toFixed(2) };
}

class ServerClock {
  constructor({ fetchFn = globalThis.fetch?.bind(globalThis), performanceRef = globalThis.performance, wallNow = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.fetchFn = fetchFn; this.performance = performanceRef; this.wallNow = wallNow; this.sleep = sleep; this.source = 'LOCAL_FALLBACK'; this.offsetMs = 0; this.rttMs = null; this.uncertaintyMs = null; this.serverEpochAnchor = null; this.performanceAnchor = null;
  }
  now() { return this.serverEpochAnchor === null ? this.wallNow() : this.serverEpochAnchor + (this.performance.now() - this.performanceAnchor); }
  parsePageServerTime(candidate) {
    const wrapped = candidate && typeof candidate === 'object' && 'value' in candidate; const dynamic = wrapped ? candidate.dynamic === true : typeof candidate === 'function'; let value; try { value = typeof (wrapped ? candidate.value : candidate) === 'function' ? (wrapped ? candidate.value : candidate)() : (wrapped ? candidate.value : candidate); } catch { return null; }
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value);
    let epoch = typeof value === 'number' ? value : Date.parse(value); if (!Number.isFinite(epoch)) return null;
    const precisionMs = Math.abs(epoch) < 100_000_000_000 ? 500 : 25; if (Math.abs(epoch) < 100_000_000_000) epoch *= 1000;
    if (epoch < Date.UTC(2020, 0, 1) || epoch > Date.UTC(2100, 0, 1)) return null;
    return { epoch, uncertaintyMs: precisionMs, dynamic };
  }
  calibrateFromPage(candidates = []) {
    for (const candidate of candidates) { const parsed = this.parsePageServerTime(candidate); if (!parsed) continue; const wallNow = this.wallNow(); const maxAgeMs = parsed.dynamic ? 5_000 : 1_000; if (Math.abs(parsed.epoch - wallNow) > maxAgeMs) continue; this.source = 'CHAOXING_SERVER_TIME'; this.offsetMs = parsed.epoch - wallNow; this.rttMs = 0; this.uncertaintyMs = parsed.uncertaintyMs; this.serverEpochAnchor = parsed.epoch; this.performanceAnchor = this.performance.now(); return this.snapshot(); }
    return null;
  }
  async calibrate(url, samples = 3, pageTimeCandidates = []) {
    const pageClock = this.calibrateFromPage(pageTimeCandidates); if (pageClock) return pageClock;
    const measured = [];
    if (typeof this.fetchFn === 'function') for (let i = 0; i < samples; i += 1) {
      const wallStart = this.wallNow(); const perfStart = this.performance.now();
      try {
        const response = await this.fetchFn(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'follow' });
        const perfEnd = this.performance.now(); const wallEnd = this.wallNow(); const date = response.headers?.get?.('date'); const serverEpoch = Date.parse(date);
        if (Number.isFinite(serverEpoch)) measured.push({ offsetMs: serverEpoch - ((wallStart + wallEnd) / 2), rttMs: perfEnd - perfStart });
      } catch { /* graceful local fallback */ }
      if (i + 1 < samples) await this.sleep(220);
    }
    if (measured.length) {
      const lowRtt = measured.sort((a, b) => a.rttMs - b.rttMs).slice(0, Math.ceil(measured.length / 2));
      const selected = lowRtt.sort((a, b) => a.offsetMs - b.offsetMs)[Math.floor(lowRtt.length / 2)];
      this.source = 'HTTP_DATE'; this.offsetMs = selected.offsetMs; this.rttMs = selected.rttMs;
      // HTTP Date typically has one-second granularity, so this is deliberately not a fictitious millisecond precision claim.
      this.uncertaintyMs = Math.ceil(500 + (selected.rttMs / 2));
    } else { this.source = 'LOCAL_FALLBACK'; this.offsetMs = 0; this.rttMs = null; this.uncertaintyMs = null; }
    this.serverEpochAnchor = this.wallNow() + this.offsetMs; this.performanceAnchor = this.performance.now();
    return this.snapshot();
  }
  snapshot() { return { source: this.source, offsetMs: this.offsetMs, rttMs: this.rttMs, uncertaintyMs: this.uncertaintyMs, estimatedServerNow: this.now() }; }
}



function safeUrl(locationRef) { try { return new URL(locationRef.href); } catch { throw new Error('页面 URL 无法解析'); } }
class ChaoxingSeatPageAdapter {
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


function replaceUrlDay(href, day) { const url = new URL(href); url.searchParams.set('day', day); return url.href; }
function isSelectUrl(href) { try { return new URL(href).pathname === '/front/third/apps/seat/select'; } catch { return false; } }
function isReserveErrorUrl(href) { try { return /^\/front\/apps\/reserve\/error\//.test(new URL(href).pathname); } catch { return false; } }
function classifyTargetGate(finalUrl, requestedDay) {
  if (isReserveErrorUrl(finalUrl)) return { gate: 'CLOSED', reason: 'SERVER_REDIRECT_TO_RESERVE_ERROR' };
  try { const url = new URL(finalUrl); if (isSelectUrl(finalUrl) && url.searchParams.get('day') === requestedDay) return { gate: 'OPEN', reason: 'SELECT_PAGE_FOR_TARGET_DAY' }; } catch { /* handled as unknown */ }
  return { gate: 'UNKNOWN', reason: 'UNEXPECTED_FINAL_URL' };
}

class TargetDayFrameLoader {
  constructor({ windowRef = window, documentRef = document, logger = null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => performance.now() } = {}) {
    this.window = windowRef; this.document = documentRef; this.logger = logger; this.sleep = sleep; this.now = now; this.frame = null; this.requestedUrl = null; this.parentUrl = null; this.loadMs = null;
  }
  log(level, event, details = {}) { this.logger?.log(level, event, 'DEBUG', details); }
  createFrame() {
    // 保持 iframe 可布局但移出视口；不使用 sandbox，避免改变页面自己的初始化语义。
    const frame = this.document.createElement('iframe'); frame.setAttribute?.('aria-hidden', 'true'); frame.setAttribute?.('tabindex', '-1'); frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:800px;height:800px;opacity:0;pointer-events:none;visibility:hidden;border:0;';
    this.frame = frame; this.log('info', 'IFRAME_CREATED'); return frame;
  }
  hide() {
    if (!this.frame) return;
    this.frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:800px;height:800px;opacity:0;pointer-events:none;visibility:hidden;border:0;';
  }
  showForHuman() {
    if (!this.frame) throw new Error('IFRAME_NOT_CREATED');
    this.frame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;opacity:1;visibility:visible;pointer-events:auto;z-index:2147483646;border:0;';
    this.log('warn', 'IFRAME_SHOWN_FOR_HUMAN');
  }
  async load(url, { timeoutMs = 10_000 } = {}) {
    this.destroy(); this.requestedUrl = url; this.parentUrl = this.window.location.href; const frame = this.createFrame(); const startedAt = this.now();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('IFRAME_LOAD_TIMEOUT')), timeoutMs); const complete = () => { clearTimeout(timeout); resolve(); };
      frame.onload = complete; frame.onerror = () => { clearTimeout(timeout); reject(new Error('IFRAME_LOAD_ERROR')); }; frame.src = url; this.document.body.append(frame);
    });
    this.loadMs = this.now() - startedAt; const inspection = this.inspect(); this.log('info', 'IFRAME_LOAD', { requestedUrl: url, loadMs: this.loadMs }); if (!inspection.sameOriginAccessible) throw new Error('IFRAME_CROSS_ORIGIN'); if (!inspection.parentUrlUnchanged) throw new Error('FRAME_BUSTING_DETECTED'); this.log('info', 'IFRAME_FINAL_URL', { finalUrl: inspection.finalUrl }); this.log('info', 'IFRAME_SAME_ORIGIN_PASS', { finalUrl: inspection.finalUrl }); return inspection;
  }
  inspect() {
    const base = { requestedUrl: this.requestedUrl, finalUrl: null, loadMs: this.loadMs, sameOriginAccessible: false, parentUrlUnchanged: this.parentUrl === this.window.location.href, pathname: null, day: null, orderElementFound: false, vueFound: false, submitIsFunction: false, chosedDay: null, roomId: null, deptIdEnc: null, roomName: '', seatConfig: null, error: null };
    if (!this.frame) return { ...base, error: 'IFRAME_NOT_CREATED' };
    try {
      // 这里严格只读；特别是不调用 iframe 内的 vm.submit()，也不写入任何 Vue 状态。
      const frameWindow = this.frame.contentWindow; const frameDocument = this.frame.contentDocument; if (!frameWindow || !frameDocument) return { ...base, error: 'IFRAME_DOCUMENT_UNAVAILABLE' };
      const finalUrl = frameWindow.location.href; const url = new URL(finalUrl); const order = frameDocument.querySelector('.order'); const vm = order?.__vue__ ?? null; const cfg = vm?.seatConfig;
      return { ...base, finalUrl, sameOriginAccessible: true, pathname: url.pathname, day: url.searchParams.get('day'), orderElementFound: Boolean(order), vueFound: Boolean(vm), submitIsFunction: typeof vm?.submit === 'function', chosedDay: vm?.chosedDay ?? null, roomId: url.searchParams.get('id') ?? vm?.roomId ?? null, deptIdEnc: url.searchParams.get('deptIdEnc') ?? vm?.deptIdEnc ?? null, roomName: typeof (vm?.roomName ?? cfg?.roomName) === 'string' ? (vm?.roomName ?? cfg?.roomName).slice(0, 160) : '', seatConfig: cfg ? { reserveBeforeDay: cfg.reserveBeforeDay, reserveBeforeTime: cfg.reserveBeforeTime, securityVerify: cfg.securityVerify, reserveMode: cfg.reserveMode } : null };
    } catch (error) { return { ...base, error: error?.name === 'SecurityError' ? 'CROSS_ORIGIN_DOM_EXCEPTION' : String(error?.message ?? error) }; }
  }
  async waitForVue(timeoutMs = 10_000, intervalMs = 80) {
    const deadline = this.now() + timeoutMs; let inspection = this.inspect();
    while (!inspection.vueFound && this.now() < deadline) { await this.sleep(intervalMs); inspection = this.inspect(); }
    if (!inspection.sameOriginAccessible) throw new Error(inspection.error ?? 'IFRAME_CROSS_ORIGIN'); if (!inspection.vueFound) throw new Error('IFRAME_VUE_TIMEOUT'); this.log('info', 'IFRAME_VUE_READY', { finalUrl: inspection.finalUrl, chosedDay: inspection.chosedDay }); return inspection;
  }
  get frameWindow() { return this.frame?.contentWindow ?? null; }
  get frameDocument() { return this.frame?.contentDocument ?? null; }
  destroy() { if (!this.frame) return; this.frame.remove?.(); this.frame = null; this.log('info', 'IFRAME_DESTROYED'); }
}


const SUBMIT_PATH = /\/data\/apps\/seat\/submit(?:$|[?#])/;
function isSubmitUrl(url, base) { try { return SUBMIT_PATH.test(new URL(url, base).pathname); } catch { return false; } }
function resultBody(xhr) {
  try { const json = typeof xhr.response === 'object' ? xhr.response : JSON.parse(xhr.responseText); return { success: json?.success === true, msg: String(json?.msg ?? json?.message ?? ''), hasJson: Boolean(json) }; } catch { return { success: false, msg: '', hasJson: false }; }
}

class SubmitObserver {
  constructor({ windowRef = window, onResult = () => {}, onDispatch = () => {} } = {}) { this.window = windowRef; this.onResult = onResult; this.onDispatch = onDispatch; this.installed = false; this.original = null; this.meta = new WeakMap(); }
  install() {
    if (this.installed) return; const win = this.window; const xhrProto = win.XMLHttpRequest?.prototype; if (!xhrProto) return;
    this.original = { open: xhrProto.open, send: xhrProto.send, fetch: win.fetch };
    const now = () => win.performance?.now?.() ?? globalThis.performance?.now?.() ?? Date.now(); const self = this;
    xhrProto.open = function patchedOpen(method, url, ...rest) { self.meta.set(this, { method, url, submit: isSubmitUrl(url, win.location?.href), startedAt: null }); return self.original.open.call(this, method, url, ...rest); };
    xhrProto.send = function patchedSend(...args) {
      const meta = self.meta.get(this); if (meta?.submit) { meta.startedAt = now(); self.onDispatch({ method: meta.method, pathname: new URL(meta.url, win.location.href).pathname, startedAt: meta.startedAt }); this.addEventListener('loadend', () => self.onResult({ transport: 'xhr', status: this.status, elapsedMs: now() - meta.startedAt, ...resultBody(this) }), { once: true }); this.addEventListener('error', () => self.onResult({ transport: 'xhr', status: this.status || 0, networkError: true }), { once: true }); }
      return self.original.send.apply(this, args);
    };
    if (typeof win.fetch === 'function') win.fetch = async function patchedFetch(input, init) { const url = typeof input === 'string' ? input : input?.url; const submit = isSubmitUrl(url, win.location?.href); const startedAt = now(); if (submit) self.onDispatch({ method: init?.method ?? 'GET', pathname: new URL(url, win.location.href).pathname, startedAt }); const response = await self.original.fetch.call(this, input, init); if (submit) response.clone().text().then((text) => { let json; try { json = JSON.parse(text); } catch { json = null; } self.onResult({ transport: 'fetch', status: response.status, elapsedMs: now() - startedAt, success: json?.success === true, msg: String(json?.msg ?? json?.message ?? ''), hasJson: Boolean(json) }); }).catch(() => self.onResult({ transport: 'fetch', status: response.status, hasJson: false })); return response; };
    this.installed = true;
  }
  restore() { if (!this.installed || !this.original) return; const proto = this.window.XMLHttpRequest?.prototype; if (proto) { proto.open = this.original.open; proto.send = this.original.send; } if (this.original.fetch) this.window.fetch = this.original.fetch; this.installed = false; }
}

// Debug only: intercepts one official submit transport before it leaves the browser. It never logs values or is installed by normal flows.
function createShadowSubmitProbe({ windowRef = window, onObserved = () => {} } = {}) {
  const proto = windowRef.XMLHttpRequest?.prototype; if (!proto) throw new Error('XMLHttpRequest 不可用'); const originalOpen = proto.open; const originalSend = proto.send; const meta = new WeakMap(); let active = true;
  proto.open = function shadowOpen(method, url, ...rest) { meta.set(this, { method, url, submit: isSubmitUrl(url, windowRef.location?.href) }); return originalOpen.call(this, method, url, ...rest); };
  proto.send = function shadowSend(...args) { const item = meta.get(this); if (active && item?.submit) { onObserved({ method: item.method, pathname: new URL(item.url, windowRef.location.href).pathname, parameterNamesOnly: true }); return undefined; } return originalSend.apply(this, args); };
  return { restore() { active = false; proto.open = originalOpen; proto.send = originalSend; } };
}


// Local, opt-in read-only diagnostics. Never retains request bodies/headers or exports arbitrary keys.
const READ_PATH = /^\/data\/apps\/(seat|seatengine)\/(index|getstatus)$/;
const RECORD_FIELDS = ['id', 'roomId', 'seatNum', 'today', 'day', 'reserveDay', 'startTime', 'endTime', 'status'];
const BOOLEAN_FIELDS = ['canReserve', 'reviewPending', 'supervisionPending', 'blacklisted', 'seatAvailable', 'isSign', 'signed'];
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function own(value, key) { return plain(value) && Object.hasOwn(value, key) ? value[key] : undefined; }
function endpointOf(raw, base) {
  try { const url = new URL(raw, base); const match = READ_PATH.exec(url.pathname); return url.origin === 'https://office.chaoxing.com' && match ? { apiStyle: match[1], endpoint: match[2] } : null; } catch { return null; }
}
function validDate(value) { try { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value; } catch { return false; } }
function statusValue(value) {
  if (Number.isInteger(value) && Math.abs(value) <= 10000) return value;
  if (typeof value === 'string' && /^-?\d{1,4}$/.test(value)) return value;
  return undefined; // Free-text or opaque string status could contain identifiers or tokens.
}
class DiagnosticSanitizer {
  constructor() { this.aliases = new Map(); this.dateAnchor = null; }
  alias(kind, value) {
    if (!(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^\d{1,16}$/.test(value))) return undefined;
    let aliases = this.aliases.get(kind); if (!aliases) { aliases = new Map(); this.aliases.set(kind, aliases); }
    const key = String(value); if (!aliases.has(key)) { if (aliases.size >= 2000) return undefined; aliases.set(key, aliases.size + 1); }
    const alias = aliases.get(key);
    return typeof value === 'number' ? alias : kind === 'seatNum' ? String(alias).padStart(Math.min(value.length, 6), '0') : String(alias);
  }
  date(value) {
    if (!validDate(value)) return undefined;
    const timestamp = Date.parse(value + 'T00:00:00Z');
    this.dateAnchor ??= timestamp;
    return new Date(Date.UTC(2000, 0, 2) + timestamp - this.dateAnchor).toISOString().slice(0, 10);
  }
  time(value) {
    if (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 4102444800000) return undefined;
    const local = new Date(numeric + 8 * 3600000).toISOString();
    const aliasDay = this.date(local.slice(0, 10));
    const alias = Date.parse(aliasDay + 'T' + local.slice(11, 23) + '+08:00');
    return typeof value === 'string' ? String(alias) : alias;
  }
  record(raw) {
    if (!plain(raw)) return null;
    const output = {};
    // Dates are processed first so timestamps and today aliases agree.
    for (const field of RECORD_FIELDS) {
      const value = own(raw, field); let filtered;
      if (['id', 'roomId', 'seatNum'].includes(field)) filtered = this.alias(field, value);
      else if (['today', 'day', 'reserveDay'].includes(field)) filtered = this.date(value);
      else if (['startTime', 'endTime'].includes(field)) filtered = this.time(value);
      else filtered = statusValue(value);
      if (filtered !== undefined) output[field] = filtered;
      else if (value !== undefined) output[field + 'Type'] = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    }
    for (const field of BOOLEAN_FIELDS) if (typeof own(raw, field) === 'boolean') output[field] = raw[field];
    return output;
  }
  project(raw, { apiStyle, endpoint, httpStatus = 200 }) {
    if (!plain(raw) || !['seat', 'seatengine'].includes(apiStyle) || !['index', 'getstatus'].includes(endpoint)) throw new Error('UNSUPPORTED_READONLY_SAMPLE');
    const body = {}, data = own(raw, 'data');
    if (typeof own(raw, 'success') === 'boolean') body.success = raw.success;
    if (typeof own(raw, 'msg') === 'string' || typeof own(raw, 'message') === 'string') {
      const message = own(raw, 'msg') ?? own(raw, 'message');
      body.messageClass = /登录|login|session|认证/i.test(message) ? 'AUTH_HINT' : /监督|验证|captcha/i.test(message) ? 'VERIFICATION_HINT' : 'OTHER';
    }
    if (plain(data)) {
      const out = own(data, "id") !== undefined && own(data, "roomId") !== undefined ? this.record(data) : {};
      for (const field of ['curReserves', 'nearReserves', 'reserves', 'recentReserves']) {
        const value = own(data, field);
        if (Array.isArray(value)) { out[field] = value.slice(0, 100).map(item => this.record(item)); if (value.length > 100) out.truncated = true; }
      }
      for (const field of ['seatReserve', 'reserve', 'reservation']) if (plain(own(data, field))) out[field] = this.record(data[field]);
      for (const field of ['status', 'reserveStatus']) if (statusValue(own(data, field)) !== undefined) out[field] = statusValue(data[field]);
      for (const field of BOOLEAN_FIELDS) if (typeof own(data, field) === 'boolean') out[field] = data[field];
      if (plain(own(data, 'rules'))) {
        out.rules = {}; for (const field of BOOLEAN_FIELDS) if (typeof own(data.rules, field) === 'boolean') out.rules[field] = data.rules[field];
      }
      if (plain(own(data, 'seatConfig'))) {
        out.seatConfig = {};
        for (const field of ['preSignDuration', 'postSignDuration', 'reserveBeforeDay', 'reserveDuration', 'reserveNumLimit']) {
          const value = own(data.seatConfig, field); if (Number.isInteger(value) && value >= 0 && value <= 10000) out.seatConfig[field] = value;
        }
        const time = own(data.seatConfig, 'reserveBeforeTime'); if (typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) out.seatConfig.reserveBeforeTime = time;
      }
      body.data = out;
    }
    return { apiStyle, endpoint, httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : 0, body, omittedFields: true };
  }
}
async function limitedText(response) {
  const clone = response.clone();
  if (!clone.body?.getReader) { const text = await clone.text(); if (text.length > 1000000) throw new Error('TOO_LARGE'); return text; }
  const reader = clone.body.getReader(), chunks = []; let length = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > 1000000) { reader.cancel().catch(() => {}); throw new Error('TOO_LARGE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
class DiagnosticCollector {
  constructor({ windowRef = globalThis.window } = {}) { this.window = windowRef; this.enabled = false; this.samples = []; this.sanitizer = new DiagnosticSanitizer(); this.epoch = 0; this.restoreHooks = null; }
  capture(raw, source) {
    if (!this.enabled) return;
    try { this.samples.push(this.sanitizer.project(raw, source)); this.samples = this.samples.slice(-10); } catch {}
  }
  importReadonly(text, apiStyle, endpoint) {
    if (!this.enabled || typeof text !== 'string' || text.length > 1000000) throw new Error('DIAGNOSTICS_DISABLED_OR_TOO_LARGE');
    const sample = this.sanitizer.project(JSON.parse(text), { apiStyle, endpoint }); this.samples.push(sample); this.samples = this.samples.slice(-10);
  }
  enable() {
    if (this.enabled) return;
    this.enabled = true; this.epoch += 1; const epoch = this.epoch, self = this, win = this.window;
    const proto = win?.XMLHttpRequest?.prototype, originalOpen = proto?.open, originalSend = proto?.send, originalFetch = win?.fetch;
    const metadata = new WeakMap();
    function open(method, url, ...rest) {
      const source = endpointOf(url, win.location?.href);
      metadata.set(this, ['GET', 'POST'].includes(String(method).toUpperCase()) ? source : null);
      return originalOpen.call(this, method, url, ...rest);
    }
    function send(...args) {
      const source = metadata.get(this);
      if (source) this.addEventListener('loadend', () => {
        if (!self.enabled || self.epoch !== epoch) return;
        const final = this.responseURL ? endpointOf(this.responseURL, win.location?.href) : source;
        if (!final || final.endpoint !== source.endpoint || final.apiStyle !== source.apiStyle) return;
        try {
          let raw;
          if (this.responseType === 'json') raw = this.response;
          else if (!this.responseType || this.responseType === 'text') { if (this.responseText.length > 1000000) return; raw = JSON.parse(this.responseText); }
          self.capture(raw, { ...source, httpStatus: this.status });
        } catch {}
      }, { once: true });
      return originalSend.apply(this, args); // Never reads or changes request payload.
    }
    function wrappedFetch(input, init) {
      const url = typeof input === 'string' || input instanceof URL ? input : input?.url;
      const source = endpointOf(url, win.location?.href), method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      const promise = originalFetch.call(this, input, init);
      if (source && ['GET', 'POST'].includes(method)) Promise.resolve(promise).then(response => {
        const final = response.url ? endpointOf(response.url, win.location?.href) : source;
        if (!self.enabled || self.epoch !== epoch || !final || final.endpoint !== source.endpoint || final.apiStyle !== source.apiStyle) return;
        limitedText(response).then(text => { if (self.enabled && self.epoch === epoch) self.capture(JSON.parse(text), { ...source, httpStatus: response.status }); }).catch(() => {});
      }).catch(() => {});
      return promise; // Original response and promise semantics remain intact.
    }
    if (proto && originalOpen && originalSend) { proto.open = open; proto.send = send; }
    if (typeof originalFetch === 'function') win.fetch = wrappedFetch;
    this.restoreHooks = () => {
      // Do not overwrite hooks installed later by the reservation observer or another extension.
      if (proto?.open === open) proto.open = originalOpen;
      if (proto?.send === send) proto.send = originalSend;
      if (win?.fetch === wrappedFetch) win.fetch = originalFetch;
    };
  }
  disable() { this.enabled = false; this.epoch += 1; this.restoreHooks?.(); this.restoreHooks = null; this.samples = []; this.sanitizer = new DiagnosticSanitizer(); }
  preview() {
    return JSON.stringify({ schemaVersion: 1, provenance: 'LOCAL_ANONYMIZED_READONLY_CAPTURE', identifiersAnonymized: true, absoluteDatesAnonymized: true, contractVerified: false, samples: this.samples }, null, 2);
  }
}
class DiagnosticPanel {
  constructor({ collector, documentRef = globalThis.document, download = null } = {}) {
    this.collector = collector; this.document = documentRef; this.root = null; this.previewRoot = null;
    this.download = download ?? ((text) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = this.document.createElement('a'); link.href = url; link.download = 'hebut-seat-readonly-diagnostics.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  }
  mount(parent = this.document.body) {
    if (this.root) return this.root;
    const root = this.document.createElement('details'); root.id = 'hebut-seat-diagnostics';
    const summary = this.document.createElement('summary'); summary.textContent = '只读接口诊断（默认关闭）'; root.append(summary);
    const info = this.document.createElement('p'); info.textContent = '只采集正常页面请求，不主动查询。编号和日期会替换；导出前请预览确认，不提交个人样本到Git。'; root.append(info);
    const enable = this.document.createElement('button'); enable.textContent = '开启本地采集'; enable.onclick = () => { this.collector.enable(); enable.textContent = '采集已开启'; }; root.append(enable);
    const stop = this.document.createElement('button'); stop.textContent = '停止并清除诊断缓存'; stop.onclick = () => { this.collector.disable(); if (this.rawInput) this.rawInput.value = '';  enable.textContent = '开启本地采集'; this.previewRoot?.remove(); this.previewRoot = null; }; root.append(stop);
    const exportButton = this.document.createElement('button'); exportButton.textContent = '预览并导出诊断JSON'; exportButton.onclick = () => this.showPreview(); root.append(exportButton);
    const fallback = this.document.createElement('details'), label = this.document.createElement('summary'); label.textContent = '未捕获到响应？手动粘贴只读响应'; fallback.append(label);
    const instructions = this.document.createElement('p'); instructions.textContent = '浏览器开发者工具Network中仅复制index/getstatus的Response JSON；不要复制请求Headers、Cookie、整份HAR或页面源码。粘贴后在本地白名单脱敏，原文不会进入导出。'; fallback.append(instructions);
    const style = this.document.createElement('select'); for (const name of ['seat', 'seatengine']) { const option = this.document.createElement('option'); option.value = name; option.textContent = name; style.append(option); }
    const endpoint = this.document.createElement('select'); for (const name of ['index', 'getstatus']) { const option = this.document.createElement('option'); option.value = name; option.textContent = name; endpoint.append(option); }
    const raw = this.document.createElement('textarea'); this.rawInput = raw; raw.placeholder = '仅粘贴Response JSON（本地处理）';
    const imported = this.document.createElement('p'), importButton = this.document.createElement('button'); importButton.textContent = '本地脱敏后加入预览';
    importButton.onclick = () => { try { this.collector.importReadonly(raw.value, style.value, endpoint.value); imported.textContent = '已脱敏，原文已清除。'; } catch { imported.textContent = '请先开启采集，并粘贴不超过1MB的JSON响应。'; } finally { raw.value = ''; } };
    fallback.append(style, endpoint, raw, importButton, imported); root.append(fallback); parent.append(root); this.root = root; return root;
  }
  showPreview() {
    this.previewRoot?.remove();
    const dialog = this.document.createElement('dialog'), text = this.collector.preview();
    const heading = this.document.createElement('p'); heading.textContent = '本地脱敏预览：仅点击“确认下载”才导出。编号和日期均为替代值，不能用于真实接口请求。';
    const preview = this.document.createElement('pre'); preview.textContent = text; preview.style.cssText = 'max-height:55vh;overflow:auto;white-space:pre-wrap';
    const confirm = this.document.createElement('button'); confirm.textContent = '确认下载JSON'; confirm.disabled = this.collector.samples.length === 0;
    confirm.onclick = () => { this.download(text); dialog.remove(); this.previewRoot = null; };
    const cancel = this.document.createElement('button'); cancel.textContent = '取消'; cancel.onclick = () => { dialog.remove(); this.previewRoot = null; };
    dialog.append(heading, preview, confirm, cancel); this.document.body.append(dialog); this.previewRoot = dialog;
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    return dialog;
  }
  destroy() { this.collector.disable(); if (this.rawInput) this.rawInput.value = '';  this.previewRoot?.remove(); this.root?.remove(); this.root = null; this.previewRoot = null; }
}


class OpenScheduler {
  constructor({ clock, documentRef = document, windowRef = window, onTick = () => {}, onFire = () => {}, onBackground = () => {}, onWake = () => {} } = {}) {
    this.clock = clock; this.document = documentRef; this.window = windowRef; this.onTick = onTick; this.onFire = onFire; this.onBackground = onBackground; this.onWake = onWake; this.timer = null; this.raf = null; this.running = false; this.fireAt = null;
    this.visibilityHandler = () => { if (!this.running) return; if (this.document.visibilityState === 'hidden' && this.fireAt - this.clock.now() < 120_000) this.onBackground(); else if (this.document.visibilityState !== 'hidden') { this.onWake(); this.tick(); } };
    this.wakeHandler = () => { if (this.running) { this.onWake(); this.tick(); } };
  }
  start(fireAt) { this.stop(); this.fireAt = fireAt; this.running = true; this.document.addEventListener?.('visibilitychange', this.visibilityHandler); this.window.addEventListener?.('focus', this.wakeHandler); this.window.addEventListener?.('pageshow', this.wakeHandler); this.tick(); }
  tick = () => {
    if (!this.running) return; const remainingMs = this.fireAt - this.clock.now(); this.onTick({ remainingMs, visible: this.document.visibilityState !== 'hidden', fireAt: this.fireAt });
    if (remainingMs <= 0) { this.running = false; this.clearTimers(); this.onFire(); return; }
    if (remainingMs > 60 * 60_000) this.timer = setTimeout(this.tick, 5 * 60_000);
    else if (remainingMs > 5 * 60_000) this.timer = setTimeout(this.tick, 60_000);
    else if (remainingMs > 30_000) this.timer = setTimeout(this.tick, Math.min(15_000, remainingMs - 25_000));
    else if (remainingMs > 5_000) this.timer = setTimeout(this.tick, 150);
    else if (remainingMs > 1_000) this.timer = setTimeout(this.tick, 45);
    else if (this.document.visibilityState !== 'hidden' && typeof this.window.requestAnimationFrame === 'function') this.raf = this.window.requestAnimationFrame(this.tick);
    else this.timer = setTimeout(this.tick, Math.min(40, remainingMs));
  };
  clearTimers() { if (this.timer !== null) clearTimeout(this.timer); if (this.raf !== null) this.window.cancelAnimationFrame?.(this.raf); this.timer = null; this.raf = null; }
  stop() { this.running = false; this.clearTimers(); this.document.removeEventListener?.('visibilitychange', this.visibilityHandler); this.window.removeEventListener?.('focus', this.wakeHandler); this.window.removeEventListener?.('pageshow', this.wakeHandler); }
}







const ResultKind = Object.freeze({ SUCCESS: 'SUCCESS', HUMAN_VERIFICATION_REQUIRED: 'HUMAN_VERIFICATION_REQUIRED', GATE_NOT_OPEN: 'GATE_NOT_OPEN', SEAT_CONFLICT: 'SEAT_CONFLICT', RATE_LIMITED: 'RATE_LIMITED', SESSION_EXPIRED: 'SESSION_EXPIRED', CONFIG_ERROR: 'CONFIG_ERROR', DEFINITIVE_FAILURE: 'DEFINITIVE_FAILURE', AMBIGUOUS: 'AMBIGUOUS' });
const patterns = [[ResultKind.HUMAN_VERIFICATION_REQUIRED, /验证码|安全|风控|验证|captcha/i], [ResultKind.GATE_NOT_OPEN, /未开放|未到预约时间|尚未开始|预约时间未到/i], [ResultKind.SEAT_CONFLICT, /座位已被预约|已约满|当前座位不可预约|座位不可用/i], [ResultKind.RATE_LIMITED, /频繁|人数过多|稍后再试|操作过快/i], [ResultKind.SESSION_EXPIRED, /登录|会话失效|重新登录|未登录/i], [ResultKind.CONFIG_ERROR, /预约区域不存在|参数错误|房间不存在/i], [ResultKind.DEFINITIVE_FAILURE, /预约失败|提交失败|预约已结束|当前日期不可预约/i]];
function classifyResult(result = {}) { if (result.success === true) return ResultKind.SUCCESS; if (result.networkError || result.timeout || !result.hasJson) return ResultKind.AMBIGUOUS; const msg = String(result.msg ?? ''); for (const [kind, regex] of patterns) if (regex.test(msg)) return kind; return ResultKind.AMBIGUOUS; }

class ReservationEngine {
  constructor({ adapter, clock, scheduler, storage, logger, notifier = () => {}, now = () => Date.now(), lockApi = globalThis.navigator?.locks, targetDayFrameLoaderFactory = null, frameAdapterFactory = null, submitObserverFactory = null, retryScheduler = (work, delay) => setTimeout(work, delay) } = {}) {
    this.adapter = adapter; this.clock = clock; this.scheduler = scheduler; this.storage = storage; this.logger = logger; this.notifier = notifier; this.now = now; this.lockApi = lockApi; this.retryScheduler = retryScheduler; this.stateListeners = new Set();
    this.targetDayFrameLoaderFactory = targetDayFrameLoaderFactory ?? (() => new TargetDayFrameLoader({ logger: this.logger })); this.frameAdapterFactory = frameAdapterFactory ?? ((refs) => new ChaoxingSeatPageAdapter({ ...refs, logger: this.logger })); this.submitObserverFactory = submitObserverFactory ?? ((options) => new SubmitObserver(options));
    this.machine = this.createMachine(); this.settings = null; this.plan = null; this.attempts = 0; this.targetGateAttempts = 0; this.seatIndex = 0; this.inFlight = false; this.verifyTimer = null; this.leaseHeartbeatTimer = null; this.metrics = {}; this.owner = `${Math.random().toString(36).slice(2)}:${Date.now()}`; this.submissionLockHeld = false; this.targetLoader = null; this.frameAdapter = null; this.frameVm = null; this.frameObserver = null;
  }
  createMachine(initial = SeatState.IDLE) { return new SeatStateMachine(initial, (event) => { this.logger.log('info', 'STATE_CHANGED', event.to, event); for (const listener of this.stateListeners) listener(event); }); }
  subscribeState(listener) { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  transition(to, reason) { if (this.machine.state !== to) this.machine.transition(to, reason); }
  status() { return { state: this.machine.state, settings: this.settings, plan: this.plan, attempts: this.attempts, targetGateAttempts: this.targetGateAttempts, seatIndex: this.seatIndex, inFlight: this.inFlight, submissionLeaseHeld: this.submissionLockHeld, iframeActive: Boolean(this.targetLoader?.frameWindow), attemptLedger: this.plan ? this.storage.getAttempt(this.plan.targetDay) : null, metrics: this.metrics, clock: this.clock.snapshot?.() }; }
  loadSettings() { this.settings = this.storage.getSettings(); return this.settings; }
  async refreshClock() { const vm = this.adapter.getVue(); const snapshot = await this.clock.calibrate(this.adapter.location.href, 3, this.adapter.getServerTimeCandidates?.(vm) ?? []); this.logger.log('info', 'CLOCK_SYNC', this.machine.state, snapshot); return snapshot; }
  resetForNextDay(reason = 'daily rollover') { clearTimeout(this.verifyTimer); this.scheduler.stop(); this.releaseSubmissionLease(); this.destroyTargetFrame(); this.plan = null; this.attempts = 0; this.targetGateAttempts = 0; this.seatIndex = 0; this.inFlight = false; this.metrics = {}; this.owner = `${Math.random().toString(36).slice(2)}:${Date.now()}`; this.machine = this.createMachine(); this.logger.log('info', 'DAILY_CYCLE_RESET', this.machine.state, { reason }); }
  validateSettings(settings) {
    if (!settings.expectedRoomId || !Array.isArray(settings.seatPriority) || !settings.seatPriority.length || settings.seatPriority.some((seat) => !String(seat).trim())) throw new Error('目标房间或座位配置为空'); durationFor(settings.startTime, settings.endTime);
    if (!Number.isFinite(Number(settings.fireDelayMs)) || Number(settings.fireDelayMs) < 0 || Number(settings.fireDelayMs) > 5000) throw new Error('fireDelayMs 非法'); if (!Number.isInteger(Number(settings.retryPolicy?.maxTotalSubmits)) || Number(settings.retryPolicy.maxTotalSubmits) < 1) throw new Error('maxTotalSubmits 非法');
    if (!Array.isArray(settings.retryPolicy?.targetGateRetryDelaysMs) || !settings.retryPolicy.targetGateRetryDelaysMs.length || settings.retryPolicy.targetGateRetryDelaysMs.some((delay) => !Number.isFinite(Number(delay)) || Number(delay) < 0 || Number(delay) > 10_000)) throw new Error('targetGateRetryDelaysMs 非法'); if (!Number.isFinite(Number(settings.recoveryGraceMs)) || Number(settings.recoveryGraceMs) < 0 || Number(settings.recoveryGraceMs) > 10_000) throw new Error('recoveryGraceMs 非法');
  }
  async probe() {
    if (![SeatState.IDLE, SeatState.READY, SeatState.SESSION_EXPIRED, SeatState.ERROR, SeatState.STOPPED].includes(this.machine.state)) throw new Error(`当前状态不能 Probe: ${this.machine.state}`);
    this.transition(SeatState.PROBING, 'manual probe'); this.metrics.scriptStartedAt ??= this.now(); this.loadSettings(); this.validateSettings(this.settings); if (this.adapter.isSessionExpired()) { this.transition(SeatState.SESSION_EXPIRED, '登录态明显失效'); throw new Error('SESSION_EXPIRED'); }
    const vm = await this.adapter.waitForVue(); const compatible = this.adapter.assertCompatible(vm, this.settings.expectedRoomId); const targetDay = tomorrowShanghai(this.clock.now()); const target = { day: targetDay, seatNum: String(this.settings.seatPriority[0]), startTime: this.settings.startTime, endTime: this.settings.endTime, expectedRoomId: this.settings.expectedRoomId };
    durationFor(target.startTime, target.endTime); const seatCheck = this.adapter.seatExists(target.seatNum, vm); if (seatCheck?.authoritative && seatCheck.exists === false) throw new Error(`目标座位不存在: ${target.seatNum}`); if (!seatCheck?.authoritative) this.logger.log('warn', 'SEAT_SOURCE_NONAUTHORITATIVE', this.machine.state, seatCheck ?? {});
    const expectedBaseline = { reserveBeforeDay: 1, reserveBeforeTime: '22:30' }; const diagnostic = { ...compatible, targetDay, target, seatCheck, expectedBaseline }; if (Number(compatible.context.seatConfig.reserveBeforeDay) !== expectedBaseline.reserveBeforeDay || String(compatible.context.seatConfig.reserveBeforeTime) !== expectedBaseline.reserveBeforeTime) this.logger.log('warn', 'OPEN_RULE_CHANGED', this.machine.state, { expectedBaseline, actual: { reserveBeforeDay: compatible.context.seatConfig.reserveBeforeDay, reserveBeforeTime: compatible.context.seatConfig.reserveBeforeTime } });
    this.storage.write('fingerprint', compatible.fingerprint); this.logger.log('info', 'PROBE_PASS', this.machine.state, diagnostic); this.transition(SeatState.READY, 'probe pass'); return diagnostic;
  }
  async dryRun() { return this.arm('dry-run'); }
  async arm(mode = this.settings?.mode ?? 'dry-run', { recovery = false } = {}) {
    if (this.machine.state !== SeatState.READY) await this.probe(); this.settings = { ...this.settings, mode }; this.validateSettings(this.settings); const vm = this.adapter.getVue(); const clock = await this.refreshClock();
    const targetDay = tomorrowShanghai(this.clock.now()); if (this.storage.getSuccess(targetDay)) throw new Error(`该日期已有成功预约记录: ${targetDay}`); if (mode === 'live' && this.storage.getAttempt(targetDay)) throw new Error(`该日期已有提交账本记录，拒绝重复提交: ${targetDay}`);
    const { context } = this.adapter.assertCompatible(vm, this.settings.expectedRoomId); const openAt = calculateOpenAt(targetDay, context.seatConfig.reserveBeforeDay, context.seatConfig.reserveBeforeTime); this.plan = { targetDay, openAt, fireAt: openAt + Number(this.settings.fireDelayMs), context, seats: this.settings.seatPriority.map(String), mode, target: null };
    const lateMs = this.clock.now() - this.plan.fireAt; const recoveryAllowed = recovery && lateMs >= 0 && lateMs <= Number(this.settings.recoveryGraceMs);
    this.metrics.armedAt = this.clock.now(); this.metrics.targetOpenAt = openAt; this.metrics.fireDeadline = this.plan.fireAt; this.transition(SeatState.ARMED, 'armed'); this.storage.saveRuntime({ armed: true, targetDay, submittedTargetDay: null, plan: this.plan }); this.transition(SeatState.WAITING_FOR_OPEN, 'scheduler started'); this.logger.log('info', 'WAITING_FOR_OPEN', this.machine.state, { targetDay, openAt, fireAt: this.plan.fireAt, mode });
    if (lateMs >= 0) { this.logger.log('warn', 'OPEN_WINDOW_ALREADY_ACTIVE', this.machine.state, { lateMs, recoveryAllowed }); await this.fire(); } else this.scheduler.start(this.plan.fireAt); return this.status();
  }
  onScheduleTick = ({ remainingMs, visible }) => { if (!visible && remainingMs < 120_000) this.notifier('background', '请把预约页面切到前台'); };
  async runExclusive(work) { if (this.lockApi?.request) return this.lockApi.request('hebut-chaoxing-seat-submit', { mode: 'exclusive' }, work); return work(); }
  acquireSubmissionLease() { if (this.submissionLockHeld) { this.storage.tryAcquireFallbackLock(this.owner, 60_000); return; } if (!this.storage.tryAcquireFallbackLock(this.owner, 60_000)) throw new Error('另一个标签正在提交或等待核验'); this.submissionLockHeld = true; this.leaseHeartbeatTimer = setInterval(() => { if (!this.storage.renewFallbackLock(this.owner, 60_000)) this.fail(new Error('跨标签 submission lease 续租失败')); else this.logger.log('info', 'SUBMISSION_LEASE_RENEWED', this.machine.state); }, 20_000); this.leaseHeartbeatTimer.unref?.(); this.logger.log('info', 'SUBMISSION_LEASE_ACQUIRED', this.machine.state, { owner: this.owner }); }
  releaseSubmissionLease() { if (!this.submissionLockHeld) return; clearInterval(this.leaseHeartbeatTimer); this.leaseHeartbeatTimer = null; this.storage.releaseFallbackLock(this.owner); this.submissionLockHeld = false; this.logger.log('info', 'SUBMISSION_LEASE_RELEASED', this.machine.state); }
  targetGateUrl() { return replaceUrlDay(this.adapter.location.href, this.plan.targetDay); }
  destroyTargetFrame() { this.frameObserver?.restore?.(); this.frameObserver = null; this.targetLoader?.destroy?.(); this.targetLoader = null; this.frameAdapter = null; this.frameVm = null; }
  scheduleTargetGateRetry(reason) { const delays = this.settings.retryPolicy.targetGateRetryDelaysMs; if (this.targetGateAttempts >= delays.length) return this.fail(new Error('TARGET_DAY_GATE_RETRY_EXHAUSTED')); const delay = Number(delays[this.targetGateAttempts]); this.transition(SeatState.WAITING_FOR_GATE_RELEASE, reason); this.logger.log('warn', 'TARGET_GATE_CLOSED', this.machine.state, { targetDay: this.plan.targetDay, attempts: this.targetGateAttempts, delay }); this.retryScheduler(() => this.fire().catch((error) => this.fail(error)), delay); }
  async loadTargetDay() {
    this.metrics.targetGateStartedAt ??= this.clock.now(); this.metrics.target_gate_started_at ??= this.metrics.targetGateStartedAt; this.targetGateAttempts += 1; this.metrics.targetGateAttempts = this.targetGateAttempts; this.metrics.target_gate_attempts = this.targetGateAttempts; this.targetLoader ??= this.targetDayFrameLoaderFactory(); const requestedUrl = this.targetGateUrl(); const loaded = await this.targetLoader.load(requestedUrl); this.metrics.targetPageLoadMs = loaded.loadMs; this.metrics.target_page_load_ms = loaded.loadMs;
    const gate = classifyTargetGate(loaded.finalUrl, this.plan.targetDay); if (gate.gate === 'CLOSED') { this.destroyTargetFrame(); this.scheduleTargetGateRetry('target day gate closed'); return false; } if (gate.gate !== 'OPEN') { this.fail(new Error(`TARGET_DAY_GATE_UNKNOWN: ${gate.reason}`)); return false; }
    this.metrics.targetGateOpenAt = this.clock.now(); this.metrics.target_gate_open_at = this.metrics.targetGateOpenAt; this.logger.log('info', 'TARGET_GATE_OPEN', this.machine.state, { targetDay: this.plan.targetDay, finalUrl: loaded.finalUrl, attempts: this.targetGateAttempts }); const inspection = await this.targetLoader.waitForVue(); this.metrics.targetVueReadyAt = this.clock.now(); this.metrics.target_vue_ready_at = this.metrics.targetVueReadyAt; const frameWindow = this.targetLoader.frameWindow; const frameDocument = this.targetLoader.frameDocument; if (!frameWindow || !frameDocument) throw new Error('TARGET_FRAME_UNAVAILABLE');
    this.frameAdapter = this.frameAdapterFactory({ windowRef: frameWindow, documentRef: frameDocument, locationRef: frameWindow.location }); this.frameVm = this.frameAdapter.getVue(); if (!this.frameVm) throw new Error('TARGET_FRAME_VUE_MISSING'); this.assertTargetFrame(inspection, this.frameVm); this.transition(SeatState.TARGET_READY, 'target iframe ready'); this.logger.log('info', 'TARGET_READY', this.machine.state, { targetDay: this.plan.targetDay, finalUrl: inspection.finalUrl }); return true;
  }
  assertTargetFrame(inspection, vm) { if (!isSelectUrl(inspection.finalUrl) || inspection.day !== this.plan.targetDay) throw new Error('TARGET_FRAME_URL_OR_DAY_MISMATCH'); if (String(vm.chosedDay) !== this.plan.targetDay) throw new Error('TARGET_FRAME_CHOSEN_DAY_MISMATCH'); const compatible = this.frameAdapter.assertCompatible(vm, this.settings.expectedRoomId); if (!compatible.context.deptIdEnc || typeof vm.submit !== 'function') throw new Error('TARGET_FRAME_SUBMIT_CONTEXT_INVALID'); return compatible; }
  installFrameObserver() { if (this.frameObserver) return; const frameWindow = this.targetLoader?.frameWindow; if (!frameWindow) throw new Error('TARGET_FRAME_UNAVAILABLE'); this.frameObserver = this.submitObserverFactory({ windowRef: frameWindow, onDispatch: (event) => { this.metrics.submitRequestDispatchedAt = this.clock.now(); this.logger.log('info', 'IFRAME_SUBMIT_OBSERVED', this.machine.state, event); }, onResult: (result) => this.onSubmitResult(result) }); this.frameObserver.install(); }
  async prepareAndSubmitTarget() {
    const vm = this.frameVm; const compatible = this.assertTargetFrame(this.targetLoader.inspect(), vm); if (this.frameAdapter.isSessionExpired()) { this.transition(SeatState.SESSION_EXPIRED, 'target iframe session expired'); return; } const seatNum = this.plan.seats[this.seatIndex]; if (!seatNum) return this.stop('没有可用候选座位');
    const target = { day: this.plan.targetDay, seatNum, startTime: this.settings.startTime, endTime: this.settings.endTime, expectedRoomId: this.settings.expectedRoomId }; const seatCheck = this.frameAdapter.seatExists(seatNum, vm); if (seatCheck?.authoritative && seatCheck.exists === false) throw new Error(`目标座位不存在: ${seatNum}`); if (!seatCheck?.authoritative) this.logger.log('warn', 'SEAT_SOURCE_NONAUTHORITATIVE', this.machine.state, seatCheck ?? {});
    const prepared = this.frameAdapter.prepareReservation(target, vm); const selected = this.frameAdapter.getCurrentSelection(vm); if (selected.day !== target.day || String(selected.seatNum) !== String(seatNum) || selected.startTime !== target.startTime || selected.endTime !== target.endTime || selected.duration !== prepared.duration) throw new Error('TARGET_FRAME_PREPARE_RECHECK_FAILED'); this.plan.target = target; this.metrics.targetPrepareAt = this.clock.now(); this.metrics.target_prepare_at = this.metrics.targetPrepareAt; this.transition(SeatState.FIRING, 'target iframe final guard pass');
    this.logger.log('info', 'IFRAME_FINAL_GUARD_PASS', this.machine.state, { targetDay: target.day, iframeDay: selected.day, roomId: compatible.context.roomId, seatNum, startTime: target.startTime, endTime: target.endTime, duration: prepared.duration, finalUrl: this.targetLoader.inspect().finalUrl, mode: this.plan.mode });
    if (this.plan.mode !== 'live') { this.logger.log('info', 'IFRAME_DRY_RUN_WOULD_SUBMIT', this.machine.state, { targetDay: target.day, iframeDay: selected.day, roomId: compatible.context.roomId, seatNum, startTime: target.startTime, endTime: target.endTime, duration: prepared.duration, finalUrl: this.targetLoader.inspect().finalUrl }); return this.stop('dry-run complete'); }
    this.installFrameObserver(); this.acquireSubmissionLease(); this.storage.markSubmittedUnverified(this.plan.targetDay, { owner: this.owner, roomId: compatible.context.roomId, seatNum, startTime: target.startTime, endTime: target.endTime }); this.inFlight = true; this.attempts += 1; this.metrics.iframeSubmitCalledAt = this.clock.now(); this.metrics.iframe_submit_called_at = this.metrics.iframeSubmitCalledAt; this.storage.saveRuntime({ armed: true, targetDay: this.plan.targetDay, submittedTargetDay: this.plan.targetDay, plan: this.plan }); this.transition(SeatState.VERIFYING, 'official iframe vm.submit called'); this.logger.log('info', 'IFRAME_FIRE', this.machine.state, { attempt: this.attempts, seat: seatNum }); this.frameAdapter.submitOfficial(vm); this.beginVerification();
  }
  async fire() {
    if (![SeatState.WAITING_FOR_OPEN, SeatState.WAITING_FOR_GATE_RELEASE].includes(this.machine.state)) return;
    try { await this.runExclusive(async () => { const existingAttempt = this.storage.getAttempt(this.plan.targetDay); if (this.inFlight || this.storage.getSuccess(this.plan.targetDay) || (existingAttempt && existingAttempt.owner !== this.owner)) throw new Error('重复提交保护已触发'); if (this.adapter.isSessionExpired()) { this.transition(SeatState.SESSION_EXPIRED, 'parent session final guard'); return; } if (tomorrowShanghai(this.clock.now()) !== this.plan.targetDay) throw new Error('TARGET_DAY 已变化'); this.metrics.fireActual ??= this.clock.now(); this.metrics.fireLatenessMs ??= this.metrics.fireActual - this.plan.fireAt; this.transition(SeatState.LOADING_TARGET_DAY, 'load target day iframe'); if (await this.loadTargetDay()) await this.prepareAndSubmitTarget(); }); } catch (error) { this.fail(error); }
  }
  beginVerification() { clearTimeout(this.verifyTimer); const deadline = Date.now() + 15_000; const poll = () => { if (!this.inFlight || this.machine.state !== SeatState.VERIFYING) return; if (this.frameAdapter?.observeSuccess(this.plan.target, this.frameVm)) return this.finishSuccess({ source: 'iframe-vue' }); if (Date.now() >= deadline) return this.handleResult({ timeout: true }); this.verifyTimer = setTimeout(poll, 250); this.verifyTimer.unref?.(); }; poll(); }
  beginHumanObservation() { clearTimeout(this.verifyTimer); const deadline = Date.now() + 10 * 60_000; const poll = () => { if (this.machine.state !== SeatState.NEEDS_HUMAN) return; if (this.frameAdapter?.observeSuccess(this.plan.target, this.frameVm)) return this.finishSuccess({ source: 'iframe-human-vue' }); if (Date.now() >= deadline) return this.stop('human verification observation timeout'); this.verifyTimer = setTimeout(poll, 500); this.verifyTimer.unref?.(); }; poll(); }
  enterNeedsHuman(reason, message) { this.inFlight = false; this.transition(SeatState.NEEDS_HUMAN, reason); this.targetLoader?.showForHuman?.(); this.beginHumanObservation(); this.notifier('human', message); }
  onSubmitResult(result) { if ((!this.inFlight && this.machine.state !== SeatState.NEEDS_HUMAN) || ![SeatState.VERIFYING, SeatState.NEEDS_HUMAN].includes(this.machine.state)) return; this.metrics.submitResponseAt = this.clock.now(); this.metrics.submitRttMs = result.elapsedMs; this.logger.log('info', 'IFRAME_SUBMIT_RESULT', this.machine.state, result); if (this.machine.state === SeatState.NEEDS_HUMAN) { if (classifyResult(result) === ResultKind.SUCCESS || this.frameAdapter?.observeSuccess(this.plan.target, this.frameVm)) this.finishSuccess({ source: 'iframe-human-completed', result }); return; } this.handleResult(result); }
  handleResult(result) {
    clearTimeout(this.verifyTimer); const kind = classifyResult(result); this.inFlight = false; if (kind === ResultKind.SUCCESS || this.frameAdapter?.observeSuccess(this.plan.target, this.frameVm)) return this.finishSuccess({ source: kind === ResultKind.SUCCESS ? 'iframe-observer' : 'iframe-vue', result }); if (kind === ResultKind.HUMAN_VERIFICATION_REQUIRED) return this.enterNeedsHuman('human verification', '超星预约需要人工验证，请立即处理。');
    if (kind === ResultKind.SESSION_EXPIRED) { this.transition(SeatState.SESSION_EXPIRED, 'iframe submission session expired'); this.releaseSubmissionLease(); this.destroyTargetFrame(); this.notifier('error', '学习通登录态失效'); return; }
    if (kind === ResultKind.GATE_NOT_OPEN && this.attempts < this.settings.retryPolicy.maxTotalSubmits) { this.destroyTargetFrame(); this.transition(SeatState.WAITING_FOR_GATE_RELEASE, 'iframe submit reported gate closed'); this.retryScheduler(() => this.fire().catch((error) => this.fail(error)), 0); return; }
    if (kind === ResultKind.SEAT_CONFLICT && this.settings.retryPolicy.allowSeatFallback && this.seatIndex + 1 < this.plan.seats.length && this.attempts < this.settings.retryPolicy.maxTotalSubmits) { this.seatIndex += 1; this.destroyTargetFrame(); this.transition(SeatState.WAITING_FOR_GATE_RELEASE, 'verified seat conflict'); this.logger.log('warn', 'SEAT_CONFLICT', this.machine.state, { nextSeat: this.plan.seats[this.seatIndex] }); this.retryScheduler(() => this.fire().catch((error) => this.fail(error)), 0); return; }
    if (kind === ResultKind.AMBIGUOUS) return this.enterNeedsHuman('ambiguous response; no fallback', '预约结果不明确，请立即在页面确认，脚本不会换座重试。'); if (kind === ResultKind.DEFINITIVE_FAILURE) { this.storage.clearAttemptForDefinitiveFailure(this.plan.targetDay, { kind }); this.logger.log('warn', 'ATTEMPT_CLEARED_DEFINITIVE_FAILURE', this.machine.state, { targetDay: this.plan.targetDay, kind }); } this.fail(new Error(`提交失败: ${kind}`));
  }
  finishSuccess(details = {}) { if (this.machine.state === SeatState.SUCCESS) return; this.inFlight = false; clearTimeout(this.verifyTimer); this.scheduler.stop(); this.transition(SeatState.SUCCESS, 'success confirmed'); this.metrics.successConfirmedAt = this.clock.now(); this.metrics.totalAttempts = this.attempts; this.metrics.seatUsed = this.plan.target?.seatNum; this.storage.markSuccess(this.plan.targetDay, { target: this.plan.target, details }); this.storage.markAttemptSuccess(this.plan.targetDay, this.plan.target); this.storage.saveRuntime({ armed: false, targetDay: this.plan.targetDay, submittedTargetDay: this.plan.targetDay }); this.releaseSubmissionLease(); this.destroyTargetFrame(); this.logger.log('info', 'SUCCESS', this.machine.state, { ...details, timing: this.metrics }); this.logger.log('info', 'TIMING_BENCHMARK', this.machine.state, this.metrics); this.notifier('success', '座位预约已确认成功'); }
  stop(reason = 'manual stop') { clearTimeout(this.verifyTimer); this.scheduler.stop(); this.inFlight = false; this.releaseSubmissionLease(); this.destroyTargetFrame(); if (this.machine.state !== SeatState.SUCCESS && this.machine.state !== SeatState.STOPPED) this.transition(SeatState.STOPPED, reason); this.storage.saveRuntime({ armed: false, targetDay: this.plan?.targetDay ?? null }); this.logger.log('warn', 'STOPPED', this.machine.state, { reason }); }
  fail(error) { clearTimeout(this.verifyTimer); this.scheduler.stop(); this.inFlight = false; this.releaseSubmissionLease(); this.destroyTargetFrame(); if (this.machine.state !== SeatState.ERROR) this.transition(SeatState.ERROR, error.message); this.logger.log('error', 'ERROR', this.machine.state, { message: error.message }); this.notifier('error', error.message); }
  async resumeIfArmed() { const runtime = this.storage.getRuntime(); if (!runtime?.armed || runtime.submittedTargetDay === runtime.targetDay || runtime.targetDay !== tomorrowShanghai(this.clock.now())) return false; if (this.storage.getAttempt(runtime.targetDay)) { this.logger.log('warn', 'RECOVERY_BLOCKED_ATTEMPT_LEDGER', this.machine.state, { targetDay: runtime.targetDay }); this.stop('submitted unverified ledger'); return false; } this.logger.log('info', 'ARMED_RESTORE', this.machine.state, { targetDay: runtime.targetDay }); await this.arm(runtime.plan?.mode ?? this.storage.getSettings().mode, { recovery: true }); return true; }
  resetForDate(day) { this.storage.remove(`success:${day}`); }
  resetAttemptForDate(day) { this.storage.resetAttemptForDate(day); }
  enableNotifications() { return this.notifier.enable?.() ?? Promise.resolve({ supported: false }); }
}




const ACTIVE_STATES = new Set([SeatState.ARMED, SeatState.WAITING_FOR_OPEN, SeatState.WAITING_FOR_GATE_RELEASE, SeatState.LOADING_TARGET_DAY, SeatState.TARGET_READY, SeatState.FIRING, SeatState.VERIFYING, SeatState.NEEDS_HUMAN]);

// 长期生命周期只编排每天的单轮 Engine；所有提交、账本和租约仍由 Engine 严格把关。
class DailyReservationController {
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



class SeatHelperPanel {
  constructor({ engine, storage, logger, controller = null, documentRef = document } = {}) { this.engine = engine; this.storage = storage; this.logger = logger; this.controller = controller; this.document = documentRef; this.root = null; this.timer = null; }
  mount() {
    if (this.root) return this.root; const host = this.document.createElement('section'); host.id = 'hebut-seat-helper-panel'; host.innerHTML = `
      <style>#hebut-seat-helper-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:305px;color:#e5e7eb;background:#111827;border:1px solid #374151;border-radius:10px;box-shadow:0 12px 32px #0008;font:12px/1.45 system-ui,sans-serif}#hebut-seat-helper-panel *{box-sizing:border-box}#hebut-seat-helper-panel header{padding:10px 12px;font-weight:700;border-bottom:1px solid #374151}#hebut-seat-helper-panel main{padding:10px 12px;display:grid;gap:7px}#hebut-seat-helper-panel .grid{display:grid;grid-template-columns:90px 1fr;gap:4px 8px}#hebut-seat-helper-panel .live{color:#fecaca;font-weight:700}#hebut-seat-helper-panel .dry{color:#bbf7d0;font-weight:700}#hebut-seat-helper-panel input,#hebut-seat-helper-panel select{width:100%;background:#1f2937;color:#fff;border:1px solid #4b5563;border-radius:4px;padding:4px}#hebut-seat-helper-panel button{cursor:pointer;background:#374151;color:#fff;border:1px solid #6b7280;border-radius:5px;padding:6px}#hebut-seat-helper-panel button:hover{background:#4b5563}#hebut-seat-helper-panel .buttons{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}#hebut-seat-helper-panel .settings{border-top:1px solid #374151;padding-top:8px}</style>
      <header>HEBUT Seat Helper</header><main><div id="hsh-status"></div><div class="grid" id="hsh-details"></div><div class="buttons"><button data-action="reconcile">立即检查</button><button data-action="dry">Dry Run</button><button data-action="arm">手动预约明天</button><button data-action="stop">停止自动预约</button><button data-action="log">下载日志</button><button data-action="notify">启用通知</button></div><div class="settings"><strong>设置</strong><div class="grid"><label>座位优先级</label><input data-setting="seatPriority" placeholder="216,215"><label>开始时间</label><input data-setting="startTime" placeholder="08:00"><label>结束时间</label><input data-setting="endTime" placeholder="22:00"><label>延迟 ms</label><input data-setting="fireDelayMs" type="number"><label>模式</label><select data-setting="mode"><option value="dry-run">DRY RUN</option><option value="live">LIVE</option></select><label>自动预约</label><input data-setting="autoArm" type="checkbox"></div><button data-action="save">保存设置</button></div></main>`;
    this.document.body.append(host); this.root = host; host.addEventListener('click', (event) => this.action(event)); this.render(); this.timer = setInterval(() => this.render(), 200); return host;
  }
  getInput(name) { return this.root.querySelector(`[data-setting="${name}"]`); }
  saveSettings() { const current = this.storage.getSettings(); const settings = { ...current, seatPriority: this.getInput('seatPriority').value.split(',').map((item) => item.trim()).filter(Boolean), startTime: this.getInput('startTime').value.trim(), endTime: this.getInput('endTime').value.trim(), fireDelayMs: Number(this.getInput('fireDelayMs').value), mode: this.getInput('mode').value, autoArm: this.getInput('autoArm').checked }; this.storage.saveSettings(settings); this.engine.settings = settings; if (settings.autoArm) this.controller?.start(); else this.controller?.stop('config disabled'); this.logger.log('info', 'CONFIG_SAVED', this.engine.machine.state, { ...settings }); this.render(); }
  async action(event) { const action = event.target.dataset.action; if (!action) return; try { if (action === 'reconcile') await this.controller?.reconcile('manual', { resyncClock: true }); if (action === 'dry') await this.engine.dryRun(); if (action === 'arm') await this.engine.arm(this.storage.getSettings().mode); if (action === 'stop') { this.storage.saveSettings({ ...this.storage.getSettings(), autoArm: false }); this.controller?.stop('manual'); this.engine.stop(action); } if (action === 'log') this.logger.download(); if (action === 'notify') await this.engine.enableNotifications(); if (action === 'save') this.saveSettings(); } catch (error) { this.engine.fail(error); } this.render(); }
  render() {
    if (!this.root) return; const status = this.engine.status(); const settings = this.storage.getSettings(); const plan = status.plan; const clock = status.clock ?? {}; const remaining = plan ? Math.max(0, plan.fireAt - (this.engine.clock.now?.() ?? Date.now())) : null;
    const uncertain = clock.source === 'LOCAL_FALLBACK' || clock.uncertaintyMs === null || Number(clock.uncertaintyMs) > Number(settings.fireDelayMs); const human = status.state === 'NEEDS_HUMAN' ? ' <span class="live">需要人工验证：请在目标页 iframe 中完成官方验证</span>' : ''; const daily = this.controller?.status?.() ?? {}; const targetDay = plan?.targetDay ?? daily.lastTargetDay ?? '—'; const latestSuccess = this.storage.getLatestSuccess?.(); const targetSuccess = this.storage.getSuccess(targetDay); this.root.querySelector('#hsh-status').innerHTML = `<strong>状态：</strong>${status.state} &nbsp; <span class="${settings.mode === 'live' ? 'live' : 'dry'}">${settings.mode === 'live' ? 'LIVE — 自动预约会真实提交' : 'DRY RUN — 不会调用 vm.submit()'}</span>${uncertain ? ' <span class="live">TIME UNCERTAIN</span>' : ''}${human}`;
    this.root.querySelector('#hsh-details').innerHTML = `<span>自动预约</span><span>${settings.autoArm ? '开启' : '关闭'}</span><span>当前日期</span><span>${formatShanghaiDay(this.engine.clock.now?.() ?? Date.now())}</span><span>当前房间</span><span>${plan?.context?.roomName || '—'}</span><span>roomId</span><span>${plan?.context?.roomId ?? settings.expectedRoomId}</span><span>目标日期</span><span>${targetDay}</span><span>目标座位</span><span>${settings.seatPriority.join(', ')}</span><span>预约时段</span><span>${settings.startTime} - ${settings.endTime}</span><span>学校开放</span><span>提前 ${plan?.context?.seatConfig?.reserveBeforeDay ?? '—'} 天 / ${plan?.context?.seatConfig?.reserveBeforeTime ?? '—'}</span><span>下一次动作</span><span>${daily.nextCheckAt ? new Date(daily.nextCheckAt).toLocaleTimeString() : (remaining === null ? '—' : (remaining / 1000).toFixed(3) + ' s')}</span><span>明天已成功</span><span>${targetSuccess ? '是' : '否'}</span><span>时间源</span><span>${clock.source ?? '—'} ${clock.offsetMs ?? ''}ms / ±${clock.uncertaintyMs ?? '—'}ms${uncertain ? ' TIME UNCERTAIN' : ''}</span><span>页面</span><span>${this.document.visibilityState === 'hidden' ? 'HIDDEN' : 'VISIBLE'}</span><span>最近成功</span><span>${latestSuccess?.day ?? '—'}</span>`;
    for (const [key, value] of Object.entries({ seatPriority: settings.seatPriority.join(','), startTime: settings.startTime, endTime: settings.endTime, fireDelayMs: settings.fireDelayMs, mode: settings.mode })) { const input = this.getInput(key); if (input && this.document.activeElement !== input) input.value = value; } this.getInput('autoArm').checked = Boolean(settings.autoArm);
  }
  destroy() { clearInterval(this.timer); this.root?.remove(); this.root = null; }
}













function createNotifier(logger) {
  let audio = null; const notify = (kind, message) => { logger.log(kind === 'error' ? 'error' : 'warn', 'NOTIFICATION', 'NOTIFY', { kind, message }); try { if (Notification.permission === 'granted') new Notification('HEBUT Seat Helper', { body: message }); } catch {} try { const AudioCtx = window.AudioContext || window.webkitAudioContext; audio ??= new AudioCtx(); const oscillator = audio.createOscillator(); oscillator.frequency.value = kind === 'success' ? 880 : 440; oscillator.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.16); } catch {} }; notify.enable = async () => { let permission = 'unsupported'; try { permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission; } catch {} try { const AudioCtx = window.AudioContext || window.webkitAudioContext; audio ??= new AudioCtx(); await audio.resume?.(); } catch {} logger.log('info', 'NOTIFICATIONS_ENABLED', 'READY', { permission }); return { supported: permission !== 'unsupported', permission }; }; return notify;
}
function weekdayAllowed(days, targetDay) { return days.includes(weekdayForShanghaiDay(targetDay)); }
function shouldBoot(windowRef) {
  return Boolean(windowRef && windowRef.top === windowRef.self && /office\.chaoxing\.com$/i.test(windowRef.location.hostname) && /\/front\/third\/apps\/seat\/select/i.test(windowRef.location.pathname));
}

function iframeReport(inspection, { ok = false, error = null, extra = {} } = {}) {
  return {
    ok,
    requestedUrl: inspection.requestedUrl,
    finalUrl: inspection.finalUrl,
    loadMs: inspection.loadMs,
    sameOriginAccessible: inspection.sameOriginAccessible,
    pathname: inspection.pathname,
    day: inspection.day,
    orderElementFound: inspection.orderElementFound,
    vueFound: inspection.vueFound,
    submitIsFunction: inspection.submitIsFunction,
    chosedDay: inspection.chosedDay,
    roomId: inspection.roomId,
    deptIdEnc: inspection.deptIdEnc,
    roomName: inspection.roomName,
    seatConfig: inspection.seatConfig,
    error: error ?? inspection.error,
    ...extra
  };
}

function boot() {
  if (window.HEBUT_SEAT) return window.HEBUT_SEAT; const logger = new EventLogger(); const storage = new SeatStorage(); const adapter = new ChaoxingSeatPageAdapter({ logger }); const clock = new ServerClock(); let engine; let dailyController;
  const scheduler = new OpenScheduler({ clock, onTick: (tick) => engine?.onScheduleTick(tick), onFire: () => engine?.fire().catch((error) => engine.fail(error)), onBackground: () => engine?.notifier('background', '请把预约页面切到前台'), onWake: () => dailyController?.reconcile('scheduler wake', { resyncClock: true }) });
  const notifier = createNotifier(logger); engine = new ReservationEngine({ adapter, clock, scheduler, storage, logger, notifier }); dailyController = new DailyReservationController({ engine, storage, clock, logger }); const panel = new SeatHelperPanel({ engine, storage, logger, controller: dailyController });
  const testIframeLoader = async () => {
    const loader = new TargetDayFrameLoader({ logger });
    logger.log('info', 'IFRAME_TEST_START', 'DEBUG', { requestedUrl: window.location.href, mode: 'CURRENT_PAGE' });
    try {
      const loaded = await loader.load(window.location.href);
      const inspection = await loader.waitForVue();
      const report = iframeReport(inspection, { ok: inspection.vueFound && inspection.submitIsFunction });
      logger.log(report.ok ? 'info' : 'warn', report.ok ? 'IFRAME_TEST_PASS' : 'IFRAME_TEST_FAIL', 'DEBUG', { finalUrl: loaded.finalUrl, error: report.error });
      return report;
    } catch (error) {
      const inspection = loader.inspect();
      const report = iframeReport(inspection, { error: String(error?.message ?? error) });
      logger.log('error', 'IFRAME_TEST_FAIL', 'DEBUG', { requestedUrl: report.requestedUrl, error: report.error });
      return report;
    } finally { loader.destroy(); }
  };
  const testTargetDayGate = async () => {
    const targetDay = tomorrowShanghai(clock.now());
    let requestedUrl;
    try { requestedUrl = replaceUrlDay(window.location.href, targetDay); } catch (error) { return { ok: false, gate: 'UNKNOWN', targetDay, error: String(error?.message ?? error) }; }
    const loader = new TargetDayFrameLoader({ logger });
    logger.log('info', 'IFRAME_TEST_START', 'DEBUG', { requestedUrl, mode: 'TARGET_DAY_GATE', targetDay });
    try {
      const loaded = await loader.load(requestedUrl);
      const gate = classifyTargetGate(loaded.finalUrl, targetDay);
      if (gate.gate === 'CLOSED') {
        logger.log('warn', 'TARGET_GATE_CLOSED', 'DEBUG', { targetDay, finalUrl: loaded.finalUrl, reason: gate.reason });
        return iframeReport(loaded, { ok: true, extra: { targetDay, ...gate } });
      }
      if (gate.gate !== 'OPEN') {
        logger.log('error', 'IFRAME_TEST_FAIL', 'DEBUG', { targetDay, finalUrl: loaded.finalUrl, reason: gate.reason });
        return iframeReport(loaded, { error: gate.reason, extra: { targetDay, ...gate } });
      }
      logger.log('info', 'TARGET_GATE_OPEN', 'DEBUG', { targetDay, finalUrl: loaded.finalUrl });
      const inspection = await loader.waitForVue();
      const ok = inspection.vueFound && inspection.submitIsFunction && inspection.day === targetDay;
      const report = iframeReport(inspection, { ok, error: ok ? null : 'IFRAME_VUE_OR_TARGET_DAY_INCOMPATIBLE', extra: { targetDay, ...gate } });
      logger.log(ok ? 'info' : 'error', ok ? 'IFRAME_TEST_PASS' : 'IFRAME_TEST_FAIL', 'DEBUG', { targetDay, finalUrl: report.finalUrl, error: report.error });
      return report;
    } catch (error) {
      const inspection = loader.inspect();
      const report = iframeReport(inspection, { error: String(error?.message ?? error), extra: { targetDay, gate: 'UNKNOWN' } });
      logger.log('error', 'IFRAME_TEST_FAIL', 'DEBUG', { targetDay, requestedUrl, error: report.error });
      return report;
    } finally { loader.destroy(); }
  };
  const api = window.HEBUT_SEAT = { probe: () => engine.probe(), dryRun: () => engine.dryRun(), arm: () => engine.arm(storage.getSettings().mode), disarm: () => { storage.saveSettings({ ...storage.getSettings(), autoArm: false }); dailyController.stop('disarm'); engine.stop('disarm'); }, stop: () => { storage.saveSettings({ ...storage.getSettings(), autoArm: false }); dailyController.stop('manual'); engine.stop('manual'); }, status: () => ({ ...engine.status(), daily: dailyController.status() }), reconcile: () => dailyController.reconcile('manual', { resyncClock: true }), enableNotifications: () => engine.enableNotifications(), downloadLog: () => logger.download(), config: (value) => { if (value) { storage.saveSettings({ ...storage.getSettings(), ...value }); if (storage.getSettings().autoArm) dailyController.start(); else dailyController.stop('config disabled'); } return storage.getSettings(); }, resetForDate: (day) => engine.resetForDate(day), resetAttemptForDate: (day) => engine.resetAttemptForDate(day), debug: { shadowSubmitProbe: () => createShadowSubmitProbe({ onObserved: (item) => logger.log('info', 'SHADOW_SUBMIT_OBSERVED', engine.machine.state, item) }), testIframeLoader, testTargetDayGate } };
  panel.mount();
  const diagnostics = new DiagnosticPanel({ collector: new DiagnosticCollector() });
  diagnostics.mount(panel.root.querySelector('main'));
  api.downloadDiagnose = () => diagnostics.showPreview();
  api.previewReadonlyDiagnostics = () => diagnostics.showPreview();
  logger.log('info', 'READY', engine.machine.state, { api: 'window.HEBUT_SEAT', settings: storage.getSettings() });
  const settings = storage.getSettings(); (async () => { try { if (settings.autoArm) dailyController.start(); else await engine.resumeIfArmed(); } catch (error) { engine.fail(error); } })();
  return api;
}
function shouldBootDiagnostics(windowRef) {
  return Boolean(windowRef && windowRef.top === windowRef.self && windowRef.location.hostname === 'office.chaoxing.com'
    && /^\/front\/(?:third\/apps\/seat|apps\/seatengine)\/(?:index|select|code)$/.test(windowRef.location.pathname));
}
function bootTopWindowOnly() {
  // @noframes 失效时仍在运行时阻止 iframe 内 Userscript 启动。
  if (window.top !== window.self) return;
  if (shouldBoot(window)) boot();
  else if (shouldBootDiagnostics(window) && !window.HEBUT_SEAT_DIAGNOSTICS) {
    const panel = new DiagnosticPanel({ collector: new DiagnosticCollector() });
    panel.mount(); window.HEBUT_SEAT_DIAGNOSTICS = { preview: () => panel.showPreview(), disable: () => panel.destroy() };
  }
}
if (typeof window !== 'undefined') bootTopWindowOnly();

})();
