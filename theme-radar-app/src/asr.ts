import {randomUUID} from 'node:crypto';
import {mkdirSync,lstatSync,writeFileSync,rmSync} from 'node:fs';
import {isAbsolute,resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RadarError} from './model.ts';
import {runProcess} from './runner.ts';

const maxBytes=32*1024*1024,downloadTimeout=30000,transcribeTimeout=180000;
const bridge=fileURLToPath(new URL('../bridges/asr_transcribe.py',import.meta.url));
export type AsrSegment={from:number;to:number;content:string};
export type AsrTranscript={text:string;segments:AsrSegment[];duration:number;model:'faster-whisper-base';language:'zh';range:{from:0;to:number};coverage:'complete'};
function duration(value:unknown){if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>600)throw new RadarError('ASR_DURATION_LIMIT','本地ASR仅处理完整的10分钟以内短视频');return value;}
function cancelled(signal?:AbortSignal){if(signal?.aborted)throw new RadarError('CANCELLED','本地转写已取消');}
function localDirectory(value:string,create=false){
  if(typeof value!=='string'||!isAbsolute(value)||/^[\\/]{2}/.test(value))throw new RadarError('ASR_CONFIG_INVALID','本地ASR需要本机绝对目录');
  const path=resolve(value);try{if(create)mkdirSync(path,{recursive:true});const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error();}catch{throw new RadarError('ASR_CONFIG_INVALID','本地ASR目录不可用');}return path;
}
export function audioSourceUrl(value:unknown){
  let url:URL;try{if(typeof value!=='string')throw new Error();url=new URL(value);}catch{throw new RadarError('ASR_AUDIO_URL_INVALID','音频地址格式无效');}
  const mediaPort=url.port==='8082'&&/\.mcdn\.bilivideo\.cn$/.test(url.hostname);
  if(url.protocol!=='https:'||url.username||url.password||url.port&&!mediaPort||url.hash||!/(?:^|\.)(?:bilivideo\.com|bilivideo\.cn|hdslb\.com)$/.test(url.hostname))throw new RadarError('ASR_AUDIO_URL_INVALID','音频仅接受指定CDN的HTTPS地址和平台音频端口');
  return url.href;
}
/** Complete refers to processing the whole bounded local file, not recognition accuracy. */
export function parseAsrOutput(payload:unknown,sourceDuration:number):AsrTranscript{
  duration(sourceDuration);const data=payload as any;
  if(!data||typeof data!=='object'||Array.isArray(data))throw new RadarError('ASR_INVALID_OUTPUT','本地转写未返回有效结果');
  if(data.ok!==true){const code=['ASR_EMPTY','ASR_UNAVAILABLE','ASR_DURATION_MISMATCH','ASR_OUTPUT_LIMIT','ASR_INVALID_INPUT'].includes(data.code)?data.code:'ASR_FAILED';throw new RadarError(code,code==='ASR_EMPTY'?'本地ASR未识别出文本；不能断言没有语音':'本地音频转写未完成');}
  if(data.model!=='faster-whisper-base'||data.language!=='zh'||data.coverage!=='complete'||typeof data.duration!=='number'||!Number.isFinite(data.duration)||data.duration<=0||data.duration>600||Math.abs(data.duration-sourceDuration)>3||data.range?.from!==0||data.range?.to!==data.duration)throw new RadarError('ASR_INVALID_OUTPUT','本地转写模型、语言或实际处理时长不符');
  if(!Array.isArray(data.segments)||data.segments.length>1000||typeof data.text!=='string'||data.text.length>40000)throw new RadarError('ASR_OUTPUT_LIMIT','本地转写正文或分段超出预算');
  const segments:AsrSegment[]=[];let end=0;
  for(const row of data.segments){
    if(!row||typeof row!=='object'||typeof row.from!=='number'||typeof row.to!=='number'||!Number.isFinite(row.from)||!Number.isFinite(row.to)||row.from<end||row.to<=row.from||row.to>data.duration||typeof row.content!=='string'||!row.content.trim())throw new RadarError('ASR_INVALID_OUTPUT','本地转写时间轴或正文无效');
    segments.push({from:row.from,to:row.to,content:row.content.trim()});end=row.to;
  }
  const text=segments.map(s=>s.content).join('\n');
  if(!text)throw new RadarError('ASR_EMPTY','本地ASR未识别出文本；不能断言没有语音');
  if(text.length>40000||data.text!==text)throw new RadarError('ASR_INVALID_OUTPUT','本地转写正文与时间轴不一致');
  return {text,segments,duration:data.duration,model:'faster-whisper-base',language:'zh',range:{from:0,to:data.duration},coverage:'complete'};
}

