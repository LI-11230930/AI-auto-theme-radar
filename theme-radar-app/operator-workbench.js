(() => {
  'use strict';
  const core = window.ThemeRadarWorkbench, $ = id => document.getElementById(id);
  if (!core || !$('automation')) return;
  const main = document.querySelector('main');
  const pages = {}, definitions = [
    ['workbench','开始运行','◎'],['preferences','兴趣主题','◇'],['email-settings','邮件内容','✉'],
    ['history','运行记录','◷'],['connections','平台连接','⇄'],['advanced','高级工具','⋯']
  ];
  const sidebar = document.createElement('aside'); sidebar.className = 'wb-sidebar'; sidebar.setAttribute('aria-label','工作台目录');
  sidebar.innerHTML = '<div class="wb-brand"><span class="wb-logo">◎</span><div>主题雷达<small>THEME RADAR</small></div></div><nav class="wb-nav" aria-label="主目录"></nav><div class="wb-sidebar-footer">本地工作空间<br>你的配置与阅读档案保存在本机。</div>';
  document.body.prepend(sidebar);
  const header = main.querySelector('header'); header.className = 'wb-topbar';
  header.innerHTML = '<div><div class="eyebrow">YOUR PERSONAL DISCOVERY WORKSPACE</div><h1>让信息，自己来找你。</h1><p class="muted">配置兴趣，选择 Agent。让它阅读 B站与 GitHub，把值得关注的内容发到邮箱。</p></div>';
  const oldNotice = main.querySelector(':scope > .notice'); if (oldNotice) oldNotice.remove();
  for (const [id,title,icon] of definitions) {
    const page = document.createElement('div'); page.id = id; page.className = 'wb-page'; page.hidden = true; pages[id] = page;
    main.append(page); const link = document.createElement('a'); link.href = '#'+id; link.innerHTML = '<span class="wb-icon" aria-hidden="true">'+icon+'</span>'+title; sidebar.querySelector('nav').append(link);
  }
  pages.workbench.innerHTML = `
    <div class="wb-intro"><div><h2>一次配置，交给 Agent。</h2><p class="muted">当前按需运行，不设置时间。每轮完成后按你的选择投递。</p></div><span class="wb-tag" id="quick-service">正在连接本机服务</span></div>
    <div class="wb-stats"><div class="wb-stat"><span>执行 Agent</span><strong id="quick-stat-agent">尚未配置</strong><small>使用所选 Agent 的当前会话模型</small></div><div class="wb-stat"><span>发现范围</span><strong id="quick-stat-platforms">B站 / GitHub</strong><small>根据兴趣自主寻找，再阅读和筛选</small></div><div class="wb-stat"><span>结果送达</span><strong id="quick-stat-mail">先生成草稿</strong><small id="quick-stat-mail-note">你决定是否通过 Outlook 投递</small></div></div>
    <div class="wb-two"><section class="panel"><h2>我的运行配置</h2><form id="quick-form">
    <div class="wb-form-row"><label>由哪个 Agent 执行<select id="quick-agent"><option>Codex</option><option>DSH</option><option>WorkBuddy</option><option>TRAE</option></select></label><label>邮件标题<input id="quick-subject" maxlength="200" value="主题雷达｜{date} {time}" required></label></div>
    <fieldset><legend>阅读平台</legend><div class="wb-checkboxes"><label class="wb-check"><input id="quick-bilibili" type="checkbox" checked>B站</label><label class="wb-check"><input id="quick-github" type="checkbox" checked>GitHub</label></div></fieldset>
    <fieldset><legend>关注的主题</legend><div id="quick-topics" class="wb-topic-options"></div><p class="wb-help">在「兴趣主题」中添加或调整关键词。</p></fieldset>
    <div class="wb-form-row"><label>Outlook 发件邮箱<input id="quick-from" type="email" autocomplete="email" placeholder="已在 Agent 中连接的邮箱"></label><label>接收邮箱<input id="quick-recipient" type="email" autocomplete="email" placeholder="分享给自己的邮箱"></label></div>
    <label class="wb-check"><input id="quick-approved" type="checkbox"><span>允许主动运行或已开启的平台计划，通过Outlook发送汇总。<br><small class="wb-help">每轮最多1次发送尝试、每天最多2次；失败或结果未知不重发。</small></span></label>
    <div class="wb-actions"><button type="submit" class="primary">保存配置</button><button type="button" id="quick-copy">复制 Agent 运行指令</button><button type="button" id="quick-start" disabled>开始一轮</button></div>
    <p id="quick-online" class="wb-help">保存后，把运行指令发给所选 Agent，它会自主完成阅读与投递。</p><div id="quick-message" class="wb-alert" role="status"></div>
    </form><details><summary>查看运行指令</summary><textarea id="quick-prompt" rows="12" readonly aria-label="运行指令"></textarea></details></section>
    <aside><section class="panel"><h2>怎么开始</h2><ol class="wb-steps"><li><b>选兴趣与平台</b>只需留下你真正关注的主题。</li><li><b>交给指定 Agent</b>复制指令到已连接主题雷达的 Agent。它会自主采集、阅读和筛选。</li><li><b>在邮箱看精选</b>需要所选 Agent 同时连接 Outlook。没有连接时会保留草稿。</li></ol></section><section class="panel"><h2>你会收到什么</h2><p class="muted">视频或项目链接、简短中文介绍和运行示意。</p><p class="muted">GitHub 可包含 Daily / Weekly 前十与 Star 数量，在「邮件内容」调整。</p><a class="wb-inline-link" href="#email-settings">调整邮件内容 →</a></section></aside></div>
    <section class="panel"><h2>最近一次运行</h2><div id="quick-latest"></div></section>`;
  pages.preferences.innerHTML = `<div class="wb-page-title"><h2>兴趣主题</h2><p class="muted">告诉 Agent 你想发现什么。关键词越具体，内容越贴近需要。</p></div><div class="wb-two"><section class="panel"><h2 id="quick-topic-heading">添加主题</h2><form id="quick-topic-form"><label>主题名称<input id="quick-topic-name" required maxlength="100" placeholder="例如：AI开发与自动化"></label><label>关注关键词<textarea id="quick-topic-keywords" rows="4" required placeholder="每行一个，也可用逗号分隔"></textarea></label><label>排除词（选填）<input id="quick-topic-exclude" placeholder="例如：广告、带货"></label><fieldset><legend>应用平台</legend><div class="wb-checkboxes"><label class="wb-check"><input id="quick-topic-bilibili" type="checkbox" checked>B站</label><label class="wb-check"><input id="quick-topic-github" type="checkbox" checked>GitHub</label></div></fieldset><button class="primary" type="submit">保存主题</button><button id="quick-topic-new" type="button">添加另一个</button><div id="quick-topic-message" class="wb-alert" role="status"></div></form></section><section class="panel"><h2>我的主题</h2><div id="quick-topic-list"></div></section></div>`;
  pages['email-settings'].innerHTML = `<div class="wb-page-title"><h2>邮件内容</h2><p class="muted">只保留你希望看到的内容。详细阅读材料保存在本地档案。</p></div><div class="wb-two"><section class="panel"><form id="quick-template-form"><h2>GitHub 汇总栏目</h2><div class="wb-checkboxes"><label class="wb-check"><input id="quick-section-projects" type="checkbox" checked>主题项目</label><label class="wb-check"><input id="quick-section-daily" type="checkbox" checked>Daily 前十</label><label class="wb-check"><input id="quick-section-weekly" type="checkbox" checked>Weekly 前十</label></div><h2 style="margin-top:24px">每条内容</h2><p class="muted">始终保留链接与简短中文介绍。</p><label class="wb-check"><input id="quick-template-stars" type="checkbox" checked>显示 Star 数量</label><label class="wb-check"><input id="quick-template-flow" type="checkbox" checked>显示简短运行示意</label><label>邮件末尾文字（选填）<textarea id="quick-template-footer" rows="3" maxlength="1000" placeholder="留空即不添加"></textarea></label><button class="primary" type="submit">保存邮件内容</button><div id="quick-template-message" class="wb-alert" role="status"></div></form></section><section class="panel"><h2>简洁呈现</h2><div class="wb-email-example"><strong>主题精选</strong>项目 / 视频名称<br>链接<br>一两句中文介绍<br><br>输入 → 处理 → 输出</div><p class="wb-help">示意图概括实际读到的材料；未验证的实现不会写成已运行。</p></section></div>`;
  pages.history.innerHTML = '<div class="wb-page-title"><h2>运行记录</h2><p class="muted">查看精选草稿和邮件状态。</p></div><section class="panel"><div id="quick-history"></div></section><p><a class="btn" href="/library" target="_blank" rel="noopener">打开内容档案 ↗</a><a class="btn" href="#reading-evidence">查看原始阅读材料</a></p>';
  pages.connections.innerHTML = '<div class="wb-page-title"><h2>平台连接</h2><p class="muted">B站登录在本机保存；Agent 模型和 Outlook 连接由你选用的 Agent 提供。</p></div><section class="panel"><h2>Agent 与 Outlook</h2><p>在所选 Agent 中连接主题雷达 MCP 和 Outlook。运行时，Agent 会核对实际发件账号，再按计划发信。</p><p class="muted">配置片段与安装说明保留在高级工具中。无需在这个网页填写 Outlook 密码。</p><a class="btn" href="/help/install" target="_blank" rel="noopener">查看接入说明</a></section>';
  pages.advanced.innerHTML = '<div class="wb-page-title"><span class="eyebrow">TOOL LIBRARY</span><h2>需要时，再打开工具。</h2><p class="wb-advanced-note">先选用途，再展开具体操作。采集、档案、邮件与维护各在自己的位置。</p></div><div class="wb-tool-layout"><nav class="wb-tool-nav" aria-label="高级工具目录"></nav><div class="wb-tool-content"></div></div>';
  const place = (element, page) => { if (element) pages[page].append(element); };
  place($('bilibili-login'),'connections'); place($('setup'),'connections');
  for (const element of [...main.children]) {
    if (element === header || element.classList.contains('wb-page')) continue;
    if (element.tagName === 'SCRIPT') continue;
    if (element.tagName === 'P') { element.remove(); continue; }
    place(element,'advanced');
  }
  const nested = {'automation-once':'history'};
  pages.workbench.querySelector('.wb-intro h2').textContent='两个平台，各自运行。';
  pages.workbench.querySelector('.wb-intro p').textContent='GitHub 每日 09:00；B站随时开关，自动阅读并分享。';
  const platformPanel=document.createElement('section');platformPanel.className='wb-platform-grid';platformPanel.id='platform-controls';
  platformPanel.innerHTML='<article class="wb-platform-card wb-github"><div class="wb-platform-label">GITHUB · 每日发现</div><h2>每天早上，新的开发灵感。</h2><div class="wb-frequency">09:00 <small>北京时间</small></div><p>主题项目 · Daily / Weekly 前十<br>中文介绍、Star 与运行示意，一封送达。</p><button id="platform-github-toggle" type="button" disabled>正在读取</button><div id="platform-github-state" role="status"></div></article><article class="wb-platform-card wb-bilibili"><div class="wb-platform-label">BILIBILI · 持续阅读</div><h2>把刷到的好内容，留给自己。</h2><p>登录推荐 → 字幕 / 语音 / 画面文字<br>Agent 阅读与筛选 → 邮箱分享</p><div class="wb-stream-meta">开启后每15分钟检查 · 每天最多2封</div><button id="platform-bilibili-toggle" type="button" disabled>正在读取</button><div id="platform-bilibili-state" role="status"></div></article><p class="wb-platform-footnote">本地自动运行需电脑、本机服务和所选Agent可用，并在独立运行会话配置唤醒。B站账号在「平台连接」扫码登录。新发件邮箱仅在对应Agent已连接后使用。</p><div id="platform-control-message" role="status"></div><div id="platform-recovery-state"></div><div id="platform-credential-state" role="status"></div>';
  pages.workbench.querySelector('.wb-intro').after(platformPanel);
  pages.workbench.querySelector('.wb-stats').hidden=true;
  const optional=pages.workbench.querySelector('.wb-two'),optionalDetails=document.createElement('details');optionalDetails.className='wb-optional';optionalDetails.innerHTML='<summary>统一配置 · Agent、主题与邮箱</summary>';optional.before(optionalDetails);optionalDetails.append(optional);
  async function refreshPlatforms(){
    const data=await read('/api/automation/platforms');
    for(const p of data.platforms){
      const button=$('platform-'+p.platform+'-toggle'),status=$('platform-'+p.platform+'-state');
      button.disabled=false;button.textContent=p.enabled?(p.platform==='bilibili'?'关闭持续阅读':'暂停每日简报'):(p.platform==='bilibili'?'开启持续阅读':'启用每日简报');
      button.setAttribute('aria-pressed',String(p.enabled));
      button.onclick=async()=>{button.disabled=true;try{await post('/api/automation/platforms/set',{platform:p.platform,enabled:!p.enabled});const current=await refreshPlatforms(),updated=current.platforms.find(v=>v.platform===p.platform);$('platform-control-message').textContent=updated.enabled?'平台已开启。'+updated.execution.note:'已关闭，尚未尝试发送的当前轮次停止。';}catch(e){$('platform-control-message').textContent=e.message;button.disabled=false;}};
      status.replaceChildren();
      for(const text of [p.enabled?'计划已开启 · '+p.frequency:'已关闭',p.execution.note,
        p.plan?'Agent：'+p.plan.agent+' · '+(p.plan.delivery==='draft'?'仅草稿':'收件：'+p.plan.recipient):'',
        p.nextScheduledAt?'目标时刻：'+new Date(p.nextScheduledAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）':'',
        p.enabled?p.mailbox.note:'']){
        if(!text)continue;const line=document.createElement('div');line.textContent=text;status.append(line);
      }
      status.dataset.execution=p.execution.state;
    }
    const pending=data.pendingReading.filter(p=>p.state==='pending_reading').length,bili=data.platforms.find(p=>p.platform==='bilibili');
    $('platform-recovery-state').textContent=pending?pending+' 条正文保留在恢复队列。'+(bili?.enabled&&bili.execution.state==='configured'?'后续轮次按冷却时间处理。':'开启平台并连接执行入口后再处理。'):'';
    return data;
  }
  for (const [id,page] of Object.entries(nested)) place($(id),page);
  const toolGroups=[
    {id:'reading',name:'采集与字幕',icon:'▷',note:'读取视频、导入字幕和作者投稿',ids:['bilibili-reading','browser-batch','author-observations','topic-discovery','bilibili-interest','interest-reading']},
    {id:'archive',name:'内容档案',icon:'▤',note:'找原文、看判断、调整筛选偏好',ids:['reading-evidence','archive-analysis','library','feedback']},
    {id:'mail',name:'邮件与投递',icon:'✉',note:'编辑模板，核对草稿和发送记录',ids:['mail-template','digest-candidates']},
    {id:'plans',name:'计划与配置',icon:'◷',note:'完整计划编辑与主题参数',ids:['automation']},
    {id:'maintenance',name:'诊断与备份',icon:'⚙',note:'查看运行能力，保护本地数据',ids:['backup']}
  ];
  const toolPanels=[...pages.advanced.querySelectorAll('.panel')],toolContent=pages.advanced.querySelector('.wb-tool-content');
  for(const group of toolGroups){const section=document.createElement('section');section.id='advanced-'+group.id;section.className='wb-tool-group';section.dataset.toolGroup=group.id;section.innerHTML='<div class="wb-tool-heading"><span>'+group.icon+'</span><div><h3>'+group.name+'</h3><p>'+group.note+'</p></div></div>';group.element=section;toolContent.append(section);const link=document.createElement('a');link.href='#'+section.id;link.innerHTML='<span>'+group.icon+'</span>'+group.name;pages.advanced.querySelector('.wb-tool-nav').append(link);}
  for(const panel of toolPanels){const heading=panel.querySelector('h2'),title=heading?.textContent||'更多操作';let group=toolGroups.find(g=>g.ids.includes(panel.id));if(!group)group=/邮件|投递|预览/.test(title)?toolGroups[2]:/主题/.test(title)?toolGroups[3]:/检索/.test(title)?toolGroups[1]:toolGroups[4];const wrapper=document.createElement('details');wrapper.className='wb-tool';const summary=document.createElement('summary'),name=document.createElement('strong'),description=document.createElement('small');name.textContent=title;description.textContent=panel.querySelector('p')?.textContent?.slice(0,90)||'展开查看操作与当前状态';summary.append(name,description);wrapper.append(summary,panel);group.element.append(wrapper);wrapper.addEventListener('toggle',()=>{if(wrapper.open)for(const other of toolContent.querySelectorAll('details.wb-tool'))if(other!==wrapper)other.open=false;});}
  for(const node of [...pages.advanced.children])if(node!==pages.advanced.querySelector('.wb-page-title')&&node!==pages.advanced.querySelector('.wb-tool-layout'))node.remove();
  const destinations = {'workbench':'workbench','preferences':'preferences','email-settings':'email-settings','history':'history','connections':'connections','advanced':'advanced'};
  for (const page of Object.values(pages)) for (const element of page.querySelectorAll('[id]')) destinations[element.id] = page.id;
  function route() {
    const id = location.hash.slice(1) || 'workbench', selected = destinations[id] || 'workbench';
    const pageTitles={workbench:'我的主题雷达',preferences:'兴趣主题','email-settings':'邮件内容',history:'运行记录',connections:'平台连接',advanced:'工具目录'};
    const pageNotes={workbench:'GitHub 每日简报，B站持续阅读。选择兴趣，让 Agent 把有价值的内容送到邮箱。',preferences:'维护关注方向与排除词，下次阅读时生效。','email-settings':'链接、中文介绍、Star与简短示意，由你决定保留哪些。',history:'每轮读到了什么，哪些内容已送达。',connections:'登录B站，并检查Agent与邮箱连接。',advanced:'按用途选择工具；操作面板按需展开。'};
    header.querySelector('h1').textContent=pageTitles[selected];header.querySelector('p').textContent=pageNotes[selected];
    for (const [name,page] of Object.entries(pages)) page.hidden = name !== selected;
    for (const link of sidebar.querySelectorAll('nav a')) { if (link.hash === '#'+selected) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); }
    if(selected==='advanced'){const target=$(id),group=target?.closest('[data-tool-group]')||toolGroups[0].element;for(const section of toolContent.children)section.hidden=section!==group;for(const link of pages.advanced.querySelectorAll('.wb-tool-nav a'))link.setAttribute('aria-current',link.hash==='#'+group.id?'page':'false');const details=target?.closest('details.wb-tool');if(details)details.open=true;}
    const target = $(id); if (target && id !== selected) requestAnimationFrame(() => target.scrollIntoView({block:'start'}));
    if (!target || id === selected) window.scrollTo({top:0,behavior:'instant'});
  }
  window.addEventListener('hashchange',route); route();
  document.addEventListener('click',event => { if (event.target.closest('[data-automation-draft]')) location.hash='history'; });
  let state, report, template, saved, editingTopic = null, dirty = false;
  const msg = (id,text,error=false) => { $(id).textContent=text; $(id).classList.toggle('wb-error',error); };
  async function read(path) { const response = await fetch(path); const data=await response.json(); if(!response.ok) throw Error(data.error||'读取失败，请稍后重试。'); return data; }
  async function post(path,body) { const current=await read('/api/state'); const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':current.token},body:JSON.stringify(body)}); const data=await response.json(); if(!response.ok) throw Error(data.error||'未能保存。'); return data; }
  const platforms = () => ['bilibili','github'].filter(p=>$('quick-'+p).checked);
  function renderTopicOptions(ids) {
    const selected=new Set(ids||[...$('quick-topics').querySelectorAll('input:checked')].map(x=>x.value));
    const nodes=core.eligibleTopics(state.topics||[],platforms()).map(t=>{const label=document.createElement('label');label.className='wb-check';const box=document.createElement('input');box.type='checkbox';box.value=t.id;box.checked=selected.has(t.id);const name=document.createElement('span');name.textContent=t.name;label.append(box,name);return label;});
    $('quick-topics').replaceChildren(...nodes); if(!nodes.length)$('quick-topics').textContent='尚无适用主题，请先添加。';
  }
  function fill(plan) {
    saved=plan||null; $('quick-agent').value=plan?.agent||'Codex';$('quick-subject').value=plan?.subject||'主题雷达｜{date} {time}';
    for(const p of ['bilibili','github'])$('quick-'+p).checked=plan?plan.platforms.includes(p):true;
    $('quick-from').value=plan?.from||'';$('quick-recipient').value=plan?.recipient||'';$('quick-approved').checked=!!(plan?.sendApproved&&plan?.delivery==='host');
    renderTopicOptions(plan?.topicIds||core.eligibleTopics(state.topics||[],platforms()).map(t=>t.id));dirty=false;updateSummary();
  }
  function updateSummary() {
    $('quick-stat-agent').textContent=saved?.agent||'尚未保存';$('quick-stat-platforms').textContent=saved?saved.platforms.map(x=>x==='github'?'GitHub':'B站').join(' + '):'请选择';
    const mail=saved?.enabled&&saved?.sendApproved&&saved.delivery==='host';$('quick-stat-mail').textContent=mail?'Outlook 邮件':'本地草稿';$('quick-stat-mail-note').textContent=mail?saved.recipient:'保存后可交给 Agent 阅读';
    $('quick-prompt').value=saved?core.agentPrompt(saved):'保存配置后生成运行指令。';
    const online=saved&&report?.onlineAgents?.includes(saved.agent);$('quick-start').disabled=!online||dirty;
    $('quick-online').textContent=online?'所选 Agent 最近已连接，可以开始一轮；它仍需持续处理任务。':'把运行指令发给所选 Agent，由它发起并自主完成本轮。网页不会唤醒关闭的 Agent。';
  }
  function renderRuns(target,runs) {
    const labels={draft_ready:'草稿已完成',awaiting_host_mail:'等待 Outlook 投递',awaiting_model:'Agent 正在阅读',no_selection:'本轮没有精选',no_readable_material:'没有可读正文',incomplete_reading:'部分处理未完成',failed:'运行未完成',cancelled:'已取消',github:'正在阅读 GitHub',bilibili:'正在阅读 B站',queued:'准备开始'};
    const delivery={submitted:'邮件已提交',sent_confirmed:'邮件已确认送达',uncertain:'邮件结果待核对，禁止重发',submitting:'邮件正在提交',prepared:'邮件等待领取',failed:'邮件发送失败'};
    const rows=runs.map(run=>{const card=document.createElement('div');card.className='wb-list-row';const title=document.createElement('h3');title.textContent=delivery[run.deliveryState]||labels[run.stage]||'处理中';const p=document.createElement('p');p.textContent=new Date(run.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+' · '+(run.planId==='personal-radar'?'我的主题雷达':run.planId.startsWith('verify-')?'历史验收记录':'阅读任务');card.append(title,p);
      for(const row of run.results||[]){const line=document.createElement('p');line.textContent=row.platform==='bilibili'?`B站 · 已判断 ${row.counts?.assessed||0} 条，精选 ${row.counts?.selected||0} 条${(row.counts?.unavailableBody||0)+(row.counts?.insufficientBody||0)?`，本轮${run.planId==='bilibili-stream'?'留待恢复':'未取得足够正文'} ${(row.counts?.unavailableBody||0)+(row.counts?.insufficientBody||0)} 条`:''}${row.counts?.failed?`，处理失败 ${row.counts.failed} 条`:''}`:`GitHub · 精选 ${row.selected||0} 个项目`;card.append(line);}
      if(run.error){const error=document.createElement('p');error.textContent=run.error.message;card.append(error);}
      if(run.absolutePreview){const link=document.createElement('a');link.href=run.absolutePreview;link.textContent='查看汇总草稿 ↗';link.target='_blank';link.rel='noopener';card.append(link);}return card;});
    target.replaceChildren(...rows);if(!rows.length){const empty=document.createElement('div');empty.className='wb-empty';empty.textContent='还没有日常运行记录。配置保存后，交给 Agent 开始第一轮。';target.append(empty);}
  }
  function renderTopicList() {
    $('quick-topic-list').replaceChildren(...(state.topics||[]).map(topic=>{const row=document.createElement('div');row.className='wb-list-row';const name=document.createElement('h3');name.textContent=topic.name;const words=document.createElement('p');words.textContent=(topic.keywords||[]).join(' · ');const status=document.createElement('p');status.textContent=topic.platforms.map(p=>p==='bilibili'?'B站':p==='github'?'GitHub':p).join(' / ')+(topic.enabled?'':' · 已暂停');row.append(name,words,status);const edit=document.createElement('button');edit.type='button';edit.textContent=topic.bilibiliAuthors?.length?'高级作者订阅':'编辑';edit.onclick=()=>{if(topic.bilibiliAuthors?.length){location.hash='topic-form';return;}editingTopic=topic;$('quick-topic-heading').textContent='编辑主题';$('quick-topic-name').value=topic.name;$('quick-topic-keywords').value=topic.keywords.join('\n');$('quick-topic-exclude').value=(topic.exclude||[]).join('，');for(const p of ['bilibili','github'])$('quick-topic-'+p).checked=topic.platforms.includes(p);$('quick-topic-name').focus();};row.append(edit);return row;}));
  }
  async function refresh(initial=false) {
    [state,report]=await Promise.all([read('/api/state'),read('/api/automation')]);
    $('quick-service').textContent=state.service?.restartRequired?'服务需要重新连接':'本机服务已连接';
    const credential=state.githubCredential;$('platform-credential-state').textContent=credential?.state==='blocked'?'GitHub需要处理：'+credential.note:credential?.source==='protected_file'?'GitHub加密凭据已加载；本机保管期限 '+new Date(credential.storedExpiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'，实际权限与额度在读取时核验。':'';
    const plan=report.plans.find(p=>p.id==='personal-radar');if(initial)fill(plan);else if(!dirty){if(plan&&plan.revision!==saved?.revision)fill(plan);else{saved=plan||saved;updateSummary();}}
    const everyday=(report.runs||[]).filter(r=>!r.planId.startsWith('verify-'));renderRuns($('quick-latest'),everyday.slice(0,1));renderRuns($('quick-history'),everyday.slice(0,12));renderTopicList();
  }
  $('quick-form').addEventListener('input',()=>{dirty=true;updateSummary();});for(const p of ['bilibili','github'])$('quick-'+p).onchange=()=>renderTopicOptions();
  $('quick-form').onsubmit=async event=>{event.preventDefault();try{const plan=core.manualPlan({agent:$('quick-agent').value,subject:$('quick-subject').value,platforms:platforms(),topicIds:[...$('quick-topics').querySelectorAll('input:checked')].map(x=>x.value),from:$('quick-from').value.trim(),recipient:$('quick-recipient').value.trim(),sendApproved:$('quick-approved').checked});
    const valid=core.eligibleTopics(state.topics,plan.platforms);for(const p of plan.platforms)if(!valid.some(t=>plan.topicIds.includes(t.id)&&t.platforms.includes(p)))throw Error('所选平台需要至少一个对应主题。');
    const result=await post('/api/automation/save',{plan,expectedRevision:saved?.revision||0});fill(result);msg('quick-message','统一配置已保存，并同步到已创建的平台计划；各自开关和频率保留。可复制指令到所选Agent手动运行。');await refresh();await refreshPlatforms();document.dispatchEvent(new Event('radar-state-changed'));
    }catch(error){msg('quick-message',error.message,true);}};
  $('quick-copy').onclick=async()=>{if(!saved||dirty){msg('quick-message','请先保存当前配置。',true);return;}const text=core.agentPrompt(saved);try{await navigator.clipboard.writeText(text);msg('quick-message','已复制。粘贴到 '+saved.agent+'，它会自主完成本轮。');}catch{const area=$('quick-prompt');area.closest('details').open=true;area.focus();area.select();msg('quick-message','运行指令已选中，请复制到 '+saved.agent+'。');}};
  $('quick-start').onclick=async()=>{if(!saved||dirty)return;const button=$('quick-start');button.disabled=true;try{const value=await post('/api/automation/start',{planId:saved.id});msg('quick-message',value.started?'本轮已开始；请保持所选 Agent 处理任务。':'已有本轮任务，无需重复启动。');await refresh();}catch(error){msg('quick-message',error.message,true);}};
  const words=text=>text.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);
  $('quick-topic-new').onclick=()=>{editingTopic=null;$('quick-topic-form').reset();$('quick-topic-heading').textContent='添加主题';msg('quick-topic-message','');};
  $('quick-topic-form').onsubmit=async event=>{event.preventDefault();try{const selected=['bilibili','github'].filter(p=>$('quick-topic-'+p).checked);if(!selected.length)throw Error('至少选择一个平台。');const name=$('quick-topic-name').value.trim(),keywords=words($('quick-topic-keywords').value);if(!keywords.length)throw Error('请填写至少一个关键词。');const topic={...(editingTopic||{}),id:editingTopic?.id||'topic-'+crypto.randomUUID().slice(0,8),name,description:editingTopic?.description||name,keywords,exclude:words($('quick-topic-exclude').value),platforms:selected,enabled:editingTopic?.enabled??true,...(selected.includes('bilibili')?{bilibiliDiscovery:'interests',bilibiliAuthors:[]}:{})};
    await post('/api/topics',{topic,...(editingTopic?{expectedRevision:editingTopic.revision}:{})});editingTopic=null;$('quick-topic-form').reset();$('quick-topic-heading').textContent='添加主题';await refresh();renderTopicOptions();msg('quick-topic-message','主题已保存。返回开始运行，勾选它即可。');document.dispatchEvent(new Event('radar-state-changed'));
    }catch(error){msg('quick-topic-message',error.message,true);}};
  read('/api/mail-template').then(data=>{template=data.template;for(const section of ['projects','daily','weekly'])$('quick-section-'+section).checked=template.github.sections.includes(section);$('quick-template-stars').checked=template.github.entry.includes('{stars}');$('quick-template-flow').checked=template.github.entry.includes('{flow}')||template.bilibili.entry.includes('{flow}');$('quick-template-footer').value=template.footer;}).catch(error=>msg('quick-template-message',error.message,true));
  $('quick-template-form').onsubmit=async event=>{event.preventDefault();try{if(!template)throw Error('邮件模板尚未加载。');const next=structuredClone(template);next.github.sections=['projects','daily','weekly'].filter(s=>$('quick-section-'+s).checked);if(!next.github.sections.length)throw Error('GitHub 至少保留一个栏目。');next.github.entry=core.toggleToken(next.github.entry,'stars',$('quick-template-stars').checked);for(const p of ['github','bilibili'])next[p].entry=core.toggleToken(next[p].entry,'flow',$('quick-template-flow').checked);next.footer=$('quick-template-footer').value;const value=await post('/api/mail-template',next);template=value.template;msg('quick-template-message','邮件内容已保存，下次运行生效。已生成的草稿保持原样。');document.dispatchEvent(new Event('radar-state-changed'));}catch(error){msg('quick-template-message',error.message,true);}};
  refresh(true).catch(error=>msg('quick-message',error.message,true));
  refreshPlatforms().catch(error=>{$('platform-control-message').textContent=error.message;});
  setInterval(()=>{if(!document.hidden)refreshPlatforms().catch(()=>{});},15000);
  setInterval(()=>{if(!document.hidden)refresh().catch(()=>{});},5000);
})();
