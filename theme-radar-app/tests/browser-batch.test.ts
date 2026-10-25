import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.ts';
import {BrowserBatchBridge,browserBatchFailureCodes} from '../src/browser-batch.ts';
import {importAuthorObservation} from '../src/author-observation.ts';
import {importBrowserSubtitles} from '../src/browser-subtitles.ts';
import {topic,item,evidence} from './fixtures.ts';

const origin='chrome-extension://'+'a'.repeat(32),otherOrigin='chrome-extension://'+'b'.repeat(32);
const ids=['BV1234567890','BV1234567891','BV1234567892','BV1234567893'],keys=ids.map(id=>'bilibili:'+id);
const subscription={...topic,id:'batch-fixture',platforms:['bilibili'] as any,bilibiliAuthors:['123']};
function setup(fileBacked=false){
 const dir=mkdtempSync(join(tmpdir(),'radar-batch-')),store=new Store(fileBacked?join(dir,'ledger.sqlite'):':memory:');let at=Date.now()-1000;
 store.saveTopic(subscription);
 importAuthorObservation(store,dir,subscription.id,{schema:'theme-radar-visible-author-v1',pageUrl:'https://space.bilibili.com/123/upload/video',authorUid:'123',observedAt:new Date(at).toISOString(),items:ids.map(bvid=>({bvid,url:'https://www.bilibili.com/video/'+bvid,title:'离线视频'})),truncated:false});
 const videos=ids.map(bvid=>({...item,key:'bilibili:'+bvid,externalId:bvid,platform:'bilibili' as const,authorId:'123',url:'https://www.bilibili.com/video/'+bvid,metadata:{subtitlePages:[{page:1,cid:'1',duration:20},{page:2,cid:'2',duration:10}]}}));
 const capture=(index:number,text='离线简介',kind='description')=>store.capture(videos[index],[{...evidence,itemKey:keys[index],kind,text}]);
 videos.forEach((_v,i)=>capture(i));
 const bridge=new BrowserBatchBridge(store,dir,()=>at);
 const payload=(index=0)=>({schema:'theme-radar-visible-subtitles-v1',bvid:ids[index],page:1,duration:20,startedAt:new Date(at).toISOString(),endedAt:new Date(at+500).toISOString(),observedFrom:0,observedTo:20,segments:[{from:1,to:10,text:'合成字幕夹具'}],truncated:false,captureStatus:'ended'});
 const paired=(indices=[0])=>{const grant=bridge.create(subscription.id,indices.map(i=>keys[i]));return {grant,...bridge.pair(grant.pairCode,origin)};};
 return {dir,store,bridge,payload,paired,capture,videos,advance:(ms:number)=>{at+=ms;},close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('手动grant仅冻结当前队列3条以内，状态与日志不泄露配对码和token',()=>{
 const f=setup();try{const {grant,token}=f.paired([0,1,2]);assert.match(grant.pairCode,/^[A-F0-9]{12}$/);assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.equal(grant.items.length,3);assert.ok(grant.items.every(i=>i.page===1&&i.duration===20));
 const status=JSON.stringify(f.bridge.publicStatus());assert.ok(!status.includes(grant.pairCode));assert.ok(!status.includes(token));assert.ok(!/pairHash|tokenHash|origin|readingSnapshot/.test(status));assert.equal(f.store.stats().assessments,0);assert.equal(f.store.stats().deliveries,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM logs').get().n,0);
 assert.throws(()=>f.bridge.create(subscription.id,keys),{code:'INVALID_BROWSER_BATCH'});assert.throws(()=>f.bridge.create(subscription.id,[]));assert.throws(()=>f.bridge.create(subscription.id,[keys[0],keys[0]]));assert.throws(()=>f.bridge.create(subscription.id,[keys[0]]),{code:'BROWSER_BATCH_BUSY'});
 }finally{f.close();}
});

test('一次性配对码和精确扩展Origin绑定，网页和其他扩展不能使用token',()=>{
 const f=setup();try{const grant=f.bridge.create(subscription.id,[keys[0]]);
 for(const bad of ['https://www.bilibili.com','null',origin+'/',origin.replace('chrome-extension','https')])assert.throws(()=>f.bridge.pair(grant.pairCode,bad),{code:'BROWSER_BATCH_PAIR_FAILED'});
 const paired=f.bridge.pair(grant.pairCode,origin);assert.equal(f.bridge.authenticate(paired.token,origin).state,'paired');assert.throws(()=>f.bridge.pair(grant.pairCode,origin),{code:'BROWSER_BATCH_PAIR_FAILED'});
 for(const bad of [otherOrigin,'https://www.bilibili.com',origin+'/',''])assert.throws(()=>f.bridge.authenticate(paired.token,bad),{code:'BROWSER_BATCH_UNAUTHORIZED'});
 assert.throws(()=>f.bridge.authenticate('x'.repeat(43),origin),{code:'BROWSER_BATCH_UNAUTHORIZED'});assert.throws(()=>new BrowserBatchBridge(f.store,f.dir).authenticate(paired.token,origin),{code:'BROWSER_BATCH_UNAUTHORIZED'});
 }finally{f.close();}
});

test('五次无效配对后锁定且不能猜码，2分钟配对码和20分钟会话严格到期',()=>{
 const f=setup();try{const grant=f.bridge.create(subscription.id,[keys[0]]);for(let i=0;i<5;i++)assert.throws(()=>f.bridge.pair('000000000000',origin));assert.equal(f.bridge.publicStatus(grant.batchId).state,'pair_locked');assert.throws(()=>f.bridge.pair(grant.pairCode,origin));
 const second=f.bridge.create(subscription.id,[keys[0]]);f.advance(120_000);assert.throws(()=>f.bridge.pair(second.pairCode,origin));assert.equal(f.bridge.publicStatus(second.batchId).state,'expired');
 const p=f.paired();f.advance(120_000);assert.equal(f.bridge.authenticate(p.token,origin).state,'paired');f.advance(18*60_000);assert.throws(()=>f.bridge.authenticate(p.token,origin));assert.equal(f.bridge.publicStatus(p.grant.batchId).state,'expired');
 }finally{f.close();}
});

test('本地取消立即撤销所有扩展动作，未配对的码也不能再用',()=>{
 const f=setup();try{const p=f.paired();assert.equal(f.bridge.cancelFromOperator(p.grant.batchId).state,'cancelled');for(const action of [()=>f.bridge.authenticate(p.token,origin),()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot:f.payload()}),()=>f.bridge.failItem(p.token,origin,{itemKey:keys[0],code:'NO_VISIBLE_SUBTITLES'})])assert.throws(action,{code:'BROWSER_BATCH_UNAUTHORIZED'});
 const grant=f.bridge.create(subscription.id,[keys[0]]);f.bridge.cancelFromOperator(grant.batchId);assert.throws(()=>f.bridge.pair(grant.pairCode,origin));assert.equal(f.store.currentEvidence(keys[0]).length,1);
 }finally{f.close();}
});

test('导入只保存观察，一次成功后相同payload幂等且改变payload拒绝',()=>{
 const f=setup();try{const p=f.paired([0,1]),snapshot=f.payload();const before=f.store.events().length,fp=f.store.fingerprint(keys[0]);
 const first=f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot});assert.equal(first.duplicate,false);assert.equal(first.result.modelRead,false);assert.equal(first.result.emailSent,false);assert.equal(first.result.fullSubtitleTrackVerified,false);assert.equal(f.store.fingerprint(keys[0]),fp);assert.equal(f.store.currentEvidence(keys[0]).length,3);assert.equal(first.status.items[0].state,'imported');
 const reordered=Object.fromEntries(Object.entries(snapshot).reverse());assert.equal(f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot:reordered}).duplicate,true);assert.equal(f.store.events().length,before+1);
 assert.throws(()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot:{...snapshot,segments:[{from:1,to:10,text:'改变正文'}]}}),{code:'BROWSER_BATCH_ALREADY_IMPORTED'});
 assert.equal(f.bridge.importCapture(p.token,origin,{itemKey:keys[1],snapshot:f.payload(1)}).duplicate,false);assert.equal(f.store.stats().assessments,0);assert.equal(f.store.stats().deliveries,0);
 }finally{f.close();}
});

