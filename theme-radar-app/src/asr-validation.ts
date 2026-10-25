import {mkdirSync,writeFileSync,readFileSync,existsSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BilibiliSource} from './bilibili.ts';
import {transcribeAudio,parseAsrOutput} from './asr.ts';
import {RadarError,isVideoTextKind,stableId,now} from './model.ts';

const escape=(s:unknown)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function checkpoint(signal?:AbortSignal){if(signal?.aborted)throw new RadarError('CANCELLED','语音对照已取消，未更新验证结果');}
function atomic(file:string,text:string){const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,text);renameSync(temp,file);}
/** Explicit diagnostic: transcribes a captioned P1 for comparison without archiving or enabling ASR. */
export async function validateAsrSample(config:any,bvidInput:string,signal?:AbortSignal,deps?:{source:Pick<BilibiliSource,'read'|'audio'>;transcribe?:typeof transcribeAudio}){
 const bvid=stableId('bilibili',bvidInput),asr=config.bilibili?.asr;
 if(!asr?.pythonCommand?.trim()||!asr?.modelDir?.trim())throw new RadarError('ASR_NOT_READY','请先配置本地ASR的Python与模型目录，再运行语音对照；不会自动安装或下载模型');
 checkpoint(signal);const source=deps?.source??new BilibiliSource({credentialFile:config.bilibili?.credentialFile||undefined});
 const result=await source.read(bvid,{pages:[1],includeDanmaku:false});checkpoint(signal);
 if(result.item.externalId!==bvid||result.item.key!=='bilibili:'+bvid||!/^\d{1,20}$/.test(result.item.authorId)||BigInt(result.item.authorId)===0n)throw new RadarError('VIDEO_MISMATCH','语音对照视频身份无效');
 const pages=result.item.metadata.subtitlePages;
 const parts=Array.isArray(pages)?pages.filter(p=>p&&typeof p==='object'&&p.page===1):[];
 const part=parts.length===1?parts[0]:null;
 const references=result.evidence.filter(e=>isVideoTextKind(e.kind,1)&&!e.kind.startsWith('asr:')&&e.coverage.acquired>0&&!!e.text.trim());
 if(!references.length)throw new RadarError('ASR_REFERENCE_REQUIRED','对照检查需要一条有可读P1字幕的视频；当前未取得参考字幕，没有下载音频');
 if(!part||!/^\d{1,20}$/.test(String(part.cid))||BigInt(part.cid)===0n||typeof part.duration!=='number'||!Number.isFinite(part.duration)||part.duration<=0||part.duration>600)throw new RadarError('ASR_DURATION_LIMIT','语音对照需要有效P1与10分钟以内源时长');
 const audio=await source.audio(bvid,{expectedAuthorUid:result.item.authorId,expectedCid:String(part.cid),signal});checkpoint(signal);
 if(audio.bvid!==bvid||String(audio.cid)!==String(part.cid)||typeof audio.duration!=='number'||!Number.isFinite(audio.duration)||audio.duration<=0||audio.duration>600||Math.abs(audio.duration-part.duration)>3)throw new RadarError('SOURCE_CHANGED','语音对照音轨与参考字幕身份或时长不一致');
 const raw=await(deps?.transcribe??transcribeAudio)({audioUrl:audio.audioUrl,sourceDuration:audio.duration,pythonCommand:asr.pythonCommand,modelDir:asr.modelDir,workDir:resolve(config.dataDir,'asr-tasks'),signal});checkpoint(signal);
 const transcript=parseAsrOutput({...raw,ok:true},audio.duration),reference=references.map(e=>e.text).join('\n');
 if(!Number.isSafeInteger(raw.audioBytes)||raw.audioBytes<1||raw.audioBytes>32*1024*1024)throw new RadarError('ASR_INVALID_OUTPUT','对照音频字节范围无效');
 const reports=resolve(config.dataDir,'reports'),previews=resolve(config.dataDir,'previews');mkdirSync(reports,{recursive:true});mkdirSync(previews,{recursive:true});
 const file=resolve(reports,'asr-validation.json');let previous:any=null;try{previous=JSON.parse(readFileSync(file,'utf8'));}catch{}
 const priorAcceptance=previous?.userAcceptedForFiltering===true?{referenceVideo:previous.referenceVideo,at:previous.userAcceptanceAt,source:'explicit_user',text:previous.userAcceptanceText}:previous?.priorAcceptance??null;
 const report={at:now(),engineExecutionVerified:true,sampleListeningVerified:false,comparisonPreview:'/preview/asr-comparison',referenceVideo:bvid,referenceCharacters:reference.length,asrCharacters:transcript.text.length,range:transcript.range,sourceDuration:audio.duration,audioBytes:raw.audioBytes,enabled:asr.enabled===true,priorAcceptance,scope:'显式字幕/机器转写对照；不模拟日常缺字幕，不调用Agent、不归档、不发信、不修改启用配置',usableText:transcript.text.trim().length>=20};
 const url='https://www.bilibili.com/video/'+bvid+'?p=1';
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>语音转写对照</title><style>body{font:16px/1.8 system-ui,sans-serif;background:#f4f7f3;color:#233f32;margin:0}main{max-width:1100px;margin:auto;padding:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}section{background:white;border:1px solid #d8e3d9;border-radius:12px;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.notice{padding:14px;background:#fff5dd;border-radius:10px}a{color:#16634d}@media(max-width:700px){.grid{grid-template-columns:1fr}}</style><main><h1>语音转写对照</h1><p><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(result.item.title)} · 打开P1原视频</a></p><p>源时长 ${audio.duration} 秒；实际音频处理 ${transcript.range.from}–${transcript.range.to.toFixed(2)} 秒。</p><p class="notice">${asr.enabled===true?'当前语音回退已启用。':'当前语音回退关闭。'}此命令专门对比有字幕视频，没有修改启用配置或调用Agent、归档、发邮件。请听原视频核对项目/API名称、数字和否定词；平台参考字幕也可能有错，处理完整不代表识别准确。</p><div class="grid"><section><h2>平台参考字幕（${reference.length}字）</h2><pre>${escape(reference)}</pre></section><section><h2>本地机器转写（${transcript.text.length}字）</h2><pre>${escape(transcript.text)}</pre></section></div><p>机器转写不读取画面或硬字幕；少于20字不会用于日常筛选。字幕优先，日常仅P1明确缺字幕时回退。</p><p><a href="/#bilibili-interests">返回兴趣阅读</a></p></main></html>`;
 checkpoint(signal);
 if(existsSync(file))atomic(resolve(reports,'asr-validation-history-'+randomUUID()+'.json'),readFileSync(file,'utf8'));
 atomic(resolve(previews,'asr-comparison.html'),html);atomic(file,JSON.stringify(report,null,2));
 return report;
}
