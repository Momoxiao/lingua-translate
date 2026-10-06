/**
 * Lingua — translation cache.
 * Two tiers: an in-memory LRU Map (hot path) + a debounced chrome.storage.local
 * snapshot (survives service-worker restarts). Registers onto Lingua.bg.cache.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});
  const { hash, debounce } = NS.utils;
  const { CACHE } = NS.constants;

  /** key -> translated string. Insertion order is our LRU order. */
  const mem = new Map();
  let loaded = false;
  let loading = null;
  let dirty = false;

  function makeKey(text, from, to, provider, model) {
    return hash(`${provider}|${model || ''}|${from}|${to}|${text}`);
  }

  async function ensureLoaded() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const res = await chrome.storage.local.get(CACHE.STORAGE_KEY);
        const snap = res && res[CACHE.STORAGE_KEY];
        if (snap && typeof snap === 'object') {
          for (const k of Object.keys(snap)) mem.set(k, snap[k]);
        }
      } catch (e) {
        /* storage unavailable — run cache-less */
      }
      loaded = true;
      loading = null;
    })();
    return loading;
  }

  const flush = debounce(async () => {
    if (!dirty) return;
    dirty = false;
    try {
      const obj = {};
      for (const [k, v] of mem) obj[k] = v;
      await chrome.storage.local.set({ [CACHE.STORAGE_KEY]: obj });
    } catch (e) {
      dirty = true; // retry on next flush
    }
  }, CACHE.FLUSH_DEBOUNCE_MS);

  function get(key) {
    if (!mem.has(key)) return undefined;
    const v = mem.get(key);
    // refresh LRU position
    mem.delete(key);
    mem.set(key, v);
    return v;
  }

  function set(key, value) {
    mem.set(key, value);
    dirty = true;
    if (mem.size > CACHE.MAX_ENTRIES) {
      const excess = mem.size - CACHE.MAX_ENTRIES;
      let i = 0;
      for (const k of mem.keys()) {
        if (i++ >= excess) break;
        mem.delete(k);
      }
    }
    flush();
  }

  function stats() {
    return { entries: mem.size, loaded };
  }

  async function clear() {
    mem.clear();
    dirty = false;
    try {
      await chrome.storage.local.remove(CACHE.STORAGE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  BG.cache = { makeKey, get, set, stats, clear, ensureLoaded };
})(typeof globalThis !== 'undefined' ? globalThis : self);
