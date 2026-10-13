import assert from "node:assert/strict";
import test from "node:test";
import { parseDetail, parseIndex } from "../src/status.ts";
import { checkContract } from "../scripts/check-contract.mjs";
import { DiagnosticSanitizer } from "../../src/diagnostics.js";
import { day, env, record, profile } from "./fixture.ts";
const target = {roomId:"3747",seatNum:"216",startTime:"08:30",endTime:"22:00"};
test("configured response paths support variants only after verification", () => {
  const custom = { ...env, STATUS_PROFILE_JSON: JSON.stringify({ ...profile, responsePaths: { current: "data.reserves", near: "data.recentReserves", detail: "data.reservation" } }) };
  const body = {success:true,data:{reserves:[record],recentReserves:[]}};
  assert.equal(parseIndex(body, custom, target, day).state,"RESERVED_PENDING");
  assert.equal(parseIndex(body, {...custom,STATUS_PROFILE_VERIFIED:"false"},target,day).state,"UNKNOWN");
  assert.equal(parseDetail({success:true,data:{reservation:record}},custom,target,day,"123").state,"RESERVED_PENDING");
});
test("getstatus data-as-record can be explicitly configured",()=>{
  const custom={...env,STATUS_PROFILE_JSON:JSON.stringify({...profile,responsePaths:{detail:"data"}})};
  assert.equal(parseDetail({success:true,data:record},custom,target,day,"123").state,"RESERVED_PENDING");
});
test("response paths cannot access outside data or turn missing arrays into absence",()=>{
  const custom={...env,STATUS_PROFILE_JSON:JSON.stringify({...profile,responsePaths:{current:"secret.records",near:"data.missing"}})};
  assert.equal(parseIndex({success:true,data:{curReserves:[],nearReserves:[]}},custom,target,day).state,"UNKNOWN");
});
test("diagnostic-to-parser pipeline is offline and never asserts production compatibility",()=>{
  const sanitizer=new DiagnosticSanitizer();
  const sample=sanitizer.project({success:true,data:{curReserves:[{...record,status:0}],nearReserves:[]}},{apiStyle:"seat",endpoint:"index"});
  const bundle={schemaVersion:1,provenance:"LOCAL_ANONYMIZED_READONLY_CAPTURE",identifiersAnonymized:true,absoluteDatesAnonymized:true,samples:[sample]};
  const result=checkContract(bundle,{states:{"0":"RESERVED_PENDING"}});
  assert.equal(result.reports[0].state,"RESERVED_PENDING");assert.equal(result.productionCompatibilityConfirmed,false);assert.equal(result.offlineOnly,true);
});
test("unmapped state or malformed data remains pending real verification",()=>{
  const bundle={schemaVersion:1,provenance:"LOCAL_ANONYMIZED_READONLY_CAPTURE",identifiersAnonymized:true,absoluteDatesAnonymized:true,samples:[{apiStyle:"seat",endpoint:"getstatus",httpStatus:200,body:{success:true,data:{}}}]};
  assert.equal(checkContract(bundle,{states:{}}).reports[0].needsVerification,true);
  assert.throws(()=>checkContract({...bundle,identifiersAnonymized:false},{states:{}}));
});
