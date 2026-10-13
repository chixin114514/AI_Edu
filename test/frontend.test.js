import { pageRoutes, resolvePageRoute } from '../public/page-routes.js';
import { sensorFeatures } from '../public/sensors.js';
import { cleanStopReason, defaultStopReason } from '../public/stop-reasons.js';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace("import { Sensors } from './sensors.js';", '').replace('\ninit();', '\n');

function browser({ stored = new Map(), fetch = async () => ({ ok: true, json: async () => ({}) }), url = 'https://travel.example/plan' } = {}) {
  const handlers = new Map(), nodes = new Map();
  const location=new URL(url),entries=[location.href];let historyIndex=0;
  const history={
    replaceState(_state,_unused,path){location.href=new URL(path,location.href).href;entries[historyIndex]=location.href;},
    pushState(_state,_unused,path){location.href=new URL(path,location.href).href;entries.splice(++historyIndex);entries.push(location.href);},
    back(){if(historyIndex>0){location.href=entries[--historyIndex];handlers.get('window:popstate')?.();}},
    forward(){if(historyIndex<entries.length-1){location.href=entries[++historyIndex];handlers.get('window:popstate')?.();}},
    get length(){return entries.length;}
  };
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: '', textContent: '', value: '', dataset: {}, querySelector: selector => node(selector),
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, fn) { const key=`${selector}:${type}`,previous=handlers.get(key);handlers.set(key, previous ? async e => { await previous(e); return fn(e); } : fn); },
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; }, focus() {}, showModal() { this.open=true; }, close() { this.open=false; }
    });
    return nodes.get(selector);
  };
  class FakeSensors extends EventTarget {
    constructor() { super(); this.samples = []; }
    features() { return {}; }
    stop() {}
  }
  const context = vm.createContext({
    console, document: { querySelector: node, querySelectorAll: () => [], addEventListener: (type, fn) => handlers.set(type, fn) },
    window: { addEventListener(type,fn) { handlers.set('window:'+type,fn); }, removeEventListener() {}, scrollTo() {}, isSecureContext: false },
    navigator: {}, location, history,
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    setTimeout: () => 0, clearTimeout() {}, Sensors: FakeSensors, sensorFeatures, pageRoutes, resolvePageRoute, cleanStopReason, defaultStopReason, routeMapMarkup:()=>'',mountRouteMaps(){},destroyRouteMaps(){}, URL, Blob, AbortController,
    FormData: class { constructor(form) { return Object.entries(form.values)[Symbol.iterator](); } }, fetch
  });
  vm.runInContext(source, context);
  return { run: code => vm.runInContext(code, context), handlers, node, stored, location, history };
}

test('planning values survive navigation and reload without persisting model consent', async () => {
  const b = browser();
  for (const [name, value] of Object.entries({ date: '2026-11-05', budget: '580', companion: '亲子', walk_limit_km: '4', days: '2', start_time: '10:00', end_time: '17:00' })) {
    b.handlers.get('#app:input')({ target: { name, value, id: name === 'walk_limit_km' ? 'walk-limit' : '' } });
  }
  b.run("applyDestination('四川省','成都市');saveDraft()");
  b.handlers.get('#app:input')({ target: { name: 'model_consent', type: 'checkbox', checked: true } });
  await b.run("navigate('trip'); navigate('plan');");
  assert.match(b.node('#app').innerHTML, /value="580"/);
  assert.match(b.node('#app').innerHTML, /value="2026-11-05"/);
  const reloaded = browser({ stored: b.stored });
  await reloaded.run('render()');
  assert.match(reloaded.node('#app').innerHTML, /value="成都市" selected/);
  assert.match(reloaded.node('#app').innerHTML, /value="580"/);
  assert.doesNotMatch(b.stored.get('mx-plan-draft'), /model_consent/);
  assert.doesNotMatch(reloaded.node('#app').innerHTML, /name="model_consent"[^>]*checked/);
});

test('malformed or unexpected stored draft values cannot break planning', async () => {
  for (const value of ['{broken', 'null', '{"city":{},"interests":5,"budget":"bad"}', '{"budget":null}', '{"budget":true}']) {
    const b = browser({ stored: new Map([['mx-plan-draft', value]]) });
    await b.run('render()');
    assert.match(b.node('#app').innerHTML, /id="plan-form"/);
    assert.match(b.node('#app').innerHTML, /value="300"/);
    assert.doesNotMatch(b.node('#app').innerHTML, /\[object Object\]/);
  }
});

test('page paths support forward/back navigation and separate login/register URLs without losing readings',async()=>{
  const b=browser();
  b.run("state.sensor={hr:88,cadence:95};navigate('login')");await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.location.pathname,'/login');assert.match(b.node('#app').innerHTML,/欢迎回来/);
  await clickNode(b,{dataset:{authMode:'register'}});
  assert.equal(b.location.pathname,'/register');assert.match(b.node('#app').innerHTML,/创建账号/);
  const before=b.history.length;
  b.history.back();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.location.pathname,'/login');assert.equal(b.run('state.authMode'),'login');assert.match(b.node('#app').innerHTML,/欢迎回来/);
  b.history.forward();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.location.pathname,'/register');assert.equal(b.run('state.authMode'),'register');assert.equal(b.history.length,before);
  b.run("navigate('plan');navigate('plan')");await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.location.pathname,'/plan');assert.equal(b.history.length,before+1,'reselecting current page must not duplicate history');
  assert.equal(b.run('state.sensor.hr'),88);assert.equal(b.run('state.sensor.cadence'),95);
  const anchor={tagName:'A',dataset:{page:'trip'},classList:{contains:()=>false}};let prevented=false;
  await b.handlers.get('click')({target:{closest:()=>anchor},ctrlKey:true,preventDefault(){prevented=true;}});
  assert.equal(prevented,false,'modified link clicks must retain native new-tab behavior');assert.equal(b.location.pathname,'/plan');
  await b.handlers.get('click')({target:{closest:()=>anchor},button:0,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(b.location.pathname,'/trip');assert.equal(b.run('state.sensor.hr'),88);
});
test('direct login/register pages, old bookmarks and account/ops guards resolve to the correct path',async()=>{
  const fetch=async url=>({ok:true,json:async()=>url==='/api/auth/me'?{user:null}:url==='/api/config'?{data_mode:'demo'}:url==='/api/pois'?{pois:[]}:url==='/api/trips'?{trips:[]}:{provinces:[]}});
  for(const [path,expected,title]of [['/login','/login','欢迎回来'],['/register','/register','创建账号'],['/#auth','/login','欢迎回来'],['/plan#register','/register','创建账号'],['/ops','/login','欢迎回来'],['/account','/login','欢迎回来']]){
    const b=browser({fetch,url:'https://travel.example'+path});await b.run('init()');
    assert.equal(b.location.pathname,expected,path);assert.equal(b.location.hash,'');assert.match(b.node('#app').innerHTML,new RegExp(title));
  }
  const account=browser({url:'https://travel.example/login'});
  account.run("state.user={id:'u',username:'traveler',role:'user'};applyLocationRoute()");await account.run('render()');
  assert.equal(account.location.pathname,'/account');assert.match(account.node('#app').innerHTML,/你好，traveler/);
  account.run("navigate('ops')");await new Promise(resolve=>setImmediate(resolve));assert.equal(account.location.pathname,'/plan');
});

test('proxy HTML and connection failures produce understandable request errors', async () => {
  const b = browser({ fetch: async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('Unexpected token <'); } }) });
  await assert.rejects(b.run("api('/trips')"), /服务暂时不可用/);
  const offline = browser({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.run("api('/trips')"), /网络连接失败/);
});

test('generation is single-flight and successful trip survives a history refresh failure', async () => {
  let complete, calls = 0;
  const trip = { id: 'trip-new', preferences: { city: '杭州' }, days: [] };
  const pending = new Promise(resolve => { complete = resolve; });
  const b = browser({ fetch: async url => {
    if (url === '/api/trip/plan') { calls++; await pending; return { ok: true, json: async () => trip }; }
    throw new TypeError('Failed to fetch');
  } });
  const submit = b.handlers.get('#app:submit');
  const event = { preventDefault() {}, target: { id: 'plan-form', values: { city: '杭州', date: '2026-11-05', days: '1', budget: '300', walk_limit_km: '6' } } };
  const first = submit(event), second = submit(event);
  await b.run("navigate('report'); navigate('plan');");
  // navigate intentionally returns synchronously; let render and submit settle.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.match(b.node('#app').innerHTML, /id="generate-button"[^>]*disabled/);
  await b.run("navigate('report')");
  complete(); await Promise.all([first, second]);
  assert.equal(b.run('state.trip.id'), 'trip-new');
  assert.equal(b.run('state.page'), 'report', 'background generation must not hijack navigation');
  assert.equal(b.run('state.planPending'), false);
  assert.match(b.stored.get('mx-trip'), /trip-new/);
});

