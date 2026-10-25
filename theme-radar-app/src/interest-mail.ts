import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Store} from './store.ts';
import {RadarError,hash,now} from './model.ts';
import {beijingDate} from './time.ts';
import {readBilibiliSample} from './bilibili-sample.ts';
import {renderBilibiliBrief} from './bilibili-brief.ts';
import {notifiedVideoKeys} from './interest-round.ts';
import {isEmailAddress} from './email-address.ts';

const kind='bilibili-interest-manual';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export type InterestMailPolicy={enabled:boolean;mode:'manual_round_only';from:string|null;recipient:string|null;maxAttemptsPerRun:1;maxMessagesPerDay:number;maxItemsPerRun:number;approvedAt?:string;approvalSource?:'explicit_user'};
const defaults=():InterestMailPolicy=>({enabled:false,mode:'manual_round_only',from:null,recipient:null,maxAttemptsPerRun:1,maxMessagesPerDay:2,maxItemsPerRun:3});
function iso(value:unknown):value is string{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)||!Number.isFinite(Date.parse(value)))return false;
  const calendar=new Date(value.slice(0,10)+'T00:00:00Z');return Number.isFinite(calendar.getTime())&&calendar.toISOString().slice(0,10)===value.slice(0,10);
}
function readJson(file:string,maxBytes:number,code:string,message:string){
  try{const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>maxBytes)throw new Error('invalid file');return JSON.parse(readFileSync(file,'utf8'));}catch{throw new RadarError(code,message);}
}
/** The approval fields declare local configuration intent; they do not authenticate a human. */
export function readInterestMailPolicy(dataDir:string):InterestMailPolicy{
  const file=resolve(dataDir,'interest-mail-policy.json');try{lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return defaults();throw new RadarError('INVALID_MAIL_POLICY','无法核对兴趣邮件政策文件');}
  const value=readJson(file,16384,'INVALID_MAIL_POLICY','兴趣邮件政策文件无效；未授权发送');
  const allowed=new Set(['enabled','mode','from','recipient','maxAttemptsPerRun','maxMessagesPerDay','maxItemsPerRun','approvedAt','approvalSource']);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.has(key)))throw new RadarError('INVALID_MAIL_POLICY','兴趣邮件政策含无效字段');
  const policy={...defaults(),...value};
  if(typeof policy.enabled!=='boolean'||policy.mode!=='manual_round_only'||policy.from!==null&&!isEmailAddress(policy.from)||policy.recipient!==null&&!isEmailAddress(policy.recipient)||policy.from!==policy.recipient||policy.maxAttemptsPerRun!==1||!Number.isSafeInteger(policy.maxMessagesPerDay)||policy.maxMessagesPerDay<1||policy.maxMessagesPerDay>2||!Number.isSafeInteger(policy.maxItemsPerRun)||policy.maxItemsPerRun<1||policy.maxItemsPerRun>3||policy.approvedAt!==undefined&&!iso(policy.approvedAt)||policy.approvalSource!==undefined&&policy.approvalSource!=='explicit_user')throw new RadarError('INVALID_MAIL_POLICY','兴趣邮件政策须使用同一有效邮箱自发自收，单轮一次、每日最多两次及最多三条');
  if(policy.enabled&&(!isEmailAddress(policy.from)||!iso(policy.approvedAt)||Date.parse(policy.approvedAt)>Date.now()+60000||policy.approvalSource!=='explicit_user'))throw new RadarError('INVALID_MAIL_POLICY','启用兴趣邮件需要本地自己的邮箱、明确授权时间和来源声明');
  return policy;
}

