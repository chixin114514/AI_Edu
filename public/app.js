import { cleanStopReason, defaultStopReason } from './stop-reasons.js';
import { routeMapMarkup, mountRouteMaps, destroyRouteMaps } from './route-map.js';
import { Sensors } from './sensors.js';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fallbackRegions=[['浙江省','杭州市','宁波市'],['北京市','北京市'],['上海市','上海市'],['广东省','广州市','深圳市'],['四川省','成都市'],['重庆市','重庆市'],['江苏省','南京市','苏州市']].map(([name,...cities])=>({name,cities:cities.map(name=>({name,districts:[]}))}));
const draft=readDraft();
const state={page:'plan',draft,planPending:false,planError:'',planConsent:false,planProvince:draft.province,planCity:draft.city,planDistrict:draft.district_adcode,regions:fallbackRegions,regionsReady:false,regionError:false,trip:null,session:null,suggestion:null,day:1,config:null,pois:[],trips:[],interests:draft.interests,sensor:{},watchPairing:null,watchPending:false,location:null,locationMessage:'',locating:false,user:null,authMode:'login',authChecked:false,offline:false};
applyDestination(draft.province,draft.city,draft.district_adcode,draft.district);
const sensors=new Sensors();
let toastTimer,renderVersion=0,lastStateAt=0,locationRequest=0,destinationRevision=0,accountRevision=0,watchAttempt=0;
const labels={plan:'规划旅程',trip:'我的行程',journey:'途中伴行',report:'旅行手记',ops:'运营工作台',auth:'登录与注册'};
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),5500);}
// Only planning preferences are persisted; permissions and sensor readings are never draft data.
function readDraft(){
  const defaults={province:'浙江省',city:'杭州市',district_adcode:'',district:'',date:new Date().toLocaleDateString('en-CA'),days:'1',budget:'300',companion:'独自',start_time:'09:00',end_time:'18:00',walk_limit_km:'6',interests:['自然','人文']};
  try{
    const saved=JSON.parse(localStorage.getItem('mx-plan-draft')||'null');
    if(!saved||typeof saved!=='object')return defaults;
    for(const key of ['province','district','district_adcode'])if(typeof saved[key]==='string'&&saved[key].length<=30)defaults[key]=saved[key];
    if(typeof saved.city==='string'&&saved.city.length<=30)defaults.city=saved.city;
    if(typeof saved.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(saved.date))defaults.date=saved.date;
    for(const [key,min,max] of [['days',1,2],['budget',0,10000],['walk_limit_km',1,15]]){
      if(['string','number'].includes(typeof saved[key])&&String(saved[key]).trim()!==''&&Number.isFinite(Number(saved[key]))&&Number(saved[key])>=min&&Number(saved[key])<=max)defaults[key]=String(saved[key]);
    }
    if(['独自','情侣','亲子','长辈同行'].includes(saved.companion))defaults.companion=saved.companion;
    for(const key of ['start_time','end_time'])if(typeof saved[key]==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(saved[key]))defaults[key]=saved[key];
    if(Array.isArray(saved.interests))defaults.interests=saved.interests.filter(v=>['自然','人文','建筑','展览','美食'].includes(v));
  }catch{/* Storage may be disabled or an older draft may be malformed. */}
  return defaults;
}
function saveDraft(){
  const {province,city}=destinationSelection();
  Object.assign(state.draft,{province:province.name,city:city.name,district_adcode:state.planDistrict,district:city.districts.find(d=>d.adcode===state.planDistrict)?.name||''});
  try{localStorage.setItem('mx-plan-draft',JSON.stringify({...state.draft,city:state.planCity,interests:state.interests}));}catch{/* Planning remains available without browser storage. */}}
