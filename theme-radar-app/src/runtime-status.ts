import {readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const serviceVersion='0.1.0-beta.31';
export function createRuntimeStatus(sourceFolder=dirname(fileURLToPath(import.meta.url))){
  const fingerprint=()=>{try{const h=createHash('sha256');for(const name of readdirSync(sourceFolder).filter(n=>n.endsWith('.ts')).sort()){h.update(JSON.stringify(name));h.update(readFileSync(resolve(sourceFolder,name)));}return h.digest('hex');}catch{return null;}};
  const sourceFingerprintAtStart=fingerprint(),startedAt=new Date(Date.now()-process.uptime()*1000).toISOString();
  return ()=>{const currentSourceFingerprint=fingerprint(),restartRequired=sourceFingerprintAtStart===null||currentSourceFingerprint===null?null:sourceFingerprintAtStart!==currentSourceFingerprint;
    return {serviceVersion,processId:process.pid,startedAt,sourceFingerprintAtStart,currentSourceFingerprint,restartRequired,scope:'启动时与当前源码指纹比较；不读取配置/凭据，不验证IDE工具缓存',note:restartRequired===true?'源码已更新，当前进程仍运行旧代码；请重连现有MCP服务，必要时在新会话刷新工具列表。':restartRequired===null?'无法核对源码版本，请核对服务入口后重连。':'服务源码未变；IDE工具列表可能仍需重新连接或新会话刷新。'};
  };
}
export const runtimeStatus=createRuntimeStatus();
