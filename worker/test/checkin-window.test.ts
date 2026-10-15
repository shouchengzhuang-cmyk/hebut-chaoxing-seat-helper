import assert from "node:assert/strict";
import test from "node:test";
import { checkinWindow } from "../src/checkin-window.ts";
import { env, day, harness, index, record } from "./fixture.ts";
const timestamp = (time: string) => Date.parse(day + "T" + time + "+08:00");
test("08:30 reservation retains exact 08:00–09:00 advisory window", () => {
  const window = checkinWindow(env, day, timestamp("08:30:00"));
  assert.equal(window.reservationStart, day + "T08:30:00+08:00");
  assert.equal(window.earliestCheckin, day + "T08:00:00+08:00");
  assert.equal(window.latestCheckin, day + "T09:00:00+08:00");
  assert.equal(window.advisoryOnly, true);
});
for (const [time, phase] of [["07:59:59.999", "BEFORE_WINDOW"], ["08:00:00", "IN_WINDOW"], ["09:00:00", "IN_WINDOW"], ["09:00:00.001", "AFTER_WINDOW"]]) {
  test(`checkin boundary ${time}`, () => assert.equal(checkinWindow(env, day, timestamp(time)).clockPhase, phase));
}
test("window crosses prior date and year in Shanghai", () => {
  const window = checkinWindow({ ...env, START_TIME: "00:15" }, "2027-01-01", Date.parse("2026-12-31T15:45:00Z"));
  assert.equal(window.earliestCheckin, "2026-12-31T23:45:00+08:00"); assert.equal(window.latestCheckin, "2027-01-01T00:45:00+08:00"); assert.equal(window.clockPhase, "IN_WINDOW");
});
test("late window crosses next date without changing reservation date", () => {
  const window = checkinWindow({ ...env, START_TIME: "23:40", END_TIME: "23:59" }, "2026-12-31", Date.parse("2026-12-31T16:00:00Z"));
  assert.equal(window.latestCheckin, "2027-01-01T00:10:00+08:00"); assert.equal(window.reservationStart, "2026-12-31T23:40:00+08:00");
});
test("offsets are configurable, strict and independent", () => {
  const window = checkinWindow({ ...env, CHECKIN_EARLY_MINUTES: "0", CHECKIN_LATE_MINUTES: "45" }, day, timestamp("08:00:00"));
  assert.equal(window.earliestCheckin, day + "T08:30:00+08:00"); assert.equal(window.latestCheckin, day + "T09:15:00+08:00");
  for (const invalid of ["-1", "1.5", "invalid", "1441", ""]) assert.throws(() => checkinWindow({ ...env, CHECKIN_EARLY_MINUTES: invalid }, day, timestamp("08:00:00")));
});
test("cached status exposes window without queries or invented release", async () => {
  const h = harness([index([record])]); await h.c.track(day); h.advance(24 * 3600000);
  const state = await h.c.inspect(); assert.equal(state.snapshot?.state, "RESERVED_PENDING"); assert.equal(state.checkinWindow?.clockPhase, "AFTER_WINDOW"); assert.equal(h.calls.length, 1);
});
