import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliInterestSource} from '../src/interest-source.ts';
import {RadarError} from '../src/model.ts';

const row=(overrides:Record<string,unknown>={})=>({goto:'av',bvid:'BV1234567890',title:'<em>自动化</em> 小工具',owner:{mid:123,name:'示例UP'},pubdate:1760000000,...overrides});
function fixture(item:unknown=[],nav:unknown={isLogin:true,mid:456}){
  const calls:string[]=[];
  const source=new BilibiliInterestSource({api:async(path:string)=>{calls.push(path);return path==='/x/web-interface/nav'?nav:{item};}});
  return {source,calls};
}

test('兴趣候选先核对登录再固定请求一页，默认12条，不回传上游私密字段',async()=>{
  const {source,calls}=fixture([row({uri:'https://advertisement.invalid',track_id:'private',rcmd_reason:{content:'private reason'},owner:{mid:123,name:'<b>示例UP</b>',face:'private'},user_history:'private'})]);
  const result=await source.recommendations();
  assert.deepEqual(calls,['/x/web-interface/nav','/x/web-interface/wbi/index/top/feed/rcmd?fresh_type=4&ps=12&fresh_idx=1']);
  assert.deepEqual(result.items,[{bvid:'BV1234567890',title:'自动化 小工具',author:'示例UP',authorId:'123',publishedAt:new Date(1760000000*1000).toISOString(),source:'recommendation'}]);
  assert.equal(result.excluded,0);assert.equal(result.authenticated,true);assert.match(result.scope,/一次有界快照/);
  assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(JSON.stringify(result).includes('advertisement.invalid'),false);
});
test('预算先于联网校验，页数固定，不自动刷新以凑满候选',async()=>{
  const {source,calls}=fixture([]);for(const limit of [0,-1,21,1.2,NaN,Infinity,'12',null])await assert.rejects(source.recommendations(limit as any),(error:any)=>error.code==='INVALID_BUDGET');
  assert.equal(calls.length,0);assert.deepEqual((await source.recommendations(20)).items,[]);assert.equal(calls.length,2);assert.ok(calls[1].includes('ps=20'));
});
test('未登录、非布尔登录标记或登录核对失败只请求nav，错误不回显凭证',async()=>{
  for(const nav of [null,{}, {isLogin:false,mid:456},{isLogin:1,mid:456},{isLogin:'true',mid:456},{isLogin:true},{isLogin:true,mid:0},{isLogin:true,mid:'昵称'}]){
    const {source,calls}=fixture([row()],nav);await assert.rejects(source.recommendations(),(error:any)=>error.code==='AUTH_REQUIRED');assert.deepEqual(calls,['/x/web-interface/nav']);
  }
  let calls=0;const source=new BilibiliInterestSource({api:async()=>{calls++;throw new Error('secret upstream');}});
  await assert.rejects(source.recommendations(),(error:any)=>error.code==='LOGIN_CHECK_FAILED'&&!String(error).includes('secret'));assert.equal(calls,1);
});
test('登录核验网络失败保留访问限制类别，不误报账号已退出或请求推荐',async()=>{
  let calls=0;const source=new BilibiliInterestSource({api:async()=>{calls++;throw new RadarError('ACCESS_DENIED','private upstream detail');}});
  await assert.rejects(source.recommendations(),(error:any)=>error.code==='ACCESS_DENIED'&&!String(error).includes('private'));assert.equal(calls,1);
});
test('广告及含未知商业元数据的候选保守排除，直播番剧和外链不得进入',async()=>{
  const excluded=[row({is_ad:true}),row({is_ad:1}),row({is_ad:'0'}),row({ad_info:{url:'https://ad.invalid'}}),row({ad_info:{}}),row({business_info:{is_ad:1}}),row({business_info:{unknown:'label'}}),row({goto:'live'}),row({goto:'bangumi'}),row({goto:'article'}),row({bvid:'https://www.bilibili.com/video/BV1234567890'})];
  const {source}=fixture([...excluded,row({is_ad:false,ad_info:null,business_info:null})]);const result=await source.recommendations();assert.equal(result.items.length,1);assert.equal(result.excluded,excluded.length);
});
test('坏单条跳过并计数，BV/UID/文本严格验证且不影响其余有效候选',async()=>{
  const rejected=[null,[],false,row({bvid:'BV!!34567890'}),row({owner:{mid:0,name:'UP'}}),row({owner:{mid:-1,name:'UP'}}),row({owner:{mid:1.2,name:'UP'}}),row({owner:{mid:Number.MAX_SAFE_INTEGER+1,name:'UP'}}),row({owner:{mid:'0',name:'UP'}}),row({owner:{mid:'昵称',name:'UP'}}),row({owner:{mid:'123456789012345678901',name:'UP'}}),row({owner:{mid:1,name:'a'.repeat(1001)}}),row({title:'a'.repeat(501)}),row({title:'<script>not content</script>'}),row({title:123}),row({owner:{mid:1,name:123}})];
  const result=await fixture([...rejected,row({owner:{mid:'0001111111111111111',name:'UP'}})]).source.recommendations();
  assert.equal(result.excluded,rejected.length);assert.equal(result.items[0].authorId,'1111111111111111');
});
test('未知或错误发布日期保留null，不能补零日期，整数秒才转ISO',async()=>{
  for(const pubdate of [undefined,null,0,-1,NaN,Infinity,1.5,'1760000000',Number.MAX_SAFE_INTEGER]){
    const result=await fixture([row({pubdate})]).source.recommendations();assert.equal(result.items.length,1);assert.equal(result.items[0].publishedAt,null);
  }
});
test('重复与超预算候选不重复消费且计excluded，无第二页补取',async()=>{
  const {source,calls}=fixture([row(),row(),row({bvid:'BV0987654321'}),row({bvid:'BV1234567891'})]);const result=await source.recommendations(2);
  assert.equal(result.items.length,2);assert.equal(result.excluded,2);assert.equal(new Set(result.items.map(item=>item.bvid)).size,2);assert.equal(calls.length,2);
});
test('列表格式错误或超过1000条拒绝整页，空数组合法且上游失败不冒充空列表',async()=>{
  for(const item of [null,{},'bad',new Array(1001).fill(row())])await assert.rejects(fixture(item).source.recommendations(),(error:any)=>error.code==='INVALID_RESPONSE');
  assert.equal((await fixture([]).source.recommendations()).excluded,0);
  let calls=0;const source=new BilibiliInterestSource({api:async()=>{calls++;if(calls===1)return {isLogin:true,mid:456};throw Object.assign(new Error('limited'),{code:'ACCESS_DENIED'});}});
  await assert.rejects(source.recommendations(),(error:any)=>error.code==='ACCESS_DENIED');assert.equal(calls,2);
});
test('上游提供账号标记时必须匹配nav账号，匿名/其他账号/异常UID拒绝整页',async()=>{
  for(const mid of [0,123,'0',null,'bad',Number.MAX_SAFE_INTEGER+1]){
    let calls=0;const source=new BilibiliInterestSource({api:async()=>{calls++;return calls===1?{isLogin:true,mid:456}:{mid,item:[row()]};}});
    await assert.rejects(source.recommendations(),(error:any)=>error.code==='ACCOUNT_MISMATCH');assert.equal(calls,2);
  }
  let calls=0;const source=new BilibiliInterestSource({api:async()=>++calls===1?{isLogin:true,mid:'00456'}:{mid:456,item:[row()]}});
  assert.equal((await source.recommendations()).items.length,1);
});
