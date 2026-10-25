import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.ts';
import {startOperator} from '../src/operator.ts';
import {importAuthorObservation} from '../src/author-observation.ts';
import {item,evidence,topic} from './fixtures.ts';

test('完整operator创建/撤销走原CSRF门槛，扩展令牌只导入冻结条目',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-batch-operator-')),dataDir=resolve(dir,'data'),previous=process.env.THEME_RADAR_CONFIG;mkdirSync(dataDir);let server;
 const bvid='BV1234567890',key='bilibili:'+bvid,t={...topic,id:'operator-bili',platforms:['bilibili'],bilibiliAuthors:['123']},origin='chrome-extension://'+'a'.repeat(32);
 try{
  const seed=new Store(resolve(dataDir,'radar.sqlite'));seed.saveTopic(t as any);importAuthorObservation(seed,dataDir,t.id,{schema:'theme-radar-visible-author-v1',pageUrl:'https://space.bilibili.com/123/upload/video',authorUid:'123',observedAt:new Date().toISOString(),items:[{bvid,url:'https://www.bilibili.com/video/'+bvid,title:'合成批次'}],truncated:false});const v={...item,key,externalId:bvid,platform:'bilibili' as const,authorId:'123',url:'https://www.bilibili.com/video/'+bvid,metadata:{subtitlePages:[{page:1,cid:'1',duration:20}]}};seed.capture(v,[{...evidence,itemKey:key,kind:'description'}]);seed.close();
  const config=resolve(dir,'config.json');writeFileSync(config,JSON.stringify({dataDir,topics:[]}));process.env.THEME_RADAR_CONFIG=config;server=await startOperator(0);if(!server.listening)await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port,state=await(await fetch(base+'/api/state')).json() as any;
  const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.match(await(await fetch(base+'/')).text(),/id="browser-batch"/);assert.match(await(await fetch(base+'/assets/browser-batch.js')).text(),/一次性配对码/);
  for(const headers of [{},{Origin:origin,'X-Radar-Token':state.token},{Origin:'https://www.bilibili.com','X-Radar-Token':state.token}])assert.equal((await post('/api/browser-batch/create',{topicId:t.id,itemKeys:[key]},headers)).status,403);
  const grant=await(await post('/api/browser-batch/create',{topicId:t.id,itemKeys:[key]},{'X-Radar-Token':state.token})).json() as any;assert.ok(grant.pairCode);const status=await(await fetch(base+'/api/browser-batch/status')).text();assert.ok(!status.includes(grant.pairCode));
  const p=await(await post('/bridge/browser-batch/pair',{pairCode:grant.pairCode},{Origin:origin})).json() as any;assert.ok(p.token);assert.notEqual(p.token,state.token);
  const headers={Origin:origin,Authorization:'Bearer '+p.token};assert.equal((await post('/api/browser-batch/cancel',{batchId:grant.batchId},headers)).status,403);assert.equal((await post('/api/topics',{topic:t},headers)).status,403);
  const snapshot={schema:'theme-radar-visible-subtitles-v1',bvid,page:1,duration:20,startedAt:grant.createdAt,endedAt:new Date().toISOString(),observedFrom:0,observedTo:20,segments:[{from:1,to:10,text:'完整HTTP隔离字幕'}],truncated:false,captureStatus:'ended'};
  const imported=await post('/bridge/browser-batch/capture',{itemKey:key,snapshot},headers);assert.equal(imported.status,200);assert.equal((await imported.json() as any).result.emailSent,false);
  assert.equal((await post('/api/browser-batch/cancel',{batchId:grant.batchId},{'X-Radar-Token':state.token})).status,200);assert.equal((await post('/bridge/browser-batch/manifest',{},headers)).status,401);
  const final=await(await fetch(base+'/api/state')).json() as any;assert.equal(final.stats.assessments,0);assert.equal(final.stats.deliveries,0);
 }finally{if(server)await new Promise<void>(r=>server.close(()=>r()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;rmSync(dir,{recursive:true,force:true});}
});