/** Reserves exactly one host send attempt; this function contains no transport. */
export function claimInterestMail(store:Store,dataDir:string,input:{sampleId:string;runId:string}){
  if(!input||typeof input.sampleId!=='string'||!uuid.test(input.sampleId)||typeof input.runId!=='string'||!uuid.test(input.runId))throw new RadarError('INVALID_INPUT','兴趣轮次和样张须使用有效UUID');
  return store.tx(()=>{
    const policy=readInterestMailPolicy(dataDir);if(!policy.enabled)throw new RadarError('MAIL_DISABLED','兴趣邮件尚未获得持续手动轮次授权；未领取发送');
    const deliveryId='bilibili-interest:'+input.runId;
    if(store.delivery(deliveryId))throw new RadarError('MAIL_ALREADY_CLAIMED','该轮次已领取一次发送；失败或结果未知也不可重新领取');
    const report=readJson(resolve(dataDir,'reports','interest-round-'+input.runId+'.json'),1048576,'INVALID_ROUND','兴趣轮次报告不存在或格式无效');
    if(report?.id!==input.runId||report.stage!=='finished'||report.stoppedReason||!iso(report.startedAt)||!iso(report.completedAt)||Date.parse(report.completedAt)<Date.parse(report.startedAt)||Date.parse(report.completedAt)>Date.now()+60000||report.sample?.id!==input.sampleId)throw new RadarError('INVALID_ROUND','仅允许已正常结束且绑定本样张的兴趣轮次发送');
    const topic=store.topics().find(t=>t.id===report.topicId&&t.enabled&&t.bilibiliDiscovery==='interests'&&t.platforms.includes('bilibili')&&!t.bilibiliAuthors?.length);
    if(!topic||!Number.isSafeInteger(report.topicRevision)||topic.revision!==report.topicRevision)throw new RadarError('TOPIC_CHANGED','兴趣主题已变化或不再启用，未领取过期样张');
    const sample=readBilibiliSample(dataDir,input.sampleId);
    if(sample.simulation!==false||typeof sample.subject!=='string'||!sample.subject.trim()||sample.subject.length>500||/[\r\n]/.test(sample.subject)||typeof sample.text!=='string'||!sample.text.trim()||sample.text.length>100000||report.sample.textSha256!==sample.textSha256||!Array.isArray(sample.entries)||sample.entries.length<1||sample.entries.length>policy.maxItemsPerRun)throw new RadarError('INVALID_SAMPLE','兴趣样张内容、散列或条数不符合本轮邮件政策');
    const keys:string[]=sample.entries.map((entry:any)=>entry?.itemKey);
    if(keys.some(key=>typeof key!=='string'||!/^bilibili:BV[A-Za-z0-9]{10}$/.test(key))||new Set(keys).size!==keys.length||!Array.isArray(report.results)||sample.entries.some((entry:any)=>entry.topicId!==topic.id||!report.results.some((result:any)=>result?.itemKey===entry.itemKey&&result.state==='assessed'&&result.selected===true)))throw new RadarError('INVALID_SAMPLE','样张必须仅包含本兴趣轮次实际选中的不同视频');
    for(const entry of sample.entries)if(!store.item(entry.itemKey)||entry.snapshot!==store.readingSnapshot(entry.itemKey))throw new RadarError('SOURCE_CHANGED','样张材料快照已变化，未领取过期正文');
    const current=renderBilibiliBrief(store,sample.batch,{topicId:topic.id,itemKeys:keys,template:sample.mailTemplate});
    if(current.skipped.some(row=>row.reason==='insufficient_video_body'))throw new RadarError('INSUFFICIENT_VIDEO_BODY','旧草稿包含正文信息量不足的视频，未领取发送；请重新生成草稿，原冻结内容保留');
    if(!current.contentReady||current.entries.length!==keys.length||hash(current.text)!==sample.textSha256)throw new RadarError('SOURCE_CHANGED','样张不再对应当前主题的真实字幕阅读判断或正文');
    const notified=notifiedVideoKeys(store);if(keys.some(key=>notified.has(key)))throw new RadarError('ALREADY_NOTIFIED','至少一条视频已处于其他投递或已发送，未创建重复邮件');
    // Claiming reserves an attempt; later rejection or cancellation cannot refund it.
    const attemptDate=beijingDate(),attemptStates=new Set(['submitting','submitted','uncertain','sent_confirmed','failed','bounced','cancelled']);let attempts=0;
    for(const row of store.db.prepare("SELECT body,state FROM deliveries WHERE channel='email'").all() as {body:string;state:string}[]){let body:any;try{body=JSON.parse(row.body);}catch{continue;}if(body?.kind!==kind)continue;if(body.runId===input.runId)throw new RadarError('MAIL_ALREADY_CLAIMED','该轮次已有发送尝试，不可重新领取');if(body.attemptDate===attemptDate&&attemptStates.has(row.state))attempts++;}
    if(attempts>=policy.maxMessagesPerDay)throw new RadarError('MAIL_DAILY_LIMIT','北京时间当日兴趣邮件发送尝试已达到上限；未知和失败尝试也计数');
    if(keys.length>store.dailyQuota(attemptDate).platforms.bilibili.remaining)throw new RadarError('DAILY_QUOTA','B站当日精选总额不足；手动轮次与正式批次共享每天5条上限，未领取发送');
    const body={verification:false,simulation:false,kind,sampleId:input.sampleId,runId:input.runId,text:sample.text,subject:sample.subject,textSha256:sample.textSha256,itemKeys:keys,policySnapshot:policy,attemptDate};
    const serialized=JSON.stringify(body);
    store.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?)').run(deliveryId,'email',policy.recipient,'submitting',hash(serialized),serialized,null,now());
    for(const key of keys)store.db.prepare('INSERT INTO delivery_items VALUES(?,?,?)').run(deliveryId,key,store.fingerprint(key));
    return {deliveryId,from:policy.from,to:policy.recipient,subject:sample.subject,text:sample.text,textSha256:sample.textSha256,state:'submitting' as const,instruction:'仅使用已连接Outlook发送一次；无连接或调用不确定不得重试'};
  });
}

