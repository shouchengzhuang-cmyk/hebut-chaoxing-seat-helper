import { ReservationEngine } from '../src/core.js';
import { SeatStorage } from '../src/storage.js';
import { EventLogger } from '../src/logger.js';
import { shanghaiEpoch } from '../src/clock.js';

export class MemoryStore { constructor() { this.data = new Map(); } getItem(k) { return this.data.get(k) ?? null; } setItem(k, v) { this.data.set(k, v); } removeItem(k) { this.data.delete(k); } }

export function makeTargetEngine({ mode = 'live', gates = ['OPEN'], shared = new MemoryStore(), clockNow = shanghaiEpoch('2026-09-20', '22:00'), notifier = () => {} } = {}) {
  let parentSubmitCalls = 0; let iframeSubmitCalls = 0; let loaderCreations = 0; const scheduled = []; const observerInstances = [];
  const parentVm = { submit() { parentSubmitCalls += 1; } };
  const settings = { expectedRoomId: '3747', seatPriority: ['216', '215'], startTime: '08:00', endTime: '22:00', fireDelayMs: 100, mode, retryPolicy: { maxTotalSubmits: 4, gateRetryDelaysMs: [1, 1, 1], targetGateRetryDelaysMs: [0, 1, 1, 1, 1, 1], allowSeatFallback: true }, autoArm: false, notifications: false, recoveryGraceMs: 3000 };
  const context = { roomId: '3747', deptIdEnc: 'dept', seatConfig: { reserveBeforeDay: 1, reserveBeforeTime: '22:30', reserveDuration: 0 } };
  const adapter = { location: { href: 'https://office.chaoxing.com/front/third/apps/seat/select?id=3747&deptIdEnc=dept&day=2026-09-20' }, isSessionExpired: () => false, waitForVue: async () => parentVm, getVue: () => parentVm, getServerTimeCandidates: () => [], assertCompatible: () => ({ context, fingerprint: {} }), seatExists: () => ({ exists: null, authoritative: false, source: null }) };
  let currentLoader = null;
  const targetDayFrom = (url) => new URL(url).searchParams.get('day');
  const targetDayFrameLoaderFactory = () => {
    const gate = gates[Math.min(loaderCreations, gates.length - 1)] ?? 'OPEN'; loaderCreations += 1; let destroyed = false; let shown = false; let inspection = null; let frameVm = null;
    const loader = {
      frameWindow: { location: { href: '' } }, frameDocument: {}, get shown() { return shown; }, get destroyed() { return destroyed; },
      async load(requestedUrl) {
        const day = targetDayFrom(requestedUrl); const finalUrl = gate === 'CLOSED' ? 'https://office.chaoxing.com/front/apps/reserve/error/closed' : gate === 'UNKNOWN' ? 'https://office.chaoxing.com/front/third/apps/seat/other?day=' + day : requestedUrl;
        this.frameWindow.location.href = finalUrl; frameVm = { chosedDay: day, chosedSeatNum: '', chosedTimeInfo: { startTime: '', endTime: '', duration: '' }, seatConfig: context.seatConfig, submitsuccess: false, submit() { iframeSubmitCalls += 1; } };
        inspection = { requestedUrl, finalUrl, loadMs: 280, sameOriginAccessible: true, pathname: new URL(finalUrl).pathname, day: new URL(finalUrl).searchParams.get('day'), orderElementFound: gate === 'OPEN', vueFound: gate === 'OPEN', submitIsFunction: gate === 'OPEN', chosedDay: frameVm.chosedDay, roomId: '3747', deptIdEnc: 'dept', roomName: '图书馆', seatConfig: context.seatConfig, error: null };
        return inspection;
      },
      async waitForVue() { if (gate === 'VUE_TIMEOUT') throw new Error('IFRAME_VUE_TIMEOUT'); return inspection; }, inspect() { return inspection; }, showForHuman() { shown = true; }, hide() { shown = false; }, destroy() { destroyed = true; }
    };
    currentLoader = loader; return loader;
  };
  const frameAdapterFactory = ({ windowRef }) => ({
    location: windowRef.location, getVue: () => currentLoader ? currentLoader._vm ?? null : null,
    isSessionExpired: () => false,
    assertCompatible: (vm) => { if (!vm) throw new Error('TARGET_FRAME_VUE_MISSING'); return { context, fingerprint: {} }; },
    seatExists: () => ({ exists: null, authoritative: false, source: null }),
    prepareReservation(target, vm) { vm.chosedDay = target.day; vm.chosedSeatNum = target.seatNum; vm.chosedTimeInfo.startTime = target.startTime; vm.chosedTimeInfo.endTime = target.endTime; vm.chosedTimeInfo.duration = '14.00'; return { day: target.day, seatNum: target.seatNum, startTime: target.startTime, endTime: target.endTime, duration: '14.00', minutes: 840 }; },
    getCurrentSelection: (vm) => ({ day: vm.chosedDay, seatNum: vm.chosedSeatNum, ...vm.chosedTimeInfo }), submitOfficial: (vm) => vm.submit(), observeSuccess: (target, vm) => vm?.submitsuccess === true
  });
  // 为 Fake Adapter 暴露 iframe Vue，但真实 Engine 仍只从 iframe 的 document/window 取得它。
  const originalFactory = targetDayFrameLoaderFactory;
  const loaderFactory = () => { const loader = originalFactory(); const originalLoad = loader.load.bind(loader); loader.load = async (url) => { const result = await originalLoad(url); loader._vm = { chosedDay: new URL(url).searchParams.get('day'), chosedSeatNum: '', chosedTimeInfo: { startTime: '', endTime: '', duration: '' }, seatConfig: context.seatConfig, submitsuccess: false, submit() { iframeSubmitCalls += 1; } }; return result; }; return loader; };
  const clock = { now: () => clockNow, calibrate: async () => ({ source: 'LOCAL_FALLBACK', offsetMs: 0, uncertaintyMs: null }), snapshot: () => ({ source: 'LOCAL_FALLBACK', offsetMs: 0, uncertaintyMs: null }) }; const scheduler = { start() {}, stop() {} }; const storage = new SeatStorage(shared, new MemoryStore()); storage.saveSettings(settings);
  const submitObserverFactory = (options) => { const observer = { ...options, installed: false, restored: false, install() { this.installed = true; }, restore() { this.restored = true; } }; observerInstances.push(observer); return observer; };
  const engine = new ReservationEngine({ adapter, clock, scheduler, storage, logger: new EventLogger({ consoleRef: null }), lockApi: null, submissionCoordinator: { claim: async () => true }, notifier, targetDayFrameLoaderFactory: loaderFactory, frameAdapterFactory, submitObserverFactory, retryScheduler: (work, delay) => scheduled.push({ work, delay }) });
  return { engine, storage, adapter, scheduled, observerInstances, get parentSubmitCalls() { return parentSubmitCalls; }, get iframeSubmitCalls() { return iframeSubmitCalls; }, get loaderCreations() { return loaderCreations; }, get currentLoader() { return currentLoader; }, setClock(value) { clockNow = value; } };
}
