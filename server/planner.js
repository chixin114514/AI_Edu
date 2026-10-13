import { randomUUID } from 'node:crypto';
import { pois, byId } from './pois.js';
import { cleanStopReason, defaultStopReason } from '../public/stop-reasons.js';
import { leg, weather, explain, liveMode, cityRegion, cityPois, regionOptions } from './providers.js';
export class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
export const ensure=(condition,message,status=400)=>{if(!condition)throw new HttpError(status,message);};
export const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
export const clock=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
// 行程只排当天：越过零点的时刻不写进数据（否则会显示成 25:10），只在拒绝时拿来解释原因。
const DAY_END=24*60;
const nextDayClock=m=>m<2*DAY_END?`次日 ${clock(m-DAY_END)} `:` ${Math.floor(m/DAY_END)} 天后`;
// 读取一个自定义坐标点（起点、终点、必去节点、换乘端点共用）。
// 坐标一律按 GCJ-02 处理，与高德返回的地点保持同一坐标系。
export function readPoint(value,label){
  ensure(value!==undefined&&value!==null,label+'格式无效');
  ensure(typeof value==='object'&&!Array.isArray(value),label+'格式无效');
  const lat=Number(value.lat),lng=Number(value.lng);
  ensure(Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180,label+'坐标无效');
  const name=typeof value.name==='string'&&value.name.trim()?value.name.trim().slice(0,40):label;
  return {name,lat,lng};
}
const optionalPoint=(value,label)=>value===undefined||value===null?null:readPoint(value,label);
export function validatePlan(b){
  ensure(typeof b.city==='string'&&/^[\p{Script=Han}·]{2,30}$/u.test(b.city.trim()),'请输入中文城市名称，例如上海或成都市');
  ensure(b.province===undefined||(typeof b.province==='string'&&/^[\p{Script=Han}·]{2,30}$/u.test(b.province)),'请选择有效省份');
  ensure(b.district_adcode===undefined||b.district_adcode===''||(typeof b.district_adcode==='string'&&/^\d{6}$/.test(b.district_adcode)),'请选择有效区县');
  if(!liveMode())ensure(!b.district_adcode,'演示模式暂不支持区县筛选');
  if(!liveMode())ensure(['杭州','杭州市'].includes(b.city.trim()),'演示模式仅有杭州样本；其他城市需要开启实况服务');
  ensure(/^\d{4}-\d{2}-\d{2}$/.test(b.date||'')&&!Number.isNaN(Date.parse(b.date))&&new Date(b.date).toISOString().slice(0,10)===b.date,'请选择有效日期');
  ensure([1,2].includes(b.days),'仅支持一日或两日行程');
  ensure(Number.isFinite(b.budget)&&b.budget>=0&&b.budget<=10000,'预算须为0—10000元');
  ensure(Number.isFinite(b.walk_limit_km)&&b.walk_limit_km>=1&&b.walk_limit_km<=15,'步行上限须为1—15公里');
  ensure(Array.isArray(b.interests)&&b.interests.length<=6&&b.interests.every(x=>['自然','人文','建筑','展览','美食'].includes(x)),'兴趣选项无效');
  ensure(/^([01]\d|2[0-3]):[0-5]\d$/.test(b.start_time||'')&&/^([01]\d|2[0-3]):[0-5]\d$/.test(b.end_time||''),'时间格式无效');
  ensure(minutes(b.end_time)-minutes(b.start_time)>=180,'请至少预留3小时');
  ensure(['独自','情侣','亲子','长辈同行'].includes(b.companion),'同行选项无效');
  ensure(typeof b.model_consent==='boolean','请明确模型数据授权选择');
  ensure(b.start_poi===undefined||b.start_poi==='auto'||(!liveMode()&&!!byId(b.start_poi)),'请使用自动选择起点');
  // 自定义起点 / 终点（酒店、当前位置等）。两种模式都支持；演示模式下步行距离为估算值。
  const startPoint=optionalPoint(b.start_point,'起点');
  const endPoint=optionalPoint(b.end_point,'终点');
  // 必去节点：前端把已生成行程里的节点回传，保证一定排进路线。
  const rawMust=Array.isArray(b.must_visit)?b.must_visit:[];
  ensure(rawMust.length<=3,'最多锁定 3 个必去地点');
  const mustVisit=rawMust.map((item,index)=>{
    ensure(item&&typeof item==='object'&&!Array.isArray(item),'必去地点格式无效');
    const lat=Number(item.lat),lng=Number(item.lng);
    ensure(Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180,'必去地点坐标无效');
    const name=typeof item.name==='string'&&item.name.trim()?item.name.trim().slice(0,40):`必去地点${index+1}`;
    const category=['自然','人文','建筑','展览','美食'].includes(item.category)?item.category:'人文';
    const duration=Number(item.duration_min);
    return {id:`must-${index}`,name,lng,lat,coordinate_system:'GCJ-02',category,
      indoor:item.indoor===true,indoor_inferred:true,
      duration_min:Number.isFinite(duration)&&duration>=10&&duration<=180?duration:45,
      price:null,open:null,close:null,closed_days:[],opening_text:'',
      per_capita_cost:null,rating:null,commerce_source:null,commerce_fetched_at:null,
      reservation:'用户锁定的地点，开放时间与预约要求需自行核实',accessibility:'待核实',slope:'unknown',
      description:'你锁定的必去地点',
      source:'用户锁定',source_url:'',updated_at:new Date().toISOString(),verified:false,confidence:'user_locked',rank:0};
  });
  return {province:b.province||null,district_adcode:b.district_adcode||null,city:b.city.trim(),date:b.date,days:b.days,budget:b.budget,walk_limit_km:b.walk_limit_km,interests:b.interests,start_time:b.start_time,end_time:b.end_time,companion:b.companion,model_consent:b.model_consent,start_poi:liveMode()?'auto':(b.start_poi&&b.start_poi!=='auto'?b.start_poi:'broken-bridge'),start_point:startPoint,end_point:endPoint,must_visit:mustVisit};
}
export async function schedule(ids,preferences,date,startAt,origin,catalog){
  let time=startAt??minutes(preferences.start_time),cost=0,walk=0,prev=origin||null;
  const stops=[];const skipped=[];
  const day=new Date(date+'T12:00:00+08:00').getUTCDay();
  for(const id of ids){
    if(catalog&&stops.length>=6)break;
    const p=catalog?catalog.find(p=>p.id===id):byId(id);if(!p||p.closed_days.includes(day)){skipped.push({id,reason:'开放日限制'});continue;}
    let transit;
    try{transit=prev?await leg(prev,p):{distance_m:0,duration_min:0,source:'起点',mode:liveMode()?'live':'demo',polyline:[]};}
    catch(error){
      if(error.providerCode==='NO_WALKING_ROUTE'){skipped.push({id,reason:'未查到可用步行路线'});continue;}
      throw error;
    }
    const arrival=Math.max(time+transit.duration_min,p.open?minutes(p.open):time);
    const departure=arrival+p.duration_min;
    if(departure>Math.min(p.close?minutes(p.close):1440,minutes(preferences.end_time)-20)||cost+(p.price??0)>preferences.budget/preferences.days||walk+transit.distance_m>preferences.walk_limit_km*1000){skipped.push({id,reason:'超出已知营业、费用、时间或步行约束'});continue;}
    const recommendation=cleanStopReason(p.recommendation_reason,p.name);
    stops.push({...p,arrival:clock(arrival),departure:clock(departure),leg:transit,recommendation_reason:recommendation||defaultStopReason(p,preferences),recommendation_source:recommendation?(p.recommendation_source||'规划规则'):'规划规则'});
    cost+=p.price??0;walk+=transit.distance_m;time=departure+10;prev=p;
  }
  return {stops,skipped,distance_m:walk,cost,unknown_cost_count:stops.filter(p=>p.price===null).length,duration_min:stops.length?minutes(stops.at(-1).departure)-(startAt??minutes(preferences.start_time)):0};
}
export const approximateDistance=(a,b)=>Math.hypot((a.lng-b.lng)*111000*Math.cos((a.lat+b.lat)*Math.PI/360),(a.lat-b.lat)*111000);
export function orderCandidates(catalog,prefs,origin){
  const pool=[...catalog],ordered=[];
  if(!pool.length)return [];
  // Select a compact neighborhood before ordering. Straight distance ranks candidates only;
  // every accepted walking leg is subsequently measured by the map provider.
  let previous=origin;
  if(!previous){
    const score=p=>pool.filter(q=>q.category!=='美食'&&approximateDistance(p,q)<2500).length*2+(prefs.interests.includes(p.category)?3:0)-p.rank/100;
    const anchor=[...pool].filter(p=>p.category!=='美食').sort((a,b)=>score(b)-score(a))[0]||pool[0];
    ordered.push(anchor.id);pool.splice(pool.indexOf(anchor),1);previous=anchor;
  }
  while(pool.length&&ordered.length<10){
    pool.sort((a,b)=>(approximateDistance(previous,a)-(prefs.interests.includes(a.category)?250:0))-(approximateDistance(previous,b)-(prefs.interests.includes(b.category)?250:0)));
    const next=pool.shift();
    if(next.category==='美食'&&(!prefs.interests.includes('美食')||ordered.some(id=>catalog.find(p=>p.id===id)?.category==='美食')))continue;
    ordered.push(next.id);previous=next;
  }
  return ordered;
}
// 用餐窗口（P1）：行程跨过午间且路线里没有美食节点时，就近插入一家。
// 插入后重新排一次，若反而挤掉了节点就回退到原方案。
async function scheduleWithLunch(ordered,prefs,date,origin,catalog){
  const base=await schedule(ordered,prefs,date,undefined,origin,catalog);
  if(!base.stops.length||base.stops.some(s=>s.category==='美食'))return base;
  const arrives=minutes(base.stops[0].arrival),leaves=minutes(base.stops.at(-1).departure);
  if(!(arrives<=13*60+30&&leaves>=11*60+30))return base;
  const used=new Set(ordered);
  const noonAt=Math.max(0,base.stops.findIndex(s=>minutes(s.arrival)>=11*60+30));
  const anchor=base.stops[Math.max(0,noonAt-1)];
  const food=[...catalog].filter(p=>p.category==='美食'&&!used.has(p.id))
    .map(p=>({p,d:approximateDistance(anchor,p)})).sort((a,b)=>a.d-b.d)[0];
  if(!food)return base;
  const withMeal=[...ordered.slice(0,noonAt),food.p.id,...ordered.slice(noonAt)];
  const next=await schedule(withMeal,prefs,date,undefined,origin,catalog);
  return next.stops.length>=base.stops.length?next:base;
}

