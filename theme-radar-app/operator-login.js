(() => {
 const el=id=>document.getElementById(id);let timer=null;
 const messages={idle:'尚未开始扫码',waiting_scan:'请用B站手机App扫码',waiting_confirm:'已扫码，请在手机确认',saved:'登录已保存，可以读取视频字幕',expired:'二维码已过期，请重新生成'};
 async function post(action){const state=await(await fetch('/api/state',{cache:'no-store'})).json();const r=await fetch('/api/bilibili/login/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':state.token},body:'{}'});const data=await r.json();if(!r.ok)throw Error(data.error||'登录未完成');return data;}
 function stop(){clearTimeout(timer);timer=null;}
 function show(data){el('bili-login-status').textContent=messages[data.state]||data.state;if(data.saved){stop();el('bili-login-image').hidden=true;}}
 async function poll(){try{const data=await post('poll');show(data);if(!data.saved)timer=setTimeout(poll,4000);}catch(e){stop();el('bili-login-status').textContent=e.message;}}
 el('bili-login-start').onclick=async()=>{stop();el('bili-login-start').disabled=true;try{const data=await post('start');show(data);el('bili-login-image').src=data.image;el('bili-login-image').hidden=false;timer=setTimeout(poll,4000);}catch(e){el('bili-login-status').textContent=e.message;}finally{el('bili-login-start').disabled=false;}};
 el('bili-login-cancel').onclick=async()=>{stop();try{show(await post('cancel'));el('bili-login-image').hidden=true;}catch(e){el('bili-login-status').textContent=e.message;}};
 window.addEventListener('pagehide',stop);
})();
