// 拦截页面里发往 /api/* 的请求，转交给 App 内的后端。
// 前端的 app.js 只有一处 api() 封装，全部走 fetch('/api'+path)，
// 所以这里替换 window.fetch 就能整体接管，前端代码不用改。
export function installApiBridge(scope=globalThis) {
  if(scope.__manxingApiBridgeReady)return true;
  // CapacitorHttp 在原生容器初始化时替换 fetch，这里保留它作为外部请求通道。
  const nativeFetch = scope.fetch.bind(scope);
  const backend = scope.__manxingBackend;
  if (!backend) {
    throw Error('本地服务组件未加载');
  }

  // 漫游开始 / 结束时联动前台服务，保证锁屏后仍能继续记录心率与定位。
  // 不改 public/app.js：这里直接观察会话接口的调用结果。
  function syncKeepAlive(pathname, method, data) {
    const alive = scope.__manxingKeepAlive;
    if (!alive) return;
    if (method === 'POST' && pathname === '/api/session/start') { alive.start(); return; }
    if (method === 'POST' && pathname === '/api/session/end') { alive.stop(); return; }
    // 重新打开 App 时会话可能仍在进行，把前台服务补起来
    if (method === 'GET' && /^\/api\/session\/[0-9a-f-]{16,}$/i.test(pathname) && data && !data.ended_at) alive.start();
  }

  scope.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input?.url;
    let target;
    try {
      target = new URL(raw, scope.location?.href || 'https://localhost/');
    } catch {
      return nativeFetch(input, init);
    }
    const localOrigin=scope.location?.origin||'https://localhost';
    if (target.origin!==localOrigin||(target.pathname !== '/api' && !target.pathname.startsWith('/api/'))) {
      return nativeFetch(input, init);
    }

    const method = String(init?.method || 'GET').toUpperCase();
    let payload;
    if (init?.body) {
      try { payload = JSON.parse(init.body); } catch { payload = undefined; }
    }
    try {
      const data = await backend.request(method, target.pathname + target.search, method === 'GET' ? undefined : (payload ?? {}));
      syncKeepAlive(target.pathname, method, data);
      return new Response(JSON.stringify(data ?? null), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error?.message || '本地处理失败' }), {
        status: error?.status && error.status >= 400 ? error.status : 500,
        headers: { 'content-type': 'application/json' }
      });
    }
  };
  scope.__manxingApiBridgeReady=true;
  return true;
}
if(globalThis.__manxingBackend)installApiBridge();
