import type {Store} from './store.ts';
import {archivedAnalysis} from './archive-reading.ts';
import {RadarError,requireText} from './model.ts';

/** Acquisition evidence is immutable. Reading claims are derived separately. */
export function materialView(store:Store,id:string){
 const material=store.material(requireText(id,'材料ID',200));if(!material)throw new RadarError('NOT_FOUND','材料不存在');
 const claims=archivedAnalysis(store,material.itemKey).assessments.filter(a=>a.readEvidenceIds.includes(id)).map(a=>{
   const provided=a.reading?.materials.find(m=>m.id===id);
   return {agent:a.agent,topicId:a.topicId,createdAt:a.createdAt,current:a.current,simulation:a.simulation===true,cited:true,providedCharacters:provided?.providedCharacters??null,totalCharacters:material.text.length,truncated:provided?.truncated??null,scope:provided?'recorded_prompt_and_agent_citation':'legacy_agent_citation_without_character_trace',evidenceSource:'agent_report'};
 });
 return {...material,characters:material.text.length,reading:{acquisitionSnapshotUnchanged:true,currentNonSimulatedClaims:claims.filter(c=>c.current&&!c.simulation),history:claims,scope:'采集coverage保留取得时的快照；后续模型提供字符与引用在此单列，引用不等于平台原始整轨或音视频理解'}};
}
