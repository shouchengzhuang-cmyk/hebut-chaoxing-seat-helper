export const DEFAULT_SETTINGS = Object.freeze({
  expectedRoomId: '3747', seatPriority: ['216'], startTime: '08:30', endTime: '22:00', fireDelayMs: 100,
  mode: 'dry-run', retryPolicy: { maxTotalSubmits: 4, gateRetryDelaysMs: [180, 260, 400], targetGateRetryDelaysMs: [0, 180, 260, 400, 650, 900], allowSeatFallback: true },
  autoArm: false, daysOfWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], notifications: true, recoveryGraceMs: 3000
});

export class SeatStorage {
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
