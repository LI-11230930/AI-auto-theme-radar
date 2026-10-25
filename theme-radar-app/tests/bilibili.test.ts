import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliSource,subtitleUrl} from '../src/bilibili.ts';
import {parseSubtitle} from '../src/transcript.ts';
import {Store} from '../src/store.ts';
import {startOperator} from '../src/operator.ts';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {topic} from './fixtures.ts';
const bvid='BV1234567890';
const info={bvid,title:'多分P测试',aid:1,cid:11,owner:{mid:99,name:'测试UP'},pages:[{page:1,cid:11,duration:20},{page:2,cid:22,duration:30},{page:3,cid:33,duration:40},{page:4,cid:44,duration:50}]};
const make=(options:{empty?:number;fail?:number;wrongCid?:boolean;foreignUrl?:boolean}={})=>{const urls:string[]=[];const source=new BilibiliSource({fetcher:async(url,init)=>{
  urls.push(url);const u=new URL(url);
  if(u.pathname==='/x/web-interface/view')return Response.json({code:0,data:{...info,comments:[{text:'他人评论不得进入档案'}]}});
  if(u.pathname==='/x/player/wbi/v2'){const cid=Number(u.searchParams.get('cid'));if(cid===options.fail)return Response.json({code:-101,message:'should not echo private upstream text'});return Response.json({code:0,data:{cid:options.wrongCid?999:cid,subtitle:{subtitles:cid===options.empty?[]:[{lan:'zh',subtitle_url:options.foreignUrl?'https://evil.invalid/text':'https://i0.hdslb.com/'+cid+'.json'}]}}});}
  assert.equal(new Headers(init?.headers).has('cookie'),false);return Response.json({body:[{from:0,to:3,content:'片段一'},{from:4,to:7,content:'片段二'}]});
}});return {source,urls};};

