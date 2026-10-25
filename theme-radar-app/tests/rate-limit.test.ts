import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from '../src/http.ts';
import { GitHubSource } from '../src/github.ts';
import { runGithub } from '../src/engine.ts';
import { Store } from '../src/store.ts';
import { FixtureRunner } from '../src/runner.ts';
import { batchAt } from '../src/time.ts';
import { topic,mockFetch } from './fixtures.ts';

const reset=Math.ceil(Date.now()/1000)+300;
const limited=()=>new Response('rate limit exceeded',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(reset)}});
test('GitHub403限流与真正权限拒绝分别返回，重试时间保留',async()=>{
  await assert.rejects(()=>request('https://api.github.com/test',{fetcher:async()=>limited()}),(e:any)=>e.code==='RATE_LIMITED'&&Date.parse(e.details.retryAt)>=reset*1000&&e.details.remaining==='0');
  await assert.rejects(()=>request('https://api.github.com/test',{fetcher:async()=>new Response('forbidden',{status:403})}),(e:any)=>e.code==='ACCESS_DENIED');
  await assert.rejects(()=>request('https://api.github.com/test',{fetcher:async()=>new Response('slow down',{status:429,headers:{'retry-after':'120'}})}),(e:any)=>e.code==='RATE_LIMITED'&&Date.parse(e.details.retryAt)>Date.now()+119000);
});
test('材料请求遇限流即停止，不继续读取Release、许可或源码',async()=>{
  const urls:string[]=[];const source=new GitHubSource(async(url)=>{urls.push(url);if(url.endsWith('/readme'))return limited();return mockFetch(url);});
  await assert.rejects(()=>source.read('sample/tool'),(e:any)=>e.code==='RATE_LIMITED');assert.equal(urls.length,2);
});
test('限流批次保存冷却与游标，恢复时间前重跑不调用网络或模型',async()=>{
  const store=new Store(':memory:'),root=mkdtempSync(join(tmpdir(),'radar-rate-'));try{
    store.saveTopic(topic);store.saveTopic({...topic,id:'second'});let calls=0;
    const source=new GitHubSource(async(url)=>{calls++;if(url.includes('/repos/'))return limited();return mockFetch(url);});
    const input={store,source,runner:new FixtureRunner(),topicId:'*',batch:batchAt('2026-10-19','09:00'),outputDir:root,limit:2};
    const first:any=await runGithub({recipient:'reader@example.com',...input});assert.equal(first.state,'needs_validation');assert.equal(store.stats().deliveries,0);assert.ok(first.retryAt);
    const before=calls;const again:any=await runGithub({recipient:'reader@example.com',...input});assert.equal(again.state,'rate_limited');assert.equal(calls,before);
    const cursor=JSON.parse((store.job(first.jobId) as any).data);assert.equal(cursor.retryAt,first.retryAt);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
