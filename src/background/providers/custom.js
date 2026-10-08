/**
 * Lingua — generic "custom API template" provider.
 * Lets a user wire up ANY HTTP translation endpoint with:
 *   - a URL template
 *   - a method
 *   - a JSON headers template
 *   - a body template
 *   - a response extraction path
 *
 * Placeholders available in the URL / headers / body templates:
 *   {{text}}    batch text as a single JSON-escaped string (numbered lines)
 *   {{texts}}   JSON array literal of the raw lines  -> switches to array mode
 *   {{from}}    source language code   (JSON-escaped)
 *   {{to}}      target language code   (JSON-escaped)
 *   {{source}}  source language name   (JSON-escaped)
 *   {{target}}  target language name   (JSON-escaped)
 *   {{key}}     API key                (JSON-escaped)
 *
 * Registers onto Lingua.bg.providers.custom.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});
  const { requestJson } = BG.http;
  const { buildBatchText, parseBatchResponse } = NS.subtitles;
  const { stripDecoration } = BG.llm;
  const { langName } = BG.prompts;
  const { getPath } = NS.utils;
  const tr = (zh, key, vars) => (NS.i18n ? NS.i18n.t(zh, key, vars) : zh);

  function esc(v) {
    return JSON.stringify(v == null ? '' : String(v)).slice(1, -1); // JSON-escape without quotes
  }

  function substitute(tpl, vars) {
    return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
      const v = vars[name];
      return v == null ? '' : String(v);
    });
  }

  function parseHeaders(raw, vars) {
    const text = substitute(raw || '{}', vars).trim() || '{}';
    try {
      const obj = JSON.parse(text);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
      throw new Error(tr('请求头不是合法 JSON，请检查 Headers 配置', 'error.customHeaders'));
    }
  }

  function asString(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map(asString).filter(Boolean).join(' ');
    if (typeof v === 'object') {
      for (const k of ['text', 'translated', 'translation', 'result', 'target', 'value', 'content', 'tgt']) {
        if (typeof v[k] === 'string') return v[k];
      }
      const first = Object.values(v).find((x) => typeof x === 'string');
      return first || null;
    }
    return null;
  }

  async function translateBatch(texts, ctx) {
    const { settings, from, to, signal } = ctx;
    const cfg = settings.providers.custom;
    if (!cfg.url) throw new Error(tr('未填写自定义接口 URL', 'error.customUrl'));

    const arrayMode = /\{\{\s*texts\s*\}\}/.test(String(cfg.body || '') + String(cfg.url || ''));
    const vars = {
      text: esc(buildBatchText(texts)),
      texts: JSON.stringify(texts),
      from: esc(from === 'auto' ? 'auto' : from),
      to: esc(to),
      source: esc(langName(from)),
      target: esc(langName(to)),
      key: esc(cfg.apiKey || ''),
    };

    const method = (cfg.method || 'POST').toUpperCase();
    const url = substitute(cfg.url, vars);
    const headers = parseHeaders(cfg.headers, vars);

    const options = { method, headers, signal };
    if (method !== 'GET' && method !== 'HEAD' && String(cfg.body || '').trim()) {
      options.body = substitute(cfg.body, vars);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const json = await requestJson(url, options, tr('自定义接口', 'providerLabel.custom'));
    const extracted = cfg.responsePath ? getPath(json, cfg.responsePath) : json;

    // Array response -> index aligned
    if (Array.isArray(extracted)) {
      if (extracted.length === texts.length) return extracted.map(asString);
      if (extracted.length === 1 && texts.length === 1) return [asString(extracted[0])];
      return new Array(texts.length).fill(null);
    }

    const str = asString(extracted);
    if (str == null) return new Array(texts.length).fill(null);

    const clean = stripDecoration(str);
    if (texts.length === 1) return [clean || null];
    if (arrayMode) {
      const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === texts.length) return lines;
    }
    const numbered = parseBatchResponse(clean, texts.length);
    if (numbered.every((x) => !x)) {
      const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === texts.length) return lines;
    }
    return numbered;
  }

  async function test(settings) {
    const out = await translateBatch(['Hello, world.'], { settings, from: 'en', to: settings.targetLang || 'zh-Hans' });
    return out[0] || '';
  }

  BG.providers = BG.providers || {};
  BG.providers.custom = { id: 'custom', translateBatch, test };
})(typeof globalThis !== 'undefined' ? globalThis : self);
