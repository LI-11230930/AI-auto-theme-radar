(function(root){
 'use strict';
 function snapshot(pageUrl,links,clock=Date.now){
  const u=new URL(pageUrl),m=/^\/([1-9]\d{0,19})\/(?:upload\/video|video)\/?$/.exec(u.pathname);
  if(u.protocol!=='https:'||u.hostname!=='space.bilibili.com'||u.username||u.password||u.port||!m)throw Error('请先进入该UP主的投稿视频页，再导出当前可见链接');
  const seen=new Set(),items=[];let truncated=false;
  for(const link of links){let v;try{v=new URL(link.url,u);}catch{continue;}const b=/^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(v.pathname),title=typeof link.title==='string'?link.title.trim():'';
   if(v.protocol!=='https:'||v.hostname!=='www.bilibili.com'||v.username||v.password||v.port||!b||!title||title.length>500||seen.has(b[1]))continue;
   if(items.length===20){truncated=true;break;}seen.add(b[1]);items.push({bvid:b[1],url:'https://www.bilibili.com/video/'+b[1],title});
  }
  return {schema:'theme-radar-visible-author-v1',pageUrl:'https://space.bilibili.com/'+m[1]+'/upload/video',authorUid:m[1],observedAt:new Date(clock()).toISOString(),items,truncated};
 }
 root.ThemeRadarAuthorCore={snapshot};
})(globalThis);
