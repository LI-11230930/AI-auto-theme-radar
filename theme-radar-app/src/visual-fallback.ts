import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {audioSourceUrl} from './asr.ts';
import {runProcess} from './runner.ts';
import {RadarError,isVideoTextKind,now} from './model.ts';
import type {BilibiliSource} from './bilibili.ts';

export async function withVisualFallback(result:any,config:any,source:BilibiliSource,signal?:AbortSignal,dependencies:{fetcher?:typeof fetch;run?:typeof runProcess}={},allowMultipartP1=false){
 const requested=result.item.metadata.requestedPages;
 if(!config.bilibili?.visual?.enabled||result.evidence.some((e:any)=>isVideoTextKind(e.kind,1)&&e.text.trim())||!Array.isArray(requested)||!requested.includes(1)||(requested.length!==1&&!allowMultipartP1))return result;
 const part=result.item.metadata.subtitlePages?.find((p:any)=>p.page===1);
 if(!part||part.reason!=='no_track_exposed'||!part.duration||part.duration>600)return result;
 const asr=result.item.metadata.asrPages?.find((p:any)=>p.page===1);
 if(['AUTH_REQUIRED','CREDENTIAL_INVALID','ACCESS_DENIED','RATE_LIMITED'].includes(asr?.reason))return result;
 const record=(state:string,reason:string,extra:any={})=>({...result,item:{...result.item,metadata:{...result.item.metadata,ocrPages:[{page:1,state,reason,...extra}]}},warnings:[...result.warnings,'画面采样：'+reason+'；仅采样帧文字，不代表完整字幕或已看完视频。']});
 const root=resolve(config.dataDir,'visual-tasks');mkdirSync(root,{recursive:true});const dir=mkdtempSync(resolve(root,'ocr-'));
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,30000);
 try{
  if(signal?.aborted)throw new RadarError('CANCELLED','已关闭本轮');
  const media=await source.audio(result.item.externalId,{expectedAuthorUid:result.item.authorId,expectedCid:String(part.cid),preferVideo:true,signal});
  const url=audioSourceUrl(media.audioUrl),response=await (dependencies.fetcher||fetch)(url,{headers:{Referer:'https://www.bilibili.com/'},credentials:'omit',redirect:'error',signal:controller.signal});
  if(!response.ok)throw new RadarError([403,412].includes(response.status)?'ACCESS_DENIED':response.status===429?'RATE_LIMITED':'OCR_DOWNLOAD_FAILED','画面材料未取得');
  if(response.redirected||response.url&&response.url!==url||/text\/|application\/json/.test(response.headers.get('content-type')||''))throw new RadarError('OCR_DOWNLOAD_INVALID','画面响应无效');
  const reader=response.body?.getReader();if(!reader)throw new RadarError('OCR_DOWNLOAD_INVALID','响应为空');let bytes=0;const chunks:Uint8Array[]=[];
  try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>32*1024*1024)throw new RadarError('OCR_MEDIA_LIMIT','画面文件超过32MiB');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  clearTimeout(timer);if(signal?.aborted)throw new RadarError('CANCELLED','已关闭本轮');
  const file=resolve(dir,'video.bin');writeFileSync(file,Buffer.concat(chunks));
  const worker=await (dependencies.run||runProcess)(config.bilibili.asr.pythonCommand,['-X','utf8',fileURLToPath(new URL('../bridges/video_ocr.py',import.meta.url))],JSON.stringify({videoPath:file,sourceDuration:part.duration,ocrTool:fileURLToPath(new URL('../tools/ocr-image.ps1',import.meta.url))}),{cwd:dir,signal,timeoutMs:240000,maxBytes:512000,env:{PYTHONUTF8:'1'}});
  const data=JSON.parse(worker.stdout);
  if(!data.ok)return record('pending',data.code||'OCR_FAILED');
  if(data.engine!=='Windows.Media.Ocr'||typeof data.text!=='string'||data.text.length>40000||!Array.isArray(data.segments)||!Number.isInteger(data.attempted)||data.attempted<1||data.attempted>120||data.expected>120||data.sourceDuration!==part.duration)throw new RadarError('OCR_INVALID_OUTPUT','画面返回格式无效');
  if(data.text.replace(/\s/g,'').length<80)return record('pending','OCR_INSUFFICIENT_TEXT',{characters:data.text.length,frames:data.attempted});
  const next=record('acquired','OCR_SAMPLED',{frames:data.attempted,expectedFrames:data.expected,interval:data.interval,characters:data.text.length});
  const coverage={expected:data.expected,acquired:data.attempted,processed:0,state:'unread',method:'本地采样视频画面，Windows OCR；相邻重复文字去重',note:`间隔${data.interval}秒采样${data.attempted}帧；非完整字幕，未识别全部画面，机器文字可能误识`};
  next.evidence=[...result.evidence,{itemKey:result.item.key,kind:'ocr:p1',url:result.item.url+'?p=1',text:data.text,collectedAt:now(),coverage:{...coverage,material:'P1采样画面文字'}},{itemKey:result.item.key,kind:'ocr-timeline:p1',url:result.item.url+'?p=1',text:JSON.stringify(data),collectedAt:now(),coverage:{...coverage,material:'P1采样时间与OCR文字'}}];return next;
 }catch(error){if(signal?.aborted||(error as any).code==='CANCELLED')throw new RadarError('CANCELLED','画面读取已取消');return record('pending',(error as any).code||'OCR_FAILED');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);rmSync(dir,{recursive:true,force:true});}
}
