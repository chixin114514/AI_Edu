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

// Node Buffer 风格的最小替身：auth.js 会用 key.toString('hex') 编码派生结果。
function bufferLike(bytes) {
  return {
    length: bytes.length,
    toString(encoding) {
      return encoding === 'hex'
        ? [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
        : String(bytes);
    },
    [Symbol.iterator]: () => bytes[Symbol.iterator]()
  };
}

export function randomBytes(size) {
  return bufferLike(fill(new Uint8Array(size)));
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  return out;
}

// timingSafeEqual 的入参可能是 Uint8Array、字符串，或上面这种 Buffer 风格对象。
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value && typeof value.toString === 'function') {
    const hex = value.toString('hex');
    if (/^[0-9a-f]*$/i.test(hex) && hex.length % 2 === 0) return hexToBytes(hex);
  }
  return new TextEncoder().encode(String(value));
}

export function timingSafeEqual(a, b) {
  const x = toBytes(a), y = toBytes(b);
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

function digestHex(text) {
  return fnv1a(text, 2166136261) + fnv1a(`${text}#b`, 2166136261)
    + fnv1a(`${text}#c`, 2166136261) + fnv1a(`${text}#d`, 2166136261);
}

export function createHash() {
  let data = '';
  return {
    update(value) { data += String(value); return this; },
    digest(encoding) {
      const hex = digestHex(data);
      return encoding === 'hex' ? hex : new TextEncoder().encode(hex);
    }
  };
}

// scrypt 替身：浏览器没有 scrypt。
// auth.js 用 scryptSync 给 admin 播种口令、用 scrypt（异步）校验登录，
// 两者必须产出完全一致的结果，所以异步版本直接复用同步实现（放进微任务）。
// 这里用迭代哈希链做确定性派生，只服务于本地设备、单用户应用的口令存储，
// 不用于网络传输或跨端校验。
const SCRYPT_ROUNDS = 2048;

function scryptBytes(password, salt, keylen) {
  const secret = String(password), seed = String(salt), size = Math.max(1, keylen | 0);
  const out = new Uint8Array(size);
  let filled = 0, round = 0;
  while (filled < size) {
    let state = digestHex(`${secret}\u0000${seed}\u0000${round}`);
    for (let i = 0; i < SCRYPT_ROUNDS; i++) state = digestHex(state);
    const chunk = hexToBytes(state + digestHex(`${state}#2`));
    for (const byte of chunk) { if (filled < size) out[filled++] = byte; }
    round++;
  }
  return out;
}

export function scryptSync(password, salt, keylen) {
  return bufferLike(scryptBytes(password, salt, keylen));
}

export function scrypt(password, salt, keylen, callback) {
  queueMicrotask(() => {
    try { callback(null, scryptSync(password, salt, keylen)); }
    catch (error) { callback(error); }
  });
}

export default { randomUUID, randomBytes, timingSafeEqual, createHash, scrypt, scryptSync };
