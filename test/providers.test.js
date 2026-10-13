import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leg, qweatherNow, weather, explain, decision, jevRequest, parseJev, providerStatus, probeProvider } from '../server/providers.js';
import { mcpSpec } from '../scripts/mcp-server.js';
import { createApp } from '../server/index.js';
import { dispatch, mergeCookies } from './harness.js';

function setup(t,handler){
  const oldFetch=globalThis.fetch,oldEnv={...process.env};
  Object.assign(process.env,{DATA_MODE:'live',AMAP_MIN_INTERVAL_MS:'0',AMAP_MAPS_API_KEY:'unit-maps-'+Math.random(),QWEATHER_API_KEY:'unit-weather-'+Math.random(),QWEATHER_API_BASE:'https://test.re.qweatherapi.com',QWEATHER_API_VERSION:'v1',TYPESAFE_API_KEY:'unit-jev',TYPESAFE_BASE_URL:'https://api.typesafe.ai',TYPESAFE_DEFAULT_MODEL:'jev-1.13.0',DEEPSEEK_API_KEY:'unit-deepseek'});
  globalThis.fetch=handler||(()=>{throw Error('Unexpected network request');});
  t.after(()=>{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);});
}
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const goodJev=()=>({model:'jev-1.13.0',answers:{travel_state:{type:'choice',choice:'rest',probabilities:{normal:.05,mild_fatigue:.1,rest:.85},confidence:.8}}});

test('admin and ordinary state inputs use the same Jev call, rule outcome and cooldown',async t=>{
  const payloads=[];
  setup(t,async(url,init)=>{assert.equal(String(url),'https://api.typesafe.ai/v1/systemone');payloads.push(JSON.parse(init.body));return response(goodJev());});
  process.env.DATA_MODE='demo';
  const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));
  for(const admin of [false,true]){
    let cookie='';
    const request=async(path,data)=>{const result=await dispatch(app,'/api'+path,data,{cookie});cookie=mergeCookies(cookie,result.headers['set-cookie']);return result;};
    await request(admin?'/auth/login':'/auth/register',admin?{username:'admin',password:'admin'}:{username:'traveler',password:'password123'});
    const {body:trip}=await request('/trip/plan',{city:'杭州',date:'2026-10-13',days:1,budget:300,walk_limit_km:6,interests:['自然'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:false});
    const {body:s}=await request('/session/start',{trip_id:trip.id,day:1,model_consent:true});
    const features={hr_vs_baseline_pct:43,cadence_change_pct:-20,duration_s:180};
    const result=await request('/feedback',{session_id:s.id,feedback_type:'state',features});
    assert.equal(result.status,200);assert.equal(result.body.status,'rest');assert.equal(result.body.model_reference.status,'rest');assert.equal(result.body.require_confirm,true);assert.equal(result.body.demo,false);
    assert.equal((await request('/session/state',{session_id:s.id,features})).body.suggestion,'cooldown');
    await request('/feedback',{session_id:s.id,feedback_type:'unwell'});
    assert.equal((await request('/session/state',{session_id:s.id,features})).body.status,'paused');
  }
  assert.equal(payloads.length,2);
  for(const payload of payloads)assert.deepEqual(payload.state.features,{hr_vs_baseline_pct:43,cadence_change_pct:-20,duration_s:180});
});

