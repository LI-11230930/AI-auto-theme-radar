import {BilibiliSource} from './bilibili.ts';
import {BilibiliInterestSource} from './interest-source.ts';
import {runInterestRound,lastInterestRun,interestCounts} from './interest-round.ts';
import {analyzeConfiguredArchive} from './service.ts';
import {readInterestMailPolicy} from './interest-mail.ts';
import {readConfiguredBilibili} from './bilibili-reading.ts';
import {reviewInterestSample} from './sample-review.ts';
import {absolutePreviewUrl} from './operator-url.ts';
import {resolve} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import type {Store} from './store.ts';import {RadarError,publicError} from './model.ts';
const controllers=new Map<string,AbortController>();
function mailPolicyStatus(dataDir:string){try{return readInterestMailPolicy(dataDir);}catch(error){return {enabled:false,unavailable:true,error:publicError(error)};}}
export function asrStatus(config:any){const asr=config.bilibili?.asr||{},modelDir=asr.modelDir||resolve(config.dataDir,'models','faster-whisper-base');let lastProbe=null;try{lastProbe=JSON.parse(readFileSync(resolve(config.dataDir,'reports','asr-validation.json'),'utf8'));}catch{}return {enabled:asr.enabled===true,model:'faster-whisper-base',pythonConfigured:typeof asr.pythonCommand==='string'&&!!asr.pythonCommand.trim(),modelFilesPresent:['config.json','model.bin','tokenizer.json'].every(name=>existsSync(resolve(modelDir,name))),maxVideoSeconds:600,maxAudioBytes:32*1024*1024,maxTranscribeSeconds:180,lastProbe,scope:'单条/作者队列/兴趣轮次共用的P1缺字幕可选本地机器语音转写；文件存在不代表准确度或完整视频阅读'};}
export function interestStatus(config:any,store:Store){
 const activeRuns=store.topics().filter(t=>t.bilibiliDiscovery==='interests').flatMap(t=>{const j=store.job('interest-round:'+t.id) as any;if(j?.state!=='running'||j.expires_at<=Date.now())return[];let data:any;try{data=JSON.parse(j.data);}catch{}const p=data?.progress;
  return [{id:typeof data?.id==='string'?data.id:null,topicId:t.id,stage:typeof data?.stage==='string'?data.stage:'starting',startedAt:p?.startedAt??null,discovered:p?.discovered??0,prefiltered:p?.prefiltered??0,results:Array.isArray(p?.results)?p.results.slice(0,3):[],sources:Array.isArray(p?.sources)?p.sources.slice(0,3):[],emailSent:false,scope:'当前有效执行租约的进度快照；不是完成或发送回执'}];});
 const running=activeRuns.length>0;
 const report=lastInterestRun(config.dataDir),row=report?.id&&typeof report.id==='string'?store.delivery('bilibili-interest:'+report.id):null;
 const delivery=row?{id:row.id,state:row.state,updatedAt:row.updated_at}:null,emailSent=row?.state==='sent_confirmed';
 let sample:any;try{if(report?.sample)sample={...report.sample,absolutePreview:absolutePreviewUrl(config,report.sample.preview)};}catch{sample={...report.sample,previewUnavailable:true};}
 return {running,activeRuns,canCancel:controllers.size>0,lastRun:report?{...report,counts:interestCounts(report),...(sample?{sample}:{}),delivery,emailSent,...(!row?{currentSampleReview:reviewInterestSample(store,config.dataDir,report)}:{})}:null,mailPolicy:mailPolicyStatus(config.dataDir),asr:asrStatus(config),emailSent};
}
export function cancelInterest(){let count=0;for(const c of controllers.values()){c.abort();count++;}return {cancelRequested:count>0,emailSent:false,note:count?'已请求取消，本次网络读取可能需等待其超时；不会继续保存或调用模型':'本进程没有可取消的运行；其他宿主需在原宿主取消'};}
export async function runConfiguredInterest(config:any,store:Store,topicId:string,readLimit?:number,signal?:AbortSignal){
 if(controllers.has(topicId))throw new RadarError('ROUND_BUSY','该主题正在执行');
 const controller=new AbortController();controllers.set(topicId,controller);const abort=()=>controller.abort();if(signal?.aborted)controller.abort();signal?.addEventListener('abort',abort,{once:true});
 try{const source=new BilibiliSource({credentialFile:config.bilibili.credentialFile||undefined}),feed=new BilibiliInterestSource(source);
  const report=await runInterestRound({store,dataDir:config.dataDir,topicId,readLimit,signal:controller.signal,source:{recommendations:n=>feed.recommendations(n),search:(k,n)=>source.search(k,n),read:(b,o)=>readConfiguredBilibili(config,b,o,controller.signal,source)},analyze:(t,k,s,g)=>analyzeConfiguredArchive(config,store,t,k,s,g)});
  return {...report,...(report.sample?{sample:{...report.sample,absolutePreview:absolutePreviewUrl(config,report.sample.preview)}}:{}),mailPolicy:mailPolicyStatus(config.dataDir),asr:asrStatus(config)};
 }finally{controllers.delete(topicId);signal?.removeEventListener('abort',abort);}
}
