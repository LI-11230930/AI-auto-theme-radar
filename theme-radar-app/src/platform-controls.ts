import {now,RadarError} from './model.ts';
import {beijingDate} from './time.ts';
import {planById,runRows,writePlan,validatePlan} from './automation-plan.ts';
import type {AutomationPlan} from './automation-plan.ts';
import type {AutomationRuntime} from './automation-runtime.ts';

export const platformPlanIds={github:'github-morning',bilibili:'bilibili-stream'};
type Platform=keyof typeof platformPlanIds;
const revisionFields=new Set(['revision','createdAt','updatedAt']);
function canonical(value:any):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>!revisionFields.has(k)&&value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
function derivedPlan(runtime:AutomationRuntime,platform:Platform,base:AutomationPlan,old?:AutomationPlan,enabled=old?.enabled??false){
 const topics=runtime.store.topics(),ids=base.topicIds.filter(id=>topics.some(t=>t.id===id&&t.enabled&&t.platforms.includes(platform)));
 const selected=base.platforms.includes(platform)&&ids.length>0;
 return {...(old||base),id:platformPlanIds[platform],name:old?.name||(platform==='github'?'GitHub每日简报':'B站持续阅读'),
  enabled:enabled&&selected,agent:base.agent,execution:base.execution,platforms:[platform],
  topicIds:selected?ids:old?.topicIds||ids,schedule:old?.schedule||{kind:'manual'},
  delivery:base.delivery,from:base.from,recipient:base.recipient,sendApproved:base.sendApproved,
  readLimit:base.readLimit,githubReadLimit:base.githubReadLimit,inspiration:base.inspiration?{...base.inspiration,enabled:base.inspiration.enabled&&platform==='bilibili'}:undefined,mailBudgetScope:'plan',
  maxMessagesPerDay:old?.maxMessagesPerDay||(platform==='github'?1:2),
  subject:old?.subject||(platform==='github'?'GitHub每日简报｜{date}':'B站阅读精选｜{date} {time}')};
}
function cancelUnattempted(runtime:AutomationRuntime,ids:string[]){
 if(!ids.length)return;
 const placeholders=ids.map(()=>'?').join(',');
 runtime.store.db.prepare("UPDATE deliveries SET state='cancelled',receipt=?,updated_at=? WHERE state='prepared' AND id IN (SELECT json_extract(data,'$.deliveryId') FROM jobs WHERE id LIKE 'automation-run:%' AND json_extract(data,'$.planId') IN ("+placeholders+"))")
  .run(JSON.stringify({source:'configuration_changed',note:'配置已变更，保留原冻结正文；未尝试发送的旧草稿停止投递'}),now(),...ids);
}
/** One transaction; no clock or mail starts. Closed platforms remain closed. */
export function savePersonalConfiguration(runtime:AutomationRuntime,input:any,expectedRevision?:number){
 if(input?.id!=='personal-radar')throw new RadarError('INVALID_PLAN','统一配置仅使用personal-radar');
 const changed:string[]=[];
 const result=runtime.store.tx(()=>{
  validatePlan(input,runtime.store);const old=planById(runtime.store,input.id);
  if(old&&expectedRevision!==old.revision||!old&&expectedRevision!==undefined&&expectedRevision!==0)throw new RadarError('STALE_PLAN','计划已变化，请重新读取');
  const base=old&&canonical(old)===canonical(input)?old:writePlan(runtime.store,input,expectedRevision);
  if(base!==old)changed.push(base.id);
  for(const platform of Object.keys(platformPlanIds) as Platform[]){
   const child=planById(runtime.store,platformPlanIds[platform]);if(!child)continue;
   const next=derivedPlan(runtime,platform,base,child);
   if(canonical(child)!==canonical(next)){writePlan(runtime.store,next,child.revision);changed.push(child.id);}
  }
  cancelUnattempted(runtime,changed);return base;
 });
 runtime.invalidatePlans(changed);
 return {plan:result,changedPlanIds:changed};
}
function nextOccurrence(platform:Platform,clock:number){
 if(platform==='bilibili')return new Date((Math.floor(clock/900000)+1)*900000).toISOString();
 const date=beijingDate(new Date(clock)),today=Date.parse(date+'T09:00:00+08:00');
 return new Date(clock<today?today:today+86400000).toISOString();
}
export function platformControls(runtime:AutomationRuntime,clock=Date.now()){
 const store=runtime.store,base=planById(store,'personal-radar'),runs=runtime.status().runs;
 const wakeupRow=store.job('platform-wakeups'),wakeups=wakeupRow?JSON.parse((wakeupRow as any).data):null;
 return {timezone:'Asia/Shanghai',driver:'host_wakeup',requires:'电脑、本机服务和所选Agent可用；自动运行还需独立专用会话的唤醒配置',
  platforms:(Object.entries(platformPlanIds) as [Platform,string][]).map(([platform,id])=>{
   const plan=planById(store,id),enabled=!!plan?.enabled;
   const configurationCurrent=!!plan&&!!base&&canonical(plan)===canonical(derivedPlan(runtime,platform,base,plan));
   let executionState='needs_setup',executionNote='先保存Agent、邮箱与兴趣主题';
   if(plan){
    if(!enabled){executionState='off';executionNote='平台已关闭，不启动轮次';}
    else if(!configurationCurrent){executionState='configuration_changed';executionNote='平台配置与首页不一致，请保存一次统一配置';}
    else if(!wakeups){executionState='needs_wakeup';executionNote='尚未配置自动唤醒；可在所选Agent手动运行';}
    else if(wakeups.status!=='ACTIVE'){executionState='wakeup_paused';executionNote='自动唤醒已暂停，计划不会自行执行';}
    else if(wakeups.driverAgent&&wakeups.driverAgent!==plan.agent||!wakeups.driverAgent&&/Codex/i.test(wakeups.driver||'')&&plan.agent!=='Codex'){
     executionState='host_mismatch';executionNote='唤醒宿主与当前Agent不一致，需要在独立会话配置对应宿主';
    }else{executionState='configured';executionNote='唤醒配置已登记；平台、模型和邮箱在实际轮次中核验';}
   }
   const lastRun=runs.find(r=>r.planId===id)||null,active=runs.find(r=>r.planId===id&&r.state==='running'&&!r.interrupted);
   const configured=executionState==='configured';
   return {platform,plan:plan||null,enabled,frequency:platform==='github'?'每天09:00':'开启后每15分钟',configurationCurrent,
    execution:{state:executionState,note:executionNote,liveVerified:false},
    nextScheduledAt:enabled?nextOccurrence(platform,clock):null,nextRunAt:enabled&&configured?nextOccurrence(platform,clock):null,
    activeRunId:active?.id||null,lastRun,
    mailbox:{state:plan?.delivery==='draft'?'draft_only':'requires_host_check',note:plan?.delivery==='draft'?'只生成草稿':'发件连接需由所选Agent实际核对，填写邮箱不代表已连接'}};
  }),wakeups,pendingReading:store.db.prepare("SELECT id,data FROM jobs WHERE id LIKE 'video-recovery:%' AND state='pending' ORDER BY updated_at DESC LIMIT 20").all().map((r:any)=>JSON.parse(r.data))};
}
export function setPlatform(runtime:AutomationRuntime,input:any){
 const platform=input.platform as Platform,id=platformPlanIds[platform];
 if(!id||typeof input.enabled!=='boolean')throw new RadarError('INVALID_INPUT','选择平台及开关状态');
 const old=planById(runtime.store,id),base=planById(runtime.store,'personal-radar');
 if(!base&&!old)throw new RadarError('SETUP_REQUIRED','先保存Agent、邮箱和兴趣主题');
 const next=derivedPlan(runtime,platform,base||old!,old,input.enabled);
 if(input.enabled&&!next.enabled)throw new RadarError('SETUP_REQUIRED','先在统一配置中选择此平台及至少一个启用主题');
 const plan=old&&canonical(old)===canonical(next)?old:runtime.save(next,old?.revision??0);
 if(!input.enabled)cancelUnattempted(runtime,[id]);
 return {plan,...platformControls(runtime)};
}
export function triggerPlatform(runtime:AutomationRuntime,input:any,clock=Date.now()){
 const id=platformPlanIds[input.platform as Platform],p=id&&planById(runtime.store,id);
 if(!p||!p.enabled)return {started:false,reason:'platform_off'};
 const wakeup=runtime.store.job('platform-wakeups');if(wakeup&&JSON.parse((wakeup as any).data).status!=='ACTIVE')return {started:false,reason:'wakeup_paused'};
 const base=planById(runtime.store,'personal-radar');if(base&&canonical(p)!==canonical(derivedPlan(runtime,input.platform,base,p)))throw new RadarError('CONFIGURATION_CHANGED','平台配置与统一配置不一致，请先保存统一配置');
 if(p.agent!==input.agent)throw new RadarError('AGENT_MISMATCH','当前宿主与平台计划不符');
 const queued=runRows(runtime.store).find(r=>r.planId===id&&r.planRevision===p.revision&&r.state==='done'&&r.stage==='awaiting_host_mail'&&runtime.store.delivery(r.deliveryId)?.state==='prepared');
 if(queued)return {started:false,resumeMail:true,runId:queued.id,reason:'prepared_mail_waiting'};
 const date=beijingDate(new Date(clock)),local=new Date(clock+8*3600000),minute=local.getUTCHours()*60+local.getUTCMinutes();
 if(input.platform==='github'&&(minute<540||minute>=555))return {started:false,reason:'outside_0900_window'};
 const attempts=runtime.store.db.prepare("SELECT data FROM jobs WHERE id LIKE 'automation-attempt:%'").all() as any[];
 if(attempts.filter(r=>{const a=JSON.parse(r.data);return a.date===date&&a.planId===p.id;}).length>=p.maxMessagesPerDay)return {started:false,reason:'daily_mail_limit'};
 const bucket=input.platform==='github'?date:String(Math.floor(clock/900000)),marker='platform-trigger:'+input.platform+':'+bucket;
 if(runtime.store.job(marker))return {started:false,reason:'already_triggered'};
 const active=runRows(runtime.store).find(r=>r.state==='running'&&!r.interrupted);if(active)return {started:false,reason:'another_round_running',runId:active.id};
 const due=input.platform==='github'?new Date(date+'T09:00:00+08:00').toISOString():new Date(Math.floor(clock/900000)*900000).toISOString();
 const result=runtime.launch(p,due,'schedule',clock);
 if(result.started)runtime.store.db.prepare('INSERT OR IGNORE INTO jobs VALUES(?,?,?,?,?,?,?)').run(marker,'done','platform-driver','',0,JSON.stringify({runId:result.runId,platform:input.platform,at:now()}),now());
 return {...result,planId:id};
}
