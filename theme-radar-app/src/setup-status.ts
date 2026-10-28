import {githubCredentialStatus} from './github-credential.ts';
import {accessSync,constants,lstatSync,statSync,readFileSync} from 'node:fs';
import {delimiter,isAbsolute,resolve} from 'node:path';
import {BilibiliSource} from './bilibili.ts';
import {loadMailTemplate} from './mail-template.ts';
import type {Topic} from './model.ts';
import {asarEntryExists} from './asar-entry.ts';

type Check={id:string;state:'ready'|'missing'|'invalid'|'optional';title:string;detail:string;action:string;href:string};
type Environment={platform?:NodeJS.Platform;env?:NodeJS.ProcessEnv};
const file=(path:string,executable=false)=>{try{if(!statSync(path).isFile())return false;accessSync(path,executable?constants.X_OK:constants.R_OK);return true;}catch{return false;}};

/** Resolve without executing a command, reading its output or returning private paths. */
export function commandAvailability(command:unknown,cwd:string,options:Environment={}){
  if(typeof command!=='string'||!command.trim()||/[\r\n\0]/.test(command))return 'missing';
  if(/\.(?:cmd|bat)$/i.test(command))return 'shell_wrapper';
  const windows=(options.platform??process.platform)==='win32',env=options.env??process.env;
  const path=Object.entries(env).find(([k])=>windows?k.toLowerCase()==='path':k==='PATH')?.[1]||'';
  const direct=isAbsolute(command)||/[\\/]/.test(command);
  const folders=direct?['']:path.split(windows?';':delimiter).filter(Boolean).map(p=>p.replace(/^"(.*)"$/,'$1'));
  const extensions=windows&&!/\.[^\\/]+$/.test(command)?['','.exe','.com']:[''];
  for(const folder of folders)for(const extension of extensions){const candidate=direct?resolve(cwd,command+extension):resolve(cwd,folder,command+extension);if(file(candidate,!windows))return 'available';}
  if(windows&&!direct&&folders.some(folder=>['.cmd','.bat'].some(ext=>file(resolve(cwd,folder,command+ext)))))return 'shell_wrapper';
  return 'missing';
}

export function runnerSetup(config:any,options:Environment={}){
  const id=config.defaultAgent,spec=config.runners?.[id],cwd=resolve(config.dataDir,'runner','setup-check');
  if(id==='WorkBuddy'||!spec?.command)return {state:'missing' as const,code:'INTERACTIVE_HOST',detail:'当前选择的是交互宿主或未配置后台CLI。可用当前宿主的MCP阅读接力；网页一键轮次需要DSH、Codex或TRAE的可用后台入口。'};
  const prefixArgs=spec.prefixArgs??[];
  if(!Array.isArray(prefixArgs)||prefixArgs.some((v:unknown)=>typeof v!=='string'||/[\r\n\0]/.test(v)))return {state:'invalid' as const,code:'INVALID_RUNNER_ARGS',detail:'prefixArgs需要字符串列表，不能包含换行。请按INSTALL.md配置入口参数。'};
  const platform=options.platform??process.platform,env={...(options.env??process.env)};
  for(const [key,value] of Object.entries(spec.env||{})){
    if(platform==='win32')for(const existing of Object.keys(env))if(existing.toLowerCase()===key.toLowerCase())delete env[existing];
    env[key]=value as string;
  }
  const availability=commandAvailability(spec.command,cwd,{platform,env});
  if(availability!=='available')return {state:'missing' as const,code:availability==='shell_wrapper'?'EXECUTABLE_REQUIRED':'RUNNER_NOT_FOUND',detail:availability==='shell_wrapper'?'发现cmd/bat包装入口，后台以无shell方式运行。请配置实际exe，或node加CLI脚本的入口。':'配置的后台命令不在有效PATH中，或对应文件不存在/不可执行。请核对应用更新后的真实入口。'};
  const args=prefixArgs as string[];
  const scriptAvailable=(path:string)=>file(path)||(id==='DSH'&&args.includes('--expose-internals')&&asarEntryExists(path));
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    const patch=arg==='--patch'?args[i+1]:arg.startsWith('--patch=')?arg.slice(8):null;
    if((arg==='--patch'||arg.startsWith('--patch='))&&(!patch||!file(resolve(cwd,patch))))return {state:'missing' as const,code:'RUNNER_PATCH_MISSING',detail:'模型补丁文件不可读取。请核对prefixArgs内--patch路径；不要重新登录或覆盖现有配置。'};
    if(!arg.startsWith('-')&&/\.(?:mjs|cjs|js|ts)$/i.test(arg)&&!scriptAvailable(resolve(cwd,arg)))return {state:'missing' as const,code:'RUNNER_SCRIPT_MISSING',detail:'CLI脚本不可读取。可执行入口存在，但其脚本可能已随宿主升级移动；请更新prefixArgs中的绝对路径。'};
  }
  if(id==='DSH'&&args.some(a=>a==='--profile'||a.startsWith('--profile=')||a==='--json'))return {state:'invalid' as const,code:'RUNNER_RESERVED_ARGS',detail:'DSH的prefixArgs不应包含--profile或--json；运行器会按场景添加，保留入口脚本和模型补丁即可。'};
  return {state:'ready' as const,code:'LOCAL_ENTRY_FOUND',detail:'后台命令、CLI脚本（含支持的Electron归档入口）和补丁已在本机定位；模型授权与实际响应需另做真实调用验证。'};
}

