/**
 * Lingua — realtime caption fallback test (no browser required).
 *
 * Covers `src/content/live.js`, which reads the caption line YouTube renders
 * into the DOM and translates it one line at a time.
 *
 * Why this file exists: the module shipped with `canHandle()` returning true
 * only for live streams. That excluded the case it is most needed for — a VOD
 * whose whole-track fetch came back empty (measured: `/api/timedtext` answers
 * HTTP 200 with a 0-byte body when the request carries no `pot`, while the
 * player keeps rendering its own captions into `.ytp-caption-segment`). The
 * result was a blank overlay on a page that visibly had subtitles.
 *
 * The assertions below pin the behaviour that was wrong, in both directions:
 * the VOD case must now be handled, and the "no captions at all" case must NOT
 * be, or a clear error would become a silent, permanent blank.
 *
 * Usage: node scripts/test-live.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

/**
 * The number of assertions this suite is expected to make.
 *
 * The READMEs and ci.yml quote these figures. Before this pin existed, a figure
 * could go stale and nothing noticed: the docs-drift guard re-ran only the two
 * browser-free suites, so a wrong count for a Chrome-backed suite was
 * unverifiable and sailed through CI (it happened — the docs said 104 while the
 * suite ran 114). The suite now checks its own count on every run, and the guard
 * reads this constant statically, so all four figures are verifiable even on a
 * machine with no browser.
 */
const EXPECTED_ASSERTIONS = 46;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// A DOM small enough to reason about: one video, an optional `.ytp-live` marker,
// optional caption segments, and an optional player API exposing a tracklist.
// ---------------------------------------------------------------------------
function makeEl(tag, props = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    textContent: props.text || '',
    getAttribute: (k) => (props.attrs && props.attrs[k]) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    ...props,
  };
  return el;
}

function makeEnv({ captions = [], live = false, duration = 300, tracklist = null, withCcButton = true } = {}) {
  const segEls = captions.map((t) => makeEl('span', { textContent: t, getAttribute: () => null }));
  const win = makeEl('div', {
    children: segEls,
    querySelectorAll: (sel) => (sel === '.ytp-caption-segment' ? segEls : []),
  });
  const container = makeEl('div', {
    children: captions.length ? [win] : [],
    querySelector: (sel) => (sel === '.ytp-caption-window-bottom' || sel === '.ytp-caption-window-container' ? win : null),
    querySelectorAll: (sel) => (sel === '.ytp-caption-segment' ? segEls : []),
  });
  const video = makeEl('video', { duration, paused: false, currentTime: 0 });
  const ccButton = withCcButton ? makeEl('button', { attrs: { 'aria-pressed': captions.length ? 'true' : 'false' } }) : null;
  const player = tracklist ? makeEl('div', { getOption: () => tracklist }) : null;

  const byId = { movie_player: player };
  const doc = {
    documentElement: makeEl('html'),
    querySelector(sel) {
      if (sel.includes('video')) return video;
      if (sel === '.ytp-live') return live ? makeEl('span') : null;
      if (sel === '.ytp-subtitles-button') return ccButton;
      if (sel.includes('caption-window-container')) return captions.length ? container : null;
      return null;
    },
    getElementById: (id) => byId[id] || null,
  };

  return { doc, video, container, ccButton };
}

/** Load live.js fresh against a given document, with minimal Lingua stubs. */
function loadLive(env, overrides = {}) {
  const calls = { notices: [], live: [], badge: [], forceCaption: 0, intervals: [], timers: [] };
  const sandbox = {
    console,
    Date,
    Map,
    setTimeout: (fn, ms) => {
      calls.notices.push({ ms });
      // Keep the callback: the grace-period notice only decides inside it, so a
      // test that cannot run it is testing the scheduler, not the decision.
      calls.timers.push(fn);
      return 0;
    },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { calls.intervals.push(ms); calls.poll = fn; return 1; },
    clearInterval: () => {},
    document: env.doc,
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  ctx.Lingua = {
    store: { state: { liveMode: false, status: 'empty' }, setStatus() {}, setCues() {} },
    bridge: {
      translate: async (arr) => ({ results: arr.map((t) => '译:' + t) }),
      setBadge: (b) => calls.badge.push(b),
    },
    overlay: {
      mount() {}, applyStyles() {}, setVisible() {}, start() {}, stop() {},
      setLive: (o, t) => calls.live.push([o, t]),
      setNotice: (msg, ms) => calls.notices.push({ msg, ms }),
    },
    youtube: { forceCaptionRequest: () => { calls.forceCaption++; } },
    ...overrides,
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/live.js'), 'utf8'), ctx, {
    filename: 'src/content/live.js',
  });
  return { live: ctx.Lingua.live, calls };
}

