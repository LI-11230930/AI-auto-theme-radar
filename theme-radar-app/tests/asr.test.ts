import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {audioSourceUrl,parseAsrOutput,transcribeAudio} from '../src/asr.ts';
import {RadarError} from '../src/model.ts';

const url='https://audio.bilivideo.com/sample.m4s?token=private';
const output=(overrides:any={})=>({ok:true,text:'读取资料\n生成结果',segments:[{from:0,to:1,content:'读取资料'},{from:2,to:3,content:'生成结果'}],duration:5,model:'faster-whisper-base',language:'zh',range:{from:0,to:5},coverage:'complete',...overrides});
function setup(t:any){
  const root=mkdtempSync(join(tmpdir(),'radar-asr-')),modelDir=join(root,'model'),workDir=join(root,'tasks');mkdirSync(modelDir);mkdirSync(workDir);
  for(const name of ['model.bin','config.json','tokenizer.json'])writeFileSync(join(modelDir,name),'fixture');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const options={audioUrl:url,sourceDuration:5,pythonCommand:process.execPath,modelDir,workDir};
  const fetcher:typeof fetch=async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-length':'3','content-type':'audio/mp4'}});
  const run=async()=>({stdout:JSON.stringify(output()),stderr:'',code:0});
  return{root,modelDir,workDir,options,fetcher,run};
}

