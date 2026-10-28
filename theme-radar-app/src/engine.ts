import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.ts';
import { GitHubSource } from './github.ts';
import { renderDigest } from './mail.ts';
import { deliveryKey } from './time.ts';
import { collectionWindow, activityInWindow } from './selection.ts';
import type { CollectionWindow } from './selection.ts';
import { RadarError, hash } from './model.ts';
import {isEmailAddress} from './email-address.ts';
import {tracedAssessment} from './archive-reading.ts';
import {materialPrompt} from './runner.ts';
import {now} from './model.ts';
import type { Assessment, Topic, Item, Evidence, Batch, Ranking } from './model.ts';
export type Runner={name?:string;describeRankings?:(rows:Ranking[],signal?:AbortSignal)=>Promise<Ranking[]>;assess:(topic:Topic,item:Item,evidence:Evidence[],signal?:AbortSignal)=>Promise<Assessment>};

export async function runGithub(options:{store:Store;source:GitHubSource;runner:Runner;topicId:string;topicIds?:string[];freezeDelivery?:boolean;allowPartialDiscovery?:boolean;batch:Batch;outputDir:string;recipient?:string|null;limit?:number;selectedLimit?:number;signal?:AbortSignal;verification?:boolean;mailTemplate?:any}){
  const {store,source,runner,batch}=options,includeSection=(id:string)=>!options.mailTemplate||options.mailTemplate.github.sections.includes(id);
  const recipient=options.recipient;if(!isEmailAddress(recipient))throw new RadarError('RECIPIENT_REQUIRED','请先在本地配置填写自己的收件邮箱；尚未采集或准备邮件');
  const topics=store.topics().filter(t=>t.enabled&&t.platforms.includes('github')&&(options.topicId==='*'||t.id===options.topicId)&&(!options.topicIds||options.topicIds.includes(t.id)));
  if(!topics.length)throw new RadarError('TOPIC_REQUIRED','请先配置并启用 GitHub 订阅主题');
  if(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1))throw new RadarError('INVALID_BUDGET','候选总预算必须为正整数');
  if(options.selectedLimit!==undefined&&(!Number.isSafeInteger(options.selectedLimit)||options.selectedLimit<1))throw new RadarError('INVALID_BUDGET','精选预算必须为正整数');
  const selectedLimit=Math.min(options.selectedLimit??5,5);
  const totalBudget=Math.min(options.limit||20,20);let attempted=0,cachedReads=0,newAssessments=0,reusedAssessments=0;
  const jobId=`github-digest:${batch.key}`,priorJob=store.job(jobId) as any,priorCursor=priorJob?JSON.parse(priorJob.data):{};
  source.store=store;
  const existing=store.delivery(deliveryKey(recipient,batch));
  // An outbox commit may survive a process crash before the job is finished.
  // Never refresh a frozen batch or retry an uncertain transport here.
  if(existing){const job=store.job(jobId) as any;if(job?.state==='done'||(job?.state==='running'&&job.expires_at>Date.now()))return {jobId,state:'already_claimed_or_completed',job,deliveryId:existing.id,deliveryState:existing.state};
    return {jobId,state:existing.state==='prepared'?'prepared':'delivery_exists',deliveryId:existing.id,recovered:true,deliveryState:existing.state,frozenBodyHash:existing.body_hash};}
  const globalCooldown=source.cooldown();
  if(globalCooldown)return {jobId,state:'rate_limited',retryAt:globalCooldown.retryAt};
  if(priorCursor.retryAt&&Date.parse(priorCursor.retryAt)>Date.now())return {jobId,state:'rate_limited',retryAt:priorCursor.retryAt};
  const lease=store.claim(jobId,runner.name||'configured-runner',600000);
  if(!lease)return {jobId,state:'already_claimed_or_completed',job:store.job(jobId)};
  const materials:Record<string,{fingerprint:string;evidenceIds:string[];warnings:string[]}>=lease.cursor.materials||{};
  const checkpoint=(cursor:object)=>store.checkpoint(jobId,lease.token,{...cursor,materials},600000);
  const errors:string[]=['活动时间取仓库创建、最近push和最新发布的实际时间；按左闭右开窗口过滤。采集为当前材料，不是历史时点快照；有数量上限，不能保证穷尽发现。','搜索按窗口内push发现候选，首次基线优先公开Star信号；关注仓库另行检查发布。可能漏掉仅发布而无窗口内push的未关注仓库。'],entries:any[]=[],completed=new Set<string>(lease.cursor.completed||[]),windows:CollectionWindow[]=[],filtered:Record<string,number>={};let rankings:any[]=[],weeklyRankings:any[]=[],rawSnapshot:string|null=null,modelFailures=0,retryAt:string|null=null;
  try {
    const check=()=>{if(options.signal?.aborted)throw new RadarError('CANCELLED','任务已取消');if(topics.some(t=>!store.topics().some(current=>current.id===t.id&&current.enabled&&current.revision===t.revision)))throw new RadarError('TOPIC_CHANGED','主题版本已变化，停止旧批次');};check();
    for(const topic of (includeSection('projects')?topics:[])){const window=collectionWindow(batch,topic.id,topic.revision,store.lastConfirmedWindow(topic.id,topic.revision,recipient));windows.push(window);
      if(window.mode==='baseline_7d')errors.push(topic.name+'：首次7日基线（该订阅版本尚无已确认真实投递），不是本时段新增');
      else if(Date.parse(window.previousEndAt!)<Date.parse(batch.startAt))errors.push(topic.name+'：历史存在漏跑，本次仅处理最近时段，未补齐缺失时段');
    }
    const previous=store.previousRanking()?.rows||[];
    if(includeSection('daily'))try{const result=await source.trending();rankings=result.rows;store.rankingSnapshot(rankings,result.collectedAt);mkdirSync(options.outputDir,{recursive:true});rawSnapshot=resolve(options.outputDir,`daily-${hash(result.html).slice(0,16)}.html`);writeFileSync(rawSnapshot,result.html);}catch(e){errors.push('Daily 榜：'+(e as Error).message);}
    if(includeSection('weekly'))try{const result=await source.trending('weekly');weeklyRankings=result.rows;store.rankingSnapshot(weeklyRankings,result.collectedAt,'weekly');mkdirSync(options.outputDir,{recursive:true});writeFileSync(resolve(options.outputDir,`weekly-${hash(result.html).slice(0,16)}.html`),result.html);}catch(e){errors.push('Weekly 榜：'+(e as Error).message);}
    if(runner.describeRankings){try{const rows=await runner.describeRankings([...rankings,...weeklyRankings],options.signal);rankings=rows.filter(r=>(r.period||'daily')==='daily');weeklyRankings=rows.filter(r=>r.period==='weekly');for(const [period,rows] of [['daily',rankings],['weekly',weeklyRankings]] as const)if(rows.length)store.rankingSnapshot(rows,rows[0].observedAt,period);}catch(e){errors.push('榜单中文简介：'+(e as Error).message);modelFailures++;}}
    topicLoop: for(const [topicIndex,topic] of (includeSection('projects')?topics:[]).entries()){
      const window=windows[topicIndex];let topicFailed=false;
      const allocation=Math.floor(totalBudget/topics.length)+(topicIndex<totalBudget%topics.length?1:0);
      if(!allocation){errors.push(topic.name+'：本批次总预算不足，未处理此主题');continue;}
      let candidates:any[]=[];
      try{const discovered=await source.search(topic,Math.min(Math.max(allocation*4,10),50),window);candidates=discovered.items;
        store.log('github_discovery',{jobId,topicId:topic.id,returned:candidates.length,total:discovered.total,incomplete:discovered.incomplete,query:discovered.query});
        if(discovered.incomplete){window.discoveryIncomplete=true;errors.push(topic.name+'：搜索返回部分候选，已取得内容仍逐条校验；本主题不标记完整覆盖、不推进覆盖窗口');}}catch(e){topicFailed=true;errors.push(topic.name+'：主题搜索 '+(e as Error).message);if((e as RadarError).code==='RATE_LIMITED'){retryAt=String((e as RadarError).details.retryAt);break topicLoop;}}
      // Keep one new-project exploration slot; use the other bounded slots for
      // stronger public signals, without imposing a minimum-star gate.
      const exploratory=[...candidates].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0))[0],mature=[...candidates].sort((a,b)=>(b.stars||0)-(a.stars||0));
      candidates=allocation>1&&exploratory?[...mature.slice(0,allocation-1),exploratory,...mature]:mature;
      const repositories=[...new Set([...(topic.repositories||[]),...candidates.map(c=>c.repo)])].slice(0,allocation);
      for(const repo of repositories){check();if(attempted>=totalBudget)break topicLoop;attempted++;checkpoint({stage:'reading',completed:[...completed],repo,topicId:topic.id});
        try{const cached=materials[repo],key='github:'+repo;
          const stored=cached&&store.fingerprint(key)===cached.fingerprint?store.evidence(key).filter(e=>cached.evidenceIds.includes(e.id!)):[];
          const collected=cached&&stored.length===cached.evidenceIds.length?{item:store.item(key) as Item,evidence:stored,warnings:cached.warnings}:await source.read(repo,{window});
          if(cached&&stored.length===cached.evidenceIds.length)cachedReads++;
          const activity=activityInWindow(collected.item,window);collected.item.metadata.selection={...activity,window};
          if(collected.evidence.every(e=>e.kind==='repository-metadata'||e.kind==='release')&&!activity.eligible){
            filtered[activity.reason]=(filtered[activity.reason]||0)+1;
            if(activity.reason==='unknown_activity')topicFailed=true;
            // Do not overwrite a previous full-content fingerprint with a
            // metadata-only skip. Unknown timestamps remain inspectable.
            if(activity.reason==='unknown_activity'&&!store.item(collected.item.key))store.capture(collected.item,collected.evidence);
            store.log('github_window_skip',{jobId,key:collected.item.key,topicId:topic.id,...activity,materialRequestsSkipped:true});continue;
          }
          check();const captured=store.capture(collected.item,collected.evidence),evidence=store.evidence(collected.item.key).filter(e=>captured.evidenceIds.includes(e.id!));
          materials[repo]={fingerprint:captured.fingerprint,evidenceIds:captured.evidenceIds,warnings:collected.warnings};
          checkpoint({stage:'reading',completed:[...completed],repo,topicId:topic.id});
          errors.push(...collected.warnings.map(w=>repo+'：'+w));
          if(!activity.eligible){filtered[activity.reason]=(filtered[activity.reason]||0)+1;if(activity.reason==='unknown_activity'){topicFailed=true;errors.push(repo+'：来源活动时间缺失，不用发现时间补值');}store.log('github_window_skip',{key:collected.item.key,topicId:topic.id,...activity});continue;}
          if(!evidence.some(e=>e.kind==='readme'&&e.text.trim()))throw new RadarError('REQUIRED_MATERIAL','未取得README，不以元数据替代项目阅读');
          if(store.alreadyRecommended(collected.item.key)){errors.push(repo+'：内容未变化，已推荐或已有待投递记录；日榜仍保留');completed.add(topic.id+':'+collected.item.key);continue;}
          const cursorKey=topic.id+':'+collected.item.key+':'+captured.fingerprint;
          let assessment=completed.has(cursorKey)?store.assessments(topic.id).find(a=>a.itemKey===collected.item.key&&a.topicRevision===topic.revision&&a.itemFingerprint===captured.fingerprint&&a.readEvidenceIds.every(id=>evidence.some(e=>e.id===id))):null;
          if(!assessment&&options.freezeDelivery===false){const snapshot=store.readingSnapshot(collected.item.key);assessment=store.assessments(topic.id).find(a=>a.itemKey===collected.item.key&&a.topicRevision===topic.revision&&a.itemFingerprint===captured.fingerprint&&a.agent===runner.name&&!a.simulation&&a.reading?.snapshot===snapshot&&a.readEvidenceIds.every(id=>evidence.some(e=>e.id===id)))||null;}
          if(assessment)reusedAssessments++;
          else{try{const startedAt=now(),snapshot=store.readingSnapshot(collected.item.key),bundle=materialPrompt(topic,collected.item,evidence);assessment=await runner.assess(topic,collected.item,evidence,options.signal);check();if(options.freezeDelivery===false){assessment=tracedAssessment(assessment,collected.item,bundle,snapshot,startedAt);store.saveArchivedAssessment(topic.id,topic.revision,snapshot,assessment);}else store.saveAssessment(topic.id,assessment);newAssessments++;}catch(e){modelFailures++;throw e;}}
          completed.add(cursorKey);entries.push({item:collected.item,evidence,assessment});
          store.log('github_item',{key:collected.item.key,change:captured.change,topicId:topic.id});
          checkpoint({stage:'reading',completed:[...completed],repo,topicId:topic.id});
        }catch(e){topicFailed=true;if((e as RadarError).code==='CANCELLED'||(e as RadarError).code==='LEASE_LOST')throw e;errors.push(repo+'：'+(e as Error).message);if((e as RadarError).code==='RATE_LIMITED')retryAt=String((e as RadarError).details.retryAt);if(['RATE_LIMITED','AUTH_REQUIRED','MODEL_QUOTA_EXCEEDED','PROVIDER_CHANNEL_REJECTED','RUNNER_NOT_FOUND','AGENT_FAILED','RUNNER_TIMEOUT','INVALID_AGENT_OUTPUT'].includes((e as RadarError).code))break topicLoop;}
      }
      window.processingCompleted=!topicFailed;
      window.completed=!topicFailed&&!window.discoveryIncomplete;
    }
    check();
    const remaining=options.verification||runner.name==='fixture'?selectedLimit:store.dailyQuota(batch.date).platforms.github.remaining;
    const selected=[...new Map(entries.filter(e=>e.assessment.selected).map(e=>[e.item.key,e])).values()].slice(0,Math.min(selectedLimit,remaining));
    if(remaining<selectedLimit)errors.push(`当日GitHub精选配额剩余${remaining}条（上限5条，已含待投递预留）；多余判断保留档案，本批次不再展开`);
    if(modelFailures)errors.push('部分材料未取得模型结果；此批次暂停自动投递，等待恢复。');
    errors.push('时间过滤跳过：'+JSON.stringify(filtered));
    if(options.verification)errors.unshift('隔离只读联调样张；不代表正式七主题完整验收，未发送邮件。');
    const digest=renderDigest({batch,entries:selected,rankings,weeklyRankings,previousRankings:previous,warnings:errors,simulation:runner.name==='fixture',collectionWindows:windows,verification:options.verification,mailTemplate:options.mailTemplate});
    const blockingIssues=[...(modelFailures?['model_result_incomplete']:[]),...windows.filter(w=>!w.completed&&!(options.allowPartialDiscovery===true&&w.discoveryIncomplete===true&&w.processingCompleted===true)).map(w=>'topic_processing_incomplete:'+w.topicId),...(includeSection('daily')&&!rankings.length?['daily_ranking_missing']:[]),...(!digest.simulation&&!digest.contentReady?digest.contentIssues:[])];
    const id=deliveryKey(recipient,batch),needsValidation=blockingIssues.length>0;
    mkdirSync(options.outputDir,{recursive:true});const path=resolve(options.outputDir,`${batch.date}-${batch.slot.replace(':','')}.html`);writeFileSync(path,digest.html);
    if(!needsValidation&&options.freezeDelivery!==false)store.prepareDelivery(id,'email',recipient,JSON.stringify(digest),selected.map(e=>e.item.key));
    checkpoint({stage:needsValidation?'needs_validation':'prepared',completed:[...completed],preview:path,rawSnapshot,errors,retryAt});
    store.finish(jobId,lease.token,needsValidation?'failed':'done');
    return {jobId,state:needsValidation?'needs_validation':'prepared',preview:path,deliveryId:needsValidation||options.freezeDelivery===false?null:id,selected:new Set(selected.map(e=>e.item.key)).size,selectedLimit,ranked:rankings.length,attempted,totalBudget,counts:{attempted,cached:cachedReads,acquired:attempted-cachedReads,assessed:entries.length,newAssessments,reusedAssessments},filtered,collectionWindows:windows,retryAt,blockingIssues,warnings:errors,errors,simulation:digest.simulation,...(options.freezeDelivery===false?{digest,itemKeys:selected.map(e=>e.item.key)}:{})};
  }catch(e){try{store.finish(jobId,lease.token,(e as RadarError).code==='CANCELLED'?'cancelled':'failed');}catch{}throw e;}
}