/** A host statement only; independent provider reconciliation must establish actual delivery. */
export function reportInterestMail(store:Store,input:{deliveryId:string;outcome:'submitted'|'uncertain';providerMessageId?:string}){
  if(!input||typeof input.deliveryId!=='string'||!input.deliveryId.startsWith('bilibili-interest:')||!uuid.test(input.deliveryId.slice('bilibili-interest:'.length))||!['submitted','uncertain'].includes(input.outcome)||input.providerMessageId!==undefined&&(typeof input.providerMessageId!=='string'||!input.providerMessageId.trim()||input.providerMessageId.length>2000||/[\r\n]/.test(input.providerMessageId)))throw new RadarError('INVALID_INPUT','兴趣邮件回执仅允许submitted或uncertain与有界消息ID');
  return store.tx(()=>{
    const old=store.delivery(input.deliveryId);let body:any;try{body=old&&JSON.parse(old.body);}catch{}
    if(!old||body?.kind!==kind)throw new RadarError('NOT_FOUND','兴趣邮件投递不存在');
    if(old.state===input.outcome){let receipt:any;try{receipt=JSON.parse(old.receipt);}catch{}if(receipt?.source==='host_self_report'&&(receipt.providerMessageId??null)===(input.providerMessageId??null))return {deliveryId:old.id,state:old.state,duplicate:true,independentlyConfirmed:false};throw new RadarError('RECEIPT_CONFLICT','该状态已记录不同回执，未改写原声明');}
    if(old.state!=='submitting')throw new RadarError('INVALID_STATE','仅待发送调用结果可报告一次；不能逆转未知结果或自行确认送达');
    const receipt={source:'host_self_report',outcome:input.outcome,...(input.providerMessageId?{providerMessageId:input.providerMessageId}:{}),at:now(),independentlyConfirmed:false,note:'宿主自行声明调用结果；不是独立服务商查询或送达证明'};
    store.db.prepare('UPDATE deliveries SET state=?,receipt=?,updated_at=? WHERE id=? AND state=?').run(input.outcome,JSON.stringify(receipt),now(),old.id,'submitting');
    return {deliveryId:old.id,state:input.outcome,duplicate:false,independentlyConfirmed:false};
  });
}
