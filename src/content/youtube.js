/**
 * Lingua — YouTube pipeline (isolated world).
 * Owns: track discovery -> cue extraction (with PoToken-aware fallbacks) ->
 * priority-ordered translation scheduling -> store updates.
 * Registers onto Lingua.youtube.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const { store, bridge, overlay, subtitles } = NS;
  const { clamp } = NS.utils;
  const tr = (zh, key, vars) => (NS.i18n ? NS.i18n.t(zh, key, vars) : zh);

  let settings = null;
  let generation = 0;
  let inflight = new Set();
  let pumpTimer = 0;
  let tracksWaiters = [];
  let latestTracks = [];
  let latestDefaultIndex = -1;
  let lastVideoId = '';
  let captionSniffers = new Set();
  let transcriptSniffers = new Set();
  let started = false;

  // ---------------------------------------------------------------------------
  // Track discovery
  // ---------------------------------------------------------------------------
  function videoIdFromUrl() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v') || '';
      const m = u.pathname.match(/^\/(?:embed|live|shorts)\/([^/?#]+)/);
      if (m) return m[1];
    } catch (e) {
      /* ignore */
    }
    return '';
  }

  function pushTracks(tracks, videoId, defaultIndex) {
    latestTracks = tracks || [];
    if (typeof defaultIndex === 'number' && defaultIndex >= 0) latestDefaultIndex = defaultIndex;
    if (videoId) lastVideoId = videoId;
    const waiters = tracksWaiters;
    tracksWaiters = [];
    for (const w of waiters) w(latestTracks);
  }

  function waitForTracks(timeoutMs = 8000) {
    if (latestTracks.length) return Promise.resolve(latestTracks);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(latestTracks), timeoutMs);
      tracksWaiters.push((t) => {
        clearTimeout(timer);
        resolve(t);
      });
    });
  }

  function pickTrack(tracks, sourceLang, defaultIndex) {
    if (!tracks.length) return null;

    // An explicit source language always wins.
    if (sourceLang && sourceLang !== 'auto') {
      const exact = tracks.find((t) => t.languageCode === sourceLang);
      if (exact) return exact;
      const want = subtitles.normalizeLang(sourceLang);
      const loose = tracks.find((t) => subtitles.normalizeLang(t.languageCode) === want);
      if (loose) return loose;
    }

    // The track YouTube pairs with the audio is the video's original language —
    // the only track guaranteed to cover the whole video. Picking a random
    // "manual" track instead can yield a partial or translated track.
    if (typeof defaultIndex === 'number' && defaultIndex >= 0 && tracks[defaultIndex]) {
      return tracks[defaultIndex];
    }

    // No default index available: prefer human-authored captions over ASR.
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const pool = manual.length ? manual : tracks;
    return pool.find((t) => /^(en|zh)/.test(t.languageCode)) || pool[0];
  }

  // ---------------------------------------------------------------------------
  // Cue extraction with fallbacks
  // ---------------------------------------------------------------------------
  // Caption acquisition
  //
  // Since 2025 YouTube signs /api/timedtext with a Proof-of-Origin token. The
  // baseUrl handed to us in ytInitialPlayerResponse carries NO `pot`, so fetching
  // it returns HTTP 200 with an empty body. The player, however, mints a `pot`
  // that is bound to the video+session (not to a specific track — verified: every
  // track request uses the same value), so we can:
  //   1. fetch with the plain baseUrl (works on videos that still allow it)
  //   2. reuse a `pot` we already sniffed from the player
  //   3. force a fresh player request, sniff its `pot`, and reuse it
  //   4. fall back to whatever track the player happened to fetch
  // ---------------------------------------------------------------------------

  /**
   * Last /api/timedtext URL the player itself requested.
   *
   * The token is bound to the video id, so keeping a bare URL across SPA
   * navigation made the next video spend one guaranteed-failing request on the
   * previous video's pot. Store the id with it and only reuse on a match.
   */
  let signedTemplate = null; // { videoId, url }

  /** Extract the reusable token params from a player-issued caption URL. */
  function potParamsFrom(url) {
    if (!url) return null;
    try {
      const u = new URL(url, location.origin);
      const pot = u.searchParams.get('pot');
      if (!pot) return null;
      return { pot, potc: u.searchParams.get('potc') || '1', c: u.searchParams.get('c') || 'WEB', fmt: 'json3' };
    } catch (e) {
      return null;
    }
  }

  /** Merge params into a caption URL without dropping its signature. */
  function withParams(baseUrl, params) {
    try {
      const u = new URL(baseUrl, location.origin);
      for (const k of Object.keys(params)) {
        if (params[k] != null) u.searchParams.set(k, params[k]);
      }
      return u.toString();
    } catch (e) {
      return baseUrl;
    }
  }

  function currentVideoId() {
    try {
      return videoIdFromUrl();
    } catch (e) {
      return '';
    }
  }

  function rememberSignedTemplate(url) {
    const videoId = currentVideoId();
    signedTemplate = url && videoId ? { videoId, url } : null;
  }

  function signedTemplateFor(videoId) {
    if (!signedTemplate || !videoId) return '';
    return signedTemplate.videoId === videoId ? signedTemplate.url : '';
  }

  function langOf(url) {
    try {
      return new URL(url, location.origin).searchParams.get('lang') || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Fetch a caption track and parse it, keeping the response shape.
   *
   * Returning bare cues threw away the one fact that separates two very
   * different failures: an empty body (the PoToken case — nothing came back) and
   * a non-empty body we could not parse (a format gap — the data was there and
   * we dropped it). Both surfaced as `cues.length === 0`, so the diagnostics
   * page could only ever report the first, and a format gap looked like a
   * network problem forever.
   */
  async function tryFetch(url) {
    const res = await bridge.fetchTrack(url);
    const body = (res && res.body) || '';
    return { cues: subtitles.parseTimedText(body), bytes: body.length };
  }

  function waitForWireCaptions(timeoutMs = 9000) {
    return new Promise((resolve) => {
      let settled = false;
      // The largest body the player fetched, even when we cannot parse it. This
      // is the only place that sees the player's own response: if the player got
      // 4 KB and our parser read none of it, the failure is ours, but without
      // recording the size the caller counts only its own (empty) responses and
      // reports the PoToken timing race instead. Same wrong-layer bug as the
      // direct path, one layer further in.
      let wireBytes = 0;
      const done = (payload) => {
        if (settled) return;
        settled = true;
        captionSniffers.delete(onCaption);
        transcriptSniffers.delete(onTranscript);
        clearTimeout(timer);
        resolve({ wireBytes, ...payload });
      };
      const onCaption = ({ body, url }) => {
        const text = body || '';
        if (text.length > wireBytes) wireBytes = text.length;
        const cues = subtitles.parseTimedText(text);
        if (cues.length) done({ cues, url: url || null });
      };
      const onTranscript = (json) => {
        const cues = parseTranscript(json);
        if (cues.length) done({ cues, url: null });
      };
      captionSniffers.add(onCaption);
      transcriptSniffers.add(onTranscript);
      const timer = setTimeout(() => done({ cues: [], url: null }), timeoutMs);
    });
  }

  /**
   * Make the player issue a caption request we can sniff. If captions are
   * already on, the player will not re-request anything, so we cycle the toggle
   * (invisible to the user — the native captions are hidden by our CSS) and, when
   * possible, ask the player to select the exact track we want.
   */
  function forceCaptionRequest(track) {
    try {
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.getOption === 'function' && typeof mp.setOption === 'function' && track) {
        const list = mp.getOption('captions', 'tracklist') || [];
        const want = list.find(
          (t) => t && t.languageCode === track.languageCode && (t.kind || '') === (track.kind || '')
        ) || list.find((t) => t && t.languageCode === track.languageCode);
        if (want) mp.setOption('captions', 'track', want);
      }
    } catch (e) {
      /* the API is not always available */
    }

    try {
      const btn = document.querySelector('.ytp-subtitles-button');
      if (!btn) return;
      if (btn.getAttribute('aria-pressed') === 'true') {
        btn.click(); // off
        setTimeout(() => {
          try {
            btn.click(); // back on -> fresh /api/timedtext request
          } catch (e) {
            /* ignore */
          }
        }, 300);
      } else {
        btn.click(); // on
      }
    } catch (e) {
      /* ignore */
    }
  }

  /** Parse a /youtubei/v1/get_transcript response into cues. */
  function parseTranscript(json) {
    try {
      const actions = (json && json.actions) || [];
      for (const a of actions) {
        const segs =
          a &&
          a.updateEngagementPanelAction &&
          a.updateEngagementPanelAction.content &&
          a.updateEngagementPanelAction.content.transcriptRenderer &&
          a.updateEngagementPanelAction.content.transcriptRenderer.body &&
          a.updateEngagementPanelAction.content.transcriptRenderer.body.transcriptSearchPanelRenderer &&
          a.updateEngagementPanelAction.content.transcriptRenderer.body.transcriptSearchPanelRenderer.body &&
          a.updateEngagementPanelAction.content.transcriptRenderer.body.transcriptSearchPanelRenderer.body
            .transcriptSegmentListRenderer &&
          a.updateEngagementPanelAction.content.transcriptRenderer.body.transcriptSearchPanelRenderer.body
            .transcriptSegmentListRenderer.initialSegments;
        if (!Array.isArray(segs)) continue;
        const cues = [];
        for (const s of segs) {
          const r = s && s.transcriptSegmentRenderer;
          if (!r) continue;
          const text = ((r.snippet && r.snippet.runs) || []).map((x) => x.text || '').join('');
          const start = (r.startMs || 0) / 1000;
          const end = (r.endMs || 0) / 1000;
          if (text.trim()) cues.push({ start, end: end || start + 2, text: subtitles.cleanText(text) });
        }
        if (cues.length) return subtitles.dedupe(cues);
      }
    } catch (e) {
      /* ignore */
    }
    return [];
  }

  async function extractCues(track) {
    const videoId = currentVideoId();
    const wirePromise = waitForWireCaptions(10000);
    forceCaptionRequest(track);

    // Track the largest body any attempt returned. A non-empty body that yields
    // no cues means the format defeated us, which is a bug on our side and needs
    // different advice from "the server sent nothing back".
    let maxBytes = 0;

    const attempts = [];
    const record = (promise, source) =>
      promise.then((result) => {
        maxBytes = Math.max(maxBytes, (result && result.bytes) || 0);
        return { ...result, source };
      });

    attempts.push(record(tryFetch(track.baseUrl), 'direct'));

    // Send all independent requests at once. On a cold load the plain baseUrl is
    // usually empty and the player-fetch path takes one round trip; racing them
    // means that path is no longer serialised behind the guaranteed-empty one.
    const prior = potParamsFrom(signedTemplateFor(videoId));
    if (prior) {
      attempts.push(record(tryFetch(withParams(track.baseUrl, prior)), 'pot-reuse'));
    }

    const wireAttempt = wirePromise.then((sniffed) => {
      maxBytes = Math.max(maxBytes, (sniffed && sniffed.wireBytes) || 0);
      return { cues: (sniffed && sniffed.cues) || [], sniffed, source: 'sniffed' };
    });
    attempts.push(wireAttempt);

    const valid = (p) => p.then((r) => (r && r.cues && r.cues.length ? r : Promise.reject(new Error('empty'))));
    const sources = attempts.map(valid);
    const winner = await Promise.any(sources).catch(() => null);
    if (winner && winner.cues && winner.cues.length) {
      if (winner.source === 'sniffed') {
        if (winner.sniffed && winner.sniffed.url) rememberSignedTemplate(winner.sniffed.url);
        const got = langOf((winner.sniffed && winner.sniffed.url) || '');
        return {
          cues: winner.cues,
          source: 'sniffed',
          sniffedLang: got,
          langMismatch: !!got && got !== track.languageCode,
        };
      }
      return { cues: winner.cues, source: winner.source };
    }

    const results = await Promise.all(
      attempts.map((p) =>
        p.catch((error) => ({ cues: [], bytes: 0, source: 'unknown', error }))
      )
    );
    const settled = results.map((r) => (r && typeof r === 'object' ? r : { cues: [], bytes: 0 }));
    const sniffedResult = settled.find((r) => r.source === 'sniffed');
    const sniffed = (sniffedResult && sniffedResult.sniffed) || { cues: [], url: null };
    if (sniffed.url) rememberSignedTemplate(sniffed.url);
    maxBytes = Math.max(maxBytes, (sniffed && sniffed.wireBytes) || 0);

    const signed = potParamsFrom(sniffed.url);
    if (signed) {
      const fresh = await tryFetch(withParams(track.baseUrl, signed));
      maxBytes = Math.max(maxBytes, fresh.bytes || 0);
      if (fresh.cues.length) return { cues: fresh.cues, source: 'pot-fresh' };
    }

    // 4. last resort: use whatever track the player fetched for itself
    if (sniffed.cues.length) {
      const got = langOf(sniffed.url || '');
      return { cues: sniffed.cues, source: 'sniffed', sniffedLang: got, langMismatch: !!got && got !== track.languageCode };
    }

    return { cues: [], source: 'none', bytes: maxBytes };
  }

  // ---------------------------------------------------------------------------
  // Priority-ordered translation scheduler
  // ---------------------------------------------------------------------------
  function currentCueIndex() {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v || !store.state.cues.length) return 0;
    const i = store.cueAt(v.currentTime);
    return i < 0 ? 0 : i;
  }

  /** Next chunk of untranslated cues, ordered by proximity to the playhead. */
  function nextChunk(size) {
    const { cues, translations, pending } = store.state;
    const cur = currentCueIndex();
    const candidates = [];
    for (let i = 0; i < cues.length; i++) {
      if (translations[i] || pending.has(i)) continue;
      candidates.push(i);
    }
    if (!candidates.length) return [];
    candidates.sort((a, b) => dist(a, cur) - dist(b, cur));

    // The very first batch is deliberately small: the user is looking at an
    // empty overlay, and 4 lines on screen in ~1s beats 16 lines in ~3s.
    let take = size;
    if (!firstChunkSent) {
      firstChunkSent = true;
      take = Math.min(size, 4);
    }
    return candidates.slice(0, take);
  }

  function dist(i, cur) {
    return i >= cur ? i - cur : (cur - i) * 1.7; // prefer what is coming up next
  }

  function chunkSize() {
    const per = settings.batchSize || 16;
    const conc = settings.concurrency || 4;
    return clamp(per * conc, 8, 96);
  }

  const MAX_INFLIGHT = 2;
  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;
  let firstChunkSent = false;

  function pump() {
    if (!started || !settings || !settings.enabled) return;
    const { cues } = store.state;
    if (!cues.length) return;
    if (store.state.status === store.STATUS.READY) return;
    if (store.state.status === store.STATUS.ERROR) return;

    while (inflight.size < MAX_INFLIGHT) {
      const chunk = nextChunk(chunkSize());
      if (!chunk.length) break;

      const gen = generation;
      store.markPending(chunk);
      const texts = chunk.map((i) => cues[i].text);

      const job = bridge
        .translate(texts, {
          from: settings.sourceLang,
          to: settings.targetLang,
          onPartial: ({ index, text }) => {
            if (gen !== generation || !text) return;
            const cueIndex = chunk[index];
            if (cueIndex == null) return;
            if (store.state.timing && store.state.timing.firstTranslationMs == null) {
              store.state.timing.firstTranslationMs = Date.now() - (store.state.timing.startedAt || Date.now());
            }
            store.applyMany([[cueIndex, text]]);
            updateBadge();
          },
        })
        .then(({ results }) => {
          if (gen !== generation) return;
          consecutiveFailures = 0;
          store.state.error = '';
          store.applyMany(chunk.map((idx, k) => [idx, results[k]]));
        })
        .catch((err) => {
          if (gen !== generation) return;
          // The page outlived an extension reload — no amount of retrying helps.
          if (err && err.code === bridge.CODE_CONTEXT_LOST) {
            store.state.error = err.message;
            store.setStatus(store.STATUS.ERROR, { reason: 'context-lost' });
            bridge.setBadge('');
            overlay.setNotice(err.message, 0);
            return;
          }
          consecutiveFailures++;
          store.state.error = describeError(err);
          store.emit('error', { message: store.state.error });
          // Release the chunk so a later pump can retry it.
          for (const i of chunk) store.state.pending.delete(i);
          // Circuit breaker: a bad key or a dead endpoint must not be hammered.
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            store.setStatus(store.STATUS.ERROR, { reason: store.state.error });
            bridge.setBadge('ERR');
            overlay.setNotice(
              tr(`翻译失败：${store.state.error}`, 'runtime.translateFailedDetail', {
                error: store.state.error,
              }),
              0
            );
          }
        })
        .finally(() => {
          inflight.delete(job);
          if (gen !== generation) return;
          updateBadge();
          if (store.state.status === store.STATUS.ERROR) return;
          if (store.translatedCount() >= store.state.cues.length) {
            if (store.state.timing && store.state.timing.completeMs == null) {
              store.state.timing.completeMs = Date.now() - (store.state.timing.startedAt || Date.now());
            }
            maybeFinish();
            return;
          }
          schedulePump(inflight.size === 0 ? 120 : 500);
        });

      inflight.add(job);
    }
    updateBadge();
  }

  /** Human-readable error, never an empty string. */
  function describeError(err) {
    if (!err) return tr('翻译失败', 'runtime.translateFailed');
    const msg = err.message || err.name || String(err);
    return err.code ? `${msg} [${err.code}]` : msg || tr('翻译失败', 'runtime.translateFailed');
  }

  /** Is a YouTube ad playing right now? */
  function adShowing() {
    try {
      const mp = document.getElementById('movie_player');
      if (mp && (mp.classList.contains('ad-showing') || mp.classList.contains('ad-interrupting'))) return true;
      return !!document.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout');
    } catch (e) {
      return false;
    }
  }

  /** Resolve once no ad is playing (or after a hard timeout). */
  function waitForAdEnd(timeoutMs = 150000) {
    if (!adShowing()) return Promise.resolve();
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (!adShowing() || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve();
        }
      }, 500);
    });
  }

  function schedulePump(delay) {
    clearTimeout(pumpTimer);
    pumpTimer = setTimeout(pump, delay || 2500);
  }

  function maybeFinish() {
    const { cues, translations } = store.state;
    if (!cues.length) return;
    const remaining = cues.length - store.translatedCount();
    if (remaining <= 0) {
      store.setStatus(store.STATUS.READY);
      bridge.setBadge('');
    } else if (store.state.status !== store.STATUS.TRANSLATING) {
      store.setStatus(store.STATUS.TRANSLATING);
    }
  }

  function updateBadge() {
    const { cues } = store.state;
    if (!cues.length) return bridge.setBadge('');
    const done = store.translatedCount();
    if (done >= cues.length) return bridge.setBadge('');
    bridge.setBadge(`${Math.round((done / cues.length) * 100)}%`);
  }

  function cancelAll() {
    clearTimeout(pumpTimer);
    pumpTimer = 0;
    inflight.clear();
  }

  // ---------------------------------------------------------------------------
  // Load pipeline
  // ---------------------------------------------------------------------------
  async function load() {
    cancelAll();
    // Release the realtime fallback before re-attempting the whole-track path.
    //
    // Without this, the two renderers fight and the fast path loses: `overlay`
    // renders `liveText` in preference to the cue list, and live.js's poller
    // keeps calling `setLive()`. So after a retry succeeded, the overlay went on
    // showing the scraped line and the popup went on saying "realtime" — the
    // whole-track result was fetched, stored, translated, and never displayed.
    // Clicking "重新翻译" looked like it did nothing.
    //
    // Deliberate tradeoff: the overlay is blank for as long as this attempt takes.
    // Keeping the previous line up would mean not stopping here, and then loading
    // a different video would leave the old video's poller running against the
    // new one. A bounded blank that self-corrects is the better failure mode.
    if (NS.live) NS.live.stop();
    consecutiveFailures = 0;
    const loadStarted = Date.now();
    let tracksAt = 0;
    let timings = {
      startedAt: loadStarted,
      trackWaitMs: null,
      cueExtractMs: null,
      firstCueMs: null,
      firstTranslationMs: null,
      completeMs: null,
    };
    const gen = ++generation;

    const vid = videoIdFromUrl();
    store.reset(true);
    store.state.videoId = vid;
    store.state.enabled = !!settings.enabled;

    if (!vid) {
      store.setStatus(store.STATUS.EMPTY, { reason: 'not-a-video' });
      return;
    }
    if (!settings.enabled) return;

    overlay.mount();
    overlay.applyStyles(settings);
    overlay.start();
    store.setStatus(store.STATUS.LOADING);

    // During a pre-roll ad the player reports the AD's player response, so both
    // the caption tracks and the reported duration belong to the ad. Wait it out.
    if (adShowing()) {
      store.setStatus(store.STATUS.LOADING, { reason: 'ad' });
      overlay.setNotice(tr('正在播放广告，广告结束后自动加载字幕', 'runtime.adPlaying'), 6000);
      await waitForAdEnd();
      if (gen !== generation) return;
    }

    latestTracks = [];
    latestDefaultIndex = -1;
    bridge.probe();
    let tracks = await waitForTracks(6000);
    if (gen !== generation) return;

    if (!tracks.length) {
      // One more probe round — the player can be slow on cold loads.
      bridge.probe();
      tracks = await waitForTracks(5000);
      if (gen !== generation) return;
    }

    store.state.tracks = tracks;
    tracksAt = Date.now();
    timings.trackWaitMs = tracksAt - loadStarted;
    if (!tracks.length) {
      store.setStatus(store.STATUS.EMPTY, { reason: 'no-captions' });
      bridge.setBadge('');
      overlay.setNotice(tr('该视频没有可用字幕，无法翻译', 'runtime.videoNoCaptions'), 8000);
      return;
    }

    const track = pickTrack(tracks, settings.sourceLang, latestDefaultIndex);
    store.state.sourceTrack = track;
    store.state.defaultIndex = latestDefaultIndex;
    store.emit('tracks', { tracks, track, defaultIndex: latestDefaultIndex });

    const { cues, ...meta } = await extractCues(track);
    timings.cueExtractMs = Date.now() - tracksAt;
    timings.firstCueMs = Date.now() - loadStarted;
    if (gen !== generation) return;

    if (!cues.length) {
      // Why we ended up here. `status: 'live'` says what we fell back TO, not
      // what failed: a zero-byte body (the PoToken timing case) and a non-empty
      // body we could not parse are both "whole-track fetch failed", and the
      // diagnostics page described both as the PoToken problem. Recording the
      // cause lets it name the layer that actually broke.
      const cause = meta.bytes > 0 ? 'unparsed-track' : 'empty-track';
      store.state.trackBytes = meta.bytes || 0;

      // Live / no-track fallback: realtime DOM scraping.
      if (NS.live && NS.live.canHandle()) {
        // `setStatus` clears `reason` unless it is passed, so it must travel
        // with the status that it explains.
        store.setStatus(store.STATUS.LIVE, { reason: cause });
        NS.live.start(settings);
        return;
      }
      store.setStatus(store.STATUS.EMPTY, { reason: cause });
      // Two causes, two instructions. Telling a user to refresh when the fault is
      // our parser sends them to retry something that cannot work, and hides the
      // bug behind a message that reads like a network hiccup.
      overlay.setNotice(
        meta.bytes > 0
          ? tr(
              '字幕数据已取回但无法解析，重试无效。请到诊断页复制信息上报',
              'runtime.captionUnparsed'
            )
          : tr(
              '未能获取字幕数据。请确认视频有字幕，或刷新页面后重试',
              'runtime.captionMissing'
            ),
        9000
      );
      return;
    }

    store.setCues(cues);
    firstChunkSent = false;
    store.state.timing = timings;
    store.emit('loaded', { cues, source: meta.source, sniffedLang: meta.sniffedLang, langMismatch: meta.langMismatch });
    store.setStatus(settings.autoTranslate ? store.STATUS.TRANSLATING : store.STATUS.READY);
    if (settings.autoTranslate) {
      pump();
      schedulePump(3000);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  function bindNavigation() {
    document.addEventListener('yt-navigate-finish', () => setTimeout(() => load(), 250), true);
    document.addEventListener('yt-page-data-updated', () => {
      if (videoIdFromUrl() !== store.state.videoId) setTimeout(() => load(), 400);
    }, true);
    // Re-prioritise around seeks without re-translating anything.
    document.addEventListener('seeked', () => schedulePump(120), true);
    window.addEventListener('popstate', () => setTimeout(() => load(), 300));
  }

  function start(s) {
    settings = s;
    store.state.enabled = !!s.enabled;
    if (!started) {
      started = true;
      bridge.initPageChannel();
      bridge.onTracks(({ tracks, defaultIndex, videoId }) => {
        if (tracks && tracks.length) pushTracks(tracks, videoId, defaultIndex);
      });
      bridge.onCaption((payload) => {
        // Remember the player's own caption URL: it carries the PoToken we need
        // to fetch any other track.
        if (payload && payload.url) signedTemplate = payload.url;
        for (const h of captionSniffers) h(payload);
      });
      bridge.onTranscript((payload) => {
        for (const h of transcriptSniffers) h(payload.transcript);
      });
      bindNavigation();
    }
    // Nothing to overlay outside a watch page — don't mount or spin a rAF loop.
    if (!videoIdFromUrl()) {
      store.setStatus(store.STATUS.EMPTY, { reason: 'not-a-video' });
      return;
    }
    overlay.mount();
    overlay.applyStyles(s);
    overlay.setVisible(!!s.enabled);
    overlay.start();
    load();
  }

  function stop() {
    cancelAll();
    overlay.stop();
    overlay.setVisible(false);
    if (NS.live) NS.live.stop();
    bridge.setBadge('');
    store.setStatus(store.STATUS.IDLE);
  }

  /** Called when only styling/enabled changed — avoids a full reload. */
  function update(s) {
    settings = s;
    store.state.enabled = !!s.enabled;
    overlay.applyStyles(s);
    overlay.setVisible(!!s.enabled);
    if (s.enabled) {
      overlay.start();
      if (store.state.cues.length && s.autoTranslate && store.state.status !== store.STATUS.ERROR) {
        pump();
        schedulePump(2500);
      }
    } else {
      overlay.stop();
      bridge.setBadge('');
    }
  }

  // The pure decisions are exported alongside the lifecycle so they can be
  // asserted without a browser: track selection and caption-URL handling are
  // exactly what breaks when YouTube changes something, and they are the parts
  // of this file that CAN be covered by tests.
  NS.youtube = {
    start,
    stop,
    update,
    load,
    parseTranscript,
    forceCaptionRequest,
    videoIdFromUrl,
    adShowing,
    pickTrack,
    potParamsFrom,
    withParams,
    langOf,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
