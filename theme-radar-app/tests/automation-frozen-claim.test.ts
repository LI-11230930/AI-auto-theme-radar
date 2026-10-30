import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {once} from 'node:events';
import {Store} from '../src/store.ts';import {AutomationRuntime} from '../src/automation-runtime.ts';
import {savePlan} from '../src/automation-plan.ts';import {draftView} from '../src/automation-outbox.ts';
import {topic,item,evidence,fixturePlan} from './fixtures.ts';import {hash} from '../src/model.ts';import {MAIL_FORMAT} from '../src/mail.ts';import {beijingDate} from '../src/time.ts';
import {startOperator} from '../src/operator.ts';

function fixture(t:any,delivery='host',file=':memory:'){
 const store=new Store(file),runtime=new AutomationRuntime({operatorUrl:'http://127.0.0.1:18767'},store);t.after(async()=>{await runtime.close();store.close();});
 store.saveTopic({...topic,platforms:['bilibili'],bilibiliDiscovery:'interests'});
 const video={...item,platform:'bilibili' as const,key:'bilibili:BV1234567890',externalId:'BV1234567890',url:'https://www.bilibili.com/video/BV1234567890',metadata:{views:10}};
 store.capture(video,[{...evidence,itemKey:video.key,kind:'subtitle:p1'}]);
 const plan=savePlan(store,fixturePlan({enabled:true,agent:'Codex',platforms:['bilibili'],delivery,sendApproved:true,from:'sender@example.test',recipient:'reader@example.test'}));
 const runId='automation-run:'+hash('frozen-claim'),deliveryId='automation-mail:'+hash(runId);
 const body={kind:'automation-digest',formatVersion:MAIL_FORMAT,simulation:false,verification:false,contentReady:true,runId,planId:plan.id,planRevision:plan.revision,attemptDate:beijingDate(),subject:'离线冻结草稿',text:video.url+'\n用于离线验证的示例。',html:'<p>用于离线验证的示例。</p>',itemKeys:[video.key],itemSnapshots:[{itemKey:video.key,fingerprint:store.fingerprint(video.key),snapshot:store.readingSnapshot(video.key)}]};
 const run={id:runId,planId:plan.id,planRevision:plan.revision,plan,topicRevisions:{sample:1},stage:'awaiting_host_mail',body,deliveryId,preview:'/preview/automation?id='+hash(runId)};
 store.prepareDelivery(deliveryId,'email',plan.recipient!,JSON.stringify(body),body.itemKeys);
 store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(runId,'done','fixture','',0,JSON.stringify(run),'fixture');
 return {store,runtime,plan,run,video,deliveryId,claim:()=>runtime.claimMail({runId,agent:'Codex',from:'sender@example.test'})};
}
function assertNotAttempted(f:any,before:any){assert.deepEqual(f.store.delivery(f.deliveryId),before);assert.equal(f.store.job('automation-attempt:'+hash(f.run.id)),undefined);assert.equal(f.store.alreadyRecommended(f.video.key),true);}
function appendObservation(f:any){const key=f.video.key;f.store.appendBrowserObservation(key,f.store.fingerprint(key),[{...evidence,itemKey:key,kind:'browser-subtitle:p1',text:'新的浏览器可见字幕正文'},{...evidence,itemKey:key,kind:'browser-subtitle-observation:p1',text:'浏览器采集范围说明'}]);}

for(const transport of ['host','smtp'])test(transport+'领取发送前拒绝内容指纹相同但阅读快照已改变的草稿',t=>{
 const f=fixture(t,transport),before=f.store.delivery(f.deliveryId),fingerprint=f.store.fingerprint(f.video.key);appendObservation(f);
 assert.equal(f.store.fingerprint(f.video.key),fingerprint);assert.notEqual(f.store.readingSnapshot(f.video.key),f.run.body.itemSnapshots[0].snapshot);
 assert.equal(draftView(f.runtime.config,f.store,f.run.id).sendReadiness.code,'SOURCE_CHANGED');
 let sends=0;assert.throws(()=>transport==='host'?f.claim():f.runtime.reserveAttempt(f.plan,f.run,()=>{sends++;}),{code:'SOURCE_CHANGED'});assert.equal(sends,0);assertNotAttempted(f,before);
});

test('主题已移除时领取拒绝，不把缺失主题当作未变更',t=>{
 const f=fixture(t),before=f.store.delivery(f.deliveryId);f.store.db.prepare('DELETE FROM subscriptions WHERE id=?').run(topic.id);
 assert.equal(draftView(f.runtime.config,f.store,f.run.id).sendReadiness.code,'TOPIC_CHANGED');assert.throws(f.claim,{code:'TOPIC_CHANGED'});assertNotAttempted(f,before);
});

