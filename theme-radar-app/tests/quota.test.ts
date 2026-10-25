import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {batchAt,deliveryKey} from '../src/time.ts';
import {runGithub} from '../src/engine.ts';
import {GitHubSource} from '../src/github.ts';
import {item,evidence,topic,mockFetch} from './fixtures.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
const date='2026-10-20',am=deliveryKey('reader@example.com',batchAt(date,'09:00')),pm=deliveryKey('reader@example.com',batchAt(date,'18:00'));
const make=(store:Store,n:number,platform:'github'|'bilibili'='github')=>{const key=platform+':sample/'+n;store.capture({...item,platform,key,externalId:'sample/'+n},[{...evidence,itemKey:key}]);return key;};

test('每日5条在早晚共享，重复准备不重复占用，超额事务不留下outbox',()=>{
  const store=new Store(':memory:');try{const keys=Array.from({length:6},(_,n)=>make(store,n));store.prepareDelivery(am,'email','reader@example.com','{}',keys.slice(0,4));store.prepareDelivery(am,'email','reader@example.com','{}',keys.slice(0,4));assert.equal(store.dailyQuota(date).platforms.github.remaining,1);
    assert.throws(()=>store.prepareDelivery(pm,'email','reader@example.com','{}',keys.slice(4)),/配额/);assert.equal(store.delivery(pm),undefined);assert.equal(store.dailyQuota(date).platforms.github.used,4);
    store.prepareDelivery(pm,'email','reader@example.com','{}',[keys[4]]);assert.equal(store.dailyQuota(date).platforms.github.remaining,0);
  }finally{store.close();}
});
test('待核对保留配额，明确失败/未提交取消释放，日期和平台隔离',()=>{
  const store=new Store(':memory:');try{const gh=make(store,1),bili=make(store,2,'bilibili');store.prepareDelivery(am,'email','reader@example.com','{}',[gh,bili]);store.beginDelivery(am);store.recoverDeliveries();assert.equal(store.dailyQuota(date).platforms.github.used,1);assert.equal(store.dailyQuota(date).platforms.bilibili.used,1);assert.equal(store.dailyQuota('2026-10-21').platforms.github.used,0);
    store.transitionDelivery(am,'failed',{reason:'confirmed no transport'});assert.equal(store.dailyQuota(date).platforms.github.used,0);store.prepareDelivery(pm,'email','reader@example.com','{}',[gh]);store.cancelPrepared(pm,'未提交取消');assert.equal(store.dailyQuota(date).platforms.github.used,0);assert.equal(store.dailyQuota(date).comments.enabled,false);
    assert.throws(()=>store.dailyQuota('2026-02-30'));assert.throws(()=>store.dailyQuota('bad'));
  }finally{store.close();}
});
test('验证/模拟批次不消耗生产配额，预留冲突回滚后计数不增加',()=>{
  const store=new Store(':memory:');try{const key=make(store,1);store.prepareDelivery(am,'email','reader@example.com',JSON.stringify({simulation:true}),[key]);assert.equal(store.dailyQuota(date).platforms.github.used,0);assert.throws(()=>store.prepareDelivery(pm,'email','reader@example.com','{}',[key]),/有效投递/);assert.equal(store.delivery(pm),undefined);assert.equal(store.dailyQuota(date).platforms.github.used,0);
  }finally{store.close();}
});
test('两数据库连接共享同日剩余，后领取不能绕过前一连接的冻结预留',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'radar-quota-')),a=new Store(resolve(root,'test.sqlite')),b=new Store(resolve(root,'test.sqlite'));try{const keys=Array.from({length:6},(_,n)=>make(a,n));a.prepareDelivery(am,'email','reader@example.com','{}',keys.slice(0,5));assert.equal(b.dailyQuota(date).platforms.github.remaining,0);assert.throws(()=>b.prepareDelivery(pm,'email','reader@example.com','{}',[keys[5]]));assert.equal(a.deliveries().length,1);
  }finally{b.close();a.close();rmSync(root,{recursive:true,force:true});}
});
test('批处理按剩余配额冻结晚报，多余AI判断留档，未执行任何发送',async()=>{
  const root=mkdtempSync(resolve(tmpdir(),'radar-quota-engine-')),store=new Store(resolve(root,'test.sqlite'));let round=0;const source=new GitHubSource(mockFetch);
  source.search=async()=>({items:Array.from({length:4},(_,n)=>({repo:'sample/round'+round+'-'+n,stars:10,url:'https://github.com/sample/tool',createdAt:'2026-10-19T00:00:00Z',pushedAt:'2026-10-19T01:00:00Z',description:'fixture'})),total:4,incomplete:false,query:'fixture'});
  source.read=async repo=>{const key='github:'+repo;return {item:{...item,key,externalId:repo,title:repo,publishedAt:'2026-10-19T00:00:00Z'},evidence:[{...evidence,itemKey:key}],warnings:[]};};
  source.trending=async(period='daily')=>({html:'fixture '+period,collectedAt:new Date().toISOString(),rows:Array.from({length:10},(_,i)=>({repo:'rank/r'+i,url:'https://github.com/rank/r'+i,rank:i+1,stars:1,starsToday:period==='daily'?1:null,period:period as 'daily'|'weekly',periodStars:1,description:'离线样例项目简介',flow:{steps:['示例输入','示例处理','示例输出'],basis:'overview' as const,evidenceIds:[]},language:null,observedAt:new Date().toISOString(),source:'https://github.com/trending?since='+period}))});
  const runner={name:'isolated-quota-test',assess:async(_topic:any,value:any,materials:any[])=>({itemKey:value.key,selected:true,summaryZh:'离线配额测试项目简介',flow:{steps:['示例输入','示例处理','示例输出'],basis:'overview' as const,evidenceIds:[]},reason:'离线配额测试',readEvidenceIds:materials.map(e=>e.id),limitations:['固定样例，未调用模型'],agent:'isolated-quota-test'})};
  try{store.saveTopic(topic);const first=await runGithub({recipient:'reader@example.com',store,source,runner,topicId:topic.id,batch:batchAt(date,'09:00'),outputDir:root,limit:4});assert.equal(first.selected,4);round=1;const second=await runGithub({recipient:'reader@example.com',store,source,runner,topicId:topic.id,batch:batchAt(date,'18:00'),outputDir:root,limit:4});assert.equal(second.selected,1);assert.equal(store.assessments(topic.id).length,8);assert.equal(store.dailyQuota(date).platforms.github.used,5);assert.ok(store.deliveries().every((d:any)=>d.state==='prepared'));
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
