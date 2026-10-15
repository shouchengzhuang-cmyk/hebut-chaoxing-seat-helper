import assert from "node:assert/strict";
import test from "node:test";
import { parseIndex, parseRecord, queryStatus } from "../src/status.ts";
import { apiPrefix, indexForm, officialUrl, targetFromEnv, requestText } from "../src/seat-api.ts";
import { day, env, harness, index, record, rules } from "./fixture.ts";
const target = targetFromEnv(env);

test("unreserved requires affirmative response and two explicit arrays", () => {
  assert.equal(parseIndex(index(), env, target, day).state, "UNRESERVED");
  for (const body of [{}, { success: false, data: { curReserves: [], nearReserves: [] } }, { success: true, data: { curReserves: [] } }]) assert.equal(parseIndex(body, env, target, day).state, "UNKNOWN");
});
for (const [status, expected] of [["pending-fixture", "RESERVED_PENDING"], ["signed-fixture", "SIGNED_IN"], ["review-fixture", "REVIEW_REQUIRED"], ["released-fixture", "RELEASED"], ["completed-fixture", "COMPLETED"]]) {
  test(`verified synthetic profile maps ${expected}`, () => { assert.equal(parseIndex(index([{ ...record, status }]), env, target, day).state, expected); });
}
test("unverified numeric codes, including 5, are never supervision assumptions", () => {
  const body = index([{ ...record, status: 5 }]);
  assert.equal(parseIndex(body, { ...env, STATUS_PROFILE_VERIFIED: "false" }, target, day).state, "UNKNOWN");
  assert.equal(parseIndex(body, env, target, day).state, "UNKNOWN");
});
test("invalid profiles and inherited status names fail closed", () => {
  for (const STATUS_PROFILE_JSON of ["invalid", '{"states":{"0":"UNRESERVED"}}', '{"states":{"0":"FAKE_STATE"}}']) assert.equal(parseIndex(index([record]), { ...env, STATUS_PROFILE_JSON }, target, day).state, "UNKNOWN");
  assert.equal(parseIndex(index([{ ...record, status: "toString" }]), env, target, day).state, "UNKNOWN");
});
test("matching includes exact seat, date and times", () => {
  for (const change of [{ startTime: "09:00" }, { seatNum: "217" }, { today: "2026-10-15" }]) assert.notEqual(parseIndex(index([{ ...record, ...change }]), env, target, day).state, "RESERVED_PENDING");
});
test("malformed records and conflicting history fail closed", () => {
  assert.equal(parseIndex(index([{ id: 123 }]), env, target, day).state, "UNKNOWN");
  assert.equal(parseIndex(index([record, { ...record, id: 124 }]), env, target, day).state, "UNKNOWN");
  assert.equal(parseIndex({ success: true, data: { curReserves: [record], nearReserves: [{ ...record, status: "released-fixture" }] } }, env, target, day).state, "UNKNOWN");
});
test("epoch timestamps normalize in Shanghai and preserve seat padding", () => {
  assert.equal(parseRecord({ ...record, startTime: Date.parse(day + "T08:30:00+08:00"), endTime: Date.parse(day + "T22:00:00+08:00"), seatNum: "007" })?.seatNum, "007");
  assert.equal(parseRecord({ ...record, today: "2026-02-30" }), undefined);
});
test("missing known id triggers detail but never inferred release", async () => {
  const h = harness([index(), { success: true, data: {} }]);
  assert.equal((await queryStatus(env, target, day, h.deps, "123")).state, "UNKNOWN");
  assert.ok(h.calls[1].url.endsWith("/getstatus")); assert.equal(new URLSearchParams(h.calls[1].init.body as string).get("reserveId"), "123");
});
test("explicit matching terminal detail confirms release", async () => {
  const h = harness([index(), { success: true, data: { seatReserve: { ...record, status: "released-fixture" }, rules } }]);
  const snapshot = await queryStatus(env, target, day, h.deps, "123");
  assert.equal(snapshot.state, "RELEASED"); assert.equal(snapshot.policy?.allowed, true);
});
test("wrong-id detail cannot confirm terminal state", async () => {
  const h = harness([index(), { success: true, data: { seatReserve: { ...record, id: 124, status: "released-fixture" } } }]);
  assert.equal((await queryStatus(env, target, day, h.deps, "123")).state, "UNKNOWN");
});
test("policy fields need affirmative typed booleans", () => {
  const good = parseIndex(index([{ ...record, status: "released-fixture" }], rules), env, target, day);
  assert.equal(good.policy?.allowed, true);
  assert.equal(parseIndex(index([record]), env, target, day).policy, undefined);
  assert.equal(parseIndex({ success: true, data: { curReserves: [record], nearReserves: [], rules: { ...rules, canReserve: "true" } } }, env, target, day).policy, undefined);
});
test("both generations use distinct school parameters without defaults", () => {
  assert.equal(indexForm(env).get("fidEnc"), "FAKE_FID");
  const modern = { ...env, API_STYLE: "seatengine", SEAT_ID: "105", SEAT_ID_ENC: "FAKE_ENC" };
  assert.equal(apiPrefix(modern), "/data/apps/seatengine"); assert.equal(indexForm(modern).get("seatId"), "105");
  assert.throws(() => indexForm({ ...env, API_STYLE: "seatengine" }));
  assert.throws(() => apiPrefix({ ...env, API_STYLE: "other" }));
});
test("status reads use only index/getstatus on configured generation", async () => {
  const h = harness([index([record])], { API_STYLE: "seatengine", SEAT_ID: "105", SEAT_ID_ENC: "FAKE_ENC", CHAOOXING_RESERVE_PAGE_URL: "https://office.chaoxing.com/front/apps/seatengine/code?id=3747" });
  await queryStatus(h.config, target, day, h.deps);
  assert.ok(h.calls[0].url.endsWith("/seatengine/index")); assert.equal(h.writes().length, 0);
});
test("credentialed URLs reject wrong origin, path and generation", () => {
  for (const url of ["https://evil.example/front/third/apps/seat/select", "http://office.chaoxing.com/front/third/apps/seat/select", "https://office.chaoxing.com/other", "https://office.chaoxing.com/front/apps/seatengine/code"]) assert.throws(() => officialUrl(url, "reserve", env));
});
test("redirect is not followed and becomes auth unknown", async () => {
  const h = harness([async () => new Response("", { status: 302, headers: { Location: "https://evil.example" } })]);
  assert.equal((await queryStatus(env, target, day, h.deps)).reason, "AUTH_EXPIRED");
  assert.equal(h.calls[0].init.redirect, "manual");
});
test("oversized response and invalid JSON become UNKNOWN", async () => {
  const h = harness(["x".repeat(1_000_001), "<html>login</html>"]);
  assert.equal((await queryStatus(env, target, day, h.deps)).state, "UNKNOWN");
  assert.equal((await queryStatus(env, target, day, h.deps)).state, "UNKNOWN");
});
test("missing cookie does not send any request", async () => {
  const h = harness([]); await assert.rejects(requestText({ ...env, CHAOOXING_COOKIE: undefined }, "https://office.chaoxing.com/data/apps/seat/index", indexForm(env), h.deps)); assert.equal(h.calls.length, 0);
});
test("timestamp seconds cannot silently match a minute-only target", () => {
  assert.equal(parseRecord({ ...record, startTime: Date.parse(day + "T08:30:30+08:00") }), undefined);
});

