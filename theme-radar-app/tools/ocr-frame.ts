import {readFileSync,writeFileSync,mkdirSync,lstatSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {APP_ROOT} from '../src/config.ts';
import {validateOcrFrame} from '../src/frame-ocr.ts';
import {RadarError,publicError} from '../src/model.ts';
try{
 const file=process.argv[2];if(!file||!isAbsolute(file)||/^\\\\|^\/\//.test(file))throw new RadarError('OCR_FRAME_PATH','请提供扩展导出画面JSON的本机绝对路径');
 const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>3000000)throw new RadarError('OCR_FRAME_BUDGET','只接受3MB以内的本机画面测试JSON');
 let input;try{input=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw new RadarError('INVALID_OCR_FRAME','画面测试JSON无法解析');}
 const frame=validateOcrFrame(input),folder=resolve(APP_ROOT,'.data/ocr-probes',randomUUID());mkdirSync(folder,{recursive:true});const image=resolve(folder,'frame.png');writeFileSync(image,frame.png);
 const shell=resolve(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 let result;try{const {stdout}=await promisify(execFile)(shell,['-NoProfile','-NonInteractive','-File',resolve(APP_ROOT,'tools/ocr-image.ps1'),'-ImagePath',image],{windowsHide:true,timeout:15000,maxBuffer:256000,encoding:'utf8'});result=JSON.parse(stdout.replace(/^\uFEFF/,''));}catch{throw new RadarError('OCR_LOCAL_FAILED','本机中文OCR未完成；没有归档、调用模型或发送');}
 if(!result?.ok||typeof result.text!=='string'||result.text.length>6000)throw new RadarError('OCR_LOCAL_FAILED','本机OCR返回无效或超出单帧文字预算');
 const report={at:new Date().toISOString(),kind:'visible-frame-ocr-probe',frame:frame.metadata,imageSha256:createHash('sha256').update(frame.png).digest('hex'),ocr:result,coverage:{state:'partial',method:'Windows.Media.Ocr on one user-exported visible pixel region',note:'仅一个暂停位置的画面下部；OCR可能错漏，不是B站字幕轨，不含连续时间覆盖；引擎未提供置信度'},archiveWritten:false,modelRead:false,emailSent:false};
 const output=resolve(folder,'result.json');writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,report:output,characters:result.text.length,text:result.text,archiveWritten:false,modelRead:false,emailSent:false}));
}catch(error){const safe=publicError(error);console.error(JSON.stringify({ok:false,code:safe.code,error:safe.message}));process.exitCode=1;}
