/**
 * Lingua — MAIN-world interceptor (runs at document_start, page context).
 *
 * WHY THIS EXISTS
 * ---------------
 * Since 2025 YouTube signs caption (`/api/timedtext`) requests with a
 * Proof-of-Origin token (PoToken) minted by BotGuard and bound to the video id.
 * Requesting a caption track from a plain extension fetch therefore returns an
 * empty HTTP 200.
 *
 * A browser extension has one big advantage: it runs *inside* the page that
 * already solved the challenge. So instead of minting our own token we
 *   1. sniff the caption/player responses the player itself requests, and
 *   2. re-issue caption fetches through the page's own `fetch`, so cookies,
 *      Origin, `visitorData` and any token the player already attached apply.
 *
 * This file only talks to the isolated world through window.postMessage — it has
 * no access to chrome.* APIs.
 */
(function () {
  'use strict';

  const SRC = 'lingua-bridge';
  const TAG = 'Lingua';
  const seenUrls = new Set();

  const isTimedText = (url) => typeof url === 'string' && /\/api\/timedtext/.test(url);
  const isPlayer = (url) => typeof url === 'string' && /\/youtubei\/v1\/player/.test(url);
  const isTranscript = (url) => typeof url === 'string' && /\/youtubei\/v1\/get_transcript/.test(url);

  function post(type, data) {
    try {
      window.postMessage({ source: SRC, type, ...data }, window.location.origin);
    } catch (e) {
      /* structured clone failure — ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Sniff the player's own caption requests
  // ---------------------------------------------------------------------------
  function handleTimedText(url, body) {
    if (!body) return;
    const key = url.slice(0, 160);
    if (seenUrls.has(key)) return;
    seenUrls.add(key);
    if (seenUrls.size > 60) seenUrls.clear();
    post('bridge:caption-response', { url, body: String(body) });
  }

  function handlePlayerJson(json) {
    if (!json || typeof json !== 'object') return;
    const info = extractTracks(json);
    if (!info) return;
    post('bridge:player-response', {
      tracks: info.tracks,
      defaultIndex: info.defaultIndex,
      videoId: (json.videoDetails && json.videoDetails.videoId) || '',
    });
  }

  /**
   * @returns {{tracks: Array, defaultIndex: number}|null}
   * `defaultIndex` is the caption track YouTube pairs with the audio — i.e. the
   * video's ORIGINAL language. Using it beats guessing: on one test video the
   * "manual" zh-Hant track only carried the first 34s of a 336s video, while the
   * default en/asr track covered the whole thing.
   */
  function extractTracks(playerResponse) {
    const r = playerResponse && playerResponse.captions && playerResponse.captions.playerCaptionsTracklistRenderer;
    if (!r || !Array.isArray(r.captionTracks)) return null;
    const tracks = r.captionTracks.map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode,
      kind: t.kind || '',
      isTranslatable: t.isTranslatable !== false,
      vssId: t.vssId || '',
    }));
    if (!tracks.length) return null;
    let defaultIndex = -1;
    const audio = r.audioTracks;
    if (Array.isArray(audio)) {
      for (const a of audio) {
        if (a && typeof a.defaultCaptionTrackIndex === 'number' && a.defaultCaptionTrackIndex >= 0) {
          defaultIndex = a.defaultCaptionTrackIndex;
          break;
        }
      }
    }
    return { tracks, defaultIndex };
  }

  // ---------------------------------------------------------------------------
  // Patch fetch
  // ---------------------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      const p = nativeFetch.apply(this, arguments);
      try {
        if (isTimedText(url) || isPlayer(url) || isTranscript(url)) {
          p.then((res) => {
            try {
              res
                .clone()
                .text()
                .then((body) => {
                  if (isTimedText(url)) handleTimedText(url, body);
                  else if (isPlayer(url)) handlePlayerJson(safeJson(body));
                  else if (isTranscript(url)) post('bridge:player-response', { transcript: safeJson(body) });
                })
                .catch(() => {});
            } catch (e) {
              /* ignore */
            }
          }).catch(() => {});
        }
      } catch (e) {
        /* ignore */
      }
      return p;
    };
  }

  // ---------------------------------------------------------------------------
  // Patch XMLHttpRequest (YouTube still uses it for some caption calls)
  // ---------------------------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        this.__linguaUrl = url;
      } catch (e) {
        /* ignore */
      }
      return open.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      const url = this.__linguaUrl;
      if (url && (isTimedText(url) || isPlayer(url) || isTranscript(url))) {
        const onDone = () => {
          try {
            let body = null;
            if (this.responseType === '' || this.responseType === 'text') body = this.responseText;
            else if (this.responseType === 'json') body = JSON.stringify(this.response);
            if (!body) return;
            if (isTimedText(url)) handleTimedText(url, body);
            else if (isPlayer(url)) handlePlayerJson(safeJson(body));
            else post('bridge:player-response', { transcript: safeJson(body) });
          } catch (e) {
            /* ignore */
          }
        };
        this.addEventListener('load', onDone);
        this.addEventListener('loadend', onDone);
      }
      return send.apply(this, arguments);
    };
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Serve caption fetches on behalf of the isolated world (page context)
  // ---------------------------------------------------------------------------
  function withJson3(url) {
    try {
      const u = new URL(url, location.origin);
      u.searchParams.set('fmt', 'json3');
      if (!u.searchParams.has('c')) u.searchParams.set('c', 'WEB');
      return u.toString();
    } catch (e) {
      return url + (url.includes('?') ? '&' : '?') + 'fmt=json3&c=WEB';
    }
  }

  async function fetchTrack(url, requestId) {
    const attempt = async (target) => {
      try {
        const res = await nativeFetch.call(window, target, {
          credentials: 'include',
          headers: { 'Accept': '*/*' },
        });
        const body = await res.text();
        return { status: res.status, body };
      } catch (e) {
        return { status: 0, body: '', error: String(e && e.message) };
      }
    };

    // Pass 1: the URL exactly as the player handed it to us, forced to json3.
    let out = await attempt(withJson3(url));
    if (out.body && out.body.length > 4) {
      post('bridge:fetch-result', { requestId, ...out });
      return;
    }

    // Pass 2: drop our `c=WEB` and try the pristine baseUrl.
    const plain = (() => {
      try {
        const u = new URL(url, location.origin);
        u.searchParams.set('fmt', 'json3');
        u.searchParams.delete('c');
        return u.toString();
      } catch (e) {
        return url;
      }
    })();
    if (plain !== withJson3(url)) {
      out = await attempt(plain);
      if (out.body && out.body.length > 4) {
        post('bridge:fetch-result', { requestId, ...out });
        return;
      }
    }

    post('bridge:fetch-result', { requestId, ...out, empty: true });
  }

  // ---------------------------------------------------------------------------
  // 3. Read the player response out of the page (covers the initial HTML load)
  // ---------------------------------------------------------------------------
  function probePlayer() {
    let info = null;
    let videoId = '';
    try {
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.getPlayerResponse === 'function') {
        const pr = mp.getPlayerResponse();
        info = extractTracks(pr);
        videoId = (pr && pr.videoDetails && pr.videoDetails.videoId) || '';
      }
    } catch (e) {
      /* ignore */
    }
    if (!info) {
      try {
        const pr = window.ytInitialPlayerResponse;
        info = extractTracks(pr);
        videoId = (pr && pr.videoDetails && pr.videoDetails.videoId) || '';
      } catch (e) {
        /* ignore */
      }
    }
    if (info) post('bridge:player-response', { tracks: info.tracks, defaultIndex: info.defaultIndex, videoId, fromProbe: true });
    else post('bridge:probe-result', { videoId });
  }

  // ---------------------------------------------------------------------------
  // Message channel with the isolated world
  // ---------------------------------------------------------------------------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== SRC) return;
    if (d.type === 'bridge:probe') probePlayer();
    else if (d.type === 'bridge:fetch-track') fetchTrack(d.url, d.requestId);
  });

  // Announce ourselves and probe a few times while the page boots.
  post('bridge:ready', {});
  let ticks = 0;
  const timer = setInterval(() => {
    probePlayer();
    if (++ticks > 12) clearInterval(timer);
  }, 700);
  window.addEventListener('DOMContentLoaded', () => probePlayer());
  window.addEventListener('yt-navigate-finish', () => setTimeout(probePlayer, 300));
  window.addEventListener('yt-page-data-updated', () => setTimeout(probePlayer, 300));
})();
