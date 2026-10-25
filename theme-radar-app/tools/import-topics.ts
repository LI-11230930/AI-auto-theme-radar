import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {APP_ROOT} from '../src/config.ts';
import {context,writeReport} from '../src/service.ts';
const {config,store}=context();
try{
  const file=process.argv[2];if(!file)throw Error('Usage: node tools/import-topics.ts <your-topics.json>');
  const value=JSON.parse(readFileSync(resolve(file),'utf8')),topics=Array.isArray(value)?value:[value];
  const results=[];for(const topic of topics){const existing=store.topics().find(t=>t.id===topic.id);const {revision,...previous}=existing||{};if(existing&&JSON.stringify(previous)===JSON.stringify(topic)){results.push({id:topic.id,state:'unchanged',revision});continue;}results.push({id:topic.id,state:'saved',revision:store.saveTopic(topic,revision||0)});}
  const report={at:new Date().toISOString(),reason:'安装者显式导入示例主题',topics:store.topics(),results,startedCollection:false,emailSent:false};
  console.log(JSON.stringify({topics:report.topics.map(t=>({id:t.id,name:t.name,revision:t.revision})),results,path:writeReport(config,'topic-configuration.json',report)},null,2));
}finally{store.close();}
