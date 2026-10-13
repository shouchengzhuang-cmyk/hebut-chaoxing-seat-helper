import assert from "node:assert/strict";
import test from "node:test";
import { day, harness, index, page, record, rules } from "./fixture.ts";
const release = { ...record, status: "released-fixture" };
const rebookEnv = { AUTO_REBOOK_ENABLED: "true", REBOOK_RULES_VERIFIED: "true" };

test("monitor without tracked day sends no upstream requests", async () => { const h = harness([]); assert.equal((await h.c.tick()).skipped, "NO_TRACKED_RESERVATION"); assert.equal(h.calls.length, 0); });
test("pending then signed-in is confirmed read-only and rate limited", async () => {
  const h = harness([index([record]), index([{ ...record, status: "signed-fixture" }])]);
  await h.c.track(day); assert.equal((await h.c.tick()).skipped, "POLL_BACKOFF");
  h.advance(60000); assert.equal((await h.c.tick()).state.snapshot?.state, "SIGNED_IN"); assert.equal(h.writes().length, 0);
});
test("supervision is recorded once, sticky and never cleared by disappearance", async () => {
  const review = { ...record, status: "review-fixture" };
  const h = harness([index([review]), index([review]), index(), { success: true, data: {} }], rebookEnv);
  await h.c.track(day); h.advance(60000); await h.c.tick(); h.advance(60000); await h.c.tick();
  const state = await h.c.inspect(); assert.equal(state.events.length, 1); assert.equal(state.reviewPending, true); assert.equal(h.writes().length, 0);
  assert.equal(state.snapshot?.record?.id, "123");
});
test("supervision cannot be bypassed by manual run or changing day", async () => {
  const h = harness([index([{ ...record, status: "review-fixture" }])]); await h.c.track(day);
  assert.equal((await h.c.run(true, day)).kind, "LIFECYCLE_BLOCKED");
  assert.equal((await h.c.track("2026-10-15")).skipped, "UNRESOLVED_ACCOUNT_STATE"); assert.equal(h.writes().length, 0);
});
test("release without explicit eligibility cannot rebook", async () => {
  const h = harness([index([release]), index([release])], rebookEnv); await h.c.track(day); h.advance(60000); await h.c.tick(); assert.equal(h.writes().length, 0);
});
test("verified release and rules rebook once for an event", async () => {
  const fresh = { ...record, id: 124 };
  const h = harness([index([release], rules), index([release], rules), index([release], rules), page, { success: true, data: { seatReserve: fresh } }, index([fresh])], rebookEnv);
  await h.c.track(day); h.advance(60000); const tick = await h.c.tick(); assert.equal(tick.result?.kind, "RESERVATION_SUCCESS");
  h.advance(60000); await h.c.tick(); assert.equal(h.writes().length, 1); assert.equal((await h.c.inspect()).rebookCounts[day], 1);
});
for (const [name, policy] of [["blacklist", { ...rules, blacklisted: true }], ["pending review", { ...rules, reviewPending: true }], ["unavailable seat", { ...rules, seatAvailable: false }], ["not allowed", { ...rules, canReserve: false }]] as const) {
  test(`rebooking stops for ${name}`, async () => {
    const h = harness([index([release], policy), index([release], policy)], rebookEnv); await h.c.track(day); h.advance(60000); await h.c.tick(); assert.equal(h.writes().length, 0);
  });
}
test("unverified rules and default disabled rebooking cannot write", async () => {
  for (const flags of [{}, { AUTO_REBOOK_ENABLED: "true", REBOOK_RULES_VERIFIED: "false" }]) { const h = harness([index([release], rules), index([release], rules)], flags); await h.c.track(day); h.advance(60000); await h.c.tick(); assert.equal(h.writes().length, 0); }
});
test("state recheck detects policy change before rebooking", async () => {
  const h = harness([index([release], rules), index([release], rules), index([release], { ...rules, blacklisted: true })], rebookEnv);
  await h.c.track(day); h.advance(60000); const tick = await h.c.tick(); assert.equal(tick.result?.kind, "LIFECYCLE_BLOCKED"); assert.equal(h.writes().length, 0);
});
test("released event with lost submit response never loops", async () => {
  const h = harness([index([release], rules), index([release], rules), index([release], rules), page, new Error("lost"), index([release], rules), index([release], rules)], rebookEnv);
  await h.c.track(day); h.advance(60000); assert.equal((await h.c.tick()).result?.kind, "SUBMITTED_UNVERIFIED");
  h.advance(60000); await h.c.tick(); assert.equal(h.writes().length, 1);
});
test("known-id disappearance remains unknown and retains the id for later polls", async () => {
  const h = harness([index([record]), index(), { success: true, data: {} }, index(), { success: true, data: { seatReserve: release } }]);
  await h.c.track(day); h.advance(60000); assert.equal((await h.c.tick()).state.snapshot?.state, "UNKNOWN");
  h.advance(120000); assert.equal((await h.c.tick()).state.snapshot?.state, "RELEASED"); assert.equal(h.writes().length, 0);
});
test("completion stops automatic polling and manual run", async () => {
  const h = harness([index([{ ...record, status: "completed-fixture" }])]); await h.c.track(day); h.advance(60000);
  assert.equal((await h.c.tick()).skipped, "COMPLETED"); assert.equal((await h.c.run(true, day)).kind, "LIFECYCLE_BLOCKED");
});
test("API errors back off exponentially", async () => {
  const h = harness([index([record]), new Error("offline"), new Error("offline")]); await h.c.track(day); h.advance(60000);
  const first = await h.c.tick(); assert.equal(first.state.pollFailures, 1); assert.equal((await h.c.tick()).skipped, "POLL_BACKOFF");
  h.advance(120000); const second = await h.c.tick(); assert.equal(second.state.pollFailures, 2); assert.equal(second.state.nextPollAt - h.deps.now().getTime(), 240000);
});
test("past-start rebooking stops rather than guessing new allowed time slots", async () => {
  const h = harness([index([release], rules), index([release], rules)], rebookEnv); await h.c.track(day); h.advance(48 * 3600000); await h.c.tick(); assert.equal(h.writes().length, 0);
});
test("initial /run cannot bypass released lifecycle policy", async () => {
  const h = harness([index([release], rules)], rebookEnv); await h.c.track(day); assert.equal((await h.c.run(true, day)).kind, "LIFECYCLE_BLOCKED"); assert.equal(h.writes().length, 0);
});
test("daily rebook budget caps distinct release events at two", async () => {
  const release2 = { ...release, id: 124 }, release3 = { ...release, id: 125 };
  const h = harness([index([release], rules), index([release], rules), index([release], rules), page, { success: true, data: { seatReserve: { ...record, id: 124 } } }, index([release2], rules), index([release2], rules), page, { success: true, data: { seatReserve: { ...record, id: 125 } } }, index([release3], rules)], rebookEnv);
  await h.c.track(day); h.advance(60000); await h.c.tick(); h.advance(60000); await h.c.tick(); h.advance(60000); await h.c.tick();
  assert.equal(h.writes().length, 2); assert.equal((await h.c.inspect()).rebookCounts[day], 2);
});
test("ambiguous original submission resolves through explicit terminal read", async () => {
  const h = harness([index(), page, new Error("lost"), index([release], rules), index([release], rules), index([release], rules), page, { success: true, data: { seatReserve: { ...record, id: 124 } } }], rebookEnv);
  await h.c.run(true, day); h.advance(60000);
  assert.equal((await h.c.tick()).result?.kind, "RESERVATION_SUCCESS"); assert.equal(h.writes().length, 2);
});
test("busy initial submission retries only after monitor backoff and fresh read", async () => {
  const h = harness([index(), page, { success: false, msg: "繁忙" }, index(), index(), page, { success: true, data: { seatReserve: record } }]);
  await h.c.run(true, day); h.advance(60000); assert.equal((await h.c.tick()).result?.kind, "RESERVATION_SUCCESS"); assert.equal(h.writes().length, 2);
});
test("a new review cycle records a new event only after authoritative clearance", async () => {
  const review = { ...record, status: "review-fixture" };
  const h = harness([index([review]), index([{ ...record, status: "signed-fixture" }], rules), index([review])]);
  await h.c.track(day); h.advance(60000); await h.c.tick(); h.advance(60000); await h.c.tick();
  assert.equal((await h.c.inspect()).events.length, 2); assert.equal((await h.c.inspect()).reviewPending, true);
});
test("tracking another day cannot overwrite an active lifecycle", async () => {
  const h = harness([index([record])]); await h.c.track(day);
  assert.equal((await h.c.track("2026-10-15")).skipped, "UNRESOLVED_ACCOUNT_STATE"); assert.equal(h.calls.length, 1);
});
