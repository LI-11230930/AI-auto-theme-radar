import {RadarError} from './model.ts';
export function operatorUrl(value:unknown='http://127.0.0.1:8767'){
 let url:URL;try{if(typeof value!=='string')throw Error();url=new URL(value);}catch{throw new RadarError('INVALID_CONFIG','验证台地址须为本机HTTP根地址');}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.port||Number(url.port)<1024)throw new RadarError('INVALID_CONFIG','验证台只允许本机HTTP根地址和1024以上端口');
 return url.origin;
}
export function absolutePreviewUrl(config:any,path:string){
 if(typeof path!=='string'||!path.startsWith('/preview/')||path.includes('\\')||/[\r\n]/.test(path))throw new RadarError('INVALID_PREVIEW','预览路径无效');
 const base=operatorUrl(config.operatorUrl),url=new URL(path,base);
 if(url.origin!==base||!url.pathname.startsWith('/preview/'))throw new RadarError('INVALID_PREVIEW','预览路径无效');
 return url.href;
}
