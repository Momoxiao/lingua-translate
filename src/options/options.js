/**
 * Lingua — options page controller.
 * Auto-saves every change to chrome.storage.local; the content script reacts via
 * storage.onChanged, so no explicit save button is needed.
 */
(function () {
  'use strict';
  const NS = globalThis.YTST;
  const { LANGUAGES, PROVIDERS, MSG } = NS.constants;
  const { getSettings, setSettings, providerReady } = NS.settings;
  const { debounce } = NS.utils;

  const $ = (id) => document.getElementById(id);
  let settings = null;

  // ---------------------------------------------------------------------------
  // Field schemas per provider
  // ---------------------------------------------------------------------------
  const SCHEMA = {
    openai: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://api.openai.com/v1', full: true,
        hint: '以 /v1 结尾即可，扩展会自动补 /chat/completions。' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gpt-4o-mini' },
      { key: 'temperature', label: '温度', type: 'number', min: 0, max: 2, step: 0.1, placeholder: '0' },
      {
        key: 'reasoning',
        label: '模型推理',
        type: 'select',
        options: [
          { value: 'off', label: '关闭（推荐，快约 2.7 倍）' },
          { value: 'auto', label: '跟随模型默认' },
        ],
        hint: '翻译任务没有歧义，推理只会浪费时间。关闭后会向接口发送“不要思考”的参数；若接口不认识这些参数会自动回退，不影响使用。',
      },
      { key: 'prompt', label: '系统提示词（留空使用内置字幕翻译提示词）', type: 'textarea', rows: 5, full: true },
    ],
    deepl: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'xxxxxxxx-xxxx-...:fx' },
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://api-free.deepl.com/v2/translate', full: true },
    ],
    google: [
      { key: 'apiKey', label: 'API Key（可选）', type: 'password', full: true,
        hint: '留空则使用免费网页接口；填入 Google Cloud Translation v2 的 Key 会走官方接口。' },
    ],
    microsoft: [
      { key: 'apiKey', label: 'Subscription Key', type: 'password' },
      { key: 'region', label: '区域', type: 'text', placeholder: 'eastasia' },
      { key: 'baseUrl', label: '接口地址', type: 'text', full: true, placeholder: 'https://api.cognitive.microsofttranslator.com/translate' },
    ],
    custom: [
      { key: 'url', label: '请求地址', type: 'text', placeholder: 'https://api.example.com/translate', full: true },
      { key: 'method', label: '方法', type: 'select', options: ['POST', 'GET', 'PUT'] },
      { key: 'apiKey', label: 'API Key（模板中用 {{key}} 引用）', type: 'password' },
      { key: 'headers', label: '请求头（JSON）', type: 'textarea', rows: 4, full: true },
      { key: 'body', label: '请求体模板', type: 'textarea', rows: 6, full: true },
      { key: 'responsePath', label: '响应取值路径（留空取整个响应）', type: 'text', full: true,
        placeholder: 'data.translations 或 result[0].text' },
    ],
  };

  const PRESETS = {
    openai: [
      { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
      { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
      { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
      { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
      { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.0-flash-exp:free' },
      { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
      { name: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
      { name: 'LM Studio 本地', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
    ],
  };

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------
  function markSaving() {
    const el = $('saveState');
    el.dataset.state = 'saving';
    el.textContent = '保存中';
  }
  function markSaved() {
    const el = $('saveState');
    el.dataset.state = 'ok';
    el.textContent = '已同步';
  }
  function markError(msg) {
    const el = $('saveState');
    el.dataset.state = 'error';
    el.textContent = msg || '保存失败';
  }

  async function save(patch) {
    markSaving();
    try {
      settings = await setSettings(patch);
      markSaved();
      renderProviderCards();
    } catch (e) {
      markError(String(e && e.message));
    }
  }
  const saveDebounced = debounce(save, 320);

  // ---------------------------------------------------------------------------
  // Provider picker
  // ---------------------------------------------------------------------------
  function renderProviderCards() {
    const wrap = $('providers');
    wrap.innerHTML = '';
    for (const key of Object.keys(PROVIDERS)) {
      const p = PROVIDERS[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'providerCard';
      btn.setAttribute('aria-pressed', String(settings.provider === key));
      btn.dataset.ready = providerReady({ ...settings, provider: key }) ? '1' : '0';
      btn.innerHTML = `<div class="providerCard__name"><span></span><span class="providerCard__dot"></span></div><div class="providerCard__hint"></div>`;
      btn.querySelector('span').textContent = p.label;
      btn.querySelector('.providerCard__hint').textContent = p.hint;
      btn.addEventListener('click', () => {
        save({ provider: key });
        renderFields();
        renderProviderCards();
      });
      wrap.appendChild(btn);
    }
  }

  // ---------------------------------------------------------------------------
  // Provider fields
  // ---------------------------------------------------------------------------
  function renderFields() {
    const providerId = settings.provider;
    const meta = PROVIDERS[providerId];
    const cfg = settings.providers[providerId] || {};
    const schema = SCHEMA[providerId] || [];

    $('paneTitle').textContent = meta.label;
    $('paneHint').textContent = meta.hint;

    // presets
    const presetWrap = $('presets');
    presetWrap.innerHTML = '';
    for (const preset of PRESETS[providerId] || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = preset.name;
      b.addEventListener('click', () => {
        const patch = { providers: { [providerId]: {} } };
        if (preset.baseUrl) patch.providers[providerId].baseUrl = preset.baseUrl;
        if (preset.model) patch.providers[providerId].model = preset.model;
        save(patch).then(() => renderFields());
      });
      presetWrap.appendChild(b);
    }

    const wrap = $('fields');
    wrap.innerHTML = '';
    for (const f of schema) {
      const field = document.createElement('div');
      field.className = 'field' + (f.full ? ' full' : '');

      const label = document.createElement('label');
      label.className = 'label';
      label.textContent = f.label;
      label.htmlFor = `f_${providerId}_${f.key}`;
      field.appendChild(label);

      let input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = f.rows || 4;
        input.value = cfg[f.key] || '';
      } else if (f.type === 'select') {
        input = document.createElement('select');
        for (const opt of f.options) {
          const o = document.createElement('option');
          // options may be plain strings or { value, label } pairs
          o.value = typeof opt === 'string' ? opt : opt.value;
          o.textContent = typeof opt === 'string' ? opt : opt.label;
          input.appendChild(o);
        }
        input.value = cfg[f.key] != null ? cfg[f.key] : typeof f.options[0] === 'string' ? f.options[0] : f.options[0].value;
      } else {
        input = document.createElement('input');
        input.type = f.type;
        if (f.min != null) input.min = f.min;
        if (f.max != null) input.max = f.max;
        if (f.step != null) input.step = f.step;
        if (f.placeholder) input.placeholder = f.placeholder;
        input.value = cfg[f.key] != null ? cfg[f.key] : '';
      }
      input.id = `f_${providerId}_${f.key}`;
      input.autocomplete = 'off';
      input.spellcheck = false;

      const commit = () => {
        let value = input.value;
        if (f.type === 'number') value = value === '' ? 0 : Number(value);
        saveDebounced({ providers: { [providerId]: { [f.key]: value } } });
      };
      input.addEventListener('input', commit);
      input.addEventListener('change', commit);

      field.appendChild(input);
      if (f.hint) {
        const h = document.createElement('div');
        h.className = 'hint';
        h.textContent = f.hint;
        field.appendChild(h);
      }
      wrap.appendChild(field);
    }
  }

  // ---------------------------------------------------------------------------
  // Language + display + perf bindings
  // ---------------------------------------------------------------------------
  function fillLanguageSelects() {
    const src = $('sourceLang');
    const tgt = $('targetLang');
    src.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = '自动（推荐）';
    src.appendChild(auto);
    for (const l of LANGUAGES) {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.label;
      src.appendChild(o);
      const o2 = document.createElement('option');
      o2.value = l.code;
      o2.textContent = l.label;
      tgt.appendChild(o2);
    }
  }

  function bindRange(id, key, fmt, scope) {
    const input = $(id);
    const out = $(`${id}Val`);
    const paint = () => {
      out.textContent = fmt(Number(input.value));
    };
    input.addEventListener('input', () => {
      paint();
      const value = Number(input.value);
      saveDebounced(scope ? { [scope]: { [key]: value } } : { [key]: value });
    });
    return paint;
  }

  /** Textarea of hostnames -> array of normalised hostnames. */
  function hostListFrom(id) {
    return $(id)
      .value.split('\n')
      .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, ''))
      .filter(Boolean);
  }

  function renderAll() {
    $('sourceLang').value = settings.sourceLang;
    $('targetLang').value = settings.targetLang;
    $('autoTranslate').checked = !!settings.autoTranslate;
    $('hideNativeCaptions').checked = !!settings.hideNativeCaptions;
    $('cacheEnabled').checked = !!settings.cacheEnabled;
    $('debug').checked = !!settings.debug;
    $('textAlign').value = settings.textAlign || 'center';

    $('fontSize').value = settings.fontSize;
    $('bottomOffset').value = settings.bottomOffset;
    $('backgroundOpacity').value = settings.backgroundOpacity;
    $('batchSize').value = settings.batchSize;
    $('concurrency').value = settings.concurrency;

    $('fontSizeVal').textContent = `${settings.fontSize}px`;
    $('bottomOffsetVal').textContent = `${settings.bottomOffset}%`;
    $('backgroundOpacityVal').textContent = Number(settings.backgroundOpacity).toFixed(2);
    $('batchSizeVal').textContent = `${settings.batchSize} 句`;
    $('concurrencyVal').textContent = `${settings.concurrency} 并发`;

    const p = settings.page || {};
    $('pageAuto').checked = !!p.autoTranslate;
    $('pageMode').value = p.displayMode || 'bilingual';
    $('pageStyle').value = p.style || 'underline';
    $('pageBatchSize').value = p.batchSize;
    $('pageMaxChars').value = p.maxChars;
    $('pageConcurrency').value = p.concurrency;
    $('pageInputs').checked = !!p.translateInputs;
    $('pageKeepLinks').checked = p.replacePreservesLinks !== false;
    $('pageSkipSelectors').value = p.skipSelectors || '';
    $('pageAutoSites').value = (p.autoSites || []).join('\n');
    $('pageSkipSites').value = (p.skipSites || []).join('\n');
    $('pageBatchSizeVal').textContent = `${p.batchSize} 段`;
    $('pageMaxCharsVal').textContent = `${p.maxChars} 字`;
    $('pageConcurrencyVal').textContent = `${p.concurrency} 并发`;

    for (const btn of $('displayMode').querySelectorAll('button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === settings.displayMode));
    }
  }

  function bindControls() {
    $('sourceLang').addEventListener('change', () => save({ sourceLang: $('sourceLang').value }));
    $('targetLang').addEventListener('change', () => save({ targetLang: $('targetLang').value }));
    $('textAlign').addEventListener('change', () => save({ textAlign: $('textAlign').value }));

    $('autoTranslate').addEventListener('change', () => save({ autoTranslate: $('autoTranslate').checked }));
    $('hideNativeCaptions').addEventListener('change', () =>
      save({ hideNativeCaptions: $('hideNativeCaptions').checked })
    );
    $('cacheEnabled').addEventListener('change', () => save({ cacheEnabled: $('cacheEnabled').checked }));
    $('debug').addEventListener('change', () => save({ debug: $('debug').checked }));

    bindRange('fontSize', 'fontSize', (v) => `${v}px`);
    bindRange('bottomOffset', 'bottomOffset', (v) => `${v}%`);
    bindRange('backgroundOpacity', 'backgroundOpacity', (v) => v.toFixed(2));
    bindRange('batchSize', 'batchSize', (v) => `${v} 句`);
    bindRange('concurrency', 'concurrency', (v) => `${v} 并发`);

    // --- page translation ---
    $('pageAuto').addEventListener('change', () => save({ page: { autoTranslate: $('pageAuto').checked } }));
    $('pageMode').addEventListener('change', () => save({ page: { displayMode: $('pageMode').value } }));
    $('pageStyle').addEventListener('change', () => save({ page: { style: $('pageStyle').value } }));
    $('pageInputs').addEventListener('change', () => save({ page: { translateInputs: $('pageInputs').checked } }));
    $('pageKeepLinks').addEventListener('change', () =>
      save({ page: { replacePreservesLinks: $('pageKeepLinks').checked } })
    );
    $('pageSkipSelectors').addEventListener('input', () =>
      saveDebounced({ page: { skipSelectors: $('pageSkipSelectors').value } })
    );
    $('pageAutoSites').addEventListener('input', () =>
      saveDebounced({ page: { autoSites: hostListFrom('pageAutoSites') } })
    );
    $('pageSkipSites').addEventListener('input', () =>
      saveDebounced({ page: { skipSites: hostListFrom('pageSkipSites') } })
    );

    bindRange('pageBatchSize', 'batchSize', (v) => `${v} 段`, 'page');
    bindRange('pageMaxChars', 'maxChars', (v) => `${v} 字`, 'page');
    bindRange('pageConcurrency', 'concurrency', (v) => `${v} 并发`, 'page');

    $('displayMode').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-mode]');
      if (!btn) return;
      for (const b of $('displayMode').querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-pressed', 'true');
      save({ displayMode: btn.dataset.mode });
    });
  }

  // ---------------------------------------------------------------------------
  // Test connection
  // ---------------------------------------------------------------------------
  function setTestResult(text, tone) {
    const box = $('testResult');
    box.hidden = !text;
    box.dataset.tone = tone;
    box.textContent = text;
  }

  async function testConnection() {
    const btn = $('testBtn');
    btn.disabled = true;
    setTestResult('正在请求接口…', 'busy');
    try {
      const res = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: MSG.TEST_PROVIDER }, (r) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (r && r.ok) resolve(r);
          else reject(new Error((r && r.error) || '测试失败'));
        });
      });
      setTestResult(`连接成功，示例译文：${res.sample || '（空）'}`, 'ok');
    } catch (e) {
      setTestResult(`连接失败：${e && e.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------------------
  async function refreshCache() {
    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: MSG.CACHE_STATS }, (r) => resolve(r));
      });
      if (res && res.ok) $('cacheCount').textContent = String(res.stats.entries);
      else $('cacheCount').textContent = '0';
    } catch (e) {
      $('cacheCount').textContent = '—';
    }
  }

  async function clearCache() {
    const btn = $('clearCache');
    btn.disabled = true;
    try {
      await new Promise((resolve) => chrome.runtime.sendMessage({ type: MSG.CLEAR_CACHE }, resolve));
      await refreshCache();
      btn.textContent = '已清空';
      setTimeout(() => (btn.textContent = '清空缓存'), 1600);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Nav highlight
  // ---------------------------------------------------------------------------
  function initNav() {
    const links = Array.from(document.querySelectorAll('.rail__nav a'));
    const sections = links
      .map((a) => document.querySelector(a.getAttribute('href')))
      .filter(Boolean);
    if (!sections.length || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (!visible.length) return;
        const id = `#${visible[0].target.id}`;
        for (const a of links) a.classList.toggle('is-active', a.getAttribute('href') === id);
      },
      { rootMargin: '-10% 0px -70% 0px', threshold: 0 }
    );
    sections.forEach((s) => observer.observe(s));
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  (async function boot() {
    settings = await getSettings();
    fillLanguageSelects();
    renderAll();
    renderProviderCards();
    renderFields();
    bindControls();
    initNav();
    markSaved();
    refreshCache();

    $('testBtn').addEventListener('click', testConnection);
    $('clearCache').addEventListener('click', clearCache);
  })();
})();
