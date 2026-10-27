import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { context, capabilityReport,liveProbe,runConfigured,writeReport,analyzeConfiguredArchive } from './service.ts';
import { Store } from './store.ts';
import { GitHubSource } from './github.ts';
import { FixtureRunner,runProcess,parseResult } from './runner.ts';
import { renderDigest,sendEmail } from './mail.ts';
import { runGithub } from './engine.ts';
import { latestDue, batchAt } from './time.ts';
import { RadarError,publicError,requireText } from './model.ts';
import { startOperator } from './operator.ts';
import{runConfiguredInterest}from'./interest-service.ts';
import{validateAsrSample}from'./asr-validation.ts';
import {setupStatus} from './setup-status.ts';
import {rehearseBackup,listBackups,createManagedBackup} from './backup.ts';
import {automationRequest} from './automation-client.ts';

const [command='help',...args]=process.argv.slice(2);
async function main(){
  if(command==='serve'){await startOperator(args[0]===undefined?undefined:Number(args[0]));return;}
  if(command==='backup-check'){console.log(JSON.stringify(rehearseBackup(resolve(requireText(args[0],'备份文件',2000))),null,2));return;}
  const {config,store}=context();
  try{
    if(command==='setup-check'){console.log(JSON.stringify(setupStatus(config,store.topics()),null,2));}
    else if(command==='automation'){const action=args[0]||'status';if(action==='status')console.log(JSON.stringify(await automationRequest(config,''),null,2));else if(action==='start')console.log(JSON.stringify(await automationRequest(config,'/start',{planId:requireText(args[1],'计划ID',80)}),null,2));else if(action==='save'){const input=JSON.parse(readFileSync(resolve(requireText(args[1],'计划文件',2000)),'utf8'));console.log(JSON.stringify(await automationRequest(config,'/save',input),null,2));}else throw new RadarError('INVALID_INPUT','automation支持status、start <id>、save <JSON文件>');}
    else if(command==='doctor'){const report=args.includes('--live')?await liveProbe(config,store):capabilityReport(config,store);const path=writeReport(config,args.includes('--live')?'live-probe.json':'doctor.json',report);console.log(JSON.stringify({report,path},null,2));}
    else if(command==='topics'){if(args[0]==='add'){const topic=JSON.parse(readFileSync(resolve(args[1]),'utf8'));console.log(JSON.stringify({revision:store.saveTopic(topic)}));}else console.log(JSON.stringify(store.topics(),null,2));}
    else if(command==='rank'){const result=await new GitHubSource().trending();store.rankingSnapshot(result.rows,result.collectedAt);console.log(JSON.stringify(result.rows,null,2));}
    else if(command==='run'){console.log(JSON.stringify(await runConfigured(config,store,args[0]||'*'),null,2));}
    else if(command==='archive'){console.log(JSON.stringify(store.search(args[0]||''),null,2));}
    else if(command==='analyze'){console.log(JSON.stringify(await analyzeConfiguredArchive(config,store,requireText(args[0],'主题ID',100),requireText(args[1],'条目ID',300)),null,2));}
    else if(command==='interest-round'){const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);try{console.log(JSON.stringify(await runConfiguredInterest(config,store,args[0]||'bilibili-interest-tools',3,controller.signal),null,2));}finally{process.off('SIGINT',abort);}}
    else if(command==='asr-check'){const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);try{console.log(JSON.stringify(await validateAsrSample(config,requireText(args[0],'视频BV号或链接',1000),controller.signal),null,2));}finally{process.off('SIGINT',abort);}}
    else if(command==='backup'){console.log(store.backup(resolve(args[0]||resolve(config.dataDir,'backups',Date.now()+'.sqlite'))));}
    else if(command==='backups'){console.log(JSON.stringify(args[0]==='create'?createManagedBackup(store,config.dataDir):listBackups(config.dataDir),null,2));}
    else if(command==='deliveries'){console.log(JSON.stringify(store.deliveries(),null,2));}
    else if(command==='cancel-prepared'){if(!args[0]||!args[1])throw new RadarError('INVALID_INPUT','需要投递ID与取消原因');const result=store.cancelPrepared(args[0],args.slice(1).join(' '));console.log(JSON.stringify({id:result.id,state:result.state,emailSent:false}));}
    else if(command==='recover'){console.log(JSON.stringify({uncertainDeliveries:store.recoverDeliveries()}));}
    else if(command==='send'){if(!args[0])throw new RadarError('INVALID_INPUT','需要已准备的投递ID');console.log(JSON.stringify(await sendEmail(config,store,args[0]),null,2));}
    else if(command==='probe-agent'){
      const name=args[0]||config.defaultAgent,spec=config.runners[name];if(!spec?.command)throw new RadarError('RUNNER_NOT_FOUND','未配置CLI入口');const cwd=resolve(config.dataDir,'runner-probe');mkdirSync(cwd,{recursive:true});
      const parameters=name==='DSH'?['--profile','headless','--json','-']:name==='Codex'?['exec','--skip-git-repo-check','--sandbox','read-only','--json','-']:['exec','--sandbox','read-only','--json','-'];
      try{const result=await runProcess(spec.command,[...(spec.prefixArgs||[]),...parameters],'This is a minimal integration check. Do not read files, call tools, write, or access the network. Reply only with the JSON object {"ok":true,"kind":"theme-radar-runtime-check"}.',{cwd,env:spec.env,timeoutMs:30000,maxBytes:200000});const final=parseResult(result.stdout);if(final.ok!==true||final.kind!=='theme-radar-runtime-check')throw new RadarError('INVALID_AGENT_OUTPUT','运行探针结果不匹配');const report={agent:name,at:new Date().toISOString(),ok:true,final,scope:'minimal text response; not full MCP acceptance'};console.log(JSON.stringify({report,path:writeReport(config,`agent-${name}.json`,report)},null,2));}
      catch(e){const report={agent:name,at:new Date().toISOString(),ok:false,code:(e as RadarError).code||'ERROR',message:publicError(e).message};console.log(JSON.stringify({report,path:writeReport(config,`agent-${name}.json`,report)},null,2));process.exitCode=2;}
    }
    else if(command==='demo'){
      const {topic,mockFetch}=await import('../tests/fixtures.ts');const root=mkdtempSync(resolve(config.dataDir,'demo-')),demoStore=new Store(resolve(root,'demo.sqlite'));try{demoStore.saveTopic(topic);const report=await runGithub({recipient:"demo@example.com",store:demoStore,source:new GitHubSource(mockFetch),runner:new FixtureRunner(),topicId:topic.id,batch:batchAt('2026-10-19','09:00'),outputDir:root,limit:1});console.log(JSON.stringify({...report,isolated:true,note:'固定样例，未调用真实模型，未发邮件或评论'},null,2));}finally{demoStore.close();}
    }
    else if(command==='preview-live'){
      const source=new GitHubSource(),warnings=['真实公开页面采集验证；未调用模型，主题精选为空；未发送邮件。'];let rows:any[]=[];try{rows=(await source.trending()).rows;}catch(e){warnings.push((e as Error).message);}const digest=renderDigest({batch:latestDue(),entries:[],rankings:rows,warnings});const folder=resolve(config.dataDir,'previews');mkdirSync(folder,{recursive:true});const path=resolve(folder,'collection-preview.html');writeFileSync(path,digest.html);console.log(JSON.stringify({preview:path,ranked:rows.length,actualModelRun:false,emailSent:false,warnings},null,2));
    }
    else console.log('Theme Radar\nnode src/cli.ts automation status\nnode src/cli.ts automation start <planId>\nnode src/cli.ts automation save <plan-request.json>\nnode src/cli.ts setup-check\nnode src/cli.ts doctor [--live]\nnode src/cli.ts demo\nnode src/cli.ts topics add topic.json\nnode src/cli.ts run [topicId|*]\nnode src/cli.ts analyze <topicId> <itemKey>\nnode src/cli.ts interest-round [bilibili-interest-tools]\nnode src/cli.ts asr-check <BV>\nnode src/cli.ts preview-live\nnode src/cli.ts archive [query]\nnode src/cli.ts backup [path]\nnode src/cli.ts backups [create]\nnode src/cli.ts backup-check <backup.sqlite>\nnode src/cli.ts serve [8767]\nnode src/mcp.ts\n真实发送默认禁用；统一计划明确启用后由本地服务调度。');
  }finally{store.close();}
}
main().catch(error=>{console.error(JSON.stringify({ok:false,...publicError(error)}));process.exitCode=1;});
