import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runProcess} from '../src/runner.ts';
import {AutomationRuntime} from '../src/automation-runtime.ts';
import {Store} from '../src/store.ts';
import {savePlan,runRows} from '../src/automation-plan.ts';
import {topic,fixturePlan} from './fixtures.ts';

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
// A defunct POSIX child has stopped executing but may await its OS reaper.
function executing(pid:number){try{process.kill(pid,0);if(process.platform==='linux'&&readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1]?.startsWith('Z'))return false;return true;}catch{return false;}}

async function processTree(t:any,{reason,stubborn,inherit,exitParent=false,stubbornParent=true}:{reason:'cancel'|'timeout'|'output';stubborn:boolean;inherit:boolean;exitParent?:boolean;stubbornParent?:boolean}){
 const root=mkdtempSync(join(tmpdir(),'radar-deadline-')),file=join(root,'ready.json'),controller=new AbortController();let ids:any;
 const childCode=`${stubborn?"process.on('SIGTERM',()=>{});":''}process.stdout.write('ready');setInterval(()=>{},1000);`;
 const code=`const {spawn}=require('node:child_process'),fs=require('node:fs');${stubborn&&stubbornParent?"process.on('SIGTERM',()=>{});":''}const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe',${JSON.stringify(inherit?'inherit':'ignore')}],windowsHide:true});child.stdout.once('data',()=>{${inherit?"child.stdout.pipe(process.stdout);":''}fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid}));${reason==='output'?"process.stdout.write('x'.repeat(10000));":''}${exitParent?'process.exit(0);':''}});setInterval(()=>{},1000);`;
 const started=Date.now(),running=runProcess(process.execPath,['-e',code,file],'',{cwd:root,signal:controller.signal,timeoutMs:reason==='timeout'||exitParent?6000:10000,maxBytes:reason==='output'?100:2000000});
 // Bound the regression test and kill only the PIDs it explicitly created.
 const watchdog=setTimeout(()=>{if(ids){for(const pid of [ids.child,ids.parent])try{process.kill(pid,'SIGKILL');}catch{}}},12000);
 const result=running.then(value=>({value,error:null}),error=>({value:null,error}));
 try{
  for(let n=0;n<500&&!existsSync(file);n++)await sleep(10);
  assert.ok(existsSync(file),'fixture must be ready before cancellation');ids=JSON.parse(readFileSync(file,'utf8'));
  if(reason==='cancel')controller.abort();
  const settled=await result;
  assert.equal(settled.error?.code,reason==='cancel'?'CANCELLED':reason==='output'?'RUNNER_OUTPUT_LIMIT':'RUNNER_TIMEOUT');
  assert.ok(Date.now()-started<11000,'exit must complete without the watchdog');
  for(let n=0;n<100&&(executing(ids.parent)||executing(ids.child));n++)await sleep(10);
  assert.equal(executing(ids.parent),false);assert.equal(executing(ids.child),false);
 }finally{clearTimeout(watchdog);controller.abort();if(ids)for(const pid of [ids.child,ids.parent])if(executing(pid))try{process.kill(pid,'SIGKILL');}catch{}await result;rmSync(root,{recursive:true,force:true});}
}

test('运行中取消真正停止已启动的父子进程',async t=>processTree(t,{reason:'cancel',stubborn:false,inherit:true}));
test('超时停止整棵父子进程，而不只返回错误',async t=>processTree(t,{reason:'timeout',stubborn:false,inherit:true}));
test('输出超限也停止整棵父子进程',async t=>processTree(t,{reason:'output',stubborn:false,inherit:true}));
test('POSIX忽略SIGTERM时取消仍升级终止整个进程组',{skip:process.platform==='win32'},async t=>processTree(t,{reason:'cancel',stubborn:true,inherit:true}));
test('POSIX忽略SIGTERM时超时仍升级终止整个进程组',{skip:process.platform==='win32'},async t=>processTree(t,{reason:'timeout',stubborn:true,inherit:true}));
test('POSIX父进程先退出而后代持有输出管道时，超时仍清理后代',{skip:process.platform==='win32'},async t=>processTree(t,{reason:'timeout',stubborn:true,inherit:true,exitParent:true}));
test('POSIX父进程响应TERM先退出时，也清理不持有管道且忽略TERM的后代',{skip:process.platform==='win32'},async t=>processTree(t,{reason:'cancel',stubborn:true,inherit:false,stubbornParent:false}));
test('正常完成不会被迟到的终止计时器影响',async()=>{const result=await runProcess(process.execPath,['-e',"process.stdout.write('completed')"],'',{cwd:tmpdir(),timeoutMs:3000});assert.equal(result.stdout,'completed');assert.equal(result.code,0);});

for(const mode of ['cancel','close','edit'] as const)test('统一轮次'+mode+'终止正在运行的本地Runner并落取消记录',async()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-runtime-exit-')),file=join(root,'ready.json'),store=new Store(':memory:');let ids:any;
 const code=`const {spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit'],windowsHide:true});c.stdout.once('data',()=>fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:c.pid})));setInterval(()=>{},1000);`;
 const runtime=new AutomationRuntime({dataDir:root,limits:{runnerTimeoutMs:5000,runnerOutputBytes:10000},runners:{DSH:{command:process.execPath,prefixArgs:['-e',code,'--',file]}}},store,{github:async({runner,signal}:any)=>{await runner.invoke('{"fixture":true}',{},signal);throw Error('fixture must be cancelled');}});
 try{
  store.saveTopic(topic);const plan=savePlan(store,fixturePlan({execution:'background'})),start=runtime.startRun(plan.id);assert.ok(start.started);
  for(let n=0;n<200&&!existsSync(file);n++)await sleep(10);assert.ok(existsSync(file));ids=JSON.parse(readFileSync(file,'utf8'));assert.ok(executing(ids.child));
  if(mode==='close')await runtime.close();else if(mode==='cancel')runtime.cancel(start.runId!);else runtime.save({...plan,name:'isolated edited plan'},plan.revision);
  for(let n=0;n<500&&runtime.active.size;n++)await sleep(10);assert.equal(runtime.active.size,0);
  const row=runRows(store)[0];assert.equal(row.id,start.runId);assert.equal(row.state,'cancelled');assert.equal(row.stage,'cancelled');assert.equal(row.error.code,'CANCELLED');assert.equal(runRows(store).length,1);
  assert.equal(store.stats().assessments,0);assert.equal(store.stats().deliveries,0);
  for(let n=0;n<100&&(executing(ids.parent)||executing(ids.child));n++)await sleep(10);assert.equal(executing(ids.parent),false);assert.equal(executing(ids.child),false);
 }finally{if(ids)for(const pid of [ids.child,ids.parent])if(executing(pid))try{process.kill(pid,'SIGKILL');}catch{}await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});
