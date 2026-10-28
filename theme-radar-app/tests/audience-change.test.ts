import test from 'node:test';import assert from 'node:assert/strict';import {Store} from '../src/store.ts';import {hash,normalizeText} from '../src/model.ts';import type {Item,Evidence} from '../src/model.ts';import {item,evidence,topic,videoBody} from './fixtures.ts';import {contentFingerprint} from '../src/content-fingerprint.ts';import {archivedAnalysis} from '../src/archive-reading.ts';import {renderBilibiliBrief} from '../src/bilibili-brief.ts';import {batchAt} from '../src/time.ts';
const video:Item={...item,platform:'bilibili',externalId:'BV1234567890',key:'bilibili:BV1234567890',url:'https://www.bilibili.com/video/BV1234567890',publishedAt:'2026-10-18T12:00:00Z',version:'video'};
const subtitle:Evidence={...evidence,itemKey:video.key,kind:'subtitle:p1',text:videoBody},dm=(text:string):Evidence=>({...subtitle,kind:'danmaku:p1',text});
const setup=(fn:(s:Store)=>void)=>{const s=new Store(':memory:');try{fn(s);}finally{s.close();}};
function selected(s:Store){const e=s.currentEvidence(video.key).find(e=>e.kind==='subtitle:p1')!;s.saveAssessment(topic.id,{itemKey:video.key,selected:true,reason:'fixture',summaryZh:'测试工具根据输入整理结果，仅用于回归验证。',flow:{steps:['输入','整理','输出'],basis:'documented',evidenceIds:[e.id!]},readEvidenceIds:[e.id!],limitations:['fixture'],agent:'fixture-contract',simulation:false,reading:{snapshot:s.readingSnapshot(video.key),startedAt:'fixture',completedAt:'fixture',scope:'archived_text_only',materials:[{id:e.id!,kind:e.kind,providedCharacters:e.text.length,totalCharacters:e.text.length,truncated:false,cited:true}]}});}
function legacyHash(v:Item,es:Evidence[]){return hash(normalizeText(JSON.stringify({title:v.title,version:v.version,materials:es.map(e=>({kind:e.kind,text:normalizeText(e.text)})).sort((a,b)=>a.kind.localeCompare(b.kind)||a.text.localeCompare(b.text))})));}

