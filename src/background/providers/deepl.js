/**
 * Lingua — DeepL provider (Free / Pro).
 * Registers onto Lingua.bg.providers.deepl.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});
  const { requestJson } = BG.http;
  const { ENGINE_LANG } = NS.constants;
  const tr = (zh, key, vars) => (NS.i18n ? NS.i18n.t(zh, key, vars) : zh);

  const MAX_TEXTS = 45; // DeepL hard limit is 50; stay under it

  async function translateBatch(texts, ctx) {
    const { settings, from, to, signal } = ctx;
    const cfg = settings.providers.deepl;
    const target = ENGINE_LANG.deepl[to] || String(to).toUpperCase();
    const url = (cfg.baseUrl || '').trim() || (cfg.pro && cfg.pro !== 'false'
      ? 'https://api.deepl.com/v2/translate'
      : 'https://api-free.deepl.com/v2/translate');

    const body = {
      text: texts,
      target_lang: target,
      preserve_formatting: true,
      split_sentences: 'nonewlines', // keep our line structure intact
    };
    if (from && from !== 'auto') body.source_lang = ENGINE_LANG.deepl[from] || String(from).toUpperCase();

    const json = await requestJson(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `DeepL-Auth-Key ${cfg.apiKey || ''}`,
        },
        body: JSON.stringify(body),
        signal,
      },
      tr('DeepL', 'provider.deepl.label')
    );

    const list = (json && json.translations) || [];
    return texts.map((_, i) => (list[i] && list[i].text) || null);
  }

  async function test(settings) {
    const out = await translateBatch(['Hello, world.'], { settings, from: 'en', to: settings.targetLang || 'zh-Hans' });
    return out[0] || '';
  }

  BG.providers = BG.providers || {};
  BG.providers.deepl = { id: 'deepl', translateBatch, test, maxTexts: MAX_TEXTS };
})(typeof globalThis !== 'undefined' ? globalThis : self);
