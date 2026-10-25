import type {Store} from './store.ts';import {hash,publicError} from './model.ts';
import {readBilibiliSample} from './bilibili-sample.ts';import {renderBilibiliBrief} from './bilibili-brief.ts';

/** Current projection only. Never rewrites history, freezes a replacement or reserves mail. */
export function reviewInterestSample(store:Store,dataDir:string,report:any){
 if(!report?.sample?.id)return null;
 try{
  const sample=readBilibiliSample(dataDir,report.sample.id),keys=sample.entries?.map((row:any)=>row.itemKey);
  if(!Array.isArray(keys)||keys.length<1||keys.length>3||new Set(keys).size!==keys.length)throw Error('Invalid sample');
  const current=renderBilibiliBrief(store,sample.batch,{topicId:report.topicId,itemKeys:keys,template:sample.mailTemplate}),eligible=new Set(current.entries.map(e=>e.itemKey));
  return {available:true,frozenCount:keys.length,eligibleNow:eligible.size,sampleCurrent:hash(current.text)===sample.textSha256,excluded:keys.filter(key=>!eligible.has(key)).map(itemKey=>({itemKey,reason:current.skipped.find(row=>row.itemKey===itemKey)?.reason||'no_current_judgment'})),scope:'当前正文与判断的只读核对；原冻结草稿、历史selected及原始轮次报告保持不变，不授予发送权'};
 }catch(error){return {available:false,sampleCurrent:false,code:publicError(error).code,scope:'无法核对当前草稿；未改写历史、生成替代或领取发送'};}
}
