import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';import {validateTopic} from '../src/model.ts';import type {Topic,Evidence,Item} from '../src/model.ts';
import {videoReadingProfile,profileCacheReady,profileVideoEvidence,textSegments} from '../src/video-reading-profile.ts';
import {materialPrompt,assessmentTask,validateModelTaskResult} from '../src/runner.ts';import {tracedAssessment,analyzeArchived} from '../src/archive-reading.ts';
import {runInterestRound} from '../src/interest-round.ts';import {withAsrFallback} from '../src/asr-fallback.ts';
import {materialView} from '../src/material-view.ts';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {topic as base,videoBody} from './fixtures.ts';
const topic:Topic={...base,id:'multipart',platforms:['bilibili'],bilibiliDiscovery:'interests',bilibiliAuthors:[],keywords:['MCP'],exclude:[]};
const item:Item={key:'bilibili:BV1234567890',platform:'bilibili',externalId:'BV1234567890',url:'https://www.bilibili.com/video/BV1234567890',title:'MCP实用教程',authorId:'123',author:'fixture',publishedAt:'2020-01-01T00:00:00Z',discoveredAt:'2026-10-28T00:00:00Z',version:'video',metadata:{pageCount:13,requestedPages:[1,2,3],subtitlePages:[1,2,3].map(page=>({page,cid:String(page),duration:60,state:'acquired'}))}};
const evidence=(page:number,text=videoBody):Evidence=>({itemKey:item.key,kind:'subtitle:p'+page,url:item.url+'?p='+page,text,collectedAt:item.discoveredAt,coverage:{material:'P'+page+'字幕',expected:1,acquired:1,processed:0,state:'unread',method:'fixture'}});

