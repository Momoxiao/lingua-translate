/**
 * Lingua — provider HTTP helpers.
 * Registers onto Lingua.bg.http.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});
  const tr = (zh, key, vars) => (NS.i18n ? NS.i18n.t(zh, key, vars) : zh);

  class ProviderError extends Error {
    constructor(message, { status = 0, code = 'PROVIDER_ERROR', retriable = false, body = '' } = {}) {
      super(message);
      this.name = 'ProviderError';
      this.status = status;
      this.code = code;
      this.retriable = retriable;
      this.body = body;
    }
  }

  /** Read a response body defensively, then throw a typed error on non-2xx. */
  async function assertOk(res, label) {
    if (res.ok) return res;
    let body = '';
    try {
      body = (await res.text()).slice(0, 800);
    } catch (e) {
      /* ignore */
    }
    const retriable = res.status === 429 || res.status >= 500;
    let message = tr(`${label} 请求失败（HTTP ${res.status}）`, 'error.http', {
      label,
      status: res.status,
    });
    if (res.status === 401 || res.status === 403) {
      message = tr(`${label} 鉴权失败（HTTP ${res.status}），请检查 API Key`, 'error.httpAuth', {
        label,
        status: res.status,
      });
    } else if (res.status === 429) {
      message = tr(`${label} 触发限流（HTTP 429），已自动退避重试`, 'error.httpRate', { label });
    } else if (res.status === 404) {
      message = tr(`${label} 接口地址不存在（HTTP 404），请检查 Base URL`, 'error.httpNotFound', { label });
    }
    if (body) message += ` — ${body.replace(/\s+/g, ' ').slice(0, 240)}`;
    throw new ProviderError(message, { status: res.status, code: `HTTP_${res.status}`, retriable, body });
  }

  async function requestJson(url, options, label, timeoutMs = 60000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    const onAbort = () => ctrl.abort(options.signal && options.signal.reason);
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      await assertOk(res, label);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new ProviderError(tr(`${label} 返回了非 JSON 响应`, 'error.badJson', { label }), {
          code: 'BAD_JSON',
          retriable: false,
          body: text.slice(0, 300),
        });
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new ProviderError(tr(`${label} 请求超时或被取消`, 'error.timeout', { label }), {
          code: 'TIMEOUT',
          retriable: err.name === 'TimeoutError',
        });
      }
      throw new ProviderError(
        tr(`${label} 网络错误：${err && err.message}`, 'error.network', {
          label,
          message: err && err.message,
        }),
        { code: 'NETWORK', retriable: true }
      );
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * POST a chat request and consume a Server-Sent-Events stream.
   *
   * `requestJson` cannot expose anything until the whole body is ready. For a
   * long subtitle batch that means the first cue waits for every later cue too.
   * This helper calls `onDelta` as each content fragment arrives; the provider
   * turns complete numbered lines into early results. It still returns the full
   * concatenated text so callers can run the normal alignment/repair parser.
   *
   * Endpoints that ignore `stream: true` and answer with ordinary JSON are
   * handled as a one-shot body.
   */
  async function requestJsonStream(url, options, label, onDelta, timeoutMs = 60000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    const onAbort = () => ctrl.abort(options.signal && options.signal.reason);
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      await assertOk(res, label);
      const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';

      if (!res.body || !/text\/event-stream/i.test(contentType)) {
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch (e) {
          throw new ProviderError(tr(`${label} 返回了非 JSON 响应`, 'error.badJson', { label }), {
            code: 'BAD_JSON',
            retriable: false,
            body: text.slice(0, 300),
          });
        }
        const choice = json && json.choices && json.choices[0];
        const content = (choice && ((choice.message && choice.message.content) || choice.text)) || '';
        if (content && onDelta) onDelta(content);
        return content;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let full = '';
      let done = false;
      while (!done) {
        const part = await reader.read();
        if (part.done) break;
        pending += decoder.decode(part.value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed[0] === ':') continue;
          const m = /^data:\s?(.*)$/.exec(trimmed);
          if (!m) continue;
          if (m[1] === '[DONE]') {
            done = true;
            break;
          }
          let json;
          try {
            json = JSON.parse(m[1]);
          } catch (e) {
            continue;
          }
          const choice = json && json.choices && json.choices[0];
          const delta = (choice && choice.delta && choice.delta.content) || (choice && choice.text) || '';
          if (delta) {
            full += delta;
            if (onDelta) onDelta(delta);
          }
        }
      }
      if (pending) {
        const m = /^data:\s?(.*)$/.exec(pending.trim());
        if (m && m[1] !== '[DONE]') {
          try {
            const json = JSON.parse(m[1]);
            const choice = json && json.choices && json.choices[0];
            const delta = (choice && choice.delta && choice.delta.content) || (choice && choice.text) || '';
            if (delta) {
              full += delta;
              if (onDelta) onDelta(delta);
            }
          } catch (e) {
            /* trailing partial event is not usable */
          }
        }
      }
      return full;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new ProviderError(tr(`${label} 请求超时或被取消`, 'error.timeout', { label }), {
          code: err.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED',
          retriable: err.name === 'TimeoutError',
        });
      }
      throw new ProviderError(
        tr(`${label} 网络错误：${err && err.message}`, 'error.network', {
          label,
          message: err && err.message,
        }),
        { code: 'NETWORK', retriable: true }
      );
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  BG.http = { requestJson, requestJsonStream, assertOk, ProviderError };
})(typeof globalThis !== 'undefined' ? globalThis : self);
