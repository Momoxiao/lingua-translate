/**
 * Lingua — content script entry point (isolated world).
 * Boots two independent pipelines and answers popup queries:
 *   - YouTube subtitles      (YTST.youtube) — only on watch pages
 *   - Full-page translation  (YTST.page)    — on any site, opt-in
 */
(function () {
  'use strict';
  const NS = globalThis.YTST;
  if (!NS || !NS.youtube) return;

  let settings = null;
  let noticeShown = false;
  let pageBootTimer = 0;

  const FULL_RELOAD_KEYS = ['provider', 'sourceLang', 'targetLang', 'autoTranslate', 'batchSize', 'concurrency'];

  function ready(s) {
    return !!(s && s.enabled && NS.settings.providerReady(s));
  }

  function subtitleSnapshot() {
    const st = NS.store.state;
    return {
      status: st.status,
      videoId: st.videoId,
      liveMode: st.liveMode,
      error: st.error,
      cueCount: st.cues.length,
      translated: NS.store.translatedCount(),
      tracks: st.tracks.map((t) => ({ languageCode: t.languageCode, name: t.name, kind: t.kind })),
      sourceTrack: st.sourceTrack ? { languageCode: st.sourceTrack.languageCode, name: st.sourceTrack.name } : null,
      enabled: st.enabled,
      provider: settings && settings.provider,
      targetLang: settings && settings.targetLang,
    };
  }

  function snapshot() {
    return {
      url: location.href,
      host: NS.page ? NS.page.hostname() : location.hostname,
      isWatchPage: !!NS.youtube.videoIdFromUrl(),
      subtitle: subtitleSnapshot(),
      page: NS.page ? NS.page.status() : null,
      provider: settings && settings.provider,
      providerReady: ready(settings),
      targetLang: settings && settings.targetLang,
      enabled: !!(settings && settings.enabled),
    };
  }

  function hintIfUnconfigured() {
    if (noticeShown) return;
    if (!settings || !settings.enabled) return;
    if (NS.settings.providerReady(settings)) return;
    if (!NS.youtube.videoIdFromUrl()) return;
    noticeShown = true;
    NS.overlay.mount();
    NS.overlay.setNotice('Lingua：尚未配置翻译服务，请点击扩展图标完成设置', 9000);
  }

  function changedMeaningfully(prev, next) {
    return FULL_RELOAD_KEYS.some((k) => prev[k] !== next[k]);
  }

  /** YouTube is a SPA — the subtitle module must be armed on every YouTube
   *  page, not just watch pages, so that navigating into a video works. */
  function onYouTubeHost() {
    try {
      return /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Full-page translation boot
  // ---------------------------------------------------------------------------
  function pageWanted(s) {
    if (!NS.page || !s) return false;
    if (!ready(s)) return false;
    if (NS.page.isBlocked(s)) return false;
    return NS.page.shouldAutoTranslate(s);
  }

  function startPageAuto() {
    if (!pageWanted(settings)) return;
    if (NS.page.state.active) return;
    clearTimeout(pageBootTimer);
    // Start right after the DOM is parsed instead of waiting for `load`: on a
    // heavy page `load` can be seconds later, and the MutationObserver already
    // picks up whatever content arrives afterwards.
    const delay = document.readyState === 'complete' ? 300 : 150;
    pageBootTimer = setTimeout(() => {
      if (!pageWanted(settings) || NS.page.state.active) return;
      NS.page.start(settings).catch(() => {});
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function boot() {
    try {
      settings = await NS.settings.getSettings();
    } catch (e) {
      return;
    }

    if (ready(settings)) {
      if (onYouTubeHost()) NS.youtube.start(settings);
    } else {
      hintIfUnconfigured();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startPageAuto, { once: true });
    } else {
      startPageAuto();
    }

    NS.settings.onChanged((next) => {
      const prev = settings;
      settings = next;
      try {
        // --- subtitles ---
        if (!ready(next)) {
          NS.youtube.stop();
        } else if (!ready(prev)) {
          if (onYouTubeHost()) NS.youtube.start(next);
        } else if (changedMeaningfully(prev, next)) {
          if (NS.youtube.videoIdFromUrl()) NS.youtube.load();
          else NS.youtube.update(next);
        } else {
          NS.youtube.update(next);
        }

        // --- page translation ---
        if (NS.page) {
          if (!next.enabled || NS.page.isBlocked(next)) {
            if (NS.page.state.active) NS.page.stop();
          } else {
            NS.page.update(next);
            if (!NS.page.state.active) startPageAuto();
          }
        }
      } catch (e) {
        /* never break the page because of a settings change */
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Popup / options RPC
  // ---------------------------------------------------------------------------
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      try {
        switch (msg.type) {
          case 'lingua:get-state':
            sendResponse({ ok: true, state: snapshot() });
            break;

          case 'lingua:refresh':
            NS.youtube.load();
            sendResponse({ ok: true });
            break;

          case 'lingua:retranslate': {
            const st = NS.store.state;
            st.translations = new Array(st.cues.length).fill(null);
            st.pending = new Set();
            NS.store.setStatus(NS.store.STATUS.TRANSLATING);
            NS.youtube.load();
            sendResponse({ ok: true });
            break;
          }

          case 'lingua:pick-track':
            settings = { ...settings, sourceLang: msg.payload.languageCode };
            NS.youtube.load();
            sendResponse({ ok: true });
            break;

          // --- full-page translation ---
          case 'lingua:page-toggle':
            if (!ready(settings)) {
              sendResponse({ ok: false, error: '请先配置翻译服务' });
              break;
            }
            if (NS.page.state.active) {
              NS.page.stop();
              sendResponse({ ok: true, active: false });
            } else {
              NS.page.start(settings).catch(() => {});
              sendResponse({ ok: true, active: true });
            }
            break;

          case 'lingua:page-retranslate':
            NS.page.retranslate(settings).catch(() => {});
            sendResponse({ ok: true });
            break;

          case 'lingua:page-toggle-original':
            sendResponse({ ok: true, showOriginal: NS.page.toggleOriginal() });
            break;

          case 'lingua:page-clear':
            NS.page.stop();
            sendResponse({ ok: true });
            break;

          case 'lingua:site-rule': {
            const host = NS.page.hostname();
            const rule = msg.payload.rule; // auto | manual | skip
            const auto = new Set(settings.page.autoSites || []);
            const skip = new Set(settings.page.skipSites || []);
            auto.delete(host);
            skip.delete(host);
            if (rule === 'auto') auto.add(host);
            if (rule === 'skip') skip.add(host);
            NS.settings
              .setSettings({ page: { autoSites: Array.from(auto), skipSites: Array.from(skip) } })
              .then((s) => {
                settings = s;
                if (rule === 'skip' && NS.page.state.active) NS.page.stop();
              })
              .catch(() => {});
            sendResponse({ ok: true, rule });
            break;
          }

          default:
            return false;
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return true;
    });
  } catch (e) {
    /* context invalidated — nothing to do */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
