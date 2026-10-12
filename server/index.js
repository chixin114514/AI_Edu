import http from 'node:http';
import https from 'node:https';
import { loadTls } from './tls.js';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { routeMap } from './maps.js';
import { pois, byId } from './pois.js';
import { createPlan, evaluate, ensure, HttpError, clock, minutes, schedule, approximateDistance } from './planner.js';
import { decision, liveMode, providerFlags, providerStatus, resolveLocation, cityOptions, regionOptions } from './providers.js';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
const safeEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
async function body(req){
  ensure((req.headers['content-type']||'').startsWith('application/json'),'仅接受JSON请求',415);
  let s='';for await(const c of req){s+=c;ensure(Buffer.byteLength(s)<=32768,'请求过大',413);}
  try{const b=JSON.parse(s);ensure(b&&typeof b==='object'&&!Array.isArray(b),'请求须为对象');return b;}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'JSON格式错误');}
}
export function createApp({database=process.env.DATABASE_PATH||'./data/manxing.sqlite',tls}={}){
  const store=createStore(database), limits=new Map();
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
      const cookies=req.headers.cookie||'';
      let owner=cookies.match(/(?:^|;\s*)mx_owner=([a-f0-9]{48})(?:;|$)/)?.[1];
      if(!owner){owner=randomBytes(24).toString('hex');res.setHeader('Set-Cookie',`mx_owner=${owner}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${req.socket.encrypted||process.env.COOKIE_SECURE==='true'?'; Secure':''}`);}
      if(req.method!=='GET'){
        const origin=req.headers.origin;
        ensure(!origin||(new URL(origin).host===req.headers.host&&(!req.socket.encrypted||new URL(origin).protocol==='https:')),'跨站请求已拒绝',403);
        const now=Date.now(),ip=req.socket.remoteAddress;let l=limits.get(ip);if(!l||now-l.at>60000)l={at:now,count:0};
        ensure(++l.count<=120,'请求过于频繁，请稍后重试',429);limits.set(ip,l);
        if(limits.size>10000)limits.clear();
      }
      const b=req.method==='POST'?await body(req):{};
      const get=(kind,id)=>{ensure(typeof id==='string','缺少标识');const v=store.get(kind,id,owner);ensure(v,'记录不存在',404);return v;};
      const session=()=>{const s=get('session',b.session_id);ensure(!s.ended_at,'行程已结束',409);return s;};
      const put=(kind,v)=>store.put(kind,v,owner);
      if(req.method==='POST') {lockKey=owner;ensure(!locks.has(lockKey),'上一操作仍在处理中，请稍后重试',409);locks.add(lockKey);acquired=true;}
      if(path==='/api/config'&&req.method==='GET')return send({data_mode:liveMode()?'live':'demo',dynamic_planning:liveMode(),city:'杭州',providers:providerFlags(),provider_status:providerStatus(),health_notice:'仅辅助调整旅行节奏，不作医学判断。',privacy:'心率原始值留在浏览器；服务端仅保存事件类型、累计步行和确认记录，不保存上传的健康特征。'});
      if(path==='/api/pois'&&req.method==='GET')return send({pois});
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
        ensure(focus===undefined||(Number.isInteger(focus)&&focus>=0&&focus<stops.length),'地点无效');
        const id='map:'+owner,now=Date.now();let limit=limits.get(id);if(!limit||now-limit.at>60000)limit={at:now,count:0};
        ensure(++limit.count<=60,'地图操作过于频繁，请稍后重试',429);limits.set(id,limit);
        let image;try{image=await routeMap(stops,{zoom,focus});}catch{throw new HttpError(503,'地图暂时无法加载，请稍后重试');}
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
          s.status='paused';s.pending_suggestion=null;s.events.push({at:new Date().toISOString(),type:'unwell',status:'paused'});put('session',s);return send({...outcome,suggestion:'seek_help',require_confirm:false});
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
      if(path==='/api/session/end'&&req.method==='POST'){const s=get('session',b.session_id);s.ended_at??=new Date().toISOString();s.pending_suggestion=null;put('session',s);return send(s);}
      if(/^\/api\/trip\/[^/]+\/report$/.test(path)&&req.method==='GET'){
        const trip=get('trip',path.split('/')[3]),sessions=store.list('session',owner).filter(s=>s.trip_id===trip.id),events=sessions.flatMap(s=>s.events),suggestions=store.list('suggestion',owner).filter(s=>s.trip_id===trip.id);
        return send({trip_id:trip.id,title:trip.title,finished:sessions.length>0&&sessions.every(s=>s.ended_at),total_stops:trip.days.reduce((n,d)=>n+d.stops.length,0),visited_stops:new Set(events.filter(e=>e.type==='checkin').map(e=>e.stop_id)).size,walked_km:sessions.reduce((n,s)=>n+s.walked_km,0),planned_distance_km:trip.days.reduce((n,d)=>n+d.distance_m,0)/1000,accepted:suggestions.filter(s=>s.accepted===true).length,rejected:suggestions.filter(s=>s.accepted===false).length,events,preference_note:suggestions.some(s=>s.accepted)?'下次可以优先尝试更轻松的节奏；请在生成行程时确认。':'继续记录您的选择，逐步认识适合您的旅行节奏。',data_mode:trip.data_mode});
      }
      if(path==='/api/ops'&&req.method==='GET')return send({poi_count:pois.length,unverified:pois.filter(p=>!p.verified).length,my_feedback:store.list('session',owner).flatMap(s=>s.events).reduce((a,e)=>(a[e.type]=(a[e.type]||0)+1,a),{}),jobs:store.list('job',owner).reverse().slice(0,10),providers:providerFlags(),provider_status:providerStatus()});
      if(path==='/api/ops/run'&&req.method==='POST'){
        const configured=process.env.ADMIN_TOKEN||'', supplied=req.headers.authorization?.replace(/^Bearer /,'')||'';
        ensure(configured.length>=16&&safeEqual(configured,supplied),'运营操作需要配置至少16位的 ADMIN_TOKEN 并登录',403);
        ensure(['poi_audit','feedback'].includes(b.job),'任务类型无效');
        const output=b.job==='poi_audit'?{summary:'已完成样本字段完整性检查。未抓取官方页面；以下记录仍需人工核验。',items:pois.map(p=>({name:p.name,result:!p.verified?'待核验':'已核验',source:p.source_url,missing:['name','source_url','updated_at','open','close'].filter(k=>!p[k])}))}:{summary:'当前浏览器反馈的规则聚类（未调用模型）',items:Object.entries(store.list('session',owner).flatMap(s=>s.events).reduce((a,e)=>(a[e.type]=(a[e.type]||0)+1,a),{})).map(([type,count])=>({type,count}))};
        return send(put('job',{id:randomUUID(),job:b.job,at:new Date().toISOString(),output}));
      }
      if(path==='/api/privacy/delete'&&req.method==='POST'){ensure(b.confirm===true,'请确认删除');store.deleteOwner(owner);return send({deleted:true});}
      throw new HttpError(404,'接口不存在');
    }catch(e){send({error:e.status?e.message:'服务暂时不可用，请稍后重试'},e.status||500);if(!e.status)console.error('Request failed:',e.name);}
    finally{if(acquired)locks.delete(lockKey);}
  };
  const app=tls?https.createServer({...tls,minVersion:'TLSv1.2'},handler):http.createServer(handler);
  app.on('close',()=>store.close());return app;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const tls=await loadTls(),app=createApp({tls}),port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
    app.on('error',error=>{console.error(error.code==='EADDRINUSE'?'端口已占用，请修改PORT。':error.code==='EPERM'?'当前运行环境禁止监听端口，请在允许运行本地服务的终端启动。':error.message);process.exitCode=1;});
    app.listen(port,host,()=>console.log(`慢行 is running at ${tls?'https':'http'}://${host.includes(':')?'['+host+']':host}:${port}`));
    for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>app.close(()=>process.exit(0)));
  }catch(error){console.error('启动失败：',error.message);process.exitCode=1;}
}
