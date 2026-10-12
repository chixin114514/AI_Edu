// DOM-stub integration smoke test, not a replacement for real-browser layout testing.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { dispatch,mergeCookies } from './harness.js';
test('frontend renders every view with real backend responses and completes suggestion flow',async t=>{
  const server=createApp({database:':memory:'});t.after(()=>server.emit('close'));let cookie='';
  const nodes=new Map();const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',querySelector:selector=>node(selector),classList:{add(){},remove(){},toggle(){}},addEventListener(){},setAttribute(){},showModal(){},close(){}});return nodes.get(selector);};
  const local=new Map(),document={querySelector:node,querySelectorAll:()=>[],addEventListener(){}};
  class FakeSensors extends EventTarget {constructor(){super();this.samples=[];}features(){return {};}stop(){} }
  const context=vm.createContext({console,document,window:{addEventListener(){},scrollTo(){},isSecureContext:false},navigator:{},location:{hash:''},history:{replaceState(){}},localStorage:{getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)},setTimeout:()=>0,clearTimeout(){},Sensors:FakeSensors,routeMapMarkup:()=>'<div>高德地图</div>',mountRouteMaps(){},destroyRouteMaps(){},URL,Blob,fetch:async(url,options={})=>{
    const r=await dispatch(server,url,options.body?JSON.parse(options.body):undefined,{cookie,...options.headers});cookie=mergeCookies(cookie,r.headers['set-cookie']);return {ok:r.status<400,json:async()=>r.body};
  }});
  const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace("import { routeMapMarkup, mountRouteMaps, destroyRouteMaps } from './route-map.js';",'').replace("import { Sensors } from './sensors.js';",'').replace('\ninit();','\n');
  vm.runInContext(source,context);const run=s=>vm.runInContext(s,context);
  await run('init()');assert.match(node('#app').innerHTML,/定制你的旅程/);
  await run(`state.trip=await api('/trip/plan',{city:'杭州',date:'2026-10-13',days:1,budget:300,walk_limit_km:6,interests:['自然'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:false})`.replace('state.trip=await','(async()=>state.trip=await')+')()');
  await run("(async()=>{state.page='trip';await render();})()");assert.match(node('#app').innerHTML,/今日的风景清单/);
  await run("(async()=>{state.session=await api('/session/start',{trip_id:state.trip.id,day:1,model_consent:false});state.page='journey';await render();await feedback('tired');})()");assert.match(node('#app').innerHTML,/接受调整/);
  await run("(async()=>{const r=await api('/session/confirm',{session_id:state.session.id,suggestion_id:state.suggestion.id,accept:true});state.trip=r.trip;state.suggestion=null;state.page='report';await render();})()");assert.match(node('#app').innerHTML,/接受路线调整/);
  await run("(async()=>{state.user=(await api('/auth/login',{username:'admin',password:'admin'})).user;state.page='ops';await render();})()");assert.match(node('#app').innerHTML,/地点数据清单/);
  assert.equal(run("esc('<script>')"),'&lt;script&gt;');
});
