import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../src/store.ts';import {loadConfig} from '../src/config.ts';import {liveProbe} from '../src/service.ts';import {GitHubSource} from '../src/github.ts';import {BilibiliSource} from '../src/bilibili.ts';import {RadarError} from '../src/model.ts';import {topic,item,evidence} from './fixtures.ts';
function setup(t:any){const root=mkdtempSync(join(tmpdir(),'radar-topic-probe-')),path=join(root,'config.json');writeFileSync(path,JSON.stringify({dataDir:root,topics:[],xiaohongshu:{enabled:false}}));const config=loadConfig(path),store=new Store(':memory:');t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {config,store};}
test('无订阅或全部停用时，联网自检不访问平台且不播种开发者样本',async t=>{
 const {config,store}=setup(t),original=GitHubSource.prototype.trending,search=BilibiliSource.prototype.search;let calls=0;GitHubSource.prototype.trending=async()=>{calls++;throw Error('must not request');};BilibiliSource.prototype.search=async()=>{calls++;throw Error('must not request');};
 try{for(const saved of [false,true]){if(saved)store.saveTopic({...topic,enabled:false});const report=await liveProbe(config,store);assert.ok(report.results.every(r=>r.skipped));assert.equal(store.stats().items,0);}assert.equal(calls,0);}finally{GitHubSource.prototype.trending=original;BilibiliSource.prototype.search=search;}
});
test('GitHub自检从使用者配置仓库读取一个样本，不默认读取参考项目',async t=>{
 const {config,store}=setup(t),oldTrending=GitHubSource.prototype.trending,oldRead=GitHubSource.prototype.read,oldSearch=GitHubSource.prototype.search;store.saveTopic({...topic,platforms:['github'],repositories:['custom/choice']});let readRepo='';
 GitHubSource.prototype.trending=async()=>({rows:[],html:'fixture',collectedAt:new Date().toISOString()});GitHubSource.prototype.search=async()=>{throw Error('explicit repo should not search');};GitHubSource.prototype.read=async repo=>{readRepo=repo;return {item:{...item,key:'github:'+repo,externalId:repo},evidence:[{...evidence,itemKey:'github:'+repo}],warnings:[]};};
 try{const report=await liveProbe(config,store);assert.equal(readRepo,'custom/choice');assert.equal(report.results.find(r=>r.id==='github-read').ok,true);assert.equal(store.stats().items,1);assert.equal(report.results.find(r=>r.id==='bilibili-search').skipped,true);}finally{GitHubSource.prototype.trending=oldTrending;GitHubSource.prototype.read=oldRead;GitHubSource.prototype.search=oldSearch;}
});
test('B站自检使用自定义关键词和UID，未订阅的平台保持跳过',async t=>{
 const {config,store}=setup(t),search=BilibiliSource.prototype.search;store.saveTopic({...topic,keywords:['my-interest'],platforms:['bilibili'],bilibiliAuthors:['123']});let actual:any;
 BilibiliSource.prototype.search=async(...args)=>{actual=args;return [];};try{const report=await liveProbe(config,store);assert.deepEqual(actual,['my-interest',2,{authorUid:'123'}]);assert.equal(report.results.find(r=>r.id==='github-read').skipped,true);}finally{BilibiliSource.prototype.search=search;}
});
test('GitHub采集限流后停止该平台后续读取，不以其他仓库绕过',async t=>{
 const {config,store}=setup(t),trending=GitHubSource.prototype.trending,read=GitHubSource.prototype.read;store.saveTopic({...topic,platforms:['github'],repositories:['custom/choice']});let reads=0;
 GitHubSource.prototype.trending=async()=>{throw new RadarError('RATE_LIMITED','bounded fixture failure');};GitHubSource.prototype.read=async()=>{reads++;throw Error('must not read');};
 try{const report=await liveProbe(config,store);assert.equal(report.results.find(r=>r.id==='github-read').reason,'upstream_blocked');assert.equal(reads,0);}finally{GitHubSource.prototype.trending=trending;GitHubSource.prototype.read=read;}
});
