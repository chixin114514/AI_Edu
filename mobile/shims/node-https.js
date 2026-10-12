// node:https 替身。
// server/index.js 里是 `tls ? https.createServer(...) : http.createServer(handler)`，
// App 内调用 createApp() 不传 tls，因此这里永远不会被调用，只需让模块能解析。

export function createServer() {
  throw new Error('App 内不启动 HTTPS 服务；后端由 fetch 桥在进程内调用。');
}

export default { createServer };