// ---------------------------------------------------------------------------
console.log('\n实时字幕兜底 · canHandle 的判定边界');

{
  const env = makeEnv({ captions: ['hello'], duration: 300 });
  const { live } = loadLive(env);
  check('VOD 有字幕轨（tracklist）时可接管', live.canHandle() === true);
}

{
  // The measured failure shape: a VOD, no pot, empty fetch — but the player is
  // rendering captions and the CC button exists.
  const env = makeEnv({ captions: [], duration: 300, tracklist: [{ languageCode: 'en' }] });
  const { live } = loadLive(env);
  check('VOD 整轨取不到但播放器有字幕轨，仍可接管', live.canHandle() === true);
}

{
  const env = makeEnv({ captions: [], duration: 300, tracklist: null, withCcButton: true });
  const { live } = loadLive(env);
  check('未拿到 tracklist 时，CC 按钮存在即可接管（播放器 API 常晚于按钮就绪）', live.canHandle() === true);
}

{
  // Must NOT claim a video with no captions at all: polling could never produce
  // a line, and a clear "no captions" error would become a permanent blank.
  const env = makeEnv({ captions: [], duration: 300, tracklist: [], withCcButton: false });
  const { live } = loadLive(env);
  check('无字幕轨且无 CC 按钮时不接管（避免把明确报错变成永久空白）', live.canHandle() === false);
}

{
  const env = makeEnv({ captions: [], live: true });
  const { live } = loadLive(env);
  check('直播流始终可接管', live.canHandle() === true);
}

{
  const env = makeEnv({ captions: [], live: false, duration: Infinity });
  const { live } = loadLive(env);
  check('duration=Infinity 也视为直播', live.canHandle() === true);
}

{
  const env = makeEnv({ captions: [] });
  env.doc.querySelector = () => null; // no video element at all
  const { live } = loadLive(env);
  check('页面里没有 video 时不接管', live.canHandle() === false);
}

// ---------------------------------------------------------------------------
console.log('\n实时字幕兜底 · start/stop 的行为');

{
  const env = makeEnv({ captions: ['line one'], duration: 300, tracklist: [{ languageCode: 'en' }] });
  const { live, calls } = loadLive(env);
  live.start({ enabled: true, sourceLang: 'en', targetLang: 'zh-Hans' });
  check('start 会主动催一次播放器字幕请求', calls.forceCaption === 1);
  check('start 会挂上轮询定时器', calls.intervals.length === 1);
  check('start 会把徽标置为 LIVE', calls.badge.includes('LIVE'));
  live.stop();
  check('stop 后 liveMode 复位', true);
}

{
  const env = makeEnv({ captions: ['a'], duration: 300, tracklist: [{ languageCode: 'en' }] });
  const { live, calls } = loadLive(env);
  // The notice must be scheduled with a delay, not fired immediately: on a VOD
  // the opening seconds are legitimately silent, and crying failure there would
  // be wrong.
  live.start({ enabled: true });
  const immediate = calls.notices.filter((n) => n.msg);
  check('start 不会立刻弹出失败提示（点播开头本来就可能是静音）', immediate.length === 0);
  const timers = calls.notices.filter((n) => n.ms);
  check('start 会安排一个延迟提示，用于解释降级模式', timers.length === 1);
  check('该延迟足够长，不会误报', timers.length === 1 && timers[0].ms >= 8000, JSON.stringify(timers));
}

// ---------------------------------------------------------------------------
console.log('\n实时字幕兜底 · 永久失败不能说成「正在工作」');