test('拒绝清单外条目、跨条BV混入、P2、时长不符和额外私密字段且不改账本',()=>{
 const f=setup();try{const p=f.paired(),snapshot=f.payload();
 assert.throws(()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[1],snapshot:f.payload(1)}),{code:'BROWSER_BATCH_ITEM_REQUIRED'});
 for(const bad of [{...snapshot,bvid:ids[1]},{...snapshot,page:2},{...snapshot,duration:40}])assert.throws(()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot:bad}),{code:'VIDEO_MISMATCH'});
 assert.throws(()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot:{...snapshot,cookie:'not accepted'}}));assert.throws(()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot,token:'not accepted'} as any));assert.equal(f.store.currentEvidence(keys[0]).length,1);
 assert.throws(()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot:{...snapshot,startedAt:new Date(Date.parse(snapshot.startedAt)-2000).toISOString()}}),{code:'BROWSER_BATCH_CAPTURE_TIME'});
 }finally{f.close();}
});

test('主题修改、取消订阅和已归档材料变化分别拒绝，不能用旧冻结快照继续导入',()=>{
 for(const change of ['topic','material','owner']){const f=setup();try{const p=f.paired();if(change==='topic')f.store.saveTopic({...subscription,bilibiliAuthors:[]},1);else if(change==='material')f.capture(0,'新简介');else{f.videos[0].authorId='999';f.capture(0);}
 assert.throws(()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot:f.payload()}),{code:change==='topic'?'TOPIC_CHANGED':'SOURCE_CHANGED'});assert.equal(f.store.currentEvidence(keys[0]).length,1);
 if(change==='topic')assert.equal(f.bridge.publicStatus(p.grant.batchId).state,'invalidated');
 }finally{f.close();}}
});

