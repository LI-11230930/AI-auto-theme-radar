import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { GitHubSource } from '../src/github.ts';
import { runGithub } from '../src/engine.ts';
import { FixtureRunner } from '../src/runner.ts';
import { batchAt } from '../src/time.ts';
import { collectionWindow, activityInWindow, sourceTimestamp } from '../src/selection.ts';
import { item, evidence, topic, mockFetch } from './fixtures.ts';

const morning=batchAt('2026-10-19','09:00');
const confirmedWindow=()=>({...collectionWindow(batchAt('2026-10-18','18:00'),topic.id,1,null),completed:true});
function confirm(store:Store,id='previous',body:object={simulation:false,collectionWindows:[confirmedWindow()]}){
  store.prepareDelivery(id,'email','reader@example.com',JSON.stringify(body));store.beginDelivery(id);store.transitionDelivery(id,'submitted');store.transitionDelivery(id,'sent_confirmed');
}
function sourceWith(pushedAt:unknown,extra:any={}){
  return new GitHubSource(async(url)=>{
    if(url==='https://api.github.com/repos/sample/tool')return Response.json({full_name:'sample/tool',owner:{id:123,login:'sample'},description:'Agent demo',default_branch:'main',created_at:'2020-01-01T00:00:00Z',pushed_at:pushedAt,updated_at:'2026-10-19T00:00:00Z',...extra});
    return mockFetch(url);
  });
}
async function run(source:GitHubSource,store:Store,runner=new FixtureRunner()){
  const root=mkdtempSync(join(tmpdir(),'radar-window-'));
  try{const result:any=await runGithub({recipient:'reader@example.com',store,source,runner,topicId:'*',batch:morning,limit:1,outputDir:root});return {...result,html:readFileSync(result.preview,'utf8')};}
  finally{rmSync(root,{recursive:true,force:true});}
}

test('活动时间仅接受可校验来源时间，发现时间和updated_at不能冒充活动',()=>{
  for(const value of ['2026-02-30T00:00:00Z','today','2026-10-19',undefined])assert.equal(sourceTimestamp(value),null);
  const window=collectionWindow(morning,topic.id,1,confirmedWindow().endAt);
  assert.equal(activityInWindow({...item,metadata:{updated_at:morning.startAt},discoveredAt:morning.startAt},window).reason,'unknown_activity');
  assert.equal(activityInWindow({...item,publishedAt:morning.startAt},window).eligible,true);
  assert.equal(activityInWindow({...item,publishedAt:morning.endAt},window).eligible,false);
  assert.equal(activityInWindow({...item,publishedAt:'2026-10-18T09:59:59Z'},window).reason,'before_window');
  assert.equal(activityInWindow({...item,publishedAt:morning.startAt,metadata:{pushedAt:morning.endAt}},window).reason,'at_or_after_end');
  assert.equal(activityInWindow({...item,metadata:{releasePublishedAt:morning.startAt}},window).eligible,true);
});

test('首轮7日基线有明确范围，已有历史保持独立时段并拒绝倒序',()=>{
  const initial=collectionWindow(morning,topic.id,1,null);
  assert.equal(initial.mode,'baseline_7d');assert.equal(initial.startAt,'2026-10-12T01:00:00.000Z');
  assert.equal(collectionWindow(morning,topic.id,1,confirmedWindow().endAt).startAt,morning.startAt);
  assert.throws(()=>collectionWindow(morning,topic.id,1,'2026-10-20T00:00:00Z'),/倒序/);
});

test('预览、模糊回执、模拟和连接测试不推进主题历史，订阅版本独立',()=>{
  const store=new Store(':memory:');try{
    store.saveTopic(topic);const body={simulation:false,collectionWindows:[confirmedWindow()]};
    store.prepareDelivery('pending','email','reader@example.com',JSON.stringify(body));
    assert.equal(store.lastConfirmedWindow(topic.id,1),null);
    store.beginDelivery('pending');store.transitionDelivery('pending','uncertain');assert.equal(store.lastConfirmedWindow(topic.id,1),null);
    confirm(store,'simulation',{...body,simulation:true});confirm(store,'verification',{...body,verification:true});confirm(store,'connection-test',{subject:'主题雷达邮箱连接测试'});
    assert.equal(store.lastConfirmedWindow(topic.id,1),null);
    confirm(store);assert.equal(store.lastConfirmedWindow(topic.id,1),confirmedWindow().endAt);
    assert.equal(store.lastConfirmedWindow(topic.id,2),null);
    confirm(store,'incomplete',{simulation:false,collectionWindows:[{...confirmedWindow(),topicRevision:2,completed:false}]});
    assert.equal(store.lastConfirmedWindow(topic.id,2),null);
  }finally{store.close();}
});

