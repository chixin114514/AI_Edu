import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leg, qweatherNow, weather, explain, decision, jevRequest, parseJev, providerStatus } from '../server/providers.js';
import { mcpSpec } from '../scripts/mcp-server.js';
import { createApp } from '../server/index.js';
import { dispatch } from './harness.js';

function setup(t,handler){
  const oldFetch=globalThis.fetch,oldEnv={...process.env};
  Object.assign(process.env,{DATA_MODE:'live',AMAP_MIN_INTERVAL_MS:'0',AMAP_MAPS_API_KEY:'unit-maps-'+Math.random(),QWEATHER_API_KEY:'unit-weather-'+Math.random(),QWEATHER_API_BASE:'https://test.re.qweatherapi.com',QWEATHER_API_VERSION:'v1',TYPESAFE_API_KEY:'unit-jev',TYPESAFE_BASE_URL:'https://api.typesafe.ai',TYPESAFE_DEFAULT_MODEL:'jev-1.13.0',DEEPSEEK_API_KEY:'unit-deepseek'});
  globalThis.fetch=handler||(()=>{throw Error('Unexpected network request');});
  t.after(()=>{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);});
}
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const goodJev=()=>({model:'jev-1.13.0',answers:{travel_state:{type:'choice',choice:'rest',probabilities:{normal:.05,mild_fatigue:.1,rest:.85},confidence:.8}}});

