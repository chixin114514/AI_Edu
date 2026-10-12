// server/store.js 的设备端替身。
// 原实现用 node:sqlite，App 内没有 SQLite 运行时；这里用 localStorage 复刻
// 完全相同的接口（records 的 get/put/list/deleteOwner/close，以及账号体系的
// userByName/createUser/saveLogin/loginUser/deleteLogin/claimGuest），
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
  // 账号体系单独命名空间，避免与 kind 为 'session' 的漫游会话记录串味。
  const userKey = id => `${NS}user::${id}`;
  const authKey = hash => `${NS}auth::${hash}`;

  const users = () => {
    const out = [];
    for (const key of keysOf('user')) {
      const user = read(key);
      if (user) out.push(user);
    }
    return out;
  };

  return {
    userByName(username) {
      return users().find(u => u.username === username) || null;
    },
    createUser(user) {
      localStorage.setItem(userKey(user.id), JSON.stringify(user));
      return user;
    },
    saveLogin(hash, userId, expires) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(`${NS}auth::`)) continue;
        const record = read(key);
        if (record && record.expires_at <= Date.now()) localStorage.removeItem(key);
      }
      localStorage.setItem(authKey(hash), JSON.stringify({ user_id: userId, expires_at: expires }));
    },
    loginUser(hash) {
      const record = read(authKey(hash));
      if (!record || record.expires_at <= Date.now()) return null;
      const user = read(userKey(record.user_id));
      return user ? { id: user.id, username: user.username, role: user.role } : null;
    },
    deleteLogin(hash) {
      localStorage.removeItem(authKey(hash));
    },
    claimGuest(guest, userId) {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(NS) || key.startsWith(`${NS}auth::`) || key.startsWith(`${NS}user::`)) continue;
        const record = read(key);
        if (record && record.owner === guest) doomed.push([key, record]);
      }
      for (const [key, record] of doomed) localStorage.setItem(key, JSON.stringify({ owner: `user:${userId}`, value: record.value }));
    },
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
