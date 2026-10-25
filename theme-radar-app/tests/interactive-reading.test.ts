import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.ts';
import {prepareReading,renewReading,cancelReading,submitReading} from '../src/interactive-reading.ts';
import {analyzeArchived} from '../src/archive-reading.ts';
import {topic,item,evidence} from './fixtures.ts';

const begin=(s:Store,agent='WorkBuddy')=>prepareReading(s,{topicId:topic.id,itemKey:item.key,agent});
const init=(s:Store)=>{s.saveTopic(topic);s.capture(item,[evidence]);};
const answer=(s:Store)=>({itemKey:item.key,selected:true,reason:'隔离材料的协议测试',limitations:['非真实模型'],readEvidenceIds:[s.currentEvidence(item.key)[0].id!],agent:'forged',simulation:true});

test('交互领取→续租→提交原子保存字符范围，不能伪造宿主/模拟字段；跨宿主复用不重记阅读',()=>{
 const s=new Store(':memory:');try{init(s);const p=begin(s);assert.equal(p.reused,false);assert.equal(JSON.parse(p.prompt!).materials[0].text,evidence.text);assert.equal(renewReading(s,p as any).renewed,true);
 const r=submitReading(s,{...p,assessment:answer(s)} as any);assert.equal(r.assessment.agent,'WorkBuddy');assert.equal(r.assessment.simulation,false);assert.equal(r.assessment.reading.materials[0].providedCharacters,evidence.text.length);assert.equal((s.job(p.jobId!) as any).state,'done');assert.equal(s.deliveries().length,0);
 assert.throws(()=>submitReading(s,{...p,assessment:answer(s)} as any),(e:any)=>e.code==='LEASE_LOST');assert.equal(begin(s,'TRAE').reused,true);assert.equal(s.assessments(topic.id).length,1);
 }finally{s.close();}
});
test('两个连接与后台模型共用唯一租约；取消释放，不删除历史材料',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-interactive-')),s=new Store(resolve(dir,'db')),other=new Store(resolve(dir,'db'));try{init(s);const p=begin(s);
 assert.throws(()=>begin(other,'TRAE'),(e:any)=>e.code==='ANALYSIS_BUSY');let called=false;await assert.rejects(analyzeArchived({store:other,topicId:topic.id,itemKey:item.key,runner:{name:'DSH',assess:async()=>{called=true;return answer(s);}}}),(e:any)=>e.code==='ANALYSIS_BUSY');assert.equal(called,false);
 assert.throws(()=>cancelReading(other,{jobId:p.jobId!,token:'wrong'}),(e:any)=>e.code==='LEASE_LOST');cancelReading(s,p as any);const next=begin(other,'TRAE');assert.notEqual(next.token,p.token);assert.throws(()=>renewReading(s,p as any),(e:any)=>e.code==='LEASE_LOST');assert.equal(s.currentEvidence(item.key).length,1);cancelReading(other,next as any);
 }finally{other.close();s.close();rmSync(dir,{recursive:true,force:true});}
});
test('主题或材料变化、伪造引用、空引用均拒绝，允许纠正后提交',()=>{
 const s=new Store(':memory:');try{init(s);let p=begin(s);for(const ids of [[],['unprovided']])assert.throws(()=>submitReading(s,{...p,assessment:{...answer(s),readEvidenceIds:ids}} as any));assert.equal(s.assessments(topic.id).length,0);
 submitReading(s,{...p,assessment:answer(s)} as any);s.saveTopic({...topic,name:'changed'},1);p=begin(s);s.saveTopic({...topic,name:'again'},2);assert.throws(()=>submitReading(s,{...p,assessment:answer(s)} as any),(e:any)=>e.code==='TOPIC_CHANGED');cancelReading(s,p as any);
 p=begin(s);s.capture({...item,version:'changed'},[evidence]);assert.throws(()=>submitReading(s,{...p,assessment:answer(s)} as any),(e:any)=>e.code==='SOURCE_CHANGED');assert.equal(s.assessments(topic.id).length,1);cancelReading(s,p as any);
 }finally{s.close();}
});
test('过期可接管，旧token不能提交；累计30分钟禁止续租或提交',()=>{
 const s=new Store(':memory:');try{init(s);const p=begin(s);s.db.prepare('UPDATE jobs SET expires_at=? WHERE id=?').run(Date.now()-1,p.jobId!);assert.throws(()=>submitReading(s,{...p,assessment:answer(s)} as any),(e:any)=>e.code==='LEASE_LOST');const next=begin(s,'TRAE');assert.notEqual(next.token,p.token);
 const cursor=JSON.parse((s.job(next.jobId!) as any).data);cursor.startedAt=new Date(Date.now()-1800001).toISOString();s.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(cursor),next.jobId!);assert.throws(()=>renewReading(s,next as any),(e:any)=>e.code==='LEASE_LOST');assert.throws(()=>submitReading(s,{...next,assessment:answer(s)} as any),(e:any)=>e.code==='LEASE_LOST');assert.equal(s.assessments(topic.id).length,0);
 }finally{s.close();}
});
test('提交失败不能结束租约或写入半条判断；过期租约的事务整体回滚',()=>{
 const s=new Store(':memory:');try{init(s);const p=begin(s);const r=answer(s);assert.throws(()=>s.saveArchivedAssessment(topic.id,99,p.snapshot!,r,{id:p.jobId!,token:p.token!}),(e:any)=>e.code==='TOPIC_CHANGED');assert.equal((s.job(p.jobId!) as any).state,'running');assert.equal(s.assessments(topic.id).length,0);
 s.db.prepare('UPDATE jobs SET expires_at=? WHERE id=?').run(Date.now()-1,p.jobId!);assert.throws(()=>s.saveArchivedAssessment(topic.id,1,p.snapshot!,r,{id:p.jobId!,token:p.token!}),(e:any)=>e.code==='LEASE_LOST');assert.equal(s.assessments(topic.id).length,0);
 }finally{s.close();}
});
