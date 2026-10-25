import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {renderBilibiliBrief} from '../src/bilibili-brief.ts';
import {batchAt} from '../src/time.ts';
import {item,evidence,topic,videoBody} from './fixtures.ts';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {startOperator} from '../src/operator.ts';
import {bilibiliCapability} from '../src/service.ts';
const batch=batchAt('2026-10-22','18:00'),t={...topic,id:'bili',platforms:['bilibili'] as any,bilibiliAuthors:['123']};
function setup(publishedAt:any='2026-10-22T01:00:00Z',kind='browser-subtitle:p1'){
 const s=new Store(':memory:');s.saveTopic(t);const v={...item,key:'bilibili:BV1234567890',externalId:'BV1234567890',platform:'bilibili' as const,url:'https://www.bilibili.com/video/BV1234567890/',title:'<script>样例工具</script>',publishedAt};s.capture(v,[{...evidence,kind,itemKey:v.key,text:videoBody}]);return {s,v};
}
function answer(s:Store,change:any={}){const e=s.currentEvidence('bilibili:BV1234567890')[0];return {itemKey:e.itemKey,selected:true,reason:'仅档案技术日志',summaryZh:'将输入内容整理为可复用的自动化结果。',flow:{steps:['输入内容','整理处理','输出结果'],basis:'documented' as const,evidenceIds:[e.id!]},readEvidenceIds:[e.id!],limitations:['未运行'],agent:'fixture contract',simulation:false,reading:{snapshot:s.readingSnapshot(e.itemKey),startedAt:'now',completedAt:'now',scope:'archived_text_only' as const,materials:[{id:e.id!,kind:e.kind,providedCharacters:e.text.length,totalCharacters:e.text.length,truncated:false,cited:true}]},...change};}
test('字幕当前判断进入简洁正文，技术日志只留档，预览无投递副作用',()=>{const {s}=setup();try{s.saveAssessment(t.id,answer(s));const before=s.stats(),a=renderBilibiliBrief(s,batch),b=renderBilibiliBrief(s,batch);assert.equal(a.entries.length,1);assert.equal(a.text,b.text);assert.equal(a.sendReady,false);assert.equal(a.collectionComplete,false);assert.match(a.text,/输入内容 → 整理处理 → 输出结果/);assert.doesNotMatch(a.text,/仅档案技术日志|未运行|reading|snapshot/);assert.ok(a.html.includes('&lt;script&gt;'));assert.ok(!a.html.includes('<script>'));assert.deepEqual(s.stats(),before);}finally{s.close();}});
test('发布时间缺失、七日基线外和截止瞬间均排除，不以发现时间代替',()=>{for(const date of [null,'2026-10-01T00:00:00Z',batch.endAt]){const {s}=setup(date);try{s.saveAssessment(t.id,answer(s));assert.equal(renderBilibiliBrief(s,batch).entries.length,0);}finally{s.close();}}});
test('简介、模拟和不选中判断不能冒充已读字幕精选',()=>{for(const opts of [{kind:'description',change:{}},{kind:'subtitle',change:{simulation:true}},{kind:'subtitle',change:{selected:false}}]){const {s}=setup(undefined,opts.kind);try{s.saveAssessment(t.id,answer(s,opts.change));assert.equal(renderBilibiliBrief(s,batch).contentReady,false);}finally{s.close();}}});
test('原始subtitle正文兼容，错误流程引用拒绝展示',()=>{const {s}=setup(undefined,'subtitle');try{s.saveAssessment(t.id,answer(s));assert.equal(renderBilibiliBrief(s,batch).entries.length,1);s.saveAssessment(t.id,answer(s,{flow:{steps:['输入','输出'],basis:'documented',evidenceIds:['wrong']}}));assert.equal(renderBilibiliBrief(s,batch).entries.length,0);}finally{s.close();}});

