import test from 'node:test';
import assert from 'node:assert/strict';
import {runProcess,classifyRunnerFailure} from '../src/runner.ts';
import {RadarError} from '../src/model.ts';
import {runGithub} from '../src/engine.ts';
import {Store} from '../src/store.ts';
import {GitHubSource} from '../src/github.ts';
import {topic,mockFetch} from './fixtures.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {batchAt} from '../src/time.ts';
test('提供方11128渠道拒绝明确分类且不回显上游正文或令牌',async()=>{await assert.rejects(()=>runProcess(process.execPath,['-e','console.log(\'dsh: buddy: {"code":11128,"msg":"Illegal API invocation from an unapproved channel","access_token":"fixture-secret"}\');process.exit(1)'],'',{cwd:process.cwd(),timeoutMs:3000}),(e:any)=>e.code==='PROVIDER_CHANNEL_REJECTED'&&!JSON.stringify(e).includes('fixture-secret'));});
test('模型渠道拒绝只尝试一次，不继续遍历主题候选或准备投递',async()=>{const root=mkdtempSync(resolve(tmpdir(),'radar-provider-')),store=new Store(resolve(root,'test.sqlite'));let calls=0;try{store.saveTopic(topic);store.saveTopic({...topic,id:'second'});const result=await runGithub({recipient:'reader@example.com',store,source:new GitHubSource(mockFetch),runner:{name:'fixture-provider-boundary',assess:async()=>{calls++;throw new RadarError('PROVIDER_CHANNEL_REJECTED','渠道拒绝');}},topicId:'*',batch:batchAt('2026-10-19','18:00'),outputDir:root});assert.equal(calls,1);assert.equal(result.state,'needs_validation');assert.equal(store.deliveries().length,0);}finally{store.close();rmSync(root,{recursive:true,force:true});}});
test('不完整模型JSON暂停批次，保留材料，不继续消耗其他候选',async()=>{const root=mkdtempSync(resolve(tmpdir(),'radar-invalid-final-')),store=new Store(resolve(root,'test.sqlite'));let calls=0;try{store.saveTopic(topic);store.saveTopic({...topic,id:'second'});const result=await runGithub({recipient:'reader@example.com',store,source:new GitHubSource(mockFetch),runner:{name:'fixture-invalid-output',assess:async()=>{calls++;throw new RadarError('INVALID_AGENT_OUTPUT','最终JSON不完整');}},topicId:'*',batch:batchAt('2026-10-19','18:00'),outputDir:root});assert.equal(calls,1);assert.equal(result.state,'needs_validation');assert.equal(store.deliveries().length,0);assert.ok(store.currentEvidence('github:sample/tool').length>0);}finally{store.close();rmSync(root,{recursive:true,force:true});}});

test('模型错误只按终止事件分类，MCP正文里的AUTH_REQUIRED不误报登录',()=>{
 const content=JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',result:{state:'AUTH_REQUIRED',authentication:'configuration text'}}});
 assert.equal(classifyRunnerFailure(content,'engine disconnected'),'AGENT_FAILED');
 assert.equal(classifyRunnerFailure(content+'\n'+JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit"}}),'authentication warning'),'MODEL_QUOTA_EXCEEDED');
 assert.equal(classifyRunnerFailure(JSON.stringify({type:'turn.failed',error:{message:'HTTP 401 Unauthorized'}}),''),'AUTH_REQUIRED');
});
test('模型额度失败停止主题循环，不做下一个候选或准备投递',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'radar-model-quota-')),store=new Store(resolve(root,'db.sqlite'));let calls=0;try{store.saveTopic(topic);store.saveTopic({...topic,id:'second'});const r=await runGithub({recipient:'reader@example.com',store,source:new GitHubSource(mockFetch),runner:{name:'quota-fixture',assess:async()=>{calls++;throw new RadarError('MODEL_QUOTA_EXCEEDED','额度不足');}},topicId:'*',batch:batchAt('2026-10-19','18:00'),outputDir:root});assert.equal(calls,1);assert.equal(r.state,'needs_validation');assert.equal(store.deliveries().length,0);}finally{store.close();rmSync(root,{recursive:true,force:true});}
});
