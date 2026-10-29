import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.ts';import {inspectBackup,rehearseBackup} from '../src/backup.ts';
import {item,evidence,topic} from './fixtures.ts';

const cases=[
 ['missing-primary-key',"DROP TABLE jobs; CREATE TABLE jobs(id TEXT,state TEXT NOT NULL,owner TEXT,token TEXT,expires_at INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,updated_at TEXT NOT NULL)"],
 ['missing-unique-key',"DROP TABLE items; CREATE TABLE items(key TEXT PRIMARY KEY,platform TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,body_hash TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL)"],
 ['missing-foreign-key',"DROP TABLE evidence; CREATE TABLE evidence(id TEXT PRIMARY KEY,item_key TEXT NOT NULL,kind TEXT NOT NULL,body_hash TEXT NOT NULL,body TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(item_key,kind,body_hash))"],
 ['changed-column-type',"DROP TABLE logs; CREATE TABLE logs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL)"],
 ['changed-nullability',"DROP TABLE logs; CREATE TABLE logs(id INTEGER PRIMARY KEY,created_at TEXT,event TEXT NOT NULL,data TEXT NOT NULL)"],
 ['changed-default',"DROP TABLE jobs; CREATE TABLE jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,owner TEXT,token TEXT,expires_at INTEGER NOT NULL DEFAULT 99,data TEXT NOT NULL,updated_at TEXT NOT NULL)"],
 ['extra-unique-index',"CREATE UNIQUE INDEX unexpected_log_event ON logs(event)"],
 ['partial-unique-key',"DROP TABLE items; CREATE TABLE items(key TEXT PRIMARY KEY,platform TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,body_hash TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE UNIQUE INDEX partial_identity ON items(platform,external_id) WHERE platform='github'"],
 ['generated-hidden-column',"ALTER TABLE logs ADD COLUMN hidden_extra TEXT GENERATED ALWAYS AS (event||data) VIRTUAL"],
 ['changed-key-collation',"DROP TABLE groups; CREATE TABLE groups(id TEXT PRIMARY KEY COLLATE NOCASE,reason TEXT NOT NULL)"],
 ['without-rowid',"DROP TABLE groups; CREATE TABLE groups(id TEXT PRIMARY KEY,reason TEXT NOT NULL) WITHOUT ROWID"]
];

for(const [name,sql] of cases)test('备份结构拒绝同列名但'+name+'，不修改源文件',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-backup-contract-')),file=join(root,'fixture.sqlite');try{const store=new Store(file);store.close();const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=OFF;'+sql);assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check,'ok');db.close();const old=readFileSync(file);assert.throws(()=>inspectBackup(file),{code:'INVALID_BACKUP_SCHEMA'});assert.throws(()=>rehearseBackup(file),{code:'INVALID_BACKUP_SCHEMA'});assert.deepEqual(readFileSync(file),old);}finally{rmSync(root,{recursive:true,force:true});}
});

test('普通非唯一性能索引不改变备份约束契约，可检查和隔离恢复',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-backup-index-')),file=join(root,'fixture.sqlite');try{const store=new Store(file);store.db.exec('CREATE INDEX log_lookup ON logs(event,created_at)');store.close();const old=readFileSync(file);assert.equal(inspectBackup(file).integrity,'ok');assert.equal(rehearseBackup(file).allRowsMatched,true);assert.deepEqual(readFileSync(file),old);}finally{rmSync(root,{recursive:true,force:true});}
});

test('等价唯一索引不按任意名字误拒绝，仍检查排序与列',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-backup-equivalent-')),file=join(root,'fixture.sqlite');try{const store=new Store(file);store.close();const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=OFF; DROP TABLE items; CREATE TABLE items(key TEXT PRIMARY KEY,platform TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,body_hash TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE UNIQUE INDEX renamed_identity ON items(platform,external_id)');db.close();assert.equal(inspectBackup(file).integrity,'ok');assert.equal(rehearseBackup(file).allRowsMatched,true);}finally{rmSync(root,{recursive:true,force:true});}
});

test('自动下一原P2-01：真实V1迁移生成的V2结构仍接受，原数据逐表保留',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-backup-migrated-')),file=join(root,'fixture.sqlite');let store:Store|undefined;
 try{store=new Store(file);store.saveTopic(topic);store.capture(item,[evidence]);store.prepareDelivery('preserved','email','reader@example.test','frozen',[item.key]);
  store.db.exec("ALTER TABLE events RENAME TO current_events; CREATE TABLE events(id TEXT PRIMARY KEY,item_key TEXT NOT NULL REFERENCES items(key),kind TEXT NOT NULL,old_hash TEXT,new_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(item_key,kind,new_hash)); INSERT INTO events SELECT * FROM current_events; DROP TABLE current_events; DROP TABLE cooldowns; DROP TABLE delivery_items; PRAGMA user_version=1;");store.close();store=undefined;
  store=new Store(file);assert.equal(store.delivery('preserved').body,'frozen');assert.equal(store.deliveryItems('preserved').length,1);assert.equal(store.currentEvidence(item.key).length,1);store.close();store=undefined;
  const old=readFileSync(file),report=rehearseBackup(file);assert.equal(report.allRowsMatched,true);assert.equal(report.tablesVerified,15);assert.equal(report.counts.items,1);assert.deepEqual(readFileSync(file),old);
 }finally{store?.close();rmSync(root,{recursive:true,force:true});}
});
