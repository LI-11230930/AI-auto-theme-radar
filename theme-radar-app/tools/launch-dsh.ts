import {spawn} from 'node:child_process';import {resolve} from 'node:path';
import {APP_ROOT,loadConfig,configFilePath} from '../src/config.ts';import {prepareDshLaunch,reserveDshProcess} from '../src/dsh-launch.ts';import {publicError} from '../src/model.ts';
try{
 const args=process.argv.slice(2);let port=8789;for(let i=0;i<args.length;i++){if(args[i]==='--port'){if(!/^\d{4,5}$/.test(args[i+1]||''))throw Error('Invalid port');port=Number(args[++i]);}else if(!['--prepare','--no-open'].includes(args[i]))throw Error('Invalid option');}
 const configFile=configFilePath(),config=loadConfig(configFile),plan=prepareDshLaunch({spec:config.runners.DSH,appRoot:APP_ROOT,dataDir:config.dataDir,configFile,port,openBrowser:!args.includes('--no-open')});
 if(process.argv.includes('--prepare'))console.log(JSON.stringify({prepared:true,patch:plan.patch,globalProfileChanged:false,started:false}));
 else{
  console.log('正在启动主题雷达专用DSH网页会话：http://127.0.0.1:'+port+'/ 。使用原模型渠道和本项目MCP，未修改全局配置。输入任务后才会调用模型或阅读内容；可用app/stop-dsh.ps1停止本项目入口。');
  const record=resolve(config.dataDir,'integrations','dsh-web-process.json'),lease=reserveDshProcess(record);
  const child=spawn(plan.command,plan.args,{cwd:plan.cwd,env:{...process.env,...plan.env},shell:false,stdio:'inherit'});
  child.on('spawn',()=>lease.write({pid:child.pid,appRoot:APP_ROOT,patch:plan.patch,port,startedAt:new Date().toISOString()}));
  child.on('error',()=>{lease.release();console.error('无法启动DSH，请核对本地可执行入口。');process.exitCode=1;});
  child.on('exit',code=>{const stopping=lease.stopRequested();lease.release();process.exitCode=stopping?0:code??1;});
 }
}catch(error){console.error(JSON.stringify(publicError(error)));process.exitCode=1;}
