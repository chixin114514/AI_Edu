import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { normalizePoi } from '../server/providers.js';
import { dispatch } from './harness.js';
const input={city:'上海',date:'2026-10-15',days:1,budget:300,walk_limit_km:6,interests:['自然','人文'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:false,start_poi:'auto'};
function setup(t,{empty=false,mapFailure=false,huge=false}={}){
 const oldEnv={...process.env},oldFetch=globalThis.fetch,calls=[];
 Object.assign(process.env,{DATA_MODE:'live',AMAP_MAPS_API_KEY:'dynamic-'+Math.random(),AMAP_MIN_INTERVAL_MS:'0'});
 const app=createApp({database:':memory:'});let cookie='';
 globalThis.fetch=async url=>{
  const u=new URL(url);calls.push(u);assert.equal(u.origin,'https://restapi.amap.com');let d;
  if(u.pathname==='/v3/config/district'){const name=u.searchParams.get('keywords');d={districts:name.includes('上海')?[{name:'上海市',adcode:'310000',level:'province',center:'121.47,31.23'}]:[]};}
  else if(u.pathname==='/v5/place/text'){
   assert.equal(u.searchParams.get('region'),'310000');assert.equal(u.searchParams.get('city_limit'),'true');
   d={pois:empty?[]:Array.from({length:18},(_,i)=>({id:'SH'+i,name:i>=15?'上海餐厅'+i:i>=11?'上海博物馆'+i:'上海公园'+i,type:i>=15?'餐饮服务':i>=11?'科教文化服务;博物馆':'风景名胜;公园广场;公园',typecode:i>=15?'050000':i>=11?'140100':'110101',adcode:'310101',location:`${121.47+i*.001},31.23`,address:'上海测试街道',business:{opentime_today:'09:00-17:00',cost:'100'}}))};
  }else if(u.pathname==='/v3/direction/walking'){
   if(mapFailure)throw Error('secret upstream failure');
   d={route:{paths:[{distance:huge?'99999':'200',duration:'180',steps:[]}]}};
  }else if(u.pathname==='/v3/weather/weatherInfo'){assert.equal(u.searchParams.get('city'),'310000');d={lives:[{weather:'晴',temperature:'24',reporttime:'2026-10-12 15:00:00'}]};}
  else throw Error('Unexpected provider '+u.pathname);
  return new Response(JSON.stringify({status:'1',...d}));
 };
 t.after(()=>{app.emit('close');globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);});
 return {app,calls,request:async(path,data)=>{const r=await dispatch(app,'/api'+path,data,{cookie});cookie=r.headers['set-cookie']?.split(';')[0]||cookie;return r;}};
}
test('arbitrary city uses real POI results, route distances, matching weather and honest unknown costs',async t=>{
 const {request,calls}=setup(t),r=await request('/trip/plan',input);assert.equal(r.status,201);const p=r.body;
 assert.equal(p.preferences.city,'上海市');assert.equal(p.data_mode,'live');assert.equal(p.route_pack.poi_count,18);assert.equal(p.days[0].stops.length,6);assert.equal(p.days[0].distance_m,1000);assert.equal(p.days[0].unknown_cost_count,6);assert.match(p.weather.source,/上海/);
 for(const stop of p.days[0].stops){assert.ok(stop.id.startsWith('SH'));assert.equal(stop.price,null);assert.equal(stop.open,null);assert.equal(stop.close,null);assert.match(stop.source_url,/uri.amap.com/);assert.equal(stop.leg.source,stop===p.days[0].stops[0]?'起点':'高德步行路径规划');}
 assert.equal(calls.filter(u=>u.pathname==='/v5/place/text').length,3);assert.ok(!JSON.stringify(p).includes('rest-gushan'));
});
test('generated route library survives reads and is isolated by browser owner',async t=>{
 const {request,app}=setup(t);const r=await request('/trip/plan',input);const packs=await request('/route-packs');assert.equal(packs.body.packs[0].trip_id,r.body.id);assert.equal(packs.body.packs[0].city,'上海市');assert.deepEqual((await dispatch(app,'/api/route-packs')).body.packs,[]);
 await request('/trip/plan',input);assert.equal((await request('/route-packs')).body.packs.length,1);await request('/privacy/delete',{confirm:true});assert.deepEqual((await request('/route-packs')).body.packs,[]);
});
test('two-day generated routes have no duplicate main stops and obey limits',async t=>{
 const {request}=setup(t);const r=await request('/trip/plan',{...input,days:2});assert.equal(r.status,201);const ids=r.body.days.flatMap(d=>d.stops.map(p=>p.id));assert.equal(new Set(ids).size,ids.length);for(const d of r.body.days){assert.ok(d.stops.length>=2);assert.ok(d.distance_m<=6000);assert.ok(d.stops.every(p=>p.departure<='18:00'));}
});
test('city rerouting stays in the same catalog and requires confirmation',async t=>{
 const {request}=setup(t),p=(await request('/trip/plan',input)).body,s=(await request('/session/start',{trip_id:p.id,day:1,model_consent:false})).body;
 for(const trigger of ['tired','hungry','rain']){
  const r=await request('/feedback',{session_id:s.id,feedback_type:trigger,demo:trigger==='rain'});assert.equal(r.status,200);assert.equal(r.body.require_confirm,true);assert.ok(r.body.candidate.stops.every(p=>p.id.startsWith('SH')));assert.equal((await request('/trip/'+p.id)).body.version,1);
  await request('/session/confirm',{session_id:s.id,suggestion_id:r.body.id,accept:false});
 }
 const a=(await request('/feedback',{session_id:s.id,feedback_type:'tired'})).body;const accepted=(await request('/session/confirm',{session_id:s.id,suggestion_id:a.id,accept:true})).body;assert.equal(accepted.trip.version,2);assert.equal(accepted.trip.days[0].unknown_cost_count,accepted.trip.days[0].stops.length);
});
test('no POI or no feasible route never silently falls back to Hangzhou fixtures',async t=>{
 const {request}=setup(t,{empty:true});const r=await request('/trip/plan',input);assert.equal(r.status,422);assert.deepEqual((await request('/route-packs')).body.packs,[]);
});
test('map outage leaves no incomplete trip or route library',async t=>{
 const {request}=setup(t,{mapFailure:true});const r=await request('/trip/plan',input);assert.equal(r.status,503);assert.deepEqual((await request('/trips')).body.trips,[]);assert.ok(!r.body.error.includes('secret'));
});
test('walk limit rejects provider routes exceeding budget',async t=>{
 const {request}=setup(t,{huge:true});assert.equal((await request('/trip/plan',input)).status,422);
});
test('invalid or ambiguous city is actionable, not replaced with another city',async t=>{
 const {request}=setup(t);assert.equal((await request('/trip/plan',{...input,city:'浙江'})).status,422);assert.equal((await request('/trip/plan',{...input,city:'<script>'})).status,400);
});
test('POI normalization filters foreign results, malformed coordinates and access gates',()=>{
 const region={name:'上海市',adcode:'310000'},p={id:'P1',name:'公园',location:'121,31',adcode:'310101',type:'公园',typecode:'110101',business:{cost:'100',opentime_today:'09:00-17:00'}};
 for(const patch of [{adcode:'330106'},{location:'NaN,31'},{location:',31'},{name:'公园出入口'}])assert.equal(normalizePoi({...p,...patch},region),null);
 const v=normalizePoi(p,region);assert.equal(v.price,null);assert.equal(v.open,null);assert.match(v.opening_text,/09:00/);
});
