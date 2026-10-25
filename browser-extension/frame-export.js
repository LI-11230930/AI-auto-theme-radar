(() => {
 'use strict';
 const button=document.getElementById('frame-export'),status=document.getElementById('status'),core=globalThis.ThemeRadarFrameCore;
 async function probe(tabId){const results=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:()=>{const v=document.querySelector('video');if(!v)throw Error('没有播放器');const r=v.getBoundingClientRect();return {url:location.href,paused:v.paused,time:v.currentTime,duration:v.duration,visible:document.visibilityState==='visible'&&!document.pictureInPictureElement,left:r.left,top:r.top,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,fit:getComputedStyle(v).objectFit,videoWidth:v.videoWidth,videoHeight:v.videoHeight};}});return results.find(r=>r.frameId===0)?.result;}
 button.addEventListener('click',async()=>{
  button.disabled=true;let objectUrl;
  try{
   const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!Number.isSafeInteger(tab?.id)||!core.identity(tab.url))throw Error('请在当前B站P1视频页点击此按钮。');
   const before=await probe(tab.id);if(!before?.paused)throw Error('请先暂停在能看清画面字幕的位置，再点击导出测试图；不需要开启CC。');
   const [active]=await chrome.tabs.query({active:true,windowId:tab.windowId});if(active?.id!==tab.id)throw Error('当前标签已改变，未采集。');
   const pixels=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
   const [afterTab]=await chrome.tabs.query({active:true,windowId:tab.windowId}),after=await probe(tab.id);
   if(afterTab?.id!==tab.id||!core.sameFrame(before,after))throw Error('画面或标签发生变化，未导出测试图。');
   const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('无法读取本次画面'));img.src=pixels;});
   const box=core.crop(before,img.naturalWidth,img.naturalHeight),canvas=document.createElement('canvas');canvas.width=box.outputWidth;canvas.height=box.outputHeight;
   canvas.getContext('2d').drawImage(img,box.x,box.y,box.width,box.height,0,0,canvas.width,canvas.height);
   const imagePng=canvas.toDataURL('image/png');if(imagePng.length>2800000)throw Error('测试图超过大小预算，请缩小播放器后重试。');
   const bvid=core.identity(before.url),snapshot={schema:'theme-radar-visible-frame-v1',bvid,page:1,time:before.time,duration:before.duration,observedAt:new Date().toISOString(),region:'video-bottom-45pct',width:canvas.width,height:canvas.height,imagePng};
   const file=new Blob([JSON.stringify(snapshot)],{type:'application/json'});objectUrl=URL.createObjectURL(file);const a=document.createElement('a');a.href=objectUrl;a.download='theme-radar-frame-'+bvid+'-'+Math.round(before.time*1000)+'.json';a.click();
   status.textContent='已导出一个视频下部画面测试JSON（无需CC）。只保存本机文件，未上传、OCR、归档或调用模型。请提供文件路径以验证真实字幕识别。';
  }catch(error){status.textContent=error.message||'测试图未导出。';}finally{button.disabled=false;if(objectUrl)setTimeout(()=>URL.revokeObjectURL(objectUrl),10000);}
 });
})();
