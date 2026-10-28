import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {resolve} from 'node:path';
import {startOperator} from '../src/operator.ts';import {topic} from './fixtures.ts';
test('真实HTTP保存阅读深度只修改主题，错误深度与过期版本拒绝，不启动采集或投递',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-depth-http-')),file=resolve(dir,'config.json'),prior=process.env.THEME_RADAR_CONFIG;
 writeFileSync(file,JSON.stringify({dataDir:resolve(dir,'data'),topics:[topic]}));process.env.THEME_RADAR_CONFIG=file;const server=await startOperator(0),base='http://127.0.0.1:'+(server.address() as any).port;
 try{
  const before=await(await fetch(base+'/api/state')).json() as any;
  const post=async(value:any,expectedRevision=1)=>fetch(base+'/api/topics',{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':before.token},body:JSON.stringify({topic:{...topic,videoReading:value},expectedRevision})});
  assert.equal((await post('unlimited')).status,400);assert.equal((await post('extended')).status,200);assert.equal((await post('standard')).status,400);
  const saved=await(await fetch(base+'/api/state')).json() as any;assert.equal(saved.topics[0].videoReading,'extended');assert.equal(saved.topics[0].revision,2);
  assert.equal(saved.stats.jobs,0);assert.equal(saved.stats.deliveries,0);assert.equal(saved.stats.items,0);assert.equal(saved.stats.assessments,0);
  const js=await(await fetch(base+'/assets/workbench.js')).text();assert.match(js,/quick-topic-video-reading/);assert.match(js,/topic\.videoReading/);
 }finally{await new Promise<void>(done=>server.close(()=>done()));if(prior===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=prior;rmSync(dir,{recursive:true,force:true});}
});
