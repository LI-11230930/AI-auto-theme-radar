import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RadarError, validateTopic } from './model.ts';
import {configureNetwork,proxyUrl} from './network.ts';
import {isEmailAddress} from './email-address.ts';
import {operatorUrl} from './operator-url.ts';
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function configFilePath(file=process.env.THEME_RADAR_CONFIG,appRoot=APP_ROOT){return resolve(file||resolve(appRoot,'config.local.json'));}
export function loadConfig(file?:string) {
  const explicit=file||process.env.THEME_RADAR_CONFIG;file=configFilePath(file);
  if(explicit&&!existsSync(file))throw new RadarError('CONFIG_NOT_FOUND','指定的配置文件不存在；请先用bootstrap configure创建，不会改用另一份默认账本');
  const defaults = JSON.parse(readFileSync(resolve(APP_ROOT,'config.example.json'),'utf8'));
  let local:any={};try{if(existsSync(file))local=JSON.parse(readFileSync(file,'utf8'));}catch{throw new RadarError('INVALID_CONFIG','无法读取配置JSON；请检查文件格式和权限，原文件未覆盖');}
  if(!local||typeof local!=='object'||Array.isArray(local))throw new RadarError('INVALID_CONFIG','配置JSON需要对象；原文件未覆盖');
  const config = {...defaults,...local,limits:{...defaults.limits,...local.limits},email:{...defaults.email,...local.email},runners:{...defaults.runners,...local.runners},accounts:{...defaults.accounts,...local.accounts},bilibili:{...defaults.bilibili,...local.bilibili},xiaohongshu:{...defaults.xiaohongshu,...local.xiaohongshu}};
  config.operatorUrl=operatorUrl(config.operatorUrl);
  if(config.timezone!=='Asia/Shanghai'||JSON.stringify(config.sendTimes)!==JSON.stringify(['09:00','18:00']))throw new RadarError('BASELINE_MISMATCH','时区与双时段配置无效');
  if(config.recipient!==null&&!isEmailAddress(config.recipient))throw new RadarError('INVALID_CONFIG','收件人须为单个有效邮箱，或留空为null；留空可进行只读操作');
  if(!Array.isArray(config.topics))throw new RadarError('INVALID_CONFIG','topics 必须为列表');
  config.topics.forEach(validateTopic);
  for(const key of ['candidates','selected','commentsPerRun','commentsHardLimit','runnerTimeoutMs','runnerOutputBytes'])if(!Number.isSafeInteger(config.limits[key])||config.limits[key]<1)throw new RadarError('INVALID_CONFIG',`预算 ${key} 必须是正整数`);
  if(config.limits.commentsHardLimit>3||config.limits.commentsPerRun>config.limits.commentsHardLimit)throw new RadarError('INVALID_CONFIG','评论数量超出既定硬上限');
  if(!['DSH','WorkBuddy','Codex','TRAE'].includes(config.defaultAgent))throw new RadarError('INVALID_CONFIG','默认 Agent 无效');
  const xhs=new URL(config.xiaohongshu.baseUrl);if(!['127.0.0.1','localhost','[::1]'].includes(xhs.hostname)||xhs.protocol!=='http:'||xhs.username||xhs.password)throw new RadarError('INVALID_CONFIG','小红书桥接仅连接本机 HTTP 服务');
  config.dataDir=resolve(dirname(existsSync(file)?file:resolve(APP_ROOT,'config.example.json')),config.dataDir);
  mkdirSync(config.dataDir,{recursive:true});
  const savedBilibili=resolve(config.dataDir,'credentials','bilibili.json');
  if(!config.bilibili.credentialFile&&existsSync(savedBilibili))config.bilibili.credentialFile=savedBilibili;
  const asr={...defaults.bilibili.asr,...local.bilibili?.asr};
  if(typeof asr.enabled!=='boolean'||asr.pythonCommand!==null&&(typeof asr.pythonCommand!=='string'||!asr.pythonCommand.trim()||/[\r\n]/.test(asr.pythonCommand))||asr.modelDir!==null&&(typeof asr.modelDir!=='string'||!asr.modelDir.trim()))throw new RadarError('INVALID_CONFIG','本地ASR配置格式无效');
  asr.modelDir=asr.modelDir?resolve(dirname(existsSync(file)?file:resolve(APP_ROOT,'config.example.json')),asr.modelDir):resolve(config.dataDir,'models','faster-whisper-base');
  config.bilibili.asr=asr;
  config.network={proxyUrl:proxyUrl(config.network?.proxyUrl)};
  configureNetwork(config.network.proxyUrl);
  return config;
}
