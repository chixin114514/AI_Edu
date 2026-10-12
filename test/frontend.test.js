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
