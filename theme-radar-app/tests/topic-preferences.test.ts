import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {validateTopic} from '../src/model.ts';
import {matchesPreference,preferenceBoost,selectionProfile} from '../src/topic-preferences.ts';
import {interestScore} from '../src/interest-round.ts';
import {materialPrompt,assessmentTask} from '../src/runner.ts';
import {topic,item,evidence} from './fixtures.ts';
import {runGithub} from '../src/engine.ts';
import {FixtureRunner} from '../src/runner.ts';
import {batchAt} from '../src/time.ts';
import {validateMailTemplate} from '../src/mail-template.ts';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {resolve} from 'node:path';

const setup=()=>{const s=new Store(':memory:');s.saveTopic(topic);s.capture(item,[evidence]);return s;};
test('开发目标和偏好可选，旧主题兼容；错误类型、超长及规范化重复被拒绝',()=>{
  assert.doesNotThrow(()=>validateTopic(topic));
  assert.doesNotThrow(()=>validateTopic({...topic,goal:{objective:'开发自己的资料摘要插件',implementationFirst:true},preferred:['本地运行']}));
  for(const value of [null,[],{objective:'',implementationFirst:true},{objective:'x',implementationFirst:'yes'},{objective:'x',implementationFirst:true,run:'code'}])assert.throws(()=>validateTopic({...topic,goal:value as any}));
  for(const value of [null,'x',[''],['a','Ａ'],Array(21).fill('x'),['x'.repeat(201)]])assert.throws(()=>validateTopic({...topic,preferred:value as any}));
});
test('优先词规范化并保留ASCII边界，不把partial当作AI；不执行正则或代码',()=>{
  assert.equal(matchesPreference('AI Agent本地运行','ａｉ'),true);
  assert.equal(matchesPreference('partial learning','AI'),false);
  assert.equal(matchesPreference('literal [x] here','[x]'),true);
  assert.equal(preferenceBoost({...topic,preferred:['MCP','本地']},'MCP server 本地'),2);
});
test('优先词只在已有关键词候选内加权，不覆盖排除规则或纳入无关候选',()=>{
  const t={...topic,preferred:['本地运行','恢复','队列']},c={bvid:'BV1234567890',title:'agent 本地运行 恢复 队列',authorId:'1'};
  assert.equal(interestScore(c,t),3);
  assert.equal(interestScore({...c,title:'本地运行 恢复'},t),0);
  assert.equal(interestScore({...c,title:'广告 agent 本地运行'},t),-1);
});
test('有用反馈先预览，再按版本应用；撤销恢复原主题和原版本字段',()=>{
  const s=setup();try{
    const f=s.addFeedback(item.key,topic.id,'useful','失败恢复');
    assert.equal(f.ruleTarget,'preferred');assert.equal(f.applicable,true);assert.deepEqual(f.before,[]);assert.deepEqual(f.after,['失败恢复']);
    assert.equal(s.topics()[0].preferred,undefined);assert.equal(s.topics()[0].revision,1);
    s.applyFeedback(f.id,1);assert.deepEqual(s.topics()[0].preferred,['失败恢复']);assert.equal(s.topics()[0].revision,2);
    const duplicate=s.addFeedback(item.key,topic.id,'useful','失败恢复');assert.equal(duplicate.applicable,false);assert.throws(()=>s.applyFeedback(duplicate.id,2),/没有待应用/);
    s.revertFeedback(f.id);assert.equal(s.topics()[0].preferred,undefined);assert.equal(s.topics()[0].revision,3);
  }finally{s.close();}
});
test('反馈冲突整体拒绝，不覆盖后来目标；历史仅记录有用意见不能偷偷应用',()=>{
  const s=setup();try{
    const f=s.addFeedback(item.key,topic.id,'useful','可插拔');
    s.saveTopic({...topic,goal:{objective:'后来设定的新目标',implementationFirst:false}},1);
    assert.throws(()=>s.applyFeedback(f.id,2),/重新预览/);assert.equal(s.topics()[0].preferred,undefined);
    const legacy=s.addFeedback(item.key,topic.id,'useful','旧记录');
    s.db.prepare('UPDATE feedback SET next_topic=previous_topic WHERE id=?').run(legacy.id);
    assert.throws(()=>s.applyFeedback(legacy.id,2),/历史仅记录/);assert.equal(s.topics()[0].preferred,undefined);
  }finally{s.close();}
});
test('已应用优先规则撤销时尊重后续手改；空规则和过长规则不落库',()=>{
  const s=setup();try{
    for(const rule of ['', 'x'.repeat(201)])assert.throws(()=>s.addFeedback(item.key,topic.id,'useful',rule));
    assert.equal(s.feedback().length,0);
    const f=s.addFeedback(item.key,topic.id,'useful','API');s.applyFeedback(f.id,1);
    s.saveTopic({...s.topics()[0],description:'后来修改'},2);assert.throws(()=>s.revertFeedback(f.id),/不能覆盖/);
    assert.deepEqual(s.topics()[0].preferred,['API']);
  }finally{s.close();}
});
test('四宿主共享模型材料包含开发目标和偏好，但这些不冒充证据且旧主题有回退',()=>{
  const s=setup();try{
    const next={...topic,goal:{objective:'构建有状态的资料摘要插件',implementationFirst:true},preferred:['检查点']};
    const bundle=materialPrompt(next,item,s.currentEvidence(item.key)),prompt=JSON.parse(assessmentTask(bundle).prompt);
    assert.equal(prompt.selectionProfile.objective,next.goal.objective);assert.equal(prompt.selectionProfile.implementationFirst,true);
    assert.deepEqual(prompt.selectionProfile.preferredTerms,['检查点']);assert.match(prompt.selectionProfile.policy,/不是内容证据/);
    assert.equal(prompt.materials.length,1);assert.equal(prompt.materials[0].text,evidence.text);assert.equal(prompt.materials[0].id,'m1');
    assert.equal(selectionProfile(topic).objective,null);
  }finally{s.close();}
});
test('GitHub预算只有一个时优先偏好改变实际阅读对象，不增加搜索与读取次数',async()=>{
  const folder=mkdtempSync(resolve(tmpdir(),'radar-preference-order-')),s=new Store(':memory:'),reads:string[]=[];let searches=0;
  try{
    s.saveTopic({...topic,platforms:['github'],preferred:['检查点']});
    const source:any={cooldown:()=>null,search:async()=>{searches++;return {items:[{repo:'sample/popular',description:'agent通用介绍',stars:10000},{repo:'sample/practical',description:'agent检查点实现',stars:1}],total:2,incomplete:false};},read:async(repo:string)=>{
      reads.push(repo);const next={...item,key:'github:'+repo,externalId:repo,url:'https://github.com/'+repo,title:repo,publishedAt:'2026-10-18T00:00:00Z'};
      return {item:next,evidence:[{...evidence,itemKey:next.key,url:next.url}],warnings:[]};
    }};
    const result=await runGithub({store:s,source,runner:new FixtureRunner(),topicId:topic.id,batch:batchAt('2026-10-19','09:00'),outputDir:folder,recipient:'reader@example.com',limit:1,mailTemplate:validateMailTemplate({github:{sections:['projects']}})});
    assert.equal(result.state,'prepared');assert.deepEqual(reads,['sample/practical']);assert.equal(searches,1);assert.equal(result.attempted,1);
    assert.equal(s.stats().items,1);
  }finally{s.close();rmSync(folder,{recursive:true,force:true});}
});
