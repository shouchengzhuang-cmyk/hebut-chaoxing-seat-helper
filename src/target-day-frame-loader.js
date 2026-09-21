export function replaceUrlDay(href, day) { const url = new URL(href); url.searchParams.set('day', day); return url.href; }
export function isSelectUrl(href) { try { return new URL(href).pathname === '/front/third/apps/seat/select'; } catch { return false; } }
export function isReserveErrorUrl(href) { try { return /^\/front\/apps\/reserve\/error\//.test(new URL(href).pathname); } catch { return false; } }
export function classifyTargetGate(finalUrl, requestedDay) {
  if (isReserveErrorUrl(finalUrl)) return { gate: 'CLOSED', reason: 'SERVER_REDIRECT_TO_RESERVE_ERROR' };
  try { const url = new URL(finalUrl); if (isSelectUrl(finalUrl) && url.searchParams.get('day') === requestedDay) return { gate: 'OPEN', reason: 'SELECT_PAGE_FOR_TARGET_DAY' }; } catch { /* handled as unknown */ }
  return { gate: 'UNKNOWN', reason: 'UNEXPECTED_FINAL_URL' };
}

export class TargetDayFrameLoader {
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
