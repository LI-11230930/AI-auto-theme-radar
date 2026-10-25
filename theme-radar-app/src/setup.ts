import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

/** Initial local configuration only. Never replaces existing account or model settings. */
export function configureLocal(appRoot:string){
 const path=resolve(appRoot,'config.local.json');
 if(existsSync(path))return {path,created:false};
 const config=JSON.parse(readFileSync(resolve(appRoot,'config.example.json'),'utf8'));
 config.topics=[];
 config.xiaohongshu={...config.xiaohongshu,enabled:false};
 mkdirSync(appRoot,{recursive:true});
 try{writeFileSync(path,JSON.stringify(config,null,2)+'\n',{flag:'wx'});return {path,created:true};}
 catch(error){if((error as any).code==='EEXIST')return {path,created:false};throw error;}
}
