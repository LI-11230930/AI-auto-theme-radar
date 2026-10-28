import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';import {inspirationView,prepareInspiration,submitInspiration,cancelInspiration,inspirationMarkdown,inspirationCard} from '../src/inspiration.ts';
import {topic as base,item as repo,evidence as template,videoBody} from './fixtures.ts';
const topic={...base,platforms:['bilibili' as const],bilibiliDiscovery:'interests' as const,bilibiliAuthors:[],goal:{objective:'做可恢复的本地阅读工具',implementationFirst:true}};
const video={...repo,key:'bilibili:BV1234567890',platform:'bilibili' as const,externalId:'BV1234567890',url:'https://www.bilibili.com/video/BV1234567890',title:'Agent教程',metadata:{pageCount:3,requestedPages:[1,2,3]}};
const ev=(kind:string,text:string,key=video.key)=>({...template,itemKey:key,kind,text});
function setup(){const s=new Store(':memory:');s.saveTopic(topic);s.capture(video,[ev('description','源码：github.com/sample/tool'),ev('subtitle:p1',videoBody)]);s.capture(repo,[ev('readme','这是一个本地阅读工具。'.repeat(20),repo.key)]);return s;}
const args={topicId:topic.id,videoKey:video.key,repo:'sample/tool',agent:'Codex'};
function answer(p:any){const m=JSON.parse(p.prompt).materials;return {title:'可恢复的本地阅读插件',mechanisms:[{text:'视频给出有界处理机制',evidenceIds:[m.find(x=>x.kind==='subtitle:p1').id]},{text:'仓库说明本地文本整理用途',evidenceIds:[m.find(x=>x.kind==='readme').id]}],proposal:{objective:'做一个本地阅读队列',steps:['先保存任务状态','再读取并人工核对结果'],dependencies:['Node和本地文本文件'],validation:['中断后重新打开，确认从未完成项恢复']},limitations:['只依据本次文本']};}

