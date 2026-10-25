import {videoBody} from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.ts';
import {hash,now} from '../src/model.ts';
import type {Topic} from '../src/model.ts';
import {beijingDate} from '../src/time.ts';
import {analyzeArchived} from '../src/archive-reading.ts';
import {freezeBilibiliSample} from '../src/bilibili-sample.ts';
import {claimInterestMail,readInterestMailPolicy,reportInterestMail} from '../src/interest-mail.ts';
import {saveMailTemplate} from '../src/mail-template.ts';

const recipient='reader@example.com';
const topic:Topic={id:'interest',name:'兴趣测试',description:'测试自动化开发兴趣',keywords:['自动化'],exclude:[],platforms:['bilibili'],bilibiliDiscovery:'interests',bilibiliAuthors:[],enabled:true};
function setup(t:any){
  const dir=mkdtempSync(join(tmpdir(),'radar-interest-mail-')),store=new Store(':memory:');store.saveTopic(topic);let sequence=0;
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const policy=(overrides:any={})=>writeFileSync(join(dir,'interest-mail-policy.json'),JSON.stringify({enabled:true,from:recipient,recipient,approvedAt:now(),approvalSource:'explicit_user',...overrides}));
  const reportFile=(id:string)=>join(dir,'reports','interest-round-'+id+'.json');
  const changeReport=(runId:string,change:any)=>{const file=reportFile(runId),r=JSON.parse(readFileSync(file,'utf8'));writeFileSync(file,JSON.stringify({...r,...change}));};
  const round=async(options:{count?:number;keys?:string[];topicId?:string}={})=>{
    const topicId=options.topicId??topic.id,keys=options.keys??Array.from({length:options.count??1},()=> 'bilibili:BV'+String(++sequence).padStart(10,'0'));
    for(const key of keys){const bv=key.slice('bilibili:'.length),url='https://www.bilibili.com/video/'+bv;if(!store.item(key))store.capture({key,platform:'bilibili',externalId:bv,url,title:'自动化开发工具 '+sequence,author:'示例UP',authorId:'123',publishedAt:'2020-01-01T00:00:00Z',discoveredAt:now(),version:'video',metadata:{}},[{itemKey:key,kind:'subtitle',url,text:videoBody,collectedAt:now(),coverage:{material:'字幕',expected:1,acquired:1,processed:0,state:'unread',method:'fixture'}}]);
      await analyzeArchived({store,topicId,itemKey:key,runner:{name:'fixture',assess:async(_topic,item,evidence)=>({itemKey:item.key,selected:true,reason:'测试实际归档字幕',summaryZh:'介绍读取资料并生成结果的自动化流程。',flow:{steps:['读取资料','生成结果'],basis:'overview',evidenceIds:[]},readEvidenceIds:evidence.map(e=>e.id!),limitations:[],agent:'fixture',simulation:false})}});
    }
    const sample=freezeBilibiliSample(store,dir,{topicId,itemKeys:keys}),runId=randomUUID(),report={id:runId,topicId,topicRevision:store.topics().find(t=>t.id===topicId)!.revision,startedAt:now(),completedAt:now(),stage:'finished',discovered:keys.length,prefiltered:keys.length,results:keys.map(itemKey=>({itemKey,state:'assessed',selected:true})),sources:[{kind:'recommendation',state:'ok',authenticated:true}],candidateBudget:20,readLimit:3,commentsRead:0,emailSent:false,sample};
    mkdirSync(join(dir,'reports'),{recursive:true});writeFileSync(reportFile(runId),JSON.stringify(report));return{sample,runId,keys,input:{sampleId:sample.id,runId},report};
  };
  return {dir,store,policy,round,changeReport};
}

test('模板变更不改写旧草稿，领取使用冻结时样式',async t=>{
 const x=setup(t);x.policy();saveMailTemplate(x.dir,{bilibili:{title:'旧标题',subject:'旧邮件 {date}'}});const r=await x.round();saveMailTemplate(x.dir,{bilibili:{title:'新标题'}});const claimed=claimInterestMail(x.store,x.dir,r.input);assert.match(claimed.text,/旧标题/);assert.doesNotMatch(claimed.text,/新标题/);assert.match(claimed.subject,/旧邮件/);
});

