// App 内后端的入口（esbuild 打成一个 IIFE，输出到 www/manxing-backend.js）。
//
// 思路：不改写 server/index.js，而是把它整份打包进 App，用 shims/ 里的
// 浏览器替身顶掉 node:* 内置模块和 SQLite 存储。这样会话、建议、确认
// 那套业务逻辑与服务端完全一致。
import { createApp } from '../../server/index.js';
import { invoke } from '../shims/node-http.js';
import { applyEnv } from './env-config.js';

// 服务端用 cookie 里的 mx_owner 做数据隔离（要求 48 位十六进制）。
// 单机 App 只有一个使用者，这里用固定值，保证多次启动数据连续。
const OWNER = Array.from({ length: 48 }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');

let started = false;

function ensureApp() {
  if (started) return;
  // 必须在 createApp 之前：providers.js 的 liveMode() / configured() 都读 process.env
  applyEnv();
  createApp({ database: 'browser' });
  started = true;
}

export async function request(method, path, payload) {
  ensureApp();
  const headers = { host: 'localhost', cookie: `mx_owner=${OWNER}` };
  let body = '';
  if (payload !== undefined && payload !== null) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const { status, body: raw } = await invoke({ method, url: path, headers, body });
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (status >= 400) {
    const error = new Error((data && data.error) || `请求失败（${status}）`);
    error.status = status;
    throw error;
  }
  return data;
}

globalThis.__manxingBackend = { request };
