import { cleanStopReason, defaultStopReason } from './stop-reasons.js';
import { routeMapMarkup, mountRouteMaps, destroyRouteMaps } from './route-map.js';
import { Sensors, sensorFeatures } from './sensors.js';
import { pageRoutes, resolvePageRoute } from './page-routes.js';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 行内图标只留三个：都是没有文字的功能按钮（清除或收起、上移、下移）。
const ICONS={
  close:'<path d="M6 6l12 12M18 6 6 18"/>',
  up:'<path d="m6 14 6-6 6 6"/>',
  down:'<path d="m6 10 6 6 6-6"/>'
};
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]||''}</svg>`;
// 行程只排当天。更早生成的行程里可能存着 25:10 这样的时刻，显示成「次日 01:10」。
const dayTime=t=>{const m=/^(\d{2,}):(\d{2})$/.exec(t||'');return m&&Number(m[1])>=24?`次日 ${String(Number(m[1])%24).padStart(2,'0')}:${m[2]}`:t||'';};
const fallbackRegions=[['浙江省','杭州市','宁波市'],['北京市','北京市'],['上海市','上海市'],['广东省','广州市','深圳市'],['四川省','成都市'],['重庆市','重庆市'],['江苏省','南京市','苏州市']].map(([name,...cities])=>({name,cities:cities.map(name=>({name,districts:[]}))}));
const draft=readDraft();
const state={page:'plan',draft,planPending:false,planError:'',planConsent:false,planProvince:draft.province,planCity:draft.city,planDistrict:draft.district_adcode,regions:fallbackRegions,regionsReady:false,regionError:false,trip:null,session:null,suggestion:null,day:1,config:null,pois:[],trips:[],interests:draft.interests,sensor:{},watchPairing:null,watchPending:false,location:null,locationMessage:'',locating:false,user:null,authMode:'login',authChecked:false,offline:false,planStartPoint:null,planEndPoint:null,picker:null,providerTests:{},providerTesting:null,journeyControls:null,transit:{from:null,to:null,result:null,error:'',loading:false},elevation:{loading:false,data:null,error:''},stopDetail:null,journal:{},journalTrip:null,journalDraft:null,summaryLoading:false,summaryError:''};
applyDestination(draft.province,draft.city,draft.district_adcode,draft.district);
const sensors=new Sensors();
let toastTimer,renderVersion=0,lastStateAt=0,locationRequest=0,destinationRevision=0,accountRevision=0,watchAttempt=0;
let useCurrentStart=false,useCurrentEnd=false;
const labels={plan:'规划旅程',trip:'我的行程',journey:'途中伴行',report:'旅行手记',ops:'运营工作台',auth:'登录与注册'};
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4000);}
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
  catch{throw Error('网络连接失败，请检查网络后重试。');}
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
// 地点选择器的搜索表单在弹窗里，不冒泡到 #app，单独监听。
$('#modal').addEventListener('submit',e=>{
  if(e.target.id!=='place-search')return;e.preventDefault();
  const data=Object.fromEntries(new FormData(e.target));
  runPlaceSearch(String(data.keyword||'').trim()).catch(()=>{});
});
// 日记里的照片选择框同样在弹窗里。
$('#modal').addEventListener('change',e=>{
  if(e.target.id!=='journal-file')return;
  handleJournalFiles(e.target.files||[]).catch(()=>{});
});
function heading(title,subtitle='',actions=''){return `<header class="page-head"><div>${subtitle?`<p class="meta">${subtitle}</p>`:''}<h1>${title}</h1></div>${actions}</header>`;}
// 文字标签只给会变化的状态用：已记录、AI 生成、必去、演示。
const label=(text,tone='')=>`<span class="label ${tone}">${esc(text)}</span>`;
// 一排大数字：把「2.8 km」拆成大数字和小单位；不是数字的（如「待核实」）整体用小一号的字。
function figures(items){return `<dl class="figures">${items.map(([title,value,note])=>{const m=/^(¥?[\d.]+(?: \/ [\d.]+)?)\s*(.*)$/.exec(String(value));return `<div class="figure"><dt>${esc(title)}</dt><dd>${m?`<strong>${esc(m[1])}</strong>${m[2]?`<small>${esc(m[2])}</small>`:''}`:`<strong class="word">${esc(value)}</strong>`}${note?`<span class="note">${esc(note)}</span>`:''}</dd></div>`;}).join('')}</dl>`;}
function paintMode(){const pill=$('#mode-pill');if(!state.config)return;const demo=state.config.data_mode==='demo';pill.textContent=demo?'演示数据':'实时数据';pill.dataset.mode=demo?'demo':'live';pill.hidden=false;}
function updateAccountUI(){
  // 只收起菜单里的入口。<main> 停在运营页时也带 data-page="ops"，不能连它一起藏掉。
  for(const node of $$('.more-menu-content [data-page="ops"]'))node.hidden=state.user?.role!=='admin';
  $('#account-button').textContent=state.user?state.user.username:'登录';
  $('#account-button').title=state.user?.role==='admin'?'管理员账号':'我的账号';
  $('#logout-button').hidden=!state.user;
}
async function switchAccount(user){
  state.providerTests={};state.providerTesting=null;state.journeyControls=null;
  accountRevision++;cancelPendingWatch();state.watchPairing=null;closeModal();renderVersion++;state.planPending=false;state.planError='';state.planConsent=false;state.user=user;state.trip=null;state.trips=[];state.session=null;state.suggestion=null;
  destroyRouteMaps();sensors.stop();clearLocation();
  localStorage.removeItem('mx-trip');localStorage.removeItem('mx-trip-owner');localStorage.removeItem('mx-session');
  $('#app').innerHTML='<div class="loading">正在加载账号行程…</div>';
  localStorage.setItem('mx-account-change',String(Date.now())+Math.random());updateAccountUI();
  try{state.trips=(await api('/trips')).trips;state.trip=state.trips[0]||null;state.offline=false;if(state.trip)cacheTrip();}
  catch{state.offline=true;toast('账号已切换，行程暂时无法加载，请联网后刷新。');}
}
function authPage(){
  if(state.user)return `<section class="account"><p class="meta">${state.user.role==='admin'?'管理员账号':'行程已保存在这个账号里'}</p><h1>你好，${esc(state.user.username)}</h1><div class="toolbar"><button class="primary" data-page="plan">去规划</button>${state.user.role==='admin'?'<button class="secondary" data-page="ops">运营工作台</button>':''}</div></section>`;
  const register=state.authMode==='register';
  return `<section class="auth"><div class="segmented" aria-label="选择登录或注册"><button type="button" data-auth-mode="login" aria-pressed="${!register}">登录</button><button type="button" data-auth-mode="register" aria-pressed="${register}">注册</button></div><h1>${register?'创建账号':'欢迎回来'}</h1><p class="meta">${register?'现在的游客行程会一起存进新账号。':'登录后，行程和手记换台设备也能接着看。'}</p><form id="auth-form"><label class="field"><span class="field-label">用户名</span><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="32" pattern="[A-Za-z0-9_]{3,32}" placeholder="字母、数字或下划线" required></label><label class="field"><span class="field-label">密码</span><input name="password" type="password" autocomplete="${register?'new-password':'current-password'}" minlength="${register?8:1}" maxlength="128" placeholder="${register?'至少 8 位':'请输入密码'}" required></label>${register?'<label class="field"><span class="field-label">再输一次密码</span><input name="confirm_password" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="再输一次" required></label>':''}<p id="auth-error" class="error-inline" role="alert"></p><button type="submit" class="primary wide" id="auth-submit">${register?'注册并登录':'登录'}</button></form><button type="button" class="text-button" data-page="plan">先不登录，直接规划</button></section>`;
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
  finally{if(form.isConnected){button.disabled=false;button.textContent=register?'注册并登录':'登录';}}
});
function mapView(stops){
  if(!state.trip||!stops?.length)return '<div class="map-empty">生成行程后，这里会显示地图和路线。</div>';
  const day=state.trip.days.find(d=>d.stops===stops)?.day||state.day;
  return routeMapMarkup(state.trip,day);
}
function routeLibrary(){const packs=new Map();for(const t of state.trips)if(t.route_pack&&!packs.has(t.route_pack.adcode))packs.set(t.route_pack.adcode,t);return `<section class="section"><h2 class="section-title">去过的地方</h2><ul class="rows">${[...packs.values()].map(t=>`<li class="row"><div class="row-main"><strong>${esc(t.preferences.city)}${t.preferences.district?' · '+esc(t.preferences.district):''}</strong><span class="meta">${t.route_pack.poi_count} 个地点 · ${esc(t.route_pack.generated_at.slice(0,10))}</span></div><div class="row-actions"><button type="button" class="link-btn" data-trip="${esc(t.id)}">查看</button><button type="button" class="link-btn" data-city="${esc(t.preferences.city)}" data-district="${esc(t.preferences.district_adcode||'')}">再规划</button></div></li>`).join('')}</ul></section>`;}
function locationPanel(planning){return `<div class="loc"><div class="loc-body" id="location-result" role="status" aria-live="polite">${locationResult()}</div><button type="button" class="link-btn" id="${planning?'locate-plan':'locate'}" ${state.locating?'disabled':''}>${state.locating?'定位中…':'重新定位'}</button></div>`;}
function locationResult(){
  if(state.locationMessage)return `<p>${esc(state.locationMessage)}</p>`;
  const l=state.location;if(!l)return '<p>还没有定位</p>';
  const note=!l.supported_city?'演示模式只能规划杭州':l.applied?'已设为目的地':l.preserved_manual?'目的地保持你选的不变':'';
  return `<p><strong>${esc(l.city)} · ${esc(l.district)}</strong>${note?` <span class="meta">${note}</span>`:''}</p><p class="meta">${esc(l.address)}${typeof l.elevation==='number'?` · 海拔约 ${l.elevation} 米`:''}</p>${l.nearby?.length?`<p class="meta">附近：${l.nearby.map(p=>esc(p.name)).join('、')}</p>`:''}${l.dynamic_planning&&l.position?`<div class="loc-toggles"><label class="check-row"><input type="checkbox" id="use-start-point"${useCurrentStart?' checked':''}><span>从这里出发</span></label><label class="check-row"><input type="checkbox" id="use-end-point"${useCurrentEnd?' checked':''}><span>结束回到这里</span></label></div>`:''}`;
}
function paintLocation(){if($('#location-result'))$('#location-result').innerHTML=locationResult();for(const id of ['#locate-plan','#locate']){const b=$(id);if(b){b.disabled=state.locating;b.textContent=state.locating?'定位中…':'重新定位';}}}
function clearLocation(){locationRequest++;state.location=null;useCurrentStart=false;useCurrentEnd=false;state.locationMessage='定位已清除。';state.locating=false;paintLocation();}
async function recognizeLocation({automatic=false}={}){
  if(state.locating)return;
  const request=++locationRequest;state.locating=true;state.location=null;useCurrentStart=false;useCurrentEnd=false;state.locationMessage='正在获取位置，请允许浏览器定位…';paintLocation();
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
    // 顺手取一次当前海拔。高程是附加信息，失败只影响这一行，不影响定位与地址识别。
    if(result.dynamic_planning&&result.position){
      try{
        const profile=await api('/elevation',{points:[{name:'当前位置',lat:result.position.lat,lng:result.position.lng}]});
        result.elevation=profile.summary?.min_m??null;
      }catch{result.elevation=null;}
      if(request!==locationRequest)return;
    }
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
function destinationHint(){return state.regionError?'城市列表没加载出来，可以重试，或直接用定位。':state.regionsReady||state.config?.data_mode==='demo'?'':'正在加载城市列表…';}
function destinationFields(){
 const options=destinationOptions();
 // 演示模式只有杭州一个选项，下拉框没有意义：直接写明，下拉框保留在 DOM 里供表单提交。
 const fixed=state.config?.data_mode==='demo';
 return `<div class="field ${fixed?'':'stack'}"><span class="field-label">去哪儿</span>${fixed?`<div class="dest-fixed"><strong>${esc(state.planCity)}</strong><span class="meta">演示模式只有杭州</span></div>`:''}<div class="dest-grid" ${fixed?'hidden':''}><select name="province" aria-label="省份" required>${options.province}</select><select name="city" aria-label="城市" required>${options.city}</select><select name="district_adcode" aria-label="区县">${options.district}</select></div><small class="note" id="city-hint">${destinationHint()}</small><button type="button" class="text-button" id="retry-regions" ${state.regionError?'':'hidden'}>重新加载城市列表</button></div>`;
}
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
  const radios=(name,values,current)=>`<div class="segmented" role="radiogroup">${values.map(([value,label])=>`<label><input type="radio" name="${name}" value="${esc(value)}" ${String(current)===String(value)?'checked':''}><span>${esc(label)}</span></label>`).join('')}</div>`;
  const recent=state.trips.length?`<section class="section"><h2 class="section-title">最近的行程</h2><div class="rows">${state.trips.slice(0,3).map(t=>`<button class="row" data-trip="${esc(t.id)}"><span class="row-main"><strong>${esc(t.preferences.city)}</strong><span class="meta">${esc(t.preferences.date)} · ${t.preferences.days} 天</span></span></button>`).join('')}</div></section>`:'';
  const side=recent+(state.trips.some(t=>t.route_pack)?routeLibrary():'');
  return `<div class="plan-layout ${side?'':'solo'}"><form id="plan-form" class="plan-form" aria-busy="${state.planPending}"><h1>想去哪儿走走？</h1><h2 class="sr-only">定制你的旅程</h2>
    <div class="field"><span class="field-label">定位</span>${locationPanel(true)}</div>
    ${destinationFields()}
    <label class="field"><span class="field-label">哪天出发</span><span class="temporal-control"><input name="date" aria-label="旅行日期" type="date" value="${esc(d.date)}" required></span></label>
    <div class="field"><span class="field-label">玩几天</span>${radios('days',[[1,'1 天'],[2,'2 天']],d.days)}</div>
    <div class="field"><span class="field-label">想看什么 <small>可多选</small></span><div class="toggles">${['自然','人文','建筑','展览','美食'].map(v=>`<button type="button" class="toggle ${state.interests.includes(v)?'selected':''}" data-interest="${v}" aria-pressed="${state.interests.includes(v)}">${v}</button>`).join('')}</div></div>
    <div class="field"><span class="field-label">和谁去</span>${radios('companion',['独自','情侣','亲子','长辈同行'].map(v=>[v,v]),d.companion)}</div>
    <label class="field"><span class="field-label">每天最多走</span><span class="range"><input name="walk_limit_km" id="walk-limit" type="range" min="1" max="15" step="1" value="${esc(d.walk_limit_km)}"><strong id="walk-label">${esc(d.walk_limit_km)} 公里</strong></span></label>
    <div class="field"><span class="field-label">几点到几点</span><span class="time-pair"><span class="temporal-control"><input name="start_time" aria-label="几点出发" type="time" value="${esc(d.start_time)}" required></span><span aria-hidden="true">—</span><span class="temporal-control"><input name="end_time" aria-label="几点结束" type="time" value="${esc(d.end_time)}" required></span></span></div>
    <label class="field"><span class="field-label">总预算（元）</span><input name="budget" type="number" inputmode="numeric" min="0" max="10000" value="${esc(d.budget)}" required></label>
    ${startEndFields()}
    <label class="check-row model-consent"><input name="model_consent" type="checkbox" ${state.planConsent?'checked':''}><span><strong>是否将兴趣和行程节点发送给 DeepSeek</strong><small>用来生成地点说明与结束后的收尾文字。关着也能正常规划。</small></span></label>
    <div class="cta-bar dock"><button class="primary generate" type="submit" id="generate-button" ${state.planPending?'disabled':''}>${state.planPending?'<span class="spinner" aria-hidden="true"></span>正在生成…':'生成行程'}</button></div>
    <div id="plan-error" class="error-inline" role="alert">${esc(state.planError)}</div>
    ${state.planPending?'<p class="note" role="status">正在找地点、算步行路线，大概要几十秒。可以先去别的页面，好了会提醒你。</p>':''}
  </form>${side?`<aside class="plan-side">${side}</aside>`:''}</div>`;
}
function empty(title){return `<section class="empty"><h1>${title}</h1><button class="primary" data-page="plan">去规划</button></section>`;}
// 参考人均和评分：只列出确实有的值，没有的不写「暂无」。
function commerceValues(p){
  const cost=typeof p.per_capita_cost==='number'&&Number.isFinite(p.per_capita_cost)&&p.per_capita_cost>0?p.per_capita_cost:null;
  const rating=typeof p.rating==='number'&&Number.isFinite(p.rating)&&p.rating>0&&p.rating<=5?p.rating:null;
  return [cost!==null?`<span>参考人均 <strong>¥${esc(cost.toFixed(2).replace(/\.00$/,''))}</strong></span>`:'',rating!==null?`<span>评分 <strong>${esc(rating.toFixed(1))}</strong></span>`:''].filter(Boolean);
}
function commerceInfo(p,{compact=false}={}){
  if(p.category!=='美食'&&p.per_capita_cost==null&&p.rating==null)return '';
  const values=commerceValues(p);
  if(!values.length)return compact?'':'<div class="commerce-info"><span>还没有价格和评分</span></div>';
  return `<div class="commerce-info">${values.join('')}</div>`;
}
function diningPlaces(trip){
  const places=(trip.poi_catalog||[]).filter(p=>p.category==='美食');
  if(!places.length)return '';
  const inDay=new Set((trip.days[state.day-1]?.stops||[]).map(stop=>stop.id));
  const source=places.find(p=>p.commerce_source)?.commerce_source;
  return `<section class="section"><h2 class="section-title">附近的餐厅<span class="section-aside">${places.length} 家</span></h2><ul class="rows">${places.map(p=>`<li class="row"><div class="row-main"><strong>${esc(p.name)}</strong>${commerceInfo(p)}<p class="meta clamp">${esc(p.description)}</p></div><div class="row-actions">${inDay.has(p.id)?'<span class="meta">已在当天行程里</span>':`<button type="button" class="link-btn" data-add-stop="${esc(p.id)}">加进第 ${state.day} 天</button>`}<button type="button" class="link-btn" data-stop-detail="${esc(p.id)}">详情</button>${p.source_url?`<a class="link-btn" href="${esc(p.source_url)}" target="_blank" rel="noopener noreferrer">高德</a>`:''}</div></li>`).join('')}</ul>${source?`<p class="note">人均和评分来自${esc(source)}，仅供参考。</p>`:''}</section>`;
}
function mustVisitList(){if(!state.mustVisit)state.mustVisit=[...(state.trip?.preferences?.must_visit||[])].map(m=>({name:m.name,lat:m.lat,lng:m.lng,category:m.category,duration_min:m.duration_min}));return state.mustVisit;}
function timeline(day,stops=day.stops,pending=false){const lockedNames=new Set(mustVisitList().map(m=>m.name)),last=stops.filter(p=>p.category!=='终点').length-1;return `<ol class="timeline" data-day="${day.day}">${stops.map((p,index)=>{
 const reason=cleanStopReason(p.recommendation_reason,p.name)||defaultStopReason(p,state.trip?.preferences);
 const previous=index?stops[index-1]:state.trip?.preferences?.start_point;
 const locked=lockedNames.has(p.name);
 // 从上一站走过来要多久、多远。顺序还没保存时这些数是旧的，不显示。
 const leg=!pending&&p.leg?.distance_m>0?`<li class="leg">步行 ${p.leg.duration_min} 分钟 · ${p.leg.distance_m} m</li>`:'';
 const facts=[p.category?`<span>${esc(p.category)}</span>`:'',p.duration_min>0?`<span>停留 ${p.duration_min} 分钟</span>`:'',...commerceValues(p)].join('');
 // 终点由规划时的设置决定，始终在最后，不参与排序。
 const move=p.category==='终点'?'':`<span class="stop-move"><button type="button" class="icon-btn" data-stop-move="-1" data-stop="${esc(p.id)}" aria-label="上移" ${index===0?'disabled':''}>${icon('up')}</button><button type="button" class="icon-btn" data-stop-move="1" data-stop="${esc(p.id)}" aria-label="下移" ${index>=last?'disabled':''}>${icon('down')}</button></span>`;
 return `${leg}<li class="stop"><div class="stop-head"><span class="stop-no">${String(index+1).padStart(2,'0')}</span>${p.arrival&&!pending?`<time>${esc(dayTime(p.arrival))}</time>`:''}<h3 class="stop-name">${esc(p.name)}${locked?label('必去'):''}</h3></div>${facts?`<div class="stop-facts">${facts}</div>`:''}<p class="stop-desc">${esc(reason)}</p><div class="stop-actions">${previous?`<a class="link-btn" href="${esc(amapNavigation(previous,p))}" target="_blank" rel="noopener noreferrer">导航</a>`:''}<button type="button" class="link-btn" data-stop-detail="${esc(p.id)}">详情</button><button type="button" class="link-btn" data-must="${esc(p.id)}" aria-pressed="${locked}" aria-label="${locked?'取消必去':'设为必去'}">必去</button>${p.category==='终点'?'':`<button type="button" class="link-btn" data-stop-remove="${esc(p.id)}">移出</button>`}${move}</div></li>`;
}).join('')}</ol>`;}

// ---------------- 景点详情与增删 ----------------
// 高德 URI 导航。官方文档写明「途径点只在驾车模式下有效」，所以步行无法把整天串成
// 一条带途经点的导航，只能一站一段地给链接。坐标本身已是 GCJ-02，不需要 coordinate 参数。
function amapNavigation(from,to){
  const point=p=>`${p.lng},${p.lat}${p.name?','+encodeURIComponent(String(p.name).replace(/,/g,' ')):''}`;
  return `https://uri.amap.com/navigation?from=${point(from)}&to=${point(to)}&mode=walk&src=manxing&callnative=1`;
}
const findStop=id=>(state.trip?.days||[]).flatMap(day=>day.stops).find(stop=>stop.id===id)||(state.trip?.poi_catalog||[]).find(poi=>poi.id===id)||state.pois.find(poi=>poi.id===id)||null;
const dayStops=()=>state.trip?.days?.[state.day-1]?.stops||[];
// 已经在行程里的地点只回传 id：服务端会原样复用（保住 id），否则每次编辑都会给
// 用户自己加的地点换一个新 id，把日记的键（行程:天:站点）打断。
// 候选池里的地点同理，服务端以池内事实为准，客户端没法借编辑接口改票价和营业时间。
function stopPayload(stop){
  if(!stop)return null;
  const inTrip=(state.trip?.days||[]).some(day=>day.stops.some(item=>item.id===stop.id));
  const known=inTrip||(state.trip?.poi_catalog||[]).some(poi=>poi.id===stop.id)||state.pois.some(poi=>poi.id===stop.id);
  return known?{id:stop.id}:{name:stop.name,lat:stop.lat,lng:stop.lng,category:stop.category,duration_min:stop.duration_min,indoor:stop.indoor===true};
}
async function saveStops(list,{day=state.day,autoPlace}={}){
  const revision=accountRevision;
  const stops=list.filter(Boolean).filter(stop=>stop.id!=='destination');
  try{
    // auto_place：新加的那一站在列表里的下标，由服务端挑位置（餐厅赶饭点，其它地点挑最顺路的）。
    const result=await api(`/trip/${state.trip.id}/stops`,{day,stops,...(autoPlace?{auto_place:stops.indexOf(autoPlace)}:{})});
    if(revision!==accountRevision)return false;
    state.trip=result.trip;state.day=day;state.mustVisit=null;state.suggestion=null;state.stopDetail=null;state.reorder=null;closeModal();cacheTrip();
    await render();
    const placed=result.placed?`已把「${result.placed.name}」排在第 ${result.placed.index+1} 站${result.placed.meal?`，正好是${result.placed.meal}时间`:'，这个位置最顺路'}`:'行程已更新';
    // 服务端不会因为超约束就悄悄删站，只把问题列出来，这里先说第一条。
    toast(result.warnings?.length?`${result.placed?placed+'。':''}${result.warnings[0]}`:placed);
    return true;
  }catch(error){toast(error.message);return false;}
}
// 调整顺序先只改本地：实况模式下每换一次相邻两站都要重新请求步行路线，攒到「保存顺序」时一次算完。
function orderedStops(){
  const stops=dayStops(),ids=state.reorder?.key===viewKey()?state.reorder.ids:null;
  if(!ids)return stops;
  const moved=ids.map(id=>stops.find(stop=>stop.id===id)).filter(Boolean),rest=stops.filter(stop=>!ids.includes(stop.id));
  // 行程在别处变过（比如途中接受了改线）时，本地顺序对不上，直接作废。
  return moved.length===ids.length&&rest.every(stop=>stop.id==='destination')?[...moved,...rest]:stops;
}
function moveStop(id,delta){
  const list=orderedStops().filter(stop=>stop.id!=='destination'),from=list.findIndex(stop=>stop.id===id),to=from+delta;
  if(from<0||to<0||to>=list.length)return;
  [list[from],list[to]]=[list[to],list[from]];
  const ids=list.map(stop=>stop.id),saved=dayStops().filter(stop=>stop.id!=='destination').map(stop=>stop.id);
  state.reorder=ids.join('\n')===saved.join('\n')?null:{key:viewKey(),ids};
  paintItinerary();
}
function itinerary(day){
  const stops=orderedStops(),pending=stops!==day.stops;
  return `${pending?`<div class="notice"><span>顺序改了，保存后重新计算到达时间</span><span class="bar-actions"><button type="button" class="secondary" id="reorder-cancel">撤销</button><button type="button" class="primary" id="reorder-save">保存顺序</button></span></div>`:''}${timeline(day,stops,pending)}<button type="button" class="secondary wide" id="add-place">添加地点</button>`;
}
function paintItinerary(){const day=state.trip?.days?.[state.day-1];if(day&&$('#itinerary'))$('#itinerary').innerHTML=itinerary(day);}
async function removeStop(id){
  const rest=orderedStops().filter(stop=>stop.id!==id);
  if(rest.length<2)return toast('每天至少要保留两个地点，可以先把别的地点加进来');
  await saveStops(rest.map(stopPayload));
}
async function addStop(place){
  const payload=stopPayload(place);
  if(!payload)return;
  const current=orderedStops().filter(stop=>stop.id!=='destination');
  if(current.some(stop=>stop.id===place.id||stop.name===place.name))return toast('这个地点已经在当天行程里了');
  if(current.length>=8)return toast('一天最多 8 个地点，先移出一个再加');
  await saveStops([...current.map(stopPayload),payload],{autoPlace:payload});
}
// 添加地点时可选的候选：这次检索到、但没排进当天的地点，离路线近的在前。
function stopCandidates(){
  const inDay=orderedStops(),taken=new Set(inDay.flatMap(stop=>[stop.id,stop.name]));
  const pool=state.trip?.poi_catalog?.length?state.trip.poi_catalog:state.pois;
  const meters=(a,b)=>Math.hypot((a.lng-b.lng)*111000*Math.cos((a.lat+b.lat)*Math.PI/360),(a.lat-b.lat)*111000);
  return pool.filter(poi=>!taken.has(poi.id)&&!taken.has(poi.name)).map(poi=>({poi,away:Math.min(...inDay.map(stop=>meters(stop,poi)))})).sort((a,b)=>a.away-b.away).slice(0,12);
}
function showStopDetail(id){
  if(!findStop(id))return;
  state.stopDetail={id,elevation:null,loading:true};
  modal(stopDetailMarkup());
  loadStopElevation(findStop(id));
}
function stopDetailMarkup(){
  const detail=state.stopDetail;if(!detail)return '';
  const stop=findStop(detail.id);if(!stop)return '';
  const stops=dayStops(),index=stops.findIndex(item=>item.id===stop.id),scheduled=index>=0;
  const previous=scheduled?(index>0?stops[index-1]:state.trip?.preferences?.start_point):null;
  const next=scheduled?stops[index+1]:null;
  const link=`https://uri.amap.com/marker?position=${stop.lng},${stop.lat}&name=${encodeURIComponent(stop.name)}&coordinate=gaode&callnative=0`;
  const locked=mustVisitList().some(item=>item.name===stop.name);
  const row=(label,value)=>`<li><span>${label}</span><strong>${value}</strong></li>`;
  return `<p class="meta">${[esc(stop.category),stop.indoor?'室内':'',locked?'必去':''].filter(Boolean).join(' · ')}</p><h2>${esc(stop.name)}</h2>${stop.description?`<p>${esc(stop.description)}</p>`:''}
  <ul class="kv">
    ${scheduled&&stop.arrival?row('时间',`${esc(dayTime(stop.arrival))} — ${esc(dayTime(stop.departure))} · 停留 ${stop.duration_min} 分钟`):''}
    ${scheduled&&stop.leg?.distance_m?row('从上一站走过来',`${stop.leg.distance_m} m · ${stop.leg.duration_min} 分钟`):''}
    ${stop.per_capita_cost!=null||stop.rating!=null?row('参考人均 / 评分',`${stop.per_capita_cost!=null?'¥'+stop.per_capita_cost:'未知'} / ${stop.rating!=null?stop.rating+' 分':'未知'}`):''}
    ${stop.reservation?row('开放与预约',esc(stop.reservation)):''}
    ${row('海拔',detail.loading?'查询中…':typeof detail.elevation==='number'?`约 ${detail.elevation} 米`:'查不到')}
    ${row('坐标',`GCJ-02 ${stop.lng.toFixed(5)}, ${stop.lat.toFixed(5)}`)}
  </ul>
  <div class="modal-actions">${previous?`<a class="primary" href="${esc(amapNavigation(previous,stop))}" target="_blank" rel="noopener noreferrer">导航到这里</a>`:''}${next?`<a class="secondary" href="${esc(amapNavigation(stop,next))}" target="_blank" rel="noopener noreferrer">去下一站</a>`:''}<a class="secondary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">在高德里看</a></div>
  <div class="modal-actions">${scheduled?`<button type="button" class="secondary" data-must="${esc(stop.id)}">${locked?'取消必去':'设为必去'}</button>${stop.category==='终点'?'':`<button type="button" class="danger" data-stop-remove="${esc(stop.id)}">移出当天行程</button>`}`:`<button type="button" class="primary" data-add-stop="${esc(stop.id)}">加进第 ${state.day} 天</button>`}</div>`;
}
async function loadStopElevation(stop){
  const id=stop.id;
  try{
    const profile=await api('/elevation',{points:[{name:stop.name,lat:stop.lat,lng:stop.lng}]});
    if(state.stopDetail?.id!==id)return;
    state.stopDetail.elevation=profile.summary?.min_m??null;
  }catch{/* 海拔是附加信息，查不到就不显示，不影响详情其它内容 */}
  if(state.stopDetail?.id!==id)return;
  state.stopDetail.loading=false;
  if($('#modal').open)repaintStopDetail();
}
function repaintStopDetail(){if(state.stopDetail&&$('#modal').open)$('#modal-content').innerHTML=stopDetailMarkup();}

