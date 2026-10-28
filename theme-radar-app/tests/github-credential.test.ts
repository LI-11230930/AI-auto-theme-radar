import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {initializeGithubCredential,githubCredentialStatus,requireGithubCredential} from '../src/github-credential.ts';
import {GitHubSource} from '../src/github.ts';
import {spawnSync} from 'node:child_process';
const fakeToken='github_pat_'+'synthetic_test_only_1234567890';
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'radar-credential-')),file=join(dir,'github.json'),clock=Date.parse('2026-10-28T04:00:00Z'),env:any={};t.after(()=>{initializeGithubCredential({}, {env:{}});rmSync(dir,{recursive:true,force:true});});const saved={version:1,createdAt:'2026-10-27T08:00:00Z',expiresAt:'2026-11-03T08:00:00Z',encryptedToken:'synthetic-encrypted-payload'};writeFileSync(file,JSON.stringify(saved));return {file,clock,env,saved,config:{github:{credentialFile:file}}};}
test('空安装允许匿名配置，不调用解密；环境变量不被覆盖',t=>{
 const x=fixture(t);let calls=0;assert.equal(initializeGithubCredential({}, {env:x.env,clock:x.clock,decrypt:()=>{calls++;return fakeToken;}}).state,'anonymous');
 x.env.GITHUB_TOKEN='existing-environment-value';const s=initializeGithubCredential(x.config,{env:x.env,clock:x.clock,decrypt:()=>{calls++;return fakeToken;}});assert.equal(s.source,'environment');assert.equal(calls,0);assert.equal(x.env.GITHUB_TOKEN,'existing-environment-value');
});
test('启动加载显式加密凭据；状态不包含令牌、密文或路径，也不冒充服务器认证',t=>{
 const x=fixture(t),s=initializeGithubCredential(x.config,{env:x.env,clock:x.clock,decrypt:value=>{assert.equal(value,x.saved.encryptedToken);return fakeToken;}});
 assert.equal(s.state,'configured');assert.equal(s.source,'protected_file');assert.equal(s.liveVerified,false);assert.equal(x.env.GITHUB_TOKEN,fakeToken);assert.equal(s.storedExpiresAt,x.saved.expiresAt);
 const text=JSON.stringify(s);for(const secret of [fakeToken,x.saved.encryptedToken,x.file])assert.equal(text.includes(secret),false);
 assert.doesNotThrow(()=>requireGithubCredential());
});
test('保管期限到期不解密，显式凭据失效时不降级匿名请求',async t=>{
 const x=fixture(t);let decrypted=0,fetched=0;const s=initializeGithubCredential(x.config,{env:x.env,clock:Date.parse('2026-11-04T00:00:00Z'),decrypt:()=>{decrypted++;return fakeToken;}});
 assert.equal(s.code,'GITHUB_CREDENTIAL_EXPIRED');assert.equal(decrypted,0);await assert.rejects(new GitHubSource(async()=>{fetched++;return Response.json({});}).trending('daily'),{code:'GITHUB_CREDENTIAL_EXPIRED'});assert.equal(fetched,0);
});
test('无效、丢失及其他系统凭据显示可处理错误而不泄露原异常',t=>{
 const x=fixture(t);writeFileSync(x.file,'{invalid');assert.equal(initializeGithubCredential(x.config,{env:x.env,clock:x.clock}).code,'GITHUB_CREDENTIAL_INVALID');
 rmSync(x.file);assert.equal(initializeGithubCredential(x.config,{env:x.env,clock:x.clock}).code,'GITHUB_CREDENTIAL_UNAVAILABLE');writeFileSync(x.file,JSON.stringify(x.saved));assert.equal(initializeGithubCredential(x.config,{env:x.env,clock:x.clock,platform:'linux'}).code,'GITHUB_CREDENTIAL_UNSUPPORTED');
});
test('解密失败不输出密文或原错误内容，界面状态仍可读取',t=>{
 const x=fixture(t),s=initializeGithubCredential(x.config,{env:x.env,clock:x.clock,decrypt:()=>{throw Error(fakeToken);}});assert.equal(s.code,'GITHUB_CREDENTIAL_DECRYPT_FAILED');assert.equal(JSON.stringify(s).includes(fakeToken),false);assert.equal(x.env.GITHUB_TOKEN,undefined);assert.equal(githubCredentialStatus().state,'blocked');
});
test('更新已保存凭据准确报告需要重启，而非要求再次输入或继续使用旧值',t=>{
 const x=fixture(t);initializeGithubCredential(x.config,{env:x.env,clock:x.clock,decrypt:()=>fakeToken});writeFileSync(x.file,JSON.stringify({...x.saved,encryptedToken:'updated-ciphertext'}));const s=githubCredentialStatus();assert.equal(s.code,'GITHUB_CREDENTIAL_RELOAD_REQUIRED');assert.equal(s.reloadRequired,true);assert.throws(()=>requireGithubCredential(),{code:'GITHUB_CREDENTIAL_RELOAD_REQUIRED'});
});
test('切换配置不把本进程解密的凭据带到另一个配置中',t=>{
 const x=fixture(t);initializeGithubCredential(x.config,{env:x.env,clock:x.clock,decrypt:()=>fakeToken});assert.equal(initializeGithubCredential({}, {env:x.env,clock:x.clock}).state,'anonymous');assert.equal(x.env.GITHUB_TOKEN,undefined);
});
test('Windows真实加解密不受宿主PowerShell7模块路径影响',{skip:process.platform!=='win32'},t=>{
 const x=fixture(t),env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
 const executable=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const encrypted=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',"$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -AsPlainText -Force;try{[Console]::Out.Write((ConvertFrom-SecureString -SecureString $s))}finally{$s.Dispose()}"],{env,input:fakeToken,encoding:'utf8',windowsHide:true,timeout:8000});assert.equal(encrypted.status,0);
 writeFileSync(x.file,JSON.stringify({...x.saved,encryptedToken:encrypted.stdout.trim()}));const previous=process.env.PSModulePath;process.env.PSModulePath=join(tmpdir(),'synthetic-powershell7-only');
 try{const state=initializeGithubCredential(x.config,{env:x.env,clock:x.clock});assert.equal(state.state,'configured');assert.equal(x.env.GITHUB_TOKEN,fakeToken);}finally{if(previous===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=previous;}
});
