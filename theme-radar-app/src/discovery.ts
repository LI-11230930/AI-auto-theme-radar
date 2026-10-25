import {RadarError,now,requireText,normalizeText} from './model.ts';
import type {Topic} from './model.ts';
import type {GitHubSource} from './github.ts';
import type {BilibiliSource} from './bilibili.ts';

/** Bounded, read-only discovery. Search matches are not model selections or a full author feed. */
export async function discoverTopic(topic:Topic,sources:{github:Pick<GitHubSource,'search'>;bilibili:Pick<BilibiliSource,'search'>&Partial<Pick<BilibiliSource,'authorVideos'>>;xiaohongshuEnabled:boolean}){
  if(!topic?.enabled)throw new RadarError('TOPIC_REQUIRED','请选择已启用主题');
  requireText(topic.id,'主题ID',120);
  const candidates=new Map<string,any>(),states:any[]=[];let excluded=0;
  const perSourceLimit=Math.floor(20/Math.max(1,new Set(topic.platforms.filter(p=>p!=='xiaohongshu')).size));
  for(const platform of [...new Set(topic.platforms)]){
    if(platform==='xiaohongshu'){states.push({platform,state:'skipped',code:sources.xiaohongshuEnabled?'INTERACTIVE_SOURCE_REQUIRED':'CAPABILITY_PAUSED',note:'小红书保持单独桥接与身份确认，本入口不自动访问。'});continue;}
    try{
      let rows:any[]=[];let queries=0,scope='',partial=false,plannedQueries=1;const failures:any[]=[];
      if(platform==='github'){
        const result=await sources.github.search(topic,perSourceLimit);rows=result.items.map((v:any)=>({key:'github:'+v.repo,platform,title:v.repo,description:v.description||'',url:v.url,publishedAt:v.createdAt||null,pushedAt:v.pushedAt||null,authorId:''}));queries=1;partial=result.incomplete;scope='当前主题GitHub搜索；候选尚未模型筛选，来源创建时间与push时间分开保留。';
      }else if(platform==='bilibili'&&topic.bilibiliDiscovery==='interests'){
        throw new RadarError('INTEREST_ROUND_REQUIRED','兴趣主题请使用兴趣自主阅读入口，将推荐候选与字幕分析连成一轮');
      }else if(platform==='bilibili'&&topic.bilibiliDiscovery==='authors'){
        if(!topic.bilibiliAuthors?.length||!sources.bilibili.authorVideos)throw new RadarError('AUTHOR_SOURCE_REQUIRED','作者模式需要UID和可用投稿适配器，不回退成全站关键词搜索');
        plannedQueries=topic.bilibiliAuthors.length;const authors=topic.bilibiliAuthors.slice(0,3),perAuthor=Math.max(1,Math.floor(perSourceLimit/authors.length));
        for(const authorUid of authors){queries++;try{const result=await sources.bilibili.authorVideos(authorUid,{page:1,limit:perAuthor});if(result.authorId!==authorUid||result.items.some(v=>v.authorId!==authorUid))throw new RadarError('AUTHOR_MISMATCH','投稿UID与订阅不符');rows.push(...result.items.map(v=>({key:'bilibili:'+v.bvid,platform,title:v.title,url:'https://www.bilibili.com/video/'+v.bvid,publishedAt:v.publishedAt,authorId:v.authorId,author:v.author})));}catch(e){partial=true;failures.push({authorUid,code:e instanceof RadarError?e.code:'SOURCE_FAILED',note:e instanceof RadarError?e.message:'作者来源未完成'});break;}}
        scope='按订阅UID各扫描第1页，最多3位作者、共享20条预算；不按关键词截掉作者投稿，候选未读未筛选，不是全量历史或完整增量。';
      }else if(platform==='bilibili'){
        const authors=topic.bilibiliAuthors?.length?topic.bilibiliAuthors:[undefined];
        plannedQueries=topic.keywords.length*authors.length;
        const combos=topic.keywords.flatMap(keyword=>authors.map(authorUid=>({keyword,authorUid}))).slice(0,3);
        for(const q of combos){queries++;try{const result=await sources.bilibili.search(q.keyword,20,{authorUid:q.authorUid,page:1});rows.push(...result.map(v=>({key:'bilibili:'+v.bvid,platform,title:v.title,url:'https://www.bilibili.com/video/'+v.bvid,publishedAt:v.publishedAt,authorId:v.authorId,author:v.author})));}catch(e){partial=true;failures.push({code:e instanceof RadarError?e.code:'SOURCE_FAILED',note:e instanceof RadarError?e.message:'来源未完成读取'});break;}}
        scope='最多3组关键词/UID组合，每组第1页；UID仅过滤这些搜索结果，不等于UP主完整投稿或无遗漏增量。';
      }
      let added=0;for(const row of rows){const text=normalizeText(row.title+' '+(row.description||'')).toLowerCase();if(topic.exclude.some(word=>word.trim()&&text.includes(normalizeText(word).toLowerCase()))){excluded++;continue;}if(added>=perSourceLimit)break;if(!candidates.has(row.key)){candidates.set(row.key,{...row,modelSelected:false,materialState:'not_read'});added++;}}
      states.push({platform,state:partial?(rows.length?'partial':'failed'):'succeeded',queries,omittedQueries:Math.max(0,plannedQueries-queries),returned:rows.length,added,limit:perSourceLimit,scope,failures});
    }catch(e){states.push({platform,state:'failed',code:e instanceof RadarError?e.code:'SOURCE_FAILED',note:e instanceof RadarError?e.message:'来源未完成读取；未使用其他结果伪装成功'});}
  }
  return {at:now(),topicId:topic.id,topicRevision:(topic as any).revision??null,candidates:[...candidates.values()],sources:states,excluded,limit:20,sourcesSucceeded:states.every(s=>s.state==='succeeded'),exhaustive:false,modelRun:false,emailSent:false,otherCommentsRead:0};
}
