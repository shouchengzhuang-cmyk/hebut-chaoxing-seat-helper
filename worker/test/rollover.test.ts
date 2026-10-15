import assert from "node:assert/strict";
import test from "node:test";
import { LifecycleCoordinator } from "../src/lifecycle.ts";
import { SerialJournal } from "../src/journal.ts";
import { createWorker } from "../src/index.ts";
import { cronPlan } from "../src/cron-plan.ts";
import { day, harness, index, page, record, rules, env } from "./fixture.ts";
const nextDay = "2026-10-15", signed = { ...record, status: "signed-fixture" }, next = { ...record, id: 124, today: nextDay };
const afterEnd = 33 * 3600000; // From fixture 10/13 13:32 Shanghai to 10/14 22:32.
test("expired signed-in task archives without asserting server completion", async () => {
  const h = harness([index([signed]), index([signed]), index(), page, { success: true, data: { seatReserve: next } }]);
  await h.c.track(day); h.advance(afterEnd);
  assert.equal((await h.c.run(true, nextDay)).kind, "RESERVATION_SUCCESS");
  const state = await h.c.inspect(); assert.equal(state.day, nextDay); assert.equal(state.archives[0].snapshot?.state, "SIGNED_IN"); assert.equal(state.archives[0].serverTerminalConfirmed, false); assert.equal(state.archives[0].reason, "LOCAL_TASK_INTERVAL_ENDED");
});
test("unknown expired observation with no uncertain write does not permanently block tomorrow", async () => {
  const h = harness(["bad json", new Error("offline"), index(), page, { success: true, data: { seatReserve: next } }]);
  await h.c.track(day); h.advance(afterEnd); assert.equal((await h.c.run(true, nextDay)).kind, "RESERVATION_SUCCESS");
  const state = await h.c.inspect(); assert.equal(state.archives[0].snapshot?.state, "UNKNOWN"); assert.ok(state.events.some(e => e.kind === "HISTORY_STATUS_UNVERIFIED"));
});
test("unconfirmed yesterday write blocks tomorrow and survives restart", async () => {
  const h = harness([index(), page, new Error("lost"), index(), index()]);
  await h.c.run(true, day); h.advance(afterEnd); assert.equal((await h.c.run(true, nextDay)).kind, "LIFECYCLE_BLOCKED");
  const state = await h.c.inspect(); assert.equal(state.archives.length, 0); assert.equal(state.handoff?.reason, "HISTORY_SUBMISSION_UNVERIFIED"); assert.equal(state.handoff?.needsHuman, true);
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  await restored.run(true, nextDay); assert.equal(h.writes().length, 1); assert.equal(h.calls.length, 5);
});
test("positive historical read resolves unknown write then resumes pending next day", async () => {
  const completed = { ...record, status: "completed-fixture" };
  const h = harness([index(), page, new Error("lost"), index(), index(), index([completed]), index(), page, { success: true, data: { seatReserve: next } }]);
  await h.c.run(true, day); h.advance(afterEnd); await h.c.run(true, nextDay);
  h.advance(60000); assert.equal((await h.c.tick()).result?.kind, "RESERVATION_SUCCESS"); assert.equal(h.writes().length, 2);
  assert.equal((await h.c.inspect()).archives[0].serverTerminalConfirmed, true);
});
test("review restrictions remain sticky across days until explicit clearance", async () => {
  const review = { ...record, status: "review-fixture" };
  const h = harness([index([review]), index([review])]); await h.c.track(day); h.advance(afterEnd);
  assert.equal((await h.c.run(true, nextDay)).kind, "LIFECYCLE_BLOCKED"); assert.equal((await h.c.inspect()).handoff?.reason, "HISTORY_REVIEW_PENDING"); assert.equal(h.writes().length, 0);
});
test("durable restart retains archives and concurrent next-day idempotency", async () => {
  const h = harness([index([signed]), index([signed]), index(), page, { success: true, data: { seatReserve: next } }]); await h.c.track(day); h.advance(afterEnd);
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  const results = await Promise.all(Array.from({ length: 6 }, () => restored.run(true, nextDay)));
  assert.ok(results.every(r => r.kind === "RESERVATION_SUCCESS")); assert.equal(h.writes().length, 1); assert.equal((await restored.inspect()).archives.length, 1);
});
test("normal 22:29 Cron maps UTC14:29 to next day and prepares near22:30", () => {
  const scheduled = Date.parse("2026-10-14T14:29:00Z"), plan = cronPlan(scheduled, scheduled);
  assert.equal(plan.day, nextDay); assert.equal(plan.submitAt, Date.parse("2026-10-14T14:30:00Z")); assert.equal(plan.prepareDelayMs, 55000); assert.equal(plan.missed, false);
});
test("delayed Cron preserves scheduled target day across midnight and stops stale execution", () => {
  const scheduled = Date.parse("2026-10-14T14:29:00Z");
  const short = cronPlan(scheduled, scheduled + 90000); assert.equal(short.prepareDelayMs, 0); assert.equal(short.day, nextDay); assert.equal(short.missed, false);
  assert.equal(cronPlan(scheduled, Date.parse("2026-10-14T16:01:00Z")).day, nextDay); assert.equal(cronPlan(scheduled, Date.parse("2026-10-14T16:01:00Z")).missed, true);
  assert.equal(cronPlan(scheduled, scheduled + 16 * 60000).missed, false); assert.equal(cronPlan(scheduled, scheduled + 16 * 60000 + 1).missed, true);
});
test("stale Cron records actionable missed event without contacting school", async () => {
  const h = harness([]); h.advance(24 * 3600000);
  const worker = createWorker({ ...h.deps, coordinator: h.c });
  await worker.scheduled!({ cron: "29 14 * * *", scheduledTime: Date.parse("2026-10-13T14:29:00Z"), noRetry() {} }, env, {} as ExecutionContext);
  assert.equal(h.calls.length, 0); assert.equal((await h.c.inspect()).handoff?.reason, "CRON_SUBMISSION_WINDOW_MISSED");
});
test("uncertain rebook cannot be resolved by the previous released record", async () => {
  const release = { ...record, status: "released-fixture" };
  const h = harness([index([release], rules), index([release], rules), index([release], rules), page, new Error("lost"), index([release], rules), index([release], rules), index([release], rules)], { AUTO_REBOOK_ENABLED: "true", REBOOK_RULES_VERIFIED: "true" });
  await h.c.track(day); h.advance(60000); await h.c.tick(); h.advance(60000); await h.c.tick(); h.advance(afterEnd);
  assert.equal((await h.c.run(true, nextDay)).kind, "LIFECYCLE_BLOCKED"); assert.equal(Object.values((await h.c.inspect()).operations)[0].phase, "SUBMITTED_UNVERIFIED"); assert.equal(h.writes().length, 1);
});
test("legacy v1 journal migrates additively without losing review or submit markers", async () => {
  const h = harness([index(), page, new Error("lost"), index()]); await h.c.run(true, day);
  const stored = h.storage.data.get("account-v1") as any; delete stored.archives; delete stored.target; h.storage.data.set("account-v1", stored);
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  const state = await restored.inspect(); assert.deepEqual(state.archives, []); assert.equal(Object.values(state.operations)[0].phase, "SUBMITTED_UNVERIFIED");
});
test("historical blockage emits one event and honors read backoff", async () => {
  const h = harness([index(), page, new Error("lost"), index(), index()]); await h.c.run(true, day); h.advance(afterEnd);
  await h.c.run(true, nextDay); const first = await h.c.inspect(); await h.c.run(true, nextDay);
  const second = await h.c.inspect(); assert.equal(second.events.filter(e => e.kind === "HISTORY_SUBMISSION_UNVERIFIED").length, 1); assert.equal(h.calls.length, 5); assert.equal(second.handoff?.nextCheckAt, first.handoff?.nextCheckAt);
});
test("confirmed historical review clearance allows next-day handoff", async () => {
  const review={...record,status:"review-fixture"}, completed={...record,status:"completed-fixture"};
  const h=harness([index([review]),index([completed],rules),index(),page,{success:true,data:{seatReserve:next}}]);await h.c.track(day);h.advance(afterEnd);
  assert.equal((await h.c.run(true,nextDay)).kind,"RESERVATION_SUCCESS");assert.equal((await h.c.inspect()).reviewPending,false);
});
test("manual and current Cron share a single next-day operation", async () => {
  const h=harness([index(),page,{success:true,data:{seatReserve:next}}]);
  const scheduled=Date.parse("2026-10-14T14:29:00Z"); h.advance(scheduled+60000-h.deps.now().getTime());
  const c=new LifecycleCoordinator(h.config,h.journal,{...h.deps,wait:async ms=>h.advance(ms)});
  const worker=createWorker({...h.deps,coordinator:c,wait:async ms=>h.advance(ms)});
  await Promise.all([c.run(true,nextDay),worker.scheduled!({cron:"29 14 * * *",scheduledTime:scheduled,noRetry(){}},env,{} as ExecutionContext)]);
  assert.equal(h.writes().length,1);
});
test("expired scheduled authorization is checked again immediately before submit", async () => {
  const h=harness([index(),async()=>{h.advance(2*60000);return new Response(page);}]);
  const submitAt=h.deps.now().getTime()-14*60000;
  assert.equal((await h.c.run(true,day,submitAt)).kind,"LIFECYCLE_BLOCKED");assert.equal(h.writes().length,0);
});
test("Cron retry retains its deadline across coordinator restart", async () => {
  const h = harness([index(), page, { success: false, msg: "繁忙" }, index(), index(), page, { success: true, data: { seatReserve: record } }]);
  const submitAt = h.deps.now().getTime();
  assert.equal((await h.c.run(true, day, submitAt)).kind, "RESERVATION_FAILED");
  h.advance(16 * 60000);
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  const retry = await restored.tick();
  assert.equal(h.writes().length, 1);
  assert.equal(retry.result?.kind, "LIFECYCLE_BLOCKED");
  assert.equal((await restored.inspect()).handoff?.reason, "CRON_SUBMISSION_WINDOW_MISSED");
});
test("Cron retry still succeeds at the inclusive authorization deadline", async () => {
  const h = harness([index(), page, { success: false, msg: "繁忙" }, index(), index(), page, { success: true, data: { seatReserve: record } }]);
  const submitAt = h.deps.now().getTime();
  await h.c.run(true, day, submitAt);
  h.advance(15 * 60000);
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  assert.equal((await restored.tick()).result?.kind, "RESERVATION_SUCCESS");
  assert.equal(h.writes().length, 2);
  assert.equal(Object.values((await restored.inspect()).operations)[0].submitAt, submitAt);
});
test("unsupported journal version fails closed without overwriting stored data",async()=>{
  const h=harness([]);h.storage.data.set("account-v1",{version:2,operations:{},events:[]});
  await assert.rejects(h.c.inspect(),/JOURNAL_SCHEMA_REQUIRES_REVIEW/);assert.equal((h.storage.data.get("account-v1") as any).version,2);assert.equal(h.calls.length,0);
});
test("backward run cannot poison current monitoring with a pending stale date",async()=>{
  const h=harness([index([record])]);await h.c.track(day);
  assert.equal((await h.c.run(true,"2026-10-13")).kind,"LIFECYCLE_BLOCKED");assert.equal((await h.c.inspect()).pendingRun,undefined);assert.equal(h.calls.length,1);
});
