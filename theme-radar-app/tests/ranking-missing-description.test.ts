import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {HostRunner} from '../src/runner.ts';
import {GitHubSource} from '../src/github.ts';
import {renderDigest,RANKING_DESCRIPTION_MISSING} from '../src/mail.ts';
import {validateMailTemplate} from '../src/mail-template.ts';
import {runGithub} from '../src/engine.ts';
import {Store} from '../src/store.ts';
import {topic} from './fixtures.ts';
import {batchAt} from '../src/time.ts';
import type {Ranking} from '../src/model.ts';

const flow={steps:['读取资料','生成结果'],basis:'overview' as const,evidenceIds:[]};
const ranking=(i:number,description='A sample automation tool'):Ranking=>({repo:'sample/project'+i,url:'https://github.com/sample/project'+i,rank:i+1,stars:100+i,starsToday:2,period:'daily',periodStars:2,description,source:'https://github.com/trending?since=daily',language:null,observedAt:'2026-10-27T00:00:00Z'});
async function withRunner(fn:(runner:HostRunner)=>Promise<void>){const dir=mkdtempSync(resolve(tmpdir(),'radar-ranking-'));try{await fn(new HostRunner('Codex',{},dir,{}));}finally{rmSync(dir,{recursive:true,force:true});}}
const answer=(prompt:string)=>({stdout:JSON.stringify({descriptions:JSON.parse(prompt).projects.map((p:any)=>({repo:p.repo,summaryZh:'读取资料并生成结果的自动化工具。',flow}))}),stderr:'',code:0});
test('空简介在榜单中间不会让模型停止，后续非空项目均提交且跨日周榜只描述一次',async()=>withRunner(async runner=>{
 const rows=[ranking(0),ranking(1,''),ranking(2),{...ranking(0),period:'weekly' as const,source:'https://github.com/trending?since=weekly'}];
 runner.invoke=async prompt=>{const p=JSON.parse(prompt);assert.deepEqual(p.projects.map((p:any)=>p.repo),['sample/project0','sample/project2']);assert.doesNotMatch(p.instruction,/明确缺失并停止/);return answer(prompt);};
 const result=await runner.describeRankings(rows);assert.equal(result.length,4);assert.equal(result[1].summaryZh,RANKING_DESCRIPTION_MISSING);assert.equal(result[1].descriptionMissing,true);assert.equal(result[1].flow,undefined);assert.equal(result[2].summaryZh,'读取资料并生成结果的自动化工具。');assert.equal(result[3].rank,1);
}));
test('没有榜单或全部缺简介时不向Agent派发空任务，也不构造虚假流程',async()=>withRunner(async runner=>{
 runner.invoke=async()=>{throw Error('must not call a model');};assert.deepEqual(await runner.describeRankings([]),[]);
 const rows=await runner.describeRankings([ranking(0,''),ranking(1,'  ')]);assert.ok(rows.every(r=>r.summaryZh===RANKING_DESCRIPTION_MISSING&&r.flow===undefined&&r.descriptionMissing));
}));
test('非空材料的最后一个项目漏答仍被拒绝，不能用缺失容错掩盖模型截断',async()=>withRunner(async runner=>{
 runner.invoke=async prompt=>{const result=answer(prompt),body=JSON.parse(result.stdout);body.descriptions.pop();return {...result,stdout:JSON.stringify(body)};};
 await assert.rejects(runner.describeRankings([ranking(0),ranking(1,''),ranking(2)]),{code:'INVALID_SUMMARY'});
}));
const template=validateMailTemplate({github:{sections:['daily','weekly']}});
test('真实缺简介保留日周榜各十条、链接和Star，其他项目仍要求中文介绍和用途图',async()=>withRunner(async runner=>{
 runner.invoke=async prompt=>answer(prompt);const daily=await runner.describeRankings(Array.from({length:10},(_,i)=>ranking(i,i===4?'':'A sample tool'))),weekly=daily.map(r=>({...r,period:'weekly' as const,source:'https://github.com/trending?since=weekly'}));
 const digest=renderDigest({batch:batchAt('2026-10-27','09:00'),entries:[],rankings:daily,weeklyRankings:weekly,warnings:[],mailTemplate:template});assert.equal(digest.contentReady,true);assert.equal(digest.audit.daily.length,10);assert.equal(digest.audit.weekly.length,10);assert.match(digest.text,/未取得项目简介/);assert.match(digest.text,/sample\/project9/);assert.match(digest.text,/累计 Star/);assert.equal(digest.audit.daily[4].flow,undefined);
}));
test('伪造missing标记不能绕过非空来源的流程校验，空来源也必须使用固定缺失提示',()=>{
 const rows=Array.from({length:10},(_,i)=>({...ranking(i),summaryZh:'示例自动化工具。',flow}));
 for(const bad of [{...rows[2],descriptionMissing:true,flow:undefined},{...rows[2],description:'',descriptionMissing:true,summaryZh:'推测出来的项目功能。',flow:undefined}]){
  const daily=rows.map((r,i)=>i===2?bad:r),weekly=rows.map(r=>({...r,period:'weekly' as const}));assert.equal(renderDigest({batch:batchAt('2026-10-27','09:00'),entries:[],rankings:daily,weeklyRankings:weekly,warnings:[],mailTemplate:template}).contentReady,false);
 }
});
const html=(empty=true)=>Array.from({length:10},(_,i)=>`<article class="Box-row"><h2><a href="/sample/project${i}">tool</a></h2>${empty&&i===4?'':'<p>Automation tool</p>'}<a href="/sample/project${i}/stargazers">123</a><span>5 stars today 10 stars this week</span></article>`).join('');
test('榜单简介为空时真实走只读README路径，截断预算4000字符，日周榜复用同轮材料',async()=>{
 const requests:string[]=[],source=new GitHubSource(async url=>{requests.push(url);return url.includes('/trending')?new Response(html()):url.endsWith('/readme')?new Response('README automation material '.repeat(300)):Response.json({private:false,visibility:'public'});});
 const daily=await source.trending(),weekly=await source.trending('weekly');assert.equal(daily.rows[4].description.length,4000);assert.equal(daily.rows[4].descriptionSource,'https://github.com/sample/project4#readme');assert.equal(daily.rows[4].descriptionMissing,false);assert.equal(weekly.rows[4].description,daily.rows[4].description);assert.equal(requests.filter(u=>u.includes('/readme')).length,1);
});
test('README确实404时标记缺失并保留后续排名，不将其他请求失败视为没有简介',async()=>{
 const source=new GitHubSource(async url=>url.includes('/trending')?new Response(html()):url.endsWith('/readme')?new Response('not found',{status:404}):Response.json({private:false}));const r=await source.trending();assert.equal(r.rows.length,10);assert.equal(r.rows[4].descriptionMissing,true);assert.equal(r.rows[9].repo,'sample/project9');
 const failed=new GitHubSource(async url=>url.includes('/trending')?new Response(html()):new Response('failed',{status:503}));await assert.rejects(failed.trending(),{code:'HTTP_ERROR'});
});
test('README鉴权和限流错误继续阻止冻结，不被误标为普通缺简介',async()=>{
 for(const status of [401,429]){const source=new GitHubSource(async url=>url.includes('/trending')?new Response(html()):new Response('blocked',{status}));await assert.rejects(source.trending(),{code:status===401?'AUTH_REQUIRED':'RATE_LIMITED'});}
});
test('榜单过时且仓库已经转私有时，停止README回退而不读取私有正文',async()=>{
 const paths:string[]=[],source=new GitHubSource(async url=>{paths.push(url);return url.includes('/trending')?new Response(html()):Response.json({private:true,visibility:'private'});});await assert.rejects(source.trending(),{code:'PUBLIC_ONLY'});assert.ok(paths.every(url=>!url.endsWith('/readme')));
});
test('整条GitHub流水线遇到中间空简介仍产出完整日周榜草稿，不创建投递或调用模型阅读仓库',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-ranking-engine-')),store=new Store(':memory:');try{
  store.saveTopic(topic);const source=new GitHubSource(async url=>url.includes('/trending')?new Response(html()):url.endsWith('/readme')?new Response('no README',{status:404}):Response.json({private:false})),runner=new HostRunner('Codex',{},dir,{});
  let modelCalls=0;runner.invoke=async prompt=>{modelCalls++;return answer(prompt);};runner.assess=async()=>{throw Error('projects section is disabled');};
  const result=await runGithub({store,source,runner,topicId:topic.id,batch:batchAt('2026-10-27','09:00'),outputDir:dir,recipient:'reader@example.com',mailTemplate:template,freezeDelivery:false});
  assert.equal(result.state,'prepared');assert.equal(result.digest?.contentReady,true);assert.equal(modelCalls,1);assert.equal(result.digest?.audit.daily.length,10);assert.equal(result.digest?.audit.weekly.length,10);assert.equal(store.stats().deliveries,0);assert.equal(store.stats().assessments,0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
