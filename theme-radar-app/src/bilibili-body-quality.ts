import {isVideoTextKind,readableEvidence} from './model.ts';
import type {Evidence,Assessment} from './model.ts';

// A conservative selection floor, not an ASR accuracy score or proof of meaning.
export const minimumVideoBodyCharacters=80;
export function videoBodyQuality(evidence:Evidence[],assessment?:Assessment,page?:number){
 const texts=new Set<string>();
 for(const e of evidence){
  if(!isVideoTextKind(e.kind,page)||!readableEvidence(e))continue;
  let text=e.text;
  if(assessment){
   if(!e.id||!assessment.readEvidenceIds.includes(e.id))continue;
   const trace=assessment.reading?.materials.find(m=>m.id===e.id&&m.kind===e.kind&&m.cited);
   if(!trace||!Number.isSafeInteger(trace.providedCharacters)||trace.providedCharacters<=0)continue;
   text=text.slice(0,trace.providedCharacters);
  }
  const normalized=text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'');
  if(normalized)texts.add(normalized);
 }
 const characters=[...texts].reduce((sum,text)=>sum+Array.from(text).length,0);
 return {sufficient:characters>=minimumVideoBodyCharacters,characters,minimumCharacters:minimumVideoBodyCharacters,reason:characters>=minimumVideoBodyCharacters?null:'INSUFFICIENT_VIDEO_BODY'};
}
