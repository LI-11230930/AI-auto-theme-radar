import test from 'node:test';
import assert from 'node:assert/strict';
import {withAsrFallback} from '../src/asr-fallback.ts';
import {RadarError,isVideoTextKind} from '../src/model.ts';
import type {Item,Evidence} from '../src/model.ts';
import type {transcribeAudio} from '../src/asr.ts';

const bvid='BV1234567890',cid='321',author='123',audioUrl='https://audio.bilivideo.com/sample.m4s?token=private-signed-audio';
const text='先读取输入资料，再用自动化脚本处理数据，最后生成可以核对的结果。';
const transcript=(content=text)=>({text:content,segments:content?[{from:0,to:10,content}]:[],duration:30,model:'faster-whisper-base' as const,language:'zh' as const,range:{from:0 as const,to:30},coverage:'complete' as const,audioBytes:1200});
function fixture(){
  const item:Item={key:'bilibili:'+bvid,platform:'bilibili',externalId:bvid,url:'https://www.bilibili.com/video/'+bvid,title:'不能拿标题代替视频正文',authorId:author,author:'UP',publishedAt:null,discoveredAt:'2026-10-23T00:00:00Z',version:'video',metadata:{requestedPages:[1],subtitlePages:[{page:1,cid,duration:30,state:'unavailable',reason:'no_track_exposed'}],audioRead:false,visionRead:false}};
  const evidence:Evidence[]=[{itemKey:item.key,kind:'description',url:item.url,text:'仅为简介',collectedAt:item.discoveredAt,coverage:{material:'简介',expected:1,acquired:1,processed:0,state:'unread',method:'fixture'}},{itemKey:item.key,kind:'video-reading-manifest',url:item.url,text:JSON.stringify({requestedPages:[1],pages:item.metadata.subtitlePages,audio:{state:'unread',asrConfigured:false},vision:{state:'unread'},otherCommentsRead:0}),collectedAt:item.discoveredAt,coverage:{material:'清单',expected:1,acquired:1,processed:0,state:'unread',method:'fixture'}}];
  return {item,evidence,warnings:['原字幕轨未暴露；保留范围。']};
}
function dependencies(){
  const counts={audio:0,transcribe:0};
  const options={enabled:true,pythonCommand:'configured-python',modelDir:'configured-model',workDir:'unused-mocked-work-dir',
    audio:async (actualBvid:string,opts:any)=>{counts.audio++;assert.equal(actualBvid,bvid);assert.equal(opts.expectedAuthorUid,author);assert.equal(opts.expectedCid,cid);return{bvid,cid,duration:30,audioUrl};},
    transcribe:(async (opts:any)=>{counts.transcribe++;assert.equal(opts.audioUrl,audioUrl);assert.equal(opts.sourceDuration,30);assert.equal(opts.pythonCommand,'configured-python');assert.equal(opts.modelDir,'configured-model');return transcript();}) as typeof transcribeAudio};
  return{counts,options};
}
const asrPage=(result:ReturnType<typeof fixture>)=>(result.item.metadata.asrPages as any[])[0];

