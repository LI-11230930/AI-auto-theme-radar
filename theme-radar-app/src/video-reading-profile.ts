import {isVideoTextKind,readableEvidence,RadarError} from './model.ts';
import type {Topic,Item,Evidence} from './model.ts';

export function videoReadingProfile(topic:Topic){
 const extended=topic.videoReading==='extended';
 return {mode:extended?'extended':'standard',maxPages:extended?3:1,charactersPerPage:extended?15000:5000,segmentCharacters:5000,fallbackPages:[1]};
}
export function videoPage(kind:string){if(kind==='subtitle')return 1;return isVideoTextKind(kind)?Number(kind.match(/:p(\d+)$/)![1]):null;}
export function profilePages(topic:Topic,item?:Item|null){
 const limit=videoReadingProfile(topic).maxPages,count=item?.metadata.pageCount;
 return Array.from({length:Number.isSafeInteger(count)&&Number(count)>0?Math.min(Number(count),limit):limit},(_,i)=>i+1);
}
export function profileVideoEvidence(topic:Topic,item:Item|null,evidence:Evidence[]){
 const wanted=new Set(profilePages(topic,item));return evidence.filter(e=>wanted.has(videoPage(e.kind)!)&&readableEvidence(e));
}
/** An old P1 cache cannot silently satisfy a request for the first three parts. */
export function profileCacheReady(topic:Topic,item:Item|null,evidence:Evidence[]){
 if(!item)return false;if(videoReadingProfile(topic).mode==='standard')return true;
 const count=item.metadata.pageCount,requested=item.metadata.requestedPages,states=item.metadata.subtitlePages;
 if(!Number.isSafeInteger(count)||Number(count)<1||!Array.isArray(requested))return false;
 return profilePages(topic,item).every(page=>requested.includes(page)&&(
  evidence.some(e=>videoPage(e.kind)===page&&readableEvidence(e)&&!!e.text.trim())||
  Array.isArray(states)&&states.some(p=>p?.page===page&&(p.state==='empty'||p.state==='unavailable'&&p.reason==='no_track_exposed'))
 ));
}
/** Contiguous prefix ranges; never split a UTF-16 surrogate pair between segments. */
export function textSegments(text:string,size=5000){
 if(!Number.isSafeInteger(size)||size<2||size>15000)throw new RadarError('INVALID_BUDGET','文本分段预算需要2至15000字符');
 const parts:{from:number;to:number;text:string}[]=[];
 for(let from=0;from<text.length;){let to=Math.min(from+size,text.length);
  if(to<text.length&&/[\uD800-\uDBFF]/.test(text[to-1])&&/[\uDC00-\uDFFF]/.test(text[to]))to--;
  if(to<=from)to=Math.min(from+2,text.length);
  parts.push({from,to,text:text.slice(from,to)});from=to;
 }return parts;
}
