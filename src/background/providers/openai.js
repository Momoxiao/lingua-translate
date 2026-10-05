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

  /**
   * "Don't deliberate, just translate."
   *
   * Reasoning models waste most of their latency thinking about a task that has
   * no ambiguity. Measured on DeepSeek with a 16-line batch:
   *   no hints      3252ms / 544 reasoning tokens
   *   hints below   1193ms /   0 reasoning tokens   (~2.7x faster)
   *
   * Every vendor spells the switch differently, and an unknown field makes some
   * gateways answer HTTP 400 — so we send the two most widely accepted spellings
   * and, if the endpoint rejects them, drop them for the rest of the session
   * rather than breaking translation outright.
   */
  const REASONING_OFF = {
    reasoning_effort: 'none',
    thinking: { type: 'disabled' },
  };
  let reasoningHintsAccepted = true;

  function postJson(url, headers, body, signal) {
    return requestJson(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, 'OpenAI 兼容接口');
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

    const withHints = cfg.reasoning !== 'auto' && reasoningHintsAccepted;
    let json;
    try {
      json = await postJson(url, headers, withHints ? Object.assign({}, body, REASONING_OFF) : body, signal);
    } catch (err) {
      const rejected = withHints && err && (err.status === 400 || err.status === 422);
      if (!rejected) throw err;
      // This endpoint does not understand the hints — retry without them and
      // stop sending them from now on.
      reasoningHintsAccepted = false;
      json = await postJson(url, headers, body, signal);
    }

    const choice = json && json.choices && json.choices[0];
    const msg = (choice && choice.message) || {};
    const content = msg.content || '';
    if (!content) {
      const err = new Error(
        msg.reasoning_content
          ? '模型只输出了推理过程、没有输出译文。请在设置里确认「模型推理」为关闭，或换用非推理模型'
          : '接口返回为空（检查模型名是否正确）'
      );
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
