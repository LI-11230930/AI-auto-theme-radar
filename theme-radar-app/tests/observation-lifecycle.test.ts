import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {archivedAnalysis} from '../src/archive-reading.ts';
import {prepareReading,submitReading} from '../src/interactive-reading.ts';
import {topic,item,evidence} from './fixtures.ts';

const video={...item,key:'bilibili:BV0000000098',externalId:'BV0000000098',platform:'bilibili' as const};
const base={...evidence,itemKey:video.key,kind:'description',text:'same video metadata'};
const pair=(page=1,text='original subtitle')=>[{...base,kind:'browser-subtitle:p'+page,text},{...base,kind:'browser-subtitle-observation:p'+page,text:'timeline '+text}];
const init=()=>{const s=new Store(':memory:');s.saveTopic(topic);s.capture(video,[base]);s.appendBrowserObservation(video.key,s.fingerprint(video.key),pair());return s;};
const assessment=(s:Store)=>({itemKey:video.key,agent:'DSH',selected:false,reason:'synthetic observation lifecycle',readEvidenceIds:[s.currentEvidence(video.key).find(e=>e.kind==='browser-subtitle:p1')!.id!],limitations:['fixture'],simulation:true});

test('重复取得相同源材料保留浏览器字幕及阅读快照，不凭刷新制造旧判断失效',()=>{
 const s=init();try{const snapshot=s.readingSnapshot(video.key),ids=s.currentEvidence(video.key).map(e=>e.id);s.saveAssessment(topic.id,assessment(s));assert.equal(s.capture({...video,discoveredAt:new Date().toISOString()},[base]).change,'unchanged');assert.deepEqual(s.currentEvidence(video.key).map(e=>e.id),ids);assert.equal(s.readingSnapshot(video.key),snapshot);assert.equal(archivedAnalysis(s,video.key).assessments[0].current,true);assert.equal(s.events().length,2);}finally{s.close();}
});
test('相同分P新版替代旧正文与清单，历史保留，其它分P不受影响',()=>{
 const s=init();try{const old=s.currentEvidence(video.key).find(e=>e.kind==='browser-subtitle:p1')!.id!;s.appendBrowserObservation(video.key,s.fingerprint(video.key),pair(2,'page two'));const next=s.appendBrowserObservation(video.key,s.fingerprint(video.key),pair(1,'corrected transcript'));const current=s.currentEvidence(video.key);assert.equal(current.filter(e=>e.kind==='browser-subtitle:p1').length,1);assert.equal(current.find(e=>e.kind==='browser-subtitle:p1')!.text,'corrected transcript');assert.equal(current.find(e=>e.kind==='browser-subtitle:p2')!.text,'page two');assert.equal(current.some(e=>e.id===old),false);assert.equal(s.material(old)!.text,'original subtitle');assert.ok(next.supersededEvidenceIds.includes(old));assert.equal(s.search('original subtitle')[0].key,video.key);}finally{s.close();}
});
test('原来源实质变化后旧观察不能被输入metadata重新挂回当前材料',()=>{
 const s=init();try{const old=s.item(video.key),ids=s.currentEvidence(video.key).filter(e=>e.kind.startsWith('browser-subtitle')).map(e=>e.id);s.capture({...old,version:'changed'},[base]);assert.equal(s.currentEvidence(video.key).some(e=>ids.includes(e.id)),false);assert.ok(ids.every(id=>s.material(id!)!==null));assert.equal(s.item(video.key).metadata.browserObservationIds,undefined);}finally{s.close();}
});
test('重复导入幂等；内容回到旧版是新的发生，旧判断随材料版本切换',()=>{
 const s=init();try{const snapshot=s.readingSnapshot(video.key),id=s.currentEvidence(video.key).find(e=>e.kind==='browser-subtitle:p1')!.id!;s.saveAssessment(topic.id,{...assessment(s),reading:{snapshot,startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),scope:'archived_text_only',materials:[{id,kind:'browser-subtitle:p1',providedCharacters:17,totalCharacters:17,truncated:false,cited:true}]}});const events=s.events().length;assert.equal(s.appendBrowserObservation(video.key,s.fingerprint(video.key),pair()).duplicate,true);assert.equal(s.events().length,events);
 s.appendBrowserObservation(video.key,s.fingerprint(video.key),pair(1,'changed'));assert.equal(archivedAnalysis(s,video.key).assessments[0].current,false);s.appendBrowserObservation(video.key,s.fingerprint(video.key),pair());assert.equal(s.events().length,events+2);assert.equal(s.readingSnapshot(video.key),snapshot);assert.equal(archivedAnalysis(s,video.key).assessments[0].current,true);assert.equal(s.evidence(video.key).filter(e=>e.kind==='browser-subtitle:p1').length,2);}finally{s.close();}
});
test('不同分P、重复正文及反序清单不允许冒充成对观察',()=>{
 const s=init();try{const count=s.evidence(video.key).length;for(const invalid of [[pair()[0],pair(2)[1]],[pair()[0],pair()[0]],[pair()[1],pair()[0]]])assert.throws(()=>s.appendBrowserObservation(video.key,s.fingerprint(video.key),invalid),(e:any)=>e.code==='INVALID_EVIDENCE');assert.equal(s.evidence(video.key).length,count);}finally{s.close();}
});
test('刷新未变化来源时交互结果仍能提交；新版字幕取代时旧提交被拒绝',()=>{
 const s=init();try{const p=prepareReading(s,{topicId:topic.id,itemKey:video.key,agent:'WorkBuddy'});s.capture(video,[base]);const result=submitReading(s,{jobId:p.jobId!,token:p.token!,assessment:assessment(s)});assert.equal(result.assessment.agent,'WorkBuddy');s.appendBrowserObservation(video.key,s.fingerprint(video.key),pair(1,'second'));const q=prepareReading(s,{topicId:topic.id,itemKey:video.key,agent:'TRAE'});s.appendBrowserObservation(video.key,s.fingerprint(video.key),pair(1,'third'));assert.throws(()=>submitReading(s,{jobId:q.jobId!,token:q.token!,assessment:assessment(s)}),(e:any)=>e.code==='SOURCE_CHANGED');assert.equal(s.assessments(topic.id).length,1);}finally{s.close();}
});
