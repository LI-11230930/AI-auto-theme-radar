import * as http from 'node:http';
import {RadarError} from './model.ts';

let activeProxy:string|null=null;
// Domestic metadata and caption CDNs stay direct when GitHub uses a local proxy.
export const DIRECT_SOURCE_HOSTS=['bilibili.com','.bilibili.com','hdslb.com','.hdslb.com','bilivideo.com','.bilivideo.com','bilivideo.cn','.bilivideo.cn'] as const;
export function proxyUrl(value:unknown):string|null {
  if(value===null||value===undefined||value==='')return null;
  let url:URL;try{url=new URL(String(value));}catch{throw new RadarError('INVALID_PROXY','代理地址格式无效');}
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new RadarError('INVALID_PROXY','仅使用无凭据的本机HTTP代理地址和端口');
  return url.origin;
}
// Configure only this Node process, before its first request. No process.env,
// Windows settings or child-agent environment changes are made.
export function configureNetwork(value:unknown):()=>void {
  const proxy=proxyUrl(value);
  if(!proxy||proxy===activeProxy)return ()=>{};
  if(activeProxy)throw new RadarError('NETWORK_ALREADY_CONFIGURED','运行中不能切换代理，请重新启动项目');
  const setup=(http as any).setGlobalProxyFromEnv;
  if(typeof setup!=='function')throw new RadarError('PROXY_RUNTIME_REQUIRED','本机代理需要Node 24.14或更高的24.x运行时');
  const restore=setup({http_proxy:proxy,https_proxy:proxy,no_proxy:['localhost','127.0.0.1','::1','[::1]',...DIRECT_SOURCE_HOSTS].join(',')});
  activeProxy=proxy;
  return ()=>{restore();activeProxy=null;};
}
