import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {resolve} from 'node:path';
import {Store} from '../src/store.ts';import {startOperator} from '../src/operator.ts';import {topic,item,evidence} from './fixtures.ts';
test('真实HTTP保存目标后正向反馈只预览、明确应用和撤销；保护版本与零副作用',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'radar-goal-http-')),prior=process.env.THEME_RADAR_CONFIG,file=resolve(root,'config.json');
 writeFileSync(file,JSON.stringify({dataDir:resolve(root,'data'),topics:[]}));process.env.THEME_RADAR_CONFIG=file;
 const s=new Store(resolve(root,'data/radar.sqlite'));s.saveTopic(topic);s.capture(item,[evidence]);s.close();const server=await startOperator(0),base='http://127.0.0.1:'+(server.address() as any).port;
 try{
  const state=await(await fetch(base+'/api/state')).json() as any;
  const post=async(path:string,body:any)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':state.token},body:JSON.stringify(body)});
  const next={...topic,goal:{objective:'构建本地资料整理插件',implementationFirst:true},preferred:['本地优先']};
  assert.equal((await post('/api/topics',{topic:next,expectedRevision:1})).status,200);
  assert.equal((await post('/api/topics',{topic:next,expectedRevision:1})).status,400);
  const feedback={itemKey:item.key,topicId:topic.id,kind:'useful',rule:'失败恢复'};
  assert.equal((await fetch(base+'/api/feedback/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(feedback)})).status,403);
  const f=await(await post('/api/feedback/preview',feedback)).json() as any;
  assert.equal(f.ruleTarget,'preferred');assert.deepEqual(f.before,['本地优先']);assert.deepEqual(f.after,['本地优先','失败恢复']);
  let view=await(await fetch(base+'/api/state')).json() as any;assert.deepEqual(view.topics[0].preferred,['本地优先']);
  assert.equal((await post('/api/feedback/apply',{id:f.id,revision:1})).status,400);
  assert.equal((await post('/api/feedback/apply',{id:f.id,revision:2})).status,200);
  view=await(await fetch(base+'/api/state')).json() as any;assert.equal(view.topics[0].revision,3);assert.deepEqual(view.topics[0].preferred,['本地优先','失败恢复']);
  assert.deepEqual(view.topics[0].goal,next.goal);
  assert.equal((await post('/api/feedback/revert',{id:f.id})).status,200);
  view=await(await fetch(base+'/api/state')).json() as any;assert.equal(view.topics[0].revision,4);assert.deepEqual(view.topics[0].preferred,['本地优先']);
  assert.equal(view.stats.assessments,0);assert.equal(view.stats.deliveries,0);assert.equal(view.stats.jobs,0);
  for(const asset of ['workbench.js','topics.js','library.js'])assert.equal((await fetch(base+'/assets/'+asset)).status,200);
 }finally{await new Promise<void>(done=>server.close(()=>done()));if(prior===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=prior;rmSync(root,{recursive:true,force:true});}
});
