import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';import {savePlan,planById} from '../src/automation-plan.ts';
import {AutomationRuntime} from '../src/automation-runtime.ts';
import {setPlatform,triggerPlatform,platformControls} from '../src/platform-controls.ts';
import {topic} from './fixtures.ts';
function fixture(t:any){const store=new Store(':memory:');t.after(()=>store.close());store.saveTopic({...topic,platforms:['github','bilibili'],bilibiliDiscovery:'interests'});const calls:any[]=[];const runtime=new AutomationRuntime({runners:{}},store);runtime.launch=((p:any,due:any)=>{calls.push({p,due});return {started:true,runId:'automation-run:'+calls.length};}) as any;savePlan(store,{id:'personal-radar',name:'Test',enabled:true,agent:'Codex',execution:'attached',topicIds:[topic.id],platforms:['bilibili','github'],schedule:{kind:'manual'},delivery:'host',sendApproved:true,recipient:'recipient@example.com',from:'sender@example.com',maxMessagesPerDay:2,readLimit:3,githubReadLimit:14,subject:'Test'});return {store,runtime,calls};}

test('统一配置灵感预算仅同步B站启用，保留平台关闭与邮件额度，过期写入整体拒绝',t=>{const x=fixture(t);setPlatform(x.runtime,{platform:'github',enabled:true});setPlatform(x.runtime,{platform:'bilibili',enabled:false});const base=planById(x.store,'personal-radar')!,settings={enabled:true,maxCards:2,maxRepositoryReads:1};x.runtime.save({...base,inspiration:settings},base.revision);const g=planById(x.store,'github-morning')!,b=planById(x.store,'bilibili-stream')!;assert.equal(g.inspiration!.enabled,false);assert.deepEqual(b.inspiration,settings);assert.equal(b.enabled,false);assert.equal(g.enabled,true);assert.equal(g.maxMessagesPerDay,1);assert.equal(b.maxMessagesPerDay,2);assert.equal(x.calls.length,0);assert.throws(()=>x.runtime.save({...base,inspiration:{...settings,enabled:false}},base.revision),{code:'STALE_PLAN'});assert.deepEqual(planById(x.store,'bilibili-stream')!.inspiration,settings);});

