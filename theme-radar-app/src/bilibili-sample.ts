import {loadMailTemplate} from './mail-template.ts';
import{mkdirSync,writeFileSync,readFileSync}from'node:fs';import{resolve}from'node:path';import{randomUUID,createHash}from'node:crypto';
import type{Store}from'./store.ts';import{renderBilibiliBrief}from'./bilibili-brief.ts';import{RadarError}from'./model.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
/** A frozen, individually reviewable verification sample. Does not reserve delivery or send. */
export function freezeBilibiliSample(store:Store,dataDir:string,options:{topicId?:string;itemKeys?:string[]}={},guard?:()=>void){
 const mailTemplate=loadMailTemplate(dataDir);
 const body=store.tx(()=>{guard?.();return renderBilibiliBrief(store,undefined,{...options,template:mailTemplate});});
 if(!body.contentReady||!body.entries.length)throw new RadarError('EMAIL_CONTENT_PENDING','没有当前有效的字幕阅读和中文简介，未准备样张');
 const id=randomUUID(),at=new Date().toISOString(),subject=body.customSubject||'B站精选',folder=resolve(dataDir,'bilibili-samples');mkdirSync(folder,{recursive:true});
 const frozen={id,at,subject,mailTemplate,batch:body.batch,text:body.text,html:body.html,textSha256:sha(body.text),htmlSha256:sha(body.html),entries:body.entries,collectionWindows:body.collectionWindows,verification:true,simulation:false,sendAuthorized:false,emailSent:false};
 writeFileSync(resolve(folder,id+'.json'),JSON.stringify(frozen,null,2),{flag:'wx'});
 return {id,subject,count:body.entries.length,textSha256:frozen.textSha256,preview:'/preview/bilibili-sample?id='+id,sendAuthorized:false,emailSent:false};
}
export function readBilibiliSample(dataDir:string,id:string){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))throw new RadarError('INVALID_INPUT','样张ID无效');
 let data:any;try{data=JSON.parse(readFileSync(resolve(dataDir,'bilibili-samples',id+'.json'),'utf8'));}catch{throw new RadarError('NOT_FOUND','冻结样张不存在');}
 if(data.id!==id||typeof data.text!=='string'||typeof data.html!=='string'||sha(data.text)!==data.textSha256||sha(data.html)!==data.htmlSha256)throw new RadarError('SAMPLE_CHANGED','样张内容校验未通过');
 return data;
}