test('字幕时间轴保留分段并合并重叠时长，取得不等于已读',()=>{
  const r=parseSubtitle({body:[{from:1,to:4,content:'一'},{from:3,to:6,content:'二'},{from:9,to:10,content:'三'}]});assert.equal(r.text,'一\n二\n三');assert.equal(r.coveredSeconds,6);assert.equal(r.lastTimestamp,10);assert.equal(r.acquiredSegments,3);assert.equal(r.truncated,false);
});
test('字幕按字符/分段双预算截断，空分段与无时间戳单列',()=>{
  const r=parseSubtitle({body:[{content:' '},{content:'一'},{content:'二'},{content:'三'}]},{maxCharacters:3,maxSegments:2});assert.equal(r.text,'一\n二');assert.equal(r.expectedSegments,4);assert.equal(r.acquiredSegments,2);assert.equal(r.emptySegments,1);assert.equal(r.timingUnknown,2);assert.equal(r.truncated,true);
  assert.equal(parseSubtitle({body:[]}).acquiredSegments,0);
});
test('错误时间轴、跨分P时长及格式拒绝，不丢弃错误后冒充整片',()=>{
  for(const body of [[{from:3,to:1,content:'错'}],[{from:-1,to:3,content:'错'}],[{from:1,content:'错'}],[{content:15}],null])assert.throws(()=>parseSubtitle({body}),/字幕/);
  assert.throws(()=>parseSubtitle({body:[{from:0,to:40,content:'错'}]},{duration:20}),/超出/);
});
test('字幕来源不接受凭据、外部域、HTTP和非标准端口',()=>{
  for(const url of ['http://i0.hdslb.com/a','https://hdslb.com.evil.invalid/a','https://user:pass@i0.hdslb.com/a','https://i0.hdslb.com:8080/a','file:///a'])assert.throws(()=>subtitleUrl(url));
  assert.equal(subtitleUrl('//i0.hdslb.com/a'),'https://i0.hdslb.com/a');
});
test('默认最多3个分P，保存独立时间轴与覆盖清单且不读取评论',async()=>{
  const {source,urls}=make(),r=await source.read(bvid);assert.deepEqual(r.item.metadata.requestedPages,[1,2,3]);assert.equal(r.item.metadata.pageCount,4);assert.ok(r.warnings.some(w=>w.includes('3/4')));
  assert.deepEqual(r.evidence.filter(e=>e.kind.startsWith('subtitle:')).map(e=>e.kind),['subtitle:p1','subtitle:p2','subtitle:p3']);
  assert.equal(r.evidence.filter(e=>e.kind.startsWith('subtitle-timeline')).length,3);assert.ok(r.evidence.every(e=>e.coverage.processed===0));assert.ok(urls.every(u=>!u.includes('/reply')&&!u.includes('/comment')&&!u.includes('/playurl')));
  assert.equal(JSON.stringify(r).includes('他人评论不得进入档案'),false);assert.equal(r.item.metadata.audioRead,false);assert.equal(r.item.metadata.visionRead,false);
});
test('链接p参数及显式分P选择准确使用相应CID，不把第一页当整片',async()=>{
  const one=make();const r=await one.source.read('https://www.bilibili.com/video/'+bvid+'?p=2');assert.deepEqual(r.item.metadata.requestedPages,[2]);assert.ok(one.urls.some(u=>u.includes('cid=22')));assert.ok(!one.urls.some(u=>u.includes('cid=11')));
  const two=make();assert.deepEqual((await two.source.read(bvid,{pages:[3,3]})).item.metadata.requestedPages,[3]);
});
test('非法分P在联网前拒绝，不存在的分P不请求任何字幕',async()=>{
  const {source,urls}=make();for(const pages of [[],[0],[-1],[1,2,3,4],['2'],[1.5]])await assert.rejects(()=>source.read(bvid,{pages:pages as any}));assert.equal(urls.length,0);
  await assert.rejects(()=>source.read(bvid,{pages:[9]}));assert.equal(urls.length,1);
});
test('一分P认证失败保留其他分P，错误不回显上游正文',async()=>{
  const {source}=make({fail:22}),r=await source.read(bvid,{pages:[1,2]});assert.ok(r.evidence.some(e=>e.kind==='subtitle:p1'));assert.ok(!r.evidence.some(e=>e.kind==='subtitle:p2'));assert.equal((r.item.metadata.subtitlePages as any[])[1].reason,'AUTH_REQUIRED');assert.equal(JSON.stringify(r).includes('should not echo'),false);
});
test('字幕轨空不等于视频没有字幕，未启用ASR与画面明确保留',async()=>{
  const {source}=make({empty:11}),r=await source.read(bvid,{pages:[1]});assert.ok(r.warnings.some(w=>w.includes('不能据此断言')));assert.equal((r.item.metadata.subtitlePages as any[])[0].state,'unavailable');assert.ok(!r.evidence.some(e=>e.kind==='subtitle:p1'));
});
test('错误CID或外部字幕地址不形成有效字幕材料',async()=>{
  for(const opts of [{wrongCid:true},{foreignUrl:true}]){const {source,urls}=make(opts),r=await source.read(bvid,{pages:[1]});assert.equal((r.item.metadata.subtitlePages as any[])[0].state,'failed');assert.ok(!r.evidence.some(e=>e.kind==='subtitle:p1'));assert.ok(!urls.some(u=>u.includes('evil.invalid')));}
});
test('作者按UID过滤同名候选，错误UID与预算在联网前拒绝',async()=>{
  let calls=0;const source=new BilibiliSource({fetcher:async()=>{calls++;return Response.json({code:0,data:{result:[{bvid,title:'同名一',author:'同名UP',mid:99,pubdate:1},{bvid:'BV0987654321',title:'同名二',author:'同名UP',mid:100,pubdate:1}]}});}});
  const r=await source.search('主题',20,{authorUid:'00099'});assert.equal(r.length,1);assert.equal(r[0].authorId,'99');assert.ok(r[0].scope?.includes('非该UP主全部投稿'));
  for(const authorUid of ['同名UP','0','https://space.bilibili.com/99'])await assert.rejects(()=>source.search('主题',20,{authorUid}));await assert.rejects(()=>source.search('主题',20,{page:6}));assert.equal(calls,1);
});
test('当前材料集与历史档案分离，不能引用旧字幕或范围清单冒充阅读',async()=>{
  const {source}=make(),r=await source.read(bvid,{pages:[1]}),store=new Store(':memory:');try{
    store.saveTopic(topic);const first=store.capture(r.item,r.evidence),old=store.currentEvidence(r.item.key).find(e=>e.kind==='subtitle:p1')!;
    const next=await source.read(bvid,{pages:[2]});store.capture(next.item,next.evidence);
    assert.ok(store.evidence(r.item.key).some(e=>e.id===old.id));assert.ok(!store.currentEvidence(r.item.key).some(e=>e.id===old.id));assert.equal(store.material(old.id!)?.text,old.text);
    const assessment={itemKey:r.item.key,selected:true,reason:'测试',readEvidenceIds:[old.id!],limitations:[],agent:'fixture'};
    assert.throws(()=>store.saveAssessment(topic.id,assessment),/引用/);
    const manifest=store.currentEvidence(r.item.key).find(e=>e.kind==='video-reading-manifest')!;assert.throws(()=>store.saveAssessment(topic.id,{...assessment,readEvidenceIds:[manifest.id!]}),/引用/);
    const current=store.currentEvidence(r.item.key).find(e=>e.kind==='subtitle:p2')!;assert.ok(store.saveAssessment(topic.id,{...assessment,readEvidenceIds:[current.id!]}));assert.notEqual(first.fingerprint,store.fingerprint(r.item.key));
  }finally{store.close();}
});
test('验证台能查询材料与当前/历史范围，真实读取写归档但没有发送动作',async()=>{
  const dir=mkdtempSync(resolve(tmpdir(),'radar-bili-ui-')),previous=process.env.THEME_RADAR_CONFIG,original=BilibiliSource.prototype.read;let server;
  try{
    const source=make().source;const collected=await original.call(source,bvid,{pages:[2]});BilibiliSource.prototype.read=async()=>collected;
    const file=resolve(dir,'config.json');writeFileSync(file,JSON.stringify({dataDir:resolve(dir,'data')}));process.env.THEME_RADAR_CONFIG=file;
    server=await startOperator(0);if(!server.listening)await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port;
    const asset=await fetch(base+'/assets/reading.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type')||'',/javascript/);assert.match(await asset.text(),/material-form/);
    const html=await (await fetch(base+'/')).text();assert.match(html,/id="bilibili-reading"/);assert.match(html,/\/assets\/reading\.js/);
    assert.equal((await fetch(base+'/assets/config.local.json')).status,404);
    const state=await (await fetch(base+'/api/state')).json() as any,headers={'Content-Type':'application/json','X-Radar-Token':state.token};
    assert.equal((await fetch(base+'/api/bilibili/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bvid})})).status,403);
    const read=await fetch(base+'/api/bilibili/read',{method:'POST',headers,body:JSON.stringify({bvid})});assert.equal(read.status,200);
    const evidence=await (await fetch(base+'/api/evidence?key='+encodeURIComponent('bilibili:'+bvid))).json() as any;assert.ok(evidence.materials.every(e=>e.current));
    const id=evidence.materials.find(e=>e.kind==='subtitle:p2').id;const material=await (await fetch(base+'/api/material?id='+id)).json() as any;assert.equal(material.text,'片段一\n片段二');
    assert.equal((await fetch(base+'/api/material?id=missing')).status,404);assert.equal((await fetch(base+'/api/bilibili/send',{method:'POST',headers,body:'{}'})).status,404);
  }finally{BilibiliSource.prototype.read=original;if(server)await new Promise<void>(r=>server.close(()=>r()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;rmSync(dir,{recursive:true,force:true});}
});
test('B站HTTP412归为访问限制，不冒充空搜索或无字幕，不自动重试',async()=>{
 let calls=0;const source=new BilibiliSource({fetcher:async()=>{calls++;return new Response('',{status:412});}});
 await assert.rejects(source.search('fixture'),(e:any)=>e.code==='ACCESS_DENIED'&&e.details.upstreamStatus===412);assert.equal(calls,1);
});
