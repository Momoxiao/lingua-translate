/**
 * Lingua — translation cache.
 *
 * Three rules keep this both fast and predictable:
 *   1. hot reads/writes touch an in-memory LRU Map only;
 *   2. persistence is split into fixed shards, so a flush rewrites only the
 *      buckets that changed instead of serialising the whole 15k-entry cache;
 *   3. every key includes a request-configuration fingerprint, so changing the
 *      prompt, model, endpoint or translation mode cannot reuse stale output.
 *
 * Registers onto Lingua.bg.cache.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});
  const { hash, debounce } = NS.utils;
  const { CACHE } = NS.constants;

  /** key -> translated string. Insertion order is our LRU order. */
  const mem = new Map();
  const dirtyShards = new Set();
  let loaded = false;
  let loading = null;
  let writeChain = Promise.resolve();

  function shardCount() {
    const n = Number(CACHE.SHARD_COUNT) || 1;
    return Math.max(1, Math.min(64, Math.floor(n)));
  }

  function storageKey(shard) {
    return `${CACHE.STORAGE_KEY}:${shard}`;
  }

  function allStorageKeys() {
    const keys = [];
    for (let i = 0; i < shardCount(); i++) keys.push(storageKey(i));
    return keys;
  }

  function legacyKeys() {
    return Array.isArray(CACHE.LEGACY_STORAGE_KEYS) ? CACHE.LEGACY_STORAGE_KEYS : [];
  }

  function bucketOf(key) {
    let n = 2166136261;
    const s = String(key);
    for (let i = 0; i < s.length; i++) {
      n ^= s.charCodeAt(i);
      n = Math.imul(n, 16777619);
    }
    return (n >>> 0) % shardCount();
  }

  function makeKey(text, from, to, provider, model, signature) {
    const config = signature || '';
    return hash(`v${CACHE.VERSION}|${provider}|${model || ''}|${config}|${from}|${to}|${text}`);
  }

  /**
   * Stable fingerprint of everything that can change a translation without
   * changing the source text. API keys are deliberately excluded: rotating one
   * must not throw away a valid cache.
   */
  function signature(settings, kind, profile) {
    const providerId = (settings && settings.provider) || '';
    const cfg = (settings && settings.providers && settings.providers[providerId]) || {};
    const parts = [providerId, kind || 'subtitle'];
    if (profile && profile.id) parts.push(profile.id, String(profile.notes || ''));

    if (providerId === 'openai') {
      parts.push(
        'base=' + String(cfg.baseUrl || ''),
        'model=' + String(cfg.model || ''),
        'temp=' + String(cfg.temperature == null ? 0 : cfg.temperature),
        'reasoning=' + String(cfg.reasoning || ''),
        'prompt=' + String(cfg.prompt || '')
      );
    } else if (providerId === 'deepl') {
      parts.push('base=' + String(cfg.baseUrl || ''), 'pro=' + String(!!cfg.pro));
    } else if (providerId === 'google') {
      // The key switches between the official API and the free web endpoint.
      parts.push('official=' + String(!!cfg.apiKey));
    } else if (providerId === 'microsoft') {
      parts.push('base=' + String(cfg.baseUrl || ''), 'region=' + String(cfg.region || ''));
    } else if (providerId === 'custom') {
      parts.push(
        'url=' + String(cfg.url || ''),
        'method=' + String(cfg.method || 'POST'),
        'headers=' + String(cfg.headers || ''),
        'body=' + String(cfg.body || ''),
        'path=' + String(cfg.responsePath || '')
      );
    }
    return hash(parts.join('\n'));
  }

  async function ensureLoaded() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const legacy = legacyKeys();
        const keys = allStorageKeys();
        const res = await chrome.storage.local.get([...keys, ...legacy]);
        for (const key of keys) {
          const snap = res && res[key];
          if (!snap || typeof snap !== 'object') continue;
          for (const k of Object.keys(snap)) mem.set(k, snap[k]);
        }
        if (legacy.length) await chrome.storage.local.remove(legacy);
      } catch (e) {
        /* storage unavailable — run cache-less */
      }
      loaded = true;
      loading = null;
    })();
    return loading;
  }

  function snapshotDirtyShards() {
    const dirty = Array.from(dirtyShards);
    dirtyShards.clear();
    if (!dirty.length) return null;
    const payloads = {};
    for (const shard of dirty) payloads[shard] = {};
    for (const [key, value] of mem) {
      const shard = bucketOf(key);
      if (payloads[shard]) payloads[shard][key] = value;
    }
    const writes = {};
    for (const shard of dirty) writes[storageKey(shard)] = payloads[shard];
    return writes;
  }

  async function flushNow() {
    const writes = snapshotDirtyShards();
    if (!writes) return;
    try {
      await chrome.storage.local.set(writes);
    } catch (e) {
      for (const key of Object.keys(writes)) {
        dirtyShards.add(Number(key.slice(`${CACHE.STORAGE_KEY}:`.length)));
      }
      scheduleFlush();
    }
  }

  const scheduleFlush = debounce(() => {
    writeChain = writeChain.then(flushNow, flushNow);
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
    dirtyShards.add(bucketOf(key));
    if (mem.size > CACHE.MAX_ENTRIES) {
      const excess = mem.size - CACHE.MAX_ENTRIES;
      let i = 0;
      for (const k of mem.keys()) {
        if (i++ >= excess) break;
        mem.delete(k);
        dirtyShards.add(bucketOf(k));
      }
    }
    scheduleFlush();
  }

  function stats() {
    return { entries: mem.size, loaded, shards: shardCount(), dirtyShards: dirtyShards.size };
  }

  async function clear() {
    mem.clear();
    dirtyShards.clear();
    const remove = () => chrome.storage.local.remove([...allStorageKeys(), ...legacyKeys()]);
    writeChain = writeChain.then(remove, remove);
    try {
      await writeChain;
    } catch (e) {
      /* ignore */
    }
  }

  BG.cache = { makeKey, signature, get, set, stats, clear, ensureLoaded, bucketOf };
})(typeof globalThis !== 'undefined' ? globalThis : self);
