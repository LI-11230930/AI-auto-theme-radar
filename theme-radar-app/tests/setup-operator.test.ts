import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {startOperator} from '../src/operator.ts';import {APP_ROOT} from '../src/config.ts';
test('配置检查HTTP只读，真实返回空安装条件且不产生判断或投递',async()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-setup-http-')),previous=process.env.THEME_RADAR_CONFIG;let server:Awaited<ReturnType<typeof startOperator>>|undefined;
 try{const config=join(root,'config.json');writeFileSync(config,JSON.stringify({dataDir:root,topics:[],recipient:null,xiaohongshu:{enabled:false},runners:{DSH:{command:process.execPath,prefixArgs:[],env:{}}}}));process.env.THEME_RADAR_CONFIG=config;
  server=await startOperator(0);await new Promise<void>(r=>server!.listening?r():server!.once('listening',r));const base='http://127.0.0.1:'+(server.address() as any).port;
  const state=await(await fetch(base+'/api/state')).json() as any;
  const response=await fetch(base+'/api/setup/status');assert.equal(response.status,200);const report=await response.json() as any;
  assert.equal(report.scope,'offline_local_configuration');assert.deepEqual(report.workflows[0].blockers,['topics']);
  const js=await fetch(base+'/assets/setup.js');assert.equal(js.status,200);assert.match(js.headers.get('content-type')!,/javascript/);
  const help=await fetch(base+'/help/install');assert.equal(help.status,200);assert.match(help.headers.get('content-type')!,/text\/plain/);assert.match(await help.text(),/setup-check/);
  const page=await(await fetch(base+'/')).text();assert.match(page,/id="setup-checks"/);assert.doesNotMatch(page,/href="http:\/\/127\.0\.0\.1:8766/);
  await fetch(base+'/api/setup/status');const final=await(await fetch(base+'/api/state')).json() as any;assert.deepEqual(final.stats,state.stats);assert.equal(final.stats.deliveries,0);assert.equal(final.stats.assessments,0);assert.equal(final.runtimeEnabled,false);
  assert.equal(JSON.parse(readFileSync(config,'utf8')).topics.length,0);
 }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;rmSync(root,{recursive:true,force:true});}
});