test('音频仅允许指定HTTPS CDN，不接受用户信息、外域、端口和协议',()=>{
  for(const value of ['http://audio.bilivideo.com/a','https://bilivideo.com.evil.invalid/a','https://evilbilivideo.com/a','https://u:p@audio.bilivideo.com/a','https://audio.bilivideo.com:8443/a','file:///a','https://audio.bilivideo.com/a#fragment','bad'])assert.throws(()=>audioSourceUrl(value),{code:'ASR_AUDIO_URL_INVALID'});
  for(const host of ['bilivideo.com','a.bilivideo.cn','a.hdslb.com'])assert.equal(audioSourceUrl('https://'+host+'/a'),'https://'+host+'/a');
  assert.equal(audioSourceUrl('https://xy1.mcdn.bilivideo.cn:8082/audio'),'https://xy1.mcdn.bilivideo.cn:8082/audio');
  for(const host of ['a.hdslb.com','a.bilivideo.cn','mcdn.bilivideo.cn.evil.invalid'])assert.throws(()=>audioSourceUrl('https://'+host+':8082/audio'));
});
test('完整短音频输出保留独立分段与实际处理范围，空转写不是无声结论',()=>{
  const result=parseAsrOutput(output(),5);assert.equal(result.text,'读取资料\n生成结果');assert.equal(result.model,'faster-whisper-base');assert.deepEqual(result.range,{from:0,to:5});assert.equal(result.coverage,'complete');
  assert.throws(()=>parseAsrOutput(output({text:'',segments:[]}),5),{code:'ASR_EMPTY'});assert.throws(()=>parseAsrOutput({ok:false,code:'ASR_EMPTY'},5),(e:any)=>e.code==='ASR_EMPTY'&&e.message.includes('不能断言'));
  assert.throws(()=>parseAsrOutput({ok:false,code:'private-model-error'},5),(e:any)=>e.code==='ASR_FAILED'&&!e.message.includes('private'));
});
test('错误模型、时长、范围、非有限/倒序/重叠时间和不一致正文均拒绝',()=>{
  for(const changed of [{model:'other'},{language:'invalid-language'},{coverage:'partial'},{duration:0},{duration:601},{duration:Infinity},{duration:15,range:{from:0,to:15}},{range:{from:1,to:5}},{text:'伪造正文'},
    ...[{from:-1,to:1,content:'a'},{from:NaN,to:1,content:'a'},{from:1,to:1,content:'a'},{from:1,to:6,content:'a'},{from:1,to:2,content:''}].map(s=>({segments:[s]})),
    {segments:[{from:0,to:3,content:'读取资料'},{from:2,to:4,content:'生成结果'}]}])assert.throws(()=>parseAsrOutput(output(changed),5));
  assert.throws(()=>parseAsrOutput(output({text:'x'.repeat(40001)}),5),{code:'ASR_OUTPUT_LIMIT'});assert.throws(()=>parseAsrOutput(output({segments:new Array(1001).fill({from:0,to:1,content:'x'})}),5),{code:'ASR_OUTPUT_LIMIT'});
});
test('预算和本地模型预检先于下载，调用失败不创建残留任务',async t=>{
  const x=setup(t);let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw Error('must not fetch');};
  for(const changed of [{sourceDuration:0},{sourceDuration:601},{sourceDuration:NaN},{sourceDuration:'5'},{timeoutMs:180001},{timeoutMs:0},{pythonCommand:'python.cmd'},{modelDir:'not-absolute'}])await assert.rejects(transcribeAudio({...x.options,...changed,fetcher} as any));
  rmSync(join(x.modelDir,'model.bin'));await assert.rejects(transcribeAudio({...x.options,fetcher}),{code:'ASR_MODEL_MISSING'});assert.equal(calls,0);assert.deepEqual(readdirSync(x.workDir),[]);
});
test('下载不传Cookie，只在临时任务中处理，调用本地模型后总会清理',async t=>{
  const x=setup(t);let invoked=false;const fetcher:typeof fetch=async(input,init)=>{assert.equal(input,url);assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.deepEqual(init?.headers,{Referer:'https://www.bilibili.com/'});return x.fetcher(input,init);};
  const result=await transcribeAudio({...x.options,fetcher},{run:async(command,args,input,opts)=>{invoked=true;assert.equal(command,process.execPath);assert.equal(args[0],'-X');assert.equal(args[1],'utf8');assert.ok(args[2].endsWith('asr_transcribe.py'));const payload=JSON.parse(input);assert.equal(payload.modelDir,x.modelDir);assert.equal(payload.sourceDuration,5);assert.equal(readFileSync(payload.audioPath).length,3);assert.equal(opts.env?.HF_HUB_OFFLINE,'1');assert.equal(opts.timeoutMs,180000);return x.run();}});
  assert.equal(invoked,true);assert.equal(result.audioBytes,3);assert.equal(JSON.stringify(result).includes('private'),false);assert.deepEqual(readdirSync(x.workDir),[]);
});
test('超32MiB声明或累计字节、空/不完整下载、非音频、HTTP拒绝和重定向不转写',async t=>{
  const x=setup(t);let runs=0;const run=async()=>{runs++;return x.run();};
  const responses=[()=>new Response('x',{headers:{'content-length':String(32*1024*1024+1)}}),()=>new Response(new Uint8Array(32*1024*1024+1)),()=>new Response(null),()=>new Response('x',{headers:{'content-length':'2'}}),()=>new Response('html',{headers:{'content-type':'text/html'}}),()=>new Response('x',{headers:{'content-length':'bad'}}),()=>new Response('x',{status:403}),()=>new Response('x',{status:302,headers:{location:'https://evil.invalid/'}})];
  for(const response of responses){await assert.rejects(transcribeAudio({...x.options,fetcher:async()=>response()},{run}));assert.deepEqual(readdirSync(x.workDir),[]);}
  assert.equal(runs,0);
});
test('下载前或下载过程中取消，不启动模型且清理任务',async t=>{
  const x=setup(t),controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(transcribeAudio({...x.options,signal:controller.signal,fetcher:async()=>{calls++;return x.fetcher(url);}},{run:x.run}),{code:'CANCELLED'});assert.equal(calls,0);
  const active=new AbortController();await assert.rejects(transcribeAudio({...x.options,signal:active.signal,fetcher:async()=>{active.abort();return x.fetcher(url);}},{run:x.run}),{code:'CANCELLED'});assert.deepEqual(readdirSync(x.workDir),[]);
});
test('模型超时/取消/无效JSON/空文本后都清理，错误不暴露进程内容',async t=>{
  const x=setup(t);
  for(const code of ['RUNNER_TIMEOUT','CANCELLED','RUNNER_NOT_FOUND','RUNNER_OUTPUT_LIMIT']){
    await assert.rejects(transcribeAudio({...x.options,fetcher:x.fetcher},{run:async()=>{throw new RadarError(code,'secret path');}}),(e:any)=>e.code===(code==='RUNNER_TIMEOUT'?'ASR_TIMEOUT':code==='CANCELLED'?'CANCELLED':'ASR_FAILED')&&!e.message.includes('secret'));
    assert.deepEqual(readdirSync(x.workDir),[]);
  }
  for(const stdout of ['bad json',JSON.stringify(output({text:'',segments:[]})),JSON.stringify({ok:false,code:'ASR_EMPTY'})]){await assert.rejects(transcribeAudio({...x.options,fetcher:x.fetcher},{run:async()=>({stdout,stderr:'',code:0})}));assert.deepEqual(readdirSync(x.workDir),[]);}
});
test('模型运行中取消信号传到进程接口，取消后不接受结果',async t=>{
  const x=setup(t),controller=new AbortController();await assert.rejects(transcribeAudio({...x.options,signal:controller.signal,fetcher:x.fetcher},{run:async(_c,_a,_i,opts)=>{assert.equal(opts.signal,controller.signal);controller.abort();return x.run();}}),{code:'CANCELLED'});assert.deepEqual(readdirSync(x.workDir),[]);
});
