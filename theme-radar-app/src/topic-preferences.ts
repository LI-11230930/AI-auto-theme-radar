import {normalizeText} from './model.ts';
import type {Topic} from './model.ts';

/** A reading priority only. Never turns an unexamined candidate into a selection. */
export function matchesPreference(text:string,term:string){
  const value=normalizeText(text).toLowerCase(),word=normalizeText(term).toLowerCase();
  if(!word)return false;
  if(/^[a-z0-9]+$/.test(word))return new RegExp('(^|[^a-z0-9])'+word+'($|[^a-z0-9])').test(value);
  return value.includes(word);
}
export function preferenceBoost(topic:Topic,text:string){return (topic.preferred||[]).filter(term=>matchesPreference(text,term)).length;}
export function feedbackTopic(topic:Topic,kind:string,rule:string):Topic{
  if(['less_like_this','irrelevant'].includes(kind))return {...topic,exclude:[...new Set([...topic.exclude,rule])]};
  if(kind==='useful'){
    if((topic.preferred||[]).some(term=>normalizeText(term).toLowerCase()===normalizeText(rule).toLowerCase()))return topic;
    return {...topic,preferred:[...(topic.preferred||[]),rule]};
  }
  return topic;
}
export function selectionProfile(topic:Topic){return {
  objective:topic.goal?.objective||null,
  implementationFirst:topic.goal?.implementationFirst??false,
  preferredTerms:topic.preferred||[],
  policy:'开发目标和优先词仅调整相关性与阅读优先级，不是内容证据；排除词优先。不能因命中偏好而跳过正文阅读或强行推荐。实现优先开启时，优先材料中确有机制、接口、代码或可复现步骤的内容，广告、预告或名称罗列不算实现。'
};}
