import http from 'node:http';
import https from 'node:https';
import { loadTls } from './tls.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createAuth } from './auth.js';
import { createWatchRelay } from './watch-relay.js';
import { routeMap } from './maps.js';
import { pois, byId } from './pois.js';
import { createPlan, evaluate, ensure, HttpError, clock, minutes, schedule, approximateDistance, readPoint } from './planner.js';
import { decision, liveMode, providerFlags, providerStatus, resolveLocation, cityOptions, cityRegion, regionOptions, qweatherMinutely, qweatherAlerts, transitRoutes, searchPlaces, openTopoElevations } from './providers.js';
import { gcj02ToWgs84, routePoints, buildElevationProfile } from './elevation.js';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.png':'image/png'};
async function body(req){
  ensure((req.headers['content-type']||'').startsWith('application/json'),'仅接受JSON请求',415);
  let s='';for await(const c of req){s+=c;ensure(Buffer.byteLength(s)<=32768,'请求过大',413);}
  try{const b=JSON.parse(s);ensure(b&&typeof b==='object'&&!Array.isArray(b),'请求须为对象');return b;}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'JSON格式错误');}
}
export function createApp({database=process.env.DATABASE_PATH||'./data/manxing.sqlite',tls}={}){
  const store=createStore(database), auth=createAuth(store),watch=createWatchRelay(),limits=new Map();
  const locks=new Set();
  const handler=async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    res.setHeader('Permissions-Policy','geolocation=(self), bluetooth=(self), accelerometer=(self)');
    const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    let lockKey, acquired=false;
    try{
      const path=new URL(req.url,'http://local').pathname;
      if(!path.startsWith('/api/')){
        ensure(req.method==='GET'||req.method==='HEAD','方法不支持',405);
        const file=resolve(root,'.'+(path==='/'?'/index.html':decodeURIComponent(path)));
        ensure(file.startsWith(root)&&!!mime[extname(file)],'页面不存在',404);
        try{const content=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)],'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);}catch{throw new HttpError(404,'页面不存在');}return;
      }
      if(path.startsWith('/api/watch/')){
        const host=new URL('http://'+req.headers.host).hostname;
        const loopback=['localhost','127.0.0.1','[::1]'].includes(host)&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        ensure(req.socket.encrypted||loopback,'Apple Watch连接需要HTTPS',400);
      }
      if(['/api/watch/pair','/api/watch/sample','/api/watch/disconnect'].includes(path)){
        ensure(req.method==='POST','方法不支持',405);
        ensure(!req.headers.origin||new URL(req.headers.origin).host===req.headers.host,'跨站请求已拒绝',403);
        const input=await body(req),token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if(path.endsWith('/pair'))return send(watch.pair(input.code,req.socket.remoteAddress));
        if(path.endsWith('/sample'))return send(watch.sample(token,input));
        return send(watch.disconnect(token));
      }
      const cookies=req.headers.cookie||'';
      const secure=Boolean(req.socket.encrypted||process.env.COOKIE_SECURE==='true'),outCookies=[];
      const setCookie=value=>{outCookies.push(value);res.setHeader('Set-Cookie',outCookies.length===1?value:outCookies);};
      const guestCookie=value=>`mx_owner=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure?'; Secure':''}`;
      let guest=cookies.match(/(?:^|;\s*)mx_owner=([a-f0-9]{48})(?:;|$)/)?.[1];
      if(!guest){guest=randomBytes(24).toString('hex');setCookie(guestCookie(guest));}
      if(req.method!=='GET'){
        const origin=req.headers.origin;
        ensure(!origin||(new URL(origin).host===req.headers.host&&(!req.socket.encrypted||new URL(origin).protocol==='https:')),'跨站请求已拒绝',403);
        const now=Date.now(),ip=req.socket.remoteAddress;let l=limits.get(ip);if(!l||now-l.at>60000)l={at:now,count:0};
        ensure(++l.count<=120,'请求过于频繁，请稍后重试',429);limits.set(ip,l);
        if(limits.size>10000)limits.clear();
      }
      const b=req.method==='POST'?await body(req):{};
      const user=auth.current(cookies),owner=user?'user:'+user.id:guest;
      if(path==='/api/auth/me'&&req.method==='GET')return send({user});
      if(['/api/auth/register','/api/auth/login'].includes(path)&&req.method==='POST'){
        const result=await auth.authenticate(b,{register:path.endsWith('/register'),ip:req.socket.remoteAddress,cookies,guest,secure});
        watch.revokeOwner(guest);watch.revokeOwner('user:'+result.user.id);if(user)watch.revokeOwner(owner);
        setCookie(result.cookie);return send({user:result.user},path.endsWith('/register')?201:200);
      }
      if(path==='/api/auth/logout'&&req.method==='POST'){
        watch.revokeOwner(owner);setCookie(auth.logout(cookies,secure));setCookie(guestCookie(randomBytes(24).toString('hex')));return send({user:null});
      }
      if(path==='/api/ops'||path.startsWith('/api/ops/')){ensure(user,'请先登录管理员账号',401);ensure(user.role==='admin','仅管理员可访问运营工作台',403);}
      const get=(kind,id)=>{ensure(typeof id==='string','缺少标识');const v=store.get(kind,id,owner);ensure(v,'记录不存在',404);return v;};
      const session=()=>{const s=get('session',b.session_id);ensure(!s.ended_at,'行程已结束',409);return s;};
      const put=(kind,v)=>store.put(kind,v,owner);
      if(req.method==='POST') {lockKey=owner;ensure(!locks.has(lockKey),'上一操作仍在处理中，请稍后重试',409);locks.add(lockKey);acquired=true;}
      if(path==='/api/watch/link'&&req.method==='POST'){
        const s=session();ensure(s.status!=='paused','行程已暂停，不能开始心率采集',409);
        ensure(b.relay_consent===true,'请同意心率经服务端临时转发');
        return send(watch.create(owner,s.id),201);
      }
      if(path==='/api/watch/state'&&req.method==='GET'){
        const sid=new URL(req.url,'http://local').searchParams.get('session_id'),s=get('session',sid);
        if(s.ended_at||s.status==='paused')watch.revoke(owner,s.id);
        return send(watch.state(owner,s.id));
      }
      if(path==='/api/watch/unlink'&&req.method==='POST'){
        const s=get('session',b.session_id);watch.revoke(owner,s.id);return send({disconnected:true});
      }
      if(path==='/api/config'&&req.method==='GET')return send({data_mode:liveMode()?'live':'demo',dynamic_planning:liveMode(),city:'杭州',providers:providerFlags(),provider_status:providerStatus(),health_notice:'仅辅助调整旅行节奏，不作医学判断。',privacy:'蓝牙心率在浏览器处理；Apple Watch经单独授权后临时转发，服务端内存仅保留最新一条，20秒后清除，不落库、不写日志、不交给模型。服务端保存行程事件，不保存健康特征。'});
      if(path==='/api/pois'&&req.method==='GET')return send({pois});
      if(path==='/api/weather'&&req.method==='GET'){
        // 未配置和风时明确说不可用，不回退到编造的天气
        if(!providerFlags().weather)return send({available:false,reason:'未配置天气服务',minutely:null,alerts:null});
        // 取行程首站所在位置；城市级精度即可，不发送用户的精确位置
        let anchor=null;
        try{
          const requested=new URL(req.url,'http://local').searchParams.get('trip_id');
          const trip=requested?get('trip',requested):store.list('trip',owner).at(-1);
          const stop=trip?.days?.[0]?.stops?.[0];
          if(stop&&Number.isFinite(stop.lat)&&Number.isFinite(stop.lng))anchor={lat:stop.lat,lng:stop.lng,city:trip.preferences?.city||''};
        }catch{}
        const point=anchor||{lat:30.2590,lng:120.1503,city:'杭州市'};
        const [minutely,alerts]=await Promise.all([
          qweatherMinutely(point.lat,point.lng).catch(()=>null),
          qweatherAlerts(point.lat,point.lng).catch(()=>null)
        ]);
        return send({available:Boolean(minutely||alerts),area:point.city||'行程所在地',anchor:{lat:point.lat,lng:point.lng},minutely,alerts,note:'城市级天气，取行程首站位置；降水为未来2小时5分钟粒度，预警来自国家预警信息发布中心'});
      }
      if(path==='/api/elevation'&&req.method==='POST'){
        let points,dayNote='';
        if(b.trip_id!==undefined){
          const trip=get('trip',b.trip_id),day=Number(b.day??1);
          ensure(Number.isInteger(day)&&day>=1&&day<=trip.days.length,'旅行日无效');
          const stops=trip.days[day-1].stops;
          ensure(stops.length>=2,'当天行程不足两个节点，无法计算坡段');
          points=routePoints(stops);
          dayNote='第 '+day+' 天：'+stops.map(stop=>stop.name).join(' → ');
        }else{
          ensure(Array.isArray(b.points)&&b.points.length>=1&&b.points.length<=48,'请提供1—48个坐标点');
          points=b.points.map((point,index)=>readPoint(point,'第'+(index+1)+'个点'));
        }
        // Open Topo Data 用的是 WGS-84 高程网格，先把项目内的 GCJ-02 反解过去；
        // 几百米平移在陡坡上足以改变取样结果，不能直接拿 GCJ-02 去查。
        let raw;try{raw=await openTopoElevations(points.map(point=>gcj02ToWgs84(point.lat,point.lng)));}catch{throw new HttpError(503,'高程服务暂时不可用，请稍后重试');}
        const profile=buildElevationProfile(points,raw.elevations);
        return send({...profile,context:dayNote,dataset:raw.dataset,source:raw.source,source_url:raw.source_url,attributions:raw.attributions,updated_at:raw.updated_at,
          coordinate_note:'输入按 GCJ-02 解释，查询高程前已转换为 WGS-84。',
          accuracy_note:'SRTM 90 米网格高程估算，不是实测坡度；台阶、隧道、桥面和微小起伏不会体现，仅作节奏参考。'});
      }
      if(path==='/api/cities'&&req.method==='GET'){
        let result;try{result=await cityOptions();}catch{throw new HttpError(503,'完整城市列表暂不可用，请选择常用城市或使用自动定位');}
        return send(result);
      }
      if(path==='/api/regions'&&req.method==='GET'){
        let result;try{result=await regionOptions();}catch{throw new HttpError(503,'省市区列表暂不可用，请稍后重试');}
        return send(result);
      }
      if(path==='/api/location/resolve'&&req.method==='POST'){
        ensure(b.coordinate_system==='WGS84','定位坐标须为浏览器提供的WGS84');
        for(const [key,min,max] of [['lat',-90,90],['lng',-180,180],['accuracy',0,20000000]])ensure(typeof b[key]==='number'&&Number.isFinite(b[key])&&b[key]>=min&&b[key]<=max,'定位数据无效');
        let location;try{location=await resolveLocation(b);}catch{throw new HttpError(503,'暂时无法识别地址，请稍后重试或手动选择目的地。');}
        const supported=location.adcode.startsWith('3301');
        const candidates=['broken-bridge','liulang','hubin'].map(byId).map(p=>({id:p.id,name:p.name,distance_m:Math.round(Math.hypot((p.lng-location.position.lng)*96000,(p.lat-location.position.lat)*111000))})).sort((a,b)=>a.distance_m-b.distance_m);
        const nearest=supported&&b.accuracy<=500&&candidates[0].distance_m<=10000?candidates[0]:null;
        // Transient lookup only: neither the input nor address is written to the store or sent to models.
        return send({...location,supported_city:liveMode()?Boolean(location.adcode):supported,dynamic_planning:liveMode(),suggested_start:liveMode()?null:nearest,coverage:liveMode()?'高德支持的国内城市':'杭州西湖周边',distance_label:'直线距离，非步行距离'});
      }
      if(path==='/api/places'&&req.method==='POST'){
        ensure(liveMode(),'地点检索需要开启实况服务（配置高德 Key）',503);
        const keyword=typeof b.keyword==='string'?b.keyword.trim():'';
        ensure(keyword.length>=2&&keyword.length<=40,'请输入2—40个字的地点名称');
        let region;
        if(b.trip_id!==undefined){
          const trip=get('trip',b.trip_id);
          region={name:trip.preferences.city,adcode:trip.route_pack?.city_adcode||trip.route_pack?.adcode||'',district_adcode:trip.preferences.district_adcode||''};
        }else{
          ensure(typeof b.city==='string'&&b.city.trim(),'请提供城市或行程');
          let city;try{city=await cityRegion(b.city.trim());}catch{throw new HttpError(503,'暂时无法确认城市，请稍后重试');}
          region={name:city.name,adcode:city.adcode,district_adcode:''};
        }
        ensure(/^\d{6}$/.test(region.adcode||''),'缺少城市编码，暂时无法检索地点',503);
        let result;try{result=await searchPlaces(keyword,region);}catch{throw new HttpError(503,'地点检索暂时不可用，请稍后重试或手动选择行程中的节点');}
        return send(result);
      }
      if(path==='/api/transit'&&req.method==='POST'){
        ensure(liveMode(),'公交换乘需要开启实况服务（配置高德 Key）',503);
        const from=readPoint(b.from,'出发地'),to=readPoint(b.to,'目的地');
        ensure(from.lat!==to.lat||from.lng!==to.lng,'出发地与目的地不能相同');
        let city=typeof b.city==='string'?b.city.trim():'';
        if(!city&&b.trip_id!==undefined){const trip=get('trip',b.trip_id);city=trip.route_pack?.city_adcode||trip.route_pack?.adcode||'';}
        ensure(/^\d{6}$/.test(city),'缺少城市编码，无法查询公交换乘');
        let result;try{result=await transitRoutes(from,to,city);}catch{throw new HttpError(503,'暂时没有查到公共交通方案，请稍后重试或直接步行');}
        return send({...result,from:{name:from.name,lat:from.lat,lng:from.lng},to:{name:to.name,lat:to.lat,lng:to.lng}});
      }
      if(path==='/api/trips'&&req.method==='GET')return send({trips:store.list('trip',owner).reverse()});
      if(path==='/api/route-packs'&&req.method==='GET'){
        const packs=new Map();for(const trip of store.list('trip',owner).reverse())if(trip.route_pack&&!packs.has(trip.route_pack.adcode))packs.set(trip.route_pack.adcode,{...trip.route_pack,trip_id:trip.id});
        return send({packs:[...packs.values()]});
      }
      if(path==='/api/trip/plan'&&req.method==='POST'){
        let trip;try{trip=await createPlan(b);}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(503,'地图服务不可用，未生成未经验证的实况路线；请检查配置或使用演示模式。');}
        return send(put('trip',trip),201);
      }
      if(/^\/api\/trip\/[^/]+\/map$/.test(path)&&req.method==='GET'){
        const trip=get('trip',path.split('/')[3]),q=new URL(req.url,'http://local').searchParams;
        const day=Number(q.get('day')||1),zoom=q.has('zoom')?Number(q.get('zoom')):undefined,focus=q.has('focus')?Number(q.get('focus')):undefined;
        ensure(Number.isInteger(day)&&day>=1&&day<=trip.days.length,'旅行日无效');
        const stops=trip.days[day-1].stops;
        ensure(zoom===undefined||(Number.isInteger(zoom)&&zoom>=3&&zoom<=17),'地图缩放级别无效');
        let center;
        if(q.has('lng')||q.has('lat')){
          ensure(q.has('lng')&&q.has('lat')&&q.get('lng').trim()!==''&&q.get('lat').trim()!=='','地图中心坐标不完整');
          center=[Number(q.get('lng')),Number(q.get('lat'))];
          ensure(center.every(Number.isFinite)&&Math.abs(center[0])<=180&&Math.abs(center[1])<=85,'地图中心坐标无效');
          ensure(focus===undefined,'地图中心与地点聚焦不能同时指定');
        }
        ensure(focus===undefined||(Number.isInteger(focus)&&focus>=0&&focus<stops.length),'地点无效');
        const id='map:'+owner,now=Date.now();let limit=limits.get(id);if(!limit||now-limit.at>60000)limit={at:now,count:0};
        ensure(++limit.count<=60,'地图操作过于频繁，请稍后重试',429);limits.set(id,limit);
        let image;try{image=await routeMap(stops,{zoom,focus,center});}catch{throw new HttpError(503,'地图暂时无法加载，请稍后重试');}
        return send(image);
      }
      if(/^\/api\/trip\/[^/]+$/.test(path)&&req.method==='GET')return send(get('trip',path.split('/')[3]));
      if(path==='/api/session/start'&&req.method==='POST'){
        const trip=get('trip',b.trip_id);const existing=store.list('session',owner).find(s=>s.trip_id===trip.id&&!s.ended_at);if(existing)return send(existing);
        ensure(typeof b.model_consent==='boolean','请明确本次模型授权');
        ensure(Number.isInteger(b.day)&&b.day>=1&&b.day<=trip.days.length,'旅行日无效');
        return send(put('session',{id:randomUUID(),trip_id:trip.id,day:b.day,current_index:0,status:'normal',started_at:new Date().toISOString(),model_consent:b.model_consent,last_suggestion_at:0,events:[],walked_km:0}),201);
      }
      if(/^\/api\/suggestion\/[^/]+$/.test(path)&&req.method==='GET')return send(get('suggestion',path.split('/')[3]));
      if(/^\/api\/session\/[^/]+$/.test(path)&&req.method==='GET')return send(get('session',path.split('/')[3]));
      if((path==='/api/session/state'||path==='/api/feedback')&&req.method==='POST'){
        const s=session(),trip=get('trip',s.trip_id),trigger=b.trigger||b.feedback_type||'state';
        ensure(['state','hr_high_sustained','tired','hungry','rain','unwell','progress'].includes(trigger),'触发类型无效');
        ensure(trigger!=='rain'||b.demo===true,'天气演示必须明确标记');
        const f=b.features||{};ensure(f&&typeof f==='object'&&!Array.isArray(f),'状态特征格式无效');
        const ranges={hr_vs_baseline_pct:[-100,400],duration_s:[0,86400],cadence_change_pct:[-100,400],delay_min:[0,1440],walked_km_today:[0,100]};
        ensure(Object.keys(f).every(k=>ranges[k]),'请仅上传支持的派生特征');
        for(const [k,v]of Object.entries(f))ensure(typeof v==='number'&&Number.isFinite(v)&&v>=ranges[k][0]&&v<=ranges[k][1],'状态特征超出范围');
        if(s.status==='paused'&&trigger!=='unwell')return send({status:'paused',suggestion:'seek_help',reason:'当前行程已暂停，请先处理不适并结束本次行程。',require_confirm:false});
        let outcome=evaluate(f,trigger);
        s.walked_km=Math.max(s.walked_km,f.walked_km_today||0);
        if(outcome.status==='paused'){
          watch.revoke(owner,s.id);s.status='paused';s.pending_suggestion=null;s.events.push({at:new Date().toISOString(),type:'unwell',status:'paused'});put('session',s);return send({...outcome,suggestion:'seek_help',require_confirm:false});
        }
        if(outcome.action==='continue') {s.status='normal';put('session',s);return send({...outcome,require_confirm:false});}
        if(['state','hr_high_sustained','progress'].includes(trigger)&&Date.now()-s.last_suggestion_at<300000)return send({status:s.status,suggestion:'cooldown',reason:'建议冷却中，继续观察。',require_confirm:false});
        const model=await decision(f,s.model_consent&&b.demo!==true);
        // Model cannot override deterministic safety boundaries or mutate the route.
        const day=trip.days[s.day-1],prefix=day.stops.slice(0,s.current_index+1),remaining=day.stops.slice(s.current_index+1);
        if(!remaining.length)return send({status:outcome.status,suggestion:'rest',reason:'已到最后一站，可以就地休息并结束行程。',require_confirm:false});
        let ids=remaining.slice(0,-1).map(p=>p.id);
        if(outcome.action==='rain')ids=day.plan_b.stops.filter(p=>!prefix.some(v=>v.id===p.id)).map(p=>p.id);
        
        if(trip.poi_catalog){
          // Dynamic trips may only use their own city's saved POI snapshot.
          if(outcome.action==='break'){
            const nearby=trip.poi_catalog.filter(p=>p.category==='美食'&&!prefix.some(v=>v.id===p.id)&&approximateDistance(prefix.at(-1),p)<=1500).sort((a,b)=>approximateDistance(prefix.at(-1),a)-approximateDistance(prefix.at(-1),b))[0];
            ids=nearby?[nearby.id,...remaining.map(p=>p.id).filter(id=>id!==nearby.id)]:remaining.slice(0,-1).map(p=>p.id);
          }
        }else{
          if(['shorten','break'].includes(outcome.action))ids=['rest-gushan',...ids.filter(id=>id!=='rest-gushan')];
          if(outcome.action==='break')ids=['lunch-hubin',...remaining.map(p=>p.id).filter(id=>id!=='lunch-hubin')];
        }
        let next;
        try{next=await schedule(ids,{...trip.preferences,budget:Math.max(0,trip.preferences.budget/trip.preferences.days-prefix.reduce((n,p)=>n+(p.price??0),0)),days:1,walk_limit_km:Math.max(0,trip.preferences.walk_limit_km-prefix.reduce((n,p)=>n+p.leg.distance_m,0)/1000)},day.date,minutes(prefix.at(-1).departure)+10,prefix.at(-1),trip.poi_catalog);}catch{throw new HttpError(503,'候选路线计算失败，原行程保持不变');}
        const stops=[...prefix,...next.stops],distance=stops.reduce((n,p)=>n+p.leg.distance_m,0),cost=stops.reduce((n,p)=>n+p.price,0);
        if(stops.map(p=>p.id).join()===day.stops.map(p=>p.id).join())return send({status:outcome.status,suggestion:'rest',reason:'当前约束下没有不同的可行路线，请先就地休息。',require_confirm:false});
        const change={id:randomUUID(),session_id:s.id,trip_id:trip.id,trip_version:trip.version,day:s.day,status:outcome.status,reason:outcome.reason,confidence:model?.confidence??null,decision_source:model?'规则边界 + '+model.source+'参考':'规则引擎',model_reference:model,require_confirm:true,suggestion:'switch_route',new_route_id:randomUUID(),created_at:new Date().toISOString(),expires_at:new Date(Date.now()+10*60000).toISOString(),changes:{distance_saved_m:day.distance_m-distance,time_saved_min:minutes(day.stops.at(-1).departure)-minutes(stops.at(-1).departure),added_stops:stops.filter(p=>!day.stops.some(v=>v.id===p.id)).map(p=>p.name),skipped_stops:day.stops.filter(p=>!stops.some(v=>v.id===p.id)).map(p=>p.name)},candidate:{...day,stops,distance_m:distance,cost,unknown_cost_count:stops.filter(p=>p.price===null).length,duration_min:minutes(stops.at(-1).departure)-minutes(stops[0].arrival)},demo:b.demo===true};
        put('suggestion',change);s.pending_suggestion=change.id;s.status=outcome.status;s.last_suggestion_at=Date.now();s.events.push({at:change.created_at,type:trigger,suggestion_id:change.id,demo:b.demo===true});put('session',s);return send(change);
      }
      if(path==='/api/session/confirm'&&req.method==='POST'){
        const s=session(),a=get('suggestion',b.suggestion_id),trip=get('trip',s.trip_id);
        ensure(a.session_id===s.id,'建议不属于当前会话',403);ensure(typeof b.accept==='boolean','确认值须为布尔类型');
        if(a.resolved_at){ensure(a.accepted===b.accept,'该建议已按另一选择处理',409);return send({trip,session:s,accepted:a.accepted,idempotent:true});}
        ensure(s.status!=='paused','行程已暂停，无法改线',409);
        ensure(s.pending_suggestion===a.id&&a.trip_version===trip.version&&Date.parse(a.expires_at)>Date.now(),'建议已过期，请重新获取',409);
        if(b.accept){trip.days[a.day-1]=a.candidate;trip.version++;put('trip',trip);}
        a.accepted=b.accept;a.resolved_at=new Date().toISOString();put('suggestion',a);s.pending_suggestion=null;s.events.push({at:a.resolved_at,type:b.accept?'accepted':'rejected',suggestion_id:a.id});put('session',s);return send({trip,session:s,accepted:b.accept});
      }
      if(path==='/api/session/checkin'&&req.method==='POST'){
        const s=session(),trip=get('trip',s.trip_id);ensure(s.status!=='paused','行程已暂停',409);
        ensure(b.stop_id===trip.days[s.day-1].stops[s.current_index]?.id,'请按当前节点打卡',409);
        s.events.push({type:'checkin',stop_id:b.stop_id,at:new Date().toISOString()});
        s.current_index=Math.min(s.current_index+1,trip.days[s.day-1].stops.length);s.pending_suggestion=null;put('session',s);return send(s);
      }
      if(path==='/api/session/end'&&req.method==='POST'){const s=get('session',b.session_id);watch.revoke(owner,s.id);s.ended_at??=new Date().toISOString();s.pending_suggestion=null;put('session',s);return send(s);}
      if(/^\/api\/trip\/[^/]+\/report$/.test(path)&&req.method==='GET'){
        const trip=get('trip',path.split('/')[3]),sessions=store.list('session',owner).filter(s=>s.trip_id===trip.id),events=sessions.flatMap(s=>s.events),suggestions=store.list('suggestion',owner).filter(s=>s.trip_id===trip.id);
        return send({trip_id:trip.id,title:trip.title,finished:sessions.length>0&&sessions.every(s=>s.ended_at),total_stops:trip.days.reduce((n,d)=>n+d.stops.length,0),visited_stops:new Set(events.filter(e=>e.type==='checkin').map(e=>e.stop_id)).size,walked_km:sessions.reduce((n,s)=>n+s.walked_km,0),planned_distance_km:trip.days.reduce((n,d)=>n+d.distance_m,0)/1000,accepted:suggestions.filter(s=>s.accepted===true).length,rejected:suggestions.filter(s=>s.accepted===false).length,events,preference_note:suggestions.some(s=>s.accepted)?'下次可以优先尝试更轻松的节奏；请在生成行程时确认。':'继续记录您的选择，逐步认识适合您的旅行节奏。',data_mode:trip.data_mode});
      }
      if(path==='/api/ops'&&req.method==='GET')return send({providers:providerFlags(),provider_status:providerStatus()});
      if(path==='/api/privacy/delete'&&req.method==='POST'){ensure(b.confirm===true,'请确认删除');watch.revokeOwner(owner);store.deleteOwner(owner);return send({deleted:true});}
      throw new HttpError(404,'接口不存在');
    }catch(e){send({error:e.status?e.message:'服务暂时不可用，请稍后重试'},e.status||500);if(!e.status)console.error('Request failed:',e.name);}
    finally{if(acquired)locks.delete(lockKey);}
  };
  const app=tls?https.createServer({...tls,minVersion:'TLSv1.2'},handler):http.createServer(handler);
  app.on('close',()=>{watch.close();store.close();});return app;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const tls=await loadTls(),app=createApp({tls}),port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
    app.on('error',error=>{console.error(error.code==='EADDRINUSE'?'端口已占用，请修改PORT。':error.code==='EPERM'?'当前运行环境禁止监听端口，请在允许运行本地服务的终端启动。':error.message);process.exitCode=1;});
    app.listen(port,host,()=>console.log(`慢行 is running at ${tls?'https':'http'}://${host.includes(':')?'['+host+']':host}:${port}`));
    for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>app.close(()=>process.exit(0)));
  }catch(error){console.error('启动失败：',error.message);process.exitCode=1;}
}
