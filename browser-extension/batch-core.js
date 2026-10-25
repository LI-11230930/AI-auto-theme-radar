(function(root){
  'use strict';
  const localOrigin='http://127.0.0.1:8767',permission=localOrigin+'/*',failureCodes=['NO_VISIBLE_SUBTITLES','PLAYER_UNAVAILABLE','PLAYBACK_BLOCKED','CAPTURE_INTERRUPTED','CAPTURE_BUDGET','IMPORT_FAILED'];
  function itemIdentity(url){try{const u=new URL(url),m=/^\/video\/(BV[0-9a-zA-Z]{10})\/?$/.exec(u.pathname);return u.protocol==='https:'&&u.hostname==='www.bilibili.com'&&!u.port&&!u.username&&!u.password&&m&&Number(u.searchParams.get('p')||1)===1?m[1]:null;}catch{return null;}}
  function validateStatus(value,now=Date.now()){
    if(!value||typeof value!=='object'||typeof value.batchId!=='string'||value.state!=='paired'||!Array.isArray(value.items)||value.items.length<1||value.items.length>3||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=now||Date.parse(value.expiresAt)>now+20*60000+2000)throw Error('本次授权无效或已到期，请在本地重新创建批次。');
    const keys=new Set();let duration=0;
    for(const item of value.items){if(!item||typeof item.itemKey!=='string'||item.itemKey!=='bilibili:'+item.bvid||keys.has(item.itemKey)||item.page!==1||item.url!=='https://www.bilibili.com/video/'+item.bvid+'?p=1'||itemIdentity(item.url)!==item.bvid||!Number.isFinite(item.duration)||item.duration<=0||item.duration>900||!['pending','imported','failed'].includes(item.state))throw Error('采集清单不符合本次有界范围，已停止。');keys.add(item.itemKey);duration+=item.duration;}
    if(duration>1000)throw Error('采集总时长超出预算，已停止。');return value;
  }
  function validateCapture(item,value){if(!value||value.schema!=='theme-radar-visible-subtitles-v1'||value.bvid!==item.bvid||value.page!==1||!Number.isFinite(value.duration)||Math.abs(value.duration-item.duration)>2||value.captureStatus!=='ended'||value.truncated!==false||!Number.isFinite(value.observedFrom)||value.observedFrom<0||value.observedFrom>2||!Number.isFinite(value.observedTo)||value.observedTo<value.duration-2||!Array.isArray(value.segments)||value.segments.length<1)throw Object.assign(Error('观察被中断、没有实际字幕或超出范围，未提交。'),{code:'CAPTURE_INTERRUPTED'});return value;}
  function createClient(fetcher,options={}){
    let token=null;const timeout=options.timeout||10000;
    async function request(path,body,useToken=true){
      if(!['pair','manifest','capture','fail','cancel'].includes(path))throw Error('采集端点不受支持');
      if(useToken&&!token)throw Error('配对凭据已清除，请重新创建批次。');
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeout);
      try{
        const response=await fetcher(localOrigin+'/bridge/browser-batch/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(useToken?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),credentials:'omit',redirect:'error',cache:'no-store',signal:abort.signal});
        if(!response.ok)throw Error('本地采集服务拒绝本次请求（'+response.status+'）。请检查验证台状态，勿重复配对旧码。');
        const data=await response.json();if(!data||typeof data!=='object')throw Error('本地服务返回格式无效。');return data;
      }finally{clearTimeout(timer);}
    }
    return {async pair(code){if(token)throw Error('本页已配对，请先停止。');if(typeof code!=='string'||!/^[A-F0-9]{12}$/.test(code))throw Error('配对码应为12位十六进制字符。');const data=await request('pair',{pairCode:code},false);if(typeof data.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.token))throw Error('本地服务未返回有效凭据。');validateStatus(data);token=data.token;const {token:discard,...status}=data;return status;},manifest:()=>request('manifest',{}),capture:(itemKey,snapshot)=>request('capture',{itemKey,snapshot}),fail:(itemKey,code)=>{if(!failureCodes.includes(code))throw Error('停止原因不受支持');return request('fail',{itemKey,code});},async cancel(){try{if(token)await request('cancel',{});}finally{token=null;}},clear(){token=null;}};
  }
  function createRunner({client,browser,onState=()=>{},clock=Date.now}){
    let generation=0,running=false,active=null;
    async function cancel(){generation++;running=false;await browser.stop();await client.cancel();onState('已停止；已导入观察保留，本次授权已撤销。');}
    async function run(initial){
      if(running)throw Error('批次已在运行');validateStatus(initial,clock());
      const current=++generation;running=true;
      try{
        for(const frozen of initial.items){
          if(frozen.state!=='pending')continue;
          if(current!==generation)throw Error('采集已停止。');
          const status=validateStatus(await client.manifest(),clock()),item=status.items.find(i=>i.itemKey===frozen.itemKey);
          if(current!==generation)throw Error('采集已停止。');
          if(status.batchId!==initial.batchId||!item||item.url!==frozen.url||item.duration!==frozen.duration||item.state!=='pending')throw Error('批次或材料状态已改变，停止继续采集。');
          active=item;onState('正在观察 '+item.bvid+' · P1；请保持字幕开启，不要拖动进度。');
          const snapshot=validateCapture(item,await browser.observe(item,Date.parse(status.expiresAt)));
          if(current!==generation)throw Error('采集已停止，未提交后续内容。');
          await browser.stop();
          if(current!==generation)throw Error('采集已停止，未提交后续内容。');
          const imported=await client.capture(item.itemKey,snapshot);
          if(!imported?.status||imported.status.batchId!==initial.batchId||!imported.status.items?.some(i=>i.itemKey===item.itemKey&&i.state==='imported'))throw Error('未取得导入确认，请在本地验证台核对。');
          active=null;onState('已导入 '+item.bvid+' 的可见字幕观察。');
        }
        if(current===generation){await client.cancel();onState('本批已完成，采集授权已撤销。观察与模型阅读分开记录。');}
      }catch(error){
        await browser.stop();
        if(current===generation){if(active&&failureCodes.includes(error.code))try{await client.fail(active.itemKey,error.code);}catch{}try{await client.cancel();}catch{}throw error;}
      }finally{if(current===generation){running=false;active=null;}}
    }
    return {run,cancel,get running(){return running;}};
  }
  root.ThemeRadarBatchCore=Object.freeze({localOrigin,permission,itemIdentity,validateStatus,validateCapture,createClient,createRunner});
})(globalThis);
