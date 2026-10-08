/**
 * Lingua — bridge layer (isolated world).
 * Two channels:
 *   - window.postMessage  <-> MAIN world interceptor (caption sniffing/fetching)
 *   - chrome.runtime port <-> service worker (translation)
 *
 * Also owns liveness detection. When the extension is reloaded or updated, the
 * content script already living in the page keeps running but every chrome.*
 * call throws "Extension context invalidated." We detect that, fail fast with a
 * typed error, and never retry — otherwise the scheduler hammers a dead channel.
 *
 * Registers onto Lingua.bridge.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const { BRIDGE, MSG } = NS.constants;

  const CODE_CONTEXT_LOST = 'CONTEXT_INVALIDATED';

  /** Is our extension context still alive in this page? */
  function isAlive() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function contextError() {
    const e = new Error('扩展已更新或重新加载，请刷新本页面后继续使用');
    e.code = CODE_CONTEXT_LOST;
    e.retriable = false;
    return e;
  }

  /** Normalise the raw chrome error so callers can branch on a stable code. */
  function normalizeError(err) {
    const msg = (err && err.message) || String(err || '');
    if (/context invalidated|Extension context|message port closed|receiving end does not exist/i.test(msg)) {
      return contextError();
    }
    return err instanceof Error ? err : new Error(msg || '请求失败');
  }

  // ---------------------------------------------------------------------------
  // MAIN world channel
  // ---------------------------------------------------------------------------
  const trackListeners = new Set();
  const captionListeners = new Set();
  const transcriptListeners = new Set();
  const pendingFetches = new Map();
  let fetchSeq = 0;
  let mainReady = false;

  function initPageChannel() {
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== BRIDGE.SOURCE) return;

      switch (d.type) {
        case BRIDGE.READY:
          mainReady = true;
          probe();
          break;
        case BRIDGE.PLAYER_RESPONSE:
          if (d.tracks) {
            for (const cb of trackListeners) {
              safe(cb, { tracks: d.tracks, defaultIndex: d.defaultIndex, videoId: d.videoId });
            }
          }
          if (d.transcript) for (const cb of transcriptListeners) safe(cb, { transcript: d.transcript });
          break;
        case BRIDGE.CAPTION_RESPONSE:
          for (const cb of captionListeners) safe(cb, { url: d.url, body: d.body });
          break;
        case BRIDGE.FETCH_RESULT: {
          const p = pendingFetches.get(d.requestId);
          if (p) {
            pendingFetches.delete(d.requestId);
            p.resolve({ body: d.body, status: d.status, empty: !!d.empty, error: d.error });
          }
          break;
        }
        default:
          break;
      }
    });

    // Ask the page for the current player response, repeatedly until it answers.
    let tries = 0;
    const ask = () => {
      probe();
      if (++tries < 15 && !mainReady) setTimeout(ask, 600);
    };
    ask();
  }

  function safe(cb, payload) {
    try {
      cb(payload);
    } catch (e) {
      /* listener error must not break the bridge */
    }
  }

  function onTracks(cb) {
    trackListeners.add(cb);
    return () => trackListeners.delete(cb);
  }

  function onCaption(cb) {
    captionListeners.add(cb);
    return () => captionListeners.delete(cb);
  }

  function onTranscript(cb) {
    transcriptListeners.add(cb);
    return () => transcriptListeners.delete(cb);
  }

  function probe() {
    window.postMessage({ source: BRIDGE.SOURCE, type: BRIDGE.PROBE }, window.location.origin);
  }

  /** Ask the page context to fetch a caption track (keeps PoToken/cookies valid). */
  function fetchTrack(url, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const requestId = `f${++fetchSeq}`;
      const timer = setTimeout(() => {
        pendingFetches.delete(requestId);
        resolve({ body: '', status: 0, empty: true, error: 'timeout' });
      }, timeoutMs);
      pendingFetches.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      window.postMessage({ source: BRIDGE.SOURCE, type: BRIDGE.FETCH_TRACK, url, requestId }, window.location.origin);
    });
  }

  // ---------------------------------------------------------------------------
  // Service-worker channel
  // ---------------------------------------------------------------------------
  let port = null;
  let reqSeq = 0;
  const pendingCalls = new Map();

  function connect() {
    if (!isAlive()) {
      port = null;
      return null;
    }
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: MSG.PORT });
      port.onMessage.addListener((msg) => {
        const entry = pendingCalls.get(msg.requestId);
        if (!entry) return;
        // A progress notification is NOT a final response. It must always return
        // here — falling through would treat it as a failure (it carries no `ok`)
        // and reject a request that is still running.
        if (msg.progress !== undefined && msg.done !== true) {
          if (entry.onProgress) entry.onProgress(msg.progress);
          if (msg.progress && msg.progress.partial && entry.onPartial) {
            entry.onPartial(msg.progress.partial);
          }
          return;
        }
        pendingCalls.delete(msg.requestId);
        if (msg.ok) entry.resolve({ results: msg.results, stats: msg.stats, jobId: msg.jobId });
        else entry.reject(normalizeError(new Error(msg.error || '翻译失败')));
      });
      port.onDisconnect.addListener(() => {
        port = null;
        const err = isAlive() ? new Error('后台连接已断开') : contextError();
        for (const [, entry] of pendingCalls) entry.reject(err);
        pendingCalls.clear();
      });
    } catch (e) {
      port = null;
    }
    return port;
  }

  /**
   * @param {string[]} texts
   * @param {{from:string,to:string,kind?:string,profile?:object,onProgress?:Function}} opts
   */
  function translate(texts, opts = {}) {
    if (!isAlive()) return Promise.reject(contextError());
    const p = connect();
    if (!p) return Promise.reject(contextError());
    return new Promise((resolve, reject) => {
      const requestId = `r${++reqSeq}`;
      pendingCalls.set(requestId, { resolve, reject, onProgress: opts.onProgress, onPartial: opts.onPartial });
      try {
        p.postMessage({
          type: MSG.TRANSLATE_BATCH,
          requestId,
          payload: {
            texts,
            from: opts.from,
            to: opts.to,
            kind: opts.kind || 'subtitle',
            // Only the profile id and free-text note travel; the directives are
            // resolved in the worker from constants.js.
            profile: opts.profile || null,
          },
        });
      } catch (e) {
        pendingCalls.delete(requestId);
        reject(normalizeError(e));
      }
    });
  }

  function cancel(jobId) {
    const p = connect();
    if (!p) return;
    try {
      p.postMessage({ type: MSG.CANCEL_JOB, payload: { jobId } });
    } catch (e) {
      /* ignore */
    }
  }

  /** One-shot request/response against the service worker. */
  function sendMessage(type, payload) {
    return new Promise((resolve, reject) => {
      if (!isAlive()) {
        reject(contextError());
        return;
      }
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          if (chrome.runtime.lastError) {
            reject(normalizeError(new Error(chrome.runtime.lastError.message)));
            return;
          }
          if (res && res.ok) resolve(res);
          else reject(new Error((res && res.error) || '请求失败'));
        });
      } catch (e) {
        reject(normalizeError(e));
      }
    });
  }

  function setBadge(text) {
    sendMessage(MSG.BADGE, { text }).catch(() => {});
  }

  NS.bridge = {
    initPageChannel,
    onTracks,
    onCaption,
    onTranscript,
    probe,
    fetchTrack,
    translate,
    cancel,
    sendMessage,
    setBadge,
    isAlive,
    contextError,
    CODE_CONTEXT_LOST,
    get port() {
      return port;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
