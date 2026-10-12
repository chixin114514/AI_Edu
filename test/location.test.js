import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { dispatch } from './harness.js';

const input={lat:30.256,lng:120.143,accuracy:20,coordinate_system:'WGS84'};
function setup(t,{city='杭州市',province='浙江省',adcode='330106',location='120.1481,30.2596',fail=false}={}){
  const oldFetch=globalThis.fetch,oldEnv={...process.env},calls=[];
  Object.assign(process.env,{AMAP_MAPS_API_KEY:'test-location-key',AMAP_MIN_INTERVAL_MS:'0'});
  const app=createApp({database:':memory:'});
  globalThis.fetch=async url=>{
    const u=new URL(url);calls.push(u);
    assert.equal(u.origin,'https://restapi.amap.com');
    if(fail)throw Error('private-key-must-not-be-exposed');
    const body=u.pathname.endsWith('/convert')?{status:'1',locations:location}:{status:'1',regeocode:{formatted_address:province+'测试地址',addressComponent:{province,city,district:'测试区',adcode},pois:[{name:'附近地点'}]}};
    return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
  };
  t.after(()=>{app.emit('close');globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);});
  return {app,calls};
}
test('location converts GPS before geocoding and selects a nearby trial starting point',async t=>{
  const {app,calls}=setup(t);const r=await dispatch(app,'/api/location/resolve',input);
  assert.equal(r.status,200);assert.equal(r.body.city,'杭州市');assert.equal(r.body.suggested_start.id,'broken-bridge');assert.equal(r.body.position.coordinate_system,'GCJ-02');
  assert.equal(calls[0].searchParams.get('coordsys'),'gps');assert.equal(calls[0].searchParams.get('locations'),'120.143000,30.256000');
  assert.equal(calls[1].searchParams.get('location'),'120.1481,30.2596');assert.equal(r.headers['cache-control'],'no-store');
  // Same lookup must hit the provider again: precise location has no application cache.
  await dispatch(app,'/api/location/resolve',input);assert.equal(calls.length,4);
  const trips=await dispatch(app,'/api/trips',undefined,{cookie:r.headers['set-cookie'].split(';')[0]});assert.deepEqual(trips.body.trips,[]);
});
test('municipality city array falls back to province; outside trial does not suggest Hangzhou',async t=>{
  const {app}=setup(t,{city:[],province:'上海市',adcode:'310101',location:'121.47,31.23'});const r=await dispatch(app,'/api/location/resolve',input);assert.equal(r.status,200);assert.equal(r.body.city,'上海市');assert.equal(r.body.supported_city,false);assert.equal(r.body.suggested_start,null);
});
test('coarse accuracy and distant Hangzhou positions do not change starting point',async t=>{
  const {app}=setup(t);const r=await dispatch(app,'/api/location/resolve',{...input,accuracy:501});assert.equal(r.body.suggested_start,null);
});
test('distant position in Hangzhou has no local starting point',async t=>{
  const {app}=setup(t,{location:'119.7,30.1'});const r=await dispatch(app,'/api/location/resolve',input);assert.equal(r.body.supported_city,true);assert.equal(r.body.suggested_start,null);
});
test('invalid coordinate inputs are rejected before network',async t=>{
  const {app,calls}=setup(t);for(const patch of [{lat:91},{lng:-181},{lat:'30'},{accuracy:-1},{accuracy:null},{coordinate_system:'GCJ-02'}]){assert.equal((await dispatch(app,'/api/location/resolve',{...input,...patch})).status,400);}assert.equal(calls.length,0);
});
test('provider failure is actionable and never exposes upstream secrets',async t=>{
  const {app}=setup(t,{fail:true});const r=await dispatch(app,'/api/location/resolve',input);assert.equal(r.status,503);assert.match(r.body.error,/手动选择/);assert.ok(!JSON.stringify(r).includes('private-key'));
});
test('malformed converted coordinates are rejected before reverse geocoding',async t=>{
  const {app,calls}=setup(t,{location:'NaN,30'});assert.equal((await dispatch(app,'/api/location/resolve',input)).status,503);assert.equal(calls.length,1);
});
test('missing address result is not invented',async t=>{
  const {app}=setup(t,{city:[],province:[],adcode:[]});assert.equal((await dispatch(app,'/api/location/resolve',input)).status,503);
});
