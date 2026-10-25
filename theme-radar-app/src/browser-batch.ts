import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {authorReadingQueue} from './author-queue.ts';
import {importBrowserSubtitles,validateBrowserSubtitles} from './browser-subtitles.ts';
import {hash,RadarError,readableEvidence,stableId} from './model.ts';
import type {Store} from './store.ts';

const BATCH_TTL=20*60_000,PAIR_TTL=2*60_000;
export const browserBatchFailureCodes=['NO_VISIBLE_SUBTITLES','PLAYER_UNAVAILABLE','PLAYBACK_BLOCKED','CAPTURE_INTERRUPTED','CAPTURE_BUDGET','IMPORT_FAILED'] as const;
type FailureCode=typeof browserBatchFailureCodes[number];
type BatchItem={itemKey:string;bvid:string;page:1;url:string;duration:number;authorUid:string;readingSnapshot:string;state:'pending'|'imported'|'failed';failureCode?:FailureCode;payloadHash?:string;result?:ReturnType<typeof importBrowserSubtitles>};
type Batch={batchId:string;topicId:string;topicRevision:number;createdAt:number;expiresAt:number;pairExpiresAt:number;pairHash?:string;tokenHash?:string;origin?:string;pairFailures:number;state:'awaiting_pair'|'paired'|'cancelled'|'expired'|'invalidated'|'pair_locked';items:BatchItem[]};
const originPattern=/^chrome-extension:\/\/[a-p]{32}$/;
function reject(code:string,message:string):never{throw new RadarError(code,message);}
function exactKeys(value:any,keys:string[]){return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');}
function canonical(value:any):string{return value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';}
function sameHash(a:string|undefined,b:string){return !!a&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}

/** Short-lived, local import permission only. No secrets or sessions are persisted. */
export class BrowserBatchBridge {
  #store:Store;#dataDir:string;#clock:()=>number;#batches=new Map<string,Batch>();
  constructor(store:Store,dataDir:string,clock:()=>number=Date.now){this.#store=store;this.#dataDir=dataDir;this.#clock=clock;}
  #expire(batch:Batch){
    if(['awaiting_pair','paired'].includes(batch.state)&&this.#clock()>=batch.expiresAt){batch.state='expired';this.#revoke(batch);}
    if(batch.state==='awaiting_pair'&&this.#clock()>=batch.pairExpiresAt){batch.state='expired';this.#revoke(batch);}
    return batch;
  }
  #revoke(batch:Batch){delete batch.pairHash;delete batch.tokenHash;}
  #batch(batchId:string){const batch=this.#batches.get(batchId);if(!batch)reject('BROWSER_BATCH_NOT_FOUND','浏览器采集批次不存在或服务已重启');return this.#expire(batch);}
  #topic(batch:Batch){
    const topic=this.#store.topics().find(t=>t.id===batch.topicId);
    if(!topic||topic.revision!==batch.topicRevision||!topic.enabled||!topic.platforms.includes('bilibili')||batch.items.some(i=>!topic.bilibiliAuthors?.includes(i.authorUid))){batch.state='invalidated';this.#revoke(batch);reject('TOPIC_CHANGED','订阅已改变，采集授权已撤销，请在本地重新创建批次');}
  }
  #authorized(token:string,origin:string){
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||typeof origin!=='string'||!originPattern.test(origin))reject('BROWSER_BATCH_UNAUTHORIZED','浏览器采集凭据或来源无效');
    const digest=hash(token),batch=[...this.#batches.values()].find(b=>sameHash(b.tokenHash,digest));
    if(!batch)reject('BROWSER_BATCH_UNAUTHORIZED','浏览器采集凭据或来源无效');
    this.#expire(batch);
    if(batch.state!=='paired'||!batch.tokenHash||batch.origin!==origin)reject('BROWSER_BATCH_UNAUTHORIZED','浏览器采集凭据或来源无效或已到期');
    this.#topic(batch);return batch;
  }
  #item(batch:Batch,itemKey:string){
    const item=batch.items.find(i=>i.itemKey===itemKey);if(!item)reject('BROWSER_BATCH_ITEM_REQUIRED','该视频不在本次采集清单内');
    const archived=this.#store.item(itemKey);
    if(!archived||archived.platform!=='bilibili'||archived.authorId!==item.authorUid||this.#store.readingSnapshot(itemKey)!==item.readingSnapshot)reject('SOURCE_CHANGED','视频作者或材料已改变，请在本地重新创建批次');
    return item;
  }
  create(topicId:string,itemKeys:string[]){
    if(!Array.isArray(itemKeys)||itemKeys.length<1||itemKeys.length>3||new Set(itemKeys).size!==itemKeys.length||itemKeys.some(k=>typeof k!=='string'))reject('INVALID_BROWSER_BATCH','一次仅允许1至3个不同的队列视频');
    const queue=authorReadingQueue(this.#store,this.#dataDir,topicId);
    const items:BatchItem[]=itemKeys.map(itemKey=>{
      const row=queue.rows.find(r=>r.itemKey===itemKey),item=this.#store.item(itemKey);
      if(!row||row.state!=='subtitle_needed'||!row.ownerVerified||!item||item.platform!=='bilibili'||item.authorId!==row.authorUid)reject('BROWSER_BATCH_ITEM_REQUIRED','仅允许当前作者队列中已核对UID且缺字幕的视频');
      if(this.#store.currentEvidence(itemKey).some(e=>readableEvidence(e)&&/^(?:browser-subtitle:p\d+|subtitle(?::p\d+)?)$/.test(e.kind)))reject('BROWSER_BATCH_SUBTITLE_EXISTS','已有可分析字幕，不重复授权采集');
      const bvid=stableId('bilibili',item.externalId),page=(item.metadata.subtitlePages as any[]|undefined)?.find(p=>p.page===1);
      if(!page||!Number.isFinite(page.duration)||page.duration<=0||page.duration>900)reject('BROWSER_BATCH_DURATION','批量观察只接收已归档P1且时长不超过15分钟的视频');
      return {itemKey,bvid,page:1,url:'https://www.bilibili.com/video/'+bvid+'?p=1',duration:page.duration,authorUid:row.authorUid,readingSnapshot:this.#store.readingSnapshot(itemKey),state:'pending'};
    });
    if(items.reduce((total,item)=>total+item.duration,0)>1000)reject('BROWSER_BATCH_DURATION','本批视频总时长不超过1000秒，以保留20分钟授权中的导航与导入时间');
    for(const batch of this.#batches.values())this.#expire(batch);
    if([...this.#batches.values()].some(b=>['awaiting_pair','paired'].includes(b.state)&&b.items.some(i=>itemKeys.includes(i.itemKey)&&i.state==='pending')))reject('BROWSER_BATCH_BUSY','这些视频已有有效采集授权，请先取消原批次');
    if(this.#batches.size>=20){for(const [id,b] of this.#batches){if(!['awaiting_pair','paired'].includes(b.state))this.#batches.delete(id);if(this.#batches.size<20)break;}if(this.#batches.size>=20)reject('BROWSER_BATCH_BUSY','有效采集批次已达上限，请先取消旧批次');}
    const at=this.#clock(),pairCode=randomBytes(6).toString('hex').toUpperCase(),batch:Batch={batchId:randomUUID(),topicId,topicRevision:queue.topicRevision,createdAt:at,expiresAt:at+BATCH_TTL,pairExpiresAt:at+PAIR_TTL,pairHash:hash(pairCode),pairFailures:0,state:'awaiting_pair',items};
    this.#batches.set(batch.batchId,batch);return {...this.publicStatus(batch.batchId),pairCode};
  }
  pair(pairCode:string,origin:string){
    const candidates=[...this.#batches.values()].map(b=>this.#expire(b)).filter(b=>b.state==='awaiting_pair');
    const validCode=typeof pairCode==='string'&&/^[A-F0-9]{12}$/.test(pairCode),validOrigin=typeof origin==='string'&&originPattern.test(origin),digest=validCode?hash(pairCode):'';
    const batch=validCode&&validOrigin?candidates.find(b=>sameHash(b.pairHash,digest)):undefined;
    if(!batch){for(const candidate of candidates){candidate.pairFailures++;if(candidate.pairFailures>=5){candidate.state='pair_locked';this.#revoke(candidate);}}reject('BROWSER_BATCH_PAIR_FAILED','配对码无效、已使用或已到期；连续失败需在本地重建批次');}
    this.#topic(batch);const token=randomBytes(32).toString('base64url');batch.tokenHash=hash(token);batch.origin=origin;batch.state='paired';delete batch.pairHash;
    return {token,...this.publicStatus(batch.batchId)};
  }
  authenticate(token:string,origin:string){return this.publicStatus(this.#authorized(token,origin).batchId);}
  importCapture(token:string,origin:string,input:{itemKey:string;snapshot:unknown}){
    const batch=this.#authorized(token,origin);
    if(!exactKeys(input,['itemKey','snapshot'])||typeof input.itemKey!=='string')reject('INVALID_BROWSER_CAPTURE','仅允许指定视频与字幕观察快照');
    const item=this.#item(batch,input.itemKey),data=validateBrowserSubtitles(input.snapshot,this.#clock());
    if(data.bvid!==item.bvid||data.page!==1||Math.abs(data.duration-item.duration)>2)reject('VIDEO_MISMATCH','观察的BV号、P1或时长与授权视频不符');
    if(Date.parse(data.startedAt)<batch.createdAt-1000||Date.parse(data.endedAt)>batch.expiresAt)reject('BROWSER_BATCH_CAPTURE_TIME','只允许本次授权有效期内新采集的字幕观察');
    const payloadHash=hash(canonical(input.snapshot));
    if(item.state==='imported'){
      if(item.payloadHash!==payloadHash)reject('BROWSER_BATCH_ALREADY_IMPORTED','该视频已成功导入，本授权不允许改变正文再次提交');
      return {duplicate:true,result:item.result,status:this.publicStatus(batch.batchId)};
    }
    if(item.state!=='pending')reject('BROWSER_BATCH_ITEM_STOPPED','该视频已停止，不能继续导入');
    const result=importBrowserSubtitles(this.#store,input.snapshot,{topicId:batch.topicId,topicRevision:batch.topicRevision,authorUid:item.authorUid,readingSnapshot:item.readingSnapshot,page:1,duration:item.duration});
    item.state='imported';item.payloadHash=payloadHash;item.result=result;item.readingSnapshot=this.#store.readingSnapshot(item.itemKey);
    return {duplicate:false,result,status:this.publicStatus(batch.batchId)};
  }
  failItem(token:string,origin:string,input:{itemKey:string;code:string}){
    const batch=this.#authorized(token,origin);
    if(!exactKeys(input,['itemKey','code'])||typeof input.itemKey!=='string'||!browserBatchFailureCodes.includes(input.code as FailureCode))reject('INVALID_BROWSER_BATCH_FAILURE','停止原因必须使用预设代码，不接收任意页面文本');
    const item=this.#item(batch,input.itemKey);
    if(item.state==='imported')reject('BROWSER_BATCH_ALREADY_IMPORTED','已导入视频不能改写为失败');
    if(item.state==='failed'&&item.failureCode!==input.code)reject('BROWSER_BATCH_ITEM_STOPPED','停止原因已经记录');
    item.state='failed';item.failureCode=input.code as FailureCode;return this.publicStatus(batch.batchId);
  }
  cancelFromOperator(batchId:string){const batch=this.#batch(batchId);if(['awaiting_pair','paired'].includes(batch.state)){batch.state='cancelled';this.#revoke(batch);}return this.publicStatus(batchId);}
  cancelFromExtension(token:string,origin:string){return this.cancelFromOperator(this.#authorized(token,origin).batchId);}
  revokeAll(){for(const batch of this.#batches.values()){batch.state='cancelled';this.#revoke(batch);}this.#batches.clear();}
  publicStatus(batchId?:string):any{
    if(batchId===undefined)return {batches:[...this.#batches.keys()].map(id=>this.publicStatus(id)),modelCalled:false,emailSent:false};
    const batch=this.#batch(batchId);
    return {batchId:batch.batchId,topicId:batch.topicId,topicRevision:batch.topicRevision,createdAt:new Date(batch.createdAt).toISOString(),expiresAt:new Date(batch.expiresAt).toISOString(),pairExpiresAt:new Date(batch.pairExpiresAt).toISOString(),state:batch.state,items:batch.items.map(i=>({itemKey:i.itemKey,bvid:i.bvid,page:i.page,url:i.url,duration:i.duration,state:i.state,...(i.failureCode?{failureCode:i.failureCode}:{})})),modelCalled:false,emailSent:false,sourceVerifiedByServer:false,scope:'本地短期有界DOM字幕导入，不授予模型、联网抓取、邮件、评论或调度权限；服务重启即失效'};
  }
}
