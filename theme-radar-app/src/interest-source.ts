import type {BilibiliSource} from './bilibili.ts';
import {RadarError} from './model.ts';
import {stripHtml} from './http.ts';

export type InterestCandidate={bvid:string;title:string;author:string;authorId:string;publishedAt:string|null;source:'recommendation'};
type ApiSource=Pick<BilibiliSource,'api'>;

function authorUid(value:unknown):string|null{
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):null;
  if(typeof value!=='string'||!/^\d{1,20}$/.test(value)||BigInt(value)===0n)return null;
  return BigInt(value).toString();
}
function publishedAt(value:unknown):string|null{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)return null;
  const milliseconds=value*1000;
  if(!Number.isSafeInteger(milliseconds))return null;
  const date=new Date(milliseconds);return Number.isFinite(date.getTime())?date.toISOString():null;
}
function candidate(value:unknown):InterestCandidate|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const row=value as Record<string,any>;
  if(row.goto!=='av'||typeof row.bvid!=='string'||!/^BV[0-9A-Za-z]{10}$/.test(row.bvid))return null;
  // Ad metadata is never copied. Unknown/nonempty advertising flags are rejected too.
  if(row.is_ad!==undefined&&row.is_ad!==null&&row.is_ad!==false&&row.is_ad!==0)return null;
  if(row.ad_info!==undefined&&row.ad_info!==null)return null;
  if(row.business_info!==undefined&&row.business_info!==null)return null;
  if(typeof row.title!=='string'||row.title.length>500)return null;
  const title=stripHtml(row.title);if(!title)return null;
  const owner=row.owner;if(!owner||typeof owner!=='object'||Array.isArray(owner))return null;
  const authorId=authorUid(owner.mid);
  if(!authorId||typeof owner.name!=='string'||owner.name.length>1000)return null;
  return {bvid:row.bvid,title,author:stripHtml(owner.name),authorId,publishedAt:publishedAt(row.pubdate),source:'recommendation'};
}

/** One authenticated recommendation page; neither browsing history nor user profiling is read. */
export class BilibiliInterestSource{
  private source:ApiSource;
  constructor(source:ApiSource){this.source=source;}
  async recommendations(limit=12):Promise<{items:InterestCandidate[];excluded:number;authenticated:true;scope:string}>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new RadarError('INVALID_BUDGET','兴趣发现每轮仅获取一页，选择1至20条候选');
    let nav:any;try{nav=await this.source.api('/x/web-interface/nav');}catch(error){throw new RadarError(error instanceof RadarError?error.code:'LOGIN_CHECK_FAILED','本次未能核验B站登录连接，未请求推荐内容；请先查看连接状态');}
    const accountId=authorUid(nav?.mid);
    if(nav?.isLogin!==true||!accountId)throw new RadarError('AUTH_REQUIRED','B站账号尚未登录，请先在本地账号连接页扫码；未请求推荐内容');
    const data=await this.source.api('/x/web-interface/wbi/index/top/feed/rcmd?'+new URLSearchParams({fresh_type:'4',ps:String(limit),fresh_idx:'1'}));
    if(data?.mid!==undefined&&authorUid(data.mid)!==accountId)throw new RadarError('ACCOUNT_MISMATCH','推荐结果与已登录账号不符，未接收候选；不降级为匿名推荐');
    if(!Array.isArray(data?.item)||data.item.length>1000)throw new RadarError('INVALID_RESPONSE','B站推荐接口未返回有效的有界候选数组；不当作没有推荐内容');
    const items:InterestCandidate[]=[],seen=new Set<string>();let excluded=0;
    for(const row of data.item){const parsed=candidate(row);if(!parsed||seen.has(parsed.bvid)||items.length>=limit){excluded++;continue;}seen.add(parsed.bvid);items.push(parsed);}
    return {items,excluded,authenticated:true,scope:'已登录账号首页推荐的一次有界快照；仅公开视频候选，非全部兴趣或无遗漏列表；不读取评论、历史记录或账号画像'};
  }
}