test('region selection and optional preferences survive reload, then failed planning can retry', async () => {
  const b = browser({ fetch: async () => ({ ok: false, json: async () => ({ error: '请稍后重试' }) }) });
  b.run("applyDestination('四川省','成都市','510105','青羊区');saveDraft()");
  b.handlers.get('#app:input')({ target: { name: 'budget', value: '580' } });
  const submit = b.handlers.get('#app:submit');
  await submit({ preventDefault() {}, target: { id: 'plan-form', values: { city: '成都市', district_adcode: '510105', days: '1', budget: '580', walk_limit_km: '6' } } });
  assert.equal(b.run('state.planPending'), false);
  assert.match(b.node('#app').innerHTML, /请稍后重试/);
  assert.doesNotMatch(b.node('#app').innerHTML, /id="generate-button"[^>]*disabled/);
  const reloaded = browser({ stored: b.stored });
  await reloaded.run('render()');
  assert.match(reloaded.node('#app').innerHTML, /value="成都市" selected/);
  assert.match(reloaded.node('#app').innerHTML, /value="510105" selected/);
  assert.match(reloaded.node('#app').innerHTML, /value="580"/);
});

test('planning responses from an old account cannot replace the current account trip or pending state', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const b = browser({ fetch: async () => { await pending; return { ok: true, json: async () => ({ id: 'old-account-trip' }) }; } });
  const submit = b.handlers.get('#app:submit');
  const first = submit({ preventDefault() {}, target: { id: 'plan-form', values: { city: '杭州市', days: '1', budget: '300', walk_limit_km: '6' } } });
  await new Promise(resolve => setImmediate(resolve));
  b.run("accountRevision++;state.trip={id:'new-account-trip'};state.planPending=true;state.planError=''");
  complete(); await first;
  assert.equal(b.run('state.trip.id'), 'new-account-trip');
  assert.equal(b.run('state.planPending'), true, 'old response must not unlock another request');
  assert.equal(b.run('state.planError'), '');
  assert.equal(b.stored.has('mx-trip'), false);
});

test('automatic location recognizes surroundings without overwriting a restored destination draft', async () => {
  const stored = new Map([['mx-plan-draft', JSON.stringify({ province: '四川省', city: '成都市', district_adcode: '510105', district: '青羊区' })]]);
  const b = browser({ stored, fetch: async () => ({ ok: true, json: async () => ({ province: '上海市', city: '上海市', district: '黄浦区', adcode: '310101', supported_city: true, nearby: [], resolved_at: '2026-10-12T10:00:00Z' }) }) });
  b.node('#plan-form').isConnected = true;
  b.run('navigator.onLine=true;sensors.locate=async()=>({lat:31,lng:121,accuracy:20})');
  await b.run('recognizeLocation({automatic:true})');
  assert.equal(b.run('state.planCity'), '成都市');
  assert.equal(b.run('state.planDistrict'), '510105');
  assert.equal(b.run('state.location.city'), '上海市');
  await b.run('recognizeLocation()');
  assert.equal(b.run('state.planCity'), '上海市', 'explicit location action may replace the draft');
});

test('background generation refreshes the visible journey without changing the selected page', async () => {
  let complete, finishHistory;
  const historyPending = new Promise(resolve => { finishHistory = resolve; });
  const pending = new Promise(resolve => { complete = resolve; });
  const trip = { id: 'trip-background', preferences: { city: '杭州市' }, days: [] };
  const b = browser({ fetch: async url => {
    if (url === '/api/trip/plan') { await pending; return { ok: true, json: async () => trip }; }
    await historyPending;return { ok: true, json: async () => ({ trips: [trip] }) };
  } });
  const first = b.handlers.get('#app:submit')({ preventDefault() {}, target: { id: 'plan-form', values: { city: '杭州市', days: '1', budget: '300', walk_limit_km: '6' } } });
  await new Promise(resolve => setImmediate(resolve));
  await b.run("navigate('journey')");
  assert.match(b.node('#app').innerHTML, /还没有行程/);
  complete(); await new Promise(resolve => setImmediate(resolve));
  try{
  assert.equal(b.run('state.page'), 'journey');
  assert.match(b.node('#app').innerHTML, /你的行程已准备好/);
  assert.doesNotMatch(b.node('#app').innerHTML, /还没有行程/);
  }finally{finishHistory();await first;}
});

function click(b, id) {
  const button=b.node('#'+id);Object.assign(button,{id,dataset:{},classList:{contains:()=>false}});
  return b.handlers.get('click')({target:{closest:()=>button}});
}
function watchBrowser() {
  const b=browser();
  b.run("state.session={id:'session-a',status:'active'};sensors.disconnect=()=>{};");
  return b;
}
test('watch setup requires explicit consent and keeps its code in page memory only',async()=>{
  const b=watchBrowser();
  b.run('sensors.connectWatch=async()=>{state.sensor={source:"watch",watchStatus:"waiting"};return {code:"AABBCCDD",pair_expires_at:Date.now()+300000}}');
  await click(b,'connect-watch');await click(b,'confirm-watch');
  assert.match(b.node('#toast').textContent,/同意/);
  b.node('#watch-relay-consent').checked=true;await click(b,'confirm-watch');
  assert.match(b.node('#watch-dialog-state').innerHTML,/AABB CCDD/);
  b.run('closeModal()');await click(b,'view-watch');
  assert.match(b.node('#watch-dialog-state').innerHTML,/AABB CCDD/);
  assert.doesNotMatch(JSON.stringify([...b.stored]),/AABB|relay_consent/);
});
test('closing pending watch setup cancels once and cannot reopen a stale dialog',async()=>{
  const b=watchBrowser();let release,starts=0,stops=0;
  b.run('sensors').connectWatch=()=>{starts++;return new Promise(r=>release=r);};
  b.run('sensors').disconnect=()=>{stops++;};
  await click(b,'connect-watch');b.node('#watch-relay-consent').checked=true;
  const first=click(b,'confirm-watch');void click(b,'confirm-watch');
  assert.equal(starts,1);
  b.run('closeModal()');release({code:'AABBCCDD',pair_expires_at:Date.now()+300000});await first;
  assert.equal(b.node('#modal').open,false);assert.equal(stops,1);
  assert.equal(b.run('state.watchPairing'),null);
});
test('watch pairing response cannot cross an account or travel session change',async()=>{
  for(const change of ["accountRevision++;state.session=null", "state.session={id:'session-b',status:'active'}"]){
    const b=watchBrowser();let release;
    b.run('sensors').connectWatch=()=>new Promise(r=>release=r);
    await click(b,'connect-watch');b.node('#watch-relay-consent').checked=true;
    const pending=click(b,'confirm-watch');b.run(change);
    release({code:'AABBCCDD',pair_expires_at:Date.now()+300000});await pending;
    assert.equal(b.run('state.watchPairing'),null);
    assert.doesNotMatch(b.node('#modal-content').innerHTML,/AABB/);
  }
});
test('expired or paired watch codes disappear and disconnected waveform resets',async()=>{
  const b=watchBrowser();b.run("state.watchPairing={session_id:'session-a',code:'AABBCCDD',pair_expires_at:Date.now()-1};state.sensor={source:'watch',watchStatus:'waiting'};updateSensors()");
  assert.match(b.node('#watch-dialog-state').innerHTML,/过期/);
  assert.doesNotMatch(b.node('#watch-dialog-state').innerHTML,/AABB/);
  b.run("state.watchPairing={session_id:'session-a',code:'AABBCCDD',pair_expires_at:Date.now()+300000};state.sensor={source:'watch',watchStatus:'waiting_for_sample'};updateSensors()");
  assert.doesNotMatch(b.node('#watch-dialog-state').innerHTML,/AABB/);
  assert.equal(b.run('state.watchPairing.code'),null);
  b.run("state.sensor={source:'watch',watchStatus:'disconnected',hr:null};updateSensors()");
  assert.equal(b.node('#pulse-line').d,'M0 30h350');assert.equal(b.node('#calibrate').disabled,true);
});
test('paused journeys cannot start watch relay setup',async()=>{
  const b=watchBrowser();b.run("state.session.status='paused'");await click(b,'connect-watch');
  assert.match(b.node('#toast').textContent,/暂停/);assert.notEqual(b.node('#modal').open,true);
});

test('calibration action remains disabled after its click handler completes',async()=>{
  const b=watchBrowser();
  b.run("state.sensor={source:'watch',watchStatus:'live',connected:true,hr:78,calibrating:false};sensors.calibrate=()=>{state.sensor.calibrating=true;updateSensors()};updateSensors()");
  assert.equal(b.node('#calibrate').disabled,false);
  await click(b,'calibrate');
  assert.equal(b.node('#calibrate').disabled,true);
});

// ---------------- 地点选择器 / 公交换乘 / 坡度 ----------------

