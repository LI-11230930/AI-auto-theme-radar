import test from 'node:test';import assert from 'node:assert/strict';import {Store} from '../src/store.ts';import {bilibiliCapability} from '../src/service.ts';import {item,evidence,topic} from './fixtures.ts';
const video={...item,platform:'bilibili' as const,externalId:'BV1234567890',key:'bilibili:BV1234567890',version:'video'};
const material=(kind:string)=>({...evidence,itemKey:video.key,kind,text:'本地材料范围仅用于合成测试'});
const setup=(fn:(s:Store)=>void)=>{const s=new Store(':memory:');try{s.saveTopic(topic);fn(s);}finally{s.close();}};
function assessment(s:Store,provided=10,kind='ocr:p1',simulation=false){const e=s.currentEvidence(video.key).find(e=>e.kind===kind)!;s.saveAssessment(topic.id,{itemKey:video.key,selected:false,reason:'fixture',agent:'fixture-contract',simulation,readEvidenceIds:[e.id!],limitations:['fixture'],reading:{snapshot:s.readingSnapshot(video.key),startedAt:'fixture',completedAt:'fixture',scope:'archived_text_only',materials:[{id:e.id!,kind,providedCharacters:provided,totalCharacters:e.text.length,truncated:provided<e.text.length,cited:true}]}});}
test('纯OCR档案不能计入字幕或语音，未有模型判断不称为已分析',()=>setup(s=>{
 s.capture(video,[material('ocr:p1')]);const c=bilibiliCapability({},null,s);assert.equal(c.state,'sampled_frame_text_archived');assert.equal(c.counts!.ocrVideos,1);assert.equal(c.counts!.subtitleVideos,0);assert.equal(c.counts!.asrVideos,0);assert.equal(c.counts!.analyzedVideos,0);assert.match(c.note,/OCR不是字幕轨/);
}));
test('真实提供并引用OCR只证明归档文字判断，不冒充字幕/视听',()=>setup(s=>{
 s.capture(video,[material('ocr:p1')]);assessment(s);const c=bilibiliCapability({},null,s);assert.equal(c.state,'archived_video_text_analysis_verified');assert.equal(c.counts!.assessments,1);assert.equal(c.counts!.subtitleVideos,0);assert.match(c.note,/未直接听音频或看画面/);
}));
test('同一视频的多种材料分别计数，视频数与主题判断份数独立',()=>setup(s=>{
 s.capture(video,[material('subtitle:p1'),material('asr:p1'),material('ocr:p1')]);assessment(s);s.saveTopic({...topic,id:'other'});const a=s.assessments(topic.id)[0];s.saveAssessment('other',a);const c=bilibiliCapability({},null,s);assert.deepEqual(c.counts,{archived:1,subtitleVideos:1,asrVideos:1,ocrVideos:1,videoTextVideos:1,analyzedVideos:1,assessments:2});assert.match(c.note,/同一视频可计入多个类别/);
}));
test('零字符、超出正文和模拟引用不计为有效当前阅读',()=>{
 for(const value of [0,999])setup(s=>{s.capture(video,[material('ocr:p1')]);assessment(s,value);assert.equal(bilibiliCapability({},null,s).counts!.assessments,0);});setup(s=>{s.capture(video,[material('ocr:p1')]);assessment(s,10,'ocr:p1',true);assert.equal(bilibiliCapability({},null,s).counts!.assessments,0);});
});
test('材料改动使旧判断失效；历史OCR不能算当前字幕',()=>setup(s=>{
 s.capture(video,[material('ocr:p1')]);assessment(s);s.capture(video,[material('subtitle:p1')]);const c=bilibiliCapability({},null,s);assert.equal(c.counts!.ocrVideos,0);assert.equal(c.counts!.subtitleVideos,1);assert.equal(c.counts!.assessments,0);assert.equal(c.state,'browser_subtitle_archived');
}));
test('观察清单、时间轴、弹幕和未取得的OCR都不能算视频正文',()=>setup(s=>{
 s.capture(video,[material('description'),material('ocr-timeline:p1'),material('danmaku:p1'),{...material('ocr:p1'),coverage:{...evidence.coverage,acquired:0,state:'unavailable'}}]);const c=bilibiliCapability({dataDir:'not-used',bilibili:{}},null,s);assert.equal(c.counts,undefined);assert.notEqual(c.state,'sampled_frame_text_archived');
}));
test('平台字幕和机器转写原状态兼容，分别统计不混入OCR',()=>{
 for(const [kind,state,field] of [['subtitle','browser_subtitle_archived','subtitleVideos'],['browser-subtitle:p1','browser_subtitle_archived','subtitleVideos'],['asr:p1','machine_transcript_archived','asrVideos']])setup(s=>{s.capture(video,[material(kind)]);const c=bilibiliCapability({},null,s);assert.equal(c.state,state);assert.equal((c.counts as any)[field],1);assert.equal(c.counts!.ocrVideos,0);});
});
test('最多扫描近期100条并保留可能还有，重复只读不写业务数据',()=>setup(s=>{
 for(let i=0;i<101;i++){const v={...video,key:'bilibili:fixture'+i,externalId:'fixture'+i};s.capture(v,[{...material('ocr:p1'),itemKey:v.key}]);}const before=s.stats(),c=bilibiliCapability({},null,s);assert.equal(c.counts!.archived,100);assert.equal(c.counts!.ocrVideos,100);assert.equal(c.mayHaveMore,true);assert.equal(c.boundedToLatest,100);assert.deepEqual(s.stats(),before);
}));
