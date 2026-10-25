import test from 'node:test';import assert from 'node:assert/strict';
import {videoBodyQuality} from '../src/bilibili-body-quality.ts';
import {evidence} from './fixtures.ts';
const body=(text:string,kind='asr:p1',id='a')=>({...evidence,id,text,kind});
test('视频正文门槛不把简介、弹幕、时间轴、标点或重复材料算作信息量',()=>{
 const rows=[body('中'.repeat(36)),body('中'.repeat(36),'subtitle:p1','b'),body('字'.repeat(1000),'description'),body('字'.repeat(1000),'danmaku:p1'),body('字'.repeat(1000),'asr-timeline:p1'),body(' ，。\n'.repeat(100))];
 assert.equal(videoBodyQuality(rows).characters,36);assert.equal(videoBodyQuality(rows).sufficient,false);
 assert.equal(videoBodyQuality([body('字'.repeat(79))]).sufficient,false);assert.equal(videoBodyQuality([body('字'.repeat(80))]).sufficient,true);
 assert.equal(videoBodyQuality([body('字'.repeat(100),'subtitle:p2')],undefined,1).sufficient,false);
});
test('邮件只计当前判断实际引用并提供的正文范围，完整归档不代替已读',()=>{
 const e=body('字'.repeat(200)),a:any={readEvidenceIds:['a'],reading:{materials:[{id:'a',kind:'asr:p1',providedCharacters:36,cited:true}]}};
 assert.equal(videoBodyQuality([e],a).characters,36);a.reading.materials[0].providedCharacters=80;assert.equal(videoBodyQuality([e],a).sufficient,true);
 a.reading.materials[0].providedCharacters=NaN;assert.equal(videoBodyQuality([e],a).characters,0);
 a.reading.materials[0].providedCharacters=80;a.readEvidenceIds=[];assert.equal(videoBodyQuality([e],a).sufficient,false);
});
