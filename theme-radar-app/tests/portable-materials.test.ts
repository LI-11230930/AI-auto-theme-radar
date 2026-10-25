import test from 'node:test';
import assert from 'node:assert/strict';
import {Buffer as ImportedBuffer} from 'node:buffer';
import {request} from '../src/http.ts';
import {GitHubSource} from '../src/github.ts';

test('没有全局Buffer时仍可解码HTTP和GitHub源码，内部错误不冒充网络故障',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'Buffer')!;
  const replies=new Map([
    ['/repos/fixture/public',JSON.stringify({full_name:'fixture/public',owner:{id:1,login:'fixture'},created_at:'2026-10-18T00:00:00Z',default_branch:'main',private:false})],
    ['/repos/fixture/public/readme','材料中文README'],
    ['/repos/fixture/public/license',JSON.stringify({type:'file',encoding:'base64',path:'LICENSE',content:ImportedBuffer.from('MIT fixture').toString('base64')})],
    ['/repos/fixture/public/contents/main.py',JSON.stringify({type:'file',encoding:'base64',path:'main.py',content:ImportedBuffer.from('print("中文")').toString('base64')})]
  ]);
  // A stream-shaped response avoids Node/Undici internals that themselves need
  // the global; this check isolates our own material decoding in a Worker host.
  const response=(text:string,status=200)=>{let consumed=false;const bytes=new TextEncoder().encode(text);return {ok:status===200,status,headers:{get:()=>null},body:{getReader:()=>({read:async()=>{if(consumed)return {done:true};consumed=true;return {done:false,value:bytes};},cancel:async()=>{}})}} as unknown as Response;};
  try{
    Object.defineProperty(globalThis,'Buffer',{configurable:true,enumerable:descriptor.enumerable,writable:true,value:undefined});
    assert.equal((await request('https://example.invalid/public',{fetcher:async()=>response('跨运行时材料✓')})).text,'跨运行时材料✓');
    const source=new GitHubSource(async url=>{const text=replies.get(new URL(url).pathname);return text===undefined?response('not found',404):response(text);});
    const result=await source.read('fixture/public',{files:['main.py']});
    assert.equal(result.evidence.find(e=>e.kind==='source:main.py')?.text,'print("中文")');
    assert.equal(result.evidence.find(e=>e.kind==='license')?.text,'MIT fixture');
  }finally{Object.defineProperty(globalThis,'Buffer',descriptor);}
});

test('Workers兼容手动重定向模式，3xx不跟随也不泄漏跳转地址',async()=>{
  let calls=0;
  const fetcher=async(_url:string,init?:RequestInit)=>{calls++;if(init?.redirect!=='manual')throw TypeError('unsupported Worker redirect mode');return new Response('do not follow',{status:302,headers:{Location:'https://untrusted.invalid/?credential=private-fixture'}});};
  await assert.rejects(()=>request('https://example.invalid/public',{fetcher}),(e:any)=>e.code==='REDIRECT_BLOCKED'&&!e.message.includes('private-fixture'));
  assert.equal(calls,1);
});