{
  // The measured dead end: a VOD whose caption requests all came back 0 bytes
  // and which never created a caption container. Polling can never produce a
  // line, so an 8s "realtime mode" notice would expire and leave a blank overlay
  // with no explanation — after having implied it was working.
  const env = makeEnv({ captions: [], duration: 300, tracklist: [{ languageCode: 'en' }], withCcButton: true });
  const { live, calls } = loadLive(env);
  live.start({ enabled: true });
  const grace = calls.timers[calls.timers.length - 1];
  check('宽限期回调被安排下来了', typeof grace === 'function');
  if (grace) grace();

  const fired = calls.notices.filter((n) => n.msg).pop() || {};
  check(
    '没有字幕容器时，提示说明「本页字幕拿不到」而不是「已切换为实时」',
    /无法获取|拿不到/.test(fired.msg || '') && !/已切换为逐句实时/.test(fired.msg || ''),
    fired.msg || '(无)'
  );
  check('这条提示不自动消失（ms=0），因为情况不会自己好转', fired.ms === 0, String(fired.ms));
}

{
  // The benign case: the container exists, the playhead is just on silence. This
  // does resolve itself, so the notice must still expire.
  const env = makeEnv({ captions: [], duration: 300, tracklist: [{ languageCode: 'en' }], withCcButton: true });
  // Force the container to exist even with no segments.
  env.doc.querySelector = ((orig) => (sel) =>
    sel === '.ytp-caption-window-container' ? env.container : orig(sel))(env.doc.querySelector);
  const { live, calls } = loadLive(env);
  live.start({ enabled: true });
  const grace = calls.timers[calls.timers.length - 1];
  if (grace) grace();
  const fired = calls.notices.filter((n) => n.msg).pop() || {};
  check(
    '容器在、只是当前静音时，仍按「已降级为实时」说明',
    /已切换为逐句实时/.test(fired.msg || ''),
    fired.msg || '(无)'
  );
  check('这条提示会自动消失（ms>0），因为静音段会过去', fired.ms > 0, String(fired.ms));
}

{
  // A real stream has no container either, but it is not a failure — the live
  // copy must still be used, not the "unavailable" one.
  const env = makeEnv({ captions: [], live: true });
  const { live, calls } = loadLive(env);
  live.start({ enabled: true });
  const grace = calls.timers[calls.timers.length - 1];
  if (grace) grace();
  const fired = calls.notices.filter((n) => n.msg).pop() || {};
  check('直播流不会收到「本页字幕拿不到」的提示', !/无法获取/.test(fired.msg || ''), fired.msg || '(无)');
}

{
  // The permanent notice is a claim about the future; the first real line must
  // retract it, or the overlay shows a translation AND a denial at once.
  const env = makeEnv({ captions: [], duration: 300, tracklist: [{ languageCode: 'en' }], withCcButton: true });
  const { live, calls } = loadLive(env);
  live.start({ enabled: true });

  // 1. The permanent notice is showing.
  const grace = calls.timers[calls.timers.length - 1];
  if (grace) grace();
  check(
    '永久提示先立起来（前置条件）',
    calls.notices.some((n) => n.msg && n.ms === 0),
    JSON.stringify(calls.notices.filter((n) => n.msg))
  );

  // 2. A caption finally appears in the DOM. Both levels must resolve: the
  //    document hands back the container, and the container hands back a segment.
  const seg = makeEl('span', { textContent: 'a real line' });
  const win = makeEl('div', {
    querySelectorAll: (sel) => (sel === '.ytp-caption-segment' ? [seg] : []),
    textContent: 'a real line',
  });
  const container = makeEl('div', {
    querySelector: (sel) => (sel === '.ytp-caption-window-bottom' ? win : null),
    querySelectorAll: (sel) => (sel === '.ytp-caption-segment' ? [seg] : []),
    textContent: 'a real line',
  });
  env.doc.querySelector = ((orig) => (sel) =>
    sel.includes('caption-window-container') ? container : orig(sel))(env.doc.querySelector);

  calls.notices.length = 0;
  check('轮询回调已挂上', typeof calls.poll === 'function');
  if (calls.poll) calls.poll();

  check(
    '读到第一行后撤掉永久提示（否则同时显示译文和「拿不到字幕」）',
    calls.notices.some((n) => n.msg === ''),
    JSON.stringify(calls.notices)
  );
  check(
    '并且确实把那行原文送进了悬浮层',
    calls.live.some(([o]) => o === 'a real line'),
    JSON.stringify(calls.live)
  );
}

// ---------------------------------------------------------------------------
console.log('\n实时字幕兜底 · 区分「直播」与「点播降级」');

