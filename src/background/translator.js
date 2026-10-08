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
  const TRANSIENT_CODES = new Set(['HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504', 'TIMEOUT', 'NETWORK']);

  /**
   * Per-provider adaptive request limiter.
   *
   * A fixed concurrency is either timid on a fast endpoint or reckless on a
   * rate-limited one. This starts from the user's setting, grows back to it
   * after clean batches, and backs off immediately when the provider pushes
   * back. It is session-local on purpose: a bad gateway should not permanently
   * lower the user's configured value.
   */
  const limiters = new Map();

  function limiterFor(providerId, configured) {
    const base = clamp(configured || 4, 1, 8);
    let lim = limiters.get(providerId);
    if (!lim) {
      lim = { limit: base, base, success: 0, cooldownUntil: 0 };
      limiters.set(providerId, lim);
    } else {
      lim.base = base;
      lim.limit = Math.min(lim.limit, base);
    }
    return lim;
  }

  function currentLimit(lim) {
    if (Date.now() < lim.cooldownUntil) {
      return Math.max(1, Math.floor(lim.limit / 2));
    }
    return lim.limit;
  }

  function noteSuccess(lim) {
    if (Date.now() < lim.cooldownUntil) return;
    lim.success++;
    if (lim.success >= 8 && lim.limit < lim.base) {
      lim.limit++;
      lim.success = 0;
    }
  }

  function noteFailure(lim, err) {
    const status = err && err.status;
    const transient =
      TRANSIENT_CODES.has(err && err.code) ||
      status === 429 ||
      (typeof status === 'number' && status >= 500) ||
      (err && err.name === 'TimeoutError');
    if (!transient) return;
    lim.limit = Math.max(1, Math.floor(lim.limit / 2));
    lim.success = 0;
    lim.cooldownUntil = Date.now() + 5000;
  }

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
  function emitPartial(ctx, baseIndex, out) {
    if (!ctx.onPartial || !out) return;
    for (let i = 0; i < out.length; i++) {
      if (out[i]) ctx.onPartial(ctx.indexMap ? ctx.indexMap[baseIndex + i] : baseIndex + i, out[i]);
    }
  }

  async function splitAndTranslate(provider, texts, ctx, depth) {
    const baseIndex = ctx.baseIndex || 0;
    const partials = new Map();
    const childCtx = ctx.onPartial
      ? Object.assign({}, ctx, {
          onDelta: (index, text) => partials.set(index, text),
        })
      : ctx;
    if (texts.length <= 1) {
      try {
        const r = await provider.translateBatch(texts, childCtx);
        for (const [index, text] of partials) if (!r[index]) r[index] = text;
        emitPartial(ctx, baseIndex, r);
        return r;
      } catch (e) {
        if (isFatal(e)) throw e;
        return new Array(texts.length).fill(null);
      }
    }
    const mid = Math.ceil(texts.length / 2);
    const [a, b] = await Promise.all([
      translateChunk(provider, texts.slice(0, mid), Object.assign({}, childCtx, { baseIndex }), depth + 1),
      translateChunk(provider, texts.slice(mid), Object.assign({}, childCtx, { baseIndex: baseIndex + mid }), depth + 1),
    ]);
    return [...a, ...b];
  }

  /**
   * Translate one batch with retry + alignment repair.
   * `out[i] === null` marks a line the provider failed to return.
   */
  async function translateChunk(provider, texts, ctx, depth = 0) {
    if (ctx.signal && ctx.signal.aborted) throw abortError();

    const baseIndex = ctx.baseIndex || 0;
    const cfg = provider.id === 'openai' ? ctx.settings.providers.openai : null;
    const streamCtx =
      ctx.onPartial && cfg && cfg.stream !== false
        ? Object.assign({}, ctx, {
            onDelta: (index, text) => {
              if (ctx.onPartial) ctx.onPartial(ctx.indexMap ? ctx.indexMap[baseIndex + index] : baseIndex + index, text);
            },
          })
        : ctx;

    let out;
    try {
      out = await retry(() => provider.translateBatch(texts, streamCtx), {
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
    const repairBase = ctx.onPartial ? missing : null;
    const repaired = await splitAndTranslate(
      provider,
      subTexts,
      repairBase
        ? Object.assign({}, ctx, { baseIndex: 0, indexMap: repairBase })
        : Object.assign({}, ctx, { baseIndex: baseIndex + missing[0] }),
      depth
    );
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
    const cacheSignature = BG.cache.signature(settings, kind, profile);

    if (settings.cacheEnabled) await BG.cache.ensureLoaded();

    const results = new Array(texts.length).fill(null);
    const miss = [];

    for (let i = 0; i < texts.length; i++) {
      if (settings.cacheEnabled) {
        const hit = BG.cache.get(BG.cache.makeKey(texts[i], from, to, providerId, model, cacheSignature));
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
      const limiter = limiterFor(providerId, settings.concurrency || 4);
      const concurrency = currentLimit(limiter);
      let done = 0;
      const chunkBase = new Map();
      for (const chunk of chunks) chunkBase.set(chunk, chunk[0]);

      await pool(chunks, concurrency, async (chunk) => {
        if (signal && signal.aborted) return;
        const subTexts = chunk.map((i) => texts[i]);
        let out;
        try {
          out = await translateChunk(provider, subTexts, {
            settings,
            from,
            to,
            signal,
            kind,
            profile,
            baseIndex: chunkBase.get(chunk) || 0,
            onPartial: opts.onPartial,
          });
          noteSuccess(limiter);
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          noteFailure(limiter, err);
          out = new Array(subTexts.length).fill(null);
        }
        for (let j = 0; j < chunk.length; j++) {
          const idx = chunk[j];
          const val = out[j];
          if (val) {
            results[idx] = val;
            stats.translated++;
            if (settings.cacheEnabled) {
              BG.cache.set(BG.cache.makeKey(texts[idx], from, to, providerId, model, cacheSignature), val);
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
