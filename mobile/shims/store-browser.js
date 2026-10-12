// server/store.js 的设备端替身。
// 原实现用 node:sqlite，App 内没有 SQLite 运行时；这里用 localStorage 实现
// 完全相同的五个方法（get / put / list / deleteOwner / close），
// 数据结构与 owner 隔离语义保持一致，因此服务器代码无需改动。
const NS = 'mx-rec:';

const recKey = (kind, id) => `${NS}${kind}::${id}`;

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function keysOf(kind) {
  const prefix = `${NS}${kind}::`;
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) out.push(key);
  }
  return out;
}

export function createStore() {
  return {
    get(kind, id, owner) {
      const record = read(recKey(kind, id));
      return record && (!owner || record.owner === owner) ? record.value : null;
    },
    put(kind, value, owner) {
      localStorage.setItem(recKey(kind, value.id), JSON.stringify({ owner, value }));
      return value;
    },
    list(kind, owner) {
      const out = [];
      for (const key of keysOf(kind)) {
        const record = read(key);
        if (record && (!owner || record.owner === owner)) out.push(record.value);
      }
      return out;
    },
    deleteOwner(owner) {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(NS)) continue;
        const record = read(key);
        if (record && record.owner === owner) doomed.push(key);
      }
      for (const key of doomed) localStorage.removeItem(key);
    },
    close() {}
  };
}

export default { createStore };