test('邮件政策默认禁用，不创建文件、不联网、不预留投递',async t=>{
  const x=setup(t);assert.deepEqual(readInterestMailPolicy(x.dir),{enabled:false,mode:'manual_round_only',from:null,recipient:null,maxAttemptsPerRun:1,maxMessagesPerDay:2,maxItemsPerRun:3});assert.equal(existsSync(join(x.dir,'interest-mail-policy.json')),false);
  const r=await x.round();assert.throws(()=>claimInterestMail(x.store,x.dir,r.input),{code:'MAIL_DISABLED'});assert.equal(x.store.deliveries().length,0);
});

test('旧冻结草稿领取时重查实际提供的正文量，拒绝后不消耗发送次数',async t=>{
 const x=setup(t);x.policy();const r=await x.round(),before=readFileSync(join(x.dir,'bilibili-samples',r.sample.id+'.json'),'utf8'),a=x.store.assessments(topic.id)[0];a.reading!.materials[0].providedCharacters=36;x.store.saveAssessment(topic.id,a);
 assert.throws(()=>claimInterestMail(x.store,x.dir,r.input),{code:'INSUFFICIENT_VIDEO_BODY'});assert.equal(x.store.deliveries().length,0);assert.equal(readFileSync(join(x.dir,'bilibili-samples',r.sample.id+'.json'),'utf8'),before);
});
test('政策启用仅接受明确本地声明，地址、次数、模式、字段不能越界',t=>{
  const x=setup(t);
  for(const change of [{approvedAt:null},{approvedAt:'yesterday'},{approvedAt:'2026-02-30T00:00:00Z'},{approvedAt:'2026-01-01T24:00:00Z'},{approvalSource:'agent'},{approvedAt:undefined},{enabled:'true'},{from:'other@example.com'},{recipient:'other@example.com'},{mode:'scheduled'},{maxAttemptsPerRun:2},{maxMessagesPerDay:3},{maxMessagesPerDay:0},{maxMessagesPerDay:1.5},{maxItemsPerRun:4},{maxItemsPerRun:0},{unknown:true}]){x.policy(change);assert.throws(()=>readInterestMailPolicy(x.dir),{code:'INVALID_MAIL_POLICY'});}
  writeFileSync(join(x.dir,'interest-mail-policy.json'),'broken');assert.throws(()=>readInterestMailPolicy(x.dir),{code:'INVALID_MAIL_POLICY'});
  x.policy({maxMessagesPerDay:1,maxItemsPerRun:1});assert.equal(readInterestMailPolicy(x.dir).maxMessagesPerDay,1);
  x.policy({enabled:false});assert.equal(readInterestMailPolicy(x.dir).enabled,false);
});
test('领取直接原子写submitting及视频指纹，正文和政策冻结，单轮不可重复领取',async t=>{
  const x=setup(t);x.policy();const r=await x.round({count:3}),claimed=claimInterestMail(x.store,x.dir,r.input),d=x.store.delivery(claimed.deliveryId),body=JSON.parse(d.body);
  assert.equal(claimed.state,'submitting');assert.equal(d.state,'submitting');assert.equal(claimed.from,recipient);assert.equal(claimed.to,recipient);assert.equal(body.verification,false);assert.equal(body.simulation,false);assert.equal(body.kind,'bilibili-interest-manual');assert.equal(body.runId,r.runId);assert.equal(body.sampleId,r.sample.id);assert.equal(body.textSha256,hash(body.text));assert.equal(body.attemptDate,beijingDate());assert.equal(body.policySnapshot.approvalSource,'explicit_user');assert.equal(d.body_hash,hash(d.body));assert.equal(x.store.deliveryItems(d.id).length,3);assert.ok(x.store.deliveryItems(d.id).every(item=>item.fingerprint===x.store.fingerprint(item.item_key)));
  assert.match(claimed.instruction,/不得重试/);assert.throws(()=>claimInterestMail(x.store,x.dir,r.input),{code:'MAIL_ALREADY_CLAIMED'});assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM recommendations').get()!.n,0);
});
test('每日北京时间最多两次，实际领取后退信或外部取消仍计已消费的发送尝试',async t=>{
  for(const state of ['submitting','submitted','uncertain','sent_confirmed','failed','bounced','cancelled']){
    const x=setup(t);x.policy();for(let i=0;i<2;i++){const r=await x.round(),d=claimInterestMail(x.store,x.dir,r.input);x.store.db.prepare('UPDATE deliveries SET state=? WHERE id=?').run(state,d.deliveryId);}
    const next=await x.round();assert.throws(()=>claimInterestMail(x.store,x.dir,next.input),{code:'MAIL_DAILY_LIMIT'});assert.equal(x.store.deliveries().length,2);
  }
});
test('不同北京日期尝试不占今天配额，prepared非本模块正常状态也不算一次',async t=>{
  const x=setup(t);x.policy();for(const [n,state,date]of [[1,'failed','2000-01-01'],[2,'prepared',beijingDate()],[3,'prepared',beijingDate()]] as const){const body=JSON.stringify({kind:'bilibili-interest-manual',runId:'fixture-'+n,attemptDate:date,text:'fixture'});x.store.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?)').run('fixture-'+n,'email',recipient,state,hash(body),body,null,now());}
  const r=await x.round();assert.equal(claimInterestMail(x.store,x.dir,r.input).state,'submitting');
});
test('两封各三条也不能超过既定每日五条精选，总额拒绝不消耗第二次领取',async t=>{
 const x=setup(t);x.policy();const first=await x.round({count:3});claimInterestMail(x.store,x.dir,first.input);assert.equal(x.store.dailyQuota(beijingDate()).platforms.bilibili.used,3);
 const oversized=await x.round({count:3});assert.throws(()=>claimInterestMail(x.store,x.dir,oversized.input),{code:'DAILY_QUOTA'});assert.equal(x.store.deliveries().length,1);
 const second=await x.round({count:2});claimInterestMail(x.store,x.dir,second.input);assert.equal(x.store.dailyQuota(beijingDate()).platforms.bilibili.used,5);assert.equal(x.store.deliveries().length,2);
});
test('未知或失败结果不能对同一round重新领取，取消旧记录也不能复用该run',async t=>{
  for(const state of ['uncertain','failed','cancelled']){const x=setup(t);x.policy();const r=await x.round(),d=claimInterestMail(x.store,x.dir,r.input);x.store.db.prepare('UPDATE deliveries SET state=? WHERE id=?').run(state,d.deliveryId);assert.throws(()=>claimInterestMail(x.store,x.dir,r.input),{code:'MAIL_ALREADY_CLAIMED'});}
});
test('跨轮次、跨主题以及旧已发样张正文中的BV全局去重',async t=>{
  for(const legacy of [false,true]){const x=setup(t);x.policy();const first=await x.round();if(legacy){x.store.prepareDelivery('old-sample','email',recipient,JSON.stringify({text:'https://www.bilibili.com/video/'+first.keys[0].slice(9)}));x.store.beginDelivery('old-sample');x.store.transitionDelivery('old-sample','submitted');x.store.transitionDelivery('old-sample','sent_confirmed');}else claimInterestMail(x.store,x.dir,first.input);
    x.store.saveTopic({...topic,id:'interest-other'});const next=await x.round({keys:first.keys,topicId:'interest-other'});assert.throws(()=>claimInterestMail(x.store,x.dir,next.input),{code:'ALREADY_NOTIFIED'});
  }
});
test('非法ID、无报告、未结束/取消/失败报告或样张绑定错误全部拒绝',async t=>{
  const x=setup(t);x.policy();const r=await x.round();for(const input of [{...r.input,runId:'../../outside'},{...r.input,sampleId:'../outside'}])assert.throws(()=>claimInterestMail(x.store,x.dir,input),{code:'INVALID_INPUT'});
  assert.throws(()=>claimInterestMail(x.store,x.dir,{...r.input,runId:randomUUID()}),{code:'INVALID_ROUND'});
  for(const change of [{stage:'discovering'},{stage:'stopped'},{stoppedReason:'CANCELLED'},{stoppedReason:'AGENT_FAILED'},{sample:{...r.sample,id:randomUUID()}},{id:randomUUID()},{completedAt:null}]){x.changeReport(r.runId,{...r.report,...change});assert.throws(()=>claimInterestMail(x.store,x.dir,r.input),{code:'INVALID_ROUND'});}
  assert.equal(x.store.deliveries().length,0);
});
test('关闭/改变主题或把作者样张伪作兴趣样张拒绝领取',async t=>{
  for(const change of [{enabled:false},{name:'新兴趣方向'},{bilibiliDiscovery:'authors',bilibiliAuthors:['123']}]){const x=setup(t);x.policy();const r=await x.round();x.store.saveTopic({...topic,...change} as Topic,1);assert.throws(()=>claimInterestMail(x.store,x.dir,r.input),{code:'TOPIC_CHANGED'});assert.equal(x.store.deliveries().length,0);}
});
test('正文散列/轮次散列、材料快照、当前判断或条数变化均不领取',async t=>{
  for(const mode of ['text','report-sha','snapshot','assessment','results','too-many','duplicate']){
    const x=setup(t);x.policy();const r=await x.round(),file=join(x.dir,'bilibili-samples',r.sample.id+'.json'),sample=JSON.parse(readFileSync(file,'utf8'));
    if(mode==='text'){sample.text+='篡改';writeFileSync(file,JSON.stringify(sample));}
    if(mode==='report-sha')x.changeReport(r.runId,{sample:{...r.sample,textSha256:'0'.repeat(64)}});
    if(mode==='snapshot'){const item=x.store.item(r.keys[0]),e=x.store.currentEvidence(item.key);x.store.capture(item,e.map(v=>({...v,text:v.text+'变动'})));}
    if(mode==='assessment'){const old=sample.entries[0].assessment;x.store.saveAssessment(topic.id,{...old,selected:false});}
    if(mode==='results')x.changeReport(r.runId,{results:r.report.results.map(item=>({...item,selected:false}))});
    if(mode==='too-many'||mode==='duplicate'){sample.entries.push(sample.entries[0]);if(mode==='too-many')sample.entries.push(sample.entries[0],sample.entries[0]);writeFileSync(file,JSON.stringify(sample));}
    assert.throws(()=>claimInterestMail(x.store,x.dir,r.input));assert.equal(x.store.deliveries().length,0);
  }
});
test('回执仅宿主声明，submitted幂等且不能标送达或逆转；uncertain也不可再提交',async t=>{
  for(const outcome of ['submitted','uncertain'] as const){const x=setup(t);x.policy();const r=await x.round(),d=claimInterestMail(x.store,x.dir,r.input),input={deliveryId:d.deliveryId,outcome,providerMessageId:'provider-fixture-id'};
    const first=reportInterestMail(x.store,input);assert.equal(first.independentlyConfirmed,false);assert.equal(first.state,outcome);assert.equal(reportInterestMail(x.store,input).duplicate,true);const receipt=JSON.parse(x.store.delivery(d.deliveryId).receipt);assert.equal(receipt.source,'host_self_report');assert.equal(receipt.independentlyConfirmed,false);assert.match(receipt.note,/不是独立/);
    assert.throws(()=>reportInterestMail(x.store,{...input,outcome:'sent_confirmed'} as any),{code:'INVALID_INPUT'});assert.throws(()=>reportInterestMail(x.store,{...input,outcome:outcome==='submitted'?'uncertain':'submitted'}),{code:'INVALID_STATE'});assert.throws(()=>reportInterestMail(x.store,{...input,providerMessageId:'different'}),{code:'RECEIPT_CONFLICT'});assert.throws(()=>claimInterestMail(x.store,x.dir,r.input),{code:'MAIL_ALREADY_CLAIMED'});
  }
});
test('本模块没有发送行为；禁用配置和失败领取不修改旧样张或原业务行',async t=>{
  const x=setup(t);x.policy();const r=await x.round(),file=join(x.dir,'bilibili-samples',r.sample.id+'.json'),before=readFileSync(file,'utf8'),original=globalThis.fetch;let calls=0;
  try{globalThis.fetch=async()=>{calls++;throw new Error('unexpected external sending');};const d=claimInterestMail(x.store,x.dir,r.input);reportInterestMail(x.store,{deliveryId:d.deliveryId,outcome:'uncertain'});assert.equal(calls,0);assert.equal(readFileSync(file,'utf8'),before);assert.equal(x.store.stats().items,1);assert.equal(x.store.stats().assessments,1);}finally{globalThis.fetch=original;}
});
