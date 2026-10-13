import { cleanStopReason, defaultStopReason } from '../public/stop-reasons.js';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace("import { Sensors } from './sensors.js';", '').replace('\ninit();', '\n');

function browser({ stored = new Map(), fetch = async () => ({ ok: true, json: async () => ({}) }) } = {}) {
  const handlers = new Map(), nodes = new Map();
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
    window: { addEventListener() {}, removeEventListener() {}, scrollTo() {}, isSecureContext: false },
    navigator: {}, location: { hash: '', origin: 'https://travel.example' }, history: { replaceState() {} },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    setTimeout: () => 0, clearTimeout() {}, Sensors: FakeSensors, cleanStopReason, defaultStopReason, routeMapMarkup:()=>'',mountRouteMaps(){},destroyRouteMaps(){}, URL, Blob, AbortController,
    FormData: class { constructor(form) { return Object.entries(form.values)[Symbol.iterator](); } }, fetch
  });
  vm.runInContext(source, context);
  return { run: code => vm.runInContext(code, context), handlers, node, stored };
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
  assert.deepEqual(calls,[{provider:'maps'}]);assert.match(b.node('#app').innerHTML,/测试成功/);assert.match(b.node('#app').innerHTML,/820 米/);assert.match(b.node('#app').innerHTML,/123 ms/);
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
