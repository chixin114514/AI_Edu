import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatchRelay } from '../server/watch-relay.js';
import { createApp } from '../server/index.js';
import { WatchLink } from '../public/watch-link.js';
import { Sensors } from '../public/sensors.js';
import { dispatch,mergeCookies } from './harness.js';
const plan={city:'杭州',date:'2026-10-13',days:1,budget:300,walk_limit_km:6,interests:['自然'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:false};
function relayFixture(t){let time=2000000000000;const r=createWatchRelay({now:()=>time});t.after(()=>r.close());return {r,now:()=>time,advance:n=>time+=n};}
function token(r,owner='owner',id='session'){return r.pair(r.create(owner,id).code,'ip').token;}
test('pairing codes are single-use, short lived, and scope device tokens to one owner',t=>{
 const {r,advance,now}=relayFixture(t),link=r.create('a','s'),credential=r.pair(link.code,'ip').token;
 assert.throws(()=>r.pair(link.code,'ip'),{status:401});assert.equal(r.state('b','s').status,'disconnected');
 r.sample(credential,{bpm:76,timestamp:now(),sequence:1});assert.equal(r.state('a','s').sample.bpm,76);
 const fresh=r.create('a','s');assert.throws(()=>r.sample(credential,{bpm:77,timestamp:now(),sequence:2}),{status:401});
 advance(300001);assert.throws(()=>r.pair(fresh.code,'ip'),{status:401});
});
test('only latest sample is retained; stale samples and expired connections disappear',t=>{
 const {r,now,advance}=relayFixture(t),credential=token(r);
 r.sample(credential,{bpm:70,timestamp:now(),sequence:1});advance(5000);r.sample(credential,{bpm:72,timestamp:now(),sequence:2});
 assert.deepEqual(r.state('owner','session').sample,{bpm:72,timestamp:now(),sequence:2});
 advance(20001);assert.equal(r.state('owner','session').sample,null);
 advance(4*3600000);assert.equal(r.state('owner','session').status,'disconnected');assert.throws(()=>r.disconnect(credential),{status:401});
});
test('relay rejects invalid, stale, replayed, too-fast and extra health fields',t=>{
 const {r,now,advance}=relayFixture(t),credential=token(r),good={bpm:80,timestamp:now(),sequence:1};
 for(const patch of [{bpm:'80'},{bpm:NaN},{bpm:300},{timestamp:now()-20001},{timestamp:now()+5001},{sequence:0},{raw_hr:[80]}])assert.throws(()=>r.sample(credential,{...good,...patch}),e=>[400,409].includes(e.status));
 r.sample(credential,good);assert.throws(()=>r.sample(credential,good),{status:409});
 assert.throws(()=>r.sample(credential,{...good,timestamp:now()+1,sequence:2}),{status:429});
 advance(5000);assert.throws(()=>r.sample(credential,{...good,sequence:2}),{status:409});
 r.sample(credential,{...good,timestamp:now(),sequence:2});
});
test('pairing brute force is bounded and owner/device revocation is immediate',t=>{
 const {r,advance}=relayFixture(t),credential=token(r);r.revokeOwner('owner');assert.throws(()=>r.disconnect(credential),{status:401});
 for(let i=0;i<10;i++)assert.throws(()=>r.pair('00000000','attacker'),{status:401});
 assert.throws(()=>r.pair('00000000','attacker'),{status:429});advance(300001);
 const next=token(r);r.disconnect(next);assert.equal(r.state('owner','session').status,'disconnected');
});
async function apiFixture(t){
 const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));let cookie='';
 const request=async(path,data,headers={})=>{const res=await dispatch(app,'/api'+path,data,{cookie,...headers});cookie=mergeCookies(cookie,res.headers['set-cookie']);return res;};
 const trip=(await request('/trip/plan',plan)).body,session=(await request('/session/start',{trip_id:trip.id,day:1,model_consent:false})).body;
 return {app,request,trip,session};
}
test('real API requires explicit consent and ownership, isolates readers and never exports raw samples',async t=>{
 const {app,request,session,trip}=await apiFixture(t),body={session_id:session.id};
 assert.equal((await request('/watch/link',body)).status,400);
 assert.equal((await dispatch(app,'/api/watch/link',{...body,relay_consent:true})).status,404);
 const link=await request('/watch/link',{...body,relay_consent:true});assert.equal(link.status,201);
 const paired=await dispatch(app,'/api/watch/pair',{code:link.body.code});assert.equal(paired.headers['set-cookie'],undefined);
 const credential=paired.body.token,headers={authorization:'Bearer '+credential};
 assert.equal((await dispatch(app,'/api/watch/sample',{bpm:83,timestamp:Date.now(),sequence:1},headers)).status,200);
 const state=await request('/watch/state?session_id='+session.id);assert.equal(state.body.sample.bpm,83);assert.equal(state.headers['cache-control'],'no-store');
 assert.equal((await dispatch(app,'/api/watch/state?session_id='+session.id)).status,404);
 for(const path of ['/session/'+session.id,'/trip/'+trip.id,'/trip/'+trip.id+'/report']){
  const text=JSON.stringify((await request(path)).body);for(const raw of ['"bpm"',credential,link.body.code])assert.ok(!text.includes(raw));
 }
 await request('/session/end',body);assert.equal((await dispatch(app,'/api/watch/sample',{bpm:83,timestamp:Date.now(),sequence:2},headers)).status,401);
 assert.equal((await request('/watch/link',{...body,relay_consent:true})).status,409);
});
test('API revokes on logout, privacy deletion, emergency, account migration and reconnect',async t=>{
 for(const action of ['logout','delete','unwell','login','reconnect']){
  const {app,request,session}=await apiFixture(t),body={session_id:session.id,relay_consent:true};
  const code=(await request('/watch/link',body)).body.code;
  const credential=(await dispatch(app,'/api/watch/pair',{code})).body.token;
  if(action==='logout')await request('/auth/logout',{});
  if(action==='delete')await request('/privacy/delete',{confirm:true});
  if(action==='unwell')await request('/feedback',{session_id:session.id,feedback_type:'unwell'});
  if(action==='login')await request('/auth/login',{username:'admin',password:'admin'});
  if(action==='reconnect')await request('/watch/link',body);
  assert.equal((await dispatch(app,'/api/watch/sample',{bpm:80,timestamp:Date.now(),sequence:1},{authorization:'Bearer '+credential})).status,401,action);
 }
});
test('watch endpoints refuse remote cleartext, cross-origin pairing and missing bearer tokens',async t=>{
 const {app}=await apiFixture(t);
 assert.equal((await dispatch(app,'/api/watch/pair',{code:'00000000'},{host:'example.com'})).status,400);
 assert.equal((await dispatch(app,'/api/watch/pair',{code:'00000000'},{origin:'https://evil.example'})).status,403);
 assert.equal((await dispatch(app,'/api/watch/sample',{bpm:80,timestamp:Date.now(),sequence:1})).status,401);
 assert.equal((await dispatch(app,'/api/watch/pair')).status,405);
});
test('browser serializes cancel/reconnect so an old unlink cannot revoke a new connection',async()=>{
 const states=[],link=new WatchLink(v=>states.push(v)),calls=[];let release;
 link.poll=()=>{};
 link.request=async(path)=>{calls.push(path);if(path==='link'&&calls.length===1)await new Promise(r=>release=r);return {code:'AABBCCDD'};};
 const first=link.start('s');const firstFailure=assert.rejects(first,/取消/);
 await new Promise(r=>setImmediate(r));const stopped=link.stop(),second=link.start('s');release();
 await firstFailure;await stopped;await second;
 assert.equal(calls.at(-1),'link');assert.equal(states.length,1);assert.equal(link.session_id,'s');await link.stop();
});
test('Watch readings use real sample times for baseline, ignore duplicate polls, and clear broken trends',()=>{
 const sensor=Object.create(Sensors.prototype);Object.assign(sensor,{source:'watch',watchStatus:'waiting',watchSequence:0,samples:[],calibrating:true,calibrationStart:Date.now()-35000,baseline:null,highSince:null});
 const original=globalThis.document;globalThis.document={hidden:false};sensor.emit=()=>{};
 try{
  const start=sensor.calibrationStart;
  for(let i=1;i<=7;i++)sensor.receiveWatch({status:'live',sample:{sequence:i,bpm:70,timestamp:start+i*5000}});
  assert.equal(sensor.baseline,70);assert.equal(sensor.calibrating,false);assert.equal(sensor.samples.length,7);
  sensor.receiveWatch({status:'live',sample:{sequence:7,bpm:200,timestamp:Date.now()}});assert.equal(sensor.samples.length,7);assert.equal(sensor.hr,70);
  sensor.receiveWatch({status:'unavailable',sample:null});assert.equal(sensor.hr,null);assert.equal(sensor.highSince,null);assert.equal(sensor.samples.length,0);
  sensor.cadence=60;sensor.cadenceBaseline=70;sensor.totalSteps=10;
  assert.equal('bpm' in sensor.features(),false);assert.equal('hr_vs_baseline_pct' in sensor.features(),false);
 }finally{globalThis.document=original;}
});
