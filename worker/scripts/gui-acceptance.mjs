import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

// Optional real-browser acceptance. Reuses an existing Playwright installation and
// an isolated Edge profile; never reads the user's browser data or .dev.vars.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:18765';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(root, '../docs/gui', runId);
await mkdir(out, { recursive: true });
const report = { runId, status: 'RUNNING', browser: '', cases: [], screenshots: [], pageErrors: [], externalRequests: [], serverOutboundAttempts: 0 };
let server, browser, serverText = '';
async function check(name, work) {
  try { await work(); report.cases.push({ name, status: 'PASS' }); console.log('PASS', name); }
  catch (error) { report.cases.push({ name, status: 'FAIL', error: error.message }); throw error; }
}
async function shot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(out, name + '.png'), fullPage: true });
  report.screenshots.push(name + '.png');
}
async function connect(page) {
  await page.locator('#token').fill('LOCAL_PREVIEW_ONLY');
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.startsWith('计划已读取'));
  assert.equal(await page.locator('#token').inputValue(), '');
}
async function save(page, revision) {
  await page.locator('#review').click();
  await page.locator('#save').click();
  await page.waitForFunction(r => document.querySelector('#notice').textContent.includes('计划已保存，revision ' + r), revision);
}
const portOccupied = await new Promise(done => {
  const socket = createConnection({ host: '127.0.0.1', port: 18765 });
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
});
if (portOccupied) throw Error('PREVIEW_PORT_OCCUPIED: refusing to reuse or stop an existing preview/state');
try {
  server = spawn(process.execPath, ['scripts/preview-control.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverText += chunk.toString(); });
  const deadline = Date.now() + 20000;
  while (!serverText.includes('Offline UI:')) {
    if (server.exitCode !== null || Date.now() > deadline) throw Error('OFFLINE_PREVIEW_START_FAILED: ' + serverText.slice(-1500));
    await new Promise(done => setTimeout(done, 100));
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server', '--disable-background-networking'] });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    report.externalRequests.push({ origin: url.origin, path: url.pathname });
    return route.abort('blockedbyclient');
  });
  context.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message)));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const nextDay = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const targetDay = nextDay(1);
  await check('page-load-and-csp', async () => {
    const response = await page.goto(origin + '/control');
    assert.equal(response.status(), 200); assert.match(response.headers()['content-security-policy'], /connect-src 'self'/);
    await page.locator('h1').waitFor(); assert.equal(await page.title(), 'HEBUT 预约控制台');
    assert.equal(await page.locator('#save').isDisabled(), true); await shot(page, '01-loaded');
  });
  await check('reject-invalid-token-and-connect', async () => {
    await page.locator('#token').fill('INVALID_SYNTHETIC_TOKEN'); await page.locator('#connect').click();
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('UNAUTHORIZED'));
    await connect(page); assert.equal(await page.locator('#room').inputValue(), '3747');
  });
  await check('candidate-order-through-real-buttons', async () => {
    await page.locator('#seats').fill('216,215,217'); await page.locator('#seatOrder button').nth(1).click();
    assert.equal(await page.locator('#seats').inputValue(), '215,216,217');
  });
  let afternoonId;
  await check('time-templates-and-default-selection', async () => {
    await page.locator('#addTemplate').click();
    const row = page.locator('#templates .row').nth(1); afternoonId = await row.getAttribute('data-id');
    await row.locator('input').nth(0).fill('下午'); await row.locator('input').nth(1).fill('14:30'); await row.locator('input').nth(2).fill('20:30');
    await page.locator('#defaultTemplate').selectOption(afternoonId);
    assert.equal(await page.locator('#templates .row').count(), 2);
  });
  await check('date-weekdays-pauses-and-dated-override', async () => {
    await page.locator('#effective').fill(today); await page.locator('#enabled').check(); await page.locator('#dateMode').selectOption('DATE'); await page.locator('#date').fill(targetDay);
    await page.locator('#dateMode').selectOption('WEEKLY'); await page.locator('#weekdays input[value="0"]').uncheck();
    await page.locator('#paused').fill(nextDay(2)); await page.locator('#overrideDay').fill(targetDay); await page.locator('#overrideTemplate').selectOption(afternoonId); await page.locator('#addOverride').click();
    assert.match(await page.locator('#overrides').innerText(), new RegExp(targetDay));
    assert.match(await page.locator('#overrides').innerText(), /下午/);
  });
  await check('save-plan-without-redeployment', async () => {
    await save(page, 1); assert.match(await page.locator('#notice').innerText(), /尚未提交预约/); await shot(page, '02-plan-saved');
  });
  await check('save-refreshes-visible-target-and-clears-old-diff', async () => {
    await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('座位 215 / 14:30–20:30'));
    assert.match(await page.locator('#diff').innerText(), /已保存/);
  });
  await check('refresh-retains-plan-but-forgets-token', async () => {
    await page.reload(); assert.equal(await page.locator('#token').inputValue(), '');
    await page.locator('#refresh').click(); await page.waitForFunction(() => document.querySelector('#notice').textContent === '请先连接控制台');
    await connect(page); assert.equal(await page.locator('#seats').inputValue(), '215,216,217');
    assert.equal(await page.locator('#dateMode').inputValue(), 'WEEKLY'); assert.equal(await page.locator('#date').inputValue(), targetDay);
    assert.equal(await page.locator('#paused').inputValue(), nextDay(2)); assert.equal(await page.locator('#defaultTemplate').inputValue(), afternoonId);
    assert.equal(await page.locator('#enabled').isChecked(), true);
    assert.equal(await page.locator('#templates .row').nth(1).locator('input').nth(1).inputValue(), '14:30');
    assert.equal(await page.locator('#templates .row').nth(1).locator('input').nth(2).inputValue(), '20:30');
    assert.equal(await page.locator('#weekdays input[value="0"]').isChecked(), false);
    assert.match(await page.locator('#overrides').innerText(), new RegExp(targetDay));
  });
  await check('two-tabs-revision-conflict-keeps-server-winner', async () => {
    const other = await context.newPage(); await other.goto(origin + '/control'); await connect(other);
    await page.locator('#seats').fill('217,215,216'); await save(page, 2);
    await other.locator('#seats').fill('216,217,215'); await other.locator('#review').click(); await other.locator('#save').click();
    await other.waitForFunction(() => document.querySelector('#notice').textContent.includes('PLAN_REVISION_CONFLICT'));
    await shot(other, '03-version-conflict'); await other.reload(); await connect(other);
    assert.equal(await other.locator('#seats').inputValue(), '217,215,216'); await other.close();
  });
  await check('global-pause-persists-across-refresh-and-resumes', async () => {
    await page.locator('#pause').click(); await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('全部暂停'));
    await shot(page, '04-paused'); await page.reload(); await connect(page);
    assert.match(await page.locator('#summary').innerText(), /全部暂停/);
    await page.locator('#resume').click(); await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('已恢复计划门禁'));
    assert.doesNotMatch(await page.locator('#summary').innerText(), /全部暂停/);
  });
  await check('read-only-preview-remains-blocked-without-school-evidence', async () => {
    await page.locator('#runDay').fill(targetDay); await page.locator('#preview').click();
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('学校房间与时间规则未核验'));
  });
  await check('mobile-layout-no-horizontal-overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(dimensions.content <= dimensions.viewport, JSON.stringify(dimensions)); await shot(page, '05-mobile');
  });
  await check('mobile-weekday-checkboxes-keep-intrinsic-width', async () => {
    const widths = await page.locator('#weekdays input').evaluateAll(inputs => inputs.map(i => i.getBoundingClientRect().width));
    assert.ok(widths.every(width => width <= 24), JSON.stringify(widths));
  });
  await check('disconnect-and-failed-reconnect-clear-visible-cached-state', async () => {
    await page.locator('#disconnect').click();
    assert.match(await page.locator('#summary').innerText(), /未连接/);
    assert.equal(await page.locator('#status').textContent(), ''); assert.equal(await page.locator('#save').isDisabled(), true);
    await connect(page); await page.locator('#token').fill('INVALID_SYNTHETIC_TOKEN'); await page.locator('#connect').click();
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('UNAUTHORIZED'));
    assert.match(await page.locator('#summary').innerText(), /未连接/); assert.equal(await page.locator('#status').textContent(), '');
    await connect(page);
  });
  await check('no-browser-errors-or-school-network', async () => {
    report.serverOutboundAttempts = (serverText.match(/OFFLINE_PREVIEW_OUTBOUND_BLOCKED/g) || []).length;
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []); assert.equal(report.serverOutboundAttempts, 0);
  });
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.failure = error.message; process.exitCode = 1;
  const pages = browser?.contexts().flatMap(context => context.pages()) || [];
  if (pages[0]) await shot(pages[0], 'failure').catch(() => {});
  console.error(error.message);
} finally {
  report.serverOutboundAttempts = (serverText.match(/OFFLINE_PREVIEW_OUTBOUND_BLOCKED/g) || []).length;
  await browser?.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise(done => server.once('exit', done));
    server.send('shutdown');
    await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(Error('PREVIEW_SHUTDOWN_TIMEOUT')), 10000).unref())]);
  }
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('GUI_REPORT', resolve(out, 'report.json'));
}
