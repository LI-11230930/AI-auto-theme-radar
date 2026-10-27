import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.ts';import {item,evidence,topic} from './fixtures.ts';
import {inspectBackup,rehearseBackup,createManagedBackup,listBackups,managedBackupPath} from '../src/backup.ts';

function setup(t:any){const root=mkdtempSync(join(tmpdir(),'radar-backup-test-')),store=new Store(join(root,'active.sqlite'));store.saveTopic(topic);store.capture(item,[evidence]);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,store};}
test('在线账本可生成本机数据库快照，恢复逐表逐行一致，不激活或替换正式库',t=>{
 const {root,store}=setup(t);store.prepareDelivery('prepared','email','private@example.test','private frozen body',[item.key]);
 const backup=createManagedBackup(store,root),path=managedBackupPath(root,backup.name),before=readFileSync(path),active=store.stats();
 assert.equal(backup.integrity,'ok');assert.equal(listBackups(root).backups.length,1);assert.equal(inspectBackup(path).counts.subscriptions,1);
 const report=rehearseBackup(path);assert.equal(report.allRowsMatched,true);assert.equal(report.tablesVerified,15);assert.equal(report.activeDatabaseReplaced,false);assert.equal(report.temporaryCopyRemoved,true);assert.equal(report.emailSent,false);
 assert.deepEqual(store.stats(),active);assert.deepEqual(readFileSync(path),before);assert.equal(store.delivery('prepared').state,'prepared');
 assert.doesNotMatch(JSON.stringify(report),/private@example|private frozen body/);assert.ok(!JSON.stringify(report).includes(root));
});
test('隔离副本将发送中记录标为不确定，作废旧运行租约；原库状态和已送达保留',t=>{
 const {root,store}=setup(t);for(const id of ['sending','confirmed','pending'])store.prepareDelivery(id,'email','reader@example.test',id);
 assert.equal(store.beginDelivery('sending'),true);assert.equal(store.beginDelivery('confirmed'),true);store.transitionDelivery('confirmed','submitted',{id:'fixture receipt'});store.transitionDelivery('confirmed','sent_confirmed',{id:'fixture receipt'});
 const lease=store.claim('active-round','fixture',120000),backup=createManagedBackup(store,root),path=managedBackupPath(root,backup.name),before=inspectBackup(path);
 const report=rehearseBackup(path);assert.equal(report.submittingMarkedUncertain,1);assert.equal(report.runningLeasesRetired,1);assert.equal(report.confirmedDeliveriesPreserved,1);
 assert.equal(store.job('active-round').token,lease.token);assert.equal(store.job('active-round').state,'running');assert.equal(store.delivery('sending').state,'submitting');assert.equal(store.delivery('confirmed').state,'sent_confirmed');assert.deepEqual(inspectBackup(path),before);
});
test('损坏或非主题雷达SQLite不创建新账本、不迁移原文件',t=>{
 const {root}=setup(t);const text=join(root,'not-sqlite.sqlite');writeFileSync(text,'not a database, private text');assert.throws(()=>rehearseBackup(text),(e:any)=>e.code==='INVALID_BACKUP');assert.equal(readFileSync(text,'utf8'),'not a database, private text');
 const foreign=join(root,'foreign.sqlite'),db=new DatabaseSync(foreign);db.exec('CREATE TABLE unrelated(id INTEGER); PRAGMA user_version=2');db.close();const before=readFileSync(foreign);assert.throws(()=>inspectBackup(foreign),(e:any)=>e.code==='INVALID_BACKUP_SCHEMA');assert.deepEqual(readFileSync(foreign),before);
 assert.throws(()=>inspectBackup(join(root,'missing.sqlite')),(e:any)=>e.code==='BACKUP_NOT_FOUND');assert.equal(existsSync(join(root,'missing.sqlite')),false);
});
test('旧版或较新schema明确拒绝，不在检查时自动迁移',t=>{
 const {root,store}=setup(t);const path=store.backup(join(root,'future.sqlite'));let db=new DatabaseSync(path);db.exec('PRAGMA user_version=99');db.close();const before=readFileSync(path);assert.throws(()=>rehearseBackup(path),(e:any)=>e.code==='BACKUP_VERSION_UNSUPPORTED');assert.deepEqual(readFileSync(path),before);
 db=new DatabaseSync(path);db.exec('PRAGMA user_version=1');db.close();assert.throws(()=>inspectBackup(path),(e:any)=>e.code==='BACKUP_VERSION_UNSUPPORTED');
});
test('外键缺失、额外触发器或篡改列结构不能被记为可恢复',t=>{
 const {root,store}=setup(t);
 for(const [name,sql] of [['fk','PRAGMA foreign_keys=OFF; DELETE FROM items;'],['trigger','CREATE TRIGGER unexpected AFTER INSERT ON logs BEGIN DELETE FROM logs; END;'],['columns','ALTER TABLE logs ADD COLUMN unexpected TEXT;']]){
  const path=store.backup(join(root,name+'.sqlite')),db=new DatabaseSync(path);db.exec(sql);db.close();assert.throws(()=>inspectBackup(path),(e:any)=>['BACKUP_INTEGRITY_FAILED','INVALID_BACKUP_SCHEMA'].includes(e.code));
 }
});
test('托管列表限定普通sqlite文件，名称不能逃出目录，原备份不可覆盖',t=>{
 const {root,store}=setup(t);assert.equal(listBackups(root).total,0);const backup=createManagedBackup(store,root);mkdirSync(join(root,'backups','folder.sqlite'));writeFileSync(join(root,'backups','notes.txt'),'ignored');assert.equal(listBackups(root).total,1);
 for(const name of ['../active.sqlite','..\\active.sqlite','/absolute.sqlite','name.sqlite-wal',null])assert.throws(()=>managedBackupPath(root,name),(e:any)=>e.code==='INVALID_BACKUP_NAME');
 assert.throws(()=>store.backup(managedBackupPath(root,backup.name)),(e:any)=>e.code==='BACKUP_EXISTS');
});
test('演练无网络，临时副本清理，失败也保留原备份',t=>{
 const {root,store}=setup(t),backup=createManagedBackup(store,root),path=managedBackupPath(root,backup.name),fetcher=globalThis.fetch;
 globalThis.fetch=async()=>{throw new Error('must stay offline');};try{const report=rehearseBackup(path);assert.equal(report.ok,true);assert.equal(report.temporaryCopyRemoved,true);}finally{globalThis.fetch=fetcher;}
});
