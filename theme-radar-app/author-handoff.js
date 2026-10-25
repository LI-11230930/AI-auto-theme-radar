(function(root){
 'use strict';
 function parse(fragment){
  if(!fragment.startsWith('#author-import='))return null;
  if(fragment.length>100000)throw Error('投稿清单超过接收预算，请使用JSON文件导入');
  const data=JSON.parse(decodeURIComponent(fragment.slice('#author-import='.length)));
  if(!data||data.schema!=='theme-radar-visible-author-v1'||typeof data.authorUid!=='string'||!Array.isArray(data.items)||data.items.length>20)throw Error('投稿清单格式无效');
  if(Object.keys(data).some(k=>!['schema','pageUrl','authorUid','observedAt','items','truncated'].includes(k)))throw Error('投稿清单包含未允许字段');
  for(const row of data.items)if(!row||Object.keys(row).some(k=>!['bvid','url','title'].includes(k))||typeof row.title!=='string'||row.title.length>500)throw Error('投稿条目格式无效');
  return data;
 }
 root.ThemeRadarAuthorHandoff={parse};
})(globalThis);
