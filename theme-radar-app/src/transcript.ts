import {RadarError} from './model.ts';
export type SubtitleSegment={from:number|null;to:number|null;text:string};
export function parseSubtitle(payload:unknown,options:{maxCharacters?:number;maxSegments?:number;duration?:number|null}={}){
  const maxCharacters=options.maxCharacters??40000,maxSegments=options.maxSegments??1000;
  if(!Number.isSafeInteger(maxCharacters)||maxCharacters<1||maxCharacters>100000||!Number.isSafeInteger(maxSegments)||maxSegments<1||maxSegments>3000)throw new RadarError('INVALID_BUDGET','字幕预算无效');
  const body=(payload as any)?.body;if(!Array.isArray(body)||body.length>30000)throw new RadarError('INVALID_SUBTITLE','字幕需要有界分段列表');
  const segments:SubtitleSegment[]=[];let characters=0,emptySegments=0,truncated=false,timingUnknown=0;
  for(const row of body){
    if(!row||typeof row!=='object'||typeof row.content!=='string')throw new RadarError('INVALID_SUBTITLE','字幕分段正文格式无效');
    const absent=row.from===undefined&&row.to===undefined;
    if(!absent&&(!Number.isFinite(row.from)||!Number.isFinite(row.to)||row.from<0||row.to<=row.from))throw new RadarError('INVALID_SUBTITLE','字幕时间轴无效');
    if(!absent&&options.duration&&row.to>options.duration+5)throw new RadarError('SUBTITLE_DURATION_MISMATCH','字幕时间超出所选分P时长，未作为有效文本归档');
    const text=row.content.trim();if(!text){emptySegments++;continue;}
    if(segments.length>=maxSegments||characters+text.length+(segments.length?1:0)>maxCharacters){truncated=true;break;}
    characters+=text.length+(segments.length?1:0);if(absent)timingUnknown++;
    segments.push({from:absent?null:row.from,to:absent?null:row.to,text});
  }
  const timed=segments.filter(s=>s.from!==null&&s.to!==null).sort((a,b)=>a.from!-b.from!);let coveredSeconds=0,end=0;
  for(const s of timed){coveredSeconds+=Math.max(0,s.to!-Math.max(end,s.from!));end=Math.max(end,s.to!);}
  return {text:segments.map(s=>s.text).join('\n'),segments,expectedSegments:body.length,acquiredSegments:segments.length,emptySegments,truncated,timingUnknown,coveredSeconds:Number(coveredSeconds.toFixed(3)),lastTimestamp:timed.length?end:null,notes:['字幕取得不等于模型已读；字幕时间范围不证明语音或画面完整。',...(emptySegments?[`空分段${emptySegments}条未计入取得正文`]:[]),...(timingUnknown?[`${timingUnknown}条未提供时间戳`]:[]),...(truncated?[`字幕预算达到${maxCharacters}字符或${maxSegments}段，保留截断状态`]:[])]};
}
