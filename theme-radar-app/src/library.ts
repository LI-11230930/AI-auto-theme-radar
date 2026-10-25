import type {Store} from './store.ts';
import {normalizeText,repoReferences,RadarError,readableEvidence} from './model.ts';

function contains(text:string,term:string){
  const needle=normalizeText(term).toLowerCase();
  if(/^[a-z0-9_ -]+$/i.test(needle)){
    const escaped=needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp('(?:^|[^a-z0-9_])'+escaped+'(?=$|[^a-z0-9_])','i').test(text);
  }
  return text.includes(needle);
}
/** Read-only view over current local materials. This is keyword/link evidence,
 * not a model judgment, and never deletes or merges source records. */
export function libraryView(store:Store,options:{topicId?:string;limit?:number}={}){
  const limit=options.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new RadarError('INVALID_BUDGET','聚合最多扫描100条本地档案');
  const topics=store.topics().filter(t=>t.enabled&&(!options.topicId||t.id===options.topicId));
  if(options.topicId&&!topics.length)throw new RadarError('TOPIC_REQUIRED','启用的主题不存在');
  const items=store.search('',{limit}),groups=new Map<string,any>(),topicRows=topics.map(topic=>({id:topic.id,name:topic.name,revision:topic.revision,items:[] as any[]}));
  for(const item of items){
    const materials=store.currentEvidence(item.key).filter(readableEvidence),text=normalizeText([item.title,...materials.map(e=>e.text)].join('\n')).toLowerCase();
    const refs=new Set(repoReferences([item.url,...materials.map(e=>e.text)].join('\n')));if(item.platform==='github')refs.add(item.externalId.toLowerCase());
    const member={key:item.key,title:item.title,platform:item.platform,url:item.url,authorId:item.authorId,currentMaterials:materials.length,legacyScope:!Array.isArray(item.metadata.currentEvidenceIds)};
    for(const repo of refs){const group=groups.get(repo)||{id:'github:'+repo,repo,basis:'explicit_repository_link',confidence:'deterministic_reference',members:[]};group.members.push(member);groups.set(repo,group);}
    for(const [index,topic] of topics.entries()){
      if(!topic.platforms.includes(item.platform))continue;
      const matched=topic.keywords.filter(term=>contains(text,term)),excluded=topic.exclude.filter(term=>contains(text,term));if(!matched.length&&!excluded.length)continue;
      const assessment=store.assessments(topic.id).find(a=>a.itemKey===item.key&&a.topicRevision===topic.revision&&a.itemFingerprint===store.fingerprint(item.key)&&(!a.reading||a.reading.snapshot===store.readingSnapshot(item.key)));
      topicRows[index].items.push({...member,matched,excluded,candidate:matched.length>0&&!excluded.length,assessment:assessment?{selected:assessment.selected,reason:assessment.reason,agent:assessment.agent}:null});
    }
  }
  return {scope:'current local materials, bounded latest archive subset; keyword matches are not AI selections',scanned:items.length,limit,mayHaveMore:items.length===limit,groups:[...groups.values()].filter(g=>g.members.length>1),topics:topicRows,sourceRecordsPreserved:true};
}
