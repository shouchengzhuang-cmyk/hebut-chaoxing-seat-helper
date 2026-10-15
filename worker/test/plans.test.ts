import assert from "node:assert/strict";
import test from "node:test";
import { PlanCoordinator } from "../src/plan-coordinator.ts";
import { addDays, envForTarget, migratePlan, planForDay, previewPlan, rulesFromEnv, validatePlan, type ReservationPlan } from "../src/plans.ts";
import { CheckinCoordinator } from "../src/checkin.ts";
import { emptyJournal, type AccountJournal } from "../src/journal.ts";
import { verifiedSeatConflict } from "../src/reservation.ts";
import { day, env, harness, index, page, record, rules } from "./fixture.ts";

// Synthetic business rules, not a HEBUT production mapping or authorization.
const roomRule = { evidenceId: "SYNTHETIC_ONLY", roomId: "3747", validFrom: "2026-01-01", validThrough: "2027-01-01", advanceDays: 1,
  openTime: "00:00", startTime: "08:00", endTime: "22:00", stepMinutes: 30, minMinutes: 30, maxMinutes: 840 };
const verified = { RESERVATION_RULES_VERIFIED: "true", RESERVATION_RULES_JSON: JSON.stringify([roomRule]) };
function fixture(responses: Parameters<typeof harness>[0] = [], overrides = {}) {
  const h = harness(responses, { ...verified, ...overrides });
  return { ...h, pc: new PlanCoordinator(h.config, h.storage, h.deps) };
}
async function enable(h: ReturnType<typeof fixture>, changes: Partial<ReservationPlan> = {}) {
  const store = await h.pc.dispatch({ action: "plans" }) as ReturnType<typeof migratePlan>;
  const plan = { ...store.current, enabled: true, bookingStrategy: "EXACT" as const, dateMode: "DATE" as const, date: day, ...changes };
  return h.pc.dispatch({ action: "save-plan", plan, revision: store.current.revision });
}
const allowed = () => index([], rules);
test("legacy config migrates paused without losing the existing unresolved journal", async () => {
  const h = fixture(), state = emptyJournal();
  state.operations.old = { phase: "SUBMITTED_UNVERIFIED", attempts: 1, nextAttemptAt: 0 };
  state.reviewPending = true; await h.storage.put("account-v1", state);
  const migrated = await h.pc.dispatch({ action: "plans" }) as ReturnType<typeof migratePlan>;
  assert.equal(migrated.current.enabled, false); assert.equal(migrated.current.templates[0].startTime, "08:30");
  const stored = await h.storage.get<AccountJournal>("account-v1");
  assert.equal(stored?.operations.old.phase, "SUBMITTED_UNVERIFIED"); assert.equal(stored?.reviewPending, true); assert.equal(h.calls.length, 0);
});
test("simultaneous configuration updates have one CAS winner", async () => {
  const h = fixture();
  const results = await Promise.allSettled([enable(h), enable(h)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await h.pc.dispatch({ action: "plans" }) as any).current.revision, 1);
});
test("storage failure leaves the previous revision and audit unchanged", async () => {
  const h = fixture(); await h.pc.dispatch({ action: "plans" });
  const before = await h.storage.get("account-v1"), put = h.storage.put;
  h.storage.put = async () => { throw Error("DISK_UNAVAILABLE"); };
  await assert.rejects(() => enable(h)); h.storage.put = put;
  assert.deepEqual(await h.storage.get("account-v1"), before);
});
test("multiple templates, ordered seats and a dated override resolve without redeploy", async () => {
  const h = fixture(); await enable(h, { seatCandidates: ["215", "216", "217"], templates: [
    { id: "all", name: "全天", startTime: "08:30", endTime: "22:00" }, { id: "pm", name: "下午", startTime: "14:00", endTime: "20:00" }
  ], defaultTemplateId: "all", overrides: [{ day, templateId: "pm" }] });
  const preview = await h.pc.dispatch({ action: "preview", day }) as any;
  assert.equal(preview.target.seatNum, "215"); assert.equal(preview.target.startTime, "14:00"); assert.equal(preview.valid, true); assert.equal(h.calls.length, 0);
});
for (const [name, change] of Object.entries({
  "duplicate seats": { seatCandidates: ["216", "216"] }, "empty candidates": { seatCandidates: [] }, "unknown fields": { token: "PRIVATE" },
  "invalid date": { date: "2026-02-30" }, "cross-midnight template": { templates: [{ id: "legacy", name: "x", startTime: "22:00", endTime: "08:00" }] },
  "unknown default template": { defaultTemplateId: "missing" }, "duplicate weekday": { weekdays: [1, 1] }, "invalid weekday": { weekdays: [7] },
  "invalid presence mode": { checkinMode: "SPOOFED_LOCATION" }, "injected name": { templates: [{ id: "legacy", name: "<script>", startTime: "08:30", endTime: "22:00" }] },
  "foreign override template": { overrides: [{ day, templateId: "missing" }] }, "duplicate overrides": { overrides: [{ day, templateId: "legacy" }, { day, templateId: "legacy" }] }
})) test(`rejects ${name} atomically`, async () => { const h = fixture(); await assert.rejects(() => enable(h, change as any)); assert.equal((await h.pc.dispatch({ action: "plans" }) as any).current.revision, 0); });

