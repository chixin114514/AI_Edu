import { randomUUID } from 'node:crypto';
import { pois, byId } from './pois.js';
import { cleanStopReason, defaultStopReason } from '../public/stop-reasons.js';
import { leg, weather, explain, liveMode, cityRegion, cityPois, regionOptions } from './providers.js';
export class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
export const ensure=(condition,message,status=400)=>{if(!condition)throw new HttpError(status,message);};
export const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
export const clock=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
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
    const transit=prev?await leg(prev,p):{distance_m:0,duration_min:0,source:'起点',mode:liveMode()?'live':'demo',polyline:[]};
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
  const stop={id:'destination',name:destination.name,lng:destination.lng,lat:destination.lat,coordinate_system:'GCJ-02',
    category:'终点',indoor:false,indoor_inferred:false,duration_min:0,price:null,open:null,close:null,closed_days:[],opening_text:'',
    per_capita_cost:null,rating:null,commerce_source:null,commerce_fetched_at:null,
    reservation:'你指定的终点',accessibility:'待核实',slope:'unknown',description:'你指定的行程终点',
    source:'用户指定',source_url:'',updated_at:new Date().toISOString(),verified:false,confidence:'user_locked',rank:0,
    arrival:clock(arrival),departure:clock(arrival),leg:transit};
  return {...main,stops:[...main.stops,stop],distance_m:main.distance_m+transit.distance_m,
    duration_min:arrival-minutes(main.stops[0].arrival)};
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
export function evaluate(features={},trigger){
  if(trigger==='unwell')return {status:'paused',action:'seek_help',reason:'您主动报告不适。请停止游览、到安全位置休息，并向身边的人或当地紧急服务寻求帮助。'};
  if(trigger==='rain')return {status:'weather_change',action:'rain',reason:'天气变化演示：切换到室内候选节点，减少户外停留。'};
  if(trigger==='hungry')return {status:'rest',action:'break',reason:'您希望用餐，建议先安排一段休息与用餐时间。'};
  if(trigger==='tired')return {status:'mild_fatigue',action:'shorten',reason:'您选择了“轻松一点”，建议减少后续节点并延长休息。'};
  if((features.hr_vs_baseline_pct??0)>=25&&(features.duration_s??0)>=180&&(features.cadence_change_pct??0)<=-15)return {status:'rest',action:'shorten',reason:'心率相对基线上升且步频持续下降，建议缩短后续路线并休息。这只是节奏提示，不是医学判断。'};
  if((features.delay_min??0)>=30)return {status:'behind_schedule',action:'shorten',reason:'当前进度落后计划至少30分钟，建议减少一个低优先级节点。'};
  return {status:'normal',action:'continue',reason:'暂未达到持续变化条件，保留当前行程。'};
}
