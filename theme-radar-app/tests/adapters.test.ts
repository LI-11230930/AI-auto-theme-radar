import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTrending,GitHubSource } from '../src/github.ts';
import { BilibiliSource,XiaohongshuSource,prepareMention } from '../src/social.ts';
import { runProcess,parseResult,materialPrompt,FixtureRunner } from '../src/runner.ts';
import { renderDigest,sendEmail } from '../src/mail.ts';
import { Store } from '../src/store.ts';
import { runGithub } from '../src/engine.ts';
import { batchAt } from '../src/time.ts';
import { item,evidence,topic,trending,mockFetch } from './fixtures.ts';

test('Outlook Agent连接不能被误当作SMTP密码发送通道',async()=>{const store=new Store(':memory:');try{await assert.rejects(()=>sendEmail({runtimeEnabled:true,email:{enabled:true,transport:'agent_outlook'}},store,'none'),/Outlook连接/);assert.equal(store.stats().deliveries,0);}finally{store.close();}});

test('Daily原排名保留，缺失当日Star不能补0',()=>{const ranks=parseTrending(trending);assert.equal(ranks[0].stars,1234);assert.equal(ranks[0].starsToday,56);assert.equal(ranks[1].starsToday,null);assert.equal(ranks[1].rank,2);assert.throws(()=>parseTrending('<html>blocked</html>'));});
test('GitHub读取材料保留取得范围，未宣称模型读完',async()=>{const source=new GitHubSource(mockFetch);const found=await source.search(topic);assert.equal(found.items[0].repo,'sample/tool');const read=await source.read('sample/tool');assert.deepEqual(read.evidence.map(e=>e.kind),['repository-metadata','readme','release','license','source:index.ts']);assert.ok(read.evidence.every(e=>e.coverage.processed===0));assert.equal(read.item.version,'v1');});
test('B站只读适配从不请求他人评论，字幕保持未读',async()=>{const urls:string[]=[];const source=new BilibiliSource({fetcher:async url=>{urls.push(url);if(url.includes('/view?'))return Response.json({code:0,data:{title:'测试',aid:1,cid:2,owner:{mid:3,name:'UP'}}});if(url.includes('/player/'))return Response.json({code:0,data:{subtitle:{subtitles:[{lan:'zh',subtitle_url:'https://i0.hdslb.com/subtitle.json'}]}}});return Response.json({body:[{content:'正文'},{content:'片段'}]});}});const result=await source.read('BV1234567890');assert.ok(urls.every(url=>!url.includes('/reply')&&!url.includes('/comment')));assert.equal(result.evidence[1].text,'正文\n片段');assert.equal(source.capabilities().readOtherComments,false);});
test('小红书桥接只连本地，按内部ID和临时参数分工',async()=>{assert.throws(()=>new XiaohongshuSource('https://example.com'));const source=new XiaohongshuSource('http://127.0.0.1:18060',async()=>Response.json({success:true,data:{note:{note_card:{title:'样例',desc:'笔记',user:{user_id:'1234567890abcdef12345678'},image_list:[{url:'https://example.com/image.png'}]}}}}));await assert.rejects(()=>source.read('1234567890abcdef12345678',''));const note=await source.read('1234567890abcdef12345678','access-hint');assert.equal(note.item.authorId,'1234567890abcdef12345678');assert.equal(note.evidence[1].coverage.acquired,0);assert.equal(note.evidence[1].coverage.state,'unavailable');});
test('B站改邮件后，即使已有执行账号也不再准备评论提及',()=>{for(const binding of [null,{platform:'bilibili',confirmed:true,executorId:'1',recipientId:'2',name:'name'}])assert.throws(()=>prepareMention('bilibili',binding,'bilibili:BV1234567890','推荐'),(e:any)=>e.code==='EMAIL_NOTIFICATION_ONLY');});
test('Runner只接受最终结果，不把进度事件当输出',()=>{const reply={itemKey:item.key,selected:true,reason:'reason',readEvidenceIds:['e'],limitations:[]};assert.deepEqual(parseResult(JSON.stringify(reply)),reply);assert.deepEqual(parseResult(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(reply)}})),reply);assert.throws(()=>parseResult('{"type":"turn.completed"}\n{"type":"turn.failed"}'));assert.throws(()=>parseResult('{"type":"turn.started"}\n{"type":"turn.completed"}'));});
test('材料提示包含不可信边界与截断范围',()=>{const bundle=materialPrompt(topic,item,[{...evidence,id:'e'}],5);assert.equal(bundle.materials[0].truncated,true);assert.ok(bundle.prompt.includes('不可信外部数据'));assert.ok(bundle.prompt.includes('providedCharacters'));});
test('子进程不经shell，中文stdin/输出保持一致',async()=>{const result=await runProcess(process.execPath,['-e',"process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s))"],'中文 & % ! $()',{cwd:tmpdir(),timeoutMs:3000});assert.equal(result.stdout,'中文 & % ! $()');});
test('子进程超时、取消与输出预算',async()=>{await assert.rejects(()=>runProcess(process.execPath,['-e','setTimeout(()=>{},10000)'],'',{cwd:tmpdir(),timeoutMs:50}),/时间预算/);await assert.rejects(()=>runProcess(process.execPath,['-e',"process.stdout.write('x'.repeat(10000))"],'',{cwd:tmpdir(),maxBytes:100}),/输出超出预算/);const signal=AbortSignal.abort();await assert.rejects(()=>runProcess(process.execPath,[], '',{cwd:tmpdir(),signal}),/取消/);});
test('日报合并主题与日榜，连续上榜保留，转义不可信HTML',()=>{const ranked=parseTrending(trending);const assessment={itemKey:item.key,selected:true,reason:'<script>alert(1)</script>',readEvidenceIds:['e'],limitations:['未运行代码'],agent:'fixture',simulation:true};const digest=renderDigest({batch:batchAt('2026-10-19','18:00'),entries:[{item,evidence:[{...evidence,id:'e'}],assessment},{item,evidence:[],assessment}],rankings:ranked,previousRankings:ranked,warnings:[]});assert.ok(digest.simulation);assert.ok(digest.html.includes('GitHub Trending Daily'));assert.ok(digest.html.includes('GitHub Trending Weekly'));assert.ok(!digest.html.includes('此前上榜'));assert.ok(!digest.html.includes('<script>alert'));assert.equal(digest.audit.entries.length,1);});
test('邮件未授权时不启动任何发送进程',async()=>{const store=new Store(':memory:');try{await assert.rejects(()=>sendEmail({runtimeEnabled:false,email:{enabled:false}},store,'none'),/尚未启用/);}finally{store.close();}});

