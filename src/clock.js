const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function parseClockTime(value, withSeconds = false) {
  const pattern = withSeconds ? /^(\d{2}):(\d{2}):(\d{2})$/ : /^(\d{2}):(\d{2})$/;
  const match = pattern.exec(String(value)); if (!match) throw new Error(`Invalid time: ${value}`);
  const [hour, minute, second = '0'] = match.slice(1).map(Number);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`Invalid time: ${value}`);
  return { hour, minute, second };
}
export function shanghaiParts(epochMs = Date.now()) {
  const date = new Date(epochMs + SHANGHAI_OFFSET_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}
export function formatShanghaiDay(epochMs = Date.now()) {
  const { year, month, day } = shanghaiParts(epochMs); return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function tomorrowShanghai(epochMs = Date.now()) { return addShanghaiDays(formatShanghaiDay(epochMs), 1); }
export function parseShanghaiDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day)); if (!match) throw new Error(`Invalid Shanghai day: ${day}`);
  const [year, month, date] = match.slice(1).map(Number); const probe = new Date(Date.UTC(year, month - 1, date));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== date) throw new Error(`Invalid Shanghai day: ${day}`);
  return { year, month, date };
}
export function shanghaiEpoch(day, time = '00:00:00') {
  const { year, month, date } = parseShanghaiDay(day); const { hour, minute, second } = parseClockTime(time.length === 5 ? `${time}:00` : time, true);
  return Date.UTC(year, month - 1, date, hour, minute, second) - SHANGHAI_OFFSET_MS;
}
export function addShanghaiDays(day, days) { return formatShanghaiDay(shanghaiEpoch(day) + days * 24 * 60 * 60 * 1000); }
export function weekdayForShanghaiDay(day) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(shanghaiEpoch(day) + SHANGHAI_OFFSET_MS).getUTCDay()]; }
export function calculateOpenAt(targetDay, reserveBeforeDay, reserveBeforeTime) {
  const before = Number(reserveBeforeDay); if (!Number.isInteger(before) || before < 0 || before > 31) throw new Error('Invalid reserveBeforeDay');
  parseClockTime(reserveBeforeTime);
  return shanghaiEpoch(addShanghaiDays(targetDay, -before), reserveBeforeTime);
}
export function durationFor(startTime, endTime) {
  const start = parseClockTime(startTime); const end = parseClockTime(endTime); const minutes = (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute);
  if (minutes <= 0) throw new Error('预约结束时间必须晚于开始时间'); return { minutes, duration: (minutes / 60).toFixed(2) };
}

export class ServerClock {
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