const toolsTrip={id:'trip-tools',version:1,data_mode:'live',title:'测试行程',explanation:'测试说明',explanation_source:'规划规则',poi_catalog:[],
  preferences:{city:'杭州市',date:'2026-10-20',days:1,budget:300,walk_limit_km:6,interests:['自然'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:false},
  weather:{source:'测试天气',temperature:24,condition:'晴',time_label:'观测时间',updated_at:'2026-10-20T10:00:00Z'},
  days:[{day:1,date:'2026-10-20',distance_m:1500,cost:0,unknown_cost_count:0,duration_min:180,skipped:[],plan_b:{stops:[]},
    stops:[{id:'a',name:'甲地',category:'自然',lat:30.25,lng:120.15,duration_min:45,price:null,per_capita_cost:null,rating:null,recommendation_reason:'适合慢慢走',leg:{distance_m:0,duration_min:0,polyline:[],mode:'live'}},
      {id:'b',name:'乙地',category:'人文',lat:30.26,lng:120.16,duration_min:45,price:null,per_capita_cost:null,rating:null,recommendation_reason:'可以停留',leg:{distance_m:1300,duration_min:18,polyline:[],mode:'live'}}]}]};
const toolsResponses={
  '/api/places':{places:[{id:'p1',name:'测试酒店',lng:121,lat:31,category:'人文',address:'测试路1号'}]},
  '/api/transit':{options:[{duration_min:27,distance_m:1471,walking_distance_m:1274,cost:2,transfers:0,rides:1,segments:[{type:'walk',line:null,from:null,to:null,distance_m:511,duration_min:9},{type:'subway',line:'地铁1号线',from:'甲站',to:'乙站',distance_m:899,duration_min:12}]}],source:'高德公交换乘路径规划',updated_at:'2026-10-20T10:00:00Z'},
  '/api/elevation':{samples:[{lat:30.25,lng:120.15,elevation:10,label:'甲地'},{lat:30.26,lng:120.16,elevation:32,label:'乙地'}],
    segments:[{from_label:'甲地',to_label:'乙地',distance_m:1300,rise_m:20,grade_pct:1.5,level:'flat',level_label:'平缓'},{from_label:'乙地',to_label:'乙地',distance_m:200,rise_m:22,grade_pct:11,level:'steep',level_label:'陡坡'}],
    summary:{gain_m:42,loss_m:0,min_m:10,max_m:32,max_up_grade_pct:11,steep_count:1,point_count:2,measured_count:2,length_m:1500,missing_count:0},
    context:'第 1 天：甲地 → 乙地',dataset:'srtm90m',source:'Open Topo Data',attributions:['SRTM（NASA / USGS）'],
    coordinate_note:'输入按 GCJ-02 解释，查询高程前已转换为 WGS-84。',accuracy_note:'SRTM 90 米网格高程估算，不是实测坡度。',updated_at:'2026-10-20T10:00:00Z'}
};
function toolsBrowser({handler}={}){
  const sent=[];
  const fetch=async(url,options)=>{
    sent.push({url,body:options?.body?JSON.parse(options.body):undefined});
    if(handler)return handler(url,options);
    if(toolsResponses[url])return {ok:true,json:async()=>toolsResponses[url]};
    throw new Error('unexpected '+url);
  };
  const b=browser({fetch});
  b.run("state.config={data_mode:'live'};state.day=1;state.trip="+JSON.stringify(toolsTrip)+";");
  b.sent=sent;
  return b;
}
function controlsBrowser(fetch){
  const b=browser({fetch});
  b.run("state.trip="+JSON.stringify(toolsTrip)+";state.user={id:'admin',username:'admin',role:'admin'};state.session={id:'control-session',day:1,current_index:0,status:'normal',model_consent:true};state.page='journey';state.journalTrip=state.trip.id;state.sensor={hr:75,cadence:95};");
  return b;
}
const controlsForm={id:'journey-controls-form',values:{hr:'110',baseline_hr:'70',cadence:'72',baseline_cadence:'100',duration_s:'200'}};
test('admin journey stays identical apart from a collapsible floating control window; applied values use ordinary feedback',async()=>{
  const calls=[];
  const b=controlsBrowser(async(url,options)=>{
    if(url==='/api/feedback'){calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({status:'rest',require_confirm:false,reason:'就地休息'})};}
    if(url==='/api/session/control-session')return {ok:true,json:async()=>({id:'control-session',day:1,current_index:0,status:'rest',model_consent:true})};
    throw Error('unexpected '+url);
  });
  b.run("state.user.role='user'");await b.run('render()');const ordinary=b.node('#app').innerHTML;
  assert.doesNotMatch(ordinary,/journey-controls/);
  b.run("state.user.role='admin'");await b.run('render()');
  assert.equal(b.node('#app').innerHTML.replace(/<div class="journey-controls">[\s\S]*$/,''),ordinary);
  assert.doesNotMatch(b.node('#app').innerHTML,/admin-simulation|仅管理员|模拟|演示/);
  assert.doesNotMatch(b.node('#app').innerHTML,/id="journey-controls-form"/);
  await click(b,'toggle-journey-controls');assert.match(b.node('#app').innerHTML,/id="journey-controls-form"/);
  b.handlers.get('#app:input')({target:{dataset:{controlField:'hr'},name:'hr',value:'110'}});
  await click(b,'close-journey-controls');await click(b,'toggle-journey-controls');
  assert.match(b.node('#app').innerHTML,/name="hr"[^>]*value="110"/);assert.match(b.node('#heart-value').innerHTML,/75</);
  await b.handlers.get('#app:submit')({preventDefault(){},target:controlsForm});
  assert.equal(calls.length,0,'applying readings must not invoke a separate decision API');
  assert.equal(b.node('#heart-value').innerHTML,'110<small>bpm</small>');assert.equal(b.node('#cadence-value').innerHTML,'72<small>步/分</small>');
  assert.doesNotMatch(b.node('#app').innerHTML,/模拟|仅管理员|演示/);
  await clickNode(b,{dataset:{controlEvent:'state'}});
  assert.equal(calls[0].feedback_type,'state');assert.equal(calls[0].session_id,'control-session');assert.ok(!('demo'in calls[0]));
  assert.deepEqual(calls[0].features,{walked_km_today:0,hr_vs_baseline_pct:57,duration_s:200,cadence_change_pct:-28});
  assert.ok(!('hr'in calls[0].features));
  for(const trigger of ['tired','hungry','rain'])await clickNode(b,{dataset:{controlEvent:trigger}});
  assert.deepEqual(calls.map(c=>c.feedback_type),['state','tired','hungry','rain']);
  await click(b,'controls-unwell');assert.match(b.node('#modal-content').innerHTML,/id="pause-unwell"/);
  b.run('state.sensor.hr=85;updateSensors()');assert.equal(b.node('#heart-value').innerHTML,'110<small>bpm</small>');
  await click(b,'use-device-readings');assert.equal(b.node('#heart-value').innerHTML,'85<small>bpm</small>');
  assert.doesNotMatch([...b.stored.values()].join(''),/baseline_hr|baseline_cadence|duration_s/);
  b.run("state.user.role='user'");await b.run('render()');assert.doesNotMatch(b.node('#app').innerHTML,/journey-controls/);
});
test('floating events prevent overlapping requests and ignore results after a session change',async()=>{
  let finish;const requests=[];
  const b=controlsBrowser(async(url,options)=>{requests.push(url);return new Promise(resolve=>finish=resolve);});
  await click(b,'toggle-journey-controls');
  const trigger=()=>clickNode(b,{dataset:{controlEvent:'rain'}});
  const pending=trigger();await new Promise(resolve=>setImmediate(resolve));
  await trigger();assert.deepEqual(requests,['/api/feedback']);assert.equal(b.run('state.journeyControls.busy'),true);
  finish({ok:false,status:503,json:async()=>({error:'地图服务暂时不可用'})});await pending;
  assert.match(b.node('#app').innerHTML,/地图服务暂时不可用/);assert.equal(b.run('state.journeyControls.busy'),false);
  const second=trigger();await new Promise(resolve=>setImmediate(resolve));
  b.run("state.session={id:'other-session',day:1,current_index:0,status:'normal'};state.suggestion=null");
  finish({ok:true,json:async()=>({require_confirm:true,id:'old-suggestion'})});await second;
  assert.equal(b.run('state.session.id'),'other-session');assert.equal(b.run('state.suggestion'),null);assert.equal(requests.length,2);
  await b.run('render()');assert.equal(b.run('state.journeyControls.applied'),null);assert.equal(b.run('state.journeyControls.open'),false);
  b.run("state.session.status='paused'");await trigger();assert.equal(requests.length,2);
});
test('manual trend duration uses the same automatic event path as devices and low HR resets the trend',async()=>{
  const calls=[];
  const b=controlsBrowser(async(url,options)=>{
    if(url==='/api/feedback'){calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({status:'rest',require_confirm:false,reason:'请休息'})};}
    return {ok:true,json:async()=>({id:'control-session',day:1,current_index:0,status:'rest',model_consent:true})};
  });
  await b.handlers.get('#app:submit')({preventDefault(){},target:controlsForm});
  const event=new Event('change');event.detail={hr:60,cadence:100};b.run('sensors').dispatchEvent(event);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);assert.equal(calls[0].feedback_type,'hr_high_sustained');assert.equal(calls[0].features.hr_vs_baseline_pct,57);
  assert.equal(b.node('#heart-value').innerHTML,'110<small>bpm</small>');
  await b.handlers.get('#app:submit')({preventDefault(){},target:{...controlsForm,values:{...controlsForm.values,hr:'70'}}});
  assert.equal(b.run('currentFeatures().duration_s'),0);
  b.run("state.session.ended_at='now'");assert.equal(b.run('controlledReadings()'),null);
});
function clickNode(b,button){
  Object.assign(button,{classList:{contains:()=>false}});
  return b.handlers.get('click')({target:{closest:()=>button}});
}

