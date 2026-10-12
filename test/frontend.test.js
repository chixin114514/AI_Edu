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
    window: { addEventListener() {}, scrollTo() {}, isSecureContext: false },
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
  assert.match(b.node('#app').innerHTML, /先有方向/);
  complete(); await new Promise(resolve => setImmediate(resolve));
  try{
  assert.equal(b.run('state.page'), 'journey');
  assert.match(b.node('#app').innerHTML, /你的行程已准备好/);
  assert.doesNotMatch(b.node('#app').innerHTML, /先有方向/);
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
  assert.match(b.node('#app').innerHTML,/怎么去 · 公交换乘/);
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
