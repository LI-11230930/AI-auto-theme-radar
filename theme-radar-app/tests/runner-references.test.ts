import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {HostRunner,materialPrompt,assessmentTask,validateModelTaskResult} from '../src/runner.ts';
import {topic,item,evidence} from './fixtures.ts';
const first='a'.repeat(63)+'7',second='b'.repeat(64);
const text=[{...evidence,id:first},{...evidence,id:second,kind:'source:main.ts',text:'Source text'}];
const result=(ids=['m1'])=>({itemKey:item.key,selected:true,reason:'材料给出可复用的处理方式',summaryZh:'读取资料并生成结果的工具。',flow:{steps:['输入资料','处理结果'],basis:'documented',evidenceIds:ids},readEvidenceIds:ids,limitations:[]});
async function runnerTest(fn:(r:HostRunner)=>Promise<void>){const folder=mkdtempSync(resolve(tmpdir(),'radar-references-'));try{await fn(new HostRunner('Codex',{},folder,{}));}finally{rmSync(folder,{recursive:true,force:true});}}
test('没有正文或材料未归档时不生成空enum任务，也不调用模型',async()=>runnerTest(async runner=>{
 runner.invoke=async()=>{throw Error('must not call model');};await assert.rejects(runner.assess(topic,item,[]),{code:'NO_READABLE_MATERIAL'});await assert.rejects(runner.assess(topic,item,[evidence]),{code:'MATERIAL_ID_REQUIRED'});
}));
test('模型只需局部编号，程序将阅读和流程引用绑定到原64位证据ID',async()=>runnerTest(async runner=>{
 runner.invoke=async(prompt,schema:any)=>{const p=JSON.parse(prompt);assert.deepEqual(p.materials.map((m:any)=>m.id),['m1','m2']);assert.deepEqual(schema.properties.readEvidenceIds.items.enum,['m1','m2']);assert.equal(p.item.metadata.currentEvidenceIds,undefined);assert.ok(!prompt.includes(first));return {stdout:JSON.stringify(result(['m1','m2'])),stderr:'',code:0};};
 const assessment=await runner.assess(topic,{...item,metadata:{currentEvidenceIds:[first,second]}},text);assert.deepEqual(assessment.readEvidenceIds,[first,second]);assert.deepEqual(assessment.flow!.evidenceIds,[first,second]);assert.equal(assessment.simulation,false);
}));
test('长哈希少一字符不做猜测补齐，未知局部编号也不能进入档案',async()=>runnerTest(async runner=>{
 for(const id of [first.slice(0,-1),'m3']){runner.invoke=async()=>({stdout:JSON.stringify(result([id])),stderr:'',code:0});await assert.rejects(runner.assess(topic,item,text),{code:'INVALID_AGENT_OUTPUT'});}
}));
test('局部编号作用域限制在当前条目，不能接受其他条目的旧结果',()=>{
 const task=assessmentTask(materialPrompt(topic,{...item,key:'github:other/tool'},text));assert.match(validateModelTaskResult(task.prompt,result())!,/条目ID/);
});
test('空预算、未取得图片和只含地址的材料不产生可引用编号',()=>{
 const bundle=materialPrompt(topic,item,[text[0],{...text[1],kind:'image-manifest'}, {...text[1],id:'c'.repeat(64),kind:'source:later.ts'}],1),task=assessmentTask(bundle),p=JSON.parse(task.prompt);
 assert.deepEqual(p.materials.map((m:any)=>m.id),['m1']);assert.deepEqual([...task.references.values()],[first]);assert.match(validateModelTaskResult(task.prompt,result(['m2']))!,/materials.id/);
});
test('流程引用未声明读取的材料仍在提交前拒绝',()=>{
 const task=assessmentTask(materialPrompt(topic,item,text)),answer={...result(),flow:{...result().flow,evidenceIds:['m2']}};assert.match(validateModelTaskResult(task.prompt,answer)!,/已引用/);
});
test('局部编号不会损失真实截断范围，归档仍保留原证据ID',async()=>runnerTest(async runner=>{
 runner.invoke=async()=>({stdout:JSON.stringify(result()),stderr:'',code:0});const output=await runner.assess(topic,item,[{...text[0],text:'x'.repeat(25000)}]);assert.deepEqual(output.readEvidenceIds,[first]);assert.ok(output.limitations.some(s=>s.includes('24000/25000')));
}));