test('管理员主动测试按钮显示等待、成功及失败结果，并防止重复请求',async()=>{
  let resolveProbe;const calls=[];
  const b=browser({fetch:async(url,options={})=>{
    if(url==='/api/ops')return {ok:true,json:async()=>({providers:{maps:true,weather:true},provider_status:{}})};
    assert.equal(url,'/api/ops/test');calls.push(JSON.parse(options.body));
    return new Promise(resolve=>{resolveProbe=resolve;});
  }});
  b.run("state.user={id:'admin-id',role:'admin'};state.page='ops'");await b.run('render()');
  assert.match(b.node('#app').innerHTML,/测试地图/);assert.match(b.node('#app').innerHTML,/测试天气/);assert.equal(calls.length,0);
  const pending=clickNode(b,{dataset:{providerTest:'maps'}});
  for(let i=0;i<20&&!resolveProbe;i++)await Promise.resolve();
  try{
    assert.match(b.node('#app').innerHTML,/测试中/);assert.equal((b.node('#app').innerHTML.match(/ disabled/g)||[]).length,2);
    await clickNode(b,{dataset:{providerTest:'weather'}});assert.equal(calls.length,1);
  }finally{resolveProbe({ok:true,json:async()=>({provider:'maps',ok:true,elapsed_ms:123,checked_at:'2026-10-12T10:00:00Z',message:'步行路径返回 820 米，约 11 分钟。'})});await pending;}
  assert.deepEqual(calls,[{provider:'maps',city:'杭州市'}]);assert.match(b.node('#app').innerHTML,/测试成功/);assert.match(b.node('#app').innerHTML,/820 米/);assert.match(b.node('#app').innerHTML,/123 ms/);
  resolveProbe=null;const weather=clickNode(b,{dataset:{providerTest:'weather'}});
  for(let i=0;i<20&&!resolveProbe;i++)await Promise.resolve();
  resolveProbe({ok:true,json:async()=>({provider:'weather',ok:false,error_code:'HTTP_403',message:'<script>失败</script>',elapsed_ms:50})});await weather;
  const html=b.node('#app').innerHTML;assert.match(html,/测试失败/);assert.match(html,/HTTP_403/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/测试成功/);
});

test('主动测试返回时若账号已切换，不展示旧管理员结果',async()=>{
  let resolveProbe;
  const b=browser({fetch:async(url)=>{
    if(url==='/api/ops')return {ok:true,json:async()=>({providers:{},provider_status:{}})};
    if(url==='/api/trips')return {ok:true,json:async()=>({trips:[]})};
    assert.equal(url,'/api/ops/test');return new Promise(resolve=>{resolveProbe=resolve;});
  }});
  b.run("state.user={role:'admin'};state.page='ops'");
  const pending=b.run("testOpsProvider('maps')");
  for(let i=0;i<20&&!resolveProbe;i++)await Promise.resolve();
  await b.run("(async()=>{await switchAccount(null);state.page='auth';})()");
  resolveProbe({ok:true,json:async()=>({ok:true,message:'旧管理员结果'})});await pending;
  assert.equal(b.run('state.providerTesting'),null);assert.equal(b.run('Object.keys(state.providerTests).length'),0);
});

test('地点选择器能检索地点并把它设为起点',async()=>{
  const b=toolsBrowser();
  await click(b,'pick-start');
  assert.equal(b.node('#modal').open,true);
  assert.match(b.node('#modal-content').innerHTML,/选择一个起点/);
  await b.run("(async()=>runPlaceSearch('测试酒店'))()");
  assert.match(b.node('#place-results').innerHTML,/测试酒店/);
  assert.match(b.node('#place-results').innerHTML,/测试路1号/);
  await clickNode(b,Object.assign(b.node('#place-0'),{id:'place-0',dataset:{place:'0'}}));
  assert.equal(b.run('state.planStartPoint.name'),'测试酒店');
  assert.equal(b.run('state.picker'),null);
  assert.match(b.node('#toast').textContent,/起点/);
  // 选完起点后回填到规划表单，按钮显示已选地点。
  await b.run("(async()=>{state.page='plan';await render();})()");
  assert.match(b.node('#app').innerHTML,/起点 · 测试酒店/);
  assert.match(b.node('#app').innerHTML,/id="clear-start"/);
});

test('演示模式下地点检索明确不可用，不弹空选择器',async()=>{
  const b=toolsBrowser();
  b.run("state.config={data_mode:'demo'}");
  await click(b,'pick-start');
  assert.match(b.node('#toast').textContent,/实况服务/);
  assert.notEqual(b.node('#modal').open,true);
});

test('自定义起点会随规划请求提交，行程生成后清空',async()=>{
  const b=toolsBrowser({handler:async url=>{
    if(url==='/api/trips')return {ok:true,json:async()=>({trips:[]})};
    if(url==='/api/trip/plan')return {ok:true,json:async()=>({...toolsTrip,id:'trip-new'})};
    throw new Error('unexpected '+url);
  }});
  b.run("state.planStartPoint={name:'测试酒店',lat:31,lng:121};state.planEndPoint={name:'测试车站',lat:31.1,lng:121.1}");
  b.node('#use-start-point').checked=false;
  const submit=b.handlers.get('#app:submit');
  await submit({preventDefault(){},target:{id:'plan-form',values:{city:'杭州市',date:'2026-10-20',days:'1',budget:'300',walk_limit_km:'6'}}});
  const plan=b.sent.find(entry=>entry.url==='/api/trip/plan');
  assert.deepEqual(plan.body.start_point,{name:'测试酒店',lat:31,lng:121});
  assert.deepEqual(plan.body.end_point,{name:'测试车站',lat:31.1,lng:121.1});
  assert.equal(b.run('state.planStartPoint'),null);
  assert.equal(b.run('state.planEndPoint'),null);
});

test('定位面板勾选后把当前位置作为起终点提交',async()=>{
  const b=toolsBrowser({handler:async url=>{
    if(url==='/api/trips')return {ok:true,json:async()=>({trips:[]})};
    if(url==='/api/trip/plan')return {ok:true,json:async()=>({...toolsTrip,id:'trip-new'})};
    throw new Error('unexpected '+url);
  }});
  b.run("state.location={district:'黄浦区',position:{lat:31.23,lng:121.47}}");
  b.node('#use-start-point').checked=true;
  b.node('#use-end-point').checked=true;
  await b.handlers.get('#app:submit')({preventDefault(){},target:{id:'plan-form',values:{city:'杭州市',date:'2026-10-20',days:'1',budget:'300',walk_limit_km:'6'}}});
  const plan=b.sent.find(entry=>entry.url==='/api/trip/plan');
  assert.deepEqual(plan.body.start_point,{name:'黄浦区',lat:31.23,lng:121.47});
  assert.deepEqual(plan.body.end_point,{name:'返回当前位置',lat:31.23,lng:121.47});
});

test('行程页能查询公交换乘并显示分段与票价',async()=>{
  const b=toolsBrowser();
  await b.run("(async()=>{state.page='trip';await render();})()");
  assert.match(b.node('#app').innerHTML,/公交换乘/);
  assert.match(b.node('#app').innerHTML,/第1站 甲地/);
  assert.equal(b.run('state.transit.from.name'),'第1站 甲地');
  assert.equal(b.run('state.transit.to.name'),'第2站 乙地');
  await click(b,'query-transit');
  const html=b.node('#app').innerHTML;
  assert.match(html,/地铁1号线/);
  assert.match(html,/直达/);
  assert.match(html,/约 ¥2/);
  assert.match(html,/约 1274 m/);
  const call=b.sent.find(entry=>entry.url==='/api/transit');
  assert.equal(call.body.trip_id,'trip-tools');
  assert.equal(call.body.from.name,'第1站 甲地');
});

test('行程页能计算并显示爬升与坡段',async()=>{
  const b=toolsBrowser();
  await b.run("(async()=>{state.page='trip';await render();})()");
  assert.match(b.node('#app').innerHTML,/坡度与爬升/);
  await click(b,'load-elevation');
  const html=b.node('#app').innerHTML;
  assert.match(html,/累计爬升/);
  assert.match(html,/42 m/);
  assert.match(html,/陡坡 1 段/);
  assert.match(html,/值得留意的坡段/);
  assert.match(html,/甲地 → 乙地/);
  assert.match(html,/乙地 附近/,'同一站内的坡段不重复显示站名');
  assert.match(html,/下坡|上坡/);
  assert.match(html,/elevation-chart/);
  assert.match(html,/不是实测坡度/);
  assert.match(html,/Open Topo Data/);
  const call=b.sent.find(entry=>entry.url==='/api/elevation');
  assert.deepEqual(call.body,{trip_id:'trip-tools',day:1});
});

test('换乘与高程结果不会跨旅行日复用',async()=>{
  const b=toolsBrowser();
  const twoDay={...toolsTrip,days:[toolsTrip.days[0],{...toolsTrip.days[0],day:2,date:'2026-10-21'}]};
  b.run('state.trip='+JSON.stringify(twoDay)+";state.transit={key:'trip-tools:1',from:{name:'旧',lat:30,lng:120},to:{name:'旧2',lat:30.1,lng:120.1},result:'stale',error:'',loading:false};state.elevation={key:'trip-tools:1',data:'stale',loading:false,error:''}");
  await b.run('(async()=>{state.day=2;state.page="trip";await render();})()');
  assert.equal(b.run('state.transit.result'),null);
  assert.equal(b.run('state.elevation.data'),null);
  assert.equal(b.run('state.transit.from.name'),'第1站 甲地');
});

