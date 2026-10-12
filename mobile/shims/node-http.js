// node:http 替身。
// server/index.js 只用了 createServer(handler)，这里把 handler 存起来，
// 由 invoke() 用手写的 req/res 假对象驱动它，不经过真实网络。
let handler = null;

export function createServer(fn) {
  handler = fn;
  const server = {
    on() { return server; },
    once() { return server; },
    off() { return server; },
    listen(_port, _host, cb) { if (typeof cb === 'function') cb(); return server; },
    close(cb) { if (typeof cb === 'function') cb(); return server; },
    address() { return { address: '127.0.0.1', port: 0 }; }
  };
  return server;
}

export function getHandler() {
  return handler;
}

// 把请求交给 server/index.js 的处理器，并把响应收敛成一个普通对象。
export function invoke({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    if (!handler) return reject(new Error('本地后端尚未初始化'));
    const req = {
      method,
      url,
      headers,
      httpVersion: '1.1',
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { if (body) yield body; },
      on() {}, once() {}
    };
    let status = 200;
    let sent = false;
    const outHeaders = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) { outHeaders[String(name).toLowerCase()] = value; },
      getHeader(name) { return outHeaders[String(name).toLowerCase()]; },
      removeHeader(name) { delete outHeaders[String(name).toLowerCase()]; },
      writeHead(code, extra) {
        status = code;
        if (extra) for (const [k, v] of Object.entries(extra)) outHeaders[String(k).toLowerCase()] = v;
        return res;
      },
      write() { return true; },
      end(data) {
        if (sent) return;
        sent = true;
        resolve({ status, headers: outHeaders, body: data == null ? '' : String(data) });
      },
      on() {}, once() {}
    };
    try {
      handler(req, res);
    } catch (error) {
      reject(error);
    }
  });
}

export default { createServer };