test('admin map and weather probes make fresh requests even in demo mode and update status',async t=>{
  const calls={maps:0,weather:0,regions:0,pois:0};
  setup(t,async url=>{
    const u=new URL(url);
    if(u.pathname==='/v3/config/district'){
      calls.regions++;
      return response({status:'1',districts:u.searchParams.get('keywords')==='中国'?
        [{level:'country',districts:[{name:'浙江省',adcode:'330000',districts:[{name:'杭州市',adcode:'330100',level:'city',districts:[{name:'西湖区',adcode:'330106',level:'district'}]}]}]}]:
        [{name:'杭州市',adcode:'330100',level:'city',center:'120.15,30.25'}]});
    }
    if(u.pathname==='/v5/place/text'){
      calls.pois++;
      return response({status:'1',pois:[{id:'P1',name:'杭州公园',type:'风景名胜;公园',typecode:'110101',adcode:'330106',location:'120.15,30.25'}]});
    }
    if(u.pathname==='/v3/direction/walking'){
      calls.maps++;assert.equal(u.searchParams.get('origin'),'120.1481,30.2596');
      return response({status:'1',route:{paths:[{distance:'820',duration:'660',steps:[]}]}});
    }
    assert.equal(u.pathname,'/weather/v1/current/30.25/120.15');calls.weather++;
    return response({condition:{text:'晴'},temperature:{value:24,unit:'°C'}});
  });
  await leg({lng:120.1481,lat:30.2596},{lng:120.1410,lat:30.2564});await qweatherNow();
  process.env.DATA_MODE='demo';
  const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));
  const login=await dispatch(app,'/api/auth/login',{username:'admin',password:'admin'});
  const cookie=mergeCookies('',login.headers['set-cookie']);
  for(const provider of ['maps','weather','maps','weather']){
    const r=await dispatch(app,'/api/ops/test',{provider},{cookie});
    assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.equal(r.body.provider,provider);
    assert.ok(r.body.elapsed_ms>=0);assert.ok(Number.isFinite(Date.parse(r.body.checked_at)));
    assert.equal(r.body.error_code,null);
    if(provider==='maps')assert.deepEqual(r.body.result,{distance_m:820,duration_min:11});
    else assert.equal(r.body.result.temperature,24);
    for(const secret of [process.env.AMAP_MAPS_API_KEY,process.env.QWEATHER_API_KEY])assert.ok(!JSON.stringify(r.body).includes(secret));
  }
  assert.deepEqual(calls,{maps:3,weather:3,regions:4,pois:6});assert.equal(process.env.DATA_MODE,'demo');
  assert.deepEqual((await probeProvider('maps')).checks.map(check=>check.name),['城市查询','区县查询','景点检索','步行路线']);
  const ops=await dispatch(app,'/api/ops',undefined,{cookie});
  assert.equal(ops.body.provider_status.maps.status,'ok');assert.equal(ops.body.provider_status.weather.status,'ok');
});
test('probe endpoint requires admin and rejects unknown providers before making requests',async t=>{
  let calls=0;setup(t,async()=>{calls++;throw Error('unexpected request');});
  const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));
  assert.equal((await dispatch(app,'/api/ops/test',{provider:'maps'})).status,401);
  const regular=await dispatch(app,'/api/auth/register',{username:'tester',password:'test-password'});
  assert.equal((await dispatch(app,'/api/ops/test',{provider:'weather'},{cookie:mergeCookies('',regular.headers['set-cookie'])})).status,403);
  const admin=await dispatch(app,'/api/auth/login',{username:'admin',password:'admin'});
  const cookie=mergeCookies('',admin.headers['set-cookie']);
  for(const provider of ['deepseek','https://example.com',null])assert.equal((await dispatch(app,'/api/ops/test',{provider},{cookie})).status,400);
  assert.equal(calls,0);
});
test('probe failures expose safe errors without fallback, cached success or upstream secrets',async t=>{
  let calls=0;setup(t,async()=>{calls++;return response({message:'private-upstream-body'},403);});
  let r=await probeProvider('weather');assert.equal(r.ok,false);assert.equal(r.error_code,'HTTP_403');assert.equal(r.result,null);assert.equal(calls,1);
  assert.equal(providerStatus().weather.status,'error');
  globalThis.fetch=async()=>response({status:'0',infocode:'10001',info:'private-upstream-body'});
  r=await probeProvider('maps');assert.equal(r.error_code,'AMAP_10001');assert.equal(r.ok,false);
  globalThis.fetch=async()=>{throw new DOMException('private-upstream-body','TimeoutError');};
  r=await probeProvider('weather');assert.equal(r.error_code,'TIMEOUT');assert.match(r.message,/超时/);
  delete process.env.QWEATHER_API_KEY;
  r=await probeProvider('weather');assert.equal(r.error_code,'NOT_CONFIGURED');assert.equal(r.ok,false);
  assert.ok(!JSON.stringify(r).includes('private-upstream-body'));
});

