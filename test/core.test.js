import { test } from 'node:test';
import { dispatch,mergeCookies } from './harness.js';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { evaluate, simulateState, minutes } from '../server/planner.js';
import { parseHeartRate } from '../public/sensors.js';
const input={city:'杭州',date:'2026-10-13',days:1,budget:300,walk_limit_km:6,interests:['自然','人文'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:false};
const simulation={hr:100,baseline_hr:70,cadence:80,baseline_cadence:100,duration_s:180,status:'auto',use_jev:false};
async function fixture(t){
  const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));let cookie='';
  const request=async(path,data,extra={})=>{const result=await dispatch(app,'/api'+path,data,{cookie,...extra});cookie=mergeCookies(cookie,result.headers['set-cookie']);return result;};
  await request('/config');return {request,foreign:path=>dispatch(app,'/api'+path)};
}
test('planning enforces budget, walking and opening windows across two days',async t=>{const {request}=await fixture(t);const {body:p,status}=await request('/trip/plan',{...input,days:2,budget:50,walk_limit_km:3});assert.equal(status,201);assert.equal(p.days.length,2);assert.notDeepEqual(p.days[0].stops,p.days[1].stops);for(const day of p.days){assert.ok(day.cost<=25);assert.ok(day.distance_m<=3000);for(const s of day.stops){assert.ok(minutes(s.arrival)>=minutes(s.open));assert.ok(minutes(s.departure)<=minutes(s.close));assert.ok(minutes(s.departure)<=minutes(input.end_time));}}});
test('invalid date, city, limits and malformed inputs fail with 400',async t=>{const {request}=await fixture(t);for(const change of [{city:'北京'},{date:'2026-02-30'},{budget:-1},{walk_limit_km:0},{days:3},{interests:['unknown']},{start_time:'bad'},{model_consent:'yes'}])assert.equal((await request('/trip/plan',{...input,...change})).status,400);});
test('closed museums are excluded on Monday',async t=>{const {request}=await fixture(t);const {body:p}=await request('/trip/plan',{...input,date:'2026-10-12',interests:['展览']});assert.ok(p.days[0].stops.every(s=>s.category!=='展览'));assert.ok(p.days[0].plan_b.stops.every(s=>s.category!=='展览'));});
test('reject preserves route; accept mutates once; conflicting repeat fails',async t=>{const {request}=await fixture(t);const {body:p}=await request('/trip/plan',input);const {body:s}=await request('/session/start',{trip_id:p.id,day:1,model_consent:false});const {body:a}=await request('/feedback',{session_id:s.id,feedback_type:'tired'});assert.equal(a.require_confirm,true);assert.equal((await request('/trip/'+p.id)).body.version,1);const no=await request('/session/confirm',{session_id:s.id,suggestion_id:a.id,accept:false});assert.deepEqual(no.body.trip.days,p.days);const {body:b}=await request('/feedback',{session_id:s.id,feedback_type:'tired'});const yes=await request('/session/confirm',{session_id:s.id,suggestion_id:b.id,accept:true});assert.equal(yes.body.trip.version,2);assert.notDeepEqual(yes.body.trip.days,p.days);const repeat=await request('/session/confirm',{session_id:s.id,suggestion_id:b.id,accept:true});assert.equal(repeat.body.trip.version,2);assert.equal(repeat.body.idempotent,true);assert.equal((await request('/session/confirm',{session_id:s.id,suggestion_id:b.id,accept:false})).status,409);});
test('superseded suggestion is rejected and emergency prevents pending reroutes',async t=>{const {request}=await fixture(t);const {body:p}=await request('/trip/plan',input);const {body:s}=await request('/session/start',{trip_id:p.id,day:1,model_consent:false});const {body:a}=await request('/feedback',{session_id:s.id,feedback_type:'tired'});const {body:b}=await request('/feedback',{session_id:s.id,feedback_type:'rain',demo:true});assert.equal((await request('/session/confirm',{session_id:s.id,suggestion_id:a.id,accept:true})).status,409);const emergency=await request('/feedback',{session_id:s.id,feedback_type:'unwell'});assert.equal(emergency.body.status,'paused');if(b.id)assert.equal((await request('/session/confirm',{session_id:s.id,suggestion_id:b.id,accept:true})).status,409);assert.equal((await request('/session/checkin',{session_id:s.id,stop_id:p.days[0].stops[0].id})).status,409);assert.equal((await request('/feedback',{session_id:s.id,feedback_type:'tired'})).body.status,'paused');});
test('session isolation, admin authorization, origin protection and deletion',async t=>{const {request,foreign}=await fixture(t);const {body:p}=await request('/trip/plan',input);const result=await foreign('/trip/'+p.id);assert.equal(result.status,404);assert.equal((await request('/ops/run',{job:'poi_audit'})).status,401);assert.equal((await request('/trip/plan',input,{Origin:'https://evil.example'})).status,403);assert.equal((await request('/privacy/delete',{confirm:true})).status,200);assert.equal((await request('/trip/'+p.id)).status,404);});
test('sensor features validation, event cooldown, and raw-health data not retained',async t=>{const {request}=await fixture(t);const {body:p}=await request('/trip/plan',input);const {body:s}=await request('/session/start',{trip_id:p.id,day:1,model_consent:false});assert.equal((await request('/session/state',{session_id:s.id,features:{raw_hr:[100]}})).status,400);assert.equal((await request('/session/state',{session_id:s.id,features:{hr_vs_baseline_pct:'30'}})).status,400);const state={session_id:s.id,trigger:'hr_high_sustained',features:{hr_vs_baseline_pct:30,duration_s:190,cadence_change_pct:-20}};assert.equal((await request('/session/state',state)).body.require_confirm,true);assert.equal((await request('/session/state',state)).body.suggestion,'cooldown');const session=(await request('/session/'+s.id)).body;assert.ok(!JSON.stringify(session).includes('hr_vs_baseline_pct'));await request('/session/end',{session_id:s.id});assert.equal((await request('/session/state',state)).status,409);});
test('single outlier does not trigger a reroute, sustained combined signal does',()=>{assert.equal(evaluate({hr_vs_baseline_pct:90,duration_s:2,cadence_change_pct:-50},'state').action,'continue');assert.equal(evaluate({hr_vs_baseline_pct:30,duration_s:180,cadence_change_pct:-20},'state').action,'shorten');assert.equal(evaluate({hr_vs_baseline_pct:30,duration_s:180},'state').action,'continue');assert.equal(evaluate({},'unwell').status,'paused');});
test('BLE parses 8-bit and 16-bit heart rate and ignores lost contact',()=>{assert.equal(parseHeartRate(new DataView(Uint8Array.from([0,80]).buffer)),80);assert.equal(parseHeartRate(new DataView(Uint8Array.from([1,160,0]).buffer)),160);assert.equal(parseHeartRate(new DataView(Uint8Array.from([4,80]).buffer)),null);assert.throws(()=>parseHeartRate(new DataView(Uint8Array.from([1,80]).buffer)));});
test('expired suggestions cannot be accepted',async t=>{const {request}=await fixture(t);const {body:p}=await request('/trip/plan',input);const {body:s}=await request('/session/start',{trip_id:p.id,day:1,model_consent:false});const {body:a}=await request('/feedback',{session_id:s.id,feedback_type:'tired'});const original=Date.now;try{Date.now=()=>original()+11*60000;assert.equal((await request('/session/confirm',{session_id:s.id,suggestion_id:a.id,accept:true})).status,409);}finally{Date.now=original;}assert.equal((await request('/trip/'+p.id)).body.version,1);});
test('missing live map credentials never silently produce a demo route',async t=>{const before=process.env.DATA_MODE,key=process.env.AMAP_KEY;try{process.env.DATA_MODE='live';delete process.env.AMAP_KEY;const {request}=await fixture(t);assert.equal((await request('/trip/plan',input)).status,503);}finally{if(before===undefined)delete process.env.DATA_MODE;else process.env.DATA_MODE=before;if(key===undefined)delete process.env.AMAP_KEY;else process.env.AMAP_KEY=key;}});
test('report reflects actual checkins and suggestion choices, ending is idempotent',async t=>{const {request}=await fixture(t);const {body:p}=await request('/trip/plan',input);const {body:s}=await request('/session/start',{trip_id:p.id,day:1,model_consent:false});await request('/session/checkin',{session_id:s.id,stop_id:p.days[0].stops[0].id});assert.equal((await request('/session/checkin',{session_id:s.id,stop_id:p.days[0].stops[0].id})).status,409);const {body:a}=await request('/feedback',{session_id:s.id,feedback_type:'tired'});await request('/session/confirm',{session_id:s.id,suggestion_id:a.id,accept:false});const end=await request('/session/end',{session_id:s.id});assert.equal((await request('/session/end',{session_id:s.id})).body.ended_at,end.body.ended_at);const r=await request('/trip/'+p.id+'/report');assert.equal(r.body.visited_stops,1);assert.equal(r.body.rejected,1);assert.equal(r.body.finished,true);});
test('admin can read provider status and prototype job endpoint is removed',async t=>{const {request}=await fixture(t);await request('/auth/login',{username:'admin',password:'admin'});const r=await request('/ops');assert.equal(r.status,200);assert.deepEqual(Object.keys(r.body).sort(),['provider_status','providers']);assert.equal((await request('/ops/run',{job:'poi_audit'})).status,404);});
test('static shell and offline files served, traversal and secrets blocked',async t=>{const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));for(const p of ['/','/app.js','/style.css','/sensors.js','/sw.js','/lake.svg'])assert.equal((await dispatch(app,p)).status,200);for(const p of ['/.env','/../server/index.js','/%2e%2e/server/index.js'])assert.equal((await dispatch(app,p)).status,404);});

