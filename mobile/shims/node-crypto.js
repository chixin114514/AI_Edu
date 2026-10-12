// node:crypto 替身。
// 说明：项目里 createHash 只用于缓存 id 和密钥指纹（providers.js 的 fingerprint、
// maps.js 的图片缓存 id），不做签名或安全校验，因此这里用确定性的 FNV-1a 组合，
// 不引入同步 SHA-256 实现。randomUUID / randomBytes / timingSafeEqual 走 WebCrypto。

export function randomUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = fill(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function fill(bytes) {
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function randomBytes(size) {
  const bytes = fill(new Uint8Array(size));
  return {
    length: size,
    toString(encoding) {
      return encoding === 'hex'
        ? [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
        : String(bytes);
    },
    [Symbol.iterator]: () => bytes[Symbol.iterator]()
  };
}

export function timingSafeEqual(a, b) {
  const x = a instanceof Uint8Array ? a : Uint8Array.from(String(a));
  const y = b instanceof Uint8Array ? b : Uint8Array.from(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function fnv1a(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createHash() {
  let data = '';
  return {
    update(value) { data += String(value); return this; },
    digest(encoding) {
      const hex = fnv1a(data, 2166136261) + fnv1a(`${data}#b`, 2166136261)
        + fnv1a(`${data}#c`, 2166136261) + fnv1a(`${data}#d`, 2166136261);
      return encoding === 'hex' ? hex : new TextEncoder().encode(hex);
    }
  };
}

export default { randomUUID, randomBytes, timingSafeEqual, createHash };