test('时间过滤先于模型，旧仓库不因今日互动或发现时间占用AI调用',async()=>{
  const store=new Store(':memory:');try{store.saveTopic(topic);const runner=new FixtureRunner();let calls=0;runner.assess=async()=>{calls++;throw Error('不应执行');};
    const result=await run(sourceWith('2020-01-02T00:00:00Z'),store,runner);
    assert.equal(calls,0);assert.equal(result.filtered.before_window,1);assert.equal(result.selected,0);
    assert.equal(result.collectionWindows[0].mode,'baseline_7d');assert.ok(!result.html.includes('首次7日基线'));
  }finally{store.close();}
});

test('有已确认历史时执行左闭右开窗口，早晚不重叠',async()=>{
  for(const [date,selected] of [[morning.startAt,1],[morning.endAt,0]] as const){
    const store=new Store(':memory:');try{store.saveTopic(topic);confirm(store);const result=await run(sourceWith(date),store);
      assert.equal(result.selected,selected);assert.equal(result.collectionWindows[0].mode,'incremental');
      assert.equal(store.lastConfirmedWindow(topic.id,1),confirmedWindow().endAt);
    }finally{store.close();}
  }
});

test('缺失活动时间不发往outbox，完整归档保留以便排查',async()=>{
  const store=new Store(':memory:');try{store.saveTopic(topic);const result=await run(sourceWith(null,{created_at:null}),store);
    assert.equal(result.filtered.unknown_activity,1);assert.equal(result.state,'needs_validation');assert.equal(store.stats().deliveries,0);assert.equal(store.stats().items,1);
  }finally{store.close();}
});

test('Daily失败保留预览但不准备投递，恢复重跑后可继续且不推进历史',async()=>{
  const store=new Store(':memory:');try{store.saveTopic(topic);const source=sourceWith(morning.startAt),original=source.trending.bind(source);source.trending=async()=>{throw Error('Daily暂不可用');};
    const failed=await run(source,store);assert.equal(failed.state,'needs_validation');assert.equal(store.stats().deliveries,0);
    source.trending=original;const resumed=await run(source,store);assert.equal(resumed.state,'prepared');assert.equal(resumed.selected,1);
    assert.equal(store.lastConfirmedWindow(topic.id,1),null);
  }finally{store.close();}
});

test('缺少README不能只用元数据生成精选，搜索不完整不能推进投递',async()=>{
  for(const mode of ['readme','search']){const store=new Store(':memory:');try{store.saveTopic(topic);const source=sourceWith(morning.startAt);
    if(mode==='readme'){const original=source.read.bind(source);source.read=async(repo)=>{const result=await original(repo);return {...result,evidence:result.evidence.filter(e=>e.kind!=='readme')};};}
    else {const original=source.search.bind(source);source.search=async(...args)=>({...await original(...args),incomplete:true});}
    const result=await run(source,store);assert.equal(result.state,'needs_validation');assert.equal(store.stats().deliveries,0);
  }finally{store.close();}}
});

test('仓库push和互动数仅用于活动/显示，不触发实质内容变化',()=>{
  const store=new Store(':memory:');try{const meta={...evidence,kind:'repository-metadata',text:JSON.stringify({description:'功能',pushed_at:'2026-10-18T00:00:00Z',stargazers_count:1})};
    const first=store.capture(item,[meta,evidence]);const second=store.capture({...item,metadata:{pushedAt:morning.startAt}},[evidence,{...meta,text:JSON.stringify({description:'功能',pushed_at:morning.startAt,stargazers_count:999})}]);
    assert.equal(second.fingerprint,first.fingerprint);assert.equal(second.change,'unchanged');
    assert.equal(store.capture(item,[{...meta,text:JSON.stringify({description:'新增功能'})},evidence]).change,'content_changed');
  }finally{store.close();}
});
