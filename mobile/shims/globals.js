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

// 请求体、登录摘要与地图图片需要的 Buffer 子集。
class MiniBuffer extends Uint8Array {
  static from(value, encoding) {
    if (typeof value === 'string') {
      const bytes = encoding === 'hex'
        ? Uint8Array.from(value.match(/.{2}/g) || [], pair => parseInt(pair, 16))
        : new TextEncoder().encode(value);
      return new MiniBuffer(bytes);
    }
    return new MiniBuffer(value);
  }
  static byteLength(value) {
    return typeof value === 'string' ? new TextEncoder().encode(value).length : value?.length || 0;
  }
  equals(other) {
    return this.length === other.length && this.every((byte, i) => byte === other[i]);
  }
  toString(encoding) {
    if (encoding === 'base64') {
      let binary = '';
      for (let i = 0; i < this.length; i += 8192) binary += String.fromCharCode(...this.subarray(i, i + 8192));
      return btoa(binary);
    }
    return encoding === 'hex'
      ? [...this].map(b => b.toString(16).padStart(2, '0')).join('')
      : new TextDecoder().decode(this);
  }
}
globalThis.Buffer = globalThis.Buffer || MiniBuffer;
export const Buffer = globalThis.Buffer;
