(function(root){
 'use strict';
 function identity(url){try{const u=new URL(url),m=/^\/video\/(BV[0-9a-zA-Z]{10})\/?$/.exec(u.pathname);return u.protocol==='https:'&&u.hostname==='www.bilibili.com'&&!u.port&&!u.username&&!u.password&&u.searchParams.getAll('p').length<=1&&m&&Number(u.searchParams.get('p')||1)===1?m[1]:null;}catch{return null;}}
 function crop(probe,imageWidth,imageHeight){
  if(!probe||!identity(probe.url)||probe.paused!==true||!Number.isFinite(probe.time)||probe.time<0||!Number.isFinite(probe.duration)||probe.duration<=0||probe.time>probe.duration||probe.visible!==true)throw Error('请暂停当前B站P1视频，让画面字幕清楚显示后再导出。');
  const {left,top,width,height,viewportWidth,viewportHeight}=probe;
  if(![left,top,width,height,viewportWidth,viewportHeight,imageWidth,imageHeight].every(Number.isFinite)||left<0||top<0||width<160||height<90||left+width>viewportWidth+1||top+height>viewportHeight+1||imageWidth<1||imageHeight<1||imageWidth>16000||imageHeight>16000)throw Error('请让整个播放器位于屏幕内，退出画中画后重试。');
  const sx=imageWidth/viewportWidth,sy=imageHeight/viewportHeight;if(Math.abs(sx-sy)>Math.max(sx,sy)*0.03)throw Error('窗口尺寸已改变，本次测试图未导出。');
  let x=left,y=top,w=width,h=height;
  if(probe.fit==='contain'&&probe.videoWidth>0&&probe.videoHeight>0){const scale=Math.min(width/probe.videoWidth,height/probe.videoHeight);w=probe.videoWidth*scale;h=probe.videoHeight*scale;x+=(width-w)/2;y+=(height-h)/2;}
  y+=h*0.55;h*=0.45;
  const box={x:Math.floor(x*sx),y:Math.floor(y*sy),width:Math.floor(w*sx),height:Math.floor(h*sy)};
  if(box.width<80||box.height<30||box.x<0||box.y<0||box.x+box.width>imageWidth||box.y+box.height>imageHeight)throw Error('视频字幕区域无效，未导出其他页面内容。');
  const scale=Math.min(1,1600/box.width,900/box.height);return {...box,outputWidth:Math.max(1,Math.round(box.width*scale)),outputHeight:Math.max(1,Math.round(box.height*scale))};
 }
 function sameFrame(before,after){return !!before&&!!after&&identity(before.url)===identity(after.url)&&identity(before.url)!==null&&after.paused===true&&after.visible===true&&Math.abs(after.time-before.time)<=0.1&&['left','top','width','height','viewportWidth','viewportHeight'].every(k=>Math.abs(after[k]-before[k])<1);}
 root.ThemeRadarFrameCore=Object.freeze({identity,crop,sameFrame});
})(globalThis);
