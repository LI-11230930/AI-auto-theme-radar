import {renderCustomMail} from './mail-template.ts';
import { resolve } from 'node:path';
import { Store } from './store.ts';
import { APP_ROOT } from './config.ts';
import { RadarError } from './model.ts';
import {isEmailAddress} from './email-address.ts';
import { deliveryKey } from './time.ts';
import type { Assessment, Item, Ranking, Batch, Evidence } from './model.ts';
import type { CollectionWindow } from './selection.ts';
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const link=(url:string)=>{try{const u=new URL(url);return ['https:','http:'].includes(u.protocol)?esc(u.href):'#';}catch{return '#';}};
export const MAIL_FORMAT='github-brief-zh-v3';
export const RANKING_DESCRIPTION_MISSING='未取得项目简介，暂无法概括用途。';
export type DigestEntry={item:Item;assessment:Assessment;evidence:Evidence[];topicId?:string};
export function briefZh(value:unknown):string|null{
  if(typeof value!=='string')return null;
  const text=value.trim();
  if(text.length<4||text.length>180||!/[\u3400-\u9fff]/.test(text)||/[\r\n]/.test(text)||/https?:|模型声明已读|覆盖说明|分步采集|字符范围|原始取得时间|会话到期|未执行仓库代码|readEvidenceIds|limitations/.test(text))return null;
  return text;
}
export const flowSchema={type:'object',additionalProperties:false,required:['steps','basis','evidenceIds'],properties:{steps:{type:'array',minItems:2,maxItems:4,items:{type:'string',minLength:1,maxLength:28}},basis:{type:'string',enum:['overview','documented']},evidenceIds:{type:'array',maxItems:8,items:{type:'string'}}}};
export function flowSketch(value:unknown):{steps:string[];basis:'overview'|'documented';evidenceIds:string[]}|null{
  const f=value as any;if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).some(k=>!['steps','basis','evidenceIds'].includes(k))||!['overview','documented'].includes(f.basis)||!Array.isArray(f.steps)||f.steps.length<2||f.steps.length>4||f.steps.some((s:any)=>typeof s!=='string'||!s.trim()||s.length>28||/[\r\n]/.test(s)||/https?:|会话到期|模型声明已读/.test(s))||!Array.isArray(f.evidenceIds)||f.evidenceIds.length>8||f.evidenceIds.some((id:any)=>typeof id!=='string'||!id.trim()||id.length>200)||(f.basis==='overview'&&f.evidenceIds.length>0)||(f.basis==='documented'&&!f.evidenceIds.length))return null;
  return {steps:f.steps.map((s:string)=>s.trim()),basis:f.basis,evidenceIds:[...new Set<string>(f.evidenceIds)]};
}
const flowLabel=(f:{basis:string})=>f.basis==='documented'?'运行示意':'用途示意（概括）';
const flowHtml=(f:ReturnType<typeof flowSketch>)=>f?`<div style="font-size:11px;color:#6b766f;margin:8px 0 4px">${flowLabel(f)}</div><table role="presentation" style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:12px;line-height:1.6"><tr>${f.steps.map((s,i)=>`${i?'<td style="width:18px;text-align:center;color:#6b766f" aria-hidden="true">→</td>':''}<td style="border:1px solid #dce5db;background:#f4f7f3;border-radius:5px;padding:7px;word-break:break-word;overflow-wrap:anywhere;text-align:center">${esc(s)}</td>`).join('')}</tr></table>`:'';
const starCount=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value.toLocaleString('en-US'):'未取得';
export function renderDigest(options:{batch:Batch;entries:DigestEntry[];rankings:Ranking[];weeklyRankings?:Ranking[];previousRankings?:Ranking[];warnings:string[];simulation?:boolean;collectionWindows?:CollectionWindow[];verification?:boolean;mailTemplate?:any}){
  const {batch}=options,unique=new Map<string,DigestEntry>();
  options.entries.filter(e=>e.assessment.selected).forEach(e=>{if(!unique.has(e.item.key))unique.set(e.item.key,e);});
  const entries=(options.mailTemplate&&!options.mailTemplate.github.sections.includes('projects')?[]:[...unique.values()]).slice(0,5),daily=options.rankings.slice(0,10),weekly=(options.weeklyRankings||[]).slice(0,10),simulated=!!options.simulation||entries.some(e=>e.assessment.simulation);
  const issues:string[]=[];
  const entryCopy=entries.map(e=>{const summary=briefZh(e.assessment.summaryZh),rawFlow=flowSketch(e.assessment.flow),flow=rawFlow&&!(rawFlow.basis==='documented'&&rawFlow.evidenceIds.some(id=>!e.assessment.readEvidenceIds.includes(id)||!e.evidence.some(m=>m.id===id)))?rawFlow:null;if(!summary)issues.push('project_summary:'+e.item.key);if(!flow)issues.push('project_flow:'+e.item.key);return {itemKey:e.item.key,topicId:e.topicId,title:e.item.title,url:e.item.url,summary:summary||'中文简介待补充。',flow,starLine:''};});
  const rankCopy=(rows:Ranking[],period:'daily'|'weekly')=>{
    if(options.mailTemplate&&!options.mailTemplate.github.sections.includes(period))return [];
    if(rows.length!==10||new Set(rows.map(r=>r.repo)).size!==10)issues.push(period+'_top10_required');
    return rows.map((r,i)=>{const missing=r.descriptionMissing===true&&!r.description.trim()&&r.summaryZh===RANKING_DESCRIPTION_MISSING&&r.flow===undefined;
      const summary=briefZh(r.summaryZh)||briefZh(r.description);if(!summary)issues.push(period+'_summary:'+r.repo);
      if(r.rank!==i+1||(r.period||(r.source.includes('since=weekly')?'weekly':'daily'))!==period)issues.push(period+'_order_or_period:'+r.repo);
      const rawFlow=flowSketch(r.flow),flow=rawFlow?.basis==='overview'?rawFlow:null;if(!flow&&!missing)issues.push(period+'_flow:'+r.repo);const periodStars=r.periodStars===undefined&&period==='daily'?r.starsToday:r.periodStars;return {title:r.repo,url:r.url,summary:summary||'中文简介待补充。',rank:r.rank,flow,starLine:`${period==='daily'?'今日新增':'本周新增'} Star：${starCount(periodStars)} · 累计 Star：${starCount(r.stars)}`};});
  };
  const dailyCopy=rankCopy(daily,'daily'),weeklyCopy=rankCopy(weekly,'weekly');
  const subject=`${simulated?'[离线样例] ':''}${options.verification?'[联调样张] ':''}GitHub ${batch.slot==='09:00'?'早报':'晚报'}｜${batch.date}｜主题项目、日榜与周榜`;
  const sections=[{heading:'当日主题项目',rows:entryCopy},{heading:'GitHub Trending Daily · Star 前十',rows:dailyCopy},{heading:'GitHub Trending Weekly · Star 前十',rows:weeklyCopy}];
  const text=sections.map(section=>[section.heading,...section.rows.map((r,i)=>`${i+1}. ${r.title}\n${r.url}\n${r.starLine?r.starLine+'\n':''}${r.summary}${r.flow?'\n'+flowLabel(r.flow)+'：'+r.flow.steps.join(' → '):''}`),...(!section.rows.length?['暂无项目。']:[])].join('\n\n')).join('\n\n');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title><body style="margin:0;background:#f5f6f3;color:#23352d;font:15px/1.8 'Microsoft YaHei',sans-serif"><main style="max-width:760px;margin:24px auto;background:white;padding:28px;border-radius:12px">${sections.map(section=>`<section><h2 style="font-size:21px;border-bottom:2px solid #dce5db;padding-bottom:10px">${esc(section.heading)}</h2>${section.rows.map((r,i)=>`<article style="margin:20px 0"><h3 style="margin:0;font-size:16px">${i+1}. <a style="color:#245e47" href="${link(r.url)}">${esc(r.title)}</a></h3>${r.starLine?`<p style="margin:4px 0;color:#68766b;font-size:12px">${esc(r.starLine)}</p>`:''}<p style="margin:5px 0 0">${esc(r.summary)}</p>${flowHtml(r.flow)}</article>`).join('')||'<p>暂无项目。</p>'}</section>`).join('')}</main></body></html>`;
  const custom=options.mailTemplate?renderCustomMail('github',options.mailTemplate,batch,sections.map((s,i)=>({...s,id:['projects','daily','weekly'][i]}))):null;
  return {subject,text,html,...(custom?{...custom,subject:(simulated?'[离线样例] ':'')+(options.verification?'[联调样张] ':'')+custom.subject}:{}),formatVersion:MAIL_FORMAT,contentReady:issues.length===0,contentIssues:issues,simulation:!!simulated,verification:!!options.verification,audit:{warnings:options.warnings,entries:entries.map(e=>({itemKey:e.item.key,assessment:e.assessment,evidence:e.evidence})),daily,weekly},...(options.collectionWindows?{collectionWindows:options.collectionWindows}:{})};
}
export async function sendEmail(config:any,store:Store,id:string,pythonCommand='python'){
  if(!config.runtimeEnabled||!config.email.enabled)throw new RadarError('DELIVERY_DISABLED','真实投递尚未启用；请先完成发送身份与授权验证');
  if(config.email.transport!=='smtp')throw new RadarError('CONNECTED_AGENT_REQUIRED','此邮件通道需由有Outlook连接的Agent执行；SMTP桥接不能代替连接授权');
  if(config.email.formatStatus==='awaiting_user')throw new RadarError('EMAIL_FORMAT_PENDING','B站与GitHub新邮件格式等待用户补充；未领取发送权');
  if(!isEmailAddress(config.recipient)||!isEmailAddress(config.email.from)||!config.email.host||!process.env[config.email.passwordEnv])throw new RadarError('EMAIL_SETUP_REQUIRED','缺少有效收件人、发送账户或环境变量授权');
  const delivery=store.delivery(id);if(!delivery||delivery.channel!=='email'||delivery.recipient!==config.recipient)throw new RadarError('INVALID_DELIVERY','投递目标不匹配');
  const body=JSON.parse(delivery.body);if(body.simulation)throw new RadarError('SIMULATION_ONLY','固定样例不能通过真实邮件发送');
  if(body.verification)throw new RadarError('VERIFICATION_ONLY','联调样张需要单独明确授权的发送验证，不能走生产发送命令');
  if(body.formatVersion!==MAIL_FORMAT||body.contentReady!==true)throw new RadarError('EMAIL_CONTENT_PENDING','需要完整的新格式中文简介和日周榜；未领取发送权');
  if(!store.beginDelivery(id))throw new RadarError('DELIVERY_EXISTS','此批次已尝试发送或待确认，不能盲目重发');
  try{const {runProcess}=await import('./runner.ts');const result=await runProcess(pythonCommand,[resolve(APP_ROOT,'bridges/smtp_send.py')],JSON.stringify({id,recipient:config.recipient,...config.email,...body}),{cwd:APP_ROOT,timeoutMs:40000,maxBytes:50000});const receipt=JSON.parse(result.stdout);if(receipt.state==='submitted')return store.transitionDelivery(id,'submitted',receipt);return store.transitionDelivery(id,receipt.state==='failed'?'failed':'uncertain',receipt);}catch(e){store.transitionDelivery(id,'uncertain',{code:(e as RadarError).code||'UNKNOWN',note:'发送子进程未提供确定回执，先核查再重试'});throw e;}
}
