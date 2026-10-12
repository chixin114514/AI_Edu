// 浏览器环境缺少的 Node 全局量替身。
// esbuild 通过 inject 把这里的导出注入到使用处（如 server/index.js 里的 process / Buffer）。
const proc = globalThis.process || {};
if (!proc.env) proc.env = {};
if (!Array.isArray(proc.argv)) proc.argv = [];
if (typeof proc.on !== 'function') proc.on = () => {};
if (typeof proc.once !== 'function') proc.once = () => {};
if (typeof proc.nextTick !== 'function') proc.nextTick = fn => Promise.resolve().then(fn);
if (!proc.platform) proc.platform = 'browser';
if (typeof proc.exit !== 'function') proc.exit = () => {};
globalThis.process = proc;
export const process = proc;

// server/index.js 只用到 Buffer.byteLength 和 Buffer.from(字符串)。
class MiniBuffer extends Uint8Array {
  static from(value, encoding) {
    if (typeof value === 'string') {
      const bytes = encoding === 'utf8' || !encoding
        ? new TextEncoder().encode(value)
        : new TextEncoder().encode(value);
      return new MiniBuffer(bytes);
    }
    return new MiniBuffer(value);
  }
  static byteLength(value) {
    return typeof value === 'string' ? new TextEncoder().encode(value).length : value?.length || 0;
  }
  toString(encoding) {
    return encoding === 'hex'
      ? [...this].map(b => b.toString(16).padStart(2, '0')).join('')
      : new TextDecoder().decode(this);
  }
}
globalThis.Buffer = globalThis.Buffer || MiniBuffer;
export const Buffer = globalThis.Buffer;