for (const [name, changes, expected] of [
  ["missing rule evidence", { RESERVATION_RULES_VERIFIED: "false" }, "OFFICIAL_RULES_UNVERIFIED"],
  ["expired evidence", { RESERVATION_RULES_JSON: JSON.stringify([{ ...roomRule, validThrough: "2026-10-13" }]) }, "OFFICIAL_RULES_UNVERIFIED"],
  ["unknown room", { RESERVATION_RULES_JSON: JSON.stringify([{ ...roomRule, roomId: "999" }]) }, "OFFICIAL_RULES_UNVERIFIED"],
  ["changed opening time", { RESERVATION_RULES_JSON: JSON.stringify([{ ...roomRule, openTime: "22:45" }]) }, "NOT_OPEN_YET"],
  ["invalid step", { RESERVATION_RULES_JSON: JSON.stringify([{ ...roomRule, stepMinutes: 60 }]) }, "OFFICIAL_TIME_RULE_VIOLATION"],
] as const) test(`blocks writes on ${name}`, async () => {
  const h = fixture([], changes); await enable(h);
  assert.match((await h.pc.dispatch({ action: "run", day, commit: true }) as any).message, new RegExp(expected)); assert.equal(h.calls.length, 0);
});
test("weekly exclusions, pauses, advance limit, date and effective revision are independent", () => {
  const now = Date.parse("2026-10-13T05:32:00Z"), store = migratePlan(env, now), p = { ...store.current, enabled: true };
  assert.ok(previewPlan({ ...p, pausedDays: [day] }, day, { ...env, ...verified }, now).reasons.includes("DAY_EXCLUDED"));
  assert.ok(previewPlan({ ...p, dateMode: "WEEKLY", weekdays: [0] }, day, { ...env, ...verified }, now).reasons.includes("DAY_EXCLUDED"));
  assert.ok(previewPlan(p, addDays(day, 1), { ...env, ...verified }, now).reasons.includes("ADVANCE_DAYS_EXCEEDED"));
  store.history.push(p); store.current = { ...p, revision: 2, effectiveDay: "2026-10-15", seatCandidates: ["215"] };
  assert.equal(planForDay(store, day)?.seatCandidates[0], "216"); assert.equal(planForDay(store, "2026-10-15")?.seatCandidates[0], "215");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});