// ---------------- 景点详情、增删改序、日记、步频与收尾文字 ----------------

const editStops=[{id:'p1',name:'第一站',category:'自然',lat:30.25,lng:120.15,duration_min:45,price:null,per_capita_cost:null,rating:null,indoor:false,recommendation_reason:'沿湖的一段',leg:{distance_m:0,duration_min:0,polyline:[],mode:'live'}},
  {id:'p2',name:'第二站',category:'人文',lat:30.26,lng:120.16,duration_min:45,price:null,per_capita_cost:null,rating:null,indoor:true,recommendation_reason:'室内看看展',leg:{distance_m:900,duration_min:12,polyline:[],mode:'live'}},
  {id:'p3',name:'第三站',category:'美食',lat:30.27,lng:120.17,duration_min:60,price:null,per_capita_cost:58,rating:4.6,indoor:true,recommendation_reason:'吃口热的',leg:{distance_m:700,duration_min:9,polyline:[],mode:'live'}}];
const editTrip={...toolsTrip,id:'trip-edit',poi_catalog:editStops,preferences:{...toolsTrip.preferences,must_visit:[]},
  days:[{...toolsTrip.days[0],stops:editStops.map(stop=>({...stop,arrival:'09:10',departure:'09:55'}))}]};
function editBrowser({handler}={}){
  const b=toolsBrowser({handler:async(url,options)=>{
    if(handler){const done=await handler(url,options);if(done)return done;}
    if(url==='/api/elevation')return {ok:true,json:async()=>({summary:{min_m:23},samples:[],segments:[]})};
    if(url==='/api/journal')return {ok:true,json:async()=>({entry:{id:'e',trip_id:'trip-edit',day:1,stop_id:'p1',stop_name:'第一站',text:'留一句',photo_ids:[],created_at:'2026-10-20T09:00:00Z',updated_at:'2026-10-20T09:00:00Z'}})};
    if(url==='/api/trip/trip-edit/journal')return {ok:true,json:async()=>({entries:[],limits:{}})}; 
    throw new Error('unexpected '+url);
  }});
  b.run('state.trip='+JSON.stringify(editTrip)+';state.pois=[];state.journal={};state.journalTrip="trip-edit";');
  return b;
}

test('景点详情弹窗给出时间、坐标、海拔与分段导航链接',async()=>{
  const b=editBrowser();
  await b.run("(async()=>{state.page='trip';await render();})()");
  assert.match(b.node('#app').innerHTML,/data-stop-detail="p2"/);
  await clickNode(b,{id:'',dataset:{stopDetail:'p2'}});
  // 海拔是拿到详情之后再补的，等一拍再断言。
  await new Promise(resolve=>setImmediate(resolve));
  const modal=b.node('#modal-content').innerHTML;
  assert.match(modal,/第二站/);
  assert.match(modal,/09:10 — 09:55/);
  assert.match(modal,/GCJ-02 120\.16000, 30\.26000/);
  assert.match(modal,/900 m · 12 分钟/);
  assert.match(modal,/约 23 米/,'海拔由 /api/elevation 补上');
  // 导航按段生成，坐标顺序是「经度,纬度」，并且是步行模式。
  const navigation=modal.match(/href="[^"]*uri\.amap\.com\/navigation[^"]*"/g)||[];
  assert.equal(navigation.length,2,'既要有「导航到这一站」，也要有「去下一站」');
  assert.match(navigation[0],/from=120\.15,30\.25,/);
  assert.match(navigation[0],/to=120\.16,30\.26/);
  assert.match(navigation[0],/mode=walk/);
  assert.match(navigation[1],/from=120\.16,30\.26/);
  assert.match(navigation[1],/to=120\.17,30\.27/);
  assert.match(modal,/uri\.amap\.com\/marker/);
});

test('移出与加入当天行程都会提交完整的新顺序',async()=>{
  const posted=[];
  const b=editBrowser({handler:async(url,options)=>{
    if(url==='/api/trip/trip-edit/stops'){
      posted.push(JSON.parse(options.body));
      // 回一个和提交内容一致的行程，后面的操作才是在新状态上继续。
      const stops=posted.at(-1).stops.map(item=>editStops.find(stop=>stop.id===item.id)||{...item,id:'custom-1'});
      return {ok:true,json:async()=>({trip:{...editTrip,version:2+posted.length,days:[{...editTrip.days[0],stops}]},warnings:[]})};
    }
    return null;
  }});
  await b.run("(async()=>{state.page='trip';await render();})()");
  await clickNode(b,{id:'',dataset:{stopRemove:'p3'}});
  assert.equal(posted.length,1);
  assert.deepEqual(posted[0].stops.map(stop=>stop.id),['p1','p2'],'移出后提交剩下的顺序');
  assert.equal(posted[0].day,1);
  await clickNode(b,{id:'',dataset:{addStop:'p3'}});
  assert.equal(posted.length,2);
  assert.deepEqual(posted[1].stops.map(stop=>stop.id),['p1','p2','p3'],'加入后追加到当天末尾');
  // 候选池里的地点只回传 id，客户端不能借编辑接口改票价。
  assert.deepEqual(Object.keys(posted[1].stops[2]),['id']);
});

test('模型授权和定位都直接显示在规划表单里，不收进折叠栏',async()=>{
  const b=toolsBrowser();
  await b.run("(async()=>{state.page='plan';await render();})()");
  const html=b.node('#app').innerHTML;
  assert.match(html,/name="model_consent"/);
  assert.match(html,/是否将兴趣和行程节点发送给 DeepSeek/);
  // 规划表单里不再有折叠栏：授权开关和定位都直接可见。
  assert.doesNotMatch(html,/<details/,'模型授权不能藏在折叠栏里');
  assert.match(html,/id="locate-plan"/);
  // 仍然不落盘：勾选后重新加载不该变成默认勾选。
  b.handlers.get('#app:input')({target:{name:'model_consent',type:'checkbox',checked:true}});
  assert.equal(b.run('state.planConsent'),true);
  assert.doesNotMatch(b.stored.get('mx-plan-draft')||'',/model_consent/);
});

test('景点列表不再提供拖动把手',async()=>{
  const b=editBrowser();
  await b.run("(async()=>{state.page='trip';await render();})()");
  const html=b.node('#app').innerHTML;
  assert.doesNotMatch(html,/drag-handle/);
  assert.doesNotMatch(html,/data-drag/);
  assert.match(html,/data-stop-remove="p1"/,'移出仍然保留');
});

test('伴行页心率步频常驻显示，写日记时文字落到接口',async()=>{
  const posted=[];
  const b=editBrowser({handler:async(url,options)=>{
    if(url==='/api/journal'){posted.push(JSON.parse(options.body));return {ok:true,json:async()=>({entry:{id:'e',trip_id:'trip-edit',day:1,stop_id:'p1',stop_name:'第一站',text:'风很大，坐了一会儿',photo_ids:['ph1'],created_at:'2026-10-20T09:00:00Z',updated_at:'2026-10-20T09:30:00Z'}})};}
    return null;
  }});
  b.run("state.session={id:'s1',trip_id:'trip-edit',day:1,status:'active',current_index:0,model_consent:false};state.sensor={motionActive:true,cadence:96,hr:88,steps:1200};");
  await b.run("(async()=>{state.page='journey';await render();})()");
  const html=b.node('#app').innerHTML;
  // 心率与步频直接展示，不再藏在折叠面板里。
  assert.match(html,/当前心率/);
  assert.match(html,/估计步频/);
  assert.doesNotMatch(html,/device-details/);
  assert.match(html,/这一站的日记/);
  await click(b,'edit-journal');
  assert.match(b.node('#modal-content').innerHTML,/这一刻/);
  // 从文本框取值，而不是直接写状态：真实用户是在 textarea 里打字的。
  b.node('#journal-text').value='风很大，坐了一会儿';
  await click(b,'save-journal');
  assert.equal(posted.length,1);
  assert.deepEqual(posted[0],{trip_id:'trip-edit',day:1,stop_id:'p1',text:'风很大，坐了一会儿'});
  assert.equal(b.run('state.journal["1:p1"].text'),'风很大，坐了一会儿');
  assert.equal(b.node('#modal').open,false);
});

test('弹窗重绘前先把文本框的值收回草稿，加照片不会丢掉已输入的文字',async()=>{
  const b=editBrowser();
  b.run("state.session={id:'s1',trip_id:'trip-edit',day:1,status:'active',current_index:0,model_consent:false};state.sensor={};");
  await b.run("(async()=>{state.page='journey';await render();})()");
  await click(b,'edit-journal');
  b.node('#journal-text').value='已经打好的字';
  // 真实的输入监听挂在 #app 上，弹窗里的文本框不在其中，所以重绘前必须手动同步。
  b.run('syncJournalText()');
  assert.equal(b.run('state.journalDraft.text'),'已经打好的字');
  b.run('paintJournal()');
  assert.match(b.node('#modal-content').innerHTML,/已经打好的字/,'重绘后文字仍然在');
  // 既没有文字也没有照片时，服务端会删掉记录，提示不能谎称已保存。
  const empty=editBrowser({handler:async url=>url==='/api/journal'?{ok:true,json:async()=>({entry:null,deleted:true})}:null});
  empty.run("state.session={id:'s1',trip_id:'trip-edit',day:1,status:'active',current_index:0,model_consent:false};state.sensor={};");
  await empty.run("(async()=>{state.page='journey';await render();})()");
  await click(empty,'edit-journal');
  await click(empty,'save-journal');
  assert.match(empty.node('#toast').textContent,/已经删掉/);
});

