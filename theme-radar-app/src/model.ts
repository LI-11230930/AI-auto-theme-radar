import { createHash } from 'node:crypto';

export type Platform = 'bilibili' | 'xiaohongshu' | 'github';
export type Coverage = { material: string; expected: number | null; acquired: number; processed: number; state: 'unread'|'partial'|'complete'|'unavailable'; method: string; note?: string; claimedByAgent?: boolean };
export type Evidence = { id?: string; itemKey: string; kind: string; url: string; text: string; collectedAt: string; coverage: Coverage; hash?: string };
export type Item = { platform: Platform; externalId: string; key: string; url: string; title: string; authorId: string; author: string; publishedAt: string | null; discoveredAt: string; version: string; metadata: Record<string, unknown> };
export type ReadingTrace={snapshot:string;startedAt:string;completedAt:string;materials:{id:string;kind:string;providedCharacters:number;totalCharacters:number;truncated:boolean;cited:boolean}[];scope:'archived_text_only'};
export type FlowSketch={steps:string[];basis:'overview'|'documented';evidenceIds:string[]};
export type Assessment = { itemKey: string; selected: boolean; reason: string; summaryZh?: string; flow?: FlowSketch; readEvidenceIds: string[]; limitations: string[]; agent: string; model?: string; simulation?: boolean; reading?:ReadingTrace };
export function isVideoTextKind(kind:string,page?:number){if(kind==='subtitle')return page===undefined||page===1;const match=/^(?:subtitle:p|browser-subtitle:p|asr:p|ocr:p)([1-9]\d*)$/.exec(kind);return !!match&&(page===undefined||Number(match[1])===page);}
export function readableEvidence(e:Evidence){return e.coverage.acquired>0&&!!e.text.trim()&&!['image-manifest','video-reading-manifest'].includes(e.kind)&&!e.kind.startsWith('browser-subtitle-observation:')&&!e.kind.startsWith('subtitle-timeline:')&&!e.kind.startsWith('asr-timeline:')&&!e.kind.startsWith('ocr-timeline:');}
export type RankingPeriod = 'daily' | 'weekly';
export type Ranking = { repo: string; url: string; rank: number; stars: number | null; starsToday: number | null; description: string; descriptionSource?: string; descriptionMissing?: boolean; summaryZh?: string; flow?: FlowSketch; period?: RankingPeriod; periodStars?: number | null; language: string | null; observedAt: string; source: string };
export type Topic = { id: string; name: string; description: string; keywords: string[]; exclude: string[]; platforms: Platform[]; repositories?: string[]; bilibiliAuthors?:string[]; bilibiliDiscovery?:'keywords'|'authors'|'interests'; enabled: boolean };
export type Batch = { date: string; slot: string; key: string; dueAt: string; startAt: string; endAt: string; timezone: 'Asia/Shanghai' };

