import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../src/store.ts';import {loadConfig} from '../src/config.ts';import {capabilityReport} from '../src/service.ts';
import {githubDigestCapability,emailCapability} from '../src/capability-summary.ts';import {saveMailTemplate} from '../src/mail-template.ts';import {topic,item,evidence} from './fixtures.ts';
function setup(t:any){const root=mkdtempSync(join(tmpdir(),'radar-generic-status-')),path=join(root,'config.json');writeFileSync(path,JSON.stringify({dataDir:root,topics:[],xiaohongshu:{enabled:false}}));const config=loadConfig(path),store=new Store(':memory:');t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,config,store};}
function assess(store:Store,selected=false,simulation=false){return store.saveAssessment(topic.id,{itemKey:item.key,selected,reason:'isolated synthetic ledger check',agent:'fixture',simulation,readEvidenceIds:store.currentEvidence(item.key).map(e=>e.id!),limitations:['synthetic unit test']});}
test('空安装按使用者配置报告，不要求七主题或假称UID/格式/邮箱已经验收',t=>{
 const {root,store,config}=setup(t);mkdirSync(join(root,'reports'));writeFileSync(join(root,'reports','seven-topic-window.json'),JSON.stringify({ok:true,topicCount:7,runner:'old-real',perTopic:Array.from({length:7},()=>({searchSucceeded:true,assessments:1}))}));writeFileSync(join(root,'reports','outlook-test.json'),JSON.stringify({state:'sent_confirmed'}));
 const report=capabilityReport(config,store),get=(id:string)=>report.capabilities.find(c=>c.id===id)!;
 assert.equal(get('github-digest').state,'not_configured');assert.equal(get('bilibili-authors').state,'not_configured');assert.equal(get('email').state,'needs_recipient');assert.equal(get('notification-format').state,'default_template_available');assert.doesNotMatch(JSON.stringify(report),/七主题|收件人与两个时段已固定|用户已确认内容质量/);
});
test('单个自定义GitHub主题的有效判断即可展示，不依赖开发者历史报告',t=>{
 const {store}=setup(t);store.saveTopic({...topic,platforms:['github']});store.capture(item,[evidence]);assess(store,true);
 const report=githubDigestCapability(store);assert.equal(report.state,'archive_assessments_available');assert.deepEqual(report.counts,{enabledTopics:1,topicsWithCurrentAssessments:1,assessedItems:1,selectedItems:1});
 assess(store,false);assert.equal(githubDigestCapability(store).counts.selectedItems,0);
});
test('模拟、旧主题版本、失效材料不算当前GitHub判断，停用主题后不再要求运行',t=>{
 const {store}=setup(t);store.saveTopic(topic);store.capture(item,[evidence]);assess(store,true,true);assert.equal(githubDigestCapability(store).state,'awaiting_analysis');
 assess(store);store.saveTopic({...topic,name:'new revision'},1);assert.equal(githubDigestCapability(store).state,'awaiting_analysis');assess(store);assert.equal(githubDigestCapability(store).state,'archive_assessments_available');
 store.capture(item,[{...evidence,text:'changed evidence'}]);assert.equal(githubDigestCapability(store).state,'awaiting_analysis');store.saveTopic({...topic,enabled:false},2);assert.equal(githubDigestCapability(store).state,'not_configured');
});
test('自定义周榜模板映射至渠道计划，损坏模板仍可读取自检和修复入口',t=>{
 const {root,store,config}=setup(t);saveMailTemplate(root,{github:{sections:['weekly']}});let report=capabilityReport(config,store);assert.equal(report.notificationPlan.emailFormat.state,'custom_template_configured');assert.deepEqual(report.notificationPlan.emailFormat.githubSections,['GitHub Trending Weekly前十']);
 writeFileSync(join(root,'mail-template.json'),'{bad private content');report=capabilityReport(config,store);assert.equal(report.capabilities.find(c=>c.id==='notification-format')?.state,'invalid_template');assert.doesNotMatch(JSON.stringify(report),/bad private content/);
});
test('历史送达按当前收件人计数，不能据旧Outlook记录推断当前连接可用',t=>{
 const {store,config}=setup(t);store.prepareDelivery('past','email','old@example.test','fixture');store.beginDelivery('past');store.transitionDelivery('past','submitted');store.transitionDelivery('past','sent_confirmed');
 config.recipient='new@example.test';assert.equal(emailCapability(config,store).confirmedDeliveries,0);config.recipient='OLD@example.test';const report=emailCapability(config,store);assert.equal(report.confirmedDeliveries,1);assert.equal(report.state,'sender_not_configured');assert.match(report.note,/不替代当前连接验证/);
});
test('手动策略与SMTP字段只表示配置，不冒充发送验收或回显邮箱凭据',t=>{
 const {root,store,config}=setup(t);config.recipient='self@example.test';writeFileSync(join(root,'interest-mail-policy.json'),JSON.stringify({enabled:true,from:config.recipient,recipient:config.recipient,approvedAt:new Date(Date.now()-1000).toISOString(),approvalSource:'explicit_user'}));
 assert.equal(emailCapability(config,store).state,'manual_policy_configured');writeFileSync(join(root,'interest-mail-policy.json'),'{}');const previous=process.env.RADAR_TEST_SMTP_SECRET;process.env.RADAR_TEST_SMTP_SECRET='private-smtp-value';
 try{Object.assign(config.email,{enabled:true,from:'sender@example.test',host:'smtp.example.test',username:'sender@example.test',passwordEnv:'RADAR_TEST_SMTP_SECRET'});const report=emailCapability(config,store);assert.equal(report.state,'smtp_configured_unverified');assert.doesNotMatch(JSON.stringify(report),/private-smtp-value|sender@example/);}finally{if(previous===undefined)delete process.env.RADAR_TEST_SMTP_SECRET;else process.env.RADAR_TEST_SMTP_SECRET=previous;}
});
