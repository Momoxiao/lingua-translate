/**
 * Lingua — OpenAI-compatible provider.
 * One implementation covers OpenAI, DeepSeek, Moonshot/Kimi, Zhipu GLM, Qwen
 * (compatible mode), SiliconFlow, OpenRouter, Groq, Together, Ollama, LM Studio,
 * vLLM, and one-api / new-api style gateways.
 * Registers onto YTST.bg.providers.openai.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});
  const BG = (NS.bg = NS.bg || {});
  const { requestJson } = BG.http;
  const { buildBatchText } = NS.subtitles;
  const { parseOutput } = BG.llm;
  const { systemPrompt } = BG.prompts;

  function resolveUrl(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('未填写 Base URL');
    if (/\/chat\/completions$/.test(base)) return base;
    return `${base}/chat/completions`;
  }

  async function translateBatch(texts, ctx) {
    const { settings, from, to, signal } = ctx;
    const cfg = settings.providers.openai;
    const url = resolveUrl(cfg.baseUrl);
    const sys = (cfg.prompt && cfg.prompt.trim()) || systemPrompt(from, to, ctx.kind);

    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

    const body = {
      model: cfg.model,
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0,
      stream: false,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: buildBatchText(texts) },
      ],
    };

    const json = await requestJson(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, 'OpenAI 兼容接口');
    const content =
      (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    if (!content) {
      const err = new Error('接口返回为空（检查模型名是否正确）');
      err.retriable = true;
      throw err;
    }
    return parseOutput(content, texts.length);
  }

  async function test(settings) {
    const out = await translateBatch(['Hello, world.'], {
      settings,
      from: 'en',
      to: settings.targetLang || 'zh-Hans',
    });
    return out[0] || '';
  }

  BG.providers = BG.providers || {};
  BG.providers.openai = { id: 'openai', translateBatch, test };
})(typeof globalThis !== 'undefined' ? globalThis : self);
