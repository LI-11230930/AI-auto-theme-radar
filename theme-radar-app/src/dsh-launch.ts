import {mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve,dirname} from 'node:path';import {pathToFileURL} from 'node:url';
import {RadarError} from './model.ts';

export function reserveDshProcess(file:string){
 const owner=randomUUID();mkdirSync(dirname(file),{recursive:true});
 try{writeFileSync(file,JSON.stringify({owner,pid:process.pid,state:'starting'}),{flag:'wx'});}catch(error){
  if((error as any).code!=='EEXIST')throw error;
  let previous:any;try{previous=JSON.parse(readFileSync(file,'utf8'));if(!Number.isSafeInteger(previous.pid)||previous.pid<1)throw Error();}catch{throw new RadarError('DSH_PROCESS_UNKNOWN','DSH入口进程记录无法核对，未覆盖；请先检查本项目记录');}
  let alive=true;try{process.kill(previous.pid,0);}catch(e){if((e as any).code==='ESRCH')alive=false;}
  if(alive)throw new RadarError('DSH_ALREADY_RUNNING','本项目DSH入口已经运行或正在启动；请使用已有页面，不重复启动');
  unlinkSync(file);try{writeFileSync(file,JSON.stringify({owner,pid:process.pid,state:'starting'}),{flag:'wx'});}catch{throw new RadarError('DSH_ALREADY_RUNNING','另一个入口已领取启动，未覆盖');}
 }
 const owned=()=>{try{return JSON.parse(readFileSync(file,'utf8')).owner===owner;}catch{return false;}};
 return {write:(data:any)=>{if(!owned())throw new RadarError('DSH_PROCESS_UNKNOWN','DSH入口记录已变化，未覆盖');writeFileSync(file,JSON.stringify({...data,owner},null,2));},stopRequested:()=>{try{return owned()&&JSON.parse(readFileSync(file,'utf8')).stopRequested===true;}catch{return false;}},release:()=>{if(owned())unlinkSync(file);}};
}

/** Project-only overlay. Never installs a plugin or changes the host's global profile. */
export function prepareDshLaunch(options:{spec:any;appRoot:string;dataDir:string;configFile:string;nodeCommand?:string;profile?:'web'|'headless';port?:number;openBrowser?:boolean}){
 const {spec}=options;
 if(!spec||typeof spec.command!=='string'||!spec.command.trim()||/\.(cmd|bat)$/i.test(spec.command)||!Array.isArray(spec.prefixArgs)||spec.prefixArgs.some(v=>typeof v!=='string'||/[\r\n\0]/.test(v)))throw new RadarError('DSH_NOT_CONFIGURED','请先配置已安装DSH的真实可执行入口与prefixArgs');
 const args=[...spec.prefixArgs],cli=args.find(v=>v.endsWith('dsh-desktop-host/lib/cli.js')||v.endsWith('dsh-desktop-host\\lib\\cli.js'));
 if(!cli||args.some(v=>['--profile','--json','--patch='].includes(v)||v.startsWith('--patch=')))throw new RadarError('DSH_NOT_CONFIGURED','需要DSH desktop-host CLI入口；prefixArgs不能包含运行模式');
 const patches=args.filter(v=>v==='--patch').length;if(patches>1)throw new RadarError('DSH_NOT_CONFIGURED','当前仅支持一个既有模型补丁，请先合并本地配置');
 let overlay='';const at=args.indexOf('--patch');if(at>=0){const file=args[at+1];if(!file||file.startsWith('--'))throw new RadarError('DSH_NOT_CONFIGURED','模型补丁路径缺失');try{overlay=readFileSync(file,'utf8');}catch{throw new RadarError('DSH_NOT_CONFIGURED','无法读取既有DSH模型补丁');}args.splice(at,2);}
 if(/(?:^|\n)\s*serverName:\s*["']?theme-radar["']?\s*(?:\r?\n|$)/.test(overlay))throw new RadarError('DSH_NOT_CONFIGURED','既有补丁已包含theme-radar；请使用原入口，避免重复注册');
 const profile=options.profile??'web',port=options.port??8789;
 if(!['web','headless'].includes(profile)||!Number.isSafeInteger(port)||(port!==0&&(port<1024||port>65535)))throw new RadarError('DSH_NOT_CONFIGURED','请选择web交互或headless验证模式及有效本机端口');
 // A minimal headless overlay may disable service providers required by the
 // web standard preset. Restore providers in this launch only; no tool runs here.
 if(profile==='web')overlay+='\n- id: subagent\n  disabled: false\n- id: web\n  disabled: false\n';
 const modules=dirname(dirname(dirname(dirname(cli)))),client=pathToFileURL(resolve(modules,'@deepseek-ai/dsh-mcp-client/lib/index.js')).href;
 const folder=resolve(options.dataDir,'integrations'),patch=resolve(folder,'dsh-theme-radar.local.yml');mkdirSync(folder,{recursive:true});
 const value=(v:string)=>JSON.stringify(v);
 writeFileSync(patch,overlay+'\n- insert:\n    - id: theme-radar-project-client\n      name: '+value(client)+'\n      config:\n        serverName: theme-radar\n        transport: stdio\n        command: '+value(options.nodeCommand||process.execPath)+'\n        args: ['+value(resolve(options.appRoot,'src/mcp.ts'))+']\n        env:\n          THEME_RADAR_CONFIG: '+value(resolve(options.configFile))+'\n        failOnStartupError: true\n');
 return {command:spec.command,args:[...args,'--profile',profile,'--patch',patch,...(profile==='web'?['--host','127.0.0.1','--port',String(port),...(options.openBrowser===false?['--no-open']:[])]:[])],env:spec.env,patch,cwd:options.appRoot,port};
}
