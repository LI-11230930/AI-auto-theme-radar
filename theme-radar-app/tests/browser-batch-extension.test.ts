import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext,Script} from 'node:vm';

const extension=resolve('../browser-extension'),source=(name:string)=>readFileSync(resolve(extension,name),'utf8'),tick=()=>new Promise(r=>setImmediate(r));
function core(){const ctx:any={URL,Date,AbortController,setTimeout,clearTimeout};runInNewContext(source('batch-core.js'),ctx);return ctx.ThemeRadarBatchCore;}
const first='BV1234567890',second='BV0123456789';
const row=(bvid=first)=>({itemKey:'bilibili:'+bvid,bvid,page:1,url:'https://www.bilibili.com/video/'+bvid+'?p=1',duration:20,state:'pending'});
const manifest=(items=[row()])=>({batchId:'isolated-test-batch',expiresAt:new Date(Date.now()+15*60000).toISOString(),state:'paired',items});
const capture=(bvid=first)=>({schema:'theme-radar-visible-subtitles-v1',bvid,page:1,duration:20,observedFrom:0,observedTo:20,captureStatus:'ended',truncated:false,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),segments:[{from:1,to:5,text:'DOM夹具字幕'}]});
function event(){const listeners=new Set<any>();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit(...args:any[]){for(const fn of [...listeners])fn(...args);},get size(){return listeners.size;}};}
function fakePort(){const messages:any[]=[],onMessage=event(),onDisconnect=event();let disconnected=0;return {name:'theme-radar-batch-v1',sender:{id:'a'.repeat(32),url:'chrome-extension://'+'a'.repeat(32)+'/batch.html?tabId=9'},onMessage,onDisconnect,messages,postMessage:message=>messages.push(message),disconnect(){disconnected++;onDisconnect.emit();},get disconnected(){return disconnected;}};}

test('扩展0.3只增加8767可选来源，批次入口不携带凭据，内容脚本无网络及模型权限',()=>{
 const m=JSON.parse(source('manifest.json'));assert.equal(m.version,'0.3.2');assert.deepEqual(m.permissions,['activeTab','scripting']);assert.deepEqual(m.optional_host_permissions,['http://127.0.0.1:8767/*']);
 for(const key of ['host_permissions','background','content_scripts','externally_connectable'])assert.equal(m[key],undefined);
 for(const name of ['batch-core.js','batch-page.js','batch-player.js','batch-popup.js'])new Script(source(name));
 assert.ok(!/fetch\s*\(|XMLHttpRequest|chrome\.storage|sessionStorage|localStorage|chrome\.cookies|document\.cookie/.test(source('batch-player.js')));
 assert.ok(!/token|pairCode|pair-code/.test(source('batch-popup.js')));assert.match(source('batch-popup.js'),/\?tabId=/);
 assert.ok(!/chrome\.storage|sessionStorage|localStorage|navigator\.sendBeacon/.test(source('batch-page.js')));
 assert.match(source('batch-page.js'),/permissions\.request/);assert.match(source('batch-player.js'),/heartbeat>10000/);
});

test('客户端只POST固定本机端点，不跟随重定向/携带Cookie；令牌不泄露给清单',async()=>{
 const calls:any[]=[],token='a'.repeat(43),client=core().createClient(async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>calls.length===1?{token,...manifest()}:manifest()};});
 const status=await client.pair('ABCDEF123456');assert.equal(status.token,undefined);assert.equal(status.items[0].bvid,first);await client.manifest();
 assert.equal(calls[0].url,'http://127.0.0.1:8767/bridge/browser-batch/pair');assert.equal(calls[0].options.headers.Authorization,undefined);
 assert.equal(calls[1].options.headers.Authorization,'Bearer '+token);for(const {options} of calls){assert.equal(options.method,'POST');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');}
 client.clear();await assert.rejects(()=>client.manifest(),/凭据已清除/);assert.equal(calls.length,2);
});

test('清单拒绝跨站URL、错BV/分P、超时长、重复、过期；字幕必须实际结束有正文',()=>{
 const c=core();assert.equal(c.validateStatus(manifest()).items.length,1);
 for(const x of [manifest([{...row(),url:'https://evil.invalid/'+first}]),manifest([{...row(),url:'https://www.bilibili.com@evil.invalid/video/'+first+'?p=1'}]),manifest([{...row(),page:2}]),manifest([{...row(),duration:901}]),manifest([row(),row()]),{...manifest(),expiresAt:new Date(Date.now()-1).toISOString()}])assert.throws(()=>c.validateStatus(x));
 for(const x of [{...capture(),bvid:second},{...capture(),page:2},{...capture(),captureStatus:'stopped'},{...capture(),segments:[]},{...capture(),observedFrom:3},{...capture(),observedTo:10},{...capture(),truncated:true}])assert.throws(()=>c.validateCapture(row(),x));
});