test('invalid verified configuration never falls back to default empty arrays',()=>{
  for(const patch of [{responsePaths:[]},{responsePaths:{current:42}},{responsePaths:{near:null}},{responsePaths:{current:'data.constructor.records'}},{policyFields:[]},{policyFields:{allowed:42}},{policyFields:{allowed:'secret.allowed'}}]) {
    const config={...env,STATUS_PROFILE_JSON:JSON.stringify({...JSON.parse(env.STATUS_PROFILE_JSON!),...patch})};
    assert.equal(parseIndex(index(),config,target,day).reason,'INVALID_STATUS_PROFILE');
  }
});
test('null and non-object response bodies fail closed without throwing',()=>{
  for(const body of [null,[],true,'text',23,undefined]) assert.equal(parseIndex(body,env,target,day).state,'UNKNOWN');
});
test('truncated diagnostic lists cannot prove absence or a terminal state',()=>{
  for(const records of [[],[record]]) assert.equal(parseIndex({success:true,data:{curReserves:records,nearReserves:[],truncated:true}},env,target,day).reason,'INCOMPLETE_INDEX');
});
test('contradictory date aliases invalidate records',()=>{
  assert.equal(parseRecord({...record,day:'2026-10-15'}),undefined);
  assert.equal(parseRecord({...record,reserveDay:null}),undefined);
  assert.ok(parseRecord({...record,day,reserveDay:day}));
});
test('missing status cannot be granted a meaning by an empty-string profile key',()=>{
  const config={...env,STATUS_PROFILE_JSON:JSON.stringify({states:{'':'RELEASED'}})};
  assert.equal(parseIndex(index([{...record,status:null}]),config,target,day).state,'UNKNOWN');
});
test('inherited response fields cannot prove reservation absence',()=>{
  const data=Object.create({curReserves:[],nearReserves:[]});
  assert.equal(parseIndex({success:true,data},env,target,day).state,'UNKNOWN');
});
test('read failures remain UNKNOWN without retrying or writing',async()=>{
  for(const response of [new Error('private error must not escape'), async()=>new Response('',{status:429}), async()=>new Response('',{status:503}), async()=>new Response('',{status:401})]) {
    const h=harness([response]); const result=await queryStatus(env,target,day,h.deps);
    assert.equal(result.state,'UNKNOWN');assert.equal(h.calls.length,1);assert.equal(h.writes().length,0);
    assert.equal(JSON.stringify(result).includes('private error'),false);
  }
});
