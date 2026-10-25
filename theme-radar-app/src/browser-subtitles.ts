import {hash,now,RadarError,stableId} from './model.ts';
import type {Evidence} from './model.ts';
import type {Store,BrowserObservationGuard} from './store.ts';
type Segment={from:number;to:number;text:string};
const fail=():never=>{throw new RadarError('INVALID_BROWSER_CAPTURE','浏览器字幕文件格式、范围或预算无效；没有保存材料');};
export function validateBrowserSubtitles(input:any,clock=Date.now()){
  const expected='bvid,captureStatus,duration,endedAt,observedFrom,observedTo,page,schema,segments,startedAt,truncated';
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!==expected||input.schema!=='theme-radar-visible-subtitles-v1'||typeof input.bvid!=='string'||stableId('bilibili',input.bvid)!==input.bvid||!Number.isSafeInteger(input.page)||input.page<1||input.page>10000||!Number.isFinite(input.duration)||input.duration<=0||input.duration>43200||typeof input.truncated!=='boolean'||!['stopped','ended','discontinuity','budget_reached'].includes(input.captureStatus))fail();
  const start=Date.parse(input.startedAt),end=Date.parse(input.endedAt);if(typeof input.startedAt!=='string'||typeof input.endedAt!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(input.startedAt)||!/(Z|[+-]\d\d:\d\d)$/.test(input.endedAt)||!Number.isFinite(start)||!Number.isFinite(end)||start>end||end>clock+60000||end-start>24*3600000)fail();
  if(!Number.isFinite(input.observedFrom)||!Number.isFinite(input.observedTo)||input.observedFrom<0||input.observedTo<=input.observedFrom||input.observedTo>input.duration+1||!Array.isArray(input.segments)||!input.segments.length||input.segments.length>1000)fail();
  let previous=input.observedFrom,characters=0;const segments:Segment[]=input.segments.map((s:any)=>{if(!s||Object.keys(s).sort().join(',')!=='from,text,to'||!Number.isFinite(s.from)||!Number.isFinite(s.to)||s.from<previous-0.05||s.to<=s.from||s.to>input.observedTo+0.05||typeof s.text!=='string'||!s.text.trim()||s.text.length>1000)fail();characters+=s.text.length;if(characters>40000)fail();previous=s.to;return {from:s.from,to:s.to,text:s.text};});
  return {...input,segments,characters};
}
export function importBrowserSubtitles(store:Store,input:any,guard?:BrowserObservationGuard){
  const data=validateBrowserSubtitles(input),key='bilibili:'+data.bvid,item=store.item(key);
  if(!item)throw new RadarError('VIDEO_REQUIRED','请先通过本地只读入口读取该视频信息，再导入浏览器观察');
  const page=(item.metadata.subtitlePages as any[]|undefined)?.find(p=>p.page===data.page);
  if(!page||!Number.isFinite(page.duration)||Math.abs(page.duration-data.duration)>2)throw new RadarError('VIDEO_MISMATCH','浏览器分P或时长与已取得的视频信息不一致');
  const url=item.url+'?p='+data.page,collectedAt=data.endedAt,note=`浏览器宿主报告；P${data.page} / CID ${page.cid}；观察${data.observedFrom.toFixed(2)}–${data.observedTo.toFixed(2)}秒 / ${data.duration}秒；${data.captureStatus}；不是原始字幕轨，AI字幕可能有转写错误；音频和画面未读`;
  const evidence:Evidence[]=[{itemKey:key,kind:'browser-subtitle:p'+data.page,url,text:data.segments.map(s=>s.text).join('\n'),collectedAt,coverage:{material:'播放器可见字幕观察',expected:null,acquired:data.segments.length,processed:0,state:'unread',method:'用户手动启用的浏览器DOM观察；来源为宿主报告',note}},
    {itemKey:key,kind:'browser-subtitle-observation:p'+data.page,url,text:JSON.stringify({schema:data.schema,page:data.page,duration:data.duration,observedFrom:data.observedFrom,observedTo:data.observedTo,segments:data.segments,truncated:data.truncated,captureStatus:data.captureStatus}),collectedAt,coverage:{material:'浏览器观察时间范围',expected:1,acquired:1,processed:0,state:'unread',method:'范围与采样时间记录；不是额外内容阅读证据',note}}];
  return {...store.appendBrowserObservation(key,store.fingerprint(key),evidence,guard),itemKey:key,materials:evidence.map(e=>({kind:e.kind,characters:e.text.length,coverage:e.coverage})),currentVersionPolicy:'同一分P采用本次字幕与范围清单，旧版保留为历史，不混入当前判断；其他分P保留。重复相同内容不改变阅读快照。',importedAt:now(),sourceVerifiedByServer:false,modelRead:false,fullSubtitleTrackVerified:false,otherCommentsRead:0,emailSent:false};
}
