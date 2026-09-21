const SUBMIT_PATH = /\/data\/apps\/seat\/submit(?:$|[?#])/;
function isSubmitUrl(url, base) { try { return SUBMIT_PATH.test(new URL(url, base).pathname); } catch { return false; } }
function resultBody(xhr) {
  try { const json = typeof xhr.response === 'object' ? xhr.response : JSON.parse(xhr.responseText); return { success: json?.success === true, msg: String(json?.msg ?? json?.message ?? ''), hasJson: Boolean(json) }; } catch { return { success: false, msg: '', hasJson: false }; }
}

export class SubmitObserver {
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
export function createShadowSubmitProbe({ windowRef = window, onObserved = () => {} } = {}) {
  const proto = windowRef.XMLHttpRequest?.prototype; if (!proto) throw new Error('XMLHttpRequest 不可用'); const originalOpen = proto.open; const originalSend = proto.send; const meta = new WeakMap(); let active = true;
  proto.open = function shadowOpen(method, url, ...rest) { meta.set(this, { method, url, submit: isSubmitUrl(url, windowRef.location?.href) }); return originalOpen.call(this, method, url, ...rest); };
  proto.send = function shadowSend(...args) { const item = meta.get(this); if (active && item?.submit) { onObserved({ method: item.method, pathname: new URL(item.url, windowRef.location.href).pathname, parameterNamesOnly: true }); return undefined; } return originalSend.apply(this, args); };
  return { restore() { active = false; proto.open = originalOpen; proto.send = originalSend; } };
}
