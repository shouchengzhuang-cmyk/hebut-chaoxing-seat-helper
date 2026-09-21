import assert from "node:assert/strict";
import test from "node:test";
import { getTomorrowInShanghai } from "../src/time.ts";

test("returns next Shanghai day for an ordinary date", () => {
  assert.equal(getTomorrowInShanghai(new Date("2026-09-21T14:30:00.000Z")), "2026-09-22");
});

test("crosses a Shanghai month end", () => {
  assert.equal(getTomorrowInShanghai(new Date("2026-01-31T14:30:00.000Z")), "2026-02-01");
});

test("crosses a Shanghai year end", () => {
  assert.equal(getTomorrowInShanghai(new Date("2026-12-31T14:30:00.000Z")), "2027-01-01");
});
