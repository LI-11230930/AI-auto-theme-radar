import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {resolve} from 'node:path';import {once} from 'node:events';import {startOperator} from '../src/operator.ts';import {topic,fixturePlan} from './fixtures.ts';
test('简洁工作台真实HTTP提供静态资源，保存有发送授权的手动计划不会开始轮次或创建定时',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-workbench-')),file=resolve(dir,'config.json'),prior=process.env.THEME_RADAR_CONFIG;writeFileSync(file,JSON.stringify({dataDir:resolve(dir,'data'),topics:[{...topic,bilibiliDiscovery:'interests',bilibiliAuthors:[]}]}));process.env.THEME_RADAR_CONFIG=file;const server=await startOperator(0),base='http://127.0.0.1:'+(server.address() as any).port;
 try{const state=await(await fetch(base+'/api/state')).json() as any;const html=await(await fetch(base+'/')).text();assert.match(html,/workbench-core\.js/);assert.match(html,/workbench\.css/);assert.match(html,/我的信息工作台/);
 for(const asset of ['workbench.css','workbench.js','workbench-core.js']){const response=await fetch(base+'/assets/'+asset);assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,asset.endsWith('css')?/text\/css/:/javascript/);assert.ok((await response.text()).length>100);}
 const plan=fixturePlan({id:'personal-radar',agent:'Codex',execution:'attached',enabled:true,delivery:'host',sendApproved:true,from:'sender@example.com',recipient:'receiver@example.com',platforms:['bilibili','github'],schedule:{kind:'manual'}});
 const response=await fetch(base+'/api/automation/save',{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':state.token},body:JSON.stringify({plan,expectedRevision:0})});assert.equal(response.status,200);
 const current=await(await fetch(base+'/api/automation')).json() as any;assert.equal(current.plans[0].delivery,'host');assert.equal(current.plans[0].schedule.kind,'manual');assert.equal(current.plans[0].scheduleStatus.nextAt,null);assert.equal(current.runs.length,0);const after=await(await fetch(base+'/api/state')).json() as any;assert.equal(after.stats.deliveries,0);assert.equal(after.stats.assessments,0);
 }finally{const closed=once(server,'close');server.close();await closed;if(prior===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=prior;rmSync(dir,{recursive:true,force:true});}
});
test('显式凭据失效时配置界面仍可启动，状态不冒充已认证',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-credential-http-')),file=resolve(dir,'config.json'),credential=resolve(dir,'github.json'),prior=process.env.THEME_RADAR_CONFIG,priorToken=process.env.GITHUB_TOKEN;
 writeFileSync(credential,JSON.stringify({version:1,createdAt:'2000-01-01T00:00:00Z',expiresAt:'2000-01-02T00:00:00Z',encryptedToken:'synthetic-expired'}));
 writeFileSync(file,JSON.stringify({dataDir:resolve(dir,'data'),topics:[],github:{credentialFile:credential}}));process.env.THEME_RADAR_CONFIG=file;delete process.env.GITHUB_TOKEN;
 const server=await startOperator(0),base='http://127.0.0.1:'+(server.address() as any).port;
 try{assert.equal((await fetch(base+'/')).status,200);const state=await(await fetch(base+'/api/state')).json() as any;assert.equal(state.githubCredential.code,'GITHUB_CREDENTIAL_EXPIRED');assert.equal(state.githubCredential.liveVerified,false);assert.equal(state.service.restartRequired,false);assert.equal(JSON.stringify(state).includes('synthetic-expired'),false);}
 finally{const closed=once(server,'close');server.close();await closed;if(prior===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=prior;if(priorToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=priorToken;rmSync(dir,{recursive:true,force:true});}
});
test('真实HTTP一次保存同步两个平台，暂停唤醒不被显示成自动执行就绪',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-linked-http-')),file=resolve(dir,'config.json'),prior=process.env.THEME_RADAR_CONFIG;
 writeFileSync(file,JSON.stringify({dataDir:resolve(dir,'data'),topics:[{...topic,platforms:['bilibili','github'],bilibiliDiscovery:'interests',bilibiliAuthors:[]}]}));process.env.THEME_RADAR_CONFIG=file;
 const server=await startOperator(0),base='http://127.0.0.1:'+(server.address() as any).port;
 try{
  const state=await(await fetch(base+'/api/state')).json() as any;
  const post=async(path:string,body:any)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':state.token},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json() as Promise<any>;};
  const plan=fixturePlan({id:'personal-radar',agent:'Codex',execution:'attached',enabled:true,delivery:'host',sendApproved:true,from:'sender@example.com',recipient:'receiver@example.com',platforms:['bilibili','github'],schedule:{kind:'manual'}});
  let saved=await post('/api/automation/save',{plan,expectedRevision:0});await post('/api/automation/platforms/set',{platform:'github',enabled:true});await post('/api/automation/platforms/set',{platform:'bilibili',enabled:false});
  saved=await post('/api/automation/save',{plan:{...saved,agent:'TRAE',recipient:'new@example.com'},expectedRevision:saved.revision});
  const view=await(await fetch(base+'/api/automation/platforms')).json() as any;
  assert.equal(view.platforms[0].enabled,true);assert.equal(view.platforms[1].enabled,false);
  for(const row of view.platforms){assert.equal(row.plan.agent,'TRAE');assert.equal(row.plan.recipient,'new@example.com');assert.equal(row.configurationCurrent,true);assert.equal(row.nextRunAt,null);}
  assert.equal(view.platforms[0].execution.state,'needs_wakeup');assert.equal(view.platforms[0].mailbox.state,'requires_host_check');
  const runs=await(await fetch(base+'/api/automation')).json() as any;assert.equal(runs.runs.length,0);assert.equal((await(await fetch(base+'/api/state')).json() as any).stats.deliveries,0);
 }finally{const closed=once(server,'close');server.close();await closed;if(prior===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=prior;rmSync(dir,{recursive:true,force:true});}
});
