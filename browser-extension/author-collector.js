(function(){
 'use strict';if(globalThis.__themeRadarAuthorCollector)return;globalThis.__themeRadarAuthorCollector=true;
 chrome.runtime.onMessage.addListener((message,_sender,respond)=>{if(message?.kind!=='author-observe')return;
  try{const links=[];for(const anchor of document.querySelectorAll('a[href*="/video/BV"]')){const rect=anchor.getBoundingClientRect(),style=getComputedStyle(anchor);if(rect.width<=0||rect.height<=0||rect.bottom<=0||rect.right<=0||rect.top>=innerHeight||rect.left>=innerWidth||style.display==='none'||style.visibility==='hidden')continue;const title=anchor.getAttribute('title')||anchor.querySelector('[title]')?.getAttribute('title')||anchor.querySelector('img')?.getAttribute('alt')||anchor.innerText;links.push({url:anchor.href,title});}
   respond({ok:true,data:globalThis.ThemeRadarAuthorCore.snapshot(location.href,links)});
  }catch(e){respond({ok:false,error:e.message||'作者页观察未完成'});}return false;
 });
})();
