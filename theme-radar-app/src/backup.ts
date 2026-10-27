import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {openSync,closeSync,readSync,lstatSync,mkdirSync,mkdtempSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from './store.ts';
import {RadarError} from './model.ts';

const columns:Record<string,string[]>={
  subscriptions:['id','revision','data','updated_at'],items:['key','platform','external_id','title','body_hash','data','updated_at'],
  evidence:['id','item_key','kind','body_hash','body','data'],assessments:['id','item_key','topic_id','topic_revision','data','created_at'],
  events:['id','item_key','kind','old_hash','new_hash','created_at'],groups:['id','reason'],group_members:['group_id','item_key'],
  jobs:['id','state','owner','token','expires_at','data','updated_at'],deliveries:['id','channel','recipient','state','body_hash','body','receipt','updated_at'],
  rankings:['id','observed_at','data'],recommendations:['item_key','fingerprint','delivery_id'],
  feedback:['id','item_key','topic_id','kind','rule','reverted','created_at','applied_revision','previous_topic','next_topic'],
  logs:['id','created_at','event','data'],cooldowns:['scope','retry_at','updated_at'],delivery_items:['delivery_id','item_key','fingerprint']
};
const names=Object.keys(columns),maxBytes=1024*1024*1024;
function regularFile(path:string){try{const info=lstatSync(path);return info.isFile()&&!info.isSymbolicLink()?info:null;}catch{return null;}}
function openBackup(path:string){
  const info=regularFile(path);if(!info)throw new RadarError('BACKUP_NOT_FOUND','备份不存在或不是普通本机文件');
  if(info.size>maxBytes)throw new RadarError('BACKUP_TOO_LARGE','当前恢复演练仅检查1GiB以内数据库');
  let fd:number|undefined;
  try{fd=openSync(path,'r');const header=Buffer.alloc(16);if(readSync(fd,header,0,16,0)!==16||header.toString('binary')!=='SQLite format 3\0')throw Error();}
  catch{throw new RadarError('INVALID_BACKUP','文件不是可识别的SQLite备份，未尝试迁移或修改');}
  finally{if(fd!==undefined)closeSync(fd);}
  try{const db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000;');return db;}
  catch{throw new RadarError('INVALID_BACKUP','备份数据库无法以只读方式打开');}
}
function validateDatabase(db:DatabaseSync){
  const version=Number((db.prepare('PRAGMA user_version').get() as any).user_version);
  if(version!==2)throw new RadarError('BACKUP_VERSION_UNSUPPORTED','恢复演练需要本工具V2数据库；不自动迁移旧版或较新版本');
  const schema=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as any[];
  if(schema.some(row=>row.type==='trigger'||row.type==='view'||/CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql||'')))throw new RadarError('INVALID_BACKUP_SCHEMA','备份包含本工具未使用的视图、触发器或虚拟表');
  const tables=schema.filter(row=>row.type==='table').map(row=>row.name);
  if(tables.length!==names.length||names.some(name=>!tables.includes(name)))throw new RadarError('INVALID_BACKUP_SCHEMA','数据库表结构不属于当前主题雷达账本');
  for(const name of names){const actual=db.prepare(`PRAGMA table_info("${name}")`).all().map((row:any)=>row.name);if(JSON.stringify(actual)!==JSON.stringify(columns[name]))throw new RadarError('INVALID_BACKUP_SCHEMA','数据库字段结构与当前版本不匹配');}
  const integrity=db.prepare('PRAGMA quick_check').all();if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new RadarError('BACKUP_INTEGRITY_FAILED','备份完整性或关联检查未通过，未修改原备份');
}
/** Row digests are streamed; no titles, bodies, recipients or tokens enter the report. */
function snapshot(db:DatabaseSync){
  const counts:Record<string,number>={},digests:Record<string,string>={};
  for(const name of names){const hash=createHash('sha256');let count=0;const order=columns[name].map(c=>'"'+c+'"').join(',');
    for(const row of db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).iterate()){hash.update(JSON.stringify(row)+'\n');count++;}
    counts[name]=count;digests[name]=hash.digest('hex');
  }return {counts,digests};
}
export function inspectBackup(path:string){const db=openBackup(resolve(path));try{validateDatabase(db);return {schemaVersion:2,integrity:'ok',...snapshot(db)};}catch(error){if(error instanceof RadarError)throw error;throw new RadarError('INVALID_BACKUP','备份检查未完成；未返回数据库错误原文');}finally{db.close();}}

