import {operatorUrl} from './operator-url.ts';import {stableId} from './model.ts';

/** Links carry an intention only. Opening them must never apply a preference. */
export function mailFeedbackLinks(settings:any,itemKey:unknown,topicId:unknown){
 if(!settings?.enabled||typeof itemKey!=='string'||typeof topicId!=='string'||!topicId.trim()||topicId.length>120||/[\x00-\x1f\x7f]/.test(topicId))return [];
 const split=itemKey.indexOf(':'),platform=itemKey.slice(0,split),id=itemKey.slice(split+1);
 if(!['github','bilibili'].includes(platform))return [];
 try{if(stableId(platform as 'github'|'bilibili',id)!==id)return [];}catch{return [];}
 const base=operatorUrl(settings.baseUrl);
 return [['useful','有用'],['less_like_this','不感兴趣']].map(([kind,label])=>{const url=new URL('/',base);url.searchParams.set('feedbackItem',itemKey);url.searchParams.set('feedbackTopic',topicId);url.searchParams.set('feedbackKind',kind);url.hash='feedback';return {label,url:url.href};});
}