export async function transcribeAudio(options:{audioUrl:string;sourceDuration:number;pythonCommand:string;modelDir:string;workDir:string;signal?:AbortSignal;fetcher?:typeof fetch;timeoutMs?:number},dependencies:{run?:typeof runProcess}={}):Promise<AsrTranscript&{audioBytes:number}>{
  cancelled(options.signal);duration(options.sourceDuration);const url=audioSourceUrl(options.audioUrl),timeout=options.timeoutMs??transcribeTimeout;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>transcribeTimeout||typeof options.pythonCommand!=='string'||!options.pythonCommand.trim()||/[\r\n]/.test(options.pythonCommand)||/\.(?:cmd|bat)$/i.test(options.pythonCommand))throw new RadarError('ASR_CONFIG_INVALID','本地转写入口或超时预算无效');
  const modelDir=localDirectory(options.modelDir);
  for(const name of ['model.bin','config.json','tokenizer.json']){try{const f=lstatSync(join(modelDir,name));if(!f.isFile()||f.isSymbolicLink()||f.size<1)throw new Error();}catch{throw new RadarError('ASR_MODEL_MISSING','本地模型尚未准备完整；转写过程不会下载模型');}}
  const workDir=localDirectory(options.workDir,true),jobDir=join(workDir,'asr-'+randomUUID());mkdirSync(jobDir);
  try{
    const controller=new AbortController(),abort=()=>controller.abort();let expired=false;
    options.signal?.addEventListener('abort',abort,{once:true});cancelled(options.signal);
    const timer=setTimeout(()=>{expired=true;controller.abort();},downloadTimeout);let audioBytes=0;
    try{
      const response=await (options.fetcher??fetch)(url,{headers:{Referer:'https://www.bilibili.com/'},credentials:'omit',redirect:'error',signal:controller.signal});cancelled(options.signal);
      if(response.redirected||response.status>=300&&response.status<400||response.url&&response.url!==url)throw new RadarError('ASR_REDIRECT_BLOCKED','音频重定向已拒绝');
      if(!response.ok)throw new RadarError(response.status===403||response.status===412?'ACCESS_DENIED':response.status===429?'RATE_LIMITED':'ASR_DOWNLOAD_FAILED','音频下载未完成');
      const length=response.headers.get('content-length');
      if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))))throw new RadarError('ASR_DOWNLOAD_INVALID','音频响应大小无效');
      if(length!==null&&Number(length)>maxBytes)throw new RadarError('ASR_AUDIO_LIMIT','音频下载超出32MiB预算');
      if(/(?:text\/|application\/json)/i.test(response.headers.get('content-type')||''))throw new RadarError('ASR_DOWNLOAD_INVALID','下载内容不是音频材料');
      const reader=response.body?.getReader();if(!reader)throw new RadarError('ASR_DOWNLOAD_INVALID','音频响应为空');
      const chunks:Uint8Array[]=[];
      try{while(true){cancelled(options.signal);const {done,value}=await reader.read();if(done)break;if(expired)throw new RadarError('ASR_DOWNLOAD_TIMEOUT','音频下载超出30秒预算');audioBytes+=value.byteLength;if(audioBytes>maxBytes)throw new RadarError('ASR_AUDIO_LIMIT','音频下载超出32MiB预算');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
      if(!audioBytes||length!==null&&audioBytes!==Number(length))throw new RadarError('ASR_DOWNLOAD_INVALID','音频下载为空或不完整');
      cancelled(options.signal);writeFileSync(join(jobDir,'audio.bin'),Buffer.concat(chunks),{flag:'wx'});
    }catch(error){if(options.signal?.aborted)throw new RadarError('CANCELLED','本地转写已取消');if(expired)throw new RadarError('ASR_DOWNLOAD_TIMEOUT','音频下载超出30秒预算');if(error instanceof RadarError)throw error;throw new RadarError('ASR_DOWNLOAD_FAILED','音频下载未完成；未执行本地转写');}
    finally{clearTimeout(timer);controller.abort();options.signal?.removeEventListener('abort',abort);}
    cancelled(options.signal);
    let result:Awaited<ReturnType<typeof runProcess>>;
    try{result=await (dependencies.run??runProcess)(options.pythonCommand,['-X','utf8',bridge],JSON.stringify({audioPath:join(jobDir,'audio.bin'),modelDir,sourceDuration:options.sourceDuration}),{cwd:jobDir,signal:options.signal,timeoutMs:timeout,maxBytes:512000,env:{PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'}});}
    catch(error){if(options.signal?.aborted||(error as any)?.code==='CANCELLED')throw new RadarError('CANCELLED','本地转写已取消');if((error as any)?.code==='RUNNER_TIMEOUT')throw new RadarError('ASR_TIMEOUT','本地转写超出时间预算');throw new RadarError('ASR_FAILED','本地转写进程未完成；未保留音频');}
    cancelled(options.signal);let output:unknown;try{output=JSON.parse(result.stdout);}catch{throw new RadarError('ASR_INVALID_OUTPUT','本地转写未返回可校验JSON');}
    return {...parseAsrOutput(output,options.sourceDuration),audioBytes};
  }finally{if(dirname(jobDir)===workDir)rmSync(jobDir,{recursive:true,force:true});}
}
