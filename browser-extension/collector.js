(() => {
  'use strict';
  if(globalThis.ThemeRadarVisibleCaptionCollector)return;
  globalThis.__themeRadarVisibleCaptionCollector=true;
  let recording=null,video=null,observer=null,timer=null,identity=null,handlers=[];
  function pageIdentity(){const u=new URL(location.href),m=/^\/video\/(BV[0-9a-zA-Z]{10})\/?$/.exec(u.pathname),page=Number(u.searchParams.get('p')||1);if(u.protocol!=='https:'||u.hostname!=='www.bilibili.com'||!m||!Number.isSafeInteger(page)||page<1||page>10000)throw Error('仅支持当前B站视频页');return {bvid:m[1],page};}
  function subtitle(){const wrap=document.querySelector('.bpx-player-subtitle-wrap'),panel=wrap?.querySelector('.bili-subtitle-x-subtitle-panel');if(!panel)return '';const css=getComputedStyle(panel);return css.display==='none'||css.visibility==='hidden'||Number(css.opacity)===0?'':panel.innerText.trim();}
  function cleanup(){observer?.disconnect();clearInterval(timer);for(const [event,fn] of handlers)video?.removeEventListener(event,fn);handlers=[];}
  function finish(reason='stopped'){if(recording&&!recording.stopped)recording.stop(reason==='discontinuity'?recording.snapshot().observedTo:video?.currentTime,reason);cleanup();return payload();}
  function tick(){if(!recording||recording.stopped)return;try{const p=pageIdentity();if(p.bvid!==identity.bvid||p.page!==identity.page||document.querySelector('video')!==video){finish('discontinuity');return;}recording.sample(video.currentTime,subtitle());if(recording.stopped)cleanup();}catch{finish('discontinuity');}}
  function payload(){return recording?{schema:'theme-radar-visible-subtitles-v1',...identity,...recording.snapshot()}:null;}
  function start(){if(recording&&!recording.stopped)throw Error('已有正在进行的记录，请先停止');identity=pageIdentity();video=document.querySelector('video');const wrap=document.querySelector('.bpx-player-subtitle-wrap');if(!video||!wrap||!Number.isFinite(video.duration))throw Error('请先加载播放器并启用中文字幕');
    recording=globalThis.ThemeRadarCaptionCore.createRecorder({duration:video.duration,start:video.currentTime});
    handlers=[['timeupdate',tick],['ended',()=>finish('ended')],['seeking',()=>finish('discontinuity')],['emptied',()=>finish('discontinuity')]];
    for(const [event,fn] of handlers)video.addEventListener(event,fn);
    observer=new MutationObserver(tick);observer.observe(wrap,{subtree:true,childList:true,characterData:true});
    const deadline=Date.now()+30*60000;timer=setInterval(()=>Date.now()>=deadline?finish('budget_reached'):tick(),500);tick();return payload();
  }
  globalThis.ThemeRadarVisibleCaptionCollector=Object.freeze({start,stop:finish,status:payload});
  chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
    if(!message||!['start','stop','status'].includes(message.kind)||Object.keys(message).some(k=>k!=='kind'))return;
    try{const data=message.kind==='start'?start():message.kind==='stop'?finish():payload();reply({ok:true,data});}catch{reply({ok:false,error:'未开始记录，请确认B站视频已加载、字幕已开启，且没有其他记录正在进行。'});}
  });
})();
