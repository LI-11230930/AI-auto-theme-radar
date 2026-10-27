import type {Store} from './store.ts';
import {RadarError,hash,now} from './model.ts';
import {planById} from './automation-plan.ts';
import type {AutomationPlan} from './automation-plan.ts';
import {isEmailAddress} from './email-address.ts';
import {absolutePreviewUrl} from './operator-url.ts';
import {MAIL_FORMAT} from './mail.ts';
import {beijingDate} from './time.ts';

const runPattern=/^automation-run:[a-f0-9]{64}$/;
export const frozenContentHash=(body:any)=>hash(JSON.stringify([body.subject,body.text,body.html]));
export function frozenRun(store:Store,id:string){
 if(typeof id!=='string'||!runPattern.test(id))throw new RadarError('INVALID_INPUT','统一轮次ID无效');
 const row=store.job(id) as any;if(!row||row.state!=='done')throw new RadarError('INVALID_STATE','需要正常完成的轮次');
 const run=JSON.parse(row.data),body=run.body;
 if(!body||body.runId!==id||body.planId!==run.planId||body.planRevision!==run.planRevision||body.kind!=='automation-digest'||body.simulation!==false||body.verification!==false||body.contentReady!==true||body.formatVersion!==MAIL_FORMAT||typeof body.subject!=='string'||!body.subject.trim()||body.subject.length>500||/[\r\n]/.test(body.subject)||typeof body.text!=='string'||!body.text.trim()||body.text.length>500000||typeof body.html!=='string'||!body.html.trim()||body.html.length>1000000||!Array.isArray(body.itemKeys)||body.itemKeys.some((key:any)=>typeof key!=='string'||key.length>300||! /^(github:|bilibili:)/.test(key)))throw new RadarError('INVALID_DRAFT','本轮没有有效的真实冻结正文');
 return run;
}
/** beta.6 attached drafts can be verified against their persisted model input. */
function legacySnapshots(store:Store,run:any){
 const tasks=(store.db.prepare("SELECT data FROM jobs WHERE id LIKE 'automation-model:%' AND state='done'").all() as any[]).map(r=>JSON.parse(r.data)).filter(t=>t.runId===run.id&&t.status==='completed');
 return run.body.itemKeys.map((key:string)=>{
  const task=tasks.find(t=>t.result?.itemKey===key&&t.result.selected===true);let input:any;try{input=JSON.parse(task?.prompt);}catch{}
  const item=store.item(key),current=store.currentEvidence(key);
  if(!input?.item||!item||['title','url','authorId','version'].some(field=>input.item[field]!==item[field])||!Array.isArray(input.item.metadata?.currentEvidenceIds)||JSON.stringify([...input.item.metadata.currentEvidenceIds].sort())!==JSON.stringify(current.map(e=>e.id).sort())||!Array.isArray(input.materials)||input.materials.some((m:any)=>typeof m.text!=='string'||!current.some(e=>e.id===m.id&&e.text.startsWith(m.text))))throw new RadarError('LEGACY_DRAFT_UNVERIFIED','旧草稿无法与原模型输入及当前材料核对；保留预览，不登记发送');
  const cited=task.result.readEvidenceIds;if(!Array.isArray(cited)||!cited.length||cited.some((id:string)=>!input.materials.some((m:any)=>m.id===id&&m.text.trim()))||!run.body.text.includes(item.url)||!run.body.text.includes(task.result.summaryZh))throw new RadarError('LEGACY_DRAFT_UNVERIFIED','旧草稿与模型引用或简介不符');
  return {itemKey:key,fingerprint:store.fingerprint(key),snapshot:store.readingSnapshot(key)};
 });
}
export function validateFrozenSources(store:Store,run:any){
 const p=planById(store,run.planId);if(!p||p.revision!==run.planRevision)throw new RadarError('PLAN_CHANGED','原计划已变化，不登记旧草稿发送');
 for(const id of p.topicIds)if(!store.topics().some(t=>t.id===id&&t.enabled&&t.revision===run.topicRevisions[id]))throw new RadarError('TOPIC_CHANGED','原主题已变化，不登记旧草稿发送');
 const snapshots=Array.isArray(run.body.itemSnapshots)?run.body.itemSnapshots:legacySnapshots(store,run);
 if(new Set(run.body.itemKeys).size!==run.body.itemKeys.length||snapshots.length!==run.body.itemKeys.length||new Set(snapshots.map((s:any)=>s?.itemKey)).size!==snapshots.length||snapshots.some((s:any)=>!s||!run.body.itemKeys.includes(s.itemKey)||s.fingerprint!==store.fingerprint(s.itemKey)||s.snapshot!==store.readingSnapshot(s.itemKey)))throw new RadarError('SOURCE_CHANGED','冻结草稿对应材料已变化，不登记发送');
 return {plan:p,snapshots};
}
export function draftView(config:any,store:Store,id:string){
 const run=frozenRun(store,id);let sendReadiness:any;try{validateFrozenSources(store,run);sendReadiness={ready:true};}catch(error){sendReadiness={ready:false,code:error instanceof RadarError?error.code:'INVALID_DRAFT'};}
 const approval=store.job('automation-approval:'+hash(id)) as any,authorization=approval?JSON.parse(approval.data):null;
 return {runId:id,planId:run.planId,analysisAgent:run.plan?.agent||null,subject:run.body.subject,text:run.body.text,html:run.body.html,contentHash:frozenContentHash(run.body),preview:run.preview,absolutePreview:absolutePreviewUrl(config,run.preview),sendReadiness,deliveryId:run.deliveryId||null,deliveryState:run.deliveryId?store.delivery(run.deliveryId)?.state:null,oneOffAuthorization:authorization?{agent:authorization.agent,from:authorization.from,recipient:authorization.recipient,expiresAt:authorization.expiresAt}:null,emailSent:run.deliveryId?store.delivery(run.deliveryId)?.state==='sent_confirmed':false,scope:'immutable local draft; no platform/model/mail call'};
}
export function oneOffApproval(store:Store,run:any,p:AutomationPlan){
 const row=store.job('automation-approval:'+hash(run.id)) as any;if(!row)return null;
 const a=JSON.parse(row.data);if(a.runId!==run.id||a.planRevision!==p.revision||a.contentHash!==frozenContentHash(run.body)||a.approved!==true||Date.parse(a.expiresAt)<=Date.now()||!['DSH','WorkBuddy','Codex','TRAE'].includes(a.agent)||!isEmailAddress(a.from)||!isEmailAddress(a.recipient))throw new RadarError('APPROVAL_EXPIRED','单封授权已到期或与原冻结内容不符，不重新领取');
 validateFrozenSources(store,run);return a;
}
/** Explicit local intent for this immutable draft only; this is not a transport or identity check. */
export function prepareOneOff(config:any,store:Store,input:{runId:string;expectedContentHash:string;agent:string;from:string;recipient:string;approved:boolean}){
 if(!input||input.approved!==true)throw new RadarError('EXPLICIT_APPROVAL_REQUIRED','请先明确授权这份冻结草稿的一次发送');
 if(!['DSH','WorkBuddy','Codex','TRAE'].includes(input.agent)||!isEmailAddress(input.from)||!isEmailAddress(input.recipient))throw new RadarError('INVALID_INPUT','选择发送宿主并填写有效发件、收件邮箱');
 const run=frozenRun(store,input.runId),contentHash=frozenContentHash(run.body);if(input.expectedContentHash!==contentHash)throw new RadarError('DRAFT_CHANGED','待授权正文与当前冻结草稿不符');
 const {plan,snapshots}=validateFrozenSources(store,run),id='automation-mail:'+hash(run.id),approvalId='automation-approval:'+hash(run.id),old=store.job(approvalId) as any;
 if(old){const a=oneOffApproval(store,run,plan);if(a!.agent!==input.agent||a!.from!==input.from||a!.recipient!==input.recipient)throw new RadarError('APPROVAL_CONFLICT','本轮已授权不同发送身份或收件人，不覆盖');const d=store.delivery(id);return {deliveryId:id,state:d.state,duplicate:true,absolutePreview:absolutePreviewUrl(config,run.preview),emailSent:d.state==='sent_confirmed'};}
 if(run.stage!=='draft_ready'||store.delivery(id))throw new RadarError('DELIVERY_EXISTS','本轮已有投递或不是仅草稿结果，不能新增授权');
 const approval={runId:run.id,planRevision:plan.revision,contentHash,agent:input.agent,from:input.from,recipient:input.recipient,approved:true,approvedAt:now(),expiresAt:new Date(Date.now()+86400000).toISOString(),scope:'one_frozen_draft_one_attempt'};
 const body={...run.body,itemSnapshots:snapshots,attemptDate:beijingDate(),oneOff:true};
 store.prepareDelivery(id,'email',input.recipient,JSON.stringify(body),body.itemKeys,()=>{
  if(store.job(approvalId))throw new RadarError('APPROVAL_CONFLICT','其他会话已登记授权，请重新读取');
  validateFrozenSources(store,run);
  store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(approvalId,'done','one-off-approval','',0,JSON.stringify(approval),now());
  run.deliveryId=id;run.oneOff=true;run.draftStage=run.stage;run.stage='awaiting_host_mail';store.db.prepare('UPDATE jobs SET data=?,updated_at=? WHERE id=?').run(JSON.stringify(run),now(),run.id);
 });
 if(!store.job(approvalId))throw new RadarError('APPROVAL_CONFLICT','本轮已有其他投递，不登记第二份授权');
 return {deliveryId:id,state:'prepared',from:input.from,to:input.recipient,subject:run.body.subject,contentHash,expiresAt:approval.expiresAt,absolutePreview:absolutePreviewUrl(config,run.preview),emailSent:false,note:'仅登记本草稿一次发送授权；请在选定Agent核对实际邮箱后claim/send/report；不改变计划和频率'};
}