// 自定义终点（P1）：作为最后一站接在行程末尾，并计入步行总量。
async function appendDestination(main,destination){
  if(!destination||!main.stops.length)return main;
  const last=main.stops.at(-1);
  const transit=await leg(last,destination);
  const arrival=minutes(last.departure)+10+transit.duration_min;
  ensure(arrival<DAY_END,`终点「${destination.name}」离最后一站步行约 ${(transit.distance_m/1000).toFixed(1)} km，要到${nextDayClock(arrival)}才能走到，当天排不下。请换一个近一点的终点。`,422);
  const stop={id:'destination',name:destination.name,lng:destination.lng,lat:destination.lat,coordinate_system:'GCJ-02',
    category:'终点',indoor:false,indoor_inferred:false,duration_min:0,price:null,open:null,close:null,closed_days:[],opening_text:'',
    per_capita_cost:null,rating:null,commerce_source:null,commerce_fetched_at:null,
    reservation:'你指定的终点',accessibility:'待核实',slope:'unknown',description:'你指定的行程终点',
    source:'用户指定',source_url:'',updated_at:new Date().toISOString(),verified:false,confidence:'user_locked',rank:0,
    arrival:clock(arrival),departure:clock(arrival),leg:transit};
  return {...main,stops:[...main.stops,stop],distance_m:main.distance_m+transit.distance_m,
    duration_min:arrival-minutes(main.stops[0].arrival)};
}
// 用户手动调整当天顺序时的单站解析。
// 能在行程里找到 id 就原样复用；候选池里的地点也以池内事实为准，客户端不能借这个
// 接口伪造票价、评分或营业时间。只有全新的地点才按"用户自己新增"处理。
function resolveStop(ref,index,trip){
  ensure(ref&&typeof ref==='object'&&!Array.isArray(ref),'地点格式无效');
  if(typeof ref.id==='string'&&ref.id){
    // 已经在行程里的节点（含用户自己加的 custom-*）原样复用，**保住原来的 id**：
    // 每次编辑都换一批 id 会把日记的键（行程:天:站点）打断。
    const inTrip=(trip.days||[]).flatMap(day=>day.stops).find(stop=>stop.id===ref.id);
    if(inTrip)return inTrip;
    const known=(trip.poi_catalog||pois).find(p=>p.id===ref.id)||byId(ref.id);
    ensure(known,`行程里没有这个地点：${ref.id}`,400);
    return known;
  }
  const point=readPoint(ref,`第${index+1}个地点`);
  const category=['自然','人文','建筑','展览','美食'].includes(ref.category)?ref.category:'人文';
  const duration=Number(ref.duration_min);
  return {id:'custom-'+randomUUID().slice(0,8),name:point.name,lng:point.lng,lat:point.lat,coordinate_system:'GCJ-02',category,
    indoor:ref.indoor===true,indoor_inferred:true,
    duration_min:Number.isFinite(duration)&&duration>=10&&duration<=180?duration:(category==='美食'?60:45),
    price:null,open:null,close:null,closed_days:[],opening_text:'',
    per_capita_cost:null,rating:null,commerce_source:null,commerce_fetched_at:null,
    reservation:'你自己添加的地点，开放时间与预约要求需自行核实',accessibility:'待核实',slope:'unknown',
    description:'你添加到行程的地点',source:'用户添加',source_url:'',updated_at:new Date().toISOString(),
    verified:false,confidence:'user_added',rank:0};
}
// 手动重排一天。与自动规划的关键差别：**不静默丢站**。
// 自动规划会把超出约束的节点放进 skipped，但用户亲手排的顺序是他明确的选择，
// 悄悄删掉比排不进去更糟，所以这里全部保留，逐条给出警告让用户自己决定。
// 新加的地点放在哪一站最合适。只用直线距离估算，不额外请求地图服务；选定位置后仍按真实步行重算。
// 餐厅优先落在还没安排吃饭的饭点（午餐 11:00—13:30、晚餐 17:00—19:30），其次看绕路多少；
// 其它地点只看绕路。已知营业时间的，到店时没开门或吃不完就基本不选。
const MEALS=[{name:'午餐',from:11*60,to:13*60+30},{name:'晚餐',from:17*60,to:19*60+30}];
export function bestInsertIndex(scheduled,stop,prefs,origin){
  const walkMin=(a,b)=>a&&b?Math.ceil(approximateDistance(a,b)*1.3/70):0;
  const outside=(at,meal)=>at<meal.from?meal.from-at:at>meal.to?at-meal.to:0;
  const freeMeals=stop.category==='美食'?MEALS.filter(meal=>!scheduled.some(s=>s.category==='美食'&&outside(minutes(s.arrival),meal)<=30)):[];
  let best=null;
  for(let index=0;index<=scheduled.length;index++){
    const prev=index?scheduled[index-1]:origin||null,next=scheduled[index]||null;
    const arrival=(index?minutes(scheduled[index-1].departure)+10:minutes(prefs.start_time))+walkMin(prev,stop);
    const detour=walkMin(prev,stop)+walkMin(stop,next)-walkMin(prev,next);
    const meal=freeMeals.map(m=>({name:m.name,off:outside(arrival,m)})).sort((a,b)=>a.off-b.off)[0];
    const shut=(stop.open&&arrival<minutes(stop.open))||(stop.close&&arrival+stop.duration_min>minutes(stop.close));
    const score=(meal?meal.off:0)+detour*2+(shut?600:0);
    if(!best||score<best.score)best={index,score,meal:meal&&meal.off===0?meal.name:null};
  }
  return best;
}
// 按给定顺序走一遍：逐段算步行、到达与离开时间。
async function walkThrough(stops,prefs){
  let time=minutes(prefs.start_time),walk=0,cost=0,prev=prefs.start_point||null;
  const scheduled=[];
  for(const stop of stops){
    const legTo=prev?await leg(prev,stop):{distance_m:0,duration_min:0,source:'起点',mode:liveMode()?'live':'demo',polyline:[]};
    const arrival=Math.max(time+legTo.duration_min,stop.open?minutes(stop.open):time);
    const departure=arrival+stop.duration_min;
    const reason=cleanStopReason(stop.recommendation_reason,stop.name);
    // 越过零点后不再格式化成 HH:MM，交给调用方统一拒绝。
    scheduled.push({...stop,arrival:arrival<DAY_END?clock(arrival):null,departure:departure<DAY_END?clock(departure):null,leg:legTo,
      recommendation_reason:reason||defaultStopReason(stop,prefs),
      recommendation_source:reason?(stop.recommendation_source||'规划规则'):'规划规则'});
    walk+=legTo.distance_m;cost+=stop.price??0;time=departure+10;prev=stop;
  }
  return {scheduled,walk,cost,endAt:time-10};
}
export async function rebuildDay(trip,dayIndex,refs,{autoPlace}={}){
  const prefs=trip.preferences,day=trip.days[dayIndex];
  // 终点由 preferences.end_point 决定，不交给客户端增删，以免被误删或挪到中间。
  const wanted=(Array.isArray(refs)?refs:[]).filter(ref=>ref&&ref.id!=='destination');
  ensure(wanted.length>=2&&wanted.length<=8,'每天需要保留2—8个地点');
  const stops=[],seen=new Set();
  for(const [index,ref] of wanted.entries()){
    const stop=resolveStop(ref,index,trip);
    ensure(!seen.has(stop.id),`同一个地点不能重复出现：${stop.name}`);
    seen.add(stop.id);stops.push(stop);
  }
  const warnings=[],origin=prefs.start_point||undefined,startAt=minutes(prefs.start_time);
  // 新加的那一站可以交给服务端挑位置：先按其余各站的时间线选好插入点，再整体重算。
  let placed=null;
  if(autoPlace!=null){
    ensure(Number.isInteger(autoPlace)&&autoPlace>=0&&autoPlace<stops.length,'要自动安排的地点无效');
    const [added]=stops.splice(autoPlace,1);
    const base=await walkThrough(stops,prefs);
    // 其余各站本身就排到了次日时没有时间线可参考，放回末尾，由下面统一拒绝。
    const spot=base.endAt<DAY_END?bestInsertIndex(base.scheduled,added,prefs,origin):{index:stops.length,meal:null};
    stops.splice(spot.index,0,added);
    placed={id:added.id,name:added.name,index:spot.index,meal:spot.meal};
  }
  const {scheduled,walk,cost,endAt}=await walkThrough(stops,prefs);
  // 手动编辑不丢站，但一天装不下的排法也不能存：否则到达时间会变成 25:10 这样的时刻。
  ensure(endAt<DAY_END,`这样排要到${nextDayClock(endAt)}才结束，一天排不下。请先移出几站，或换个近一点的地点。`);
  const weekday=new Date(day.date+'T12:00:00+08:00').getUTCDay();
  for(const stop of scheduled)if((stop.closed_days||[]).includes(weekday))warnings.push(`「${stop.name}」在你选的日期通常闭馆，请出发前核实。`);
  if(minutes(scheduled.at(-1).departure)>minutes(prefs.end_time)-20)warnings.push(`按这个顺序会在 ${scheduled.at(-1).departure} 结束，晚于你设定的 ${prefs.end_time}，请删减节点或延长结束时间。`);
  if(walk>prefs.walk_limit_km*1000+0.001)warnings.push(`调整后总步行约 ${(walk/1000).toFixed(1)} km，超过每日上限 ${prefs.walk_limit_km} km。`);
  if(cost>prefs.budget/prefs.days)warnings.push(`已知费用 ¥${cost} 超出按天分摊的预算 ¥${Math.round(prefs.budget/prefs.days)}。`);
  let result={stops:scheduled,skipped:[],distance_m:walk,cost,unknown_cost_count:scheduled.filter(stop=>stop.price===null).length,
    duration_min:minutes(scheduled.at(-1).departure)-startAt};
  if(dayIndex===trip.days.length-1&&prefs.end_point)result=await appendDestination(result,prefs.end_point);
  // 雨天候选照旧重新挑一轮室内节点，保持"雨天也有好去处"可用。
  const indoor=(trip.poi_catalog||pois).filter(poi=>poi.indoor&&!scheduled.some(stop=>stop.id===poi.id));
  const rain=await schedule(orderCandidates(indoor,prefs,result.stops[0]).slice(0,4),prefs,day.date,undefined,origin,trip.poi_catalog);
  return {day:{day:day.day,date:day.date,...result,plan_b:rain},warnings,placed};
}
async function dynamicPlan(prefs){
  let region;try{region=await cityRegion(prefs.city);}catch(e){if(e.providerCode==='CITY_NOT_FOUND')throw new HttpError(422,'未找到唯一城市，请填写完整城市名，例如苏州市；暂不支持直接填写省份或区县');throw e;}
  prefs.city=region.name;
  if(prefs.province||prefs.district_adcode){
    const {provinces}=await regionOptions();
    const province=provinces.find(p=>(!prefs.province||p.name===prefs.province)&&p.cities.some(c=>c.adcode===region.adcode));
    ensure(province,'所选省份与城市不匹配，请重新选择',422);prefs.province=province.name;
    if(prefs.district_adcode){
      const district=province.cities.find(c=>c.adcode===region.adcode).districts.find(d=>d.adcode===prefs.district_adcode);
      ensure(district,'所选区县不属于当前城市，请重新选择',422);
      prefs.district=district.name;region.district_adcode=district.adcode;
    }
  }
  const catalog=await cityPois(region,prefs.interests);
  // 用户锁定的必去地点并入候选池，保证能参与编排
  const pool=[...(prefs.must_visit||[]),...catalog];
  ensure(pool.filter(p=>p.category!=='美食').length>=2,prefs.district?'该区县暂未检索到足够的有效景点，可选择全市范围或其他区县':'该城市暂未检索到足够的有效景点，请换一个城市或稍后重试',422);
  const origin=prefs.start_point||undefined;
  const destination=prefs.end_point||undefined;
  const days=[],visited=new Set(),warnings=[];
  for(let i=0;i<prefs.days;i++){
    const date=new Date(Date.parse(prefs.date+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);
    const candidates=pool.filter(p=>!visited.has(p.id));
    // 必去节点排在最前，避免被就近排序或约束挤掉；其余仍按就近顺序编排
    const locked=candidates.filter(p=>p.confidence==='user_locked');
    const rest=candidates.filter(p=>p.confidence!=='user_locked');
    const ordered=[...locked.map(p=>p.id),...orderCandidates(rest,prefs,origin||locked.at(-1)||undefined)];
    // 传当天未访问的候选，避免用餐插入选中前一日已用过的地点
    const scheduled=await scheduleWithLunch(ordered,prefs,date,origin,candidates);
    // 终点只接在最后一天
    const main=(i===prefs.days-1)?await appendDestination(scheduled,destination):scheduled;
    ensure(main.stops.length>=2,`第${i+1}天未找到至少两个满足步行和时间约束的地点，请减少天数或放宽约束`,422);
    main.stops.forEach(p=>{if(p.id!=='destination')visited.add(p.id);});
    for(const item of main.skipped.filter(s=>String(s.id).startsWith('must-'))){
      const poi=(prefs.must_visit||[]).find(p=>p.id===item.id);
      warnings.push(`必去地点「${poi?poi.name:item.id}」在当前时间、步行或预算约束下排不进去，未编入路线。`);
    }
    const walkedKm=main.distance_m/1000;
    if(walkedKm>prefs.walk_limit_km+0.001)warnings.push(`含起终点接驳后总步行约 ${walkedKm.toFixed(1)} km，超过你设定的 ${prefs.walk_limit_km} km 上限，请留意体力。`);
    const indoor=pool.filter(p=>p.indoor&&approximateDistance(main.stops[0],p)<5000);
    const rain=await schedule(orderCandidates(indoor,prefs,main.stops[0]).slice(0,4),prefs,date,undefined,origin,pool);
    days.push({day:i+1,date,...main,plan_b:rain});
  }
  const w=await weather(region),generated=new Date().toISOString();
  const note=await annotateStops(days,prefs,pool,'地点来自高德，营业、票价与预约未核实；停留时长为规划估计；天气为实况而非出行日预报');
  return {id:randomUUID(),version:1,title:region.name+' · 自动漫游路线',preferences:prefs,days,weather:w,created_at:generated,data_mode:'live',poi_catalog:pool,
    route_pack:{id:randomUUID(),city:region.name,district:prefs.district||null,adcode:prefs.district_adcode||region.adcode,city_adcode:region.adcode,generated_at:generated,poi_count:pool.length,source:'高德POI自动检索'},
    explanation:note||'按城市检索真实地点，优先串联相近且符合兴趣的节点，用高德步行距离和耗时筛选，并为停留预留缓冲。当前为待核实路线草案。',explanation_source:note?'DeepSeek':'自动规划规则',
    warnings:['营业时间、票价和预约要求尚未核实；未知费用不视为免费，暂不能保证总预算。','停留时长为规划估计，室内属性按地点类别推断；雨天候选需核实后使用。',`仅规划步行；${origin?'你指定的起点之前':'抵达第一站'}与${destination?'你指定的终点之后':'最后一站后'}的交通不计入。`,...warnings]};
}
export async function createPlan(input){
  const prefs=validatePlan(input);
  if(liveMode())return dynamicPlan(prefs);
  const routes=[['broken-bridge','bai-causeway','pinghu','zhejiang-museum','gushan','xiling','rest-gushan','quyuan'],['liulang','qianwang','nanshan','art-museum','silk-museum','leifeng']];
  if(prefs.interests.includes('建筑'))routes[0]=['hubin','nanshan','qianwang','liulang','art-museum'];
  if(prefs.interests.includes('美食'))routes[0]=['hubin','lunch-hubin','hefang','hutang','wushan'];
  if(prefs.interests.includes('展览'))routes[0]=['broken-bridge','zhejiang-museum','rest-gushan','gushan','pinghu','xiling'];
  if(prefs.interests.includes('美食'))routes[1]=['wushan','city-museum','hefang','hutang','liulang'];
  if(prefs.companion==='长辈同行'||prefs.companion==='亲子') routes[0]=['broken-bridge','bai-causeway','zhejiang-museum','rest-gushan','pinghu'];
  routes[0]=[prefs.start_poi,...routes[0].filter(id=>id!==prefs.start_poi)];
  // 演示模式同样支持自定义起终点与必去节点：必去节点并入候选池，终点接在最后一天
  const pool=[...(prefs.must_visit||[]),...pois];
  const origin=prefs.start_point||undefined;
  const destination=prefs.end_point||undefined;
  const mustIds=(prefs.must_visit||[]).map(p=>p.id);
  const days=[],warnings=[];
  for(let i=0;i<prefs.days;i++){
    const date=new Date(Date.parse(prefs.date+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);
    const main=await schedule([...new Set([...mustIds,...routes[i]])],prefs,date,undefined,origin,pool);
    ensure(main.stops.length>0,'当前约束下没有可执行节点，请调整日期、时间或起点',422);
    for(const item of main.skipped.filter(s=>String(s.id).startsWith('must-'))){
      const poi=(prefs.must_visit||[]).find(p=>p.id===item.id);
      warnings.push(`必去地点「${poi?poi.name:item.id}」在当前时间、步行或预算约束下排不进去，未编入路线。`);
    }
    const withEnd=(i===prefs.days-1)?await appendDestination(main,destination):main;
    const rain=await schedule(i===0?['zhejiang-museum','rest-gushan']:['art-museum','silk-museum'],prefs,date,undefined,origin,pool);
    days.push({day:i+1,date,...withEnd,plan_b:rain});
  }
  const w=await weather();
  const note=await annotateStops(days,prefs,[],'全部为演示数据');
  return {id:randomUUID(),version:1,title:'湖山之间，慢一点也很好',preferences:prefs,days,weather:w,created_at:new Date().toISOString(),data_mode:liveMode()?'mixed':'demo',explanation:note||'沿湖串联自然与人文节点，为每段停留留出缓冲；营业、预算和步行上限参与筛选。演示营业与预约信息需在出发前核实。',explanation_source:note?'DeepSeek':'规则模板',warnings:['POI营业、预约和无障碍信息尚未人工核验，不能作为正式出行保证。','仅支持步行；费用为样本门票与样本餐饮费用，不含住宿、往返交通。',`${origin?'你指定的起点之前':'起点前'}与${destination?'你指定的终点之后':'最后一站后'}的交通不计入路线。`,...warnings]};
}
async function annotateStops(days,prefs,catalog,limitations){
  const result=await explain({city:prefs.city,interests:prefs.interests,days:days.map(d=>({date:d.date,stops:d.stops.map(({id,name,category,description})=>({id,name,category,description}))})),limitations},prefs.model_consent,{withStops:true});
  if(!result)return null;
  const reasons=new Map(result.recommendations.map(p=>[p.id,p.reason]));
  for(const stop of [...days.flatMap(d=>[...d.stops,...d.plan_b.stops]),...catalog]){
    if(reasons.has(stop.id)){stop.recommendation_reason=reasons.get(stop.id);stop.recommendation_source='DeepSeek';}
  }
  return result.explanation;
}
// 从当前站继续编排，优先加入未安排的适合地点，再按地图耗时检查可行性。
// 候选只取本行程的城市快照；演示行程才使用本地样本。
export async function buildReroute(trip,session,outcome){
  const day=trip.days[session.day-1],prefix=day.stops.slice(0,session.current_index+1),anchor=prefix.at(-1);
  if(!anchor||session.current_index>=day.stops.length)return {candidate:null,reason:'今天的节点已全部完成，可以结束漫游。'};
  const remaining=day.stops.slice(session.current_index+1).filter(p=>p.id!=='destination');
  const destination=day.stops.slice(session.current_index+1).find(p=>p.id==='destination');
  const catalog=[...new Map([...(trip.poi_catalog??(trip.data_mode==='live'?[]:pois)),...day.stops].map(p=>[p.id,p])).values()];
  const rain=outcome.action==='rain',food=outcome.action==='break',rest=outcome.action==='shorten'&&outcome.status!=='behind_schedule';
  const suitable=p=>p.id!=='destination'&&(rain?p.indoor===true:food?p.category==='美食':rest?(p.category==='休息'||p.category==='美食'||p.indoor===true)&&p.slope!=='high':false);
  const allPlanned=trip.days.flatMap(d=>d.stops);
  const samePlace=(a,b)=>a.id===b.id||(a.name===b.name&&approximateDistance(a,b)<100);
  const radius=rest?1500:food?2000:2500;
  const priority=p=>rest?(p.category==='休息'?0:p.category==='美食'?1:2):0;
  const nearby=catalog.filter(p=>suitable(p)&&approximateDistance(anchor,p)<=radius&&!allPlanned.some(s=>samePlace(s,p)))
    .sort((a,b)=>priority(a)-priority(b)||approximateDistance(anchor,a)-approximateDistance(anchor,b)).slice(0,4);
  const usedWalk=prefix.reduce((sum,p)=>sum+p.leg.distance_m,0),usedCost=prefix.reduce((sum,p)=>sum+(p.price??0),0);
  const prefs={...trip.preferences,days:1,budget:Math.max(0,trip.preferences.budget/trip.preferences.days-usedCost),walk_limit_km:Math.max(0,trip.preferences.walk_limit_km-usedWalk/1000)};
  const startAt=minutes(anchor.departure)+10;
  const assemble=async(wanted,replacement)=>{
    const local=new Map(catalog.map(p=>[p.id,p]));
    if(replacement)local.set(replacement.id,rest?{...replacement,duration_min:Math.min(30,replacement.duration_min)}:replacement);
    let suffix=await schedule([...new Set(wanted)],prefs,day.date,startAt,anchor,[...local.values()]);
    if(replacement&&(!suffix.stops.some(p=>p.id===replacement.id)||suffix.stops[0]?.id!==replacement.id||suffix.stops[0].leg.distance_m>radius))return null;
    if(destination){
      try{suffix=await appendDestination(suffix.stops.length?suffix:{...suffix,stops:[anchor]},destination);}
      catch(error){if(error instanceof HttpError)return null;throw error;}
    }
    // appendDestination 需要起点，空后缀时仅用当前站计算回程，随后移除重复站。
    const tail=suffix.stops.filter(p=>p.id!==anchor.id),stops=[...prefix,...tail];
    const distance=stops.reduce((sum,p)=>sum+p.leg.distance_m,0),cost=stops.reduce((sum,p)=>sum+(p.price??0),0);
    if(distance>trip.preferences.walk_limit_km*1000||cost>trip.preferences.budget/trip.preferences.days||minutes(stops.at(-1).departure)>minutes(trip.preferences.end_time))return null;
    if(rest&&distance>day.distance_m)return null;
    if(stops.map(p=>p.id).join()===day.stops.map(p=>p.id).join())return null;
    return {...day,stops,skipped:suffix.skipped,distance_m:distance,cost,unknown_cost_count:stops.filter(p=>p.price===null).length,duration_min:minutes(stops.at(-1).departure)-minutes(stops[0].arrival)};
  };
  const keep=rain?remaining.filter(p=>p.indoor===true):outcome.action==='shorten'?remaining.slice(0,-1):remaining;
  for(const replacement of nearby){
    const candidate=await assemble([replacement.id,...keep.map(p=>p.id)],replacement);
    if(candidate)return {candidate,reason:outcome.reason+(rest?' 新增就近短暂停留地点，是否有座位及开放情况请到店核实。':'')};
    // 疲劳时优先保留就近休整，避免继续串联原景点使步行反而增加。
    if(rest&&keep.length){const shorter=await assemble([replacement.id],replacement);if(shorter)return {candidate:shorter,reason:outcome.reason+' 新增就近短暂停留地点，是否有座位及开放情况请到店核实。'};}
  }
  const existing=remaining.filter(p=>suitable(p)&&approximateDistance(anchor,p)<=radius).sort((a,b)=>approximateDistance(anchor,a)-approximateDistance(anchor,b))[0];
  const fallback=existing?[existing.id,...keep.filter(p=>p.id!==existing.id).map(p=>p.id)]:keep.map(p=>p.id);
  if(food&&!existing)return {candidate:null,reason:'附近未找到满足时间和步行约束的餐饮替代地点，原路线保持不变。'};
  if(rain&&!fallback.length)return {candidate:null,reason:'附近未找到满足约束的室内替代地点，原路线保持不变。建议先就近避雨。'};
  let candidate=await assemble(fallback);
  const hasExisting=existing&&candidate?.stops.some(p=>p.id===existing.id);
  if((food&&!hasExisting)||(rain&&!candidate?.stops.slice(prefix.length).some(p=>p.indoor===true)))candidate=null;
  const note=hasExisting?'未找到可新增的合适地点，优先安排原路线已有的'+(food?'餐厅':rain?'室内地点':'休整地点')+'。':rest?'未找到可新增的就近休整地点，本次仅缩短后续路线。':'';
  return {candidate,reason:candidate?outcome.reason+(note?' '+note:''):'当前时间、步行和预算约束下没有可行的替代路线，原路线保持不变。'};
}
export function evaluate(features={},trigger){
  if(trigger==='unwell')return {status:'paused',action:'seek_help',reason:'您主动报告不适。请停止游览、到安全位置休息，并向身边的人或当地紧急服务寻求帮助。'};
  if(trigger==='rain')return {status:'weather_change',action:'rain',reason:'为避雨，建议切换到室内候选节点，减少户外停留。'};
  if(trigger==='hungry')return {status:'rest',action:'break',reason:'您希望用餐，建议先安排一段休息与用餐时间。'};
  if(trigger==='tired')return {status:'mild_fatigue',action:'shorten',reason:'您选择了“轻松一点”，建议减少后续节点并延长休息。'};
  if((features.hr_vs_baseline_pct??0)>=25&&(features.duration_s??0)>=180&&(features.cadence_change_pct??0)<=-15)return {status:'rest',action:'shorten',reason:'心率相对基线上升且步频持续下降，建议缩短后续路线并休息。这只是节奏提示，不是医学判断。'};
  if((features.delay_min??0)>=30)return {status:'behind_schedule',action:'shorten',reason:'当前进度落后计划至少30分钟，建议减少一个低优先级节点。'};
  return {status:'normal',action:'continue',reason:'暂未达到持续变化条件，保留当前行程。'};
}
