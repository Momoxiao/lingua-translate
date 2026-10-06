/**
 * Lingua — shared utilities.
 * Classic script, registers onto globalThis.Lingua.utils.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});

  /** Stable 53-bit string hash (FNV-1a variant, fast enough for cache keys). */
  function hash(str) {
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function debounce(fn, wait) {
    let t = null;
    return function debounced(...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn.apply(this, args);
      }, wait);
    };
  }

  function throttle(fn, wait) {
    let last = 0;
    let pending = null;
    return function throttled(...args) {
      const now = Date.now();
      if (now - last >= wait) {
        last = now;
        fn.apply(this, args);
      } else if (!pending) {
        pending = setTimeout(() => {
          pending = null;
          last = Date.now();
          fn.apply(this, args);
        }, wait - (now - last));
      }
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Retry with exponential backoff + jitter. `shouldRetry` decides per-error. */
  async function retry(fn, { attempts = 3, base = 400, max = 6000, shouldRetry } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn(i);
      } catch (err) {
        lastErr = err;
        const retriable = shouldRetry ? shouldRetry(err, i) : true;
        if (!retriable || i === attempts - 1) break;
        const delay = Math.min(max, base * 2 ** i) * (0.75 + Math.random() * 0.5);
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  /** Run async tasks with a bounded concurrency pool. Preserves result order. */
  async function pool(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const size = Math.max(1, Math.min(limit || 1, items.length || 1));
    const runners = new Array(size).fill(0).map(async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    });
    await Promise.all(runners);
    return results;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Deep-merge plain objects (b wins). Arrays are replaced, not concatenated. */
  function deepMerge(a, b) {
    if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
    const out = { ...a };
    for (const k of Object.keys(b)) {
      const bv = b[k];
      out[k] = isPlainObject(bv) && isPlainObject(a[k]) ? deepMerge(a[k], bv) : bv;
    }
    return out;
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && (v.constructor === Object || Object.getPrototypeOf(v) === null);
  }

  /** Resolve "a.b[0].c" / "data.translations.0.text" against an object. */
  function getPath(obj, path) {
    if (!path) return obj;
    const parts = String(path)
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .filter(Boolean);
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  /** Clamp helper */
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  /** Format seconds -> mm:ss */
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // Why a video shows no subtitles
  // ---------------------------------------------------------------------------
  /**
   * `status: 'empty'` is not one condition — it is three wearing one name, and
   * the advice is different for each. The popup and the diagnostics page used to
   * write their own sentence for it, and both said "该视频没有可用字幕" even when
   * they had just printed six caption tracks above it. The user's takeaway was
   * "this video cannot be translated" when the real problem was that our fetch
   * came back empty — a bug to report, not a dead end.
   *
   * One function, one wording, so the two screens cannot disagree again.
   * `reason` wins when present; `tracks.length` is the fallback for callers
   * holding an older state shape.
   *
   * @param {object} sub the `subtitle` block of the content-script snapshot
   * @returns {{tone:'info'|'warn', reason:string, text:string}}
   */
  function emptySubtitleNote(sub) {
    const s = sub || {};
    const tracks = Array.isArray(s.tracks) ? s.tracks : [];
    const reason = s.reason || (tracks.length ? 'empty-track' : 'no-captions');

    if (reason === 'not-a-video') {
      return { tone: 'info', reason, text: '当前不是 YouTube 视频播放页，不会加载字幕。' };
    }
    if (reason === 'empty-track' || tracks.length) {
      return {
        tone: 'warn',
        reason: 'empty-track',
        text:
          `这个视频有 ${tracks.length} 条字幕轨，但一条字幕数据都没取回来——` +
          '失败的是「取字幕」这一步，不是视频没有字幕。到诊断页复制信息上报即可。',
      };
    }
    return { tone: 'warn', reason: 'no-captions', text: '这个视频没有可用字幕，无法翻译。' };
  }

  /** Short label for the diagnostic report, so `reason` is readable in an issue. */
  const EMPTY_REASON_LABEL = {
    'not-a-video': '页面不是视频播放页',
    'no-captions': '播放器没有报告任何字幕轨',
    'empty-track': '字幕轨在，但取回的字幕数据是空的',
    'ad': '正在播放广告，字幕加载已推迟',
  };

  function emptyReasonLabel(reason) {
    return EMPTY_REASON_LABEL[reason] || reason || '';
  }

  NS.utils = {
    hash,
    debounce,
    throttle,
    sleep,
    retry,
    pool,
    escapeRegExp,
    deepMerge,
    isPlainObject,
    getPath,
    clamp,
    fmtTime,
    emptySubtitleNote,
    emptyReasonLabel,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
