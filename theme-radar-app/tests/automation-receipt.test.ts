import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {request} from 'node:http';import {once} from 'node:events';
import {AutomationRuntime} from '../src/automation-runtime.ts';import {Store} from '../src/store.ts';import {hash} from '../src/model.ts';import {beijingDate} from '../src/time.ts';import {startOperator} from '../src/operator.ts';

function fixture(file=':memory:'){
 const store=new Store(file),runtime=new AutomationRuntime({},store),runId='automation-run:'+hash('receipt-fixture'),deliveryId='automation-mail:'+hash(runId),body=JSON.stringify({kind:'automation-digest',runId,attemptDate:beijingDate(),simulation:false,verification:false});
 store.prepareDelivery(deliveryId,'email','reader@example.test',body);assert.ok(store.beginDelivery(deliveryId));
 store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('automation-attempt:'+hash(runId),'done','fixture','',0,'{"fixture":true}','fixture');
 return {store,runtime,deliveryId};
}

for(const outcome of ['submitted','uncertain'])test('统一邮件'+outcome+'相同回执重复确认不写入、不增加尝试',async()=>{
 const f=fixture();try{const input={deliveryId:f.deliveryId,outcome,providerMessageId:'fixture-message'};assert.equal(f.runtime.reportMail(input).duplicate,false);const old=f.store.delivery(f.deliveryId),stats=f.store.stats();assert.equal(f.runtime.reportMail(input).duplicate,true);assert.deepEqual(f.store.delivery(f.deliveryId),old);assert.deepEqual(f.store.stats(),stats);assert.equal(JSON.parse(old.receipt).independentlyConfirmed,false);assert.equal(f.store.beginDelivery(f.deliveryId),false);}finally{await f.runtime.close();f.store.close();}
});

test('相同结果但回执ID变更、补加或删除均不能覆盖旧声明',async()=>{
 for(const initial of [undefined,'fixture-message']){const f=fixture();try{f.runtime.reportMail({deliveryId:f.deliveryId,outcome:'submitted',providerMessageId:initial});const old=f.store.delivery(f.deliveryId);for(const id of initial===undefined?['added']:['different',undefined])assert.throws(()=>f.runtime.reportMail({deliveryId:f.deliveryId,outcome:'submitted',providerMessageId:id}),{code:'RECEIPT_CONFLICT'});assert.deepEqual(f.store.delivery(f.deliveryId),old);}finally{await f.runtime.close();f.store.close();}}
});

test('重复报告不能逆转状态、自行确认送达或覆盖独立查询结果',async()=>{
 for(const outcome of ['submitted','uncertain']){const f=fixture();try{f.runtime.reportMail({deliveryId:f.deliveryId,outcome});const old=f.store.delivery(f.deliveryId);assert.throws(()=>f.runtime.reportMail({deliveryId:f.deliveryId,outcome:outcome==='submitted'?'uncertain':'submitted'}),{code:'INVALID_STATE'});assert.throws(()=>f.runtime.reportMail({deliveryId:f.deliveryId,outcome:'sent_confirmed'}),{code:'INVALID_INPUT'});assert.deepEqual(f.store.delivery(f.deliveryId),old);
 f.store.db.prepare('UPDATE deliveries SET receipt=? WHERE id=?').run(JSON.stringify({source:'provider_query',independentlyConfirmed:true,providerMessageId:null}),f.deliveryId);const independent=f.store.delivery(f.deliveryId);assert.throws(()=>f.runtime.reportMail({deliveryId:f.deliveryId,outcome}),{code:'RECEIPT_CONFLICT'});assert.deepEqual(f.store.delivery(f.deliveryId),independent);}finally{await f.runtime.close();f.store.close();}}
});

test('缺失消息ID与旧版null视为同一无ID声明；损坏回执不猜测',async()=>{
 const f=fixture();try{f.runtime.reportMail({deliveryId:f.deliveryId,outcome:'uncertain'});assert.equal(f.runtime.reportMail({deliveryId:f.deliveryId,outcome:'uncertain'}).duplicate,true);f.store.db.prepare('UPDATE deliveries SET receipt=? WHERE id=?').run('{broken',f.deliveryId);const old=f.store.delivery(f.deliveryId);assert.throws(()=>f.runtime.reportMail({deliveryId:f.deliveryId,outcome:'uncertain'}),{code:'RECEIPT_CONFLICT'});assert.deepEqual(f.store.delivery(f.deliveryId),old);}finally{await f.runtime.close();f.store.close();}
});

test('回执输入拒绝空白ID、换行、超长和非对象；不改变发送中状态',async()=>{
 const f=fixture();try{const old=f.store.delivery(f.deliveryId);for(const input of [null,undefined,[],{deliveryId:f.deliveryId,outcome:'submitted',providerMessageId:''},{deliveryId:f.deliveryId,outcome:'submitted',providerMessageId:'  '},{deliveryId:f.deliveryId,outcome:'submitted',providerMessageId:'bad\nline'},{deliveryId:f.deliveryId,outcome:'submitted',providerMessageId:'x'.repeat(2001)}])assert.throws(()=>f.runtime.reportMail(input as any),{code:'INVALID_INPUT'});assert.deepEqual(f.store.delivery(f.deliveryId),old);}finally{await f.runtime.close();f.store.close();}
});

