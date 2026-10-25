import {RadarError,requireText,now,readableEvidence} from './model.ts';
import {archivedAnalysis,archiveReadingKey,tracedAssessment} from './archive-reading.ts';
import {materialPrompt} from './runner.ts';
import type {Assessment} from './model.ts';
import type {Store} from './store.ts';

const ttl=600000,maxDuration=1800000;
const agents=['DSH','WorkBuddy','Codex','TRAE'];
export function prepareReading(store:Store,args:{topicId:string;itemKey:string;agent:string}){
  requireText(args.topicId,'主题ID',100);requireText(args.itemKey,'条目ID',300);
  if(!agents.includes(args.agent))throw new RadarError('INVALID_AGENT','请选择DSH、WorkBuddy、Codex或TRAE');
  const topic=store.topics().find(t=>t.id===args.topicId&&t.enabled),item=store.item(args.itemKey);
  if(!topic)throw new RadarError('TOPIC_REQUIRED','请选择已启用的主题');
  if(!item)throw new RadarError('NOT_FOUND','档案条目不存在');
  const snapshot=store.readingSnapshot(item.key),evidence=store.currentEvidence(item.key);
  if(!evidence.some(readableEvidence))throw new RadarError('NO_READABLE_MATERIAL','没有可分析正文');
  const existing=archivedAnalysis(store,item.key).assessments.find(a=>a.topicId===topic.id&&a.current&&a.reading?.snapshot===snapshot&&!a.simulation);
  if(existing)return {reused:true,assessment:existing,scope:'复用现有判断；不计为当前宿主重新阅读',emailSent:false};
  const jobId=archiveReadingKey(topic.id,topic.revision,snapshot),lease=store.claim(jobId,args.agent,ttl);
  if(!lease)throw new RadarError('ANALYSIS_BUSY','同一主题和材料已有执行者；等待结束或租约到期，不启动重复分析');
  const bundle=materialPrompt(topic,item,evidence),startedAt=now();
  store.checkpoint(jobId,lease.token,{kind:'interactive-reading',topicId:topic.id,revision:topic.revision,itemKey:item.key,snapshot,agent:args.agent,startedAt},ttl);
  return {reused:false,jobId,token:lease.token,expiresAt:new Date(Date.now()+ttl).toISOString(),topicRevision:topic.revision,snapshot,prompt:bundle.prompt,scope:'只读所给归档文本；完成后用reading_submit提交，取消用reading_cancel；租约10分钟，可续至首次领取后30分钟',emailSent:false};
}
function session(store:Store,jobId:string,token:string){
  requireText(jobId,'任务ID',200);requireText(token,'租约token',100);
  const job=store.job(jobId) as any;
  if(!job||job.token!==token||job.state!=='running'||job.expires_at<=Date.now())throw new RadarError('LEASE_LOST','租约已失效、结束或被接管');
  const cursor=JSON.parse(job.data);
  if(cursor.kind!=='interactive-reading')throw new RadarError('INVALID_SESSION','这不是交互阅读会话');
  if(Date.now()-Date.parse(cursor.startedAt)>=maxDuration)throw new RadarError('LEASE_LOST','交互分析已达30分钟上限');
  return cursor;
}
export function renewReading(store:Store,args:{jobId:string;token:string}){
  const cursor=session(store,args.jobId,args.token),remaining=maxDuration-(Date.now()-Date.parse(cursor.startedAt));
  store.checkpoint(args.jobId,args.token,cursor,Math.min(ttl,remaining));
  return {renewed:true,expiresAt:new Date(Date.now()+Math.min(ttl,remaining)).toISOString()};
}
export function cancelReading(store:Store,args:{jobId:string;token:string}){
  session(store,args.jobId,args.token);store.finish(args.jobId,args.token,'cancelled');return {cancelled:true};
}
export function submitReading(store:Store,args:{jobId:string;token:string;assessment:Assessment}){
  const cursor=session(store,args.jobId,args.token),topic=store.topics().find(t=>t.id===cursor.topicId&&t.enabled),item=store.item(cursor.itemKey);
  if(!topic||topic.revision!==cursor.revision)throw new RadarError('TOPIC_CHANGED','主题已变化，请取消旧会话并重新准备');
  if(!item||store.readingSnapshot(item.key)!==cursor.snapshot)throw new RadarError('SOURCE_CHANGED','材料已变化，请取消旧会话并重新准备');
  const a=args.assessment;
  if(!a||typeof a.selected!=='boolean'||typeof a.reason!=='string'||!Array.isArray(a.limitations)||a.limitations.some(x=>typeof x!=='string')||!Array.isArray(a.readEvidenceIds)||!a.readEvidenceIds.length)throw new RadarError('INVALID_ASSESSMENT','必须返回判断、理由、限制及至少一个所给正文ID');
  const bundle=materialPrompt(topic,item,store.currentEvidence(item.key));
  const assessment=tracedAssessment({...a,agent:cursor.agent,simulation:false},item,bundle,cursor.snapshot,cursor.startedAt);
  const id=store.saveArchivedAssessment(topic.id,cursor.revision,cursor.snapshot,assessment,{id:args.jobId,token:args.token});
  return {id,assessment,...archivedAnalysis(store,item.key),provenance:'interactive_host_self_report; 宿主名来自领取参数，阅读引用为模型报告，不是独立宿主身份认证'};
}
