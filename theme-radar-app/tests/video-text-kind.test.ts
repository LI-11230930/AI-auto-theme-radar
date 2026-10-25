import test from'node:test';import assert from'node:assert/strict';import{isVideoTextKind,readableEvidence}from'../src/model.ts';import{materialPrompt}from'../src/runner.ts';
test('字幕和机器转写独立按分P判正文，时间轴弹幕不构成视频正文',()=>{
 for(const kind of ['subtitle','subtitle:p1','browser-subtitle:p1','asr:p1']){assert.equal(isVideoTextKind(kind,1),true);assert.equal(isVideoTextKind(kind,2),false);}
 for(const kind of ['asr:p2','subtitle:p2']){assert.equal(isVideoTextKind(kind,2),true);assert.equal(isVideoTextKind(kind,1),false);}
 for(const kind of ['asr-timeline:p1','subtitle-timeline:p1','danmaku:p1','description','asr:p0','asr:p-1'])assert.equal(isVideoTextKind(kind),false);
});
test('ASR时间轴不进入Agent正文，机器转写正文保留实际字符范围',()=>{
 const evidence=(kind:string)=>({id:kind,itemKey:'bilibili:BV1234567890',kind,url:'https://www.bilibili.com/video/BV1234567890',text:'归档文本',collectedAt:new Date().toISOString(),coverage:{material:kind,expected:1,acquired:1,processed:0,state:'unread' as const,method:'fixture'}});
 assert.equal(readableEvidence(evidence('asr-timeline:p1')),false);assert.equal(readableEvidence(evidence('asr:p1')),true);
 const result=materialPrompt({id:'test',name:'测试',description:'',keywords:[],exclude:[],platforms:['bilibili'],enabled:true},{key:'bilibili:BV1234567890',externalId:'BV1234567890',platform:'bilibili',title:'test',url:'https://www.bilibili.com/video/BV1234567890',authorId:'1',author:'test',publishedAt:null,discoveredAt:new Date().toISOString(),version:'1',metadata:{}},[evidence('asr:p1'),evidence('asr-timeline:p1')]);
 assert.deepEqual(result.materials.map(m=>m.kind),['asr:p1']);assert.equal(result.materials[0].providedCharacters,4);
});
