import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {Store} from '../src/store.ts';
import {analyzeArchived,archivedAnalysis} from '../src/archive-reading.ts';
import {materialPrompt,HostRunner} from '../src/runner.ts';
import {startOperator} from '../src/operator.ts';
import {topic,item,evidence} from './fixtures.ts';

const init=(s:Store)=>{s.saveTopic(topic);s.capture(item,[evidence,{...evidence,kind:'video-reading-manifest',text:'only a manifest'},{...evidence,kind:'browser-subtitle-observation:p1',text:'only a timeline'}]);};
const answer=(s:Store)=>({itemKey:item.key,selected:true,reason:'仅用于链路验证的模型夹具',readEvidenceIds:[s.currentEvidence(item.key).find(e=>e.kind==='readme')!.id!],limitations:['固定夹具，非真实模型'],agent:'test-runner'});
test('current按各自主题及材料有效性判定，不作为全局唯一标志',()=>{
 const s=new Store(':memory:');try{init(s);s.saveTopic({...topic,id:'other'});s.saveAssessment(topic.id,answer(s));s.saveAssessment('other',answer(s));let view=archivedAnalysis(s,item.key);assert.equal(view.assessments.filter(a=>a.current).length,2);assert.match(view.currentDefinition,/不是全局唯一/);s.saveTopic({...topic,name:'new'},1);view=archivedAnalysis(s,item.key);assert.equal(view.assessments.find(a=>a.topicId===topic.id)!.current,false);assert.equal(view.assessments.find(a=>a.topicId==='other')!.current,true);}finally{s.close();}
});
test('档案文本分析只提供正文，保存字符范围；相同输入复用而不再调用',async()=>{
 const s=new Store(':memory:');let calls=0;try{init(s);const runner={name:'test-runner',assess:async()=>{calls++;return answer(s);}};
 const r=await analyzeArchived({store:s,runner,topicId:topic.id,itemKey:item.key});assert.equal(r.assessment.reading?.materials.length,1);assert.equal(r.assessment.reading?.materials[0].providedCharacters,evidence.text.length);assert.equal(r.assessment.reading?.materials[0].cited,true);assert.equal(r.emailSent,false);assert.equal(s.deliveries().length,0);
 assert.equal((await analyzeArchived({store:s,runner,topicId:topic.id,itemKey:item.key})).reused,true);assert.equal(calls,1);assert.equal(archivedAnalysis(s,item.key).assessments[0].current,true);
 assert.equal(s.currentEvidence(item.key)[0].coverage.processed,0,'不可变采集记录不被模型判断覆盖');
 }finally{s.close();}
});
test('并发连接仅执行一次，材料变化和主题变化在提交前拒绝',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-archive-lock-'));const s=new Store(resolve(dir,'db.sqlite')),other=new Store(resolve(dir,'db.sqlite'));let release:any;try{init(s);const runner={name:'test-runner',assess:async()=>{await new Promise(r=>release=r);return answer(s);}};
 const first=analyzeArchived({store:s,runner,topicId:topic.id,itemKey:item.key});await assert.rejects(analyzeArchived({store:other,runner,topicId:topic.id,itemKey:item.key}),(e:any)=>e.code==='ANALYSIS_BUSY');other.capture({...item,version:'v2'},[evidence]);release();await assert.rejects(first,(e:any)=>e.code==='SOURCE_CHANGED');assert.equal(s.assessments(topic.id).length,0);
 const second=analyzeArchived({store:s,runner,topicId:topic.id,itemKey:item.key});other.saveTopic({...topic,name:'modified topic'},1);release();await assert.rejects(second,(e:any)=>e.code==='TOPIC_CHANGED');assert.equal(s.assessments(topic.id).length,0);
 }finally{other.close();s.close();rmSync(dir,{recursive:true,force:true});}
});
test('相同源指纹下的浏览器材料追加也使正在执行的判断失效',async()=>{
 const s=new Store(':memory:');try{const v={...item,platform:'bilibili' as const,key:'bilibili:BV0000000098',externalId:'BV0000000098'};s.saveTopic(topic);s.capture(v,[{...evidence,itemKey:v.key}]);const fingerprint=s.fingerprint(v.key);let release:any;
 const run=analyzeArchived({store:s,topicId:topic.id,itemKey:v.key,runner:{name:'test',assess:async()=>{await new Promise(r=>release=r);return {itemKey:v.key,selected:true,reason:'fixture',limitations:[],agent:'test',readEvidenceIds:[s.currentEvidence(v.key)[0].id!]};}}});
 s.appendBrowserObservation(v.key,fingerprint,[{...evidence,itemKey:v.key,kind:'browser-subtitle:p1'},{...evidence,itemKey:v.key,kind:'browser-subtitle-observation:p1'}]);assert.equal(s.fingerprint(v.key),fingerprint);release();await assert.rejects(run,(e:any)=>e.code==='SOURCE_CHANGED');assert.equal(s.assessments(topic.id).length,0);
 }finally{s.close();}
});
test('取消后即使执行器晚返回也不保存，不完整结果不重试',async()=>{
 const s=new Store(':memory:');try{init(s);let release:any;const controller=new AbortController();const running=analyzeArchived({store:s,topicId:topic.id,itemKey:item.key,signal:controller.signal,runner:{name:'test',assess:async()=>{await new Promise(r=>release=r);return answer(s);}}});controller.abort();release();await assert.rejects(running,(e:any)=>e.code==='CANCELLED');assert.equal(s.assessments(topic.id).length,0);
 let calls=0;await assert.rejects(analyzeArchived({store:s,topicId:topic.id,itemKey:item.key,runner:{name:'test',assess:async()=>{calls++;return {...answer(s),readEvidenceIds:['not-provided']};}}}),(e:any)=>e.code==='INVALID_AGENT_OUTPUT');assert.equal(calls,1);assert.equal(s.assessments(topic.id).length,0);
 }finally{s.close();}
});
test('空正文、图片/观察清单不能启动模型；正文预算仍然生效',async()=>{
 const s=new Store(':memory:');try{s.saveTopic(topic);s.capture(item,[{...evidence,kind:'image-manifest'}]);let called=false;await assert.rejects(analyzeArchived({store:s,topicId:topic.id,itemKey:item.key,runner:{name:'test',assess:async()=>{called=true;return answer(s);}}}),(e:any)=>e.code==='NO_READABLE_MATERIAL');assert.equal(called,false);
 const b=materialPrompt(topic,item,[{...evidence,id:'body',text:'x'.repeat(25000)},{...evidence,id:'manifest',kind:'browser-subtitle-observation:p1'}]);assert.equal(b.materials.length,1);assert.equal(b.materials[0].providedCharacters,24000);assert.equal(b.materials[0].truncated,true);
 }finally{s.close();}
});
test('本地同源HTTP分析归档→执行器→持久判断→只读查询，不开放跨站调用',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-archive-http-')),prev=process.env.THEME_RADAR_CONFIG;let server;try{
 const data=resolve(dir,'data'),config=resolve(dir,'config.json');writeFileSync(config,JSON.stringify({dataDir:data,topics:[topic],defaultAgent:'DSH',runners:{DSH:{command:process.execPath,prefixArgs:['-e',"let x='';process.stdin.on('data',c=>x+=c);process.stdin.on('end',()=>{const p=JSON.parse(x);console.log(JSON.stringify({itemKey:p.item.key,selected:true,reason:'HTTP链路夹具，非真实模型',readEvidenceIds:[p.materials[0].id],limitations:['测试夹具']}));});",'--']}}}));process.env.THEME_RADAR_CONFIG=config;const store=new Store(resolve(data,'radar.sqlite'));init(store);store.close();server=await startOperator(0);if(!server.listening)await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port,state=await(await fetch(base+'/api/state')).json() as any,body=JSON.stringify({topicId:topic.id,itemKey:item.key}),headers={'Content-Type':'application/json','X-Radar-Token':state.token};
 assert.equal((await fetch(base+'/api/archive/analyze',{method:'POST',headers:{...headers,Origin:'https://example.test'},body})).status,403);
 const r=await fetch(base+'/api/archive/analyze',{method:'POST',headers,body}),result=await r.json() as any;assert.equal(r.status,200,JSON.stringify(result));assert.equal(result.assessment.reading.materials.length,1);assert.equal(JSON.parse(readFileSync(resolve(data,'reports/agent-analysis-DSH.json'),'utf8')).ok,true);const view=await(await fetch(base+'/api/archive/analysis?key='+encodeURIComponent(item.key))).json() as any;assert.equal(view.assessments.length,1);assert.equal(view.assessments[0].current,true);assert.equal(view.emailSent,false);
 }finally{if(server)await new Promise<void>(r=>server.close(()=>r()));if(prev===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=prev;rmSync(dir,{recursive:true,force:true});}
});
