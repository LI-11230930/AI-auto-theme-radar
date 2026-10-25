import {renderCustomMail,loadMailTemplate} from './mail-template.ts';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Store} from './store.ts';
import {digestCandidates} from './digest-candidates.ts';
import {briefZh,flowSketch} from './mail.ts';
import {collectionWindow,sourceTimestamp} from './selection.ts';
import {latestDue} from './time.ts';
import {isVideoTextKind} from './model.ts';
import {videoBodyQuality} from './bilibili-body-quality.ts';
import type {Batch} from './model.ts';
const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Readonly view of current, window-eligible, actually assessed subtitle text. Never an outbox. */
export function renderBilibiliBrief(store:Store,batch:Batch=latestDue(),options:{topicId?:string;itemKeys?:string[];template?:any}={}){
 const candidates=digestCandidates(store,{platform:'bilibili',topicId:options.topicId,itemKeys:options.itemKeys}),topics=store.topics(),entries:any[]=[],skipped:any[]=[];
 const windows=topics.filter(t=>t.enabled&&t.platforms.includes('bilibili')).map(t=>collectionWindow(batch,t.id,t.revision,store.lastConfirmedWindow(t.id,t.revision)));
 for(const row of candidates.rows){
  if(options.itemKeys&&!options.itemKeys.includes(row.itemKey))continue;
  if(row.state!=='candidate'){skipped.push({itemKey:row.itemKey,reason:row.state});continue;}
  const published=sourceTimestamp(row.publishedAt),eligible=row.judgments.filter(j=>j.state==='selected'&&(topics.some(t=>t.id===j.topicId&&t.bilibiliDiscovery==='interests')||windows.some(w=>w.topicId===j.topicId&&published!==null&&published>=Date.parse(w.startAt)&&published<Date.parse(w.endAt))));
  if(!eligible.length){skipped.push({itemKey:row.itemKey,reason:published===null?'unknown_source_time':'outside_window'});continue;}
  const good=eligible.flatMap(j=>{const a=j.assessment,summary=briefZh(a.summaryZh),flow=flowSketch(a.flow),cited=new Set(a.readEvidenceIds),materials=new Set(row.materials.map(e=>e.id));
   const subtitleRead=a.reading?.materials?.some(m=>m.cited&&cited.has(m.id)&&materials.has(m.id)&&m.providedCharacters>0&&isVideoTextKind(m.kind));
   if(!summary||!flow||!subtitleRead||!videoBodyQuality(store.currentEvidence(row.itemKey),a).sufficient||flow.basis==='documented'&&flow.evidenceIds.some(id=>!cited.has(id)||!materials.has(id)))return [];
   return [{topicId:j.topicId,summary,flow,assessment:a}];});
  if(!good.length){const thin=eligible.every(j=>!videoBodyQuality(store.currentEvidence(row.itemKey),j.assessment).sufficient);skipped.push({itemKey:row.itemKey,reason:thin?'insufficient_video_body':'missing_valid_copy_flow_or_subtitle_reading'});continue;}
  let url:URL;try{url=new URL(row.url);}catch{skipped.push({itemKey:row.itemKey,reason:'invalid_video_url'});continue;}if(url.protocol!=='https:'||url.hostname!=='www.bilibili.com'||url.username||url.password||!/^\/video\/BV[A-Za-z0-9]{10}\/?$/.test(url.pathname)){skipped.push({itemKey:row.itemKey,reason:'invalid_video_url'});continue;}
  const pageCount=store.item(row.itemKey)?.metadata.pageCount,readPages=[...new Set(good[0].assessment.reading!.materials.filter(m=>m.cited&&good[0].assessment.readEvidenceIds.includes(m.id)&&m.providedCharacters>0&&isVideoTextKind(m.kind)).map(m=>m.kind==='subtitle'?1:Number(m.kind.match(/:p(\d+)$/)![1])))].sort((a,b)=>a-b);
  const title=typeof pageCount==='number'&&pageCount>1&&readPages.length<pageCount?row.title+'（本次仅'+readPages.map(p=>'P'+p).join('、')+'）':row.title;
  entries.push({itemKey:row.itemKey,title,url:url.origin+url.pathname,publishedAt:row.publishedAt,snapshot:row.snapshot,...good[0]});
 }
 entries.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||a.itemKey.localeCompare(b.itemKey));
 const selected=entries.slice(0,5),label=f=>f.basis==='documented'?'运行示意':'用途示意（概括）';
 const text='B站精选\n\n'+(selected.length?selected.map((e,i)=>`${i+1}. ${e.title}\n${e.url}\n${e.summary}\n${label(e.flow)}：${e.flow.steps.join(' → ')}`).join('\n\n'):'本批次暂无可展示内容。');
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>B站精选预览</title><body style="margin:0;background:#fff;color:#203a31;font:15px/1.8 system-ui,sans-serif"><main style="max-width:680px;margin:auto;padding:24px"><h2>B站精选</h2>'+(selected.length?selected.map((e,i)=>`<article style="margin:24px 0"><h3><a style="color:#245e47" href="${esc(e.url)}">${i+1}. ${esc(e.title)}</a></h3><p>${esc(e.summary)}</p><p style="font-size:12px;color:#6b766f">${label(e.flow)}</p><table role="presentation" style="width:100%;table-layout:fixed"><tr>${e.flow.steps.map((s,i)=>`${i?'<td style="width:18px;text-align:center">→</td>':''}<td style="border:1px solid #dce5db;padding:8px;background:#f4f7f3;overflow-wrap:anywhere">${esc(s)}</td>`).join('')}</tr></table></article>`).join(''):'<p>本批次暂无可展示内容。</p>')+'</main></body></html>';
 const custom=options.template?renderCustomMail('bilibili',options.template,batch,[{id:'bilibili',heading:'B站精选',rows:selected}]):null;
 return {formatVersion:'bilibili-brief-zh-v1',batch,text,html,...(custom?{...custom,customSubject:custom.subject}:{}),entries:selected,skipped,overflow:entries.slice(5).map(e=>e.itemKey),collectionWindows:windows,contentReady:selected.length>0,sendReady:false,collectionComplete:false,scope:'当前本地已读字幕的有界预览；不表示作者全量采集完成，不冻结投递或消耗配额',emailSent:false};
}
export function bilibiliPreview(config:any,store:Store,batch:Batch=latestDue()){
 const rendered=renderBilibiliBrief(store,batch,{template:loadMailTemplate(config.dataDir)}),folder=resolve(config.dataDir,'previews');mkdirSync(folder,{recursive:true});const preview=resolve(folder,`bilibili-${batch.date}-${batch.slot.replace(':','')}.html`);writeFileSync(preview,rendered.html);return {...rendered,preview};
}