test("unverified status, query-only plan and disabled writes cannot submit", async () => {
  for (const mode of ["status", "query", "writes"]) {
    const h = fixture([], mode === "status" ? { STATUS_PROFILE_VERIFIED: "false" } : mode === "writes" ? { WRITES_ENABLED: "false" } : {});
    await enable(h, mode === "query" ? { bookingStrategy: "QUERY_ONLY" } : {});
    assert.notEqual((await h.pc.dispatch({ action: "run", day, commit: true }) as any).kind, "RESERVATION_SUCCESS"); assert.equal(h.calls.length, 0);
  }
});
test("missing or revoked eligibility never reaches a submit", async () => {
  for (const responses of [[index()], [allowed(), page, index([], { ...rules, canReserve: false })]]) {
    const h = fixture(responses); await enable(h);
    assert.equal((await h.pc.dispatch({ action: "run", day, commit: true }) as any).kind, "LIFECYCLE_BLOCKED"); assert.equal(h.writes().length, 0);
  }
});
test("parallel cron/manual invocations share the write journal and freeze same-day edits", async () => {
  const h = fixture([allowed(), page, allowed(), { success: true, data: { seatReserve: record } }]); await enable(h);
  const replies = await Promise.all(Array.from({ length: 5 }, () => h.pc.dispatch({ action: "run", day, commit: true })));
  assert.ok(replies.every((r: any) => r.kind === "RESERVATION_SUCCESS")); assert.equal(h.writes().length, 1);
  await assert.rejects(() => enable(h, { seatCandidates: ["215"] }), /EXISTING_ATTEMPT_FROZEN/);
  await enable(h, { seatCandidates: ["215"], effectiveDay: "2026-10-15" });
  assert.equal((await h.storage.get<AccountJournal>("account-v1"))?.target?.seatNum, "216");
});
test("lost POST response survives coordinator restart, empty read, and config attempts", async () => {
  const h = fixture([allowed(), page, allowed(), Error("PRIVATE_TRANSPORT"), allowed(), allowed()]); await enable(h);
  assert.equal((await h.pc.dispatch({ action: "run", day, commit: true }) as any).kind, "SUBMITTED_UNVERIFIED");
  h.advance(60000);
  const restored = new PlanCoordinator(h.config, h.storage, h.deps);
  assert.equal((await restored.dispatch({ action: "run", day, commit: true }) as any).kind, "SUBMITTED_UNVERIFIED");
  await assert.rejects(() => enable(h, { seatCandidates: ["215"] })); assert.equal(h.writes().length, 1);
});
test("candidate fallback needs verified explicit conflict, persists cursor and waits 60 seconds", async () => {
  const h = fixture([allowed(), page, allowed(), { success: false, code: "TAKEN", msg: "conflict" }, allowed(), page, allowed(), { success: true, data: { seatReserve: { ...record, seatNum: "215" } } }], {
    SUBMIT_CONFLICT_PROFILE_VERIFIED: "true", SUBMIT_CONFLICT_PROFILE_JSON: JSON.stringify({ evidenceId: "SYNTHETIC_ONLY", codeField: "code", codes: ["TAKEN"] })
  });
  await enable(h, { bookingStrategy: "ORDERED", seatCandidates: ["216", "215", "217"] });
  await h.pc.dispatch({ action: "run", day, commit: true });
  assert.equal((await h.pc.dispatch({ action: "run", day, commit: true }) as any).message, "CANDIDATE_BACKOFF"); h.advance(60000);
  const result = await new PlanCoordinator(h.config, h.storage, h.deps).dispatch({ action: "run", day, commit: true }) as any;
  assert.equal(result.kind, "RESERVATION_SUCCESS"); assert.equal(result.seatNum, "215"); assert.equal(h.writes().length, 2);
});
for (const [name, reply] of [["unknown text", { success: false, msg: "unrecognized" }], ["captcha", { success: false, msg: "验证码" }], ["rate limit", { success: false, msg: "操作频繁" }], ["expired login", { success: false, msg: "请登录" }], ["false conflict without code profile", { success: false, code: "TAKEN", msg: "conflict" }], ["HTTP429", async () => new Response("", { status: 429 })], ["HTTP500", async () => new Response("", { status: 500 })], ["lost response", Error("lost")], ["mismatched success", { success: true, data: { seatReserve: { ...record, seatNum: "999" } } }]] as const)
  test(`${name} never advances candidate or sends a second write`, async () => {
    const h = fixture([allowed(), page, allowed(), reply, allowed(), allowed()]); await enable(h, { bookingStrategy: "ORDERED", seatCandidates: ["216", "215"] });
    await h.pc.dispatch({ action: "run", day, commit: true }); h.advance(60000);
    await h.pc.dispatch({ action: "run", day, commit: true });
    assert.equal(h.writes().length, 1); assert.equal((await h.storage.get<AccountJournal>("account-v1"))?.candidateProgress, undefined);
  });
