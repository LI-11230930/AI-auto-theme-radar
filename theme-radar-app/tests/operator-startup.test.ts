import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startOperator} from '../src/operator.ts';
test('启动等到真实监听；端口冲突以可处理错误返回并保留原服务，关闭后可重启',async()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-startup-')),previous=process.env.THEME_RADAR_CONFIG;let first:Awaited<ReturnType<typeof startOperator>>|undefined,second:typeof first;
 try{const path=join(root,'config.json');writeFileSync(path,JSON.stringify({dataDir:root,topics:[],xiaohongshu:{enabled:false}}));process.env.THEME_RADAR_CONFIG=path;
  first=await startOperator(0);assert.equal(first.listening,true);const port=(first.address() as any).port;
  await assert.rejects(startOperator(port),(e:any)=>e.code==='OPERATOR_PORT_IN_USE');
  const response=await fetch('http://127.0.0.1:'+port+'/api/setup/status');assert.equal(response.status,200);
  await new Promise<void>(r=>first!.close(()=>r()));first=undefined;
  second=await startOperator(port);assert.equal(second.listening,true);assert.equal((await fetch('http://127.0.0.1:'+port+'/')).status,200);
 }finally{if(first)await new Promise<void>(r=>first!.close(()=>r()));if(second)await new Promise<void>(r=>second!.close(()=>r()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;rmSync(root,{recursive:true,force:true});}
});
test('无效端口在打开数据库或启动服务前拒绝',async()=>{
 for(const port of [-1,65536,NaN,1.5])await assert.rejects(startOperator(port),(e:any)=>e.code==='INVALID_OPERATOR_PORT');
});
