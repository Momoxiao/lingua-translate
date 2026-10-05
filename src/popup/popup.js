/**
 * Lingua — popup controller.
 * Reads/writes settings directly in chrome.storage.local (the content script
 * picks the change up through storage.onChanged) and polls the page for status.
 * Two independent panels: video subtitles and full-page translation.
 */
(function () {
  'use strict';
  const NS = globalThis.YTST;
  const { LANGUAGES, PROVIDERS } = NS.constants;
  const { getSettings, setSettings } = NS.settings;

  const el = (id) => document.getElementById(id);
  const ui = {
    statusPill: el('statusPill'),
    statusText: el('statusText'),
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
    pageEnabled: el('pageEnabled'),
    pageMode: el('pageMode'),
    pageStyle: el('pageStyle'),
    pageShowOriginal: el('pageShowOriginal'),
    pageBall: el('pageBall'),
    siteRule: el('siteRule'),
    pageProgressBox: el('pageProgressBox'),
    pageProgressBar: el('pageProgressBar'),
    pageProgressLabel: el('pageProgressLabel'),
    pageProgressNum: el('pageProgressNum'),
    pageNote: el('pageNote'),
    pageRetranslate: el('pageRetranslate'),
    // foot
    footHint: el('footHint'),
    openOptions: el('openOptions'),
  };

  let settings = null;
  let tabId = null;
  let supported = false;
  let lastState = null;
  let activeTab = 'video';
  let pollTimer = 0;
  let syncing = false; // guard so programmatic checkbox writes don't fire handlers

  const VIDEO_STATUS = {
    idle: { tone: 'idle', text: '未启用' },
    loading: { tone: 'busy', text: '读取字幕' },
    translating: { tone: 'busy', text: '翻译中' },
    ready: { tone: 'ok', text: '已就绪' },
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
    ui.providerName.textContent = provider
      ? `服务：${provider.label}${NS.settings.providerReady(settings) ? '' : '（未配置）'}`
      : '服务未选择';
    ui.enabled.checked = !!settings.enabled;
    ui.target.value = settings.targetLang;
    for (const btn of ui.displayMode.querySelectorAll('button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === settings.displayMode));
    }

    ui.pageEnabled.checked = false;
    ui.pageMode.value = (settings.page && settings.page.displayMode) || 'bilingual';
    ui.pageStyle.value = (settings.page && settings.page.style) || 'underline';
    ui.pageBall.checked = !settings.page || settings.page.showBall !== false;
    ui.footHint.textContent = provider
      ? `${provider.label} → ${labelOf(settings.targetLang)}`
      : '未配置服务';
  }

  function labelOf(code) {
    const l = LANGUAGES.find((x) => x.code === code);
    return l ? l.label : code;
  }

  function renderVideoPanel(state) {
    const s = state.subtitle || {};
    const meta = VIDEO_STATUS[s.status] || VIDEO_STATUS.idle;
    if (activeTab === 'video') setStatus(meta.tone, meta.text);

    fillTracks(state);

    if (!s.cueCount) {
      ui.progressBox.hidden = true;
    } else {
      ui.progressBox.hidden = false;
      const pct = Math.round(((s.translated || 0) / s.cueCount) * 100);
      ui.progressBar.style.width = `${pct}%`;
      ui.progressNum.textContent = `${s.translated || 0} / ${s.cueCount}`;
      ui.progressLabel.textContent = (s.translated || 0) >= s.cueCount ? '翻译完成' : s.liveMode ? '实时翻译' : '翻译中';
    }

    if (!state.isWatchPage) {
      setNote(ui.note, '当前不是 YouTube 视频播放页。', 'info');
    } else if (s.error) {
      setNote(ui.note, s.error, 'err');
    } else if (s.status === 'empty') {
      setNote(ui.note, '该视频没有可用字幕。', 'warn');
    } else if (!settings.enabled) {
      setNote(ui.note, '已暂停，字幕不会翻译。', 'info');
    } else if (!NS.settings.providerReady(settings)) {
      setNote(ui.note, '尚未配置翻译服务，请前往设置填写 API。', 'warn');
    } else {
      setNote(ui.note, '');
    }
  }

  function renderPagePanel(state) {
    const p = state.page || {};
    const meta = PAGE_STATUS[p.status] || PAGE_STATUS.idle;
    if (activeTab === 'page') setStatus(meta.tone, meta.text);

    ui.pageHost.textContent = state.host || location.hostname;

    syncing = true;
    ui.pageEnabled.checked = !!p.active;
    ui.pageShowOriginal.checked = !!p.showOriginal;
    if (p.mode) ui.pageMode.value = p.mode;
    if (p.style) ui.pageStyle.value = p.style;
    if (p.rule) ui.siteRule.value = p.rule;
    syncing = false;

    if (p.active && p.total) {
      ui.pageProgressBox.hidden = false;
      const pct = Math.round(((p.done || 0) / p.total) * 100);
      ui.pageProgressBar.style.width = `${pct}%`;
      ui.pageProgressNum.textContent = `${p.done || 0} / ${p.total}`;
      ui.pageProgressLabel.textContent = (p.done || 0) >= p.total ? '翻译完成' : '翻译中';
    } else {
      ui.pageProgressBox.hidden = true;
    }

    if (p.error) {
      setNote(ui.pageNote, p.error, 'err');
    } else if (p.rule === 'skip') {
      setNote(ui.pageNote, '已把本站设为「不翻译」。', 'info');
    } else if (!NS.settings.providerReady(settings)) {
      setNote(ui.pageNote, '尚未配置翻译服务，请前往设置填写 API。', 'warn');
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
    pollTimer = setInterval(queryState, 900);
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------
  function switchTab(name) {
    activeTab = name;
    for (const btn of ui.tabs.querySelectorAll('button')) {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
    }
    for (const panel of document.querySelectorAll('.panel')) {
      panel.hidden = panel.dataset.panel !== name;
    }
    if (lastState) {
      renderVideoPanel(lastState);
      renderPagePanel(lastState);
    } else {
      queryState();
    }
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
      if (btn) switchTab(btn.dataset.tab);
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
    ui.pageEnabled.addEventListener('change', async () => {
      if (syncing) return;
      const want = ui.pageEnabled.checked;
      const res = await send('lingua:page-toggle');
      if (!res.ok) {
        ui.pageEnabled.checked = false;
        setNote(ui.pageNote, res.error || '无法启动网页翻译', 'err');
      }
      setTimeout(queryState, want ? 300 : 120);
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
      // Default to the panel that is useful for this page.
      switchTab(/youtube(-nocookie)?\.com\/(watch|shorts|live|embed)/.test(url) ? 'video' : 'page');
      queryState();
      startPolling();
    } else {
      switchTab('page');
      setStatus('warn', '不支持');
      setNote(ui.pageNote, '当前页面不支持翻译（仅支持 http/https 网页）。', 'info');
      ui.pageEnabled.disabled = true;
      ui.pageRetranslate.disabled = true;
      ui.retranslate.disabled = true;
    }
  })();

  window.addEventListener('unload', () => clearInterval(pollTimer));
})();
