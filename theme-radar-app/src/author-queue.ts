import type {Store} from './store.ts';
import {listAuthorObservations} from './author-observation.ts';
import {archivedAnalysis} from './archive-reading.ts';
import {videoBodyQuality} from './bilibili-body-quality.ts';
import {RadarError,isVideoTextKind} from './model.ts';
export function authorReadingQueue(store:Store,dataDir:string,topicId:string){
 const topic=store.topics().find(t=>t.id===topicId&&t.enabled&&t.platforms.includes('bilibili')&&t.bilibiliAuthors?.length);
 if(!topic)throw new RadarError('TOPIC_REQUIRED','请选择有效作者订阅');
 const observations=listAuthorObservations(store,dataDir).observations.filter(r=>r.current&&r.topicId===topicId),seen=new Map<string,any>();
 for(const record of observations)for(const row of record.snapshot.items){
  const key='bilibili:'+row.bvid;if(seen.has(key))continue;const item=store.item(key),ownerVerified=!!item&&item.authorId===record.snapshot.authorUid;
  const materials=ownerVerified?store.currentEvidence(key):[],subtitle=materials.some(e=>e.text.trim()&&isVideoTextKind(e.kind,1));
  const analysis=ownerVerified?archivedAnalysis(store,key).assessments.find(a=>a.topicId===topicId&&a.current&&!a.simulation&&a.readEvidenceIds.some(id=>materials.some(e=>e.id===id&&isVideoTextKind(e.kind,1)))):null;
  const bodyQuality=videoBodyQuality(materials,undefined,1),selectionQuality=analysis?videoBodyQuality(materials,analysis,1):null;
  const state=!item?'metadata_pending':!ownerVerified?'owner_mismatch':subtitle&&!bodyQuality.sufficient?'insufficient_body':analysis?'assessed':subtitle?'analysis_pending':'subtitle_needed';
  seen.set(key,{itemKey:key,bvid:row.bvid,title:item?.title||row.title,url:row.url,authorUid:record.snapshot.authorUid,ownerVerified,state,selected:analysis?.selected??null,bodyQuality,selectionBodySufficient:selectionQuality?.sufficient??null,observationId:record.id});
 }
 const rows=[...seen.values()],counts=Object.fromEntries(['metadata_pending','owner_mismatch','subtitle_needed','analysis_pending','insufficient_body','assessed'].map(s=>[s,rows.filter(r=>r.state===s).length]));
 return {topicId,topicRevision:topic.revision,rows,counts,boundedToObservations:20,exhaustive:false,scope:'当前订阅的浏览器可见链接队列；逐条实际UID、字幕取得与模型判断分别列示，不声称全量或云端持续采集',emailSent:false};
}
export async function readNextAuthorItems(options:{store:Store;dataDir:string;topicId:string;limit?:number;source:any}){
 const limit=options.limit??2;if(!Number.isSafeInteger(limit)||limit<1||limit>3)throw new RadarError('INVALID_LIMIT','每次只读取1至3条新视频');
 const before=authorReadingQueue(options.store,options.dataDir,options.topicId),groups=new Map<string,any[]>();for(const row of before.rows.filter(r=>r.state==='metadata_pending')){if(!groups.has(row.authorUid))groups.set(row.authorUid,[]);groups.get(row.authorUid)!.push(row);}const pending:any[]=[],results:any[]=[];for(let offset=0;pending.length<limit;offset++){let added=false;for(const rows of groups.values())if(rows[offset]&&pending.length<limit){pending.push(rows[offset]);added=true;}if(!added)break;}
 for(const row of pending){try{const r=await options.source.read(row.bvid,{expectedAuthorUid:row.authorUid,pages:[1]});if(r.item.authorId!==row.authorUid)throw new RadarError('AUTHOR_MISMATCH','实际作者与订阅UID不同');const current=options.store.topics().find(t=>t.id===options.topicId);if(current?.revision!==before.topicRevision)throw new RadarError('TOPIC_CHANGED','读取期间主题已变化，没有保存本条材料');const asr=r.item.metadata.asrPages,blocked=Array.isArray(asr)?asr.find(p=>p?.page===1&&p.state==='failed'&&['AUTH_REQUIRED','CREDENTIAL_INVALID','ACCESS_DENIED','RATE_LIMITED'].includes(p.reason)):null;results.push({itemKey:row.itemKey,ok:!blocked,...(blocked?{code:blocked.reason}:{}),capture:options.store.capture(r.item,r.evidence),warnings:r.warnings});if(blocked)break;}catch(e){results.push({itemKey:row.itemKey,ok:false,code:e instanceof RadarError?e.code:'SOURCE_FAILED'});break;}}
 return {results,requestedLimit:limit,stoppedOnFailure:results.some(r=>!r.ok),queue:authorReadingQueue(options.store,options.dataDir,options.topicId),modelCalled:false,emailSent:false,scope:'有界读取未归档视频；已核对UID但缺字幕的条目跳过，不反复刷新或按标题调用模型'};
}
