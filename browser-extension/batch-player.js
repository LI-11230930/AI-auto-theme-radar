(() => {
  'use strict';
  if(globalThis.__themeRadarBatchPlayer)return;
  globalThis.__themeRadarBatchPlayer=true;
  let occupied=false;
  const identity=()=>{try{const u=new URL(location.href),m=/^\/video\/(BV[0-9a-zA-Z]{10})\/?$/.exec(u.pathname);return u.protocol==='https:'&&u.hostname==='www.bilibili.com'&&!u.port&&m&&Number(u.searchParams.get('p')||1)===1?m[1]:null;}catch{return null;}};
  const visible=panel=>{if(!panel)return false;const css=getComputedStyle(panel);return css.display!=='none'&&css.visibility!=='hidden'&&Number(css.opacity)!==0;};
  chrome.runtime.onConnect.addListener(port=>{
    let source;try{source=new URL(port.sender?.url||'about:blank');}catch{return;}
    if(port.name!=='theme-radar-batch-v1'||port.sender?.id!==chrome.runtime.id||source.protocol!=='chrome-extension:'||source.hostname!==chrome.runtime.id||source.pathname!=='/batch.html'||occupied){port.disconnect();return;}
    occupied=true;
    let nonce=null,expected=null,video=null,owned=false,mutated=false,recording=false,closed=false,boundAt=Date.now(),heartbeat=Date.now(),began=0,lastProgress=0,lastTime=0,hadSubtitle=false,previousMuted=false,phase='binding',readyDeadline=0,subtitleReady=false;
    const collector=globalThis.ThemeRadarVisibleCaptionCollector;
    const post=value=>{if(!closed)try{port.postMessage({...value,nonce});}catch{cleanup();}};
    function cleanup(){if(closed)return;closed=true;occupied=false;clearInterval(timer);if(recording){try{collector.stop();}catch{}recording=false;}if(document.querySelector('video')===video){if(owned)video.pause();if(mutated&&video.muted===true)video.muted=previousMuted;}owned=false;mutated=false;}
    function fail(code){if(closed)return;post({kind:'failed',code});cleanup();}
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    async function bind(message){
      if(nonce||!message||Object.keys(message).sort().join(',')!=='bvid,duration,kind,nonce,page'||message.kind!=='bind'||typeof message.nonce!=='string'||!/^[a-f0-9]{32}$/.test(message.nonce)||!/^BV[0-9a-zA-Z]{10}$/.test(message.bvid)||message.page!==1||!Number.isFinite(message.duration)||message.duration<=0||message.duration>900){fail('CAPTURE_INTERRUPTED');return;}
      nonce=message.nonce;expected=message;heartbeat=Date.now();
      try{
        if(!collector)throw Object.assign(Error(),{code:'PLAYER_UNAVAILABLE'});
        if(collector.status()?.captureStatus==='recording')throw Object.assign(Error(),{code:'CAPTURE_INTERRUPTED'});
        const deadline=Date.now()+20000;
        while(!closed){
          if(identity()!==expected.bvid)throw Object.assign(Error(),{code:'CAPTURE_INTERRUPTED'});
          video=document.querySelector('video');
          if(video&&Number.isFinite(video.duration)&&video.readyState>=2)break;
          if(Date.now()>deadline)throw Object.assign(Error(),{code:'PLAYER_UNAVAILABLE'});
          await wait(200);
        }
        if(closed)return;
        if(collector.status()?.captureStatus==='recording')throw Object.assign(Error(),{code:'CAPTURE_INTERRUPTED'});
        if(Math.abs(video.duration-expected.duration)>2)throw Object.assign(Error(),{code:'CAPTURE_INTERRUPTED'});
        phase='waiting_subtitles';readyDeadline=Date.now()+90000;
        post({kind:'waiting_subtitles',seconds:90});
      }catch(error){fail(error.code||'PLAYER_UNAVAILABLE');}
    }
    async function beginCapture(){
      if(phase!=='waiting_subtitles')return;
      if(!subtitleReady){post({kind:'waiting_subtitles',seconds:Math.max(0,Math.ceil((readyDeadline-Date.now())/1000))});return;}
      phase='preparing';
      try{
        if(identity()!==expected.bvid)throw Object.assign(Error(),{code:'CAPTURE_INTERRUPTED'});
        video=document.querySelector('video');
        if(!video||!document.querySelector('.bpx-player-subtitle-wrap')||!Number.isFinite(video.duration)||Math.abs(video.duration-expected.duration)>2||video.readyState<2)throw Object.assign(Error(),{code:'PLAYER_UNAVAILABLE'});
        if(collector.status()?.captureStatus==='recording')throw Object.assign(Error(),{code:'CAPTURE_INTERRUPTED'});
        previousMuted=video.muted;
        video.pause();video.muted=true;mutated=true;
        if(video.currentTime>0.1){video.currentTime=0;const seekDeadline=Date.now()+5000;while(!closed&&(video.seeking||video.currentTime>0.2)){if(Date.now()>seekDeadline)throw Object.assign(Error(),{code:'PLAYER_UNAVAILABLE'});await wait(100);}}
        if(closed)return;
        if(identity()!==expected.bvid||document.querySelector('video')!==video||collector.status()?.captureStatus==='recording')throw Object.assign(Error(),{code:'CAPTURE_INTERRUPTED'});
        collector.start();recording=true;phase='capturing';began=lastProgress=Date.now();lastTime=video.currentTime;
        owned=true;
        const play=Promise.resolve(video.play());
        void play.then(()=>{if(closed&&document.querySelector('video')===video)video.pause();},()=>{});
        let playTimer;try{await Promise.race([play,new Promise((_,reject)=>{playTimer=setTimeout(()=>reject(Object.assign(Error(),{code:'PLAYBACK_BLOCKED'})),8000);})]);}finally{clearTimeout(playTimer);}
        if(!closed)post({kind:'started'});
      }catch(error){fail(error.code||'PLAYBACK_BLOCKED');}
    }
    const timer=setInterval(()=>{
      if(closed)return;
      if(Date.now()-heartbeat>10000||(!nonce&&Date.now()-boundAt>5000)){fail('CAPTURE_INTERRUPTED');return;}
      if(nonce&&identity()!==expected.bvid){fail('CAPTURE_INTERRUPTED');return;}
      if(phase==='waiting_subtitles'){
        if(Date.now()>=readyDeadline){fail('NO_VISIBLE_SUBTITLES');return;}
        const panel=document.querySelector('.bpx-player-subtitle-wrap')?.querySelector('.bili-subtitle-x-subtitle-panel');
        if(!subtitleReady&&visible(panel)&&panel.innerText.trim()){subtitleReady=true;post({kind:'subtitle_ready'});}
        return;
      }
      if(!began||!recording)return;
      if(identity()!==expected.bvid||document.querySelector('video')!==video){fail('CAPTURE_INTERRUPTED');return;}
      const panel=document.querySelector('.bpx-player-subtitle-wrap')?.querySelector('.bili-subtitle-x-subtitle-panel');
      if(visible(panel)&&panel.innerText.trim())hadSubtitle=true;
      const snapshot=collector.status();if(snapshot?.segments?.length)hadSubtitle=true;
      if(!hadSubtitle&&Date.now()-began>15000){fail('NO_VISIBLE_SUBTITLES');return;}
      if(video.currentTime>lastTime+0.05){lastProgress=Date.now();lastTime=video.currentTime;}
      if(Date.now()-lastProgress>30000){fail('CAPTURE_INTERRUPTED');return;}
      if(Date.now()-began>(expected.duration+45)*1000){fail('CAPTURE_BUDGET');return;}
      if(snapshot?.captureStatus==='ended'){
        if(!hadSubtitle||!snapshot.segments.length){fail('NO_VISIBLE_SUBTITLES');return;}
        recording=false;cleanup();try{port.postMessage({kind:'snapshot',snapshot,nonce});}catch{}return;
      }
      if(snapshot?.captureStatus!=='recording')fail(snapshot?.captureStatus==='budget_reached'?'CAPTURE_BUDGET':'CAPTURE_INTERRUPTED');
    },500);
    port.onMessage.addListener(message=>{
      if(closed)return;
      if(!nonce){void bind(message);return;}
      if(!message||message.nonce!==nonce||Object.keys(message).sort().join(',')!=='kind,nonce'){fail('CAPTURE_INTERRUPTED');return;}
      if(message.kind==='heartbeat')heartbeat=Date.now();
      else if(message.kind==='continue')void beginCapture();
      else if(message.kind==='stop'){cleanup();try{port.postMessage({kind:'stopped',nonce});}catch{}}
      else fail('CAPTURE_INTERRUPTED');
    });
    port.onDisconnect.addListener(cleanup);
  });
})();
