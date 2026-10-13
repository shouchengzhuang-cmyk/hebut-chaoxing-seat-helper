import assert from "node:assert/strict";
import test from "node:test";
import { createWorker } from "../src/index.ts";
import { runReservation } from "../src/reservation.ts";
import { arrivalEntry } from "../src/arrival.ts";
import { day, env, harness, index, page, record } from "./fixture.ts";
function req(path: string, method = "GET", body?: unknown): Request { return new Request("https://worker.example" + path, { method, headers: { Authorization: "Bearer FAKE_ADMIN", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
async function invoke(worker: ReturnType<typeof createWorker>, request: Request, config = env) { return worker.fetch!(request, config, {} as ExecutionContext) as Promise<Response>; }

test("all monitoring and arrival routes require authentication", async () => {
  const h = harness([]), worker = createWorker({ ...h.deps, coordinator: h.c });
  for (const [method, path] of [["GET", "/status"], ["POST", "/monitor"], ["POST", "/track"], ["GET", "/arrival"]]) {
    assert.equal((await invoke(worker, new Request("https://worker.example" + path, { method }))).status, 401);
  }
  assert.equal(h.calls.length, 0);
});
test("cached /status sends no school request", async () => {
  const h = harness([]), worker = createWorker({ ...h.deps, coordinator: h.c });
  assert.equal((await invoke(worker, req("/status"))).status, 200); assert.equal(h.calls.length, 0);
});
test("authenticated /track then /monitor is read-only and throttled", async () => {
  const h = harness([index([record])]), worker = createWorker({ ...h.deps, coordinator: h.c });
  const response = await invoke(worker, req("/track", "POST", { day })); assert.equal(response.status, 200);
  const second = await invoke(worker, req("/monitor", "POST")); assert.equal((await second.json() as any).result.skipped, "POLL_BACKOFF"); assert.equal(h.writes().length, 0);
});
test("arrival supplies official hall URL without school writes", async () => {
  const h = harness([]), worker = createWorker({ ...h.deps, coordinator: h.c });
  const body = await (await invoke(worker, req("/arrival"))).json() as any;
  assert.equal(body.entry.url, env.CHAOOXING_HALL_URL); assert.equal(h.calls.length, 0);
  assert.throws(() => arrivalEntry({ ...env, CHAOOXING_HALL_URL: "https://evil.example" }));
});
test("no public sign, release or clear-supervision endpoint exists", async () => {
  const worker = createWorker();
  for (const path of ["/sign", "/signback", "/cancel", "/clear-supervision"]) assert.equal((await invoke(worker, req(path, "POST"))).status, 404);
});
test("missing durable binding blocks live run", async () => {
  const h = harness([]), worker = createWorker(h.deps);
  const response = await invoke(worker, req("/run?commit=1", "POST")); assert.equal(response.status, 409); assert.equal(h.calls.length, 0);
  assert.equal((await runReservation(env, true, h.deps)).kind, "STATE_STORE_REQUIRED");
});
test("lost response gets202 and remains unverified", async () => {
  const h = harness([index(), page, new Error("lost"), index()]), worker = createWorker({ ...h.deps, coordinator: h.c });
  const response = await invoke(worker, req("/run?commit=1&day=" + day, "POST")); assert.equal(response.status, 202); assert.equal((await response.json() as any).result.kind, "SUBMITTED_UNVERIFIED");
});
test("upstream errors never leak credential-like messages", async () => {
  const h = harness([new Error("Cookie=REAL_SECRET submit_enc=SECRET")]), worker = createWorker(h.deps);
  const response = await invoke(worker, req("/run", "POST")); assert.doesNotMatch(await response.text(), /REAL_SECRET|submit_enc|Cookie=/);
});
test("monitor cron cannot enter reservation path", async () => {
  const h = harness([index([record]), index([{ ...record, status: "signed-fixture" }])]); await h.c.track(day); h.advance(60000);
  const worker = createWorker({ ...h.deps, coordinator: h.c });
  await worker.scheduled!({ cron: "*/1 * * * *", scheduledTime: h.deps.now().getTime(), noRetry() {} }, { ...env, MONITOR_ENABLED: "true" }, {} as ExecutionContext);
  assert.equal(h.writes().length, 0); assert.equal((await h.c.inspect()).snapshot?.state, "SIGNED_IN");
});
test("disabled crons and unknown cron do nothing", async () => {
  const h = harness([]), worker = createWorker({ ...h.deps, coordinator: h.c });
  for (const cron of ["*/1 * * * *", "29 14 * * *", "* * * * *"]) await worker.scheduled!({ cron, scheduledTime: 0, noRetry() {} }, { ...env, WRITES_ENABLED: "false", MONITOR_ENABLED: "false" }, {} as ExecutionContext);
  assert.equal(h.calls.length, 0);
});
