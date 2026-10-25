import { RadarError } from './model.ts';
import type { Batch } from './model.ts';
const offset = 8 * 3600_000;
export function beijingDate(when = new Date()) { return new Date(when.getTime()+offset).toISOString().slice(0,10); }
export function batchAt(date: string, slot: string): Batch {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['09:00','18:00'].includes(slot))throw new RadarError('INVALID_BATCH','批次日期或时段无效');
  const due=new Date(`${date}T${slot}:00+08:00`);
  if(!Number.isFinite(due.getTime())||beijingDate(due)!==date)throw new RadarError('INVALID_BATCH','批次日期无效');
  const start=new Date(due.getTime()-(slot==='09:00'?15:9)*3600_000);
  return {date,slot,key:`${date}:${slot}`,dueAt:due.toISOString(),startAt:start.toISOString(),endAt:due.toISOString(),timezone:'Asia/Shanghai'};
}
export function latestDue(when = new Date()): Batch {
  const date=beijingDate(when),morning=batchAt(date,'09:00'),evening=batchAt(date,'18:00');
  if(when.getTime()>=Date.parse(evening.dueAt))return evening;
  if(when.getTime()>=Date.parse(morning.dueAt))return morning;
  return batchAt(beijingDate(new Date(when.getTime()-24*3600_000)),'18:00');
}
export function deliveryKey(recipient: string,batch: Batch,type='github-digest') {return `${recipient.toLowerCase()}:${batch.key}:${type}`;}