test('冻结快照清单损坏时预览与领取给出一致拒绝，保留旧正文',t=>{
 const f=fixture(t),before=f.store.delivery(f.deliveryId);f.run.body.itemSnapshots=[];f.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(f.run),f.run.id);
 // Keep both persisted bodies mutually consistent; the source mapping is invalid.
 const body=JSON.stringify(f.run.body);f.store.db.prepare('UPDATE deliveries SET body=?,body_hash=? WHERE id=?').run(body,hash(body),f.deliveryId);const corrupted=f.store.delivery(f.deliveryId);
 assert.equal(draftView(f.runtime.config,f.store,f.run.id).sendReadiness.code,'SOURCE_CHANGED');assert.throws(f.claim,{code:'SOURCE_CHANGED'});assertNotAttempted(f,corrupted);assert.equal(JSON.parse(before.body).text,JSON.parse(corrupted.body).text);
});

test('同一写事务再次核对冻结账本正文，SMTP回调不先执行',t=>{
 const f=fixture(t,'smtp');const body=JSON.stringify({...f.run.body,text:'被替换的冻结正文'});f.store.db.prepare('UPDATE deliveries SET body=?,body_hash=? WHERE id=?').run(body,hash(body),f.deliveryId);const before=f.store.delivery(f.deliveryId);
 let sends=0;assert.throws(()=>f.runtime.reserveAttempt(f.plan,f.run,()=>{sends++;}),{code:'DRAFT_CHANGED'});assert.equal(sends,0);assertNotAttempted(f,before);
});

test('仅互动数变化仍允许原冻结正文领取一次，不制造新的阅读要求',t=>{
 const f=fixture(t),fingerprint=f.store.fingerprint(f.video.key),snapshot=f.store.readingSnapshot(f.video.key);
 f.store.capture({...f.video,metadata:{views:11}},[{...evidence,itemKey:f.video.key,kind:'subtitle:p1'}]);
 assert.equal(f.store.fingerprint(f.video.key),fingerprint);assert.equal(f.store.readingSnapshot(f.video.key),snapshot);assert.equal(draftView(f.runtime.config,f.store,f.run.id).sendReadiness.ready,true);
 const mail=f.claim();assert.equal(mail.text,f.run.body.text);assert.equal(mail.html,f.run.body.html);assert.equal(f.store.delivery(f.deliveryId).state,'submitting');assert.throws(f.claim,{code:'MAIL_ALREADY_CLAIMED'});
});

for(const changed of [false,true])test('自动下一真实本地HTTP领取与预览一致，材料变化='+changed,async t=>{
 const root=mkdtempSync(join(tmpdir(),'radar-frozen-http-')),file=join(root,'config.json'),previous=process.env.THEME_RADAR_CONFIG;
 writeFileSync(file,JSON.stringify({dataDir:root,topics:[],xiaohongshu:{enabled:false}}));process.env.THEME_RADAR_CONFIG=file;
 const f=fixture({after(){}},'host',join(root,'radar.sqlite'));let server:any;
 try{server=await startOperator(0);const base='http://127.0.0.1:'+server.address().port,state=await(await fetch(base+'/api/state')).json() as any;
  if(changed)appendObservation(f);const before=f.store.delivery(f.deliveryId);
  const view=await(await fetch(base+'/api/automation/draft?runId='+encodeURIComponent(f.run.id))).json() as any;
  const headers={'Content-Type':'application/json','X-Radar-Token':state.token},res=await fetch(base+'/api/automation/mail/claim',{method:'POST',headers,body:JSON.stringify({runId:f.run.id,agent:'Codex',from:'sender@example.test'})}),mail=await res.json() as any;
  if(changed){assert.equal(view.sendReadiness.code,'SOURCE_CHANGED');assert.equal(res.status,400);assert.equal(mail.code,'SOURCE_CHANGED');assertNotAttempted(f,before);}
  else{assert.equal(view.sendReadiness.ready,true);assert.equal(res.status,200);assert.equal(mail.text,f.run.body.text);assert.equal(mail.html,f.run.body.html);
   const report=await fetch(base+'/api/automation/mail/report',{method:'POST',headers,body:JSON.stringify({deliveryId:mail.deliveryId,outcome:'uncertain'})});assert.equal(report.status,200);assert.equal(f.store.delivery(mail.deliveryId).state,'uncertain');assert.equal(f.store.beginDelivery(mail.deliveryId),false);
  }
  assert.equal(f.store.stats().assessments,0);assert.equal(f.store.stats().deliveries,1);
 }finally{if(server){const closed=once(server,'close');server.close();await closed;await new Promise(r=>setTimeout(r,20));}if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;await f.runtime.close();f.store.close();rmSync(root,{recursive:true,force:true});}
});
