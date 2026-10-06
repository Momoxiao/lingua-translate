/**
 * Lingua — watch the caption requests a page makes.
 *
 * Two harnesses need this: `smoke-youtube.mjs` (a throwaway profile) and
 * `inspect-live.mjs` (your own signed-in browser). It used to be inlined in one
 * of them, and the reason it is worth sharing is the same reason
 * scripts/lib/chrome.mjs exists: the count alone is worthless, the attribution
 * is the whole point.
 *
 * A zero-cue result has several causes that need opposite fixes, and only the
 * request log can tell them apart:
 *   0 requests            the player never asked — look at the environment
 *   ours, no pot, 200     YouTube refused us; this is the PoToken path
 *   theirs, no pot, 200   even the player gets nothing; no pot exists to reuse
 *   refused with a code   the endpoint itself is unhappy
 *
 * Attributed by `fmt=json3`, which only `inject.js`'s `fetchTrack` forces — the
 * player asks for its own format.
 */
export function watchCaptionRequests(cdp, sessionId) {
  const byRequestId = new Map();
  const seen = [];

  cdp.onEvent((ev) => {
    if (ev.sessionId !== sessionId) return;
    const p = ev.params || {};
    if (ev.method === 'Network.requestWillBeSent' && /\/api\/timedtext/.test(p.request?.url || '')) {
      const entry = { url: p.request.url, status: null, failed: '' };
      byRequestId.set(p.requestId, entry);
      seen.push(entry);
    }
    if (ev.method === 'Network.responseReceived' && byRequestId.has(p.requestId)) {
      byRequestId.get(p.requestId).status = p.response?.status ?? null;
    }
    if (ev.method === 'Network.loadingFailed' && byRequestId.has(p.requestId)) {
      byRequestId.get(p.requestId).failed = p.errorText || 'failed';
    }
  });

  return {
    get all() {
      return seen;
    },
    /** How many came from each side. The split is the whole point. */
    counts() {
      let ours = 0;
      let theirs = 0;
      for (const r of seen) (/[?&]fmt=json3/.test(r.url) ? ours++ : theirs++);
      const potty = seen.filter((r) => /[?&]pot=/.test(r.url)).length;
      return { ours, theirs, potty, total: seen.length };
    },
    /** One line per request, for the report. */
    describe() {
      if (!seen.length) return '0（一次都没请求过 /api/timedtext）';
      return seen
        .map((r) => {
          const pot = /[?&]pot=/.test(r.url) ? 'pot=有' : 'pot=无';
          const who = /[?&]fmt=json3/.test(r.url) ? '扩展' : '播放器';
          const state = r.failed ? r.failed : r.status === null ? 'pending' : `HTTP ${r.status}`;
          return `${who} ${pot} ${state}`;
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
  };
}
