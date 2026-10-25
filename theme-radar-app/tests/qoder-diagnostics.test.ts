import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {classifyRunnerFailure} from '../src/runner.ts';
import {hostCapability} from '../src/host-capability.ts';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
test('DSH中文凭据错误识别为授权缺失，普通失败和超时描述不误判登录',()=>{
 const event=message=>JSON.stringify({type:'status',phase:'turn_end',reason:{kind:'error',error:{message}}});
 assert.equal(classifyRunnerFailure(event('未配置凭据，请先登录'),''),'AUTH_REQUIRED');
 assert.equal(classifyRunnerFailure(event('凭据已过期'),''),'AUTH_REQUIRED');
 assert.equal(classifyRunnerFailure(event('上游返回不完整JSON'),''),'AGENT_FAILED');
 assert.equal(classifyRunnerFailure(event('运行超出时间预算'),''),'AGENT_FAILED');
});
test('新渠道探针超时优先于旧渠道成功，后续真实分析结果优先于旧探针',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-route-'));mkdirSync(join(root,'reports'));
 try{const put=(n,d)=>writeFileSync(join(root,'reports/'+n+'.json'),JSON.stringify(d));
 put('agent-mcp-DSH',{ok:true,at:'2026-10-21T00:00:00Z',provider:'old'});
 put('agent-route-DSH',{ok:false,at:'2026-10-22T14:03:35Z',code:'RUNNER_TIMEOUT',provider:'qodercn',model:'dfmodel'});
 assert.equal(hostCapability({dataDir:root},'DSH',{}).state,'route_probe_timeout');
 assert.match(hostCapability({dataDir:root},'DSH',{}).note,/不等同于授权失效/);
 put('agent-analysis-DSH',{ok:false,at:'2026-10-22T14:10:00Z',code:'AGENT_FAILED'});
 assert.equal(hostCapability({dataDir:root},'DSH',{}).state,'latest_analysis_failed');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('失效项目补丁在历史授权前报告，PATH入口与无补丁交互宿主保持原行为',()=>{
 const root=join(tmpdir(),'radar-missing-qoder-fixture');
 const actual=hostCapability({dataDir:root},'DSH',{command:'dsh',prefixArgs:['--patch',join(root,'missing.yml')]});
 assert.equal(actual.state,'runner_patch_missing');assert.match(actual.note,/不据此要求重新登录/);
 assert.equal(hostCapability({dataDir:root},'WorkBuddy',{}).state,'interactive_mcp');
 assert.equal(hostCapability({dataDir:root},'DSH',{command:'dsh'}).state,'configured_unverified');
});
