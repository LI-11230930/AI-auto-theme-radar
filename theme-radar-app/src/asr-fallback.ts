import {RadarError,isVideoTextKind,now} from './model.ts';
import type {Item,Evidence} from './model.ts';
import {parseAsrOutput,transcribeAudio} from './asr.ts';

type ReadingResult={item:Item;evidence:Evidence[];warnings:string[]};
type AudioLocator=(bvid:string,options:{expectedAuthorUid:string;expectedCid:string;signal?:AbortSignal})=>Promise<{bvid:string;cid:string;duration:number;audioUrl:string}>;
type Options={enabled:boolean;clipLongVideos?:boolean;pythonCommand?:string|null;modelDir?:string|null;workDir:string;signal?:AbortSignal;audio:AudioLocator;transcribe?:typeof transcribeAudio};
const propagated=new Set(['CANCELLED','AUTHOR_MISMATCH','VIDEO_MISMATCH','SOURCE_CHANGED','INVALID_AUTHOR','INVALID_CID','INVALID_ID']);
const recognized=new Set(['AUTH_REQUIRED','CREDENTIAL_INVALID','ACCESS_DENIED','RATE_LIMITED','UPSTREAM_ERROR','INVALID_RESPONSE','NO_AUDIO','ASR_BUDGET','ASR_DURATION_LIMIT','ASR_CONFIG_INVALID','ASR_MODEL_MISSING','ASR_UNAVAILABLE','ASR_FAILED','ASR_EMPTY','ASR_TIMEOUT','ASR_DOWNLOAD_TIMEOUT','ASR_DOWNLOAD_FAILED','ASR_AUDIO_LIMIT','ASR_AUDIO_URL_INVALID','INVALID_AUDIO_URL','ASR_REDIRECT_BLOCKED','ASR_DOWNLOAD_INVALID','ASR_INVALID_INPUT','ASR_INVALID_OUTPUT','ASR_OUTPUT_LIMIT','ASR_DURATION_MISMATCH']);
const decimal=(value:unknown)=>typeof value==='string'&&/^\d{1,20}$/.test(value)&&BigInt(value)>0n?BigInt(value).toString():null;
function checkpoint(signal?:AbortSignal){if(signal?.aborted)throw new RadarError('CANCELLED','本轮已取消，未接受音频转写材料');}

