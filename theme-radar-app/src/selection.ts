import { RadarError } from './model.ts';
import type { Batch, Item } from './model.ts';

export type CollectionWindow = {
  topicId:string; topicRevision:number; mode:'baseline_7d'|'incremental';
  startAt:string; endAt:string; previousEndAt:string|null; completed:boolean;
};

// Activity must come from a source timestamp, never the local discovery clock.
export function sourceTimestamp(value:unknown):number|null {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
  if(Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)return null;
  const [year,month,day]=value.slice(0,10).split('-').map(Number),calendar=new Date(0);
  calendar.setUTCFullYear(year,month-1,day);
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day)return null;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;
}

export function collectionWindow(batch:Batch,topicId:string,topicRevision:number,previousEndAt:string|null):CollectionWindow {
  const end=sourceTimestamp(batch.endAt),start=sourceTimestamp(batch.startAt);
  if(end===null||start===null||start>=end)throw new RadarError('INVALID_WINDOW','批次窗口无效');
  const previous=sourceTimestamp(previousEndAt);
  if(previousEndAt!==null&&previous===null)throw new RadarError('INVALID_WINDOW','已确认历史窗口无效');
  if(previous!==null&&previous>end)throw new RadarError('HISTORY_AHEAD','存在比当前批次更晚的已确认历史，不能倒序生成');
  return {topicId,topicRevision,mode:previous===null?'baseline_7d':'incremental',
    startAt:new Date(previous===null?end-7*86400000:start).toISOString(),endAt:batch.endAt,previousEndAt,completed:false};
}

export function activityInWindow(item:Item,window:CollectionWindow) {
  const candidates=[item.publishedAt,item.metadata.pushedAt,item.metadata.releasePublishedAt]
    .map(sourceTimestamp).filter((value):value is number=>value!==null);
  if(!candidates.length)return {eligible:false,reason:'unknown_activity',activityAt:null};
  const latest=Math.max(...candidates),start=Date.parse(window.startAt),end=Date.parse(window.endAt);
  return {eligible:latest>=start&&latest<end,reason:latest<start?'before_window':latest>=end?'at_or_after_end':'in_window',activityAt:new Date(latest).toISOString()};
}
