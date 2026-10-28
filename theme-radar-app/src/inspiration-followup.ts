import type {Store} from './store.ts';import type {AutomationPlan} from './automation-plan.ts';
import {RadarError,publicError} from './model.ts';import {parseResult} from './runner.ts';import {GitHubSource} from './github.ts';
import {inspirationLinks,prepareInspiration,submitInspiration,cancelInspiration} from './inspiration.ts';

export async function runInspirationFollowups(args:{store:Store;plan:AutomationPlan;seeds:{topicId:string;videoKey:string}[];protectedKeys:string[];signal:AbortSignal;guard:()=>void;invoke:(prompt:string,schema:object,signal:AbortSignal)=>Promise<{stdout:string}>;onProgress?:(report:any)=>void;readRepository?:(repo:string,signal:AbortSignal)=>Promise<any>;timeoutMs?:number}){
 const settings=args.plan.inspiration,report:any={enabled:settings?.enabled===true,attempted:0,newCards:0,reusedCards:0,declined:0,repositoryReads:0,failed:0,duplicateRepositories:0,rows:[],emailChanged:false};
 if(!settings?.enabled)return report;
 const controller=new AbortController(),abort=()=>controller.abort(),timeout=setTimeout(abort,args.timeoutMs??180000);if(args.signal.aborted)controller.abort();args.signal.addEventListener('abort',abort,{once:true});
 const seen=new Set<string>(),protectedKeys=new Set(args.protectedKeys),notify=()=>{args.onProgress?.(report);},check=()=>{args.guard();if(controller.signal.aborted)throw new RadarError('INSPIRATION_TIMEOUT','灵感跟进达到独立时间预算');};
 const read=args.readRepository||((repo:string,signal:AbortSignal)=>new GitHubSource((url,init)=>{if(signal.aborted)throw new RadarError('CANCELLED','跟进已取消');return fetch(url,{...init,signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});},args.store).read(repo,{files:[]}));
 const bounded=<T>(action:()=>Promise<T>)=>new Promise<T>((resolve,reject)=>{check();const stop=()=>{reject(new RadarError('INSPIRATION_TIMEOUT','灵感跟进达到独立时间预算'));};controller.signal.addEventListener('abort',stop,{once:true});Promise.resolve().then(action).then(value=>{controller.signal.removeEventListener('abort',stop);resolve(value);},error=>{controller.signal.removeEventListener('abort',stop);reject(error);});});
 try{
  follow:for(const seed of args.seeds){check();let links:string[];try{links=inspirationLinks(args.store,seed.topicId,seed.videoKey);}catch(error){report.rows.push({...seed,state:'skipped',code:publicError(error).code});continue;}
   for(const repo of links){
    if(seen.has(repo)){report.duplicateRepositories++;continue;}if(report.attempted>=settings.maxCards){report.budgetReached=true;break follow;}seen.add(repo);report.attempted++;
    const row:any={...seed,repo,state:'preparing'},input={...seed,repo,agent:args.plan.agent};report.rows.push(row);notify();let lease:any=null;
    try{
     check();try{lease=prepareInspiration(args.store,input);}catch(error){
      if(publicError(error).code!=='REPO_BODY_REQUIRED')throw error;
      if(protectedKeys.has('github:'+repo))throw new RadarError('PROTECTED_MAIL_SOURCE','本轮邮件已引用该仓库，未为灵感跟进刷新正文');
      if(report.repositoryReads>=settings.maxRepositoryReads)throw new RadarError('INSPIRATION_READ_BUDGET','灵感仓库读取预算已用完');
      report.repositoryReads++;row.repositoryRead=true;notify();const result=await bounded(()=>read(repo,controller.signal));check();
      if(result.item.key!=='github:'+repo||result.item.platform!=='github'||result.item.externalId!==repo)throw new RadarError('REPOSITORY_MISMATCH','补读仓库与明确引用不符');
      args.store.capture(result.item,result.evidence,check);lease=prepareInspiration(args.store,input);
     }
     check();if(lease.reused){row.state='reused';row.cardId=lease.card.id;row.proposal=!!lease.card.result.proposal;report.reusedCards++;if(!row.proposal)report.declined++;}
     else{row.state='reading';notify();const response=await bounded(()=>args.invoke(lease.prompt,lease.schema,controller.signal));check();const saved=submitInspiration(args.store,{jobId:lease.jobId,token:lease.token,result:parseResult(response.stdout)});row.state=saved.card.result.proposal?'created':'declined';row.cardId=saved.card.id;report.newCards++;if(!saved.card.result.proposal)report.declined++;}
    }catch(error){args.guard();const safe=publicError(error);row.state='failed';row.code=controller.signal.aborted?'INSPIRATION_TIMEOUT':safe.code;report.failed++;if(controller.signal.aborted||safe.code.startsWith('GITHUB_CREDENTIAL_')||['AUTH_REQUIRED','ACCESS_DENIED','RATE_LIMITED','MODEL_QUOTA_EXCEEDED','PROVIDER_CHANNEL_REJECTED','RUNNER_NOT_FOUND'].includes(safe.code)){report.stoppedReason=row.code;break follow;}}
    finally{if(lease&&!lease.reused)try{cancelInspiration(args.store,lease);}catch{}notify();}
   }
  }
  return report;
 }catch(error){args.guard();report.stoppedReason=publicError(error).code;return report;}
 finally{clearTimeout(timeout);args.signal.removeEventListener('abort',abort);notify();}
}
