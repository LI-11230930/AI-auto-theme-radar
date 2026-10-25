import test from 'node:test';
import assert from 'node:assert/strict';
import {executionPlan} from '../src/planner.ts';
const clock=(s:string)=>Date.parse('2026-10-21T'+s+':00+08:00'),mailId='mail:2026-10-21:18:00',previewId='preview:2026-10-21:18:00';
test('诊断北京时间早晚及跨日边界，不创建计划或发送',()=>{
  for(const [at,due,next] of [['08:59','2026-10-20:18:00','2026-10-21:09:00'],['09:00','2026-10-21:09:00','2026-10-21:18:00'],['18:00','2026-10-21:18:00','2026-10-22:09:00']]){const p=executionPlan({clock:clock(at)});assert.equal(p.due.key,due);assert.equal(p.nextDue.key,next);assert.equal(p.createsTask,false);assert.equal(p.sendsEmail,false);}assert.throws(()=>executionPlan({clock:NaN}));
});
test('采集租约有效只等待，过期只建议复用材料接力且不回显令牌',()=>{
  const preview={id:previewId,state:'collecting',leaseUntil:clock('18:10'),owner:'DSH',token:'fixture-secret'};
  const active=executionPlan({clock:clock('18:01'),previews:[preview]});assert.equal(active.action,'wait_for_owner');assert.equal(active.preview?.activeLease,true);assert.ok(!JSON.stringify(active).includes('fixture-secret'));
  assert.equal(executionPlan({clock:clock('18:11'),previews:[preview]}).action,'resume_saved_materials');
});
test('缺失、过期、未来Daily不能被诊断成正式准备已通过',()=>{
  const previews=[{id:previewId,state:'prepared'}];for(const dailyAt of [undefined,'2026-10-21T01:00:00Z','2026-10-22T01:00:00Z'])assert.equal(executionPlan({clock:clock('18:01'),previews,dailyAt}).action,'refresh_rankings_for_preparation');
  assert.equal(executionPlan({clock:clock('18:01'),previews,dailyAt:'2026-10-21T10:00:00Z',weeklyAt:'2026-10-21T10:00:00Z'}).action,'prepare_outbox');
});
test('单封授权只适用同一时段指纹，早报授权不扩成晚报',()=>{
  const outboxes=[{id:mailId,state:'prepared',bodyHash:'a'}],grant={id:mailId,bodyHash:'a',expiresAt:'2026-10-21T11:00:00Z'};
  assert.equal(executionPlan({clock:clock('18:01'),outboxes,dispatchEnabled:true,grant}).action,'one_authorized_attempt');
  for(const g of [{...grant,id:'mail:2026-10-21:09:00'},{...grant,bodyHash:'b'},{...grant,expiresAt:'2026-10-21T09:00:00Z'}])assert.equal(executionPlan({clock:clock('18:01'),outboxes,dispatchEnabled:true,grant:g}).action,'await_single_authorization');
});
test('已交接或过期租约禁止再次领取；回执摘要不能当本站查信',()=>{
  const outboxes=[{id:mailId,state:'prepared',bodyHash:'a'}];for(const state of ['claimed','submitted','uncertain','receipt_reported']){const p=executionPlan({clock:clock('18:10'),outboxes,dispatches:[{delivery_id:mailId,state,deadline:clock('18:05')}],dispatchEnabled:true,grant:{id:mailId,bodyHash:'a',expiresAt:'2026-10-21T11:00:00Z'}});assert.equal(p.action,state==='receipt_reported'?'review_reported_receipt':'reconcile_only');if(state==='claimed')assert.equal(p.unresolvedDispatches[0].state,'uncertain');}
});
test('来源到期和冷却停止采集，但不阻碍已存在邮件的回执核对',()=>{
  assert.equal(executionPlan({clock:clock('18:01'),source:{mode:'invalid_configuration'}}).action,'source_configuration_required');
  const source={mode:'credential_configured',expiresAt:'2026-10-21T09:00:00Z',retryAt:'2026-10-21T11:00:00Z'};assert.equal(executionPlan({clock:clock('18:01'),source}).action,'source_expired');assert.equal(executionPlan({clock:clock('18:01'),source:{...source,expiresAt:'2026-10-22T00:00:00Z'}}).action,'wait_for_source_cooldown');
  const p=executionPlan({clock:clock('18:10'),source,outboxes:[{id:mailId,state:'prepared',bodyHash:'a'}],dispatches:[{delivery_id:mailId,state:'uncertain',deadline:clock('18:05')}]});assert.equal(p.action,'reconcile_only');
});
test('没有预览的历史时段标为未生成，不虚称漏发；取消时段不复活',()=>{
  const p=executionPlan({clock:clock('18:01'),previews:[{id:previewId,state:'cancelled'}]});assert.equal(p.action,'do_not_revive');assert.equal(p.unpreparedSlots.length,5);assert.ok(!p.unpreparedSlots.includes('2026-10-21:18:00'));assert.match(p.unpreparedScope,/不能称为漏发/);
});
