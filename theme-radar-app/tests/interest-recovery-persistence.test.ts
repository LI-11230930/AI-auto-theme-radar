import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../src/store.ts';import {runInterestRound} from '../src/interest-round.ts';import {RadarError,hash} from '../src/model.ts';import {topic,item,evidence,videoBody} from './fixtures.ts';

test('自动下一实际SQLite重开保留恢复冷却，正文取得后清除待恢复且不发送',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'radar-recovery-file-')),file=join(dir,'radar.sqlite');let store=new Store(file);
 const interest={...topic,platforms:['bilibili' as const],bilibiliDiscovery:'interests' as const,bilibiliAuthors:[]},bvid='BV1234567890',key='bilibili:'+bvid,id='video-recovery:'+hash(topic.id+':'+bvid);let reads=0,analyses=0,networkFailure=true;
 const source={recommendations:async()=>({authenticated:true,items:[{bvid,title:'Agent 自动化工具',authorId:'123'}]}),search:async()=>[],read:async()=>{reads++;if(networkFailure)throw new RadarError('CONNECTION_REFUSED','isolated fixture');return {item:{...item,platform:'bilibili' as const,key,externalId:bvid,url:'https://www.bilibili.com/video/'+bvid,metadata:{}},evidence:[{...evidence,itemKey:key,kind:'subtitle:p1',text:videoBody.repeat(2)}],warnings:[]};}};
 const run=()=>runInterestRound({store,dataDir:dir,topicId:topic.id,source,recoverUnread:true,readLimit:1,analyze:async()=>{analyses++;const materials=store.currentEvidence(key);assert.ok(materials.some(e=>e.kind==='subtitle:p1'&&e.text===videoBody.repeat(2)));return {assessment:{selected:false,simulation:false,readEvidenceIds:materials.map(e=>e.id)}};}});
 try{store.saveTopic(interest);const failed=await run();assert.equal(failed.counts.failed,1);assert.equal(reads,1);assert.equal(analyses,0);const pending=store.job(id);assert.equal(pending!.state,'pending');
  store.close();store=new Store(file);assert.deepEqual(store.job(id),pending);networkFailure=false;const held=await run();assert.equal(held.counts.attempted,0);assert.equal(reads,1);assert.equal(analyses,0);assert.deepEqual(store.job(id),pending);
  const ready=JSON.parse(String(pending!.data));ready.nextAt=new Date(Date.now()-60000).toISOString();store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(ready),id);
  const recovered=await run();assert.equal(recovered.results[0].source,'recovery');assert.equal(recovered.counts.assessed,1);assert.equal(recovered.counts.selected,0);assert.equal(reads,2);assert.equal(analyses,1);assert.equal(store.job(id)!.state,'done');assert.equal(store.stats().deliveries,0);
  store.close();store=new Store(file);assert.equal(store.job(id)!.state,'done');assert.equal(store.stats().deliveries,0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
