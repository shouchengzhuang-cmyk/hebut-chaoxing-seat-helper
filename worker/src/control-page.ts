// Served on the Worker's own origin. Admin credentials never cross into an official
// school tab and are held only in this page's closure, never URL/browser storage.
export function controlPage(): Response {
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HEBUT 预约控制台</title>
<style nonce="${nonce}">body{font:16px/1.6 system-ui,sans-serif;background:#f4f6fa;color:#172132;margin:0}main{max-width:1000px;margin:auto;padding:24px}section{background:white;padding:20px;margin:16px 0;border:1px solid #d7deea;border-radius:12px}h1,h2{margin:0 0 12px}label{display:block;margin:9px 0}input,select,button{font:inherit;padding:7px;border:1px solid #9aaac0;border-radius:5px}input[type=text]{max-width:90%}button{cursor:pointer;background:#eef3fc;margin:4px}button.primary{background:#1e4ca1;color:white}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6fa;padding:12px}small{display:block;color:#516078}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row input{width:130px}.row label{display:inline}#notice{position:sticky;top:0;background:#e9f0ff;padding:12px;border:1px solid #9db4e1}#templates .row{margin:8px 0}#templates input:first-child{width:150px}a{color:#19458e}</style>
<main><h1>HEBUT 预约控制台</h1><p>Worker 统一协调预约；到馆请完成学校要求的真实验证。学校规则未核验时仅保存和模拟。</p><div id="notice" role="status">尚未连接</div>
<section><h2>连接</h2><label>管理令牌 <input id="token" type="password" autocomplete="off" spellcheck="false"></label><button id="connect">连接</button><button id="disconnect">断开并清除令牌</button><small>只在本控制页输入 ADMIN_TOKEN。不要输入学校 Cookie；令牌仅在页面内存中保存，刷新后需重输。</small></section>
<section><h2>计划与生效日期</h2><label>生效日期 <input id="effective" type="date"></label><small>已经提交或结果未知的日期被冻结；换座需先在官方系统处理，并核验终态。本页修改只影响未来任务。</small>
<label><input id="enabled" type="checkbox"> 启用计划</label><label>日期方式 <select id="dateMode"><option value="TOMORROW">明天</option><option value="DATE">指定日期</option><option value="WEEKLY">按星期循环</option></select> <input id="date" type="date"></label><div id="weekdays" class="row"></div>
<label>暂停日期（逗号分隔） <input id="paused" type="text" placeholder="2026-10-20,2026-10-21"></label><label>房间编号 <input id="room" type="text" inputmode="numeric"></label>
<label>候选座位（从左到右优先） <input id="seats" type="text" placeholder="216,215,217"></label><div id="seatOrder" class="row"></div>
<label>策略 <select id="strategy"><option value="QUERY_ONLY">仅查询 / 模拟</option><option value="EXACT">只预约首选座位</option><option value="ORDERED">候选优先级（明确冲突证据后切换）</option></select></label>
<h2>时间模板</h2><div id="templates"></div><button id="addTemplate">添加时段</button><label>默认模板 <select id="defaultTemplate"></select></label>
<label>单日覆盖 <input id="overrideDay" type="date"> <select id="overrideTemplate"></select><button id="addOverride">添加覆盖</button></label><div id="overrides"></div>
<label><input id="notifications" type="checkbox"> 到馆提前与临近截止提醒（程序提示窗口，须以学校规定为准）</label>
<button id="review">预览配置差异</button><button id="save" class="primary" disabled>保存已预览配置</button><button id="restore">恢复首次迁移配置（先预览再保存）</button><pre id="diff">保存成功不等于预约成功。</pre></section>
<section><h2>校验与执行</h2><label>本次目标日期 <input id="runDay" type="date"></label><button id="preview">只读校验 / 模拟</button><button id="execute">按已保存计划执行一次预约</button><button id="pause">暂停所有预约</button><button id="resume">恢复未来计划</button><button id="refresh">刷新缓存状态</button><button id="checkin">回读官方签到状态</button><button id="arrival">打开官方到馆流程</button><button id="notify">允许浏览器通知</button><small>真实预约受部署写入开关、已核验规则、时段和持久账本共同约束。签到回读不会发送签到请求。控制页关闭后浏览器通知不可用。</small><pre id="summary">尚无缓存状态</pre><details><summary>技术诊断详情</summary><pre id="previewResult"></pre><pre id="status"></pre></details></section></main>
<script nonce="${nonce}">${controlScript}</script></html>`, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  } });
}
export const controlScript = String.raw`(() => {
'use strict';
const $ = id => document.getElementById(id);
let token = '', store = null, staged = null, overrides = [], seen = new Set(), busy = false;
const note = text => { $('notice').textContent = text; };
const labels = {UNKNOWN:'未知，需核验',UNRESERVED:'未发现匹配预约',RESERVED_PENDING:'学校记录：待签到',SIGNED_IN:'学校记录：已签到',REVIEW_REQUIRED:'学校记录：待人工处理',RELEASED:'学校记录：已释放',COMPLETED:'学校记录：已结束',NEEDS_USER_PRESENCE:'请到馆完成官方现场验证',NEEDS_HUMAN:'请处理官方验证',PLAN_DISABLED:'计划暂停',OFFICIAL_RULES_UNVERIFIED:'学校房间与时间规则未核验',NOT_OPEN_YET:'尚未开放',DAY_EXCLUDED:'该日期不在本计划范围',ELIGIBILITY_EVIDENCE_REQUIRED:'缺少学校预约资格证据',AUTOMATION_PAUSED:'所有预约已暂停',START_TIME_PASSED:'预约起点已过，已阻止补提'};
const describe = v => labels[v] || v || '尚未检查';
const today = () => new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const tomorrow = () => new Date(Date.now()+8*3600000+86400000).toISOString().slice(0,10);
async function api(path, method='GET', body) {
  if (!token) throw Error('请先连接控制台');
  const response = await fetch(path,{method,redirect:'error',credentials:'omit',cache:'no-store',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || result.result?.message || '请求失败 '+response.status);
  return result.result ?? result;
}
function invalidate() { staged=null; $('save').disabled=true; }
function option(select,value,label) { const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o); }
function templates() { return [...$('templates').children].map(row=>({id:row.dataset.id,name:row.children[0].value,startTime:row.children[1].value,endTime:row.children[2].value})); }
function updateChoices() {
  for (const id of ['defaultTemplate','overrideTemplate']) { const selected=$(id).value;$(id).replaceChildren();for(const t of templates())option($(id),t.id,t.name);if([...$(id).options].some(o=>o.value===selected))$(id).value=selected; }
  invalidate();
}
function addTemplate(t) {
  const row=document.createElement('div');row.className='row';row.dataset.id=t.id;
  for(const [type,value] of [['text',t.name],['time',t.startTime],['time',t.endTime]]){const i=document.createElement('input');i.type=type;i.value=value;i.setAttribute('aria-label',type==='text'?'模板名称':'模板时间');row.append(i);}
  const b=document.createElement('button');b.textContent='移除';b.onclick=()=>{row.remove();updateChoices();};row.append(b);$('templates').append(row);row.oninput=updateChoices;
}
function renderOverrides(){ $('overrides').replaceChildren();for(const [i,o] of overrides.entries()){const row=document.createElement('div');row.textContent=o.day+' → '+o.templateId;const b=document.createElement('button');b.textContent='移除';b.onclick=()=>{overrides.splice(i,1);renderOverrides();invalidate();};row.append(b);$('overrides').append(row);} }
function seatOrder(){ $('seatOrder').replaceChildren();const seats=$('seats').value.split(',').map(s=>s.trim()).filter(Boolean);for(const [i,seat] of seats.entries()){const b=document.createElement('button');b.textContent=seat+(i?' ↑':'');b.disabled=i===0;b.onclick=()=>{[seats[i-1],seats[i]]=[seats[i],seats[i-1]];$('seats').value=seats.join(',');seatOrder();invalidate();};$('seatOrder').append(b);} }
function fill(p){
  $('effective').value=p.effectiveDay;$('enabled').checked=p.enabled;$('dateMode').value=p.dateMode;$('date').value=p.date;$('paused').value=p.pausedDays.join(',');$('room').value=p.roomId;$('seats').value=p.seatCandidates.join(',');$('strategy').value=p.bookingStrategy;$('notifications').checked=p.notifications;
  for(const i of $('weekdays').querySelectorAll('input'))i.checked=p.weekdays.includes(Number(i.value));
  $('templates').replaceChildren();for(const t of p.templates)addTemplate(t);updateChoices();$('defaultTemplate').value=p.defaultTemplateId;overrides=structuredClone(p.overrides);renderOverrides();seatOrder();invalidate();
}
function collect(){ if(!store)throw Error('请先读取计划');return {...store.current,effectiveDay:$('effective').value,enabled:$('enabled').checked,dateMode:$('dateMode').value,date:$('date').value,weekdays:[...$('weekdays').querySelectorAll('input:checked')].map(i=>Number(i.value)),pausedDays:$('paused').value.split(',').map(s=>s.trim()).filter(Boolean),roomId:$('room').value.trim(),seatCandidates:$('seats').value.split(',').map(s=>s.trim()).filter(Boolean),bookingStrategy:$('strategy').value,templates:templates(),defaultTemplateId:$('defaultTemplate').value,overrides:structuredClone(overrides),notifications:$('notifications').checked}; }
async function load(){store=await api('/plans');fill(store.current);note('计划已读取，revision '+store.current.revision);}
async function status(){
  const s=await api('/status');$('status').textContent=JSON.stringify(s,null,2);
  $('summary').textContent='自动预约：'+(s.paused?'全部暂停':'按有效计划')+'\n预约日期：'+(s.day||'尚未跟踪')+'\n学校状态：'+describe(s.snapshot?.state)+'\n到馆步骤：'+describe(s.checkin?.state)+'\n上次回读：'+(s.checkin?.observedAt?new Date(s.checkin.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚无')+'\n下次允许检查：'+(s.nextPollAt?new Date(s.nextPollAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'现在')+'\n提示窗口：'+(s.checkinWindow?s.checkinWindow.earliestCheckin+' 至 '+s.checkinWindow.latestCheckin+'（程序提示，非校方认证）':'待获取预约')+'\n待处理：'+describe(s.handoff?.reason||s.snapshot?.reason)+'\n今天与明天计划：\n'+(s.plannedDays||[]).map(p=>p.day+' / 房间 '+(p.target?.roomId||'—')+' / 座位 '+(p.target?.seatNum||'—')+' / '+(p.target?.startTime||'')+'–'+(p.target?.endTime||'')+' / '+p.reasons.map(describe).join('；')+(p.openAt?' / 距开放约 '+Math.max(0,Math.ceil((p.openAt-(s.clock?.asOf||Date.now()))/60000))+' 分钟（未与学校校时）':'')).join('\n');
  const window=s.checkinWindow;
  if(store?.current.notifications && window && s.checkin?.state==='NEEDS_USER_PRESENCE'){
    const now=Date.now(),early=Date.parse(window.earliestCheckin)-15*60000,last=Date.parse(window.latestCheckin),kind=now>=last-10*60000?'临近签到提示截止':'提前到馆提醒';
    const key=s.day+':'+kind;
    if(now>=early && now<=last && !seen.has(key) && typeof Notification!=='undefined' && Notification.permission==='granted'){
      seen.add(key);const claim=await api('/notifications/claim','POST',{day:s.day,noticeKind:kind==='临近签到提示截止'?'DEADLINE':'EARLY'});
      if(claim.claimed)new Notification(kind,{body:'请按校方正式窗口到馆并完成真实现场验证；本地窗口仅供提示。'});
    }
  }
}
function bind(id,work){$(id).onclick=async()=>{if(busy)return;busy=true;try{await work();}catch(e){note(e.message);}finally{busy=false;}};}
for(const [i,name] of ['日','一','二','三','四','五','六'].entries()){const l=document.createElement('label'),c=document.createElement('input');c.type='checkbox';c.value=i;l.append(c,'周'+name);$('weekdays').append(l);}
document.querySelectorAll('input,select').forEach(e=>e.addEventListener('input',invalidate));$('seats').addEventListener('input',seatOrder);
bind('connect',async()=>{token=$('token').value;$('token').value='';try{await load();await status();}catch(e){token='';throw e;}});
bind('disconnect',async()=>{token='';store=null;staged=null;$('token').value='';$('status').textContent='已断开';note('令牌已清除');invalidate();});
bind('addTemplate',async()=>{addTemplate({id:'t'+crypto.randomUUID().slice(0,8),name:'新时段',startTime:'14:00',endTime:'20:00'});updateChoices();});
bind('addOverride',async()=>{const day=$('overrideDay').value;if(!day)throw Error('请选择覆盖日期');overrides=overrides.filter(o=>o.day!==day);overrides.push({day,templateId:$('overrideTemplate').value});renderOverrides();invalidate();});
bind('review',async()=>{staged=collect();const diff={};for(const k of Object.keys(staged))if(JSON.stringify(staged[k])!==JSON.stringify(store.current[k]))diff[k]={before:store.current[k],after:staged[k]};$('diff').textContent=JSON.stringify({effectiveDay:staged.effectiveDay,changes:diff,existingReservationChanged:false},null,2);$('save').disabled=false;});
bind('save',async()=>{if(!staged)throw Error('请先预览');const result=await api('/plans','PUT',{revision:store.current.revision,plan:staged});store=result.plans;fill(store.current);note('计划已保存，revision '+store.current.revision+'；尚未提交预约');});
bind('restore',async()=>{if(!store)throw Error('请先连接');const first=store.history[0]||store.current;fill({...first,revision:store.current.revision,effectiveDay:today(),enabled:false});note('已载入首次配置，请确认生效日期并预览保存');});
bind('preview',async()=>{const p=await api('/preview','POST',{day:$('runDay').value});$('previewResult').textContent=JSON.stringify(p,null,2);note((p.valid?'校验通过':'已阻止执行')+'：'+p.reasons.map(describe).join('；')+'。目标 '+p.day+' / 房间 '+(p.target?.roomId||'未知')+' / 座位 '+(p.target?.seatNum||'未知')+' / '+(p.target?.startTime||'')+'–'+(p.target?.endTime||''));});
bind('pause',async()=>{await api('/pause','POST',{paused:true});await status();note('已暂停后续预约，已发送的请求仍需回读确认');});
bind('resume',async()=>{await api('/pause','POST',{paused:false});await status();note('已恢复计划门禁；不会清除未知提交或补发过期任务');});
bind('execute',async()=>{if(!confirm('按已保存计划执行一次真实预约？请先核对日期、房间、座位、时段及官方规则。'))return;const result=await api('/run?commit=1&day='+encodeURIComponent($('runDay').value),'POST');$('previewResult').textContent=JSON.stringify(result,null,2);note(result.kind==='RESERVATION_SUCCESS'||result.kind==='ALREADY_RESERVED'?'学校已确认预约；签到状态另行回读':describe(result.message||result.kind));await status();});
bind('refresh',status);bind('checkin',async()=>{await api('/checkin','POST');await status();});
bind('arrival',async()=>{const tab=window.open('about:blank','_blank');try{const e=await api('/arrival');const u=new URL(e.entry?.url||e.url);if(u.origin!=='https://office.chaoxing.com')throw Error('官方入口无效');if(tab){tab.opener=null;tab.location=u.href;}}catch(e){tab?.close();throw e;}});
bind('notify',async()=>{if(typeof Notification==='undefined')throw Error('此浏览器不支持通知');note('通知权限：'+await Notification.requestPermission());});
$('runDay').value=tomorrow();setInterval(()=>{if(token&&!busy&&document.visibilityState==='visible')status().catch(e=>note(e.message));},60000);
})();`;