/** Offline preflight only: never calls models, upstream platforms or mail transports. */
export function setupStatus(config:any,topics:Topic[],options:Environment={}){
  const checks:Check[]=[],add=(id:string,state:Check['state'],title:string,detail:string,action:string,href:string)=>checks.push({id,state,title,detail,action,href});
  const [major,minor]=process.versions.node.split('.').map(Number),enabled=topics.filter(t=>t.enabled),runner=runnerSetup(config,options);
  add('node',major===24&&minor>=14?'ready':'invalid','Node运行环境',`当前Node ${process.versions.node}；需要24.14以上的24.x。`,'查看安装与环境说明','/help/install');
  add('topics',enabled.length?'ready':'missing','订阅主题',enabled.length?`已有${enabled.length}个启用的自定义主题。`:'尚无启用主题，首次安装不会预置个人订阅。','创建或启用自己的主题','#topic-form');
  add('runner',runner.state,`后台分析器 · ${config.defaultAgent}`,runner.detail,'查看后台入口配置与真实模型检查方法','/help/install');
  let modelProbe:{state:'not_recorded'|'passed'|'failed';checkedAt?:string;code?:string}={state:'not_recorded'};
  try{
    const path=resolve(config.dataDir,'reports',`agent-${config.defaultAgent}.json`),saved=JSON.parse(readFileSync(path,'utf8'));
    if(typeof saved.ok==='boolean'){
      const known=['RUNNER_TIMEOUT','AUTH_REQUIRED','RUNNER_NOT_FOUND','INVALID_AGENT_OUTPUT','MODEL_QUOTA_EXCEEDED','PROVIDER_CHANNEL_REJECTED','AGENT_FAILED'];
      modelProbe={state:saved.ok?'passed':'failed',checkedAt:statSync(path).mtime.toISOString(),...(!saved.ok?{code:known.includes(saved.code)?saved.code:'AGENT_FAILED'}:{})};
    }
  }catch{}
  add('model-response',modelProbe.state==='failed'?'invalid':'optional','最近模型响应检查',modelProbe.state==='failed'?`最近保存的最小响应检查未通过（${modelProbe.code}）。入口存在与模型可响应分别判断；超时不代表登录失效，不自动重试。`:modelProbe.state==='passed'?'保留过往最小响应成功记录；当前渠道状态及完整MCP/阅读能力仍需实际验证。':'尚无最小真实响应记录。配置检查本身不调用模型。','查看probe-agent检查方法与模型连接说明','/help/install');
  const biliTopics=enabled.filter(t=>t.platforms.includes('bilibili'));
  try{const credential=config.bilibili.credentialFile||resolve(config.dataDir,'credentials','bilibili.json');if(!file(credential))add('bilibili','missing','B站连接','未找到可读取的本机凭据。Chrome登录与本项目扫码登录相互独立。','使用B站App扫码连接','#bilibili-login');
    else{new BilibiliSource({credentialFile:credential}).headers();add('bilibili','ready','B站连接','本机凭据格式可读取；有效期和上游访问权限须在真实读取时确认。','查看账号连接','#bilibili-login');}}
  catch{add('bilibili','invalid','B站连接','本机凭据文件格式无效；未输出或改写凭据。','检查本机凭据文件；先备份，勿将内容发到聊天','#bilibili-login');}
  const asr=config.bilibili.asr;
  if(!asr?.enabled)add('asr','optional','可选语音回退','当前关闭；有平台字幕的视频可直接阅读，不要求安装Python。','查看可选语音回退配置方法','/help/install');
  else{
    const python=commandAvailability(asr.pythonCommand,config.dataDir,options)==='available';
    const model=['model.bin','config.json','tokenizer.json'].every(name=>{try{const info=lstatSync(resolve(asr.modelDir,name));return info.isFile()&&!info.isSymbolicLink()&&info.size>0;}catch{return false;}});
    add('asr',python&&model?'ready':'missing','可选语音回退',python&&model?'Python入口及必需模型文件存在；未加载依赖或执行转写，识别能力另验。':!python?'语音回退已启用，但Python入口不可用；平台字幕阅读仍可使用。':'语音回退已启用，但模型缺失或文件为空；平台字幕阅读仍可使用。','查看本地ASR与asr-check说明','/help/install');
  }
  try{const custom=loadMailTemplate(config.dataDir);add('template','ready','邮件模板',custom?'自定义模板结构有效；冻结草稿保留生成时的模板。':'使用内置简洁模板，可自行调整栏目与内容。','编辑邮件模板','#mail-template');}
  catch{add('template','invalid','邮件模板','保存的模板格式无效，生成草稿会停止。','修复并保存模板','#mail-template');}
  add('mail','optional','邮箱投递',config.recipient?'已配置收件人；此检查不验证宿主邮箱连接或SMTP授权。阅读和草稿可单独使用。':'尚未配置收件人，可先阅读并生成本地草稿。','查看邮箱连接与投递说明','/help/install');
  const githubToken=githubCredentialStatus(config,{env:options.env??process.env});
  add('github',githubToken.state==='blocked'?'invalid':'optional','GitHub访问',githubToken.note,'查看GitHub凭据设置方法','/help/install');
  const missing=(ids:string[])=>checks.filter(c=>ids.includes(c.id)&&['missing','invalid'].includes(c.state)).map(c=>c.id);
  const common=['node','runner','template'];
  const workflow=(id:string,title:string,platformTopics:Topic[],requirements:string[])=>({id,title,configured:platformTopics.length>0,blockers:[...(!platformTopics.length?['topics']:[]),...missing(requirements)],localReady:platformTopics.length>0&&!missing(requirements).length});
  return {at:new Date().toISOString(),scope:'offline_local_configuration',liveVerified:false,modelInvoked:false,emailSent:false,modelProbe,checks,
    workflows:[workflow('github','GitHub主题阅读与草稿',enabled.filter(t=>t.platforms.includes('github')),[...common,'github']),workflow('bilibili','B站登录阅读与草稿',biliTopics,[...common,'bilibili']),{id:'archive',title:'已有档案后台分析',configured:true,blockers:missing(['node','runner']),localReady:!missing(['node','runner']).length}],
    note:'就绪仅表示本机前置条件满足，不代表模型授权、平台读取、邮箱送达或任何宿主MCP已通过。交互MCP阅读与后台分析器分别配置。'};
}
