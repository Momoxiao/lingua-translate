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
  const tr = (zh, key, vars) => (NS.i18n ? NS.i18n.t(zh, key, vars) : zh);

  // Live captions can change several times a second. Polling less often than
  // this puts a visible delay between the caption and the request; waiting for a
  // long quiet period also misses captions that grow word by word. One poll is
  // enough to prove the line is stable before sending it.
  const POLL_MS = 100;
  const SETTLE_MS = 40;
  const RETRY_MS = 1500;
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
  let inflight = null; // { text, jobId, gen }
  let requestGen = 0;
  let retryTimer = 0;
  let noticeTimer = 0;
  let lastCountedOriginal = '';
  /** Set as soon as any caption line is read, so the grace-period notice is skipped. */
  let sawAnyCaption = false;
  /**
   * Observable counters for the smoke test — see `show()`. Reset on `start()` so
   * a value always describes the current session rather than a previous video.
   */
  const liveStats = { lines: 0, translated: 0, lastOriginal: '', lastTranslated: '' };

  const MAX_CACHE = 500;

  /**
   * Can the player render a caption here at all?
   *
   * This is the difference between "the playhead is on silence" (benign, and it
   * passes) and "this page will never show a caption" (permanent), and the two
   * need opposite words. Measured: a VOD whose 8 caption responses were all 0
   * bytes never created the container, so polling could not have succeeded no
   * matter how long it ran. Published so the popup can say the same thing the
   * overlay does, instead of "waiting for the first line" forever.
   */
  function hasCaptionContainer() {
    return !!document.querySelector('.ytp-caption-window-container');
  }

  /**
   * Normalise a rendered caption before deciding whether it is spoken text.
   *
   * YouTube leaves zero-width direction marks in some segments; `trim()` does
   * not remove them, so treating them as text produced a translated empty line
   * in headed smoke runs. C0/C1 controls have the same problem.
   */
  function normaliseCaption(raw) {
    return String(raw || '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Is this line YouTube's caption-settings UI rather than dialogue?
   *
   * The player renders the "language / click / view settings" affordance into
   * the same `.ytp-caption-segment` nodes as real captions. A headed smoke run
   * captured it as `德语（德国） 点击 查看设置` and the fallback translated it.
   * There is no class or ARIA marker separating the two, so the discriminator
   * has to be the whole line's shape.
   *
   * Keep this deliberately narrow: it only fires when the line contains the
   * settings affordance AND consists of a language choice and/or the expected
   * click wording. A real sentence that merely mentions settings keeps its
   * translation.
   */
  function isCaptionSettingsPrompt(text) {
    if (!text || text.length > 120) return false;

    const settings = /(?:click|tap)\b[\s\S]{0,24}\b(?:settings|options)\b|查看设置|点击\s*查看设置|點擊\s*查看設定|設定を見る|クリックして設定|설정\s*보기|ver\s+configuración|voir\s+les\s+paramètres|einstellungen\s+anzeigen/i;
    const withoutPunctuation = text.replace(/[，。！？、,.!?;:：；—–-]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = withoutPunctuation.split(' ').filter(Boolean);
    const languageChunk =
      /^(?:[\p{L}\p{M}'’.-]+\s*){1,4}$/u.test(withoutPunctuation) ||
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s]{2,16}$/u.test(withoutPunctuation);
    const languageOnly =
      /^(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{1,12}|[\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+){0,3})\s*[（(][^()（）]{1,24}[)）]\s*$/u;

    const affordance = settings.exec(text);
    if (!affordance) {
      // A lone localised language name in parentheses is the other half of the
      // same affordance on some locales.
      return languageOnly.test(text);
    }
    const before = text.slice(0, affordance.index).trim();
    if (!before) return true;
    if (languageOnly.test(before)) return true;
    const beforeWords = before.replace(/\s+/g, ' ').split(' ').filter(Boolean);
    return beforeWords.length <= 4 && languageChunk && /^[\p{L}\p{M}'’().（）\s-]+$/u.test(before);
  }

  function readCaption() {
    const win = document.querySelector('.ytp-caption-window-container .ytp-caption-window-bottom') ||
      document.querySelector('.ytp-caption-window-container');
    if (!win) return '';
    const segs = win.querySelectorAll('.ytp-caption-segment');
    if (segs.length) {
      const parts = [];
      segs.forEach((s) => {
        const part = normaliseCaption(s.textContent);
        if (part) parts.push(part);
      });
      const text = parts.join(' ');
      return isCaptionSettingsPrompt(text) ? '' : text;
    }
    const text = normaliseCaption(win.textContent);
    return isCaptionSettingsPrompt(text) ? '' : text;
  }

  function cancelInflight() {
    const job = inflight;
    inflight = null;
    if (job && job.jobId && bridge.cancel) {
      try {
        bridge.cancel(job.jobId);
      } catch (e) {
        /* the worker may already be gone */
      }
    }
  }

  function isActive(gen, text) {
    return (
      !!inflight &&
      inflight.gen === gen &&
      running &&
      (text === currentOriginal || isContinuation(text, currentOriginal))
    );
  }

  function isPrefixOf(previous, next) {
    if (!previous || !next) return false;
    const a = previous.trim().toLowerCase();
    const b = next.trim().toLowerCase();
    return !!a && !!b && a !== b && b.startsWith(a) &&
      /^[\s.,!?;:，。！？；：'"“”‘’()[\]{}<>《》-]/.test(b.slice(a.length));
  }

  /**
   * Is `next` the same spoken sentence as `previous`, just with more words?
   *
   * YouTube's live captions are rendered incrementally, so the DOM often goes
   * "The quick" -> "The quick brown" -> "The quick brown fox". Treating each of
   * those as a new line made live.js cancel and restart the translation several
   * times per sentence; the provider could never finish one before the next
   * cancellation arrived. Punctuation-only changes count as the same line too.
   */
  function isContinuation(previous, next) {
    if (!previous || !next) return false;
    const a = previous.trim().toLowerCase();
    const b = next.trim().toLowerCase();
    return a === b || isPrefixOf(previous, next);
  }

  function translateNow(text) {
    if (!text || !running) return;
    if (cache.has(text)) {
      cancelInflight();
      pendingText = text;
      show(text, cache.get(text));
      return;
    }
    // Keep the in-flight request alive while the caption is still growing. A
    // growth is not a new sentence and must not invalidate work already done.
    // The partial belongs to the shorter source, though, so it is rendered as a
    // temporary preview; `finally` below starts the correction for whatever the
    // final caption turned out to be.
    if (inflight && (inflight.text === text || isPrefixOf(inflight.text, text))) {
      pendingText = text;
      return;
    }

    // Live mode is "latest caption wins": a request for a line that is no longer
    // on screen only wastes the provider's latency budget. Cancel it before
    // starting the current line, so the next streaming token belongs to what the
    // viewer is reading now.
    cancelInflight();
    pendingText = text;
    const gen = ++requestGen;
    const jobId = `live_${Date.now()}_${gen}`;
    inflight = { text, jobId, gen };
    bridge
      .translate([text], {
        from: settings.sourceLang,
        to: settings.targetLang,
        kind: 'live',
        jobId,
        onPartial: ({ index, text: partial }) => {
          if (index !== 0 || !partial || !isActive(gen, text)) return;
          show(currentOriginal, partial, true);
        },
      })
      .then(({ results }) => {
        if (!isActive(gen, text)) return;
        const out = (results && results[0]) || '';
        if (!out) {
          pendingText = '';
          return;
        }
        if (cache.size > MAX_CACHE) cache.clear();
        cache.set(text, out);
        if (text === currentOriginal) show(text, out);
        // A translation of a prefix is not a translation of the sentence the
        // viewer is now reading. Keep it as an interim hint, then let `finally`
        // request the completed caption.
        else show(currentOriginal, out, true);
      })
      .catch(() => {
        if (!isActive(gen, text)) return;
        pendingText = text;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = 0;
          if (running && currentOriginal === text) pendingText = '';
        }, RETRY_MS);
      })
      .finally(() => {
        if (inflight && inflight.gen === gen) {
          inflight = null;
          // The source grew while this request was finishing. Keep the partial
          // on screen and start one follow-up for the latest, complete caption.
          if (
            running &&
            currentOriginal &&
            text !== currentOriginal &&
            isContinuation(text, currentOriginal)
          ) {
            translateNow(currentOriginal);
          }
        }
      });
  }

  function show(original, translated, partial) {
    const nextTranslated = translated || '';
    const lineChanged = original !== lastShownOriginal;
    const visualChanged = lineChanged || nextTranslated !== lastShownTranslated;
    const countFinal = !partial && original && nextTranslated && original !== lastCountedOriginal;
    if (!visualChanged && !countFinal) return;

    if (lineChanged && original) liveStats.lines++;
    lastShownOriginal = original;
    lastShownTranslated = nextTranslated;
    if (countFinal) {
      lastCountedOriginal = original;
      liveStats.translated++;
    }
    // Counters for the smoke test. The realtime path never touches the cue
    // store, so without these the only externally visible fact is the status
    // string "live" — which cannot distinguish "translated a line" from
    // "polled forever and matched nothing". They are plain counters, not state
    // the UI reads.
    liveStats.lastOriginal = original || '';
    liveStats.lastTranslated = nextTranslated;
    if (visualChanged) overlay.setLive(original, nextTranslated);
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
      const grew = isContinuation(currentOriginal, text);
      currentOriginal = text;
      currentSince = Date.now();
      if (!text) {
        // Caption cleared — clear the overlay too.
        cancelInflight();
        pendingText = '';
        show('', '');
        return;
      }
      // Immediately surface a cached translation to avoid flicker.
      if (cache.has(text)) {
        cancelInflight();
        pendingText = text;
        show(text, cache.get(text));
        return;
      }
      // A growing caption keeps its translation visible while the in-flight
      // request continues. A genuinely new line shows the original until the
      // next request produces something.
      show(text, grew && lastShownTranslated ? lastShownTranslated : '');
      // Start on the first observation instead of waiting for another poll.
      // The latest-caption logic still cancels this request if a new sentence
      // arrives before it completes.
      translateNow(text);
      return;
    }

    if (!text) return;
    // Caption has settled -> translate once. If a previous line is still in
    // flight, translateNow cancels it and starts this one instead.
    if (Date.now() - currentSince >= SETTLE_MS && text !== pendingText && !inflight) {
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
    lastCountedOriginal = '';
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
      if (!hasCaptionContainer() && !isLive) {
        overlay.setNotice(
          tr(
            '整轨字幕和播放器自绘字幕都没拿到——这个视频的字幕无法获取，本页翻译不可用。' +
              '可到诊断页复制信息上报',
            'runtime.liveDoomed'
          ),
          0
        );
        return;
      }
      overlay.setNotice(
        isLive
          ? tr('直播模式：字幕出现即翻译，支持时逐字显示译文', 'runtime.liveMode')
          : tr(
              '整轨字幕暂时没赶在 YouTube 签名窗口内返回，先用逐句实时翻译顶上，并在后台继续重试完整字幕轨',
              'runtime.liveFallback'
            ),
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
    retryTimer = 0;
    clearTimeout(noticeTimer);
    noticeTimer = 0;
    sawAnyCaption = false;
    cancelInflight();
    pendingText = '';
    currentOriginal = '';
    lastShownOriginal = '';
    lastShownTranslated = '';
    lastCountedOriginal = '';
    overlay.setLive(null);
  }

  // `hasContainer` is part of the stats a surface reads: the popup uses it to
  // stop printing "waiting for the first line" for a page that will never render
  // one, which is the same false-comfort this file's notice guards against.
  NS.live = {
    start,
    stop,
    canHandle,
    hasCaptionContainer,
    stats: () => ({ ...liveStats, hasContainer: hasCaptionContainer() }),
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
