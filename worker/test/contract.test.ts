import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDetail, parseIndex, parseRecord } from "../src/status.ts";
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

// Entirely invented examples; no private diagnostic records are copied into this file.
function bundle(samples: unknown[]) { return { schemaVersion: 1, provenance: 'LOCAL_ANONYMIZED_READONLY_CAPTURE', identifiersAnonymized: true, absoluteDatesAnonymized: true, samples }; }
function sample(body: unknown, endpoint = 'index', httpStatus = 200) { return { apiStyle: 'seat', endpoint, httpStatus, body }; }
test('offline inspection covers every current and history record without inventing code meanings', () => {
  const body = { success: true, data: { curReserves: [{...record,status:41}], nearReserves: [{...record,id:555,today:'2026-10-13',status:42},{...record,id:556,today:'2026-10-12',status:43}] } };
  const result = checkContract(bundle([sample(body)]));
  assert.equal(result.reports[0].recordCount, 3);
  assert.equal(result.reports[0].allRecordsValid, true);
  assert.deepEqual(result.reports[0].records.map(r => r.state), ['UNKNOWN','UNKNOWN','UNKNOWN']);
  assert.deepEqual(result.reports[0].records.map(r => r.source), ['current','near','near']);
  assert.equal(result.needsVerification, true);
});
test('unknown history prevents an apparently mapped first record from passing the contract', () => {
  const body = {success:true,data:{curReserves:[record],nearReserves:[{...record,id:555,today:'2026-10-12',status:99}]}};
  const report = checkContract(bundle([sample(body)]),profile).reports[0];
  assert.equal(report.state,'RESERVED_PENDING');
  assert.equal(report.needsVerification,true);
  assert.equal(report.records[1].state,'UNKNOWN');
});
test('contract inspection follows configured paths rather than guessed candidates', () => {
  const body={success:true,data:{reserve:record}};
  assert.equal(checkContract(bundle([sample(body,'getstatus')]),profile).reports[0].state,'UNKNOWN');
  assert.equal(checkContract(bundle([sample(body,'getstatus')]),{...profile,responsePaths:{detail:'data.reserve'}}).reports[0].state,'RESERVED_PENDING');
});
test('configured index lists inspect every record and data-as-detail is supported',()=>{
  const custom={...profile,responsePaths:{current:'data.reserves',near:'data.recentReserves',detail:'data'}};
  const result=checkContract(bundle([sample({success:true,data:{reserves:[record],recentReserves:[]}}),sample({success:true,data:record},'getstatus')]),custom);
  assert.deepEqual(result.reports.map(r=>r.recordCount),[1,1]);
  assert.equal(result.needsVerification,false);
  assert.equal(result.productionCompatibilityConfirmed,false);
});
for (const body of [null,[],false,{}, {success:true,data:{curReserves:[],nearReserves:[null]}}]) {
  test(`malformed sample produces bounded UNKNOWN report: ${JSON.stringify(body)}`,()=>{
    const report=checkContract(bundle([sample(body)])).reports[0];
    assert.equal(report.state,'UNKNOWN');assert.equal(report.needsVerification,true);
  });
}
test('HTTP error and truncated arrays cannot establish a known lifecycle state',()=>{
  for(const s of [sample({success:true,data:{curReserves:[record],nearReserves:[]}},'index',503), sample({success:true,data:{curReserves:[record],nearReserves:[],truncated:true}})]) {
    const report=checkContract(bundle([s]),profile).reports[0];
    assert.equal(report.state,'UNKNOWN'); assert.equal(report.needsVerification,true);
  }
});
test('empty captures are rejected; explicit empty lists still require verification',()=>{
  assert.throws(()=>checkContract(bundle([])));
  assert.throws(()=>checkContract(bundle([null])));
  const report=checkContract(bundle([sample({success:true,data:{curReserves:[],nearReserves:[]}})])).reports[0];
  assert.equal(report.state,'UNRESERVED');assert.equal(report.needsVerification,true);
});
test('contract output excludes arbitrary input content, identifiers and configured paths',()=>{
  const secret='SENSITIVE_SENTINEL';
  const result=checkContract(bundle([sample({success:true,secret,data:{curReserves:[{...record,id:987654321,status:secret}],nearReserves:[]}})]),{states:{[secret]:'SIGNED_IN'}});
  const output=JSON.stringify(result);
  for(const excluded of [secret,'987654321',record.today,'curReserves','rawStatus']) assert.equal(output.includes(excluded),false);
});
test('invalid profile structures are rejected by the offline tool',()=>{
  for(const bad of [null, {states:null}, {states:[]}, {states:{x:'UNRESERVED'}}, {states:{},responsePaths:{current:23}}, {states:{},policyFields:'bad'}]) assert.throws(()=>checkContract(bundle([sample({})]),bad));
});

test('zero reservation IDs remain invalid through anonymization and offline contract checks',()=>{
  for (const id of [0, '0', '000']) {
    const raw={...record,id};
    // The production parser and local diagnostic projection must agree.
    assert.equal(parseRecord(raw),undefined);
    const projected=new DiagnosticSanitizer().project({success:true,data:{curReserves:[raw],nearReserves:[]}},{apiStyle:'seat',endpoint:'index'});
    const report=checkContract(bundle([projected]),profile).reports[0];
    assert.equal(report.recordCount,1);
    assert.equal(report.records[0].recordValid,false);
    assert.equal(report.records[0].state,'UNKNOWN');
    assert.equal(report.needsVerification,true);
  }
});

test('CLI supports unmapped offline inspection without credentials or a profile file',()=>{
  const dir=mkdtempSync(join(tmpdir(),'seat-contract-'));
  try {
    const path=join(dir,'sample.json');
    writeFileSync(path,JSON.stringify(bundle([sample({success:true,data:{curReserves:[{...record,status:84}],nearReserves:[]}})])));
    const result=spawnSync(process.execPath,[new URL('../scripts/check-contract.mjs',import.meta.url).pathname,path],{encoding:'utf8',env:{}});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.reports[0].state,'UNKNOWN');assert.equal(report.productionCompatibilityConfirmed,false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('CLI failures do not echo private paths or malformed file contents',()=>{
  const dir=mkdtempSync(join(tmpdir(),'seat-contract-'));
  try {
    const path=join(dir,'PRIVATE_SENTINEL.json');writeFileSync(path,'PRIVATE_SENTINEL');
    const result=spawnSync(process.execPath,[new URL('../scripts/check-contract.mjs',import.meta.url).pathname,path],{encoding:'utf8',env:{}});
    assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr.includes('PRIVATE_SENTINEL'),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