test('批次逐条观察，确认停止后才上传及导航下一条，完成撤销授权',async()=>{
 const c=core(),state=manifest([row(),row(second)]),order:string[]=[],client={manifest:async()=>{order.push('manifest');return structuredClone(state);},capture:async(key:string)=>{order.push('capture '+key);state.items.find(i=>i.itemKey===key)!.state='imported';return {status:structuredClone(state)};},cancel:async()=>{order.push('cancel');},fail:async()=>{throw Error('不应失败');}},browser={observe:async item=>{order.push('observe '+item.bvid);return capture(item.bvid);},stop:async()=>{order.push('stop');}};
 const runner=c.createRunner({client,browser});await runner.run(structuredClone(state));assert.equal(runner.running,false);assert.deepEqual(order,['manifest','observe '+first,'stop','capture bilibili:'+first,'manifest','observe '+second,'stop','capture bilibili:'+second,'cancel']);
});

test('停止发生在清单请求期间，不得在返回后启动页面；发生在观察期间不得继续提交',async()=>{
 const c=core();for(const phase of ['manifest','observe']){let release:any,observed=0,captured=0,cancelled=0;const blocked=new Promise(r=>release=r),client={manifest:async()=>phase==='manifest'?blocked:manifest(),capture:async()=>{captured++;},cancel:async()=>{cancelled++;},fail:async()=>{}},browser={observe:async()=>{observed++;return blocked;},stop:async()=>{}};
 const runner=c.createRunner({client,browser}),pending=runner.run(manifest());await tick();await runner.cancel();release(phase==='manifest'?manifest():capture());await pending;assert.equal(captured,0);assert.equal(observed,phase==='manifest'?0:1);assert.equal(cancelled,1);assert.equal(runner.running,false);}
});

test('错误字幕或来源版本变更停止整批，不提交或转到下一条',async()=>{
 const c=core();let captured=0,observed=0,failed=0,cancelled=0;const state=manifest([row(),row(second)]),client={manifest:async()=>state,capture:async()=>{captured++;},fail:async(_key,code)=>{assert.equal(code,'CAPTURE_INTERRUPTED');failed++;},cancel:async()=>{cancelled++;}},browser={observe:async()=>{observed++;return capture(second);},stop:async()=>{}};
 await assert.rejects(()=>c.createRunner({client,browser}).run(state),/中断/);assert.equal(captured,0);assert.equal(observed,1);assert.equal(failed,1);assert.equal(cancelled,1);
});

function pageHarness(options:any={}){
 const nodes:any=Object.fromEntries(['pair-form','pair-code','pair','run','continue','stop','items','status'].map(name=>[name,{handlers:{},addEventListener(kind,fn){this.handlers[kind]=fn;},replaceChildren(){},append(){},value:'',disabled:false,textContent:''}]));
 const updated=event(),removed=event(),ports:any[]=[],updates:any[]=[],scripts:any[]=[],pageEvents:any={};let browser:any,currentUrl=options.url||'https://www.bilibili.com/video/'+first+'?p=1';
 const base=core(),ctx:any={URL,Date,Uint8Array,crypto:globalThis.crypto,setTimeout,clearTimeout,setInterval,clearInterval,location:{href:'chrome-extension://'+'a'.repeat(32)+'/batch.html?tabId=9'},document:{getElementById:id=>nodes[id],createElement:()=>({append(){}})},addEventListener:(kind,fn)=>pageEvents[kind]=fn,ThemeRadarBatchCore:{...base,createClient:()=>({clear(){}}),createRunner:input=>{browser=input.browser;return {running:false};}},chrome:{tabs:{onUpdated:updated,onRemoved:removed,get:async()=>options.get?options.get():{id:9,url:currentUrl},sendMessage:async()=>options.manual?{ok:true,data:{captureStatus:'recording'}}:{ok:true,data:null},update:async(id,change)=>{updates.push({id,change});currentUrl=change.url;return {status:'loading',url:currentUrl};},connect:()=>{const port=fakePort();ports.push(port);return port;}},scripting:{executeScript:async input=>scripts.push(input)}}};
 runInNewContext(source('batch-page.js'),ctx);return {browser,nodes,updated,removed,ports,updates,scripts,pageEvents,get currentUrl(){return currentUrl;}};
}

test('页面在首次tabs.get尚未返回时停止，不会随后导航或注入；现有手动记录也不导航',async()=>{
 let release:any;const pending=new Promise(r=>release=r),h=pageHarness({get:()=>pending}),observe=h.browser.observe(row(),Date.now()+60000);await tick();await h.browser.stop();release({id:9,url:row().url});await assert.rejects(()=>observe,/停止/);assert.equal(h.updates.length,0);assert.equal(h.scripts.length,0);
 const manual=pageHarness({manual:true});await assert.rejects(()=>manual.browser.observe(row(),Date.now()+60000),/手动记录/);assert.equal(manual.updates.length,0);
});

