import {readFileSync,lstatSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {hash,RadarError} from './model.ts';

type Options={env?:NodeJS.ProcessEnv;platform?:string;clock?:number;decrypt?:(encrypted:string)=>string};
type State={state:string;source:string;liveVerified:false;loadedAt?:string;storedExpiresAt?:string;reloadRequired?:boolean;code?:string;note:string};
let loaded:{file:string;signature:string;at:string;tokenHash:string}|null=null;
let currentConfig:any=null,currentOptions:Options={};
let startupError:string|null=null;
const messages:Record<string,string>={
 GITHUB_CREDENTIAL_EXPIRED:'保存凭据的本机保管期限已到；不会降级为匿名访问。先核对实际GitHub有效期再更新配置。',
 GITHUB_CREDENTIAL_INVALID:'保存的GitHub凭据记录格式无效；没有输出或覆盖凭据。',
 GITHUB_CREDENTIAL_UNAVAILABLE:'无法读取已配置的GitHub凭据文件；没有改用其他凭据或匿名访问。',
 GITHUB_CREDENTIAL_UNSUPPORTED:'当前系统无法解密Windows当前用户凭据；可改用本机GITHUB_TOKEN环境变量。',
 GITHUB_CREDENTIAL_DECRYPT_FAILED:'Windows当前用户无法解密该凭据；请核对使用者与本机保存记录。',
 GITHUB_CREDENTIAL_RELOAD_REQUIRED:'保存的GitHub凭据已更新，当前进程仍使用旧值；请重启服务或重连MCP，无需重复输入。'
};
function record(file:string){
 try{
  const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw Error();
  const data=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  if(data.version!==1||typeof data.encryptedToken!=='string'||!data.encryptedToken||data.encryptedToken.length>32768||!Number.isFinite(Date.parse(data.createdAt))||!Number.isFinite(Date.parse(data.expiresAt))||Date.parse(data.expiresAt)<=Date.parse(data.createdAt))throw Error();
  return {...data,signature:hash(data.encryptedToken+'\n'+data.expiresAt)};
 }catch(error:any){throw new RadarError(error?.code==='ENOENT'||error?.code==='EACCES'?'GITHUB_CREDENTIAL_UNAVAILABLE':'GITHUB_CREDENTIAL_INVALID','凭据记录不可用');}
}
function decryptWindows(encrypted:string){
 // Only encrypted data enters stdin. Fixed code, no token/filename in command arguments or logs.
 const script=`$ErrorActionPreference='Stop';$b=[IntPtr]::Zero;$s=$null;try{$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd().Trim());$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))}catch{exit 1}finally{if($b -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)};if($s){$s.Dispose()}}`;
 const childEnv={...process.env};for(const key of Object.keys(childEnv))if(key.toLowerCase()==='psmodulepath')delete childEnv[key];
 const executable=resolve(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const result=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:childEnv,input:encrypted,encoding:'utf8',timeout:8000,maxBuffer:16384,windowsHide:true});
 if(result.status!==0||result.error)throw new RadarError('GITHUB_CREDENTIAL_DECRYPT_FAILED','解密失败');
 return result.stdout.trim();
}
function failure(code:string,extra:Partial<State>={}):State{return {state:'blocked',source:'protected_file',liveVerified:false,code,note:messages[code],...extra};}
/** Offline status. A local TTL is never described as GitHub's server token expiry. */
export function githubCredentialStatus(config:any=currentConfig,options:Options=currentOptions):State{
 const env=options.env??process.env,file=config?.github?.credentialFile,clock=options.clock??Date.now();
 if(env.GITHUB_TOKEN&&(!loaded||loaded.file!==file))return {state:'configured',source:'environment',liveVerified:false,note:'进程环境中有GitHub凭据；权限、真实到期及额度需实际请求核验。'};
 if(!file)return {state:'anonymous',source:'none',liveVerified:false,note:'未配置凭据，使用匿名额度。'};
 let saved:any;try{saved=record(file);}catch(error:any){return failure(error.code);}
 const metadata={storedExpiresAt:saved.expiresAt,...(loaded?.file===file?{loadedAt:loaded.at}:{})};
 if(Date.parse(saved.expiresAt)<=clock)return failure('GITHUB_CREDENTIAL_EXPIRED',metadata);
 if(loaded?.file===file&&loaded.signature!==saved.signature)return failure('GITHUB_CREDENTIAL_RELOAD_REQUIRED',{...metadata,reloadRequired:true});
 if(startupError)return failure(startupError,metadata);
 if(env.GITHUB_TOKEN&&loaded?.file===file)return {state:'configured',source:'protected_file',liveVerified:false,...metadata,reloadRequired:false,note:'已加载本机加密凭据；这里只核对本机保管期限，未验证GitHub服务器权限或真实到期。'};
 return {state:'not_loaded',source:'protected_file',liveVerified:false,...metadata,note:'已配置本机加密凭据，当前进程尚未加载。'};
}
/** Called once at process startup. UI remains available even if a credential needs attention. */
export function initializeGithubCredential(config:any,options:Options={}):State{
 currentConfig=config;currentOptions=options;startupError=null;
 const env=options.env??process.env,file=config?.github?.credentialFile;
 if(loaded&&loaded.file!==file&&env.GITHUB_TOKEN&&hash(env.GITHUB_TOKEN)===loaded.tokenHash)delete env.GITHUB_TOKEN;
 if(env.GITHUB_TOKEN)return githubCredentialStatus(config,options);
 loaded=null;if(!file)return githubCredentialStatus(config,options);
 try{
  const saved=record(file);if(Date.parse(saved.expiresAt)<=(options.clock??Date.now()))throw new RadarError('GITHUB_CREDENTIAL_EXPIRED','本机期限已到');
  if(!options.decrypt&&(options.platform??process.platform)!=='win32')throw new RadarError('GITHUB_CREDENTIAL_UNSUPPORTED','不支持此加密格式');
  const token=(options.decrypt??decryptWindows)(saved.encryptedToken);
  if(!/^github_pat_[A-Za-z0-9_]{20,255}$/.test(token))throw new RadarError('GITHUB_CREDENTIAL_DECRYPT_FAILED','解密结果格式无效');
  env.GITHUB_TOKEN=token;loaded={file,signature:saved.signature,at:new Date(options.clock??Date.now()).toISOString(),tokenHash:hash(token)};
 }catch(error:any){startupError=messages[error?.code]?error.code:'GITHUB_CREDENTIAL_DECRYPT_FAILED';}
 return githubCredentialStatus(config,options);
}
export function requireGithubCredential(){
 const state=githubCredentialStatus();
 if(state.state==='blocked'||state.state==='not_loaded')throw new RadarError(state.code||'GITHUB_CREDENTIAL_UNAVAILABLE',state.note);
}