test('联调样张即使发送开关打开也不能走生产发送路径',async()=>{
  const store=new Store(':memory:'),key='THEME_RADAR_TEST_UNUSED_PASSWORD',previous=process.env[key];try{
    process.env[key]='unused-test-data';store.prepareDelivery('sample','email','reader@example.com',JSON.stringify({verification:true}));
    await assert.rejects(()=>sendEmail({runtimeEnabled:true,recipient:'reader@example.com',email:{enabled:true,transport:'smtp',from:'reader@example.com',host:'example.invalid',passwordEnv:key}},store,'sample'),(e:any)=>e.code==='VERIFICATION_ONLY');
    assert.equal(store.delivery('sample').state,'prepared');
  }finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;store.close();}
});

test('简洁正文不混入证据日志，证据与未读限制仍完整留档',()=>{
  const materials=[{...evidence,id:'read',kind:'source:index.ts',coverage:{...evidence.coverage,note:'仅取得20/100字符 <script>bad</script>'}},{...evidence,id:'unread',kind:'license',url:'javascript:alert(1)'}];
  const digest=renderDigest({batch:batchAt('2026-10-19','18:00'),entries:[{item,evidence:materials,assessment:{itemKey:item.key,selected:true,reason:'用途与最小开发想法',readEvidenceIds:['read'],limitations:['源码只读片段'],agent:'test'}}],rankings:[],warnings:[]});
  assert.ok(!digest.text.includes('source:index.ts'));assert.ok(!digest.text.includes('未声明阅读'));assert.ok(!digest.html.includes('条目ID'));assert.ok(!digest.html.includes('仅取得20/100字符'));assert.deepEqual(digest.audit.entries[0].evidence,materials);assert.deepEqual(digest.audit.entries[0].assessment.limitations,['源码只读片段']);assert.ok(!digest.html.includes('<script>bad</script>'));assert.ok(!digest.html.includes('href="javascript:'));
});
test('端到端离线固定样例、租约重跑与隔离存储',async()=>{const root=mkdtempSync(join(tmpdir(),'radar-e2e-')),store=new Store(join(root,'test.sqlite'));try{store.saveTopic(topic);const input={store,source:new GitHubSource(mockFetch),runner:new FixtureRunner(),topicId:topic.id,batch:batchAt('2026-10-19','09:00'),outputDir:root,limit:1};const result=await runGithub({recipient:'reader@example.com',...input});assert.equal(result.state,'prepared');assert.equal((result as any).simulation,true);assert.equal(store.stats().items,1);const again=await runGithub({recipient:'reader@example.com',...input});assert.equal(again.state,'already_claimed_or_completed');assert.equal(store.stats().deliveries,1);}finally{store.close();rmSync(root,{recursive:true,force:true});}});
