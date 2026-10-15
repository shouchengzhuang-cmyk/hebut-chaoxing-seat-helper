import assert from "node:assert/strict";
import test from "node:test";
import { LifecycleCoordinator } from "../src/lifecycle.ts";
import { SerialJournal, emptyJournal, type AccountJournal } from "../src/journal.ts";
import { day, harness, index, page, record } from "./fixture.ts";

test("legacy rejected Cron without authorization time cannot retry after restart", async () => {
  const h = harness([index(), page, { success: false, msg: "繁忙" }, index(), index(), page, { success: true, data: { seatReserve: record } }]);
  await h.c.run(true, day, h.deps.now().getTime());
  const stored = await h.storage.get<AccountJournal>("account-v1");
  assert.ok(stored);
  delete Object.values(stored.operations)[0].submitAt;
  delete Object.values(stored.operations)[0].authorizationSource;
  await h.storage.put("account-v1", stored);
  h.advance(16 * 60000);
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  await restored.tick();
  assert.equal(h.writes().length, 1);
  const state = await restored.inspect();
  assert.equal(Object.values(state.operations)[0].phase, "REJECTED");
  assert.equal(Object.values(state.operations)[0].attempts, 1);
  assert.equal(Object.values(state.operations)[0].submitAt, undefined);
  assert.equal(state.handoff?.reason, "AUTHORIZATION_EVIDENCE_REQUIRED");
});

for (const offset of [15 * 60000, 16 * 60000]) {
  test(`persisted Cron source without time fails closed at offset ${offset}`, async () => {
    const h = harness([index(), page, { success: false, msg: "繁忙" }, index(), index(), index(), index()]);
    await h.c.run(true, day, h.deps.now().getTime());
    const stored = (await h.storage.get<AccountJournal>("account-v1"))!;
    delete Object.values(stored.operations)[0].submitAt;
    await h.storage.put("account-v1", stored);
    h.advance(offset);
    const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
    await restored.tick();
    // Neither a manual request nor a new Cron time repairs old missing evidence.
    await restored.run(true, day);
    await restored.run(true, day, h.deps.now().getTime());
    const state = await restored.inspect();
    assert.equal(h.writes().length, 1);
    assert.equal(Object.values(state.operations)[0].submitAt, undefined);
    assert.equal(Object.values(state.operations)[0].authorizationSource, "CRON");
    assert.equal(Object.values(state.operations)[0].attempts, 1);
    assert.equal(state.handoff?.reason, "AUTHORIZATION_EVIDENCE_REQUIRED");
  });
}

for (const [offset, writes] of [[15 * 60000, 2], [16 * 60000, 1]]) {
  test(`legacy finite Cron time migrates without extending deadline at offset ${offset}`, async () => {
    const h = harness([index(), page, { success: false, msg: "繁忙" }, index(), index(), page, { success: true, data: { seatReserve: record } }]);
    const submitAt = h.deps.now().getTime();
    await h.c.run(true, day, submitAt);
    const stored = (await h.storage.get<AccountJournal>("account-v1"))!;
    delete Object.values(stored.operations)[0].authorizationSource;
    await h.storage.put("account-v1", stored);
    h.advance(offset);
    const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
    await restored.tick();
    const op = Object.values((await restored.inspect()).operations)[0];
    assert.equal(h.writes().length, writes);
    assert.equal(op.authorizationSource, "CRON");
    assert.equal(op.submitAt, submitAt);
    assert.equal(op.attempts, writes);
  });
}

test("explicit manual retry survives restart without acquiring a Cron timestamp", async () => {
  const h = harness([index(), page, { success: false, msg: "繁忙" }, index(), index(), page, { success: true, data: { seatReserve: record } }]);
  await h.c.run(true, day);
  h.advance(16 * 60000);
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  await restored.tick();
  const op = Object.values((await restored.inspect()).operations)[0];
  assert.equal(h.writes().length, 2);
  assert.equal(op.authorizationSource, "MANUAL");
  assert.equal(op.submitAt, undefined);
  assert.equal(op.phase, "CONFIRMED");
});

for (const offset of [15 * 60000, 16 * 60000]) {
  test(`legacy pendingRun with finite Cron time preserves deadline at offset ${offset}`, async () => {
    const h = harness([index(), page, { success: true, data: { seatReserve: record } }]);
    const state = emptyJournal(), submitAt = h.deps.now().getTime() - offset;
    state.pendingRun = { day, submitAt };
    await h.storage.put("account-v1", state);
    const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
    await restored.tick();
    const stored = await restored.inspect();
    if (offset === 15 * 60000) {
      assert.equal(h.writes().length, 1);
      const op = Object.values(stored.operations)[0];
      assert.equal(op.phase, "CONFIRMED");
      assert.equal(op.submitAt, submitAt);
      assert.equal(op.authorizationSource, "CRON");
    } else {
      assert.equal(h.writes().length, 0);
      assert.equal(h.calls.length, 0);
      assert.deepEqual(stored.pendingRun, { day, submitAt, authorizationSource: "CRON" });
      assert.equal(stored.handoff?.reason, "CRON_SUBMISSION_WINDOW_MISSED");
    }
  });
}

