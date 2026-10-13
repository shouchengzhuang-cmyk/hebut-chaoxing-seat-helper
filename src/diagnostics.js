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
export class DiagnosticSanitizer {
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
export class DiagnosticCollector {
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
export class DiagnosticPanel {
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
