(() => {
  const status = document.querySelector('#setup-result');
  const checks = document.querySelector('#setup-checks');
  const button = document.querySelector('#setup-refresh');
  const names = {ready:'本机已具备',missing:'待配置',invalid:'需修复',optional:'可选'};
  async function refresh() {
    button.disabled = true;
    try {
      const response = await fetch('/api/setup/status');
      if (!response.ok) throw new Error('配置检查暂不可用，请核对服务是否启动。');
      const report = await response.json();
      status.textContent = report.workflows.map(w => w.title+'：'+(w.localReady?'本机前置条件满足':'待完成 '+w.blockers.join('、'))).join('；')+'。检查不调用模型、不访问平台、不发邮件。';
      if (report.modelProbe.state === 'failed') status.textContent += ' 最近模型响应检查未通过，请先核对当前渠道。';
      checks.replaceChildren(...report.checks.map(c => {
        const row = document.createElement('div'); row.className = 'topic';
        const title = document.createElement('strong'); title.textContent = c.title+' · '+names[c.state];
        const detail = document.createElement('p'); detail.textContent = c.detail;
        const link = document.createElement('a'); link.href = c.href; link.textContent = c.action;
        row.append(title,detail,link); return row;
      }));
    } catch (error) {status.textContent = error.message;}
    finally {button.disabled = false;}
  }
  button.addEventListener('click',refresh);
  document.addEventListener('radar-state-changed',refresh);
  refresh();
})();
