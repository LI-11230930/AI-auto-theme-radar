import {loadMailTemplate} from './mail-template.ts';
import {listAuthorObservations} from './author-observation.ts';
import { existsSync, writeFileSync, mkdirSync,readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { loadConfig } from './config.ts';
import { GitHubSource } from './github.ts';
import { BilibiliSource,XiaohongshuSource } from './social.ts';
import { HostRunner } from './runner.ts';
import { RadarError,now,isVideoTextKind } from './model.ts';
import { latestDue } from './time.ts';
import { runGithub } from './engine.ts';
import {renderDigest} from './mail.ts';
import {collectionWindow,activityInWindow} from './selection.ts';
import type {Batch} from './model.ts';
import {hostCapability} from './host-capability.ts';
import {analyzeArchived,archivedAnalysis} from './archive-reading.ts';
import {runtimeStatus} from './runtime-status.ts';
import {notificationPlan} from './digest-candidates.ts';

export function context(){const config=loadConfig();const store=new Store(resolve(config.dataDir,'radar.sqlite'));for(const topic of config.topics){const existing=store.topics().find(t=>t.id===topic.id);if(!existing)store.saveTopic(topic);}return {config,store};}
export async function analyzeConfiguredArchive(config:any,store:Store,topicId:string,itemKey:string,signal?:AbortSignal,commitGuard?:()=>void){const name=config.defaultAgent;try{const result=await analyzeArchived({store,topicId,itemKey,signal,commitGuard,runner:new HostRunner(name,config.runners[name],resolve(config.dataDir,'runner',randomUUID()),config.limits)});if(!result.reused)writeReport(config,`agent-analysis-${name}.json`,{at:now(),ok:true,topicId,itemKey,agent:name,scope:'actual configured archive runner; reused judgments do not update model health'});return result;}catch(error){const code=(error as RadarError).code;if(['AGENT_FAILED','INVALID_AGENT_OUTPUT','MODEL_QUOTA_EXCEEDED','AUTH_REQUIRED','RUNNER_TIMEOUT','RUNNER_NOT_FOUND','PROVIDER_CHANNEL_REJECTED'].includes(code))writeReport(config,`agent-analysis-${name}.json`,{at:now(),ok:false,code,topicId,itemKey,agent:name,scope:'one actual archive runner failure; stopped without retry'});throw error;}}
const savedReport=(config:any,name:string)=>{try{return JSON.parse(readFileSync(resolve(config.dataDir,'reports',name),'utf8'));}catch{return null;}};
export function authorObservationCapability(config:any,store:Store){
  try{const current=listAuthorObservations(store,config.dataDir).observations.filter((r:any)=>r.current),authors=new Set(current.map((r:any)=>r.snapshot.authorUid)),links=new Set(current.flatMap((r:any)=>r.snapshot.items.map((i:any)=>i.bvid)));
    if(current.length)return {id:'bilibili-authors',state:'browser_observations_imported',note:`当前订阅已有${authors.size}位作者、${links.size}个去重可见投稿链接，来自用户浏览器观察；取得视频前另核对实际UID。没有将链接计为字幕阅读、全量历史或云端独立采集。`};
  }catch{return {id:'bilibili-authors',state:'observation_store_error',note:'作者观察目录未完成读取，请核对本地记录；未把错误计为空投稿。'};}
  return {id:'bilibili-authors',state:savedReport(config,'bilibili-authors-live.json')?.sources?.some((s:any)=>s.state==='failed')?'source_access_restricted':'configured_unverified',note:'订阅UID已配置；公共投稿接口限制与浏览器观察分开，实际来源另验，不将失败当作空投稿。'};
}
export function capabilityReport(config:any,store:Store){const browser=savedReport(config,'browser-identity.json'),outlook=savedReport(config,'outlook-test.json'),sample=savedReport(config,'github-sample-receipt.json'),cloud=savedReport(config,'cloud-trial.json'),trial=savedReport(config,'seven-topic-window.json');const active=new GitHubSource(undefined,store).cooldown(),cooldown=!!active,sampleReceived=sample?.sentCount===1&&sample?.inboxCount===1&&sample?.queryComplete===true,sevenReady=trial?.ok===true&&trial?.runner!=='fixture'&&trial?.topicCount===7&&trial?.perTopic?.length===7&&trial.perTopic.every((t:any)=>t.searchSucceeded&&t.assessments>0);return {at:now(),service:runtimeStatus(),notificationPlan:notificationPlan(config.recipient),runtimeEnabled:config.runtimeEnabled,recipient:config.recipient,timezone:config.timezone,sendTimes:config.sendTimes,defaultAgent:config.defaultAgent,topics:store.topics(),stats:store.stats(),capabilities:[
  {id:'github',state:cooldown?'rate_limit_cooldown':'available_public_read',note:cooldown?'公开API额度耗尽，等待'+active!.retryAt+'；不要求重复登录或DSH授权。':'公开查询/README/Release/许可证/源码抽样/Daily；活动窗口已过滤，真实请求另记。'},
  {id:'github-digest',state:sevenReady?'seven_topic_preview_ready':'needs_complete_trial',note:sevenReady?'七主题真实DSH筛选、5项精选及Daily前10已生成，用户已确认内容质量；本机记录与后续云端样张分别留档，自动投递关闭。':'完整七主题真实筛选和Daily预览尚待通过。'},
  {id:'cloud',state:cloud?.checks?.publicGitHubSearch?.status==='verified'?'earlier_cloud_probe_saved':'not_verified',note:cloud?'本机保留早期云端只读探测；云端当前有限试运行状态独立见私有站点和进度看板。本地缓存不作云端投递开关判断。':'当前本地运行不能证明云端调度可用。'},
  bilibiliCapability(config,browser,store),
  authorObservationCapability(config,store),
  {id:'notification-format',state:'confirmed',note:'GitHub三部分正文已确认，新增日/周周期Star与累计Star及项目流程示意；用途概括与文档明确流程分列。技术记录仅留档；发送与调度仍关闭。'},
  {id:'xiaohongshu',state:config.xiaohongshu.enabled===false?'paused_by_user':'needs_bridge_and_login',note:config.xiaohongshu.enabled===false?'用户本轮暂缓；自检与MCP不访问此平台。':'需要本机桥接与内部user_id确认，doctor live可检查连接'},
  {id:'email',state:sampleReceived?'outlook_sample_received':outlook?.state==='sent_confirmed'?'outlook_test_received':config.email.enabled&&config.email.from&&process.env[config.email.passwordEnv]?'configured_unverified':'needs_sender_authorization',note:sampleReceived?'单参考主题真实样张已获独立授权，仅发1封，发送/收件各核对1条；纯文本邮件，正式任务关闭。':outlook?.state==='sent_confirmed'?'Outlook一封授权测试已核对发送/收件；自动任务仍关闭，云端待验证。':'收件人与两个时段已固定；未发送测试邮件'},
  ...Object.entries(config.runners).map(([id,spec]:[string,any])=>hostCapability(config,id,spec))
]};}
export function bilibiliCapability(config:any,browser:any,store:Store){
  const videos=store.search('',{platform:'bilibili',limit:100});
  const observed=videos.map(item=>({item,evidence:store.currentEvidence(item.key).filter(e=>isVideoTextKind(e.kind)&&e.text.trim())})).filter(v=>v.evidence.length);
  if(observed.length){
    const analyses=observed.flatMap(v=>archivedAnalysis(store,v.item.key).assessments.filter(a=>a.current&&!a.simulation&&a.reading&&a.readEvidenceIds.some(id=>v.evidence.some(e=>e.id===id)))),analyzedVideos=new Set(analyses.map(a=>a.itemKey)).size;
    const asrVideos=observed.filter(v=>v.evidence.some(e=>e.kind.startsWith('asr:'))).length,subtitleVideos=observed.filter(v=>v.evidence.some(e=>!e.kind.startsWith('asr:'))).length;
    return {id:'bilibili',state:analyses.length?(asrVideos?'archived_video_text_analysis_verified':'archived_subtitle_analysis_verified'):(asrVideos?'machine_transcript_archived':'browser_subtitle_archived'),checkedAt:analyses[0]?.createdAt||observed[0].evidence[0].collectedAt,counts:{archived:videos.length,subtitleVideos,asrVideos,videoTextVideos:observed.length,analyzedVideos,assessments:analyses.length},scope:'bounded local archive, not live login probe',note:`本地最近${videos.length}条B站档案中，${subtitleVideos}条有当前字幕、${asrVideos}条有机器转写；${analyzedVideos}条视频对应${analyses.length}份当前非模拟引用判断。Agent读取归档文本，未直接听音频或看画面，不读取评论；机器转写可能误识别，宿主观察不自动证明原字幕轨完整。`};
  }
  const checked=savedReport(config,'bilibili-reading.json'),read=checked?.checks?.find((c:any)=>c.id==='read');
  if(read?.ok){const parts=read.metadata?.subtitlePages||[],subtitles=parts.some((p:any)=>p.segments>0);return {id:'bilibili',state:subtitles?'subtitle_acquisition_verified':'metadata_read_verified_subtitles_unavailable',checkedAt:checked.at,note:subtitles?'上次探测已取得部分字幕；每次最多3个分P，当前材料/模型引用/音频和画面范围单列；不读评论。':'上次探测已取得视频简介，但接口未提供字幕轨，不能断言视频无字幕。多分P/时间轴代码已实现；真实完整字幕、ASR与画面仍待验证。'};}
  return {id:'bilibili',state:browser?.bilibili?.subtitleSample?'chrome_partial_read_verified':config.bilibili.credentialFile&&existsSync(config.bilibili.credentialFile)?'credential_file_configured':'not_verified',checkedAt:checked?.at,note:'每次最多3个分P及字幕时间轴已实现，真实取得范围另记；不读取他人评论；凭证存在不代表认证有效。'};
}
export async function liveProbe(config:any,store:Store){const results:any[]=[];const collect=async(id:string,fn:()=>Promise<unknown>)=>{try{results.push({id,ok:true,result:await fn()});}catch(e){results.push({id,ok:false,code:(e as RadarError).code||'ERROR',message:(e as Error).message});}};
  const github=new GitHubSource(undefined,store);
  await collect('github-daily',async()=>{const result=await github.trending();store.rankingSnapshot(result.rows,result.collectedAt);const folder=resolve(config.dataDir,'snapshots');mkdirSync(folder,{recursive:true});writeFileSync(resolve(folder,'daily-latest.html'),result.html);return {count:result.rows.length,first:result.rows[0].repo,collectedAt:result.collectedAt};});
  await collect('github-read',async()=>{const result=await github.read('c1overzz/dsh-bili-scroll');const captured=store.capture(result.item,result.evidence);return {key:captured.key,materials:result.evidence.map(e=>e.kind),warnings:result.warnings};});
  await collect('bilibili-search',async()=>({count:(await new BilibiliSource({credentialFile:config.bilibili.credentialFile||undefined}).search('DeepSeek Harness',2)).length,otherCommentsRead:0}));
  if(config.xiaohongshu.enabled===false)results.push({id:'xiaohongshu-status',skipped:true,reason:'user_paused'});else await collect('xiaohongshu-status',()=>new XiaohongshuSource(config.xiaohongshu.baseUrl).status());
  return {at:now(),scope:'public-read-only; no model, comment or email calls',results};
}
export async function runConfigured(config:any,store:Store,topicId='*',signal?:AbortSignal,commitGuard?:()=>void){const name=config.defaultAgent;return runGithub({mailTemplate:loadMailTemplate(config.dataDir),recipient:config.recipient,store,source:new GitHubSource(undefined,store),runner:new HostRunner(name,config.runners[name],resolve(config.dataDir,'runner',randomUUID()),config.limits),topicId,batch:latestDue(),outputDir:resolve(config.dataDir,'previews'),limit:Math.min(config.limits.candidates,20),selectedLimit:config.limits.selected,signal});}
export function writeReport(config:any,name:string,content:unknown){const path=resolve(config.dataDir,'reports',name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(content,null,2));return path;}
export function archivePreview(config:any,store:Store,batch:Batch=latestDue()){
  const entries:any[]=[],seen=new Set<string>(),windows:any[]=[];
  for(const topic of store.topics().filter(t=>t.enabled&&t.platforms.includes('github'))){
    const window=collectionWindow(batch,topic.id,topic.revision,store.lastConfirmedWindow(topic.id,topic.revision,config.recipient)),evaluated=new Set<string>();windows.push(window);
    for(const assessment of store.assessments(topic.id)){
      if(assessment.topicRevision!==topic.revision||assessment.itemFingerprint!==store.fingerprint(assessment.itemKey)||evaluated.has(assessment.itemKey))continue;
      evaluated.add(assessment.itemKey);const item=store.item(assessment.itemKey);
      if(!assessment.selected||seen.has(assessment.itemKey)||item?.platform!=='github'||!activityInWindow(item,window).eligible||store.alreadyRecommended(item.key))continue;
      seen.add(item.key);entries.push({item,evidence:store.currentEvidence(item.key),assessment});
    }
  }
  const rankings=store.previousRanking()?.rows||[],warnings=['宿主交互筛选的档案预览；仅本地已存结果，未发送邮件，不推进投递历史。','已按来源活动时间过滤；材料为采集时当前版本，档案和日榜可能不是最新快照。'];
  const selectedEntries=entries.slice(0,Math.min(config.limits?.selected??5,5));
  const digest=renderDigest({batch,entries:selectedEntries,rankings,weeklyRankings:store.previousRanking('weekly')?.rows||[],warnings,collectionWindows:windows}),folder=resolve(config.dataDir,'previews');mkdirSync(folder,{recursive:true});const path=resolve(folder,'host-preview.html');writeFileSync(path,digest.html);return {preview:path,selected:selectedEntries.length,ranked:rankings.length,weeklyRanked:store.previousRanking('weekly')?.rows.length||0,contentReady:digest.contentReady,contentIssues:digest.contentIssues,emailSent:false,collectionWindows:windows,warning:warnings};
}
