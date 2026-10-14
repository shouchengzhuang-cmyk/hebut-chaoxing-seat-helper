import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, join, dirname } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import MF from 'miniflare';
const { Miniflare, convertV4MiniflareOptions, Response: MFResponse } = MF;
// Real workerd + SQLite DO; every outgoing request is intercepted, never passed to the network.
const day = new Date(Date.now() + 32 * 3600000).toISOString().slice(0,10);
const index = {success:true,data:{curReserves:[],nearReserves:[]}};
const record = {id:123,roomId:3747,seatNum:'216',today:day,startTime:'08:30',endTime:'22:00',status:'pending-fixture'};
const profile = {states:{'pending-fixture':'RESERVED_PENDING','signed-fixture':'SIGNED_IN'}};
function runtime(replies, persist, scriptPath = resolve('.build/index.js')) {
  const calls=[];
  const options = convertV4MiniflareOptions({ modules:true, modulesRoot:dirname(scriptPath), durableObjectsPersist:persist, scriptPath, compatibilityDate:'2026-09-21', durableObjects:{SEAT_ACCOUNT:{className:'SeatAccount',useSQLite:true}}, bindings:{ADMIN_TOKEN:'FAKE_ADMIN',CHAOOXING_COOKIE:'FAKE_COOKIE',FID_ENC:'FAKE_FID',CHAOOXING_RESERVE_PAGE_URL:'https://office.chaoxing.com/front/third/apps/seat/select?id=3747',WRITES_ENABLED:'true',STATUS_PROFILE_VERIFIED:'true',STATUS_PROFILE_JSON:JSON.stringify(profile)}, outboundService:async request=>{
    const url=new URL(request.url); calls.push(url.pathname);
    assert.equal(url.origin,'https://office.chaoxing.com');
    const expected=replies.shift(); assert.ok(expected,'UNEXPECTED_OUTBOUND_REQUEST');
    assert.equal(url.pathname,expected.path);
    return new MFResponse(typeof expected.body==='string'?expected.body:JSON.stringify(expected.body),{status:expected.status??200});
  } });
  const mf = new Miniflare({ ...options, ...(persist ? { resourcePersistencePath:persist } : {}) });
  return {mf,calls,replies};
}
const headers={Authorization:'Bearer FAKE_ADMIN','Content-Type':'application/json'};
test('workerd loads SQLite DO and persists tracking across stub calls', async()=>{
  const {mf,replies}=runtime([{path:'/data/apps/seat/index',body:index}]);
  try {
    assert.equal((await mf.dispatchFetch('https://worker.example/health')).status,200);
    assert.equal((await mf.dispatchFetch('https://worker.example/status')).status,401);
    const track=await mf.dispatchFetch('https://worker.example/track',{method:'POST',headers,body:JSON.stringify({day})});
    assert.equal(track.status,200);
    const stored=await (await mf.dispatchFetch('https://worker.example/status',{headers})).json();
    assert.equal(stored.result.day,day); assert.equal(stored.result.snapshot.state,'UNRESERVED'); assert.equal(replies.length,0);
  } finally {await mf.dispose();}
});

