/**
 * Lingua — live / no-track realtime fallback (isolated world).
 * When no caption track can be fetched (live streams, some premieres), we read
 * the caption line YouTube itself renders and translate it on the fly.
 * Registers onto Lingua.live.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const { store, bridge, overlay } = NS;

  const POLL_MS = 220;
  const SETTLE_MS = 120; // wait for the caption to stop changing before translating

  let timer = 0;
  let settings = null;
  let running = false;
  let cache = new Map(); // original -> translated
  let pendingText = '';
  let lastShownOriginal = '';
  let lastShownTranslated = '';
  let currentOriginal = '';
  let currentSince = 0;
  let inflightText = '';
  let retryTimer = 0;

  const MAX_CACHE = 500;

  function readCaption() {
    const win = document.querySelector('.ytp-caption-window-container .ytp-caption-window-bottom') ||
      document.querySelector('.ytp-caption-window-container');
    if (!win) return '';
    const segs = win.querySelectorAll('.ytp-caption-segment');
    if (segs.length) {
      let out = '';
      segs.forEach((s) => {
        out += (s.textContent || '') + ' ';
      });
      return out.replace(/\s+/g, ' ').trim();
    }
    return (win.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function translateNow(text) {
    if (!text || inflightText === text) return;
    if (cache.has(text)) {
      show(text, cache.get(text));
      return;
    }
    inflightText = text;
    bridge
      .translate([text], { from: settings.sourceLang, to: settings.targetLang })
      .then(({ results }) => {
        const out = (results && results[0]) || '';
        if (cache.size > MAX_CACHE) cache.clear();
        cache.set(text, out);
        if (out && text === currentOriginal) show(text, out);
      })
      .catch(() => {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          inflightText = '';
        }, 3000);
      })
      .finally(() => {
        if (inflightText === text) inflightText = '';
      });
  }

  function show(original, translated) {
    if (original === lastShownOriginal && translated === lastShownTranslated) return;
    lastShownOriginal = original;
    lastShownTranslated = translated;
    overlay.setLive(original, translated);
  }

  function poll() {
    if (!running) return;
    const text = readCaption();

    if (text !== currentOriginal) {
      currentOriginal = text;
      currentSince = Date.now();
      if (!text) {
        // Caption cleared — clear the overlay too.
        show('', '');
        return;
      }
      // Immediately surface a cached translation to avoid flicker.
      if (cache.has(text)) {
        show(text, cache.get(text));
        return;
      }
      show(text, ''); // show original while the translation is in flight
      return;
    }

    if (!text) return;
    // Caption has settled -> translate once.
    if (Date.now() - currentSince >= SETTLE_MS && text !== pendingText) {
      pendingText = text;
      translateNow(text);
    }
  }

  function canHandle() {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    const isLive = !!document.querySelector('.ytp-live') || (v && v.duration === Infinity);
    return !!v && isLive;
  }

  function start(s) {
    settings = s;
    if (running) return;
    running = true;
    store.state.liveMode = true;
    overlay.mount();
    overlay.applyStyles(s);
    overlay.setVisible(true);
    overlay.start();
    NS.youtube.forceCaptionRequest();
    timer = setInterval(poll, POLL_MS);
    bridge.setBadge('LIVE');
  }

  function stop() {
    running = false;
    store.state.liveMode = false;
    clearInterval(timer);
    timer = 0;
    clearTimeout(retryTimer);
    inflightText = '';
    pendingText = '';
    currentOriginal = '';
    lastShownOriginal = '';
    lastShownTranslated = '';
    overlay.setLive(null);
  }

  NS.live = { start, stop, canHandle };
})(typeof globalThis !== 'undefined' ? globalThis : self);
