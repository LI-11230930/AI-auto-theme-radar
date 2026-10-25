import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {setImmediate} from 'node:timers/promises';

const source = readFileSync(new URL('../operator-interest.js', import.meta.url), 'utf8');
const preview = '/preview/bilibili-sample?id=12345678-1234-1234-1234-123456789abc';
const canonicalVideo = 'https://www.bilibili.com/video/BV0000000099/';
const topic = {id:'interest-ai', name:'AI 与自动化', enabled:true, platforms:['bilibili'], bilibiliDiscovery:'interests'};
type Data = Record<string, any>;
type Handler = () => void | Promise<void>;

class Element {
  tag: string;
  children: Element[] = [];
  handlers: Record<string, Handler> = {};
  disabled = false;
  value = '';
  textContent = '';
  href?: string;
  target?: string;
  rel?: string;
  constructor(tag = 'div') { this.tag = tag; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
    if (this.tag === 'select') this.value = nodes[0]?.value || '';
  }
  addEventListener(type: string, handler: Handler) { this.handlers[type] = handler; }
  set innerHTML(_value: string) { throw Error('UI must not interpret HTML'); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

function fixtureReport(overrides: Data = {}) {
  return {
    id:'run-fixture', topicId:topic.id, discovered:8, prefiltered:3, emailSent:false,
    sources:[{kind:'search', state:'ok', count:8}],
    results:[{itemKey:'bilibili:BV0000000099', title:'自动化示例', url:canonicalVideo,
      authorUid:'123', state:'assessed', selected:true, summaryZh:'介绍自动化流程。'}],
    sample:{id:'12345678-1234-1234-1234-123456789abc', count:1, preview},
    ...overrides
  };
}

function harness(options: {lastRun?: Data; running?: boolean; topics?: Data[];activeRuns?:Data[]} = {}) {
  const elements = Object.fromEntries(['interest-topic','interest-start','interest-cancel','interest-status','interest-results']
    .map(id => [id, new Element(id === 'interest-topic' ? 'select' : 'div')])) as Record<string, Element>;
  const calls: {path: string; options: Data}[] = [];
  const listeners: Record<string, Handler[]> = {};
  const document = {
    getElementById: (id: string) => elements[id],
    createElement: (tag: string) => new Element(tag),
    addEventListener(type: string, fn: Handler) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(event: {type: string}) { for (const fn of listeners[event.type] || []) void fn(); }
  };
  let nextStateDelay: Promise<void> | undefined;
  let nextStatusDelay: Promise<void> | undefined;
  let runDelay: Promise<Data> | undefined;
  let lastRun = options.lastRun || null;
  let running = options.running || false;
  let activeRuns=options.activeRuns||[];
  let timerId=0;const timers=new Map<number,()=>Promise<void>>();
  const fetch = async (path: string, requestOptions: Data = {}) => {
    calls.push({path, options:requestOptions});
    let data: Data;
    if (path === '/api/state') {
      const delay = nextStateDelay; nextStateDelay = undefined;
      if (delay) await delay;
      data = {token:'local-fixture-token', topics:options.topics || [topic]};
    } else if (path === '/api/bilibili/interest/status') {
      data = {running, lastRun,activeRuns};
      const delay=nextStatusDelay;nextStatusDelay=undefined;if(delay)await delay;
    } else if (path === '/api/bilibili/interest/run') {
      running = true;
      data = runDelay ? await runDelay : fixtureReport();
      running = false;
      lastRun = data;
    } else if (path === '/api/bilibili/interest/cancel') {
      data = {ok:true};
    } else throw Error('Unexpected UI request: ' + path);
    return {ok:true, json:async () => data};
  };
  runInNewContext(source, {
    document, fetch, URL,
    setTimeout:(fn:()=>Promise<void>)=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:(id:number)=>timers.delete(id),
    Event:class {type: string; constructor(type: string) {this.type = type;}},
    window:{location:{origin:'http://127.0.0.1:8767'}}
  });
  return {
    elements, calls,
    delayNextState(promise: Promise<void>) { nextStateDelay = promise; },
    delayNextStatus(promise:Promise<void>){nextStatusDelay=promise;},
    delayRun(promise: Promise<Data>) { runDelay = promise; },
    async click(id: string) { await elements[id].handlers.click?.(); },
    posts() { return calls.filter(call => call.options.method === 'POST'); },
    scheduledPolls(){return timers.size;},
    setStatus(value:{running:boolean;activeRuns?:Data[];lastRun?:Data}){running=value.running;activeRuns=value.activeRuns||[];if(value.lastRun)lastRun=value.lastRun;},
    async tick(){const entry=timers.entries().next().value;if(entry){timers.delete(entry[0]);await entry[1]();}},
    async flush() { await setImmediate(); await setImmediate(); }
  };
}

function descendants(node: Element): Element[] {
  return [node, ...node.children.flatMap(descendants)];
}

test('兴趣界面首次加载只读，主题仅列出已启用 B站 interests，不自动启动或发信', async () => {
  const h = harness({topics:[topic,
    {...topic,id:'author-mode',bilibiliDiscovery:'authors'},
    {...topic,id:'disabled',enabled:false},
    {...topic,id:'github-only',platforms:['github']} ]});
  await h.flush();
  assert.deepEqual(h.calls.map(call => call.path), ['/api/state','/api/bilibili/interest/status']);
  assert.equal(h.posts().length, 0);
  assert.equal(h.elements['interest-topic'].children.length, 1);
  assert.equal(h.elements['interest-topic'].value, topic.id);
  assert.equal(h.elements['interest-start'].disabled, false);
  assert.equal(h.elements['interest-cancel'].disabled, true);
  assert.match(h.elements['interest-status'].textContent, /生成草稿，不发送邮件/);
});
test('已送达与未知邮件按投递账本显示，不以旧轮次的emailSent=false误报未发',async()=>{
 const sent=harness({lastRun:fixtureReport({emailSent:false,delivery:{state:'sent_confirmed'}})});await sent.flush();assert.match(sent.elements['interest-status'].textContent,/已核对送达/);assert.doesNotMatch(sent.elements['interest-status'].textContent,/本轮未发送邮件/);
 const unknown=harness({lastRun:fixtureReport({emailSent:false,delivery:{state:'uncertain'}})});await unknown.flush();assert.match(unknown.elements['interest-status'].textContent,/请勿重复发送/);assert.equal(unknown.posts().length,0);
});

test('一次长请求附带 CSRF，等待期间防重复启动，取消最多一次请求，完成后恢复按钮', async () => {
  const h = harness(), pending = deferred<Data>();
  await h.flush(); h.delayRun(pending.promise);
  const run = h.click('interest-start');
  await h.flush();
  assert.equal(h.elements['interest-start'].disabled, true);
  assert.equal(h.elements['interest-topic'].disabled, true);
  await h.click('interest-start');
  assert.equal(h.calls.filter(call => call.path.endsWith('/run')).length, 1);
  await h.click('interest-cancel');
  await h.click('interest-cancel');
  assert.equal(h.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
  assert.equal(h.elements['interest-cancel'].disabled, true);
  const request = h.posts().find(call => call.path.endsWith('/run'))!;
  assert.equal(request.options.headers['X-Radar-Token'], 'local-fixture-token');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), {topicId:topic.id, readLimit:3});
  pending.resolve(fixtureReport()); await run; await h.flush();
  assert.equal(h.elements['interest-start'].disabled, false);
  assert.equal(h.elements['interest-cancel'].disabled, true);
  assert.match(h.elements['interest-status'].textContent, /本轮未发送邮件/);
  assert.deepEqual(h.posts().map(call => call.path), ['/api/bilibili/interest/run','/api/bilibili/interest/cancel']);
});

test('运行前 token 刷新遇到取消时不创建后台任务，也不重复发取消请求', async () => {
  const h = harness(), token = deferred<void>();
  await h.flush(); h.delayNextState(token.promise);
  const run = h.click('interest-start'); await h.flush();
  await h.click('interest-cancel'); await h.click('interest-cancel');
  token.resolve(); await run;
  assert.equal(h.posts().length, 0);
  assert.match(h.elements['interest-status'].textContent, /本轮未启动后台阅读/);
  assert.equal(h.elements['interest-start'].disabled, false);
});

test('已运行状态阻止新启动，重新加载能恢复已完成结果且不触发写入', async () => {
  const busy = harness({running:true}); await busy.flush();
  assert.equal(busy.elements['interest-start'].disabled, true);
  await busy.click('interest-start'); assert.equal(busy.posts().length, 0);
  const restored = harness({lastRun:fixtureReport()}); await restored.flush();
  assert.equal(restored.posts().length, 0);
  assert.match(restored.elements['interest-status'].textContent, /发现 8 条/);
  const links = descendants(restored.elements['interest-results']).filter(node => node.tag === 'a');
  assert.deepEqual(links.map(node => node.href), [canonicalVideo, preview]);
});

test('恶意标题仅作文字，上游 URL 严格校验并移除视频查询参数', async () => {
  const title = '<img src=x onerror=alert(1)>';
  const report = fixtureReport({results:[
    {title, url:'javascript:alert(1)', state:'failed'},
    {title:'伪造域名',url:'https://www.bilibili.com.evil.test/video/BV0000000099/'},
    {title:'用户信息',url:'https://evil@www.bilibili.com/video/BV0000000099/'},
    {title:'非视频页',url:'https://www.bilibili.com/read/cv123'},
    {title:'正确链接',url:canonicalVideo+'?evil=1#fragment', selected:true}
  ]});
  const h = harness({lastRun:report}); await h.flush();
  const nodes = descendants(h.elements['interest-results']);
  assert.ok(nodes.some(node => node.textContent === title));
  assert.deepEqual(nodes.filter(node => node.tag === 'a').map(node => node.href), [canonicalVideo, preview]);
  for (const link of nodes.filter(node => node.tag === 'a')) {
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  }
});

test('冻结草稿仅允许本站精确预览路由、单个 UUID 参数，拒绝外链和额外参数', async () => {
  for (const url of [
    'https://evil.test'+preview,
    '//evil.test'+preview,
    preview+'&extra=1',
    preview+'&id=12345678-1234-1234-1234-123456789abc',
    preview+'#fragment',
    '/preview/bilibili-sample?id=not-a-uuid',
    '/preview/bilibili-sample/else?id=12345678-1234-1234-1234-123456789abc',
    'javascript:alert(1)'
  ]) {
    const h = harness({lastRun:fixtureReport({results:[],sample:{count:1,preview:url}})});
    await h.flush();
    assert.equal(descendants(h.elements['interest-results']).filter(node => node.tag === 'a').length, 0, url);
    assert.equal(h.posts().length, 0);
  }
});
test('取得范围显示机器转写、归档复用与实际引用；时间范围不冒充听音频',async()=>{
 const report=fixtureReport();report.results[0].acquisition={cached:true,agentRead:true,videoText:[{kind:'asr:p1',characters:504}],asr:[{state:'acquired',processedRange:{from:0,to:63.808}}]};
 const h=harness({lastRun:report});await h.flush();const text=descendants(h.elements['interest-results']).map(n=>n.textContent).join('\n');
 assert.match(text,/复用归档材料：P1机器转写 504字/);assert.match(text,/当前判断引用了视频正文/);assert.match(text,/处理 0.0–63.8 秒/);
});
test('无正文与ASR空结果显示跳过，不能显示已读正文',async()=>{
 const report=fixtureReport({results:[{state:'no_subtitle',acquisition:{cached:false,agentRead:false,videoText:[],asr:[{state:'insufficient_text',reason:'ASR_EMPTY'}]}}],sample:null});
 const h=harness({lastRun:report});await h.flush();const text=descendants(h.elements['interest-results']).map(n=>n.textContent).join('\n');
 assert.match(text,/未取得可读视频正文/);assert.match(text,/文字不足，已跳过/);assert.match(text,/本轮没有确认模型引用视频正文/);assert.doesNotMatch(text,/当前判断引用了视频正文/);
});

test('稀疏正文在阅读页说明保留归档但不进入精选，不显示为已精选',async()=>{
 const h=harness({lastRun:fixtureReport({sample:null,results:[{state:'insufficient_body',selected:false,acquisition:{cached:true,agentRead:false,videoText:[{kind:'asr:p1',characters:36}],selectionGate:{sufficient:false,characters:33,minimumCharacters:80}}}]})});await h.flush();const text=descendants(h.elements['interest-results']).map(n=>n.textContent).join('\n');assert.match(text,/未选中/);assert.match(text,/有效文字 33 \/ 最低 80 字/);assert.match(text,/未进入邮件精选/);assert.doesNotMatch(text,/已精选/);assert.equal(h.posts().length,0);
});

test('旧草稿当前不合格时标明历史选择与当前排除，不改写原记录或触发请求',async()=>{const report=fixtureReport({currentSampleReview:{available:true,frozenCount:3,eligibleNow:2,sampleCurrent:false,excluded:[{itemKey:'bilibili:BV0000000099',reason:'insufficient_video_body'}]},counts:{attempted:3,newSourceReads:1,cachedMaterials:2,newAssessments:1,reusedAssessments:1,insufficientBody:1}}),h=harness({lastRun:report});await h.flush();assert.match(h.elements['interest-status'].textContent,/历史草稿 3 条，当前符合条件 2 条/);assert.match(h.elements['interest-status'].textContent,/新取得 1 条 · 复用材料 2 条/);const text=descendants(h.elements['interest-results']).map(n=>n.textContent).join('\n');assert.match(text,/历史判断选中，当前已排除/);assert.match(text,/以上介绍为历史判断/);assert.match(text,/查看历史冻结草稿/);assert.equal(h.posts().length,0);assert.equal(report.results[0].selected,true);});
test('后台运行恢复后按只读状态轮询显示阶段，结束后停止轮询且不启动新轮次',async()=>{
 const active=fixtureReport({stage:'analyzing',sample:null});const h=harness({running:true,activeRuns:[active]});await h.flush();assert.match(h.elements['interest-status'].textContent,/Agent正在分析/);assert.equal(h.scheduledPolls(),1);
 h.setStatus({running:true,activeRuns:[{...active,stage:'reading'}]});await h.tick();assert.match(h.elements['interest-status'].textContent,/取得字幕或语音文字/);assert.equal(h.scheduledPolls(),1);
 h.setStatus({running:false,lastRun:fixtureReport({stage:'finished'})});await h.tick();assert.match(h.elements['interest-status'].textContent,/已结束/);assert.equal(h.scheduledPolls(),0);assert.equal(h.posts().length,0);assert.equal(h.elements['interest-start'].disabled,false);
});
test('当前页发起的长请求可轮询运行阶段，完成清理定时器，不把旧结果当新进度',async()=>{
 const h=harness(),pending=deferred<Data>();await h.flush();assert.equal(h.scheduledPolls(),0);h.delayRun(pending.promise);const run=h.click('interest-start');await h.flush();assert.equal(h.scheduledPolls(),1);
 h.setStatus({running:true,activeRuns:[fixtureReport({stage:'reading',sample:null})]});await h.tick();assert.match(h.elements['interest-status'].textContent,/本轮仍在运行/);assert.equal(h.elements['interest-start'].disabled,true);
 pending.resolve(fixtureReport({stage:'finished'}));await run;await h.flush();assert.equal(h.scheduledPolls(),0);assert.equal(h.posts().length,1);
});
test('延迟返回的旧进度不能覆盖已结束结果或重新启动轮询',async()=>{
 const h=harness(),pending=deferred<Data>(),oldStatus=deferred<void>();await h.flush();h.delayRun(pending.promise);const run=h.click('interest-start');await h.flush();h.setStatus({running:true,activeRuns:[fixtureReport({stage:'analyzing'})]});h.delayNextStatus(oldStatus.promise);const poll=h.tick();await h.flush();
 pending.resolve(fixtureReport({stage:'finished'}));await run;await h.flush();oldStatus.resolve();await poll;await h.flush();assert.match(h.elements['interest-status'].textContent,/已结束/);assert.doesNotMatch(h.elements['interest-status'].textContent,/本轮仍在运行/);assert.equal(h.scheduledPolls(),0);assert.equal(h.elements['interest-start'].disabled,false);
});
