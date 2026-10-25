import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {Store} from '../src/store.ts';
import {GitHubSource} from '../src/github.ts';
import {BilibiliSource} from '../src/social.ts';
import {runGithub} from '../src/engine.ts';
import {FixtureRunner,runProcess,HostRunner} from '../src/runner.ts';
import {capabilityReport,runConfigured,archivePreview} from '../src/service.ts';
import {loadConfig,APP_ROOT} from '../src/config.ts';
import {collectionWindow} from '../src/selection.ts';
import {batchAt} from '../src/time.ts';
import {publicError} from '../src/model.ts';
import {startOperator} from '../src/operator.ts';
import {item,evidence,topic,mockFetch} from './fixtures.ts';

const morning=batchAt('2026-10-19','09:00'),window=collectionWindow(morning,topic.id,1,null);
const temporary=()=>mkdtempSync(join(tmpdir(),'radar-recovery-'));
const options=(store:Store,dir:string)=>({store,source:new GitHubSource(mockFetch),runner:new FixtureRunner(),topicId:'*',batch:morning,outputDir:dir,limit:1});
const sampleConfig=(dir:string)=>loadConfig(writeConfig(dir));
function writeConfig(dir:string){const path=join(dir,'config.json');writeFileSync(path,JSON.stringify({recipient:'reader@example.com',dataDir:join(dir,'data'),xiaohongshu:{enabled:false}}));return path;}