test('已有日记会直接显示在伴行页，照片用 data URL 内联',async()=>{
  const b=editBrowser();
  b.run("state.session={id:'s1',trip_id:'trip-edit',day:1,status:'active',current_index:0,model_consent:false};state.journal={'1:p1':{id:'e',day:1,stop_id:'p1',stop_name:'第一站',text:'先前的记录',photos:[{id:'ph0',mime:'image/jpeg',size:10,url:'data:image/jpeg;base64,AAA'}],updated_at:'2026-10-20T09:00:00Z'}};state.journalTrip='trip-edit';");
  await b.run("(async()=>{state.page='journey';await render();})()");
  const html=b.node('#app').innerHTML;
  assert.match(html,/先前的记录/);
  assert.match(html,/data:image\/jpeg;base64,AAA/);
  await click(b,'edit-journal');
  assert.match(b.node('#modal-content').innerHTML,/data:image\/jpeg;base64,AAA/,'编辑时能看到已有的照片');
  assert.match(b.node('#modal-content').innerHTML,/删除这张/);
});

test('开始漫游时默认申请步频，失败也不打扰',async()=>{
  const b=editBrowser({handler:async url=>url==='/api/session/start'?{ok:true,json:async()=>({id:'s1',trip_id:'trip-edit',day:1,status:'active',current_index:0,model_consent:false,ended_at:null})}:null});
  b.run("window.DeviceMotionEvent=function(){};let motionCalls=0;sensors.startMotion=async()=>{motionCalls++;state.sensor={...state.sensor,motionActive:true};};sensors.disconnect=()=>{};state.journalTrip='trip-edit';");
  b.node('#health-model-consent').checked=false;
  await click(b,'start-journey');
  await click(b,'confirm-start');
  assert.equal(b.run('motionCalls'),1,'开始漫游时自动开启步频');
  // 不支持运动传感器的浏览器里静默跳过，不弹提示。
  const plain=editBrowser({handler:async url=>url==='/api/session/start'?{ok:true,json:async()=>({id:'s2',trip_id:'trip-edit',day:1,status:'active',current_index:0,model_consent:false,ended_at:null})}:null});
  plain.run("let m=0;sensors.startMotion=async()=>{m++;};sensors.disconnect=()=>{};state.journalTrip='trip-edit';");
  plain.node('#health-model-consent').checked=false;
  await click(plain,'start-journey');
  await click(plain,'confirm-start');
  assert.equal(plain.run('m'),0);
});

test('收尾文字卡片：未授权时说明原因，授权后可生成并展示',async()=>{
  const noConsent=editBrowser({handler:async url=>url==='/api/trip/trip-edit/report'?{ok:true,json:async()=>({finished:true,visited_stops:2,total_stops:3,walked_km:2.4,planned_distance_km:3.1,accepted:1,rejected:0,events:[],preference_note:'继续记录。',data_mode:'live',summary:null,journal:[]})}:null});
  noConsent.run("(async()=>{state.page='report';await render();})()");
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(noConsent.node('#app').innerHTML,/没有开启 DeepSeek/);
  assert.doesNotMatch(noConsent.node('#app').innerHTML,/id="write-summary"/);

  let summaryCalls=0,generated=null;
  const summaryRecord={text:'风把湖面吹皱。',generated_at:'2026-10-20T10:00:00Z',source:'DeepSeek summary-model'};
  const consented=editBrowser({handler:async url=>{
    if(url==='/api/trip/trip-edit/report')return {ok:true,json:async()=>({finished:true,visited_stops:2,total_stops:3,walked_km:2.4,planned_distance_km:3.1,accepted:1,rejected:0,events:[],preference_note:'继续记录。',data_mode:'live',summary:generated,journal:[{id:'e',day:1,stop_id:'p1',stop_name:'第一站',text:'风很大',photos:[{id:'ph1',mime:'image/jpeg',size:9,url:'data:image/jpeg;base64,BBB'}],updated_at:'2026-10-20T09:10:00Z'}]})};
    if(url==='/api/trip/trip-edit/summary'){summaryCalls++;generated=summaryRecord;return {ok:true,json:async()=>({summary:summaryRecord})};}
    if(url==='/api/trip/trip-edit')return {ok:true,json:async()=>({...editTrip,preferences:{...editTrip.preferences,model_consent:true},summary:generated})};
    return null;
  }});
  consented.run("state.trip="+JSON.stringify({...editTrip,preferences:{...editTrip.preferences,model_consent:true}}));
  consented.run("(async()=>{state.page='report';await render();})()");
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(consented.node('#app').innerHTML,/写一段收尾文字/);
  assert.match(consented.node('#app').innerHTML,/第二站的日记|这一程的日记/);
  assert.match(consented.node('#app').innerHTML,/data:image\/jpeg;base64,BBB/);
  await click(consented,'write-summary');
  assert.equal(summaryCalls,1);
  assert.match(consented.node('#app').innerHTML,/风把湖面吹皱。/);
  assert.match(consented.node('#app').innerHTML,/summary-model/);
});

// ---------------- 行程安排：调整顺序、添加地点、自动落位 ----------------

function stopsServer(posted,{placed=null}={}){
  return async(url,options)=>{
    if(url!=='/api/trip/trip-edit/stops')return null;
    posted.push(JSON.parse(options.body));
    const stops=posted.at(-1).stops.map((item,index)=>editStops.find(stop=>stop.id===item.id)||{...item,id:'custom-'+index,category:item.category||'人文',duration_min:45,leg:{distance_m:0,duration_min:0,polyline:[],mode:'live'}}).map(stop=>({...stop,arrival:'09:10',departure:'09:55'}));
    return {ok:true,json:async()=>({trip:{...editTrip,version:2+posted.length,days:[{...editTrip.days[0],stops}]},warnings:[],placed})};
  };
}
const order=html=>[...html.matchAll(/data-stop-remove="([^"]+)"/g)].map(match=>match[1]);

test('上移下移先只改本地顺序，点保存才提交一次；撤销恢复原样',async()=>{
  const posted=[];
  const b=editBrowser({handler:stopsServer(posted)});
  await b.run("(async()=>{state.page='trip';await render();})()");
  assert.deepEqual(order(b.node('#app').innerHTML),['p1','p2','p3']);
  assert.match(b.node('#app').innerHTML,/data-stop-move="-1" data-stop="p1"[^>]*disabled/,'第一站不能再上移');
  assert.match(b.node('#app').innerHTML,/data-stop-move="1" data-stop="p3"[^>]*disabled/,'最后一站不能再下移');
  assert.doesNotMatch(b.node('#app').innerHTML,/id="reorder-save"/);
  await clickNode(b,{id:'',dataset:{stopMove:'1',stop:'p1'}});
  await clickNode(b,{id:'',dataset:{stopMove:'1',stop:'p1'}});
  const pending=b.node('#itinerary').innerHTML;
  assert.deepEqual(order(pending),['p2','p3','p1']);
  assert.match(pending,/id="reorder-save"/);
  assert.doesNotMatch(pending,/<time>/,'顺序没保存前，旧的到达时间不再显示');
  assert.equal(posted.length,0,'调整过程中不请求服务端');
  await click(b,'reorder-cancel');
  assert.deepEqual(order(b.node('#itinerary').innerHTML),['p1','p2','p3']);
  assert.equal(b.run('state.reorder'),null);
  // 挪回原位等于没改，不留下「未保存」状态。
  await clickNode(b,{id:'',dataset:{stopMove:'1',stop:'p2'}});
  await clickNode(b,{id:'',dataset:{stopMove:'-1',stop:'p2'}});
  assert.equal(b.run('state.reorder'),null);
  await clickNode(b,{id:'',dataset:{stopMove:'-1',stop:'p3'}});
  await click(b,'reorder-save');
  assert.equal(posted.length,1);
  assert.deepEqual(posted[0].stops,[{id:'p1'},{id:'p3'},{id:'p2'}]);
  assert.equal(posted[0].auto_place,undefined,'保存顺序时不让服务端再挪位置');
  assert.equal(b.run('state.reorder'),null);
  assert.deepEqual(order(b.node('#app').innerHTML),['p1','p3','p2']);
  assert.match(b.node('#app').innerHTML,/<time>09:10<\/time>/);
});

test('未保存的顺序不会带到另一天，移出时连同新顺序一起提交',async()=>{
  const posted=[];
  const b=editBrowser({handler:stopsServer(posted)});
  await b.run("(async()=>{state.page='trip';await render();})()");
  await clickNode(b,{id:'',dataset:{stopMove:'-1',stop:'p3'}});
  assert.equal(b.run('orderedStops().map(stop=>stop.id).join()'),'p1,p3,p2');
  b.run('state.day=2');
  assert.equal(b.run('orderedStops().length'),0,'另一天不受影响');
  b.run('state.day=1');
  await clickNode(b,{id:'',dataset:{stopRemove:'p1'}});
  assert.deepEqual(posted[0].stops,[{id:'p3'},{id:'p2'}]);
});

