(() => {
  'use strict';
  const button=document.getElementById('batch-open');
  button.addEventListener('click',async()=>{
    button.disabled=true;
    try{
      const [current]=await chrome.tabs.query({active:true,currentWindow:true}),u=new URL(current?.url||'about:blank');
      if(!Number.isSafeInteger(current?.id)||u.protocol!=='https:'||u.hostname!=='www.bilibili.com'||!/^\/video\/BV[0-9a-zA-Z]{10}\/?$/.test(u.pathname))throw Error('请先在当前B站视频页点击扩展图标，再打开批次。');
      await chrome.tabs.create({url:chrome.runtime.getURL('batch.html')+'?tabId='+current.id});
    }catch(error){document.getElementById('status').textContent=error.message||'无法打开批次。';}
    finally{button.disabled=false;}
  });
})();
