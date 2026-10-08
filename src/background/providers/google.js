/**
 * Lingua — Google Translate provider.
 * Two paths: official Cloud Translation v2 (when an API key is set) and the
 * free public gtx endpoint (no key). Registers onto Lingua.bg.providers.google.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});
  const { requestJson } = BG.http;
  const { ENGINE_LANG } = NS.constants;
  const tr = (zh, key, vars) => (NS.i18n ? NS.i18n.t(zh, key, vars) : zh);

  function targetCode(to) {
    return ENGINE_LANG.google[to] || to;
  }

  async function official(texts, { settings, from, to, signal }) {
    const key = settings.providers.google.apiKey;
    const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`;
    const body = { q: texts, target: targetCode(to), format: 'text' };
    if (from && from !== 'auto') body.source = from;
    const json = await requestJson(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal },
      'Google Cloud Translation'
    );
    const list = (json && json.data && json.data.translations) || [];
    return texts.map((_, i) => (list[i] && decode(list[i].translatedText)) || null);
  }

  async function free(texts, { from, to, signal }) {
    const url = new URL('https://translate.googleapis.com/translate_a/t');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('format', 'text');
    url.searchParams.set('sl', from && from !== 'auto' ? from : 'auto');
    url.searchParams.set('tl', targetCode(to));
    for (const t of texts) url.searchParams.append('q', t);

    const json = await requestJson(
      url.toString(),
      { method: 'GET', signal },
      tr('Google 翻译', 'provider.google.label')
    );
    return normalize(json, texts.length);
  }

  /** The free endpoint's shape has drifted over the years — normalise all of them. */
  function normalize(data, count) {
    if (!Array.isArray(data)) return new Array(count).fill(null);
    // ["a","b"] | [["a"],["b"]] | [["a","en"],["b","en"]] | [[["a"]]]
    const flat = data.map((d) => {
      if (typeof d === 'string') return d;
      if (Array.isArray(d)) {
        const first = d[0];
        if (typeof first === 'string') return first;
        if (Array.isArray(first)) return first.map((x) => (Array.isArray(x) ? x[0] : x)).join('');
      }
      return null;
    });
    if (flat.length === count) return flat.map((v) => (v == null ? null : decode(v)));
    return new Array(count).fill(null);
  }

  function decode(s) {
    return String(s)
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  async function translateBatch(texts, ctx) {
    const key = ctx.settings.providers.google.apiKey;
    return key ? official(texts, ctx) : free(texts, ctx);
  }

  async function test(settings) {
    const out = await translateBatch(['Hello, world.'], { settings, from: 'en', to: settings.targetLang || 'zh-Hans' });
    return out[0] || '';
  }

  BG.providers = BG.providers || {};
  BG.providers.google = { id: 'google', translateBatch, test };
})(typeof globalThis !== 'undefined' ? globalThis : self);
