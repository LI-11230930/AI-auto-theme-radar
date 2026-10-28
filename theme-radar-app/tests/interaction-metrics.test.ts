import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {resolve} from 'node:path';
import {Store} from '../src/store.ts';import {interactionMetrics,metricDelta} from '../src/interaction-metrics.ts';import {archivedAnalysis} from '../src/archive-reading.ts';import {GitHubSource} from '../src/github.ts';import {BilibiliSource} from '../src/bilibili.ts';import {startOperator} from '../src/operator.ts';import {item,evidence,topic,mockFetch} from './fixtures.ts';
const at=(stars:number|null,extra:any={})=>({...item,metadata:{stars,...extra}});
const withStore=(fn:(s:Store)=>void)=>{const s=new Store(':memory:');try{fn(s);}finally{s.close();}};

test('互动值仅保留本平台有效整数，未知/字符串/负数不补零',()=>{
 assert.deepEqual(interactionMetrics('github',{stars:0,forks:4,watchers:null,token:'private'}),{stars:0,forks:4});
 for(const v of [null,[],{stars:-1},{stars:'2'},{stars:Infinity},{stars:2.4},{stars:Number.MAX_SAFE_INTEGER+1}])assert.deepEqual(interactionMetrics('github',v),{});
 assert.deepEqual(interactionMetrics('xiaohongshu',{stars:3}),{});assert.deepEqual(interactionMetrics('bilibili',{view:0,reply:2,comments:['not retained']}),{view:0,reply:2});
});
test('首次取得及相同互动计数只建基线，升降均记录独立事件',()=>withStore(s=>{
 assert.equal(s.capture(at(10),[evidence]).metricsChanged,false);assert.equal(s.capture(at(10),[evidence]).metricsChanged,false);
 const update=s.capture(at(12),[evidence]);assert.equal(update.change,'unchanged');assert.equal(update.metricsChanged,true);s.capture(at(9),[evidence]);
 const rows=s.itemChanges(item.key).events;assert.deepEqual(rows.map(r=>r.kind),['metrics_changed','metrics_changed','discovered']);assert.deepEqual(rows[0].changes,[{field:'stars',before:12,after:9}]);
}));
test('仅涨Star不改变正文/阅读快照、当前判断或已推荐占用',()=>withStore(s=>{
 s.saveTopic(topic);const captured=s.capture(at(10),[evidence]),snapshot=s.readingSnapshot(item.key);s.saveAssessment(topic.id,{itemKey:item.key,selected:true,reason:'fixture',readEvidenceIds:captured.evidenceIds,limitations:[],agent:'fixture'});
 s.prepareDelivery('frozen','email','reader@example.com','frozen text',[item.key]);assert.equal(s.alreadyRecommended(item.key),true);
 s.capture(at(100),[evidence]);assert.equal(s.fingerprint(item.key),captured.fingerprint);assert.equal(s.readingSnapshot(item.key),snapshot);assert.equal(archivedAnalysis(s,item.key).assessments[0].current,true);assert.equal(s.alreadyRecommended(item.key),true);assert.equal(s.delivery('frozen')!.body,'frozen text');assert.equal(s.stats().deliveries,1);assert.equal(s.stats().assessments,1);
}));
test('正文与互动同时变化分别记录，新正文不被互动事件掩盖',()=>withStore(s=>{
 const old=s.capture(at(1),[evidence]);const next=s.capture(at(2),[{...evidence,text:'新的可读实现正文'}]);assert.equal(next.change,'content_changed');assert.notEqual(old.fingerprint,next.fingerprint);assert.deepEqual(s.itemChanges(item.key).events.map(r=>r.kind),['metrics_changed','content_changed','discovered']);
}));
test('版本变更独立于互动，保留同值返回的历史顺序',()=>withStore(s=>{
 s.capture(at(1),[evidence]);s.capture({...at(2),version:'v2'},[evidence]);s.capture(at(1),[evidence]);const rows=s.itemChanges(item.key).events;assert.deepEqual(rows.map(r=>r.kind),['metrics_changed','version_changed','metrics_changed','version_changed','discovered']);assert.deepEqual(rows[0].changes,[{field:'stars',before:2,after:1}]);
}));
test('只有两次均明确存在的计数参与比较，缺失不是0',()=>{
 assert.deepEqual(metricDelta(at(null),at(0)),[]);assert.deepEqual(metricDelta(at(3),at(null)),[]);
 assert.deepEqual(metricDelta(at(1,{interactions:{stars:1}}),at(1,{interactions:{stars:1,forks:3}})),[]);
 assert.deepEqual(metricDelta(at(1,{interactions:{stars:1,forks:0}}),at(1,{interactions:{stars:1,forks:3}})),[{field:'forks',before:0,after:3}]);
});
test('计数日志失败及提交保护失败均原子回滚，不留下半个变化',()=>withStore(s=>{
 s.capture(at(1),[evidence]);const before=s.stats(),logger=s.log;s.log=()=>{throw Error('fixture disk error');};assert.throws(()=>s.capture(at(2),[evidence]),/fixture/);s.log=logger;assert.equal(s.item(item.key).metadata.stars,1);assert.deepEqual(s.stats(),before);assert.throws(()=>s.capture(at(2),[evidence],()=>{throw Error('guard');}),/guard/);assert.deepEqual(s.stats(),before);
}));
test('历史查询有界且只读取，空条目不补造变化',()=>withStore(s=>{
 for(let i=0;i<34;i++)s.capture(at(i),[evidence]);const before=s.stats(),view=s.itemChanges(item.key);assert.equal(view.events.length,30);assert.equal(view.mayHaveMore,true);assert.equal(s.itemChanges(item.key,50).events.length,34);for(const n of [0,51,1.5])assert.throws(()=>s.itemChanges(item.key,n),/1至50/);assert.deepEqual(s.stats(),before);assert.deepEqual(s.itemChanges('github:none/repo').events,[]);
}));
test('GitHub/B站复用已请求元数据取计数，不新增互动或评论API',async()=>{
 const urls:string[]=[];const github=new GitHubSource(async(url,init)=>{urls.push(url);if(url==='https://api.github.com/repos/sample/tool')return Response.json({full_name:'sample/tool',owner:{id:1},stargazers_count:10,forks_count:0,watchers_count:null,default_branch:'main'});return mockFetch(url);});const g=await github.read('sample/tool',{files:[]});assert.deepEqual(g.item.metadata.interactions,{stars:10,forks:0});assert.equal(urls.filter(u=>/stargazers|forks|watchers|comments/.test(u)).length,0);
 const biliUrls:string[]=[];const bili=new BilibiliSource({fetcher:async(url)=>{biliUrls.push(url);if(url.includes('/x/web-interface/view'))return Response.json({code:0,data:{bvid:'BV1234567890',title:'fixture',aid:1,cid:11,owner:{mid:1},pages:[{page:1,cid:11,duration:1}],stat:{view:20,like:0,reply:4,comments:['not read']}}});return Response.json({code:0,data:{subtitle:{subtitles:[]}}});}});const b=await bili.read('BV1234567890');assert.deepEqual(b.item.metadata.interactions,{view:20,like:0,reply:4});assert.equal(biliUrls.length,2);assert.equal(biliUrls.some(u=>/reply|comment/.test(u)),false);assert.equal(b.evidence.some(e=>e.text.includes('not read')),false);
});
test('真实HTTP档案分析返回变化分类/前后计数，保留原判断与0投递',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-change-')),config=resolve(dir,'config.json'),previous=process.env.THEME_RADAR_CONFIG;writeFileSync(config,JSON.stringify({dataDir:resolve(dir,'data'),topics:[topic]}));process.env.THEME_RADAR_CONFIG=config;const server=await startOperator(0),base='http://127.0.0.1:'+(server.address() as any).port;
 try{const s=new Store(resolve(dir,'data/radar.sqlite'));s.capture(at(0),[evidence]);s.capture(at(7),[evidence]);s.close();const response=await fetch(base+'/api/archive/analysis?key='+encodeURIComponent(item.key));assert.equal(response.status,200);const d=await response.json() as any;assert.deepEqual(d.changeHistory.events[0].changes,[{field:'stars',before:0,after:7}]);assert.equal(d.changeHistory.events[0].metricsOnly,true);assert.deepEqual(d.assessments,[]);assert.equal(d.emailSent,false);const s2=new Store(resolve(dir,'data/radar.sqlite'));assert.equal(s2.stats().deliveries,0);assert.equal(s2.stats().jobs,0);s2.close();
 }finally{await new Promise<void>(done=>server.close(()=>done()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;rmSync(dir,{recursive:true,force:true});}
});
