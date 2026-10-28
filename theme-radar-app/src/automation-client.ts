import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {RadarError} from './model.ts';
import {operatorUrl} from './operator-url.ts';
import {operatorIdentity} from './operator-identity.ts';
import {APP_ROOT,configFilePath} from './config.ts';
import {serviceVersion} from './runtime-status.ts';
import {githubCredentialStatus} from './github-credential.ts';
const sessionId=randomUUID();
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
type OperatorState={ready:boolean;code:string;url:string;serviceVersion?:string;processId?:number;restartRequired?:boolean|null;note:string};
async function connection(config:any):Promise<{status:OperatorState;token?:string}>{
 const url=operatorUrl(config.operatorUrl);let response:Response;
 try{response=await fetch(new URL('/api/state',url),{signal:AbortSignal.timeout(1500),redirect:'error'});}catch{return {status:{ready:false,code:'OPERATOR_REQUIRED',url,note:'统一服务未连接，可显式启动本机服务。'}};}
 if(!response.ok)return {status:{ready:false,code:'OPERATOR_UNRECOGNIZED',url,note:'端口上有其他服务或请求被拒绝；未连接或替换该进程。'}};
 let data:any;try{data=await response.json();}catch{return {status:{ready:false,code:'OPERATOR_UNRECOGNIZED',url,note:'端口响应不是主题雷达状态。'}};}
 if(!data||typeof data.token!=='string'||!data.service||typeof data.service.processId!=='number')return {status:{ready:false,code:'OPERATOR_UNRECOGNIZED',url,note:'端口响应不是可用的主题雷达服务。'}};
 const details={url,serviceVersion:data.service.serviceVersion,processId:data.service.processId,restartRequired:data.service.restartRequired};
 if(data.service.serviceVersion!==serviceVersion)return {status:{...details,ready:false,code:'OPERATOR_VERSION_MISMATCH',note:`MCP=${serviceVersion}，本机服务=${data.service.serviceVersion}。旧MCP需重新连接；只有本机服务旧时才重启服务，不关闭版本检查。`}};
 if(data.service.restartRequired!==false)return {status:{...details,ready:false,code:'OPERATOR_RESTART_REQUIRED',note:'服务源码已变化或无法核对，请重启服务。'}};
 if(data.operatorIdentity!==operatorIdentity(config))return {status:{...details,ready:false,code:'OPERATOR_LEDGER_MISMATCH',note:'服务连接的账本与当前宿主不同；请核对配置，不自动替换。'}};
 return {status:{...details,ready:true,code:'READY',note:'统一服务与当前账本匹配。'},token:data.token};
}
export async function operatorStatus(config:any){return (await connection(config)).status;}
/** Explicit start only. Listening port arbitrates concurrent starts; no service is replaced. */
export async function startOperatorService(config:any){
 let status=await operatorStatus(config);if(status.ready)return {...status,started:false,reused:true};
 if(status.code!=='OPERATOR_REQUIRED')throw new RadarError(status.code,status.note);
 const port=Number(new URL(status.url).port);let spawnError=false;
 const childEnv={...process.env,THEME_RADAR_CONFIG:configFilePath()};
 // The worker loads its own protected record, retaining expiry/update tracking.
 if(githubCredentialStatus(config).source==='protected_file')delete childEnv.GITHUB_TOKEN;
 const child=spawn(process.execPath,[resolve(APP_ROOT,'src/cli.ts'),'serve',String(port)],{cwd:APP_ROOT,env:childEnv,detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{spawnError=true;});child.unref();
 // Includes one bounded cold start of the Windows protected-credential helper.
 const deadline=Date.now()+35000;
 do{await pause(100);status=await operatorStatus(config);if(status.ready)return {...status,started:status.processId===child.pid,reused:status.processId!==child.pid};if(status.code!=='OPERATOR_REQUIRED')throw new RadarError(status.code,status.note);}while(!spawnError&&Date.now()<deadline);
 throw new RadarError('OPERATOR_START_FAILED','本机服务未在限定时间内就绪；请核对端口和配置，不自动重试或关闭其他进程。');
}
/** MCP and CLI connect to one local worker; status itself never starts it. */
export async function automationRequest(config:any,path:string,body?:any){
 const {status,token}=await connection(config);if(!status.ready)throw new RadarError(status.code,status.note);
 try{const response=await fetch(new URL('/api/automation'+path,status.url),body===undefined?{signal:AbortSignal.timeout(5000),redirect:'error'}:{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':token!},body:JSON.stringify({...body,...(path==='/next'?{sessionId}:{})}),signal:AbortSignal.timeout(25000),redirect:'error'});const result=await response.json() as any;if(!response.ok)throw new RadarError(result.code||'AUTOMATION_FAILED',result.error||'任务操作未完成');return result;}
 catch(error){if(error instanceof RadarError)throw error;throw new RadarError('OPERATOR_REQUIRED','本地统一服务未响应；请先检查服务状态。');}
}
