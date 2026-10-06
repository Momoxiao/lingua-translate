/**
 * Lingua — watch the caption requests a page makes.
 *
 * Two harnesses need this: `smoke-youtube.mjs` (a throwaway profile) and
 * `inspect-live.mjs` (your own signed-in browser). The count alone is
 * worthless — the attribution is the whole point, because the causes of a
 * zero-cue result need opposite fixes:
 *   0 requests              nothing ever asked — look at the environment
 *   extension only, no pot  YouTube refused us; the token was never available
 *   page requests too       the player did ask; compare its status codes
 *   refused with a code     the endpoint itself is unhappy
 *
 * ---------------------------------------------------------------------------
 * On attribution, honestly
 * ---------------------------------------------------------------------------
 * This used to claim attribution as settled fact from `fmt=json3`, on the
 * reasoning that only `inject.js` forces that format. That reasoning is wrong,
 * and wrong in a way that matters: `inject.js` builds its URL *from the
 * player's own `baseUrl`*, so the extension's request and the player's can be
 * byte-identical. A caption request carrying `fmt=json3` is therefore NOT
 * evidence that we sent it.
 *
 * So prefer the evidence that actually identifies the caller — CDP's
 * `initiator.stack`, which names the script that made the request — and when
 * there is none, say "unknown" instead of guessing. A diagnostic that quietly
 * guesses is worse than one that admits a gap, because the guess gets quoted as
 * a fact. (It was: this file's own heuristic ended up in a README as "the count
 * is a fact, not a guess".)
 */
export function watchCaptionRequests(cdp, sessionId) {
  const byRequestId = new Map();
  const seen = [];
  let bodyCaptured = false;

  cdp.onEvent((ev) => {
    if (ev.sessionId !== sessionId) return;
    const p = ev.params || {};
    if (ev.method === 'Network.requestWillBeSent' && /\/api\/timedtext/.test(p.request?.url || '')) {
      const init = p.initiator || {};
      const frame = (init.stack && init.stack.callFrames && init.stack.callFrames[0]) || null;
      const entry = {
        url: p.request.url,
        status: null,
        wireBytes: null,
        body: null,
        failed: '',
        // Authoritative when present: the script that issued the request.
        initiatorUrl: (frame && frame.url) || '',
        initiatorType: init.type || '',
      };
      byRequestId.set(p.requestId, entry);
      seen.push(entry);
    }
    if (ev.method === 'Network.responseReceived' && byRequestId.has(p.requestId)) {
      byRequestId.get(p.requestId).status = p.response?.status ?? null;
    }
    // `encodedDataLength` — deliberately named `wireBytes` and NOT `bytes`,
    // because it counts headers too, not the response body. Reading it as "the
    // response was 55 bytes, so it had content" is how this file's author
    // produced a third wrong diagnosis in a row: the bodies were 0 bytes and the
    // 16–248 figure was the header overhead. If you need the body, read the
    // body (`body()` below, or capture it on the way in).
    if (ev.method === 'Network.loadingFinished' && byRequestId.has(p.requestId)) {
      const entry = byRequestId.get(p.requestId);
      entry.wireBytes = p.encodedDataLength ?? null;
      if (!bodyCaptured && entry.wireBytes > 0) {
        bodyCaptured = true;
        cdp
          .send('Network.getResponseBody', { requestId: p.requestId }, sessionId)
          .then((r) => {
            const body = r && (r.body || '');
            entry.body = r && r.base64Encoded ? '(base64)' : body.slice(0, 240);
          })
          .catch((e) => {
            entry.body = `(读不到: ${e.message})`;
          });
      }
    }
    if (ev.method === 'Network.loadingFailed' && byRequestId.has(p.requestId)) {
      byRequestId.get(p.requestId).failed = p.errorText || 'failed';
    }
  });

  /**
   * 'extension' | 'page' | 'unknown'.
   *
   * `chrome-extension://` in the initiating frame means a content script sent
   * it; any other named frame means the page did. No frame at all is common —
   * the player's caption load can originate below JS — and that is 'unknown',
   * which is the honest answer rather than the convenient one.
   */
  function sourceOf(r) {
    if (/^chrome-extension:\/\//.test(r.initiatorUrl)) return 'extension';
    if (r.initiatorUrl) return 'page';
    return 'unknown';
  }

  return {
    get all() {
      return seen;
    },
    /** Per-side counts. `unknown` is reported, not folded into either side. */
    counts() {
      const out = {
        extension: 0,
        page: 0,
        unknown: 0,
        total: seen.length,
        withPot: 0,
        finished: 0,
      };
      for (const r of seen) {
        out[sourceOf(r)]++;
        if (/[?&]pot=/.test(r.url)) out.withPot++;
        if (typeof r.wireBytes === 'number') out.finished++;
      }
      return out;
    },
    /** One line per request, for the report. */
    describe() {
      if (!seen.length) return '0（一次都没请求过 /api/timedtext）';
      const mark = { extension: '扩展', page: '页面', unknown: '来源未知' };
      return seen
        .map((r) => {
          const pot = /[?&]pot=/.test(r.url) ? 'pot=有' : 'pot=无';
          const state = r.failed ? r.failed : r.status === null ? 'pending' : `HTTP ${r.status}`;
          // Labelled 'wire' so nobody reads it as the body size again.
          const wire = typeof r.wireBytes === 'number' ? `wire ${r.wireBytes}B` : '未完成';
          return `${mark[sourceOf(r)]} ${pot} ${state} ${wire}`;
        })
        .join(' · ');
    },
    /** The params that matter, for one sample request. */
    sample() {
      const r = seen[0];
      if (!r) return '';
      try {
        const u = new URL(r.url);
        const keep = ['lang', 'tlang', 'fmt', 'c', 'pot', 'potc', 'kind', 'v'];
        return keep
          .filter((k) => u.searchParams.has(k))
          .map((k) => `${k}=${u.searchParams.get(k)}`)
          .join(' ');
      } catch (e) {
        return '';
      }
    },
    /** The initiating script of each request — what attribution actually rests on. */
    initiators() {
      return seen.map((r) => r.initiatorUrl || `(无 · type=${r.initiatorType || '?'})`);
    },
    /**
     * The first response body we could actually read, or null.
     *
     * `Network.getResponseBody` is the obvious way to get it and it does not
     * work reliably here, so null is a normal outcome — it means "not measured",
     * and the caller must say so out loud instead of substituting a proxy.
     * The smoke test installs its own capture on the way in for this reason.
     */
    payload() {
      const r = seen.find((x) => typeof x.body === 'string' && x.body && x.body.charAt(0) !== '(');
      if (!r) return null;
      return { wireBytes: r.wireBytes, text: r.body };
    },
  };
}