// ---------------- 漫游日记（文字 + 照片） ----------------
const JOURNAL_TEXT_MAX=1200,JOURNAL_PHOTOS_MAX=6;
async function loadJournal(){
  if(!state.trip){state.journal={};state.journalTrip=null;return;}
  state.journalTrip=state.trip.id;
  try{const {entries}=await api(`/trip/${state.trip.id}/journal`);state.journal=Object.fromEntries(entries.map(entry=>[`${entry.day}:${entry.stop_id}`,entry]));}
  catch{state.journal={};}
}
const journalFor=(day,stopId)=>state.journal[`${day}:${stopId}`]||null;
function journalBlock(day,stop){
  const entry=journalFor(day,stop.id);
  return `<section class="section"><h2 class="section-title"><span>这一站的日记${entry?label('已记录'):''}</span></h2>
  ${entry?.text?`<p class="journal-text prose">${esc(entry.text)}</p>`:''}
  ${entry?.photos?.length?`<div class="journal-photos">${entry.photos.map(photo=>`<img src="${esc(photo.url)}" alt="${esc(stop.name)}的照片" loading="lazy">`).join('')}</div>`:''}
  <button type="button" class="secondary" id="edit-journal">${entry?'修改日记':'写两句，拍几张'}</button></section>`;
}
function journalEditor(){
  const draft=state.journalDraft;if(!draft)return '';
  return `<h2>${esc(draft.stop_name)}</h2>
  <label class="field"><span class="field-label">这一刻</span><textarea id="journal-text" name="journal-text" rows="5" maxlength="${JOURNAL_TEXT_MAX}" placeholder="看见了什么，想记住什么…">${esc(draft.text)}</textarea></label>
  ${draft.photos.length?`<div class="journal-photos">${draft.photos.map((photo,index)=>`<figure class="journal-photo"><img src="${esc(photo.url)}" alt="第 ${index+1} 张待保存的照片"><button type="button" class="text-button" data-journal-photo-remove="${index}">删除这张</button></figure>`).join('')}</div>`:''}
  <label class="field"><span class="field-label">照片 <small>${draft.photos.length} / ${JOURNAL_PHOTOS_MAX} 张</small></span><input type="file" id="journal-file" accept="image/jpeg,image/png,image/webp" multiple ${draft.photos.length>=JOURNAL_PHOTOS_MAX?'disabled':''}></label>
  <p class="error-inline" role="alert">${esc(draft.error||'')}</p>
  <div class="modal-actions"><button type="button" class="primary" id="save-journal" ${draft.busy?'disabled':''}>${draft.busy?'正在保存…':'保存日记'}</button><button type="button" class="secondary modal-close">取消</button></div>`;
}
// 弹窗里的文本框不在 #app 里，没有对应的 input 监听，所以每次重绘或保存前都要
// 先把它的当前值收回草稿——否则加照片重绘一次，用户刚打的字就没了。
function syncJournalText(){
  const textarea=$('#journal-text');
  if(textarea&&state.journalDraft)state.journalDraft.text=String(textarea.value??'');
}
function paintJournal(){if(state.journalDraft&&$('#modal').open)$('#modal-content').innerHTML=journalEditor();}
function openJournal(day,stop){
  const entry=journalFor(day,stop.id);
  state.journalDraft={day,stop_id:stop.id,stop_name:stop.name,text:entry?.text||'',photos:(entry?.photos||[]).map(photo=>({id:photo.id,url:photo.url})),busy:false,error:''};
  modal(journalEditor());
}
function imageElement(file){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file),image=new Image();
    image.onload=()=>{URL.revokeObjectURL(url);resolve(image);};
    image.onerror=()=>{URL.revokeObjectURL(url);reject(Error('这张图片读不出来，换一张再试'));};
    image.src=url;
  });
}
// 先在本机压到长边 1280，再按 JPEG 0.82 编码：手机原图动辄好几 MB，
// 直接上传会撞到请求上限，存在 SQLite／设备存储里也不合适。
async function shrinkPhoto(file){
  if(!/^image\//.test(file.type||''))throw Error('只能选择图片文件');
  const source=typeof createImageBitmap==='function'?await createImageBitmap(file):await imageElement(file);
  const width=source.width||1,height=source.height||1,scale=Math.min(1,1280/Math.max(width,height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
  canvas.getContext('2d').drawImage(source,0,0,canvas.width,canvas.height);
  source.close?.();
  return canvas.toDataURL('image/jpeg',0.82);
}
async function handleJournalFiles(files){
  const draft=state.journalDraft;if(!draft||!state.trip)return;
  syncJournalText();
  for(const file of [...files]){
    if(draft.photos.length>=JOURNAL_PHOTOS_MAX){toast(`每个地点最多 ${JOURNAL_PHOTOS_MAX} 张照片`);break;}
    draft.busy=true;draft.error='';paintJournal();
    try{
      const data=await shrinkPhoto(file);
      const result=await api('/journal/photo',{trip_id:state.trip.id,day:draft.day,stop_id:draft.stop_id,data});
      draft.photos.push({id:result.photo.id,url:result.photo.url});
      state.journal[`${draft.day}:${draft.stop_id}`]=result.entry;
    }catch(error){draft.error=error.message;}
    draft.busy=false;paintJournal();
  }
}
async function removeJournalPhoto(index){
  const draft=state.journalDraft;if(!draft)return;
  const photo=draft.photos[index];if(!photo)return;
  syncJournalText();
  draft.busy=true;draft.error='';paintJournal();
  try{
    const result=await api('/journal/photo/delete',{photo_id:photo.id});
    draft.photos.splice(index,1);
    if(result.entry)state.journal[`${draft.day}:${draft.stop_id}`]=result.entry;
    else delete state.journal[`${draft.day}:${draft.stop_id}`];
  }catch(error){draft.error=error.message;}
  draft.busy=false;paintJournal();
}
async function saveJournal(){
  const draft=state.journalDraft;if(!draft)return;
  syncJournalText();
  draft.busy=true;draft.error='';paintJournal();
  try{
    const result=await api('/journal',{trip_id:state.trip.id,day:draft.day,stop_id:draft.stop_id,text:draft.text});
    if(result.entry)state.journal[`${draft.day}:${draft.stop_id}`]=result.entry;
    else delete state.journal[`${draft.day}:${draft.stop_id}`];
    state.journalDraft=null;closeModal();await render();
    toast(result.entry?'日记已保存':'没有文字也没有照片，这条日记已经删掉');
  }catch(error){draft.error=error.message;draft.busy=false;paintJournal();}
}

// ---------------- 走完之后的总结（DeepSeek） ----------------
async function writeSummary(){
  if(state.summaryLoading||!state.trip)return;
  state.summaryLoading=true;state.summaryError='';await render();
  try{
    await api(`/trip/${state.trip.id}/summary`,{});
    state.trip.summary=null;state.trip=(await api('/trip/'+state.trip.id))||state.trip;
  }catch(error){state.summaryError=error.message;}
  state.summaryLoading=false;await render();
}
function summaryCard(report){
  const consented=state.trip?.preferences?.model_consent===true;
  const summary=report.summary;
  const head=mark=>`<h2 class="section-title"><span>收尾的话${mark?label(mark):''}</span></h2>`;
  if(summary)return `<section class="section summary">${head('AI 生成')}<p class="summary-text">${esc(summary.text)}</p><div class="summary-foot"><span class="note">${esc(summary.source)} · ${esc(new Date(summary.generated_at).toLocaleString('zh-CN'))}</span><button type="button" class="link-btn" id="write-summary" ${state.summaryLoading?'disabled':''}>${state.summaryLoading?'正在重写…':'换一段'}</button></div><p class="error-inline">${esc(state.summaryError)}</p></section>`;
  if(!consented)return `<section class="section summary">${head('')}<p>这份行程规划时没有开启 DeepSeek，所以写不了收尾文字。下次规划时打开开关就行。</p><button type="button" class="secondary" data-page="plan">去规划页</button></section>`;
  return `<section class="section summary">${head('')}<p>让 DeepSeek 按这次走过的地点和你的选择，写一段收尾文字。</p><button type="button" class="secondary" id="write-summary" ${state.summaryLoading?'disabled':''}>${state.summaryLoading?'正在写…':'写一段收尾文字'}</button><p class="error-inline">${esc(state.summaryError)}</p></section>`;
}
function journalListMarkup(journal){
  if(!journal?.length)return `<section class="section"><h2 class="section-title">这一程的日记</h2><p class="meta">还没有日记。</p></section>`;
  return `<section class="section"><h2 class="section-title">这一程的日记<span class="section-aside">${journal.length} 条</span></h2>${journal.map(entry=>`<article class="journal-entry"><h3>第 ${entry.day} 天 · ${esc(entry.stop_name)}</h3>${entry.text?`<p class="journal-text prose">${esc(entry.text)}</p>`:''}${entry.photos.length?`<div class="journal-photos">${entry.photos.map(photo=>`<img src="${esc(photo.url)}" alt="${esc(entry.stop_name)}的照片" loading="lazy">`).join('')}</div>`:''}<p class="note">${esc(new Date(entry.updated_at).toLocaleString('zh-CN'))}</p></article>`).join('')}</section>`;
}

// 当前视图标识：行程或旅行日一变化，换乘结果与高程结果就必须作废，不能跨日复用。
const viewKey=()=>`${state.trip?.id||''}:${state.day}`;
const liveData=()=>state.config?.data_mode==='live';

// ---------------- 地点选择器：自定义起点、终点、必去地点与换乘端点 ----------------
const pickerTargets={start:'起点',end:'终点',must:'必去地点',stop:'地点','transit-from':'换乘出发地','transit-to':'换乘目的地'};
const pickerLabel=target=>pickerTargets[target]||'地点';
function placeResultsMarkup(){
  const p=state.picker;if(!p)return '';
  if(p.loading)return '<p class="meta">搜索中…</p>';
  if(p.error)return `<p class="error-inline">${esc(p.error)}</p>`;
  if(!p.searched)return '';
  if(!p.results.length)return '<p class="meta">没找到，换个关键词或加上附近地标再试。</p>';
  return `<div class="place-list">${p.results.map((place,index)=>`<button type="button" class="place-item" data-place="${index}"><strong>${esc(place.name)}</strong><small>${esc(place.address||place.category)}</small></button>`).join('')}</div>`;
}
function paintPlaceResults(){if($('#place-results'))$('#place-results').innerHTML=placeResultsMarkup();}
function placePicker(target){
  state.picker={target,results:[],loading:false,error:'',searched:false};
  const search=`<form id="place-search" class="search-row"><input name="keyword" aria-label="地点名称" minlength="2" maxlength="40" placeholder="搜地点，比如 西湖文化广场" required><button type="submit" class="primary" id="place-search-button">搜索</button></form><div id="place-results" role="status" aria-live="polite">${placeResultsMarkup()}</div>`;
  if(target!=='stop')return `<h2>选择一个${pickerLabel(target)}</h2>${search}`;
  // 加进当天行程：实况模式可以按名称搜；两种模式都能从候选里直接挑。
  const candidates=stopCandidates(),distance=m=>m<1000?`${Math.round(m/10)*10} m`:`${(m/1000).toFixed(1)} km`;
  return `<h2>添加到第 ${state.day} 天</h2>${liveData()?search:''}${candidates.length?`<h3>${liveData()?'或者从候选地点里挑':'从候选地点里挑'}</h3><div class="place-list">${candidates.map(({poi,away})=>`<button type="button" class="place-item" data-add-stop="${esc(poi.id)}"><strong>${esc(poi.name)}</strong><small>${esc(poi.category)} · 离路线约 ${distance(away)}</small></button>`).join('')}</div>`:liveData()?'':'<p class="meta">没有可以添加的候选地点了。</p>'}`;
}
async function runPlaceSearch(keyword){
  const target=state.picker?.target;if(!target)return;
  state.picker={...state.picker,loading:true,error:'',searched:true,results:[]};paintPlaceResults();
  try{
    // 已有行程时用行程所在城市，还没有行程时用规划草稿里选的城市。
    const result=await api('/places',state.trip?{keyword,trip_id:state.trip.id}:{keyword,city:state.planCity});
    if(state.picker?.target!==target)return;
    state.picker.loading=false;state.picker.results=result.places;
  }catch(error){if(state.picker?.target!==target)return;state.picker.loading=false;state.picker.error=error.message;}
  paintPlaceResults();
}
function applyPickedPlace(target,place){
  // 加进当天行程：保存成功后弹窗才关，失败时留着让用户换一个。
  if(target==='stop')return addStop(place);
  const point={name:place.name,lat:place.lat,lng:place.lng};
  if(target==='start'||target==='end'){
    if(target==='start')state.planStartPoint=point;else state.planEndPoint=point;
  }else if(target==='must'){
    const list=mustVisitList();
    if(list.length>=3){closeModal();state.picker=null;toast('最多锁定 3 个必去地点');return;}
    list.push({name:place.name,lat:place.lat,lng:place.lng,category:place.category,duration_min:45});
  }else if(target==='transit-from'){state.transit.from=point;state.transit.result=null;}
  else if(target==='transit-to'){state.transit.to=point;state.transit.result=null;}
  state.picker=null;closeModal();render();
  toast(target==='must'?`已加入必去「${place.name}」，点「按必去重新规划」生效`:`已设为${pickerLabel(target)}：${place.name}`);
}
function startEndFields(){
  const pick=(kind,point)=>`<span class="pick-item"><button type="button" class="pick-btn ${point?'set':''}" id="pick-${kind}">${point?pickerLabel(kind)+' · '+esc(point.name):'选择'+pickerLabel(kind)}</button>${point?`<button type="button" class="icon-btn" id="clear-${kind}" aria-label="清除${pickerLabel(kind)}">${icon('close')}</button>`:''}</span>`;
  return `<div class="field stack"><span class="field-label">起点和终点 <small>${liveData()?'不选就自动安排':'演示模式下自动安排'}</small></span><div class="pick-row">${pick('start',state.planStartPoint)}${pick('end',state.planEndPoint)}</div></div>`;
}

// ---------------- 公交换乘 ----------------
const transitModes={walk:'步行',bus:'公交',subway:'地铁',railway:'铁路',taxi:'出租'};
function transitCandidates(){
  const list=[];
  if(state.location?.position)list.push({name:'当前位置'+(state.location.district?'（'+state.location.district+'）':''),lat:state.location.position.lat,lng:state.location.position.lng});
  for(const [index,stop] of (state.trip?.days?.[state.day-1]?.stops||[]).entries())list.push({name:`第${index+1}站 ${stop.name}`,lat:stop.lat,lng:stop.lng});
  return list;
}
function transitSelect(role,point){
  const candidates=transitCandidates();
  const at=point?candidates.findIndex(c=>c.lat===point.lat&&c.lng===point.lng):-1;
  return `<label class="field">${role==='from'?'出发地':'目的地'}<select name="transit-${role}" id="transit-${role}">${candidates.map((candidate,index)=>`<option value="${index}" ${index===at?'selected':''}>${esc(candidate.name)}</option>`).join('')}${at<0&&point?`<option value="custom" selected>自定义：${esc(point.name)}</option>`:''}</select></label>`;
}
function transitResult(result){
  if(!result?.options?.length)return '';
  return `<ol>${result.options.map((option,index)=>`<li class="transit-option"><p class="transit-head"><strong>约 ${option.duration_min} 分钟</strong><span class="meta">${[index===0?'推荐':'',option.transfers?option.transfers+' 次换乘':'直达'].filter(Boolean).join(' · ')}</span></p><p class="meta">步行约 ${Math.round(option.walking_distance_m??0)} m · 票价${option.cost===null?'未知':option.cost>0?'约 ¥'+option.cost:'免费'} · 全程 ${(option.distance_m/1000).toFixed(1)} km</p><ol class="transit-legs">${option.segments.map(segment=>`<li><span>${transitModes[segment.type]||segment.type}</span><strong>${esc(segment.line||(segment.type==='walk'?'步行':'换乘'))}</strong><small>${esc([segment.from,segment.from!==segment.to?segment.to:''].filter(Boolean).join(' → '))||(segment.duration_min===null?'':'约 '+segment.duration_min+' 分钟')}</small></li>`).join('')}</ol></li>`).join('')}</ol><p class="note">${esc(result.source||'')} · ${esc(result.updated_at?.replace('T',' ').slice(0,16)||'')}</p>`;
}
function transitCard(){
  const title='<h2 class="section-title">公交换乘</h2>';
  if(!liveData())return `<section class="section">${title}<p class="meta">演示模式不可用。接入高德实时数据后可以查公交和地铁。</p></section>`;
  const key=viewKey();
  if(state.transit.key!==key)state.transit={key,from:null,to:null,result:null,error:'',loading:false};
  const candidates=transitCandidates();
  if(candidates.length<2)return `<section class="section">${title}<p class="meta">当天至少有两站才能查。</p></section>`;
  const t=state.transit;
  if(!t.from)t.from=candidates[0];if(!t.to)t.to=candidates.at(-1);
  return `<section class="section">${title}<div class="form-grid">${transitSelect('from',t.from)}${transitSelect('to',t.to)}</div><div class="toolbar"><button class="secondary" id="query-transit" ${t.loading?'disabled':''}>${t.loading?'查询中…':'查路线'}</button><button type="button" class="link-btn" data-pick="transit-from">换个出发地</button><button type="button" class="link-btn" data-pick="transit-to">换个目的地</button></div><p id="transit-error" class="error-inline">${esc(t.error||'')}</p><div id="transit-result">${transitResult(t.result)}</div></section>`;
}
async function queryTransit(){
  const t=state.transit;
  if(!t.from||!t.to)return;
  if(t.from.lat===t.to.lat&&t.from.lng===t.to.lng)throw Error('出发地与目的地不能相同');
  const revision=accountRevision;
  Object.assign(t,{loading:true,error:'',result:null});await render();
  try{state.transit.result=await api('/transit',{trip_id:state.trip?.id,from:{...state.transit.from},to:{...state.transit.to}});}
  catch(error){state.transit.error=error.message;}
  finally{state.transit.loading=false;if(revision===accountRevision&&state.page==='trip')await render();}
}

// ---------------- 海拔与坡段（Open Topo Data / SRTM 90m） ----------------
function elevationChart(samples){
  const known=samples.map(sample=>sample.elevation).filter(value=>value!==null);
  if(known.length<2)return '';
  const min=Math.min(...known),max=Math.max(...known),span=Math.max(1,max-min),width=350,height=70;
  let path='',open=false;
  for(const [index,sample] of samples.entries()){
    if(sample.elevation===null){open=false;continue;}
    const x=index/(samples.length-1)*width,y=height-6-(sample.elevation-min)/span*(height-14);
    path+=(open?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)+' ';open=true;
  }
  return `<svg class="elevation-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="海拔剖面：最低 ${Math.round(min)} 米，最高 ${Math.round(max)} 米"><path d="${path.trim()}" fill="none" stroke="#1d5a41" stroke-width="2"/></svg>`;
}
function elevationResult(data){
  const s=data.summary,steep=data.segments.filter(segment=>segment.level==='steep'||segment.level==='noticeable').sort((a,b)=>Math.abs(b.grade_pct)-Math.abs(a.grade_pct)).slice(0,5);
  const row=(label,value)=>`<li><span>${label}</span><strong>${value}</strong></li>`;
  return `<ul class="kv">${row('累计爬升',`${s.gain_m} m`)}${row('累计下降',`${s.loss_m} m`)}${row('最低 / 最高',`${s.min_m??'—'} / ${s.max_m??'—'} m`)}${row('最陡上坡',`${s.max_up_grade_pct===null?'—':s.max_up_grade_pct+'%'} · 陡坡 ${s.steep_count} 段`)}</ul>`
    +elevationChart(data.samples)
    +(data.context?`<p class="note">${esc(data.context)}</p>`:'')
    +(steep.length?`<h3>值得留意的坡段</h3><ul class="kv">${steep.map(segment=>{
      const where=segment.from_label&&segment.from_label===segment.to_label?`${esc(segment.from_label)} 附近`:`${esc(segment.from_label||'途中')} → ${esc(segment.to_label||'途中')}`;
      return row(where,`${segment.grade_pct>0?'上坡':'下坡'} ${Math.abs(segment.grade_pct)}% · 约 ${segment.distance_m} m · ${esc(segment.level_label)}`);
    }).join('')}</ul>`:'<p>这条路线基本是平路。</p>')
    +`<p class="note">${esc(data.accuracy_note)} 数据：${esc(data.source)}（${data.attributions.map(esc).join('、')}）</p>`;
}
function elevationCard(){
  const key=viewKey();
  if(state.elevation.key!==key)state.elevation={key,loading:false,data:null,error:''};
  const e=state.elevation;
  return `<section class="section"><h2 class="section-title">坡度与爬升</h2><button class="secondary" id="load-elevation" ${e.loading?'disabled':''}>${e.loading?'正在计算…':e.data?'重新计算':'看看今天的路陡不陡'}</button><p id="elevation-error" class="error-inline">${esc(e.error||'')}</p><div id="elevation-result">${e.data?elevationResult(e.data):''}</div></section>`;
}
async function loadElevation(){
  if(!state.trip)return;
  const revision=accountRevision;
  Object.assign(state.elevation,{loading:true,error:''});await render();
  try{state.elevation.data=await api('/elevation',{trip_id:state.trip.id,day:state.day});}
  catch(error){state.elevation.data=null;state.elevation.error=error.message;}
  finally{state.elevation.loading=false;if(revision===accountRevision&&state.page==='trip')await render();}
}

// ---------------- 分钟级降水与天气预警（和风） ----------------
// 只有配置了天气服务才请求，每份行程取一次；取不到就不显示，不占位。
function weatherLiveMarkup(data){
  const rain=data.minutely,alerts=data.alerts?.alerts||[];
  const wet=rain&&(rain.raining_now||rain.rainy_minutes>0);
  return (rain?`<p class="rain">${esc(rain.summary||(wet?`未来 2 小时里有 ${rain.rainy_minutes*5} 分钟会下雨`:'未来 2 小时不下雨'))}</p>`:'')
    +alerts.map(alert=>`<details class="alert"><summary>${esc(alert.headline||alert.event)}</summary><p>${esc(alert.description)}</p>${alert.instruction?`<p>${esc(alert.instruction)}</p>`:''}</details>`).join('');
}
async function loadWeatherLive(){
  const trip=state.trip;if(!trip||!state.config?.providers?.weather)return;
  if(state.weatherLive?.trip!==trip.id){
    state.weatherLive={trip:trip.id,data:null};
    try{const data=await api('/weather?trip_id='+encodeURIComponent(trip.id));if(state.weatherLive?.trip===trip.id)state.weatherLive.data=data;}
    catch{/* 实况降水是附加信息，取不到不影响行程页 */}
  }
  const box=$('#weather-live'),data=state.weatherLive?.data;
  if(box&&state.page==='trip'&&state.trip?.id===trip.id&&data?.available)box.innerHTML=weatherLiveMarkup(data);
}

function tripPage(){
  if(!state.trip)return empty('还没有行程');
  const t=state.trip,d=t.days[state.day-1],must=mustVisitList(),active=state.session&&!state.session.ended_at;
  const skipped=d.skipped.length?`<details class="skipped"><summary>${d.skipped.length} 个地点没排进去</summary><ul class="kv">${d.skipped.map(p=>`<li><span>${esc((t.poi_catalog||state.pois).find(v=>v.id===p.id)?.name||p.id)}</span><strong>${esc(p.reason)}</strong></li>`).join('')}</ul></details>`:'';
  const weather=`<section class="section"><h2 class="section-title">天气</h2><p class="weather-main"><strong>${t.weather.temperature??'—'}°</strong>${esc(t.weather.condition)} <span class="meta">${esc(t.weather.source)} · ${esc(t.weather.updated_at?.replace('T',' ').slice(5,16))}</span></p><div id="weather-live"></div>${t.weather.fallback_reason?`<p class="note">${esc(t.weather.fallback_reason)}</p>`:''}${t.weather.source_url?`<p class="note attribution"><a href="https://www.qweather.com/" target="_blank" rel="noopener noreferrer">天气数据：和风天气</a> · <a href="https://developer.qweather.com/attribution.html" target="_blank" rel="noopener noreferrer">数据来源声明</a></p>`:''}</section>`;
  // 服务端随行程下发的限定说明，原文照登：哪些没核实、哪些不计入、预算能不能保证。
  const checks=Array.isArray(t.warnings)&&t.warnings.length?`<section class="section"><h2 class="section-title">出发前核实</h2><ul class="checks">${t.warnings.map(text=>`<li>${esc(text)}</li>`).join('')}</ul></section>`:'';
  return `<header class="page-head"><div><p class="meta">${esc(d.date)} · ${esc(t.preferences.companion)}${t.preferences.district?' · '+esc(t.preferences.district):''}</p><h1>${esc(t.preferences.city)}${t.days.length>1?`<small>第 ${state.day} 天</small>`:''}</h1></div><div class="row-actions"><button class="link-btn" id="pick-must">加必去地点</button><button class="link-btn" id="export-trip">导出</button></div></header>
  <div class="dock"><button class="primary wide start" id="start-journey">${active?'继续漫游':'开始漫游'}</button></div>`
  +figures([['站点',`${d.stops.length} 站`],['步行',`${(d.distance_m/1000).toFixed(1)} km`],['时长',`${(d.duration_min/60).toFixed(1)} 小时`],['花费',d.unknown_cost_count?'待核实':`¥${d.cost}`,d.unknown_cost_count?'':`预算 ¥${t.preferences.budget}`]])
  +(d.unknown_cost_count?`<p class="note">${d.unknown_cost_count} 处价格未知，预算 ¥${t.preferences.budget} 暂不能保证。</p>`:'')
  +`${t.data_mode==='demo'?'<p class="notice">演示数据：距离、时间和天气都是样例，不能用来导航。</p>':''}
  ${must.length?`<div class="notice"><span>必去：${must.map(m=>esc(m.name)).join('、')}</span><span class="bar-actions"><button class="secondary" id="replan-must">按必去重新规划</button></span></div>`:''}
  <div class="layout"><section class="section"><h2 class="section-title">行程安排${t.days.length>1?`<div class="segmented day-tabs">${t.days.map(day=>`<button type="button" class="${day.day===state.day?'selected':''}" data-day="${day.day}">第 ${day.day} 天</button>`).join('')}</div>`:''}</h2><div id="itinerary">${itinerary(d)}</div>${skipped}</section>
  <aside class="side-stack">${checks}<section class="section"><h2 class="section-title">地图</h2>${mapView(d.stops)}</section>${weather}
  <section class="section"><h2 class="section-title">为什么这样排</h2><p class="prose">${esc(t.explanation)}</p><p class="note">说明来源：${esc(t.explanation_source)}</p></section>
  <section class="section"><h2 class="section-title">下雨的话</h2><p>${d.plan_b.stops.length?d.plan_b.stops.map(p=>esc(p.name)).join(' → '):'这天没有合适的室内路线，下雨建议改期或提前结束。'}</p></section></aside></div>
  <div class="tool-grid">${transitCard()}${elevationCard()}</div>${diningPlaces(t)}
  ${state.trips.length?`<section class="section"><h2 class="section-title">全部行程</h2><div class="rows">${state.trips.slice(0,5).map(x=>`<button class="row" data-trip="${esc(x.id)}"><span class="row-main"><strong>${esc(x.preferences.city)}${x.id===t.id?label('当前'):''}</strong><span class="meta">${esc(x.preferences.date)} · ${x.preferences.days} 天</span></span></button>`).join('')}</div></section>`:''}`;
}
function sensorCard(){const s=state.sensor;return `<h2 class="section-title"><span>身体状态${state.session?.model_consent?label('AI 判断已开'):''}</span></h2><dl class="figures two"><div class="figure"><dt>当前心率</dt><dd><strong id="heart-value">--<small>bpm</small></strong></dd></div><div class="figure"><dt>估计步频</dt><dd><strong id="cadence-value">--<small>步/分</small></strong></dd></div></dl><svg class="pulse-chart" viewBox="0 0 350 55" aria-hidden="true"><path d="M0 30h350" stroke="#d3cab6" stroke-dasharray="4 4"/><path id="pulse-line" d="M0 30h350" fill="none" stroke="#1d5a41" stroke-width="2"/></svg><p class="sensor-state"><span id="sensor-status" role="status">未连接设备</span><span id="sensor-extra"></span></p><div class="device-options"><button class="secondary" id="connect-watch">连接 Apple Watch</button><button class="secondary" id="connect-hr">连接蓝牙心率带</button></div><div class="watch-progress" id="watch-progress" hidden><p id="watch-progress-text"></p><button class="text-button" id="view-watch">查看配对进度</button></div><div class="toolbar sensor-actions"><button class="link-btn" id="calibrate" disabled>采集静息心率</button><button class="link-btn" id="motion" ${s.motionActive?'disabled':''}>${s.motionActive?'步频已开启':'开启步频'}</button><button class="link-btn" id="stop-sensors">全部停止</button></div>${locationPanel(false)}<p class="note">只用来提醒你调整节奏，不用于诊断。</p>`;}
function controlsAvailable(){return state.user?.role==='admin'&&state.session&&!state.session.ended_at;}
function controlsState(){
  if(!controlsAvailable())return null;
  if(state.journeyControls?.session_id!==state.session.id)state.journeyControls={session_id:state.session.id,open:false,draft:{hr:state.sensor.hr??80,cadence:state.sensor.cadence??100,baseline_hr:state.sensor.baseline??70,baseline_cadence:sensors.cadenceBaseline??100,duration_s:0},applied:null,history:[],busy:false,error:''};
  return state.journeyControls;
}
function controlledReadings(){
  const a=state.journeyControls;
  return controlsAvailable()&&state.session.status!=='paused'&&a?.session_id===state.session.id?a.applied:null;
}
function currentFeatures(){
  const r=controlledReadings();
  return r?sensorFeatures({hr:r.hr,baseline:r.baseline_hr,cadence:r.cadence,cadenceBaseline:r.baseline_cadence,highSince:r.highSince,totalSteps:state.sensor.steps||0}):sensors.features();
}
function journeyControlsView(){
  const a=controlsState();if(!a)return '';
  const d=a.draft,paused=state.session.status==='paused';
  const number=(name,label,min,max,unit)=>`<label class="field"><span class="field-label">${label}${unit?'（'+unit+'）':''}</span><input type="number" name="${name}" data-control-field="${name}" value="${esc(d[name])}" min="${min}" max="${max}" step="1" inputmode="numeric" required></label>`;
  return `<div class="journey-controls">${a.open?`<section class="journey-controls-panel" id="journey-controls-panel" role="region" aria-labelledby="journey-controls-title"><div class="section-title"><h2 id="journey-controls-title">途中控制</h2><button type="button" class="icon-btn" id="close-journey-controls" aria-label="收起途中控制">${icon('close')}</button></div><form id="journey-controls-form"><fieldset ${a.busy||paused?'disabled':''}><div class="form-grid">${number('hr','心率',25,240,'bpm')}${number('cadence','步频',0,240,'步/分')}</div><details class="controls-reference"><summary>参考设置</summary><div class="form-grid">${number('baseline_hr','静息心率',25,240,'bpm')}${number('baseline_cadence','参考步频',1,240,'步/分')}${number('duration_s','心率偏高持续时间',0,86400,'秒')}</div></details><div class="toolbar"><button type="submit" class="primary">应用读数</button><button type="button" class="secondary" id="use-device-readings">使用设备读数</button></div></fieldset></form><fieldset class="controls-events" ${a.busy||paused?'disabled':''}><legend>触发事件</legend><div class="controls-event-grid"><button type="button" class="secondary" data-control-event="state">判断状态</button><button type="button" class="secondary" data-control-event="tired">有点累</button><button type="button" class="secondary" data-control-event="hungry">想吃饭</button><button type="button" class="secondary" data-control-event="rain">下雨了</button><button type="button" class="secondary" id="controls-unwell">身体不适</button></div></fieldset><p class="error-inline" role="alert">${esc(a.error)}</p></section>`:''}<button type="button" class="controls-launcher" id="toggle-journey-controls" aria-expanded="${a.open}" ${a.open?'aria-controls="journey-controls-panel"':''}>调节</button></div>`;
}
function rememberControlField(target){
  const field=target.dataset?.controlField;if(!field)return false;
  const a=controlsState();if(a&&!a.busy&&Object.hasOwn(a.draft,field))a.draft[field]=target.value;
  return true;
}
async function applyControlReadings(form){
  const a=controlsState();if(!a||a.busy||state.session.status==='paused')return;
  const raw=Object.fromEntries(new FormData(form)),readings={};
  const ranges={hr:[25,240],cadence:[0,240],baseline_hr:[25,240],baseline_cadence:[1,240],duration_s:[0,86400]};
  a.draft={...a.draft,...raw};a.error='';
  for(const [key,[min,max]]of Object.entries(ranges)){
    const value=raw[key]?.trim()?Number(raw[key]):NaN;
    if(!Number.isFinite(value)||value<min||value>max){a.error='请填写有效的心率、步频和参考数值。';await render();return;}
    readings[key]=value;
  }
  if(readings.hr/readings.baseline_hr>5||readings.cadence/readings.baseline_cadence>5){a.error='心率和步频不能超过对应参考值的 5 倍。';await render();return;}
  readings.highSince=readings.hr>=readings.baseline_hr*1.25?Date.now()-readings.duration_s*1000:null;
  a.applied=readings;a.history.push({at:Date.now(),value:readings.hr});a.history=a.history.slice(-50);
  await render();
}
async function triggerControlEvent(trigger){
  const a=controlsState();if(!a||a.busy||state.session.status==='paused'||!['state','tired','hungry','rain'].includes(trigger))return;
  const revision=accountRevision,sessionId=state.session.id;
  const current=()=>revision===accountRevision&&state.session?.id===sessionId&&!state.session.ended_at&&state.journeyControls===a;
  a.busy=true;a.error='';await render();
  try{if(current())await feedback(trigger);}
  catch(error){if(current())a.error=error.message;}
  finally{if(current()){a.busy=false;if(state.page==='journey')await render();}}
}
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
  if($('#watch-dialog-state'))$('#watch-dialog-state').innerHTML=`<p class="watch-status" role="status">${esc(v.text)}</p>${v.code?`<div class="watch-code" aria-label="配对码 ${esc(v.code)}">${esc(v.code.slice(0,4))} ${esc(v.code.slice(4))}</div><p class="note">只能用一次，别发给别人。</p>`:''}`;
}
function showWatchPairing(){
  modal(`<h2>在手表上输入配对码</h2><p>打开手表上的慢行应用，填入下面的服务地址和配对码，再点“配对并开始”。</p><label class="watch-address-label">服务地址</label><p class="watch-server">${esc(location.origin)}</p>${location.origin.startsWith('https://')?'':'<p class="notice">这是本机测试地址，真机上的手表连不到，需要换成手表能访问的 HTTPS 地址。</p>'}<div id="watch-dialog-state"></div><div class="modal-actions"><button class="primary modal-close">好了，回去</button><button class="secondary" id="watch-retry" hidden>重新配对</button><button class="text-button" id="cancel-watch">断开连接</button></div>`);
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
  const row=(name,value)=>`<li><span>${name}</span><strong>${value}</strong></li>`;
  return `<section class="suggestion box" aria-labelledby="suggestion-title"><h2 id="suggestion-title">要不要换个走法？${a.demo?label('演示','warn'):''}</h2><p class="prose">${esc(a.reason)}</p><dl class="figures two"><div class="figure"><dt>步行</dt><dd><strong>${changes.distance_saved_m>=0?'少走':'多走'} ${Math.abs(changes.distance_saved_m)}</strong><small>m</small></dd></div><div class="figure"><dt>结束时间</dt><dd><strong>${changes.time_saved_min>=0?'提前':'延后'} ${Math.abs(changes.time_saved_min)}</strong><small>分钟</small></dd></div></dl><ul class="kv">${row('新增',changes.added_stops.map(esc).join('、')||'没有')}${row('跳过',changes.skipped_stops.map(esc).join('、')||'没有')}${!changes.added_stops.length&&changes.moved_stops?.length?row('调序',changes.moved_stops.map(esc).join('、')):''}</ul>${(a.candidate?.stops||[]).filter(p=>p.category==='美食').map(p=>`<div class="suggestion-dining"><strong>${esc(p.name)}</strong>${commerceInfo(p)}</div>`).join('')}<div class="suggestion-actions"><button class="primary" data-confirm="true">接受调整</button><button class="secondary" data-confirm="false">保留原路线</button></div><p class="note" title="${esc(a.decision_source)}">${a.expires_at?esc(new Date(a.expires_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}))+' 前有效':'10 分钟内有效'}</p></section>`;
}
function journeyPage(){
  if(!state.trip)return empty('还没有行程');
  if(!state.session||state.session.ended_at)return `<section class="ready"><p class="meta">${esc(state.trip.preferences.city)} · 第 ${state.day} 天</p><h1>你的行程已准备好</h1><div class="dock"><button class="primary start" id="start-journey">开始第 ${state.day} 天漫游</button></div></section>`;
  const s=state.session,d=state.trip.days[s.day-1],current=d.stops[s.current_index],paused=s.status==='paused',finished=!current&&!paused;
  const previous=current?(s.current_index?d.stops[s.current_index-1]:state.trip.preferences.start_point):null,next=current?d.stops[s.current_index+1]:null;
  return `<div class="journey-layout"><div class="journey-main"><section class="now ${paused?'paused':''}"><div class="now-top"><span class="now-label">${paused?'行程已暂停':current?`第 ${s.current_index+1} 站 · 共 ${d.stops.length} 站`:'全部打卡完成'}</span>${finished?'':'<button class="link-btn" id="end-journey">结束漫游</button>'}</div><h1>${paused?'先照顾好自己':current?esc(current.name):'今天的行程走完了'}</h1><p class="now-meta">${paused?'停下来，到安全的地方，找身边的人帮忙。':current?`${esc(dayTime(current.arrival))} — ${esc(dayTime(current.departure))} · 停留 ${current.duration_min} 分钟`:'结束漫游，就能看到今天的手记。'}</p>${current&&!paused?commerceInfo(current):''}<div class="journey-progress" role="progressbar" aria-label="打卡进度" aria-valuemin="0" aria-valuemax="${d.stops.length}" aria-valuenow="${s.current_index}"><span style="width:${Math.min(100,s.current_index/Math.max(1,d.stops.length)*100)}%"></span></div>${current&&!paused?`${next?`<p class="now-next">下一站：${esc(next.name)}</p>`:''}<div class="now-actions dock"><button class="primary" id="checkin">逛完了，去下一站</button>${previous?`<a class="secondary" href="${esc(amapNavigation(previous,current))}" target="_blank" rel="noopener noreferrer">导航</a>`:''}</div>`:''}${finished?`<div class="dock"><button class="primary" id="end-journey">结束并看手记</button></div>`:''}</section>
  ${state.suggestion&&!paused?suggestionCard(state.suggestion):''}
  <section class="section"><h2 class="section-title">现在感觉怎么样？</h2>${paused?'<p>路线建议已暂停。需要急救请拨打 120。</p>':`<div class="feel-grid"><button data-feedback="tired"><strong>有点累</strong><small>少走一点，找地方歇歇</small></button><button data-feedback="hungry"><strong>想吃饭</strong><small>就近安排一家餐厅</small></button><button data-feedback="rain"><strong>下雨了</strong><small>去室内逛一逛吧</small></button></div>`}<button class="help-btn" id="unwell">身体不舒服，需要帮助</button></section>
  ${current&&!paused?journalBlock(s.day,current):''}
  </div><aside class="journey-aside"><section class="section sensor">${sensorCard()}</section><section class="section"><h2 class="section-title">地图</h2>${mapView(d.stops)}</section></aside></div>${journeyControlsView()}`;
}
async function reportPage(){
  if(!state.trip)return empty('还没有手记');
  const r=await api(`/trip/${state.trip.id}/report`);
  const names={tired:'说有点累',hungry:'说想吃饭',rain:'反馈下雨',hr_high_sustained:'身体状态变化',accepted:'接受路线调整',rejected:'保留原路线',checkin:'打卡',unwell:'身体不适，暂停行程',progress:'进度落后',state:'状态变化'};
  return heading(esc(state.trip.preferences.city)+' · 手记',r.finished?'这一程已经走完。':'还在路上，结束后会更完整。',`<button class="link-btn" id="export-report">导出</button>`)
  +figures([['打卡',`${r.visited_stops} / ${r.total_stops}`],['实际步行',`${r.walked_km.toFixed(2)} km`],['接受调整',`${r.accepted} 次`],['保留原路线',`${r.rejected} 次`]])
  +`<p class="note">实际步行按步数估算 · 计划 ${r.planned_distance_km.toFixed(1)} km</p>`
  +(r.preference_note?`<p class="report-note">${esc(r.preference_note)}</p>`:'')
  +summaryCard(r)
  +`<div class="layout even"><section class="section"><h2 class="section-title">途中发生了什么</h2><ul class="events">${r.events.length?r.events.map(e=>`<li><time>${esc(new Date(e.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}))}</time><span>${esc(names[e.type]||e.type)}${e.demo?' · 演示':''}</span></li>`).join(''):'<li class="meta">还没有记录。</li>'}</ul></section>${journalListMarkup(r.journal)}</div>`;
}
function providerTestCard(name,label){
  const result=state.providerTests?.[name],running=state.providerTesting===name;
  return `<li class="row"><div class="row-main"><strong>${esc(label)}</strong><div role="status" aria-live="polite">${running?'<p class="meta">正在请求服务…</p>':result?`<p class="meta">${result.ok?'测试成功':'测试失败'}${Number.isFinite(result.elapsed_ms)?` · ${result.elapsed_ms} ms`:''}</p><p class="meta">${esc(result.message)}${result.error_code?`（${esc(result.error_code)}）`:''}</p>${result.checked_at?`<p class="note">测试时间：${esc(new Date(result.checked_at).toLocaleString('zh-CN'))}</p>`:''}`:'<p class="meta">尚未主动测试</p>'}</div>${name==='weather'?'<p class="note attribution"><a href="https://www.qweather.com/" target="_blank" rel="noopener noreferrer">天气数据：和风天气</a> · <a href="https://developer.qweather.com/attribution.html" target="_blank" rel="noopener noreferrer">数据来源声明</a></p>':''}</div><button type="button" class="secondary" data-provider-test="${name}" ${state.providerTesting?'disabled':''}>${running?'测试中…':name==='maps'?'测试地图':'测试天气'}</button></li>`;
}
async function testOpsProvider(name){
  if(state.user?.role!=='admin'||state.providerTesting||!['maps','weather'].includes(name))return;
  const revision=accountRevision;state.providerTesting=name;
  try{
    if(state.page==='ops')await render();
    if(revision!==accountRevision)return;
    const result=await api('/ops/test',{provider:name,...(name==='maps'?{city:state.planCity}:{})});
    if(revision===accountRevision)(state.providerTests??={})[name]=result;
  }catch(e){if(revision===accountRevision)(state.providerTests??={})[name]={ok:false,message:e.message};}
  finally{if(revision===accountRevision){state.providerTesting=null;if(state.page==='ops')await render();}}
}
async function opsPage(){
  if(state.user?.role!=='admin')throw Error('仅管理员可访问运营工作台');
  const o=await api('/ops');
  const services=[['maps','高德地图',['已配置','演示模式']],['weather','和风天气',['已配置','未配置']],['deepseek','DeepSeek 说明生成',['已配置','规则模板']],['jev','TypeSafe Jev 决策',['已配置','规则引擎']],['elevation','Open Topo Data 高程',['公开服务','未启用']]];
  const recent=p=>p?esc({not_checked:'还没调用过',not_configured:'未配置',ok:'最近调用成功',error:'最近调用失败'}[p.status]||p.status)+(p.error_code?' · '+esc(p.error_code):''):'';
  return heading('运营工作台')+
    `<section class="section"><h2 class="section-title">服务连接状态</h2><table class="table"><thead><tr><th scope="col">服务</th><th scope="col">配置</th><th scope="col">最近调用</th></tr></thead><tbody>${services.map(([name,label,[on,off]])=>`<tr><td>${label}</td><td>${o.providers[name]?on:off}</td><td>${recent(o.provider_status?.[name])}</td></tr>`).join('')}</tbody></table><ul class="rows">${providerTestCard('maps','高德地图')}${providerTestCard('weather','和风天气')}</ul></section>`;
}
async function render(){
  if(state.page==='ops'&&state.user?.role!=='admin'){state.page=state.user?'plan':'auth';state.authMode='login';history.replaceState(null,'',state.user?'/plan':'/login');}
  if(state.page==='auth'&&!state.user&&location.pathname==='/account'){state.authMode='login';history.replaceState(null,'','/login');}
  if(state.page==='auth'&&state.user&&['/login','/register'].includes(location.pathname))history.replaceState(null,'','/account');
  updateAccountUI();destroyRouteMaps();const version=++renderVersion;
  // 伴行页需要日记，但渲染不能等它：先标记已请求，拿到数据后再刷新一次（每个行程只取一次）。
  if(state.page==='journey'&&state.trip&&state.journalTrip!==state.trip.id){
    state.journalTrip=state.trip.id;
    loadJournal().then(()=>{if(state.page==='journey')render();}).catch(()=>{});
  }
  $('#app').dataset.page=state.page;$('.main-nav').dataset.active=state.page;$$('[data-page]').forEach(b=>{b.classList.toggle('active',b.dataset.page===state.page);if(b.dataset.page===state.page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});document.title=`${state.page==='auth'?(state.user?'我的账号':state.authMode==='register'?'注册':'登录'):labels[state.page]} · 慢行`;
  // 手记和运营页要先等接口返回：等得久了才换成加载提示，免得每次切换都闪一下。
  const slow=['ops','report'].includes(state.page)?setTimeout(()=>{if(version===renderVersion)$('#app').innerHTML='<div class="loading">加载中…</div>';},260):0;
  try{const html=await ({plan:planPage,trip:tripPage,journey:journeyPage,report:reportPage,ops:opsPage,auth:authPage}[state.page])();if(version!==renderVersion)return;$('#app').innerHTML=(state.offline?'<div class="notice">现在没有网络，只能查看已保存的行程。</div>':'')+html;updateSensors();mountRouteMaps(state.trip);if(state.page==='trip')loadWeatherLive();}catch(e){if(version===renderVersion)$('#app').innerHTML=`<div class="empty"><h2>没加载出来</h2><p>${esc(e.message)}</p><button class="secondary" id="retry">再试一次</button></div>`;}finally{clearTimeout(slow);}}
function currentRoutePath(){return state.page==='auth'?(state.user?'/account':state.authMode==='register'?'/register':'/login'):pageRoutes[state.page].path;}
function navigate(page,{replace=false}={}){
  const route=page==='auth'?(state.user?pageRoutes.account:pageRoutes.login):Object.hasOwn(pageRoutes,page)?pageRoutes[page]:null;if(!route)return;
  const menu=$('#more-menu');if(menu)menu.open=false;
  const from=`${state.page}:${state.authMode}`;
  state.page=route.page;if(route.authMode)state.authMode=route.authMode;
  const path=currentRoutePath(),changed=from!==`${state.page}:${state.authMode}`;
  if(location.pathname!==path||location.hash)history[replace?'replaceState':'pushState'](null,'',path);
  // 新内容换上去之后再回到顶部：手记页要等接口，先滚动会看到旧页面跳一下。
  render().then(()=>{window.scrollTo({top:0});if(changed)playPageEnter();});
}
// 换页时让新内容轻轻浮上来；同一页内的重绘不播，免得每次操作都闪。
function playPageEnter(){const app=$('#app');app.classList.remove('page-enter');void app.offsetWidth;app.classList.add('page-enter');}
function applyLocationRoute(){
  const route=resolvePageRoute(location.pathname,location.hash)||pageRoutes.plan;
  state.page=route.page;if(route.authMode)state.authMode=route.authMode;
  if(location.pathname!==route.path||location.hash)history.replaceState(null,'',route.path);
}

function download(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function refreshSession(){if(!state.session)return;state.session=await api('/session/'+state.session.id);localStorage.setItem('mx-session',state.session.id);}
async function feedback(trigger){
  if(!state.session||state.session.ended_at)throw Error('请先开始漫游');
  const revision=accountRevision,sessionId=state.session.id;
  const current=()=>revision===accountRevision&&state.session?.id===sessionId&&!state.session.ended_at;
  const a=await api('/feedback',{session_id:sessionId,feedback_type:trigger,features:currentFeatures()});
  if(!current())return;
  const session=await api('/session/'+sessionId);if(!current())return;
  state.session=session;state.suggestion=a.require_confirm?a:null;
  if(!a.require_confirm)toast(a.reason);await render();
}
function updateSensors(){updateWatchUI();const s={...state.sensor};if(!$('#heart-value'))return;const r=controlledReadings();if(r){s.hr=r.hr;s.cadence=r.cadence;s.baseline=r.baseline_hr;}$('#heart-value').innerHTML=`${s.hr??'--'}<small>bpm</small>`;$('#cadence-value').innerHTML=`${s.cadence??'--'}<small>步/分</small>`;$('#sensor-status').textContent=r?`静息心率 ${r.baseline_hr} bpm`:s.source==='watch'?({background:'页面在后台，暂停判断',waiting:'等手表输入配对码',waiting_for_sample:'手表已配对，等心率数据',unavailable:'暂时连不上，等待恢复',disconnected:'手表已断开，请重新配对'}[s.watchStatus]||`Apple Watch · ${s.hr==null?'等心率数据':s.calibrating?'静坐采集中…':s.baseline?'静息心率 '+s.baseline+' bpm':'还没采集静息心率'}`):s.connected?`已连接 · ${s.calibrating?'静坐采集中…':s.baseline?'静息心率 '+s.baseline+' bpm':'还没采集静息心率'}`:'未连接设备';$('#sensor-extra').textContent=s.steps?`已走约 ${s.steps} 步`:'';$('#calibrate').disabled=!s.connected||s.hr==null||s.calibrating;const motionButton=$('#motion');if(motionButton){motionButton.disabled=!!s.motionActive;motionButton.textContent=s.motionActive?'步频已开启':'开启步频';}const samples=r?state.journeyControls.history:sensors.samples.slice(-50);if(samples.length<2)$('#pulse-line').setAttribute('d','M0 30h350');if(samples.length>1){const min=Math.min(...samples.map(s=>s.value))-3,max=Math.max(...samples.map(s=>s.value))+3;$('#pulse-line').setAttribute('d',samples.map((s,i)=>`${i?'L':'M'}${i/(samples.length-1)*350},${45-(s.value-min)/(max-min)*35}`).join(' '));}}
sensors.addEventListener('change',e=>{state.sensor=e.detail;if(!state.watchPending&&!e.detail.source)state.watchPairing=null;updateSensors();if(e.detail.message)toast(e.detail.message);const f=currentFeatures();if(state.session&&!state.session.ended_at&&state.session.status!=='paused'&&f.duration_s>=180&&f.cadence_change_pct<=-15&&Date.now()-lastStateAt>300000){lastStateAt=Date.now();feedback('hr_high_sustained').catch(e=>toast(e.message));}});
// 步频默认开启：开始漫游时就申请运动权限。iOS 要求 requestPermission 必须发生在
// 用户手势里，所以调用点放在点击处理的最前面（任何 await 之前），否则手势上下文会丢失。
// 桌面浏览器没有 DeviceMotionEvent，直接静默跳过，不打扰。
async function startMotionByDefault(){
  if(state.sensor.motionActive||!window.DeviceMotionEvent)return;
  try{await sensors.startMotion();}
  catch{/* 权限被拒或设备不支持时保留「启用步频」按钮，让用户自己再试 */ }
}
$('#app').addEventListener('change',e=>{
  if(rememberControlField(e.target))return;
  if(e.target.id==='use-start-point'){useCurrentStart=e.target.checked;return;}
  if(e.target.id==='use-end-point'){useCurrentEnd=e.target.checked;return;}
  if(['province','city'].includes(e.target.name)){useCurrentStart=false;useCurrentEnd=false;paintLocation();}
  if(e.target.name==='transit-from'||e.target.name==='transit-to'){
    // 选「自定义」时保持已搜索到的点不动，等用户重新搜索。
    if(e.target.value==='custom')return;
    const candidate=transitCandidates()[Number(e.target.value)];if(!candidate)return;
    state.transit[e.target.name==='transit-from'?'from':'to']=candidate;state.transit.result=null;
    return;
  }
  if(['province','city','district_adcode'].includes(e.target.name))destinationRevision++;if(e.target.name==='province'){state.planProvince=e.target.value;state.planCity='';state.planDistrict='';paintDestination();}else if(e.target.name==='city'){state.planCity=e.target.value;state.planDistrict='';paintDestination();}else if(e.target.name==='district_adcode')state.planDistrict=e.target.value;if(['province','city','district_adcode'].includes(e.target.name))saveDraft();});
$('#app').addEventListener('submit',async e=>{
  if(e.target.id==='journey-controls-form'){e.preventDefault();await applyControlReadings(e.target);return;}
  if(e.target.id!=='plan-form')return;
  e.preventDefault();if(state.planPending)return;
  const revision=accountRevision;
  const data=Object.fromEntries(new FormData(e.target));
  Object.assign(data,{days:Number(data.days),budget:Number(data.budget),walk_limit_km:Number(data.walk_limit_km),interests:[...state.interests],model_consent:data.model_consent==='on'});
  // 自定义起终点优先；没选就看定位面板上的勾选；都没有时由后端自动决定起点。
  const position=state.location?.position;
  if(state.planStartPoint)data.start_point=state.planStartPoint;
  else if($('#use-start-point')?.checked&&position)data.start_point={name:state.location.district||'当前位置',lat:position.lat,lng:position.lng};
  if(state.planEndPoint)data.end_point=state.planEndPoint;
  else if($('#use-end-point')?.checked&&position)data.end_point={name:'返回当前位置',lat:position.lat,lng:position.lng};
  state.planPending=true;state.planError='';saveDraft();await render();
  try{
    if(revision!==accountRevision)return;
    const trip=await api('/trip/plan',data);
    state.trip=trip;state.trips=[trip,...state.trips.filter(t=>t.id!==trip.id)];state.day=1;state.session=null;state.suggestion=null;sensors.stop();
    try{localStorage.removeItem('mx-session');}catch{}
    cacheTrip();
    // 起终点已经写进这次的行程偏好，表单里的一次性选择用完即清，避免下次误用。
    state.planStartPoint=null;state.planEndPoint=null;
    state.planPending=false;
    if(state.page==='plan')navigate('trip');else{await render();if(revision===accountRevision)toast('行程已生成，去「行程」看看。');}
    // History is optional: the new trip and visible controls are already usable.
    try{const history=await api('/trips');if(revision===accountRevision&&state.trip?.id===trip.id)state.trips=history.trips;}catch{}
  }catch(err){if(revision!==accountRevision)return;state.planError=err.message;state.planPending=false;if(state.page==='plan')await render();else toast(err.message);}
});
$('#app').addEventListener('input',e=>{
  const target=e.target;
  if(rememberControlField(target))return;
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
  const b=e.target.closest('button, a[data-page], a[data-auth-mode]');if(!b)return;
  if(b.tagName==='A'){if(e.button>0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();}
  if(b.id==='toggle-journey-controls'||b.id==='close-journey-controls'){const a=controlsState();if(a){a.open=b.id==='toggle-journey-controls'?!a.open:false;await render();if(a.open)$('#journey-controls-panel input')?.focus();}return;}
  if(b.id==='use-device-readings'){const a=controlsState();if(a&&!a.busy){a.applied=null;a.history=[];a.error='';await render();}return;}
  if(b.dataset.controlEvent){await triggerControlEvent(b.dataset.controlEvent);return;}
  if(b.dataset.providerTest){await testOpsProvider(b.dataset.providerTest);return;}
  if(b.dataset.authMode){navigate(b.dataset.authMode);return;}
  if(b.dataset.page){navigate(b.dataset.page);return;}
  if(b.classList.contains('modal-close')){closeModal();return;}
  if(b.dataset.interest){const v=b.dataset.interest;state.interests=state.interests.includes(v)?state.interests.filter(x=>x!==v):[...state.interests,v];b.classList.toggle('selected');b.setAttribute('aria-pressed',state.interests.includes(v));saveDraft();return;}
  if(b.dataset.city){destinationRevision++;const province=state.regions.find(p=>p.cities.some(c=>c.name===b.dataset.city));state.planProvince=province?.name||state.planProvince;state.planCity=b.dataset.city;state.planDistrict=b.dataset.district||'';saveDraft();navigate('plan');return;}
  if(b.dataset.day){state.day=Number(b.dataset.day);render();return;}
  if(b.dataset.pick){
    if(!liveData()){toast('地点检索需要开启实况服务（配置高德 Key）');return;}
    modal(placePicker(b.dataset.pick));return;
  }
  if(b.dataset.place!==undefined){
    const place=state.picker?.results?.[Number(b.dataset.place)];if(!place)return;
    await applyPickedPlace(state.picker.target,place);return;
  }
  if(b.dataset.stopDetail!==undefined){showStopDetail(b.dataset.stopDetail);return;}
  if(b.dataset.stopMove!==undefined){moveStop(b.dataset.stop,Number(b.dataset.stopMove));return;}
  if(b.dataset.stopRemove!==undefined){await removeStop(b.dataset.stopRemove);return;}
  if(b.dataset.addStop!==undefined){await addStop(findStop(b.dataset.addStop));return;}
  if(b.dataset.journalPhotoRemove!==undefined){await removeJournalPhoto(Number(b.dataset.journalPhotoRemove));return;}
  if(b.dataset.must!==undefined){
    const stop=(state.trip?.days.flatMap(d=>d.stops)||[]).find(s=>s.id===b.dataset.must)||findStop(b.dataset.must);if(!stop)return;
    const list=mustVisitList(),at=list.findIndex(m=>m.name===stop.name);
    if(at>=0)list.splice(at,1);
    else{if(list.length>=3)return toast('最多锁定 3 个必去地点');list.push({name:stop.name,lat:stop.lat,lng:stop.lng,category:stop.category,duration_min:stop.duration_min});}
    render();repaintStopDetail();toast(at>=0?`已取消「${stop.name}」的必去`:`已把「${stop.name}」设为必去，点上方「按必去重新规划」生效`);return;
  }
  if(b.id==='replan-must'){
    const list=mustVisitList();if(!list.length)return;const p=state.trip.preferences;
    b.disabled=true;b.textContent='正在重新规划…';
    try{
      state.trip=await api('/trip/plan',{city:p.city,date:p.date,days:p.days,budget:p.budget,walk_limit_km:p.walk_limit_km,interests:p.interests,start_time:p.start_time,end_time:p.end_time,companion:p.companion,model_consent:p.model_consent,start_poi:'auto',start_point:p.start_point||undefined,end_point:p.end_point||undefined,must_visit:list});
      state.trips=(await api('/trips')).trips;state.mustVisit=null;state.day=1;state.session=null;state.suggestion=null;cacheTrip();await render();toast('已按必去地点重新规划。');
    }catch(err){b.disabled=false;b.textContent='按必去重新规划';toast(err.message);}
    return;
  }
  const id=b.id;b.disabled=true;
  try{
    if(id==='account-button')navigate(state.user?'account':'login');
    if(id==='logout-button'){await api('/auth/logout',{});await switchAccount(null);navigate('login');toast('已退出登录');}
    if(id==='retry')await render();
    if(id==='retry-regions')await loadRegions();
    if(id==='pick-start'||id==='pick-end'||id==='pick-must'){
      if(!liveData())throw Error('地点检索需要开启实况服务（配置高德 Key）');
      modal(placePicker(id==='pick-must'?'must':id==='pick-start'?'start':'end'));
    }
    if(id==='add-place')modal(placePicker('stop'));
    if(id==='reorder-save')await saveStops(orderedStops().map(stopPayload));
    if(id==='reorder-cancel'){state.reorder=null;paintItinerary();}
    if(id==='clear-start'){state.planStartPoint=null;await render();}
    if(id==='clear-end'){state.planEndPoint=null;await render();}
    if(id==='query-transit')await queryTransit();
    if(id==='load-elevation')await loadElevation();
    if(id==='edit-journal'){const s=state.session,current=s&&state.trip?.days[s.day-1]?.stops[s.current_index];if(current)openJournal(s.day,current);}
    if(id==='save-journal')await saveJournal();
    if(id==='write-summary')await writeSummary();
    if(id==='export-trip')download('慢行-行程.json',state.trip);
    if(id==='export-report')download('慢行-手记.json',await api(`/trip/${state.trip.id}/report`));
    if(b.dataset.trip){state.trip=await api('/trip/'+b.dataset.trip);state.mustVisit=null;state.day=1;state.session=null;state.suggestion=null;localStorage.removeItem('mx-session');sensors.stop();cacheTrip();navigate('trip');}
    if(id==='start-journey'){
      if(state.session&&!state.session.ended_at){navigate('journey');return;}
      modal(`<h2>开始第 ${state.day} 天漫游</h2><p>不连手表或心率带也能走。连了设备的话，心率和步频的变化幅度会发给慢行后端，用来判断要不要提醒你歇一歇，不会保存。</p><label class="check-row"><input id="health-model-consent" type="checkbox"><span><strong>让 AI 帮忙判断身体状态</strong><small>会把心率、步频的变化幅度和持续时间发给 TypeSafe Jev。关着就用内置规则判断。</small></span></label><div class="modal-actions"><button class="primary" id="confirm-start">同意并开始</button><button class="secondary modal-close">再等等</button></div>`);
    }
    if(id==='confirm-start'){
      // iOS 要求运动权限在用户手势里申请，所以先发起（不 await），再开始会话。
      const motion=startMotionByDefault();
      state.session=await api('/session/start',{trip_id:state.trip.id,day:state.day,model_consent:$('#health-model-consent').checked});
      localStorage.setItem('mx-session',state.session.id);state.suggestion=null;closeModal();
      await Promise.all([loadJournal(),motion]);
      navigate('journey');
    }
    if(b.dataset.feedback)await feedback(b.dataset.feedback);
    if(id==='unwell'||id==='controls-unwell'){modal('<h2>先照顾好自己</h2><p>胸痛、头晕或明显不舒服时，请马上停下，到安全的地方，找身边的人帮忙。</p><div class="modal-actions"><a class="primary" href="tel:120">拨打 120</a><button class="danger" id="pause-unwell">暂停行程</button></div>');}
    if(id==='pause-unwell'){await feedback('unwell');sensors.stop();closeModal();}
    if(b.dataset.confirm){const r=await api('/session/confirm',{session_id:state.session.id,suggestion_id:state.suggestion.id,accept:b.dataset.confirm==='true'});state.trip=r.trip;state.session=r.session;state.suggestion=null;cacheTrip();toast(r.accepted?'已按你的选择更新行程。':'已保留原路线。');await render();}
    if(id==='checkin'){state.session=await api('/session/checkin',{session_id:state.session.id,stop_id:state.trip.days[state.session.day-1].stops[state.session.current_index].id});state.suggestion=null;toast('已记录打卡');await render();}
    if(id==='end-journey')modal('<h2>结束今天的漫游？</h2><p>设备会停止采集，打卡和路线调整都会留在手记里。</p><div class="modal-actions"><button class="primary" id="confirm-end">结束，看手记</button><button class="secondary modal-close">继续走</button></div>');
    if(id==='confirm-end'){closeModal();state.session=await api('/session/end',{session_id:state.session.id});sensors.stop();state.suggestion=null;navigate('report');}
    if(id==='connect-watch'||id==='watch-retry'){
      if(!state.session||state.session.ended_at)throw Error('请先开始漫游');
      if(state.session.status==='paused')throw Error('行程已暂停，请先照顾自己');
      if(id==='connect-watch'&&state.watchPairing?.session_id===state.session.id&&!watchConnectionView().retry){showWatchPairing();return;}
      modal('<h2>连接 Apple Watch</h2><ol class="watch-steps"><li><strong>手表上装好慢行应用</strong><span>网页读不到 Apple 健康数据，要靠手表应用转发。</span></li><li><strong>在手表上输入地址和配对码</strong><span>手表要能访问这个 HTTPS 地址。</span></li><li><strong>允许读取心率</strong><span>网页保持在前台，等读数出现。</span></li></ol><details class="watch-privacy"><summary>会传什么数据？</summary><p>只传心率数值和采样时间。服务端只在内存里留最新一条，20 秒后清掉，不存库、不写日志、不给模型。配对码 5 分钟内有效、只能用一次，连接最长 4 小时，结束漫游或退出账号就失效。</p></details><label class="check-row"><input id="watch-relay-consent" type="checkbox"><span>同意本次心率临时转发</span></label><p id="watch-error" class="error-inline" role="alert"></p><div class="modal-actions"><button class="primary" id="confirm-watch">生成配对码</button><button class="secondary modal-close">暂不连接</button></div>');
    }
    if(id==='confirm-watch')await createWatchPairing();
    if(id==='view-watch')showWatchPairing();
    if(id==='cancel-watch'){watchAttempt++;state.watchPending=false;state.watchPairing=null;sensors.disconnect();closeModal();updateWatchUI();toast('设备已断开');}
    if(id==='connect-hr')await sensors.connect();
    if(id==='calibrate')sensors.calibrate();
    if(id==='motion')await sensors.startMotion();
    if(id==='locate'||id==='locate-plan')await recognizeLocation();
    if(id==='stop-sensors'){clearLocation();sensors.stop();}
    if(id==='privacy-button')modal('<h2>隐私与数据</h2><h3>会保存</h3><ul class="plain-list"><li>行程、打卡、你对路线调整的选择</li><li>你写的日记和照片</li><li>浏览器里缓存的最近一份行程（断网时查看）</li></ul><h3>不保存</h3><ul class="plain-list"><li>心率、加速度原始数据</li><li>定位坐标（只发给高德识别城市，用完即弃）</li><li>Apple Watch 心率：只在内存留最新一条，20 秒后清掉</li></ul><h3>关于 AI</h3><ul class="plain-list"><li>默认关闭，打开开关后才发送对应内容</li><li>日记、照片和定位任何时候都不发给模型</li></ul><h3>账号</h3><ul class="plain-list"><li>登录后行程跟着账号走；没登录时跟着这个浏览器走</li><li>注册或登录时，这个浏览器里的游客行程会并入账号</li></ul><div class="modal-actions"><button class="secondary" id="privacy-stop">停止定位和传感器</button><button class="danger" id="delete-data">删除我的行程与记录</button></div>');
    if(id==='privacy-stop'){clearLocation();sensors.stop();toast('已停止定位和传感器');}
    if(id==='delete-data')modal('<h2>确定全部删除？</h2><p>行程、打卡、日记和照片都会删掉，无法恢复。账号本身会保留。</p><div class="modal-actions"><button class="danger" id="confirm-delete">全部删除</button><button class="secondary modal-close">取消</button></div>');
    if(id==='confirm-delete'){await api('/privacy/delete',{confirm:true});clearLocation();sensors.stop();state.trip=null;state.session=null;state.suggestion=null;state.trips=[];localStorage.removeItem('mx-trip');localStorage.removeItem('mx-session');localStorage.removeItem('mx-plan-draft');state.draft=readDraft();applyDestination(state.draft.province,state.draft.city,state.draft.district_adcode,state.draft.district);state.interests=state.draft.interests;state.planConsent=false;closeModal();navigate('plan');toast('已全部删除');}
  }catch(err){toast(err.message);}finally{b.disabled=false;if(id==='calibrate')updateSensors();}
});
window.addEventListener('offline',()=>{state.offline=true;toast('网络断了，已保存的行程还能看。');});
window.addEventListener('online',()=>{state.offline=false;toast('网络已恢复');render();});
async function init(){
  try{state.user=(await api('/auth/me')).user;state.authChecked=true;updateAccountUI();state.config=await api('/config');state.pois=(await api('/pois')).pois;state.trips=(await api('/trips')).trips;const cached=JSON.parse(localStorage.getItem('mx-trip')||'null');state.trip=state.trips.find(t=>t.id===cached?.id)||state.trips[0]||null;if(state.trip)cacheTrip();const sid=localStorage.getItem('mx-session');if(sid){try{state.session=await api('/session/'+sid);if(state.session.trip_id!==state.trip?.id)state.session=null;else if(state.session.pending_suggestion){try{const pending=await api('/suggestion/'+state.session.pending_suggestion);if(!pending.resolved_at&&Date.parse(pending.expires_at)>Date.now())state.suggestion=pending;}catch{}}}catch{localStorage.removeItem('mx-session');}}paintMode();}
  catch{state.offline=true;try{state.trip=state.authChecked&&localStorage.getItem('mx-trip-owner')===(state.user?.id||'guest')?JSON.parse(localStorage.getItem('mx-trip')||'null'):null;}catch{}toast('连不上服务，先看看已保存的行程。');}
  // 已经有进行中的漫游时，尽量把步频也恢复起来（iOS 可能因为没有用户手势而失败）。
  if(state.session&&!state.session.ended_at){startMotionByDefault();await loadJournal();}
  applyLocationRoute();await render();
  // One automatic attempt per page load; rendering/navigation never requests again.
  await Promise.all([recognizeLocation({automatic:true}),loadRegions()]);
}
init();
window.addEventListener('storage',e=>{if(e.key==='mx-account-change')location.reload();});
window.addEventListener('popstate',()=>{applyLocationRoute();render().then(playPageEnter);});
window.addEventListener('hashchange',()=>{const page=location.hash.replace(/^#\/?/,'');if(page==='auth'||Object.hasOwn(pageRoutes,page)){applyLocationRoute();render();}});
if('serviceWorker' in navigator&&window.isSecureContext)navigator.serviceWorker.register('/sw.js').catch(()=>{});