test('明确链接必须来自当前主题实际提供范围，标题、弹幕、历史和越界分P都不能触发关联',()=>{
 const s=setup();try{
  assert.equal(inspirationView(s,{topicId:topic.id}).candidates.length,1);
  s.capture({...video,title:'https://github.com/sample/tool'},[ev('description','无链接'),ev('subtitle:p1',videoBody),ev('danmaku:p1','https://github.com/sample/tool'),ev('subtitle:p2','https://github.com/sample/tool')]);
  assert.equal(inspirationView(s,{topicId:topic.id}).candidates.length,0);assert.throws(()=>prepareInspiration(s,args),{code:'EXPLICIT_LINK_REQUIRED'});
  s.capture(video,[ev('subtitle:p1',videoBody+'字'.repeat(5000)+' https://github.com/sample/tool')]);assert.equal(inspirationView(s,{topicId:topic.id}).candidates.length,0);
  s.capture(video,[ev('description','https://github.com.evil.invalid/sample/tool github.com@evil.invalid/sample/tool'),ev('subtitle:p1',videoBody)]);assert.equal(inspirationView(s,{topicId:topic.id}).candidates.length,0);
 }finally{s.close();}
});
test('缺视频正文或仓库正文不能用简介/元数据/许可证代替',()=>{
 const s=setup();try{
  s.capture(video,[ev('description','源码：github.com/sample/tool')]);assert.throws(()=>prepareInspiration(s,args),{code:'VIDEO_BODY_REQUIRED'});
  assert.equal(inspirationView(s).candidates[0].code,'VIDEO_BODY_REQUIRED');
  s.capture(video,[ev('description','源码：github.com/sample/tool'),ev('subtitle:p1',videoBody)]);s.capture(repo,[ev('repository-metadata','描述'.repeat(100),repo.key),ev('license','MIT'.repeat(100),repo.key)]);
  assert.throws(()=>prepareInspiration(s,args),{code:'REPO_BODY_REQUIRED'});assert.equal(s.stats().jobs,0);
 }finally{s.close();}
});
test('两来源任务各有字符预算，提供局部引用和用户目标，长文本分段不重复全文',()=>{
 const s=setup();try{s.saveTopic({...topic,videoReading:'extended'});s.capture(video,[ev('description','github.com/sample/tool'),...[1,2,3].map(p=>ev('subtitle:p'+p,'长'.repeat(25000)))]);s.capture(repo,[ev('readme','文'.repeat(30000),repo.key),ev('source:cli.ts','码'.repeat(20000),repo.key)]);
  const p:any=prepareInspiration(s,args),task=JSON.parse(p.prompt),ms=task.materials;assert.equal(task.topic.goal.objective,topic.goal.objective);
  for(const source of ['video','repository'])assert.ok(ms.filter(m=>m.source===source).reduce((n,m)=>n+m.providedCharacters,0)<=20000);
  assert.ok(ms.some(m=>m.textSegments));assert.ok(ms.filter(m=>m.textSegments).every(m=>m.text===undefined));assert.ok(ms.every(m=>/^[vr]\d+$/.test(m.id)));
  assert.deepEqual(task.schema.properties.mechanisms.items.properties.evidenceIds.items.enum,ms.map(m=>m.id));
 }finally{s.close();}
});
test('真实提交形状保留两来源范围、可导出，准备同快照复用且不泄漏租约',()=>{
 const s=setup();try{const before={items:s.stats().items,evidence:s.stats().evidence,assessments:s.stats().assessments,deliveries:s.stats().deliveries};const p:any=prepareInspiration(s,args),result=submitInspiration(s,{jobId:p.jobId,token:p.token,result:answer(p)});
  assert.equal(result.accepted,true);assert.equal(result.card.current,true);assert.equal(result.card.agent,'Codex');assert.ok(result.card.reading.every(m=>m.id&&m.providedCharacters>0));
  const again:any=prepareInspiration(s,{...args,agent:'TRAE'});assert.equal(again.reused,true);assert.equal(again.card.agent,'Codex');assert.equal(s.stats().jobs,1);
  const view=inspirationView(s);assert.equal(JSON.stringify(view).includes(p.token),false);assert.deepEqual({items:s.stats().items,evidence:s.stats().evidence,assessments:s.stats().assessments,deliveries:s.stats().deliveries},before);
  const md=inspirationMarkdown(result.card);assert.match(md,/最小开发建议（未执行）/);assert.match(md,/https:\/\/github.com\/sample\/tool/);assert.match(md,/证据 /);assert.deepEqual(inspirationCard(s,p.jobId),result.card);
 }finally{s.close();}
});
test('缺双来源正文引用、未知引用和无效方案均拒绝，不结束原任务，可纠正一次提交',()=>{
 const s=setup();try{const p:any=prepareInspiration(s,args),valid=answer(p);
  const variants=[{...valid,extra:'unexpected'},{...valid,mechanisms:valid.mechanisms.map(m=>({...m,evidenceIds:['r1']}))},{...valid,mechanisms:valid.mechanisms.map(m=>({...m,evidenceIds:['guessed']}))},{...valid,proposal:{...valid.proposal,steps:['仅一步']}},{...valid,limitations:[]}];
  for(const value of variants){assert.throws(()=>submitInspiration(s,{jobId:p.jobId,token:p.token,result:value}));assert.equal((s.job(p.jobId) as any).state,'running');}
  assert.equal(submitInspiration(s,{jobId:p.jobId,token:p.token,result:valid}).accepted,true);assert.throws(()=>submitInspiration(s,{jobId:p.jobId,token:p.token,result:valid}),{code:'LEASE_LOST'});
 }finally{s.close();}
});
test('并发宿主互斥、取消和过期接管使旧token失效',()=>{
 const s=setup();try{let p:any=prepareInspiration(s,args);assert.throws(()=>prepareInspiration(s,{...args,agent:'TRAE'}),{code:'ANALYSIS_BUSY'});assert.throws(()=>cancelInspiration(s,{jobId:p.jobId,token:'wrong'}),{code:'LEASE_LOST'});
  cancelInspiration(s,p);const second:any=prepareInspiration(s,{...args,agent:'TRAE'});assert.notEqual(second.token,p.token);assert.throws(()=>submitInspiration(s,{...p,result:answer(p)}),{code:'LEASE_LOST'});
  s.db.prepare('UPDATE jobs SET expires_at=? WHERE id=?').run(Date.now()-1,p.jobId);p=prepareInspiration(s,args);assert.notEqual(p.token,second.token);assert.throws(()=>submitInspiration(s,{...second,result:answer(second)}),{code:'LEASE_LOST'});
 }finally{s.close();}
});
test('准备后修改主题或任一来源拒绝提交，已完成旧卡只标历史不删除',()=>{
 for(const change of ['topic','video','repo']){const s=setup();try{const p:any=prepareInspiration(s,args);if(change==='topic')s.saveTopic({...topic,name:'后来修改'});if(change==='video')s.capture(video,[ev('description','github.com/sample/tool'),ev('subtitle:p1',videoBody+'后来补充')]);if(change==='repo')s.capture(repo,[ev('readme','新的说明'.repeat(50),repo.key)]);assert.throws(()=>submitInspiration(s,{...p,result:answer(p)}),{code:'SOURCE_CHANGED'});}finally{s.close();}}
 const s=setup();try{const p:any=prepareInspiration(s,args);submitInspiration(s,{...p,result:answer(p)});s.saveTopic({...topic,name:'新主题'});assert.equal(inspirationView(s).cards[0].current,false);assert.equal(inspirationCard(s,p.jobId).current,false);assert.equal((prepareInspiration(s,args) as any).reused,false);}finally{s.close();}
});
test('截断限制由系统补充，档案列表读取不改变材料计数或创建任务',()=>{
 const s=setup();try{s.capture(repo,[ev('readme','中'.repeat(30000),repo.key)]);const stats=s.stats();inspirationView(s);assert.deepEqual(s.stats(),stats);const p:any=prepareInspiration(s,args),card=submitInspiration(s,{...p,result:answer(p)}).card;assert.ok(card.result.limitations.some(l=>/20000\/30000/.test(l)));assert.ok(card.result.limitations.some(l=>/未执行仓库代码/.test(l)));assert.throws(()=>inspirationView(s,{limit:101}));assert.throws(()=>prepareInspiration(s,{...args,agent:'other'}),{code:'INVALID_AGENT'});assert.throws(()=>inspirationCard(s,'../../config.local.json'),{code:'INVALID_INPUT'});}finally{s.close();}
});

