import {videoBody} from './fixtures.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../src/store.ts';import {runInterestRound,interestScore,notifiedVideoKeys,lastInterestRun,interestCounts} from '../src/interest-round.ts';
import {analyzeArchived} from '../src/archive-reading.ts';import {readBilibiliSample} from '../src/bilibili-sample.ts';
import {RadarError,validateTopic} from '../src/model.ts';import type {Topic} from '../src/model.ts';
import {withAsrFallback} from '../src/asr-fallback.ts';
import {beijingDate,batchAt,deliveryKey} from '../src/time.ts';
const topic:Topic={id:'interest',name:'兴趣测试',description:'按自动化开发兴趣阅读',keywords:['自动化','MCP','AI'],exclude:['广告'],platforms:['bilibili'],bilibiliDiscovery:'interests',bilibiliAuthors:[],enabled:true};
const bv=(n:number)=>'BV'+String(n).padStart(10,'0');
const candidate=(n:number,author=String(n))=>({bvid:bv(n),title:'MCP 自动化工具 '+n,authorId:author,publishedAt:'2020-01-01T00:00:00Z'});
test('真实阅读计数区分取得/缓存、新判断/复用及薄正文跳过，不把尝试数说成新读数',()=>{assert.deepEqual(interestCounts({results:[{state:'assessed',selected:true,reused:true,acquisition:{cached:true}},{state:'assessed',selected:false,reused:false,acquisition:{cached:false}},{state:'insufficient_body',selected:false,acquisition:{cached:true}}]}),{attempted:3,newSourceReads:1,cachedMaterials:2,assessed:2,newAssessments:1,reusedAssessments:1,selected:1,insufficientBody:1});});
function setup(t:any){const dir=mkdtempSync(join(tmpdir(),'radar-interest-')),store=new Store(':memory:');store.saveTopic(topic);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});let models=0,reads=0;
 const source={recommendations:async()=>({items:[candidate(1),candidate(2),candidate(3),candidate(4)],authenticated:true}),search:async()=>[],read:async(bvid:string,options:any)=>{reads++;return {item:{key:'bilibili:'+bvid,platform:'bilibili' as const,externalId:bvid,title:'MCP 自动化工具',url:'https://www.bilibili.com/video/'+bvid,authorId:options.expectedAuthorUid,author:'用户UP',publishedAt:'2020-01-01T00:00:00Z',discoveredAt:new Date().toISOString(),version:'video',metadata:{}},evidence:[{itemKey:'bilibili:'+bvid,kind:'subtitle',text:videoBody,url:'https://www.bilibili.com/video/'+bvid,collectedAt:new Date().toISOString(),coverage:{material:'字幕',expected:1,acquired:1,processed:0,state:'unread' as const,method:'fixture'}}],warnings:[]};}};
 const runner={name:'test',assess:async(_topic:any,item:any,evidence:any[])=>{models++;return {itemKey:item.key,selected:true,reason:'测试工具机制',summaryZh:'介绍一个自动化工具与可复用开发流程。',flow:{steps:['输入资料','整理输出'],basis:'overview' as const,evidenceIds:[]},readEvidenceIds:evidence.filter(e=>e.kind==='subtitle').map(e=>e.id),limitations:[],agent:'test',simulation:false};}};
 const analyze=(topicId:string,itemKey:string,signal?:AbortSignal,commitGuard?:()=>void)=>analyzeArchived({store,runner,topicId,itemKey,signal,commitGuard});
 const run=(change:any={})=>runInterestRound({store,dataDir:dir,topicId:topic.id,source,analyze,...change});return{dir,store,source,run,analyze,models:()=>models,reads:()=>reads};
}
test('兴趣关键词边界与排除词；兴趣模式不能混入作者白名单',()=>{assert.equal(interestScore({...candidate(1),title:'chair'},topic),0);assert.equal(interestScore({...candidate(1),title:'AI工具'},topic),1);assert.equal(interestScore({...candidate(1),title:'广告 MCP'},topic),-1);assert.throws(()=>validateTopic({...topic,bilibiliAuthors:['123']}));});
test('确认邮件/未知投递及旧样张链接全局去重；取消投递不拦截',t=>{const{store}=setup(t);for(const [n,state] of [[1,'sent_confirmed'],[2,'uncertain'],[3,'cancelled']] as const){const id='verification:'+n;store.prepareDelivery(id,'email','reader@example.com',JSON.stringify({text:'https://www.bilibili.com/video/'+bv(n)}));if(state==='cancelled')store.cancelPrepared(id,'test');else{store.beginDelivery(id);store.transitionDelivery(id,state==='sent_confirmed'?'submitted':'uncertain');if(state==='sent_confirmed')store.transitionDelivery(id,'sent_confirmed');}}
 const keys=notifiedVideoKeys(store);assert.equal(keys.has('bilibili:'+bv(1)),true);assert.equal(keys.has('bilibili:'+bv(2)),true);assert.equal(keys.has('bilibili:'+bv(3)),false);
});
test('一轮最多3视频，读取正文后才分析与冻结；旧推荐视频不冒充当天投稿',async t=>{const x=setup(t),r=await x.run();assert.equal(r.results.length,3);assert.equal(x.models(),3);assert.equal(r.sample.count,3);assert.equal(r.discovered,4);assert.equal(r.emailSent,false);assert.equal(x.store.deliveries().length,0);const body=readBilibiliSample(x.dir,r.sample.id);assert.equal(body.entries.length,3);assert.ok(body.entries.every(e=>e.publishedAt==='2020-01-01T00:00:00Z'));assert.equal(lastInterestRun(x.dir).id,r.id);const second=await x.run();assert.equal(x.models(),3);assert.ok(second.results.every(r=>r.reused));assert.equal(x.reads(),3);});
test('发送过的样张视频不再读取，优先来自不同作者',async t=>{const x=setup(t);x.source.recommendations=async()=>({items:[candidate(1,'11'),candidate(2,'11'),candidate(3,'22'),candidate(4,'33')],authenticated:true});x.store.prepareDelivery('sent','email','reader@example.com',JSON.stringify({text:'https://www.bilibili.com/video/'+bv(1)}));x.store.beginDelivery('sent');x.store.transitionDelivery('sent','submitted');x.store.transitionDelivery('sent','sent_confirmed');const r=await x.run();assert.equal(r.results.length,3);assert.ok(!r.results.some(r=>r.itemKey==='bilibili:'+bv(1)));assert.equal(new Set(r.results.map(r=>r.authorUid)).size,3);});
test('同主题跨宿主租约拒绝并行；结束后允许新轮次',async t=>{const x=setup(t);let release:any;const gate=new Promise<void>(r=>release=r);x.source.recommendations=async()=>{await gate;return {items:[],authenticated:true};};const first=x.run();await assert.rejects(x.run(),{code:'ROUND_BUSY'});release();assert.equal((await first).stage,'finished');assert.equal((await x.run()).stage,'finished');});
test('推荐身份未确认或认证失败不继续搜索与读取',async t=>{for(const reason of ['anonymous','failure']){const x=setup(t);let searches=0;x.source.search=async()=>{searches++;return[];};x.source.recommendations=async()=>{if(reason==='failure')throw new RadarError('AUTH_REQUIRED','未登录');return {items:[candidate(1)],authenticated:false};};const r=await x.run();assert.equal(r.stoppedReason,'AUTH_REQUIRED');assert.equal(searches,0);assert.equal(x.reads(),0);}});
test('搜索来源失败保留有效推荐，停止继续请求该搜索接口',async t=>{const x=setup(t);let calls=0;x.source.search=async()=>{calls++;throw new RadarError('ACCESS_DENIED','搜索受限');};const r=await x.run();assert.equal(calls,1);assert.equal(r.discoveryPartial,true);assert.equal(r.results.length,3);assert.equal(r.sample.count,3);});
test('无字幕不能凭简介或弹幕进入模型与邮件',async t=>{const x=setup(t),original=x.source.read;x.source.read=async(...args)=>{const r=await original(...args);r.evidence[0].kind='description';return r;};const r=await x.run();assert.equal(x.models(),0);assert.equal(r.sample,undefined);assert.ok(r.results.every(r=>r.state==='no_subtitle'));});

