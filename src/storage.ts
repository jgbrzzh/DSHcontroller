import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATE, type Obj } from './common.js';
export class Store {
  readonly db:DatabaseSync;
  constructor(path=resolve(STATE,'controller.sqlite')) {
    if(path!==':memory:')mkdirSync(STATE,{recursive:true});
    this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));');
  }
  get<T=Obj>(kind:string,id:string):T|undefined {const row=this.db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(String(row.data)):undefined;}
  put(kind:string,id:string,value:any){this.db.prepare('INSERT INTO entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,id,JSON.stringify(value));}
  list<T=Obj>(kind:string):T[]{return this.db.prepare('SELECT data FROM entities WHERE kind=?').all(kind).map(row=>JSON.parse(String(row.data)));}
  close(){this.db.close();}
}
