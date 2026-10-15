const SENSITIVE_KEY = /cookie|password|token|captcha|authorization|wyToken|enc|session|^uid$|reserveId|rawStatus|^msg$|headers|responseText/i;
const SENSITIVE_TEXT = /(cookie|password|token|captcha|authorization|wyToken|enc|session)\s*[:=]\s*[^,\s&}]+/gi;

export function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(/https:\/\/[^\s"'<>]+/g, (text) => { try { const url = new URL(text); return url.origin + url.pathname; } catch { return '[URL]'; } }).replace(SENSITIVE_TEXT, '$1=[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}

export class EventLogger {
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