test('稀疏ASR即使标题与长简介命中也不调用模型、不进入草稿，原文仍留档',async t=>{
 const x=setup(t),read=x.source.read;x.source.read=async(...args)=>{const r=await read(...args);r.evidence[0].kind='asr:p1';r.evidence[0].text='请大家看一条简体中文的语音转写，这次是将所有的语音转写成绩的语音转写。';r.evidence.push({...r.evidence[0],kind:'description',text:videoBody.repeat(5)});return r;};
 const r=await x.run();assert.equal(x.models(),0);assert.equal(r.sample,undefined);assert.ok(r.results.every(v=>v.state==='insufficient_body'&&!v.selected));assert.equal(x.store.stats().items,3);assert.equal(x.store.currentEvidence('bilibili:'+bv(1)).length,2);
});
test('读取期间改兴趣主题或取消，返回材料不归档不调用模型',async t=>{for(const kind of ['topic','cancel']){const x=setup(t),original=x.source.read,controller=new AbortController();x.source.read=async(...args)=>{const r=await original(...args);if(kind==='topic')x.store.saveTopic({...topic,name:'修改'},1);else controller.abort();return r;};const r=await x.run({signal:controller.signal});assert.equal(r.stoppedReason,kind==='topic'?'TOPIC_CHANGED':'CANCELLED');assert.equal(x.store.stats().items,0);assert.equal(x.models(),0);assert.equal(r.sample,undefined);}});
test('模型错误后停止后续付费调用，不自动重试',async t=>{const x=setup(t);let calls=0;const r=await x.run({analyze:async()=>{calls++;throw new RadarError('MODEL_QUOTA_EXCEEDED','额度');}});assert.equal(calls,1);assert.equal(r.stoppedReason,'MODEL_QUOTA_EXCEEDED');assert.equal(r.sample,undefined);});
test('候选多于预算截至20，阅读预算在联网前拒绝',async t=>{const x=setup(t);x.source.recommendations=async()=>({items:Array.from({length:100},(_,i)=>candidate(i+1)),authenticated:true});const r=await x.run({readLimit:1});assert.equal(r.discovered,20);assert.equal(x.models(),1);await assert.rejects(x.run({readLimit:4}),{code:'INVALID_BUDGET'});});
test('已有P2字幕不能冒充本轮P1，必须重新读取目标分P',async t=>{const x=setup(t),old=await x.source.read(bv(1),{expectedAuthorUid:'1'});old.evidence[0].kind='subtitle:p2';x.store.capture(old.item,old.evidence);const before=x.reads(),r=await x.run({readLimit:1});assert.equal(x.reads(),before+1);assert.equal(r.results[0].state,'assessed');assert.ok(r.sample);});
test('外层轮次租约在模型提交前被接管，内层阅读租约不能越权写判断',async t=>{const x=setup(t);const r=await x.run({readLimit:1,analyze:async(topicId,itemKey,signal,guard)=>{x.store.db.prepare('UPDATE jobs SET token=? WHERE id=?').run('other-host','interest-round:'+topic.id);return x.analyze(topicId,itemKey,signal,guard);}});assert.equal(r.stoppedReason,'LEASE_LOST');assert.equal(x.store.stats().assessments,0);assert.equal(r.sample,undefined);});
test('模型运行期间其他投递已预留相同视频，冻结阶段再次全局去重',async t=>{const x=setup(t);const r=await x.run({readLimit:1,analyze:async(...args)=>{const a=await x.analyze(...args);x.store.prepareDelivery('other-pending','email','reader@example.com',JSON.stringify({text:'https://www.bilibili.com/video/'+bv(1)}));return a;}});assert.equal(r.sample,undefined);assert.equal(r.sampleIssue,'ALREADY_NOTIFIED');});
test('显式精选键不被最近100档案截断，旧视频无需伪造更新时间',async t=>{const x=setup(t);await x.run({readLimit:1});const old=x.store.item('bilibili:'+bv(1)),ev=x.store.currentEvidence(old.key);for(let i=1000;i<1101;i++){const b=bv(i),key='bilibili:'+b;x.store.capture({...old,key,externalId:b,url:'https://www.bilibili.com/video/'+b},ev.map(e=>({...e,itemKey:key})));}x.store.db.prepare('UPDATE items SET updated_at=? WHERE key=?').run('2000-01-01T00:00:00Z',old.key);assert.equal(x.store.search('',{platform:'bilibili',limit:100}).some(i=>i.key===old.key),false);const r=await x.run({readLimit:1});assert.equal(r.sample.count,1);assert.equal(x.models(),1);assert.equal(readBilibiliSample(x.dir,r.sample.id).entries[0].itemKey,old.key);});
test('轮次取得范围区分新字幕与归档复用，并保留模型引用事实',async t=>{
 const x=setup(t),first=await x.run({readLimit:1}),a=first.results[0].acquisition;
 assert.equal(a.cached,false);assert.equal(a.agentRead,true);assert.deepEqual(a.videoText,[{kind:'subtitle',characters:videoBody.length}]);
 const second=await x.run({readLimit:1});assert.equal(second.results[0].acquisition.cached,true);assert.equal(second.results[0].acquisition.agentRead,true);
});
test('ASR读取遭遇鉴权、拒绝或限流，保存失败范围后停止后续视频且不调用模型',async t=>{
 for(const code of ['AUTH_REQUIRED','CREDENTIAL_INVALID','ACCESS_DENIED','RATE_LIMITED']){
  const x=setup(t),original=x.source.read;let audioCalls=0;
  x.source.read=async(...args)=>{const r=await original(...args);r.item.metadata={requestedPages:[1],subtitlePages:[{page:1,cid:'123',duration:30,state:'unavailable',reason:'no_track_exposed'}]};r.evidence=[];
   return withAsrFallback(r,{enabled:true,pythonCommand:'fixture',modelDir:'fixture',workDir:x.dir,audio:async()=>{audioCalls++;throw new RadarError(code,'fixture');}});
  };
  const r=await x.run();assert.equal(r.stoppedReason,code);assert.equal(r.results.length,1);assert.equal(audioCalls,1);assert.equal(x.models(),0);assert.equal(r.results[0].acquisition.asr[0].reason,code);assert.equal(r.results[0].acquisition.agentRead,false);assert.equal(r.sample,undefined);
 }
});
test('空ASR可继续其他候选，但不能进入筛选或把失败记作模型已读',async t=>{
 const x=setup(t),original=x.source.read;
 x.source.read=async(...args)=>{const r=await original(...args);r.evidence=[];r.item.metadata={asrPages:[{page:1,state:'insufficient_text',reason:'ASR_EMPTY',sourceDuration:30}]};return r;};
 const r=await x.run();assert.equal(r.results.length,3);assert.equal(r.stoppedReason,undefined);assert.equal(x.models(),0);assert.ok(r.results.every(v=>v.acquisition.videoText.length===0&&!v.acquisition.agentRead));
});
test('ASR正文与时间轴分开显示，未引用视频正文不能显示模型已读',async t=>{
 const x=setup(t),original=x.source.read;x.source.read=async(...args)=>{const r=await original(...args);r.evidence[0].kind='asr:p1';r.evidence.push({...r.evidence[0],kind:'asr-timeline:p1',text:'not video text'});r.item.metadata={asrPages:[{page:1,state:'acquired',characters:r.evidence[0].text.length,processedRange:{from:0,to:30}}]};return r;};
 const r=await x.run({readLimit:1,analyze:async()=>({assessment:{selected:false,simulation:false,readEvidenceIds:[]}})});
 assert.deepEqual(r.results[0].acquisition.videoText,[{kind:'asr:p1',characters:videoBody.length}]);assert.equal(r.results[0].acquisition.agentRead,false);assert.equal(r.results[0].acquisition.asr[0].processedRange.to,30);
});
test('耗时读取前已写入当前视频进度，恢复页无需等待整轮完成',async t=>{
 const x=setup(t),original=x.source.read;let release!:()=>void;const gate=new Promise<void>(r=>release=r);x.source.read=async(...args)=>{await gate;return original(...args);};const pending=x.run({readLimit:1});
 try{await new Promise(r=>setImmediate(r));const job=x.store.job('interest-round:'+topic.id),cursor=JSON.parse(job.data);assert.equal(cursor.stage,'reading');assert.equal(cursor.progress.results[0].itemKey,'bilibili:'+bv(1));assert.equal(cursor.progress.discovered,4);assert.equal(lastInterestRun(x.dir),null);}finally{release();await pending;}
});
test('冻结草稿按每日剩余额度截取，其他已选判断留档，不先生成无法领取的三条邮件',async t=>{
 const x=setup(t),reserved:string[]=[];for(let n=100;n<104;n++){const r=await x.source.read(bv(n),{expectedAuthorUid:String(n)});x.store.capture(r.item,r.evidence);reserved.push(r.item.key);}
 const batch=batchAt(beijingDate(),'09:00');x.store.prepareDelivery(deliveryKey('reader@example.org',batch),'email','reader@example.org','{}',reserved);
 const r=await x.run();assert.equal(r.results.filter(v=>v.selected).length,3);assert.equal(r.sample.count,1);assert.equal(r.dailySelectedRemainingAtFreeze,1);assert.equal(r.deferredSelected,2);assert.equal(x.store.assessments(topic.id).length,3);assert.equal(x.store.deliveries().length,1);
});
