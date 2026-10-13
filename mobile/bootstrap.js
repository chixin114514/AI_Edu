// 所有 HTML 入口共用这个启动顺序；前端首次请求前，本地请求桥必须安装完成。
export async function bootMobile(load=path=>import(path),scope=globalThis){
  let stage='backend';
  scope.__manxingStartup={stage};
  try{
    await load('./manxing-backend.js');
    if(typeof scope.__manxingBackend?.request!=='function')throw Error('本地服务组件未加载');
    stage='bridge';scope.__manxingStartup={stage};
    await load('./manxing-api-bridge.js');
    if(!scope.__manxingApiBridgeReady)throw Error('本地请求桥未安装');
    stage='service';scope.__manxingStartup={stage};
    const response=await scope.fetch('/api/config');
    const config=await response.json();
    if(!response.ok||!['live','demo'].includes(config.data_mode))throw Error('本地服务初始化失败');
    stage='native';scope.__manxingStartup={stage};
    const native=await load('./manxing-native.js');
    await native?.nativeReady;
    stage='app';scope.__manxingStartup={stage};
    await load('./app.js');
    scope.__manxingStartup={stage:'ready'};
    return true;
  }catch(error){
    scope.__manxingStartup={stage,error:true};
    scope.console?.error('[manxing] 应用启动失败：'+stage,error);
    const app=scope.document?.getElementById('app');
    if(app){
      app.innerHTML='<section class="empty"><h2>应用组件启动失败</h2><p>请重新打开应用；如果仍然出现，请重新安装最新安装包。</p><button class="primary" id="mx-retry-start">重试</button></section>';
      app.querySelector('#mx-retry-start')?.addEventListener('click',()=>scope.location.reload());
    }
    return false;
  }
}
if(typeof document!=='undefined')bootMobile();