for (const phase of ['REJECTED', 'SUBMITTED_UNVERIFIED']) {
  test(`SQLite restart preserves legacy ${phase} intent without inventing authorization`, async()=>{
    const persist=await mkdtemp(join(tmpdir(),'seat-do-legacy-auth-'));
    const seedPath=join(persist,'seed.mjs');
    // Test-only module writes an old account-v1 journal using the identical DO class/namespace.
    // It is never bundled with the production Worker and only touches this temporary SQLite store.
    await writeFile(seedPath, `
      export class SeatAccount {
        constructor(state) { this.state = state; }
        async fetch(request) {
          await this.state.storage.put('account-v1', await request.json());
          return Response.json({ok:true});
        }
      }
      export default {fetch(request, env) {
        return env.SEAT_ACCOUNT.get(env.SEAT_ACCOUNT.idFromName('single-account-v1')).fetch(request);
      }};
    `);
    const key=[day,'3747','216','08:30','22:00','initial'].join('|');
    const legacy={version:1,day,archives:[],nextPollAt:0,pollFailures:0,reviewPending:false,events:[],rebookCounts:{},
      snapshot:{state:'UNRESERVED',reason:'ABSENT_FROM_INDEX'},operations:{[key]:{phase,attempts:1,nextAttemptAt:0}}};
    let first,second;
    try {
      first=runtime([],persist,seedPath);
      assert.equal((await first.mf.dispatchFetch('https://worker.example/seed',{method:'POST',body:JSON.stringify(legacy)})).status,200);
      assert.equal(first.calls.length,0);
      await first.mf.dispose();first=null;
      second=runtime([{path:'/data/apps/seat/index',body:index},{path:'/data/apps/seat/index',body:index},{path:'/data/apps/seat/index',body:index}],persist);
      const before=await (await second.mf.dispatchFetch('https://worker.example/status',{headers})).json();
      assert.equal(before.result.operations[key].phase,phase);
      await second.mf.dispatchFetch('https://worker.example/monitor',{method:'POST',headers});
      await second.mf.dispatchFetch('https://worker.example/run?commit=1&day='+day,{method:'POST',headers});
      const stored=await (await second.mf.dispatchFetch('https://worker.example/status',{headers})).json();
      assert.equal(stored.result.version,1);
      assert.equal(stored.result.operations[key].phase,phase);
      assert.equal(stored.result.operations[key].attempts,1);
      assert.equal(stored.result.operations[key].submitAt,undefined);
      assert.equal(stored.result.operations[key].authorizationSource,undefined);
      if(phase==='REJECTED') assert.equal(stored.result.handoff.reason,'AUTHORIZATION_EVIDENCE_REQUIRED');
      assert.equal(second.calls.filter(path=>path.endsWith('/submit')).length,0);
      assert.equal(second.replies.length,phase==='REJECTED'?0:1);
    } finally {if(first)await first.mf.dispose();if(second)await second.mf.dispose();await rm(persist,{recursive:true,force:true});}
  });
}
test('workerd concurrent HTTP requests use one durable submit journal',async()=>{
  const {mf,calls,replies}=runtime([{path:'/data/apps/seat/index',body:index},{path:'/front/third/apps/seat/select',body:'<input id="submit_enc" value="FAKE_SALT">'},{path:'/data/apps/seat/submit',body:{success:true,data:{seatReserve:record}}}]);
  try {
    const results=await Promise.all(Array.from({length:4},()=>mf.dispatchFetch('https://worker.example/run?commit=1&day='+day,{method:'POST',headers})));
    for(const response of results){assert.equal(response.status,200);assert.equal((await response.json()).result.kind,'RESERVATION_SUCCESS');}
    assert.equal(calls.filter(path=>path.endsWith('/submit')).length,1); assert.equal(replies.length,0);
  } finally {await mf.dispose();}
});
test('workerd restart retains old signed task and safely archives before next-day submit',async()=>{
  const persist=await mkdtemp(join(tmpdir(),'seat-do-rollover-'));
  const oldDay=new Date(Date.now()+8*3600000-24*3600000).toISOString().slice(0,10);
  const oldRecord={...record,today:oldDay,status:'signed-fixture'};
  let first,second;
  try{
    first=runtime([{path:'/data/apps/seat/index',body:{success:true,data:{curReserves:[oldRecord],nearReserves:[]}}}],persist);
    await first.mf.dispatchFetch('https://worker.example/track',{method:'POST',headers,body:JSON.stringify({day:oldDay})});
    await first.mf.dispose();first=null;
    second=runtime([{path:'/data/apps/seat/index',body:{success:true,data:{curReserves:[oldRecord],nearReserves:[]}}},{path:'/data/apps/seat/index',body:index},{path:'/front/third/apps/seat/select',body:'<input id="submit_enc" value="FAKE_SALT">'},{path:'/data/apps/seat/submit',body:{success:true,data:{seatReserve:record}}}],persist);
    const results=await Promise.all(Array.from({length:4},()=>second.mf.dispatchFetch('https://worker.example/run?commit=1&day='+day,{method:'POST',headers})));
    for(const response of results)assert.equal((await response.json()).result.kind,'RESERVATION_SUCCESS');
    const stored=await (await second.mf.dispatchFetch('https://worker.example/status',{headers})).json();
    assert.equal(stored.result.archives.length,1);assert.equal(stored.result.archives[0].day,oldDay);assert.equal(stored.result.archives[0].serverTerminalConfirmed,false);
    assert.equal(stored.result.checkinWindow.earliestCheckin,day+'T08:00:00+08:00');
    assert.equal(second.calls.filter(path=>path.endsWith('/submit')).length,1);assert.equal(second.replies.length,0);
  }finally{if(first)await first.mf.dispose();if(second)await second.mf.dispose();await rm(persist,{recursive:true,force:true});}
});
test('workerd restart retains uncertain write and never resubmits after empty read',async()=>{
  const persist=await mkdtemp(join(tmpdir(),'seat-do-uncertain-'));let first,second;
  try{
    first=runtime([{path:'/data/apps/seat/index',body:index},{path:'/front/third/apps/seat/select',body:'<input id="submit_enc" value="FAKE_SALT">'},{path:'/data/apps/seat/submit',status:500,body:{}},{path:'/data/apps/seat/index',body:index}],persist);
    const initial=await first.mf.dispatchFetch('https://worker.example/run?commit=1&day='+day,{method:'POST',headers});assert.equal(initial.status,202);
    await first.mf.dispose();first=null;
    second=runtime([{path:'/data/apps/seat/index',body:index}],persist);
    const retry=await second.mf.dispatchFetch('https://worker.example/run?commit=1&day='+day,{method:'POST',headers});assert.equal(retry.status,202);
    const stored=await (await second.mf.dispatchFetch('https://worker.example/status',{headers})).json();assert.equal(Object.values(stored.result.operations)[0].phase,'SUBMITTED_UNVERIFIED');
    assert.equal(second.calls.filter(path=>path.endsWith('/submit')).length,0);assert.equal(second.replies.length,0);
  }finally{if(first)await first.mf.dispose();if(second)await second.mf.dispose();await rm(persist,{recursive:true,force:true});}
});
