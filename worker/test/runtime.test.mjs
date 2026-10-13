import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import MF from 'miniflare';
const { Miniflare, convertV4MiniflareOptions, Response: MFResponse } = MF;
// Real workerd + SQLite DO; every outgoing request is intercepted, never passed to the network.
const day = new Date(Date.now() + 32 * 3600000).toISOString().slice(0,10);
const index = {success:true,data:{curReserves:[],nearReserves:[]}};
const record = {id:123,roomId:3747,seatNum:'216',today:day,startTime:'08:30',endTime:'22:00',status:'pending-fixture'};
const profile = {states:{'pending-fixture':'RESERVED_PENDING'}};
function runtime(replies) {
  const calls=[];
  const mf = new Miniflare(convertV4MiniflareOptions({ modules:true, scriptPath:resolve('.build/index.js'), compatibilityDate:'2026-09-21', durableObjects:{SEAT_ACCOUNT:{className:'SeatAccount',useSQLite:true}}, bindings:{ADMIN_TOKEN:'FAKE_ADMIN',CHAOOXING_COOKIE:'FAKE_COOKIE',FID_ENC:'FAKE_FID',CHAOOXING_RESERVE_PAGE_URL:'https://office.chaoxing.com/front/third/apps/seat/select?id=3747',WRITES_ENABLED:'true',STATUS_PROFILE_VERIFIED:'true',STATUS_PROFILE_JSON:JSON.stringify(profile)}, outboundService:async request=>{
    const url=new URL(request.url); calls.push(url.pathname);
    assert.equal(url.origin,'https://office.chaoxing.com');
    const expected=replies.shift(); assert.ok(expected,'UNEXPECTED_OUTBOUND_REQUEST');
    assert.equal(url.pathname,expected.path);
    return new MFResponse(typeof expected.body==='string'?expected.body:JSON.stringify(expected.body));
  } }));
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