test('页面只接收当前Port/nonce且清理导航监听，旧Port和错误nonce不能完成观察',async()=>{
 const h=pageHarness(),pending=h.browser.observe(row(),Date.now()+60000);await tick();h.updated.emit(9,{status:'complete'},{url:row().url});await tick();assert.equal(h.ports.length,1);const port=h.ports[0],bind=port.messages[0];assert.equal(bind.bvid,first);assert.equal(bind.page,1);assert.equal(Object.keys(bind).sort().join(','),'bvid,duration,kind,nonce,page');
 let settled=false;void pending.then(()=>settled=true);port.onMessage.emit({kind:'snapshot',nonce:'b'.repeat(32),snapshot:capture()});await tick();assert.equal(settled,false);
 port.onMessage.emit({kind:'waiting_subtitles',nonce:bind.nonce});port.onMessage.emit({kind:'subtitle_ready',nonce:bind.nonce});h.nodes.continue.handlers.click();
 port.onMessage.emit({kind:'snapshot',nonce:bind.nonce,snapshot:capture()});assert.equal((await pending).bvid,first);assert.equal(h.updated.size,0);assert.equal(h.removed.size,0);assert.equal(port.disconnected,1);port.onMessage.emit({kind:'snapshot',nonce:bind.nonce,snapshot:capture(second)});assert.equal(port.disconnected,1);
});

test('同BV含跟踪参数直接连接现文档，CC期间loading/同BV地址变化不重载或中断',async()=>{
 const h=pageHarness({url:'https://www.bilibili.com/video/'+first+'/?spm=old&p=1'}),pending=h.browser.observe(row(),Date.now()+60000);await tick();assert.equal(h.updates.length,0);assert.equal(h.scripts.length,1);const port=h.ports[0],nonce=port.messages[0].nonce;
 h.updated.emit(9,{status:'loading'},{url:'https://www.bilibili.com/video/'+first+'?p=1&track=changed'});h.updated.emit(9,{url:'https://www.bilibili.com/video/'+first+'?p=1&track=other'},{url:row().url});assert.equal(port.disconnected,0);
 port.onMessage.emit({kind:'waiting_subtitles',nonce});assert.equal(h.nodes.continue.disabled,true);h.nodes.continue.handlers.click();assert.equal(port.messages.some(m=>m.kind==='continue'),false);
 port.onMessage.emit({kind:'subtitle_ready',nonce});assert.equal(h.nodes.continue.disabled,false);h.nodes.continue.handlers.click();assert.equal(port.messages.filter(m=>m.kind==='continue').length,1);
 port.onMessage.emit({kind:'snapshot',nonce,snapshot:capture()});await pending;assert.equal(h.updates.length,0);
});

test('换BV只导航一次，新文档连接后等字幕确认，不能在确认前接受快照',async()=>{
 const h=pageHarness(),pending=h.browser.observe(row(second),Date.now()+60000);await tick();assert.equal(h.updates.length,1);assert.equal(h.scripts.length,0);h.updated.emit(9,{status:'complete'},{url:row(second).url});await tick();const port=h.ports[0],nonce=port.messages[0].nonce;port.onMessage.emit({kind:'waiting_subtitles',nonce});assert.equal(h.nodes.continue.disabled,true);port.onMessage.emit({kind:'snapshot',nonce,snapshot:capture(second)});await assert.rejects(()=>pending,/尚未确认/);assert.equal(port.disconnected,1);
});

test('观察期间外部导航立即失败，断开内容控制且不创建新标签',async()=>{
 const h=pageHarness(),pending=h.browser.observe(row(),Date.now()+60000);await tick();h.updated.emit(9,{status:'complete'},{url:row().url});await tick();h.updated.emit(9,{url:'https://space.bilibili.com/99'},{url:'https://space.bilibili.com/99'});await assert.rejects(()=>pending,/切换/);assert.equal(h.ports[0].disconnected,1);assert.equal(h.updates.length,0);
});

