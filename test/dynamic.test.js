import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { normalizePoi, normalizeRegions } from '../server/providers.js';
import { buildReroute, evaluate } from '../server/planner.js';
import { dispatch } from './harness.js';
const input={city:'上海',date:'2026-10-15',days:1,budget:300,walk_limit_km:6,interests:['自然','人文'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:false,start_poi:'auto'};
function setup(t,{empty=false,mapFailure=false,huge=false,district=false}={}){
 const oldEnv={...process.env},oldFetch=globalThis.fetch,calls=[];
 Object.assign(process.env,{DATA_MODE:'live',AMAP_MAPS_API_KEY:'dynamic-'+Math.random(),AMAP_MIN_INTERVAL_MS:'0'});
 const app=createApp({database:':memory:'});let cookie='';
 globalThis.fetch=async url=>{
  const u=new URL(url);calls.push(u);assert.equal(u.origin,'https://restapi.amap.com');let d;
  if(u.pathname==='/v3/config/district'){const name=u.searchParams.get('keywords');d=name==='中国'?{districts:[{level:'country',districts:[{name:'上海市',adcode:'310000',level:'province',districts:[{name:'上海城区',adcode:'310100',level:'city',districts:[{name:'黄浦区',adcode:'310101',level:'district'},{name:'徐汇区',adcode:'310104',level:'district'}]}]}]}]}:{districts:name.includes('上海')?[{name:'上海市',adcode:'310000',level:'province',center:'121.47,31.23'}]:[]};}
  else if(u.pathname==='/v5/place/text'){
   assert.equal(u.searchParams.get('region'),district?'310101':'310000');assert.equal(u.searchParams.get('city_limit'),'true');
   d={pois:empty?[]:Array.from({length:18},(_,i)=>({id:'SH'+i,name:i>=15?'上海餐厅'+i:i>=11?'上海博物馆'+i:'上海公园'+i,type:i>=15?'餐饮服务':i>=11?'科教文化服务;博物馆':'风景名胜;公园广场;公园',typecode:i>=15?'050000':i>=11?'140100':'110101',adcode:district&&i===17?'310104':'310101',location:`${121.47+i*.001},31.23`,address:'上海测试街道',business:{opentime_today:'09:00-17:00',cost:'100',rating:'4.5'}}))};
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
 for(const stop of p.days[0].stops){assert.ok(stop.id.startsWith('SH'));assert.equal(stop.price,null);assert.equal(stop.per_capita_cost,100);assert.equal(stop.rating,4.5);assert.equal(stop.commerce_source,'高德地图');assert.equal(stop.open,null);assert.equal(stop.close,null);assert.match(stop.source_url,/uri.amap.com/);assert.equal(stop.leg.source,stop===p.days[0].stops[0]?'起点':'高德步行路径规划');}
 assert.equal(calls.filter(u=>u.pathname==='/v5/place/text').length,3);assert.ok(!JSON.stringify(p).includes('rest-gushan'));
});
test('generated route library survives reads and is isolated by browser owner',async t=>{
 const {request,app}=setup(t);const r=await request('/trip/plan',input);const packs=await request('/route-packs');assert.equal(packs.body.packs[0].trip_id,r.body.id);assert.equal(packs.body.packs[0].city,'上海市');const saved=(await request('/trip/'+r.body.id)).body;assert.equal(saved.poi_catalog.find(p=>p.category==='美食').per_capita_cost,100);assert.equal(saved.poi_catalog[0].rating,4.5);assert.deepEqual((await dispatch(app,'/api/route-packs')).body.packs,[]);
 await request('/trip/plan',input);assert.equal((await request('/route-packs')).body.packs.length,1);await request('/privacy/delete',{confirm:true});assert.deepEqual((await request('/route-packs')).body.packs,[]);
});
test('two-day generated routes have no duplicate main stops and obey limits',async t=>{
 const {request}=setup(t);const r=await request('/trip/plan',{...input,days:2});assert.equal(r.status,201);const ids=r.body.days.flatMap(d=>d.stops.map(p=>p.id));assert.equal(new Set(ids).size,ids.length);for(const d of r.body.days){assert.ok(d.stops.length>=2);assert.ok(d.distance_m<=6000);assert.ok(d.stops.every(p=>p.departure<='18:00'));}
});
test('city rerouting stays in the same catalog and requires confirmation',async t=>{
 const {request}=setup(t),p=(await request('/trip/plan',input)).body,s=(await request('/session/start',{trip_id:p.id,day:1,model_consent:false})).body;
 for(const trigger of ['tired','hungry','rain']){
  const r=await request('/feedback',{session_id:s.id,feedback_type:trigger,demo:false});assert.equal(r.status,200);assert.equal(r.body.require_confirm,true);assert.equal(r.body.demo,false);assert.doesNotMatch(r.body.reason,/演示/);assert.ok(r.body.candidate.stops.every(p=>p.id.startsWith('SH')));assert.equal((await request('/trip/'+p.id)).body.version,1);
  const added=r.body.candidate.stops.filter(stop=>!p.days[0].stops.some(old=>old.id===stop.id));
  assert.ok(added.length>0,trigger+' must add a suitable unused place when one fits');
  assert.deepEqual(r.body.changes.added_stops,added.map(stop=>stop.name));
  assert.equal(new Set(r.body.candidate.stops.map(stop=>stop.id)).size,r.body.candidate.stops.length);
  assert.deepEqual(r.body.candidate.stops[0],p.days[0].stops[0]);
  if(trigger==='rain')assert.ok(r.body.candidate.stops.slice(1).every(stop=>stop.indoor));
  if(trigger==='hungry')assert.equal(added[0].category,'美食');
  if(trigger==='tired')assert.ok(r.body.changes.distance_saved_m>=0,'fatigue must not increase walking');
  await request('/session/confirm',{session_id:s.id,suggestion_id:r.body.id,accept:false});
 }
 const a=(await request('/feedback',{session_id:s.id,feedback_type:'tired'})).body;const accepted=(await request('/session/confirm',{session_id:s.id,suggestion_id:a.id,accept:true})).body;assert.equal(accepted.trip.version,2);assert.equal(accepted.trip.days[0].unknown_cost_count,accepted.trip.days[0].stops.length);
});
test('rain rerouting finds unused indoor POIs beyond an overlapping Plan B and rejects closed alternatives',async t=>{
 const {request}=setup(t),trip=(await request('/trip/plan',input)).body;
 trip.days[0].plan_b={stops:trip.days[0].stops};
 const session={day:1,current_index:0},outcome=evaluate({},'rain');
 const found=await buildReroute(trip,session,outcome);
 assert.ok(found.candidate.stops.some(stop=>!trip.days[0].stops.some(old=>old.id===stop.id)));
 assert.ok(found.candidate.stops.slice(1).every(stop=>stop.indoor));
 for(const poi of trip.poi_catalog)if(poi.indoor)poi.closed_days=[4];
 const closed=await buildReroute(trip,session,outcome);
 assert.equal(closed.candidate,null,'cannot replace outdoor stops with an empty itinerary when indoor places are closed');
 assert.match(closed.reason,/原路线保持不变/);
});
test('hungry rerouting reorders an existing restaurant only if no unused meal fits; no restaurant preserves the route',async t=>{
 const {request}=setup(t),trip=(await request('/trip/plan',input)).body;
 const before=structuredClone(trip.days[0]);
 const alreadyPlanned=new Set(before.stops.map(stop=>stop.id));
 trip.poi_catalog=trip.poi_catalog.filter(p=>p.category!=='美食'||alreadyPlanned.has(p.id));
 const found=await buildReroute(trip,{day:1,current_index:0},evaluate({},'hungry'));
 assert.ok(found.candidate);assert.equal(found.candidate.stops[1].category,'美食');
 assert.ok(found.candidate.stops.every(stop=>alreadyPlanned.has(stop.id)));
 assert.match(found.reason,/原路线已有的餐厅/);
 assert.deepEqual(trip.days[0],before,'building a candidate must not mutate the stored trip');
 trip.poi_catalog=trip.poi_catalog.filter(p=>p.category!=='美食');
 trip.days[0].stops=trip.days[0].stops.filter(p=>p.category!=='美食');
 const none=await buildReroute(trip,{day:1,current_index:0},evaluate({},'hungry'));
 assert.equal(none.candidate,null);assert.match(none.reason,/餐饮替代地点.*原路线保持不变/);
});
test('fatigue falls back honestly to shortening when no new rest fits, and keeps current and checked-in stops',async t=>{
 const {request}=setup(t),trip=(await request('/trip/plan',input)).body;
 trip.poi_catalog=trip.days[0].stops.filter(p=>!p.indoor&&p.category!=='美食');
 trip.days[0].stops=trip.poi_catalog;
 const session={day:1,current_index:1},found=await buildReroute(trip,session,evaluate({},'tired'));
 assert.ok(found.candidate);assert.match(found.reason,/本次仅缩短/);
 assert.deepEqual(found.candidate.stops.slice(0,2),trip.days[0].stops.slice(0,2));
 assert.ok(found.candidate.distance_m<=trip.days[0].distance_m);
 assert.ok(found.candidate.stops.every(stop=>trip.days[0].stops.some(old=>old.id===stop.id)));
});
test('rerouting retains the custom destination, actual totals and confirmation semantics',async t=>{
 const {request}=setup(t),trip=(await request('/trip/plan',{...input,end_point:{name:'测试酒店',lng:121.471,lat:31.23}})).body;
 const session=(await request('/session/start',{trip_id:trip.id,day:1,model_consent:false})).body;
 const result=await request('/feedback',{session_id:session.id,feedback_type:'rain'});
 assert.equal(result.status,200);assert.equal(result.body.require_confirm,true);
 const candidate=result.body.candidate;
 assert.equal(candidate.stops.at(-1).id,'destination');assert.equal(candidate.stops.at(-1).name,'测试酒店');
 assert.equal(candidate.stops.filter(p=>p.id==='destination').length,1);
 assert.equal(candidate.distance_m,candidate.stops.reduce((sum,p)=>sum+p.leg.distance_m,0));
 assert.ok(candidate.distance_m<=trip.preferences.walk_limit_km*1000);
 assert.deepEqual((await request('/trip/'+trip.id)).body.days,trip.days);
 const accepted=await request('/session/confirm',{session_id:session.id,suggestion_id:result.body.id,accept:true});
 assert.deepEqual(accepted.body.trip.days[0],candidate);assert.equal(accepted.body.trip.version,2);
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

test('invalid commercial data stays unknown and reference spend never becomes a ticket price',()=>{
 const region={name:'上海市',adcode:'310000'},p={id:'R1',name:'餐厅',location:'121,31',adcode:'310101',type:'餐饮服务',typecode:'050000'};
 for(const value of [undefined,null,[],{},'', ' ',true,'未知','NaN',Infinity,-1,0]){
  const result=normalizePoi({...p,business:{cost:value,rating:value}},region);
  assert.equal(result.per_capita_cost,null);assert.equal(result.rating,null);assert.equal(result.price,null);
 }
 const result=normalizePoi({...p,business:{cost:'58.50',rating:'4.5'}},region);
 assert.equal(result.per_capita_cost,58.5);assert.equal(result.rating,4.5);assert.equal(result.price,null);
 assert.equal(normalizePoi({...p,business:{rating:'5.1'}},region).rating,null);
 assert.equal(normalizePoi({...p,business:{rating:'5'}},region).rating,5);
});

test('district selection constrains provider search, catalog and stored route library',async t=>{
 const {request}=setup(t,{district:true});const r=await request('/trip/plan',{...input,province:'上海市',district_adcode:'310101'});
 assert.equal(r.status,201);assert.equal(r.body.preferences.district,'黄浦区');assert.equal(r.body.route_pack.adcode,'310101');assert.equal(r.body.route_pack.city_adcode,'310000');
 assert.equal(r.body.poi_catalog.length,17);assert.ok(r.body.poi_catalog.every(p=>p.adcode==='310101'));
 assert.ok(r.body.days[0].stops.every(p=>p.adcode==='310101'));
});
test('mismatched province or district rejected before POI search',async t=>{
 const {request,calls}=setup(t);
 for(const selection of [{province:'浙江省'},{province:'上海市',district_adcode:'330106'},{district_adcode:'310999'}])assert.equal((await request('/trip/plan',{...input,...selection})).status,422);
 assert.equal((await request('/trip/plan',{...input,district_adcode:'bad'})).status,400);
 assert.equal(calls.filter(u=>u.pathname==='/v5/place/text').length,0);
});
test('region hierarchy handles municipalities and excludes street-level options',()=>{
 const provinces=normalizeRegions([{name:'上海市',adcode:'310000',districts:[{name:'上海城区',adcode:'310100',level:'city',districts:[{name:'黄浦区',adcode:'310101',level:'district'}]}]},{name:'海南省',adcode:'460000',districts:[{name:'屯昌县',adcode:'469022',level:'city',districts:[{name:'南坤镇',adcode:'469022',level:'street'}]}]}]);
 assert.equal(provinces[0].cities[0].name,'上海市');assert.deepEqual(provinces[0].cities[0].districts,[{name:'黄浦区',adcode:'310101'}]);assert.deepEqual(provinces[1].cities[0].districts,[]);
});
