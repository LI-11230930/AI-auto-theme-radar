import {hash,normalizeText} from './model.ts';import type {Item,Evidence} from './model.ts';
export const audienceMaterial=(kind:string)=>/^danmaku(?::p[1-9]\d*)?$/.test(kind);
export function contentFingerprint(item:Item,evidence:Evidence[]){
 return hash(normalizeText(JSON.stringify({title:item.title,version:item.version,materials:evidence.filter(e=>item.platform!=='bilibili'||!audienceMaterial(e.kind)).map(e=>{
  let text=e.text;if(e.kind==='repository-metadata'){try{const meta=JSON.parse(text);for(const key of ['pushed_at','updated_at','created_at','stargazers_count','forks_count','watchers_count'])delete meta[key];text=JSON.stringify(meta);}catch{}}
  return {kind:e.kind,text:normalizeText(text)};
 }).sort((a,b)=>a.kind.localeCompare(b.kind)||a.text.localeCompare(b.text))})));
}
export function audienceFingerprint(evidence:Evidence[]){const rows=evidence.filter(e=>audienceMaterial(e.kind)).map(e=>({kind:e.kind,hash:hash(e.text)})).sort((a,b)=>a.kind.localeCompare(b.kind)||a.hash.localeCompare(b.hash));return rows.length?hash(JSON.stringify(rows)):null;}