test('custom readings use baselines, duration and explicit state independently',()=>{
  const auto=simulateState(simulation);assert.equal(auto.rule.status,'rest');assert.deepEqual(auto.features,{hr_vs_baseline_pct:43,cadence_change_pct:-20,duration_s:180});
  assert.equal(simulateState({...simulation,duration_s:179}).outcome.status,'normal');
  assert.equal(simulateState({...simulation,hr:70}).features.duration_s,0);
  assert.equal(simulateState({...simulation,cadence:100}).outcome.status,'normal');
  const normal=simulateState({...simulation,status:'normal'});assert.equal(normal.rule.status,'rest');assert.equal(normal.outcome.status,'normal');
  assert.equal(simulateState({...simulation,hr:70,cadence:100,status:'mild_fatigue'}).outcome.status,'mild_fatigue');
});
test('custom simulation requires admin and ownership and rejects invalid readings',async t=>{
  const {request,foreign}=await fixture(t);
  assert.equal((await request('/session/simulate',{})).status,401);
  await request('/auth/register',{username:'traveler',password:'password123'});
  assert.equal((await request('/session/simulate',{})).status,403);
  await request('/auth/login',{username:'admin',password:'admin'});
  const {body:p}=await request('/trip/plan',input),{body:s}=await request('/session/start',{trip_id:p.id,day:1,model_consent:false});
  for(const invalid of [{hr:0},{hr:'100'},{cadence:-1},{baseline_cadence:0},{baseline_hr:0},{duration_s:-1},{status:'paused'},{status:'bogus'},{use_jev:'yes'},{raw_hr:[100]}]){
    assert.equal((await request('/session/simulate',{session_id:s.id,simulation:{...simulation,...invalid}})).status,400,JSON.stringify(invalid));
  }
  assert.equal((await request('/session/simulate',{session_id:s.id,simulation:{...simulation,use_jev:true}})).status,400);
  assert.equal((await request('/session/simulate',{session_id:'foreign',simulation})).status,404);
  assert.equal((await foreign('/session/'+s.id)).status,404);
});
test('admin simulation bypasses cooldown, keeps raw readings transient and requires confirmation',async t=>{
  const {request}=await fixture(t);await request('/auth/login',{username:'admin',password:'admin'});
  const {body:p}=await request('/trip/plan',input),{body:s}=await request('/session/start',{trip_id:p.id,day:1,model_consent:false});
  await request('/session/state',{session_id:s.id,features:{hr_vs_baseline_pct:30,duration_s:180,cadence_change_pct:-20}});
  const before=(await request('/session/'+s.id)).body;
  const run=async extra=>{const result=await request('/session/simulate',{session_id:s.id,simulation:{...simulation,...extra}});assert.equal(result.status,200);return result.body;};
  const a=await run({}),b=await run({status:'mild_fatigue'});
  assert.equal(a.require_confirm,true);assert.equal(a.demo,true);assert.equal(a.simulation_result.status,'rest');assert.equal(b.require_confirm,true);assert.notEqual(a.id,b.id);
  assert.equal((await request('/session/confirm',{session_id:s.id,suggestion_id:a.id,accept:true})).status,409);
  assert.equal((await request('/trip/'+p.id)).body.version,1);
  const saved=(await request('/session/'+s.id)).body;
  assert.equal(saved.last_suggestion_at,before.last_suggestion_at);assert.ok(saved.events.at(-1).demo);
  assert.doesNotMatch(JSON.stringify(saved),/baseline_hr|baseline_cadence|hr_vs_baseline_pct|duration_s/);
  const stored=(await request('/suggestion/'+b.id)).body;
  assert.doesNotMatch(JSON.stringify(stored),/baseline_hr|baseline_cadence|hr_vs_baseline_pct|duration_s/);
  const normal=await run({status:'normal'});assert.equal(normal.simulation_result.rule_status,'rest');assert.equal(normal.status,'normal');assert.equal(normal.require_confirm,false);
  assert.equal((await request('/session/'+s.id)).body.pending_suggestion,null);
  assert.equal((await request('/session/confirm',{session_id:s.id,suggestion_id:b.id,accept:true})).status,409);
  const c=await run({status:'rest'});
  assert.equal((await request('/session/confirm',{session_id:s.id,suggestion_id:c.id,accept:true})).body.trip.version,2);
  await request('/feedback',{session_id:s.id,feedback_type:'unwell'});
  assert.equal((await run({status:'normal'})).status,'paused');
  assert.equal((await request('/session/'+s.id)).body.status,'paused');
  await request('/session/end',{session_id:s.id});
  assert.equal((await request('/session/simulate',{session_id:s.id,simulation})).status,409);
});
