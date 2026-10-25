(() => {
  'use strict';
  const core=globalThis.ThemeRadarBatchCore,ui={form:document.getElementById('pair-form'),code:document.getElementById('pair-code'),pair:document.getElementById('pair'),run:document.getElementById('run'),next:document.getElementById('continue'),stop:document.getElementById('stop'),items:document.getElementById('items'),status:document.getElementById('status')};
  const parameters=new URL(location.href).searchParams,tabId=Number(parameters.get('tabId'));
  let paired=null,busy=false,active=null,unloading=false,cancellation=0;
  const show=text=>ui.status.textContent=text;
  const client=core.createClient((...args)=>fetch(...args));
  const failureMessages={NO_VISIBLE_SUBTITLES:'90秒准备期未确认可见字幕，或开始播放后15秒仍未记录到字幕；请先确认播放器CC可显示实际字幕。',PLAYER_UNAVAILABLE:'播放器或字幕容器未就绪。',PLAYBACK_BLOCKED:'浏览器未允许本次播放。',CAPTURE_INTERRUPTED:'视频身份、播放进度或当前记录状态发生变化，本条已停止。',CAPTURE_BUDGET:'本次观察达到时间预算。'};
  function buttons(){ui.pair.disabled=busy||!!paired;ui.code.disabled=busy||!!paired;ui.run.disabled=busy||!paired;ui.next.disabled=!active?.canContinue;ui.stop.disabled=!paired;}
  function cleanupActive(job){if(job.cleaned)return;job.cleaned=true;clearInterval(job.heartbeat);clearTimeout(job.deadline);chrome.tabs.onUpdated.removeListener(job.updated);chrome.tabs.onRemoved.removeListener(job.removed);if(job.port)try{job.port.disconnect();}catch{}if(active===job)active=null;ui.next.disabled=true;}
  async function stop(){
    cancellation++;
    const job=active;if(!job)return;
    if(job.port&&!job.cleaned){await new Promise(resolve=>{const timer=setTimeout(resolve,1000);job.stopAck=()=>{clearTimeout(timer);resolve();};try{job.port.postMessage({kind:'stop',nonce:job.nonce});}catch{clearTimeout(timer);resolve();}});}
    cleanupActive(job);job.reject(Object.assign(Error('采集已停止。'),{code:'CAPTURE_INTERRUPTED'}));
  }
  async function observe(item,expiresAt){
    if(active)throw Error('已有活动页面观察。');
    const attempt=cancellation;
    const current=await chrome.tabs.get(tabId);
    if(attempt!==cancellation||unloading)throw Object.assign(Error('采集已停止。'),{code:'CAPTURE_INTERRUPTED'});
    if(!core.itemIdentity(current.url))throw Object.assign(Error('原B站标签页已改变，请重新从该视频页打开扩展。'),{code:'CAPTURE_INTERRUPTED'});
    let prior=null;try{prior=await chrome.tabs.sendMessage(tabId,{kind:'status'});}catch{}
    if(attempt!==cancellation||unloading)throw Object.assign(Error('采集已停止。'),{code:'CAPTURE_INTERRUPTED'});
    if(prior?.ok&&prior.data?.captureStatus==='recording')throw Object.assign(Error('原标签页正在手动记录；请先停止并导出，批次未导航。'),{code:'CAPTURE_INTERRUPTED'});
    const bytes=crypto.getRandomValues(new Uint8Array(16)),nonce=Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');
    return new Promise((resolve,reject)=>{
      const job={nonce,port:null,cleaned:false,heartbeat:null,deadline:null,updated:null,removed:null,reject,canContinue:false,captureApproved:false,captureStarted:false};active=job;
      const fail=error=>{if(job.cleaned)return;cleanupActive(job);reject(error);};
      const broken=reason=>fail(Object.assign(Error(reason),{code:'CAPTURE_INTERRUPTED'}));
      const sameVideo=core.itemIdentity(current.url)===item.bvid;
      let loading=!sameVideo||current.status==='loading',injected=false;
      job.updated=(id,change,tab)=>{if(id!==tabId||job.cleaned)return;const target=change.url||(!loading||change.status==='complete'?tab?.url:null);if(target&&core.itemIdentity(target)!==item.bvid){broken('原标签页切换了BV号、分P或站点；本条已停止。');return;}if(loading&&change.status==='complete'){loading=false;void inject();}};
      job.removed=id=>{if(id===tabId)broken('原B站标签页已关闭；本条已停止。');};
      chrome.tabs.onUpdated.addListener(job.updated);chrome.tabs.onRemoved.addListener(job.removed);
      job.deadline=setTimeout(()=>fail(Object.assign(Error('本次观察超过授权时间。'),{code:'CAPTURE_BUDGET'})),Math.max(1,Math.min(expiresAt-Date.now(),(item.duration+185)*1000)));
      async function inject(){
        if(injected||job.cleaned)return;injected=true;
        try{
          const check=await chrome.tabs.get(tabId);if(job.cleaned||attempt!==cancellation||unloading)return;if(core.itemIdentity(check.url)!==item.bvid)throw Error('视频已切换');
          await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},files:['caption-core.js','collector.js','batch-player.js']});
          if(job.cleaned||attempt!==cancellation||unloading)return;
          const port=chrome.tabs.connect(tabId,{name:'theme-radar-batch-v1',frameId:0});job.port=port;
          port.onMessage.addListener(message=>{
            if(job.cleaned||active!==job||!message||message.nonce!==nonce)return;
            if(message.kind==='failed')fail(Object.assign(Error(failureMessages[message.code]||'采集中断。'),{code:message.code}));
            else if(message.kind==='waiting_subtitles'){job.canContinue=false;ui.next.disabled=true;show('已连接 '+item.bvid+'，尚未开始记录。请在原视频页手动开启CC并播放到字幕实际显示，再回本页点击“字幕已显示，开始本条”。准备期最多90秒。');}
            else if(message.kind==='subtitle_ready'){job.canContinue=true;ui.next.disabled=false;show('已观察到 '+item.bvid+' 的可见字幕。点击“字幕已显示，开始本条”后才会静音、从头记录。');}
            else if(message.kind==='snapshot'){try{if(!job.captureApproved)throw Object.assign(Error('尚未确认开始，本条未接收字幕。'),{code:'CAPTURE_INTERRUPTED'});const snapshot=core.validateCapture(item,message.snapshot);cleanupActive(job);resolve(snapshot);}catch(error){fail(error);}}
            else if(message.kind==='stopped')job.stopAck?.();
            else if(message.kind==='started'){job.captureStarted=true;job.canContinue=false;ui.next.disabled=true;show('正在静音播放并观察 '+item.bvid+'；尚未取得导入确认。');}
          });
          port.onDisconnect.addListener(()=>{if(!job.cleaned)broken(job.captureStarted?'记录期间控制连接断开，可能视频页刷新或扩展重载；本条已停止。':'播放器准备期间控制连接断开，尚未开始记录。请保持原页不刷新并重新创建批次。');});
          port.postMessage({kind:'bind',nonce,bvid:item.bvid,page:1,duration:item.duration});
          job.heartbeat=setInterval(()=>{if(job.cleaned)return;try{port.postMessage({kind:'heartbeat',nonce});}catch{broken('控制心跳连接断开，本条已停止。');}},2000);
        }catch{fail(Object.assign(Error('不能控制刚才授权的B站标签页，请核对扩展版本与页面状态。'),{code:'PLAYER_UNAVAILABLE'}));}
      }
      if(sameVideo){if(!loading)void inject();}
      else void chrome.tabs.update(tabId,{url:item.url}).then(tab=>{if(!job.cleaned&&tab.status==='complete'){loading=false;void inject();}},()=>fail(Object.assign(Error('无法导航当前B站标签页。'),{code:'PLAYER_UNAVAILABLE'})));
    });
  }
  const runner=core.createRunner({client,browser:{observe,stop},onState:show});
  ui.next.addEventListener('click',()=>{const job=active;if(!job||job.cleaned||!job.canContinue||!job.port)return;job.canContinue=false;job.captureApproved=true;ui.next.disabled=true;try{job.port.postMessage({kind:'continue',nonce:job.nonce});show('正在准备从头记录；请不要拖动播放器进度。');}catch{show('控制连接已断开，请停止本批次。');}});
  ui.form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||paired)return;
    if(!Number.isSafeInteger(tabId)||tabId<0||[...parameters.keys()].some(k=>k!=='tabId')){show('入口无效，请从B站视频页点击扩展按钮打开本页。');return;}
    const code=ui.code.value.trim().toUpperCase();if(!/^[A-F0-9]{12}$/.test(code)){show('请输入12位配对码。');return;}
    busy=true;buttons();
    try{
      const granted=await chrome.permissions.request({origins:[core.permission]});
      if(!granted)throw Error('尚未授权本机8767访问，未配对、未采集。');
      paired=await client.pair(code);ui.code.value='';ui.items.replaceChildren();
      for(const item of paired.items){const li=document.createElement('li'),link=document.createElement('a');link.href=item.url;link.target='_blank';link.rel='noreferrer noopener';link.textContent=item.bvid+' · P1 · '+Math.round(item.duration)+'秒';li.append(link);ui.items.append(li);}
      show('配对成功，共'+paired.items.length+'条。核对清单后点击“连接视频并准备字幕”；每条看到实际字幕后单独确认开始。本页关闭后无法恢复。');
    }catch(error){show(error.message||'配对失败。');}finally{busy=false;buttons();}
  });
  ui.run.addEventListener('click',async()=>{if(busy||!paired)return;busy=true;buttons();try{await runner.run(paired);}catch(error){show((error.message||'批次中断。')+' 请在本地验证台核对已导入条目，再创建新批次。');}finally{paired=null;client.clear();busy=false;buttons();}});
  ui.stop.addEventListener('click',async()=>{if(!paired)return;ui.stop.disabled=true;try{await runner.cancel();}catch{show('页面控制已停止；撤销请求未确认，请在本地验证台取消本批次。');}finally{paired=null;client.clear();busy=false;buttons();}});
  addEventListener('pagehide',()=>{unloading=true;cancellation++;if(active)cleanupActive(active);client.clear();});
  addEventListener('beforeunload',event=>{if(!unloading&&(busy||paired)){event.preventDefault();event.returnValue='';}});
  buttons();
})();
