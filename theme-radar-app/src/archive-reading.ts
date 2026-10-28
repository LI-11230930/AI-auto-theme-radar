import {RadarError,hash,now,readableEvidence,requireText} from './model.ts';
import {materialPrompt} from './runner.ts';
import type {Runner} from './engine.ts';
import type {Store} from './store.ts';
import type {Assessment,Item} from './model.ts';

export const archiveReadingKey=(topicId:string,revision:number,snapshot:string)=>'archive-reading:'+hash(JSON.stringify([topicId,revision,snapshot]));
export function tracedAssessment(result:Assessment,item:Item,bundle:ReturnType<typeof materialPrompt>,snapshot:string,startedAt:string){
  if(result.itemKey!==item.key||!Array.isArray(result.readEvidenceIds)||result.readEvidenceIds.some(id=>!bundle.materials.some(m=>m.id===id&&m.providedCharacters>0)))throw new RadarError('INVALID_AGENT_OUTPUT','模型引用了未提供的正文材料');
  const limits=['仅分析当前归档文本；未请求上游，未核验材料中的新闻或事实，未运行代码。',...(item.platform==='bilibili'?['Agent仅阅读归档字幕或机器转写文本，未直接听音频、未看画面、未读取他人评论；机器转写可能误识别，浏览器字幕属于宿主观察，原始字幕轨完整性未验证。']:[])];
  return {...result,limitations:[...new Set([...(result.limitations||[]),...limits,...bundle.materials.filter(m=>m.truncated&&result.readEvidenceIds.includes(m.id!)).map(m=>`${m.kind} 只提供 ${m.providedCharacters}/${m.totalCharacters} 字符`)])],reading:{snapshot,startedAt,completedAt:now(),scope:'archived_text_only' as const,materials:bundle.materials.map(m=>({id:m.id!,kind:m.kind,providedCharacters:m.providedCharacters,totalCharacters:m.totalCharacters,truncated:m.truncated,cited:result.readEvidenceIds.includes(m.id!),...(m.textSegments?{providedSegments:m.textSegments.map(({from,to})=>({from,to}))}:{})}))}};
}

export function archivedAnalysis(store:Store,itemKey:string){
  requireText(itemKey,'条目ID',300);if(!store.item(itemKey))throw new RadarError('NOT_FOUND','档案条目不存在');
  const snapshot=store.readingSnapshot(itemKey),fingerprint=store.fingerprint(itemKey),currentIds=new Set(store.currentEvidence(itemKey).map(e=>e.id));
  const assessments=store.topics().flatMap(t=>store.assessments(t.id).filter(a=>a.itemKey===itemKey).map(a=>({...a,topicId:t.id,topicName:t.name,current:a.topicRevision===t.revision&&a.itemFingerprint===fingerprint&&(a.reading?a.reading.snapshot===snapshot:a.readEvidenceIds.every(id=>currentIds.has(id)))})));
  return {itemKey,snapshot,assessments,currentDefinition:'current表示此判断的主题版本及材料仍有效，不是全局唯一或最后一条；不同主题可同时为true，同主题也可保留多个有效判断。请结合topicId、agent与createdAt识别。',scope:'本地已归档文本分析；不是平台事实核验、视听阅读或自动订阅',emailSent:false,otherCommentsRead:0};
}

export async function analyzeArchived(options:{store:Store;runner:Runner;topicId:string;itemKey:string;signal?:AbortSignal;commitGuard?:()=>void}){
  const {store,runner,signal}=options;requireText(options.topicId,'主题ID',100);requireText(options.itemKey,'条目ID',300);
  if(signal?.aborted)throw new RadarError('CANCELLED','运行已取消');
  const topic=store.topics().find(t=>t.id===options.topicId&&t.enabled),item=store.item(options.itemKey);
  if(!topic)throw new RadarError('TOPIC_REQUIRED','请选择已启用的主题');
  if(!item)throw new RadarError('NOT_FOUND','请先取得并归档内容');
  const evidence=store.currentEvidence(item.key),snapshot=store.readingSnapshot(item.key);
  if(!evidence.some(readableEvidence))throw new RadarError('NO_READABLE_MATERIAL','本条没有可分析正文；范围清单、空简介与图片地址不能替代内容');
  const existing=archivedAnalysis(store,item.key).assessments.find(a=>a.topicId===topic.id&&a.current&&a.reading?.snapshot===snapshot&&!a.simulation);
  if(existing)return {reused:true,assessment:existing,...archivedAnalysis(store,item.key)};
  const jobId=archiveReadingKey(topic.id,topic.revision,snapshot);
  const lease=store.claim(jobId,runner.name||'archive-runner',600000);
  if(!lease)throw new RadarError('ANALYSIS_BUSY','相同主题和材料的分析正在执行或已结束，请读取已有结果');
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  let leaseLost=false;
  const timer=setInterval(()=>{try{store.checkpoint(jobId,lease.token,{itemKey:item.key,topicId:topic.id,snapshot},600000);}catch{leaseLost=true;controller.abort();}},30000);
  const startedAt=now(),bundle=materialPrompt(topic,item,evidence);
  try{
    store.checkpoint(jobId,lease.token,{itemKey:item.key,topicId:topic.id,snapshot,startedAt},600000);
    const result=await runner.assess(topic,item,evidence,controller.signal);
    if(leaseLost)throw new RadarError('LEASE_LOST','执行租约已失效，未保存结果');
    if(controller.signal.aborted)throw new RadarError('CANCELLED','运行已取消');
    const assessment=tracedAssessment(result,item,bundle,snapshot,startedAt);
    // Re-check lease and input revisions immediately before synchronous commit.
    store.checkpoint(jobId,lease.token,{itemKey:item.key,topicId:topic.id,snapshot},600000);
    const id=store.saveArchivedAssessment(topic.id,topic.revision,snapshot,assessment,{id:jobId,token:lease.token},options.commitGuard);
    return {id,reused:false,assessment,...archivedAnalysis(store,item.key)};
  }catch(e){try{store.finish(jobId,lease.token,(e as RadarError).code==='CANCELLED'?'cancelled':'failed');}catch{}throw e;}
  finally{clearInterval(timer);signal?.removeEventListener('abort',abort);}
}
