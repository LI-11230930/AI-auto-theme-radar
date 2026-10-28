import { request, stripHtml } from './http.ts';
import { Buffer } from 'node:buffer';
import type { Fetcher } from './http.ts';
import { now, stableId, RadarError, hash } from './model.ts';
import type { Item, Evidence, Ranking, RankingPeriod, Topic } from './model.ts';
import { activityInWindow,sourceTimestamp } from './selection.ts';
import type { CollectionWindow } from './selection.ts';
import {requireGithubCredential} from './github-credential.ts';
export type RateLedger={cooldowns:(prefix?:string,clock?:number)=>{scope:string;retryAt:string}[];setCooldown:(scope:string,retryAt:string)=>void};

const numeric=(text:string|undefined)=>{if(!text)return null;const clean=text.replace(/,/g,'').trim();if(/^\d+$/.test(clean))return Number(clean);const m=/^(\d+(?:\.\d+)?)k$/i.exec(clean);return m?Math.round(Number(m[1])*1000):null;};
export function repositoryPaths(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>3||value.some(path=>typeof path!=='string'||!path||path.length>250||/[\\%?#:\u0000-\u001f]/.test(path)||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')))throw new RadarError('INVALID_PATH','源码路径须为仓库相对文件路径，最多3个，不能包含URL或路径跳转');
  return [...new Set(value)];
}
const sourceFile=(name:string)=>/\.(?:[cm]?[jt]sx?|py|go|rs|cs|java|cpp|c|h|rb|sh)$/i.test(name)&&!/(?:^|[._-])(?:test|spec|min|generated)(?:[._-]|$)/i.test(name);
const propagateLimit=(error:unknown)=>{if(error instanceof RadarError&&(['RATE_LIMITED','PUBLIC_ONLY','AUTH_REQUIRED'].includes(error.code)||error.code.startsWith('CHECKPOINT_')||error.code.startsWith('SOURCE_')))throw error;};
export function parseTrending(html:string,observedAt=now(),period:RankingPeriod='daily'):Ranking[]{
  if(!['daily','weekly'].includes(period))throw new RadarError('INVALID_PERIOD','榜单周期只支持daily或weekly');
  const articles=[...html.matchAll(/<article\b[^>]*class=["'][^"']*\bBox-row\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)];
  const rows:Ranking[]=[];
  for(const [,article] of articles){const heading=/<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(article)?.[1];if(!heading)continue;const href=/href=["']\/([\w.-]+\/[\w.-]+)["']/i.exec(heading)?.[1];if(!href)continue;const repo=stableId('github',href);
    const starsMatch=/<a\b[^>]*href=["'][^"']*\/stargazers["'][^>]*>([\s\S]*?)<\/a>/i.exec(article)?.[1];
    const today=(period==='daily'?/([\d,]+)\s+stars?\s+today/i:/([\d,]+)\s+stars?\s+this\s+week/i).exec(stripHtml(article));
    rows.push({repo,url:`https://github.com/${repo}`,rank:rows.length+1,stars:numeric(starsMatch?stripHtml(starsMatch):undefined),starsToday:period==='daily'?numeric(today?.[1]):null,period,periodStars:numeric(today?.[1]),description:stripHtml(/<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(article)?.[1]||''),language:stripHtml(/<span\b[^>]*itemprop=["']programmingLanguage["'][^>]*>([\s\S]*?)<\/span>/i.exec(article)?.[1]||'')||null,observedAt,source:`https://github.com/trending?since=${period}`});
  }
  if(!rows.length)throw new RadarError('RANKING_UNAVAILABLE',period+'榜未解析到条目；保留失败，不生成替代榜单');
  return rows;
}
export class GitHubSource {
  fetcher?:Fetcher;store?:RateLedger;
  rankingReadmes=new Map<string,{description:string;descriptionSource:string}>();
  constructor(fetcher?:Fetcher,store?:RateLedger){this.fetcher=fetcher;this.store=store;}
  scopePrefix(){return 'github:'+ (process.env.GITHUB_TOKEN?'auth-'+hash(process.env.GITHUB_TOKEN).slice(0,20):'anonymous')+':';}
  cooldown(){return this.store?.cooldowns(this.scopePrefix())[0]||null;}
  private async request(url:string,options:Parameters<typeof request>[1]={}){
    requireGithubCredential();
    const api=new URL(url).hostname==='api.github.com',resource=new URL(url).pathname.startsWith('/search/')?'search':'core',prefix=this.scopePrefix();
    const active=api?this.store?.cooldowns(prefix).find(r=>r.scope===prefix+resource||r.scope===prefix+'secondary'):null;
    if(active)throw new RadarError('RATE_LIMITED','GitHub冷却中，'+active.retryAt+' 后再试',{retryAt:active.retryAt,resource,persisted:true});
    try{return await request(url,{...options,fetcher:this.fetcher});}catch(error){
      if(api&&error instanceof RadarError&&error.code==='RATE_LIMITED'&&typeof error.details.retryAt==='string')this.store?.setCooldown(prefix+(error.details.remaining==='0'?resource:'secondary'),error.details.retryAt);
      throw error;
    }
  }
  private async json(url:string,options:Parameters<typeof request>[1]={}){const r=await this.request(url,options);try{return JSON.parse(r.text);}catch{throw new RadarError('INVALID_RESPONSE','GitHub返回非JSON内容');}}
  headers(){return {Accept:'application/vnd.github+json',...(process.env.GITHUB_TOKEN?{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`}:{})};}
  async search(topic:Topic,limit=20,window?:CollectionWindow){
    const terms=topic.keywords.map(x=>`"${x.replace(/["\\]/g,'')}"`).join(' OR ');
    const end=window?new Date(window.endAt).toISOString().replace('.000Z','Z'):null;
    const pushed=window?`${new Date(window.startAt).toISOString().replace('.000Z','Z')}..${new Date(Date.parse(window.endAt)-1000).toISOString().replace('.000Z','Z')}`:null;
    const q=terms+(end?` pushed:${pushed} created:<${end} archived:false is:public`:'');
    const url='https://api.github.com/search/repositories?'+new URLSearchParams({q,sort:window?.mode==='baseline_7d'?'stars':'updated',order:'desc',per_page:String(Math.min(Math.max(limit,1),50))});
    const result=await this.json(url,{headers:this.headers()});
    if(!Array.isArray(result.items))throw new RadarError('INVALID_RESPONSE','GitHub 搜索缺少 items');
    return {items:result.items.filter((r:any)=>!topic.exclude.some(word=>(r.full_name+' '+r.description).toLowerCase().includes(word.toLowerCase()))).filter((r:any)=>!window||(!r.archived&&r.private!==true&&r.size!==0&&![r.created_at,r.pushed_at].some(value=>{const at=sourceTimestamp(value);return at!==null&&at>=Date.parse(window.endAt);}))).map((r:any)=>({repo:stableId('github',r.full_name),description:r.description||'',stars:r.stargazers_count,url:r.html_url,createdAt:r.created_at||null,pushedAt:r.pushed_at||null})),incomplete:!!result.incomplete_results,total:result.total_count,query:q};
  }
  async read(repoInput:string,options:{files?:string[];window?:CollectionWindow}={}):Promise<{item:Item;evidence:Evidence[];warnings:string[]}>{
    const requested=options.files===undefined?null:repositoryPaths(options.files);
    const repo=stableId('github',repoInput),base=`https://api.github.com/repos/${repo}`,collectedAt=now(),warnings:string[]=[];
    const meta=await this.json(base,{headers:this.headers()});
    if(meta.private===true||meta.visibility==='private')throw new RadarError('PUBLIC_ONLY','主题雷达当前只读取公开仓库');
    const item:Item={key:`github:${repo}`,platform:'github',externalId:repo,title:meta.full_name||repo,url:`https://github.com/${repo}`,authorId:String(meta.owner?.id||''),author:meta.owner?.login||repo.split('/')[0],publishedAt:meta.created_at||null,discoveredAt:collectedAt,version:'default-branch',metadata:{stars:meta.stargazers_count??null,license:meta.license?.spdx_id||null,defaultBranch:meta.default_branch,archived:!!meta.archived,pushedAt:meta.pushed_at}};
    const evidence:Evidence[]=[];
    const add=(kind:string,url:string,text:string)=>evidence.push({itemKey:item.key,kind,url,text,collectedAt,coverage:{material:kind,expected:1,acquired:1,processed:0,state:'unread',method:'GitHub REST API；仅取得，尚未声明模型阅读'}});
    add('repository-metadata',base,JSON.stringify({description:meta.description,topics:meta.topics,license:item.metadata.license,archived:meta.archived,default_branch:meta.default_branch,pushed_at:meta.pushed_at},null,2));
    const readRelease=async()=>{try{const release=await this.json(base+'/releases/latest',{headers:this.headers(),fetcher:this.fetcher});item.version=release.tag_name||'default-branch';item.metadata.releasePublishedAt=release.published_at||null;add('release',release.html_url||item.url+'/releases',`${release.tag_name||''}\n${release.name||''}\n${release.body||''}`);}catch(e){propagateLimit(e);if(!(e instanceof RadarError&&e.details.status===404)){if(options.window)throw new RadarError('ACTIVITY_UNAVAILABLE','最新发布查询失败，无法确认批次活动范围');warnings.push('Release：'+(e as Error).message);}}};
    if(options.window){
      if(activityInWindow(item,options.window).reason==='at_or_after_end')return {item,evidence,warnings:['仓库元数据已超出批次截止时间，未请求正文']};
      await readRelease();
      if(!activityInWindow(item,options.window).eligible)return {item,evidence,warnings:['元数据与发布活动不在批次窗口，未请求正文']};
    }
    try{const r=await this.request(base+'/readme',{headers:{...this.headers(),Accept:'application/vnd.github.raw+json'},fetcher:this.fetcher,maxBytes:600000});add('readme',item.url+'#readme',r.text);}catch(e){propagateLimit(e);warnings.push('README：'+(e as Error).message);}
    if(!options.window)await readRelease();
    const ref=typeof meta.default_branch==='string'?meta.default_branch:'HEAD';
    const fileMaterial=(file:any,kind:string)=>{
      if(file?.type!=='file'||file.encoding!=='base64'||typeof file.content!=='string'||typeof file.path!=='string')throw new RadarError('FILE_UNAVAILABLE','未取得普通文本文件；不跟随符号链接或下载地址');
      repositoryPaths([file.path]);const bytes=Buffer.from(file.content,'base64');if(bytes.includes(0))throw new RadarError('BINARY_MATERIAL','二进制文件不作为源码文本');
      const text=bytes.toString('utf8'),limit=kind==='license'?16000:40000,truncated=text.length>limit;
      add(kind,`${item.url}/blob/${encodeURIComponent(ref)}/${file.path.split('/').map(encodeURIComponent).join('/')}`,text.slice(0,limit));
      evidence[evidence.length-1].coverage.note=`路径 ${file.path}；blob ${file.sha||'未提供'}；取得${Math.min(text.length,limit)}/${text.length}字符；${truncated?'材料已截断':'该文件文本已取得'}；分支材料非历史时点快照`;
      if(truncated)warnings.push(file.path+'：取得材料已截断');
    };
    try{fileMaterial(await this.json(base+'/license',{headers:this.headers(),fetcher:this.fetcher,maxBytes:200000}),'license');}catch(e){propagateLimit(e);warnings.push('许可证：'+(e as Error).message);}
    let paths=requested||[];
    if(requested===null){try{
      const list=async(path='')=>{const result=await this.json(base+'/contents'+(path?'/'+path:'')+'?'+new URLSearchParams({ref}),{headers:this.headers(),fetcher:this.fetcher,maxBytes:500000});if(!Array.isArray(result))throw new RadarError('DIRECTORY_UNAVAILABLE','源码目录没有返回列表');return result;};
      let entries=await list();
      if(!entries.some(entry=>entry.type==='file'&&sourceFile(entry.name))){const directory=entries.find(entry=>entry.type==='dir'&&['src','lib','app'].includes(entry.name));if(directory)entries=await list(directory.name);}
      const candidates=entries.filter(entry=>entry.type==='file'&&sourceFile(entry.name)).sort((a,b)=>Number(!/^(?:index|main|cli|app)\./i.test(a.name))-Number(!/^(?:index|main|cli|app)\./i.test(b.name))||a.name.localeCompare(b.name));
      paths=repositoryPaths(candidates.slice(0,1).map(entry=>entry.path));
      if(!paths.length)warnings.push('源码抽样：所查目录未找到支持的普通源码文件，未递归全仓库');
    }catch(e){propagateLimit(e);warnings.push('源码抽样：'+(e as Error).message);}}
    for(const path of paths){try{const file=await this.json(base+'/contents/'+path.split('/').map(encodeURIComponent).join('/')+'?'+new URLSearchParams({ref}),{headers:this.headers(),fetcher:this.fetcher,maxBytes:200000});if(file.path!==path)throw new RadarError('PATH_MISMATCH','返回文件路径不一致');fileMaterial(file,'source:'+path);}catch(e){propagateLimit(e);warnings.push(path+'：'+(e as Error).message);}}
    return {item,evidence,warnings};
  }
  async trending(period:RankingPeriod='daily'){
    if(!['daily','weekly'].includes(period))throw new RadarError('INVALID_PERIOD','榜单周期只支持daily或weekly');
    const response=await this.request(`https://github.com/trending?since=${period}`,{fetcher:this.fetcher,maxBytes:2000000,timeoutMs:30000}),rows=parseTrending(response.text,now(),period).slice(0,10);
    for(const row of rows){
      if(row.description.trim())continue;
      let material=this.rankingReadmes.get(row.repo);
      if(!material){
        const url=`https://api.github.com/repos/${row.repo}/readme`;
        try{
          const meta=await this.json(`https://api.github.com/repos/${row.repo}`,{headers:this.headers()});
          if(meta.private!==false||meta.visibility&&meta.visibility!=='public')throw new RadarError('PUBLIC_ONLY','榜单README回退只读取当前确认公开的仓库');
          const readme=await this.request(url,{headers:{...this.headers(),Accept:'application/vnd.github.raw+json'},maxBytes:600000});material={description:readme.text.trim().slice(0,4000),descriptionSource:row.url+'#readme'};
        }
        catch(error){propagateLimit(error);if(!(error instanceof RadarError&&error.details.status===404))throw error;material={description:'',descriptionSource:row.source};}
        this.rankingReadmes.set(row.repo,material);
      }
      Object.assign(row,material,{descriptionMissing:!material.description.trim()});
    }
    return {rows,html:response.text,collectedAt:now()};
  }
}
