import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hostCapability} from '../src/host-capability.ts';
test('IDE user reports retain provenance and description-only scope',()=>{
  const root=mkdtempSync(join(tmpdir(),'radar-host-'));mkdirSync(join(root,'reports'));
  try{writeFileSync(join(root,'reports/agent-mcp-WorkBuddy.json'),JSON.stringify({ok:true,userReported:true,at:'now'}));const actual=hostCapability({dataDir:root},'WorkBuddy',{});assert.equal(actual.state,'mcp_user_report_verified');assert.equal(actual.evidenceSource,'user_report');assert.match(actual.note,/视频简介/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('New DSH channel success supersedes old failure while preserving reliability limits',()=>{
  const root=mkdtempSync(join(tmpdir(),'radar-host-'));mkdirSync(join(root,'reports'));
  try{writeFileSync(join(root,'reports/agent-mcp-DSH.json'),JSON.stringify({ok:true,provider:'Jet Hub/TRAE',recentIncompleteFinals:4}));writeFileSync(join(root,'reports/agent-DSH.json'),JSON.stringify({ok:false,code:'AUTH_REQUIRED'}));const actual=hostCapability({dataDir:root},'DSH',{});assert.equal(actual.state,'mcp_fixture_reading_verified');assert.match(actual.note,/TRAE/);assert.match(actual.note,/不完整JSON/);assert.doesNotMatch(actual.note,/11128/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('应用更新后的缺失绝对入口单列，PATH命令不按当前目录误判',()=>{
 const c={dataDir:'nonexistent-fixture-path'};assert.equal(hostCapability(c,'Codex',{command:join(tmpdir(),'missing-radar-fixture','codex.exe')}).state,'runner_executable_missing');assert.equal(hostCapability(c,'Codex',{command:'codex'}).state,'configured_unverified');
});
test('新的用户字幕报告替代简介范围，同时保留非重放与未重新分析边界',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-host-subtitle-'));mkdirSync(join(root,'reports'));
 try{writeFileSync(join(root,'reports/agent-mcp-TRAE.json'),JSON.stringify({ok:true,userReported:true,materialKind:'browser-subtitle:p1'}));const c=hostCapability({dataDir:root},'TRAE',{});assert.equal(c.evidenceSource,'user_report');assert.match(c.note,/浏览器字幕/);assert.match(c.note,/本Agent未重放/);assert.match(c.note,/不等于本宿主重新分析/);assert.doesNotMatch(c.note,/仅为视频简介/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('新交互提交及旧进程错误优先于历史只读成功，不能把过期服务仍报成新链路通过',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-host-handoff-'));mkdirSync(join(root,'reports'));
 try{for(const id of ['WorkBuddy','TRAE'])writeFileSync(join(root,`reports/agent-mcp-${id}.json`),JSON.stringify({ok:true,userReported:true}));writeFileSync(join(root,'reports/agent-handoff-WorkBuddy.json'),JSON.stringify({ok:true,ledgerVerified:true}));writeFileSync(join(root,'reports/agent-handoff-TRAE.json'),JSON.stringify({ok:false,code:'STALE_MCP_PROCESS'}));assert.equal(hostCapability({dataDir:root},'WorkBuddy',{}).state,'interactive_assessment_saved');assert.equal(hostCapability({dataDir:root},'TRAE',{}).state,'mcp_refresh_required');assert.match(hostCapability({dataDir:root},'TRAE',{}).note,/不需要重装/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('TRAE成功复用取代旧进程告警，不把跨宿主复用计为TRAE新阅读',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-host-reused-'));mkdirSync(join(root,'reports'));
 try{writeFileSync(join(root,'reports/agent-handoff-TRAE.json'),JSON.stringify({ok:true,reused:true,userReported:true,reuseLedgerVerified:true}));const c=hostCapability({dataDir:root},'TRAE',{});assert.equal(c.state,'interactive_handoff_reused');assert.match(c.note,/未重复提交/);assert.match(c.note,/复用不登记为TRAE重新阅读/);assert.doesNotMatch(c.note,/需要刷新/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('最近归档分析失败不被历史MCP成功遮蔽，也不误报为认证失效',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-host-analysis-fail-'));mkdirSync(join(root,'reports'));
 try{writeFileSync(join(root,'reports/agent-mcp-DSH.json'),JSON.stringify({ok:true}));writeFileSync(join(root,'reports/agent-analysis-DSH.json'),JSON.stringify({ok:false,code:'AGENT_FAILED'}));const c=hostCapability({dataDir:root},'DSH',{});assert.equal(c.state,'latest_analysis_failed');assert.match(c.note,/既往成功证据保留/);assert.match(c.note,/不据普通失败推断需要重新登录/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('真实新渠道业务成功不再展示旧渠道名称，保留文本分析边界',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-host-recovered-'));mkdirSync(join(root,'reports'));
 try{writeFileSync(join(root,'reports/agent-route-DSH.json'),JSON.stringify({ok:true,at:'2026-10-22T14:14:40Z',provider:'workbuddy',model:'deepseek-v4.1-flash'}));writeFileSync(join(root,'reports/agent-analysis-DSH.json'),JSON.stringify({ok:true,at:'2026-10-22T14:15:37Z'}));writeFileSync(join(root,'reports/agent-mcp-DSH.json'),JSON.stringify({ok:true,provider:'old-TRAE'}));const c=hostCapability({dataDir:root},'DSH',{});assert.equal(c.state,'archive_analysis_verified');assert.match(c.note,/workbuddy/);assert.doesNotMatch(c.note,/old-TRAE/);assert.match(c.note,/不代表视听/);}finally{rmSync(root,{recursive:true,force:true});}
});