test('TypeSafe uses official systemone payload and parses choice distribution',async t=>{
  setup(t,async(url,init)=>{assert.equal(String(url),'https://api.typesafe.ai/v1/systemone');assert.equal(init.headers.Authorization,'Bearer unit-jev');assert.equal(init.redirect,'error');const body=JSON.parse(init.body);assert.equal(body.model,'jev-1.13.0');assert.equal(body.questions.travel_state.type,'choice');assert.equal(Object.keys(body.questions.travel_state.criteria).length,3);assert.ok(!('raw_hr'in body.state.features));assert.ok(!('location'in body.state.features));return response(goodJev());});
  const r=await decision({hr_vs_baseline_pct:30,duration_s:190,raw_hr:[100],location:{lat:30}},true);assert.equal(r.status,'rest');assert.equal(r.source,'TypeSafe Jev');assert.equal(providerStatus().jev.status,'ok');
});
test('model opt-out prevents both Jev and DeepSeek requests',async t=>{setup(t);assert.equal(await decision({},false),null);assert.equal(await explain({},false),null);assert.equal(await explain({},false,{withStops:true}),null);});
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
test('walking coordinates respect six decimal places for geolocation and floating point POIs',async t=>{
  setup(t,async url=>{
    const u=new URL(url);
    assert.equal(u.searchParams.get('origin'),'120.148123,30.259654');
    assert.equal(u.searchParams.get('destination'),'120.141123,30.256654');
    return response({status:'1',route:{paths:[{distance:'820',duration:'660',steps:[]}]}});
  });
  assert.equal((await leg({lng:120.1481234567,lat:30.259654321},{lng:120.1411234567,lat:30.256654321})).distance_m,820);
});
test('map probe catches POI permission failures even when the walking API succeeds',async t=>{
  setup(t,async url=>{
    const u=new URL(url);
    if(u.pathname==='/v3/direction/walking')return response({status:'1',route:{paths:[{distance:'820',duration:'660',steps:[]}]}});
    if(u.pathname==='/v3/config/district')return response({status:'1',districts:u.searchParams.get('keywords')==='中国'?
      [{level:'country',districts:[{name:'浙江省',adcode:'330000',districts:[{name:'杭州市',adcode:'330100',level:'city'}]}]}]:
      [{name:'杭州市',adcode:'330100',level:'city',center:'120.15,30.25'}]});
    return response({status:'0',infocode:'10012',info:'private-provider-key'});
  });
  assert.equal((await leg({lng:120.1481,lat:30.2596},{lng:120.141,lat:30.2564})).mode,'live');
  const result=await probeProvider('maps');
  assert.equal(result.ok,false);assert.equal(result.error_code,'AMAP_10012');assert.match(result.message,/景点检索/);
  assert.equal(providerStatus().maps.status,'error');assert.ok(!JSON.stringify(result).includes('private-provider-key'));
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
test('DeepSeek stop notes use known IDs and strip repeated names, labels and emoji',async t=>{
 setup(t,async(url,init)=>{
  const request=JSON.parse(init.body);assert.equal(request.max_tokens,3000);assert.match(request.messages[0].content,/recommendations/);
  return response({choices:[{message:{content:JSON.stringify({explanation:'按兴趣串联地点。',recommendations:[{id:'a',reason:'🌿 A地点，推荐原因：适合放慢脚步，欣赏沿途景观。'}]})}}]});
 });
 const result=await explain({days:[{stops:[{id:'a',name:'A地点'}]}]},true,{withStops:true});
 assert.equal(result.recommendations[0].reason,'适合放慢脚步，欣赏沿途景观。');
});
test('unknown, duplicate and malformed model stop notes are rejected without inventing recommendations',async t=>{
 setup(t);const context={days:[{stops:[{id:'a',name:'地点A'},{id:'b',name:'地点B'}]}]};
 for(const recommendations of [null,[{id:'elsewhere',reason:'未知地点'}],[{id:'a',reason:'甲'},{id:'a',reason:'乙'}],[{id:'a',reason:'推荐原因：'}],[{id:'a',reason:123}],[{id:'a',reason:'长'.repeat(301)}]]){
  globalThis.fetch=async()=>response({choices:[{message:{content:JSON.stringify({explanation:'说明',recommendations})}}]});
  assert.equal(await explain(context,true,{withStops:true}),null);
 }
});
test('planning persists model notes by stop ID, and missing notes retain honest rule text',async t=>{
 let chosen;setup(t,async(url,init)=>{
  assert.equal(url,'https://api.deepseek.com/chat/completions');const context=JSON.parse(JSON.parse(init.body).messages[1].content);chosen=context.days[0].stops[0].id;
  assert.ok(!JSON.stringify(context).includes('raw_hr'));assert.ok(context.days[0].stops.every(p=>p.id&&p.name&&p.category));
  return response({choices:[{message:{content:JSON.stringify({explanation:'行程说明。',recommendations:[{id:chosen,reason:'符合你的兴趣，适合在漫游途中停下来看看。'}]})}}]});
 });process.env.DATA_MODE='demo';const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));
 const r=await dispatch(app,'/api/trip/plan',{city:'杭州',date:'2026-10-15',days:1,budget:300,walk_limit_km:6,interests:['自然'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:true});
 assert.equal(r.status,201);assert.equal(r.body.days[0].stops[0].id,chosen);assert.equal(r.body.days[0].stops[0].recommendation_source,'DeepSeek');
 assert.ok(r.body.days[0].stops.slice(1).every(p=>p.recommendation_reason&&p.recommendation_source==='规划规则'));
 const saved=await dispatch(app,'/api/trip/'+r.body.id,undefined,{cookie:r.headers['set-cookie'].split(';')[0]});
 assert.equal(saved.body.days[0].stops[0].recommendation_reason,r.body.days[0].stops[0].recommendation_reason);
});