test('关闭、非P1请求、已有可读视频正文时零次音频或ASR调用',async()=>{
  for(const mode of ['disabled','other-platform','missing-pages','p2','multi-page','subtitle','subtitle:p1','browser-subtitle:p1','asr:p1']){
    const input=fixture(),x=dependencies();
    if(mode==='disabled')x.options.enabled=false;
    if(mode==='other-platform')input.item.platform='github';
    if(mode==='missing-pages')delete input.item.metadata.requestedPages;
    if(mode==='p2')input.item.metadata.requestedPages=[2];
    if(mode==='multi-page')input.item.metadata.requestedPages=[1,2];
    if(['subtitle','subtitle:p1','browser-subtitle:p1','asr:p1'].includes(mode))input.evidence.push({...input.evidence[0],kind:mode,text:'已有正文'});
    assert.equal(await withAsrFallback(input,x.options),input,mode);
    assert.deepEqual(x.counts,{audio:0,transcribe:0},mode);
  }
});
test('字幕访问受限、身份/请求错误、不明状态和重复P1不能触发音频回退',async()=>{
  for(const part of [
    {page:1,cid,duration:30,state:'failed',reason:'AUTH_REQUIRED'},
    {page:1,cid,duration:30,state:'failed',reason:'ACCESS_DENIED'},
    {page:1,cid,duration:30,state:'failed',reason:'UPSTREAM_ERROR'},
    {page:1,cid,duration:30,state:'failed',reason:'no_track_exposed'},
    {page:1,cid,duration:30,state:'unavailable',reason:'UNKNOWN'},
    {page:1,cid,duration:30,state:'empty',reason:'AUTH_REQUIRED'},
    {page:1,cid,duration:30,state:'acquired'}
  ]){
    const input=fixture(),x=dependencies();input.item.metadata.subtitlePages=[part];
    assert.equal(await withAsrFallback(input,x.options),input);assert.deepEqual(x.counts,{audio:0,transcribe:0});
  }
  const input=fixture(),x=dependencies();input.item.metadata.subtitlePages=[...(input.item.metadata.subtitlePages as any[]),...(input.item.metadata.subtitlePages as any[])];
  assert.equal(await withAsrFallback(input,x.options),input);assert.equal(x.counts.audio,0);
});
test('启用但Python/模型未配置记录not_ready且不访问音频；未知或超预算时长也零调用',async()=>{
  for(const change of [{pythonCommand:null},{pythonCommand:' '},{modelDir:null},{modelDir:''}]){
    const input=fixture(),x=dependencies(),out=await withAsrFallback(input,{...x.options,...change});
    assert.equal(asrPage(out).state,'not_ready');assert.equal(asrPage(out).reason,'ASR_NOT_READY');assert.deepEqual(x.counts,{audio:0,transcribe:0});
    assert.equal(JSON.parse(out.evidence[1].text).audio.asrConfigured,false);
    assert.equal(input.item.metadata.asrPages,undefined);
  }
  for(const duration of [null,0,601,Infinity]){
    const input=fixture(),x=dependencies();(input.item.metadata.subtitlePages as any[])[0].duration=duration;
    const out=await withAsrFallback(input,x.options);assert.equal(asrPage(out).reason,'ASR_DURATION_LIMIT');assert.deepEqual(x.counts,{audio:0,transcribe:0});
  }
});
test('只回退一次，保留字幕原状态并添加独立未读正文/时间轴与准确处理范围，不存签名URL',async()=>{
  for(const state of ['unavailable','empty']){
    const input=fixture(),before=JSON.stringify(input),x=dependencies();
    if(state==='empty'){
      (input.item.metadata.subtitlePages as any[])[0]={page:1,cid,duration:30,state:'empty',segments:0};
      const manifest=JSON.parse(input.evidence[1].text);manifest.pages=input.item.metadata.subtitlePages;input.evidence[1].text=JSON.stringify(manifest);
    }
    const originalPages=JSON.stringify(input.item.metadata.subtitlePages),out=await withAsrFallback(input,x.options);
    assert.deepEqual(x.counts,{audio:1,transcribe:1});assert.equal(JSON.stringify(out.item.metadata.subtitlePages),originalPages);
    assert.equal(out.evidence.length,input.evidence.length+2);
    const body=out.evidence.find(e=>e.kind==='asr:p1')!,timeline=out.evidence.find(e=>e.kind==='asr-timeline:p1')!;
    assert.equal(body.text,text);assert.equal(body.url,input.item.url+'?p=1');
    assert.equal(body.coverage.processed,0);assert.equal(body.coverage.state,'unread');assert.equal(body.coverage.acquired,1);
    assert.equal(isVideoTextKind(body.kind,1),true);assert.equal(isVideoTextKind(timeline.kind,1),false);
    assert.deepEqual(JSON.parse(timeline.text).processedRange,{from:0,to:30});
    assert.equal(asrPage(out).state,'acquired');assert.equal(asrPage(out).sourceDuration,30);assert.equal(asrPage(out).audioBytes,1200);assert.equal(asrPage(out).engine,'faster-whisper-base');
    assert.equal(asrPage(out).machineTranscript,true);assert.equal(asrPage(out).agentListenedAudio,false);
    const manifest=JSON.parse(out.evidence.find(e=>e.kind==='video-reading-manifest')!.text);
    assert.equal(manifest.audio.state,'acquired');assert.equal(manifest.audio.agentListenedAudio,false);assert.equal(manifest.vision.state,'unread');assert.deepEqual(manifest.pages,input.item.metadata.subtitlePages);
    assert.equal(JSON.stringify(out).includes('private-signed-audio'),false);assert.equal(JSON.stringify(out).includes('audio.bilivideo.com'),false);
    assert.match(out.warnings.at(-1)!,/机器转写/);assert.match(body.coverage.note!,/不是 Agent 直接听取音频/);
    if(state==='unavailable')assert.equal(JSON.stringify(input),before);
    assert.equal(await withAsrFallback(out,x.options),out);assert.deepEqual(x.counts,{audio:1,transcribe:1});
  }
});
test('时间轴/简介/P2字幕不是P1视频正文，不阻止一次合规回退',async()=>{
  for(const kind of ['subtitle-timeline:p1','asr-timeline:p1','browser-subtitle-observation:p1','subtitle:p2']){
    const input=fixture(),x=dependencies();input.evidence.push({...input.evidence[0],kind,text:'不能当P1正文'});
    const out=await withAsrFallback(input,x.options);assert.equal(asrPage(out).state,'acquired');assert.deepEqual(x.counts,{audio:1,transcribe:1});
  }
});
test('取消在请求前/locator后/转写后均向上传播，阻止接受材料',async()=>{
  for(const stage of ['before','audio','transcribe']){
    const input=fixture(),x=dependencies(),controller=new AbortController();
    if(stage==='before')controller.abort();
    const audio=x.options.audio,transcribe=x.options.transcribe;
    await assert.rejects(withAsrFallback(input,{...x.options,signal:controller.signal,
      audio:async(...args)=>{assert.equal(args[1].signal,controller.signal);const data=await audio(...args);if(stage==='audio')controller.abort();return data;},
      transcribe:(async(opts:any)=>{assert.equal(opts.signal,controller.signal);const data=await transcribe(opts);if(stage==='transcribe')controller.abort();return data;}) as typeof transcribeAudio}),{code:'CANCELLED'});
    assert.equal(input.item.metadata.asrPages,undefined);assert.equal(input.evidence.some(e=>e.kind==='asr:p1'),false);
    if(stage==='before')assert.deepEqual(x.counts,{audio:0,transcribe:0});
    if(stage==='audio')assert.deepEqual(x.counts,{audio:1,transcribe:0});
  }
});
test('UID/CID/BV或源时长变化以及显式身份错误向上传播，不用变化后音轨归档',async()=>{
  for(const mode of ['bad-uid','bad-cid','bad-bv','returned-bv','returned-cid','returned-duration','AUTHOR_MISMATCH','VIDEO_MISMATCH','SOURCE_CHANGED']){
    const input=fixture(),x=dependencies();
    if(mode==='bad-uid')input.item.authorId='nickname';
    if(mode==='bad-cid')(input.item.metadata.subtitlePages as any[])[0].cid='unknown';
    if(mode==='bad-bv')input.item.key='bilibili:BV0000000000';
    const audio=x.options.audio;
    await assert.rejects(withAsrFallback(input,{...x.options,audio:async(...args)=>{
      if(['AUTHOR_MISMATCH','VIDEO_MISMATCH','SOURCE_CHANGED'].includes(mode))throw new RadarError(mode,'private signed '+audioUrl);
      const data=await audio(...args);return {...data,...(mode==='returned-bv'?{bvid:'BV0000000000'}:{}),...(mode==='returned-cid'?{cid:'999'}:{}),...(mode==='returned-duration'?{duration:100}:{})};
    }}),(error:any)=>['INVALID_AUTHOR','INVALID_CID','VIDEO_MISMATCH','SOURCE_CHANGED','AUTHOR_MISMATCH'].includes(error.code)&&!error.message.includes('private'));
    assert.equal(x.counts.transcribe,0);assert.equal(input.item.metadata.asrPages,undefined);
  }
});
test('ASR失败保留原材料并返回有界失败状态，未泄露进程原文/私有路径或音频地址',async()=>{
  for(const mode of ['audio-access','python-failure','unknown-failure','bad-output','bad-bytes']){
    const input=fixture(),x=dependencies(),original=JSON.stringify(input),audio=x.options.audio;
    const out=await withAsrFallback(input,{...x.options,
      audio:async(...args)=>{if(mode==='audio-access')throw new RadarError('ACCESS_DENIED','private '+audioUrl);return audio(...args);},
      transcribe:(async()=>{x.counts.transcribe++;if(mode==='unknown-failure')throw Error('secret-python-path '+audioUrl);if(mode==='python-failure')throw new RadarError('ASR_FAILED','secret-python-output '+audioUrl);return {...transcript(),...(mode==='bad-output'?{coverage:'partial'}:{}),...(mode==='bad-bytes'?{audioBytes:32*1024*1024+1}:{})};}) as typeof transcribeAudio});
    assert.equal(asrPage(out).state,'failed');assert.equal(out.evidence.length,input.evidence.length);assert.deepEqual(out.evidence[0],input.evidence[0]);assert.equal(JSON.stringify(input),original);
    assert.equal(JSON.stringify(out).includes('secret-python'),false);assert.equal(JSON.stringify(out).includes('private'),false);assert.equal(JSON.stringify(out).includes('audio.bilivideo.com'),false);
    if(mode==='audio-access')assert.equal(x.counts.transcribe,0);
  }
});
test('空白、过少机器转写保留insufficient_text，不称无声且不增加视频筛选正文',async()=>{
  for(const content of ['', '五个字而已', ' '.repeat(25)]){
    const input=fixture(),x=dependencies();
    const out=await withAsrFallback(input,{...x.options,transcribe:(async()=>{x.counts.transcribe++;return transcript(content);}) as typeof transcribeAudio});
    assert.equal(asrPage(out).state,'insufficient_text');assert.equal(out.evidence.some(e=>isVideoTextKind(e.kind,1)),false);assert.equal(out.evidence.length,input.evidence.length);assert.match(out.warnings.at(-1)!,/不能据此断言视频无声/);
  }
  const input=fixture(),x=dependencies(),out=await withAsrFallback(input,{...x.options,transcribe:(async()=>{throw new RadarError('ASR_EMPTY','private');}) as typeof transcribeAudio});
  assert.equal(asrPage(out).state,'insufficient_text');assert.equal(JSON.stringify(out).includes('private'),false);
});
