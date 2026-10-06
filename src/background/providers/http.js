/**
 * Lingua — provider HTTP helpers.
 * Registers onto Lingua.bg.http.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});

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
    let message = `${label} 请求失败（HTTP ${res.status}）`;
    if (res.status === 401 || res.status === 403) message = `${label} 鉴权失败（HTTP ${res.status}），请检查 API Key`;
    else if (res.status === 429) message = `${label} 触发限流（HTTP 429），已自动退避重试`;
    else if (res.status === 404) message = `${label} 接口地址不存在（HTTP 404），请检查 Base URL`;
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
        throw new ProviderError(`${label} 返回了非 JSON 响应`, { code: 'BAD_JSON', retriable: false, body: text.slice(0, 300) });
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new ProviderError(`${label} 请求超时或被取消`, { code: 'TIMEOUT', retriable: err.name === 'TimeoutError' });
      }
      throw new ProviderError(`${label} 网络错误：${err && err.message}`, { code: 'NETWORK', retriable: true });
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  BG.http = { requestJson, assertOk, ProviderError };
})(typeof globalThis !== 'undefined' ? globalThis : self);
