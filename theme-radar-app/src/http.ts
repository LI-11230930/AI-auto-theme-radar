import { RadarError } from './model.ts';
import { Buffer } from 'node:buffer';
export type Fetcher = (input:string, init?:RequestInit)=>Promise<Response>;
export async function request(url:string, options:{headers?:Record<string,string>;method?:string;body?:unknown;timeoutMs?:number;maxBytes?:number;fetcher?:Fetcher}={}) {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),options.timeoutMs||15000);
  try {
    const response=await (options.fetcher||fetch)(url,{method:options.method||'GET',headers:{'User-Agent':'ThemeRadar/0.1 (+local personal research)',...options.headers,...(options.body!==undefined?{'Content-Type':'application/json'}:{})},body:options.body===undefined?undefined:JSON.stringify(options.body),signal:controller.signal,redirect:'manual'});
    // Workers does not accept redirect:'error'. Manual mode retains the same
    // no-follow boundary, with an explicit failure before reading a 3xx body.
    if(response.status>=300&&response.status<400){await response.body?.cancel().catch(()=>{});throw new RadarError('REDIRECT_BLOCKED','上游重定向已拒绝',{status:response.status,host:new URL(url).hostname});}
    if(!response.ok){
      const remaining=response.headers.get('x-ratelimit-remaining'),reset=response.headers.get('x-ratelimit-reset'),retryAfter=response.headers.get('retry-after');
      const limited=response.status===429||(response.status===403&&(remaining==='0'||retryAfter!==null));
      let retryAt:string|null=null;
      if(limited){const waits=[Date.now()+60000],epoch=Number(reset),seconds=Number(retryAfter);
        if(remaining==='0'&&reset&&Number.isFinite(epoch)&&epoch>0&&epoch<8640000000000)waits.push(epoch*1000);
        if(retryAfter){const parsed=Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(retryAfter);if(Number.isFinite(parsed)&&Math.abs(parsed)<8640000000000000)waits.push(parsed);}
        retryAt=new Date(Math.max(...waits)).toISOString();
      }
      throw new RadarError(limited?'RATE_LIMITED':response.status===401?'AUTH_REQUIRED':response.status===403?'ACCESS_DENIED':'HTTP_ERROR',limited?`上游限流（HTTP ${response.status}），${retryAt} 后再试`:`上游 HTTP ${response.status}`,{status:response.status,host:new URL(url).hostname,retryAfter,remaining,reset,retryAt});
    }
    const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
    if(reader){while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>(options.maxBytes||2000000)){await reader.cancel();throw new RadarError('RESPONSE_LIMIT','上游响应超出预算');}chunks.push(value);}}
    const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');
    return {text,bytes,headers:response.headers,status:response.status};
  } catch(error) {if(error instanceof RadarError)throw error;const refused=(error as any)?.cause?.code==='ECONNREFUSED';throw new RadarError(controller.signal.aborted?'TIMEOUT':refused?'CONNECTION_REFUSED':'NETWORK_ERROR',controller.signal.aborted?'上游请求超时':refused?'连接被拒绝，请检查项目代理是否运行及网络连接':'无法连接上游服务，请检查网络连接',{host:new URL(url).hostname});}
  finally{clearTimeout(timer);}
}
export async function jsonRequest(url:string,options:Parameters<typeof request>[1]={}){const response=await request(url,options);try{return JSON.parse(response.text);}catch{throw new RadarError('INVALID_RESPONSE','上游返回非 JSON 内容',{host:new URL(url).hostname});}}
export function stripHtml(text:string){return text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();}