test('添加地点：演示模式从候选里挑，新地点交给服务端选位置并提示结果',async()=>{
  const posted=[];
  const b=editBrowser({handler:stopsServer(posted,{placed:{id:'c2',name:'湖边面馆',index:1,meal:'午餐'}})});
  b.run("state.config={data_mode:'demo'};state.trip.poi_catalog=[];state.pois="+JSON.stringify([
    ...editStops,
    {id:'c1',name:'远处的塔',category:'建筑',lat:30.40,lng:120.30,duration_min:45},
    {id:'c2',name:'湖边面馆',category:'美食',lat:30.2601,lng:120.1601,duration_min:60}]));
  await b.run("(async()=>{state.page='trip';await render();})()");
  assert.match(b.node('#app').innerHTML,/id="add-place"/);
  await click(b,'add-place');
  const dialog=b.node('#modal-content').innerHTML;
  assert.equal(b.node('#modal').open,true);
  assert.match(dialog,/添加到第 1 天/);
  assert.doesNotMatch(dialog,/id="place-search"/,'演示模式没有地点检索，不显示搜索框');
  assert.doesNotMatch(dialog,/data-add-stop="p1"/,'已经在当天行程里的不再列出');
  assert.ok(dialog.indexOf('湖边面馆')<dialog.indexOf('远处的塔'),'离路线近的排前面');
  await clickNode(b,{id:'',dataset:{addStop:'c2'}});
  assert.equal(posted.length,1);
  assert.deepEqual(posted[0].stops,[{id:'p1'},{id:'p2'},{id:'p3'},{id:'c2'}]);
  assert.equal(posted[0].auto_place,3);
  assert.equal(b.node('#modal').open,false);
  assert.match(b.node('#toast').textContent,/排在第 2 站/);
  assert.match(b.node('#toast').textContent,/午餐时间/);
});

test('添加地点：实况模式可以搜索，搜到的新地点按名称与坐标提交',async()=>{
  const posted=[];
  const b=editBrowser({handler:async(url,options)=>{
    // 搜索结果的 id 不在行程和候选池里，按新地点处理。
    if(url==='/api/places')return {ok:true,json:async()=>({places:[{id:'amap-9',name:'测试酒店',lng:121,lat:31,category:'人文',address:'测试路1号'}]})};
    return stopsServer(posted,{placed:{id:'custom-3',name:'测试酒店',index:3,meal:null}})(url,options);
  }});
  await b.run("(async()=>{state.page='trip';await render();})()");
  await click(b,'add-place');
  assert.match(b.node('#modal-content').innerHTML,/id="place-search"/);
  await b.run("(async()=>runPlaceSearch('测试酒店'))()");
  assert.equal(b.sent.find(entry=>entry.url==='/api/places').body.trip_id,'trip-edit');
  await clickNode(b,{id:'',dataset:{place:'0'}});
  assert.equal(posted.length,1);
  assert.deepEqual(posted[0].stops.at(-1),{name:'测试酒店',lat:31,lng:121,category:'人文',indoor:false});
  assert.equal(posted[0].auto_place,3);
  assert.match(b.node('#toast').textContent,/最顺路/);
});

test('一天满 8 站时不再提交；旧数据里超过 24 点的时间显示成次日',async()=>{
  const posted=[];
  const b=editBrowser({handler:stopsServer(posted)});
  const eight=Array.from({length:8},(_,index)=>({...editStops[0],id:'s'+index,name:'站'+index,arrival:'09:00',departure:'09:30'}));
  b.run('state.trip.days[0].stops='+JSON.stringify(eight));
  await b.run("addStop({id:'x',name:'第九个',lat:30,lng:120,category:'人文'})");
  assert.equal(posted.length,0);
  assert.match(b.node('#toast').textContent,/最多 8 个/);
  assert.equal(b.run("dayTime('25:10')"),'次日 01:10');
  assert.equal(b.run("dayTime('09:05')"),'09:05');
  assert.equal(b.run("dayTime(undefined)"),'');
  const late=b.run(`timeline({day:1,stops:[{id:'a',name:'很晚的一站',category:'人文',lng:120,lat:30,arrival:'24:35',departure:'25:20'}]})`);
  assert.match(late,/<time>次日 00:35<\/time>/);
  assert.doesNotMatch(late,/24:35/);
});

// ---------------- 标签栏：当前页标记、进场动画与加载提示 ----------------

test('切换标签会标记当前页并播放一次进场动画，同一页内的重绘不播',async()=>{
  const b=editBrowser();
  const played=[];
  b.node('#app').classList={add:name=>played.push(name),remove(){},toggle(){},contains:()=>false};
  b.run("navigate('trip')");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.node('.main-nav').dataset.active,'trip','底部标签栏靠这个标记移动当前标签的底块');
  assert.deepEqual(played,['page-enter']);
  // 页面内的操作（比如上移一站后重绘）不应该让整页再闪一次。
  await b.run('render()');
  assert.deepEqual(played,['page-enter']);
  // 点的是当前所在的标签：不换页，也不重播。
  b.run("navigate('trip')");
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(played,['page-enter']);
  b.run("navigate('plan')");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.node('.main-nav').dataset.active,'plan');
  assert.deepEqual(played,['page-enter','page-enter']);
});

test('手记页等接口返回期间保留原来的内容，不立刻换成加载提示',async()=>{
  let finish;
  const report={finished:false,visited_stops:1,total_stops:3,walked_km:0.8,planned_distance_km:3.1,accepted:0,rejected:0,events:[],preference_note:'',data_mode:'live',summary:null,journal:[]};
  const b=editBrowser({handler:async url=>url==='/api/trip/trip-edit/report'?new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>report});}):null});
  await b.run("(async()=>{state.page='trip';await render();})()");
  assert.match(b.node('#app').innerHTML,/行程安排/);
  b.run("navigate('report')");
  for(let i=0;i<20&&!finish;i++)await Promise.resolve();
  assert.equal(b.node('.main-nav').dataset.active,'report','标签先切过去，给出即时反馈');
  assert.match(b.node('#app').innerHTML,/行程安排/,'接口没回来之前还是上一页的内容');
  assert.doesNotMatch(b.node('#app').innerHTML,/class="loading"/);
  finish();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(b.node('#app').innerHTML,/途中发生了什么/);
  assert.doesNotMatch(b.node('#app').innerHTML,/行程安排/);
});

test('管理员停在运营页时退出登录，只收起菜单里的运营入口，页面内容还在',async()=>{
  const b=browser({fetch:async url=>({ok:true,json:async()=>url==='/api/ops'?{providers:{},provider_status:{}}:{}})});
  const main=b.node('#app'),entry={hidden:true,dataset:{page:'ops'},classList:{toggle(){}},setAttribute(){},removeAttribute(){}};
  const hiddenWrites=[];
  Object.defineProperty(main,'hidden',{get:()=>false,set:value=>hiddenWrites.push(value)});
  // 真实页面里 <main id="app"> 自己也带 data-page，停在运营页时同样匹配不加限定的 [data-page="ops"]。
  b.run('document').querySelectorAll=selector=>selector.split(',').some(part=>part.trim().startsWith('[data-page="ops"]'))?[main,entry]:[entry];
  b.run("state.user={id:'admin-id',username:'admin',role:'admin'};state.page='ops'");
  await b.run('render()');
  assert.equal(entry.hidden,false,'管理员能看到运营入口');
  assert.match(main.innerHTML,/服务连接状态/);
  await b.run("(async()=>{await switchAccount(null);navigate('login');})()");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(entry.hidden,true,'退出后入口收起');
  assert.ok(!hiddenWrites.includes(true),'主内容区不能被一起隐藏，否则退出后整页空白');
  assert.match(main.innerHTML,/欢迎回来/);
});

// ---------------- 排版改版：限定语一句不少，不靠装饰撑场面 ----------------

test('票价没核实时花费写「待核实」且不承诺预算；都核实了才显示金额',async()=>{
  const b=editBrowser();
  b.run("state.trip.days[0].unknown_cost_count=2;state.trip.days[0].cost=137;");
  await b.run("(async()=>{state.page='trip';await render();})()");
  let html=b.node('#app').innerHTML;
  assert.match(html,/<dt>花费<\/dt><dd><strong class="word">待核实<\/strong><\/dd>/);
  assert.match(html,/<p class="note">2 处价格未知，预算 ¥300 暂不能保证。<\/p>/,'说清有几处没核实，也不承诺预算');
  assert.doesNotMatch(html,/免费/,'没核实的票价不能写成免费');
  assert.doesNotMatch(html,/¥137/,'已知部分的小计不能单独摆出来当总花费');
  b.run("state.trip.days[0].unknown_cost_count=0;");
  await b.run('render()');
  html=b.node('#app').innerHTML;
  assert.match(html,/<dt>花费<\/dt><dd><strong>¥137<\/strong><span class="note">预算 ¥300<\/span><\/dd>/);
  assert.doesNotMatch(html,/待核实|暂不能保证|价格未知/);
});

