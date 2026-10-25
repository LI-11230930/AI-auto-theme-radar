import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runProcess} from '../src/runner.ts';
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
test('Runner cancellation terminates its actual owned descendant process',async()=>{
  const root=mkdtempSync(join(tmpdir(),'radar-cancel-')),file=join(root,'pids.json'),controller=new AbortController();let childPid=0;
  try{
    const code=`const {spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>{},1000);`;
    const running=runProcess(process.execPath,['-e',code,file],'',{cwd:root,signal:controller.signal,timeoutMs:10000});
    const rejected=assert.rejects(running,{code:'CANCELLED'});
    for(let n=0;n<100&&!existsSync(file);n++)await new Promise(r=>setTimeout(r,20));assert.ok(existsSync(file));
    const ids=JSON.parse(readFileSync(file,'utf8'));childPid=ids.child;assert.ok(alive(childPid));controller.abort();await rejected;
    for(let n=0;n<100&&alive(childPid);n++)await new Promise(r=>setTimeout(r,20));assert.equal(alive(ids.parent),false);assert.equal(alive(childPid),false);
  }finally{if(childPid&&alive(childPid))process.kill(childPid);rmSync(root,{recursive:true,force:true});}
});
