import { now, stableId, RadarError,bindAccount } from './model.ts';
import type { Evidence, Item } from './model.ts';
import { jsonRequest, stripHtml } from './http.ts';
import type { Fetcher } from './http.ts';

export { BilibiliSource } from './bilibili.ts';

export class XiaohongshuSource {
  baseUrl:string;fetcher?:Fetcher;
  constructor(baseUrl='http://127.0.0.1:18060',fetcher?:Fetcher){const url=new URL(baseUrl);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw new RadarError('INVALID_BRIDGE','仅连接本机小红书桥接');this.baseUrl=url.origin;this.fetcher=fetcher;}
  async api(path:string,body?:object){const r=await jsonRequest(this.baseUrl+path,{fetcher:this.fetcher,method:body?'POST':'GET',body});if(r.success===false||r.error)throw new RadarError('XHS_ERROR','小红书桥接返回失败');return r.data??r;}
  async status(){const data=await this.api('/api/v1/login/status');const userId=/^[a-f0-9]{24}$/i.test(data.user_id||'')?String(data.user_id).toLowerCase():null;return {loggedIn:data.is_logged_in===true,userId,displayName:data.username||null,identityConfirmed:data.is_logged_in===true&&!!userId};}
  async search(keyword:string,limit=20){const result=await this.api('/api/v1/feeds/search',{keyword});return (result.feeds||[]).slice(0,limit).map((x:any)=>({id:stableId('xiaohongshu',x.id),accessHint:x.xsecToken||x.xsec_token,title:x.noteCard?.displayTitle||x.note_card?.display_title||''}));}
  async read(idInput:string,accessHint:string):Promise<{item:Item;evidence:Evidence[];warnings:string[]}>{
    const id=stableId('xiaohongshu',idInput);if(!accessHint)throw new RadarError('ACCESS_HINT_REQUIRED','需要搜索结果附带的临时访问参数，不以它识别用户');
    const response=await this.api('/api/v1/feeds/detail',{feed_id:id,xsec_token:accessHint,load_all_comments:false});const result=response.data||response;const note=result.note?.note_card||result.note?.noteCard||result.note_card||result.noteCard||result.note;
    if(!note)throw new RadarError('INVALID_RESPONSE','小红书桥接缺少笔记正文');
    const collectedAt=now(),images=note.image_list||note.imageList||[],user=note.user||{};
    const item:Item={key:'xiaohongshu:'+id,platform:'xiaohongshu',externalId:id,title:note.title||note.display_title||'小红书笔记',url:'https://www.xiaohongshu.com/explore/'+id,author:user.nickname||'',authorId:String(user.user_id||user.userId||''),publishedAt:note.time?new Date(note.time).toISOString():null,discoveredAt:collectedAt,version:'note',metadata:{imageCount:images.length,type:note.type||'unknown',commentsAnalyzed:false}};
    const evidence:Evidence[]=[{itemKey:item.key,kind:'note-text',url:item.url,text:note.desc||'',collectedAt,coverage:{material:'笔记正文',expected:1,acquired:1,processed:0,state:'unread',method:'本机小红书桥接'}}];
    if(images.length)evidence.push({itemKey:item.key,kind:'image-manifest',url:item.url,text:JSON.stringify(images.map((x:any)=>({url:x.url_default||x.urlDefault||x.url||null}))),collectedAt,coverage:{material:'图片',expected:images.length,acquired:0,processed:0,state:'unavailable',method:'仅取得图片地址；图片内容尚未下载或识别'}});
    return {item,evidence,warnings:images.length?['图片仅取得地址，尚未 OCR/视觉分析；视频音频尚未读取']:[]};
  }
}

export function prepareMention(platform:'bilibili'|'xiaohongshu',binding:any,itemKey:string,text:string){
  if(platform==='bilibili')throw new RadarError('EMAIL_NOTIFICATION_ONLY','用户已将B站提醒改为邮件汇总，不再准备评论区提及；邮件已采用链接和简短中文介绍');
  if(!binding?.confirmed||binding.platform!==platform)throw new RadarError('ACCOUNT_NOT_CONFIRMED','先确认执行账号与接收 ID');
  const verified=bindAccount(platform,binding.executorId,binding.recipientId,{name:binding.name,profile:binding.profile,confirmed:binding.confirmed});
  if(!itemKey.startsWith(platform+':'))throw new RadarError('INVALID_ITEM','平台与内容不匹配');
  if(!text.trim()||text.length>150)throw new RadarError('INVALID_COMMENT','评论正文须为 1–150 字符');
  return {platform,itemKey,text,executorId:verified.executorId,recipientId:verified.recipientId,recipientName:binding.name,requiredCapability:'structured-user-mention',state:'needs_provider_verification',sent:false,note:'必须在平台界面或已验证接口中按 ID 选中目标；此准备结果不会发表评论。'};
}