export class RadarError extends Error {
  code: string; details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) { super(message); this.name = 'RadarError'; this.code = code; this.details = details; }
}
// Unknown runtime/parser errors may contain credentials, paths or response bodies.
export function publicError(error:unknown) {
  if(error instanceof RadarError)return {code:error.code,message:error.message};
  return {code:'INTERNAL_ERROR',message:'操作未完成，请查看本地诊断状态后重试'};
}
export const now = () => new Date().toISOString();
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function requireText(value: unknown, field: string, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RadarError('INVALID_INPUT', `${field} 必须为非空文本且不超过 ${max} 字符`);
  return value.trim();
}
export function stableId(platform: Platform, input: string): string {
  const text = requireText(input, 'ID', 1000);
  if (platform === 'bilibili') {
    const match = /(?:^|\/)(BV[0-9a-zA-Z]{10})(?:$|[/?#])/.exec(text);
    if (!match) throw new RadarError('INVALID_ID', '需要有效 BV 号或视频链接');
    if (text.includes('://') && !['www.bilibili.com','bilibili.com'].includes(new URL(text).hostname)) throw new RadarError('INVALID_ID','B站链接域名不匹配');
    return match[1];
  }
  if (platform === 'xiaohongshu') {
    if (/^[a-f0-9]{24}$/i.test(text)) return text.toLowerCase();
    const url = new URL(text);
    if (!['www.xiaohongshu.com','xiaohongshu.com'].includes(url.hostname)) throw new RadarError('INVALID_ID','小红书链接域名不匹配');
    const match = /^\/(?:explore|user\/profile)\/([a-f0-9]{24})(?:\/|$)/i.exec(url.pathname);
    if (!match) throw new RadarError('INVALID_ID','需要平台内部 ID 或主页/笔记链接；不能用昵称绑定');
    return match[1].toLowerCase();
  }
  const cleaned = text.includes('://') ? (()=>{const url=new URL(text);if(url.hostname!=='github.com')throw new RadarError('INVALID_ID','GitHub 域名不匹配');return url.pathname;})() : text;
  const match = /^\/?([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(cleaned);
  if (!match || match[1]==='.' || match[2]==='.' || match[1]==='..' || match[2]==='..') throw new RadarError('INVALID_ID','需要 owner/repo 或仓库主页链接');
  return `${match[1]}/${match[2]}`.toLowerCase();
}
export function bindAccount(platform: Platform, executorId: string, recipientId: string, confirmation: {name: string; profile: string; confirmed: boolean}) {
  if(!['bilibili','xiaohongshu'].includes(platform))throw new RadarError('INVALID_PLATFORM','仅社交平台需要提醒账号绑定');
  if (!confirmation.confirmed) throw new RadarError('CONFIRM_ACCOUNT','需要确认头像/主页与目标账号');
  const valid = platform==='bilibili' ? /^\d+$/ : /^[a-f0-9]{24}$/i;
  if (!valid.test(executorId) || !valid.test(recipientId)) throw new RadarError('INVALID_ID','执行与接收账号必须使用平台稳定 ID，不能使用昵称');
  executorId=platform==='bilibili'?BigInt(executorId).toString():executorId.toLowerCase();
  recipientId=platform==='bilibili'?BigInt(recipientId).toString():recipientId.toLowerCase();
  if(executorId==='0'||recipientId==='0')throw new RadarError('INVALID_ID','用户ID必须为有效的正数');
  if (executorId === recipientId) throw new RadarError('SELF_MENTION','需分离执行账号与接收账号，以验证通知');
  return {platform, executorId, recipientId, ...confirmation, confirmedAt:now()};
}
export function validateCoverage(c: Coverage) {
  if (!c || !['unread','partial','complete','unavailable'].includes(c.state) || !Number.isInteger(c.acquired) || !Number.isInteger(c.processed) || c.acquired<0 || c.processed<0 || c.processed>c.acquired || (c.expected!==null && (!Number.isInteger(c.expected)||c.expected<0||c.acquired>c.expected))) throw new RadarError('INVALID_COVERAGE','阅读覆盖计数不合法');
  if (c.state==='complete' && (c.expected===null || c.processed!==c.expected || c.expected===0)) throw new RadarError('INVALID_COVERAGE','完整阅读必须有已知且全部处理的非零材料数');
  if ((c.state==='unread'||c.state==='unavailable') && c.processed!==0) throw new RadarError('INVALID_COVERAGE','未读材料不能计为已处理');
  requireText(c.material,'material'); requireText(c.method,'method');
}
export function normalizeText(text: string) { return text.normalize('NFKC').replace(/\s+/g,' ').trim(); }
export function repoReferences(text: string): string[] {
  const refs=new Set<string>();
  // Match public links, including the protocol-less form commonly used in
  // video descriptions. A host boundary prevents userinfo/lookalike domains.
  for(const m of text.matchAll(/(?<![\w./:@-])((?:https?:\/\/)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)(?=$|[\s/\?#)>\]}】」"'`，。；、：！])/gi)){
    try{const url=new URL(/^https?:/i.test(m[1])?m[1]:'https://'+m[1]);const repo=stableId('github',url.origin+url.pathname);refs.add(repo);}catch{}
  }
  return [...refs];
}
export function validateTopic(topic: Topic) {
  requireText(topic.id,'topic id',120); requireText(topic.name,'topic name',200); requireText(topic.description,'topic description',4000);
  if(!Array.isArray(topic.keywords)||!topic.keywords.length||topic.keywords.some(x=>typeof x!=='string'||!x.trim()||x.length>120)||!Array.isArray(topic.exclude)||topic.exclude.some(x=>typeof x!=='string'||x.length>200)||!Array.isArray(topic.platforms)||!topic.platforms.length||topic.platforms.some(x=>!['github','bilibili','xiaohongshu'].includes(x))||typeof topic.enabled!=='boolean')throw new RadarError('INVALID_TOPIC','主题关键词、排除条件和平台配置无效');
  if(topic.bilibiliAuthors!==undefined&&(!Array.isArray(topic.bilibiliAuthors)||topic.bilibiliAuthors.length>5||topic.bilibiliAuthors.some(id=>typeof id!=='string'||!/^[1-9]\d{0,19}$/.test(id))||new Set(topic.bilibiliAuthors).size!==topic.bilibiliAuthors.length))throw new RadarError('INVALID_TOPIC','B站作者使用最多5个不重复的正整数UID字符串，不能使用昵称');
  if(topic.bilibiliDiscovery!==undefined&&!['keywords','authors','interests'].includes(topic.bilibiliDiscovery))throw new RadarError('INVALID_TOPIC','B站发现方式无效');
  if(topic.bilibiliDiscovery==='interests'&&(!topic.platforms.includes('bilibili')||topic.bilibiliAuthors?.length))throw new RadarError('INVALID_TOPIC','兴趣推荐模式需要B站平台，作者UID需留空；原作者订阅可独立保留');
  if(topic.bilibiliDiscovery==='authors'&&(!topic.bilibiliAuthors?.length||!topic.platforms.includes('bilibili')))throw new RadarError('INVALID_TOPIC','作者投稿模式需要B站平台和至少一个作者UID');
  return topic;
}
