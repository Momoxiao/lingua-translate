/**
 * Lingua — popup controller.
 * Reads/writes settings directly in chrome.storage.local (the content script
 * picks the change up through storage.onChanged) and polls the page for status.
 * Two independent panels: video subtitles and full-page translation.
 */
(function () {
  'use strict';
  const NS = globalThis.Lingua;
  const { LANGUAGES, PROVIDERS } = NS.constants;
  const { getSettings, setSettings } = NS.settings;
  const { emptySubtitleNote } = NS.utils;

  const el = (id) => document.getElementById(id);
  const ui = {
    statusPill: el('statusPill'),
    statusText: el('statusText'),
    modeLabel: el('modeLabel'),
    tabs: el('tabs'),
    // video
    enabled: el('enabled'),
    providerName: el('providerName'),
    target: el('target'),
    displayMode: el('displayMode'),
    trackField: el('trackField'),
    track: el('track'),
    progressBox: el('progressBox'),
    progressBar: el('progressBar'),
    progressLabel: el('progressLabel'),
    progressNum: el('progressNum'),
    note: el('note'),
    retranslate: el('retranslate'),
    // page
    pageHost: el('pageHost'),
    pageToggle: el('pageToggle'),
    pageStateCard: el('pageStateCard'),
    pageStateTitle: el('pageStateTitle'),
    pageMode: el('pageMode'),
    pageStyle: el('pageStyle'),
    pageShowOriginal: el('pageShowOriginal'),
    pageBall: el('pageBall'),
    siteRule: el('siteRule'),
    pageProfileValue: el('pageProfileValue'),
    // The page progress is a hairline inside the state card: the card's title
    // already carries "翻译中 34/86", so a second labelled bar is redundant.
    pageProgressBox: el('pageProgressBox'),
    pageProgressBar: el('pageProgressBar'),
    pageNote: el('pageNote'),
    pageRetranslate: el('pageRetranslate'),
    // foot
    footHint: el('footHint'),
    openDiagnostics: el('openDiagnostics'),
    openOptions: el('openOptions'),
  };

  let settings = null;
  let tabId = null;
  let supported = false;
  let lastState = null;
  /** which panel is on screen: 'video' | 'page' — decided once, from the URL */
  let activeTab = 'page';
  let pollTimer = 0;
  let syncing = false; // guard so programmatic checkbox writes don't fire handlers

  const VIDEO_STATUS = {
    idle: { tone: 'idle', text: '未启用' },
    loading: { tone: 'busy', text: '读取字幕' },
    translating: { tone: 'busy', text: '翻译中' },
    ready: { tone: 'ok', text: '已就绪' },
    // Both 'empty' cases get the pill from emptySubtitleNote() below: the tracks
    // ARE there in the more common of the two, and calling that "无字幕" is the
    // same lie the note used to tell.
    empty: { tone: 'warn', text: '无字幕' },
    error: { tone: 'err', text: '出错' },
    live: { tone: 'busy', text: '直播模式' },
  };

  const PAGE_STATUS = {
    idle: { tone: 'idle', text: '未翻译' },
    scanning: { tone: 'busy', text: '扫描中' },
    translating: { tone: 'busy', text: '翻译中' },
    done: { tone: 'ok', text: '已翻译' },
    error: { tone: 'err', text: '出错' },
  };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function fillLanguages() {
    ui.target.innerHTML = '';
    for (const l of LANGUAGES) {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.label;
      ui.target.appendChild(o);
    }
  }

  function fillTracks(state) {
    const tracks = (state && state.subtitle && state.subtitle.tracks) || [];
    if (tracks.length < 2) {
      ui.trackField.hidden = true;
      return;
    }
    ui.trackField.hidden = false;
    ui.track.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = '自动选择';
    ui.track.appendChild(auto);
    for (const t of tracks) {
      const o = document.createElement('option');
      o.value = t.languageCode;
      o.textContent = `${t.name || t.languageCode}${t.kind === 'asr' ? '（自动生成）' : ''}`;
      ui.track.appendChild(o);
    }
    ui.track.value = settings.sourceLang || 'auto';
  }

  function setNote(target, text, tone) {
    if (!text) {
      target.hidden = true;
      return;
    }
    target.hidden = false;
    target.dataset.tone = tone || 'info';
    target.textContent = text;
  }

  function setStatus(tone, text) {
    ui.statusPill.dataset.tone = tone;
    ui.statusText.dataset.tone = tone;
    ui.statusText.textContent = text;
  }

  function renderStatic() {
    const provider = PROVIDERS[settings.provider];
    const ready = NS.settings.providerReady(settings);
    const model = modelOf(settings.provider);
    ui.providerName.textContent = provider
      ? `${provider.label}${model ? ' · ' + model : ''}${ready ? '' : ' · 未配置'}`
      : '未选择供应商';
    ui.providerName.dataset.state = ready ? 'ready' : 'missing';
    ui.enabled.checked = !!settings.enabled;
    ui.target.value = settings.targetLang;
    for (const btn of ui.displayMode.querySelectorAll('button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === settings.displayMode));
    }

    ui.pageMode.value = (settings.page && settings.page.displayMode) || 'bilingual';
    ui.pageStyle.value = (settings.page && settings.page.style) || 'underline';
    ui.pageBall.checked = !settings.page || settings.page.showBall !== false;
    ui.footHint.textContent = provider ? `${provider.label} → ${labelOf(settings.targetLang)}` : '未配置翻译服务';
  }

  /** Short "which model am I actually using" label for the popup header. */
  function modelOf(providerId) {
    const cfg = (settings.providers && settings.providers[providerId]) || {};
    if (providerId === 'openai') return cfg.model || '';
    if (providerId === 'custom') {
      return String(cfg.url || '').replace(/^https?:\/\//, '').split('/')[0] || '';
    }
    if (providerId === 'deepl') return cfg.pro ? 'Pro' : 'Free';
    if (providerId === 'microsoft') return cfg.region || '';
    if (providerId === 'google') return cfg.apiKey ? '官方接口' : '免费接口';
    return '';
  }

  function labelOf(code) {
    const l = LANGUAGES.find((x) => x.code === code);
    return l ? l.label : code;
  }

  function renderVideoPanel(state) {
    const s = state.subtitle || {};
    // 'empty' covers two unrelated failures; emptySubtitleNote() is the single
    // source of the wording for both, shared with the diagnostics page.
    const empty = s.status === 'empty' ? emptySubtitleNote(s) : null;
    const meta = VIDEO_STATUS[s.status] || VIDEO_STATUS.idle;
    if (activeTab === 'video') {
      // The pill is 4 characters wide — it cannot carry the explanation, but it
      // must at least stop claiming the video has no captions when it does.
      // `unparsed-track` matters here too: the data arrived and we failed to read
      // it, so falling through to the `empty` default would print "无字幕" — the
      // exact false claim this split exists to remove.
      const pill =
        empty && empty.reason === 'unparsed-track'
          ? '解析失败'
          : empty && empty.reason === 'empty-track'
            ? '取字幕失败'
            : // `live` covers a real stream AND a VOD whose whole-track fetch
              // failed. Telling a VOD user "直播模式" says their ordinary video
              // is a stream, which is both wrong and useless — the actionable
              // fact is that the fast path degraded and a re-run may recover it.
              s.status === 'live' && !s.isLiveStream
              ? '实时兜底'
              : meta.text;
      setStatus(empty ? empty.tone : meta.tone, pill);
    }

    fillTracks(state);

    // Realtime mode has no cue list — it translates the one line being spoken —
    // so `cueCount` is always 0 there. Reading progress from cueCount alone hid
    // the progress row and disabled the button while subtitles were working.
    const liveStats = s.live || null;
    const inRealtime = s.status === 'live' || !!(liveStats && (liveStats.lines || liveStats.translated));

    if (!s.cueCount && !inRealtime) {
      ui.progressBox.hidden = true;
    } else if (inRealtime) {
      // There is no total to divide by: lines arrive as they are spoken. Show
      // that lines are landing rather than a percentage that would be a lie.
      ui.progressBox.hidden = false;
      ui.progressBar.style.width = '100%';
      ui.progressNum.textContent = `${liveStats ? liveStats.translated || 0 : 0} 句`;
      ui.progressLabel.textContent = liveStats && liveStats.lines ? '实时翻译中' : '实时翻译（等待第一句）';
    } else {
      ui.progressBox.hidden = false;
      const pct = Math.round(((s.translated || 0) / s.cueCount) * 100);
      ui.progressBar.style.width = `${pct}%`;
      // No spaces around the slash: the page panel, the ball and this row all
      // show the same "done/total" shape, and they used to disagree.
      ui.progressNum.textContent = `${s.translated || 0}/${s.cueCount}`;
      ui.progressLabel.textContent = (s.translated || 0) >= s.cueCount ? '翻译完成' : s.liveMode ? '实时翻译' : '翻译中';
    }

    // The label follows the state. Before anything is translated this button is
    // the manual start — which is the only way in when 进入视频后自动开始翻译 is
    // off — and afterwards it re-runs the pipeline. Hiding it instead would
    // strand that user with no trigger at all.
    ui.retranslate.textContent = (s.translated || 0) > 0 || (liveStats && liveStats.translated > 0) ? '重新翻译' : '开始翻译';
    // Realtime mode is exactly the state a user wants to escape by re-running:
    // it means the whole-track fetch lost its race, and a retry often wins.
    ui.retranslate.disabled = !s.cueCount && !inRealtime;

    if (!state.isWatchPage) {
      setNote(ui.note, '当前不是 YouTube 视频播放页。', 'info');
    } else if (s.error) {
      setNote(ui.note, s.error, 'err');
    } else if (s.status === 'empty') {
      setNote(ui.note, empty.text, empty.tone);
    } else if (!settings.enabled) {
      setNote(ui.note, '已暂停，字幕不会翻译。', 'info');
    } else if (!NS.settings.providerReady(settings)) {
      setNote(ui.note, '尚未配置翻译服务，请前往设置填写凭据。', 'warn');
    } else {
      setNote(ui.note, '');
    }
  }

  /**
   * The same wording the floating ball uses, so the two controls always read
   * identically — a popup that says something different from the ball on the
   * page is exactly the desync users notice.
   */
  function pageStatusText(p) {
    if (p.status === 'error') return p.error ? `出错：${p.error}` : '翻译出错';
    if (p.status === 'scanning') return '正在扫描页面…';
    if (p.status === 'translating') return `翻译中 ${p.done || 0}/${p.total || 0}`;
    if (p.active) return p.total ? `已翻译 ${p.done || 0}/${p.total || 0}` : '已开启';
    return '未翻译';
  }

  function renderPagePanel(state) {
    const p = state.page || {};
    // Same table the video panel uses. Hand-rolling this mapped "translating"
    // to green (it tested `active`, which is also true once finished), so the
    // pill said green while the card below it said orange — for one state.
    const meta = PAGE_STATUS[p.status] || PAGE_STATUS.idle;
    if (activeTab === 'page') setStatus(meta.tone, pageStatusText(p));

    ui.pageHost.textContent = state.host || '—';
    ui.pageStateTitle.textContent = pageStatusText(p);
    ui.pageStateCard.dataset.tone = p.status === 'error' ? 'err' : p.active ? 'on' : 'idle';
    // Once the run is finished there is nothing left to stop, and 停止 next to
    // "已翻译 86/86" reads as if something were still going. Clicking it puts
    // the page back, so say that instead.
    ui.pageToggle.textContent = !p.active ? '开始翻译' : p.status === 'done' ? '还原原文' : '停止';
    // Drives the click handler. It used to read the button's own label to decide
    // which way the toggle was going, so relabelling the button silently changed
    // the logic — a state flag cannot drift from the state.
    ui.pageToggle.dataset.active = p.active ? '1' : '';
    ui.pageToggle.disabled = false;
    // Before the first run this duplicates 开始翻译, so it only appears once
    // there is something to re-translate.
    ui.pageRetranslate.hidden = !p.active;

    syncing = true;
    ui.pageShowOriginal.checked = !!p.showOriginal;
    if (p.mode) ui.pageMode.value = p.mode;
    if (p.style) ui.pageStyle.value = p.style;
    if (p.rule) ui.siteRule.value = p.rule;
    syncing = false;

    if (p.active && p.total) {
      ui.pageProgressBox.hidden = false;
      const pct = Math.round(((p.done || 0) / p.total) * 100);
      ui.pageProgressBar.style.width = `${pct}%`;
    } else {
      ui.pageProgressBox.hidden = true;
    }

    // Show which "translation expert" the page was assigned, so the adaptive
    // behaviour is something the user can see and disagree with. Only the
    // override is annotated: "自动识别" on every page would be noise.
    const prof = p.profile;
    ui.pageProfileValue.textContent = prof
      ? prof.confidence === 'manual'
        ? `${prof.label} · 手动`
        : prof.label
      : '';

    if (p.error) {
      setNote(ui.pageNote, p.error, 'err');
    } else if (p.rule === 'skip') {
      setNote(ui.pageNote, '已把本站设为「不翻译」。改回「手动翻译」即可恢复。', 'info');
    } else if (!NS.settings.providerReady(settings)) {
      setNote(ui.pageNote, '尚未配置翻译服务，请前往设置填写凭据。', 'warn');
    } else if (!p.active && p.showBall !== false) {
      setNote(ui.pageNote, '提示：页面上的悬浮球也能直接开始翻译。', 'info');
    } else {
      setNote(ui.pageNote, '');
    }
  }

  // ---------------------------------------------------------------------------
  // Page state polling
  // ---------------------------------------------------------------------------
  function queryState() {
    if (!supported || tabId == null) return;
    try {
      chrome.tabs.sendMessage(tabId, { type: 'lingua:get-state' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          setStatus('warn', '未注入');
          setNote(ui.note, '页面脚本尚未就绪，刷新页面后重试。', 'info');
          setNote(ui.pageNote, '页面脚本尚未就绪，刷新页面后重试。', 'info');
          ui.progressBox.hidden = true;
          ui.pageProgressBox.hidden = true;
          return;
        }
        lastState = res.state;
        renderVideoPanel(res.state);
        renderPagePanel(res.state);
      });
    } catch (e) {
      /* tab gone */
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    // Push updates do the real work; this is only a safety net for the case where
    // the page script restarts and misses a broadcast.
    pollTimer = setInterval(queryState, 2500);
  }

  /**
   * The content script broadcasts every meaningful state change, so the popup
   * tracks the floating ball in real time instead of waiting for a poll tick.
   */
  function listenForPageState() {
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.type !== 'lingua:page-state') return;
        lastState = Object.assign({}, lastState || {}, { page: msg.page, host: msg.host });
        renderPagePanel(lastState);
      });
    } catch (e) {
      /* not available */
    }
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------
  /**
   * Show exactly one panel.
   *
   * The two halves of the product never apply at the same time: subtitles only
   * exist on a YouTube video page, web-page translation applies to everything
   * else. Presenting both as tabs meant one was always a dead end — and on
   * YouTube the dead end was the one selected by default.
   */
  function showPanel(name) {
    activeTab = name;
    for (const panel of document.querySelectorAll('.panel')) {
      panel.hidden = panel.dataset.panel !== name;
    }
    for (const btn of ui.tabs.querySelectorAll('button')) {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
    }
    ui.modeLabel.textContent = name === 'video' ? '视频字幕' : '网页翻译';
    if (lastState) {
      renderVideoPanel(lastState);
      renderPagePanel(lastState);
    } else {
      queryState();
    }
  }

  /** A YouTube URL that actually carries a video. */
  function isVideoPage(url) {
    return /(^|\.)youtube(-nocookie)?\.com\/(watch|shorts|live|embed)/.test(url);
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      if (tabId == null) return resolve({ ok: false });
      try {
        chrome.tabs.sendMessage(tabId, { type, payload }, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message) });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function bindEvents() {
    ui.tabs.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-tab]');
      if (btn) showPanel(btn.dataset.tab);
    });

    // ---- video ----
    ui.enabled.addEventListener('change', async () => {
      settings = await setSettings({ enabled: ui.enabled.checked });
      renderStatic();
      queryState();
    });

    ui.target.addEventListener('change', async () => {
      settings = await setSettings({ targetLang: ui.target.value });
      renderStatic();
      queryState();
    });

    ui.track.addEventListener('change', async () => {
      settings = await setSettings({ sourceLang: ui.track.value });
      renderStatic();
      queryState();
    });

    ui.displayMode.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-mode]');
      if (!btn) return;
      settings = await setSettings({ displayMode: btn.dataset.mode });
      renderStatic();
    });

    ui.retranslate.addEventListener('click', async () => {
      await send('lingua:retranslate');
      setTimeout(queryState, 300);
    });

    // ---- page ----
    // One button, exactly like clicking the floating ball.
    ui.pageToggle.addEventListener('click', async () => {
      if (syncing) return;
      const wantStop = ui.pageToggle.dataset.active === '1';
      ui.pageToggle.disabled = true;
      const res = await send('lingua:page-toggle');
      if (!res.ok) {
        setNote(ui.pageNote, res.error || '无法启动网页翻译', 'err');
      }
      ui.pageToggle.disabled = false;
      setTimeout(queryState, wantStop ? 120 : 250);
    });

    ui.pageMode.addEventListener('change', async () => {
      if (syncing) return;
      settings = await setSettings({ page: { displayMode: ui.pageMode.value } });
    });

    ui.pageStyle.addEventListener('change', async () => {
      if (syncing) return;
      settings = await setSettings({ page: { style: ui.pageStyle.value } });
    });

    ui.pageShowOriginal.addEventListener('change', async () => {
      if (syncing) return;
      await send('lingua:page-toggle-original');
      setTimeout(queryState, 120);
    });

    ui.siteRule.addEventListener('change', async () => {
      if (syncing) return;
      await send('lingua:site-rule', { rule: ui.siteRule.value });
      setTimeout(queryState, 200);
    });

    ui.pageBall.addEventListener('change', async () => {
      if (syncing) return;
      settings = await setSettings({ page: { showBall: ui.pageBall.checked } });
      setTimeout(queryState, 200);
    });

    ui.pageRetranslate.addEventListener('click', async () => {
      await send('lingua:page-retranslate');
      setTimeout(queryState, 300);
    });

    ui.openOptions.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });

    // The popup knows which tab the user is looking at; the diagnostics page
    // cannot work that out on its own (it IS a tab), so pass it along.
    ui.openDiagnostics.addEventListener('click', () => {
      const q = tabId != null ? `?tab=${tabId}` : '';
      chrome.tabs.create({ url: chrome.runtime.getURL(`src/diagnostics/diagnostics.html${q}`) });
      window.close();
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  (async function boot() {
    settings = await getSettings();
    fillLanguages();
    renderStatic();
    bindEvents();

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    const url = (tab && tab.url) || '';
    supported = /^https?:\/\//.test(url) || url.startsWith('file://');

    if (supported) {
      tabId = tab.id;
      listenForPageState();
      // A YouTube video page is the one place where BOTH halves apply: the video
      // has captions to translate and the page around it (description, comments,
      // sidebar) has prose. Everywhere else there is nothing to switch between,
      // so the switcher stays hidden rather than offering a dead end.
      const videoMode = isVideoPage(url);
      ui.tabs.hidden = !videoMode;
      showPanel(videoMode ? 'video' : 'page');
      queryState();
      startPolling();
    } else {
      showPanel('page');
      setStatus('warn', '不支持');
      setNote(ui.pageNote, '当前页面不支持翻译（仅支持 http/https 网页）。', 'info');
      ui.pageToggle.disabled = true;
      ui.pageRetranslate.disabled = true;
      ui.retranslate.disabled = true;
    }
  })();

  window.addEventListener('unload', () => clearInterval(pollTimer));
})();
