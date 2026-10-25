import {readFileSync,existsSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
export function hostCapability(config:any,id:string,spec:any){
  if(spec?.command&&isAbsolute(spec.command)&&!existsSync(spec.command))return {id,state:'runner_executable_missing',evidenceSource:'local_filesystem',note:'配置的执行文件当前不存在；历史接入结果保留。请核对应用更新后的实际入口，无需据此重新登录。'};
  const args=Array.isArray(spec?.prefixArgs)?spec.prefixArgs:[];
  for(let i=0;i<args.length;i++)if(args[i]==='--patch'&&typeof args[i+1]==='string'&&isAbsolute(args[i+1])&&!existsSync(args[i+1]))return {id,state:'runner_patch_missing',evidenceSource:'local_filesystem',note:'本项目配置的接入补丁文件不存在；请核对插件更新后的项目接入路径，历史授权和成功记录保留，不据此要求重新登录。'};
  const get=(name:string)=>{try{return JSON.parse(readFileSync(resolve(config.dataDir,'reports',name),'utf8'));}catch{return null;}};
  const checked=get(`agent-${id}.json`),reading=get(`agent-reading-${id}.json`),mcp=get(`agent-mcp-${id}.json`);
  const handoff=get(`agent-handoff-${id}.json`);
  const latestAnalysis=get(`agent-analysis-${id}.json`);
  const route=get(`agent-route-${id}.json`);
  if(latestAnalysis?.ok===true&&Date.parse(latestAnalysis.at)>=Date.parse(route?.at||'1970-01-01'))return {id,state:'archive_analysis_verified',checkedAt:latestAnalysis.at,evidenceSource:'local_probe',note:'当前配置已完成真实归档文本分析并保存判断。'+(route?.ok?' 渠道：'+route.provider+'/'+route.model+'。':'')+'材料范围与引用另存档案；不代表视听、上游事实核验或生产稳定性通过。'};
  if(route?.ok===false&&Date.parse(route.at)>Date.parse(latestAnalysis?.at||'1970-01-01'))return {id,state:route.code==='RUNNER_TIMEOUT'?'route_probe_timeout':'route_probe_failed',checkedAt:route.at,evidenceSource:'local_probe',note:`当前项目渠道 ${route.provider}/${route.model} 的有界试跑未通过（${route.code}）；没有登记新业务判断。超时不等同于授权失效，历史成功结果保留；请在DSH界面核对同一渠道的实际响应。`};
  if(latestAnalysis?.ok===false)return {id,state:'latest_analysis_failed',checkedAt:latestAnalysis.at,evidenceSource:'local_probe',note:'最近新B站主题归档分析尝试失败，已停止重试；既往成功证据保留，默认配置未改。当前Codex桌面对话独立完成的判断不计为DSH恢复，不据普通失败推断需要重新登录。'};
  if(handoff?.ok&&handoff?.reused===true&&handoff?.reuseLedgerVerified)return {id,state:'interactive_handoff_reused',checkedAt:handoff.at,evidenceSource:'user_report_and_local_ledger',note:'用户实机刷新后取得25工具，BV检索1条，prepare复用WorkBuddy的workflow-automation判断；1659/1659字符，未重复提交。本地账本独立核对仍只有1条该主题判断；复用不登记为TRAE重新阅读。'};
  if(handoff?.code==='STALE_MCP_PROCESS')return {id,state:'mcp_refresh_required',checkedAt:handoff.at,evidenceSource:'user_report_and_local_process_check',note:'历史字幕读取通过；最新交互接力遇到旧工具。已确认旧MCP进程早于源码更新，入口/账本路径正确。请重连现有服务并开新会话刷新工具列表；不需要重装扩展、重配账号或重新提交WorkBuddy判断。'};
  if(handoff?.ok&&handoff?.ledgerVerified)return {id,state:'interactive_assessment_saved',checkedAt:handoff.at,evidenceSource:'user_report_and_local_ledger',note:'用户实机prepare领取及submit成功，本地账本独立读回workflow-automation当前判断、1659/1659字符和已完成租约。宿主名称为调用方报告，不作独立身份认证；不等于完整视频理解。'};
  const user=mcp?.userReported===true;
  const state=mcp?.providerBlocked?'provider_channel_rejected':mcp?.ok?(user?'mcp_user_report_verified':'mcp_fixture_reading_verified'):reading?.ok?'material_reading_verified':checked?.ok?'minimal_response_verified':checked?.code==='AUTH_REQUIRED'?'needs_model_authorization':spec?.command?'configured_unverified':'interactive_mcp';
  let note=mcp?.providerBlocked?'最新探测：CodeBuddy以11128拒绝当前JetHub调用渠道；停止自动重试。':mcp?.ok?(user?(mcp.materialKind==='browser-subtitle:p1'?'用户提交IDE实际四工具及1659字符浏览器字幕读取结果；本Agent未重放。读取了既有DSH判断，不等于本宿主重新分析或完整视听理解。':'用户提交IDE实际四工具调用成功摘要；本Agent未重放。材料仅为视频简介，不代表字幕或完整视频阅读。'):'真实CLI→MCP状态/聚合/固定材料读取通过；固定材料不替代真实七主题业务验收。'):reading?.ok?'公开资料阅读与证据校验已通过；宿主MCP验收另记。':checked?.ok?'最小真实响应已通过；完整MCP/业务验收另记':checked?.message||'配置存在不代表真实模型授权或工具调用通过';
  if(mcp?.provider)note+=' 当前渠道：'+mcp.provider+'。';
  if(mcp?.recentIncompleteFinals)note+=' 新渠道近期有'+mcp.recentIncompleteFinals+'次不完整JSON失败，已拒绝保存；稳定性尚待观察。';
  return {id,state,checkedAt:mcp?.at||reading?.at||checked?.at,evidenceSource:user?'user_report':'local_probe',note};
}