test('统一保存同步Agent、邮箱、主题与阅读预算，保留关闭状态及平台私有设置',t=>{
 const x=fixture(t);setPlatform(x.runtime,{platform:'github',enabled:true});setPlatform(x.runtime,{platform:'bilibili',enabled:false});
 const g=planById(x.store,'github-morning')!;x.runtime.save({...g,subject:'My daily',maxMessagesPerDay:4},g.revision);
 x.store.saveTopic({...topic,id:'new-topic',platforms:['github','bilibili'],bilibiliDiscovery:'interests'});
 const p=planById(x.store,'personal-radar')!;x.runtime.save({...p,agent:'WorkBuddy',recipient:'new@example.com',from:'other@example.com',topicIds:['new-topic'],githubReadLimit:9},p.revision);
 const data=platformControls(x.runtime);for(const row of data.platforms){assert.equal(row.plan!.agent,'WorkBuddy');assert.equal(row.plan!.recipient,'new@example.com');assert.equal(row.plan!.from,'other@example.com');assert.deepEqual(row.plan!.topicIds,['new-topic']);assert.equal(row.plan!.githubReadLimit,9);assert.equal(row.configurationCurrent,true);}
 assert.equal(data.platforms[0].enabled,true);assert.equal(data.platforms[0].plan!.subject,'My daily');assert.equal(data.platforms[0].plan!.maxMessagesPerDay,4);assert.equal(data.platforms[1].enabled,false);assert.equal(x.calls.length,0);
});
test('不变配置不递增版本，过期写入整体拒绝，不改其他计划',t=>{
 const x=fixture(t);setPlatform(x.runtime,{platform:'github',enabled:true});setPlatform(x.runtime,{platform:'bilibili',enabled:false});
 const p=planById(x.store,'personal-radar')!,g=planById(x.store,'github-morning')!;const other=savePlan(x.store,{...p,id:'other-plan'});
 x.runtime.save({...p},p.revision);assert.equal(planById(x.store,p.id)!.revision,p.revision);assert.equal(planById(x.store,g.id)!.revision,g.revision);
 assert.throws(()=>x.runtime.save({...p,recipient:'new@example.com'},p.revision-1),{code:'STALE_PLAN'});assert.deepEqual(planById(x.store,g.id),g);assert.deepEqual(planById(x.store,'other-plan'),other);
});
test('撤回发送授权同步草稿模式；移除平台关闭它，重新勾选不会自动开启',t=>{
 const x=fixture(t);setPlatform(x.runtime,{platform:'github',enabled:true});setPlatform(x.runtime,{platform:'bilibili',enabled:true});
 let p=planById(x.store,'personal-radar')!;x.runtime.save({...p,platforms:['github'],delivery:'draft',enabled:false,sendApproved:false,from:null,recipient:null},p.revision);
 assert.equal(planById(x.store,'bilibili-stream')!.enabled,false);assert.equal(planById(x.store,'github-morning')!.delivery,'draft');assert.equal(planById(x.store,'github-morning')!.sendApproved,false);
 assert.throws(()=>setPlatform(x.runtime,{platform:'bilibili',enabled:true}),{code:'SETUP_REQUIRED'});
 p=planById(x.store,'personal-radar')!;x.runtime.save({...p,platforms:['github','bilibili']},p.revision);assert.equal(planById(x.store,'bilibili-stream')!.enabled,false);
});
test('子计划校验失败回滚全部保存且不提前取消运行',t=>{
 const x=fixture(t);setPlatform(x.runtime,{platform:'github',enabled:true});const p=planById(x.store,'personal-radar')!,g=planById(x.store,'github-morning')!;
 x.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({...g,maxMessagesPerDay:99}),'automation-plan:'+g.id);
 const aborted=new AbortController();x.runtime.active.set('run-synthetic',aborted);x.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('automation-run:synthetic','running','fixture','token',Date.now()+60000,JSON.stringify({id:'run-synthetic',planId:p.id}),'2026-10-28T00:00:00Z');
 assert.throws(()=>x.runtime.save({...p,agent:'TRAE'},p.revision),{code:'INVALID_BUDGET'});assert.deepEqual(planById(x.store,p.id),p);assert.equal(aborted.signal.aborted,false);
});
test('配置变更只取消尚未尝试的旧草稿，已提交状态保留',t=>{
 const x=fixture(t);setPlatform(x.runtime,{platform:'github',enabled:true});const p=planById(x.store,'personal-radar')!;
 for(const [id,state] of [['draft-old','prepared'],['sent-old','submitted']]){x.store.prepareDelivery(id,'email','recipient@example.com','{}');if(state==='submitted'){x.store.beginDelivery(id);x.store.transitionDelivery(id,'submitted');}x.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('automation-run:'+id,'done','fixture','',0,JSON.stringify({id:'automation-run:'+id,planId:'github-morning',deliveryId:id}),'2026-10-28T00:00:00Z');}
 for(let i=0;i<35;i++)x.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('automation-run:later-'+i,'done','fixture','',0,JSON.stringify({id:'automation-run:later-'+i,planId:'other-plan'}),'2027-01-01T00:00:00Z');
 x.runtime.save({...p,recipient:'new@example.com'},p.revision);assert.equal(x.store.delivery('draft-old').state,'cancelled');assert.equal(x.store.delivery('sent-old').state,'submitted');
});
test('状态区分平台开关与唤醒状态，暂停不宣称下次将实际执行',t=>{
 const x=fixture(t);setPlatform(x.runtime,{platform:'github',enabled:true});
 const at=Date.parse('2026-10-28T12:00:00+08:00');let row=platformControls(x.runtime,at).platforms[0];assert.equal(row.execution.state,'needs_wakeup');assert.equal(row.nextScheduledAt,'2026-10-29T01:00:00.000Z');assert.equal(row.nextRunAt,null);
 x.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('platform-wakeups','done','configuration','',0,JSON.stringify({status:'PAUSED',driver:'Codex thread heartbeat'}),'2026-10-28T00:00:00Z');row=platformControls(x.runtime,at).platforms[0];assert.equal(row.execution.state,'wakeup_paused');assert.equal(row.nextRunAt,null);
 assert.equal(triggerPlatform(x.runtime,{platform:'github',agent:'Codex'},Date.parse('2026-10-29T09:00:00+08:00')).reason,'wakeup_paused');assert.equal(x.calls.length,0);
 x.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({status:'ACTIVE',driver:'Codex thread heartbeat'}),'platform-wakeups');row=platformControls(x.runtime,at).platforms[0];assert.equal(row.execution.state,'configured');assert.equal(row.execution.liveVerified,false);assert.equal(row.mailbox.state,'requires_host_check');
 const p=planById(x.store,'personal-radar')!;x.runtime.save({...p,agent:'TRAE'},p.revision);assert.equal(platformControls(x.runtime,at).platforms[0].execution.state,'host_mismatch');
});
test('两个平台独立开关、邮件额度与主题范围，不改原计划',t=>{const x=fixture(t);setPlatform(x.runtime,{platform:'github',enabled:true});setPlatform(x.runtime,{platform:'bilibili',enabled:true});setPlatform(x.runtime,{platform:'bilibili',enabled:false});const data=platformControls(x.runtime);assert.equal(data.platforms[0].enabled,true);assert.equal(data.platforms[1].enabled,false);assert.equal(data.platforms[0].plan.mailBudgetScope,'plan');assert.equal(data.platforms[0].plan.maxMessagesPerDay,1);assert.equal(data.platforms[1].plan.maxMessagesPerDay,2);assert.equal(x.calls.length,0);});
test('GitHub只在北京时间9点窗口触发一次，B站关闭不触发，开启每15分钟去重',t=>{const x=fixture(t);setPlatform(x.runtime,{platform:'github',enabled:true});assert.equal(triggerPlatform(x.runtime,{platform:'github',agent:'Codex'},Date.parse('2026-10-28T08:59:00+08:00')).reason,'outside_0900_window');const at=Date.parse('2026-10-28T09:00:00+08:00');assert.equal(triggerPlatform(x.runtime,{platform:'github',agent:'Codex'},at).started,true);assert.equal(triggerPlatform(x.runtime,{platform:'github',agent:'Codex'},at+60000).reason,'already_triggered');assert.equal(triggerPlatform(x.runtime,{platform:'bilibili',agent:'Codex'},at).reason,'platform_off');setPlatform(x.runtime,{platform:'bilibili',enabled:true});assert.equal(triggerPlatform(x.runtime,{platform:'bilibili',agent:'Codex'},at).started,true);assert.equal(triggerPlatform(x.runtime,{platform:'bilibili',agent:'Codex'},at+60000).reason,'already_triggered');assert.throws(()=>triggerPlatform(x.runtime,{platform:'bilibili',agent:'TRAE'},at),{code:'AGENT_MISMATCH'});});
