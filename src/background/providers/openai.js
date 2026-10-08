/**
 * Lingua — OpenAI-compatible provider.
 * One implementation covers OpenAI, DeepSeek, Moonshot/Kimi, Zhipu GLM, Qwen
 * (compatible mode), SiliconFlow, OpenRouter, Groq, Together, Ollama, LM Studio,
 * vLLM, and one-api / new-api style gateways.
 * Registers onto Lingua.bg.providers.openai.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});
  const { requestJson, requestJsonStream } = BG.http;
  const { buildBatchText } = NS.subtitles;
  const { parseOutput, createStreamParser } = BG.llm;
  const { systemPrompt, profileSuffix } = BG.prompts;

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
  let streamAccepted = true;

  function postJson(url, headers, body, signal, onDelta) {
    const opts = { method: 'POST', headers, body: JSON.stringify(body), signal };
    if (onDelta) return requestJsonStream(url, opts, 'OpenAI 兼容接口', onDelta);
    return requestJson(url, opts, 'OpenAI 兼容接口');
  }

  async function translateBatch(texts, ctx) {
    const { settings, from, to, signal } = ctx;
    const cfg = settings.providers.openai;
    const url = resolveUrl(cfg.baseUrl);
    // A user-written prompt replaces the built-in rules, so the adaptive profile
    // can only be appended to it. The built-in prompt takes it inline instead,
    // which keeps the output-format contract as the last thing the model reads.
    const custom = cfg.prompt && cfg.prompt.trim();
    const sys = custom
      ? custom + profileSuffix(ctx.profile)
      : systemPrompt(from, to, ctx.kind, ctx.profile);

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
    const onDelta = ctx.onDelta;
    let streamed = null;
    if (onDelta && streamAccepted) {
      streamed = createStreamParser(texts.length, onDelta);
      body.stream = true;
    }
    let json;
    try {
      json = await postJson(
        url,
        headers,
        withHints ? Object.assign({}, body, REASONING_OFF) : body,
        signal,
        streamed ? (delta) => streamed.push(delta) : null
      );
    } catch (err) {
      const rejected = withHints && err && (err.status === 400 || err.status === 422);
      const streamRejected = streamed && err && (err.status === 400 || err.status === 422);
      if (!rejected && !streamRejected) throw err;
      // Some compatible gateways reject either the reasoning hints or
      // `stream: true`. Drop only the feature that failed and retry once; both
      // capabilities are remembered for the rest of the session.
      if (rejected) reasoningHintsAccepted = false;
      if (streamRejected) {
        streamAccepted = false;
        streamed = null;
        body.stream = false;
      }
      json = await postJson(
        url,
        headers,
        reasoningHintsAccepted ? Object.assign({}, body, REASONING_OFF) : body,
        signal,
        streamed ? (delta) => streamed.push(delta) : null
      );
    }

    let content = '';
    if (typeof json === 'string') {
      content = json;
    } else {
      const choice = json && json.choices && json.choices[0];
      const msg = (choice && choice.message) || {};
      content = msg.content || (choice && choice.text) || '';
    }
    if (!content) {
      const err = new Error(
        json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.reasoning_content
          ? '模型只输出了推理过程、没有输出译文。请在设置里确认「模型推理」为关闭，或换用非推理模型'
          : '接口返回为空（检查模型名是否正确）'
      );
      err.retriable = true;
      throw err;
    }
    if (streamed) {
      const out = streamed.finish();
      // A single-line custom endpoint may answer without a "1." prefix. The
      // normal parser accepts that; the incremental one deliberately does not,
      // so fall back to the full raw answer here instead of reporting a miss.
      if (texts.length === 1 && !out[0]) {
        return parseOutput(content, 1);
      }
      return out;
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
