/**
 * Lingua — options page controller.
 * Auto-saves every change to chrome.storage.local; the content script reacts via
 * storage.onChanged, so no explicit save button is needed.
 */
(function () {
  'use strict';
  const NS = globalThis.Lingua;
  const { LANGUAGES, PROVIDERS, MSG, CUSTOM_PRESETS, CUSTOM_PLACEHOLDERS } = NS.constants;
  const { getSettings, setSettings, providerReady } = NS.settings;
  const { debounce } = NS.utils;

  const $ = (id) => document.getElementById(id);
  let settings = null;
  /** paint callbacks for the sliders, so they can be refreshed after loading */
  const rangePaints = [];

  // ---------------------------------------------------------------------------
  // Field schemas per provider
  // ---------------------------------------------------------------------------
  const SCHEMA = {
    openai: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://api.openai.com/v1', full: true,
        hint: '以 /v1 结尾即可，扩展会自动补 /chat/completions。' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...',
        hint: '本地模型可留空。' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'deepseek-chat',
        hint: '推荐用非推理模型。' },
      { key: 'temperature', label: '温度', type: 'number', min: 0, max: 2, step: 0.1, placeholder: '0' },
      {
        key: 'reasoning',
        label: '模型推理',
        type: 'select',
        options: [
          { value: 'off', label: '关闭（推荐，快约 2.7 倍）' },
          { value: 'auto', label: '跟随模型默认' },
        ],
        hint: '翻译没有歧义，推理只会浪费时间。关闭后会向接口发送「不要思考」的参数；若接口不认识会自动回退。',
      },
      { key: 'prompt', label: '系统提示词（留空使用内置提示词）', type: 'textarea', rows: 4, full: true },
    ],
    deepl: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'xxxxxxxx-xxxx-...:fx', full: true,
        hint: 'Free 版 Key 以 :fx 结尾。' },
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://api-free.deepl.com/v2/translate', full: true },
    ],
    google: [
      { key: 'apiKey', label: 'API Key（可选）', type: 'password', full: true,
        hint: '留空则使用免费网页接口；填入 Google Cloud Translation v2 的 Key 会走官方接口。' },
    ],
    microsoft: [
      { key: 'apiKey', label: 'Subscription Key', type: 'password' },
      { key: 'region', label: '区域', type: 'text', placeholder: 'eastasia',
        hint: '区域资源必填；全球资源可留空。填错会返回 401。' },
      { key: 'baseUrl', label: '接口地址', type: 'text', full: true, placeholder: 'https://api.cognitive.microsofttranslator.com/translate' },
    ],
    custom: [
      { key: 'url', label: '请求地址', type: 'text', placeholder: 'https://api.example.com/translate', full: true,
        hint: '支持占位符，例如 .../translate?to={{to}}' },
      { key: 'method', label: '请求方法', type: 'select', options: ['POST', 'GET', 'PUT'],
        hint: 'GET 不会发送请求体。' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: '在模板里用 {{key}} 引用' },
      { key: 'headers', label: '请求头（JSON）', type: 'textarea', rows: 4, full: true },
      { key: 'body', label: '请求体模板', type: 'textarea', rows: 5, full: true,
        hint: '用 {{text}} 或 {{texts}} 把要翻译的内容放进去。' },
      { key: 'responsePath', label: '响应取值路径', type: 'text', full: true,
        placeholder: 'data.translations 或 result[0].text',
        hint: '留空表示从整个响应里取文本。' },
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
    custom: CUSTOM_PRESETS,
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
    // "已同步" would promise a cloud sync. Settings live in chrome.storage.local
    // — one machine, one profile — so the honest word is 已保存.
    el.textContent = '已保存';
  }
  function markError(msg) {
    const el = $('saveState');
    el.dataset.state = 'error';
    el.textContent = msg || '保存失败';
  }

  let pendingPatch = null;
  /** Serialises writes: two overlapping setSettings() calls would each read the
   *  same base and the second would clobber the first. */
  let writeChain = Promise.resolve();

  async function save(patch) {
    markSaving();
    writeChain = writeChain.then(async () => {
      try {
        settings = await setSettings(patch);
        markSaved();
        // Keep the whole provider section consistent: the picker's ready dots, the
        // pane header and the custom-provider diagnostics all depend on the
        // credentials that were just saved.
        renderProviderCards();
        renderPaneHeader();
        if (settings.provider === 'custom') updateCustomAids();
      } catch (e) {
        markError(String(e && e.message));
      }
    });
    return writeChain;
  }

  /**
   * Queue a change coming from a field that fires on every keystroke.
   *
   * Debouncing the whole save() call would keep only the last call's patch, so
   * editing two fields inside the debounce window silently dropped the first
   * one (type a Base URL, tab into API Key, keep typing → the URL was lost).
   * The patches are merged first and written once.
   */
  const flushQueuedSave = debounce(() => {
    const patch = pendingPatch;
    pendingPatch = null;
    if (patch) save(patch);
  }, 320);

  function saveDebounced(patch) {
    pendingPatch = pendingPatch ? NS.utils.deepMerge(pendingPatch, patch) : patch;
    flushQueuedSave();
  }

  // ---------------------------------------------------------------------------
  // Provider picker
  // ---------------------------------------------------------------------------
  function renderProviderCards() {
    const wrap = $('providers');
    wrap.innerHTML = '';
    for (const key of Object.keys(PROVIDERS)) {
      const p = PROVIDERS[key];
      const ready = providerReady({ ...settings, provider: key });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'providerCard';
      btn.setAttribute('aria-pressed', String(settings.provider === key));
      btn.dataset.ready = ready ? '1' : '0';
      btn.innerHTML =
        '<span class="providerCard__name"></span>' +
        '<span class="providerCard__short"></span>' +
        '<span class="providerCard__state"></span>' +
        '<span class="providerCard__dot"></span>';
      btn.querySelector('.providerCard__name').textContent = p.label;
      btn.querySelector('.providerCard__short').textContent = p.short || '';
      btn.querySelector('.providerCard__state').textContent = ready ? '已配置' : '未配置';
      btn.addEventListener('click', async () => {
        // save() is async — settings.provider is only updated once it resolves.
        // Rendering the pane before that reads the OLD provider and leaves the
        // picker and the pane below it disagreeing: the card highlights the new
        // service while the pane still shows the previous one's fields.
        await save({ provider: key });
        renderFields();
      });
      wrap.appendChild(btn);
    }
  }

  /** One-line summary of what is currently in effect, for the pane header. */
  function activeSummary(providerId) {
    const cfg = settings.providers[providerId] || {};
    if (providerId === 'openai') {
      const model = cfg.model || '未填模型';
      const host = String(cfg.baseUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return host ? `${model} · ${host}` : model;
    }
    if (providerId === 'custom') {
      return String(cfg.url || '').replace(/^https?:\/\//, '').split('/')[0] || '未填请求地址';
    }
    if (providerId === 'deepl') return cfg.pro ? 'DeepL Pro' : 'DeepL Free';
    // An empty region is a legitimate global-resource setup, so there is nothing
    // to report — saying "未填区域" next to a green "使用中" contradicts itself.
    if (providerId === 'microsoft') return cfg.region ? `区域 ${cfg.region}` : '';
    if (providerId === 'google') return cfg.apiKey ? '官方接口' : '免费网页接口';
    return '';
  }

  // ---------------------------------------------------------------------------
  // Provider pane
  // ---------------------------------------------------------------------------
  /**
   * Title / hint / status line only.
   *
   * Kept separate from renderFields() so it can run on every save without
   * rebuilding the inputs: rebuilding them on each keystroke would steal focus.
   * Without it the pane header goes stale the moment you type a credential —
   * the card flips to 已配置 while the header still reads 未配置.
   */
  function renderPaneHeader() {
    const providerId = settings.provider;
    const meta = PROVIDERS[providerId];
    const ready = providerReady(settings);
    const summary = activeSummary(providerId);
    $('paneTitle').textContent = meta.label;
    $('paneHint').textContent = meta.hint;
    $('paneStatus').textContent = ready
      ? summary
        ? `使用中 · ${summary}`
        : '使用中'
      : summary
        ? `未配置 · ${summary}`
        : '未配置';
    $('paneStatus').dataset.state = ready ? 'ready' : 'missing';
  }

  function renderFields() {
    const providerId = settings.provider;
    const cfg = settings.providers[providerId] || {};
    const schema = SCHEMA[providerId] || [];

    renderPaneHeader();

    // presets
    const presetWrap = $('presets');
    presetWrap.innerHTML = '';
    for (const preset of PRESETS[providerId] || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = preset.name;
      b.addEventListener('click', () => {
        // Presets are plain patches — every key except the display name is a
        // provider config field, which keeps one code path for all providers.
        const patch = {};
        for (const [k, v] of Object.entries(preset)) if (k !== 'name') patch[k] = v;
        save({ providers: { [providerId]: patch } }).then(() => renderFields());
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

    renderCustomAids();
  }

  // ---------------------------------------------------------------------------
  // Custom provider — diagnostics
  //
  // The custom provider is the one place where the user writes raw HTTP, so it
  // gets the feedback the fixed providers get for free: what is wrong with the
  // template, what the placeholders mean, and what request will actually be
  // sent. Every rule below mirrors a real branch in
  // src/background/providers/custom.js — keep the two in step.
  // ---------------------------------------------------------------------------
  const SAMPLE_VARS = {
    text: '1. Hello\n2. World',
    texts: '["Hello","World"]',
    from: 'en',
    to: 'zh-Hans',
    source: 'English',
    target: 'Simplified Chinese',
    key: '••••••',
  };

  /** Mirror of custom.js substitute(); preview only, never used for real calls. */
  function substitute(tpl, vars) {
    return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n) => (vars[n] == null ? '' : String(vars[n])));
  }

  function customIssues(cfg) {
    const out = [];
    const method = String(cfg.method || 'POST').toUpperCase();
    const url = String(cfg.url || '');
    const body = String(cfg.body || '');
    const headers = String(cfg.headers || '');

    if (headers.trim()) {
      try {
        const parsed = JSON.parse(headers);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          out.push({ tone: 'err', text: '请求头必须是 JSON 对象，例如 {"Content-Type":"application/json"}。' });
        }
      } catch (e) {
        out.push({ tone: 'err', text: `请求头不是合法 JSON（${e.message}），修正前无法发起请求。` });
      }
    }
    if (body.trim() && (method === 'GET' || method === 'HEAD')) {
      out.push({ tone: 'err', text: `${method} 请求不会发送请求体，请把占位符写进请求地址。` });
    }
    if (body.trim() && !/\{\{\s*texts?\s*\}\}/.test(body)) {
      out.push({ tone: 'warn', text: '请求体里没有 {{text}} 或 {{texts}}，接口收不到要翻译的内容。' });
    }
    if (!/\{\{\s*(to|target)\s*\}\}/.test(url + body)) {
      out.push({ tone: 'warn', text: '没有把目标语言传给接口（缺 {{to}} 或 {{target}}），译文语种可能不对。' });
    }
    if (!String(cfg.responsePath || '').trim()) {
      out.push({ tone: 'info', text: '未填响应取值路径：将从整个响应里提取文本。嵌套结构建议填写，例如 data.translations。' });
    }
    return out;
  }

  function previewRequest(cfg) {
    const method = String(cfg.method || 'POST').toUpperCase();
    const url = substitute(cfg.url, SAMPLE_VARS) || '（未填请求地址）';
    const headers = substitute(cfg.headers, SAMPLE_VARS);
    const body = method === 'GET' || method === 'HEAD' ? '' : substitute(cfg.body, SAMPLE_VARS);
    let out = `${method} ${url}\n`;
    if (headers.trim()) out += `\n${headers}\n`;
    if (body.trim()) out += `\n${body}`;
    return out.trim();
  }

  function disclosure(label, fill) {
    const d = document.createElement('details');
    d.className = 'disclosure';
    const s = document.createElement('summary');
    s.textContent = label;
    d.appendChild(s);
    const body = document.createElement('div');
    body.className = 'disclosure__body';
    fill(body);
    d.appendChild(body);
    return d;
  }

  /**
   * The structure is built once and only its contents are refreshed afterwards,
   * so typing in a textarea cannot collapse an open disclosure or reset the
   * preview's scroll position.
   */
  function renderCustomAids() {
    const wrap = $('customAids');
    if (settings.provider !== 'custom') {
      if (wrap.dataset.built) {
        wrap.innerHTML = '';
        delete wrap.dataset.built;
      }
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    if (!wrap.dataset.built) {
      wrap.innerHTML = '';
      const issues = document.createElement('div');
      issues.className = 'customAids__issues';
      issues.id = 'customIssues';
      wrap.appendChild(issues);
      wrap.appendChild(
        disclosure('可用占位符', (body) => {
          const dl = document.createElement('dl');
          dl.className = 'phTable';
          for (const p of CUSTOM_PLACEHOLDERS) {
            const dt = document.createElement('dt');
            dt.textContent = p.token;
            const dd = document.createElement('dd');
            dd.textContent = p.desc;
            dl.append(dt, dd);
          }
          body.appendChild(dl);
        })
      );
      wrap.appendChild(
        disclosure('请求预览（示例值）', (body) => {
          const pre = document.createElement('pre');
          pre.className = 'preview';
          pre.id = 'customPreview';
          body.appendChild(pre);
        })
      );
      wrap.dataset.built = '1';
    }
    updateCustomAids();
  }

  function updateCustomAids() {
    const cfg = settings.providers.custom || {};
    const box = $('customIssues');
    if (box) {
      box.innerHTML = '';
      for (const it of customIssues(cfg)) {
        const el = document.createElement('div');
        el.className = 'customAids__issue';
        el.dataset.tone = it.tone;
        el.textContent = it.text;
        box.appendChild(el);
      }
    }
    const pre = $('customPreview');
    if (pre) pre.textContent = previewRequest(cfg);
  }

  // ---------------------------------------------------------------------------
  // Language + display + perf bindings
  // ---------------------------------------------------------------------------
  function fillLanguageSelects() {
    // Translation style: the "auto" option plus every profile, from one source.
    const profile = $('pageProfile');
    for (const p of NS.constants.PAGE_PROFILES) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      opt.title = p.hint || '';
      profile.appendChild(opt);
    }
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
      const v = Number(input.value);
      out.textContent = fmt(v);
      // Drives the filled part of the track (see theme.css ::-webkit-slider-*).
      const min = Number(input.min) || 0;
      const max = Number(input.max) || 100;
      const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
      input.style.setProperty('--pct', `${pct}%`);
    };
    input.addEventListener('input', () => {
      paint();
      const value = Number(input.value);
      saveDebounced(scope ? { [scope]: { [key]: value } } : { [key]: value });
    });
    rangePaints.push(paint);
    return paint;
  }

  /** Values + filled tracks for every slider (run after the values are loaded). */
  function refreshRanges() {
    for (const paint of rangePaints) paint();
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

    const p = settings.page || {};
    $('pageAuto').checked = !!p.autoTranslate;
    $('pageMode').value = p.displayMode || 'bilingual';
    $('pageStyle').value = p.style || 'underline';
    $('pageBatchSize').value = p.batchSize;
    $('pageMaxChars').value = p.maxChars;
    $('pageConcurrency').value = p.concurrency;
    $('pageInputs').checked = !!p.translateInputs;
    $('pageBall').checked = p.showBall !== false;
    $('pageLinkMode').value = p.replaceLinkMode || 'translate';
    $('pageSkipSelectors').value = p.skipSelectors || '';
    $('pageAutoSites').value = (p.autoSites || []).join('\n');
    $('pageSkipSites').value = (p.skipSites || []).join('\n');
    $('pageProfile').value = p.profileMode || 'auto';
    $('pageNotes').value = p.profileNotes || '';

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
    // No unit suffix on the concurrency sliders: the label already ends in 数,
    // and "并发数 4 并发" reads like a stutter.
    bindRange('concurrency', 'concurrency', (v) => String(v));

    // --- page translation ---
    $('pageAuto').addEventListener('change', () => save({ page: { autoTranslate: $('pageAuto').checked } }));
    $('pageMode').addEventListener('change', () => save({ page: { displayMode: $('pageMode').value } }));
    $('pageStyle').addEventListener('change', () => save({ page: { style: $('pageStyle').value } }));
    $('pageProfile').addEventListener('change', () => save({ page: { profileMode: $('pageProfile').value } }));
    $('pageInputs').addEventListener('change', () => save({ page: { translateInputs: $('pageInputs').checked } }));
    $('pageBall').addEventListener('change', () => save({ page: { showBall: $('pageBall').checked } }));
    $('pageLinkMode').addEventListener('change', () => save({ page: { replaceLinkMode: $('pageLinkMode').value } }));
    $('pageSkipSelectors').addEventListener('input', () =>
      saveDebounced({ page: { skipSelectors: $('pageSkipSelectors').value } })
    );
    $('pageNotes').addEventListener('input', () =>
      saveDebounced({ page: { profileNotes: $('pageNotes').value } })
    );
    $('pageAutoSites').addEventListener('input', () =>
      saveDebounced({ page: { autoSites: hostListFrom('pageAutoSites') } })
    );
    $('pageSkipSites').addEventListener('input', () =>
      saveDebounced({ page: { skipSites: hostListFrom('pageSkipSites') } })
    );

    bindRange('pageBatchSize', 'batchSize', (v) => `${v} 段`, 'page');
    bindRange('pageMaxChars', 'maxChars', (v) => `${v} 字`, 'page');
    bindRange('pageConcurrency', 'concurrency', (v) => String(v), 'page');

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
      // Back to the label the markup ships with — it used to restore a longer
      // one ("清空缓存"), so the button silently grew after the first click.
      setTimeout(() => (btn.textContent = '清空'), 1600);
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
    refreshRanges();
    initNav();
    markSaved();
    refreshCache();

    $('testBtn').addEventListener('click', testConnection);
    $('clearCache').addEventListener('click', clearCache);
  })();
})();
