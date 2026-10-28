import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, now, normalizeText, repoReferences, RadarError, validateCoverage, validateTopic, requireText,readableEvidence } from './model.ts';
import type { Assessment, Evidence, Item, Topic, Ranking } from './model.ts';
import {metricDelta} from './interaction-metrics.ts';
import {sourceTimestamp} from './selection.ts';
import {batchAt} from './time.ts';
import {isEmailAddress} from './email-address.ts';
import {feedbackTopic} from './topic-preferences.ts';

export type BrowserObservationGuard={topicId:string;topicRevision:number;authorUid:string;readingSnapshot:string;page:number;duration:number};

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if(file!==':memory:')mkdirSync(dirname(file),{recursive:true});
    this.db=new DatabaseSync(file);
    try{this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      if(file!==':memory:'&&Number((this.db.prepare('PRAGMA user_version').get() as any).user_version)===1)this.backup(file+'.before-v2-'+Date.now()+'-'+randomUUID().slice(0,8)+'.sqlite');
      this.migrate();
    }catch(error){this.db.close();throw error;}
  }
  migrate() {
    const version=Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if(version>2)throw new RadarError('SCHEMA_NEWER','数据库版本高于当前程序');
    if(version===2)return;
    if(version===0)this.tx(()=>this.db.exec(`
      CREATE TABLE subscriptions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE items(key TEXT PRIMARY KEY,platform TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,body_hash TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(platform,external_id));
      CREATE TABLE evidence(id TEXT PRIMARY KEY,item_key TEXT NOT NULL REFERENCES items(key),kind TEXT NOT NULL,body_hash TEXT NOT NULL,body TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(item_key,kind,body_hash));
      CREATE TABLE assessments(id TEXT PRIMARY KEY,item_key TEXT NOT NULL REFERENCES items(key),topic_id TEXT NOT NULL REFERENCES subscriptions(id),topic_revision INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE events(id TEXT PRIMARY KEY,item_key TEXT NOT NULL REFERENCES items(key),kind TEXT NOT NULL,old_hash TEXT,new_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(item_key,kind,new_hash));
      CREATE TABLE groups(id TEXT PRIMARY KEY,reason TEXT NOT NULL);
      CREATE TABLE group_members(group_id TEXT NOT NULL REFERENCES groups(id),item_key TEXT NOT NULL REFERENCES items(key),PRIMARY KEY(group_id,item_key));
      CREATE TABLE jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,owner TEXT,token TEXT,expires_at INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE deliveries(id TEXT PRIMARY KEY,channel TEXT NOT NULL,recipient TEXT NOT NULL,state TEXT NOT NULL,body_hash TEXT NOT NULL,body TEXT NOT NULL,receipt TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE rankings(id TEXT PRIMARY KEY,observed_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE recommendations(item_key TEXT NOT NULL REFERENCES items(key),fingerprint TEXT NOT NULL,delivery_id TEXT NOT NULL REFERENCES deliveries(id),PRIMARY KEY(item_key,fingerprint));
      CREATE TABLE feedback(id TEXT PRIMARY KEY,item_key TEXT NOT NULL REFERENCES items(key),topic_id TEXT NOT NULL REFERENCES subscriptions(id),kind TEXT NOT NULL,rule TEXT NOT NULL,reverted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,applied_revision INTEGER,previous_topic TEXT,next_topic TEXT);
      CREATE TABLE logs(id INTEGER PRIMARY KEY,created_at TEXT NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL);
      PRAGMA user_version=1;
    `));
    this.tx(()=>this.db.exec(`
      ALTER TABLE events RENAME TO events_v1;
      CREATE TABLE events(id TEXT PRIMARY KEY,item_key TEXT NOT NULL REFERENCES items(key),kind TEXT NOT NULL,old_hash TEXT,new_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      INSERT INTO events SELECT * FROM events_v1;
      DROP TABLE events_v1;
      CREATE TABLE cooldowns(scope TEXT PRIMARY KEY,retry_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE delivery_items(delivery_id TEXT NOT NULL REFERENCES deliveries(id),item_key TEXT NOT NULL REFERENCES items(key),fingerprint TEXT NOT NULL,PRIMARY KEY(delivery_id,item_key));
      INSERT INTO delivery_items SELECT delivery_id,item_key,fingerprint FROM recommendations;
      PRAGMA user_version=2;
    `));
  }
  close(){this.db.close();}
  tx<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  log(event: string,data: Record<string,unknown>={}) {
    const safe=JSON.stringify(data,(_key,value)=>typeof value==='string'?value.replace(/(Bearer\s+)[\w.\-]+/gi,'$1[redacted]').replace(/((?:SESSDATA|bili_jct|password|access_token|refresh_token|authorization)["'\s:=]+)[^\s,;"}]+/gi,'$1[redacted]'):value);
    this.db.prepare('INSERT INTO logs(created_at,event,data) VALUES(?,?,?)').run(now(),event,safe);
  }
  saveTopic(topic:Topic,expectedRevision?:number){validateTopic(topic);return this.tx(()=>{const old=this.db.prepare('SELECT revision FROM subscriptions WHERE id=?').get(topic.id) as any;if(expectedRevision!==undefined&&Number(old?.revision||0)!==expectedRevision)throw new RadarError('REVISION_CONFLICT','订阅已更新');const revision=Number(old?.revision||0)+1;this.db.prepare('INSERT INTO subscriptions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at').run(topic.id,revision,JSON.stringify(topic),now());return revision;});}
  topics(){return this.db.prepare('SELECT data,revision FROM subscriptions ORDER BY id').all().map((r:any)=>({...JSON.parse(r.data),revision:r.revision}));}
  capture(item:Item,evidences:Evidence[],guard?:()=>void) {
    if(!['github','bilibili','xiaohongshu'].includes(item.platform)||item.key!==`${item.platform}:${item.externalId}`)throw new RadarError('INVALID_ITEM','内容稳定键无效');
    requireText(item.title,'title');requireText(item.version,'version');
    evidences.forEach(e=>{if(e.itemKey!==item.key)throw new RadarError('INVALID_EVIDENCE','证据归属不一致');validateCoverage(e.coverage);if(typeof e.text!=='string')throw new RadarError('INVALID_EVIDENCE','正文必须为文本');});
    const currentEvidenceIds=evidences.map(e=>hash(`${item.key}:${e.kind}:${hash(e.text)}`));
    const storedItem:Item={...item,metadata:{...item.metadata,currentEvidenceIds}};
    delete storedItem.metadata.browserObservationBase;delete storedItem.metadata.browserObservationIds;
    const fingerprint=hash(normalizeText(JSON.stringify({title:item.title,version:item.version,materials:evidences.map(e=>{
      let text=e.text;
      if(e.kind==='repository-metadata'){try{const meta=JSON.parse(text);for(const key of ['pushed_at','updated_at','created_at','stargazers_count','forks_count','watchers_count'])delete meta[key];text=JSON.stringify(meta);}catch{}}
      return {kind:e.kind,text:normalizeText(text)};
    }).sort((a,b)=>a.kind.localeCompare(b.kind)||a.text.localeCompare(b.text))})));
    return this.tx(()=>{
      guard?.();
      const old=this.db.prepare('SELECT body_hash,data FROM items WHERE key=?').get(item.key) as any;
      if(item.platform==='bilibili'&&old?.body_hash===fingerprint){const previous=JSON.parse(old.data).metadata;if(previous?.browserObservationBase===fingerprint&&Array.isArray(previous.browserObservationIds)){storedItem.metadata.browserObservationBase=fingerprint;storedItem.metadata.browserObservationIds=previous.browserObservationIds;}}
      this.db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET title=excluded.title,body_hash=excluded.body_hash,data=excluded.data,updated_at=excluded.updated_at').run(item.key,item.platform,item.externalId,item.title,fingerprint,JSON.stringify(storedItem),now());
      const ids=evidences.map(e=>{const bodyHash=hash(e.text);const id=hash(`${item.key}:${e.kind}:${bodyHash}`);this.db.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?,?)').run(id,item.key,e.kind,bodyHash,e.text,JSON.stringify({...e,id,hash:bodyHash}));return id;});
      let change='unchanged';
      if(!old||old.body_hash!==fingerprint){const previous=old?JSON.parse(old.data):null;change=!old?'discovered':previous.version!==item.version?'version_changed':'content_changed';this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(randomUUID(),item.key,change,old?.body_hash||null,fingerprint,now());}
      const metrics=old?metricDelta(JSON.parse(old.data),storedItem):[];
      if(metrics.length){const eventId=randomUUID();this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(eventId,item.key,'metrics_changed',hash(JSON.stringify(metrics.map(m=>({field:m.field,value:m.before})))),hash(JSON.stringify(metrics.map(m=>({field:m.field,value:m.after})))),now());this.log('metrics_changed',{eventId,itemKey:item.key,changes:metrics});}
      const refs=new Set(repoReferences([item.url,...evidences.map(e=>e.text)].join('\n')));
      if(item.platform==='github')refs.add(item.externalId.toLowerCase());
      for(const repo of refs){const group='github:'+repo;this.db.prepare('INSERT OR IGNORE INTO groups VALUES(?,?)').run(group,'明确引用同一GitHub仓库；保留独立来源');this.db.prepare('INSERT OR IGNORE INTO group_members VALUES(?,?)').run(group,item.key);}
      return {key:item.key,evidenceIds:ids,change,fingerprint,metricsChanged:metrics.length>0};
    });
  }
  item(key:string){const row=this.db.prepare('SELECT data FROM items WHERE key=?').get(key) as any;return row?JSON.parse(row.data):null;}
  itemChanges(key:string,limit=30){
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new RadarError('INVALID_LIMIT','变化记录上限须为1至50');
    const rows=this.db.prepare('SELECT id,kind,old_hash,new_hash,created_at FROM events WHERE item_key=? ORDER BY rowid DESC LIMIT ?').all(key,limit+1) as any[];
    const events=rows.slice(0,limit).map(row=>{if(row.kind!=='metrics_changed')return {...row,metricsOnly:false};const detail=this.db.prepare("SELECT data FROM logs WHERE event='metrics_changed' AND json_extract(data,'$.eventId')=? ORDER BY id DESC LIMIT 1").get(row.id) as any;return {...row,metricsOnly:true,changes:detail?JSON.parse(detail.data).changes:[],note:'仅是两次取得的互动计数差异，不代表正文新价值，也不触发再次推荐。'};});
    return {events,limit,mayHaveMore:rows.length>limit,scope:'local_observations_only; historical unknown counts are not reconstructed'};
  }
  fingerprint(key:string){return (this.db.prepare('SELECT body_hash FROM items WHERE key=?').get(key) as any)?.body_hash||null;}
  evidence(key:string):Evidence[]{return this.db.prepare('SELECT data FROM evidence WHERE item_key=? ORDER BY rowid').all(key).map((r:any)=>JSON.parse(r.data));}
  currentEvidence(key:string):Evidence[]{const meta=this.item(key)?.metadata,ids=meta?.currentEvidenceIds;const all=this.evidence(key),observations=meta?.browserObservationBase===this.fingerprint(key)&&Array.isArray(meta?.browserObservationIds)?meta.browserObservationIds:[];return Array.isArray(ids)?all.filter(e=>ids.includes(e.id)||observations.includes(e.id)):all;}
  appendBrowserObservation(key:string,expectedFingerprint:string,evidences:Evidence[],guard?:BrowserObservationGuard){
    if(!key.startsWith('bilibili:')||!Array.isArray(evidences)||evidences.length!==2)throw new RadarError('INVALID_EVIDENCE','仅接收有界B站字幕观察');
    for(const e of evidences){if(e.itemKey!==key||!/^browser-subtitle(?:-observation)?:p\d+$/.test(e.kind)||typeof e.text!=='string')throw new RadarError('INVALID_EVIDENCE','观察材料归属无效');validateCoverage(e.coverage);}
    const page=/^browser-subtitle:p([1-9]\d*)$/.exec(evidences[0].kind)?.[1];
    if(!page||evidences[1].kind!=='browser-subtitle-observation:p'+page)throw new RadarError('INVALID_EVIDENCE','正文和范围清单必须来自同一个分P并成对导入');
    return this.tx(()=>{const row=this.db.prepare('SELECT body_hash,data FROM items WHERE key=?').get(key) as any;if(!row||row.body_hash!==expectedFingerprint)throw new RadarError('SOURCE_CHANGED','视频信息已变化，请重新核对后导入');
      // Check batch permissions under the same SQLite write lock as the append.
      // A different host may update subscriptions/materials after the bridge's early check.
      if(guard){
        const subscription=this.db.prepare('SELECT revision,data FROM subscriptions WHERE id=?').get(guard.topicId) as any;
        const topic=subscription?JSON.parse(subscription.data):null;
        if(!topic||subscription.revision!==guard.topicRevision||!topic.enabled||!topic.platforms?.includes('bilibili')||!topic.bilibiliAuthors?.includes(guard.authorUid))throw new RadarError('TOPIC_CHANGED','订阅已改变，没有保存过期采集材料');
        const archived=JSON.parse(row.data);
        if(archived.platform!=='bilibili'||archived.authorId!==guard.authorUid||this.readingSnapshot(key)!==guard.readingSnapshot)throw new RadarError('SOURCE_CHANGED','视频作者或阅读材料已改变，没有保存过期采集材料');
        const page=archived.metadata?.subtitlePages?.find((p:any)=>p.page===guard.page);
        if(!page||page.duration!==guard.duration)throw new RadarError('SOURCE_CHANGED','视频分P或时长已改变，没有保存过期采集材料');
      }
      const item=JSON.parse(row.data),ids=evidences.map(e=>hash(`${key}:${e.kind}:${hash(e.text)}`));
      const previous=item.metadata.browserObservationBase===expectedFingerprint?(item.metadata.browserObservationIds||[]):[];
      const replacedKinds=new Set(evidences.map(e=>e.kind)),superseded=this.evidence(key).filter(e=>previous.includes(e.id)&&replacedKinds.has(e.kind)).map(e=>e.id!);
      if(ids.every(id=>previous.includes(id))&&superseded.every(id=>ids.includes(id)))return {duplicate:true,evidenceIds:ids,contentFingerprintUnchanged:true,supersededEvidenceIds:[]};
      for(let n=0;n<evidences.length;n++){const e=evidences[n],id=ids[n],bodyHash=hash(e.text);this.db.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?,?)').run(id,key,e.kind,bodyHash,e.text,JSON.stringify({...e,id,hash:bodyHash}));}
      const baseIds=Array.isArray(item.metadata.currentEvidenceIds)?item.metadata.currentEvidenceIds:this.evidence(key).filter(e=>!e.kind.startsWith('browser-subtitle')).map(e=>e.id);
      const retained=previous.filter((id:string)=>!superseded.includes(id));
      item.metadata={...item.metadata,currentEvidenceIds:baseIds,browserObservationBase:expectedFingerprint,browserObservationIds:[...new Set([...retained,...ids])].slice(-20)};
      this.db.prepare('UPDATE items SET data=?,updated_at=? WHERE key=? AND body_hash=?').run(JSON.stringify(item),now(),key,expectedFingerprint);
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(randomUUID(),key,'browser_observation_added',expectedFingerprint,expectedFingerprint,now());
      return {duplicate:false,evidenceIds:ids,contentFingerprintUnchanged:true,supersededEvidenceIds:superseded.filter(id=>!ids.includes(id))};
    });
  }
  material(id:string):Evidence|null{const row=this.db.prepare('SELECT data FROM evidence WHERE id=?').get(id) as any;return row?JSON.parse(row.data):null;}
  readingSnapshot(key:string){return hash(JSON.stringify({fingerprint:this.fingerprint(key),evidenceIds:this.currentEvidence(key).map(e=>e.id).sort()}));}
  saveArchivedAssessment(topicId:string,revision:number,snapshot:string,assessment:Assessment,lease?:{id:string;token:string},commitGuard?:()=>void){return this.tx(()=>{
    commitGuard?.();
    if(lease)this.checkpoint(lease.id,lease.token,JSON.parse((this.job(lease.id) as any)?.data||'{}'),600000);
    const topic=this.topics().find(t=>t.id===topicId);
    if(!topic||topic.revision!==revision)throw new RadarError('TOPIC_CHANGED','分析期间主题已修改，请重新核对');
    if(this.readingSnapshot(assessment.itemKey)!==snapshot)throw new RadarError('SOURCE_CHANGED','分析期间材料已变化，未保存过期判断');
    const id=this.saveAssessment(topicId,assessment);if(lease)this.finish(lease.id,lease.token);return id;
  });}
  saveAssessment(topicId:string,assessment:Assessment){
    const topic=this.db.prepare('SELECT revision FROM subscriptions WHERE id=?').get(topicId) as any;
    if(!topic||!this.item(assessment.itemKey))throw new RadarError('NOT_FOUND','订阅或内容不存在');
    requireText(assessment.reason,'reason',4000);if(typeof assessment.selected!=='boolean'||!Array.isArray(assessment.readEvidenceIds)||!Array.isArray(assessment.limitations)||assessment.limitations.some(x=>typeof x!=='string'))throw new RadarError('INVALID_ASSESSMENT','判断结果格式无效');
    const available=new Set(this.currentEvidence(assessment.itemKey).filter(readableEvidence).map(e=>e.id));
    if(assessment.readEvidenceIds.some(id=>!available.has(id))||(assessment.selected&&!assessment.readEvidenceIds.length))throw new RadarError('INVALID_ASSESSMENT','推荐必须引用本条实际取得的证据');
    const id=randomUUID();this.db.prepare('INSERT INTO assessments VALUES(?,?,?,?,?,?)').run(id,assessment.itemKey,topicId,topic.revision,JSON.stringify({...assessment,itemFingerprint:this.fingerprint(assessment.itemKey)}),now());return id;
  }
  assessments(topicId:string){return this.db.prepare('SELECT data,created_at,topic_revision FROM assessments WHERE topic_id=? ORDER BY created_at DESC,rowid DESC').all(topicId).map((r:any)=>({...JSON.parse(r.data),topicRevision:r.topic_revision,createdAt:r.created_at}));}
  search(query:string,filter: {platform?:string;authorId?:string;from?:string;to?:string;topicId?:string;limit?:number}={}){
    if(typeof query!=='string'||query.length>2000)throw new RadarError('INVALID_INPUT','检索词不能超过2000字符');
    if(filter.platform&&!['github','bilibili','xiaohongshu'].includes(filter.platform))throw new RadarError('INVALID_PLATFORM','检索平台无效');
    for(const date of [filter.from,filter.to])if(date!==undefined&&sourceTimestamp(date)===null)throw new RadarError('INVALID_WINDOW','档案日期须为含时区的ISO时间');
    if(filter.from&&filter.to&&Date.parse(filter.from)>=Date.parse(filter.to))throw new RadarError('INVALID_WINDOW','档案起止范围无效');
    if(filter.limit!==undefined&&(!Number.isSafeInteger(filter.limit)||filter.limit<1||filter.limit>100))throw new RadarError('INVALID_BUDGET','检索最多100条');
    const conditions=['1=1'];const args:any[]=[];
    if(query){conditions.push('(i.title LIKE ? ESCAPE \'\\\' OR i.key LIKE ? ESCAPE \'\\\' OR json_extract(i.data,\'$.externalId\') LIKE ? ESCAPE \'\\\' OR json_extract(i.data,\'$.url\') LIKE ? ESCAPE \'\\\' OR EXISTS(SELECT 1 FROM evidence e WHERE e.item_key=i.key AND (e.body LIKE ? ESCAPE \'\\\' OR e.id LIKE ? ESCAPE \'\\\' OR json_extract(e.data,\'$.url\') LIKE ? ESCAPE \'\\\')))');const pattern='%'+query.replace(/[\\%_]/g,'\\$&')+'%';args.push(...Array(7).fill(pattern));}
    if(filter.platform){conditions.push('i.platform=?');args.push(filter.platform);}
    if(filter.authorId){conditions.push("json_extract(i.data,'$.authorId')=?");args.push(filter.authorId);}
    if(filter.from){conditions.push("julianday(json_extract(i.data,'$.publishedAt'))>=julianday(?)");args.push(filter.from);}
    if(filter.to){conditions.push("julianday(json_extract(i.data,'$.publishedAt'))<julianday(?)");args.push(filter.to);}
    if(filter.topicId){conditions.push('EXISTS(SELECT 1 FROM assessments a WHERE a.item_key=i.key AND a.topic_id=?)');args.push(filter.topicId);}
    args.push(Math.max(1,Math.min(filter.limit||30,100)));
    return this.db.prepare(`SELECT i.data FROM items i WHERE ${conditions.join(' AND ')} ORDER BY i.updated_at DESC,i.key LIMIT ?`).all(...args).map((r:any)=>JSON.parse(r.data));
  }
  groups(){return this.db.prepare('SELECT g.id,g.reason,m.item_key FROM groups g JOIN group_members m ON m.group_id=g.id ORDER BY g.id,m.item_key').all();}
  events(){return this.db.prepare('SELECT * FROM events ORDER BY created_at DESC,rowid DESC').all();}
  claim(id:string,owner:string,ttlMs=120000,clock=Date.now()){
    if(ttlMs<100||ttlMs>3600000)throw new RadarError('INVALID_LEASE','租约时长无效');
    return this.tx(()=>{const old=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as any;if(old&&(old.state==='done'||(old.state==='running'&&old.expires_at>clock)))return null;const token=randomUUID();const cursor=old?JSON.parse(old.data):{};this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,owner=excluded.owner,token=excluded.token,expires_at=excluded.expires_at,updated_at=excluded.updated_at').run(id,'running',owner,token,clock+ttlMs,JSON.stringify(cursor),now());return {id,token,cursor};});
  }
  checkpoint(id:string,token:string,cursor:object,ttlMs=120000,clock=Date.now()){
    const result=this.db.prepare('UPDATE jobs SET data=?,expires_at=?,updated_at=? WHERE id=? AND token=? AND state=? AND expires_at>?').run(JSON.stringify(cursor),clock+ttlMs,now(),id,token,'running',clock);
    if(!result.changes)throw new RadarError('LEASE_LOST','运行租约已过期或被接管');
  }
  finish(id:string,token:string,state='done',clock=Date.now()){
    if(!['done','failed','cancelled'].includes(state))throw new RadarError('INVALID_STATE','运行结束状态无效');
    const result=this.db.prepare('UPDATE jobs SET state=?,updated_at=? WHERE id=? AND token=? AND state=? AND expires_at>?').run(state,now(),id,token,'running',clock);
    if(!result.changes)throw new RadarError('LEASE_LOST','不能提交过期运行结果');
  }
  job(id:string){return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);}
  prepareDelivery(id:string,channel:string,recipient:string,body:string,itemKeys:string[]=[],commit?:()=>void){
    const fingerprint=hash(body);return this.tx(()=>{const old=this.delivery(id);if(old){if(old.body_hash!==fingerprint||old.channel!==channel||old.recipient!==recipient)throw new RadarError('BATCH_EXISTS','同一批次已有不同正文或目标，须核对原记录');
      const frozen=this.deliveryItems(id);if(JSON.stringify(frozen.map(r=>r.item_key).sort())!==JSON.stringify([...new Set(itemKeys)].sort()))throw new RadarError('RESERVATION_CONFLICT','批次推荐清单已经冻结，不能追加或替换内容');
      if(!['failed','cancelled','bounced'].includes(old.state))this.restoreReservations(id);return {...old,duplicate:true};}
      const quotaDate=this.productionDate(id,channel,recipient,body);
      if(quotaDate){const quota=this.dailyQuota(quotaDate);for(const platform of ['github','bilibili','xiaohongshu']){const requested=[...new Set(itemKeys)].filter(key=>this.item(key)?.platform===platform).length;if(requested>quota.platforms[platform].remaining)throw new RadarError('DAILY_QUOTA','该平台当日精选配额不足；待投递和待核对内容也占用配额');}}
      this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?)').run(id,channel,recipient,'prepared',fingerprint,body,null,now());
      for(const key of new Set(itemKeys)){const current=this.fingerprint(key);if(!current)throw new RadarError('NOT_FOUND','推荐内容不存在');this.db.prepare('INSERT INTO delivery_items VALUES(?,?,?)').run(id,key,current);}
      this.restoreReservations(id);commit?.();return this.delivery(id);});
  }
  delivery(id:string){return this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as any;}
  deliveries(){return this.db.prepare('SELECT id,channel,recipient,state,body_hash,updated_at FROM deliveries ORDER BY updated_at DESC,rowid DESC LIMIT 50').all();}
  cancelPrepared(id:string,reason:string){requireText(reason,'取消原因',500);const result=this.transitionDelivery(id,'cancelled',{reason});this.log('delivery_cancelled',{id,reason});return result;}
  deliveryItems(id:string){return this.db.prepare('SELECT item_key,fingerprint FROM delivery_items WHERE delivery_id=? ORDER BY item_key').all(id) as {item_key:string;fingerprint:string}[];}
  private productionDate(id:string,channel:string,recipient:string,body:string):string|null{
    if(channel!=='email'||!isEmailAddress(recipient))return null;
    let digest:any;try{digest=JSON.parse(body);if(digest?.simulation===true||digest?.verification===true)return null;}catch{}
    if(digest?.kind==='bilibili-interest-manual'&&/^bilibili-interest:[a-f0-9-]{36}$/.test(id)&&id==='bilibili-interest:'+digest.runId){batchAt(digest.attemptDate,'09:00');return digest.attemptDate;}
    if(digest?.kind==='automation-digest'&&id==='automation-mail:'+hash(digest.runId)){batchAt(digest.attemptDate,'09:00');return digest.attemptDate;}
    if(!id.startsWith(recipient.toLowerCase()+':'))return null;
    const match=/^(\d{4}-\d{2}-\d{2}):(09:00|18:00):[a-z][a-z0-9-]{0,60}$/.exec(id.slice(recipient.length+1));if(!match)return null;
    batchAt(match[1],match[2]);return match[1];
  }
  dailyQuota(date:string){
    batchAt(date,'09:00');const platforms:Record<string,{limit:number;used:number;remaining:number}>={github:{limit:5,used:0,remaining:5},bilibili:{limit:5,used:0,remaining:5},xiaohongshu:{limit:5,used:0,remaining:5}};
    const rows=this.db.prepare("SELECT id,channel,recipient,body FROM deliveries WHERE channel='email' AND state NOT IN ('cancelled','failed','bounced')").all() as any[];
    for(const row of rows){if(this.productionDate(row.id,row.channel,row.recipient,row.body)!==date)continue;for(const selected of this.deliveryItems(row.id)){const platform=this.item(selected.item_key)?.platform;if(platforms[platform])platforms[platform].used++;}}
    for(const p of Object.values(platforms))p.remaining=Math.max(0,p.limit-p.used);
    return {date,timezone:'Asia/Shanghai',scope:'formal batches by batch date and manual interest mail by Beijing attempt date; prepared/uncertain reservations included; verification and simulation excluded',platforms,comments:{enabled:false,defaultPerRun:1,hardLimit:3,reason:'真实评论接口未接入；按账号授权后另行验证'}};
  }
  lastConfirmedWindow(topicId:string,topicRevision:number,recipient:string|null=null):string|null {
    const rows=this.db.prepare("SELECT body FROM deliveries WHERE channel='email' AND state='sent_confirmed' AND json_valid(body) AND (? IS NULL OR lower(recipient)=lower(?))").all(recipient,recipient) as any[];
    const ends:string[]=[];
    for(const row of rows){const digest=JSON.parse(row.body);if(digest.simulation||digest.verification||!Array.isArray(digest.collectionWindows))continue;
      for(const window of digest.collectionWindows)if(window.topicId===topicId&&window.topicRevision===topicRevision&&window.completed===true&&typeof window.endAt==='string'&&Number.isFinite(Date.parse(window.endAt)))ends.push(window.endAt);
    }
    return ends.sort((a,b)=>Date.parse(b)-Date.parse(a))[0]||null;
  }
  alreadyRecommended(itemKey:string){return !!this.db.prepare("SELECT 1 FROM recommendations r JOIN items i ON i.key=r.item_key AND i.body_hash=r.fingerprint JOIN deliveries d ON d.id=r.delivery_id WHERE r.item_key=? AND d.state NOT IN ('failed','cancelled','bounced')").get(itemKey);}
  private restoreReservations(id:string){for(const row of this.deliveryItems(id)){
    const owner=this.db.prepare('SELECT r.delivery_id,d.state FROM recommendations r JOIN deliveries d ON d.id=r.delivery_id WHERE r.item_key=? AND r.fingerprint=?').get(row.item_key,row.fingerprint) as any;
    if(owner&&owner.delivery_id!==id&&!['failed','cancelled','bounced'].includes(owner.state))throw new RadarError('RESERVATION_CONFLICT','相同内容已有其他有效投递批次');
    this.db.prepare('INSERT INTO recommendations VALUES(?,?,?) ON CONFLICT(item_key,fingerprint) DO UPDATE SET delivery_id=excluded.delivery_id').run(row.item_key,row.fingerprint,id);
  }}
  reserveRecommendations(id:string,itemKeys:string[]){return this.tx(()=>{const d=this.delivery(id);if(!d||['failed','cancelled','bounced'].includes(d.state))throw new RadarError('INVALID_STATE','投递不可恢复预留');if(JSON.stringify([...new Set(itemKeys)].sort())!==JSON.stringify(this.deliveryItems(id).map(r=>r.item_key).sort()))throw new RadarError('RESERVATION_CONFLICT','只能恢复原冻结推荐清单');this.restoreReservations(id);});}
  beginDelivery(id:string){return !!this.db.prepare('UPDATE deliveries SET state=?,updated_at=? WHERE id=? AND state=?').run('submitting',now(),id,'prepared').changes;}
  transitionDelivery(id:string,next:string,receipt:object={}){
    const allowed:Record<string,string[]>={prepared:['cancelled'],submitting:['submitted','uncertain','failed'],submitted:['sent_confirmed','uncertain','bounced'],uncertain:['submitted','sent_confirmed','failed'],sent_confirmed:['bounced']};
    return this.tx(()=>{const old=this.delivery(id);if(!old||!allowed[old.state]?.includes(next))throw new RadarError('INVALID_STATE','不允许的投递状态转换');this.db.prepare('UPDATE deliveries SET state=?,receipt=?,updated_at=? WHERE id=?').run(next,JSON.stringify(receipt),now(),id);return this.delivery(id);});
  }
  recoverDeliveries(){return this.db.prepare("UPDATE deliveries SET state='uncertain',updated_at=? WHERE state='submitting'").run(now()).changes;}
  setCooldown(scope:string,retryAt:string){if(!Number.isFinite(Date.parse(retryAt)))throw new RadarError('INVALID_COOLDOWN','冷却时间无效');const stamp=new Date(retryAt).toISOString();this.db.prepare('INSERT INTO cooldowns VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET retry_at=max(cooldowns.retry_at,excluded.retry_at),updated_at=excluded.updated_at').run(scope,stamp,now());}
  cooldowns(prefix='github:',clock=Date.now()){return (this.db.prepare('SELECT scope,retry_at AS retryAt FROM cooldowns ORDER BY retry_at DESC').all() as {scope:string;retryAt:string}[]).filter(r=>r.scope.startsWith(prefix)&&Date.parse(r.retryAt)>clock);}
  rankingSnapshot(rows:Ranking[],observedAt=now(),period:'daily'|'weekly'='daily') {if(!['daily','weekly'].includes(period)||rows.some(r=>(r.period||(r.source.includes('since=weekly')?'weekly':'daily'))!==period))throw new RadarError('INVALID_PERIOD','榜单周期与条目不一致');const id=hash(observedAt+':github-trending-'+period+':'+hash(JSON.stringify(rows)));this.db.prepare('INSERT OR IGNORE INTO rankings VALUES(?,?,?)').run(id,observedAt,JSON.stringify(rows));return id;}
  ranking(id:string){const r=this.db.prepare('SELECT data,observed_at FROM rankings WHERE id=?').get(requireText(id,'榜单快照ID',200)) as any;return r?{id,rows:JSON.parse(r.data) as Ranking[],observedAt:r.observed_at}:null;}
  previousRanking(period:'daily'|'weekly'='daily'){if(!['daily','weekly'].includes(period))throw new RadarError('INVALID_PERIOD','榜单周期无效');const row=this.db.prepare("SELECT data,observed_at FROM rankings WHERE coalesce(json_extract(data,'$[0].period'),CASE WHEN json_extract(data,'$[0].source') LIKE '%since=weekly%' THEN 'weekly' ELSE 'daily' END)=? ORDER BY observed_at DESC,rowid DESC LIMIT 1").get(period) as any;return row?{rows:JSON.parse(row.data),observedAt:row.observed_at}:null;}
  addFeedback(itemKey:string,topicId:string,kind:string,rule:string){
    if(!['useful','irrelevant','duplicate','less_like_this'].includes(kind))throw new RadarError('INVALID_FEEDBACK','反馈类型无效');
    const row=this.db.prepare('SELECT revision,data FROM subscriptions WHERE id=?').get(topicId) as any;if(!this.item(itemKey)||!row)throw new RadarError('NOT_FOUND','反馈目标不存在');
    const negative=['less_like_this','irrelevant'].includes(kind);rule=requireText(rule,'rule',kind==='duplicate'?2000:200);
    const topic=JSON.parse(row.data),next=feedbackTopic(topic,kind,rule);validateTopic(next);
    const applicable=JSON.stringify(next)!==row.data,id=randomUUID(),ruleTarget=negative?'exclude':kind==='useful'?'preferred':'record';
    this.db.prepare('INSERT INTO feedback(id,item_key,topic_id,kind,rule,reverted,created_at,previous_topic,next_topic) VALUES(?,?,?,?,?,0,?,?,?)').run(id,itemKey,topicId,kind,rule,now(),row.data,JSON.stringify(next));
    return {id,preview:rule,revision:row.revision,ruleTarget,before:negative?topic.exclude:topic.preferred||[],after:negative?next.exclude:next.preferred||[],applicable,applied:false,note:negative?'规则为字面排除词，作用于本主题各平台；应用前核对影响范围':kind==='useful'?'应用后作为本主题的优先偏好；仅调整候选阅读顺序和模型相关性，不扩大搜索、不保证入选，排除词优先':'仅保存重复线索，不自动合并、删除或过滤其他来源'};
  }
  feedback(){return this.db.prepare('SELECT * FROM feedback ORDER BY created_at DESC').all();}
  revertFeedback(id:string){return this.tx(()=>{const f=this.db.prepare('SELECT * FROM feedback WHERE id=?').get(id) as any;if(!f)throw new RadarError('NOT_FOUND','反馈不存在');if(f.reverted)return;if(f.applied_revision){const topic=this.db.prepare('SELECT revision,data FROM subscriptions WHERE id=?').get(f.topic_id) as any;if(topic.revision!==f.applied_revision||topic.data!==f.next_topic)throw new RadarError('REVISION_CONFLICT','订阅后来又修改过，请先比较规则再撤销，不能覆盖后续更改');this.db.prepare('UPDATE subscriptions SET revision=?,data=?,updated_at=? WHERE id=?').run(topic.revision+1,f.previous_topic,now(),f.topic_id);}this.db.prepare('UPDATE feedback SET reverted=1 WHERE id=?').run(id);this.log('feedback_reverted',{id});});}
  applyFeedback(id:string,expectedRevision:number){return this.tx(()=>{
    const f=this.db.prepare('SELECT * FROM feedback WHERE id=?').get(id) as any;if(!f||f.reverted)throw new RadarError('NOT_FOUND','反馈已撤销或不存在');if(f.applied_revision)throw new RadarError('ALREADY_APPLIED','反馈规则已经应用');
    const row=this.db.prepare('SELECT revision,data FROM subscriptions WHERE id=?').get(f.topic_id) as any;
    if(row.revision!==expectedRevision||(f.previous_topic&&f.previous_topic!==row.data))throw new RadarError('REVISION_CONFLICT','订阅已变化，请重新预览，不能应用旧预览');
    const topic=feedbackTopic(JSON.parse(row.data),f.kind,f.rule);validateTopic(topic);const next=JSON.stringify(topic);
    if(next===row.data||next!==f.next_topic)throw new RadarError('NO_RULE_CHANGE','此反馈没有待应用的订阅规则变化；历史仅记录的意见需重新预览');
    this.db.prepare('UPDATE subscriptions SET revision=?,data=?,updated_at=? WHERE id=?').run(row.revision+1,next,now(),f.topic_id);
    this.db.prepare('UPDATE feedback SET applied_revision=?,previous_topic=?,next_topic=? WHERE id=?').run(row.revision+1,row.data,next,id);this.log('feedback_applied',{id,revision:row.revision+1});return topic;
  });}
  stats(){const result:Record<string,number>={};for(const name of ['subscriptions','items','evidence','assessments','events','jobs','deliveries','rankings','feedback'])result[name]=Number((this.db.prepare(`SELECT count(*) n FROM ${name}`).get() as any).n);return result;}
  backup(path:string){const absolute=resolve(path);mkdirSync(dirname(absolute),{recursive:true});if(existsSync(absolute))throw new RadarError('BACKUP_EXISTS','备份文件已存在');this.db.prepare('VACUUM INTO ?').run(absolute);return absolute;}
}
