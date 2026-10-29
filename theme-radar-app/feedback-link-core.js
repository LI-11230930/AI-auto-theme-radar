(function(root){
 'use strict';
 function parse(url,topics){
  const values=new URL(url).searchParams,keys=['feedbackItem','feedbackTopic','feedbackKind'];if(!keys.some(k=>values.has(k)))return null;
  if(keys.some(k=>values.getAll(k).length!==1))throw Error('邮件反馈参数缺失或重复，请从邮件中的原链接重新打开。');
  const [itemKey,topicId,kind]=keys.map(k=>values.get(k));
  if(!/^(?:bilibili:BV[A-Za-z0-9]{10}|github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.test(itemKey)||itemKey.length>300||!['useful','less_like_this'].includes(kind)||!topicId||topicId.length>120||/[\x00-\x1f\x7f]/.test(topicId))throw Error('邮件反馈参数无效，未选择或修改任何主题。');
  const platform=itemKey.split(':')[0],topic=topics.find(t=>t.id===topicId&&t.enabled&&t.platforms.includes(platform));
  if(!topic)throw Error('邮件原主题不存在、已停用或不再包含该平台；请自行选择合适的主题，不会自动换成其他主题。');
  return {itemKey,topicId,kind};
 }
 root.ThemeRadarFeedbackLink={parse};
})(globalThis);
