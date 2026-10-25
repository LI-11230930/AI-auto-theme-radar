import {existsSync,mkdirSync,writeFileSync,linkSync,unlinkSync,lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from './http.ts';
import type {Fetcher} from './http.ts';
import {RadarError} from './model.ts';
const qr=createRequire(import.meta.url)('../vendor/qrcode-generator/qrcode.cjs');
const passport='https://passport.bilibili.com/x/passport-login/web/qrcode/';
export class BilibiliLogin {
  private session:{key:string;expires:number;nextPoll:number;state:string}|null=null;
  private busy=false;
  private file:string;private fetcher?:Fetcher;private clock:()=>number;
  constructor(file:string,fetcher?:Fetcher,clock=Date.now){this.file=file;this.fetcher=fetcher;this.clock=clock;}
  status(){return {credentialConfigured:existsSync(this.file),state:this.session?(this.session.state==='saved'?'saved':this.clock()>=this.session.expires?'expired':this.session.state):'idle',emailSent:false};}
  cancel(){if(this.busy)throw new RadarError('LOGIN_BUSY','登录请求正在完成，请稍后取消');this.session=null;return this.status();}
  private async exclusive<T>(fn:()=>Promise<T>){if(this.busy)throw new RadarError('LOGIN_BUSY','登录请求正在完成');this.busy=true;try{return await fn();}finally{this.busy=false;}}
  async start(){return this.exclusive(async()=>{
    if(existsSync(this.file))throw new RadarError('CREDENTIAL_EXISTS','已有凭据，先使用现有连接；未覆盖');
    this.session=null;
    const response=await request(passport+'generate',{fetcher:this.fetcher,maxBytes:20000});
    let result:any;try{result=JSON.parse(response.text);}catch{throw new RadarError('INVALID_RESPONSE','登录接口返回格式无效');}
    const data=result?.data;
    if(result.code!==0||typeof data?.qrcode_key!=='string'||!/^[a-zA-Z0-9_-]{16,256}$/.test(data.qrcode_key)||typeof data.url!=='string'||data.url.length>2000)throw new RadarError('INVALID_RESPONSE','未取得有效登录二维码');
    let link:URL;try{link=new URL(data.url);}catch{throw new RadarError('INVALID_RESPONSE','登录二维码地址无效');}
    const expected=(link.hostname==='passport.bilibili.com'&&link.pathname==='/h5-app/passport/login/scan')||(link.hostname==='account.bilibili.com'&&link.pathname==='/h5/account-h5/auth/scan-web');
    if(link.protocol!=='https:'||!expected||link.username||link.password||link.port)throw new RadarError('INVALID_RESPONSE','登录二维码不是预期的B站登录地址');
    const code=qr(0,'M');code.addData(data.url);code.make();
    this.session={key:data.qrcode_key,expires:this.clock()+180000,nextPoll:0,state:'waiting_scan'};
    return {...this.status(),expiresAt:new Date(this.session.expires).toISOString(),image:'data:image/svg+xml;base64,'+Buffer.from(code.createSvgTag(5,20)).toString('base64')};
  });}
  async poll(){return this.exclusive(async()=>{
    const session=this.session;
    if(!session||this.clock()>=session.expires)throw new RadarError('LOGIN_EXPIRED','二维码已失效，请重新生成');
    if(session.state==='saved')return {...this.status(),saved:true};
    if(this.clock()<session.nextPoll)throw new RadarError('LOGIN_POLL_WAIT','请等待3秒后检查登录');
    session.nextPoll=this.clock()+3000;
    const response=await request(passport+'poll?qrcode_key='+encodeURIComponent(session.key),{fetcher:this.fetcher,maxBytes:20000});
    let result:any;try{result=JSON.parse(response.text);}catch{throw new RadarError('INVALID_RESPONSE','登录状态返回格式无效');}
    if(result.code!==0)throw new RadarError('LOGIN_FAILED','登录状态查询失败');
    const code=result.data?.code;
    if(code===86101||code===86090){session.state=code===86101?'waiting_scan':'waiting_confirm';return this.status();}
    if(code===86038){session.expires=0;throw new RadarError('LOGIN_EXPIRED','二维码已过期，请重新生成');}
    if(code!==0)throw new RadarError('LOGIN_FAILED','平台未确认本次登录');
    const cookies:Record<string,string>={};
    for(const line of response.headers.getSetCookie()){
      const [pair]=line.split(';'),index=pair.indexOf('='),name=pair.slice(0,index),value=pair.slice(index+1);
      if(['SESSDATA','bili_jct','DedeUserID','buvid3'].includes(name)){
        if(name in cookies||!value||value.length>4096||/[\r\n;]/.test(value))throw new RadarError('CREDENTIAL_INVALID','登录凭据字段无效');cookies[name]=value;
      }
    }
    if(!cookies.SESSDATA||!cookies.bili_jct||!/^\d{1,20}$/.test(cookies.DedeUserID||''))throw new RadarError('CREDENTIAL_INVALID','平台没有返回完整登录凭据；未保存');
    const auth=await request('https://api.bilibili.com/x/web-interface/nav',{fetcher:this.fetcher,maxBytes:50000,headers:{Referer:'https://www.bilibili.com/',Cookie:Object.entries(cookies).map(([k,v])=>k+'='+v).join('; ')}});
    let account:any;try{account=JSON.parse(auth.text);}catch{throw new RadarError('INVALID_RESPONSE','账户核验返回格式无效');}
    if(account.code!==0||account.data?.isLogin!==true||String(account.data.mid)!==cookies.DedeUserID)throw new RadarError('AUTH_REQUIRED','扫码后的账户核验未通过；未保存');
    if(this.clock()>=session.expires)throw new RadarError('LOGIN_EXPIRED','账户核验期间二维码已过期；未保存');
    const folder=dirname(this.file);mkdirSync(folder,{recursive:true,mode:0o700});
    if(lstatSync(folder).isSymbolicLink()||existsSync(this.file))throw new RadarError('CREDENTIAL_EXISTS','凭据目录或文件状态发生改变；未覆盖');
    const tmp=this.file+'.'+randomUUID()+'.tmp';
    try{writeFileSync(tmp,JSON.stringify({sessdata:cookies.SESSDATA,bili_jct:cookies.bili_jct,buvid3:cookies.buvid3||'',dedeuserid:cookies.DedeUserID}),{flag:'wx',mode:0o600});linkSync(tmp,this.file);}finally{if(existsSync(tmp))unlinkSync(tmp);}
    session.key='';session.state='saved';
    return {...this.status(),saved:true,accountUid:cookies.DedeUserID};
  });}
}