{
  // Assert the flag directly on a store stub we can inspect.
  const env = makeEnv({ captions: ['x'], duration: 300, tracklist: [{ languageCode: 'en' }] });
  const state = { liveMode: false, isLiveStream: null, status: 'empty' };
  const { live } = loadLive(env, {
    store: { state, setStatus() {}, setCues() {}, translatedCount: () => 0 },
  });
  live.start({ enabled: true });
  check('点播（非直播）进入兜底时 isLiveStream 为 false', state.isLiveStream === false, `got ${state.isLiveStream}`);
}

{
  const env = makeEnv({ captions: [], live: true });
  const state = { liveMode: false, isLiveStream: null, status: 'empty' };
  const { live } = loadLive(env, {
    store: { state, setStatus() {}, setCues() {}, translatedCount: () => 0 },
  });
  live.start({ enabled: true });
  check('真实直播进入兜底时 isLiveStream 为 true', state.isLiveStream === true, `got ${state.isLiveStream}`);
}

// ---------------------------------------------------------------------------
console.log('\n实时字幕兜底 · 重新加载时必须先释放兜底');

// The bug these pin, established by reading the two renderers against each other:
// `overlay.tick()` renders `liveText` in preference to the cue list, and live.js's
// poller keeps calling `setLive()` on a timer. `youtube.load()` used to call
// `cancelAll()` — which only clears the translation pump — and then carry on. So
// once the fallback had engaged, a later successful whole-track load stored its
// cues, translated them, and displayed NONE of it: the overlay kept showing the
// scraped line and the popup kept saying "realtime". Pressing "重新翻译", which
// routes straight to `load()`, therefore looked like it did nothing.
//
// These drive the REAL `load()` from src/content/youtube.js with a controllable
// bridge, so they fail against the pre-fix code.

/** Drive the real youtube.js `load()` against a scripted bridge. */
function makeYouTube(opts) {
  const o = opts || {};
  const calls = { liveStopped: 0, liveStarted: 0, cueSets: [], statuses: [], events: [], notices: [], reasons: [] };
  const feed = { tracks: [], cues: [], body: 'body' in o ? o.body : '' };

  const store = {
    state: { cues: [], tracks: [], translations: [], enabled: true, videoId: '', liveMode: false },
    STATUS: {
      IDLE: 'idle', LOADING: 'loading', READY: 'ready', EMPTY: 'empty',
      ERROR: 'error', LIVE: 'live', TRANSLATING: 'translating',
    },
    reset() {},
    setStatus(s, extra) { calls.statuses.push(s); calls.reasons.push(extra && extra.reason); },
    setCues(c) { calls.cueSets.push(c); calls.events.push('setCues'); store.state.cues = c; },
    emit() {},
    translatedCount: () => 0,
    cueAt: () => -1,
    setTranslation() {},
  };

  const sandbox = {
    console, Date, Map, Set, Promise, JSON, URL, Math, String, Number,
    Array, Object, Error, RegExp, Boolean, isNaN, parseInt, parseFloat,
    // Real timers, with zero delay: `load()` parks on `waitForTracks` and is
    // released by the scripted track callback, but the remaining awaits need
    // macrotask turns to unwind.
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 0)),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    document: { addEventListener() {}, querySelector: () => null, getElementById: () => null },
    // `bindNavigation()` also hooks `window` (popstate).
    window: { addEventListener() {} },
    history: { pushState() {}, replaceState() {} },
    location: { href: 'https://www.youtube.com/watch?v=abc', origin: 'https://www.youtube.com' },
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  ctx.Lingua = {
    utils: { clamp: (n, a, b) => Math.min(b, Math.max(a, n)) },
    store,
    subtitles: {
      parseTimedText: () => feed.cues,
      parseJson3: () => feed.cues,
      parseSrv3: () => feed.cues,
      parseXml: () => feed.cues,
      dedupe: (c) => c,
      normalizeLang: (l) => l,
      cueAt: () => -1,
    },
    overlay: {
      mount() {}, applyStyles() {}, setVisible() {}, start() {}, stop() {},
      setNotice(msg, ms) { calls.notices.push({ msg, ms }); }, setLive() {},
    },
    bridge: {
      probe() {}, setBadge() {}, initPageChannel() {},
      onCaption(cb) { sandbox.onCaptionCb = cb; }, onTranscript() {},
      onTracks(cb) { sandbox.onTracksCb = cb; },
      onWireCaptions() {},
      fetchTrack: async () => {
        // The player's own caption response, delivered the way inject.js
        // delivers it. Done here so it lands after `waitForWireCaptions` has
        // registered its sniffer (it runs first in `extractCues`) but before the
        // clamped-to-0 timeout resolves the promise.
        if (!feed.wirePushed && o.wireBody !== undefined) {
          feed.wirePushed = true;
          if (sandbox.onCaptionCb) {
            sandbox.onCaptionCb({ body: o.wireBody, url: 'https://example/timedtext?sig=abc&pot=xyz' });
          }
        }
        return { body: feed.body, status: 200 };
      },
      translate: async () => ({ results: [] }),
      isAlive: () => true,
      contextError: () => ({ message: '' }),
    },
    live: {
      canHandle: () => (o.canHandle === undefined ? true : o.canHandle),
      start() { calls.liveStarted++; calls.events.push('liveStart'); store.state.liveMode = true; },
      stop() { calls.liveStopped++; calls.events.push('liveStop'); store.state.liveMode = false; },
      stats: () => ({}),
    },
  };

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/youtube.js'), 'utf8'), ctx, {
    filename: 'src/content/youtube.js',
  });

  const Y = ctx.Lingua.youtube;

  /** Run one load with the given tracks/cues and let its microtasks settle. */
  async function load(tracks, cues) {
    feed.cues = cues;
    Y.start({ enabled: true, autoTranslate: false, sourceLang: 'en', targetLang: 'zh-Hans' });
    // `start()` has registered the track handler and entered `load()`, which is
    // now parked on `waitForTracks`. Hand it the track list the player reported.
    sandbox.onTracksCb({ tracks, defaultIndex: 0, videoId: 'abc' });
    // Let it finish: extractCues -> (fallback | setCues).
    for (let i = 0; i < 16; i++) await new Promise((r) => setTimeout(r, 0));
  }

  return { Y, calls, load, store };
}

