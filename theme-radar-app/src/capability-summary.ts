import type {Store} from './store.ts';
import {readableEvidence} from './model.ts';
import {loadMailTemplate,defaultMailTemplate} from './mail-template.ts';
import {readInterestMailPolicy} from './interest-mail.ts';

/** Current ledger state, independent of the developer's historical test reports. */
export function githubDigestCapability(store:Store){
 const topics=store.topics().filter(t=>t.enabled&&t.platforms.includes('github')),items=new Set<string>(),selected=new Set<string>();let covered=0;
 for(const topic of topics){const evaluated=new Set<string>();let hasCurrent=false;
  for(const a of store.assessments(topic.id)){
   if(a.topicRevision!==topic.revision||a.simulation===true||evaluated.has(a.itemKey))continue;
   const item=store.item(a.itemKey);if(item?.platform!=='github'||a.itemFingerprint!==store.fingerprint(a.itemKey)||!a.readEvidenceIds.length)continue;
   const available=new Set(store.currentEvidence(a.itemKey).filter(readableEvidence).map(e=>e.id));
   if(a.readEvidenceIds.some(id=>!available.has(id))||a.reading&&a.reading.snapshot!==store.readingSnapshot(a.itemKey))continue;
   evaluated.add(a.itemKey);hasCurrent=true;items.add(a.itemKey);if(a.selected)selected.add(a.itemKey);
  }if(hasCurrent)covered++;
 }
 return {id:'github-digest',state:!topics.length?'not_configured':!items.size?'awaiting_analysis':'archive_assessments_available',
   counts:{enabledTopics:topics.length,topicsWithCurrentAssessments:covered,assessedItems:items.size,selectedItems:selected.size},
   note:!topics.length?'尚无启用的GitHub主题；可创建任意数量的自定义主题。':!items.size?'已有自定义GitHub主题，尚无当前有效的非模拟判断；先读取并筛选自己的主题。':`当前${covered}/${topics.length}个GitHub主题有有效非模拟判断，涉及${items.size}条去重内容、${selected.size}条选中记录。时间窗口、已投递去重及邮件就绪情况以本次预览另行核对。`};
}
export function mailFormatCapability(dataDir:string){
 try{const custom=loadMailTemplate(dataDir);return {id:'notification-format',state:custom?'custom_template_configured':'default_template_available',githubSections:(custom||defaultMailTemplate).github.sections,
   note:custom?'已保存自定义邮件模板；栏目与格式由使用者选择，旧冻结草稿保留原样。':'内置简洁邮件模板可用；可自定义栏目、标题、简介、Star和流程展示，不预设使用者已验收或启用发送。'};}
 catch{return {id:'notification-format',state:'invalid_template',githubSections:[] as string[],note:'本机邮件模板无效，请修复模板后再生成预览；没有覆盖文件或启用发信。'};}
}
export function emailCapability(config:any,store:Store){
 const recipient=config.recipient?.toLowerCase(),confirmed=recipient?Number((store.db.prepare("SELECT count(*) n FROM deliveries WHERE lower(recipient)=? AND state='sent_confirmed'").get(recipient) as any).n):0;
 let policy;try{policy=readInterestMailPolicy(config.dataDir);}catch{return {id:'email',state:'invalid_manual_policy',confirmedDeliveries:confirmed,note:'本机手动投递策略文件无效，需修复；只读阅读仍可使用。未进行邮箱连接或发送检查。'};}
 const manual=policy.enabled&&policy.recipient?.toLowerCase()===recipient,smtp=!!(config.email.transport==='smtp'&&config.email.enabled&&config.email.from&&config.email.host&&process.env[config.email.passwordEnv]);
 const state=!recipient?'needs_recipient':manual?'manual_policy_configured':smtp?'smtp_configured_unverified':'sender_not_configured';
 return {id:'email',state,confirmedDeliveries:confirmed,note:(!recipient?'尚未配置收件人；可先阅读并查看本地草稿。':manual?'已保存本机B站手动投递策略；当前宿主邮箱连接与可用性需单独核对。':smtp?'SMTP字段与环境凭据已配置，但尚未在本次检查中验证连接或发送。':'已有收件人，尚未配置可核对的发送通道；可先准备草稿。')+` 此收件人在本机有${confirmed}条已确认送达记录，历史记录不替代当前连接验证。`};
}