test('成功后若其他人更新材料，相同重试也不能把历史结果冒充当前快照',()=>{
 const f=setup();try{const p=f.paired(),snapshot=f.payload();f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot});f.capture(0,'采集后的新版简介');assert.throws(()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot}),{code:'SOURCE_CHANGED'});
 }finally{f.close();}
});

test('仅限已归档且UID匹配、当前订阅有观察且缺字幕的短视频',()=>{
 const f=setup();try{
 f.videos[0].authorId='999';f.capture(0);assert.throws(()=>f.bridge.create(subscription.id,[keys[0]]),{code:'BROWSER_BATCH_ITEM_REQUIRED'});
 f.capture(1,'已有字幕','subtitle:p1');assert.throws(()=>f.bridge.create(subscription.id,[keys[1]]),{code:'BROWSER_BATCH_ITEM_REQUIRED'});
 f.videos[2].metadata.subtitlePages[0].duration=901;f.capture(2);assert.throws(()=>f.bridge.create(subscription.id,[keys[2]]),{code:'BROWSER_BATCH_DURATION'});
 f.store.saveTopic({...subscription,name:'新主题'},1);assert.throws(()=>f.bridge.create(subscription.id,[keys[3]]),{code:'BROWSER_BATCH_ITEM_REQUIRED'});
 }finally{f.close();}
});