test('TypeSafe uses official systemone payload and parses choice distribution',async t=>{
  setup(t,async(url,init)=>{assert.equal(String(url),'https://api.typesafe.ai/v1/systemone');assert.equal(init.headers.Authorization,'Bearer unit-jev');assert.equal(init.redirect,'error');const body=JSON.parse(init.body);assert.equal(body.model,'jev-1.13.0');assert.equal(body.questions.travel_state.type,'choice');assert.equal(Object.keys(body.questions.travel_state.criteria).length,3);assert.ok(!('raw_hr'in body.state.features));assert.ok(!('location'in body.state.features));return response(goodJev());});
  const r=await decision({hr_vs_baseline_pct:30,duration_s:190,raw_hr:[100],location:{lat:30}},true);assert.equal(r.status,'rest');assert.equal(r.source,'TypeSafe Jev');assert.equal(providerStatus().jev.status,'ok');
});
test('model opt-out prevents both Jev and DeepSeek requests',async t=>{setup(t);assert.equal(await decision({},false),null);assert.equal(await explain({},false),null);});
test('malformed Jev choices and probability distributions rejected',()=>{
  for(const change of [{choice:'diagnosis'},{confidence:2},{probabilities:{normal:.1,mild_fatigue:.1,rest:.1}},{probabilities:{normal:.8,mild_fatigue:.1,rest:.1}},{type:'score'}]){const d=goodJev();Object.assign(d.answers.travel_state,change);assert.throws(()=>parseJev(d));}
  assert.deepEqual(jevRequest({duration_s:2,raw_hr:[100]}).state.features,{duration_s:2});
});
test('Jev auth, rate limit, timeout, DNS and JSON failures return null without secret errors',async t=>{
  setup(t);for(const status of [401,429,529]){globalThis.fetch=async()=>response({message:'secret-provider-body'},status);assert.equal(await decision({},true),null);assert.equal(providerStatus().jev.error_code,'HTTP_'+status);}
  globalThis.fetch=async()=>{throw new DOMException('secret','TimeoutError');};assert.equal(await decision({},true),null);assert.equal(providerStatus().jev.error_code,'TIMEOUT');
  globalThis.fetch=async()=>{throw new TypeError('secret',{cause:{code:'EAI_AGAIN'}});};assert.equal(await decision({},true),null);assert.equal(providerStatus().jev.error_code,'EAI_AGAIN');
  globalThis.fetch=async()=>new Response('not json');assert.equal(await decision({},true),null);assert.equal(providerStatus().jev.error_code,'INVALID_JSON');
});
test('configured origin cannot redirect keys or include userinfo',async t=>{setup(t);process.env.TYPESAFE_BASE_URL='http://api.typesafe.ai';assert.equal(await decision({},true),null);assert.equal(providerStatus().jev.error_code,'INVALID_BASE_URL');process.env.TYPESAFE_BASE_URL='https://name:password@api.typesafe.ai';assert.equal(await decision({},true),null);});
test('QWeather v1 authenticates in header and distinguishes fetch time from observation time',async t=>{
  let calls=0;setup(t,async(url,init)=>{calls++;const u=new URL(url);assert.equal(u.origin,'https://test.re.qweatherapi.com');assert.equal(u.pathname,'/weather/v1/current/30.25/120.15');assert.equal(u.searchParams.has('key'),false);assert.ok(init.headers['X-QW-Api-Key']);return response({condition:{text:'晴'},temperature:{value:24.5,unit:'°C'},feelsLike:{value:25},metadata:{attributions:['https://developer.qweather.com/attribution.html']}});});
  const r=await qweatherNow();assert.equal(r.temperature,24.5);assert.equal(r.time_label,'获取时间');assert.equal(r.mode,'live');assert.equal(r.attributions.length,1);await qweatherNow();assert.equal(calls,1);
});
test('QWeather city v7 compatibility reads observation time and handles zero temperature',async t=>{
  setup(t,async(url)=>{assert.equal(new URL(url).pathname,'/v7/weather/now');assert.equal(new URL(url).searchParams.get('location'),'101210101');return response({code:'200',now:{text:'阴',temp:'0',feelsLike:'-1',obsTime:'2026-10-12T10:00:00+08:00'},refer:{sources:[]}});});process.env.QWEATHER_API_VERSION='v7';const r=await qweatherNow();assert.equal(r.temperature,0);assert.equal(r.time_label,'观测时间');
});
test('weather explicitly falls back to Amap; total outage returns unavailable without fake weather',async t=>{
  setup(t,async(url)=>String(url).includes('qweatherapi.com')?response({},403):response({status:'1',lives:[{weather:'多云',temperature:'23',reporttime:'2026-10-12 15:00:00'}]}));
  const r=await weather();assert.match(r.source,/高德/);assert.match(r.fallback_reason,/和风天气不可用/);assert.equal(providerStatus().weather.error_code,'HTTP_403');
  process.env.AMAP_MAPS_API_KEY='different-cache-key';globalThis.fetch=async()=>{throw Error('offline');};assert.equal((await weather()).mode,'unavailable');
});
test('Amap recognizes supplied MCP key name and normalizes walking response',async t=>{
  setup(t,async(url)=>{assert.equal(new URL(url).searchParams.get('key'),process.env.AMAP_MAPS_API_KEY);return response({status:'1',route:{paths:[{distance:'820',duration:'660',steps:[{polyline:'120.1,30.2;120.11,30.21'}]}]}});});const r=await leg({lng:120.1,lat:30.2},{lng:120.11,lat:30.21});assert.equal(r.distance_m,820);assert.equal(r.duration_min,11);assert.equal(r.polyline.length,2);
});
test('Amap missing distance is rejected instead of coerced into zero',async t=>{setup(t,async()=>response({status:'1',route:{paths:[{distance:null,duration:100}]}}));await assert.rejects(leg({lng:120,lat:30},{lng:121,lat:31}));assert.equal(providerStatus().maps.status,'error');});
test('DeepSeek uses JSON mode and configured model; malformed/empty output falls back',async t=>{
  setup(t,async(url,init)=>{assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(init.headers.Authorization,'Bearer unit-deepseek');const body=JSON.parse(init.body);assert.equal(body.model,'configured-test-model');assert.equal(body.response_format.type,'json_object');assert.deepEqual(body.thinking,{type:'disabled'});return response({choices:[{message:{content:'{"explanation":"沿湖漫步。"}'}}]});});process.env.DEEPSEEK_MODEL='configured-test-model';assert.equal(await explain({stops:['西湖']},true),'沿湖漫步。');
  globalThis.fetch=async()=>response({choices:[{message:{content:'{}'}}]});assert.equal(await explain({},true),null);assert.equal(providerStatus().deepseek.status,'error');
});
test('MCP launchers forward only matching credentials and preserve package arguments',()=>{
  const env={PATH:'/bin',TYPESAFE_API_KEY:'never-forward',DEEPSEEK_API_KEY:'never-forward',QWEATHER_API_KEY:'q-secret',QWEATHER_API_BASE:'https://test.re.qweatherapi.com',AMAP_MAPS_API_KEY:'a-secret'};
  const q=mcpSpec('qweather',env),a=mcpSpec('amap-maps',env);assert.deepEqual(q.args,['-y','@mseep/qweather-mcp@1.0.8']);assert.equal(q.env.AMAP_MAPS_API_KEY,undefined);assert.equal(q.env.TYPESAFE_API_KEY,undefined);assert.equal(a.env.QWEATHER_API_KEY,undefined);assert.equal(a.env.DEEPSEEK_API_KEY,undefined);assert.equal(a.env.AMAP_MAPS_API_KEY,'a-secret');
});
test('public config exposes configuration and safe status only, never credentials',async t=>{
  setup(t);const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));const r=await dispatch(app,'/api/config');assert.equal(r.body.providers.jev,true);assert.equal(r.body.providers.weather,true);const text=JSON.stringify(r.body);for(const secret of ['unit-jev','unit-deepseek',process.env.QWEATHER_API_KEY,process.env.AMAP_MAPS_API_KEY])assert.ok(!text.includes(secret));assert.equal((await dispatch(app,'/.env')).status,404);assert.equal((await dispatch(app,'/config/mcp.json')).status,404);
});

test('Amap rate-limited reads retry with a bound, while authentication errors do not',async t=>{
 let calls=0;setup(t,async()=>++calls<3?response({status:'0',infocode:'10021'}):response({status:'1',route:{paths:[{distance:'500',duration:'400',steps:[]}]}}));
 assert.equal((await leg({lng:120,lat:30},{lng:121,lat:31})).distance_m,500);assert.equal(calls,3);
 process.env.AMAP_MAPS_API_KEY='auth-error-test';calls=0;globalThis.fetch=async()=>{calls++;return response({status:'0',infocode:'10001'});};
 await assert.rejects(leg({lng:120,lat:30},{lng:121,lat:31}));assert.equal(calls,1);
});
test('DeepSeek truncated output is rejected even if partial JSON happens to parse',async t=>{
 setup(t,async()=>response({choices:[{finish_reason:'length',message:{content:'{"explanation":"片段"}'}}]}));
 assert.equal(await explain({},true),null);assert.equal(providerStatus().deepseek.error_code,'MODEL_OUTPUT_TRUNCATED');
});
