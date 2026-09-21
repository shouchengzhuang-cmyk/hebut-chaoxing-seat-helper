import assert from "node:assert/strict";
import test from "node:test";
import { makeEnc } from "../src/enc.ts";

test("enc golden vector #1 keeps empty captcha and wyToken", () => {
  const params = { roomId: "3747", startTime: "08:30", endTime: "22:00", day: "2026-09-21", captcha: "", seatNum: "216", wyToken: "" };
  assert.equal(makeEnc(params, "TEST_SALT"), "bd612adcc92b1839e5bf1b6bf28278df");
});

test("enc golden vector #2 uses only existing keys", () => {
  const params = { roomId: "3747", startTime: "08:30", endTime: "22:00", day: "2026-09-21", seatNum: "216" };
  assert.equal(makeEnc(params, "TEST_SALT"), "ad8e4f47b4605dff40c4c7fd5bf43e6c");
});