test('主题筛选在卡片分页前执行，其他主题较新的50条不会隐藏本主题记录',()=>{
 const s=setup();try{const p:any=prepareInspiration(s,args);submitInspiration(s,{...p,result:answer(p)});const row=s.job(p.jobId) as any;for(let i=0;i<51;i++){const d={...JSON.parse(row.data),topicId:'other'};s.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('inspiration:fixture-'+i,'done','fixture','',0,JSON.stringify(d),'2099-01-01T00:00:00Z');}
  assert.equal(inspirationView(s).cards.length,50);assert.equal(inspirationView(s).cardsMayHaveMore,true);const filtered=inspirationView(s,{topicId:topic.id});assert.equal(filtered.cards.length,1);assert.equal(filtered.cards[0].id,p.jobId);
 }finally{s.close();}
});

test('模型可明确拒绝拼凑方案，记录理由并复用同快照，不强行生成步骤',()=>{
 const s=setup();try{const p:any=prepareInspiration(s,args),result={title:'暂无足够开发线索',mechanisms:[],proposal:null,limitations:['已读材料与该财务目标不相关，不据此推测实现']};const saved=submitInspiration(s,{...p,result});assert.equal(saved.accepted,true);assert.equal(saved.card.result.proposal,null);assert.match(inspirationMarkdown(saved.card),/未形成开发方案/);assert.equal((prepareInspiration(s,args) as any).reused,true);}finally{s.close();}
});
