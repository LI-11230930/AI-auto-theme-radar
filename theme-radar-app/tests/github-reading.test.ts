import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSource,repositoryPaths } from '../src/github.ts';
import { materialPrompt } from '../src/runner.ts';
import { mockFetch,topic,item,evidence } from './fixtures.ts';

test('源码路径不能越过仓库或注入URL，非法输入在联网前拒绝',async()=>{
  let calls=0;const source=new GitHubSource(async()=>{calls++;throw Error('不应联网');});
  for(const files of [['../secret'],['https://example.com/a'],['a\\b'],['a%2fb'],['/root'],['a','b','c','d']])await assert.rejects(()=>source.read('sample/tool',{files}),/路径/);
  assert.equal(calls,0);assert.deepEqual(repositoryPaths(['src/工具.ts','src/工具.ts']),['src/工具.ts']);
});

test('显式源码只请求指定文件，归档路径和blob证据，不执行文件',async()=>{
  const urls:string[]=[];const source=new GitHubSource(async(url)=>{urls.push(url);return mockFetch(url);});
  const result=await source.read('sample/tool',{files:['index.ts']});
  assert.ok(!urls.some(url=>/\/contents\?/.test(url)));const code=result.evidence.find(e=>e.kind==='source:index.ts')!;
  assert.equal(code.text,'export const demo = true;');assert.equal(code.coverage.processed,0);assert.ok(code.coverage.note!.includes('source-sample'));assert.ok(code.url.includes('/blob/main/index.ts'));
});

test('私有仓库、符号链接、二进制和返回路径不符不被当作源码',async()=>{
  const privateSource=new GitHubSource(async()=>Response.json({private:true}));await assert.rejects(()=>privateSource.read('sample/tool'),/公开仓库/);
  for(const file of [{type:'symlink',path:'index.ts'}, {type:'file',encoding:'base64',path:'index.ts',content:Buffer.from([0,1,2]).toString('base64')},{type:'file',encoding:'base64',path:'other.ts',content:'YQ=='}]){
    const source=new GitHubSource(async(url)=>url.includes('/contents/index.ts?')?Response.json(file):mockFetch(url));
    const result=await source.read('sample/tool',{files:['index.ts']});assert.ok(!result.evidence.some(e=>e.kind.startsWith('source:')));assert.ok(result.warnings.some(w=>w.startsWith('index.ts')));
  }
});

test('大文件截断和巨大README不会冒充完整阅读或吞掉全部源码预算',async()=>{
  const source=new GitHubSource(async(url)=>url.includes('/contents/index.ts?')?Response.json({type:'file',encoding:'base64',path:'index.ts',content:Buffer.from('a'.repeat(45000)).toString('base64'),sha:'large'}):mockFetch(url));
  const result=await source.read('sample/tool',{files:['index.ts']});const code=result.evidence.find(e=>e.kind==='source:index.ts')!;
  assert.equal(code.text.length,40000);assert.ok(code.coverage.note!.includes('40000/45000'));assert.ok(result.warnings.some(w=>w.includes('截断')));
  const bundle=materialPrompt(topic,item,[{...evidence,id:'readme',text:'r'.repeat(100000)},{...code,id:'code'}]);
  assert.equal(bundle.materials[0].providedCharacters,24000);assert.equal(bundle.materials[1].providedCharacters,15000);assert.equal(bundle.materials[1].truncated,true);
});

test('根目录没有源码时只向一个约定目录取样，缺失许可证保留失败',async()=>{
  const calls:string[]=[];const source=new GitHubSource(async(url)=>{calls.push(url);
    if(url.endsWith('/license'))return new Response('none',{status:404});
    if(url.includes('/contents?'))return Response.json([{type:'dir',name:'src',path:'src'},{type:'dir',name:'lib',path:'lib'}]);
    if(url.includes('/contents/src?'))return Response.json([{type:'file',name:'main.ts',path:'src/main.ts'}]);
    if(url.includes('/contents/src/main.ts?'))return Response.json({type:'file',path:'src/main.ts',encoding:'base64',content:Buffer.from('const value = 1;').toString('base64')});
    return mockFetch(url);
  });const result=await source.read('sample/tool');
  assert.ok(result.evidence.some(e=>e.kind==='source:src/main.ts'));assert.ok(result.warnings.some(w=>w.startsWith('许可证')));assert.ok(!calls.some(url=>url.includes('/contents/lib')));
});
