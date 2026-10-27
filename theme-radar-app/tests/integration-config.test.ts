import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';import {join,resolve,relative} from 'node:path';import {tmpdir} from 'node:os';
import {configureLocal} from '../src/setup.ts';import {APP_ROOT,configFilePath,loadConfig} from '../src/config.ts';import {writeIntegrations} from '../src/integration-config.ts';import {Store} from '../src/store.ts';import {topic} from './fixtures.ts';
function temporary(t:any){const root=mkdtempSync(join(tmpdir(),'radar-config-handoff-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const app=join(root,'application');mkdirSync(app);writeFileSync(join(app,'config.example.json'),readFileSync(join(APP_ROOT,'config.example.json')));return {root,app};}
test('自定义配置首次只创建指定文件，原默认配置与个人内容逐字保留',t=>{
 const {root,app}=temporary(t),original=join(app,'config.local.json'),external=join(root,'my settings','profile.json');writeFileSync(original,'{"preserve":"local-personal"}\n');
 const result=configureLocal(app,external);assert.equal(result.path,external);assert.equal(result.created,true);assert.equal(JSON.parse(readFileSync(external,'utf8')).topics.length,0);assert.equal(readFileSync(original,'utf8'),'{"preserve":"local-personal"}\n');
 const content=readFileSync(external,'utf8');assert.equal(configureLocal(app,external).created,false);assert.equal(readFileSync(external,'utf8'),content);
});
test('四宿主及DSH项目补丁全部绑定指定配置，同一数据目录共享账本',t=>{
 const {root,app}=temporary(t),external=join(root,'my settings','profile.json');configureLocal(app,external);const generated=writeIntegrations(app,{configFile:relative(process.cwd(),external)});assert.equal(generated.configFile,external);
 const config=loadConfig(external),first=new Store(join(config.dataDir,'radar.sqlite'));first.saveTopic(topic);first.close();
 for(const host of ['DSH','WorkBuddy','TRAE','common']){
  const server=JSON.parse(readFileSync(join(app,'integrations',host+'.mcp.json'),'utf8')).mcpServers['theme-radar'];assert.equal(server.env.THEME_RADAR_CONFIG,external);const linked=loadConfig(server.env.THEME_RADAR_CONFIG),store=new Store(join(linked.dataDir,'radar.sqlite'));try{assert.equal(store.topics()[0].id,topic.id);}finally{store.close();}
 }
 for(const name of ['Codex.config.toml','DSH.cordis.yml'])assert.ok(readFileSync(join(app,'integrations',name),'utf8').includes(JSON.stringify(external)));
 assert.equal(existsSync(join(app,'config.local.json')),false);assert.equal(existsSync(join(app,'.data')),false);
});
test('环境变量路径用于生成配置，输出绝对路径不受后续宿主工作目录影响',t=>{
 const {root,app}=temporary(t),previous=process.env.THEME_RADAR_CONFIG,path=join(root,'selected.json');process.env.THEME_RADAR_CONFIG=relative(process.cwd(),path);
 try{assert.equal(configFilePath(undefined,app),path);assert.equal(writeIntegrations(app).configFile,path);}finally{if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;}
});
test('指定配置丢失时明确停止，不创建默认数据目录或静默使用另一份账本',t=>{
 const {root,app}=temporary(t),missing=join(root,'missing.json');assert.throws(()=>loadConfig(missing),(e:any)=>e.code==='CONFIG_NOT_FOUND');assert.equal(existsSync(missing),false);assert.equal(existsSync(join(root,'.data')),false);
});
test('错误配置JSON不回显私有内容，也不覆盖现有文件',t=>{
 const {root}=temporary(t),path=join(root,'bad.json');for(const content of ['{"private-key":"hidden-value",', 'null','[]']){writeFileSync(path,content);assert.throws(()=>loadConfig(path),(e:any)=>e.code==='INVALID_CONFIG'&&!String(e.message).includes('hidden-value'));assert.equal(readFileSync(path,'utf8'),content);}
});
