import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverTopic} from '../src/discovery.ts';
import {Store} from '../src/store.ts';
import {RadarError,validateTopic} from '../src/model.ts';
import {capabilityReport} from '../src/service.ts';
import {topic,item,evidence} from './fixtures.ts';

const github:any={search:async()=>({items:Array.from({length:20},(_,i)=>({repo:'owner/r'+i,url:'https://github.com/owner/r'+i,description:'repo',createdAt:null,pushedAt:null})),incomplete:false})};
test('跨平台发现共享20条预算，保留平台/日期未知和未筛选声明',async()=>{
 let calls=0;const bilibili:any={search:async()=>{calls++;return Array.from({length:20},(_,i)=>({bvid:'BV'+String(i).padStart(10,'0'),title:'video'+i,authorId:'123',publishedAt:null}));}};
 const r=await discoverTopic({...topic,keywords:['a','b','c','d']},{github,bilibili,xiaohongshuEnabled:false});assert.equal(r.candidates.length,20);assert.equal(r.candidates.filter(c=>c.platform==='github').length,10);assert.equal(calls,3);assert.equal(r.sources.find(s=>s.platform==='bilibili').omittedQueries,1);assert.equal(r.sources.find(s=>s.platform==='xiaohongshu').code,'CAPABILITY_PAUSED');assert.equal(r.exhaustive,false);assert.equal(r.sourcesSucceeded,false);assert.equal(r.modelRun,false);assert.equal(r.emailSent,false);assert.ok(r.candidates.every(c=>!c.modelSelected&&c.materialState==='not_read'&&c.publishedAt===null));
});
test('UID串唯一绑定，有限关键词过滤不冒充作者全量；后续失败保留已有候选',async()=>{
 let calls=0;const bilibili:any={search:async(_k,_l,o)=>{assert.equal(o.authorUid,'123');if(++calls===2)throw new RadarError('ACCESS_DENIED','来源访问受限');return [{bvid:'BV1234567890',title:'allowed',authorId:'123',publishedAt:null}];}};
 const r=await discoverTopic({...topic,platforms:['bilibili'],keywords:['one','two','three'],bilibiliAuthors:['123']},{github,bilibili,xiaohongshuEnabled:false});assert.equal(calls,2);assert.equal(r.candidates.length,1);assert.equal(r.sources[0].state,'partial');assert.equal(r.sources[0].failures[0].code,'ACCESS_DENIED');assert.match(r.sources[0].scope,/不等于UP主完整投稿/);
 for(const authors of [['昵称'],['001'],['123','123'],[123],Array.from({length:6},(_,i)=>String(i+1))])assert.throws(()=>validateTopic({...topic,bilibiliAuthors:authors as any}));assert.doesNotThrow(()=>validateTopic({...topic,bilibiliAuthors:['123']}));
});
test('重复/排除项不进入候选，未知异常不回显上游内容，单平台失败不会伪装完整',async()=>{
 const bilibili:any={search:async()=>[{bvid:'BV1234567890',title:'广告',authorId:'1'},{bvid:'BV1234567891',title:'normal',authorId:'1'},{bvid:'BV1234567891',title:'normal',authorId:'1'}]};
 const r=await discoverTopic({...topic,keywords:['a'],exclude:['广告']},{github:{search:async()=>{throw Error('FAKE_SECRET');}},bilibili,xiaohongshuEnabled:false} as any);assert.equal(r.candidates.length,1);assert.equal(r.excluded,1);assert.equal(r.sourcesSucceeded,false);assert.ok(!JSON.stringify(r).includes('FAKE_SECRET'));assert.equal(r.otherCommentsRead,0);
});
test('能力自检从当前档案与真实分析记录读取，历史探测不覆盖新字幕证据',()=>{
 const s=new Store(':memory:');try{const video={...item,key:'bilibili:BV0000000098',platform:'bilibili' as const,externalId:'BV0000000098'};s.saveTopic(topic);s.capture(video,[{...evidence,itemKey:video.key,kind:'browser-subtitle:p1'}]);const e=s.currentEvidence(video.key)[0],snapshot=s.readingSnapshot(video.key);const c:any={dataDir:'nonexistent-fixture-path',runtimeEnabled:false,recipient:'fixture',timezone:'Asia/Shanghai',sendTimes:['09:00','18:00'],defaultAgent:'DSH',bilibili:{},xiaohongshu:{enabled:false},email:{enabled:false},runners:{}};
 assert.equal(capabilityReport(c,s).capabilities.find(v=>v.id==='bilibili')?.state,'browser_subtitle_archived');s.saveAssessment(topic.id,{itemKey:video.key,selected:false,reason:'fixture record',readEvidenceIds:[e.id!],limitations:[],agent:'fixture-test',simulation:false,reading:{snapshot,startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),scope:'archived_text_only',materials:[{id:e.id!,kind:e.kind,providedCharacters:e.text.length,totalCharacters:e.text.length,truncated:false,cited:true}]}});assert.equal(capabilityReport(c,s).capabilities.find(v=>v.id==='bilibili')?.state,'archived_subtitle_analysis_verified');
 }finally{s.close();}
});