test('实际SQLite文件重开后相同回执仍幂等，原尝试和不可重发状态保留',async()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-receipt-reopen-'));try{for(const outcome of ['submitted','uncertain']){const file=join(root,outcome+'.sqlite'),f=fixture(file),input={deliveryId:f.deliveryId,outcome,providerMessageId:'persisted-receipt'};f.runtime.reportMail(input);const old=f.store.delivery(f.deliveryId);await f.runtime.close();f.store.close();const reopened=new Store(file),runtime=new AutomationRuntime({},reopened);try{assert.equal(runtime.reportMail(input).duplicate,true);assert.deepEqual(reopened.delivery(f.deliveryId),old);assert.equal(reopened.db.prepare("SELECT count(*) n FROM jobs WHERE id LIKE 'automation-attempt:%'").get()!.n,1);assert.equal(reopened.beginDelivery(f.deliveryId),false);}finally{await runtime.close();reopened.close();}}}finally{rmSync(root,{recursive:true,force:true});}
});

test('两个SQLite连接重复相同回执只认可原记录，冲突声明不覆盖',async()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-receipt-connections-')),f=fixture(join(root,'radar.sqlite')),second=new Store(join(root,'radar.sqlite')),other=new AutomationRuntime({},second);try{const input={deliveryId:f.deliveryId,outcome:'submitted',providerMessageId:'same-receipt'};assert.equal(f.runtime.reportMail(input).duplicate,false);const old=f.store.delivery(f.deliveryId);assert.equal(other.reportMail(input).duplicate,true);assert.throws(()=>other.reportMail({...input,providerMessageId:'other-receipt'}),{code:'RECEIPT_CONFLICT'});assert.deepEqual(f.store.delivery(f.deliveryId),old);assert.equal(second.beginDelivery(f.deliveryId),false);}finally{await other.close();await f.runtime.close();second.close();f.store.close();rmSync(root,{recursive:true,force:true});}
});

test('落库失败回滚保留发送中和原尝试，可恢复后只登记结果不再发送',async()=>{
 const f=fixture();try{const input={deliveryId:f.deliveryId,outcome:'uncertain'},old=f.store.delivery(f.deliveryId);f.store.db.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT,'offline-fixture'); END;");assert.throws(()=>f.runtime.reportMail(input));assert.deepEqual(f.store.delivery(f.deliveryId),old);assert.equal(f.store.db.prepare("SELECT count(*) n FROM jobs WHERE id LIKE 'automation-attempt:%'").get()!.n,1);f.store.db.exec('DROP TRIGGER reject_receipt');assert.equal(f.runtime.reportMail(input).state,'uncertain');assert.equal(f.runtime.reportMail(input).duplicate,true);assert.equal(f.store.beginDelivery(f.deliveryId),false);}finally{await f.runtime.close();f.store.close();}
});

test('执行器关闭后仍可确认同一迟到回执，不要求恢复采集或发送',async()=>{
 const f=fixture();try{await f.runtime.close();const input={deliveryId:f.deliveryId,outcome:'submitted',providerMessageId:'late-receipt'};assert.equal(f.runtime.reportMail(input).duplicate,false);const old=f.store.delivery(f.deliveryId);assert.equal(f.runtime.reportMail(input).duplicate,true);assert.deepEqual(f.store.delivery(f.deliveryId),old);assert.equal(f.runtime.active.size,0);}finally{await f.runtime.close();f.store.close();}
});

test('自动下一HTTP响应正文丢弃后仅重报相同回执，零重发且原回执不改',async()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-receipt-http-')),file=join(root,'config.json'),previous=process.env.THEME_RADAR_CONFIG;writeFileSync(file,JSON.stringify({dataDir:root,topics:[],xiaohongshu:{enabled:false}}));process.env.THEME_RADAR_CONFIG=file;
 const f=fixture(join(root,'radar.sqlite')),server=await startOperator(0),base='http://127.0.0.1:'+(server.address() as any).port;
 try{const state=await(await fetch(base+'/api/state')).json() as any,input={deliveryId:f.deliveryId,outcome:'submitted',providerMessageId:'http-receipt'},data=JSON.stringify(input),headers={'Content-Type':'application/json','X-Radar-Token':state.token,'Content-Length':String(Buffer.byteLength(data))};
  await new Promise<void>((resolve,reject)=>{const req=request(base+'/api/automation/mail/report',{method:'POST',headers},res=>{assert.equal(res.statusCode,200);res.on('error',()=>{});res.destroy();resolve();});req.on('error',reject);req.end(data);});
  const old=f.store.delivery(f.deliveryId);assert.equal(old.state,'submitted');const response=await fetch(base+'/api/automation/mail/report',{method:'POST',headers,body:data});assert.equal(response.status,200);assert.equal((await response.json() as any).duplicate,true);assert.deepEqual(f.store.delivery(f.deliveryId),old);assert.equal(f.store.beginDelivery(f.deliveryId),false);assert.equal(f.store.stats().deliveries,1);
 }finally{const closed=once(server,'close');server.close();await closed;await new Promise(r=>setTimeout(r,20));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;await f.runtime.close();f.store.close();rmSync(root,{recursive:true,force:true});}
});