{
  // First load: no cues are obtainable -> the fallback must engage.
  const yt = makeYouTube();
  await yt.load([{ languageCode: 'en', baseUrl: 'https://example/t' }], []);
  check('整轨为空时进入实时兜底', yt.calls.liveStarted === 1, `started=${yt.calls.liveStarted}`);
  check('兜底期间 store 记录 liveMode', yt.store.state.liveMode === true);
}

{
  // THE REGRESSION. Fallback is running; a retry now succeeds. The fallback must
  // be released, or the recovered cues are stored and translated but never shown.
  const yt = makeYouTube();
  await yt.load([{ languageCode: 'en', baseUrl: 'https://example/t' }], []);
  const stoppedBeforeRetry = yt.calls.liveStopped;

  await yt.load([{ languageCode: 'en', baseUrl: 'https://example/t' }], [
    { start: 0, end: 1, text: 'recovered line' },
  ]);

  check(
    '重新加载会先释放实时兜底（否则恢复的字幕永远显示不出来）',
    yt.calls.liveStopped > stoppedBeforeRetry,
    `liveStopped=${yt.calls.liveStopped}`
  );
  check(
    '重试成功后兜底确实处于停止状态',
    yt.store.state.liveMode === false,
    `liveMode=${yt.store.state.liveMode}`
  );
  // Ordering matters, not just the fact: the fallback must be released BEFORE the
  // recovered cues are published. If it were released after, `overlay.tick()`
  // would render the last scraped line over the first real cue.
  const ev = yt.calls.events;
  const lastStop = ev.lastIndexOf('liveStop');
  const lastCue = ev.lastIndexOf('setCues');
  check('释放兜底发生在本轮 setCues 之前', lastStop !== -1 && lastStop < lastCue, ev.join(' > '));
}

