import {createHash} from 'node:crypto';import {RadarError} from './model.ts';
// Protocol permutation, first 32 positions used by the browser request signature.
const indices=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13];
export function signWbi(params:Record<string,string>,img:string,sub:string,seconds=Math.floor(Date.now()/1000)){
 if(!/^[a-f0-9]{32}$/.test(img)||!/^[a-f0-9]{32}$/.test(sub)||!Number.isSafeInteger(seconds)||seconds<0||Object.hasOwn(params,'w_rid')||Object.hasOwn(params,'wts'))throw new RadarError('INVALID_WBI','签名参数无效');
 const key=indices.map(i=>(img+sub)[i]).join(''),values:Record<string,string>={...params,wts:String(seconds)};
 const query=Object.keys(values).sort().map(k=>encodeURIComponent(k)+'='+encodeURIComponent(values[k].replace(/[!'()*]/g,''))).join('&');
 return query+'&w_rid='+createHash('md5').update(query+key).digest('hex');
}
export function wbiKey(value:unknown){if(typeof value!=='string')throw new RadarError('INVALID_WBI','账户接口未返回签名材料');let url:URL;try{url=new URL(value);}catch{throw new RadarError('INVALID_WBI','签名材料地址格式无效');}if(url.protocol!=='https:'||!/(?:^|\.)hdslb\.com$/.test(url.hostname))throw new RadarError('INVALID_WBI','签名材料来源无效');const name=url.pathname.split('/').pop()||'',key=name.split('.')[0];if(!/^[a-f0-9]{32}$/.test(key))throw new RadarError('INVALID_WBI','签名材料长度无效');return key;}
