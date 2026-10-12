import {mapPixel,routePaths,validPoint} from './map-geometry.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const active=new Set();
export function routeMapMarkup(trip,day){
 const stops=trip.days[day-1]?.stops||[];
 if(!stops.length)return '<div class="map-empty">生成行程后，这里会显示城市地图与路线。</div>';
 return `<div class="route-map" data-trip="${esc(trip.id)}" data-day="${day}" data-version="${trip.version}"><div class="map-canvas"><div class="map-picture"></div><p class="map-message" role="status" aria-live="polite">正在加载高德地图…</p></div><div class="map-controls" aria-label="地图操作"><button type="button" data-map-action="out" aria-label="缩小地图">−</button><button type="button" data-map-action="in" aria-label="放大地图">＋</button><button type="button" data-map-action="fit">查看全程</button><button type="button" data-map-action="retry" hidden>重新加载</button></div><p class="map-caption">高德地图 · ${trip.data_mode==='demo'?'演示地点，未绘制真实步行路径':'绿色线为高德步行路径'} · 点击地点查看</p><div class="map-stops">${stops.map((p,i)=>`<button type="button" data-map-focus="${i}" aria-pressed="false">${i+1}. ${esc(p.name)}</button>`).join('')}</div><div class="map-selected" aria-live="polite"></div></div>`;
}
export function destroyRouteMaps(){for(const dispose of active)dispose();active.clear();}
export function mountRouteMaps(trip){
 if(!trip)return;
 for(const el of document.querySelectorAll('.route-map')){
  const stops=trip.days[Number(el.dataset.day)-1]?.stops||[];
  const picture=el.querySelector('.map-picture'),message=el.querySelector('.map-message');
  let view=null,focus=null,controller=null,sequence=0,disposed=false;
  const controls=busy=>{for(const b of el.querySelectorAll('[data-map-action]'))b.disabled=busy;el.querySelector('[data-map-action="in"]').disabled=busy||view?.zoom===17;el.querySelector('[data-map-action="out"]').disabled=busy||view?.zoom===3;};
  const selected=()=>{for(const b of el.querySelectorAll('[data-map-focus]'))b.setAttribute('aria-pressed',String(Number(b.dataset.mapFocus)===focus));const p=stops[focus];el.querySelector('.map-selected').innerHTML=p?`<strong>${esc(p.name)}</strong><p>${esc(p.arrival)}—${esc(p.departure)} · ${esc(p.description)}</p><a href="https://uri.amap.com/marker?position=${p.lng},${p.lat}&name=${encodeURIComponent(p.name)}&coordinate=gaode&callnative=0" target="_blank" rel="noopener noreferrer">在高德中打开 ↗</a>`:'';};
  async function load(zoom){
   controller?.abort();controller=new AbortController();const request=++sequence;controls(true);message.hidden=false;message.textContent='正在加载高德地图…';
   const q=new URLSearchParams({day:el.dataset.day,v:el.dataset.version});if(zoom!==undefined)q.set('zoom',zoom);if(focus!==null)q.set('focus',focus);
   try{
    const response=await fetch(`/api/trip/${encodeURIComponent(trip.id)}/map?${q}`,{signal:controller.signal});
    if(!response.ok)throw Error('MAP_UNAVAILABLE');const data=await response.json();
    if(disposed||request!==sequence)return;
    if(!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(data.image))throw Error('INVALID_MAP');
    view=data.view;
    const paths=routePaths(stops).map(path=>path.map((p,i)=>{const [x,y]=mapPixel(p,view);return `${i?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`;}).join(''));
    const pins=stops.map((p,i)=>{if(!validPoint([p.lng,p.lat]))return '';const [x,y]=mapPixel([p.lng,p.lat],view);return `<g class="map-pin" data-map-focus="${i}" role="button" tabindex="0" aria-label="${i+1}. ${esc(p.name)}" transform="translate(${x.toFixed(2)},${y.toFixed(2)})"><circle r="17" fill="${i===focus?'#b17b40':'#2f5d49'}" stroke="white" stroke-width="3"/><text y="5" text-anchor="middle" fill="white" font-size="15" font-weight="600">${i+1}</text></g>`;}).join('');
    picture.innerHTML=`<img src="${data.image}" alt="高德城市道路底图" width="640" height="480"><svg viewBox="0 0 640 480" class="map-overlay" aria-label="行程地点与步行路线">${paths.map(d=>`<path d="${d}" fill="none" stroke="white" stroke-width="8"/><path d="${d}" fill="none" stroke="#2f7654" stroke-width="5" stroke-linejoin="round"/>`).join('')}${pins}</svg>`;
    message.hidden=true;el.querySelector('[data-map-action="retry"]').hidden=true;selected();
    const missing=stops.slice(1).filter(p=>p.leg?.mode!=='live'||!(p.leg.polyline?.length>=2)).length;
    if(trip.data_mode!=='demo'&&missing)el.querySelector('.map-caption').textContent='高德地图 · 部分路段暂无路径，仅显示已有步行路线与地点';
   }catch(e){if(disposed||request!==sequence||e.name==='AbortError')return;message.textContent=picture.childElementCount?'地图更新失败，当前仍为上次视图。':'地图暂时无法加载，请检查网络后重试。';el.querySelector('[data-map-action="retry"]').hidden=false;}
   finally{if(!disposed&&request===sequence)controls(false);}
  }
  function click(e){const b=e.target.closest('[data-map-action],[data-map-focus]');if(!b||!el.contains(b))return;e.stopPropagation();if(b.dataset.mapFocus!==undefined){focus=Number(b.dataset.mapFocus);selected();load(16);return;}const action=b.dataset.mapAction;if(action==='fit'){focus=null;selected();load();}else load(action==='in'?Math.min(17,(view?.zoom||14)+1):action==='out'?Math.max(3,(view?.zoom||14)-1):view?.zoom);}
  function keydown(e){if(e.target.matches('.map-pin')&&['Enter',' '].includes(e.key)){e.preventDefault();click(e);}}
  el.addEventListener('click',click);el.addEventListener('keydown',keydown);
  active.add(()=>{disposed=true;controller?.abort();el.removeEventListener('click',click);el.removeEventListener('keydown',keydown);});load();
 }
}
