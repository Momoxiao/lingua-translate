/**
 * Lingua — MV3 service worker.
 * Classic worker (no ES modules) so the same shared/*.js files can be reused
 * verbatim by the content scripts. No build step required.
 */
importScripts(
  '../shared/constants.js',
  '../shared/utils.js',
  '../shared/settings.js',
  '../shared/subtitles.js',
  'cache.js',
  'providers/http.js',
  'providers/prompts.js',
  'providers/llm.js',
  'providers/openai.js',
  'providers/deepl.js',
  'providers/google.js',
  'providers/microsoft.js',
  'providers/custom.js',
  'translator.js'
);

(function () {
  'use strict';
  const NS = globalThis.Lingua;
  const { MSG, ID } = NS.constants;
  const { getSettings, setSettings } = NS.settings;
  const translator = NS.bg.translator;

  /** jobId -> AbortController, so the content script can cancel work. */
  const jobs = new Map();

  function log(...args) {
    getSettings()
      .then((s) => {
        if (s.debug) console.log(`[${ID}/bg]`, ...args);
      })
      .catch(() => {});
  }

  async function handleTranslate(payload, emit) {
    const settings = await getSettings();
    const jobId = payload.jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ctrl = new AbortController();
    jobs.set(jobId, ctrl);
    try {
      const started = Date.now();
      const { results, stats } = await translator.translate(payload.texts, {
        settings,
        from: payload.from || settings.sourceLang,
        to: payload.to || settings.targetLang,
        kind: payload.kind || 'subtitle',
        profile: payload.profile || null,
        signal: ctrl.signal,
        onProgress: emit,
      });
      log('translate done', { count: payload.texts.length, ms: Date.now() - started, stats });
      return { ok: true, jobId, results, stats };
    } catch (err) {
      const detail = (err && (err.message || err.name)) || String(err) || '翻译失败';
      const code = err && err.code ? ` [${err.code}]` : '';
      log('translate failed', detail, code);
      return { ok: false, jobId, error: detail + code };
    } finally {
      jobs.delete(jobId);
    }
  }

  // ---------------------------------------------------------------------------
  // Long-lived port: keeps the worker alive during a translation session and
  // carries streaming progress back to the content script.
  // ---------------------------------------------------------------------------
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== MSG.PORT) return;
    port.onMessage.addListener(async (msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === MSG.TRANSLATE_BATCH) {
        const emit = (p) => {
          try {
            port.postMessage({ type: MSG.TRANSLATE_STATUS, requestId: msg.requestId, progress: p });
          } catch (e) {
            /* port closed */
          }
        };
        const res = await handleTranslate(msg.payload || {}, emit);
        try {
          port.postMessage({ type: MSG.TRANSLATE_STATUS, requestId: msg.requestId, done: true, ...res });
        } catch (e) {
          /* port closed */
        }
      } else if (msg.type === MSG.CANCEL_JOB) {
        const ctrl = jobs.get(msg.payload && msg.payload.jobId);
        if (ctrl) ctrl.abort();
      } else if (msg.type === MSG.GET_SETTINGS) {
        port.postMessage({ type: MSG.GET_SETTINGS, requestId: msg.requestId, settings: await getSettings() });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // One-shot messages: popup / options page
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    (async () => {
      try {
        switch (msg.type) {
          case MSG.PING:
            sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
            break;
          case MSG.GET_SETTINGS:
            sendResponse({ ok: true, settings: await getSettings() });
            break;
          case 'lingua:set-settings':
            sendResponse({ ok: true, settings: await setSettings(msg.payload || {}) });
            break;
          case MSG.TEST_PROVIDER: {
            const current = await getSettings();
            const merged = msg.payload && msg.payload.settings ? { ...current, ...msg.payload.settings } : current;
            const sample = await translator.testProvider(merged);
            sendResponse({ ok: true, sample });
            break;
          }
          case MSG.CLEAR_CACHE:
            await NS.bg.cache.clear();
            sendResponse({ ok: true });
            break;
          case MSG.CACHE_STATS:
            await NS.bg.cache.ensureLoaded();
            sendResponse({ ok: true, stats: NS.bg.cache.stats() });
            break;
          case MSG.BADGE:
            try {
              const text = (msg.payload && msg.payload.text) || '';
              await chrome.action.setBadgeText({ text });
              await chrome.action.setBadgeBackgroundColor({ color: '#E4572E' });
            } catch (e) {
              /* ignore */
            }
            sendResponse({ ok: true });
            break;
          case 'lingua:open-options':
            // Triggered from the page's floating ball (content scripts cannot
            // call chrome.runtime.openOptionsPage directly).
            chrome.runtime.openOptionsPage();
            sendResponse({ ok: true });
            break;
          default:
            sendResponse({ ok: false, error: `未知消息类型：${msg.type}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: (err && err.message) || '处理失败' });
      }
    })();

    return true; // keep the channel open for the async response
  });

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      chrome.runtime.openOptionsPage().catch(() => {});
    }
  });

  // Warm the cache on cold start so the first batch is not penalised.
  NS.bg.cache.ensureLoaded().catch(() => {});
})();
