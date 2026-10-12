// node:tls 替身。
// App 内后端只通过 createApp() 被 fetch 桥调用，不监听端口、不提供 TLS。
// createSecureContext 只在 loadTls() 里被调用，而 loadTls 只出现在
// `process.argv[1] === 本文件` 的启动分支里（App 内该分支不执行），所以这里只需存在。

export function createSecureContext() {
  throw new Error('App 内不启动 TLS 服务；桌面/网页端才需要 HTTPS。');
}

export default { createSecureContext };
