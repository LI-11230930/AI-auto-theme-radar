import {loadMailTemplate,saveMailTemplate,defaultMailTemplate} from './mail-template.ts';
import {importAuthorObservation,listAuthorObservations} from './author-observation.ts';
import { createServer } from 'node:http';
import { readFileSync,existsSync,readdirSync,writeFileSync,mkdirSync,statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { context,capabilityReport,liveProbe,runConfigured,writeReport,analyzeConfiguredArchive,archivePreview } from './service.ts';
import { APP_ROOT } from './config.ts';
import { GitHubSource } from './github.ts';
import { renderDigest } from './mail.ts';
import { latestDue } from './time.ts';
import {AutomationRuntime} from './automation-runtime.ts';
import {operatorIdentity} from './operator-identity.ts';
import {draftView,prepareOneOff} from './automation-outbox.ts';
import { RadarError,publicError } from './model.ts';
import {BilibiliSource} from './bilibili.ts';
import {readConfiguredBilibili} from './bilibili-reading.ts';
import {requireText} from './model.ts';
import {libraryView} from './library.ts';
import {importBrowserSubtitles} from './browser-subtitles.ts';
import {archivedAnalysis} from './archive-reading.ts';
import {discoverTopic} from './discovery.ts';
import {materialView} from './material-view.ts';
import {digestCandidates} from './digest-candidates.ts';
import {renderBilibiliBrief} from './bilibili-brief.ts';
import {authorReadingQueue,readNextAuthorItems} from './author-queue.ts';
import {BrowserBatchBridge} from './browser-batch.ts';
import {browserBatchHttp} from './browser-batch-http.ts';
import {BilibiliLogin} from './bilibili-login.ts';
import{freezeBilibiliSample,readBilibiliSample}from'./bilibili-sample.ts';
import{interestStatus,runConfiguredInterest,cancelInterest}from'./interest-service.ts';
import {setupStatus} from './setup-status.ts';
import {listBackups,createManagedBackup,managedBackupPath,rehearseBackup} from './backup.ts';

export async function startOperator(port?:number,automationDependencies?:any){
  if(port!==undefined&&(!Number.isInteger(port)||port<0||port>65535))throw new RadarError('INVALID_OPERATOR_PORT','验证台端口须为0至65535的整数；0仅用于自动分配测试端口');
  const {config,store}=context(),token=randomBytes(24).toString('hex'),analyses=new Map<string,AbortController>();
  port=port??Number(new URL(config.operatorUrl).port);
  const browserBatches=new BrowserBatchBridge(store,config.dataDir);
  const automation=new AutomationRuntime(config,store,automationDependencies);
  const loginFile=config.bilibili.credentialFile||resolve(config.dataDir,'credentials','bilibili.json');
  const biliLogin=new BilibiliLogin(loginFile);
  const server=createServer(async(req,res)=>{
    const localPort=req.socket.localPort||port;
    const host=req.headers.host;if(![`127.0.0.1:${localPort}`,`localhost:${localPort}`].includes(host||'')){res.writeHead(403);res.end();return;}
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const url=new URL(req.url||'/','http://127.0.0.1:'+localPort);
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try{
      if(await browserBatchHttp(req,res,browserBatches))return;
      if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator.html')));return;}
      if(req.method==='GET'&&url.pathname==='/help/install'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Security-Policy':"default-src 'none'; base-uri 'none'; form-action 'none'"});res.end(readFileSync(resolve(APP_ROOT,'INSTALL.md')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/reading.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-reading.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/login.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-login.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/interest.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-interest.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/library.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-library.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/template.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-template.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/setup.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-setup.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/backup.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-backup.js')));return;}
      if(req.method==='GET'&&url.pathname==='/api/backups'){reply(200,listBackups(config.dataDir));return;}
      if(req.method==='GET'&&url.pathname==='/api/setup/status'){reply(200,setupStatus(config,store.topics()));return;}
      if(req.method==='GET'&&url.pathname==='/api/mail-template'){const template=loadMailTemplate(config.dataDir);reply(200,{configured:!!template,template:template||defaultMailTemplate,emailSent:false});return;}
      if(req.method==='GET'&&url.pathname==='/assets/topics.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-topics.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/digest.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-digest.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/author-handoff.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'author-handoff.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/authors.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-authors.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/browser-batch.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-browser-batch.js')));return;}
      if(req.method==='GET'&&url.pathname==='/api/browser-batch/status'){reply(200,browserBatches.publicStatus());return;}
      if(req.method==='GET'&&url.pathname==='/api/bilibili/login/status'){reply(200,biliLogin.status());return;}
      if(req.method==='GET'&&url.pathname==='/api/bilibili/interest/status'){reply(200,interestStatus(config,store));return;}
      if(req.method==='GET'&&url.pathname==='/preview/archive'){const file=resolve(config.dataDir,'previews','host-preview.html');if(!existsSync(file)){reply(404,{error:'尚无档案预览，请先生成本地档案预览'});return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"});res.end(readFileSync(file));return;}
      if(req.method==='GET'&&url.pathname==='/preview/asr-comparison'){const file=resolve(config.dataDir,'previews','asr-comparison.html');if(!existsSync(file)){reply(404,{error:'尚无语音转写对照样本'});return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"});res.end(readFileSync(file));return;}
      if(req.method==='GET'&&url.pathname==='/preview/bilibili-sample'){const sample=readBilibiliSample(config.dataDir,url.searchParams.get('id')||'');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"});res.end(sample.html);return;}
      if(req.method==='GET'&&url.pathname==='/api/state'){reply(200,{token,operatorIdentity:operatorIdentity(config),...capabilityReport(config,store)});return;}
      if(req.method==='GET'&&url.pathname==='/api/automation'){reply(200,automation.status());return;}
      if(req.method==='GET'&&url.pathname==='/api/automation/draft'){reply(200,draftView(config,store,url.searchParams.get('runId')||''));return;}
      if(req.method==='GET'&&url.pathname==='/assets/automation.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-automation.js')));return;}
      if(req.method==='GET'&&url.pathname==='/assets/outbox.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(readFileSync(resolve(APP_ROOT,'operator-outbox.js')));return;}
      if(req.method==='GET'&&url.pathname==='/preview/automation'){const id=url.searchParams.get('id')||'';if(!/^[a-f0-9]{64}$/.test(id))throw new RadarError('INVALID_INPUT','预览ID无效');const file=resolve(config.dataDir,'automation-previews',id+'.html');if(!existsSync(file))throw new RadarError('NOT_FOUND','预览不存在');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"});res.end(readFileSync(file));return;}
      if(req.method==='GET'&&url.pathname==='/api/archive'){reply(200,{items:store.search(url.searchParams.get('q')||'',{platform:url.searchParams.get('platform')||undefined,authorId:url.searchParams.get('authorId')||undefined,topicId:url.searchParams.get('topicId')||undefined,from:url.searchParams.get('from')||undefined,to:url.searchParams.get('to')||undefined,limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):30}),dateScope:'source publishedAt, [from,to); missing dates excluded when filtering'});return;}
      if(req.method==='GET'&&url.pathname==='/api/library'){reply(200,libraryView(store,{topicId:url.searchParams.get('topicId')||undefined},config.recipient));return;}
      if(req.method==='GET'&&url.pathname==='/api/digest/candidates'){reply(200,digestCandidates(store,{platform:url.searchParams.get('platform')||undefined,topicId:url.searchParams.get('topicId')||undefined},config.recipient));return;}
      if(req.method==='GET'&&url.pathname==='/api/digest/bilibili-preview'){reply(200,renderBilibiliBrief(store,undefined,{template:loadMailTemplate(config.dataDir)}));return;}
      if(req.method==='GET'&&url.pathname==='/preview/bilibili'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"});res.end(renderBilibiliBrief(store,undefined,{template:loadMailTemplate(config.dataDir)}).html);return;}
      if(req.method==='GET'&&url.pathname==='/api/bilibili/author-observations'){reply(200,listAuthorObservations(store,config.dataDir));return;}
      if(req.method==='GET'&&url.pathname==='/api/bilibili/author-queue'){reply(200,authorReadingQueue(store,config.dataDir,requireText(url.searchParams.get('topicId'),'主题ID',100)));return;}
      if(req.method==='GET'&&url.pathname==='/api/quota'){reply(200,store.dailyQuota(url.searchParams.get('date')||latestDue().date));return;}
      if(req.method==='GET'&&url.pathname==='/api/feedback'){reply(200,{feedback:store.feedback()});return;}
      if(req.method==='GET'&&url.pathname==='/api/archive/analysis'){reply(200,archivedAnalysis(store,requireText(url.searchParams.get('key'),'条目ID',300)));return;}
      if(req.method==='GET'&&url.pathname==='/api/evidence'){
        const key=requireText(url.searchParams.get('key'),'条目ID',300);if(!store.item(key))throw new RadarError('NOT_FOUND','条目不存在');
        const all=store.evidence(key),current=new Set(store.currentEvidence(key).map(e=>e.id));
        reply(200,{item:store.item(key),materials:all.map(e=>({id:e.id,kind:e.kind,url:e.url,collectedAt:e.collectedAt,characters:e.text.length,coverage:e.coverage,reading:materialView(store,e.id!).reading,current:current.has(e.id)}))});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/material'){
        reply(200,materialView(store,requireText(url.searchParams.get('id'),'材料ID',200)));return;
      }
      if(req.method==='GET'&&url.pathname==='/api/deliveries'){reply(200,{deliveries:store.deliveries()});return;}
      if(req.method==='GET'&&['/preview/latest','/preview/seven-topics','/preview/sent-sample'].includes(url.pathname)){
        const folder=resolve(config.dataDir,'previews'),specific=url.pathname==='/preview/seven-topics'?'seven-topic-preview.html':url.pathname==='/preview/sent-sample'?'verification-preview.html':null;
        const files=specific?(existsSync(resolve(folder,specific))?[specific]:[]):existsSync(folder)?readdirSync(folder).filter(x=>/^(?:collection-preview|host-preview|verification-preview|seven-topic-preview|\d{4}-\d{2}-\d{2}-\d{4})\.html$/.test(x)).sort((a,b)=>statSync(resolve(folder,a)).mtimeMs-statSync(resolve(folder,b)).mtimeMs):[];
        if(!files.length){reply(404,{error:'尚无邮件预览'});return;}
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"});res.end(readFileSync(resolve(folder,files[files.length-1])));return;
      }
      if(req.method!=='POST'){reply(404,{error:'接口不存在'});return;}
      const origin=req.headers.origin;
      if((origin&&!['http://127.0.0.1:'+localPort,'http://localhost:'+localPort].includes(origin))||req.headers['x-radar-token']!==token){reply(403,{error:'请从本机验证台提交'});return;}
      if(!req.headers['content-type']?.startsWith('application/json')){reply(415,{error:'需要JSON'});return;}
      const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>200000){reply(413,{error:'请求过大'});return;}chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');
      let body:any;try{body=JSON.parse(raw||'{}');}catch{throw new RadarError('INVALID_INPUT','请求JSON格式无效');}if(!body||typeof body!=='object'||Array.isArray(body))throw new RadarError('INVALID_INPUT','需要JSON对象');
      if(url.pathname==='/api/automation/save'){reply(200,automation.save(body.plan,body.expectedRevision));return;}
      if(url.pathname==='/api/automation/draft'){reply(200,draftView(config,store,body.runId));return;}
      if(url.pathname==='/api/automation/mail/prepare'){reply(200,prepareOneOff(config,store,body));return;}
      if(url.pathname==='/api/automation/start'){reply(200,automation.startRun(requireText(body.planId,'计划ID',80)));return;}
      if(url.pathname==='/api/automation/cancel'){reply(200,automation.cancel(requireText(body.runId,'轮次ID',150)));return;}
      if(url.pathname==='/api/automation/next'){reply(200,await automation.next(body.agent,body.waitMs??0,requireText(body.sessionId,'会话ID',120)));return;}
      if(url.pathname==='/api/automation/submit'){reply(200,automation.submit(body));return;}
      if(url.pathname==='/api/automation/mail/claim'){reply(200,automation.claimMail(body));return;}
      if(url.pathname==='/api/automation/mail/report'){reply(200,automation.reportMail(body));return;}
      if(url.pathname==='/api/mail-template'){reply(200,{template:saveMailTemplate(config.dataDir,body),emailSent:false});return;}
      if(url.pathname==='/api/backups/create'){reply(200,createManagedBackup(store,config.dataDir));return;}
      if(url.pathname==='/api/backups/check'){reply(200,rehearseBackup(managedBackupPath(config.dataDir,body.name)));return;}
      if(url.pathname==='/api/archive/preview'){const preview=archivePreview(config,store);reply(200,{...preview,preview:'/preview/archive',scope:'local_archive_only; no platform/model/mail calls'});return;}
      if(url.pathname==='/api/topics'){reply(200,{revision:store.saveTopic(body.topic,body.expectedRevision)});return;}
      if(url.pathname==='/api/browser-batch/create'){reply(200,browserBatches.create(requireText(body.topicId,'主题ID',100),body.itemKeys));return;}
      if(url.pathname==='/api/browser-batch/cancel'){reply(200,browserBatches.cancelFromOperator(requireText(body.batchId,'批次ID',100)));return;}
      if(url.pathname==='/api/topics/discover'){const topic=store.topics().find(t=>t.id===body.topicId);if(!topic)throw new RadarError('TOPIC_REQUIRED','主题未配置');reply(200,await discoverTopic(topic,{github:new GitHubSource(undefined,store),bilibili:new BilibiliSource({credentialFile:config.bilibili.credentialFile||undefined}),xiaohongshuEnabled:config.xiaohongshu.enabled!==false}));return;}
      if(url.pathname==='/api/archive/analyze-cancel'){const key=requireText(body.itemKey,'条目ID',300),active=analyses.get(key);if(active)active.abort();reply(200,{cancelRequested:!!active,itemKey:key,emailSent:false});return;}
      if(url.pathname==='/api/archive/analyze'){
        const key=requireText(body.itemKey,'条目ID',300),topicId=requireText(body.topicId,'主题ID',100);
        if(analyses.has(key))throw new RadarError('ANALYSIS_BUSY','该条内容正在分析，请等待或取消');
        const controller=new AbortController();analyses.set(key,controller);const abort=()=>{if(!res.writableEnded)controller.abort();};res.on('close',abort);
        try{reply(200,await analyzeConfiguredArchive(config,store,topicId,key,controller.signal));}finally{res.off('close',abort);analyses.delete(key);}return;
      }
      if(url.pathname==='/api/feedback/preview'){reply(200,store.addFeedback(body.itemKey,body.topicId,body.kind,body.rule));return;}
      if(url.pathname==='/api/feedback/apply'){reply(200,{topic:store.applyFeedback(body.id,body.revision)});return;}
      if(url.pathname==='/api/feedback/revert'){store.revertFeedback(body.id);reply(200,{reverted:true});return;}
      if(url.pathname==='/api/bilibili/search'){
        const source=new BilibiliSource({credentialFile:config.bilibili.credentialFile||undefined});reply(200,{items:await source.search(requireText(body.keyword,'关键词',200),20,{authorUid:body.authorUid||undefined,page:body.page??1}),scope:'有界关键词候选，可按UID过滤；不等于UP主全部投稿',otherCommentsRead:0});return;
      }
      if(url.pathname==='/api/bilibili/read'){
        const result=await readConfiguredBilibili(config,requireText(body.bvid,'BV号或链接',300),{pages:body.pages,includeDanmaku:body.includeDanmaku,...(body.expectedAuthorUid!==undefined?{expectedAuthorUid:body.expectedAuthorUid}:{})});
        const capture=store.capture(result.item,result.evidence);reply(200,{item:store.item(capture.key),capture,warnings:result.warnings,materials:store.currentEvidence(capture.key).map(e=>({id:e.id,kind:e.kind,characters:e.text.length,coverage:e.coverage})),otherCommentsRead:0});return;
      }
      if(url.pathname==='/api/bilibili/author-read-next'){reply(200,await readNextAuthorItems({store,dataDir:config.dataDir,topicId:requireText(body.topicId,'主题ID',100),limit:body.limit,source:{read:(b,o)=>readConfiguredBilibili(config,b,{...o,includeDanmaku:true})}}));return;}
      if(url.pathname==='/api/bilibili/author-import'){reply(200,importAuthorObservation(store,config.dataDir,body.topicId,body.snapshot));return;}
      if(url.pathname==='/api/bilibili/login/start'){reply(200,await biliLogin.start());return;}
      if(url.pathname==='/api/bilibili/sample'){reply(200,freezeBilibiliSample(store,config.dataDir));return;}
      if(url.pathname==='/api/bilibili/interest/run'){reply(200,await runConfiguredInterest(config,store,requireText(body.topicId,'主题ID',100),body.readLimit));return;}
      if(url.pathname==='/api/bilibili/interest/cancel'){reply(200,cancelInterest());return;}
      if(url.pathname==='/api/bilibili/login/poll'){const result=await biliLogin.poll();if(result.saved)config.bilibili.credentialFile=loginFile;reply(200,result);return;}
      if(url.pathname==='/api/bilibili/login/cancel'){reply(200,biliLogin.cancel());return;}
      if(url.pathname==='/api/bilibili/browser-import'){reply(200,importBrowserSubtitles(store,body));return;}
      if(url.pathname==='/api/probe'){const report=await liveProbe(config,store);writeReport(config,'live-probe.json',report);reply(200,report);return;}
      if(url.pathname==='/api/run'){reply(200,await runConfigured(config,store,body.topicId||'*'));return;}
      if(url.pathname==='/api/deliveries/cancel'){if(typeof body.id!=='string')throw new RadarError('INVALID_INPUT','需要投递ID');const cancelled=store.cancelPrepared(body.id,body.reason);reply(200,{id:cancelled.id,state:cancelled.state,emailSent:false});return;}
      if(url.pathname==='/api/preview'){
        const source=new GitHubSource(undefined,store),warnings=['只读采集预览：未执行AI筛选，未发送邮件。'];let rankings:any[]=[];try{const result=await source.trending();rankings=result.rows;store.rankingSnapshot(result.rows,result.collectedAt);}catch(e){warnings.push((e as Error).message);}
        const digest=renderDigest({batch:latestDue(),entries:[],rankings,warnings}),folder=resolve(config.dataDir,'previews');mkdirSync(folder,{recursive:true});writeFileSync(resolve(folder,'collection-preview.html'),digest.html);reply(200,{preview:'/preview/latest',ranked:rankings.length,actualModelRun:false,emailSent:false,warnings});return;
      }
      reply(404,{error:'接口不存在'});
    }catch(e){const safe=publicError(e);const status=safe.code==='INTERNAL_ERROR'?500:safe.code==='RATE_LIMITED'?429:safe.code==='NOT_FOUND'?404:400;reply(status,{error:safe.message,code:safe.code});}
  });
  let released=false;const release=()=>{if(released)return;released=true;browserBatches.revokeAll();void automation.close().then(()=>store.close());};server.on('close',release);
  try{await new Promise<void>((ready,fail)=>{
    const onError=(error:NodeJS.ErrnoException)=>{server.off('listening',onListening);fail(error);};
    const onListening=()=>{server.off('error',onError);ready();};
    server.once('error',onError);server.once('listening',onListening);server.listen(port,'127.0.0.1');
  });}catch(error){release();if((error as NodeJS.ErrnoException).code==='EADDRINUSE')throw new RadarError('OPERATOR_PORT_IN_USE','验证台端口已占用。请使用已运行的验证台，或停止旧服务后重启；不会自动停止其他进程。');throw new RadarError('OPERATOR_START_FAILED','验证台无法启动，请检查本机端口与运行权限。');}
  config.operatorUrl='http://127.0.0.1:'+(server.address() as any).port;console.log('Local: '+config.operatorUrl+'/');
  automation.start();
  return server;
}
