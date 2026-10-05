/**
 * Lingua — shared utilities.
 * Classic script, registers onto globalThis.YTST.utils.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});

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

  NS.utils = { hash, debounce, throttle, sleep, retry, pool, escapeRegExp, deepMerge, isPlainObject, getPath, clamp, fmtTime };
})(typeof globalThis !== 'undefined' ? globalThis : self);
