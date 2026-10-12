import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/index.js';
import {dispatch} from './harness.js';
import {mapViewport,mapPixel,project,unproject,routePaths} from '../public/map-geometry.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const input={city:'杭州',date:'2026-10-15',days:2,budget:300,walk_limit_km:6,interests:['自然'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:false};
async function fixture(t){
 const old={...process.env},original=globalThis.fetch;process.env.DATA_MODE='demo';process.env.AMAP_MAPS_API_KEY='map-test-'+Math.random();
 const app=createApp({database:':memory:'});const plan=await dispatch(app,'/api/trip/plan',input),cookie=plan.headers['set-cookie'].split(';')[0];
 t.after(()=>{globalThis.fetch=original;app.emit('close');for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);});
 return {app,trip:plan.body,cookie,url:'/api/trip/'+plan.body.id+'/map'};
}
test('viewport fits stops and actual path bounds; GCJ-02 coordinates are not converted twice',()=>{
 const stops=[{lng:120.15,lat:30.25},{lng:120.16,lat:30.26,leg:{mode:'live',polyline:[[120.15,30.25],[120.14,30.27],[120.16,30.26]]}}];
 const view=mapViewport(stops);
 for(const p of [[120.15,30.25],[120.16,30.26],...routePaths(stops)[0]]){const [x,y]=mapPixel(p,view);assert.ok(x>=40&&x<=600);assert.ok(y>=40&&y<=440);}
 assert.deepEqual(mapViewport(stops,{focus:1,zoom:17}).center,[120.16,30.26]);
 const roundtrip=unproject(project([120.15,30.25]));assert.ok(Math.abs(roundtrip[0]-120.15)<1e-8&&Math.abs(roundtrip[1]-30.25)<1e-8);
 assert.equal(mapViewport([stops[0]]).zoom,17);
});
test('missing and demo geometry never becomes a straight route between stops',()=>{
 const stops=[{lng:120,lat:30,leg:{mode:'demo',polyline:[[120,30],[121,31]]}},{lng:121,lat:31,leg:{mode:'live',polyline:[]}},{lng:122,lat:32,leg:{mode:'live',polyline:[[121,31],[NaN,31],[122,32]]}}];
 assert.deepEqual(routePaths(stops),[[[121,31],[122,32]]]);
});
test('map endpoint protects ownership, validates view, and never exposes provider key',async t=>{
 const {app,cookie,url}=await fixture(t);let calls=0;
 globalThis.fetch=async url=>{calls++;const u=new URL(url);assert.equal(u.origin,'https://restapi.amap.com');assert.equal(u.pathname,'/v3/staticmap');assert.equal(u.searchParams.get('size'),'640*480');assert.equal(u.searchParams.get('key'),process.env.AMAP_MAPS_API_KEY);return new Response(png,{headers:{'content-type':'image/png;charset=UTF-8'}});};
 assert.equal((await dispatch(app,url)).status,404);
 for(const q of ['day=0','day=3','zoom=18','zoom=NaN','focus=-1','focus=999'])assert.equal((await dispatch(app,url+'?'+q,undefined,{cookie})).status,400);
 assert.equal(calls,0);
 const r=await dispatch(app,url,undefined,{cookie});assert.equal(r.status,200);assert.match(r.body.image,/^data:image\/png;base64,/);assert.equal(r.body.source,'高德地图');assert.ok(!JSON.stringify(r.body).includes(process.env.AMAP_MAPS_API_KEY));assert.equal(r.headers['cache-control'],'no-store');
 assert.equal((await dispatch(app,url,undefined,{cookie})).status,200);assert.equal(calls,1);
 const focused=await dispatch(app,url+'?focus=1&zoom=16',undefined,{cookie});assert.equal(focused.body.view.zoom,16);assert.equal(calls,2);
});
test('map provider errors stay actionable and do not leak URLs or credentials',async t=>{
 const {app,cookie,url}=await fixture(t);
 for(const response of [()=>new Response(JSON.stringify({key:process.env.AMAP_MAPS_API_KEY}),{headers:{'content-type':'application/json'}}),()=>new Response('not-an-image',{headers:{'content-type':'image/png'}}),()=>{throw Error('https://secret-request-url')}]){
  globalThis.fetch=async()=>response();const r=await dispatch(app,url,undefined,{cookie});assert.equal(r.status,503);assert.match(r.body.error,/地图暂时/);assert.ok(!JSON.stringify(r.body).includes('secret'));
 }
});
