// node:path 替身。只需要 index.js 用到的 resolve / extname，
// 顺带补几个常用函数，语义贴近 POSIX 实现。
export const sep = '/';

export function extname(p = '') {
  const base = String(p).split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

export function normalize(p = '') {
  const absolute = String(p).startsWith('/');
  const out = [];
  for (const part of String(p).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!absolute) out.push('..'); continue; }
    out.push(part);
  }
  return (absolute ? '/' : '') + out.join('/') || (absolute ? '/' : '.');
}

export function join(...parts) {
  return normalize(parts.filter(p => p != null && p !== '').join('/'));
}

export function resolve(...parts) {
  let out = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part == null || part === '') continue;
    out = `${part}/${out}`;
    if (String(part).startsWith('/')) break;
  }
  return normalize(out.startsWith('/') ? out : `/${out}`);
}

export function dirname(p = '') {
  const s = String(p);
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  return i === 0 ? '/' : s.slice(0, i);
}

export function basename(p = '') {
  return String(p).split('/').pop() || '';
}

export default { sep, extname, normalize, join, resolve, dirname, basename };
