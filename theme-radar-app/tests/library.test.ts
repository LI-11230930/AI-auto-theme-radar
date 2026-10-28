import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {repoReferences} from '../src/model.ts';
import {libraryView} from '../src/library.ts';
import {topic,item,evidence} from './fixtures.ts';
import {startOperator} from '../src/operator.ts';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {once} from 'node:events';
const video={...item,key:'bilibili:BV1234567890',externalId:'BV1234567890',platform:'bilibili' as const,url:'https://www.bilibili.com/video/BV1234567890',title:'Agent 视频'};
const setup=()=>{const store=new Store(':memory:');store.saveTopic(topic);store.capture(item,[evidence]);return store;};

test('仓库链接识别中文冒号后的无协议地址、源码路径与大小写，拒绝伪域和userinfo',()=>{
  assert.deepEqual(repoReferences('源码：github.com/Sample/Tool\n[源码](https://github.com/sample/tool/blob/main/x.ts) HTTPS://github.com/Other/Repo.git'),['sample/tool','other/repo']);
  assert.deepEqual(repoReferences('https://evil.invalid/github.com/sample/tool https://github.com.evil.invalid/sample/tool https://github.com@evil.invalid/sample/tool https://notgithub.com/sample/tool xgithub.com/sample/tool'),[]);
});
test('聚合当前引用保留跨来源原始条目，删除当前引用后不使用历史正文维持关联',()=>{
  const store=setup();try{store.capture(video,[{...evidence,itemKey:video.key,text:'源码：github.com/sample/tool'}]);let view=libraryView(store);assert.equal(view.groups.length,1);assert.equal(view.groups[0].members.length,2);assert.equal(store.stats().items,2);
    store.capture(video,[{...evidence,itemKey:video.key,text:'Agent 新材料，旧链接已移除'}]);view=libraryView(store);assert.equal(view.groups.length,0);assert.equal(store.evidence(video.key).length,2);
  }finally{store.close();}
});
test('主题聚合遵守平台和排除词；AI不匹配Daily，关键词不是AI筛选',()=>{
  const store=setup();try{store.saveTopic({...topic,id:'ai',keywords:['AI'],exclude:['广告'],platforms:['bilibili']});store.capture(video,[{...evidence,itemKey:video.key,text:'Daily report'}]);assert.equal(libraryView(store,{topicId:'ai'}).topics[0].items.length,0);
    store.capture(video,[{...evidence,itemKey:video.key,text:'AI 工具 广告'}]);const row=libraryView(store,{topicId:'ai'}).topics[0].items[0];assert.equal(row.candidate,false);assert.deepEqual(row.matched,['AI']);assert.deepEqual(row.excluded,['广告']);assert.equal(row.assessment,null);
    assert.throws(()=>libraryView(store,{limit:101}));assert.throws(()=>libraryView(store,{topicId:'missing'}));
  }finally{store.close();}
});
test('档案日期按来源发布时间含起不含止，跨时区等价，未知日期不补发现时间',()=>{
  const store=setup();try{store.capture({...video,publishedAt:'2026-10-20T09:00:00+08:00'},[{...evidence,itemKey:video.key}]);const filter={from:'2026-10-20T01:00:00Z',to:'2026-10-20T02:00:00Z'};assert.equal(store.search('',filter).length,1);assert.equal(store.search('',{from:'2026-10-20T00:00:00Z',to:filter.from}).length,0);
    assert.equal(store.search('',{...filter,from:'2026-10-20T01:00:01Z'}).length,0);assert.equal(store.search('',{platform:'bilibili',authorId:video.authorId}).length,1);
    for(const f of [{from:'2026-02-30T00:00:00Z'},{to:'not-a-date'},{...filter,from:filter.to},{limit:0},{platform:'unknown'}])assert.throws(()=>store.search('',f));
  }finally{store.close();}
});
test('反馈预览显示前后规则，订阅改变后即使传入新版本也拒绝旧预览',()=>{
  const store=setup();try{const f=store.addFeedback(item.key,topic.id,'less_like_this','入门教程');assert.equal(f.applicable,true);assert.equal(f.revision,1);assert.deepEqual(f.before,topic.exclude);assert.ok(f.after.includes('入门教程'));assert.equal(store.topics()[0].revision,1);
    store.saveTopic({...topic,description:'用户后来修改'},1);assert.throws(()=>store.applyFeedback(f.id,2),/重新预览/);assert.deepEqual(store.topics()[0].exclude,topic.exclude);
  }finally{store.close();}
});
test('重复只记录意见，重复排除词不制造无效版本，长度校验与撤销保留',()=>{
  const store=setup();try{const f=store.addFeedback(item.key,topic.id,'duplicate','意见');assert.equal(f.applicable,false);assert.throws(()=>store.applyFeedback(f.id,1),/没有待应用/);store.revertFeedback(f.id);
    const duplicate=store.addFeedback(item.key,topic.id,'irrelevant',topic.exclude[0]);assert.equal(duplicate.applicable,false);assert.throws(()=>store.applyFeedback(duplicate.id,1));
    assert.throws(()=>store.addFeedback(item.key,topic.id,'irrelevant','x'.repeat(201)));assert.equal(store.topics()[0].revision,1);
    const valid=store.addFeedback(item.key,topic.id,'irrelevant','教程');store.applyFeedback(valid.id,1);store.revertFeedback(valid.id);assert.equal(store.topics()[0].revision,3);assert.deepEqual(store.topics()[0].exclude,topic.exclude);
  }finally{store.close();}
});
test('网页反馈需要CSRF并可预览应用撤销；聚合/检索只读且不开放任意静态文件',async()=>{
  const root=mkdtempSync(resolve(tmpdir(),'radar-library-')),previous=process.env.THEME_RADAR_CONFIG;let server;
  try{const file=resolve(root,'config.json');writeFileSync(file,JSON.stringify({dataDir:resolve(root,'data')}));process.env.THEME_RADAR_CONFIG=file;const store=new Store(resolve(root,'data/radar.sqlite'));store.saveTopic(topic);store.capture(item,[evidence]);store.close();server=await startOperator(0);if(!server.listening)await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port;
    const state=await (await fetch(base+'/api/state')).json() as any,headers={'Content-Type':'application/json','X-Radar-Token':state.token},body={itemKey:item.key,topicId:topic.id,kind:'irrelevant',rule:'教程'};
    assert.equal((await fetch(base+'/api/feedback/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,403);
    const preview=await (await fetch(base+'/api/feedback/preview',{method:'POST',headers,body:JSON.stringify(body)})).json() as any;assert.equal(preview.applicable,true);
    assert.equal((await fetch(base+'/api/feedback/apply',{method:'POST',headers,body:JSON.stringify({id:preview.id,revision:preview.revision})})).status,200);
    assert.equal((await fetch(base+'/api/feedback/revert',{method:'POST',headers,body:JSON.stringify({id:preview.id})})).status,200);
    assert.equal((await fetch(base+'/api/library')).status,200);assert.equal((await fetch(base+'/api/archive?from=bad')).status,400);assert.equal((await fetch(base+'/assets/library.js')).status,200);assert.equal((await fetch(base+'/assets/config.local.json')).status,404);
  }finally{if(server)await new Promise<void>(r=>server.close(()=>r()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;rmSync(root,{recursive:true,force:true});}
});
