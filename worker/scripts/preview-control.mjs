import { resolve, dirname } from 'node:path';
import MF from 'miniflare';

// Local UI acceptance only. No .dev.vars, cookies, production state or school network.
const scriptPath = resolve('.build/index.js');
const options = MF.convertV4MiniflareOptions({ modules: true, modulesRoot: dirname(scriptPath), scriptPath,
  host: '127.0.0.1', port: 18765, compatibilityDate: '2026-09-21',
  durableObjects: { SEAT_ACCOUNT: { className: 'SeatAccount', useSQLite: true } },
  bindings: { ADMIN_TOKEN: 'LOCAL_PREVIEW_ONLY', WRITES_ENABLED: 'false', STATUS_PROFILE_VERIFIED: 'false' },
  outboundService: () => new MF.Response('OFFLINE_PREVIEW_NO_SCHOOL_NETWORK', { status: 503 }),
});
const mf = new MF.Miniflare(options);
await mf.ready;
console.log('Offline UI: http://127.0.0.1:18765/control — synthetic token LOCAL_PREVIEW_ONLY');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await mf.dispose(); process.exit(0); });
