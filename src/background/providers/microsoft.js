/**
 * Lingua — Microsoft Azure Translator provider.
 * Registers onto YTST.bg.providers.microsoft.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});
  const BG = (NS.bg = NS.bg || {});
  const { requestJson } = BG.http;
  const { ENGINE_LANG } = NS.constants;

  async function translateBatch(texts, ctx) {
    const { settings, from, to, signal } = ctx;
    const cfg = settings.providers.microsoft;
    const base = (cfg.baseUrl || 'https://api.cognitive.microsofttranslator.com/translate').replace(/\/+$/, '');
    const url = new URL(base);
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('to', ENGINE_LANG.microsoft[to] || to);
    if (from && from !== 'auto') url.searchParams.set('from', from);

    const headers = {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': cfg.apiKey || '',
    };
    if (cfg.region) headers['Ocp-Apim-Subscription-Region'] = cfg.region;

    const body = texts.map((t) => ({ Text: t }));
    const json = await requestJson(
      url.toString(),
      { method: 'POST', headers, body: JSON.stringify(body), signal },
      '微软翻译'
    );
    if (!Array.isArray(json)) return new Array(texts.length).fill(null);
    return texts.map((_, i) => {
      const item = json[i];
      return (item && item.translations && item.translations[0] && item.translations[0].text) || null;
    });
  }

  async function test(settings) {
    const out = await translateBatch(['Hello, world.'], { settings, from: 'en', to: settings.targetLang || 'zh-Hans' });
    return out[0] || '';
  }

  BG.providers = BG.providers || {};
  BG.providers.microsoft = { id: 'microsoft', translateBatch, test };
})(typeof globalThis !== 'undefined' ? globalThis : self);
