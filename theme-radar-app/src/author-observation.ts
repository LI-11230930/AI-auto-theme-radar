import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {hash,RadarError,requireText,stableId,now} from './model.ts';
import type {Store} from './store.ts';

function profile(value:unknown){
  let u:URL;try{u=new URL(requireText(value,'作者投稿页',300));}catch{throw new RadarError('INVALID_AUTHOR_PAGE','需要B站作者投稿页HTTPS地址');}
  const m=/^\/([1-9]\d{0,19})\/(?:upload\/video|video)\/?$/.exec(u.pathname);
  if(u.protocol!=='https:'||u.hostname!=='space.bilibili.com'||u.username||u.password||u.port||!m)throw new RadarError('INVALID_AUTHOR_PAGE','只接收space.bilibili.com/UID/upload/video或UID/video投稿页');
  return {uid:m[1],url:'https://space.bilibili.com/'+m[1]+'/upload/video'};
}
export function validateAuthorObservation(input:any,clock=Date.now()){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['schema','pageUrl','authorUid','observedAt','items','truncated'].includes(k))||input.schema!=='theme-radar-visible-author-v1')throw new RadarError('INVALID_AUTHOR_OBSERVATION','作者观察JSON结构无效；不接收Cookie或页面隐私字段');
  const page=profile(input.pageUrl),time=Date.parse(input.observedAt);
  if(input.authorUid!==page.uid||!Number.isFinite(time)||time>clock+60000||clock-time>31*86400000||typeof input.truncated!=='boolean'||!Array.isArray(input.items)||input.items.length>20)throw new RadarError('INVALID_AUTHOR_OBSERVATION','作者UID、观察时间或20条预算无效');
  const seen=new Set<string>();const items=input.items.map((row:any)=>{
    if(!row||Object.keys(row).some(k=>!['bvid','url','title'].includes(k)))throw new RadarError('INVALID_AUTHOR_OBSERVATION','候选只接收BV号、视频链接与可见标题');
    const bvid=stableId('bilibili',row.bvid);if(stableId('bilibili',requireText(row.url,'视频链接',300))!==bvid||!String(row.url).startsWith('https://www.bilibili.com/video/'))throw new RadarError('VIDEO_MISMATCH','视频链接与BV号不符');
    if(seen.has(bvid))throw new RadarError('INVALID_AUTHOR_OBSERVATION','同一观察不能重复BV号');seen.add(bvid);
    return {bvid,url:'https://www.bilibili.com/video/'+bvid,title:requireText(row.title,'可见标题',500)};
  });
  return {schema:'theme-radar-visible-author-v1',pageUrl:page.url,authorUid:page.uid,observedAt:new Date(time).toISOString(),items,truncated:input.truncated};
}
export function importAuthorObservation(store:Store,dataDir:string,topicId:string,input:any){
  const topic=store.topics().find(t=>t.id===topicId&&t.enabled&&t.platforms.includes('bilibili'));
  if(!topic)throw new RadarError('TOPIC_REQUIRED','请选择已启用的B站订阅');
  const snapshot=validateAuthorObservation(input);
  if(!topic.bilibiliAuthors?.includes(snapshot.authorUid))throw new RadarError('AUTHOR_NOT_SUBSCRIBED','该页面UID不在所选主题作者订阅中，不自动增加订阅');
  const id=hash(JSON.stringify({topicId,topicRevision:topic.revision,snapshot})),folder=resolve(dataDir,'author-observations');mkdirSync(folder,{recursive:true});
  const record={id,topicId,topicRevision:topic.revision,snapshot,importedAt:now(),scope:'浏览器可见链接观察；页面UID为调用方报告，逐条视频作者尚待平台核对；不是完整投稿、已读字幕或模型推荐',authorVerified:false,modelRun:false,emailSent:false,otherCommentsRead:0};
  let reused=false;try{writeFileSync(resolve(folder,id+'.json'),JSON.stringify(record,null,2),{flag:'wx'});}catch(e){if((e as any).code!=='EEXIST')throw e;reused=true;}
  return {...JSON.parse(readFileSync(resolve(folder,id+'.json'),'utf8')),reused};
}
export function listAuthorObservations(store:Store,dataDir:string){
  const folder=resolve(dataDir,'author-observations');let files:string[];try{files=readdirSync(folder).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));}catch(e){if((e as any).code==='ENOENT')return {observations:[],boundedTo:20};throw e;}
  const topics=store.topics(),records=files.map(name=>JSON.parse(readFileSync(resolve(folder,name),'utf8'))).sort((a,b)=>b.importedAt.localeCompare(a.importedAt)).slice(0,20);
  return {observations:records.map(r=>({...r,current:topics.some(t=>t.id===r.topicId&&t.revision===r.topicRevision&&t.enabled&&t.platforms.includes('bilibili')&&t.bilibiliAuthors?.includes(r.snapshot.authorUid))})),boundedTo:20};
}