test('历史selected判断若正文稀疏或只提供少量字符，不能用长简介撑起邮件',()=>{for(const truncated of [false,true]){const {s,v}=setup(undefined,'asr:p1');try{if(!truncated)s.capture(v,[{...evidence,itemKey:v.key,kind:'asr:p1',text:'字'.repeat(36)},{...evidence,itemKey:v.key,kind:'description',text:videoBody.repeat(10)}]);const a=answer(s),body=s.currentEvidence(v.key).find(e=>e.kind==='asr:p1')!;a.readEvidenceIds=[body.id!];a.reading.materials=[{id:body.id!,kind:body.kind,providedCharacters:36,totalCharacters:body.text.length,truncated,cited:true}];s.saveAssessment(t.id,a);assert.equal(renderBilibiliBrief(s,batch).contentReady,false);assert.equal(s.assessments(t.id)[0].selected,true);}finally{s.close();}}});

test('多分P邮件标题注明本次实际阅读分P，不将课程总标题冒充全课已读',()=>{const{s,v}=setup();try{s.capture({...v,metadata:{pageCount:13}},[{...evidence,itemKey:v.key,kind:'subtitle:p1',text:videoBody}]);s.saveAssessment(t.id,answer(s));const r=renderBilibiliBrief(s,batch);assert.match(r.entries[0].title,/本次仅P1/);assert.match(r.text,/本次仅P1/);assert.equal(r.entries.length,1);}finally{s.close();}});
test('当前实际引用机器语音转写可进入简洁正文，时间轴和弹幕不能冒充正文',()=>{for(const kind of ['asr:p1','asr-timeline:p1','danmaku:p1']){const{s}=setup(undefined,kind);try{if(kind==='asr-timeline:p1')assert.throws(()=>s.saveAssessment(t.id,answer(s)),{code:'INVALID_ASSESSMENT'});else s.saveAssessment(t.id,answer(s));assert.equal(renderBilibiliBrief(s,batch).entries.length,kind==='asr:p1'?1:0);}finally{s.close();}}});
test('材料和订阅版本变化后旧判断失效，UID订阅排除其他作者',()=>{const {s,v}=setup();try{s.saveAssessment(t.id,answer(s));s.capture(v,[{...evidence,kind:'browser-subtitle:p1',itemKey:v.key,text:'changed'}]);assert.equal(renderBilibiliBrief(s,batch).entries.length,0);s.saveAssessment(t.id,answer(s));s.saveTopic({...t,bilibiliAuthors:['456']},1);assert.equal(renderBilibiliBrief(s,batch).entries.length,0);}finally{s.close();}});
test('同视频多主题判断分开计数，不能把判断份数报成阅读视频数',()=>{const {s}=setup();try{s.saveTopic({...t,id:'second'});s.saveAssessment(t.id,answer(s));s.saveAssessment('second',answer(s));const c=bilibiliCapability({dataDir:'not-used'},null,s);assert.equal(c.counts!.analyzedVideos,1);assert.equal(c.counts!.assessments,2);assert.match(c.note,/1条视频对应2份/);}finally{s.close();}});
test('HTTP简洁HTML与独立审计JSON可读，不建outbox、不注入脚本',async()=>{
 const folder=mkdtempSync(resolve(tmpdir(),'radar-bili-brief-http-')),previous=process.env.THEME_RADAR_CONFIG;let server;
 try{const config=resolve(folder,'config.json'),data=resolve(folder,'data');writeFileSync(config,JSON.stringify({dataDir:data,topics:[t]}));process.env.THEME_RADAR_CONFIG=config;server=await startOperator(0);if(!server.listening)await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port;
 const response=await fetch(base+'/preview/bilibili');assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy')!,/default-src 'none'/);const html=await response.text();assert.match(html,/B站精选/);assert.doesNotMatch(html,/<script|readEvidenceIds|collectionWindows/);
 const json=await(await fetch(base+'/api/digest/bilibili-preview')).json() as any;assert.equal(json.sendReady,false);assert.equal(json.collectionComplete,false);const s=new Store(resolve(data,'radar.sqlite'));assert.equal(s.stats().deliveries,0);s.close();
 }finally{if(server)await new Promise<void>(r=>server.close(()=>r()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;rmSync(folder,{recursive:true,force:true});}
});
