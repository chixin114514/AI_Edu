import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function createStore(path) {
  if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
  const db=new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, owner TEXT, value TEXT, PRIMARY KEY(kind,id));');
  db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','admin')), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_expiry ON auth_sessions(expires_at);`);
  return {
    userByName(username){return db.prepare('SELECT * FROM users WHERE username=?').get(username);},
    createUser(user){db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id,user.username,user.password_hash,user.role,user.created_at);return user;},
    saveLogin(hash,userId,expires){db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(Date.now());db.prepare('INSERT INTO auth_sessions VALUES (?,?,?)').run(hash,userId,expires);},
    loginUser(hash){return db.prepare('SELECT u.id,u.username,u.role FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hash,Date.now());},
    deleteLogin(hash){db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash);},
    claimGuest(guest,userId){db.prepare('UPDATE records SET owner=? WHERE owner=?').run('user:'+userId,guest);},
    get(kind,id,owner){const r=db.prepare('SELECT value,owner FROM records WHERE kind=? AND id=?').get(kind,id);return r&&(!owner||r.owner===owner)?JSON.parse(r.value):null;},
    put(kind,value,owner){db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind,value.id,owner,JSON.stringify(value));return value;},
    list(kind,owner){return (owner?db.prepare('SELECT value FROM records WHERE kind=? AND owner=?').all(kind,owner):db.prepare('SELECT value FROM records WHERE kind=?').all(kind)).map(r=>JSON.parse(r.value));},
    delete(kind,id,owner){db.prepare('DELETE FROM records WHERE kind=? AND id=? AND owner=?').run(kind,id,owner);},
    deleteOwner(owner){db.prepare('DELETE FROM records WHERE owner=?').run(owner);},
    close(){db.close();}
  };
}
