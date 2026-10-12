import {createHash} from 'node:crypto';
import {mapViewport} from '../public/map-geometry.js';
const cache=new Map(),pending=new Map();
export async function routeMap(stops,options={}){
 const key=process.env.AMAP_MAPS_API_KEY||process.env.AMAP_KEY;
 if(!key)throw Error('MAP_NOT_CONFIGURED');
 const view=mapViewport(stops,options);
 const id=createHash('sha256').update(key+JSON.stringify(view)).digest('hex');
 const hit=cache.get(id);if(hit&&hit.expires>Date.now())return {...hit.value,view};
 if(pending.has(id))return pending.get(id);
 const task=(async()=>{
  const u=new URL('https://restapi.amap.com/v3/staticmap');
  for(const[k,v]of Object.entries({key,location:view.center.join(','),zoom:view.zoom,size:`${view.width}*${view.height}`,scale:1}))u.searchParams.set(k,v);
  const r=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(12000)});
  const type=(r.headers.get('content-type')||'').split(';')[0];
  if(!r.ok||!['image/png','image/jpeg'].includes(type))throw Error('MAP_UNAVAILABLE');
  const bytes=Buffer.from(await r.arrayBuffer());
  if(bytes.length>3_000_000||bytes.length<8)throw Error('INVALID_MAP');
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(type==='image/png'?!png:!jpeg)throw Error('INVALID_MAP');
  const value={image:`data:${type};base64,${bytes.toString('base64')}`,view,source:'高德地图'};
  if(cache.size>=64)cache.delete(cache.keys().next().value);
  cache.set(id,{value,expires:Date.now()+300000});return value;
 })();
 pending.set(id,task);try{return await task;}finally{pending.delete(id);}
}
