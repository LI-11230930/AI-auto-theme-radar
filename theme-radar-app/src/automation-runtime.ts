import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {HostRunner,validateModelTaskResult} from './runner.ts';
import {RadarError,now,hash,publicError} from './model.ts';
import type {Batch} from './model.ts';
import {beijingDate} from './time.ts';
import {runGithub} from './engine.ts';
import {analyzeArchived} from './archive-reading.ts';
import {GitHubSource} from './github.ts';
import {BilibiliSource} from './bilibili.ts';
import {BilibiliInterestSource} from './interest-source.ts';
import {readConfiguredBilibili} from './bilibili-reading.ts';
import {runInterestRound} from './interest-round.ts';
import {readBilibiliSample} from './bilibili-sample.ts';
import {loadMailTemplate} from './mail-template.ts';
import {MAIL_FORMAT,sendEmail} from './mail.ts';
import {automationAgents,plans,planById,savePlan,scheduleStatus,occurrenceStart,insertRun,runRows} from './automation-plan.ts';
import type {AutomationPlan} from './automation-plan.ts';
import type {Store} from './store.ts';
import {absolutePreviewUrl} from './operator-url.ts';
import {frozenContentHash,oneOffApproval} from './automation-outbox.ts';
import {savePersonalConfiguration} from './platform-controls.ts';
import {runInspirationFollowups} from './inspiration-followup.ts';
import {inspirationTaskIssue} from './inspiration.ts';

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function batchForRun(p:AutomationPlan,run:any):Batch{const end=new Date(run.dueAt),date=beijingDate(end),slot=new Date(end.getTime()+28800000).toISOString().slice(11,16);return {date,slot,key:run.id,dueAt:end.toISOString(),startAt:occurrenceStart(p,run.dueAt),endAt:end.toISOString(),timezone:'Asia/Shanghai'};}
export class AutomationRuntime{
 config:any;store:Store;active=new Map<string,AbortController>();runningData=new Map<string,any>();online=new Map<string,number>();blocked=new Map<string,any>();timer:any;closed=false;dependencies:any;
 constructor(config:any,store:Store,dependencies:any={}){this.config=config;this.store=store;this.dependencies=dependencies;}
 start(){this.timer=setInterval(()=>{try{this.tick();}catch{}},10000);this.timer.unref?.();}
 async close(){this.closed=true;clearInterval(this.timer);for(const c of this.active.values())c.abort();while(this.active.size)await pause(10);}
 status(){return {plans:plans(this.store).map(p=>({...p,scheduleStatus:scheduleStatus(p),blockedReason:this.blocked.get(p.id)||null,availability:p.execution==='attached'?'requires_online_agent_session':p.agent==='WorkBuddy'?'unsupported_background':this.config.runners[p.agent]?.command?'cli_configured_unverified':'missing_cli'})),runs:runRows(this.store).map(({body,plan,...run})=>({...run,...(run.preview?{absolutePreview:absolutePreviewUrl(this.config,run.preview)}:{}),...(body?{contentHash:frozenContentHash(body),subject:body.subject}:{}),deliveryState:run.deliveryId?this.store.delivery(run.deliveryId)?.state:null,emailSent:run.deliveryId?this.store.delivery(run.deliveryId)?.state==='sent_confirmed':false})),onlineAgents:[...this.online].filter(([,at])=>Date.now()-at<30000).map(([agent])=>agent),timezone:'Asia/Shanghai',scheduler:'local_service_only; computer and service must stay running',automaticSendingDefault:false};}
 invalidatePlans(ids:string[]){for(const [id,controller] of this.active){const data=this.runningData.get(id)||JSON.parse((this.store.job(id) as any)?.data||'{}');if(ids.includes(data.planId))controller.abort();}}
 save(input:any,expectedRevision?:number){if(input?.id==='personal-radar')return savePersonalConfiguration(this,input,expectedRevision).plan;const p=savePlan(this.store,input,expectedRevision);this.invalidatePlans([p.id]);return p;}
 cancel(id:string){const controller=this.active.get(id);if(!controller)throw new RadarError('RUN_NOT_ACTIVE','本进程无该运行；若原进程退出，等待租约失效，不重新发信');controller.abort();return {cancelRequested:true};}
 tick(clock=Date.now()){
  if(this.closed)return;
  for(const p of plans(this.store)){if(!p.enabled)continue;if(p.execution==='attached'&&clock-(this.online.get(p.agent)||0)>30000)continue;const due=scheduleStatus(p,clock).dueAt;if(due)try{this.launch(p,due,'schedule',clock);this.blocked.delete(p.id);}catch(error){this.blocked.set(p.id,publicError(error));}}
 }
 startRun(id:string){const p=planById(this.store,id);if(!p)throw new RadarError('NOT_FOUND','计划不存在');if(p.execution==='attached'&&Date.now()-(this.online.get(p.agent)||0)>30000)throw new RadarError('AGENT_OFFLINE','请先让选定Agent调用automation_next连接当前会话；不会改用其他模型');return this.launch(p,now(),'manual');}
 launch(p:AutomationPlan,due:string,trigger:'manual'|'schedule',clock=Date.now()){
  if(this.closed)throw new RadarError('CANCELLED','执行服务正在关闭');
  if(p.execution==='background'&&(p.agent==='WorkBuddy'||!this.config.runners[p.agent]?.command))throw new RadarError('RUNNER_NOT_FOUND','选定宿主无可用后台入口，不降级为DSH');
  if(p.delivery!=='draft'&&(!p.enabled||!p.sendApproved))throw new RadarError('MAIL_DISABLED','发送计划尚未启用；请启用并授权，或改为仅草稿后运行');
  if(p.delivery==='smtp'&&(!this.config.runtimeEnabled||!this.config.email.enabled))throw new RadarError('DELIVERY_DISABLED','全局SMTP尚未启用；未启动采集或投递');
  if(p.delivery==='smtp'&&(this.config.email.transport!=='smtp'||!this.config.email.host||this.config.email.from!==p.from||!process.env[this.config.email.passwordEnv]))throw new RadarError('EMAIL_SETUP_REQUIRED','SMTP连接、发件身份或密码环境变量未就绪；未启动采集');
  const lease=insertRun(this.store,p,due,trigger,clock);if(!lease)return {started:false,reason:'duplicate_or_active'};
  lease.data.topicRevisions=Object.fromEntries(this.store.topics().filter(t=>p.topicIds.includes(t.id)).map(t=>[t.id,t.revision]));
  const controller=new AbortController();this.active.set(lease.id,controller);this.runningData.set(lease.id,lease.data);
  this.execute(p,lease,controller.signal).finally(()=>{this.active.delete(lease.id);this.runningData.delete(lease.id);});return {started:true,runId:lease.id};
 }
 guard(p:AutomationPlan,signal:AbortSignal){if(signal.aborted||this.closed)throw new RadarError('CANCELLED','运行已取消');const current=planById(this.store,p.id);if(!current||current.revision!==p.revision)throw new RadarError('PLAN_CHANGED','计划已变更，停止旧轮次');for(const id of p.topicIds){const topic=this.store.topics().find(t=>t.id===id&&t.enabled);if(!topic)throw new RadarError('TOPIC_CHANGED','主题已关闭或移除');}}
 async requestModel(p:AutomationPlan,runId:string,prompt:string,schema:object,signal?:AbortSignal){
  if(signal?.aborted)throw new RadarError('CANCELLED','任务已取消');
  const id='automation-model:'+randomUUID(),token=randomUUID(),expires=Date.now()+600000,data={runId,agent:p.agent,prompt,schema,status:'pending',result:null};
  const parent=this.runningData.get(runId),previousStage=parent?.stage;if(parent)parent.stage='awaiting_model';
  this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(id,'running',p.agent,token,expires,JSON.stringify(data),now());
  try{while(Date.now()<expires){if(signal?.aborted||this.closed||this.active.get(runId)?.signal.aborted)throw new RadarError('CANCELLED','模型任务已取消');const row=this.store.job(id) as any;if(row.state!=='running')throw new RadarError('LEASE_LOST','模型任务已失效');const current=JSON.parse(row.data);if(current.status==='rejected')throw new RadarError('INVALID_AGENT_OUTPUT',current.validationError||'模型结果连续校验失败');if(current.status==='completed'){this.store.finish(id,token);return {stdout:JSON.stringify(current.result),stderr:'',code:0};}await pause(100);}throw new RadarError('RUNNER_TIMEOUT','等待当前宿主模型超过10分钟；未切换其他宿主');}
  catch(error){try{this.store.finish(id,token,'cancelled');}catch{}throw error;}finally{if(parent?.stage==='awaiting_model')parent.stage=previousStage;}
 }
 async next(agent:string,waitMs=0,sessionId='local-session'){
  if(!automationAgents.includes(agent)||!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>20000)throw new RadarError('INVALID_INPUT','宿主或等待时间无效，等待最多20秒');
  const end=Date.now()+waitMs;
  do{this.online.set(agent,Date.now());this.tick();const rows=this.store.db.prepare("SELECT t.id,t.token,t.data,t.expires_at FROM jobs t JOIN jobs r ON r.id=json_extract(t.data,'$.runId') WHERE t.id LIKE 'automation-model:%' AND t.state='running' AND t.owner=? AND t.expires_at>? AND json_extract(t.data,'$.status')='pending' AND coalesce(json_extract(t.data,'$.claimedSession'),'') IN ('',?) AND r.state='running' AND r.expires_at>? ORDER BY t.updated_at,t.rowid LIMIT 1").all(agent,Date.now(),sessionId,Date.now()) as any[];
   for(const row of rows){const task=this.store.tx(()=>{const latest=this.store.job(row.id) as any;if(!latest||latest.state!=='running'||latest.owner!==agent||latest.token!==row.token||latest.expires_at<=Date.now())return null;const d=JSON.parse(latest.data);if(d.status!=='pending'||d.claimedSession&&d.claimedSession!==sessionId)return null;const run=this.store.job(d.runId) as any;if(!run||run.state!=='running'||run.expires_at<=Date.now())return null;d.claimedSession=sessionId;this.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(d),row.id);return {id:row.id,token:row.token,agent,runId:d.runId,prompt:d.prompt,schema:d.schema,...(JSON.parse(d.prompt).kind==='inspiration-card'?{kind:'inspiration-card'}:{}),...(d.validationError?{validationError:d.validationError,correctionsRemaining:3-d.validationFailures}:{}),expiresAt:new Date(row.expires_at).toISOString()};});if(task)return {task,instruction:'用当前宿主模型阅读prompt并按schema返回JSON，通过automation_submit提交；accepted=false且retryable=true时只纠正原任务，不创建新轮次；不得自行访问平台或发信；宿主名为自报，非身份认证'};}
   if(Date.now()>=end||this.closed)break;await pause(100);
  }while(true);return {task:null,instruction:'没有待处理模型任务；需要持续参与已启用计划时，在当前会话继续调用next；本服务不能主动唤醒已关闭的Agent应用'};
 }
 submit(input:{taskId:string;token:string;agent:string;result:any}){return this.store.tx(()=>{
  const row=this.store.job(input.taskId) as any;if(!row||!row.id.startsWith('automation-model:')||row.token!==input.token||row.owner!==input.agent||row.state!=='running'||row.expires_at<=Date.now())throw new RadarError('LEASE_LOST','模型任务、宿主或令牌已失效');
  const d=JSON.parse(row.data),run=this.store.job(d.runId) as any;if(!run||run.state!=='running'||run.expires_at<=Date.now())throw new RadarError('LEASE_LOST','父轮次已失效');
  const r=JSON.parse(run.data),p=planById(this.store,r.planId);if(!p||p.revision!==r.planRevision||this.active.get(d.runId)?.signal.aborted)throw new RadarError('PLAN_CHANGED','父计划已变化或取消');
  if(!input.result||typeof input.result!=='object'||Array.isArray(input.result)||JSON.stringify(input.result).length>150000)throw new RadarError('INVALID_AGENT_OUTPUT','结果需要有界JSON对象');
  if(d.status!=='pending')throw new RadarError('ALREADY_SUBMITTED','任务已提交，不重复覆盖');
  const optionalTask=JSON.parse(d.prompt).kind==='inspiration-card';const issue=optionalTask?inspirationTaskIssue(d.prompt,input.result,this.store):validateModelTaskResult(d.prompt,input.result);
  if(issue){d.validationFailures=(d.validationFailures||0)+1;d.validationError=issue;if(d.validationFailures>=3)d.status='rejected';this.store.db.prepare('UPDATE jobs SET data=?,updated_at=? WHERE id=?').run(JSON.stringify(d),now(),row.id);return {accepted:false,code:'INVALID_AGENT_OUTPUT',retryable:d.validationFailures<3,optionalTask,taskId:row.id,correctionsRemaining:Math.max(0,3-d.validationFailures),error:issue,instruction:d.validationFailures<3?'原任务仍待提交。仅按原prompt/schema纠正本任务，使用相同taskId和token重新submit；不要另开轮次，也不要把未接受结果计为有效判断。':optionalTask?'本次可选灵感任务已停止，主结果保留；继续查看同轮状态与后续任务，不另开轮次。':'本任务已连续三次校验失败，停止本轮，不补开第二轮。'};}
  d.status='completed';d.result=input.result;this.store.db.prepare('UPDATE jobs SET data=?,updated_at=? WHERE id=?').run(JSON.stringify(d),now(),row.id);return {accepted:true,semanticValidation:'pipeline will validate citations, summaries and schema before preparing mail'};
 });}
 async execute(p:AutomationPlan,lease:any,signal:AbortSignal){
  const run=lease.data,store=this.store,config=this.config;
  const check=()=>{this.guard(p,signal);if(store.topics().some(t=>p.topicIds.includes(t.id)&&t.revision!==run.topicRevisions[t.id]))throw new RadarError('TOPIC_CHANGED','主题版本已变化，停止旧轮次');store.checkpoint(lease.id,lease.token,run,600000);};
  const heartbeat=setInterval(()=>{try{check();}catch{this.active.get(lease.id)?.abort();}},10000);
  try{
   check();const batch=batchForRun(p,run),queue=this;
   class AttachedRunner extends HostRunner{async invoke(prompt:string,schema:object,s?:AbortSignal){return queue.requestModel(p,run.id,prompt,schema,s);}}
   const runner=p.execution==='attached'?new AttachedRunner(p.agent,{},resolve(config.dataDir,'runner',randomUUID()),config.limits):new HostRunner(p.agent,config.runners[p.agent],resolve(config.dataDir,'runner',randomUUID()),config.limits);
   const sections:{text:string;html:string}[]=[],keys:string[]=[],windows:any[]=[],inspirationSeeds:{topicId:string;videoKey:string}[]=[];
   if(p.platforms.includes('github')){
    run.stage='github';check();const result=await (this.dependencies.github||runGithub)({store,source:this.dependencies.githubSource||new GitHubSource(undefined,store),runner,topicId:'*',topicIds:p.topicIds,batch,outputDir:resolve(config.dataDir,'previews'),recipient:p.recipient||'preview@example.invalid',limit:p.githubReadLimit,selectedLimit:5,signal,mailTemplate:loadMailTemplate(config.dataDir),freezeDelivery:false,allowPartialDiscovery:true});check();
    run.results.push({platform:'github',state:result.state,selected:result.selected,counts:result.counts,blockingIssues:result.blockingIssues,warnings:result.warnings||result.errors,discoveryIncompleteTopics:(result.collectionWindows||[]).filter((w:any)=>w.discoveryIncomplete).map((w:any)=>w.topicId),errors:result.state==='prepared'?[]:result.errors});if(result.state!=='prepared'||!result.digest?.contentReady)throw new RadarError('CONTENT_INCOMPLETE','GitHub必需正文、模型结果或邮件栏目未齐备；具体原因见blockingIssues，普通阅读提示不阻止投递');if(result.selected>0||result.digest.audit?.daily?.length||result.digest.audit?.weekly?.length)sections.push(result.digest);keys.push(...result.itemKeys);windows.push(...result.collectionWindows||[]);
   }
   let remaining=p.readLimit;const readKeys:string[]=[];
   for(const topic of store.topics().filter(t=>p.topicIds.includes(t.id)&&t.platforms.includes('bilibili')&&p.platforms.includes('bilibili'))){
    if(!remaining)break;run.stage='bilibili';check();const source=new BilibiliSource({credentialFile:config.bilibili.credentialFile||undefined}),feed=new BilibiliInterestSource(source);
    const result=await (this.dependencies.bilibili||runInterestRound)({store,dataDir:config.dataDir,topicId:topic.id,readLimit:remaining,recoverUnread:true,excludeKeys:readKeys,signal,source:this.dependencies.bilibiliSource||{recommendations:(n:number)=>feed.recommendations(n),search:(k:string,n:number)=>source.search(k,n),read:(b:string,o:any)=>readConfiguredBilibili(config,b,o,signal,source)},analyze:(t:string,k:string,s:AbortSignal,g:any)=>analyzeArchived({store,runner,topicId:t,itemKey:k,signal:s,commitGuard:()=>{check();g?.();}})});check();remaining-=Math.max(1,result.counts.assessed);readKeys.push(...result.results.map((r:any)=>r.itemKey));
    const skippedReasons=result.results.filter((r:any)=>r.state==='no_subtitle'||r.state==='insufficient_body'||r.state==='failed').map((r:any)=>({state:r.state,code:r.code||r.acquisition?.asr?.find((a:any)=>a.reason)?.reason||null}));
    run.results.push({platform:'bilibili',topicId:topic.id,counts:result.counts,skippedReasons,stoppedReason:result.stoppedReason});if(result.stage==='stopped'||result.stoppedReason||result.sampleIssue)throw new RadarError('CONTENT_INCOMPLETE','B站轮次未正常完成，保留取得结果，不自动发送');
    if(result.sample){const sample=readBilibiliSample(config.dataDir,result.sample.id);sections.push(sample);keys.push(...sample.entries.map((e:any)=>e.itemKey));inspirationSeeds.push(...sample.entries.map((e:any)=>({topicId:topic.id,videoKey:e.itemKey})));windows.push(...sample.collectionWindows||[]);}
   }
   check();if(!sections.length){const bili=run.results.filter((r:any)=>r.platform==='bilibili');run.stage=bili.some((r:any)=>r.counts.failed>0)?'incomplete_reading':!run.results.some((r:any)=>r.platform==='github')&&bili.some((r:any)=>r.counts.attempted>0)&&bili.every((r:any)=>r.counts.assessed===0)?'no_readable_material':'no_selection';run.completedAt=now();store.checkpoint(lease.id,lease.token,run,600000);store.finish(lease.id,lease.token);return;}
   if(p.inspiration?.enabled&&inspirationSeeds.length){run.stage='inspiration';const protectedSnapshots=new Map(keys.map(key=>[key,store.readingSnapshot(key)]));check();run.inspiration=await runInspirationFollowups({store,plan:p,seeds:inspirationSeeds,protectedKeys:keys,signal,guard:check,invoke:(prompt,schema,s)=>runner.invoke(prompt,schema,s),readRepository:this.dependencies.inspirationReadRepository,timeoutMs:this.dependencies.inspirationTimeoutMs,onProgress:report=>{run.inspiration=report;check();}});check();for(const [key,snapshot] of protectedSnapshots)if(store.readingSnapshot(key)!==snapshot)throw new RadarError('SOURCE_CHANGED','灵感跟进期间原邮件材料已变化，未冻结过期邮件');}
   const subject=p.subject.replaceAll('{date}',batch.date).replaceAll('{time}',batch.slot),body={kind:'automation-digest',formatVersion:MAIL_FORMAT,contentReady:true,simulation:false,verification:false,batch,collectionWindows:windows,subject,text:sections.map(s=>s.text).join('\n\n'),html:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="font:15px/1.8 system-ui;max-width:760px;margin:auto;padding:24px">'+sections.map(s=>/<body[^>]*>([\s\S]*?)<\/body>/i.exec(s.html)?.[1]||s.html).join('\n')+'</body></html>',planId:p.id,planRevision:p.revision,runId:run.id,attemptDate:beijingDate(),itemKeys:[...new Set(keys)],itemSnapshots:[...new Set(keys)].map(itemKey=>({itemKey,fingerprint:store.fingerprint(itemKey),snapshot:store.readingSnapshot(itemKey)}))};
   const folder=resolve(config.dataDir,'automation-previews');mkdirSync(folder,{recursive:true});const file=hash(run.id)+'.html';writeFileSync(resolve(folder,file),body.html);run.preview='/preview/automation?id='+hash(run.id);run.body=body;
   if(p.delivery==='draft'){run.stage='draft_ready';}
   else{check();const deliveryId='automation-mail:'+hash(run.id);store.prepareDelivery(deliveryId,'email',p.recipient!,JSON.stringify(body),body.itemKeys);run.deliveryId=deliveryId;run.stage=p.delivery==='host'?'awaiting_host_mail':'smtp_ready';store.checkpoint(lease.id,lease.token,run,600000);
    if(p.delivery==='smtp'){check();this.reserveAttempt(p,run,()=>{});const receipt=await (this.dependencies.send||sendEmail)({...config,recipient:p.recipient,email:{...config.email,from:p.from}},store,deliveryId);run.stage=receipt?.state==='submitted'?'mail_submitted':receipt?.state==='failed'?'mail_failed':'mail_uncertain';}
   }
   run.completedAt=now();check();store.finish(lease.id,lease.token);
  }catch(error){run.stage=signal.aborted?'cancelled':'failed';run.error=publicError(error);run.completedAt=now();try{store.checkpoint(lease.id,lease.token,run,600000);store.finish(lease.id,lease.token,signal.aborted?'cancelled':'failed');}catch{}}
  finally{clearInterval(heartbeat);}
 }
 reserveAttempt(p:AutomationPlan,run:any,claim:()=>void){return this.store.tx(()=>{
  const current=planById(this.store,p.id),once=oneOffApproval(this.store,run,p);if(!current||current.revision!==p.revision||!once&&(!current.enabled||!current.sendApproved||current.delivery==='draft'))throw new RadarError('MAIL_DISABLED','计划未启用或发送授权已变化');
  if(this.store.topics().some(t=>p.topicIds.includes(t.id)&&(!t.enabled||t.revision!==run.topicRevisions[t.id])))throw new RadarError('TOPIC_CHANGED','主题已变化，未领取旧草稿发送');
  for(const item of this.store.deliveryItems(run.deliveryId))if(item.fingerprint!==this.store.fingerprint(item.item_key))throw new RadarError('SOURCE_CHANGED','冻结邮件的材料已变化，未领取发送');
  const attemptId='automation-attempt:'+hash(run.id);if(this.store.job(attemptId))throw new RadarError('MAIL_ALREADY_CLAIMED','该轮已领取发送，失败或未知均不重发');
  const date=beijingDate(),attempts=this.store.db.prepare("SELECT data FROM jobs WHERE id LIKE 'automation-attempt:%'").all() as any[];
  const recipient=once?.recipient||p.recipient!;
  if(attempts.filter(row=>{const d=JSON.parse(row.data);return d.date===date&&d.recipient.toLowerCase()===recipient.toLowerCase()&&(p.mailBudgetScope!=='plan'||d.planId===p.id);}).length>=p.maxMessagesPerDay)throw new RadarError('MAIL_DAILY_LIMIT','当日发送尝试已达该计划的上限');
  {const delivery=this.store.delivery(run.deliveryId),body=JSON.parse(delivery.body);if(delivery.state==='prepared'&&body.attemptDate!==date){
   const quota=this.store.dailyQuota(date),items=this.store.deliveryItems(delivery.id);
   for(const platform of ['github','bilibili','xiaohongshu'])if(items.filter(i=>this.store.item(i.item_key)?.platform===platform).length>quota.platforms[platform].remaining)throw new RadarError('DAILY_QUOTA','跨日领取时当日精选配额不足，保留草稿且不发送');
   body.attemptDate=date;const serialized=JSON.stringify(body);this.store.db.prepare('UPDATE deliveries SET body=?,body_hash=?,updated_at=? WHERE id=?').run(serialized,hash(serialized),now(),delivery.id);
  }}
  claim();this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(attemptId,'done',p.id,'',0,JSON.stringify({runId:run.id,planId:p.id,recipient,date}),now());return true;
 });}
 claimMail(input:{runId:string;agent:string;from:string}){
  const row=this.store.job(input.runId) as any;if(!row||row.state!=='done')throw new RadarError('INVALID_STATE','轮次尚未正常完成');const run=JSON.parse(row.data),p=planById(this.store,run.planId);
  const once=p?oneOffApproval(this.store,run,p):null,target=once||p;
  if(!p||!target||!once&&p.delivery!=='host'||target.agent!==input.agent||target.from!==input.from||p.revision!==run.planRevision||run.stage!=='awaiting_host_mail')throw new RadarError('MAIL_IDENTITY_MISMATCH','宿主、已连接发件身份或计划版本不符');
  const frozen=this.store.delivery(run.deliveryId);if(!frozen||frozen.recipient!==target.recipient||hash(frozen.body)!==frozen.body_hash||frozenContentHash(JSON.parse(frozen.body))!==frozenContentHash(run.body))throw new RadarError('DRAFT_CHANGED','投递账本与授权的冻结正文或收件人不符');
  this.reserveAttempt(p,run,()=>{if(!this.store.beginDelivery(run.deliveryId))throw new RadarError('MAIL_ALREADY_CLAIMED','投递已尝试，不能重复领取');});
  const delivery=this.store.delivery(run.deliveryId),body=JSON.parse(delivery.body);return {deliveryId:delivery.id,from:target.from,to:delivery.recipient,subject:body.subject,text:body.text,html:body.html,contentHash:frozenContentHash(body),instruction:'核对当前真实邮箱身份后原样发送一次，再report；结果不明记uncertain，不重试'};
 }
 reportMail(input:{deliveryId:string;outcome:string;providerMessageId?:string}){
  if(typeof input.deliveryId!=='string'||!input.deliveryId.startsWith('automation-mail:')||!['submitted','uncertain'].includes(input.outcome)||input.providerMessageId!==undefined&&(typeof input.providerMessageId!=='string'||input.providerMessageId.length>2000||/[\r\n]/.test(input.providerMessageId)))throw new RadarError('INVALID_INPUT','只允许报告本轮submitted或uncertain');
  const delivery=this.store.delivery(input.deliveryId);if(!delivery||delivery.state!=='submitting')throw new RadarError('INVALID_STATE','投递未领取或已报告');return this.store.transitionDelivery(input.deliveryId,input.outcome,{source:'host_self_report',providerMessageId:input.providerMessageId||null,independentlyConfirmed:false});
 }
}
