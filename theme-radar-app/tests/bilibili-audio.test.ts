import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliSource} from '../src/bilibili.ts';

const bvid='BV1234567890',options={expectedAuthorUid:'123',expectedCid:'456'};
function setup(change:{info?:any;playback?:any;response?:()=>Response;controller?:AbortController;abortAt?:'view'|'playback'}={}){
  const calls:{url:string;headers:Headers}[]=[];
  const info={bvid,cid:456,owner:{mid:123},pages:[{page:1,cid:456,duration:90}],...change.info};
  const playback={bvid,cid:456,dash:{audio:[{bandwidth:128000,baseUrl:'https://audio.bilivideo.com/high.m4s?expires=1'},{bandwidth:32000,baseUrl:'https://audio.bilivideo.cn/low.m4s?expires=1'}]},...change.playback};
  const source=new BilibiliSource({fetcher:async(url,init)=>{calls.push({url,headers:new Headers(init?.headers)});const stage=new URL(url).pathname==='/x/web-interface/view'?'view':'playback';if(change.abortAt===stage)change.controller?.abort();return change.response?.()??Response.json({code:0,data:stage==='view'?info:playback});}});
  return{source,calls};
}
test('核对实际BV/作者/P1 CID/时长后，只取正常DASH最低带宽；没有任何CDN请求',async()=>{
  const {source,calls}=setup(),result=await source.audio(bvid,options);assert.deepEqual(result,{bvid,cid:'456',duration:90,audioUrl:'https://audio.bilivideo.cn/low.m4s?expires=1'});
  assert.deepEqual(calls.map(c=>c.url),['https://api.bilibili.com/x/web-interface/view?bvid='+bvid,'https://api.bilibili.com/x/player/playurl?bvid='+bvid+'&cid=456&fnval=16&qn=16&fourk=0']);assert.ok(calls.every(c=>new URL(c.url).hostname==='api.bilibili.com'&&!c.headers.has('cookie')));
});
test('无效BV/UID/CID、外链/非HTTPS/其他P先于任何联网拒绝',async()=>{
  const {source,calls}=setup();
  for(const [video,input]of [['bad',options],[bvid,{...options,expectedAuthorUid:'昵称'}],[bvid,{...options,expectedAuthorUid:'0'}],[bvid,{...options,expectedCid:'0'}],[bvid,{...options,expectedCid:'456.1'}],[bvid,{...options,expectedCid:456}],['https://evil.invalid/video/'+bvid,options],['http://www.bilibili.com/video/'+bvid,options],['https://user:pass@www.bilibili.com/video/'+bvid,options],['https://www.bilibili.com:8080/video/'+bvid,options],['https://www.bilibili.com/video/'+bvid+'?p=2',options],['https://www.bilibili.com/video/'+bvid+'?p=1&p=1',options]] as any[])await assert.rejects(source.audio(video,input));
  assert.equal(calls.length,0);
});
test('正常P1链接与规范化正整数身份可用；仅底层metadata缺pages时使用默认P1',async()=>{
  const one=setup();assert.equal((await one.source.audio('https://www.bilibili.com/video/'+bvid+'/?p=1&trackid=fixture',{expectedAuthorUid:'00123',expectedCid:'00456'})).cid,'456');
  const two=setup({info:{pages:undefined,duration:30}});assert.equal((await two.source.audio(bvid,options)).duration,30);
});
test('实际BV/UID/CID/分P清单不一致，不请求playurl',async()=>{
  for(const [info,code]of [[{bvid:'BV0987654321'},'VIDEO_MISMATCH'],[{bvid:undefined},'VIDEO_MISMATCH'],[{owner:{mid:999}},'AUTHOR_MISMATCH'],[{owner:{mid:Number.MAX_SAFE_INTEGER+1}},'AUTHOR_MISMATCH'],[{cid:999},'SOURCE_CHANGED'],[{pages:[{page:1,cid:999,duration:90}]},'SOURCE_CHANGED'],[{pages:[{page:2,cid:456,duration:90}]},'SOURCE_CHANGED'],[{pages:[{page:1,cid:456,duration:90},{page:1,cid:456,duration:90}]},'SOURCE_CHANGED'],[{pages:[]},'SOURCE_CHANGED']] as const){const{source,calls}=setup({info});await assert.rejects(source.audio(bvid,options),(e:any)=>e.code===code);assert.equal(calls.length,1);}
});
test('未知、错误或超过600秒时长拒绝，600秒边界可用',async()=>{
  for(const duration of [undefined,null,'90',0,-1,601,Infinity,NaN]){const{source,calls}=setup({info:{pages:[{page:1,cid:456,duration}]}});await assert.rejects(source.audio(bvid,options),{code:'ASR_BUDGET'});assert.equal(calls.length,1);}
  assert.equal((await setup({info:{pages:[{page:1,cid:456,duration:600}]}}).source.audio(bvid,options)).duration,600);
});
test('音频响应身份发生变化拒绝，不能读其他视频或CID的地址',async()=>{
  for(const [playback,code]of [[{bvid:'BV0987654321'},'VIDEO_MISMATCH'],[{cid:999},'SOURCE_CHANGED'],[{cid:null},'SOURCE_CHANGED']] as const){const{source,calls}=setup({playback});await assert.rejects(source.audio(bvid,options),(e:any)=>e.code===code);assert.equal(calls.length,2);}
});
test('DASH缺失/异常/无有效带宽不尝试durl、FLAC、备用接口或CDN',async()=>{
  for(const dash of [undefined,null,{audio:[]},{audio:'not array'},{audio:new Array(1001).fill({bandwidth:1,baseUrl:'https://audio.bilivideo.com/a'})},{audio:[{bandwidth:0},{bandwidth:-1},{bandwidth:'32000'},{bandwidth:1.2},{bandwidth:NaN},null]}]){const{source,calls}=setup({playback:{dash,durl:[{url:'https://audio.bilivideo.com/fallback'}],dolby:{audio:[]}}});await assert.rejects(source.audio(bvid,options),{code:'NO_AUDIO'});assert.equal(calls.length,2);}
});
test('非法、非HTTPS、带凭据或非标准端口媒体地址拒绝，不使用backupUrl',async()=>{
  for(const baseUrl of [undefined,'//audio.bilivideo.com/a','http://audio.bilivideo.com/a','https://bilivideo.com.evil.invalid/a','https://evil.invalid/a','https://user:pass@audio.bilivideo.com/a','https://audio.bilivideo.com:8080/a','file:///a','https://127.0.0.1/a']){const{source,calls}=setup({playback:{dash:{audio:[{bandwidth:1,baseUrl,backupUrl:['https://audio.bilivideo.com/backup']} ]}}});await assert.rejects(source.audio(bvid,options),{code:'INVALID_AUDIO_URL'});assert.equal(calls.length,2);}
  for(const base_url of ['https://audio.hdslb.com/a','https://bilivideo.com:443/a','https://bilivideo.cn/a'])assert.ok((await setup({playback:{dash:{audio:[{bandwidth:1,base_url}]}}}).source.audio(bvid,options)).audioUrl.startsWith('https://'));
});
test('认证或访问限制保持错误类型，不重试或降级其他端点',async()=>{
  for(const [response,code]of [[()=>Response.json({code:-101,message:'private'}),'AUTH_REQUIRED'],[()=>Response.json({code:-412,message:'private'}),'ACCESS_DENIED'],[()=>new Response('',{status:412}),'ACCESS_DENIED']] as const){const{source,calls}=setup({response});await assert.rejects(source.audio(bvid,options),(e:any)=>e.code===code&&!String(e).includes('private'));assert.equal(calls.length,1);}
});
test('开始前取消不请求API，任一API结束后取消立即停止后续或返回地址',async()=>{
  const controller=new AbortController();controller.abort();const before=setup();await assert.rejects(before.source.audio(bvid,{...options,signal:controller.signal}),{code:'CANCELLED'});assert.equal(before.calls.length,0);
  for(const abortAt of ['view','playback'] as const){const controller=new AbortController(),{source,calls}=setup({controller,abortAt});await assert.rejects(source.audio(bvid,{...options,signal:controller.signal}),{code:'CANCELLED'});assert.equal(calls.length,abortAt==='view'?1:2);}
});
