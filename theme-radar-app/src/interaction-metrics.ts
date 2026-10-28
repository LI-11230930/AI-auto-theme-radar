import type {Item,Platform} from './model.ts';

const fields:Record<Platform,string[]>={github:['stars','forks','watchers'],bilibili:['view','like','coin','favorite','share','danmaku','reply'],xiaohongshu:[]};
export function interactionMetrics(platform:Platform,value:unknown):Record<string,number>{
 const result:Record<string,number>={};
 if(!value||typeof value!=='object'||Array.isArray(value))return result;
 for(const key of fields[platform]){const n=(value as any)[key];if(Number.isSafeInteger(n)&&n>=0)result[key]=n;}
 return result;
}
export function metricDelta(previous:Item,current:Item){
 const before=interactionMetrics(previous.platform,previous.metadata.interactions??(previous.platform==='github'?{stars:previous.metadata.stars}:undefined));
 const after=interactionMetrics(current.platform,current.metadata.interactions??(current.platform==='github'?{stars:current.metadata.stars}:undefined));
 return fields[current.platform].filter(key=>Object.hasOwn(before,key)&&Object.hasOwn(after,key)&&before[key]!==after[key]).map(field=>({field,before:before[field],after:after[field]}));
}
