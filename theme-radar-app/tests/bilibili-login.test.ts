import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BilibiliLogin} from '../src/bilibili-login.ts';
const key='abcdefghijklmnop1234';
const generated=(url='https://passport.bilibili.com/h5-app/passport/login/scan?foo=1')=>Response.json({code:0,data:{url,qrcode_key:key}});
function setup(t:any,options:{pollCode?:number;navUid?:number;missingCookie?:boolean;url?:string}={}){
 const dir=mkdtempSync(join(tmpdir(),'radar-login-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'bilibili.json');let time=10000;const calls:string[]=[];
 const login=new BilibiliLogin(file,async(url,init)=>{calls.push(url);
  if(url.includes('/generate'))return generated(options.url);
  if(url.includes('/poll')){const headers=new Headers();for(const cookie of ['SESSDATA=fake-secret','bili_jct=fake-csrf',...(options.missingCookie?[]:['DedeUserID=123'])])headers.append('set-cookie',cookie+'; Path=/; Secure; HttpOnly');return Response.json({code:0,data:{code:options.pollCode??0}},{headers});}
  assert.equal(new Headers(init?.headers).get('Cookie')?.includes('fake-secret'),true);return Response.json({code:0,data:{isLogin:true,mid:options.navUid??123}});
 },()=>time);
 return {dir,file,login,calls,advance:(n=4000)=>time+=n};
}
test('扫码后核验UID才保存凭据；公开返回不包含密钥且二维码本地编码',async t=>{
 const x=setup(t);const start=await x.login.start();assert.ok(start.image.startsWith('data:image/svg+xml;base64,'));assert.equal(JSON.stringify(start).includes(key),false);assert.equal(existsSync(x.file),false);
 const result=await x.login.poll();assert.equal(result.saved,true);assert.equal(result.accountUid,'123');assert.equal(JSON.stringify(result).includes('fake-secret'),false);assert.equal(JSON.parse(readFileSync(x.file,'utf8')).sessdata,'fake-secret');assert.deepEqual(readdirSync(x.dir),['bilibili.json']);assert.equal(x.calls.length,3);
 x.advance();assert.equal((await x.login.poll()).saved,true);assert.equal(x.calls.length,3);await assert.rejects(x.login.start(),{code:'CREDENTIAL_EXISTS'});
});
test('等待扫码和手机确认均不写文件且3秒节流',async t=>{for(const pollCode of [86101,86090]){const x=setup(t,{pollCode});await x.login.start();const r=await x.login.poll();assert.equal(r.state,pollCode===86101?'waiting_scan':'waiting_confirm');await assert.rejects(x.login.poll(),{code:'LOGIN_POLL_WAIT'});assert.equal(existsSync(x.file),false);}});
test('过期、取消与平台未知状态不会保存凭据',async t=>{
 const x=setup(t);await x.login.start();x.advance(180000);await assert.rejects(x.login.poll(),{code:'LOGIN_EXPIRED'});assert.equal(x.login.status().state,'expired');x.login.cancel();await assert.rejects(x.login.poll(),{code:'LOGIN_EXPIRED'});
 for(const pollCode of [86038,777]){const y=setup(t,{pollCode});await y.login.start();await assert.rejects(y.login.poll());assert.equal(existsSync(y.file),false);}
});
test('凭据缺失、登录UID不匹配与非B站二维码全部拒绝',async t=>{
 for(const options of [{missingCookie:true},{navUid:456}]){const x=setup(t,options);await x.login.start();await assert.rejects(x.login.poll());assert.equal(existsSync(x.file),false);}
 for(const url of ['https://evil.invalid/h5-app/passport/login/scan','http://passport.bilibili.com/h5-app/passport/login/scan','https://a:b@passport.bilibili.com/h5-app/passport/login/scan']){const x=setup(t,{url});await assert.rejects(x.login.start());assert.equal(existsSync(x.file),false);}
});
test('其他进程新建凭据时不覆盖，临时文件不遗留',async t=>{const x=setup(t);await x.login.start();writeFileSync(x.file,'existing');await assert.rejects(x.login.poll(),{code:'CREDENTIAL_EXISTS'});assert.equal(readFileSync(x.file,'utf8'),'existing');assert.deepEqual(readdirSync(x.dir),['bilibili.json']);});
test('真实平台当前account登录地址可编码，其他路径仍拒绝',async t=>{const x=setup(t,{url:'https://account.bilibili.com/h5/account-h5/auth/scan-web?key=test'});assert.equal((await x.login.start()).state,'waiting_scan');for(const url of ['https://passport.bilibili.com/h5-app/passport/login/scan-other','https://account.bilibili.com/other']){const y=setup(t,{url});await assert.rejects(y.login.start());}});
test('并发登录请求拒绝，失败后可以重新开始',async t=>{
 const x=setup(t);let release:()=>void=()=>{};const wait=new Promise<void>(r=>release=r);const login=new BilibiliLogin(x.file,async()=>{await wait;return generated();});const first=login.start();await assert.rejects(login.start(),{code:'LOGIN_BUSY'});assert.throws(()=>login.cancel(),{code:'LOGIN_BUSY'});release();await first;login.cancel();assert.equal(login.status().state,'idle');
});