test('V1账本迁移保留事件、推荐与投递，重复A→B→A→B完整留痕且可备份恢复',()=>{
  const dir=temporary(),file=join(dir,'legacy.sqlite');let store=new Store(file);
  try{
    store.capture(item,[evidence]);store.prepareDelivery('original','email','reader@example.com','frozen',[item.key]);
    store.db.exec(`ALTER TABLE events RENAME TO current_events;
      CREATE TABLE events(id TEXT PRIMARY KEY,item_key TEXT NOT NULL REFERENCES items(key),kind TEXT NOT NULL,old_hash TEXT,new_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(item_key,kind,new_hash));
      INSERT INTO events SELECT * FROM current_events;DROP TABLE current_events;
      DROP TABLE cooldowns;DROP TABLE delivery_items;PRAGMA user_version=1;`);
    store.close();store=new Store(file);
    assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version,2);
    assert.equal(store.delivery('original').body,'frozen');assert.equal(store.deliveryItems('original').length,1);
    for(const text of ['A','B','A','B'])store.capture(item,[{...evidence,text}]);
    assert.equal(store.events().length,5);assert.equal(new Set(store.events().map((r:any)=>r.id)).size,5);
    const copy=new Store(store.backup(join(dir,'backup.sqlite')));try{assert.equal(copy.events().length,5);assert.equal(copy.deliveryItems('original').length,1);}finally{copy.close();}
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('prepared取消释放原内容，但已提交或不确定投递不能直接取消重发',()=>{
  const store=new Store(':memory:');try{
    store.capture(item,[evidence]);store.prepareDelivery('first','email','a@b','frozen',[item.key]);
    assert.equal(store.alreadyRecommended(item.key),true);store.transitionDelivery('first','cancelled',{reason:'人工取消'});
    assert.equal(store.alreadyRecommended(item.key),false);assert.equal(store.beginDelivery('first'),false);
    assert.equal(store.deliveryItems('first').length,1);assert.equal(store.delivery('first').body,'frozen');
    store.prepareDelivery('next','email','a@b','next',[item.key]);assert.equal(store.alreadyRecommended(item.key),true);
    store.beginDelivery('next');assert.throws(()=>store.transitionDelivery('next','cancelled'));
    store.recoverDeliveries();assert.equal(store.delivery('next').state,'uncertain');assert.throws(()=>store.transitionDelivery('next','cancelled'));
  }finally{store.close();}
});

test('投递冻结目标和清单，恢复原指纹，不把后来变化预留到旧邮件',()=>{
  const store=new Store(':memory:');try{
    store.capture(item,[evidence]);const old=store.fingerprint(item.key);store.prepareDelivery('first','email','a@b','frozen',[item.key]);
    assert.throws(()=>store.prepareDelivery('first','email','other@b','frozen',[item.key]),(e:any)=>e.code==='BATCH_EXISTS');
    assert.throws(()=>store.prepareDelivery('first','email','a@b','frozen',[]),(e:any)=>e.code==='RESERVATION_CONFLICT');
    store.db.exec('DELETE FROM recommendations');store.capture(item,[{...evidence,text:'later content'}]);
    store.prepareDelivery('first','email','a@b','frozen',[item.key]);
    assert.equal(store.alreadyRecommended(item.key),false);assert.equal((store.db.prepare('SELECT fingerprint FROM recommendations').get() as any).fingerprint,old);
    store.prepareDelivery('empty','email','a@b','empty');assert.throws(()=>store.prepareDelivery('empty','email','a@b','empty',[item.key]),(e:any)=>e.code==='RESERVATION_CONFLICT');
  }finally{store.close();}
});

test('不同有效批次不可抢占同一内容预留，冲突时新outbox整体回滚',()=>{
  const store=new Store(':memory:');try{
    store.capture(item,[evidence]);store.prepareDelivery('first','email','a@b','one',[item.key]);
    assert.throws(()=>store.prepareDelivery('second','email','a@b','two',[item.key]),(e:any)=>e.code==='RESERVATION_CONFLICT');
    assert.equal(store.delivery('second'),undefined);assert.equal((store.db.prepare('SELECT delivery_id FROM recommendations').get() as any).delivery_id,'first');
  }finally{store.close();}
});

test('outbox已提交但job未完成时，零网络零模型恢复原冻结正文；活租约不被接管',async()=>{
  const dir=temporary(),store=new Store(':memory:');try{
    store.saveTopic(topic);const input=options(store,dir),first:any=await runGithub({recipient:'reader@example.com',...input}),body=store.delivery(first.deliveryId).body;
    store.db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(first.jobId);
    input.source.trending=async()=>{throw Error('不应访问网络');};input.runner.assess=async()=>{throw Error('不应调用模型');};
    const result:any=await runGithub({recipient:'reader@example.com',...input});assert.equal(result.state,'prepared');assert.equal(result.recovered,true);assert.equal(store.delivery(first.deliveryId).body,body);
    const lease=store.claim(first.jobId,'other',10000)!;assert.ok(lease);
    assert.equal((await runGithub({recipient:'reader@example.com',...input})).state,'already_claimed_or_completed');
    store.checkpoint(first.jobId,lease.token,{},10000);store.finish(first.jobId,lease.token);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('模型失败后重跑复用同批次已归档材料，不重新消耗正文请求',async()=>{
  const dir=temporary(),store=new Store(':memory:');try{
    store.saveTopic(topic);const input=options(store,dir);let reads=0;const original=input.source.read.bind(input.source);
    input.source.read=async(...args)=>{reads++;return original(...args);};
    input.runner.assess=async()=>{throw Error('离线模拟一次模型失败');};
    const failed:any=await runGithub({recipient:'reader@example.com',...input});assert.equal(failed.state,'needs_validation');assert.equal(reads,1);
    const resumed:any=await runGithub({recipient:'reader@example.com',...input,runner:new FixtureRunner()});assert.equal(resumed.state,'prepared');assert.equal(resumed.selected,1);assert.equal(reads,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('凭证解析和MCP错误不返回凭证片段，未知异常只返回稳定错误',async()=>{
  const dir=temporary(),marker='FAKE741_secret_not_real';try{
    const file=join(dir,'credential.json');writeFileSync(file,'{"sessdata":'+marker+'}');
    let calls=0;const source=new BilibiliSource({credentialFile:file,fetcher:async()=>{calls++;throw Error('不应联网');}});
    await assert.rejects(()=>source.search('test'),(e:any)=>e.code==='CREDENTIAL_INVALID'&&!e.message.includes('FAKE741'));assert.equal(calls,0);
    const config=writeConfig(dir);writeFileSync(config,JSON.stringify({dataDir:join(dir,'data'),bilibili:{credentialFile:file}}));
    const messages=[{jsonrpc:'2.0',id:1,method:'initialize'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'radar_bilibili_search',arguments:{keyword:'test'}}}];
    const result=await runProcess(process.execPath,[resolve(APP_ROOT,'src/mcp.ts')],messages.map(m=>JSON.stringify(m)).join('\n')+'\n',{cwd:APP_ROOT,env:{THEME_RADAR_CONFIG:config},timeoutMs:5000});
    assert.ok(!result.stdout.includes('FAKE741'));assert.ok(result.stdout.includes('CREDENTIAL_INVALID'));
    assert.deepEqual(publicError(new Error(marker)),{code:'INTERNAL_ERROR',message:'操作未完成，请查看本地诊断状态后重试'});
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('HTTP错误JSON不会回显原文片段，继续拒绝跨站写入',async()=>{
  const dir=temporary(),previous=process.env.THEME_RADAR_CONFIG;let server;try{
    process.env.THEME_RADAR_CONFIG=writeConfig(dir);server=await startOperator(0);if(!server.listening)await once(server,'listening');
    const base='http://127.0.0.1:'+(server.address() as any).port,state=await(await fetch(base+'/api/state')).json();
    const headers={'Content-Type':'application/json','X-Radar-Token':state.token};
    const response=await fetch(base+'/api/topics',{method:'POST',headers,body:'{"sessdata":FAKE741_secret}'}),text=await response.text();
    assert.equal(response.status,400);assert.ok(text.includes('INVALID_INPUT'));assert.ok(!text.includes('FAKE741'));
    assert.equal((await fetch(base+'/api/topics',{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:'{}'})).status,403);
    const seed=new Store(join(dir,'data','radar.sqlite'));try{seed.prepareDelivery('cancel-test','email','a@b','synthetic');}finally{seed.close();}
    const list=await(await fetch(base+'/api/deliveries')).json();assert.equal(list.deliveries[0].state,'prepared');assert.equal(list.deliveries[0].body,undefined);
    assert.equal((await fetch(base+'/api/deliveries/cancel',{method:'POST',headers,body:JSON.stringify({id:'cancel-test',reason:''})})).status,400);
    assert.equal((await fetch(base+'/api/deliveries/cancel',{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:JSON.stringify({id:'cancel-test',reason:'test'})})).status,403);
    const cancelled=await(await fetch(base+'/api/deliveries/cancel',{method:'POST',headers,body:JSON.stringify({id:'cancel-test',reason:'离线测试取消'})})).json();assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.emailSent,false);
    assert.equal((await fetch(base+'/api/deliveries/cancel',{method:'POST',headers,body:JSON.stringify({id:'cancel-test',reason:'重复'})})).status,400);
  }finally{if(server)await new Promise<void>(r=>server.close(()=>r()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;rmSync(dir,{recursive:true,force:true});}
});

test('共享冷却跨进程账本和早晚批次生效，面板从同一状态读取且不依赖报告文件',async()=>{
  const dir=temporary(),file=join(dir,'shared.sqlite'),store=new Store(file);let other:Store|undefined;try{
    store.saveTopic(topic);let calls=0;const source=new GitHubSource(async(url)=>{calls++;return url.includes('/repos/')?new Response('limited',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.ceil(Date.now()/1000)+600)}}):mockFetch(url);});
    const first:any=await runGithub({recipient:'reader@example.com',...options(store,dir),source});assert.equal(first.state,'needs_validation');
    const before=calls;other=new Store(file);const nextSource=new GitHubSource(async()=>{calls++;throw Error('不应联网');},other);
    const next:any=await runGithub({recipient:'reader@example.com',...options(other,dir),source:nextSource,batch:batchAt('2026-10-19','18:00')});assert.equal(next.state,'rate_limited');assert.equal(calls,before);
    assert.equal(capabilityReport(sampleConfig(dir),other).capabilities.find(c=>c.id==='github')!.state,'rate_limit_cooldown');
    assert.equal(other.cooldowns('github:',Date.now()+86400000).length,0);
    assert.ok(!JSON.stringify(other.cooldowns()).includes(process.env.GITHUB_TOKEN||'never-a-token'));
  }finally{other?.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('限流按core/search和授权作用域隔离；次级限流跨资源保护',async()=>{
  const store=new Store(':memory:'),previous=process.env.GITHUB_TOKEN;try{
    delete process.env.GITHUB_TOKEN;let calls=0;const source=new GitHubSource(async(url)=>{calls++;return mockFetch(url);},store);
    const prefix=source.scopePrefix();store.setCooldown(prefix+'core',new Date(Date.now()+600000).toISOString());
    await source.search(topic);assert.equal(calls,1);await assert.rejects(()=>source.read('sample/tool'),(e:any)=>e.code==='RATE_LIMITED');assert.equal(calls,1);
    process.env.GITHUB_TOKEN='SYNTHETIC_ONLY_TOKEN';assert.equal(source.cooldown(),null);await source.search(topic);assert.equal(calls,2);
    store.setCooldown(source.scopePrefix()+'secondary',new Date(Date.now()+600000).toISOString());await assert.rejects(()=>source.search(topic),(e:any)=>e.code==='RATE_LIMITED');assert.equal(calls,2);
    assert.ok(!JSON.stringify(store.cooldowns()).includes('SYNTHETIC_ONLY_TOKEN'));
  }finally{if(previous===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=previous;store.close();}
});

test('截止后仓库只读元数据，旧仓库只补发布信息；不污染已有完整档案指纹',async()=>{
  for(const mode of ['future','old','release']){const urls:string[]=[],source=new GitHubSource(async(url)=>{
    urls.push(url);if(url==='https://api.github.com/repos/sample/tool')return Response.json({full_name:'sample/tool',created_at:'2020-01-01T00:00:00Z',pushed_at:mode==='future'?morning.endAt:'2020-01-02T00:00:00Z'});
    if(url.endsWith('/releases/latest'))return mode==='release'?Response.json({tag_name:'v2',published_at:'2026-10-18T13:00:00Z'}):new Response('',{status:404});
    return mockFetch(url);
  });const result=await source.read('sample/tool',{window});assert.equal(urls.length,mode==='future'?1:mode==='old'?2:6);assert.equal(result.evidence.some(e=>e.kind==='readme'),mode==='release');}
  const dir=temporary(),store=new Store(':memory:');try{
    store.saveTopic({...topic,repositories:['sample/tool']});store.capture(item,[evidence]);const fingerprint=store.fingerprint(item.key);
    const source=new GitHubSource(async(url)=>url==='https://api.github.com/repos/sample/tool'?Response.json({full_name:'sample/tool',created_at:morning.endAt}):mockFetch(url));
    const result:any=await runGithub({recipient:'reader@example.com',...options(store,dir),source});assert.equal(result.filtered.at_or_after_end,1);assert.equal(store.fingerprint(item.key),fingerprint);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('搜索向上游提交固定截止时间，预算前过滤截止后/空仓/归档但保留低Star探索',async()=>{
  let query='';const source=new GitHubSource(async(url)=>{query=new URL(url).searchParams.get('q')!;return Response.json({items:[
    {full_name:'x/future',created_at:morning.endAt,size:1},{full_name:'x/empty',size:0},{full_name:'x/archived',archived:true,size:1},
    {full_name:'x/new',stargazers_count:0,size:1,created_at:morning.startAt}
  ]});});
  const result=await source.search(topic,10,window);assert.deepEqual(result.items.map(i=>i.repo),['x/new']);assert.ok(query.includes('pushed:2026-10-12T01:00:00Z..2026-10-19T00:59:59Z'));assert.ok(query.includes('created:<2026-10-19T01:00:00Z'));
});

test('发布活动查询失败不能被当作无新活动，保留未完成而不准备投递',async()=>{
  const dir=temporary(),store=new Store(':memory:');try{
    store.saveTopic(topic);const source=new GitHubSource(async(url)=>url.endsWith('/releases/latest')?new Response('temporary outage',{status:503}):mockFetch(url));
    const result:any=await runGithub({recipient:'reader@example.com',...options(store,dir),source});assert.equal(result.state,'needs_validation');assert.equal(result.collectionWindows[0].completed,false);assert.equal(store.stats().deliveries,0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('精选配置经runConfigured和档案预览生效，仍保留最多5项上限',async()=>{
  const dir=temporary(),store=new Store(':memory:');const oldRead=GitHubSource.prototype.read,oldSearch=GitHubSource.prototype.search,oldTrending=GitHubSource.prototype.trending,oldAssess=HostRunner.prototype.assess;
  try{
    store.saveTopic(topic);GitHubSource.prototype.search=async()=>({items:Array.from({length:7},(_,i)=>({repo:'sample/tool'+i,stars:i})),incomplete:false,total:7,query:'synthetic'} as any);
    GitHubSource.prototype.read=async(repo)=>({item:{...item,key:'github:'+repo,externalId:repo,title:repo,publishedAt:new Date(Date.now()-3600000*12).toISOString()},evidence:[{...evidence,itemKey:'github:'+repo}],warnings:[]});
    GitHubSource.prototype.trending=async()=>({rows:[{repo:'sample/tool',rank:1,url:item.url,observedAt:new Date().toISOString(),stars:1,starsToday:1,description:'sample',language:null,source:'fixture'}],html:'fixture',collectedAt:new Date().toISOString()});
    HostRunner.prototype.assess=async(_topic,i,materials)=>({itemKey:i.key,selected:true,reason:'离线配置验证',readEvidenceIds:materials.map(e=>e.id!),limitations:['未实跑模型'],agent:'fixture',simulation:true});
    const config=sampleConfig(dir);config.limits.candidates=7;config.limits.selected=1;
    const result:any=await runConfigured(config,store);assert.equal(result.selected,1);assert.equal(result.selectedLimit,1);
    assert.equal(archivePreview(config,store).selected,1);
    // This branch tests the selected limit, so use activity inside its fixed
    // batch instead of mixing today's wall clock with a historical deadline.
    GitHubSource.prototype.read=async(repo)=>({item:{...item,key:'github:'+repo,externalId:repo,title:repo,publishedAt:'2026-10-18T12:00:00Z'},evidence:[{...evidence,itemKey:'github:'+repo}],warnings:[]});
    const other=new Store(':memory:');try{other.saveTopic(topic);const capped:any=await runGithub({recipient:'reader@example.com',...options(other,dir),limit:7,selectedLimit:99,batch:batchAt('2026-10-19','18:00')});assert.equal(capped.selected,5);}finally{other.close();}
  }finally{GitHubSource.prototype.read=oldRead;GitHubSource.prototype.search=oldSearch;GitHubSource.prototype.trending=oldTrending;HostRunner.prototype.assess=oldAssess;store.close();rmSync(dir,{recursive:true,force:true});}
});
