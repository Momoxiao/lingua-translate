/**
 * Lingua — live / no-track realtime fallback (isolated world).
 *
 * Reads the caption line YouTube itself renders and translates it on the fly.
 * Registers onto Lingua.live.
 *
 * Two situations land here, and they are different:
 *
 *   1. A live stream, where there is no whole track to fetch in the first place.
 *   2. A VOD whose track WAS advertised but whose fetch came back empty. That is
 *      the measured PoToken failure: `/api/timedtext` answers HTTP 200 with a
 *      0-byte body when the request carries no `pot`. The player is not subject
 *      to it — it mints its own token and keeps rendering the lines it shows
 *      into `.ytp-caption-segment`. So on exactly the failure where the overlay
 *      used to go blank, the right text is already in the DOM.
 *
 * Case 2 costs something real and the UI says so: only the line being spoken can
 * be read, so there is no translation queued ahead of the playhead and the first
 * line appears a beat late. That is strictly better than a blank overlay, and it
 * is not dressed up as the fast path.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const { store, bridge, overlay } = NS;

  const POLL_MS = 220;
  const SETTLE_MS = 120; // wait for the caption to stop changing before translating
  /**
   * How long to wait for a first line before telling the user anything. On a VOD
   * the player only renders a caption once playback reaches one, so a video that
   * opens with silence shows nothing for a while. Silence here is not failure,
   * and the notice must not claim it is.
   */
  const FIRST_LINE_GRACE_MS = 12000;

  let timer = 0;
  let settings = null;
  let running = false;
  let cache = new Map(); // original -> translated
  let pendingText = '';
  let lastShownOriginal = '';
  let lastShownTranslated = '';
  let currentOriginal = '';
  let currentSince = 0;
  let inflightText = '';
  let retryTimer = 0;
  let noticeTimer = 0;
  /** Set as soon as any caption line is read, so the grace-period notice is skipped. */
  let sawAnyCaption = false;
  /**
   * Observable counters for the smoke test — see `show()`. Reset on `start()` so
   * a value always describes the current session rather than a previous video.
   */
  const liveStats = { lines: 0, translated: 0, lastOriginal: '', lastTranslated: '' };

  const MAX_CACHE = 500;

  function readCaption() {
    const win = document.querySelector('.ytp-caption-window-container .ytp-caption-window-bottom') ||
      document.querySelector('.ytp-caption-window-container');
    if (!win) return '';
    const segs = win.querySelectorAll('.ytp-caption-segment');
    if (segs.length) {
      let out = '';
      segs.forEach((s) => {
        out += (s.textContent || '') + ' ';
      });
      return out.replace(/\s+/g, ' ').trim();
    }
    return (win.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function translateNow(text) {
    if (!text || inflightText === text) return;
    if (cache.has(text)) {
      show(text, cache.get(text));
      return;
    }
    inflightText = text;
    bridge
      .translate([text], { from: settings.sourceLang, to: settings.targetLang })
      .then(({ results }) => {
        const out = (results && results[0]) || '';
        if (cache.size > MAX_CACHE) cache.clear();
        cache.set(text, out);
        if (out && text === currentOriginal) show(text, out);
      })
      .catch(() => {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          inflightText = '';
        }, 3000);
      })
      .finally(() => {
        if (inflightText === text) inflightText = '';
      });
  }

  function show(original, translated) {
    if (original === lastShownOriginal && translated === lastShownTranslated) return;
    lastShownOriginal = original;
    lastShownTranslated = translated;
    // Counters for the smoke test. The realtime path never touches the cue
    // store, so without these the only externally visible fact is the status
    // string "live" — which cannot distinguish "translated a line" from
    // "polled forever and matched nothing". They are plain counters, not state
    // the UI reads.
    if (original) liveStats.lines++;
    if (original && translated) liveStats.translated++;
    liveStats.lastOriginal = original || '';
    liveStats.lastTranslated = translated || '';
    overlay.setLive(original, translated);
  }

  function poll() {
    if (!running) return;
    const text = readCaption();
    // A single line is enough to prove the player really is rendering captions,
    // which is what cancels the "could not get the track" notice.
    if (text) {
      // The permanent "captions are unavailable here" notice is a claim about
      // the future, so the first line that contradicts it must retract it —
      // otherwise the overlay shows a translated line *and* says none can be
      // fetched, which is the kind of self-contradiction this file exists to
      // avoid. A no-op when no notice is showing.
      if (!sawAnyCaption) overlay.setNotice('');
      sawAnyCaption = true;
    }

    if (text !== currentOriginal) {
      currentOriginal = text;
      currentSince = Date.now();
      if (!text) {
        // Caption cleared — clear the overlay too.
        show('', '');
        return;
      }
      // Immediately surface a cached translation to avoid flicker.
      if (cache.has(text)) {
        show(text, cache.get(text));
        return;
      }
      show(text, ''); // show original while the translation is in flight
      return;
    }

    if (!text) return;
    // Caption has settled -> translate once.
    if (Date.now() - currentSince >= SETTLE_MS && text !== pendingText) {
      pendingText = text;
      translateNow(text);
    }
  }

  /**
   * Can we fall back to reading the player's own rendered captions?
   *
   * This used to require `isLive`, which excluded the case that needs it most: a
   * VOD whose track fetch came back empty. The player renders captions on VOD
   * too — measured: a fallback run whose caption requests carried no `pot` at all
   * still read real lines out of the DOM (2 read, 1 translated) — so the only
   * requirements are a video and a player that has captions on.
   *
   * "Often", not "always". In the same batch of runs one VOD fetched 8 caption
   * responses, all of them 0 bytes, created no caption container, and left this
   * with nothing to read. So this is a rescue for the common case, and the caller
   * must still be able to say that it read nothing rather than implying success.
   *
   * The caller decides WHEN to use this: `youtube.js` only reaches here after the
   * whole-track path has already been tried and failed, so this never displaces
   * the fast path.
   */
  function canHandle() {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v) return false;
    const isLive = !!document.querySelector('.ytp-live') || v.duration === Infinity;
    if (isLive) return true;
    // A VOD must actually have a caption track to render, otherwise polling can
    // never produce anything and we would be replacing a clear error with a
    // silent, permanent blank.
    const mp = document.getElementById('movie_player');
    try {
      if (mp && typeof mp.getOption === 'function') {
        const list = mp.getOption('captions', 'tracklist') || [];
        if (list.length) return true;
      }
    } catch (e) {
      /* fall through to the DOM check */
    }
    // Fallback signal when the player API is not exposed yet: the CC button
    // exists and reports captions are available.
    return !!document.querySelector('.ytp-subtitles-button');
  }

  function start(s) {
    settings = s;
    if (running) return;
    running = true;
    store.state.liveMode = true;
    liveStats.lines = 0;
    liveStats.translated = 0;
    liveStats.lastOriginal = '';
    liveStats.lastTranslated = '';
    overlay.mount();
    overlay.applyStyles(s);
    overlay.setVisible(true);
    overlay.start();
    NS.youtube.forceCaptionRequest();
    timer = setInterval(poll, POLL_MS);
    bridge.setBadge('LIVE');

    // Say what mode this is, because it behaves differently from the fast path:
    // one line at a time, translated just after it appears. Saying nothing would
    // let a user conclude the extension is slow or broken.
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    const isLive = !!document.querySelector('.ytp-live') || (v && v.duration === Infinity);
    store.state.isLiveStream = !!isLive;
    noticeTimer = setTimeout(() => {
      if (!running || sawAnyCaption) return;
      // Two situations look identical on a blank overlay, and they need opposite
      // treatment:
      //
      //   no caption container  the player never rendered captions at all, so
      //                         polling can NEVER produce a line. Measured: a VOD
      //                         made 8 caption requests, every body 0 bytes, and
      //                         created no `.ytp-caption-window-container` — the
      //                         player had nothing to render. A notice that timed
      //                         out after 8s left the user with a blank overlay
      //                         and no explanation, having been told a moment
      //                         earlier that realtime mode was working.
      //   container, no text    the playhead is simply on silence. This does
      //                         resolve itself, so the notice should expire.
      //
      // So the first case gets a notice that stays until something changes, and
      // says the honest thing: this cannot work here.
      const win = document.querySelector('.ytp-caption-window-container');
      if (!win && !isLive) {
        overlay.setNotice(
          '整轨字幕和播放器自绘字幕都没拿到——这个视频的字幕无法获取，本页翻译不可用。' +
            '可到诊断页复制信息上报',
          0
        );
        return;
      }
      overlay.setNotice(
        isLive
          ? '直播模式：逐句实时翻译，比点播稍慢'
          : '整轨字幕获取失败（YouTube 签名限制），已切换为逐句实时翻译',
        8000
      );
    }, FIRST_LINE_GRACE_MS);
  }

  function stop() {
    running = false;
    store.state.liveMode = false;
    clearInterval(timer);
    timer = 0;
    clearTimeout(retryTimer);
    clearTimeout(noticeTimer);
    noticeTimer = 0;
    sawAnyCaption = false;
    inflightText = '';
    pendingText = '';
    currentOriginal = '';
    lastShownOriginal = '';
    lastShownTranslated = '';
    overlay.setLive(null);
  }

  NS.live = { start, stop, canHandle, stats: () => ({ ...liveStats }) };
})(typeof globalThis !== 'undefined' ? globalThis : self);
