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
import { RadarError,now,isVideoTextKind,publicError } from './model.ts';
import { latestDue } from './time.ts';
import { runGithub } from './engine.ts';
import {renderDigest} from './mail.ts';
import {collectionWindow,activityInWindow} from './selection.ts';
import type {Batch} from './model.ts';
import {hostCapability} from './host-capability.ts';
import {analyzeArchived,archivedAnalysis} from './archive-reading.ts';
import {runtimeStatus} from './runtime-status.ts';
import {notificationPlan} from './digest-candidates.ts';
import {githubDigestCapability,mailFormatCapability,emailCapability} from './capability-summary.ts';
import {plans as automationPlans} from './automation-plan.ts';
import {initializeGithubCredential,githubCredentialStatus} from './github-credential.ts';

export function context(){const config=loadConfig();initializeGithubCredential(config);const store=new Store(resolve(config.dataDir,'radar.sqlite'));for(const topic of config.topics){const existing=store.topics().find(t=>t.id===topic.id);if(!existing)store.saveTopic(topic);}return {config,store};}
export async function analyzeConfiguredArchive(config:any,store:Store,topicId:string,itemKey:string,signal?:AbortSignal,commitGuard?:()=>void){const name=config.defaultAgent;try{const result=await analyzeArchived({store,topicId,itemKey,signal,commitGuard,runner:new HostRunner(name,config.runners[name],resolve(config.dataDir,'runner',randomUUID()),config.limits)});if(!result.reused)writeReport(config,`agent-analysis-${name}.json`,{at:now(),ok:true,topicId,itemKey,agent:name,scope:'actual configured archive runner; reused judgments do not update model health'});return result;}catch(error){const code=(error as RadarError).code;if(['AGENT_FAILED','INVALID_AGENT_OUTPUT','MODEL_QUOTA_EXCEEDED','AUTH_REQUIRED','RUNNER_TIMEOUT','RUNNER_NOT_FOUND','PROVIDER_CHANNEL_REJECTED'].includes(code))writeReport(config,`agent-analysis-${name}.json`,{at:now(),ok:false,code,topicId,itemKey,agent:name,scope:'one actual archive runner failure; stopped without retry'});throw error;}}
const savedReport=(config:any,name:string)=>{try{return JSON.parse(readFileSync(resolve(config.dataDir,'reports',name),'utf8'));}catch{return null;}};
export function authorObservationCapability(config:any,store:Store){
  if(!store.topics().some(t=>t.enabled&&t.platforms.includes('bilibili')&&t.bilibiliAuthors?.length))return {id:'bilibili-authors',state:'not_configured',note:'尚未配置作者UID订阅；可使用不限作者的兴趣主题，或创建自己的作者订阅。'};
  try{const current=listAuthorObservations(store,config.dataDir).observations.filter((r:any)=>r.current),authors=new Set(current.map((r:any)=>r.snapshot.authorUid)),links=new Set(current.flatMap((r:any)=>r.snapshot.items.map((i:any)=>i.bvid)));
    if(current.length)return {id:'bilibili-authors',state:'browser_observations_imported',note:`当前订阅已有${authors.size}位作者、${links.size}个去重可见投稿链接，来自用户浏览器观察；取得视频前另核对实际UID。没有将链接计为字幕阅读、全量历史或云端独立采集。`};
  }catch{return {id:'bilibili-authors',state:'observation_store_error',note:'作者观察目录未完成读取，请核对本地记录；未把错误计为空投稿。'};}
  return {id:'bilibili-authors',state:savedReport(config,'bilibili-authors-live.json')?.sources?.some((s:any)=>s.state==='failed')?'source_access_restricted':'configured_unverified',note:'订阅UID已配置；公共投稿接口限制与浏览器观察分开，实际来源另验，不将失败当作空投稿。'};
}
export function capabilityReport(config:any,store:Store){const browser=savedReport(config,'browser-identity.json'),cloud=savedReport(config,'cloud-trial.json'),format=mailFormatCapability(config.dataDir);const active=new GitHubSource(undefined,store).cooldown(),cooldown=!!active;return {at:now(),service:runtimeStatus(),githubCredential:githubCredentialStatus(config),notificationPlan:notificationPlan(config.recipient,{formatState:format.state,sections:format.githubSections}),runtimeEnabled:config.runtimeEnabled,recipient:config.recipient,timezone:config.timezone,sendTimes:config.sendTimes,defaultAgent:config.defaultAgent,topics:store.topics(),stats:store.stats(),capabilities:[
  {id:'automation',state:automationPlans(store).some(p=>p.enabled)?'plans_enabled':'disabled',note:'统一任务计划'+automationPlans(store).length+'个；自定义频率由本地服务执行，交互模式需当前Agent持续参与，后台模式需选定CLI。计划默认暂停/仅草稿；全局SMTP关闭不代表宿主邮箱计划已关闭，请核对各计划。'},
  {id:'github',state:cooldown?'rate_limit_cooldown':'available_public_read',note:cooldown?'公开API额度耗尽，等待'+active!.retryAt+'；不要求重复登录或DSH授权。':'公开查询/README/Release/许可证/源码抽样/Daily；活动窗口已过滤，真实请求另记。'},
  githubDigestCapability(store),
  {id:'cloud',state:cloud?.checks?.publicGitHubSearch?.status==='verified'?'earlier_cloud_probe_saved':'not_verified',note:cloud?'本机保留早期云端只读探测；云端当前有限试运行状态独立见私有站点和进度看板。本地缓存不作云端投递开关判断。':'当前本地运行不能证明云端调度可用。'},
  bilibiliCapability(config,browser,store),
  authorObservationCapability(config,store),
  format,
  {id:'xiaohongshu',state:config.xiaohongshu.enabled===false?'paused_by_user':'needs_bridge_and_login',note:config.xiaohongshu.enabled===false?'用户本轮暂缓；自检与MCP不访问此平台。':'需要本机桥接与内部user_id确认，doctor live可检查连接'},
  emailCapability(config,store),
  ...Object.entries(config.runners).map(([id,spec]:[string,any])=>hostCapability(config,id,spec))
]};}
export function bilibiliCapability(config:any,browser:any,store:Store){
  const videos=store.search('',{platform:'bilibili',limit:100});
  const observed=videos.map(item=>({item,evidence:store.currentEvidence(item.key).filter(e=>isVideoTextKind(e.kind)&&e.coverage.acquired>0&&e.text.trim())})).filter(v=>v.evidence.length);
  if(observed.length){
    const analyses=observed.flatMap(v=>archivedAnalysis(store,v.item.key).assessments.filter(a=>a.current&&!a.simulation&&a.reading?.materials?.some(m=>m.cited&&Number.isSafeInteger(m.providedCharacters)&&m.providedCharacters>0&&a.readEvidenceIds.includes(m.id)&&v.evidence.some(e=>e.id===m.id&&e.kind===m.kind&&m.providedCharacters<=e.text.length)))),analyzedVideos=new Set(analyses.map(a=>a.itemKey)).size;
    const asrVideos=observed.filter(v=>v.evidence.some(e=>e.kind.startsWith('asr:'))).length,ocrVideos=observed.filter(v=>v.evidence.some(e=>e.kind.startsWith('ocr:'))).length,subtitleVideos=observed.filter(v=>v.evidence.some(e=>!e.kind.startsWith('asr:')&&!e.kind.startsWith('ocr:'))).length;
    return {id:'bilibili',state:analyses.length?(asrVideos||ocrVideos?'archived_video_text_analysis_verified':'archived_subtitle_analysis_verified'):(ocrVideos?'sampled_frame_text_archived':asrVideos?'machine_transcript_archived':'browser_subtitle_archived'),checkedAt:analyses[0]?.createdAt||observed[0].evidence[0].collectedAt,counts:{archived:videos.length,subtitleVideos,asrVideos,ocrVideos,videoTextVideos:observed.length,analyzedVideos,assessments:analyses.length},boundedToLatest:100,mayHaveMore:videos.length===100,scope:'bounded local archive, not live login probe',note:`本地最近${videos.length}条B站档案中，${subtitleVideos}条有当前字幕、${asrVideos}条有机器转写、${ocrVideos}条有采样画面OCR文字（同一视频可计入多个类别）；${analyzedVideos}条视频对应${analyses.length}份当前非模拟引用判断。Agent读取归档文字，未直接听音频或看画面，不读取评论；OCR不是字幕轨，机器识别可能有误，引用记录不证明完整视听或理解。`};

  }
  const checked=savedReport(config,'bilibili-reading.json'),read=checked?.checks?.find((c:any)=>c.id==='read');
  if(read?.ok){const parts=read.metadata?.subtitlePages||[],subtitles=parts.some((p:any)=>p.segments>0);return {id:'bilibili',state:subtitles?'subtitle_acquisition_verified':'metadata_read_verified_subtitles_unavailable',checkedAt:checked.at,note:subtitles?'上次探测已取得部分字幕；每次最多3个分P，当前材料/模型引用/音频和画面范围单列；不读评论。':'上次探测已取得视频简介，但接口未提供字幕轨，不能断言视频无字幕。多分P/时间轴代码已实现；真实完整字幕、ASR与画面仍待验证。'};}
  return {id:'bilibili',state:browser?.bilibili?.subtitleSample?'chrome_partial_read_verified':config.bilibili.credentialFile&&existsSync(config.bilibili.credentialFile)?'credential_file_configured':'not_verified',checkedAt:checked?.at,note:'每次最多3个分P及字幕时间轴已实现，真实取得范围另记；不读取他人评论；凭证存在不代表认证有效。'};
}
export async function liveProbe(config:any,store:Store){const results:any[]=[];const collect=async(id:string,fn:()=>Promise<unknown>)=>{try{const value={id,ok:true,result:await fn()};results.push(value);return value;}catch(e){const safe=publicError(e),value={id,ok:false,code:safe.code,message:safe.message};results.push(value);return value;}};
  const topics=store.topics().filter(t=>t.enabled),githubTopic=topics.find(t=>t.platforms.includes('github')),biliTopic=topics.find(t=>t.platforms.includes('bilibili'));
  const github=new GitHubSource(undefined,store);
  if(githubTopic){
    const daily=await collect('github-daily',async()=>{const result=await github.trending();store.rankingSnapshot(result.rows,result.collectedAt);const folder=resolve(config.dataDir,'snapshots');mkdirSync(folder,{recursive:true});writeFileSync(resolve(folder,'daily-latest.html'),result.html);return {count:result.rows.length,first:result.rows[0]?.repo||null,collectedAt:result.collectedAt};});
    if(!daily.ok&&['AUTH_REQUIRED','ACCESS_DENIED','RATE_LIMITED'].includes((daily as any).code))results.push({id:'github-read',skipped:true,reason:'upstream_blocked'});
    else await collect('github-read',async()=>{const repo=githubTopic.repositories?.[0]||(await github.search(githubTopic,1)).items[0]?.repo;if(!repo)return {topicId:githubTopic.id,read:false,reason:'no_candidates'};const result=await github.read(repo);const captured=store.capture(result.item,result.evidence);return {topicId:githubTopic.id,key:captured.key,materials:result.evidence.map(e=>e.kind),warnings:result.warnings};});
  }else results.push({id:'github-daily',skipped:true,reason:'platform_not_subscribed'},{id:'github-read',skipped:true,reason:'platform_not_subscribed'});
  if(biliTopic)await collect('bilibili-search',async()=>({topicId:biliTopic.id,count:(await new BilibiliSource({credentialFile:config.bilibili.credentialFile||undefined}).search(biliTopic.keywords[0],2,biliTopic.bilibiliAuthors?.length?{authorUid:biliTopic.bilibiliAuthors[0]}:{})).length,otherCommentsRead:0}));else results.push({id:'bilibili-search',skipped:true,reason:'platform_not_subscribed'});
  if(config.xiaohongshu.enabled===false||!topics.some(t=>t.platforms.includes('xiaohongshu')))results.push({id:'xiaohongshu-status',skipped:true,reason:config.xiaohongshu.enabled===false?'user_paused':'platform_not_subscribed'});else await collect('xiaohongshu-status',()=>new XiaohongshuSource(config.xiaohongshu.baseUrl).status());
  return {at:now(),scope:'public-read-only; no model, comment or email calls',results};
}
export async function runConfigured(config:any,store:Store,topicId='*',signal?:AbortSignal,commitGuard?:()=>void){const name=config.defaultAgent;return runGithub({mailTemplate:loadMailTemplate(config.dataDir),recipient:config.recipient,store,source:new GitHubSource(undefined,store),runner:new HostRunner(name,config.runners[name],resolve(config.dataDir,'runner',randomUUID()),config.limits),topicId,batch:latestDue(),outputDir:resolve(config.dataDir,'previews'),limit:Math.min(config.limits.candidates,20),selectedLimit:config.limits.selected,signal});}
export function writeReport(config:any,name:string,content:unknown){const path=resolve(config.dataDir,'reports',name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(content,null,2));return path;}
export function archivePreview(config:any,store:Store,batch:Batch=latestDue()){
  const entries:any[]=[],seen=new Set<string>(),windows:any[]=[],template=loadMailTemplate(config.dataDir);
  for(const topic of store.topics().filter(t=>t.enabled&&t.platforms.includes('github'))){
    const window=collectionWindow(batch,topic.id,topic.revision,store.lastConfirmedWindow(topic.id,topic.revision,config.recipient)),evaluated=new Set<string>();windows.push(window);
    for(const assessment of store.assessments(topic.id)){
      if(assessment.topicRevision!==topic.revision||assessment.itemFingerprint!==store.fingerprint(assessment.itemKey)||evaluated.has(assessment.itemKey))continue;
      evaluated.add(assessment.itemKey);const item=store.item(assessment.itemKey);
      if(!assessment.selected||seen.has(assessment.itemKey)||item?.platform!=='github'||!activityInWindow(item,window).eligible||store.alreadyRecommended(item.key))continue;
      seen.add(item.key);entries.push({item,evidence:store.currentEvidence(item.key),assessment});
    }
  }
  const sections=template?.github.sections||['projects','daily','weekly'],rankings=sections.includes('daily')?store.previousRanking('daily')?.rows||[]:[],weeklyRankings=sections.includes('weekly')?store.previousRanking('weekly')?.rows||[]:[],warnings=['宿主交互筛选的档案预览；仅本地已存结果，未发送邮件，不推进投递历史。','已按来源活动时间过滤；材料为采集时当前版本，档案和榜单可能不是最新快照。'];
  const selectedEntries=sections.includes('projects')?entries.slice(0,Math.min(config.limits?.selected??5,5)):[];
  const digest=renderDigest({batch,entries:selectedEntries,rankings,weeklyRankings,warnings,collectionWindows:windows,mailTemplate:template}),folder=resolve(config.dataDir,'previews');mkdirSync(folder,{recursive:true});const path=resolve(folder,'host-preview.html');writeFileSync(path,digest.html);return {preview:path,selected:selectedEntries.length,ranked:rankings.length,weeklyRanked:weeklyRankings.length,contentReady:digest.contentReady,contentIssues:digest.contentIssues,simulation:digest.simulation,emailSent:false,collectionWindows:windows,warning:warnings};
}
