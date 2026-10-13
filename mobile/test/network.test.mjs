import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMobileEntries } from '../html-entry.mjs';
import { bootMobile } from '../bootstrap.js';
import { installApiBridge } from '../src/bridge.js';
import { networkDiagnostics } from '../src/network-diagnostics.js';
import { pageRoutes, resolvePageRoute } from '../../public/page-routes.js';
import { sensorFeatures } from '../../public/sensors.js';
import { cleanStopReason, defaultStopReason } from '../../public/stop-reasons.js';

test('every packaged page installs the same mobile startup entry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manxing-mobile-pages-'));
  try{
    await cp(new URL('../../public/',import.meta.url),dir,{recursive:true});await prepareMobileEntries(dir);
    for(const name of ['index.html',...Object.keys(pageRoutes).map(page=>'pages/'+page+'.html')]){
      const html=await readFile(join(dir,name),'utf8');
      assert.match(html,/src="\/manxing-app.js"/,name);assert.doesNotMatch(html,/src="\/app.js"/,name);
    }
    assert.equal(await readFile(join(dir,'manxing-app.js'),'utf8'),await readFile(new URL('../bootstrap.js',import.meta.url),'utf8'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

// 前台服务的原生回归：Android 14 起，前台服务类型要求对应运行时权限已经授予，
// 否则 startForeground() 抛 SecurityException 并把整个 App 带崩。
// 没有 Android 仪器测试环境，所以这里直接对原生源码与清单做静态校验 ——
// 一旦有人改回「无条件用 connectedDevice」，这条用例会失败。
test('前台服务按已授予的权限选择类型，且异常不会逃到主线程',async()=>{
  const manifest=await readFile(new URL('../android/app/src/main/AndroidManifest.xml',import.meta.url),'utf8');
  assert.match(manifest,/foregroundServiceType="connectedDevice\|location"/);
  assert.match(manifest,/android\.permission\.FOREGROUND_SERVICE_LOCATION/);
  assert.ok(manifest.includes('android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE'));

  const plugin=await readFile(new URL('../android/app/src/main/java/com/manxing/app/KeepAlivePlugin.java',import.meta.url),'utf8');
  assert.ok(plugin.includes('BLUETOOTH_CONNECT')&&plugin.includes('BLUETOOTH_SCAN')&&plugin.includes('BLUETOOTH_ADVERTISE'),'蓝牙三种权限任一即可');
  assert.ok(plugin.includes('ACCESS_FINE_LOCATION')&&plugin.includes('ACCESS_COARSE_LOCATION'),'定位权限支撑 location 类型');
  assert.ok(plugin.indexOf('if (types == 0)')<plugin.indexOf('startForegroundService'),'必须先判定权限再启动服务，顺序反了会崩');
  assert.ok(plugin.includes('KeepAliveService.EXTRA_TYPES'),'类型要传给服务，服务不再自己假定');
  assert.ok(plugin.includes('call.resolve(denied)')&&plugin.includes('reason'),'不能启动时把原因回给前端');

  const service=await readFile(new URL('../android/app/src/main/java/com/manxing/app/KeepAliveService.java',import.meta.url),'utf8');
  assert.ok(!service.includes('ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE'),'服务不能再硬编码 connectedDevice');
  assert.ok(service.includes('getIntExtra(EXTRA_TYPES'),'类型来自插件');
  assert.ok(service.includes('catch (RuntimeException')&&service.includes('stopSelf()'),'异常必须兜住并停掉服务');
});

test('API bridge keeps local calls on-device and external calls on the original HTTP transport',async()=>{
  const local=[],network=[],alive=[];
  const scope={location:new URL('https://localhost/plan'),fetch:async(...args)=>{network.push(args);return new Response('external');},
    __manxingBackend:{request:async(method,path,data)=>{local.push({method,path,data});if(path==='/api/fail')throw Object.assign(Error('冲突'),{status:409});return {ok:true};}},
    __manxingKeepAlive:{start(){alive.push('start');},stop(){alive.push('stop');}}};
  installApiBridge(scope);const installed=scope.fetch;installApiBridge(scope);assert.equal(scope.fetch,installed);
  const response=await scope.fetch('/api/config');assert.deepEqual(await response.json(),{ok:true});assert.equal(network.length,0);
  await scope.fetch('/api/session/start',{method:'POST',body:JSON.stringify({day:1})});assert.deepEqual(alive,['start']);
  assert.deepEqual(local[1],{method:'POST',path:'/api/session/start',data:{day:1}});
  const init={method:'POST',headers:{Authorization:'Bearer test'},body:'{"state":1}',signal:new AbortController().signal};
  await scope.fetch('https://provider.example/api/decision',init);assert.equal(network.length,1);assert.equal(network[0][1],init);
  assert.equal(local.length,2,'foreign /api URLs must not be swallowed by the on-device backend');
  const failed=await scope.fetch('/api/fail');assert.equal(failed.status,409);assert.deepEqual(await failed.json(),{error:'冲突'});
  assert.throws(()=>installApiBridge({fetch:async()=>{}}),/本地服务组件未加载/);
});

test('startup waits for bridge and local service; component failures do not fall through to localhost network',async()=>{
  let release;const loaded=[];const scope={console:{error(){}},fetch:async()=>new Response('{"data_mode":"demo"}')};
  const pending=bootMobile(async path=>{
    loaded.push(path);
    if(path==='./manxing-backend.js')scope.__manxingBackend={request(){}};
    if(path==='./manxing-api-bridge.js'){await new Promise(resolve=>release=resolve);scope.__manxingApiBridgeReady=true;}
  },scope);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(loaded,['./manxing-backend.js','./manxing-api-bridge.js']);
  release();assert.equal(await pending,true);assert.deepEqual(loaded,['./manxing-backend.js','./manxing-api-bridge.js','./manxing-native.js','./app.js']);
  const app={innerHTML:'',querySelector:()=>null},failed=[];
  const broken={console:{error(){}},document:{getElementById:()=>app},fetch:async()=>{throw Error('must not reach network');}};
  assert.equal(await bootMobile(async path=>failed.push(path),broken),false);
  assert.deepEqual(failed,['./manxing-backend.js']);assert.equal(broken.__manxingStartup.stage,'backend');assert.match(app.innerHTML,/应用组件启动失败/);
  const badService={console:{error(){}},__manxingBackend:{request(){}},__manxingApiBridgeReady:true,fetch:async()=>new Response('<html>wrong endpoint</html>')};
  const badLoads=[];assert.equal(await bootMobile(async path=>badLoads.push(path),badService),false);
  assert.equal(badService.__manxingStartup.stage,'service');assert.ok(!badLoads.includes('./app.js'));

  let ready;const ordered=[];
  const nativeScope={...scope,__manxingApiBridgeReady:true};
  const waiting=bootMobile(async path=>{
    ordered.push(path);
    if(path==='./manxing-native.js')return {nativeReady:new Promise(resolve=>ready=resolve)};
  },nativeScope);
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(!ordered.includes('./app.js'),'automatic location must wait for native adapters');
  ready();assert.equal(await waiting,true);assert.equal(ordered.at(-1),'./app.js');
});

test('real bundled backend and current frontend start offline without Node globals or a computer IP',async()=>{
  const bundle=(await readFile(new URL('../www/manxing-backend.js',import.meta.url),'utf8'))
    .replaceAll('import.meta.url',JSON.stringify('https://localhost/manxing-backend.js')).replace(/export\s*\{[^}]*\};?/g,'');
  const frontend=(await readFile(new URL('../../public/app.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'').replace('\ninit();','\n');
  const bridge=(await readFile(new URL('../www/manxing-api-bridge.js',import.meta.url),'utf8')).replace(/export\s*\{[^}]*\};?/g,'');
  for(const pathname of ['/plan','/pages/login.html','/pages/register.html']){
    const memory=new Map([['manxing-env','{"DATA_MODE":"demo"}']]),nodes=new Map(),requests=[];
    const node=selector=>{
      if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',dataset:{},value:'',querySelector:node,
        classList:{add(){},remove(){},toggle(){}},addEventListener(){},setAttribute(){},removeAttribute(){},close(){},focus(){}});
      return nodes.get(selector);
    };
    class Sensors extends EventTarget{constructor(){super();this.samples=[];}features(){return {};}stop(){}}
    const location=new URL('https://localhost'+pathname);
    const context=vm.createContext({URL,URLSearchParams,Response,Request,TextEncoder,TextDecoder,AbortController,AbortSignal,DOMException,btoa,atob,crypto:webcrypto,console,
      setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},queueMicrotask,
      fetch:async url=>{requests.push(url);throw Error('network is offline');},location,
      localStorage:{get length(){return memory.size;},key:i=>[...memory.keys()][i]??null,getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)},
      document:{querySelector:node,querySelectorAll:()=>[],getElementById:id=>node('#'+id),addEventListener(){}},window:{addEventListener(){},removeEventListener(){},scrollTo(){},isSecureContext:true},
      navigator:{onLine:false},history:{replaceState(_s,_t,path){location.href=new URL(path,location).href;}},Sensors,sensorFeatures,pageRoutes,resolvePageRoute,cleanStopReason,defaultStopReason,
      routeMapMarkup:()=>'',destroyRouteMaps(){},mountRouteMaps(){}});
    assert.equal(vm.runInContext('typeof Buffer',context),'undefined');
    assert.equal(await bootMobile(async path=>{
      if(path==='./manxing-backend.js')await vm.runInContext('(async()=>{'+bundle+'})()',context);
      if(path==='./manxing-api-bridge.js')vm.runInContext(bridge,context);
      if(path==='./app.js'){vm.runInContext(frontend,context);await vm.runInContext('init()',context);}
    },context),true,pathname);
    assert.equal(vm.runInContext('state.offline',context),false);assert.equal(vm.runInContext('state.authChecked',context),true);
    assert.equal(requests.length,0,'startup must never try connecting to localhost or a computer');
    assert.doesNotMatch(node('#toast').textContent,/连不上服务/);
    if(pathname.includes('login'))assert.match(node('#app').innerHTML,/欢迎回来/);
    else if(pathname.includes('register'))assert.match(node('#app').innerHTML,/创建账号/);
    else assert.match(node('#app').innerHTML,/定制你的旅程/);
    if(pathname==='/plan'){
      const call=async(path,data)=>{
        const response=await context.fetch('/api'+path,data?{method:'POST',body:JSON.stringify(data)}:undefined);
        return {status:response.status,data:await response.json()};
      };
      assert.equal((await call('/auth/login',{username:'admin',password:'wrong-password'})).status,401);
      const admin=await call('/auth/login',{username:'admin',password:'admin'});
      assert.equal(admin.status,200);assert.equal(admin.data.user.role,'admin');
      assert.equal((await call('/auth/me')).data.user.username,'admin');
      assert.equal((await call('/ops')).status,200);
      await call('/auth/logout',{});
      const registered=await call('/auth/register',{username:'traveler',password:'valid-password'});
      assert.equal(registered.status,200);assert.equal(registered.data.user.role,'user');
      await call('/auth/logout',{});
      assert.equal((await call('/auth/login',{username:'traveler',password:'valid-password'})).status,200);
      assert.equal((await call('/ops')).status,403);

      // 图片下载成功后仍需 Buffer 的 PNG 校验与 base64 编码，不能依赖 Node 的 Buffer。
      const trip=(await call('/trip/plan',{city:'杭州',date:'2026-10-13',days:1,budget:300,walk_limit_km:6,interests:['自然'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:false})).data;
      const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+8v0lAAAAAElFTkSuQmCC';
      context.process.env.AMAP_MAPS_API_KEY='test-map-key';
      const localFetch=context.fetch;
      context.fetch=(url,init)=>String(url).startsWith('https://restapi.amap.com/v3/staticmap')
        ?Promise.resolve(new Response(Uint8Array.from(atob(png),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png'}}))
        :localFetch(url,init);
      const map=await call('/trip/'+trip.id+'/map');
      assert.equal(map.status,200);assert.equal(map.data.image,'data:image/png;base64,'+png);
    }
  }
});

test('network diagnostics distinguish local startup, missing keys and provider errors without showing secrets',async()=>{
  const secret='private-test-key',urls=[];
  const scope={location:new URL('https://localhost'),__manxingApiBridgeReady:true,Capacitor:{isNativePlatform:()=>true,isPluginAvailable:()=>true},
    fetch:async url=>{urls.push(String(url));return String(url)==='/api/config'?new Response('{"data_mode":"live"}'):new Response('{"status":"1"}');}};
  const good=await networkDiagnostics({scope,config:{AMAP_MAPS_API_KEY:secret}});
  assert.match(good,/本地服务：正常/);assert.match(good,/高德接口：联网正常/);assert.doesNotMatch(good,new RegExp(secret));assert.ok(urls[1].startsWith('https://restapi.amap.com/'));
  const missing=await networkDiagnostics({scope,config:{}});assert.match(missing,/未配置 Web服务 Key/);
  scope.fetch=async url=>new Response(String(url)==='/api/config'?'{"data_mode":"live"}':'{"status":"0","infocode":"10001","info":"'+secret+'"}');
  const denied=await networkDiagnostics({scope,config:{AMAP_MAPS_API_KEY:secret}});assert.match(denied,/10001/);assert.doesNotMatch(denied,new RegExp(secret));
  scope.fetch=async()=>{throw Error(secret);};const offline=await networkDiagnostics({scope,config:{AMAP_MAPS_API_KEY:secret}});
  assert.match(offline,/本地服务：未启动/);assert.match(offline,/外部请求失败/);assert.doesNotMatch(offline,new RegExp(secret));
  scope.fetch=()=>new Promise(()=>{});const slow=await networkDiagnostics({scope,config:{AMAP_MAPS_API_KEY:secret},timeout:5});assert.match(slow,/请求超时/);
});