test('失败只接受枚举码，幂等且禁止改写原因或再导入，成功条目不能改为失败',()=>{
 const f=setup();try{const p=f.paired([0,1]);assert.ok(browserBatchFailureCodes.includes('NO_VISIBLE_SUBTITLES'));
 assert.throws(()=>f.bridge.failItem(p.token,origin,{itemKey:keys[0],code:'页面上的私密错误文本'}),{code:'INVALID_BROWSER_BATCH_FAILURE'});
 assert.throws(()=>f.bridge.failItem(p.token,origin,{itemKey:keys[0],code:'NO_VISIBLE_SUBTITLES',message:'not accepted'} as any));
 assert.equal(f.bridge.failItem(p.token,origin,{itemKey:keys[0],code:'NO_VISIBLE_SUBTITLES'}).items[0].state,'failed');assert.equal(f.bridge.failItem(p.token,origin,{itemKey:keys[0],code:'NO_VISIBLE_SUBTITLES'}).items[0].failureCode,'NO_VISIBLE_SUBTITLES');
 assert.throws(()=>f.bridge.failItem(p.token,origin,{itemKey:keys[0],code:'PLAYER_UNAVAILABLE'}),{code:'BROWSER_BATCH_ITEM_STOPPED'});assert.throws(()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot:f.payload()}),{code:'BROWSER_BATCH_ITEM_STOPPED'});
 f.bridge.importCapture(p.token,origin,{itemKey:keys[1],snapshot:f.payload(1)});assert.throws(()=>f.bridge.failItem(p.token,origin,{itemKey:keys[1],code:'IMPORT_FAILED'}),{code:'BROWSER_BATCH_ALREADY_IMPORTED'});
 }finally{f.close();}
});

test('总视频预算预留导航时间，扩展取消和服务关闭都立即撤销token',()=>{
 const f=setup();try{
 f.videos[0].metadata.subtitlePages[0].duration=600;f.capture(0);f.videos[1].metadata.subtitlePages[0].duration=500;f.capture(1);assert.throws(()=>f.bridge.create(subscription.id,[keys[0],keys[1]]),{code:'BROWSER_BATCH_DURATION'});
 const first=f.paired();assert.equal(f.bridge.cancelFromExtension(first.token,origin).state,'cancelled');assert.throws(()=>f.bridge.authenticate(first.token,origin),{code:'BROWSER_BATCH_UNAUTHORIZED'});
 const second=f.paired([1]);f.bridge.revokeAll();assert.deepEqual(f.bridge.publicStatus().batches,[]);assert.throws(()=>f.bridge.authenticate(second.token,origin),{code:'BROWSER_BATCH_UNAUTHORIZED'});
 }finally{f.close();}
});

test('其他SQLite宿主在早期校验后修改主题、作者、分P时长或字幕，事务内冻结检查拒绝过期写入',()=>{
 for(const change of ['topic','author','duration','subtitle']){
  const f=setup(true),other=new Store(join(f.dir,'ledger.sqlite'));
  try{
   const p=f.paired(),snapshot=f.payload(),originalAppend=f.store.appendBrowserObservation.bind(f.store),fingerprint=f.store.fingerprint(keys[0]);let injected=false;
   f.store.appendBrowserObservation=(...args)=>{
    injected=true;
    if(change==='topic')other.saveTopic({...subscription,name:'另一宿主的新订阅'},1);
    if(change==='author')other.capture({...f.videos[0],authorId:'999'},[{...evidence,itemKey:keys[0],kind:'description',text:'离线简介'}]);
    if(change==='duration')other.capture({...f.videos[0],metadata:{subtitlePages:[{page:1,cid:'1',duration:40}]}},[{...evidence,itemKey:keys[0],kind:'description',text:'离线简介'}]);
    if(change==='subtitle')importBrowserSubtitles(other,{...snapshot,segments:[{from:1,to:10,text:'另一宿主已取得的字幕'}]});
    // These races deliberately preserve the base fingerprint; only an in-transaction
    // revision/UID/readingSnapshot check can reject them.
    assert.equal(other.fingerprint(keys[0]),fingerprint);
    return originalAppend(...args);
   };
   assert.throws(()=>f.bridge.importCapture(p.token,origin,{itemKey:keys[0],snapshot}),{code:change==='topic'?'TOPIC_CHANGED':'SOURCE_CHANGED'});
   assert.equal(injected,true);assert.equal(f.bridge.publicStatus(p.grant.batchId).items[0].state,'pending');
   assert.ok(!f.store.currentEvidence(keys[0]).some(e=>e.text==='合成字幕夹具'));
   assert.equal(f.store.currentEvidence(keys[0]).length,change==='subtitle'?3:1);
  }finally{other.close();f.close();}
 }
});