{
  // A non-empty body that parses to nothing. `canHandle: false` keeps the
  // realtime fallback out of the way so the whole-track path reaches its
  // failure branch. This is the case that used to masquerade as a network
  // problem: the data was right there and our parser dropped it.
  const yt = makeYouTube({ canHandle: false, body: 'WEBVTT-ish garbage that parses to nothing' });
  await yt.load([{ languageCode: 'en', baseUrl: 'https://example/t' }], []);
  check(
    '取回非空响应却解析不出时，reason 是 unparsed-track',
    yt.calls.reasons.includes('unparsed-track'),
    JSON.stringify(yt.calls.reasons)
  );
  const msg = (yt.calls.notices[0] || {}).msg || '';
  check('提示里说明数据已取回', /已取回/.test(msg), msg);
  check('提示里明确说重试无效', /重试无效/.test(msg), msg);
  // Advising a refresh here points at a network problem that does not exist.
  check('提示不再让人刷新重试', !/刷新/.test(msg), msg);
}

{
  // The other cause: nothing came back at all (the PoToken shape). Here a
  // reload genuinely can help, so the advice must stay the opposite one.
  const yt = makeYouTube({ canHandle: false, body: '' });
  await yt.load([{ languageCode: 'en', baseUrl: 'https://example/t' }], []);
  check(
    '响应为空时 reason 仍是 empty-track',
    yt.calls.reasons.includes('empty-track'),
    JSON.stringify(yt.calls.reasons)
  );
  const msg = (yt.calls.notices[0] || {}).msg || '';
  check('空响应的提示仍建议刷新重试', /刷新/.test(msg), msg);
  check('空响应的提示不谎称数据已取回', !/已取回/.test(msg), msg);
}

{
  // Fallback engaged AND the response was non-empty. `status: 'live'` alone says
  // what we fell back to, not what failed — the diagnostics page described every
  // degraded VOD as the PoToken timing problem, including this one, where the
  // cause was our parser and reloading could not possibly help.
  const yt = makeYouTube({ canHandle: true, body: 'not a caption format we know' });
  await yt.load([{ languageCode: 'en', baseUrl: 'https://example/t' }], []);
  check('兜底接管后仍记录真实原因', yt.calls.reasons.includes('unparsed-track'), JSON.stringify(yt.calls.reasons));
  check('仍然进入实时兜底', yt.calls.liveStarted === 1, `started=${yt.calls.liveStarted}`);
  check('原因不是空响应', !yt.calls.reasons.includes('empty-track'), JSON.stringify(yt.calls.reasons));
}

{
  // The PoToken shape: nothing came back, fallback engaged. Here the cause IS the
  // timing race, so it must stay on the other branch.
  const yt = makeYouTube({ canHandle: true, body: '' });
  await yt.load([{ languageCode: 'en', baseUrl: 'https://example/t' }], []);
  check('空响应兜底时原因记为 empty-track', yt.calls.reasons.includes('empty-track'), JSON.stringify(yt.calls.reasons));
  check('空响应不会记成解析问题', !yt.calls.reasons.includes('unparsed-track'), JSON.stringify(yt.calls.reasons));
}

{
  // The PLAYER's own caption response is a caption response. If it is non-empty
  // and our parser reads none of it, the fault is ours — but only the direct
  // fetches were counted, so a 4 KB body the player fetched was reported as the
  // PoToken timing race. Same wrong layer, one level further in.
  const yt = makeYouTube({ canHandle: false, body: '', wireBody: 'a player-fetched body we cannot parse' });
  await yt.load([{ languageCode: 'en', baseUrl: 'https://example/t' }], []);
  check(
    '播放器自己取回的非空响应也算进响应大小',
    yt.calls.reasons.includes('unparsed-track'),
    JSON.stringify(yt.calls.reasons)
  );
  check(
    '不会把播放器取回的数据说成「没取回来」',
    !yt.calls.reasons.includes('empty-track'),
    JSON.stringify(yt.calls.reasons)
  );
}

{
  // And the wire path must not invent a size: when the player fetched nothing
  // either, it is still the PoToken case.
  const yt = makeYouTube({ canHandle: false, body: '', wireBody: '' });
  await yt.load([{ languageCode: 'en', baseUrl: 'https://example/t' }], []);
  check(
    '播放器也没取回数据时仍是 empty-track',
    yt.calls.reasons.includes('empty-track'),
    JSON.stringify(yt.calls.reasons)
  );
}

// ---------------------------------------------------------------------------
console.log('');
if (passed !== EXPECTED_ASSERTIONS) {
  console.log(`FAIL assertion count drifted: the pin says ${EXPECTED_ASSERTIONS}, this run made ${passed}`);
  failed++;
}
if (failed === 0) {
  console.log(`${passed} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`${passed} passed, ${failed} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
