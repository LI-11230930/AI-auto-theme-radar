import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {commandAvailability,runnerSetup,setupStatus} from '../src/setup-status.ts';
import {APP_ROOT} from '../src/config.ts';
import {defaultMailTemplate} from '../src/mail-template.ts';
import {topic} from './fixtures.ts';

function fixture(fn:(config:any,root:string)=>void){const root=mkdtempSync(join(tmpdir(),'radar-ready-'));try{const config=JSON.parse(readFileSync(resolve(APP_ROOT,'config.example.json'),'utf8'));config.dataDir=root;config.bilibili.asr.modelDir=join(root,'model');config.runners.DSH.command=process.execPath;fn(config,root);}finally{rmSync(root,{recursive:true,force:true});}}
test('命令只按运行环境PATH定位，Windows包装脚本不被算为可执行入口',()=>fixture((config,root)=>{
  const bin=join(root,'bin');mkdirSync(bin);writeFileSync(join(bin,'only-wrapper.cmd'),'@exit /b 0');writeFileSync(join(bin,'actual.exe'),'fixture, never executed');
  assert.equal(commandAvailability('only-wrapper',root,{platform:'win32',env:{Path:bin}}),'shell_wrapper');
  assert.equal(commandAvailability('actual',root,{platform:'win32',env:{PATH:bin}}),'available');
  assert.equal(commandAvailability('not-on-path',root,{platform:'win32',env:{Path:bin}}),'missing');
  assert.equal(commandAvailability('anything.cmd',root),'shell_wrapper');
  assert.equal(commandAvailability(process.execPath,root),'available');
}));
test('Node存在但宿主升级移动CLI脚本、模型补丁丢失会分别指出',()=>fixture((config,root)=>{
  const cli=join(root,'cli.js'),patch=join(root,'model.yml');writeFileSync(cli,'');writeFileSync(patch,'');
  config.runners.DSH.prefixArgs=[cli,'--patch',patch];assert.equal(runnerSetup(config).state,'ready');
  config.runners.DSH.prefixArgs=[join(root,'moved.js'),'--patch',patch];assert.equal(runnerSetup(config).code,'RUNNER_SCRIPT_MISSING');
  config.runners.DSH.prefixArgs=[cli,'--patch='+join(root,'missing.yml')];assert.equal(runnerSetup(config).code,'RUNNER_PATCH_MISSING');
  config.runners.DSH.prefixArgs=[cli,'--patch'];assert.equal(runnerSetup(config).code,'RUNNER_PATCH_MISSING');
  config.runners.DSH.prefixArgs=[cli,'--profile','web'];assert.equal(runnerSetup(config).code,'RUNNER_RESERVED_ARGS');
}));
test('不能用工作区相对脚本冒充运行目录中存在的入口',()=>fixture((config,root)=>{
  writeFileSync(join(root,'relative.js'),'');config.runners.DSH.prefixArgs=['relative.js'];
  assert.equal(runnerSetup(config).code,'RUNNER_SCRIPT_MISSING');
}));
test('Windows runner专属Path覆盖进程PATH，不误用另一处同名入口',()=>fixture((config,root)=>{
  const bin=join(root,'override');mkdirSync(bin);writeFileSync(join(bin,'private-runner.exe'),'');
  config.runners.DSH.command='private-runner';config.runners.DSH.env={Path:bin};
  assert.equal(runnerSetup(config,{platform:'win32',env:{PATH:join(root,'absent')}}).state,'ready');
}));
test('WorkBuddy交互MCP与后台CLI分开，不把设置command误报为后台可用',()=>fixture((config)=>{
  config.defaultAgent='WorkBuddy';config.runners.WorkBuddy.command=process.execPath;
  assert.equal(runnerSetup(config).code,'INTERACTIVE_HOST');
}));
test('省略可选prefixArgs与显式空列表具有相同行为',()=>fixture(config=>{delete config.runners.DSH.prefixArgs;assert.equal(runnerSetup(config).state,'ready');}));
test('入口前置满足仍独立展示最新模型失败，缓存错误原文不会泄露',()=>fixture((config,root)=>{
  mkdirSync(join(root,'reports'));const path=join(root,'reports','agent-DSH.json');writeFileSync(path,JSON.stringify({ok:false,code:'RUNNER_TIMEOUT',message:'private-api-secret'}));
  const report=setupStatus(config,[topic]);assert.equal(report.workflows[0].localReady,true);assert.equal(report.modelProbe.state,'failed');assert.equal(report.modelProbe.code,'RUNNER_TIMEOUT');assert.equal(report.checks.find(c=>c.id==='model-response')?.state,'invalid');assert.doesNotMatch(JSON.stringify(report),/private-api-secret/);
  writeFileSync(path,JSON.stringify({ok:false,code:'private-secret-code'}));assert.equal(setupStatus(config,[topic]).modelProbe.code,'AGENT_FAILED');
}));
test('首次零主题、未配B站或ASR不会误报真实验收，也不阻断GitHub前置检查',()=>fixture((config)=>{
  let report=setupStatus(config,[]);assert.equal(report.liveVerified,false);assert.equal(report.workflows[0].localReady,false);assert.deepEqual(report.workflows[0].blockers,['topics']);
  report=setupStatus(config,[{...topic,platforms:['github']}]);assert.equal(report.workflows[0].localReady,true);assert.equal(report.workflows[1].localReady,false);assert.equal(report.checks.find(c=>c.id==='asr')?.state,'optional');assert.equal(report.modelInvoked,false);assert.equal(report.emailSent,false);
}));
test('本机凭据解析无效与登录缺失分开，检查不返回Cookie、邮箱、密钥或个人路径',()=>fixture((config,root)=>{
  config.bilibili.credentialFile=join(root,'secret.json');config.recipient='private@example.test';config.runners.DSH.env={MODEL_KEY:'never-publish-this'};
  writeFileSync(config.bilibili.credentialFile,JSON.stringify({sessdata:'sensitive-cookie;bad'}));
  let report=setupStatus(config,[topic],{env:{GITHUB_TOKEN:'github-private-token'}});
  assert.equal(report.checks.find(c=>c.id==='bilibili')?.state,'invalid');
  assert.doesNotMatch(JSON.stringify(report),/sensitive-cookie|never-publish-this|private@example|github-private-token/);assert.ok(!JSON.stringify(report).includes(root));
  writeFileSync(config.bilibili.credentialFile,JSON.stringify({sessdata:'valid-syntax-only'}));
  report=setupStatus(config,[topic]);assert.equal(report.workflows[1].localReady,true);assert.equal(report.liveVerified,false);
}));
test('可选ASR缺Python或模型只影响回退提示，存在文件不冒充已验证依赖',()=>fixture((config,root)=>{
  config.bilibili.asr.enabled=true;config.bilibili.asr.pythonCommand=process.execPath;
  let report=setupStatus(config,[topic]);assert.equal(report.checks.find(c=>c.id==='asr')?.state,'missing');assert.equal(report.workflows[0].localReady,true);
  mkdirSync(config.bilibili.asr.modelDir);for(const name of ['model.bin','config.json','tokenizer.json'])writeFileSync(join(config.bilibili.asr.modelDir,name),'fixture');
  report=setupStatus(config,[topic]);assert.equal(report.checks.find(c=>c.id==='asr')?.state,'ready');assert.match(report.checks.find(c=>c.id==='asr')!.detail,/未加载依赖/);
}));
test('损坏模板明确阻止草稿就绪，检查不自动覆盖文件或访问网络',()=>fixture((config,root)=>{
  const template=join(root,'mail-template.json');writeFileSync(template,'{"private":"invalid-template"}');
  const before=readdirSync(root),fetcher=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('network must not be called');};
  try{const report=setupStatus(config,[topic]);assert.equal(report.checks.find(c=>c.id==='template')?.state,'invalid');assert.ok(report.workflows[0].blockers.includes('template'));assert.deepEqual(readdirSync(root),before);assert.equal(readFileSync(template,'utf8'),'{"private":"invalid-template"}');}
  finally{globalThis.fetch=fetcher;}
  writeFileSync(template,JSON.stringify(defaultMailTemplate));assert.equal(setupStatus(config,[topic]).workflows[0].localReady,true);
}));
