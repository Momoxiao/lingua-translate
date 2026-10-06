/**
 * Lingua — translation orchestrator.
 * Turns a flat array of subtitle lines into translated lines using:
 *   cache lookup -> chunking -> bounded concurrency -> retry -> adaptive split.
 * Registers onto Lingua.bg.translator.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});
  const { retry, pool, clamp } = NS.utils;

  const FATAL_CODES = new Set(['HTTP_401', 'HTTP_403', 'HTTP_404', 'BAD_JSON']);

  function isFatal(err) {
    return !!err && FATAL_CODES.has(err.code);
  }

  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function abortError() {
    const e = new Error('已取消');
    e.name = 'AbortError';
    e.retriable = false;
    return e;
  }

  /** Split a failing batch in half and translate both halves concurrently. */
  async function splitAndTranslate(provider, texts, ctx, depth) {
    if (texts.length <= 1) {
      try {
        const r = await provider.translateBatch(texts, ctx);
        return r;
      } catch (e) {
        if (isFatal(e)) throw e;
        return new Array(texts.length).fill(null);
      }
    }
    const mid = Math.ceil(texts.length / 2);
    const [a, b] = await Promise.all([
      translateChunk(provider, texts.slice(0, mid), ctx, depth + 1),
      translateChunk(provider, texts.slice(mid), ctx, depth + 1),
    ]);
    return [...a, ...b];
  }

  /**
   * Translate one batch with retry + alignment repair.
   * `out[i] === null` marks a line the provider failed to return.
   */
  async function translateChunk(provider, texts, ctx, depth = 0) {
    if (ctx.signal && ctx.signal.aborted) throw abortError();

    let out;
    try {
      out = await retry(() => provider.translateBatch(texts, ctx), {
        attempts: 3,
        base: 400,
        shouldRetry: (err) => !isFatal(err) && !(err && err.retriable === false),
      });
    } catch (err) {
      if (isFatal(err) || depth >= 3) throw err;
      return splitAndTranslate(provider, texts, ctx, depth);
    }

    if (!Array.isArray(out)) return new Array(texts.length).fill(null);

    const missing = [];
    for (let i = 0; i < out.length; i++) if (!out[i]) missing.push(i);
    if (missing.length === 0) return out;
    if (texts.length === 1 || depth >= 3) return out;

    // Repair: re-request only the lines the model dropped, in a smaller batch.
    const subTexts = missing.map((i) => texts[i]);
    const repaired = await splitAndTranslate(provider, subTexts, ctx, depth);
    missing.forEach((origIdx, k) => {
      if (repaired[k]) out[origIdx] = repaired[k];
    });
    return out;
  }

  /**
   * @param {string[]} texts
   * @param {{settings:object, from:string, to:string, signal?:AbortSignal, kind?:string, profile?:object, onProgress?:Function}} opts
   * @returns {Promise<{results:string[], stats:object}>}
   */
  async function translate(texts, opts) {
    const { settings, from, to, signal, kind, profile } = opts;
    if (!texts.length) return { results: [], stats: { total: 0, cached: 0, translated: 0, failed: 0 } };

    const providerId = settings.provider;
    const provider = BG.providers[providerId];
    if (!provider) throw new Error(`未知的翻译服务：${providerId}`);

    const model = providerId === 'openai' ? settings.providers.openai.model : '';

    if (settings.cacheEnabled) await BG.cache.ensureLoaded();

    const results = new Array(texts.length).fill(null);
    const miss = [];

    for (let i = 0; i < texts.length; i++) {
      if (settings.cacheEnabled) {
        const hit = BG.cache.get(BG.cache.makeKey(texts[i], from, to, providerId, model));
        if (hit != null) {
          results[i] = hit;
          continue;
        }
      }
      miss.push(i);
    }

    const stats = { total: texts.length, cached: texts.length - miss.length, translated: 0, failed: 0 };

    if (miss.length) {
      const providerCap = provider.maxTexts || 64;
      const size = clamp(settings.batchSize || 16, 1, providerCap);
      const chunks = chunkArray(miss, size);
      const concurrency = clamp(settings.concurrency || 4, 1, 8);
      let done = 0;

      await pool(chunks, concurrency, async (chunk) => {
        if (signal && signal.aborted) return;
        const subTexts = chunk.map((i) => texts[i]);
        let out;
        try {
          out = await translateChunk(provider, subTexts, { settings, from, to, signal, kind, profile });
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          out = new Array(subTexts.length).fill(null);
        }
        for (let j = 0; j < chunk.length; j++) {
          const idx = chunk[j];
          const val = out[j];
          if (val) {
            results[idx] = val;
            stats.translated++;
            if (settings.cacheEnabled) {
              BG.cache.set(BG.cache.makeKey(texts[idx], from, to, providerId, model), val);
            }
          } else {
            stats.failed++;
          }
        }
        done += chunk.length;
        if (opts.onProgress) opts.onProgress({ done, total: miss.length });
      });
    }

    // Anything still missing falls back to the source line so the overlay never
    // renders an empty subtitle.
    for (let i = 0; i < results.length; i++) if (results[i] == null) results[i] = texts[i];

    return { results, stats };
  }

  /** Connectivity / credential check used by the options page. */
  async function testProvider(settings) {
    const provider = BG.providers[settings.provider];
    if (!provider) throw new Error(`未知的翻译服务：${settings.provider}`);
    if (!provider.test) throw new Error('该服务不支持连接测试');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      return await provider.test(settings);
    } finally {
      clearTimeout(timer);
    }
  }

  BG.translator = { translate, testProvider };
})(typeof globalThis !== 'undefined' ? globalThis : self);
