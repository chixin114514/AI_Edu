import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function createStore(path) {
  if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
  const db=new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, owner TEXT, value TEXT, PRIMARY KEY(kind,id));');
  return {
    get(kind,id,owner){const r=db.prepare('SELECT value,owner FROM records WHERE kind=? AND id=?').get(kind,id);return r&&(!owner||r.owner===owner)?JSON.parse(r.value):null;},
    put(kind,value,owner){db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind,value.id,owner,JSON.stringify(value));return value;},
    list(kind,owner){return (owner?db.prepare('SELECT value FROM records WHERE kind=? AND owner=?').all(kind,owner):db.prepare('SELECT value FROM records WHERE kind=?').all(kind)).map(r=>JSON.parse(r.value));},
    deleteOwner(owner){db.prepare('DELETE FROM records WHERE owner=?').run(owner);},
    close(){db.close();}
  };
}