test("manual request cannot downgrade a persisted expired Cron operation", async () => {
  const h = harness([index(), page, { success: false, msg: "繁忙" }, index(), page]);
  const submitAt = h.deps.now().getTime();
  await h.c.run(true, day, submitAt);
  h.advance(16 * 60000);
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  await restored.run(true, day);
  const state = await restored.inspect(), op = Object.values(state.operations)[0];
  assert.equal(h.writes().length, 1);
  assert.equal(op.authorizationSource, "CRON");
  assert.equal(op.submitAt, submitAt);
  assert.equal(op.phase, "REJECTED");
  assert.equal(op.attempts, 1);
  assert.equal(state.handoff?.reason, "CRON_SUBMISSION_WINDOW_MISSED");
});

test("legacy unknown write remains unresolved after restart and fresh Cron request", async () => {
  const h = harness([index(), page, new Error("lost"), index(), index(), index()]);
  await h.c.run(true, day, h.deps.now().getTime());
  const stored = (await h.storage.get<AccountJournal>("account-v1"))!;
  delete Object.values(stored.operations)[0].submitAt;
  delete Object.values(stored.operations)[0].authorizationSource;
  await h.storage.put("account-v1", stored);
  h.advance(16 * 60000);
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  await restored.tick();
  await restored.run(true, day, h.deps.now().getTime());
  const op = Object.values((await restored.inspect()).operations)[0];
  assert.equal(h.writes().length, 1);
  assert.equal(op.phase, "SUBMITTED_UNVERIFIED");
  assert.equal(op.attempts, 1);
  assert.equal(op.submitAt, undefined);
});

test("legacy pendingRun cannot be promoted to manual or refreshed Cron authorization", async () => {
  const h = harness([]), state = emptyJournal();
  state.day = "2026-10-13";
  state.pendingRun = { day };
  await h.storage.put("account-v1", state);
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  await restored.tick();
  await restored.run(true, day);
  await restored.run(true, day, h.deps.now().getTime());
  const stored = await restored.inspect();
  assert.equal(h.writes().length, 0);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(stored.pendingRun, { day });
  assert.deepEqual(stored.operations, {});
  assert.equal(stored.handoff?.reason, "AUTHORIZATION_EVIDENCE_REQUIRED");
});

test("new manual pendingRun preserves its authorization source across restart", async () => {
  const h = harness([index([record])]);
  await h.c.track(day);
  await h.c.run(true, "2026-10-15");
  const restored = new LifecycleCoordinator(h.config, new SerialJournal(h.storage), h.deps);
  await restored.tick();
  assert.equal(h.writes().length, 0);
  const state = await restored.inspect();
  assert.deepEqual(state.pendingRun, { day: "2026-10-15", submitAt: undefined, authorizationSource: "MANUAL" });
  assert.equal(state.handoff?.reason, "OLD_INTERVAL_ACTIVE");
});

test("pendingRun after a handoff crash cannot be bypassed by same-day manual run", async () => {
  const h = harness([]), state = emptyJournal();
  state.day = day;
  state.pendingRun = { day };
  await h.storage.put("account-v1", state);
  await h.c.run(true, day);
  await h.c.run(true, "2026-10-15");
  const stored = await h.c.inspect();
  assert.equal(h.writes().length, 0);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(stored.pendingRun, { day });
  assert.deepEqual(stored.operations, {});
  assert.equal(stored.handoff?.reason, "AUTHORIZATION_EVIDENCE_REQUIRED");
});

for (const submitAt of [NaN, Infinity]) {
  test(`invalid persisted Cron timestamp ${submitAt} cannot authorize submission`, async () => {
    const h = harness([index(), index()]);
    const state = emptyJournal();
    state.day = day;
    state.operations[`${day}|3747|216|08:30|22:00|initial`] = { phase: "REJECTED", attempts: 1, nextAttemptAt: 0, submitAt, authorizationSource: "CRON" };
    await h.storage.put("account-v1", state);
    await h.c.tick();
    assert.equal(h.writes().length, 0);
    assert.equal(Object.values((await h.c.inspect()).operations)[0].phase, "REJECTED");
    assert.equal((await h.c.inspect()).handoff?.reason, "AUTHORIZATION_EVIDENCE_REQUIRED");
  });
}