test('旧主题默认P1/5000，扩展最多3P/15000，非法深度在保存前拒绝',()=>{
 assert.deepEqual(videoReadingProfile(topic),{mode:'standard',maxPages:1,charactersPerPage:5000,segmentCharacters:5000,fallbackPages:[1]});
 assert.equal(videoReadingProfile({...topic,videoReading:'extended'}).maxPages,3);
 for(const videoReading of [null,3,{},'all'])assert.throws(()=>validateTopic({...topic,videoReading} as any));
});
test('扩展缓存必须覆盖实际前三P，单P视频和明确无轨可复用，缺失或失败不能冒充完成',()=>{
 const t={...topic,videoReading:'extended' as const},es=[evidence(1),evidence(2),evidence(3)];
 assert.equal(profileCacheReady(t,item,es),true);
 assert.equal(profileCacheReady(t,{...item,metadata:{...item.metadata,requestedPages:[1]}},es),false);
 assert.equal(profileCacheReady(t,item,es.slice(0,2)),false);
 const unavailable={...item,metadata:{...item.metadata,subtitlePages:[{page:3,state:'unavailable',reason:'no_track_exposed'}]}};
 assert.equal(profileCacheReady(t,unavailable,es.slice(0,2)),true);
 assert.equal(profileCacheReady(t,{...item,metadata:{pageCount:1,requestedPages:[1]}},[evidence(1)]),true);
 assert.equal(profileCacheReady(t,{...item,metadata:{}},es),false);
 assert.deepEqual(profileVideoEvidence(t,item,[...es,evidence(4)]).map(e=>e.kind),['subtitle:p1','subtitle:p2','subtitle:p3']);
});
test('文本连续分段不重复、不漏字、不拆代理对，区间是字符而非视频时间',()=>{
 const text='中'.repeat(4999)+'🙂'+'文'.repeat(5100),segments=textSegments(text);
 assert.equal(segments.map(s=>s.text).join(''),text);assert.equal(segments[0].to,4999);
 assert.equal(segments[1].from,4999);assert.equal(segments.at(-1)!.to,text.length);
 for(let n=1;n<segments.length;n++)assert.equal(segments[n-1].to,segments[n].from);
 for(const size of [0,1,-1,1.5,15001])assert.throws(()=>textSegments(text,size));
});
test('扩展长字幕在一个任务内按连续文本片段提供，不复制全文；总字符与截断仍受预算约束',()=>{
 const s=new Store(':memory:');try{s.saveTopic(topic);s.capture(item,[evidence(1,'字'.repeat(21000))]);const es=s.currentEvidence(item.key);
 const standard=materialPrompt(topic,item,es);assert.equal(standard.materials[0].providedCharacters,5000);assert.equal(JSON.parse(standard.prompt).materials[0].text.length,5000);
 const bundle=materialPrompt({...topic,videoReading:'extended'},item,es),task=assessmentTask(bundle),p=JSON.parse(task.prompt);
 assert.equal(p.materials[0].text,undefined);assert.equal(p.materials[0].textSegments.length,3);assert.equal(p.materials[0].textSegments.map(s=>s.text).join('').length,15000);assert.equal(p.materials[0].truncated,true);
 const bounded=materialPrompt({...topic,videoReading:'extended'},item,es,6000);assert.equal(bounded.materials[0].providedCharacters,6000);
 const assessment:any={itemKey:item.key,selected:false,reason:'fixture',summaryZh:'测试字幕内容。',flow:{steps:['输入','输出'],basis:'overview',evidenceIds:[]},readEvidenceIds:['m1'],limitations:[]};
 assert.equal(validateModelTaskResult(task.prompt,assessment),null);
 const traced=tracedAssessment({...assessment,readEvidenceIds:[es[0].id]},item,bundle,s.readingSnapshot(item.key),'2026-10-28T00:00:00Z');
 assert.deepEqual(traced.reading.materials[0].providedSegments,[{from:0,to:5000},{from:5000,to:10000},{from:10000,to:15000}]);
 assert.match(traced.limitations.join(' '),/15000\/21000/);
 s.saveAssessment(topic.id,{...traced,agent:'fixture',simulation:true});
 const view=materialView(s,es[0].id!);assert.deepEqual(view.reading.history[0].providedSegments,traced.reading.materials[0].providedSegments);assert.equal(view.coverage.state,'unread');assert.equal(view.reading.currentNonSimulatedClaims.length,0);
 }finally{s.close();}
});
test('前三P长正文合计仍不超过任务总预算，时间轴不会进入文本片段',()=>{
 const es=[1,2,3].map(page=>({...evidence(page,'字'.repeat(25000)),id:'e'+page}));
 const timeline={...es[0],kind:'subtitle-timeline:p1',text:'not body'},bundle=materialPrompt({...topic,videoReading:'extended'},item,[...es,timeline]);
 assert.equal(bundle.materials.length,3);assert.equal(bundle.materials.reduce((n,m)=>n+m.providedCharacters,0),45000);
 const zero=materialPrompt({...topic,videoReading:'extended'},item,es,0);assert.throws(()=>assessmentTask(zero),{code:'NO_READABLE_MATERIAL'});
});

