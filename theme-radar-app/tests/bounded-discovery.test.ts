import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {Store} from '../src/store.ts';
import {GitHubSource} from '../src/github.ts';
import {runGithub} from '../src/engine.ts';
import {FixtureRunner} from '../src/runner.ts';
import {batchAt} from '../src/time.ts';
import {validateMailTemplate} from '../src/mail-template.ts';
import {topic,mockFetch} from './fixtures.ts';
import {RadarError} from '../src/model.ts';
const batch=batchAt('2026-10-19','09:00'),template=validateMailTemplate({github:{sections:['projects']}});
async function setup(fn:(store:Store,source:GitHubSource,options:any,runner:any)=>Promise<void>){
 const folder=mkdtempSync(resolve(tmpdir(),'radar-bounded-')),store=new Store(':memory:');try{
  store.saveTopic(topic);const source=new GitHubSource(async url=>url.endsWith('/repos/sample/tool')?Response.json({full_name:'sample/tool',owner:{id:123,login:'sample'},description:'Agent demo',private:false,created_at:'2026-10-18T00:00:00Z',pushed_at:'2026-10-18T01:00:00Z'}):mockFetch(url));
  const fixture=new FixtureRunner(),runner={name:'Codex',assess:async(...args:any[])=>({...await fixture.assess(...args as [any,any,any]),agent:'Codex',simulation:false})};
  await fn(store,source,{store,source,runner,topicId:'*',batch,outputDir:folder,recipient:'reader@example.com',mailTemplate:template,limit:1},runner);
 }finally{store.close();rmSync(folder,{recursive:true,force:true});}
}
test('有界阅读可汇总部分发现的有效材料，但真实投递后仍不推进不完整发现窗口',async()=>setup(async(store,source,options)=>{
 const search=source.search.bind(source);source.search=async(...args)=>({...await search(...args),incomplete:true});
 const result=await runGithub({...options,allowPartialDiscovery:true});assert.equal(result.state,'prepared');assert.equal(result.selected,1);assert.deepEqual(result.blockingIssues,[]);assert.equal(result.collectionWindows![0].completed,false);assert.equal(result.collectionWindows![0].processingCompleted,true);assert.equal(result.collectionWindows![0].discoveryIncomplete,true);
 const delivery=store.delivery(result.deliveryId!);store.beginDelivery(delivery.id);store.transitionDelivery(delivery.id,'submitted');store.transitionDelivery(delivery.id,'sent_confirmed');assert.equal(store.lastConfirmedWindow(topic.id,1,'reader@example.com'),null);
 assert.ok(result.warnings!.some(s=>s.includes('不推进覆盖窗口')));
}));
test('传统完整发现模式保持严格，不因新统一流程改动而偷偷放行',async()=>setup(async(store,source,options)=>{
 const search=source.search.bind(source);source.search=async(...args)=>({...await search(...args),incomplete:true});const result=await runGithub(options);assert.equal(result.state,'needs_validation');assert.equal(store.stats().deliveries,0);assert.ok(result.blockingIssues.some(s=>s.includes('topic_processing_incomplete')));
}));
test('允许部分发现仍不能用元数据代替缺失README，也不能吞掉搜索鉴权错误',async()=>setup(async(store,source,options)=>{
 const read=source.read.bind(source),search=source.search.bind(source);source.search=async(...args)=>({...await search(...args),incomplete:true});source.read=async(...args)=>{const r=await read(...args);return {...r,evidence:r.evidence.filter(e=>e.kind!=='readme')};};
 const result=await runGithub({...options,allowPartialDiscovery:true});assert.equal(result.state,'needs_validation');assert.equal(store.stats().deliveries,0);
}));
test('不完整搜索和正文模型失败同时发生时，不能把模型失败降级为发现提示',async()=>setup(async(store,source,options)=>{
 const search=source.search.bind(source);source.search=async(...args)=>({...await search(...args),incomplete:true});const result=await runGithub({...options,allowPartialDiscovery:true,runner:{name:'Codex',assess:async()=>{throw Error('model failure');}}});assert.equal(result.state,'needs_validation');assert.ok(result.blockingIssues.includes('model_result_incomplete'));assert.equal(store.stats().deliveries,0);
}));
test('搜索鉴权失败仍阻止冻结，不能把请求失败当成有效的部分发现',async()=>setup(async(store,source,options)=>{
 source.search=async()=>{throw new RadarError('AUTH_REQUIRED','fixture authentication required');};const result=await runGithub({...options,allowPartialDiscovery:true});assert.equal(result.state,'needs_validation');assert.equal(store.stats().deliveries,0);assert.ok(result.blockingIssues.some(s=>s.startsWith('topic_processing_incomplete:')));
}));
test('已读快照和主题及宿主一致时跨轮复用判断，材料变化后必须重新判断',async()=>setup(async(store,source,options,runner)=>{
 let calls=0;const assess=runner.assess;runner.assess=async(...args:any[])=>{calls++;return assess(...args);};
 const first=await runGithub({...options,freezeDelivery:false,allowPartialDiscovery:true});assert.equal(first.state,'prepared');assert.equal(calls,1);
 const second=await runGithub({...options,freezeDelivery:false,allowPartialDiscovery:true,batch:{...batch,key:batch.key+':second'}});assert.equal(second.state,'prepared');assert.equal(calls,1);assert.equal(second.counts!.reusedAssessments,1);assert.equal(second.counts!.newAssessments,0);
 const read=source.read.bind(source);source.read=async(...args)=>{const r=await read(...args);return {...r,evidence:r.evidence.map(e=>e.kind==='readme'?{...e,text:e.text+' 实质新增功能'}:e)};};
 const third=await runGithub({...options,freezeDelivery:false,allowPartialDiscovery:true,batch:{...batch,key:batch.key+':third'}});assert.equal(third.state,'prepared');assert.equal(calls,2);assert.equal(third.counts!.newAssessments,1);
}));
test('源码抽样缺失或许可证截断只保留提示，不能单独阻止有正文及有效判断的邮件',async()=>setup(async(store,source,options)=>{
 const read=source.read.bind(source);source.read=async(...args)=>{const r=await read(...args);return {...r,warnings:['源码抽样未找到普通文件','许可证材料已截断']};};const result=await runGithub({...options,allowPartialDiscovery:true});assert.equal(result.state,'prepared');assert.equal(result.warnings!.filter(s=>s.includes('抽样')||s.includes('许可证')).length,2);assert.deepEqual(result.blockingIssues,[]);
}));
