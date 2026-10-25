import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {BrowserBatchBridge} from '../src/browser-batch.ts';
import {browserBatchHttp} from '../src/browser-batch-http.ts';
import {importAuthorObservation} from '../src/author-observation.ts';
import {item,evidence,topic} from './fixtures.ts';

const origin='chrome-extension://'+'a'.repeat(32),other='chrome-extension://'+'b'.repeat(32),bvid='BV1234567890',key='bilibili:'+bvid;
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'radar-batch-http-')),store=new Store(':memory:'),t={...topic,id:'bili-http',platforms:['bilibili'] as any,bilibiliAuthors:['123']};store.saveTopic(t);
 importAuthorObservation(store,dir,t.id,{schema:'theme-radar-visible-author-v1',pageUrl:'https://space.bilibili.com/123/upload/video',authorUid:'123',observedAt:new Date().toISOString(),items:[{bvid,url:'https://www.bilibili.com/video/'+bvid,title:'合成测试'}],truncated:false});
 const v={...item,key,externalId:bvid,platform:'bilibili' as const,authorId:'123',url:'https://www.bilibili.com/video/'+bvid,metadata:{subtitlePages:[{page:1,cid:'1',duration:20}]}};store.capture(v,[{...evidence,itemKey:key,kind:'description'}]);
 const bridge=new BrowserBatchBridge(store,dir),grant=bridge.create(t.id,[key]);
 const server=createServer(async(req,res)=>{if(!await browserBatchHttp(req,res,bridge)){res.writeHead(403);res.end('operator CSRF protection');}});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+(server.address() as any).port,post=(route:string,body:unknown,token?:string,from=origin)=>fetch(base+'/bridge/browser-batch/'+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:from,...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 const pair=async()=>{const r=await post('pair',{pairCode:grant.pairCode});assert.equal(r.status,200);return await r.json() as any;};
 const snapshot=()=>({schema:'theme-radar-visible-subtitles-v1',bvid,page:1,duration:20,startedAt:grant.createdAt,endedAt:new Date().toISOString(),observedFrom:0,observedTo:20,segments:[{from:1,to:10,text:'HTTP合成观察'}],truncated:false,captureStatus:'ended'});
 return {bridge,store,grant,base,post,pair,snapshot,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));bridge.revokeAll();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('桥接只为精确扩展Origin返回CORS，拒绝缺失来源、网页、查询串与未知接口',async()=>{const f=await fixture();try{
 for(const from of ['https://www.bilibili.com','null',origin+'/',origin.replace('chrome-extension','https')]){const r=await f.post('pair',{pairCode:f.grant.pairCode},undefined,from);assert.equal(r.status,403);assert.equal(r.headers.get('access-control-allow-origin'),null);}
 const missing=await fetch(f.base+'/bridge/browser-batch/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(missing.status,403);
 assert.equal((await f.post('pair?token=ignored',{})).status,404);assert.equal((await f.post('anything',{})).status,404);
 const paired=await f.pair();assert.ok(paired.token);const ordinary=await fetch(f.base+'/api/topics',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});assert.equal(ordinary.status,403);assert.equal(ordinary.headers.get('access-control-allow-origin'),null);
 }finally{await f.close();}});

test('预检仅接受POST与必要请求头，不开启Cookie和任意方法权限',async()=>{const f=await fixture();try{
 const pre=(method,headers)=>fetch(f.base+'/bridge/browser-batch/capture',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':headers}});
 const ok=await pre('POST','authorization, content-type');assert.equal(ok.status,204);assert.equal(ok.headers.get('access-control-allow-origin'),origin);assert.equal(ok.headers.get('access-control-allow-credentials'),null);assert.equal((await pre('DELETE','authorization')).status,403);assert.equal((await pre('POST','x-radar-token')).status,403);
 }finally{await f.close();}});

test('配对只消费一次；凭据不能被其他扩展使用，也不返回公开状态或普通operator权限',async()=>{const f=await fixture();try{
 const p=await f.pair();assert.equal((await f.post('pair',{pairCode:f.grant.pairCode})).status,400);assert.equal((await f.post('manifest',{})).status,401);assert.equal((await f.post('manifest',{},p.token,other)).status,401);
 const good=await f.post('manifest',{},p.token);assert.equal(good.status,200);const s=await good.text();assert.ok(!s.includes(p.token));assert.ok(!s.includes(f.grant.pairCode));assert.equal((await f.post('manifest',{arbitrary:'no'},p.token)).status,400);
 }finally{await f.close();}});

test('HTTP实际导入只增加字幕证据，重复幂等，取消即停止且不分析或发信',async()=>{const f=await fixture();try{
 const p=await f.pair(),body={itemKey:key,snapshot:f.snapshot()},first=await f.post('capture',body,p.token);assert.equal(first.status,200);assert.equal((await first.json() as any).duplicate,false);const count=f.store.events().length;
 assert.equal((await(await f.post('capture',body,p.token)).json() as any).duplicate,true);assert.equal(f.store.events().length,count);assert.equal(f.store.stats().assessments,0);assert.equal(f.store.stats().deliveries,0);
 assert.equal((await f.post('cancel',{},p.token)).status,200);assert.equal((await f.post('capture',body,p.token)).status,401);assert.equal((await f.post('manifest',{},p.token)).status,401);
 }finally{await f.close();}});

test('格式、额外参数与大小限制拒绝，失败不会消耗配对码或写入正文',async()=>{const f=await fixture();try{
 assert.equal((await f.post('pair',{pairCode:f.grant.pairCode,token:'no'})).status,400);
 const raw=body=>fetch(f.base+'/bridge/browser-batch/pair',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body});
 assert.equal((await raw('[')).status,400);assert.equal((await raw('[]')).status,400);assert.equal((await raw('x'.repeat(200001))).status,413);
 const noJson=await fetch(f.base+'/bridge/browser-batch/pair',{method:'POST',headers:{Origin:origin},body:'{}'});assert.equal(noJson.status,415);
 const p=await f.pair();assert.equal((await f.post('fail',{itemKey:key,code:'arbitrary page text'},p.token)).status,400);assert.equal(f.store.currentEvidence(key).length,1);
 }finally{await f.close();}});
