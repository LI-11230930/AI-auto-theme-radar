(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const topic = el('interest-topic'), start = el('interest-start'), cancel = el('interest-cancel');
  const status = el('interest-status'), results = el('interest-results');
  const asrStatus = el('interest-asr-status');
  if (!topic || !start || !cancel || !status || !results) return;

  let running = false, requestPending = false, cancelPending = false, loading = false;
  let cancellationRequested = false, runDispatched = false;
  let eligibleTopics = [], refreshAgain = false;
  let pollTimer = null, pollGeneration = 0;
  const labels = {
    selected: '已精选', assessed: '已分析', skipped: '已跳过', failed: '未完成',
    reused: '复用已有判断', unread: '尚未取得正文', subtitle_needed: '缺少可读字幕', no_subtitle: '未取得可读视频正文', insufficient_body: '正文不足，保留档案',
    ok: '取得成功', partial: '部分取得', unavailable: '暂不可用', cancelled: '已取消',
    ready: '已准备', done: '已完成', complete: '已完成', blocked: '已停止',
    recommendation: '账号推荐', recommendations: '账号推荐', search: '兴趣关键词搜索',
    history: '账号历史', interests: '兴趣发现', starting: '准备开始', discovering: '发现候选',
    reading: '取得字幕或语音文字', analyzing: 'Agent正在分析', freezing: '准备草稿', finished: '已结束', stopped: '已停止'
  };
  const clean = (value, limit = 300) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
  const number = value => Number.isInteger(value) && value >= 0 ? String(value) : '未知';
  const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(value) ? value : '';
  const label = value => labels[value] || clean(value, 60) || '未知';
  function updateButtons() {
    start.disabled = loading || requestPending || running || !eligibleTopics.length;
    topic.disabled = loading || requestPending || running;
    cancel.disabled = cancelPending || cancellationRequested || !(requestPending || running);
  }
  function errorText(error) {
    return (error && error.radarCode ? error.radarCode + '：' : '') +
      '请求未完成，请核对本地服务状态；未自动重试。';
  }
  async function read(path, options) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    let data;
    try { data = await response.json(); } catch { throw Error('INVALID_RESPONSE'); }
    if (!response.ok) {
      const error = Error('REQUEST_FAILED');
      error.radarCode = code(data && data.code);
      throw error;
    }
    return data;
  }
  async function post(path, body, beforeSend) {
    const state = await read('/api/state');
    if (typeof state.token !== 'string' || !state.token) throw Error('TOKEN_UNAVAILABLE');
    if (beforeSend) beforeSend();
    return read(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Radar-Token': state.token },
      body: JSON.stringify(body)
    });
  }
  function videoUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://www.bilibili.com' || url.username || url.password ||
          !/^\/video\/BV[A-Za-z0-9]{10}\/?$/.test(url.pathname)) return null;
      return url.origin + url.pathname.replace(/\/$/, '') + '/';
    } catch { return null; }
  }
  function sampleUrl(value) {
    if (typeof value !== 'string' || !value.startsWith('/preview/bilibili-sample?')) return null;
    try {
      const url = new URL(value, window.location.origin);
      const id = url.searchParams.get('id');
      if (url.origin !== window.location.origin || url.pathname !== '/preview/bilibili-sample' ||
          url.hash || [...url.searchParams.keys()].length !== 1 ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id || '')) return null;
      return '/preview/bilibili-sample?id=' + encodeURIComponent(id);
    } catch { return null; }
  }
  function addText(parent, tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    parent.append(node);
    return node;
  }
  function renderAsr(value) {
    if (!asrStatus) return;
    asrStatus.replaceChildren();
    addText(asrStatus, 'span', value && value.enabled === true
      ? '语音转写已启用：仅在P1无可读字幕时尝试，限10分钟以内视频；机器转写可能误识别。'
      : '语音转写尚未启用；当前优先读取字幕。');
    if (value && value.lastProbe && value.lastProbe.comparisonPreview === '/preview/asr-comparison') {
      const link = document.createElement('a'); link.href = '/preview/asr-comparison';
      link.textContent = ' 查看语音转写对照样本';link.target = '_blank';link.rel = 'noopener noreferrer';asrStatus.append(link);
    }
  }
  function render(report) {
    results.replaceChildren();
    if (!report || typeof report !== 'object') return;
    const deliveryState = report.delivery && report.delivery.state;
    const sampleReview = report.currentSampleReview;
    const outdatedSample = sampleReview && sampleReview.available === true && sampleReview.sampleCurrent === false;
    const mailLine = deliveryState === 'sent_confirmed' ? '本轮邮件已核对送达。'
      : deliveryState === 'submitted' ? '本轮邮件发送调用已提交，送达待核对。'
      : ['submitting','uncertain'].includes(deliveryState) ? '本轮邮件结果待核对，请勿重复发送。'
      : deliveryState === 'failed' ? '本轮发送尝试未成功，未自动重发。'
      : report.emailSent === true ? '请在投递账本核对邮件状态。' : '本轮未发送邮件。';
    const lines = [
      '主题：' + clean(report.topicId, 100),
      ...(report.stage ? ['阶段：' + label(report.stage)] : []),
      '发现 ' + number(report.discovered) + ' 条 · 初筛 ' + number(report.prefiltered) + ' 条',
      mailLine
    ];
    if (report.reused) lines.push('已复用同一轮结果。');
    if (report.stoppedReason) lines.push('停止原因：' + clean(report.stoppedReason, 200));
    if (report.deferredSelected > 0) lines.push('每日精选额度不足，另有 ' + number(report.deferredSelected) + ' 条判断保留档案。');
    if (report.sampleIssue) lines.push('草稿准备：' + clean(report.sampleIssue, 100));
    if (report.counts) lines.push('尝试 ' + number(report.counts.attempted) + ' 条 · 新取得 ' + number(report.counts.newSourceReads) + ' 条 · 复用材料 ' + number(report.counts.cachedMaterials) + ' 条；新判断 ' + number(report.counts.newAssessments) + ' 条 · 复用判断 ' + number(report.counts.reusedAssessments) + ' 条 · 正文不足跳过 ' + number(report.counts.insufficientBody) + ' 条');
    if (outdatedSample) lines.push('历史草稿 ' + number(sampleReview.frozenCount) + ' 条，当前符合条件 ' + number(sampleReview.eligibleNow) + ' 条；原冻结内容保留，不能直接沿用发送。');
    const sources = Array.isArray(report.sources) ? report.sources.slice(0, 20) : [];
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      lines.push(label(source.kind) + ' · ' + label(source.state) +
        (source.count !== undefined ? ' · ' + number(source.count) + ' 条' : '') +
        (code(source.code) ? ' · ' + code(source.code) : ''));
    }
    status.textContent = lines.join('\n');
    const rows = Array.isArray(report.results) ? report.results.slice(0, 30) : [];
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue;
      const row = document.createElement('section');
      row.className = 'topic';
      const heading = document.createElement('h3');
      const title = clean(item.title, 200) || clean(item.itemKey, 100) || '视频';
      const href = videoUrl(item.url);
      if (href) {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = title;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        heading.append(link);
      } else heading.textContent = title;
      row.append(heading);
      const currentlyExcluded = outdatedSample && Array.isArray(sampleReview.excluded) && sampleReview.excluded.find(entry => entry.itemKey === item.itemKey);
      addText(row, 'p', (currentlyExcluded ? '历史判断选中，当前已排除' : item.selected === true ? '已精选' : item.selected === false ? '未选中' : label(item.state)) +
        (item.authorUid ? ' · UP 主 UID ' + clean(item.authorUid, 30) : '') +
        (code(item.code) ? ' · ' + code(item.code) : ''));
      if (item.summaryZh) addText(row, 'p', clean(item.summaryZh, 1000));
      if (currentlyExcluded) addText(row, 'p', currentlyExcluded.reason === 'insufficient_video_body' ? '当前视频正文信息量不足，不进入新草稿；以上介绍为历史判断。' : '当前材料或判断不再满足草稿条件；以上介绍为历史判断。');
      if (item.acquisition && typeof item.acquisition === 'object') {
        const acquisition = item.acquisition;
        if (acquisition.selectionGate && acquisition.selectionGate.sufficient === false) addText(row, 'p', '视频正文信息量不足：有效文字 ' + number(acquisition.selectionGate.characters) + ' / 最低 ' + number(acquisition.selectionGate.minimumCharacters) + ' 字；未进入邮件精选。');
        const materials = Array.isArray(acquisition.videoText) ? acquisition.videoText.slice(0, 3) : [];
        const materialText = materials.map(m => (m.kind === 'asr:p1' ? 'P1机器转写' : 'P1字幕') + ' ' + number(m.characters) + '字').join('、');
        addText(row, 'p', (acquisition.cached === true ? '复用归档材料：' : '本次取得：') +
          (materialText || '未取得可读视频正文') +
          (acquisition.agentRead === true ? '；当前判断引用了视频正文。' : '；本轮没有确认模型引用视频正文。'));
        if (Array.isArray(acquisition.asr)) for (const part of acquisition.asr.slice(0, 1)) {
          let detail = part.state === 'acquired' ? '语音回退已取得文字' : part.state === 'insufficient_text' ? '语音回退文字不足，已跳过' : part.state === 'not_ready' ? '语音回退环境未准备' : '语音回退未完成';
          const range = part.processedRange;
          if (range && Number.isFinite(range.from) && Number.isFinite(range.to)) detail += ' · 处理 ' + range.from.toFixed(1) + '–' + range.to.toFixed(1) + ' 秒';
          if (code(part.reason)) detail += ' · ' + code(part.reason);
          addText(row, 'p', detail);
        }
      }
      if (Array.isArray(item.warnings) && item.warnings.length) {
        addText(row, 'p', '阅读提示：' + item.warnings.slice(0, 8).map(warning => clean(warning, 180)).filter(Boolean).join('；'));
      }
      results.append(row);
    }
    if (!rows.length) addText(results, 'p', '本轮没有可展示的阅读结果。');
    const preview = report.sample && sampleUrl(report.sample.preview);
    if (preview) {
      const link = document.createElement('a');
      link.href = preview;
      link.textContent = (outdatedSample ? '查看历史冻结草稿（' : '查看本轮邮件内容（') + number(report.sample.count) + ' 条）';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      results.append(link);
    }
  }
  function stopPolling() {
    pollGeneration++;
    if (pollTimer !== null && typeof clearTimeout === 'function') clearTimeout(pollTimer);
    pollTimer = null;
  }
  function activeReport(current) {
    return current.running === true && Array.isArray(current.activeRuns)
      ? current.activeRuns.find(report => report && report.topicId === topic.value) : null;
  }
  function schedulePoll() {
    if (pollTimer !== null || !(running || requestPending && runDispatched) || typeof setTimeout !== 'function') return;
    const generation = pollGeneration;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      try {
        const current = await read('/api/bilibili/interest/status');
        if (generation !== pollGeneration) return;
        running = current.running === true;
        renderAsr(current.asr);
        const active = activeReport(current);
        if (active) {
          render(active);
          status.textContent = (cancellationRequested ? '已请求取消，等待当前操作结束。\n' : '本轮仍在运行。\n') + status.textContent;
        } else if (!requestPending && current.lastRun) render(current.lastRun);
      } catch {
        if (generation === pollGeneration) status.textContent = '运行状态暂时无法刷新；保留后台任务，请勿重复启动，可稍后刷新核对。';
      } finally {
        if (generation === pollGeneration) { updateButtons(); schedulePoll(); }
      }
    }, 5000);
  }
  async function load() {
    if (loading) { refreshAgain = true; return; }
    loading = true;
    updateButtons();
    try {
      const state = await read('/api/state');
      const selected = topic.value;
      eligibleTopics = (Array.isArray(state.topics) ? state.topics : []).filter(item => item &&
        item.enabled && Array.isArray(item.platforms) && item.platforms.includes('bilibili') &&
        item.bilibiliDiscovery === 'interests');
      topic.replaceChildren(...eligibleTopics.map(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = clean(item.name, 100) || clean(item.id, 100);
        return option;
      }));
      if (eligibleTopics.some(item => item.id === selected)) topic.value = selected;
      const current = await read('/api/bilibili/interest/status');
      renderAsr(current.asr);
      running = current.running === true;
      if (!requestPending) {
        const active = activeReport(current);
        if (active) render(active);
        else if (current.lastRun) render(current.lastRun);
        else results.replaceChildren();
        if (running) status.textContent = active ? '本轮仍在运行。\n' + status.textContent : '已有兴趣阅读正在运行，正在更新进度。';
        else if (!current.lastRun) status.textContent = eligibleTopics.length
          ? '选择兴趣主题后，可开始一轮阅读；最多阅读 3 条视频，生成草稿，不发送邮件。'
          : '尚无启用的 B站兴趣发现主题，请先在主题设置中保存兴趣主题。';
      }
    } catch (error) {
      if (!requestPending) {
        running = true;
        status.textContent = errorText(error) + '\n后台状态暂无法核对，请刷新页面后再开始。';
      }
    }
    finally {
      loading = false;
      updateButtons();
      schedulePoll();
      if (refreshAgain) { refreshAgain = false; void load(); }
    }
  }
  start.addEventListener('click', async () => {
    if (requestPending || running || loading || !eligibleTopics.some(item => item.id === topic.value)) return;
    requestPending = true;
    cancellationRequested = false;
    runDispatched = false;
    updateButtons();
    results.replaceChildren();
    status.textContent = '正在发现候选、取得字幕与弹幕并由 Agent 阅读；最多 3 条。请等待本次请求完成。';
    try {
      const report = await post('/api/bilibili/interest/run', { topicId: topic.value, readLimit: 3 }, () => {
        if (cancellationRequested) {
          const error = Error('CANCELLED_BEFORE_DISPATCH');
          error.cancelledBeforeDispatch = true;
          throw error;
        }
        runDispatched = true;
        schedulePoll();
      });
      running = false;
      render(report);
      document.dispatchEvent(new Event('radar-state-changed'));
    } catch (error) {
      if (error.cancelledBeforeDispatch) {
        status.textContent = '启动已取消，本轮未启动后台阅读。';
        return;
      }
      status.textContent = errorText(error);
      // A lost HTTP response does not establish that the server stopped its job.
      try { running = (await read('/api/bilibili/interest/status')).running === true; }
      catch { running = true; }
      if (running) status.textContent += '\n后台状态可能仍在运行，请刷新核对或点击取消。';
    } finally { requestPending = false; stopPolling(); updateButtons(); schedulePoll(); }
  });
  cancel.addEventListener('click', async () => {
    if (cancelPending || cancellationRequested || !(requestPending || running)) return;
    cancellationRequested = true;
    cancelPending = true;
    updateButtons();
    try {
      if (requestPending && !runDispatched) {
        status.textContent = '启动已取消，本轮未启动后台阅读。';
        return;
      }
      await post('/api/bilibili/interest/cancel', {});
      status.textContent = '已请求取消；当前已完成的阅读保留。请等待本轮请求返回，或刷新页面核对结果。';
    } catch (error) { status.textContent = errorText(error); }
    finally { cancelPending = false; updateButtons(); }
  });
  document.addEventListener('radar-state-changed', () => { void load(); });
  window.addEventListener?.('pagehide', stopPolling);
  start.disabled = true;
  cancel.disabled = true;
  void load();
})();
