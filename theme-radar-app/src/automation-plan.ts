import {randomUUID} from 'node:crypto';
import {RadarError,now,requireText,hash} from './model.ts';
import {isEmailAddress} from './email-address.ts';
import {beijingDate} from './time.ts';
import type {Store} from './store.ts';
export const automationAgents=['DSH','WorkBuddy','Codex','TRAE'];
export type AutomationPlan={id:string;name:string;enabled:boolean;agent:string;execution:'attached'|'background';topicIds:string[];platforms:('github'|'bilibili')[];schedule:{kind:'manual'|'daily'|'interval';times?:string[];weekdays?:number[];minutes?:number};delivery:'draft'|'smtp'|'host';recipient:string|null;from:string|null;sendApproved:boolean;maxMessagesPerDay:number;mailBudgetScope?:'recipient'|'plan';readLimit:number;githubReadLimit:number;subject:string;inspiration?:{enabled:boolean;maxCards:number;maxRepositoryReads:number};revision:number;createdAt:string;updatedAt:string};
export function plans(store:Store):AutomationPlan[]{return store.db.prepare("SELECT data FROM jobs WHERE id LIKE 'automation-plan:%' ORDER BY id").all().map((r:any)=>JSON.parse(r.data));}
export function planById(store:Store,id:string){return plans(store).find(p=>p.id===id);}
export function validatePlan(input:any,store:Store){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new RadarError('INVALID_PLAN','计划需要对象');
 const allowed=['id','name','enabled','agent','execution','topicIds','platforms','schedule','delivery','recipient','from','sendApproved','maxMessagesPerDay','mailBudgetScope','readLimit','githubReadLimit','subject','inspiration','revision','createdAt','updatedAt'];
 if(Object.keys(input).some(k=>!allowed.includes(k)))throw new RadarError('INVALID_PLAN','计划含未知字段');
 if(typeof input.id!=='string'||! /^[a-zA-Z0-9_-]{1,80}$/.test(input.id))throw new RadarError('INVALID_PLAN','计划ID使用1至80个字母、数字、下划线或短横线');
 requireText(input.name,'计划名称',120);
 if(input.mailBudgetScope!==undefined&&!['recipient','plan'].includes(input.mailBudgetScope))throw new RadarError('INVALID_PLAN','邮件额度范围无效');
 if(typeof input.enabled!=='boolean'||!automationAgents.includes(input.agent)||!['attached','background'].includes(input.execution)||!['draft','smtp','host'].includes(input.delivery)||typeof input.sendApproved!=='boolean')throw new RadarError('INVALID_PLAN','执行模式、宿主或投递模式无效');
 if(input.execution==='background'&&input.agent==='WorkBuddy')throw new RadarError('INTERACTIVE_HOST','WorkBuddy使用当前会话执行，尚无已验证后台CLI；请选择交互模式');
 if(!Array.isArray(input.topicIds)||!input.topicIds.length||input.topicIds.length>20||new Set(input.topicIds).size!==input.topicIds.length||input.topicIds.some((id:any)=>typeof id!=='string'||!store.topics().some(t=>t.id===id&&(!input.enabled||t.enabled))))throw new RadarError('TOPIC_REQUIRED','选择1至20个已启用主题；停用计划可保留原主题');
 if(!Array.isArray(input.platforms)||!input.platforms.length||new Set(input.platforms).size!==input.platforms.length||input.platforms.some((p:any)=>!['github','bilibili'].includes(p)))throw new RadarError('INVALID_PLAN','请选择B站或GitHub');
 if(input.inspiration!==undefined){const i=input.inspiration;if(!i||typeof i!=='object'||Array.isArray(i)||Object.keys(i).length!==3||Object.keys(i).some(k=>!['enabled','maxCards','maxRepositoryReads'].includes(k))||typeof i.enabled!=='boolean'||!Number.isSafeInteger(i.maxCards)||i.maxCards<1||i.maxCards>3||!Number.isSafeInteger(i.maxRepositoryReads)||i.maxRepositoryReads<0||i.maxRepositoryReads>3||i.enabled&&!input.platforms.includes('bilibili'))throw new RadarError('INVALID_INSPIRATION','灵感跟进需B站，卡片1至3、新增仓库读取0至3，且明确设置开关');}
 for(const platform of input.platforms)if(!input.topicIds.some((id:string)=>store.topics().some(t=>t.id===id&&t.platforms.includes(platform))))throw new RadarError('TOPIC_REQUIRED','选定平台缺少对应主题');
 for(const [key,max] of [['readLimit',3],['githubReadLimit',20],['maxMessagesPerDay',24]] as const)if(!Number.isSafeInteger(input[key])||input[key]<1||input[key]>max)throw new RadarError('INVALID_BUDGET',`${key}需要1至${max}`);
 if(input.platforms.includes('bilibili')&&input.topicIds.some((id:string)=>store.topics().some(t=>t.id===id&&t.platforms.includes('bilibili')&&t.bilibiliDiscovery!=='interests')))throw new RadarError('INVALID_PLAN','自动计划的B站主题目前使用兴趣发现；作者/关键词订阅仍可单独运行');
 if(input.recipient!==null&&!isEmailAddress(input.recipient)||input.from!==null&&!isEmailAddress(input.from))throw new RadarError('INVALID_PLAN','邮箱须为单个有效地址或null');
 if(input.delivery!=='draft'&&(!input.sendApproved||!isEmailAddress(input.recipient)||!isEmailAddress(input.from)))throw new RadarError('MAIL_DISABLED','发送模式需要明确授权并填写发件与收件邮箱；开发默认仅草稿');
 if(input.execution==='background'&&input.delivery==='host')throw new RadarError('CONNECTED_AGENT_REQUIRED','宿主邮箱模式需要当前Agent会话在线，不能由后台CLI隐式发送');
 requireText(input.subject,'邮件标题',200);if(/[\r\n]/.test(input.subject))throw new RadarError('INVALID_PLAN','标题不能换行');
 const s=input.schedule;if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['kind','times','weekdays','minutes'].includes(k))||!['manual','daily','interval'].includes(s.kind))throw new RadarError('INVALID_SCHEDULE','频率配置无效');
 if(s.kind==='daily'&&(!Array.isArray(s.times)||!s.times.length||s.times.length>24||s.times.some((t:any)=>typeof t!=='string'||! /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))||new Set(s.times).size!==s.times.length))throw new RadarError('INVALID_SCHEDULE','每天设置1至24个不重复HH:mm时刻');
 if(s.kind==='interval'&&(!Number.isSafeInteger(s.minutes)||s.minutes<15||s.minutes>10080))throw new RadarError('INVALID_SCHEDULE','间隔为15至10080分钟');
 if(s.weekdays!==undefined&&(!Array.isArray(s.weekdays)||!s.weekdays.length||new Set(s.weekdays).size!==s.weekdays.length||s.weekdays.some((d:any)=>!Number.isInteger(d)||d<0||d>6)))throw new RadarError('INVALID_SCHEDULE','星期使用0至6，0代表周日');
 if(s.kind!=='daily'&&(s.times!==undefined||s.weekdays!==undefined)||s.kind!=='interval'&&s.minutes!==undefined)throw new RadarError('INVALID_SCHEDULE','频率字段与模式不匹配');
 return input;
}
/** Caller owns the transaction, allowing an atomic group of linked plans. */
export function writePlan(store:Store,input:any,expectedRevision?:number){
 validatePlan(input,store);const old=planById(store,input.id);
 if(old&&expectedRevision!==old.revision||!old&&expectedRevision!==undefined&&expectedRevision!==0)throw new RadarError('STALE_PLAN','计划已变化，请重新读取');
 const clock=now(),p:AutomationPlan={...input,revision:(old?.revision||0)+1,createdAt:old?.createdAt||clock,updatedAt:clock};
 store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run('automation-plan:'+p.id,'done','configuration','',0,JSON.stringify(p),clock);return p;
}
export function savePlan(store:Store,input:any,expectedRevision?:number){return store.tx(()=>writePlan(store,input,expectedRevision));}
function candidates(p:AutomationPlan,clock:number){
 if(p.schedule.kind==='manual')return [];
 if(p.schedule.kind==='interval'){const step=p.schedule.minutes!*60000,base=Date.parse(p.updatedAt);return [base+Math.floor((clock-base)/step)*step,base+(Math.floor((clock-base)/step)+1)*step].filter(t=>t>base);}
 const out:number[]=[];for(let day=-8;day<=8;day++){const date=beijingDate(new Date(clock+day*86400000)),weekday=new Date(date+'T12:00:00Z').getUTCDay();if(p.schedule.weekdays&&!p.schedule.weekdays.includes(weekday))continue;for(const slot of p.schedule.times!)out.push(Date.parse(date+'T'+slot+':00+08:00'));}return out.sort((a,b)=>a-b);
}
export function occurrenceStart(p:AutomationPlan,dueAt:string){const due=Date.parse(dueAt);if(p.schedule.kind==='interval')return new Date(due-p.schedule.minutes!*60000).toISOString();const previous=p.schedule.kind==='daily'?candidates(p,due).filter(t=>t<due).at(-1):undefined;return new Date(previous??due-86400000).toISOString();}
export function scheduleStatus(p:AutomationPlan,clock=Date.now()){
 const all=candidates(p,clock),due=all.filter(t=>t<=clock&&t>=Date.parse(p.updatedAt)).at(-1),next=all.find(t=>t>clock);
 return {timezone:'Asia/Shanghai',dueAt:due&&clock-due<=120000?new Date(due).toISOString():null,nextAt:next?new Date(next).toISOString():null,missedPolicy:'skip; latest occurrence only within 2 minutes; no catch-up'};
}
export function automationRunId(planId:string,dueAt:string){return 'automation-run:'+hash(planId+':'+dueAt);}
export function insertRun(store:Store,p:AutomationPlan,dueAt:string,trigger:'manual'|'schedule',clock=Date.now()){
 const id=automationRunId(p.id,dueAt);return store.tx(()=>{
  if(store.job(id))return null;
  const active=store.db.prepare("SELECT id,data FROM jobs WHERE id LIKE 'automation-run:%' AND state='running' AND expires_at>?").all(clock) as any[];
  if(active.some(row=>JSON.parse(row.data).planId===p.id))return null;
  const token=randomUUID(),data={id,planId:p.id,planRevision:p.revision,plan:p,dueAt,trigger,stage:'queued',startedAt:new Date(clock).toISOString(),results:[],emailSent:false};
  store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(id,'running','automation:'+process.pid,token,clock+600000,JSON.stringify(data),now());return {id,token,data};
 });
}
export function runRows(store:Store){return (store.db.prepare("SELECT id,state,expires_at,data FROM jobs WHERE id LIKE 'automation-run:%' ORDER BY updated_at DESC,rowid DESC LIMIT 30").all() as any[]).map(row=>({...JSON.parse(row.data),state:row.state,interrupted:row.state==='running'&&row.expires_at<=Date.now()}));}
