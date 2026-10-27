import type { Item, Evidence, Topic, Ranking } from '../src/model.ts';
export const topic:Topic={id:'sample',name:'离线样例主题',description:'仅用于离线测试，不代表用户订阅',keywords:['agent'],exclude:['广告'],platforms:['github','bilibili','xiaohongshu'],enabled:true};
export const item:Item={platform:'github',externalId:'sample/tool',key:'github:sample/tool',url:'https://github.com/sample/tool',title:'Sample Tool',authorId:'123',author:'sample',publishedAt:null,discoveredAt:'2026-10-19T00:00:00Z',version:'v1',metadata:{stars:10}};
export const evidence:Evidence={itemKey:item.key,kind:'readme',url:item.url,text:'Agent 示例工具，支持本地运行。',collectedAt:item.discoveredAt,coverage:{material:'README',expected:1,acquired:1,processed:0,state:'unread',method:'测试固定样例'}};
export const trending=`<html><article class="Box-row"><h2><a href="/sample/tool">sample / tool</a></h2><p>Agent demo</p><span itemprop="programmingLanguage">TypeScript</span><a href="/sample/tool/stargazers">1,234</a><span>56 stars today</span></article><article class="Box-row"><h2><a href="/other/repo">other / repo</a></h2><p>Other demo</p><a href="/other/repo/stargazers">22</a></article></html>`;
export function mockFetch(url:string):Promise<Response>{
  if(url.includes('/trending'))return Promise.resolve(new Response(trending));
  if(url.includes('/search/repositories'))return Promise.resolve(Response.json({items:[{full_name:'sample/tool',description:'Agent demo',stargazers_count:1234,html_url:item.url}],total_count:1,incomplete_results:false}));
  if(url.endsWith('/readme'))return Promise.resolve(new Response(evidence.text));
  if(url.endsWith('/license'))return Promise.resolve(Response.json({type:'file',encoding:'base64',path:'LICENSE',content:Buffer.from('MIT license sample').toString('base64'),sha:'license-sample'}));
  if(url.includes('/contents/index.ts?'))return Promise.resolve(Response.json({type:'file',encoding:'base64',path:'index.ts',content:Buffer.from('export const demo = true;').toString('base64'),sha:'source-sample'}));
  if(url.includes('/contents?'))return Promise.resolve(Response.json([{type:'file',name:'index.ts',path:'index.ts'}]));
  if(url.endsWith('/releases/latest'))return Promise.resolve(Response.json({tag_name:'v1',name:'Version 1',body:'离线发布说明',html_url:item.url+'/releases/tag/v1'}));
  if(url.includes('/repos/sample/tool'))return Promise.resolve(Response.json({full_name:'sample/tool',owner:{id:123,login:'sample'},description:'Agent demo',topics:['agent'],license:{spdx_id:'MIT'},stargazers_count:1234,default_branch:'main',created_at:'2026-10-18T12:00:00Z',pushed_at:'2026-10-18T13:00:00Z'}));
  return Promise.resolve(new Response('not found',{status:404}));
}

export const videoBody="先读取本地资料并校验字段，随后按已保存的主题规则筛选。脚本把候选交给模型生成中文摘要，保留原始链接与引用。写入结果前检查唯一标识，避免重复处理；失败时保存检查点并结束本轮。用户确认后才执行通知，回执用于核对发送状态。";

export function fixturePlan(extra:any={}){return {id:'my-plan',name:'自定义计划',enabled:false,agent:'DSH',execution:'attached',topicIds:['sample'],platforms:['github'],schedule:{kind:'manual'},delivery:'draft',recipient:null,from:null,sendApproved:false,maxMessagesPerDay:2,readLimit:3,githubReadLimit:2,subject:'主题精选｜{date} {time}',...extra};}
