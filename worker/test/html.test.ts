import assert from "node:assert/strict";
import test from "node:test";
import { extractSubmitEnc } from "../src/html.ts";
import { ParseError } from "../src/types.ts";

test("extracts submit_enc with id before value", () => {
  assert.equal(extractSubmitEnc('<input type="hidden" id="submit_enc" value="ABC_123">'), "ABC_123");
});

test("extracts submit_enc with value before id", () => {
  assert.equal(extractSubmitEnc('<input value="XYZ" type="hidden" id="submit_enc">'), "XYZ");
});

test("throws ParseError when submit_enc is absent", () => {
  assert.throws(() => extractSubmitEnc('<input id="another" value="nope">'), ParseError);
});