test('仅弹幕样本更新保持内容指纹和已推荐去重，独立事件保留',()=>setup(s=>{
 const first=s.capture(video,[subtitle,dm('甲')]);s.prepareDelivery('frozen','email','reader@example.com','frozen',[video.key]);const update=s.capture(video,[subtitle,dm('乙')]);assert.equal(update.change,'unchanged');assert.equal(update.fingerprint,first.fingerprint);assert.equal(update.audienceChanged,true);assert.equal(s.alreadyRecommended(video.key),true);assert.deepEqual(s.itemChanges(video.key).events.map(e=>e.kind),['audience_sample_changed','discovered']);assert.equal(s.delivery('frozen').body,'frozen');
}));
test('弹幕实际材料ID变化仍更新阅读快照，不能把旧判断称为当前',()=>setup(s=>{
 s.saveTopic(topic);s.capture(video,[subtitle,dm('甲')]);selected(s);const before=s.readingSnapshot(video.key);assert.equal(archivedAnalysis(s,video.key).assessments[0].current,true);s.capture(video,[subtitle,dm('乙')]);assert.notEqual(s.readingSnapshot(video.key),before);assert.equal(archivedAnalysis(s,video.key).assessments[0].current,false);assert.equal(s.currentEvidence(video.key).find(e=>e.kind==='danmaku:p1')!.text,'乙');assert.equal(s.evidence(video.key).filter(e=>e.kind==='danmaku:p1').length,2);
}));
test('重判同一正文仍不能把已推送视频再次加入邮件',()=>setup(s=>{
 s.saveTopic(topic);s.capture(video,[subtitle,dm('甲')]);selected(s);s.prepareDelivery('frozen','email','reader@example.com','frozen',[video.key]);s.capture(video,[subtitle,dm('乙')]);selected(s);assert.equal(archivedAnalysis(s,video.key).assessments[0].current,true);const result=renderBilibiliBrief(s,batchAt('2026-10-19','09:00'),{topicId:topic.id,itemKeys:[video.key]});assert.equal(result.entries.length,0);assert.equal(result.skipped[0].reason,'already_recommended');assert.equal(s.stats().deliveries,1);
}));
test('字幕真实变化、标题和版本改变继续记录内容或版本更新',()=>setup(s=>{
 s.capture(video,[subtitle,dm('甲')]);s.prepareDelivery('frozen','email','reader@example.com','frozen',[video.key]);assert.equal(s.capture(video,[{...subtitle,text:videoBody+'新增接口说明'},dm('乙')]).change,'content_changed');assert.equal(s.alreadyRecommended(video.key),false);assert.equal(s.capture({...video,version:'v2'},[subtitle,dm('乙')]).change,'version_changed');assert.equal(s.capture({...video,version:'v2',title:'新的标题'},[subtitle,dm('乙')]).change,'content_changed');
}));
test('旧版含弹幕指纹刷新原文不解除旧预留；快照及历史仍保留',()=>setup(s=>{
 s.saveTopic(topic);const es=[subtitle,dm('甲')];s.capture(video,es);const legacy=legacyHash(video,es);assert.notEqual(legacy,contentFingerprint(video,es));s.db.prepare('UPDATE items SET body_hash=? WHERE key=?').run(legacy,video.key);selected(s);s.prepareDelivery('old-frozen','email','reader@example.com','legacy mail',[video.key]);const oldId=s.currentEvidence(video.key).find(e=>e.kind==='danmaku:p1')!.id;const next=s.capture(video,[subtitle,dm('乙')]);assert.equal(next.fingerprint,legacy);assert.equal(next.change,'unchanged');assert.equal(s.alreadyRecommended(video.key),true);assert.equal(s.material(oldId!)!.text,'甲');assert.equal(s.deliveryItems('old-frozen')[0].fingerprint,legacy);assert.equal(archivedAnalysis(s,video.key).assessments[0].current,false);
}));
test('旧当前清单缺材料时不猜测等价，也不误记观察变化',()=>setup(s=>{
 s.capture(video,[subtitle,dm('甲')]);const v=s.item(video.key);v.metadata.currentEvidenceIds.push('missing');s.db.prepare('UPDATE items SET body_hash=?,data=? WHERE key=?').run('legacy-incomplete',JSON.stringify(v),video.key);const next=s.capture(video,[subtitle,dm('乙')]);assert.notEqual(next.fingerprint,'legacy-incomplete');assert.equal(next.audienceChanged,false);assert.equal(next.change,'content_changed');
}));
test('缺失弹幕样本不当作空样本；显式取得空样本可以记录变化',()=>setup(s=>{
 const first=s.capture(video,[subtitle,dm('甲')]);assert.equal(s.capture(video,[subtitle]).audienceChanged,false);assert.equal(s.fingerprint(video.key),first.fingerprint);assert.equal(s.capture(video,[subtitle,dm('乙')]).audienceChanged,false);assert.equal(s.capture(video,[subtitle,dm('')]).audienceChanged,true);assert.equal(s.capture(video,[subtitle,dm('')]).audienceChanged,false);
}));
test('同样本重复和材料顺序不产生变化，A-B-A保留两次观察',()=>setup(s=>{
 s.capture(video,[subtitle,dm('甲')]);const initial=s.fingerprint(video.key);assert.equal(s.capture(video,[dm('甲'),subtitle]).audienceChanged,false);s.capture(video,[subtitle,dm('乙')]);s.capture(video,[subtitle,dm('甲')]);assert.equal(s.fingerprint(video.key),initial);assert.equal(s.itemChanges(video.key).events.filter(e=>e.kind==='audience_sample_changed').length,2);
}));
test('只排除B站规定弹幕kind，不丢掉其他平台正文或未知材料',()=>{
 assert.notEqual(contentFingerprint(item,[evidence,{...evidence,kind:'danmaku:p1',text:'甲'}]),contentFingerprint(item,[evidence,{...evidence,kind:'danmaku:p1',text:'乙'}]));assert.notEqual(contentFingerprint(video,[subtitle,{...dm('甲'),kind:'source:danmaku'}]),contentFingerprint(video,[subtitle,{...dm('乙'),kind:'source:danmaku'}]));
});
test('采集提交保护失败时，指纹、观察事件和材料原子回滚',()=>setup(s=>{
 s.capture(video,[subtitle,dm('甲')]);const before=s.stats(),snapshot=s.readingSnapshot(video.key);assert.throws(()=>s.capture(video,[subtitle,dm('乙')],()=>{throw Error('guard');}),/guard/);assert.deepEqual(s.stats(),before);assert.equal(s.readingSnapshot(video.key),snapshot);assert.equal(s.currentEvidence(video.key).find(e=>e.kind==='danmaku:p1')!.text,'甲');
}));
