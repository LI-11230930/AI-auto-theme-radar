import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';import {resolve} from 'node:path';import {randomUUID} from 'node:crypto';import {RadarError} from './model.ts';
export const defaultMailTemplate={github:{subject:'GitHub 精选｜{date} {slot}',sections:['projects','daily','weekly'],titles:{projects:'主题项目',daily:'GitHub Trending Daily',weekly:'GitHub Trending Weekly'},entry:'{index}. {title}\n{url}\n{stars}\n{summary}\n{flow}'},bilibili:{subject:'B站精选｜{date} {slot}',title:'B站精选',entry:'{index}. {title}\n{url}\n{summary}\n{flow}'},footer:''};
const fail=()=>{throw new RadarError('INVALID_MAIL_TEMPLATE','模板字段、占位符或长度无效；未保存');};
function keys(v:any,allowed:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail();}
function text(v:any,max:number,tokens:string[],multiline=false){if(typeof v!=='string'||v.length>max||(!multiline&&/[\r\n]/.test(v))||/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(v))fail();for(const m of v.matchAll(/\{([^{}]+)\}/g))if(!tokens.includes(m[1]))fail();return v;}
export function validateMailTemplate(input:any){
 keys(input,['github','bilibili','footer']);const d=structuredClone(defaultMailTemplate);
 if(input.github!==undefined){const g=input.github;keys(g,['subject','sections','titles','entry']);if(g.subject!==undefined)d.github.subject=text(g.subject,200,['date','slot']);if(g.entry!==undefined)d.github.entry=text(g.entry,2000,['index','title','url','stars','summary','flow'],true);
  if(g.sections!==undefined){if(!Array.isArray(g.sections)||!g.sections.length||g.sections.length>3||new Set(g.sections).size!==g.sections.length||g.sections.some(s=>!['projects','daily','weekly'].includes(s)))fail();d.github.sections=[...g.sections];}
  if(g.titles!==undefined){keys(g.titles,['projects','daily','weekly']);for(const [k,v]of Object.entries(g.titles))d.github.titles[k]=text(v,100,[]);}}
 if(input.bilibili!==undefined){const b=input.bilibili;keys(b,['subject','title','entry']);if(b.subject!==undefined)d.bilibili.subject=text(b.subject,200,['date','slot']);if(b.title!==undefined)d.bilibili.title=text(b.title,100,[]);if(b.entry!==undefined)d.bilibili.entry=text(b.entry,2000,['index','title','url','summary','flow'],true);}
 if(input.footer!==undefined)d.footer=text(input.footer,1000,[],true);
 for(const t of [d.github,d.bilibili])if(!t.subject.trim()||!t.entry.includes('{url}')||!t.entry.includes('{summary}'))fail();
 return d;
}
export function loadMailTemplate(dataDir:string){try{const file=resolve(dataDir,'mail-template.json'),s=readFileSync(file,'utf8');if(Buffer.byteLength(s)>15000)fail();return validateMailTemplate(JSON.parse(s));}catch(e){if((e as any).code==='ENOENT')return null;throw new RadarError('INVALID_MAIL_TEMPLATE','本地邮件模板无效；未按默认模板悄悄发送');}}
export function saveMailTemplate(dataDir:string,input:any){const v=validateMailTemplate(input);mkdirSync(dataDir,{recursive:true});const target=resolve(dataDir,'mail-template.json'),temp=target+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(v,null,2));renameSync(temp,target);return v;}
const fill=(pattern:string,data:Record<string,unknown>)=>pattern.replace(/\{([^{}]+)\}/g,(_,k)=>String(data[k]??''));
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function renderCustomMail(kind:'github'|'bilibili',input:any,batch:{date:string;slot:string},sections:{id:string;heading:string;rows:any[]}[]){
 const template=validateMailTemplate(input),p=template[kind],subject=fill(p.subject,batch),wanted=kind==='github'?template.github.sections:['bilibili'];
 const parts=wanted.map(id=>{const section=sections.find(s=>s.id===id);if(!section)return null;const heading=kind==='github'?template.github.titles[id]:template.bilibili.title;
  const rows=section.rows.map((r,i)=>fill(p.entry,{index:i+1,title:r.title,url:r.url,summary:r.summary,stars:r.starLine||'',flow:r.flow?(r.flow.basis==='documented'?'运行示意':'用途示意（概括）')+'：'+r.flow.steps.join(' → '):''}).split('\n').filter(s=>s.trim()).join('\n'));
  return {heading,rows};}).filter(Boolean) as {heading:string;rows:string[]}[];
 const text=parts.map(s=>[s.heading,...(s.rows.length?s.rows:['暂无项目。'])].join('\n\n')).join('\n\n')+(template.footer?'\n\n'+template.footer:'');
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+esc(subject)+'</title><body style="font:15px/1.8 system-ui;max-width:760px;margin:auto;padding:24px">'+parts.map(s=>'<section><h2>'+esc(s.heading)+'</h2>'+s.rows.map(row=>'<p style="white-space:pre-wrap">'+row.split('\n').map(line=>/^https:\/\/(?:github\.com|www\.bilibili\.com)\//.test(line)?'<a href="'+esc(line)+'">'+esc(line)+'</a>':esc(line)).join('\n')+'</p>').join('')+'</section>').join('')+(template.footer?'<footer style="white-space:pre-wrap">'+esc(template.footer)+'</footer>':'')+'</body></html>';
 return {subject,text,html};
}
