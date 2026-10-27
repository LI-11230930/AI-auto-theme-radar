import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliSource} from '../src/bilibili.ts';
import {Store} from '../src/store.ts';
import {digestCandidates,notificationPlan} from '../src/digest-candidates.ts';
import {discoverTopic} from '../src/discovery.ts';
import {RadarError,validateTopic} from '../src/model.ts';
import {sendEmail} from '../src/mail.ts';
import {startOperator} from '../src/operator.ts';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {topic,item,evidence} from './fixtures.ts';
const subscribed={...topic,id:'bili',platforms:['bilibili'] as any,bilibiliAuthors:['123','456'],bilibiliDiscovery:'authors' as const};
const video={...item,key:'bilibili:BV1234567890',externalId:'BV1234567890',platform:'bilibili' as const,authorId:'123'};
const init=()=>{const s=new Store(':memory:');s.saveTopic(subscribed);s.capture(video,[{...evidence,itemKey:video.key}]);return s;};
const navResponse=()=>Response.json({code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+ 'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}});
const answer=(s:Store)=>({itemKey:video.key,selected:true,reason:'fixture',readEvidenceIds:[s.currentEvidence(video.key)[0].id!],limitations:[],agent:'test',simulation:false});

test('投稿页按精确UID绑定并有界读取，不把昵称/列表总数当作完整读取',async()=>{
 const requests:string[]=[];const source=new BilibiliSource({fetcher:async url=>{requests.push(url);if(url.includes('/nav'))return navResponse();return Response.json({code:0,data:{page:{count:200},list:{vlist:[{mid:123,bvid:'BV1234567890',title:'<em>AI</em>',author:'可改昵称',created:1792587600}]}}});}});
 const result=await source.authorVideos('123',{limit:10});assert.equal(result.items[0].title,'AI');assert.equal(result.items[0].authorId,'123');assert.equal(result.totalReported,200);assert.equal(result.exhaustive,false);const u=new URL(requests.find(u=>u.includes('/space/wbi/'))!);assert.equal(u.searchParams.get('mid'),'123');assert.equal(u.searchParams.get('ps'),'10');assert.ok(requests.every(u=>!u.includes('comment')&&!u.includes('reply')));
 for(const opts of [{limit:21},{page:3},{page:0}])await assert.rejects(source.authorVideos('123',opts));await assert.rejects(source.authorVideos('昵称'));
});
test('作者不符、缺列表及访问受限不能伪装成没有投稿',async()=>{
 for(const payload of [{code:0,data:{list:{vlist:[{mid:456,bvid:'BV1234567890',title:'wrong'}]}}},{code:0,data:{list:{}}},{code:-412}]){const s=new BilibiliSource({fetcher:async url=>url.includes('/nav')?navResponse():Response.json(payload)});await assert.rejects(s.authorVideos('123'));}
 const empty=new BilibiliSource({fetcher:async url=>url.includes('/nav')?navResponse():Response.json({code:0,data:{list:{vlist:[]},page:{count:0}}})});assert.equal((await empty.authorVideos('123')).items.length,0);
});
test('作者发现分配双UID预算，不按关键词漏掉投稿；后一个失败保留已取得内容',async()=>{
 const calls:any[]=[];const source:any={search:async()=>{throw Error('should not search');},authorVideos:async(uid,options)=>{calls.push([uid,options]);if(uid==='456')throw new RadarError('ACCESS_DENIED','受限');return {authorId:uid,items:[{bvid:'BV1234567890',authorId:uid,title:'不含关键词的投稿',publishedAt:null}]};}};
 const r=await discoverTopic(subscribed,{github:{} as any,bilibili:source,xiaohongshuEnabled:false});assert.deepEqual(calls.map(c=>c[0]),['123','456']);assert.equal(calls[0][1].limit,10);assert.equal(r.candidates.length,1);assert.equal(r.sources[0].state,'partial');assert.equal(r.sources[0].failures[0].authorUid,'456');assert.equal(r.exhaustive,false);assert.equal(r.emailSent,false);
 assert.throws(()=>validateTopic({...subscribed,bilibiliAuthors:[]}));assert.throws(()=>validateTopic({...subscribed,bilibiliDiscovery:'invalid' as any}));
});
test('作者适配器缺失时不回退全站关键词，也拒绝冒充指定作者的数据',async()=>{
 let searched=false;const source:any={search:async()=>{searched=true;return [];}};const r=await discoverTopic(subscribed,{github:{} as any,bilibili:source,xiaohongshuEnabled:false});assert.equal(r.sources[0].code,'AUTHOR_SOURCE_REQUIRED');assert.equal(searched,false);
 source.authorVideos=async()=>({authorId:'999',items:[]});const wrong=await discoverTopic(subscribed,{github:{} as any,bilibili:source,xiaohongshuEnabled:false});assert.equal(wrong.sources[0].failures[0].code,'AUTHOR_MISMATCH');assert.equal(wrong.candidates.length,0);
});
test('待汇总数据按平台、作者和当前非模拟主题判断过滤，不建outbox或改变订阅',()=>{
 const s=init();try{assert.equal(digestCandidates(s).rows[0].state,'awaiting_analysis');s.saveAssessment(subscribed.id,answer(s));const r=digestCandidates(s);assert.equal(r.rows[0].state,'candidate');assert.equal(r.formatStatus,'confirmed');assert.equal(r.emailSent,false);assert.equal(s.deliveries().length,0);assert.equal(s.topics()[0].revision,1);
 s.capture({...video,authorId:'999'},[{...evidence,itemKey:video.key}]);assert.equal(digestCandidates(s).rows.length,0);assert.throws(()=>digestCandidates(s,{platform:'xiaohongshu'}));assert.throws(()=>digestCandidates(s,{topicId:'missing'}));}finally{s.close();}
});
test('旧主题/材料和模拟结果不能混入正式候选，不选中与未分析分开',()=>{
 const s=init();try{s.saveAssessment(subscribed.id,{...answer(s),simulation:true});assert.equal(digestCandidates(s).rows[0].state,'awaiting_analysis');s.saveAssessment(subscribed.id,{...answer(s),selected:false});assert.equal(digestCandidates(s).rows[0].state,'not_selected');s.saveTopic({...subscribed,name:'changed'},1);assert.equal(digestCandidates(s).rows[0].state,'awaiting_analysis');s.saveAssessment(subscribed.id,answer(s));s.capture(video,[{...evidence,itemKey:video.key,text:'changed'}]);assert.equal(digestCandidates(s).rows[0].state,'awaiting_analysis');}finally{s.close();}
});
test('邮件格式待定时不能领取发送权，统一渠道政策不授权新调度',async()=>{
 const s=new Store(':memory:');try{await assert.rejects(sendEmail({runtimeEnabled:true,email:{enabled:true,transport:'smtp',formatStatus:'awaiting_user'}},s,'any'),(e:any)=>e.code==='EMAIL_FORMAT_PENDING');assert.equal(s.deliveries().length,0);const p=notificationPlan();assert.equal(p.bilibili,'email');assert.equal(p.github,'email');assert.equal(p.commentMentionEnabled,false);assert.equal(p.deliveryEnabled,false);}finally{s.close();}
});
test('网页只读待汇总接口与渠道计划可用，作者主题保存仍有同源保护',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-bili-email-http-')),previous=process.env.THEME_RADAR_CONFIG;let server;
 try{const config=resolve(dir,'config.json'),data=resolve(dir,'data');writeFileSync(config,JSON.stringify({dataDir:data,topics:[subscribed]}));process.env.THEME_RADAR_CONFIG=config;const s=new Store(resolve(data,'radar.sqlite'));s.saveTopic(subscribed);s.capture(video,[{...evidence,itemKey:video.key}]);s.close();server=await startOperator(0);if(!server.listening)await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port,state=await(await fetch(base+'/api/state')).json() as any;assert.equal(state.notificationPlan.bilibili,'email');assert.equal(state.notificationPlan.emailFormat.state,'default_template_available');const r=await fetch(base+'/api/digest/candidates?platform=bilibili'),d=await r.json() as any;assert.equal(r.status,200);assert.equal(d.rows.length,1);assert.equal(d.rows[0].state,'awaiting_analysis');assert.equal((await fetch(base+'/assets/digest.js')).status,200);assert.equal((await fetch(base+'/api/digest/candidates?platform=bad')).status,400);assert.equal((await fetch(base+'/api/topics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:subscribed})})).status,403);const final=new Store(resolve(data,'radar.sqlite'));assert.equal(final.deliveries().length,0);final.close();
 }finally{if(server)await new Promise<void>(r=>server.close(()=>r()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;rmSync(dir,{recursive:true,force:true});}
});
