import { readConfig } from './env-config.js';

async function timedRequest(fetch,url,timeout){
  const controller=new AbortController();let timer;
  try{
    return await Promise.race([
      (async()=>{const response=await fetch(url,{signal:controller.signal,redirect:'error'});return {ok:response.ok,status:response.status,data:await response.json()};})(),
      new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DOMException('timeout','TimeoutError'));},timeout);})
    ]);
  }finally{clearTimeout(timer);}
}

export async function networkDiagnostics({scope=globalThis,config=readConfig(),timeout=8000}={}){
  const lines=[`页面地址：${scope.location?.origin||'未知'}`,`本地请求桥：${scope.__manxingApiBridgeReady?'已安装':'未安装'}`];
  const fetch=scope.fetch.bind(scope);
  try{
    const local=await timedRequest(fetch,'/api/config',timeout);
    lines.push(local.ok&&['live','demo'].includes(local.data?.data_mode)?`本地服务：正常（${local.data.data_mode==='live'?'实况':'演示'}）`:'本地服务：返回异常，请重新安装最新安装包');
  }catch{lines.push('本地服务：未启动，请重新打开应用或安装最新安装包');}
  if(scope.Capacitor?.isNativePlatform?.())lines.push(`原生 HTTP：${scope.Capacitor.isPluginAvailable?.('CapacitorHttp')?'可用':'未就绪，请重新同步并安装 APK'}`);
  const key=config.AMAP_MAPS_API_KEY||config.AMAP_KEY;
  if(!key){lines.push('高德接口：未配置 Web服务 Key，可在服务配置中填写');return lines.join('\n');}
  const url=new URL('https://restapi.amap.com/v3/config/district');
  url.search=new URLSearchParams({keywords:'中国',subdistrict:'0',extensions:'base',key});
  try{
    const result=await timedRequest(fetch,url.toString(),timeout);
    if(!result.ok)lines.push(`高德接口：HTTP ${result.status}`);
    else if(result.data?.status==='1')lines.push('高德接口：联网正常');
    else lines.push('高德接口：服务返回错误'+(/^\d{5}$/.test(result.data?.infocode||'')?'（'+result.data.infocode+'）':''));
  }catch(error){lines.push(['TimeoutError','AbortError'].includes(error.name)?'高德接口：请求超时':'高德接口：外部请求失败，请检查手机网络');}
  return lines.join('\n');
}
