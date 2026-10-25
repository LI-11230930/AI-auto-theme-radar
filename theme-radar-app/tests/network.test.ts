import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,get} from 'node:http';
import {once} from 'node:events';
import {configureNetwork,proxyUrl} from '../src/network.ts';
import {request} from '../src/http.ts';

test('项目代理配置拒绝远程、凭据和路径，不把代理密码写入错误',()=>{
  assert.equal(proxyUrl(null),null);assert.equal(proxyUrl('http://127.0.0.1:7897'),'http://127.0.0.1:7897');
  for(const url of ['socks5://127.0.0.1:1','http://remote.example:80','http://user:FAKE_SECRET@localhost:8','http://localhost:8/path','not-url'])assert.throws(()=>proxyUrl(url),(e:any)=>e.code==='INVALID_PROXY'&&!e.message.includes('FAKE_SECRET'));
});

test('Node进程代理可取得HTTP内容，回环服务直连且环境变量保持原值',async()=>{
  const before={...process.env};let requests=0,restore=()=>{};const sockets=new Set<any>();
  const proxy=createServer((_req,res)=>{requests++;res.end('proxied');});
  proxy.on('connect',(req,socket)=>{requests++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));assert.ok(['radar-probe.invalid:80','api.github.com:80','notbilibili.com:80','api.bilibili.com.evil.invalid:80'].includes(req.url||''));socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.once('data',()=>socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied'));});
  const direct=createServer((_req,res)=>res.end('local'));
  try{
    proxy.listen(0,'127.0.0.1');direct.listen(0,'127.0.0.1');await Promise.all([once(proxy,'listening'),once(direct,'listening')]);
    restore=configureNetwork('http://127.0.0.1:'+(proxy.address() as any).port);
    assert.equal(await(await fetch('http://radar-probe.invalid/',{signal:AbortSignal.timeout(3000)})).text(),'proxied');assert.equal(requests,1);
    assert.equal(await(await fetch('http://127.0.0.1:'+(direct.address() as any).port,{signal:AbortSignal.timeout(3000)})).text(),'local');assert.equal(requests,1);
    // Resolve these exact source hostnames to the fixture only for this request.
    // The global proxy must bypass them, while the unrelated host above stays proxied.
    for(const host of ['bilibili.com','api.bilibili.com','www.bilibili.com','hdslb.com','aisubtitle.hdslb.com']){
      const value=await new Promise<string>((resolve,reject)=>{const req=get({hostname:host,port:(direct.address() as any).port,path:'/',lookup:((_h:any,_o:any,cb:any)=>_o.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)) as any},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve(body));});req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('timeout')));});
      assert.equal(value,'local',host);assert.equal(requests,1,host+' must not reach proxy');
    }
    for(const host of ['api.github.com','notbilibili.com','api.bilibili.com.evil.invalid'])assert.equal(await(await fetch('http://'+host+'/',{signal:AbortSignal.timeout(3000)})).text(),'proxied');
    assert.equal(requests,4,'GitHub and lookalike domains still use the proxy');
    assert.ok(Object.keys(process.env).length===Object.keys(before).length&&Object.keys(before).every(key=>process.env[key]===before[key]),'process environment must remain unchanged');
  }finally{restore();for(const socket of sockets)socket.destroy();await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>direct.close(()=>r()))]);}
});

test('连接拒绝给出明确分类，错误不泄露上游内容或凭据',async()=>{
  const fetcher=async()=>{throw Object.assign(Error('FAKE_SECRET'),{cause:{code:'ECONNREFUSED',message:'FAKE_SECRET'}});};
  await assert.rejects(request('https://api.example.test/',{fetcher}), (e:any)=>e.code==='CONNECTION_REFUSED'&&e.message.includes('代理')&&!JSON.stringify(e).includes('FAKE_SECRET'));
});
