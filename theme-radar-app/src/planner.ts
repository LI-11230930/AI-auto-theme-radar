import {batchAt,beijingDate,latestDue} from './time.ts';
import {RadarError} from './model.ts';

type Preview={id:string;state:string;leaseUntil?:number;owner?:string;completedTopics?:number};
type Outbox={id:string;state:string;bodyHash:string};
type Dispatch={delivery_id:string;state:string;deadline:number};
type Source={mode:string;expiresAt?:string|null;retryAt?:string|null};
type Grant={id:string;bodyHash:string;expiresAt:string};
type Pilot={dates:string[];issuedAt:string;expiresAt:string;maxAttempts:number;attemptsUsed:number};
export type PlanInput={clock?:number;previews?:Preview[];outboxes?:Outbox[];dispatches?:Dispatch[];source?:Source;dailyAt?:string|null;weeklyAt?:string|null;dispatchEnabled?:boolean;grant?:Grant|null;pilot?:Pilot|null};
/** Read-only advice. No claiming, resending, scheduler creation, or token fields. */
export function executionPlan(input:PlanInput={}){
  const clock=input.clock??Date.now();if(!Number.isSafeInteger(clock)||clock<0||clock>8640000000000000)throw new RadarError('INVALID_CLOCK','诊断时钟无效');
  const when=new Date(clock),today=beijingDate(when),morning=batchAt(today,'09:00'),evening=batchAt(today,'18:00'),due=latestDue(when);
  const next=clock<Date.parse(morning.dueAt)?morning:clock<Date.parse(evening.dueAt)?evening:batchAt(beijingDate(new Date(clock+86400000)),'09:00');
  const batchId='preview:'+due.key,mailId='mail:'+due.key,preview=(input.previews||[]).find(r=>r.id===batchId),outbox=(input.outboxes||[]).find(r=>r.id===mailId),dispatch=(input.dispatches||[]).find(r=>r.delivery_id===mailId);
  const retryAt=Date.parse(input.source?.retryAt||''),expiry=Date.parse(input.source?.expiresAt||''),daily=Date.parse(input.dailyAt||'');
  const sourceConfigured=input.source?.mode==='credential_configured',sourceExpired=Number.isFinite(expiry)&&expiry<=clock,cooling=Number.isFinite(retryAt)&&retryAt>clock;
  const dailyState=!Number.isFinite(daily)?'missing':daily>clock+1000?'future_timestamp':clock-daily>3600000?'stale':'fresh';
  const weeklyTime=Date.parse(input.weeklyAt||''),weeklyState=!Number.isFinite(weeklyTime)?'missing':weeklyTime>clock+1000?'future_timestamp':clock-weeklyTime>3600000?'stale':'fresh';
  let action='collect_read_only',reason='当前到期时段尚无完整冻结预览；仅建议采集，不表示调度已运行';
  if(outbox){
    if(dispatch){action=dispatch.state==='receipt_reported'?'review_reported_receipt':'reconcile_only';reason=dispatch.state==='receipt_reported'?'宿主已报回执，保留其来源；这不是本站直接查信证明':'已有一次发送交接，无论租约是否过期都只核对，不重新领取或重发';}
    else if(outbox.state==='cancelled'){action='do_not_revive';reason='该时段已取消，保留历史，不以取消重建或重发';}
    else{const g=input.grant,p=input.pilot,single=g?.id===mailId&&g.bodyHash===outbox.bodyHash&&Date.parse(g.expiresAt)>clock,pilot=!!p&&p.dates.includes(due.date)&&clock>=Date.parse(p.issuedAt)&&clock<Date.parse(p.expiresAt)&&clock-Date.parse(due.dueAt)<=2*3600000&&p.attemptsUsed<p.maxAttempts,authorized=input.dispatchEnabled===true&&(single||pilot);
      action=authorized?'one_authorized_attempt':'await_single_authorization';reason=authorized?(pilot?'该时段在有限试运行授权内；仍须原子领取一次，诊断本身不领取':'仅该冻结版本有未过期单封授权；实际执行仍须原子领取，诊断本身不领取'):'此版本或时段没有匹配的有效授权；其他时段和已消耗授权不能复用';}
  }else if(preview?.state==='cancelled'){action='do_not_revive';reason='预览已取消，不重新创建同一时段';}
  else if(preview?.state==='prepared'){action=dailyState==='fresh'&&weeklyState==='fresh'?'prepare_outbox':'refresh_rankings_for_preparation';reason='已有冻结预览；正式正文准备仍须服务端核对七主题、材料指纹、每日配额及一小时内Daily/Weekly和简短中文简介';}
  else if(preview?.state==='collecting'){
    const active=Number.isFinite(preview.leaseUntil)&&preview.leaseUntil!>clock;action=active?'wait_for_owner':'resume_saved_materials';reason=active?'已有有效采集租约，等待执行者，不另起一轮':'租约已过期，只建议通过正规领取接力，复用已存材料，不使用旧令牌';
  }
  if(['collect_read_only','resume_saved_materials'].includes(action)){
    if(input.source?.mode==='invalid_configuration'){action='source_configuration_required';reason='已配置资料来源存在错误；停止采集，不静默退回匿名';}
    else if(sourceExpired){action='source_expired';reason='配置的资料凭据已到期；停止采集，不静默改成匿名或自动换凭据';}
    else if(cooling){action='wait_for_source_cooldown';reason='共享GitHub冷却仍有效，当前不再请求；Daily网页的独立可达性另记';}
  }
  const known=new Set((input.previews||[]).map(r=>r.id)),unpreparedSlots=[];
  for(let days=2;days>=0;days--){const date=beijingDate(new Date(clock-days*86400000));for(const slot of ['09:00','18:00']){const batch=batchAt(date,slot);if(Date.parse(batch.dueAt)<=clock&&!known.has('preview:'+batch.key))unpreparedSlots.push(batch.key);}}
  const unresolved=(input.dispatches||[]).filter(r=>r.state!=='receipt_reported').map(r=>({id:r.delivery_id,state:r.state==='claimed'&&r.deadline<=clock?'uncertain':r.state,action:'reconcile_only'}));
  return {at:when.toISOString(),timezone:'Asia/Shanghai',due,nextDue:{key:next.key,at:next.dueAt},action,reason,preview:preview?{id:preview.id,state:preview.state,completedTopics:preview.completedTopics??null,activeLease:preview.state==='collecting'&&(preview.leaseUntil??0)>clock}:null,
    source:{configured:sourceConfigured,expired:sourceExpired,cooling,retryAt:cooling?input.source!.retryAt:null,scope:'配置状态不证明真实来源调用成功'},daily:{state:dailyState,observedAt:input.dailyAt||null,scope:'新正文准备的快照时效；不改已冻结邮件'},weekly:{state:weeklyState,observedAt:input.weeklyAt||null},unresolvedDispatches:unresolved,
    unpreparedSlots,unpreparedScope:'最近三天没有预览记录的到期时段；没有实际调度证据时不能称为漏发',schedulerState:'not_observed_here',createsTask:false,sendsEmail:false};
}
