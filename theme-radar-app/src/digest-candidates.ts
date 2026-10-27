import type {Store} from './store.ts';
import {RadarError} from './model.ts';
import {archivedAnalysis} from './archive-reading.ts';

export const notificationPlan=(recipient:string|null=null,format:{formatState?:string;sections?:string[]}={})=>({bilibili:'email',github:'email',xiaohongshu:'paused',recipient,timezone:'Asia/Shanghai',slots:['09:00','18:00'],commentMentionEnabled:false,emailFormat:{state:format.formatState||'default_template_available',version:format.formatState==='custom_template_configured'?'custom':'github-brief-zh-v3',githubSections:(format.sections||['projects','daily','weekly']).map(id=>({projects:'主题项目',daily:'GitHub Trending Daily前十',weekly:'GitHub Trending Weekly前十'}[id])),copy:'链接和简短中文介绍；技术证据仅留档',appliesTo:['bilibili','github']},deliveryEnabled:false,scope:'邮箱与模板由使用者配置；时段保留为规划，本视图不授权发送或调度'});

/** Format-independent archive projection, not a frozen outbox or delivery promise. */
export function digestCandidates(store:Store,options:{platform?:string;topicId?:string;itemKeys?:string[]}={},recipient:string|null=null){
  const platform=options.platform??'bilibili';if(!['bilibili','github','all'].includes(platform))throw new RadarError('INVALID_PLATFORM','待汇总来源仅支持B站、GitHub或all');
  const topics=store.topics().filter(t=>t.enabled&&(!options.topicId||t.id===options.topicId));if(options.topicId&&!topics.length)throw new RadarError('TOPIC_REQUIRED','启用主题不存在');
  if(options.itemKeys!==undefined&&(!Array.isArray(options.itemKeys)||options.itemKeys.length>5||options.itemKeys.some(k=>typeof k!=='string'||k.length>300)))throw new RadarError('INVALID_INPUT','显式精选键最多5项');
  const items=options.itemKeys?[...new Set(options.itemKeys)].map(k=>store.item(k)).filter(i=>i&&(platform==='all'||i.platform===platform)):store.search('',{...(platform==='all'?{}:{platform}),limit:100}),rows:any[]=[];
  for(const item of items){
    if(!['bilibili','github'].includes(item.platform))continue;
    const relevant=topics.filter(t=>t.platforms.includes(item.platform)&&(item.platform!=='bilibili'||!t.bilibiliAuthors?.length||t.bilibiliAuthors.includes(item.authorId)));
    if(!relevant.length)continue;
    const analyses=archivedAnalysis(store,item.key).assessments;
    const judgments=relevant.map(t=>{const a=analyses.find(a=>a.topicId===t.id&&a.current&&!a.simulation);return {topicId:t.id,topicName:t.name,topicRevision:t.revision,state:a?(a.selected?'selected':'not_selected'):'awaiting_analysis',assessment:a||null};});
    const selected=judgments.some(j=>j.state==='selected'),alreadyRecommended=store.alreadyRecommended(item.key);
    rows.push({itemKey:item.key,platform:item.platform,title:item.title,url:item.url,authorId:item.authorId,author:item.author,publishedAt:item.publishedAt,judgments,state:selected?(alreadyRecommended?'already_recommended':'candidate'):judgments.some(j=>j.state==='awaiting_analysis')?'awaiting_analysis':'not_selected',materials:store.currentEvidence(item.key).map(e=>({id:e.id,kind:e.kind,characters:e.text.length,coverage:e.coverage})),snapshot:store.readingSnapshot(item.key)});
  }
  return {schema:'theme-radar-digest-candidates-v1',formatStatus:'confirmed',platform,rows,counts:{scanned:items.length,rows:rows.length,candidates:rows.filter(r=>r.state==='candidate').length,awaitingAnalysis:rows.filter(r=>r.state==='awaiting_analysis').length},boundedToLatest:100,notificationPlan:notificationPlan(recipient),scope:'仅列本地已归档内容及相应主题当前非模拟判断；不是排版、时间批次筛选或最终精选，不冻结outbox、不预留配额、不调用上游/模型/发送',emailSent:false};
}