test("minute scheduling uses verified opening time and de-duplicates missed-window events", async () => {
  const h = fixture(); await enable(h); await h.pc.dispatch({ action: "scheduled" }); await h.pc.dispatch({ action: "scheduled" });
  assert.equal(h.calls.length, 0); assert.equal((await h.storage.get<AccountJournal>("account-v1"))?.events.filter(e => e.kind === "CRON_SUBMISSION_WINDOW_MISSED").length, 1);
});
test("unknown plan schema never resets a journal", async () => {
  const h = fixture(); await h.pc.dispatch({ action: "plans" }); const s = (await h.storage.get<AccountJournal>("account-v1"))!;
  (s.plans as any).schemaVersion = 99; await h.storage.put("account-v1", s);
  await assert.rejects(() => h.pc.dispatch({ action: "plans" }), /PLAN_SCHEMA_REQUIRES_REVIEW/);
});
for (const [raw, state, reason] of [
  ["SIGNED_IN", "SIGNED_IN", "VERIFIED_STATUS_PROFILE"], ["RESERVED_PENDING", "NEEDS_USER_PRESENCE", "VERIFIED_STATUS_PROFILE"],
  ["REVIEW_REQUIRED", "NEEDS_HUMAN", "VERIFIED_STATUS_PROFILE"], ["RELEASED", "NOT_AVAILABLE_UNDER_OFFICIAL_RULES", "VERIFIED_STATUS_PROFILE"],
  ["UNKNOWN", "UNKNOWN", "UNMAPPED_STATUS"], ["SIGNED_IN", "UNKNOWN", "UNMAPPED_STATUS"]
] as const) test(`checkin ${raw}/${reason} is ${state} based on official evidence only`, () => {
  const s = emptyJournal(); s.day = day; s.snapshot = { state: raw, reason, record: { ...record, id: "123", roomId: "3747", day, rawStatus: "SYNTHETIC", seatNum: "216" } };
  const c = new CheckinCoordinator(); assert.equal(c.reconcile(s, 9999999999999).state, state);
  assert.deepEqual(c.reconcile(s, 1), c.reconcile(structuredClone(s), 1));
});
test("checkin readback is throttled and never submits, even when legacy rebooking enabled", async () => {
  const h = fixture([index([record]), index([{ ...record, status: "signed-fixture" }])], { AUTO_REBOOK_ENABLED: "true", REBOOK_RULES_VERIFIED: "true" });
  await h.pc.dispatch({ action: "track", day }); h.advance(60000);
  assert.equal((await h.pc.dispatch({ action: "checkin" }) as any).checkin.state, "SIGNED_IN");
  const cached = await h.pc.dispatch({ action: "checkin" }) as any; assert.equal(cached.skipped, "POLL_BACKOFF"); assert.equal(h.writes().length, 0);
});
test("minute Cron and manual run at a changed official opening share one transaction", async () => {
  const h = fixture([allowed(), page, allowed(), { success: true, data: { seatReserve: record } }], { RESERVATION_RULES_JSON: JSON.stringify([{ ...roomRule, openTime: "13:32" }]) });
  await enable(h);
  await Promise.all([h.pc.dispatch({ action: "scheduled" }), h.pc.dispatch({ action: "run", day, commit: true })]);
  assert.equal(h.writes().length, 1);
});
test("global pause takes effect without deleting or repairing unknown attempts", async () => {
  const h = fixture(); await enable(h); await h.pc.dispatch({ action: "pause", paused: true });
  assert.equal((await h.pc.dispatch({ action: "run", day, commit: true }) as any).message, "AUTOMATION_PAUSED");
  assert.equal((await h.pc.dispatch({ action: "scheduled" }) as any).skipped, "AUTOMATION_PAUSED"); assert.equal(h.calls.length, 0);
  assert.equal((await h.pc.dispatch({ action: "pause", paused: false }) as any).paused, false);
});
test("reminder claim is durable and exclusive across tabs and restart for both reminder stages", async () => {
  const h = fixture([index([record])]); await enable(h); await h.pc.dispatch({ action: "track", day });
  h.advance(Date.parse(day + "T07:45:00+08:00") - h.deps.now().getTime());
  const replies = await Promise.all(Array.from({ length: 5 }, () => h.pc.dispatch({ action: "notification-claim", day, noticeKind: "EARLY" })));
  assert.equal(replies.filter((r: any) => r.claimed).length, 1);
  const restored = new PlanCoordinator(h.config, h.storage, h.deps);
  assert.equal((await restored.dispatch({ action: "notification-claim", day, noticeKind: "EARLY" }) as any).claimed, false);
  assert.equal((await restored.dispatch({ action: "notification-claim", day, noticeKind: "DEADLINE" }) as any).claimed, false);
  h.advance(65 * 60000);
  assert.equal((await restored.dispatch({ action: "notification-claim", day, noticeKind: "DEADLINE" }) as any).claimed, true);
  assert.equal(h.writes().length, 0);
});
test("stale signed-in checkin cannot override a new UNKNOWN school observation", async () => {
  const h = fixture(); await h.pc.dispatch({ action: "plans" }); const state = (await h.storage.get<AccountJournal>("account-v1"))!;
  state.day = day; state.snapshot = { state: "UNKNOWN", reason: "STATUS_API_ERROR" };
  state.checkin = { state: "SIGNED_IN", operationId: "old", reason: "old", observedAt: 1, unattended: "NOT_AVAILABLE_UNDER_OFFICIAL_RULES" };
  await h.storage.put("account-v1", state);
  assert.equal((await h.pc.dispatch({ action: "inspect" }) as any).checkin.state, "UNKNOWN");
  const mismatch = emptyJournal(); mismatch.day = "2026-10-15";
  mismatch.snapshot = { state: "SIGNED_IN", reason: "VERIFIED_STATUS_PROFILE", record: { id: "123", day, roomId: "3747", seatNum: "216", startTime: "08:30", endTime: "22:00", rawStatus: "SYNTHETIC" } };
  assert.equal(new CheckinCoordinator().reconcile(mismatch, 1).state, "UNKNOWN");
});
test("repeated unknown runs are bounded to one read per minute", async () => {
  const h = fixture([Error("offline")]); await enable(h);
  await Promise.all(Array.from({ length: 8 }, () => h.pc.dispatch({ action: "run", day, commit: true })));
  assert.equal(h.calls.length, 1); assert.equal(h.writes().length, 0);
});
test("conflict profile requires explicit provenance and exact code type", () => {
  for (const p of [{ codeField: "code", codes: [42] }, { evidenceId: "SYNTHETIC", codeField: "code", codes: ["42"] }]) {
    assert.equal(Boolean(verifiedSeatConflict({ success: false, code: 42 }, { ...env, SUBMIT_CONFLICT_PROFILE_VERIFIED: "true", SUBMIT_CONFLICT_PROFILE_JSON: JSON.stringify(p) })), false);
  }
});
test("read-only tracking does not freeze a target that has never been submitted", async () => {
  const h = fixture([allowed(), allowed(), page, allowed(), { success: true, data: { seatReserve: { ...record, seatNum: "215" } } }]);
  await enable(h); await h.pc.dispatch({ action: "track", day }); await enable(h, { seatCandidates: ["215"] });
  assert.equal((await h.pc.dispatch({ action: "run", day, commit: true }) as any).seatNum, "215"); assert.equal(h.writes().length, 1);
});
test("verified release rebooking retains the old coordinator gates and final eligibility read", async () => {
  const released = () => index([{ ...record, status: "released-fixture" }], rules);
  const h = fixture([released(), released(), released(), page, released(), { success: true, data: { seatReserve: { ...record, id: 124 } } }], { AUTO_REBOOK_ENABLED: "true", REBOOK_RULES_VERIFIED: "true" });
  await enable(h); await h.pc.dispatch({ action: "track", day }); h.advance(60000);
  assert.equal((await h.pc.dispatch({ action: "scheduled" }) as any).kind, "RESERVATION_SUCCESS"); assert.equal(h.writes().length, 1);
});
