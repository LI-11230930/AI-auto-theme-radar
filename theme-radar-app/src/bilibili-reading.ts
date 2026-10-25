import {resolve} from 'node:path';
import {BilibiliSource} from './bilibili.ts';
import {withAsrFallback} from './asr-fallback.ts';
import {RadarError} from './model.ts';

/** All account-backed reading entry points share the same opt-in, P1-only fallback. */
export async function readConfiguredBilibili(config:any,bvid:string,options:{pages?:number[];expectedAuthorUid?:string;includeDanmaku?:boolean}={},signal?:AbortSignal,source=new BilibiliSource({credentialFile:config.bilibili?.credentialFile||undefined})){
 if(signal?.aborted)throw new RadarError('CANCELLED','本次视频读取已取消，未访问平台');
 const asr=config.bilibili?.asr||{};
 return withAsrFallback(await source.read(bvid,options),{enabled:asr.enabled===true,pythonCommand:asr.pythonCommand,modelDir:asr.modelDir,workDir:resolve(config.dataDir,'asr-tasks'),signal,audio:(id,o)=>source.audio(id,o)});
}
