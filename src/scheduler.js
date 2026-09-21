export class OpenScheduler {
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
