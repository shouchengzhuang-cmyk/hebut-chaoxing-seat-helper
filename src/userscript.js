import { ChaoxingSeatPageAdapter } from './page-adapter.js';
import { ServerClock, tomorrowShanghai, weekdayForShanghaiDay } from './clock.js';
import { OpenScheduler } from './scheduler.js';
import { SubmitObserver, createShadowSubmitProbe } from './submit-observer.js';
import { SeatStorage } from './storage.js';
import { EventLogger } from './logger.js';
import { ReservationEngine } from './core.js';
import { DailyReservationController } from './daily-controller.js';
import { SeatHelperPanel } from './ui.js';
import { TargetDayFrameLoader, replaceUrlDay, classifyTargetGate } from './target-day-frame-loader.js';

function createNotifier(logger) {
  let audio = null; const notify = (kind, message) => { logger.log(kind === 'error' ? 'error' : 'warn', 'NOTIFICATION', 'NOTIFY', { kind, message }); try { if (Notification.permission === 'granted') new Notification('HEBUT Seat Helper', { body: message }); } catch {} try { const AudioCtx = window.AudioContext || window.webkitAudioContext; audio ??= new AudioCtx(); const oscillator = audio.createOscillator(); oscillator.frequency.value = kind === 'success' ? 880 : 440; oscillator.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.16); } catch {} }; notify.enable = async () => { let permission = 'unsupported'; try { permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission; } catch {} try { const AudioCtx = window.AudioContext || window.webkitAudioContext; audio ??= new AudioCtx(); await audio.resume?.(); } catch {} logger.log('info', 'NOTIFICATIONS_ENABLED', 'READY', { permission }); return { supported: permission !== 'unsupported', permission }; }; return notify;
}
export function weekdayAllowed(days, targetDay) { return days.includes(weekdayForShanghaiDay(targetDay)); }
export function shouldBoot(windowRef) {
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
  const api = window.HEBUT_SEAT = { probe: () => engine.probe(), dryRun: () => engine.dryRun(), arm: () => engine.arm(storage.getSettings().mode), disarm: () => { storage.saveSettings({ ...storage.getSettings(), autoArm: false }); dailyController.stop('disarm'); engine.stop('disarm'); }, stop: () => { storage.saveSettings({ ...storage.getSettings(), autoArm: false }); dailyController.stop('manual'); engine.stop('manual'); }, status: () => ({ ...engine.status(), daily: dailyController.status() }), reconcile: () => dailyController.reconcile('manual', { resyncClock: true }), enableNotifications: () => engine.enableNotifications(), downloadLog: () => logger.download(), downloadDiagnose: () => logger.download(`hebut-seat-diagnose-${Date.now()}.json`), config: (value) => { if (value) { storage.saveSettings({ ...storage.getSettings(), ...value }); if (storage.getSettings().autoArm) dailyController.start(); else dailyController.stop('config disabled'); } return storage.getSettings(); }, resetForDate: (day) => engine.resetForDate(day), resetAttemptForDate: (day) => engine.resetAttemptForDate(day), debug: { shadowSubmitProbe: () => createShadowSubmitProbe({ onObserved: (item) => logger.log('info', 'SHADOW_SUBMIT_OBSERVED', engine.machine.state, item) }), testIframeLoader, testTargetDayGate } };
  panel.mount(); logger.log('info', 'READY', engine.machine.state, { api: 'window.HEBUT_SEAT', settings: storage.getSettings() });
  const settings = storage.getSettings(); (async () => { try { if (settings.autoArm) dailyController.start(); else await engine.resumeIfArmed(); } catch (error) { engine.fail(error); } })();
  return api;
}
function bootTopWindowOnly() {
  // @noframes 失效时仍在运行时阻止 iframe 内 Userscript 启动。
  if (window.top !== window.self) return;
  if (shouldBoot(window)) boot();
}
if (typeof window !== 'undefined') bootTopWindowOnly();
