(function (root) {
  'use strict';
  function createRecorder({duration,start,clock=Date.now,maxCharacters=40000,maxSegments=1000}) {
    if(!Number.isFinite(duration)||duration<=0||duration>43200||!Number.isFinite(start)||start<0||start>duration)throw Error('视频时长或开始位置无效');
    const startedAt=new Date(clock()).toISOString(),segments=[];let current=null,last=start,characters=0,stopped=false,truncated=false,reason=null,endedAt=null;
    const flush=t=>{if(!current)return;const end=Math.max(current.from,Math.min(t,duration));if(end>current.from){segments.push({from:current.from,to:end,text:current.text});characters+=current.text.length;}current=null;};
    function stop(time,status='stopped') {if(stopped)return snapshot();const at=Number.isFinite(time)?Math.min(duration,Math.max(start,time)):last;flush(at);last=at;stopped=true;reason=status;truncated=truncated||status==='budget_reached';endedAt=new Date(clock()).toISOString();return snapshot();}
    function sample(time,text) {
      if(stopped)return;
      if(!Number.isFinite(time)||time<last-0.25||time>duration+1){stop(last,'discontinuity');return;}
      last=Math.min(duration,Math.max(start,time));text=typeof text==='string'?text.trim():'';
      if(current?.text===text)return;
      flush(last);
      if(text){if(segments.length>=maxSegments||text.length>1000||characters+text.length>maxCharacters){truncated=true;stop(last,'budget_reached');return;}current={from:last,text};}
    }
    function snapshot(){return {startedAt,endedAt,observedFrom:start,observedTo:last,duration,segments:segments.map(s=>({...s})),truncated,captureStatus:stopped?reason:'recording'};}
    return {sample,stop,snapshot,get stopped(){return stopped;}};
  }
  root.ThemeRadarCaptionCore={createRecorder};
})(globalThis);