test('服务端随行程下发的核实事项原文列在「出发前核实」里，没有就不出现这一节',async()=>{
  const warnings=['营业时间、票价和预约要求尚未核实；未知费用不视为免费，暂不能保证总预算。','停留时长为规划估计，室内属性按地点类别推断；雨天候选需核实后使用。','<b>不当标签</b>'];
  const b=editBrowser();
  await b.run("(async()=>{state.page='trip';await render();})()");
  assert.doesNotMatch(b.node('#app').innerHTML,/出发前核实/);
  b.run('state.trip.warnings=[]');
  await b.run('render()');
  assert.doesNotMatch(b.node('#app').innerHTML,/出发前核实/,'空清单不留一个空标题');
  b.run('state.trip.warnings='+JSON.stringify(warnings));
  await b.run('render()');
  const section=b.node('#app').innerHTML.match(/<h2 class="section-title">出发前核实<\/h2><ul class="checks">([\s\S]*?)<\/ul>/);
  assert.ok(section,'核实事项单独成节');
  // 一条不少、一字不改；只做转义。
  assert.deepEqual([...section[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match=>match[1]),warnings.map(text=>b.run(`esc(${JSON.stringify(text)})`)));
  assert.doesNotMatch(section[1],/<b>/);
});

test('演示行程写明数据是样例、不能用来导航；实况行程没有这句',async()=>{
  const b=editBrowser();
  b.run("state.trip.data_mode='demo'");
  await b.run("(async()=>{state.page='trip';await render();})()");
  assert.match(b.node('#app').innerHTML,/<p class="notice">演示数据：距离、时间和天气都是样例，不能用来导航。<\/p>/);
  b.run("state.trip.data_mode='live'");
  await b.run('render()');
  assert.doesNotMatch(b.node('#app').innerHTML,/演示数据|不能用来导航/);
});

test('顶栏标出现在看的是演示数据还是实时数据',()=>{
  const b=browser();
  b.node('#mode-pill').hidden=true;
  b.run('paintMode()');
  assert.equal(b.node('#mode-pill').hidden,true,'配置没拿到之前不乱标');
  b.run("state.config={data_mode:'demo'};paintMode()");
  assert.equal(b.node('#mode-pill').textContent,'演示数据');
  assert.equal(b.node('#mode-pill').dataset.mode,'demo');
  assert.equal(b.node('#mode-pill').hidden,false);
  b.run("state.config={data_mode:'live'};paintMode()");
  assert.equal(b.node('#mode-pill').textContent,'实时数据');
  assert.equal(b.node('#mode-pill').dataset.mode,'live');
});

test('身体状态面板写明读数只用来提醒，不用于诊断',async()=>{
  const b=editBrowser();
  b.run("state.session={id:'s1',trip_id:'trip-edit',day:1,status:'active',current_index:0,model_consent:false};");
  await b.run("(async()=>{state.page='journey';await render();})()");
  assert.match(b.node('#app').innerHTML,/<p class="note">只用来提醒你调整节奏，不用于诊断。<\/p>/);
});

test('公交票价没拿到时写「未知」，只有明确为 0 元才写免费',()=>{
  const b=browser();
  const fare=cost=>b.run(`transitResult(${JSON.stringify({options:[{...toolsResponses['/api/transit'].options[0],cost}],source:'高德公交换乘路径规划',updated_at:'2026-10-20T10:00:00Z'})})`);
  assert.match(fare(null),/票价未知/);
  assert.doesNotMatch(fare(null),/免费|¥/);
  assert.match(fare(2),/票价约 ¥2/);
  assert.match(fare(0),/票价免费/);
});

test('每站写明停留多久，站与站之间写明要走多久多远；顺序没保存时不显示旧的步行段',async()=>{
  const b=editBrowser({handler:stopsServer([])});
  await b.run("(async()=>{state.page='trip';await render();})()");
  const list=b.node('#app').innerHTML;
  assert.deepEqual([...list.matchAll(/<li class="leg">([^<]*)<\/li>/g)].map(match=>match[1]),['步行 12 分钟 · 900 m','步行 9 分钟 · 700 m'],'第一站前面没有步行段');
  assert.deepEqual([...list.matchAll(/<span>(停留 \d+ 分钟)<\/span>/g)].map(match=>match[1]),['停留 45 分钟','停留 45 分钟','停留 60 分钟']);
  assert.ok(list.indexOf('步行 12 分钟 · 900 m')<list.indexOf('第二站')&&list.indexOf('第二站')<list.indexOf('步行 9 分钟 · 700 m'),'步行段夹在它连接的两站之间');
  // 换了顺序，旧的步行段对不上新的相邻两站：和到达时间一样先收起，停留时长与顺序无关，留着。
  await clickNode(b,{id:'',dataset:{stopMove:'1',stop:'p1'}});
  const pending=b.node('#itinerary').innerHTML;
  assert.doesNotMatch(pending,/class="leg"/);
  assert.equal((pending.match(/<span>停留 \d+ 分钟<\/span>/g)||[]).length,3);
});

test('各页模板不带表情符号；图标只留给没有文字的按钮，而且都有读屏名称',async()=>{
  const report={finished:true,visited_stops:2,total_stops:3,walked_km:1.8,planned_distance_km:3.1,accepted:1,rejected:1,preference_note:'更愿意少走一点。',data_mode:'demo',
    events:[{type:'tired',at:'2026-10-20T09:30:00Z',demo:true},{type:'accepted',at:'2026-10-20T09:31:00Z'},{type:'rain',at:'2026-10-20T10:00:00Z'},{type:'checkin',at:'2026-10-20T10:20:00Z'}],
    summary:{text:'风把湖面吹皱。',source:'DeepSeek deepseek-flash',generated_at:'2026-10-20T12:00:00Z'},
    journal:[{day:1,stop_name:'第一站',text:'坐了一会儿',photos:[],updated_at:'2026-10-20T09:40:00Z'}]};
  const b=editBrowser({handler:async url=>{
    if(url==='/api/trip/trip-edit/report')return {ok:true,json:async()=>report};
    if(url==='/api/ops')return {ok:true,json:async()=>({providers:{maps:true,weather:false},provider_status:{maps:{status:'ok'},weather:{status:'error',error_code:'HTTP_403'}}})};
    return null;
  }});
  const pages={};
  const shot=async(name,setup)=>{b.run(setup);await b.run('render()');pages[name]=b.node('#app').innerHTML;};
  b.run("state.trip.warnings=['营业时间、票价和预约要求尚未核实。'];state.trip.days[0].unknown_cost_count=1;state.trips=[state.trip];");
  await shot('规划（实况）',"state.page='plan';state.interests=['自然','美食'];state.planStartPoint={name:'测试酒店',lat:31,lng:121};");
  await shot('规划（演示）',"state.config={data_mode:'demo'};state.planStartPoint=null;");
  await shot('行程（演示）',"state.page='trip';state.trip.data_mode='demo';");
  await clickNode(b,{id:'',dataset:{stopDetail:'p2'}});
  await new Promise(resolve=>setImmediate(resolve));
  pages['地点详情']=b.node('#modal-content').innerHTML;
  await shot('行程（实况，顺序未保存）',"state.config={data_mode:'live'};state.trip.data_mode='live';state.stopDetail=null;state.reorder={key:viewKey(),ids:['p2','p1','p3']};");
  await shot('途中（还没开始）',"state.reorder=null;state.page='journey';state.session=null;");
  await shot('途中（有调整建议，管理员面板展开）',"state.user={id:'admin',username:'admin',role:'admin'};state.session={id:'s1',trip_id:'trip-edit',day:1,status:'active',current_index:0,model_consent:true};controlsState().open=true;"
    +"state.suggestion={id:'sg1',demo:true,reason:'建议减少后续节点并延长休息。',decision_source:'rules',expires_at:'2026-10-20T10:00:00Z',candidate:{stops:[editStops[2]]},changes:{distance_saved_m:257,time_saved_min:59,added_stops:['第三站'],skipped_stops:['第二站'],moved_stops:[]}};".replace('editStops[2]',JSON.stringify(editStops[2])));
  await shot('手记',"state.suggestion=null;state.page='report';");
  await shot('运营',"state.page='ops';");
  await shot('账号',"state.page='auth';");
  await shot('登录',"state.user=null;state.page='auth';state.authMode='login';");
  await shot('注册',"state.authMode='register';");
  assert.equal(Object.keys(pages).length,12);
  for(const [name,html]of Object.entries(pages)){
    assert.ok(html.length>100,name+' 渲染出了内容');
    assert.doesNotMatch(html,/没加载出来/,name);
    assert.doesNotMatch(html,/\p{Extended_Pictographic}/u,name+' 不用表情符号当图标');
    const icons=(html.match(/<svg class="icon"/g)||[]).length;
    const labelled=(html.match(/<button[^>]*\saria-label="[^"]+"[^>]*><svg class="icon"[^>]*>(?:<path[^>]*\/>)+<\/svg><\/button>/g)||[]).length;
    assert.equal(icons,labelled,name+' 的每个图标都是一个带读屏名称、没有文字的按钮');
  }
  // 能排序的页面确实带着上移／下移，免得上面的计数因为模板空了而成立。
  assert.ok((pages['行程（演示）'].match(/<svg class="icon"/g)||[]).length>=6);
  assert.match(pages['规划（实况）'],/id="clear-start" aria-label="清除起点"/);
  assert.match(pages['途中（有调整建议，管理员面板展开）'],/id="close-journey-controls"/);
});
