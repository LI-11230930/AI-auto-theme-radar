import type {IncomingMessage,ServerResponse} from 'node:http';
import type {BrowserBatchBridge} from './browser-batch.ts';
import {RadarError,publicError} from './model.ts';

const paths=new Set(['pair','manifest','capture','fail','cancel']);
const extensionOrigin=/^chrome-extension:\/\/[a-p]{32}$/;
/** Dedicated, scoped import bridge. Does not grant access to ordinary operator routes. */
export async function browserBatchHttp(req:IncomingMessage,res:ServerResponse,bridge:BrowserBatchBridge):Promise<boolean>{
  const path=(req.url||'').split('?')[0];
  if(!path.startsWith('/bridge/browser-batch/'))return false;
  const reply=(status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  const origin=req.headers.origin;
  if(typeof origin!=='string'||!extensionOrigin.test(origin)){reply(403,{code:'BROWSER_BATCH_ORIGIN',error:'仅允许已配对的Chrome扩展来源'});return true;}
  res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
  const route=path.slice('/bridge/browser-batch/'.length);
  if(!paths.has(route)||req.url!==path){reply(404,{error:'采集接口不存在'});return true;}
  if(req.method==='OPTIONS'){
    const requested=(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
    if(req.headers['access-control-request-method']!=='POST'||requested.some(h=>!['authorization','content-type'].includes(h))){reply(403,{error:'不允许的采集请求'});return true;}
    res.writeHead(204,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'0'});res.end();return true;
  }
  if(req.method!=='POST'){reply(405,{error:'采集接口只接受JSON POST'});return true;}
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){reply(415,{error:'需要JSON'});return true;}
  try{
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>200000){reply(413,{error:'观察文件超过本次上限'});return true;}chunks.push(chunk);}
    let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RadarError('INVALID_INPUT','请求JSON格式无效');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw new RadarError('INVALID_INPUT','需要JSON对象');
    if(route==='pair'){
      if(Object.keys(body).join(',')!=='pairCode')throw new RadarError('INVALID_INPUT','仅接收一次性配对码');
      reply(200,bridge.pair(body.pairCode,origin));return true;
    }
    const authorization=req.headers.authorization||'',match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if(!match){reply(401,{code:'BROWSER_BATCH_UNAUTHORIZED',error:'缺少有效采集凭据'});return true;}
    const token=match[1];
    if(route==='capture')reply(200,bridge.importCapture(token,origin,body));
    else if(route==='fail')reply(200,bridge.failItem(token,origin,body));
    else {
      if(Object.keys(body).length)throw new RadarError('INVALID_INPUT','此接口不接收额外内容');
      reply(200,route==='cancel'?bridge.cancelFromExtension(token,origin):bridge.authenticate(token,origin));
    }
  }catch(e){const safe=publicError(e);reply(safe.code==='INTERNAL_ERROR'?500:safe.code==='BROWSER_BATCH_UNAUTHORIZED'?401:400,{code:safe.code,error:safe.message});}
  return true;
}
