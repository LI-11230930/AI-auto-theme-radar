import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {RadarError,now,normalizeText,stableId,publicError,isVideoTextKind} from './model.ts';
import type {Topic,Item,Evidence} from './model.ts';import type {Store} from './store.ts';
import {freezeBilibiliSample} from './bilibili-sample.ts';
import {beijingDate} from './time.ts';
import {videoBodyQuality} from './bilibili-body-quality.ts';

export type InterestCandidate={bvid:string;title:string;authorId:string;author?:string;publishedAt?:string|null;source?:string};
export type InterestSources={recommendations:(limit:number)=>Promise<{items:InterestCandidate[];[key:string]:unknown}>;search:(keyword:string,limit:number)=>Promise<InterestCandidate[]>;read:(bvid:string,options:{pages:number[];expectedAuthorUid:string;includeDanmaku:boolean})=>Promise<{item:Item;evidence:Evidence[];warnings:string[]}>};
const ttl=600000;
export function notifiedVideoKeys(store:Store){
 const keys=new Set<string>();
 const rows=store.db.prepare("SELECT id,body FROM deliveries WHERE state IN ('prepared','submitting','submitted','uncertain','sent_confirmed')").all() as any[];
 for(const row of rows){for(const item of store.deliveryItems(row.id))if(item.item_key.startsWith('bilibili:'))keys.add(item.item_key);
  let text='';try{const body=JSON.parse(row.body);text=typeof body.text==='string'?body.text:'';}catch{continue;}
  for(const match of text.matchAll(/https:\/\/www\.bilibili\.com\/video\/(BV[A-Za-z0-9]{10})(?=$|[/?#\s])/g))keys.add('bilibili:'+match[1]);
 }return keys;
}
export function interestScore(candidate:InterestCandidate,topic:Topic){
 const text=normalizeText(candidate.title).toLowerCase();
 if(topic.exclude.some(word=>word.trim()&&text.includes(normalizeText(word).toLowerCase())))return -1;
 return topic.keywords.filter(word=>{const w=normalizeText(word).toLowerCase();if(!w)return false;if(/^[a-z0-9]+$/.test(w))return new RegExp('(^|[^a-z0-9])'+w+'($|[^a-z0-9])','i').test(text);return text.includes(w);}).length;
}
function ensureTopic(store:Store,id:string,revision?:number){const topic=store.topics().find(t=>t.id===id&&t.enabled&&t.bilibiliDiscovery==='interests'&&t.platforms.includes('bilibili')&&!t.bilibiliAuthors?.length);if(!topic)throw new RadarError('TOPIC_REQUIRED','请选择不限作者的B站兴趣主题');if(revision!==undefined&&topic.revision!==revision)throw new RadarError('TOPIC_CHANGED','兴趣主题已变化，已停止本轮');return topic;}
function claimRound(store:Store,topicId:string){const id='interest-round:'+topicId,token=randomUUID(),clock=Date.now();store.tx(()=>{const old=store.job(id) as any;if(old?.state==='running'&&old.expires_at>clock)throw new RadarError('ROUND_BUSY','同一兴趣主题已有宿主执行，请等待或取消');store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,owner=excluded.owner,token=excluded.token,expires_at=excluded.expires_at,data=excluded.data,updated_at=excluded.updated_at').run(id,'running','interest:'+process.pid,token,clock+ttl,'{}',now());});return{id,token};}
export function lastInterestRun(dataDir:string){try{return JSON.parse(readFileSync(resolve(dataDir,'reports','interest-round-last.json'),'utf8'));}catch{return null;}}
export function interestCounts(report:any){const rows=Array.isArray(report?.results)?report.results:[];return {attempted:rows.length,newSourceReads:rows.filter(r=>r.acquisition?.cached===false).length,cachedMaterials:rows.filter(r=>r.acquisition?.cached===true).length,assessed:rows.filter(r=>r.state==='assessed').length,newAssessments:rows.filter(r=>r.state==='assessed'&&r.reused!==true).length,reusedAssessments:rows.filter(r=>r.state==='assessed'&&r.reused===true).length,selected:rows.filter(r=>r.selected===true).length,insufficientBody:rows.filter(r=>r.state==='insufficient_body'||r.code==='INSUFFICIENT_VIDEO_BODY').length,unavailableBody:rows.filter(r=>r.state==='no_subtitle').length,failed:rows.filter(r=>r.state==='failed').length};}
function readingAcquisition(store:Store,key:string,cached:boolean){
 const item=store.item(key),evidence=store.currentEvidence(key),parts=item?.metadata?.asrPages;
 const asr=Array.isArray(parts)?parts.filter(p=>p&&typeof p==='object'&&p.page===1).map(p=>({page:1,state:p.state,reason:p.reason,characters:p.characters,sourceDuration:p.sourceDuration,processedRange:p.processedRange})):[];
 return {cached,videoText:evidence.filter(e=>isVideoTextKind(e.kind,1)&&!!e.text.trim()).map(e=>({kind:e.kind,characters:e.text.length})),asr,agentRead:false};
}
export async function runInterestRound(args:{store:Store;dataDir:string;topicId:string;source:InterestSources;readLimit?:number;excludeKeys?:string[];analyze:(topicId:string,itemKey:string,signal?:AbortSignal,commitGuard?:()=>void)=>Promise<any>;signal?:AbortSignal}){
 const {store,source}=args,limit=args.readLimit??3;if(!Number.isSafeInteger(limit)||limit<1||limit>3)throw new RadarError('INVALID_BUDGET','一轮最多读取3条视频');
 const topic=ensureTopic(store,args.topicId),lease=claimRound(store,topic.id),id=randomUUID();
 const report:any={id,topicId:topic.id,topicRevision:topic.revision,startedAt:now(),discovered:0,prefiltered:0,results:[],sources:[],candidateBudget:20,readLimit:limit,commentsRead:0,emailSent:false};
 const controller=new AbortController(),signal=controller.signal,abort=()=>controller.abort();let controlError:unknown=null;if(args.signal?.aborted)controller.abort();args.signal?.addEventListener('abort',abort,{once:true});
 const checkpoint=()=>{if(controlError)throw controlError;if(signal.aborted)throw new RadarError('CANCELLED','本轮已取消');ensureTopic(store,topic.id,topic.revision);store.checkpoint(lease.id,lease.token,{id,topicId:topic.id,stage:report.stage,progress:{...report}},ttl);};
 const heartbeat=setInterval(()=>{try{checkpoint();}catch(error){controlError=error;controller.abort();}},10000);
 const persist=()=>{const folder=resolve(args.dataDir,'reports');mkdirSync(folder,{recursive:true});const text=JSON.stringify(report,null,2);writeFileSync(resolve(folder,'interest-round-'+id+'.json'),text);const tmp=resolve(folder,'interest-round-last.'+id+'.tmp');writeFileSync(tmp,text);renameSync(tmp,resolve(folder,'interest-round-last.json'));};
 try{
  checkpoint();report.stage='discovering';const feed=await source.recommendations(12);checkpoint();if(feed.authenticated!==true)throw new RadarError('AUTH_REQUIRED','未确认登录推荐，不降级为匿名热门');report.sources.push({kind:'recommendation',state:'ok',count:feed.items.length,authenticated:true});
  const candidates=new Map<string,InterestCandidate>();
  const add=(items:InterestCandidate[],kind:string)=>{for(const row of items){if(candidates.size>=20)break;try{const bvid=stableId('bilibili',row.bvid);if(typeof row.title!=='string'||!row.title.trim()||row.title.length>500||!/^\d{1,20}$/.test(row.authorId)||BigInt(row.authorId)===0n)continue;if(!candidates.has(bvid))candidates.set(bvid,{...row,bvid,source:kind});}catch{continue;}}};
  add(feed.items,'recommendation');
  for(const keyword of topic.keywords.slice(0,2)){if(candidates.size>=20)break;checkpoint();try{const rows=await source.search(keyword,Math.min(4,20-candidates.size));checkpoint();add(rows,'search');report.sources.push({kind:'search',state:'ok',keyword,count:rows.length});}catch(error){if(error instanceof RadarError&&['TOPIC_CHANGED','CANCELLED','LEASE_LOST'].includes(error.code))throw error;const safe=publicError(error);report.sources.push({kind:'search',state:'failed',keyword,code:safe.code});report.discoveryPartial=true;if(['AUTH_REQUIRED','RATE_LIMITED'].includes(safe.code))report.stoppedReason=safe.code;break;}}
  checkpoint();report.discovered=candidates.size;const notified=new Set([...notifiedVideoKeys(store),...(args.excludeKeys||[])]);
  const ranked=[...candidates.values()].map(row=>({...row,score:interestScore(row,topic)})).filter(row=>row.score>0&&!notified.has('bilibili:'+row.bvid)).sort((a,b)=>b.score-a.score||a.bvid.localeCompare(b.bvid));
  report.prefiltered=ranked.length;report.notifiedSkipped=[...candidates.values()].filter(row=>notified.has('bilibili:'+row.bvid)).map(row=>'bilibili:'+row.bvid);
  // Title matches only prioritize reading; only cited subtitle judgments can enter a sample.
  const chosen:typeof ranked=[],owners=new Set<string>();for(const row of ranked)if(!owners.has(row.authorId)&&chosen.length<limit){chosen.push(row);owners.add(row.authorId);}for(const row of ranked)if(chosen.length<limit&&!chosen.includes(row))chosen.push(row);
  if(!report.stoppedReason)for(const row of chosen){
   checkpoint();report.stage='reading';const key='bilibili:'+row.bvid,result:any={itemKey:key,title:row.title,url:'https://www.bilibili.com/video/'+row.bvid,authorUid:row.authorId,source:row.source,state:'reading'};report.results.push(result);checkpoint();
   try{
    const current=store.item(key),subtitle=store.currentEvidence(key).some(e=>e.text.trim()&&isVideoTextKind(e.kind,1));
    const cached=!!current&&current.authorId===row.authorId&&subtitle;
    if(!cached){const read=await source.read(row.bvid,{pages:[1],expectedAuthorUid:row.authorId,includeDanmaku:true});checkpoint();if(read.item.authorId!==row.authorId)throw new RadarError('AUTHOR_MISMATCH','实际作者与候选不符');store.capture(read.item,read.evidence,checkpoint);result.warnings=read.warnings;}
    checkpoint();result.acquisition=readingAcquisition(store,key,cached);
    const blocked=result.acquisition.asr.find(p=>p.state==='failed'&&['AUTH_REQUIRED','CREDENTIAL_INVALID','ACCESS_DENIED','RATE_LIMITED'].includes(p.reason));
    if(blocked){result.state='no_subtitle';result.code=blocked.reason;report.stoppedReason=blocked.reason;break;}
    if(!store.currentEvidence(key).some(e=>e.text.trim()&&isVideoTextKind(e.kind,1))){result.state='no_subtitle';continue;}
    result.acquisition.selectionGate=videoBodyQuality(store.currentEvidence(key),undefined,1);
    if(!result.acquisition.selectionGate.sufficient){result.state='insufficient_body';result.code='INSUFFICIENT_VIDEO_BODY';result.selected=false;continue;}
    report.stage='analyzing';checkpoint();const analysis=await args.analyze(topic.id,key,signal,checkpoint);checkpoint();const assessment=analysis.assessment;if(!assessment||assessment.simulation===true)throw new RadarError('INVALID_AGENT_OUTPUT','本轮需要真实正文判断');
    result.state='assessed';result.title=store.item(key).title;result.selected=assessment.selected===true;result.summaryZh=assessment.summaryZh;result.reused=analysis.reused===true;
    const ids=new Set(assessment.readEvidenceIds||[]);result.acquisition.agentRead=store.currentEvidence(key).some(e=>ids.has(e.id)&&isVideoTextKind(e.kind,1));
    result.acquisition.selectionGate=videoBodyQuality(store.currentEvidence(key),assessment,1);
    if(result.selected&&!result.acquisition.selectionGate.sufficient){result.agentSelected=true;result.selected=false;result.code='INSUFFICIENT_VIDEO_BODY';}
   }catch(error){const safe=publicError(error);result.state='failed';result.code=safe.code;if(['TOPIC_CHANGED','TOPIC_REQUIRED','CANCELLED','LEASE_LOST'].includes(safe.code))throw error;if(['AUTH_REQUIRED','ACCESS_DENIED','RATE_LIMITED','RUNNER_TIMEOUT','PROVIDER_CHANNEL_REJECTED','MODEL_QUOTA_EXCEEDED','AGENT_FAILED'].includes(safe.code)){report.stoppedReason=safe.code;break;}}
  }
  checkpoint();const selectedKeys=report.results.filter(r=>r.state==='assessed'&&r.selected).map(r=>r.itemKey),remaining=store.dailyQuota(beijingDate()).platforms.bilibili.remaining,keys=selectedKeys.slice(0,remaining);
  report.dailySelectedRemainingAtFreeze=remaining;report.deferredSelected=selectedKeys.length-keys.length;
  if(selectedKeys.length&&!keys.length)report.sampleIssue='DAILY_QUOTA';
  if(keys.length){report.stage='freezing';try{report.sample=freezeBilibiliSample(store,args.dataDir,{topicId:topic.id,itemKeys:keys},()=>{checkpoint();const excluded=notifiedVideoKeys(store);if(keys.some(k=>excluded.has(k)))throw new RadarError('ALREADY_NOTIFIED','候选已在其他投递中，未生成重复样张');});}catch(error){const code=publicError(error).code;if(['TOPIC_CHANGED','TOPIC_REQUIRED','CANCELLED','LEASE_LOST'].includes(code))throw error;report.sampleIssue=code;}}
  report.stage='finished';report.completedAt=now();report.counts=interestCounts(report);store.finish(lease.id,lease.token);persist();return report;
 }catch(error){const safe=publicError(controlError||error);report.stage='stopped';report.stoppedReason=safe.code;report.completedAt=now();report.counts=interestCounts(report);try{store.finish(lease.id,lease.token,safe.code==='CANCELLED'?'cancelled':'failed');}catch{}persist();return report;}finally{clearInterval(heartbeat);args.signal?.removeEventListener('abort',abort);}
}
