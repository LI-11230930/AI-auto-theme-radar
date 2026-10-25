import {readFileSync} from 'node:fs';
import {now,stableId,RadarError,requireText} from './model.ts';
import type {Evidence,Item} from './model.ts';
import {jsonRequest,stripHtml,request} from './http.ts';
import {parseDanmaku} from './danmaku.ts';
import {signWbi,wbiKey} from './wbi.ts';
import type {Fetcher} from './http.ts';
import {parseSubtitle} from './transcript.ts';
const uid=(value:unknown)=>{if(typeof value!=='string'||!/^\d{1,20}$/.test(value)||BigInt(value)===0n)throw new RadarError('INVALID_AUTHOR','UP主使用正整数UID，不能使用昵称');return BigInt(value).toString();};
export function subtitleUrl(value:unknown){
  if(typeof value!=='string')throw new RadarError('INVALID_SUBTITLE_URL','缺少字幕地址');
  let url:URL;try{url=new URL(value.startsWith('//')?'https:'+value:value);}catch{throw new RadarError('INVALID_SUBTITLE_URL','字幕地址无效');}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!/(?:^|\.)(?:hdslb|bilibili)\.com$/.test(url.hostname))throw new RadarError('INVALID_SUBTITLE_URL','字幕来源不属于允许的HTTPS域名');
  return url.href;
}
function selectedPages(value:unknown){if(value===undefined)return null;if(!Array.isArray(value)||!value.length||value.length>3||value.some(n=>!Number.isSafeInteger(n)||n<1||n>10000))throw new RadarError('INVALID_PAGES','每次选择1至3个有效分P序号');return [...new Set(value)] as number[];}
export class BilibiliSource {
  fetcher?:Fetcher;credentialFile?:string;
  constructor(options:{fetcher?:Fetcher;credentialFile?:string}={}){this.fetcher=options.fetcher;this.credentialFile=options.credentialFile;}
  headers(){let cookie='';if(this.credentialFile){let c:any;try{c=JSON.parse(readFileSync(this.credentialFile,'utf8'));}catch{throw new RadarError('CREDENTIAL_INVALID','无法读取或解析B站凭证文件，请在本机检查格式');}
    if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.sessdata!=='string'||!c.sessdata.trim())throw new RadarError('AUTH_REQUIRED','指定凭证文件缺少有效sessdata');
    for(const key of ['sessdata','bili_jct','buvid3'])if(c[key]!==undefined&&(typeof c[key]!=='string'||/[\r\n;]/.test(c[key])))throw new RadarError('CREDENTIAL_INVALID','B站凭证字段格式无效');
    cookie=`SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct||''}; buvid3=${c.buvid3||''}`;
  }return {Referer:'https://www.bilibili.com/',...(cookie?{Cookie:cookie}:{})};}
  async api(path:string){
    let r:any;try{r=await jsonRequest('https://api.bilibili.com'+path,{fetcher:this.fetcher,headers:this.headers()});}catch(e){if(e instanceof RadarError&&e.details.status===412)throw new RadarError('ACCESS_DENIED','B站接口返回HTTP 412，本次访问受限；不重试、不记为空结果，可保留已取得的浏览器材料',{upstreamStatus:412});throw e;}
    if(r.code!==0)throw new RadarError(r.code===-101?'AUTH_REQUIRED':r.code===-412?'ACCESS_DENIED':'UPSTREAM_ERROR','B站接口未完成读取',{upstreamCode:r.code});
    return r.data;
  }
  async search(keyword:string,limit=20,options:{authorUid?:string;page?:number}={}){
    requireText(keyword,'关键词',200);if(!Number.isSafeInteger(limit)||limit<1||limit>50||!Number.isSafeInteger(options.page??1)||(options.page??1)<1||(options.page??1)>5)throw new RadarError('INVALID_BUDGET','搜索每次1至50条，页码1至5');
    const author=options.authorUid===undefined?null:uid(options.authorUid);
    const r=await this.api('/x/web-interface/search/type?'+new URLSearchParams({search_type:'video',keyword,order:'pubdate',page:String(options.page??1)}));
    if(!Array.isArray(r?.result))throw new RadarError('INVALID_RESPONSE','B站搜索未返回候选列表');
    return r.result.filter((v:any)=>!author||String(v.mid).replace(/^0+/,'')===author).slice(0,limit).map((v:any)=>({bvid:stableId('bilibili',v.bvid),title:stripHtml(String(v.title||'')),author:v.author,authorId:String(v.mid),publishedAt:Number.isFinite(v.pubdate)?new Date(v.pubdate*1000).toISOString():null,...(author?{scope:'关键词搜索结果按UID过滤；非该UP主全部投稿'}:{})}));
  }
  async authorVideos(authorUid:string,options:{page?:number;limit?:number}={}){
    const author=uid(authorUid),page=options.page??1,limit=options.limit??10;
    if(!Number.isSafeInteger(page)||page<1||page>2||!Number.isSafeInteger(limit)||limit<1||limit>20)throw new RadarError('INVALID_BUDGET','作者扫描每次1至20条，最多前2页');
    const nav=await this.api('/x/web-interface/nav');
    const signed=signWbi({mid:author,pn:String(page),ps:String(limit),order:'pubdate'},wbiKey(nav?.wbi_img?.img_url),wbiKey(nav?.wbi_img?.sub_url));
    const data=await this.api('/x/space/wbi/arc/search?'+signed);
    if(!Array.isArray(data?.list?.vlist))throw new RadarError('INVALID_RESPONSE','作者投稿接口没有返回视频清单；不当作空投稿');
    const items=data.list.vlist.slice(0,limit).map((v:any)=>{
      if(v.mid===undefined||uid(String(v.mid))!==author)throw new RadarError('AUTHOR_MISMATCH','投稿列表的作者UID与订阅不符，未接收本页');
      const bvid=stableId('bilibili',v.bvid);if(typeof v.title!=='string'||!v.title.trim())throw new RadarError('INVALID_RESPONSE','投稿缺少标题');
      const timestamp=typeof v.created==='number'&&Number.isSafeInteger(v.created)&&v.created>0?v.created*1000:null;
      return {bvid,title:stripHtml(v.title),author:String(v.author||''),authorId:author,publishedAt:timestamp!==null&&Number.isFinite(new Date(timestamp).getTime())?new Date(timestamp).toISOString():null};
    });
    return {items,authorId:author,page,limit,totalReported:Number.isSafeInteger(data.page?.count)&&data.page.count>=0?data.page.count:null,exhaustive:false,scope:'指定UID的有界最近投稿页；不代表全部历史、删除/隐藏投稿或无遗漏增量，不读取评论'};
  }
  /** Exposes one normally available P1 DASH audio URL to a bounded local ASR worker; never downloads or stores it. */
  async audio(bvidInput:string,options:{expectedAuthorUid:string;expectedCid:string;signal?:AbortSignal}):Promise<{bvid:string;cid:string;duration:number;audioUrl:string}>{
    const checkpoint=()=>{if(options?.signal?.aborted)throw new RadarError('CANCELLED','本轮已取消，未继续获取音频');};checkpoint();
    const decimal=(value:unknown):string|null=>{
      if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):null;
      return typeof value==='string'&&/^\d{1,20}$/.test(value)&&BigInt(value)>0n?BigInt(value).toString():null;
    };
    let bvid:string;try{bvid=stableId('bilibili',bvidInput);}catch(error){if(error instanceof RadarError)throw error;throw new RadarError('INVALID_ID','音频输入需要有效BV号或正常HTTPS视频链接');}
    const author=uid(options?.expectedAuthorUid),cid=typeof options?.expectedCid==='string'?decimal(options.expectedCid):null;
    if(!cid)throw new RadarError('INVALID_CID','音频需要已核对的正整数P1 CID');
    if(bvidInput!==bvid){let input:URL;try{input=new URL(bvidInput);}catch{throw new RadarError('INVALID_ID','音频输入需要BV号或正常HTTPS视频链接');}
      if(input.protocol!=='https:'||!['www.bilibili.com','bilibili.com'].includes(input.hostname)||input.username||input.password||input.port&&input.port!=='443'||!new RegExp('^/video/'+bvid+'/?$').test(input.pathname))throw new RadarError('INVALID_ID','音频输入只接受正常HTTPS视频链接');
      const pages=input.searchParams.getAll('p');if(pages.length>1||pages.length===1&&pages[0]!=='1')throw new RadarError('INVALID_PAGES','本轮音频阅读仅支持P1');
    }
    checkpoint();let info:any;try{info=await this.api('/x/web-interface/view?bvid='+encodeURIComponent(bvid));}finally{checkpoint();}
    if(info?.bvid!==bvid)throw new RadarError('VIDEO_MISMATCH','视频信息与音频请求BV不符');
    if(decimal(info?.owner?.mid)!==author)throw new RadarError('AUTHOR_MISMATCH','实际视频作者与已核对UID不符，未读取音频地址');
    let part:any;
    if(info.pages===undefined)part={page:1,cid:info.cid,duration:info.duration};
    else if(Array.isArray(info.pages)&&info.pages.length>0&&info.pages.length<=10000){const first=info.pages.filter((p:any)=>p?.page===1);if(first.length===1)part=first[0];}
    if(!part||decimal(part.cid)!==cid||info.cid!==undefined&&decimal(info.cid)!==cid)throw new RadarError('SOURCE_CHANGED','P1 CID与已核对材料不一致，未读取音频地址');
    const duration=part.duration;
    if(typeof duration!=='number'||!Number.isFinite(duration)||duration<=0||duration>600)throw new RadarError('ASR_BUDGET','本轮仅支持已知时长且不超过600秒的P1音频');
    checkpoint();let playback:any;try{playback=await this.api('/x/player/playurl?'+new URLSearchParams({bvid,cid,fnval:'16',qn:'16',fourk:'0'}));}finally{checkpoint();}
    if(playback?.bvid!==undefined&&playback.bvid!==bvid)throw new RadarError('VIDEO_MISMATCH','音频播放结果返回了其他视频');
    if(playback?.cid!==undefined&&decimal(playback.cid)!==cid)throw new RadarError('SOURCE_CHANGED','音频播放结果返回了其他分P');
    const audio=playback?.dash?.audio;
    if(!Array.isArray(audio)||!audio.length||audio.length>1000)throw new RadarError('NO_AUDIO','接口未正常暴露有界DASH音轨；未尝试其他播放或受限来源');
    const streams=audio.filter((row:any)=>row&&typeof row==='object'&&!Array.isArray(row)&&Number.isSafeInteger(row.bandwidth)&&row.bandwidth>0);
    if(!streams.length)throw new RadarError('NO_AUDIO','DASH音轨没有有效的正整数带宽');
    const stream=streams.reduce((best:any,row:any)=>row.bandwidth<best.bandwidth?row:best),raw=stream.baseUrl??stream.base_url;
    let url:URL;try{if(typeof raw!=='string'||!raw||raw.length>16384)throw new Error('invalid');url=new URL(raw);}catch{throw new RadarError('INVALID_AUDIO_URL','DASH音轨地址无效');}
    const mediaPort=url.port==='8082'&&/\.mcdn\.bilivideo\.cn$/.test(url.hostname);
    if(url.protocol!=='https:'||url.username||url.password||url.port&&!mediaPort||url.hash||!/(?:^|\.)(?:bilivideo\.(?:com|cn)|hdslb\.com)$/.test(url.hostname))throw new RadarError('INVALID_AUDIO_URL','音轨仅允许平台HTTPS媒体域名和指定媒体端口');
    checkpoint();return{bvid,cid,duration,audioUrl:url.href};
  }
  async read(bvidInput:string,options:{pages?:number[];expectedAuthorUid?:string;includeDanmaku?:boolean}={}):Promise<{item:Item;evidence:Evidence[];warnings:string[]}>{
    if(options.includeDanmaku!==undefined&&typeof options.includeDanmaku!=='boolean')throw new RadarError('INVALID_INPUT','includeDanmaku需要布尔值');
    let requested=selectedPages(options.pages);const bvid=stableId('bilibili',bvidInput);
    if(requested===null&&/^https?:/.test(bvidInput)){const p=new URL(bvidInput).searchParams.get('p');if(p!==null)requested=selectedPages([Number(p)]);}
    const info=await this.api('/x/web-interface/view?bvid='+encodeURIComponent(bvid)),collectedAt=now();
    if(options.expectedAuthorUid!==undefined&&uid(String(info?.owner?.mid||''))!==uid(options.expectedAuthorUid))throw new RadarError('AUTHOR_MISMATCH','视频实际作者UID与观察页面不符，未读取字幕或归档');
    if(info?.bvid&&info.bvid!==bvid)throw new RadarError('VIDEO_MISMATCH','返回视频与请求BV号不一致');
    if(typeof info?.title!=='string'||!info.title.trim())throw new RadarError('INVALID_RESPONSE','视频信息缺少标题');
    const pages=Array.isArray(info.pages)&&info.pages.length?info.pages:[{page:1,cid:info.cid,duration:info.duration,part:info.title}];
    if(pages.length>10000||pages.some((p:any)=>!Number.isSafeInteger(p.page)||p.page<1||!Number.isSafeInteger(Number(p.cid))||Number(p.cid)<1)||new Set(pages.map((p:any)=>p.page)).size!==pages.length)throw new RadarError('INVALID_RESPONSE','视频分P清单无效');
    const chosen=requested||pages.slice(0,3).map((p:any)=>p.page);if(chosen.some(n=>!pages.some((p:any)=>p.page===n)))throw new RadarError('INVALID_PAGES','所选分P不在视频清单内');
    const item:Item={key:'bilibili:'+bvid,platform:'bilibili',externalId:bvid,title:info.title,url:'https://www.bilibili.com/video/'+bvid,author:info.owner?.name||'',authorId:String(info.owner?.mid||''),publishedAt:info.pubdate?new Date(info.pubdate*1000).toISOString():null,discoveredAt:collectedAt,version:'video',metadata:{cid:info.cid,aid:info.aid,pageCount:pages.length,requestedPages:chosen,readOtherComments:false,audioRead:false,visionRead:false}};
    const evidence:Evidence[]=[{itemKey:item.key,kind:'description',url:item.url,text:typeof info.desc==='string'?info.desc:'',collectedAt,coverage:{material:'视频简介',expected:1,acquired:1,processed:0,state:'unread',method:'B站视频信息'}}],warnings:string[]=[],results:any[]=[];
    if(chosen.length<pages.length)warnings.push(`本轮选择${chosen.length}/${pages.length}个分P；其他分P未读取`);
    for(const page of chosen){const part=pages.find((p:any)=>p.page===page),url=item.url+'?p='+page,result:any={page,cid:String(part.cid),duration:Number.isFinite(part.duration)&&part.duration>0?part.duration:null,state:'unavailable',segments:0};
      try{
        const player=await this.api('/x/player/wbi/v2?'+new URLSearchParams({aid:String(info.aid),cid:String(part.cid)}));
        if((player?.aid!==undefined&&String(player.aid)!==String(info.aid))||(player?.bvid!==undefined&&player.bvid!==bvid))throw new RadarError('VIDEO_MISMATCH','字幕播放器返回了其他视频');
        if(player?.cid!==undefined&&String(player.cid)!==String(part.cid))throw new RadarError('VIDEO_MISMATCH','字幕播放器返回了其他分P');
        const tracks=player?.subtitle?.subtitles;if(!Array.isArray(tracks))throw new RadarError('INVALID_RESPONSE','播放器未返回字幕轨列表');
        const track=tracks.find((t:any)=>['ai-zh','zh-CN','zh'].includes(t.lan))||tracks[0];
        if(!track){result.reason='no_track_exposed';warnings.push(`P${page}当前未提供字幕轨；不能据此断言视频没有字幕，登录/平台限制未排除；音频处理情况见独立记录`);}
        else{
          const parsed=parseSubtitle(await jsonRequest(subtitleUrl(track.subtitle_url),{fetcher:this.fetcher,maxBytes:600000}),{duration:result.duration});
          result.language=typeof track.lan==='string'?track.lan:'unknown';result.state=parsed.truncated?'partial':parsed.text?'acquired':'empty';result.segments=parsed.acquiredSegments;result.expectedSegments=parsed.expectedSegments;result.coveredSeconds=parsed.coveredSeconds;result.lastTimestamp=parsed.lastTimestamp;
          const note=`P${page} / CID ${part.cid}；${parsed.acquiredSegments}/${parsed.expectedSegments}段；${parsed.notes.join('；')}`;
          evidence.push({itemKey:item.key,kind:pages.length===1?'subtitle':`subtitle:p${page}`,url,text:parsed.text,collectedAt,coverage:{material:`P${page}字幕`,expected:parsed.expectedSegments,acquired:parsed.acquiredSegments,processed:0,state:parsed.text?'unread':'unavailable',method:'有界字幕轨提取；未读音频与画面',note}});
          evidence.push({itemKey:item.key,kind:`subtitle-timeline:p${page}`,url,text:JSON.stringify({page,cid:String(part.cid),language:result.language,segments:parsed.segments,truncated:parsed.truncated}),collectedAt,coverage:{material:`P${page}字幕时间轴`,expected:parsed.expectedSegments,acquired:parsed.acquiredSegments,processed:0,state:parsed.segments.length?'unread':'unavailable',method:'字幕JSON时间轴；模型处理范围另记',note}});
          if(parsed.truncated||!parsed.text)warnings.push(`P${page}字幕${parsed.truncated?'达到预算被截断':'为空'}；不记为整片已读`);
        }
      }catch(e){result.state='failed';result.reason=e instanceof RadarError?e.code:'UNKNOWN';warnings.push(`P${page}字幕读取未完成：${result.reason}；保留其他已取得分P，音频和画面未读`);}
      results.push(result);
    }
    if(options.includeDanmaku){const captures:any[]=[];for(const page of chosen){const part=pages.find((p:any)=>p.page===page);try{
      const response=await request('https://api.bilibili.com/x/v2/dm/web/seg.so?'+new URLSearchParams({type:'1',oid:String(part.cid),segment_index:'1'}),{fetcher:this.fetcher,headers:this.headers(),maxBytes:600000});
      if(!/application\/(?:octet-stream|x-protobuf)/i.test(response.headers.get('content-type')||''))throw new RadarError('INVALID_DANMAKU','弹幕接口未返回预期分包；未当作空弹幕');
      const parsed=parseDanmaku(response.bytes),end=Math.min(Number(part.duration)||360,360);
      if(parsed.rows.some(row=>row.timeSeconds>end+1))throw new RadarError('INVALID_DANMAKU','弹幕时间超出所请求分包范围');
      const scope={page,segmentIndex:1,windowSeconds:[0,end],exhaustive:false,...parsed};
      captures.push({page,state:'acquired',count:parsed.rows.length,truncated:parsed.truncated,segmentIndex:1});
      evidence.push({itemKey:item.key,kind:`danmaku:p${page}`,url:item.url+'?p='+page,text:JSON.stringify(scope),collectedAt,coverage:{material:`P${page}有界弹幕样本`,expected:null,acquired:parsed.rows.length,processed:0,state:parsed.rows.length?'unread':'unavailable',method:'首个6分钟分包、最多100条；观众反应，不是视频事实或评论区',note:'不获取发送者身份；未覆盖其他分包、历史弹幕或保证全量'}});
    }catch(e){captures.push({page,state:'failed',code:e instanceof RadarError?e.code:'UNKNOWN'});warnings.push(`P${page}弹幕读取未完成；保留字幕，不记作无弹幕`);break;}}item.metadata.danmakuPages=captures;}
    item.metadata.subtitlePages=results;
    evidence.push({itemKey:item.key,kind:'video-reading-manifest',url:item.url,text:JSON.stringify({pageCount:pages.length,requestedPages:chosen,pages:results,audio:{state:'unread',asrConfigured:false},vision:{state:'unread'},otherCommentsRead:0}),collectedAt,coverage:{material:'视频读取范围清单',expected:1,acquired:1,processed:0,state:'unread',method:'读取过程记录；不是视频内容'}});
    return {item,evidence,warnings};
  }
  capabilities(){return {read:['search','video_info','subtitle','subtitle_timeline','bounded_multipart','optional_bounded_danmaku'],maxPagesPerRead:3,danmaku:{optIn:true,maxPerPage:100,segmentIndex:1,maxWindowSeconds:360,exhaustive:false},authorFilter:'UID over bounded signed author API; live access can be restricted',readOtherComments:false,structuredMention:'disabled-email-only',audio:false,vision:false};}
}
