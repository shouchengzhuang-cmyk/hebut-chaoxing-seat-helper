import assert from "node:assert/strict";
import test from "node:test";
import { LifecycleCoordinator } from "../src/lifecycle.ts";
import { SerialJournal } from "../src/journal.ts";
import { day, harness, index, page, record } from "./fixture.ts";

test("success is persisted and repeat calls submit only once", async () => {
  const h = harness([index(), page, { success: true, data: { seatReserve: record } }]);
  assert.equal((await h.c.run(true, day)).kind, "RESERVATION_SUCCESS");
  assert.equal((await h.c.run(true, day)).kind, "RESERVATION_SUCCESS");
  assert.equal(h.writes().length, 1);
  const state = await h.c.inspect();
  assert.equal(Object.values(state.operations)[0].phase, "CONFIRMED");
  assert.doesNotMatch(JSON.stringify(state), /FAKE_COOKIE|FAKE_SALT|FAKE_ADMIN/);
});
test("explicit permanent failure is not retried", async () => {
  const h = harness([index(), page, { success: false, msg: "不允许预约" }]);
  assert.equal((await h.c.run(true, day)).kind, "RESERVATION_FAILED");
  h.advance(3600000); await h.c.run(true, day); assert.equal(h.writes().length, 1);
});
test("lost response is reconciled by positive read, no resend", async () => {
  const h = harness([index(), page, new Error("lost response"), index([record])]);
  assert.equal((await h.c.run(true, day)).kind, "ALREADY_RESERVED"); assert.equal(h.writes().length, 1);
});
test("absence after lost response stays uncertain across restart", async () => {
  const h = harness([index(), page, new Error("timeout"), index(), index()]);
  assert.equal((await h.c.run(true, day)).kind, "SUBMITTED_UNVERIFIED");
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  assert.equal((await restored.run(true, day)).kind, "SUBMITTED_UNVERIFIED"); assert.equal(h.writes().length, 1);
});
test("eight concurrent Cron/manual triggers submit once", async () => {
  const h = harness([index(), page, { success: true, data: { seatReserve: record } }]);
  const results = await Promise.all(Array.from({ length: 8 }, () => h.c.run(true, day)));
  assert.ok(results.every(result => result.kind === "RESERVATION_SUCCESS")); assert.equal(h.writes().length, 1);
});
test("malformed state read prevents all writes", async () => {
  const h = harness([{ success: true, data: {} }]);
  assert.equal((await h.c.run(true, day)).kind, "LIFECYCLE_BLOCKED"); assert.equal(h.writes().length, 0);
});
test("busy obeys backoff and rereads before retry", async () => {
  const h = harness([index(), page, { success: false, msg: "繁忙" }, index([record])]);
  assert.equal((await h.c.run(true, day)).kind, "RESERVATION_FAILED");
  await h.c.run(true, day); assert.equal(h.calls.length, 3);
  h.advance(60000); assert.equal((await h.c.run(true, day)).kind, "ALREADY_RESERVED"); assert.equal(h.writes().length, 1);
});
test("busy is capped at three acknowledged attempts", async () => {
  const rejected = { success: false, msg: "系统繁忙" };
  const h = harness([index(), page, rejected, index(), page, rejected, index(), page, rejected]);
  await h.c.run(true, day); h.advance(60000); await h.c.run(true, day); h.advance(300000);
  await h.c.run(true, day); h.advance(900000); await h.c.run(true, day); assert.equal(h.writes().length, 3);
});
test("HTTP500 is ambiguous, never a retryable failure", async () => {
  const h = harness([index(), page, async () => new Response("error", { status: 500 }), index()]);
  assert.equal((await h.c.run(true, day)).kind, "SUBMITTED_UNVERIFIED"); assert.equal(h.writes().length, 1);
});
test("wrong time success stays uncertain", async () => {
  const h = harness([index(), page, { success: true, data: { seatReserve: { ...record, startTime: "09:00" } } }, index()]);
  assert.equal((await h.c.run(true, day)).kind, "SUBMITTED_UNVERIFIED");
});
test("captcha stops and latches human review", async () => {
  const h = harness([index(), page, { success: false, msg: "需要验证码" }]);
  await h.c.run(true, day); assert.equal((await h.c.inspect()).reviewPending, true);
  assert.equal((await h.c.run(true, day)).kind, "LIFECYCLE_BLOCKED"); assert.equal(h.writes().length, 1);
});
test("prewrite marker survives failure saving final result", async () => {
  const h = harness([index(), page, { success: true, data: { seatReserve: record } }, index([record])]);
  let puts = 0; const original = h.storage.put.bind(h.storage);
  h.storage.put = async (key, value) => { if (++puts === 3) throw new Error("storage result failure"); return original(key, value); };
  await assert.rejects(h.c.run(true, day));
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  assert.equal((await restored.run(true, day)).kind, "ALREADY_RESERVED"); assert.equal(h.writes().length, 1);
});
test("prewrite persistence failure sends no submit", async () => {
  const h = harness([index(), page]); let puts = 0; const original = h.storage.put.bind(h.storage);
  h.storage.put = async (key, value) => { if (++puts === 2) throw new Error("prewrite failure"); return original(key, value); };
  await assert.rejects(h.c.run(true, day)); assert.equal(h.writes().length, 0);
});
test("timeout aborts transport and retains unresolved intent", async () => {
  const h = harness([index(), page, async (_url, init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })), index()]);
  assert.equal((await h.c.run(true, day)).kind, "SUBMITTED_UNVERIFIED"); assert.equal(h.writes().length, 1);
});
test("disabled writes never contact upstream", async () => {
  const h = harness([], { WRITES_ENABLED: "false" });
  assert.equal((await h.c.run(true, day)).kind, "WRITES_DISABLED"); assert.equal(h.calls.length, 0);
});
