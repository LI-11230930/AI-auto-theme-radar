import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {loadConfig} from '../src/config.ts';import {isEmailAddress} from '../src/email-address.ts';import {runGithub} from '../src/engine.ts';import {Store} from '../src/store.ts';import {GitHubSource} from '../src/github.ts';import {FixtureRunner} from '../src/runner.ts';import {batchAt,deliveryKey} from '../src/time.ts';import {readInterestMailPolicy} from '../src/interest-mail.ts';import {item,evidence} from './fixtures.ts';
function temporary(t:any){const dir=mkdtempSync(join(tmpdir(),'radar-portable-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('新安装无默认邮箱，现有个人配置逐字保留，普通邮箱可配置而CRLF/多收件人拒绝',t=>{
 const dir=temporary(t),file=join(dir,'config.json');writeFileSync(file,JSON.stringify({dataDir:join(dir,'data')}));assert.equal(loadConfig(file).recipient,null);
 const config=JSON.stringify({recipient:'reader+radar@example.org',dataDir:join(dir,'other')});writeFileSync(file,config);assert.equal(loadConfig(file).recipient,'reader+radar@example.org');assert.equal(readFileSync(file,'utf8'),config);
 for(const value of ['a@example.org\r\nBcc:b@example.org','a@example.org,b@example.org',' a@example.org','mail','x@@example.org']){writeFileSync(file,JSON.stringify({recipient:value,dataDir:join(dir,'data')}));assert.throws(()=>loadConfig(file),{code:'INVALID_CONFIG'});}
});
test('邮箱验证不接收显示名、控制字符、畸形本地部分或非法域名',()=>{
 for(const value of [null,undefined,'',123,'Name <reader@example.org>','.x@example.org','x.@example.org','x..y@example.org','x@-example.org','x@example-.org','x@localhost','x@example.org\n'])assert.equal(isEmailAddress(value),false,String(value));
 for(const value of ['reader@example.org','reader+radar@example.org','reader.name@sub.example.org'])assert.equal(isEmailAddress(value),true,value);
});
test('GitHub批次未填收件人时在所有平台与模型调用前停止，不创建租约或投递',async t=>{
 const dir=temporary(t),store=new Store(':memory:');t.after(()=>store.close());let calls=0;const source=new GitHubSource(async()=>{calls++;throw Error('must not request');});
 await assert.rejects(runGithub({store,source,runner:new FixtureRunner(),topicId:'*',batch:batchAt('2026-10-24','09:00'),outputDir:dir}),{code:'RECIPIENT_REQUIRED'});assert.equal(calls,0);assert.equal(store.deliveries().length,0);assert.equal(store.db.prepare('select count(*) as n from jobs').get()!.n,0);
});
test('安装者自己的邮箱具有相同配额限制，变换邮箱也不能释放本地同日额度',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const keys=Array.from({length:6},(_,n)=>{const repo='portable/repo'+n,key='github:'+repo;store.capture({...item,key,externalId:repo},[{...evidence,itemKey:key}]);return key;});const morning=batchAt('2026-10-24','09:00'),evening=batchAt('2026-10-24','18:00');
 store.prepareDelivery(deliveryKey('Reader@Example.org',morning),'email','Reader@Example.org','{}',keys.slice(0,5));assert.equal(store.dailyQuota(morning.date).platforms.github.remaining,0);
 assert.throws(()=>store.prepareDelivery(deliveryKey('other@example.org',evening),'email','other@example.org','{}',[keys[5]]),{code:'DAILY_QUOTA'});assert.equal(store.deliveries().length,1);
});
test('已确认窗口按收件人隔离，保留旧记录并拒绝借其他邮箱跳过首次基线',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const body=JSON.stringify({collectionWindows:[{topicId:'portable',topicRevision:1,completed:true,endAt:'2026-10-24T01:00:00Z'}]});store.prepareDelivery('old','email','reader@example.org',body);store.beginDelivery('old');store.transitionDelivery('old','submitted');store.transitionDelivery('old','sent_confirmed');
 assert.equal(store.lastConfirmedWindow('portable',1,'reader@example.org'),'2026-10-24T01:00:00Z');assert.equal(store.lastConfirmedWindow('portable',1,'other@example.org'),null);assert.equal(store.deliveries().length,1);
});
test('手动策略无邮箱默认关闭，必须明确自己的同一邮箱，旧地址不能从公共默认继承',t=>{
 const dir=temporary(t);assert.equal(readInterestMailPolicy(dir).from,null);assert.equal(readInterestMailPolicy(dir).enabled,false);
 const save=(fields:any)=>writeFileSync(join(dir,'interest-mail-policy.json'),JSON.stringify({enabled:true,approvedAt:new Date().toISOString(),approvalSource:'explicit_user',...fields}));
 save({});assert.throws(()=>readInterestMailPolicy(dir),{code:'INVALID_MAIL_POLICY'});save({from:'reader@example.org',recipient:'reader@example.org'});assert.equal(readInterestMailPolicy(dir).enabled,true);
 save({from:'reader@example.org',recipient:'other@example.org'});assert.throws(()=>readInterestMailPolicy(dir),{code:'INVALID_MAIL_POLICY'});
});