/** Optional P1-only acquisition fallback. It never stores, downloads models or calls an Agent. */
export async function withAsrFallback(result:ReadingResult,options:Options):Promise<ReadingResult>{
  checkpoint(options.signal);
  if(!options.enabled)return result;
  const {item}=result,requested=item.metadata.requestedPages;
  if(item.platform!=='bilibili'||!Array.isArray(requested)||requested.length!==1||requested[0]!==1)return result;
  if(result.evidence.some(e=>isVideoTextKind(e.kind,1)&&e.coverage.acquired>0&&!!e.text.trim()))return result;
  const pages=item.metadata.subtitlePages;
  if(!Array.isArray(pages))return result;
  const first=pages.filter(p=>p&&typeof p==='object'&&p.page===1);
  if(first.length!==1)return result;
  const part=first[0];
  if(!((part.reason==='no_track_exposed'&&part.state==='unavailable')||(part.state==='empty'&&(part.reason===undefined||part.reason==='no_track_exposed'))))return result;
  const collectedAt=now(),engine='faster-whisper-base';
  function record(state:string,fields:Record<string,unknown>,warning:string,evidence=result.evidence):ReadingResult{
    const page={page:1,cid:String(part.cid),state,engine,machineTranscript:true,agentListenedAudio:false,...fields};
    const old=item.metadata.asrPages,asrPages=Array.isArray(old)?old.filter(p=>p&&typeof p==='object'&&p.page!==1):[];
    const nextEvidence=evidence.map(e=>{
      if(e.kind!=='video-reading-manifest')return e;
      let manifest:any;try{manifest=JSON.parse(e.text);}catch{return e;}
      if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))return e;
      return {...e,text:JSON.stringify({...manifest,audio:{state,asrConfigured:!!options.pythonCommand?.trim()&&!!options.modelDir?.trim(),machineTranscript:true,agentListenedAudio:false,pages:[page]}}),collectedAt};
    });
    return {item:{...item,metadata:{...item.metadata,asrPages:[...asrPages,page]}},evidence:nextEvidence,warnings:[...result.warnings,warning]};
  }
  if(!options.pythonCommand?.trim()||!options.modelDir?.trim())return record('not_ready',{reason:'ASR_NOT_READY'},'P1 无可读字幕；本地 ASR 的 Python 或模型配置未准备，未访问音频、未取得视频正文。');
  const cid=decimal(typeof part.cid==='number'?String(part.cid):part.cid),author=decimal(item.authorId);
  if(!/^BV[A-Za-z0-9]{10}$/.test(item.externalId)||item.key!=='bilibili:'+item.externalId)throw new RadarError('VIDEO_MISMATCH','ASR 视频身份与当前材料不一致，未继续归档');
  if(!author)throw new RadarError('INVALID_AUTHOR','ASR 缺少已核对的有效作者 UID，未继续归档');
  if(!cid)throw new RadarError('INVALID_CID','ASR 缺少已核对的有效 P1 CID，未继续归档');
  if(typeof part.duration!=='number'||!Number.isFinite(part.duration)||part.duration<=0||part.duration>(options.clipLongVideos?7200:600))return record('failed',{reason:'ASR_DURATION_LIMIT'},'P1 无可读字幕；源时长未知或超出当前分段预算，未访问音频，保留待恢复。');
  let rangeFields:Record<string,unknown>={sourceDuration:part.duration};
  try{
    checkpoint(options.signal);
    const audio=await options.audio(item.externalId,{expectedAuthorUid:author,expectedCid:cid,signal:options.signal});
    checkpoint(options.signal);
    if(audio.bvid!==item.externalId)throw new RadarError('VIDEO_MISMATCH','ASR 音轨返回了其他视频，未继续归档');
    if(decimal(audio.cid)!==cid)throw new RadarError('SOURCE_CHANGED','ASR 音轨 CID 与原材料不一致，未继续归档');
    if(typeof audio.duration!=='number'||!Number.isFinite(audio.duration)||Math.abs(audio.duration-part.duration)>Math.max(3,Math.min(10,part.duration*.05)))throw new RadarError('SOURCE_CHANGED','ASR 音轨时长与原材料不一致，未继续归档');
    if(audio.duration<=0||audio.duration>(options.clipLongVideos?7200:600))throw new RadarError('ASR_DURATION_LIMIT','ASR 音轨超过本轮处理预算');
    const boundedDuration=Math.min(audio.duration,600),partial=audio.duration>600;
    const raw=await (options.transcribe??transcribeAudio)({audioUrl:audio.audioUrl,sourceDuration:boundedDuration,...(partial?{clipAudioAt:600}:{}),pythonCommand:options.pythonCommand,modelDir:options.modelDir,workDir:options.workDir,signal:options.signal});
    checkpoint(options.signal);
    if(typeof raw.text==='string'&&!raw.text.trim())return record('insufficient_text',{sourceDuration:audio.duration,reason:'ASR_EMPTY'},'P1 机器转写未取得足够文本，未加入视频筛选正文；不能据此断言视频无声。');
    const transcript=parseAsrOutput({...raw,ok:true},boundedDuration);
    if(!Number.isSafeInteger(raw.audioBytes)||raw.audioBytes<1||raw.audioBytes>32*1024*1024)throw new RadarError('ASR_INVALID_OUTPUT','ASR 音频字节范围无效');
    rangeFields={sourceDuration:audio.duration,processedRange:transcript.range,processedDuration:transcript.duration,audioBytes:raw.audioBytes,partial};
    if(transcript.text.trim().length<20)return record('insufficient_text',{...rangeFields,reason:'ASR_INSUFFICIENT_TEXT',characters:transcript.text.trim().length},'P1 已完成有界机器转写，但文本不足 20 字，信息不足，未加入视频筛选正文；不能据此断言视频无声。');
    const url=item.url.split('?')[0].split('#')[0]+'?p=1';
    const note=`P1 / CID ${cid}；机器转写处理 ${transcript.range.from}–${transcript.range.to} 秒 / 源时长 ${audio.duration} 秒；${partial?'仅处理前10分钟，其余未读；':''}机器转写不代表识别准确，也不是 Agent 直接听取音频；画面仍未读`;
    const coverage={expected:transcript.segments.length,acquired:transcript.segments.length,processed:0,state:'unread' as const,method:'本地 faster-whisper-base CPU 机器转写；Agent 阅读范围另记',note};
    const evidence:Evidence[]=[...result.evidence,
      {itemKey:item.key,kind:'asr:p1',url,text:transcript.text,collectedAt,coverage:{...coverage,material:'P1 音频机器转写正文'}},
      {itemKey:item.key,kind:'asr-timeline:p1',url,text:JSON.stringify({page:1,cid,language:transcript.language,engine,machineTranscript:true,sourceDuration:audio.duration,processedRange:transcript.range,segments:transcript.segments}),collectedAt,coverage:{...coverage,material:'P1 音频机器转写时间轴'}}
    ];
    return record('acquired',{...rangeFields,characters:transcript.text.length},'P1 无可读字幕，已取得本地机器转写正文；'+note+'。',evidence);
  }catch(error){
    checkpoint(options.signal);
    const rawCode=(error as any)?.code;
    if(propagated.has(rawCode))throw new RadarError(rawCode,rawCode==='CANCELLED'?'本轮已取消，未接受音频转写材料':'ASR 身份或源材料发生变化，未继续归档');
    if((error as any)?.name==='AbortError')throw new RadarError('CANCELLED','本轮已取消，未接受音频转写材料');
    const code=recognized.has(rawCode)?rawCode:'ASR_FAILED';
    if(code==='ASR_EMPTY')return record('insufficient_text',{...rangeFields,reason:code},'P1 机器转写未取得足够文本，未加入视频筛选正文；不能据此断言视频无声。');
    return record('failed',{...rangeFields,reason:code},`P1 本地机器转写未完成（${code}），保留原字幕状态和简介，不以标题代替视频正文。`);
  }
}