function playerHarness(options:any={}){
 let wall=Date.now(),connect:any,stops=0,starts=0,plays=0,pauses=0,payload:any=options.manual?{captureStatus:'recording',segments:[]}:null;const intervals=new Map<number,any>(),timeouts=new Map<number,any>();let next=1;
 const video:any={duration:20,currentTime:options.seeking?5:0,seeking:!!options.seeking,readyState:4,muted:false,pause(){pauses++;},play(){plays++;return options.blocked?Promise.reject(Error('blocked')):Promise.resolve();}};
 const panel={innerText:options.subtitle===false?'':'实际DOM字幕'},wrap={querySelector:()=>panel};
 const ctx:any={URL,Date:class extends Date{static now(){return wall;}},location:{href:row().url},document:{querySelector:selector=>selector==='video'?video:selector==='.bpx-player-subtitle-wrap'?wrap:null},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),setInterval:fn=>{const id=next++;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id),setTimeout:fn=>{const id=next++;timeouts.set(id,fn);return id;},clearTimeout:id=>timeouts.delete(id),ThemeRadarVisibleCaptionCollector:{status:()=>payload,start(){starts++;payload={captureStatus:'recording',segments:[]};},stop(){stops++;payload={...payload,captureStatus:'stopped'};}},chrome:{runtime:{id:'a'.repeat(32),onConnect:{addListener:fn=>connect=fn}}}};
 runInNewContext(source('batch-player.js'),ctx);const port=fakePort();connect(port);
 return {port,video,panel,bind(start=true){port.onMessage.emit({kind:'bind',nonce:'c'.repeat(32),bvid:first,page:1,duration:20});if(start){wall+=500;for(const fn of [...intervals.values()])fn();port.onMessage.emit({kind:'continue',nonce:'c'.repeat(32)});}},continue(){port.onMessage.emit({kind:'continue',nonce:'c'.repeat(32)});},advance(ms:number){wall+=ms;for(const fn of [...intervals.values()])fn();},end(){payload=capture();},get starts(){return starts;},get stops(){return stops;},get plays(){return plays;},get pauses(){return pauses;},get intervals(){return intervals.size;}};
}

test('内容Port断开和心跳超时停止自有采集/播放；不停止原手动记录',async()=>{
 for(const mode of ['disconnect','timeout']){const h=playerHarness();h.bind();await tick();assert.equal(h.starts,1);assert.equal(h.plays,1);if(mode==='disconnect')h.port.onDisconnect.emit();else h.advance(11000);assert.equal(h.stops,1);assert.equal(h.pauses,2);assert.equal(h.video.muted,false);assert.equal(h.intervals,0);h.port.onDisconnect.emit();assert.equal(h.stops,1);}
 const manual=playerHarness({manual:true});manual.bind();await tick();assert.equal(manual.starts,0);assert.equal(manual.stops,0);assert.equal(manual.pauses,0);assert.equal(manual.plays,0);assert.equal(manual.port.messages[0].kind,'failed');
});

test('内容绑定只等待用户CC，实际字幕出现和显式continue后才归零/静音/记录',async()=>{
 const h=playerHarness({subtitle:false});h.video.currentTime=7;h.bind(false);await tick();assert.equal(h.port.messages[0].kind,'waiting_subtitles');assert.equal(h.starts,0);assert.equal(h.plays,0);assert.equal(h.pauses,0);assert.equal(h.video.muted,false);assert.equal(h.video.currentTime,7);
 h.continue();await tick();assert.equal(h.starts,0);h.panel.innerText='用户开启CC后实际字幕';h.advance(500);assert.equal(h.port.messages.at(-1).kind,'subtitle_ready');assert.equal(h.starts,0);h.continue();await tick();assert.equal(h.starts,1);assert.equal(h.video.currentTime,0);assert.equal(h.video.muted,true);assert.equal(h.plays,1);h.port.onDisconnect.emit();assert.equal(h.video.muted,false);
 const expired=playerHarness({subtitle:false});expired.bind(false);for(let i=0;i<10;i++){expired.advance(9000);expired.port.onMessage.emit({kind:'heartbeat',nonce:'c'.repeat(32)});}assert.equal(expired.port.messages.at(-1).code,'NO_VISIBLE_SUBTITLES');assert.equal(expired.starts,0);assert.equal(expired.pauses,0);assert.equal(expired.intervals,0);
});

test('内容脚本启动准备阶段断开恢复静音，错误nonce不接受控制，完成先清理再返回',async()=>{
 const seek=playerHarness({seeking:true});seek.bind();await tick();assert.equal(seek.video.muted,true);seek.port.onDisconnect.emit();assert.equal(seek.video.muted,false);assert.equal(seek.starts,0);assert.equal(seek.stops,0);
 const bad=playerHarness();bad.bind();await tick();bad.port.onMessage.emit({kind:'heartbeat',nonce:'d'.repeat(32)});assert.equal(bad.stops,1);assert.equal(bad.port.messages.at(-1).kind,'failed');
 const ended=playerHarness();ended.bind();await tick();ended.end();ended.advance(500);assert.equal(ended.port.messages.at(-1).kind,'snapshot');assert.equal(ended.pauses,2);assert.equal(ended.intervals,0);
});
