import test from 'node:test';import assert from 'node:assert/strict';import {githubReadCapability} from '../src/capability-summary.ts';import {capabilityReport} from '../src/service.ts';import {Store} from '../src/store.ts';import {loadConfig} from '../src/config.ts';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {resolve} from 'node:path';import {startOperator} from '../src/operator.ts';
test('显式凭据受阻或未加载时，GitHub能力不能仍显示可读',()=>{
 for(const code of ['GITHUB_CREDENTIAL_EXPIRED','GITHUB_CREDENTIAL_INVALID','GITHUB_CREDENTIAL_RELOAD_REQUIRED','GITHUB_CREDENTIAL_UNSUPPORTED','GITHUB_CREDENTIAL_DECRYPT_TIMEOUT']){const c=githubReadCapability({state:'blocked',source:'protected_file',code});assert.equal(c.state,'credential_blocked');assert.equal(c.code,code);assert.equal(c.liveVerified,false);assert.match(c.note,/不降级匿名/);}
 const c=githubReadCapability({state:'not_loaded',source:'protected_file'});assert.equal(c.state,'credential_not_loaded');assert.equal(c.code,'GITHUB_CREDENTIAL_UNAVAILABLE');
});
test('凭据受阻优先于限流，两类信息仍同时保留',()=>{
 const until='2030-01-01T00:00:00Z',c=githubReadCapability({state:'blocked',source:'protected_file',code:'GITHUB_CREDENTIAL_EXPIRED'},{retryAt:until});assert.equal(c.state,'credential_blocked');assert.equal(c.retryAt,until);assert.match(c.note,/同时存在API冷却/);
});
test('已配置和匿名只说明本机状态，不声称当前联网已验证',()=>{
 for(const state of ['configured','anonymous']){const c=githubReadCapability({state,source:state==='configured'?'environment':'none'});assert.equal(c.state,'available_public_read');assert.equal(c.liveVerified,false);assert.equal(c.credentialState,state);assert.equal(c.code,undefined);}assert.match(githubReadCapability({state:'anonymous',source:'none'}).note,/匿名额度/);
});
test('正常凭据下冷却仍阻止读取，过期信息不丢失',()=>{
 const c=githubReadCapability({state:'configured',source:'environment'},{retryAt:'2030-01-01T00:00:00Z'});assert.equal(c.state,'rate_limit_cooldown');assert.equal(c.retryAt,'2030-01-01T00:00:00Z');assert.equal(c.liveVerified,false);
});
test('同一能力报告的凭据与GitHub栏状态一致，只读不写账本或配置',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-github-status-')),file=resolve(dir,'config.json');writeFileSync(file,JSON.stringify({dataDir:dir,topics:[],github:{credentialFile:'missing.cred'}}));const old=process.env.GITHUB_TOKEN;delete process.env.GITHUB_TOKEN;const s=new Store(':memory:');try{const c=loadConfig(file),before=s.stats(),r=capabilityReport(c,s),github=r.capabilities.find(v=>v.id==='github') as any;assert.equal(r.githubCredential.state,'blocked');assert.equal(github.state,'credential_blocked');assert.equal(github.code,r.githubCredential.code);assert.deepEqual(s.stats(),before);assert.doesNotMatch(github.note,/missing\.cred|radar-github-status/);}finally{s.close();if(old!==undefined)process.env.GITHUB_TOKEN=old;rmSync(dir,{recursive:true,force:true});}
});
test('真实HTTP坏凭据可进入修复页，状态明确阻止且没有业务轮次',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-github-status-http-')),file=resolve(dir,'config.json'),previous=process.env.THEME_RADAR_CONFIG,token=process.env.GITHUB_TOKEN;delete process.env.GITHUB_TOKEN;writeFileSync(file,JSON.stringify({dataDir:resolve(dir,'data'),topics:[],github:{credentialFile:'missing.cred'}}));process.env.THEME_RADAR_CONFIG=file;const server=await startOperator(0),base='http://127.0.0.1:'+(server.address() as any).port;
 try{const response=await fetch(base+'/api/state');assert.equal(response.status,200);const d=await response.json() as any,c=d.capabilities.find(v=>v.id==='github');assert.equal(c.state,'credential_blocked');assert.equal(c.code,d.githubCredential.code);assert.equal((await fetch(base+'/')).status,200);assert.equal(d.stats.items,0);assert.equal(d.stats.jobs,0);assert.equal(d.stats.deliveries,0);}finally{await new Promise<void>(done=>server.close(()=>done()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;if(token===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=token;rmSync(dir,{recursive:true,force:true});}
});