async function api(path,data,headers={}){
  const revision=accountRevision;
  let response;
  try{response=await fetch('/api'+path,{method:data===undefined?'GET':'POST',headers:{...(data!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:data===undefined?undefined:JSON.stringify(data)});}
  catch{throw Error('网络连接失败，请检查网络后重试。你的输入仍然保留。');}
  let value;
  try{value=await response.json();}catch{throw Error('服务暂时不可用，请稍后重试。');}
  if(revision!==accountRevision&&!path.startsWith('/auth/'))throw Error('账号已切换，请重新操作');
  if(!response.ok)throw Error(value.error||'服务暂时不可用，请稍后重试。');
  return value;
}
function cacheTrip(){try{localStorage.setItem('mx-trip',JSON.stringify(state.trip));localStorage.setItem('mx-trip-owner',state.user?.id||'guest');}catch{toast('浏览器无法保存离线行程，请保持页面开启。');}}
function cancelPendingWatch(){if(state.watchPending){watchAttempt++;state.watchPending=false;state.watchPairing=null;sensors.disconnect();}}
function modal(html){cancelPendingWatch();$('#modal-content').innerHTML=html;const title=$('#modal-content').querySelector('h2');if(title){title.id='modal-title';$('#modal').setAttribute('aria-labelledby','modal-title');}$('#modal').showModal();}
function closeModal(){cancelPendingWatch();$('#modal').close();}
$('#modal').addEventListener('cancel',()=>cancelPendingWatch());
function heading(k,title,subtitle,actions=''){return `<div class="page-heading"><div><p class="eyebrow">${k}</p><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${actions||`<div class="date-note">城市路线 · 按需生成</div>`}</div>`;}
const badge=(text,warm=false)=>`<span class="badge ${warm?'warm':''}">${esc(text)}</span>`;
function updateAccountUI(){
  for(const node of $$('[data-page="ops"],.nav-divider'))node.hidden=state.user?.role!=='admin';
  $('#account-button').textContent=state.user?state.user.username:'登录 / 注册';
  $('#account-button').title=state.user?.role==='admin'?'管理员账号':'我的账号';
  $('#logout-button').hidden=!state.user;
}
async function switchAccount(user){
  accountRevision++;cancelPendingWatch();state.watchPairing=null;closeModal();renderVersion++;state.planPending=false;state.planError='';state.planConsent=false;state.user=user;state.trip=null;state.trips=[];state.session=null;state.suggestion=null;
  destroyRouteMaps();sensors.stop();clearLocation();
  localStorage.removeItem('mx-trip');localStorage.removeItem('mx-trip-owner');localStorage.removeItem('mx-session');
  $('#app').innerHTML='<div class="loading">正在加载账号行程…</div>';
  localStorage.setItem('mx-account-change',String(Date.now())+Math.random());updateAccountUI();
  try{state.trips=(await api('/trips')).trips;state.trip=state.trips[0]||null;state.offline=false;if(state.trip)cacheTrip();}
  catch{state.offline=true;toast('账号已切换，行程暂时无法加载，请联网后刷新。');}
}
function authPage(){
  if(state.user)return `<section class="card account-card"><p class="eyebrow">YOUR MANXING ACCOUNT</p><h1>你好，${esc(state.user.username)}</h1><p class="subtitle">${state.user.role==='admin'?'管理员 · 可使用运营工作台':'旅行者 · 行程已关联到你的账号'}</p><div class="toolbar"><button class="primary" data-page="plan">继续规划旅程 →</button>${state.user.role==='admin'?'<button class="secondary" data-page="ops">进入运营工作台</button>':''}</div></section>`;
  const register=state.authMode==='register';
  return `<section class="auth-layout"><div class="auth-intro"><p class="eyebrow">AT YOUR OWN PACE</p><h1>好风景，<br>从这一程开始。</h1><p>保存每一次漫游，<br>在不同设备继续你的旅程。</p><img src="/lake.svg" alt="湖岸山水插画"></div><div class="card auth-card"><div class="auth-tabs" aria-label="选择登录或注册"><button type="button" data-auth-mode="login" aria-pressed="${!register}">登录</button><button type="button" data-auth-mode="register" aria-pressed="${register}">注册</button></div><h2>${register?'创建你的慢行账号':'欢迎回到慢行'}</h2><p class="subtitle">${register?'已有游客行程会一并保存在新账号中。':'登录后，继续查看你的行程与旅行手记。'}</p><form id="auth-form"><label class="field">用户名<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="32" pattern="[A-Za-z0-9_]{3,32}" placeholder="英文字母、数字或下划线" required></label><label class="field">密码<input name="password" type="password" autocomplete="${register?'new-password':'current-password'}" minlength="${register?8:1}" maxlength="128" placeholder="${register?'至少8位字符':'请输入密码'}" required></label>${register?'<label class="field">确认密码<input name="confirm_password" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="再次输入密码" required></label>':''}<p id="auth-error" class="error-inline" role="alert"></p><button type="submit" class="primary wide" id="auth-submit">${register?'注册并登录':'登录'} →</button></form><button type="button" class="text-button auth-guest" data-page="plan">先以游客身份规划旅程</button></div></section>`;
}
$('#app').addEventListener('submit',async e=>{
  if(e.target.id!=='auth-form')return;e.preventDefault();
  const form=e.target,register=state.authMode==='register',data=Object.fromEntries(new FormData(form));
  const error=form.querySelector('#auth-error'),button=form.querySelector('#auth-submit');error.textContent='';
  if(register&&data.password!==data.confirm_password){error.textContent='两次输入的密码不一致';return;}
  button.disabled=true;button.textContent=register?'正在创建账号…':'正在登录…';
  try{
    const result=await api(register?'/auth/register':'/auth/login',{username:data.username,password:data.password});
    await switchAccount(result.user);navigate('plan');toast(register?'注册成功，已登录':'登录成功');
  }catch(e){if(form.isConnected)error.textContent=e.message;}
  finally{if(form.isConnected){button.disabled=false;button.textContent=register?'注册并登录 →':'登录 →';}}
});
function mapView(stops){
  if(!state.trip||!stops?.length)return '<div class="map-empty"><span>⌖</span><strong>下一座城，下一段风景</strong><p>生成行程后查看高德地图与步行路线。</p></div>';
  const day=state.trip.days.find(d=>d.stops===stops)?.day||state.day;
  return routeMapMarkup(state.trip,day);
}
function routeLibrary(){const packs=new Map();for(const t of state.trips)if(t.route_pack&&!packs.has(t.route_pack.adcode))packs.set(t.route_pack.adcode,t);return `<section class="card route-library"><div class="card-head"><h2>自动生成的城市路线库</h2>${badge(packs.size+' 个区域')}</div><p class="subtitle">每次规划自动检索并保留城市地点与路线。再次生成会重新检查地点数据和步行路线。</p>${packs.size?`<div class="route-library-grid">${[...packs.values()].map(t=>`<article><h3>${esc(t.preferences.city)}${t.preferences.district?' · '+esc(t.preferences.district):''}</h3><p class="fineprint">${t.route_pack.poi_count} 个候选地点 · ${esc(t.route_pack.generated_at.slice(0,10))}</p><div class="toolbar"><button type="button" class="text-button" data-trip="${esc(t.id)}">查看路线 ↗</button><button type="button" class="text-button" data-city="${esc(t.preferences.city)}" data-district="${esc(t.preferences.district_adcode||'')}">重新规划 →</button></div></article>`).join('')}</div>`:'<p class="fineprint">选择城市或使用自动定位，生成第一份城市路线包。</p>'}</section>`;}
function locationPanel(planning){return `<div class="location-panel"><div class="location-heading"><strong>⌖ 自动识别当前位置</strong><button type="button" class="secondary" id="${planning?'locate-plan':'locate'}" ${state.locating?'disabled':''}>${state.locating?'正在识别…':'重新识别位置'}</button></div><p class="fineprint">打开页面后自动请求定位。浏览器允许后，本次位置经后端发送给高德识别省市区及附近地点；本项目不保存定位，也不发送给模型。可拒绝授权并手动选择。</p><div id="location-result" role="status" aria-live="polite">${locationResult()}</div></div>`;}
function locationResult(){
  if(state.locationMessage)return `<p class="location-message">${esc(state.locationMessage)}</p>`;
  const l=state.location;if(!l)return '<p class="fineprint">授权后自动识别；也可直接手动规划。</p>';
  const hint=l.dynamic_planning?'已识别城市，生成行程时将自动检索当地景点并编排路线。起点从当地候选地点中选择，当前位置到起点的路程另计。':!l.supported_city?'演示模式仅支持杭州样本；请开启实况服务生成此城市路线。':'已识别位置，可生成杭州演示路线。';
  return `<p class="location-address"><strong>${esc(l.city)} · ${esc(l.district)}</strong><br>${esc(l.address)}</p>${l.nearby.length?`<p class="fineprint">附近：${l.nearby.map(p=>esc(p.name)).join('、')}</p>`:''}<p class="location-message">${esc(hint)}</p>${l.dynamic_planning&&l.position?`<div class="check-row" style="gap:16px;flex-wrap:wrap;margin:6px 0 0"><label><input type="checkbox" id="use-start-point" checked> 用当前位置作为起点</label><label><input type="checkbox" id="use-end-point"> 结束回到当前位置</label></div>`:''}<p class="fineprint">${esc(l.source)} · 定位精度约 ${Math.round(l.accuracy)} m · ${esc(new Date(l.resolved_at).toLocaleTimeString('zh-CN'))}${l.applied?' · 已填入目的地，可手动修改':l.preserved_manual?' · 已保留您手动选择的目的地':''}</p>`;
}
function paintLocation(){if($('#location-result'))$('#location-result').innerHTML=locationResult();for(const id of ['#locate-plan','#locate']){const b=$(id);if(b){b.disabled=state.locating;b.textContent=state.locating?'正在识别…':'重新识别位置';}}}
function clearLocation(){locationRequest++;state.location=null;state.locationMessage='定位已清除。';state.locating=false;paintLocation();}
async function recognizeLocation({automatic=false}={}){
  if(state.locating)return;
  const request=++locationRequest;state.locating=true;state.location=null;state.locationMessage='正在获取位置，请允许浏览器定位…';paintLocation();
  // Hold the original form reference so a delayed response cannot change a different page's form.
  const form=$('#plan-form'),revision=destinationRevision;
  let preserveDraft=false;
  try{const saved=JSON.parse(localStorage.getItem('mx-plan-draft')||'null');preserveDraft=automatic&&typeof saved?.city==='string'&&saved.city.trim().length>0;}catch{}
  try{
    if(!navigator.onLine)throw Error('当前离线，请联网后重试，或手动选择目的地。');
    const position=await sensors.locate();if(request!==locationRequest){sensors.position=null;return;}
    state.locationMessage='正在识别城市与附近地点…';paintLocation();
    const result=await api('/location/resolve',position);if(request!==locationRequest)return;
    state.location=result;state.locationMessage='';
    if(form&&form.isConnected&&result.supported_city){
      if(revision===destinationRevision&&!preserveDraft){applyDestination(result.province,result.city,result.adcode,result.district);paintDestination();saveDraft();result.applied=true;}
      else result.preserved_manual=true;
    }
  }catch(e){if(request===locationRequest)state.locationMessage=e.message;}
  finally{if(request===locationRequest){state.locating=false;paintLocation();}}
}
function destinationRegions(){return state.config?.data_mode==='demo'?[{...fallbackRegions[0],cities:[fallbackRegions[0].cities[0]]}]:state.regions;}
function destinationSelection(){
 const regions=destinationRegions();let province=regions.find(p=>p.name===state.planProvince)||regions[0];
 let city=province.cities.find(c=>c.name.replace(/市$/,'')===state.planCity.replace(/市$/,''))||province.cities[0];
 state.planProvince=province.name;state.planCity=city.name;
 if(!city.districts.some(d=>d.adcode===state.planDistrict))state.planDistrict='';
 return {regions,province,city};
}
function destinationOptions(){
 const {regions,province,city}=destinationSelection();
 const option=(value,label,selected)=>`<option value="${esc(value)}" ${selected?'selected':''}>${esc(label)}</option>`;
 return {province:regions.map(p=>option(p.name,p.name,p===province)).join(''),city:province.cities.map(c=>option(c.name,c.name,c===city)).join(''),district:option('','全市范围',!state.planDistrict)+city.districts.map(d=>option(d.adcode,d.name,d.adcode===state.planDistrict)).join('')};
}
function destinationHint(){return state.config?.data_mode==='demo'?'演示模式仅支持杭州全市样本':state.regionError?'完整列表暂不可用，可重试或使用自动定位':state.regionsReady?'先选省份和城市，再选区县；也可保留全市范围':'正在加载省、市、区县列表…';}
function destinationFields(){const options=destinationOptions();return `<div class="field full"><span>目的地</span><div class="destination-grid"><label class="field">省份<select name="province" required>${options.province}</select></label><label class="field">城市<select name="city" required>${options.city}</select></label><label class="field">区县<select name="district_adcode">${options.district}</select></label></div><small id="city-hint">${destinationHint()}</small><button type="button" class="text-button" id="retry-regions" ${state.regionError?'':'hidden'}>重新加载省市区 ↻</button></div>`;}
function paintDestination(){
 const form=$('#plan-form');if(!form)return;const options=destinationOptions();
 form.querySelector('[name="province"]').innerHTML=options.province;form.querySelector('[name="city"]').innerHTML=options.city;form.querySelector('[name="district_adcode"]').innerHTML=options.district;
 $('#city-hint').textContent=destinationHint();$('#retry-regions').hidden=!state.regionError;
}
function applyDestination(provinceName,cityName,adcode='',districtName=''){
 let province=state.regions.find(p=>p.name===provinceName);
 if(!province){province={name:provinceName,cities:[]};state.regions.push(province);}
 let city=province.cities.find(c=>c.name===cityName);if(!city){city={name:cityName,districts:[]};province.cities.push(city);}
 if(adcode&&districtName&&!city.districts.some(d=>d.adcode===adcode))city.districts.push({name:districtName,adcode});
 state.planProvince=provinceName;state.planCity=cityName;state.planDistrict=state.config?.data_mode==='demo'?'':adcode;
}
async function loadRegions(){
 try{const data=await api('/regions');if(!Array.isArray(data.provinces)||!data.provinces.length)throw Error('EMPTY_REGIONS');state.regions=data.provinces;state.regionsReady=true;state.regionError=false;}catch{state.regionError=true;}
 paintDestination();
}
function planPage(){
  const d=state.draft;
  const options=(values,current)=>values.map(([value,label])=>`<option value="${esc(value)}" ${String(current)===String(value)?'selected':''}>${esc(label)}</option>`).join('');
  return `<section class="plan-intro"><div><p class="eyebrow"><span class="live-dot"></span> 体感自适应 · 城市旅行</p><h1>好风景，<br>不必<span class="serif-accent">赶路。</span></h1><p class="intro-description">告诉慢行你想去哪。<br>路线随你的状态调整，每次改变由你决定。</p></div><span class="edition">THE CITY, AT YOUR PACE<br>慢行城市指南 / 01</span></section>
  <div class="plan-layout"><section class="planner-panel"><div class="section-label"><span>01 / 从这里出发</span><span>无需设备，也能使用</span></div><h2 class="sr-only">定制你的旅程</h2>
  <form id="plan-form" aria-busy="${state.planPending}">
    ${destinationFields()}
    <div class="form-grid essential-fields"><label class="field">哪天出发<span class="temporal-control"><input name="date" aria-label="旅行日期" type="date" value="${esc(d.date)}" required></span></label><label class="field">留几天<select name="days" aria-label="旅行天数">${options([[1,'一日漫游'],[2,'两日慢游']],d.days)}</select></label></div>
    <details class="preferences"><summary><span>按你的节奏 <small id="preference-summary">${esc(d.companion)} · 每日 ${esc(d.walk_limit_km)} km · ¥${esc(d.budget)}</small></span><span class="expand-mark" aria-hidden="true">＋</span></summary><div class="preferences-body">
      <div class="field"><span>想遇见什么 <small>可多选</small></span><div class="chips">${['自然','人文','建筑','展览','美食'].map(v=>`<button type="button" class="chip ${state.interests.includes(v)?'selected':''}" data-interest="${v}" aria-pressed="${state.interests.includes(v)}">${v}</button>`).join('')}</div></div>
      <div class="form-grid"><label class="field">同行伙伴<select name="companion">${options(['独自','情侣','亲子','长辈同行'].map(v=>[v,v]),d.companion)}</select></label><label class="field">总预算（元）<input name="budget" type="number" inputmode="numeric" min="0" max="10000" value="${esc(d.budget)}" required></label><label class="field">每日出发<span class="temporal-control"><input name="start_time" type="time" value="${esc(d.start_time)}" required></span></label><label class="field">每日结束<span class="temporal-control"><input name="end_time" type="time" value="${esc(d.end_time)}" required></span></label></div>
      <label class="field"><span class="range-label">每日步行上限 <strong id="walk-label">${esc(d.walk_limit_km)} 公里</strong></span><input name="walk_limit_km" id="walk-limit" type="range" min="1" max="15" step="1" value="${esc(d.walk_limit_km)}"><span class="range-label"><small>轻松一点</small><small>多探索一点</small></span></label>
      <p class="fineprint">步行路线 · 起点自动选择。未知票价与预约费用需出发前核实。</p>
    </div></details>
    <button class="primary generate" type="submit" id="generate-button" ${state.planPending?'disabled':''}><span>${state.planPending?'正在为你编排行程…':'生成我的行程'}</span><span aria-hidden="true">${state.planPending?'◌':'↗'}</span></button>
    <div id="plan-error" class="error-inline" role="alert">${esc(state.planError)}</div>
    <p class="plan-status" role="status">${state.planPending?'正在检索地点与步行路线，可能需要数十秒。可以切换页面，完成后会提醒你。':'先规划，再出发。走累了，随时点「轻松一点」。'}</p>
    <details class="optional-settings"><summary>定位与 AI 说明 <span>可选</span></summary><div class="preferences-body">${locationPanel(true)}<label class="check-row"><input name="model_consent" type="checkbox" ${state.planConsent?'checked':''}><span>允许将兴趣和行程节点发送至 DeepSeek 生成说明。不包含身份、定位和心率；不开启也能规划。</span></label></div></details>
    <p class="data-note">${state.config?.data_mode==='live'?'实况地点与步行路线 · 营业、预约和费用待核实':'当前为杭州演示体验 · 示例路线不可用于实际导航'}</p>
  </form></section>
  <aside class="plan-story"><div class="story-art"><img src="/lake.svg" alt="湖岸与山景插画"><span class="art-caption">慢一点，看见更多。<small>城市漫游概念插画</small></span></div><div class="story-copy"><span class="eyebrow">A JOURNEY THAT LISTENS</span><h2>计划有方向，<br>旅程有余地。</h2><p>天气变了，或只是想休息一下。<br>慢行给出新建议，你决定怎么走。</p><div class="story-promise"><span>01 选一座城</span><span>02 生成路线</span><span>03 随感受调整</span></div></div></aside></div>
  ${state.trips.length?`<section class="recent-trips"><div class="section-label"><span>02 / 接着上次的期待</span><span>我的行程</span></div><div class="recent-grid">${state.trips.slice(0,3).map(t=>`<button data-trip="${esc(t.id)}"><span><small>${esc(t.preferences.date)} · ${t.preferences.days} 日</small><strong>${esc(t.preferences.city)}</strong></span><span aria-hidden="true">↗</span></button>`).join('')}</div></section>`:''}
  <section class="how-it-works"><div><span>01</span><h3>想去，就出发</h3><p>选城市与日期，安排适合你的步行路线。</p></div><div><span>02</span><h3>累了，就慢一点</h3><p>途中反馈感受，设备连接始终可选。</p></div><div><span>03</span><h3>改线，你说了算</h3><p>先看少走多远、会错过什么，再确认。</p></div></section>${state.trips.some(t=>t.route_pack)?routeLibrary():''}`;
}
function empty(title,description){return `<section class="empty"><div class="empty-symbol">⌁</div><h2>${title}</h2><p>${description}</p><button class="primary" data-page="plan">规划第一段旅程 ↗</button></section>`;}
function stats(items){return `<div class="stat-grid">${items.map(([title,value,note])=>`<div class="stat"><span>${esc(title)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join('')}</div>`;}
function commerceInfo(p,{compact=false}={}){
  if(p.category!=='美食'&&p.per_capita_cost==null&&p.rating==null)return '';
  const cost=typeof p.per_capita_cost==='number'&&Number.isFinite(p.per_capita_cost)&&p.per_capita_cost>0?p.per_capita_cost:null;
  const rating=typeof p.rating==='number'&&Number.isFinite(p.rating)&&p.rating>0&&p.rating<=5?p.rating:null;
  if(compact){const values=[cost!==null?`<span>参考人均 <strong>¥${esc(cost.toFixed(2).replace(/\.00$/,''))}</strong></span>`:'',rating!==null?`<span>评分 <strong>${esc(rating.toFixed(1))} / 5</strong></span>`:''].filter(Boolean);return values.length?`<div class="commerce-info"><div class="commerce-values">${values.join('')}</div></div>`:'';}
  return `<div class="commerce-info"><div class="commerce-values"><span>参考人均 <strong>${cost===null?'暂无':'¥'+esc(cost.toFixed(2).replace(/\.00$/,''))}</strong></span><span>评分 <strong>${rating===null?'暂无':esc(rating.toFixed(1))+' / 5'}</strong></span></div>${p.commerce_source?`<p class="fineprint">来源：${esc(p.commerce_source)} · 获取于 ${esc(p.commerce_fetched_at?.replace('T',' ').slice(0,16)||'未知')}</p>`:'<p class="fineprint">暂无消费与评分数据，重新生成行程可查询。</p>'}</div>`;
}
function diningPlaces(trip){
  const places=(trip.poi_catalog||[]).filter(p=>p.category==='美食');
  if(!places.length)return '';
  return `<section class="card dining-places"><div class="card-head"><h2>本次检索的餐厅</h2>${badge(places.length+' 家')}</div><p class="subtitle">查看人均消费和评分，方便安排用餐。参考人均不等于实际账单，也未计入行程确定费用。</p><div class="dining-grid">${places.map(p=>`<article class="dining-place"><h3>${esc(p.name)}</h3><p class="subtitle">${esc(p.description)}</p>${commerceInfo(p)}<a class="source-link" href="${esc(p.source_url)}" target="_blank" rel="noopener noreferrer">查看高德地点 ↗</a></article>`).join('')}</div></section>`;
}
function mustVisitList(){if(!state.mustVisit)state.mustVisit=[...(state.trip?.preferences?.must_visit||[])].map(m=>({name:m.name,lat:m.lat,lng:m.lng,category:m.category,duration_min:m.duration_min}));return state.mustVisit;}
function timeline(day){const lockedNames=new Set(mustVisitList().map(m=>m.name));return `<div class="timeline scenery-list">${day.stops.map(p=>{
 const reason=cleanStopReason(p.recommendation_reason,p.name)||defaultStopReason(p,state.trip?.preferences);
 const link=`https://uri.amap.com/marker?position=${p.lng},${p.lat}&name=${encodeURIComponent(p.name)}&coordinate=gaode&callnative=0`;
 return `<article class="route-stop"><div class="stop-body"><h3 class="stop-title">${esc(p.name)}</h3>${commerceInfo(p,{compact:true})}<p class="stop-description">${esc(reason)}</p><a class="source-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">查看高德地点</a><button class="text-button" data-must="${esc(p.id)}">${lockedNames.has(p.name)?'✓ 已锁定为必去':'锁定为必去'}</button></div></article>`;
}).join('')}</div>`;}

function tripPage(){if(!state.trip)return empty('旅程，从一个想法开始','选择日期和偏好，生成你的第一份城市漫游计划。');const t=state.trip,d=t.days[state.day-1];return heading('YOUR CITY, YOUR PACE',esc(t.preferences.city)+'，慢慢走。',`${esc(d.date)} · ${esc(t.preferences.city)}${t.preferences.district?' · '+esc(t.preferences.district):''} · ${esc(t.preferences.companion)} · 第 ${state.day} 天`,`<div class="toolbar">${mustVisitList().length?`<button class="secondary" id="replan-must">✦ 按必去重新规划（${mustVisitList().length}）</button>`:''}<button class="secondary" id="export-trip">↓ 导出行程</button><button class="primary" id="start-journey">${state.session&&!state.session.ended_at?'继续伴行':'开始漫游'} ↗</button></div>`)+`<div class="notice">${t.data_mode==='demo'?'演示行程：距离、耗时、天气均为样本或演示估算，不能用于实际导航。':'高德提供真实地点、步行耗时与距离；营业、票价与预约仍需核实。'} ${t.route_pack?'这是一份待核实草案，未知费用不代表免费，出发前请确认总预算。':'请通过官方渠道核实开放与预约信息。'}</div>`+stats([['行程节点',`${d.stops.length} 站`,'自然与人文交错'],['规划步行',`${(d.distance_m/1000).toFixed(1)} km`,t.data_mode==='demo'?'演示估算':'高德路线'],['游览时长',`${(d.duration_min/60).toFixed(1)} 小时`,'已预留节点间缓冲'],['地点费用',d.unknown_cost_count?'待核实':`¥${d.cost}`,d.unknown_cost_count?'预算 ¥'+t.preferences.budget+'，尚不能保证':'样本门票与餐饮']])+`<div class="layout"><section class="card"><div class="card-head"><h2>今日的风景清单</h2>${badge('行程版本 '+t.version)}</div><div class="route-tabs">${t.days.map(d=>`<button class="chip ${d.day===state.day?'selected':''}" data-day="${d.day}">DAY ${d.day} · ${esc(d.date.slice(5))}</button>`).join('')}</div>${timeline(d)}${d.skipped.length?`<details><summary>${d.skipped.length} 个候选节点因约束未安排</summary><p>${d.skipped.map(p=>esc((t.poi_catalog||state.pois).find(v=>v.id===p.id)?.name||p.id)+'：'+esc(p.reason)).join('<br>')}</p></details>`:''}</section><aside><section class="card preview-card"><div class="preview-top"><div class="card-head"><h2>路线一览</h2>${badge('高德地图')}</div></div>${mapView(d.stops)}<div class="map-foot"><div><span>${esc(t.weather.source)}</span><strong>${t.weather.temperature??'—'}° <small>${esc(t.weather.condition)}</small></strong></div><div><span>${esc(t.weather.time_label||'数据时间')}</span><small>${esc(t.weather.updated_at?.replace('T',' ').slice(0,16))}</small></div></div>${t.weather.source_url?`<p class="fineprint weather-attribution"><a href="https://www.qweather.com/" target="_blank" rel="noopener noreferrer">天气数据：和风天气 ↗</a> · <a href="https://developer.qweather.com/attribution.html" target="_blank" rel="noopener noreferrer">数据来源声明</a></p>`:''}${t.weather.fallback_reason?`<p class="fineprint weather-attribution">${esc(t.weather.fallback_reason)}</p>`:''}<div id="weather-live" class="fineprint" style="margin-top:10px">正在获取分钟级降水与天气预警…</div></section><section class="card tip-card"><h3>✦ 为什么这样安排</h3><p>${esc(t.explanation)}</p><p class="fineprint">说明来源：${esc(t.explanation_source)}</p></section><section class="card" style="margin-top:18px"><div class="card-head"><h2>雨天，也有好去处</h2>${badge('PLAN B',true)}</div><p class="subtitle">${d.plan_b.stops.length?d.plan_b.stops.map(p=>esc(p.name)).join(' → '):'当天没有符合开放与时间约束的室内路线，建议另选日期或结束户外行程。'}</p><p class="fineprint">途中触发建议后，仍需你确认。开放时间与室内属性需核实；若没有合适候选，建议就地避雨或结束户外行程。</p></section></aside></div>${diningPlaces(t)}<section class="history"><h3>我的行程记录</h3>${state.trips.slice(0,5).map(t=>`<button data-trip="${esc(t.id)}"><span>${esc(t.preferences.date)} · ${esc(t.preferences.city)} ${t.preferences.days} 日漫游</span><span>查看 ↗</span></button>`).join('')}</section>`;}
function sensorCard(){return `<section class="card"><div class="sensor-header"><h2>跟随身体的节奏</h2>${badge('可选设备')}</div><p class="subtitle">没有设备，也能随时告诉慢行你的感受。</p><div class="sensor-grid"><div class="sensor-value heart"><span>♡ 当前心率</span><strong id="heart-value">—<small>bpm</small></strong></div><div class="sensor-value"><span>⌁ 估计步频</span><strong id="cadence-value">—<small>步/分</small></strong></div></div><svg class="pulse-chart" viewBox="0 0 350 55" aria-hidden="true"><path d="M0 30h350" stroke="#e8edde" stroke-dasharray="4 4"/><path id="pulse-line" d="M0 30h350" fill="none" stroke="#9cbb83" stroke-width="2"/></svg><p class="sensor-state" id="sensor-status" role="status">未连接设备 · 手动反馈模式</p><div class="device-options"><button class="secondary device-option" id="connect-watch"><strong>Apple Watch</strong><span>配套应用 · Safari 可用</span></button><button class="secondary device-option" id="connect-hr"><strong>蓝牙心率设备</strong><span>需浏览器支持网页蓝牙</span></button></div><div class="watch-progress" id="watch-progress" hidden><p id="watch-progress-text"></p><button class="text-button" id="view-watch">查看配对进度 →</button></div><div class="toolbar sensor-actions"><button class="secondary" id="calibrate" disabled>采集静息基线</button><button class="secondary" id="motion">启用步频</button><button class="text-button" id="stop-sensors">停止传感器</button></div>${locationPanel(false)}<p class="fineprint" id="sensor-extra">Apple Watch需安装慢行配套应用，通过HTTPS临时转发；蓝牙心率在本页读取。请保持页面前台，锁屏后暂停趋势判断。</p></section>`;}
function watchConnectionView(){
  const p=state.watchPairing,s=state.sensor;
  if(!p||p.session_id!==state.session?.id||state.session?.ended_at||state.session?.status==='paused')return {text:'连接已结束，可继续手动反馈。',retry:true};
  if(['live','waiting_for_sample'].includes(s.watchStatus))p.code=null;
  if(s.watchStatus==='disconnected'||s.source!=='watch')return {text:'连接已断开，请重新配对。',retry:true};
  if(!p.code)return {text:s.watchStatus==='background'?'网页已进入后台，返回后等待新心率并重新采集基线。':s.watchStatus==='unavailable'?'网络暂不可用，恢复后自动重试。':s.hr==null?'手表已配对，等待新的心率。请检查佩戴和健康权限。':'已收到手表心率。可关闭此窗口，静坐后采集参考基线。',retry:false};
  const seconds=Math.max(0,Math.ceil((p.pair_expires_at-Date.now())/1000));
  if(!seconds)return {text:'配对码已过期，请重新生成。',retry:true};
  return {text:s.watchStatus==='unavailable'?'网络暂不可用，正在等待恢复。':`等待手表配对 · 剩余 ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`,code:p.code,retry:false};
}
function updateWatchUI(){
  const v=watchConnectionView(),p=state.watchPairing;
  const visible=!!p&&p.session_id===state.session?.id&&!state.session?.ended_at&&state.session?.status!=='paused';
  if($('#watch-progress'))$('#watch-progress').hidden=!visible;
  if($('#watch-progress-text'))$('#watch-progress-text').textContent=v.text;
  if($('#watch-retry'))$('#watch-retry').hidden=!v.retry;
  if($('#watch-dialog-state'))$('#watch-dialog-state').innerHTML=`<p class="watch-status" role="status">${esc(v.text)}</p>${v.code?`<div class="watch-code" aria-label="配对码 ${esc(v.code)}">${esc(v.code.slice(0,4))} ${esc(v.code.slice(4))}</div><p class="fineprint">仅限本次漫游、一次有效。请勿分享给他人。</p>`:''}`;
}
function showWatchPairing(){
  modal(`<p class="eyebrow">WATCH CONNECTION</p><h2>把手表，连接到这一程。</h2><p>在慢行手表应用输入服务地址和配对码，再选择“配对并开始”。</p><label class="watch-address-label">服务地址</label><p class="watch-server">${esc(location.origin)}</p>${location.origin.startsWith('https://')?'':'<p class="notice">当前是本机测试地址。真机需使用手表可访问且证书受信任的 HTTPS 地址。</p>'}<div id="watch-dialog-state"></div><p class="fineprint">保持网页前台。收到心率后可静坐至少30秒，采集参考基线；无需设备也可继续手动反馈。</p><div class="modal-actions"><button class="primary modal-close">返回漫游</button><button class="secondary" id="watch-retry" hidden>重新配对</button><button class="text-button" id="cancel-watch">断开连接</button></div>`);
  updateWatchUI();
}
async function createWatchPairing(){
  if(state.watchPending)return;
  if(!state.session||state.session.ended_at||state.session.status==='paused')throw Error('当前漫游已结束或暂停，不能连接设备');
  if(!$('#watch-relay-consent')?.checked)throw Error('请先同意本次心率临时转发');
  const session_id=state.session.id,account=accountRevision,attempt=++watchAttempt;
  state.watchPending=true;state.watchPairing=null;
  const button=$('#confirm-watch');button.disabled=true;button.textContent='正在生成配对码…';
  try{
    const pairing=await sensors.connectWatch(session_id);
    if(attempt!==watchAttempt)return;
    if(account!==accountRevision||session_id!==state.session?.id||state.session.ended_at||state.session.status==='paused'){sensors.disconnect();return;}
    state.watchPending=false;state.watchPairing={...pairing,session_id};showWatchPairing();
  }catch(error){if(attempt===watchAttempt){if($('#watch-error'))$('#watch-error').textContent=error.message;throw error;}}
  finally{if(attempt===watchAttempt){state.watchPending=false;button.disabled=false;button.textContent='生成配对码';}}
}
function suggestionCard(a){
  const changes=a.changes;
  return `<section class="suggestion" aria-labelledby="suggestion-title"><div class="card-head"><p class="eyebrow">路线调整建议</p>${badge(a.demo?'演示触发':'待你确认',true)}</div><h2 id="suggestion-title">换个走法，也很好。</h2><p class="suggestion-reason">${esc(a.reason)}</p><div class="changes"><div><span>规划步行</span><strong>${changes.distance_saved_m>=0?'少走':'多走'} ${Math.abs(changes.distance_saved_m)}<small> m</small></strong></div><div><span>结束时间</span><strong>${changes.time_saved_min>=0?'提前':'延后'} ${Math.abs(changes.time_saved_min)}<small> 分钟</small></strong></div></div><div class="route-tradeoff"><div><span>＋ 新增停留</span><strong>${changes.added_stops.map(esc).join('、')||'无新增地点'}</strong></div><div><span>－ 将会跳过</span><strong>${changes.skipped_stops.map(esc).join('、')||'保留全部地点'}</strong></div></div>${(a.candidate?.stops||[]).filter(p=>p.category==='美食').map(p=>`<div class="suggestion-dining"><strong>${esc(p.name)}</strong>${commerceInfo(p)}</div>`).join('')}<p class="fineprint">${esc(a.decision_source)} · ${a.expires_at?'有效至 '+esc(new Date(a.expires_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})):'10分钟内有效'} · ${state.trip.data_mode==='demo'?'距离为演示估算':'路线由高德计算'}</p><div class="suggestion-actions"><button class="primary" data-confirm="true">接受调整 ↗</button><button class="secondary" data-confirm="false">保留原路线</button></div><p class="confirmation-note">只有你接受后，行程才会改变。</p></section>`;
}
function journeyPage(){
  if(!state.trip)return empty('先有方向，再慢慢出发','选一座城市，生成行程后就能开启途中伴行。');
  if(!state.session||state.session.ended_at)return heading('ON THE WAY','准备好，就出发。','不需要心率设备，也有一路陪伴。')+`<section class="ready-journey"><p class="eyebrow">${esc(state.trip.preferences.city)} / DAY ${state.day}</p><h2>你的行程已准备好</h2><p>开始后，打卡记录每一站。<br>走累了，随时告诉慢行。</p><button class="primary" id="start-journey">开始第 ${state.day} 天漫游 ↗</button></section>`;
  const s=state.session,d=state.trip.days[s.day-1],current=d.stops[s.current_index],paused=s.status==='paused';
  return heading('ON THE WAY · '+esc(state.trip.preferences.city),'走走，停停，都很好。','有方向，也有随时调整的自由。',`<button class="text-button" id="end-journey">结束漫游 ↗</button>`)+`
  <div class="journey-layout"><div class="journey-main"><section class="current-stop ${paused?'paused':''}"><div class="current-meta"><span>${paused?'行程已暂停':current?'当前一站':'今日行程已走完'}</span><span>已打卡 ${s.current_index} / ${d.stops.length}</span></div><h2>${paused?'先照顾好自己':current?esc(current.name):'把今天，留在手记里。'}</h2><p>${paused?'请停止游览，到安全位置并寻求身边人的帮助。':current?`${esc(current.arrival)} — ${esc(current.departure)} · 计划停留 ${current.duration_min} 分钟`:'今天的节点已全部打卡，可以结束漫游并查看记录。'}</p>${current&&!paused?commerceInfo(current):''}<div class="journey-progress" role="progressbar" aria-label="打卡进度" aria-valuemin="0" aria-valuemax="${d.stops.length}" aria-valuenow="${s.current_index}"><span style="width:${Math.min(100,s.current_index/Math.max(1,d.stops.length)*100)}%"></span></div>${current&&!paused?`<button class="primary" id="checkin">完成此站，继续下一站 <span aria-hidden="true">↗</span></button>`:''}</section>
  ${state.suggestion&&!paused?suggestionCard(state.suggestion):''}
  <section class="feeling-panel"><div class="section-label"><span>现在，感觉怎么样？</span><span>随时说，不必等</span></div>${paused?'<p class="subtitle">普通路线建议已暂停。需要紧急帮助时，请联系当地急救服务。</p>':`<div class="feedback-grid"><button data-feedback="tired"><span class="feedback-icon" aria-hidden="true">⌁</span><strong>轻松一点</strong><small>调整节奏，找处歇脚</small><span class="feedback-arrow" aria-hidden="true">↗</span></button><button data-feedback="hungry"><span class="feedback-icon" aria-hidden="true">◡</span><strong>想吃饭了</strong><small>给下一程补充能量</small><span class="feedback-arrow" aria-hidden="true">↗</span></button></div><p class="fineprint">慢行会说明改线原因和取舍，由你决定是否接受。</p>`}<button class="text-button help-button" id="unwell">身体不适，需要帮助 ↗</button></section>
  ${!paused?`<details class="demo-controls"><summary>试试动态调整 <span>比赛演示</span></summary><p class="fineprint">以下为模拟事件，不代表当前天气或身体状态。</p><div class="toolbar"><button class="secondary" data-feedback="rain">模拟下雨</button><button class="secondary" id="simulate-fatigue">模拟疲劳趋势</button></div></details>`:''}
  </div><aside class="journey-aside"><details class="device-details"><summary><span>连接设备，感受你的节奏<small>可选 · 无设备时使用手动反馈</small></span><span class="expand-mark" aria-hidden="true">＋</span></summary>${sensorCard()}<p class="fineprint">模型授权：${s.model_consent?'已开启':'未开启'}。蓝牙心率在本页读取；Apple Watch经单独授权后临时转发。仅派生特征会按模型授权参与判断。结束会话可撤回本次授权。阈值未经临床验证，不用于诊断。</p></details><section class="card preview-card"><div class="preview-top"><div class="card-head"><h2>今天的方向</h2>${badge('高德地图')}</div></div>${mapView(d.stops)}</section></aside></div>`;
}
async function reportPage(){if(!state.trip)return empty('把今天的风景，留在手记里','完成一次漫游后，这里会记录你的路线与每一次选择。');const r=await api(`/trip/${state.trip.id}/report`);return heading('MEMORIES, AT YOUR PACE','走过的路，都算数。',r.finished?'这段旅程已经结束，谢谢你和慢行一起出发。':'这是当前行程的即时记录，结束后将成为完整手记。',`<button class="secondary" id="export-report">↓ 导出手记</button>`)+stats([['已打卡地点',`${r.visited_stops} / ${r.total_stops}`,'来自手动打卡'],['步行估计',`${r.walked_km.toFixed(2)} km`,'仅已上报的步数推算'],['接受调整',`${r.accepted} 次`,'用户主动确认'],['保留原路线',`${r.rejected} 次`,'尊重你的每个选择']])+`<div class="layout"><section class="card report-hero"><p class="eyebrow">A DAY WELL SPENT</p><div class="report-title">风景值得停留，<br>你的感受也值得。</div><p>${esc(r.preference_note)}</p><p class="fineprint">规划距离 ${r.planned_distance_km.toFixed(1)} km 不等于实际步行。未采集的数据不作推断；未保存原始心率。</p></section><section class="card"><h2>旅程中的选择</h2><ul class="inline-list">${r.events.length?r.events.map(e=>`<li><span>${esc({tired:'想轻松一点',hungry:'希望用餐',rain:'天气变化演示',hr_high_sustained:'持续状态变化',accepted:'接受路线调整',rejected:'保留原路线',checkin:'完成节点打卡',unwell:'报告不适，暂停行程',progress:'进度延迟',state:'状态变化'}[e.type]||e.type)} ${e.demo?'· 演示':''}</span><small>${esc(new Date(e.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}))}</small></li>`).join(''):'<li>还没有行程事件。开始漫游后会记录在这里。</li>'}</ul></section></div>`;}
async function opsPage(){if(state.user?.role!=='admin')throw Error('仅管理员可访问运营工作台');const o=await api('/ops');return heading('BEHIND EVERY GOOD JOURNEY','让好旅程，持续发生。','运营原型 · POI字段审查、反馈聚类与运行记录。')+stats([['地点样本',o.poi_count+' 个','杭州西湖周边'],['待人工核验',o.unverified+' 个','尚未自动核验官网'],['本人反馈事件',Object.values(o.my_feedback).reduce((a,b)=>a+b,0)+' 条','仅当前账号数据'],['任务记录',o.jobs.length+' 次','显示最近10次']])+`<div class="notice">运营页当前提供字段审查与规则聚类。官网变更抓取、人工审核发布和定时调度尚未接入，不会将样本标为已核验。</div><div class="layout"><section class="card"><div class="card-head"><h2>运营任务</h2>${badge('管理员')}</div><h3>POI 数据审查</h3><p class="subtitle">检查字段完整性，输出需要人工核验的记录清单。</p><button class="secondary" data-job="poi_audit" style="margin-top:15px">运行字段审查 →</button><div class="separator"></div><h3>反馈分析</h3><p class="subtitle">汇总当前账号的反馈、接受与拒绝事件，帮助发现体验问题。</p><button class="secondary" data-job="feedback" style="margin-top:15px">运行反馈聚类 →</button>${o.jobs.map(j=>`<div class="job"><h3>${j.job==='poi_audit'?'POI字段审查':'反馈聚类'} ${badge('已完成')}</h3><p>${esc(j.output.summary)}</p><details><summary>查看 ${j.output.items.length} 条结果 · ${esc(j.at.slice(0,16))}</summary><ul>${j.output.items.map(i=>`<li>${esc(i.name||i.type)} · ${esc(i.result??i.count)}${i.missing?.length?' · 缺失 '+esc(i.missing.join('、')):''}</li>`).join('')}</ul></details></div>`).join('')}</section><aside class="card"><h2>服务连接状态</h2><ul class="inline-list"><li>高德路径服务 ${badge(o.providers.maps?'已配置':'演示模式',!o.providers.maps)}</li><li>和风天气 ${badge(o.providers.weather?'已配置':'未配置',!o.providers.weather)}</li><li>DeepSeek 说明生成 ${badge(o.providers.deepseek?'已配置':'规则模板',!o.providers.deepseek)}</li><li>TypeSafe Jev 决策 ${badge(o.providers.jev?'已配置':'规则引擎',!o.providers.jev)}</li></ul><ul class="inline-list">${Object.entries(o.provider_status||{}).map(([name,p])=>`<li>${esc({maps:'地图',weather:'天气',jev:'Jev',deepseek:'DeepSeek'}[name])}<span>${esc({not_checked:'尚未联调',not_configured:'未配置',ok:'最近调用成功',error:'最近调用失败'}[p.status]||p.status)}${p.error_code?' · '+esc(p.error_code):''}</span></li>`).join('')}</ul><p class="fineprint">已配置不代表已验证服务可用。密钥只在服务器保存。Jev已适配TypeSafe官方接口，调用仍需本次会话授权。</p></aside></div><section class="card" style="margin-top:23px"><div class="card-head"><h2>地点数据清单</h2>${badge('全部为演示样本',true)}</div><div class="table-wrap"><table><thead><tr><th>地点</th><th>类型</th><th>演示营业窗口</th><th>数据状态</th><th>参考来源</th></tr></thead><tbody>${state.pois.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.category)}</td><td>${esc(p.open)}—${esc(p.close)}</td><td>${badge('待核验',true)}</td><td><a class="source-link" href="${esc(p.source_url)}" target="_blank" rel="noopener noreferrer">官方入口 ↗</a></td></tr>`).join('')}</tbody></table></div></section>`;}
async function render(){if(state.page==='ops'&&state.user?.role!=='admin'){state.page=state.user?'plan':'auth';history.replaceState(null,'','#'+state.page);}updateAccountUI();destroyRouteMaps();const version=++renderVersion;$('#app').dataset.page=state.page;$$('[data-page]').forEach(b=>{b.classList.toggle('active',b.dataset.page===state.page);if(b.dataset.page===state.page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});$('#page-name').textContent=labels[state.page];if(['ops','report'].includes(state.page))$('#app').innerHTML='<div class="loading">正在整理旅程数据…</div>';try{const html=await ({plan:planPage,trip:tripPage,journey:journeyPage,report:reportPage,ops:opsPage,auth:authPage}[state.page])();if(version!==renderVersion)return;$('#app').innerHTML=(state.offline?'<div class="notice">当前离线，仅可查看缓存行程；联网后才能生成、上报和确认调整。</div>':'')+html;updateSensors();mountRouteMaps(state.trip);}catch(e){if(version===renderVersion)$('#app').innerHTML=`<div class="empty"><h2>暂时没有加载成功</h2><p>${esc(e.message)}</p><button class="secondary" id="retry">重新加载</button></div>`;}}
function navigate(page){if(!labels[page])return;const menu=$('#more-menu');if(menu)menu.open=false;state.page=page;history.replaceState(null,'','#'+page);render();window.scrollTo({top:0});}
function download(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function refreshSession(){if(!state.session)return;state.session=await api('/session/'+state.session.id);localStorage.setItem('mx-session',state.session.id);}
async function feedback(trigger,demo=false){if(!state.session||state.session.ended_at)throw Error('请先开始漫游');const features=trigger==='hr_high_sustained'&&demo?{hr_vs_baseline_pct:30,duration_s:190,cadence_change_pct:-20}:sensors.features();const a=await api('/feedback',{session_id:state.session.id,feedback_type:trigger,features,demo});state.suggestion=a.require_confirm?a:null;await refreshSession();if(!a.require_confirm)toast(a.reason);await render();}
function updateSensors(){updateWatchUI();const s=state.sensor;if(!$('#heart-value'))return;$('#heart-value').innerHTML=`${s.hr??'—'}<small>bpm</small>`;$('#cadence-value').innerHTML=`${s.cadence??'—'}<small>步/分</small>`;$('#sensor-status').textContent=s.source==='watch'?({background:'页面在后台 · 趋势判断已暂停',waiting:'等待手表输入配对码',waiting_for_sample:'手表已配对，等待新心率',unavailable:'连接暂不可用，等待恢复',disconnected:'手表已断开，请重新配对'}[s.watchStatus]||`Apple Watch · ${s.hr==null?'等待新心率':s.calibrating?'静坐采集中…':s.baseline?'参考基线 '+s.baseline+' bpm':'待采集静息参考基线'}`):s.connected?`已连接 · ${s.calibrating?'静坐采集中…':s.baseline?'参考基线 '+s.baseline+' bpm':'待采集静息参考基线'}`:'未连接设备 · 手动反馈模式';$('#sensor-extra').textContent=`估计步数 ${s.steps||0} · ${s.position?'定位精度约 '+Math.round(s.position.accuracy)+'m，地址识别结果见上方。':'定位未启用。'} ${s.source==='watch'?'手表心率经服务端临时转发，不落库、不交给模型。':'蓝牙原始心率不上传。'} 步频算法需实测校准。`;$('#calibrate').disabled=!s.connected||s.hr==null||s.calibrating;const samples=sensors.samples.slice(-50);if(samples.length<2)$('#pulse-line').setAttribute('d','M0 30h350');if(samples.length>1){const min=Math.min(...samples.map(s=>s.value))-3,max=Math.max(...samples.map(s=>s.value))+3;$('#pulse-line').setAttribute('d',samples.map((s,i)=>`${i?'L':'M'}${i/(samples.length-1)*350},${45-(s.value-min)/(max-min)*35}`).join(' '));}}
sensors.addEventListener('change',e=>{state.sensor=e.detail;if(!state.watchPending&&!e.detail.source)state.watchPairing=null;updateSensors();if(e.detail.message)toast(e.detail.message);const f=sensors.features();if(state.session&&!state.session.ended_at&&state.session.status!=='paused'&&f.duration_s>=180&&f.cadence_change_pct<=-15&&Date.now()-lastStateAt>300000){lastStateAt=Date.now();feedback('hr_high_sustained').catch(e=>toast(e.message));}});
$('#app').addEventListener('change',e=>{if(['province','city','district_adcode'].includes(e.target.name))destinationRevision++;if(e.target.name==='province'){state.planProvince=e.target.value;state.planCity='';state.planDistrict='';paintDestination();}else if(e.target.name==='city'){state.planCity=e.target.value;state.planDistrict='';paintDestination();}else if(e.target.name==='district_adcode')state.planDistrict=e.target.value;if(['province','city','district_adcode'].includes(e.target.name))saveDraft();});
$('#app').addEventListener('submit',async e=>{
  if(e.target.id!=='plan-form')return;
  e.preventDefault();if(state.planPending)return;
  const revision=accountRevision;
  const data=Object.fromEntries(new FormData(e.target));
  Object.assign(data,{days:Number(data.days),budget:Number(data.budget),walk_limit_km:Number(data.walk_limit_km),interests:[...state.interests],model_consent:data.model_consent==='on'});
  state.planPending=true;state.planError='';saveDraft();await render();
  try{
    if(revision!==accountRevision)return;
    const trip=await api('/trip/plan',data);
    state.trip=trip;state.trips=[trip,...state.trips.filter(t=>t.id!==trip.id)];state.day=1;state.session=null;state.suggestion=null;sensors.stop();
    try{localStorage.removeItem('mx-session');}catch{}
    cacheTrip();
    state.planPending=false;
    if(state.page==='plan')navigate('trip');else{await render();if(revision===accountRevision)toast('行程已生成，前往「行程」查看。');}
    // History is optional: the new trip and visible controls are already usable.
    try{const history=await api('/trips');if(revision===accountRevision&&state.trip?.id===trip.id)state.trips=history.trips;}catch{}
  }catch(err){if(revision!==accountRevision)return;state.planError=err.message;state.planPending=false;if(state.page==='plan')await render();else toast(err.message);}
});
$('#app').addEventListener('input',e=>{
  const target=e.target;
  if(target.name==='model_consent'){state.planConsent=target.checked;return;}
  if(['province','city','district_adcode'].includes(target.name))return;
  if(!Object.hasOwn(state.draft,target.name)||target.name==='interests')return;
  state.draft[target.name]=target.value;
  if(target.name==='city')state.planCity=target.value;
  if(target.id==='walk-limit')$('#walk-label').textContent=`${target.value} 公里`;
  if($('#preference-summary'))$('#preference-summary').textContent=`${state.draft.companion} · 每日 ${state.draft.walk_limit_km} km · ¥${state.draft.budget}`;
  saveDraft();
});
// Reveal invalid optional fields before the browser moves focus to them.
$('#app').addEventListener('invalid',e=>{const details=e.target.closest('details');if(details)details.open=true;},true);
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.authMode){state.authMode=b.dataset.authMode;render();return;}
  if(b.dataset.page){navigate(b.dataset.page);return;}
  if(b.classList.contains('modal-close')){closeModal();return;}
  if(b.dataset.interest){const v=b.dataset.interest;state.interests=state.interests.includes(v)?state.interests.filter(x=>x!==v):[...state.interests,v];b.classList.toggle('selected');b.setAttribute('aria-pressed',state.interests.includes(v));saveDraft();return;}
  if(b.dataset.city){destinationRevision++;const province=state.regions.find(p=>p.cities.some(c=>c.name===b.dataset.city));state.planProvince=province?.name||state.planProvince;state.planCity=b.dataset.city;state.planDistrict=b.dataset.district||'';saveDraft();navigate('plan');return;}
  if(b.dataset.day){state.day=Number(b.dataset.day);render();return;}
  if(b.dataset.must!==undefined){
    const stop=(state.trip?.days.flatMap(d=>d.stops)||[]).find(s=>s.id===b.dataset.must);if(!stop)return;
    const list=mustVisitList(),at=list.findIndex(m=>m.name===stop.name);
    if(at>=0)list.splice(at,1);
    else{if(list.length>=3)return toast('最多锁定 3 个必去地点');list.push({name:stop.name,lat:stop.lat,lng:stop.lng,category:stop.category,duration_min:stop.duration_min});}
    render();toast(at>=0?`已取消「${stop.name}」的必去标记`:`已锁定「${stop.name}」，点上方按钮重新规划`);return;
  }
  if(b.id==='replan-must'){
    const list=mustVisitList();if(!list.length)return;const p=state.trip.preferences;
    b.disabled=true;b.textContent='正在按必去重新规划…';
    try{
      state.trip=await api('/trip/plan',{city:p.city,date:p.date,days:p.days,budget:p.budget,walk_limit_km:p.walk_limit_km,interests:p.interests,start_time:p.start_time,end_time:p.end_time,companion:p.companion,model_consent:p.model_consent,start_poi:'auto',start_point:p.start_point||undefined,end_point:p.end_point||undefined,must_visit:list});
      state.trips=(await api('/trips')).trips;state.mustVisit=null;state.day=1;state.session=null;state.suggestion=null;cacheTrip();await render();toast('已按必去地点重新规划。');
    }catch(err){b.disabled=false;b.textContent='✦ 按必去重新规划';toast(err.message);}
    return;
  }
  const id=b.id;b.disabled=true;
  try{
    if(id==='account-button')navigate('auth');
    if(id==='logout-button'){await api('/auth/logout',{});await switchAccount(null);navigate('auth');toast('已退出登录');}
    if(id==='retry')await render();
    if(id==='retry-regions')await loadRegions();
    if(id==='export-trip')download('慢行-行程.json',state.trip);
    if(id==='export-report')download('慢行-手记.json',await api(`/trip/${state.trip.id}/report`));
    if(b.dataset.trip){state.trip=await api('/trip/'+b.dataset.trip);state.mustVisit=null;state.day=1;state.session=null;state.suggestion=null;localStorage.removeItem('mx-session');sensors.stop();cacheTrip();navigate('trip');}
    if(id==='start-journey'){
      if(state.session&&!state.session.ended_at){navigate('journey');return;}
      modal(`<h2>开始你的第 ${state.day} 天漫游</h2><p>设备和定位均可跳过。蓝牙心率在本页处理；Apple Watch需另行授权临时转发。触发事件时，将相对变化和持续时间发送到本项目后端，服务端不保存这些健康特征。</p><label class="check-row"><input id="health-model-consent" type="checkbox"><span>可选：允许将心率相对基线变化、步频变化和持续时间发送至配置的TypeSafe Jev服务，辅助状态判断。不同意时仅使用规则引擎。</span></label><div class="modal-actions"><button class="primary" id="confirm-start">同意端侧处理与必要上报，开始</button><button class="secondary modal-close">暂不开始</button></div>`);
    }
    if(id==='confirm-start'){state.session=await api('/session/start',{trip_id:state.trip.id,day:state.day,model_consent:$('#health-model-consent').checked});localStorage.setItem('mx-session',state.session.id);state.suggestion=null;closeModal();navigate('journey');}
    if(b.dataset.feedback)await feedback(b.dataset.feedback,b.dataset.feedback==='rain');
    if(id==='simulate-fatigue')await feedback('hr_high_sustained',true);
    if(id==='unwell'){modal('<h2>先照顾好自己</h2><p>如果您感到胸痛、眩晕或明显不适，请停止游览，到安全位置并向身边的人寻求帮助。需要紧急帮助时可联系当地急救服务。</p><div class="modal-actions"><button class="danger" id="pause-unwell">暂停行程</button><a class="primary" href="tel:120">拨打120（中国大陆）</a></div>');}
    if(id==='pause-unwell'){await feedback('unwell');sensors.stop();closeModal();}
    if(b.dataset.confirm){const r=await api('/session/confirm',{session_id:state.session.id,suggestion_id:state.suggestion.id,accept:b.dataset.confirm==='true'});state.trip=r.trip;state.session=r.session;state.suggestion=null;cacheTrip();toast(r.accepted?'已按你的选择更新行程。':'已保留原路线。');await render();}
    if(id==='checkin'){state.session=await api('/session/checkin',{session_id:state.session.id,stop_id:state.trip.days[state.session.day-1].stops[state.session.current_index].id});state.suggestion=null;toast('已记录打卡');await render();}
    if(id==='end-journey')modal('<h2>把今天，留在手记里？</h2><p>结束后将停止本次设备采集，保留已打卡地点与路线调整记录。</p><div class="modal-actions"><button class="primary" id="confirm-end">结束并生成手记</button><button class="secondary modal-close">继续漫游</button></div>');
    if(id==='confirm-end'){closeModal();state.session=await api('/session/end',{session_id:state.session.id});sensors.stop();state.suggestion=null;navigate('report');}
    if(id==='connect-watch'||id==='watch-retry'){
      if(!state.session||state.session.ended_at)throw Error('请先开始漫游');
      if(state.session.status==='paused')throw Error('行程已暂停，请先照顾自己');
      if(id==='connect-watch'&&state.watchPairing?.session_id===state.session.id&&!watchConnectionView().retry){showWatchPairing();return;}
      modal('<p class="eyebrow">OPTIONAL COMPANION</p><h2>连接 Apple Watch</h2><ol class="watch-steps"><li><strong>安装手表配套应用</strong><span>需要已安装的慢行 watchOS 应用，网页不能直接读取 Apple Health。</span></li><li><strong>输入地址与一次性配对码</strong><span>手机与手表需能访问同一 HTTPS 服务，且信任其证书。</span></li><li><strong>允许读取，等待实时心率</strong><span>保持网页前台；没有读数时仍可手动反馈。</span></li></ol><details class="watch-privacy"><summary>本次会传输什么数据？</summary><p>心率数值和采样时间经 HTTPS 发到本项目服务端，内存只保留最新一条，20秒后清除，不落库、不写日志、不将原始读数交给模型。配对码5分钟有效、仅限一次；连接最长4小时。结束漫游或退出账号即失效。</p></details><label class="check-row"><input id="watch-relay-consent" type="checkbox"><span>同意本次心率临时转发</span></label><p id="watch-error" class="error-inline" role="alert"></p><div class="modal-actions"><button class="primary" id="confirm-watch">生成配对码</button><button class="secondary modal-close">暂不连接</button></div>');
    }
    if(id==='confirm-watch')await createWatchPairing();
    if(id==='view-watch')showWatchPairing();
    if(id==='cancel-watch'){watchAttempt++;state.watchPending=false;state.watchPairing=null;sensors.disconnect();closeModal();updateWatchUI();toast('设备已断开，可以继续手动反馈。');}
    if(id==='connect-hr')await sensors.connect();
    if(id==='calibrate')sensors.calibrate();
    if(id==='motion')await sensors.startMotion();
    if(id==='locate'||id==='locate-plan')await recognizeLocation();
    if(id==='stop-sensors'){clearLocation();sensors.stop();}
    if(b.dataset.job){await api('/ops/run',{job:b.dataset.job});toast('运营任务已完成');await render();}
    if(id==='privacy-button'||id==='privacy-mobile')modal('<h2>你的旅程，你的数据。</h2><p>登录后行程按账号隔离，游客行程使用匿名浏览器Cookie隔离；注册或登录会将本浏览器的游客行程关联到账号。服务端保存行程、打卡与建议选择；原始心率、加速度和定位不持久化。Apple Watch经单独授权后将心率和时间发送到本项目服务端，内存仅保留最新一条、20秒后清除，不写日志、不交给模型。</p><p>蓝牙和运动权限在点击相关按钮后申请。页面打开自动请求一次定位权限，允许后将本次坐标发送给高德转换坐标并识别地址；本项目不落库、不缓存定位，不将定位发送给模型。模型默认关闭；授权开启后才会发送明确说明的必要数据。可随时停止传感器，或结束会话撤回本次模型使用。</p><p>浏览器会缓存最近一份行程供离线查看。服务器数据暂不自动过期，可使用下方按钮删除当前账号（或游客身份）的行程记录。账号本身不会删除。</p><div class="modal-actions"><button class="secondary" id="privacy-stop">停止采集</button><button class="danger" id="delete-data">删除我的行程与记录</button></div>');
    if(id==='privacy-stop'){clearLocation();sensors.stop();toast('采集已停止');}
    if(id==='delete-data')modal('<h2>确认删除本浏览器的数据？</h2><p>将删除所有行程、会话、建议、任务记录和本地缓存。删除后不能恢复。</p><div class="modal-actions"><button class="danger" id="confirm-delete">确认删除</button><button class="secondary modal-close">取消</button></div>');
    if(id==='confirm-delete'){await api('/privacy/delete',{confirm:true});clearLocation();sensors.stop();state.trip=null;state.session=null;state.suggestion=null;state.trips=[];localStorage.removeItem('mx-trip');localStorage.removeItem('mx-session');localStorage.removeItem('mx-plan-draft');state.draft=readDraft();applyDestination(state.draft.province,state.draft.city,state.draft.district_adcode,state.draft.district);state.interests=state.draft.interests;state.planConsent=false;closeModal();navigate('plan');toast('本浏览器的记录已删除');}
  }catch(err){toast(err.message);}finally{b.disabled=false;if(id==='calibrate')updateSensors();}
});
window.addEventListener('offline',()=>{state.offline=true;toast('网络已断开，缓存行程仍可查看。');});
window.addEventListener('online',()=>{state.offline=false;toast('网络已恢复');render();});
async function init(){
  try{state.user=(await api('/auth/me')).user;state.authChecked=true;updateAccountUI();state.config=await api('/config');state.pois=(await api('/pois')).pois;state.trips=(await api('/trips')).trips;const cached=JSON.parse(localStorage.getItem('mx-trip')||'null');state.trip=state.trips.find(t=>t.id===cached?.id)||state.trips[0]||null;if(state.trip)cacheTrip();const sid=localStorage.getItem('mx-session');if(sid){try{state.session=await api('/session/'+sid);if(state.session.trip_id!==state.trip?.id)state.session=null;else if(state.session.pending_suggestion){try{const pending=await api('/suggestion/'+state.session.pending_suggestion);if(!pending.resolved_at&&Date.parse(pending.expires_at)>Date.now())state.suggestion=pending;}catch{}}}catch{localStorage.removeItem('mx-session');}}$('#mode-pill').textContent=state.config.data_mode==='demo'?'演示体验':'实况规划';}
  catch{state.offline=true;try{state.trip=state.authChecked&&localStorage.getItem('mx-trip-owner')===(state.user?.id||'guest')?JSON.parse(localStorage.getItem('mx-trip')||'null'):null;}catch{}toast('服务连接失败，当前可查看已缓存行程。');}
  const page=location.hash.slice(1);state.page=labels[page]?page:'plan';await render();
  // One automatic attempt per page load; rendering/navigation never requests again.
  await Promise.all([recognizeLocation({automatic:true}),loadRegions()]);
}
init();
window.addEventListener('storage',e=>{if(e.key==='mx-account-change')location.reload();});
window.addEventListener('hashchange',()=>{const page=location.hash.slice(1);if(labels[page]&&page!==state.page)navigate(page);});
if('serviceWorker' in navigator&&window.isSecureContext)navigator.serviceWorker.register('/sw.js').catch(()=>{});
