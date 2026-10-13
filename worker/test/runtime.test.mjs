import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import MF from 'miniflare';
const { Miniflare, convertV4MiniflareOptions, Response: MFResponse } = MF;
// Real workerd + SQLite DO; every outgoing request is intercepted, never passed to the network.
const day = new Date(Date.now() + 32 * 3600000).toISOString().slice(0,10);
const index = {success:true,data:{curReserves:[],nearReserves:[]}};
const record = {id:123,roomId:3747,seatNum:'216',today:day,startTime:'08:30',endTime:'22:00',status:'pending-fixture'};
const profile = {states:{'pending-fixture':'RESERVED_PENDING','signed-fixture':'SIGNED_IN'}};
function runtime(replies, persist) {
  const calls=[];
  const options = convertV4MiniflareOptions({ modules:true, durableObjectsPersist:persist, scriptPath:resolve('.build/index.js'), compatibilityDate:'2026-09-21', durableObjects:{SEAT_ACCOUNT:{className:'SeatAccount',useSQLite:true}}, bindings:{ADMIN_TOKEN:'FAKE_ADMIN',CHAOOXING_COOKIE:'FAKE_COOKIE',FID_ENC:'FAKE_FID',CHAOOXING_RESERVE_PAGE_URL:'https://office.chaoxing.com/front/third/apps/seat/select?id=3747',WRITES_ENABLED:'true',STATUS_PROFILE_VERIFIED:'true',STATUS_PROFILE_JSON:JSON.stringify(profile)}, outboundService:async request=>{
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
