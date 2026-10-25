import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync,mkdirSync,writeFileSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {validateAsrSample} from '../src/asr-validation.ts';import {RadarError} from '../src/model.ts';
const bvid='BV1234567890',text='这是用于核对API名称、数字和否定词的语音转写示例。';
function setup(t:any){
 const dir=mkdtempSync(join(tmpdir(),'radar-asr-check-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const config={dataDir:dir,bilibili:{asr:{enabled:false,pythonCommand:'fixture',modelDir:join(dir,'model')}}};let audioCalls=0,transcribeCalls=0;
 const result:any={item:{key:'bilibili:'+bvid,externalId:bvid,authorId:'123',title:'<script>bad()</script>',metadata:{subtitlePages:[{page:1,cid:'321',duration:30}]}},evidence:[{kind:'subtitle:p1',text:'参考字幕<&>',coverage:{acquired:1}}]};
 const audio:any={bvid,cid:'321',duration:30,audioUrl:'https://audio.bilivideo.com/token-private'};
 const raw={text,segments:[{from:0,to:10,content:text}],duration:30,model:'faster-whisper-base',language:'zh',range:{from:0,to:30},coverage:'complete',audioBytes:100};
 const deps:any={source:{read:async(_b:string,options:any)=>{assert.deepEqual(options,{pages:[1],includeDanmaku:false});return result;},audio:async(_b:string,options:any)=>{audioCalls++;assert.equal(options.expectedCid,'321');assert.equal(options.expectedAuthorUid,'123');return audio;}},transcribe:async()=>{transcribeCalls++;return raw;}};
 return{dir,config,result,audio,raw,deps,audioCalls:()=>audioCalls,transcribeCalls:()=>transcribeCalls};
}
test('显式ASR对照在关闭配置下可运行，不启用配置、不建档，预览转义且不暴露音轨地址',async t=>{
 const x=setup(t),before=JSON.stringify(x.config),r=await validateAsrSample(x.config,bvid,undefined,x.deps);
 assert.equal(r.enabled,false);assert.equal(r.referenceCharacters,7);assert.equal(r.asrCharacters,text.length);assert.equal(x.audioCalls(),1);assert.equal(x.transcribeCalls(),1);assert.equal(JSON.stringify(x.config),before);
 const html=readFileSync(join(x.dir,'previews/asr-comparison.html'),'utf8');assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|token-private/);assert.equal(existsSync(join(x.dir,'radar.sqlite')),false);assert.equal(r.sampleListeningVerified,false);
});
test('缺配置、缺参考或过长P1均在音频请求前拒绝，不生成成功预览',async t=>{
 for(const reason of ['config','reference','duration']){const x=setup(t);if(reason==='config')x.config.bilibili.asr.pythonCommand='';if(reason==='reference')x.result.evidence=[];if(reason==='duration')x.result.item.metadata.subtitlePages[0].duration=601;
 await assert.rejects(validateAsrSample(x.config,bvid,undefined,x.deps),{code:reason==='config'?'ASR_NOT_READY':reason==='reference'?'ASR_REFERENCE_REQUIRED':'ASR_DURATION_LIMIT'});assert.equal(x.audioCalls(),0);assert.equal(existsSync(join(x.dir,'previews')),false);}
});
test('音轨身份或时长变化在转写前拒绝',async t=>{for(const change of [{bvid:'BV0000000000'},{cid:'999'},{duration:NaN},{duration:600}]){const x=setup(t);Object.assign(x.audio,change);await assert.rejects(validateAsrSample(x.config,bvid,undefined,x.deps),{code:'SOURCE_CHANGED'});assert.equal(x.transcribeCalls(),0);}});
test('取消或转写失败保留旧对照和旧验收报告',async t=>{
 for(const mode of ['cancel','failure']){const x=setup(t),controller=new AbortController();mkdirSync(join(x.dir,'reports'));writeFileSync(join(x.dir,'reports/asr-validation.json'),'old report');mkdirSync(join(x.dir,'previews'));writeFileSync(join(x.dir,'previews/asr-comparison.html'),'old page');
 x.deps.transcribe=async()=>{if(mode==='failure')throw new RadarError('ASR_EMPTY','fixture');controller.abort();return x.raw;};await assert.rejects(validateAsrSample(x.config,bvid,controller.signal,x.deps),{code:mode==='cancel'?'CANCELLED':'ASR_EMPTY'});
 assert.equal(readFileSync(join(x.dir,'reports/asr-validation.json'),'utf8'),'old report');assert.equal(readFileSync(join(x.dir,'previews/asr-comparison.html'),'utf8'),'old page');}
});
test('新对照保留此前用户接受的来源视频及原始报告，不冒充新样本已校听',async t=>{
 const x=setup(t);mkdirSync(join(x.dir,'reports'));const previous={referenceVideo:'BV0000000001',userAcceptedForFiltering:true,userAcceptanceAt:'2026-10-24T09:00:00Z',userAcceptanceText:'可以，启用语音回退'};writeFileSync(join(x.dir,'reports/asr-validation.json'),JSON.stringify(previous));
 const r=await validateAsrSample(x.config,bvid,undefined,x.deps);assert.equal(r.priorAcceptance.referenceVideo,previous.referenceVideo);assert.equal(r.sampleListeningVerified,false);assert.equal(readdirSync(join(x.dir,'reports')).filter(f=>f.startsWith('asr-validation-history-')).length,1);
});
test('非法转写或字节范围不能写成成功结果',async t=>{for(const mode of ['duration','bytes']){const x=setup(t);if(mode==='duration')x.raw.duration=1;else x.raw.audioBytes=0;await assert.rejects(validateAsrSample(x.config,bvid,undefined,x.deps));assert.equal(existsSync(join(x.dir,'previews')),false);}});