/** A rehearsal never activates or replaces a database. Temporary files are removed. */
export function rehearseBackup(path:string){
  const source=openBackup(resolve(path)),scratchRoot=resolve(tmpdir());
  let copy:Store|undefined,scratch:string|undefined;
  try{
    scratch=mkdtempSync(join(scratchRoot,'theme-radar-restore-'));
    // VACUUM INTO runs outside a transaction. Compare the fixed source before and
    // after copying; concurrent source changes invalidate the rehearsal.
    validateDatabase(source);const before=snapshot(source),target=join(scratch,'rehearsal.sqlite');
    source.prepare('VACUUM INTO ?').run(target);copy=new Store(target);validateDatabase(copy.db);
    const recovered=snapshot(copy.db),after=snapshot(source);
    if(JSON.stringify(before)!==JSON.stringify(recovered)||JSON.stringify(before)!==JSON.stringify(after))throw new RadarError('BACKUP_CHANGED','备份在演练期间发生变化或复制不一致；请使用固定备份重新检查');
    const reconciled=copy.recoverDeliveries();
    const retired=copy.db.prepare("UPDATE jobs SET state='cancelled',owner=NULL,token=NULL,expires_at=0 WHERE state='running'").run().changes;
    const confirmedBefore=source.prepare("SELECT count(*) n FROM deliveries WHERE state='sent_confirmed'").get() as any;
    const confirmedAfter=copy.db.prepare("SELECT count(*) n FROM deliveries WHERE state='sent_confirmed'").get() as any;
    if(confirmedBefore.n!==confirmedAfter.n)throw new RadarError('BACKUP_INTEGRITY_FAILED','演练中已确认送达记录不一致');
    validateDatabase(copy.db);
    return {ok:true,scope:'isolated_database_recovery_rehearsal',schemaVersion:2,integrity:'ok',allRowsMatched:true,counts:before.counts,
      tablesVerified:names.length,submittingMarkedUncertain:Number(reconciled),runningLeasesRetired:Number(retired),confirmedDeliveriesPreserved:Number(confirmedAfter.n),
      sourceModified:false,activeDatabaseReplaced:false,emailSent:false,temporaryCopyRemoved:true,
      note:'只在临时副本中演练，原备份与正式数据库保留。旧备份不包含后续投递，真正切换前需核对完整投递记录；不自动恢复或重发。'};
  }catch(error){if(error instanceof RadarError)throw error;throw new RadarError('BACKUP_REHEARSAL_FAILED','隔离恢复演练未完成；原数据库与备份均未替换');}
  finally{copy?.close();source.close();if(scratch&&dirname(scratch)===scratchRoot&&basename(scratch).startsWith('theme-radar-restore-'))rmSync(scratch,{recursive:true,force:true});}
}
function backupDirectory(dataDir:string,create=false){const dir=resolve(dataDir,'backups');if(create)mkdirSync(dir,{recursive:true});try{if(lstatSync(dir).isSymbolicLink()||!lstatSync(dir).isDirectory())throw Error();}catch{throw new RadarError('BACKUP_DIRECTORY_UNAVAILABLE','本机备份目录不可用');}return dir;}
export function managedBackupPath(dataDir:string,name:unknown){
  if(typeof name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,149}\.sqlite$/.test(name))throw new RadarError('INVALID_BACKUP_NAME','请选择备份列表中的sqlite文件');
  const folder=backupDirectory(dataDir),file=resolve(folder,name);if(dirname(file)!==folder||!regularFile(file))throw new RadarError('BACKUP_NOT_FOUND','备份文件不存在');return file;
}
export function listBackups(dataDir:string){
  if(!existsSync(resolve(dataDir,'backups')))return {backups:[],total:0,scope:'database_only',limit:100,note:'数据库备份不包含登录、模型、配置、模板或尚未投递的冻结样张文件。'};
  const folder=backupDirectory(dataDir);
  const rows=readdirSync(folder).filter(name=>/^[A-Za-z0-9][A-Za-z0-9_.-]{0,149}\.sqlite$/.test(name)).flatMap(name=>{const info=regularFile(join(folder,name));return info?[{name,bytes:info.size,createdAt:info.mtime.toISOString()}]:[];}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return {backups:rows.slice(0,100),total:rows.length,limit:100,scope:'database_only',note:'备份含本机主题、档案、判断及投递去重；不含登录、模型、配置、模板或尚未投递的冻结样张文件。备份含个人内容，请勿放入公开仓库。'};
}
export function createManagedBackup(store:Store,dataDir:string){const folder=backupDirectory(dataDir,true),name='radar-'+new Date().toISOString().replace(/[-:.]/g,'')+'-'+randomUUID().slice(0,8)+'.sqlite';store.backup(join(folder,name));return {name,scope:'database_only',...(inspectBackup(join(folder,name))),emailSent:false};}