test('共享档案含其他分P时，模型只能收到本主题允许的正文和引用',()=>{
 const es=[1,2,3,4].map(page=>({...evidence(page),id:'e'+page}));
 const standard=materialPrompt(topic,item,es),extended=materialPrompt({...topic,videoReading:'extended'},item,es);
 assert.deepEqual(standard.materials.map(m=>m.kind),['subtitle:p1']);
 assert.deepEqual(extended.materials.map(m=>m.kind),['subtitle:p1','subtitle:p2','subtitle:p3']);
 const task=assessmentTask(standard),invalid={itemKey:item.key,selected:false,reason:'不应读取P2',summaryZh:'测试材料范围。',flow:{steps:['输入','输出'],basis:'overview',evidenceIds:[]},readEvidenceIds:['m2'],limitations:[]};
 assert.match(validateModelTaskResult(task.prompt,invalid)!,/本任务/);
 assert.throws(()=>tracedAssessment({...invalid,readEvidenceIds:['e2']} as any,item,standard,'snapshot','start'),{code:'INVALID_AGENT_OUTPUT'});
});
test('标准P1缓存不能满足扩展轮次；P2正文可筛选，随后复用完整多P档案且不重复读上游',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'radar-multipart-')),s=new Store(':memory:');t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
 s.saveTopic({...topic,videoReading:'extended'});s.capture({...item,metadata:{...item.metadata,requestedPages:[1]}},[evidence(1)]);let reads=0,models=0,options:any;
 const source={recommendations:async()=>({items:[{bvid:item.externalId,title:item.title,authorId:item.authorId}],authenticated:true}),search:async()=>[],read:async(_b:any,o:any)=>{reads++;options=o;return {item,evidence:[evidence(1,'开场介绍'),evidence(2),evidence(3)],warnings:['仅前三P']};}};
 const runner={name:'Codex',assess:async(_t:any,i:any,es:any[])=>{models++;return {itemKey:i.key,selected:true,reason:'仅依据已提供P2实现说明',summaryZh:'介绍本地工具的处理流程。',flow:{steps:['资料','整理输出'],basis:'overview' as const,evidenceIds:[]},readEvidenceIds:es.filter(e=>e.kind==='subtitle:p2').map(e=>e.id),limitations:[],agent:'Codex',simulation:false};}};
 const analyze=(topicId:string,itemKey:string,signal?:AbortSignal,commitGuard?:()=>void)=>analyzeArchived({store:s,runner,topicId,itemKey,signal,commitGuard});
 const run=()=>runInterestRound({store:s,dataDir:dir,topicId:topic.id,source,readLimit:1,analyze});
 const first=await run();assert.equal(reads,1);assert.equal(models,1);assert.equal(options.pages,undefined);assert.equal(options.multipartP1Fallback,true);
 assert.equal(first.results[0].state,'assessed');assert.equal(first.results[0].selected,true);assert.equal(first.sample.count,1);assert.equal(first.results[0].acquisition.videoText.length,3);
 const second=await run();assert.equal(reads,1);assert.equal(models,1);assert.equal(second.results[0].acquisition.cached,true);assert.equal(second.results[0].reused,true);
});
test('没有P1的多P请求即使显式允许也不能调用P2/P3的ASR',async()=>{
 let calls=0;const result:any={item:{...item,metadata:{...item.metadata,requestedPages:[2,3]}},evidence:[],warnings:[]};
 await withAsrFallback(result,{enabled:true,allowMultipartP1:true,workDir:'.',audio:async()=>{calls++;throw Error('must not run');}});assert.equal(calls,0);
});
test('普通多P读取仍不隐式启动ASR；扩展模式仅以P1 CID执行原有单次回退',async()=>{
 let calls=0;const result:any={item:{...item,metadata:{...item.metadata,subtitlePages:[{page:1,cid:'1',duration:60,state:'unavailable',reason:'no_track_exposed'}]}},evidence:[evidence(2)],warnings:[]};
 const options:any={enabled:true,pythonCommand:'fixture',modelDir:'fixture',workDir:'.',audio:async(_b:any,o:any)=>{calls++;assert.equal(o.expectedCid,'1');return {bvid:item.externalId,cid:'1',duration:60,audioUrl:'https://example.invalid/unused'};},transcribe:async()=>({text:videoBody,segments:[{from:0,to:60,content:videoBody}],duration:60,range:{from:0,to:60},coverage:'complete',language:'zh',model:'faster-whisper-base',audioBytes:100})};
 await withAsrFallback(result,options);assert.equal(calls,0);
 const acquired=await withAsrFallback(result,{...options,allowMultipartP1:true});assert.equal(calls,1);assert.ok(acquired.evidence.some(e=>e.kind==='subtitle:p2'));
 assert.ok(acquired.evidence.some(e=>e.kind==='asr:p1'));assert.equal(acquired.evidence.some(e=>e.kind==='asr:p2'),false);
});
