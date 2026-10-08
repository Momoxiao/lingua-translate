/**
 * Lingua — headless render check for the extension's HTML pages.
 *
 * Uses the locally installed Chrome in headless mode (no npm dependencies, no
 * CDP): a temporary copy of the page is written next to the original — so all
 * relative script/CSS paths keep working — with a chrome.* stub injected as the
 * first script. Any runtime error is written into the DOM, which we read back
 * via --dump-dom: a page that threw is reported as FAIL and the run exits
 * non-zero, so a broken demo can never ship as a plausible-looking screenshot.
 * A PNG screenshot is captured in the same run.
 *
 * Usage: node scripts/preview.mjs [outDir] [pageName]
 *
 * One page per invocation — a full pass is 10 separate runs, and this sandbox
 * kills a shell that launches Chrome more than a couple of times in a row.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveChrome } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || '/tmp/lingua-preview';
const ONLY = process.argv[3] || ''; // optional: render a single page by name
// Optional viewport-height override, so a very long page can be captured in
// readable slices (PREVIEW_HEIGHT=1100 node scripts/preview.mjs out options).
const HEIGHT = Number(process.env.PREVIEW_HEIGHT) || 0;
// Optional anchor, so a slice of a long page can be captured directly
// (PREVIEW_HASH=#language node scripts/preview.mjs out options).
const HASH = process.env.PREVIEW_HASH || '';

const chromePath = resolveChrome();
if (!chromePath) {
  console.error('No Chrome/Chromium/Edge binary found — skipping preview.');
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });

const STUB = (tabUrl, patch) => `
<script>
(() => {
  /*
   * The error reporter is installed FIRST and the whole stub is wrapped in a
   * try/catch. A stub that throws before it installs itself (a typo in the
   * settings literal, say) otherwise fails silently: window.chrome stays
   * undefined, the page quietly falls back to default settings, and the harness
   * reports a healthy render of the wrong thing.
   */
  function report(e) {
    let el = document.getElementById('__lingua_errs');
    if (!el) {
      el = document.createElement('div');
      el.id = '__lingua_errs';
      el.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c0392b;color:#fff;' +
        'font:11px/1.5 ui-monospace,monospace;padding:6px 8px;white-space:pre-wrap;word-break:break-all');
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent += 'ERR ' + String(e) + '\\n';
  }
  window.addEventListener('error', (e) => report(e.message));
  window.addEventListener('unhandledrejection', (e) => report('rejection: ' + ((e.reason && e.reason.message) || e.reason)));

  try {
  const TAB_URL = ${JSON.stringify(tabUrl)};
  const PATCH = ${JSON.stringify(patch || {})};
  function mergeDeep(base, patch) {
    for (const k of Object.keys(patch || {})) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) base[k] = mergeDeep(Object.assign({}, base[k]), v);
      else base[k] = v;
    }
    return base;
  }
  // Test hook, stripped before the patch reaches the settings store: makes the
  // tab refuse to answer, i.e. the page was opened before the extension was
  // installed. That is the single most common real failure, and the diagnostics
  // page exists to report it — so it has to be assertable, not just eyeballed.
  const DEAD = !!PATCH.__dead;
  delete PATCH.__dead;
  // Same idea for the state the tab reports. Some verdicts can only be asserted
  // if the fixture can put the page into that state, and the one that matters
  // most is "the video HAS caption tracks but the cue fetch came back empty":
  // the popup and the diagnostics page both used to describe that as "该视频没有
  // 可用字幕" while printing the track list an inch above it. Stripped before the
  // patch reaches the settings store, like __dead.
  const STATE_PATCH = PATCH.__state || {};
  delete PATCH.__state;
  // Locale used by the i18n catalogue. Headless Chrome inherits the host
  // machine's language, so tests that assert Chinese copy must pin it instead
  // of depending on the developer's machine.
  const LANG = PATCH.__lang || 'zh-CN';
  delete PATCH.__lang;
  const store = {
    'lingua:settings:v1': mergeDeep({
      enabled: true, provider: 'openai', sourceLang: 'auto', targetLang: 'zh-Hans',
      displayMode: 'bilingual', autoTranslate: true, hideNativeCaptions: true,
      fontSize: 24, bottomOffset: 12, textAlign: 'center', backgroundOpacity: 0.72,
      batchSize: 16, concurrency: 4, lookahead: 25, cacheEnabled: true, liveMode: false, debug: false,
      page: {
        autoTranslate: false, displayMode: 'bilingual', style: 'underline',
        batchSize: 12, maxChars: 1400, concurrency: 3, autoSites: [], skipSites: [],
        skipSelectors: '', translateInputs: false, profileMode: 'auto', profileNotes: ''
      },
      providers: {
        openai: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-demo', model: 'deepseek-chat', temperature: 0, prompt: '' },
        deepl: { baseUrl: 'https://api-free.deepl.com/v2/translate', apiKey: '', pro: false },
        google: { apiKey: '' },
        microsoft: { baseUrl: 'https://api.cognitive.microsofttranslator.com/translate', apiKey: '', region: '' },
        custom: { url: '', method: 'POST', apiKey: '', headers: '{}', body: '', responsePath: '' }
      }
    }, PATCH)
  };
  const listeners = [];
  const STATE = {
    url: TAB_URL,
    host: TAB_URL.indexOf('youtube') !== -1 ? 'youtube.com' : 'news.ycombinator.com',
    isWatchPage: TAB_URL.indexOf('/watch') !== -1,
    hasPageModule: true,
    bridgeAlive: true,
    bridgeError: '',
    subtitle: {
      status: 'translating', videoId: 'dQw4w9WgXcQ', liveMode: false, error: '',
      cueCount: 412, translated: 268,
      tracks: [
        { languageCode: 'en', name: 'English', kind: '' },
        { languageCode: 'en', name: 'English (auto-generated)', kind: 'asr' },
        { languageCode: 'ja', name: '日本語', kind: '' }
      ],
      sourceTrack: { languageCode: 'en', name: 'English' },
      enabled: true
    },
    page: {
      active: true, status: 'translating', total: 86, done: 34, error: '',
      mode: 'bilingual', style: 'underline', showOriginal: false, showBall: true,
      host: 'news.ycombinator.com', rule: 'manual', auto: false,
      profile: { id: 'forum', label: '社区讨论', confidence: 'auto' }
    },
    provider: 'openai', providerReady: true, targetLang: 'zh-Hans', enabled: true
  };
  mergeDeep(STATE, STATE_PATCH);
  window.chrome = {
    storage: {
      local: {
        get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: store[k] } : {}),
        set: (o) => { Object.assign(store, o); listeners.forEach(f => f(o, 'local')); return Promise.resolve(); },
        remove: (k) => { delete store[k]; return Promise.resolve(); }
      },
      onChanged: { addListener(f) { listeners.push(f); }, removeListener() {} }
    },
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: '1.0.0' }),
      // A character class, not /^\//: inside this template literal a backslash
      // escape collapses, and /^\// would be emitted as the invalid regex /^//,
      // which is a syntax error that kills the whole stub script.
      getURL: (p) => 'chrome-extension://preview/' + String(p).replace(/^[/]/, ''),
      openOptionsPage: () => {},
      onMessage: { addListener: () => {}, removeListener: () => {} },
      // Callbacks are synchronous on purpose: the page then settles inside the
      // microtask queue, i.e. before the load event, so the screenshot reflects
      // the real post-boot state. (With --virtual-time-budget, a setTimeout-based
      // stub can make style recalc lag behind the screenshot.)
      sendMessage: (msg, cb) => {
        const reply = { ok: true };
        if (msg && msg.type === 'lingua:test-provider') reply.sample = '你好，世界。';
        if (msg && msg.type === 'lingua:cache-stats') reply.stats = { entries: 1284 };
        if (cb) cb(reply);
      }
    },
    i18n: { getUILanguage: () => LANG },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: TAB_URL }]),
      get: (id) => Promise.resolve({ id, url: TAB_URL, title: 'Preview tab' }),
      create: () => Promise.resolve({}),
      sendMessage: (id, msg, cb) => {
        if (DEAD) {
          // chrome.runtime.lastError is only readable from inside the callback,
          // which is why it is set and cleared around the call rather than left on.
          window.chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
          if (cb) cb(undefined);
          window.chrome.runtime.lastError = undefined;
          return;
        }
        if (cb) cb({ ok: true, state: STATE });
      }
    }
  };
  } catch (e) {
    report('stub: ' + ((e && e.stack) || e));
  }
})();
</script>
`;

/**
 * The stub is injected as a <script>, and a syntax error inside it is the worst
 * possible failure mode: the whole block fails to parse, so its own try/catch and
 * error reporter never run, `window.chrome` is never installed, the page quietly
 * falls back to its defaults — and the harness reports a healthy render of the
 * wrong thing. Parsing it here turns that into a loud failure at startup.
 *
 * (Found the hard way: `.replace(/^\//, '')` inside this template literal emits
 * `/^//`, because a backslash escape collapses in a template literal.)
 */
function assertStubParses() {
  const raw = STUB('https://example.com/', {});
  const body = raw.slice(raw.indexOf('<script>') + 8, raw.lastIndexOf('</script>'));
  try {
    // Parses without executing; we only care that it is valid JavaScript.
    new Function(body);
  } catch (e) {
    console.error('preview stub does not parse — every page would render against a dead chrome.* stub:');
    console.error(`  ${e.message}`);
    process.exit(1);
  }
}
assertStubParses();

const POPUP_PAGE_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => window.addEventListener('load', r, { once: true }));
  await sleep(400);
  const tab = Array.prototype.slice.call(document.querySelectorAll('.tabs button'))
    .filter((b) => b.dataset.tab === 'page')[0];
  if (!tab) return;
  tab.click();
  await sleep(60);
  // The capture runs under --virtual-time-budget, which fast-forwards timers
  // but does not advance CSS transitions — a highlight that just started
  // would be photographed at its OLD value, making the screenshot disagree
  // with the DOM. Dropping the transition snaps it to the final state.
  document.querySelectorAll('.tabs button').forEach((b) => { b.style.transition = 'none'; });
})();`;

const PAGES = [
  // The light/dark flags are explicit: headless Chrome follows the OS
  // appearance, so without them the "light" screenshots would silently turn
  // dark on a dark-mode machine and the docs set would be wrong.
  { html: 'src/popup/popup.html', tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', width: 356, height: 499, name: 'popup', light: true },
  {
    // The same YouTube page, with the switcher used to reach web-page
    // translation — the reason the switcher exists at all.
    html: 'src/popup/popup.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    width: 356,
    height: 578,
    name: 'popup-yt-page',
    light: true,
    script: POPUP_PAGE_SCRIPT,
  },
  {
    // The English store listing uses the same page panel with an English UI.
    html: 'src/popup/popup.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    width: 356,
    height: 578,
    name: 'popup-yt-page-en',
    light: true,
    patch: { __lang: 'en-US' },
    script: POPUP_PAGE_SCRIPT,
  },
  { html: 'src/popup/popup.html', tabUrl: 'https://news.ycombinator.com/item?id=1', width: 356, height: 527, name: 'popup-page', light: true },
  { html: 'src/popup/popup.html', tabUrl: 'https://news.ycombinator.com/item?id=1', width: 356, height: 527, name: 'popup-page-dark', dark: true },
  { html: 'src/options/options.html', width: 1180, height: 2620, name: 'options', light: true },
  { html: 'src/options/options.html', width: 1180, height: 2620, name: 'options-en', light: true, patch: { __lang: 'en-US' } },
  { html: 'src/options/options.html', width: 1180, height: 2620, name: 'options-dark', dark: true },
  // the custom provider is the one pane with hand-written HTTP in it, so it gets
  // its own screenshot (configured, so the diagnostics have something to say)
  {
    html: 'src/options/options.html',
    width: 1180,
    height: 1500,
    name: 'options-custom',
    light: true,
    patch: {
      provider: 'custom',
      providers: {
        custom: {
          url: 'http://localhost:1188/translate',
          method: 'POST',
          apiKey: 'sk-demo',
          headers: '{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer {{key}}"\n}',
          body: '{\n  "text": "{{text}}",\n  "source_lang": "{{from}}",\n  "target_lang": "{{to}}"\n}',
          responsePath: 'data',
        },
      },
    },
  },
  // The diagnostics page exists to be read by whoever triages an issue, so it
  // gets a screenshot too — pointed at a YouTube watch page, which is the case
  // people actually file issues about.
  {
    html: 'src/diagnostics/diagnostics.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    width: 900,
    height: 900,
    name: 'diagnostics',
    light: true,
  },
  {
    html: 'src/diagnostics/diagnostics.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    width: 900,
    height: 900,
    name: 'diagnostics-en',
    light: true,
    patch: { __lang: 'en-US' },
  },
  { build: buildPageDemo, mode: 'bilingual', style: 'underline', width: 900, height: 1180, name: 'page-bilingual' },
  { build: buildPageDemo, mode: 'replace', style: 'highlight', width: 900, height: 1180, name: 'page-replace' },
  { build: buildBallDemo, state: 'translating', width: 760, height: 420, name: 'ball' },

  // The headline feature. Rendered at 16:9 in both sizes it is needed in: 2x for
  // the README, and an exact 1280x800 for the store canvas composited later.
  { build: buildPlayerDemo, width: 1280, height: 720, name: 'player-yt' },
  { build: buildPlayerDemo, width: 1280, height: 720, scale: 1, name: 'player-yt-1x' },
];

/**
 * Demo page for the floating ball. The ball lives in a shadow root, so it can
 * only be previewed by actually mounting it — hence a generated page.
 */
function buildBallDemo() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lingua floating ball</title>
<style>
  body{margin:0;background:#fbf8f4;color:#1a1714;
    font:15px/1.7 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"PingFang SC",sans-serif;}
  .page{max-width:620px;margin:0 auto;padding:30px 28px}
  h1{font:600 23px/1.3 "Iowan Old Style",Palatino,Georgia,serif;margin:0 0 10px}
  p{color:#332e28;margin:0 0 14px}
  .hint{font-size:12.5px;color:#8a7f74;border-top:1px solid #e6ddd1;padding-top:14px;margin-top:22px}
</style></head>
<body>
<div class="page">
  <h1>悬浮球（悬停滑出 + 面板展开）</h1>
  <p>平时贴边半隐藏，只露出一小条；鼠标移上去才滑出来。点击即翻译，可拖动，位置按站点记住。</p>
  <p>外圈就是进度环，不需要额外的进度条。悬停向左展开操作面板：暂时收起译文 / 重新翻译 / 停止。右键打开设置。</p>
  <p>三处不可见的悬停桥：球与面板之间、贴边滑走后让出的那条带、以及进度环所在的一圈。少任何一处，鼠标移过去都会中途丢失 hover，球就缩回去。</p>
  <p class="hint">下面是状态预览（静态截图，实际可交互）</p>
</div>
<!-- constants.js first: ball.js reads its font stack from Lingua.constants.FONTS,
     so loading ball.js alone throws at parse time and the ball never mounts. -->
<script src="src/shared/constants.js"></script>
<script src="src/content/page/ball.js"></script>
<script>
(function () {
  // minimal chrome stub so ball.js can read its saved position
  window.chrome = {
    storage: { local: {
      get: function () { return Promise.resolve({}); },
      set: function () { return Promise.resolve(); }
    } },
    runtime: { id: 'preview', lastError: undefined, sendMessage: function () {} }
  };
  function report(e) {
    // Same id as every other demo page, so one convention covers them all.
    var el = document.getElementById('__lingua_errs');
    if (!el) {
      el = document.createElement('div');
      el.id = '__lingua_errs';
      el.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c0392b;color:#fff;' +
        'font:11px/1.5 ui-monospace,monospace;padding:6px 8px;white-space:pre-wrap');
      document.body.appendChild(el);
    }
    el.textContent += 'ERR ' + String(e) + '\\n';
  }
  window.addEventListener('error', function (e) { report(e.message); });

  Lingua.page.ball.mount({
    onToggle: function () {}, onRetranslate: function () {},
    onStop: function () {}, onToggleOriginal: function () { return false; },
    onOpenSettings: function () {}
  });
  Lingua.page.ball.setStatus({ active: true, status: 'done', done: 442, total: 442, error: '' });
  // force the hover panel open for the screenshot
  var wrap = document.getElementById('lingua-ball').shadowRoot.querySelector('.wrap');
  wrap.classList.add('pinned');
})();
</script>
</body></html>`;
}

/**
 * The headline feature, finally with a picture.
 *
 * Why this is a fixture and not a capture: the caption pipeline cannot be
 * driven in automation. As the README's "Known limitations" section records,
 * the player only requests a caption track once it is genuinely playing and
 * rendering captions, and neither a headless window nor a background tab ever
 * gets there — so no automated run can photograph real captions.
 *
 * What is mocked is only the frame and the player chrome. The subtitle overlay
 * is the real `src/content/overlay.js` running its real CSS through its real
 * `setLive()` render path, so this cannot drift from what users actually see:
 * change the overlay's font size, colours or spacing and this image changes too.
 *
 * `PLAYER_CUE=<n>` selects which pair of lines is on screen, which is how the
 * animated demo is built — one render per cue, assembled afterwards.
 */
function buildPlayerDemo() {
  const LINES = [
    {
      original: 'The caption request is signed, so a plain fetch comes back empty.',
      translated: '字幕请求是带签名的，所以普通 fetch 会返回空。',
    },
    {
      original: 'HTTP 200 with a zero-byte body — a failure that looks like success.',
      translated: 'HTTP 200，响应体却是 0 字节——一个看起来像成功的失败。',
    },
    {
      original: 'So we reuse the token the player already obtained.',
      translated: '于是我们复用播放器已经拿到的那个令牌。',
    },
    {
      original: 'Drag the scrubber and the priority re-sorts around the playhead.',
      translated: '拖动进度条，优先级会围绕播放头重新排序。',
    },
  ];
  const i = Math.max(0, Math.min(LINES.length - 1, Number(process.env.PLAYER_CUE) || 0));
  const line = LINES[i];
  const progress = [24, 38, 52, 66][i];
  const clock = ['5:41', '7:12', '9:03', '10:48'][i];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lingua — bilingual YouTube subtitles</title>
<style>
  :root{ color-scheme: dark; }
  *{ box-sizing:border-box; }
  html,body{ margin:0; height:100%; overflow:hidden; background:#0f0f0f;
    font-family:Roboto,"Segoe UI",ui-sans-serif,-apple-system,"PingFang SC",sans-serif; }

  /* ---- the "video frame": an out-of-focus shot, so the captions carry it ----
     Deliberately an empty, blurred room rather than a synthesised person: a
     painted-on face reads as uncanny at a glance, and a mock that looks wrong
     costs more trust than a plain one. Nothing here claims to be a capture. */
  #movie_player{ position:relative; width:100vw; height:100vh; overflow:hidden; background:#000; }
  .frame{ position:absolute; inset:0;
    background:
      radial-gradient(42% 58% at 20% 30%, rgba(255,192,126,.62), rgba(255,192,126,0) 70%),
      radial-gradient(34% 48% at 83% 22%, rgba(104,140,186,.40), rgba(104,140,186,0) 74%),
      radial-gradient(28% 40% at 62% 74%, rgba(226,150,96,.24), rgba(226,150,96,0) 72%),
      linear-gradient(166deg,#413224 0%,#2a201a 44%,#131110 100%); }
  /* Out-of-focus highlights, sized and placed like practical lights in a room,
     with a shallow-depth spread so they do not read as flat circles. */
  .bokeh{ position:absolute; border-radius:50%; filter:blur(17px);
    background:radial-gradient(circle,rgba(255,226,186,.95),rgba(255,226,186,0) 68%); }
  .b1{ width:74px;  height:74px;  left:7%;   top:14%;  opacity:.34; }
  .b2{ width:46px;  height:46px;  left:15%;  top:26%;  opacity:.22; }
  .b3{ width:58px;  height:58px;  left:88%;  top:58%;  opacity:.20; }
  .b4{ width:38px;  height:38px;  left:70%;  top:11%;  opacity:.17; }
  .b5{ width:52px;  height:52px;  left:93%;  top:30%;  opacity:.15; }
  .b6{ width:34px;  height:34px;  left:76%;  top:40%;  opacity:.13; }
  .vignette{ position:absolute; inset:0;
    background:radial-gradient(126% 96% at 46% 44%, rgba(0,0,0,0) 36%, rgba(0,0,0,.74) 100%); }

  /* ---- mocked YouTube player chrome ---- */
  .ytp-gradient-top{ position:absolute; left:0; right:0; top:0; height:140px;
    background:linear-gradient(rgba(0,0,0,.62),rgba(0,0,0,0)); }
  .ytp-chrome-top{ position:absolute; left:0; right:0; top:0; padding:16px 20px; }
  .ytp-title-text{ display:block; max-width:74%; color:#fff; font-size:18px; line-height:1.35;
    font-weight:400; text-shadow:0 1px 2px rgba(0,0,0,.8);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ytp-chrome-bottom{ position:absolute; left:0; right:0; bottom:0; padding:0 20px 14px;
    background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.72)); }
  .ytp-progress-bar{ position:relative; height:5px; border-radius:3px;
    background:rgba(255,255,255,.28); margin-bottom:11px; }
  .ytp-play-progress{ position:absolute; left:0; top:0; bottom:0; border-radius:3px; background:#ff0033; }
  .ytp-scrubber{ position:absolute; top:50%; width:13px; height:13px; margin:-6.5px 0 0 -6.5px;
    border-radius:50%; background:#ff0033; }
  .ytp-controls{ display:flex; align-items:center; gap:19px; color:#fff; font-size:15px; }
  .ic{ opacity:.95; font-size:17px; line-height:1; }
  .ic.cc{ font-size:14px; font-weight:700; letter-spacing:.5px;
    border:1.5px solid rgba(255,255,255,.9); border-radius:3px; padding:1px 3px; }
  .ytp-time{ font-size:14px; opacity:.92; font-variant-numeric:tabular-nums; }
  .spacer{ flex:1; }
</style></head>
<body>
<div id="movie_player" class="html5-video-player">
  <div class="frame"></div>
  <div class="bokeh b1"></div><div class="bokeh b2"></div><div class="bokeh b3"></div>
  <div class="bokeh b4"></div><div class="bokeh b5"></div><div class="bokeh b6"></div>
  <div class="vignette"></div>
  <!-- pickVideo() needs a real <video> to exist; live mode drives the text, not currentTime -->
  <video class="html5-main-video" muted playsinline></video>

  <div class="ytp-gradient-top"></div>
  <div class="ytp-chrome-top">
    <span class="ytp-title-text">Signed caption requests — why a plain fetch returns nothing</span>
  </div>
  <div class="ytp-chrome-bottom">
    <div class="ytp-progress-bar">
      <div class="ytp-play-progress" style="width:${progress}%"></div>
      <div class="ytp-scrubber" style="left:${progress}%"></div>
    </div>
    <div class="ytp-controls">
      <span class="ic">&#9654;</span>
      <span class="ic">&#9199;</span>
      <span class="ic">&#128266;</span>
      <span class="ytp-time">${clock} / 18:56</span>
      <span class="spacer"></span>
      <span class="ic cc">CC</span>
      <span class="ic">&#9881;</span>
      <span class="ic">&#9974;</span>
    </div>
  </div>
</div>

<!-- constants.js and store.js first: overlay.js reads its font stack and its
     settings store at render time, so loading overlay.js alone throws and nothing
     mounts. This used to omit store.js and hide the error behind a delayed,
     no-op assertion; the demo page now proves the real render path immediately. -->
<script src="src/shared/constants.js"></script>
<script src="src/content/store.js"></script>
<script src="src/content/overlay.js"></script>
<script>
(function () {
  function report(e) {
    var el = document.getElementById('__lingua_errs');
    if (!el) {
      el = document.createElement('div');
      el.id = '__lingua_errs';
      el.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c0392b;color:#fff;' +
        'font:11px/1.5 ui-monospace,monospace;padding:6px 8px;white-space:pre-wrap');
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent += 'ERR ' + String(e) + '\\n';
  }
  window.addEventListener('error', function (e) { report(e.message); });

  // Fail loudly rather than shipping a plausible-looking picture of nothing: if
  // the overlay did not mount, the demo is worthless as a screenshot.
  function fail(msg) { report(msg); }
  try {
    if (!Lingua || !Lingua.overlay) throw new Error('overlay.js did not register Lingua.overlay');
    if (!Lingua.overlay.mount()) throw new Error('overlay.mount() found no #movie_player');

    Lingua.overlay.applyStyles({
      fontSize: 26, bottomOffset: 11, backgroundOpacity: 0.72,
      textAlign: 'center', displayMode: 'bilingual', hideNativeCaptions: true
    });
    Lingua.overlay.setVisible(true);

    // The real render path: live mode renders exactly what it is handed, so the
    // screenshot does not depend on a <video> actually playing.
    Lingua.overlay.setLive(${JSON.stringify(line.original)}, ${JSON.stringify(line.translated)});
    Lingua.overlay.start();

    // setLive() stores the text; the next animation frame writes it to the DOM.
    // Check the actual rendered values, not the arguments, so a missing
    // dependency or a broken overlay is reported by the demo itself.
    requestAnimationFrame(function () {
      var t = document.querySelector('.lingua-translated');
      var o = document.querySelector('.lingua-original');
      if (!t || t.textContent !== ${JSON.stringify(line.translated)}) {
        fail('translated line did not render through setLive()');
      }
      if (!o || o.textContent !== ${JSON.stringify(line.original)}) {
        fail('original line did not render through setLive()');
      }
    });
  } catch (e) { fail(e && e.message ? e.message : e); }
})();
</script>
</body></html>`;
}

/**
 * A generated demo page: loads the real units.js + render.js against a
 * realistic article layout, then applies fake translations so the layout can be
 * eyeballed. Also proves the renderer does not disturb flex/grid/nav layout.
 */
function buildPageDemo({ mode, style }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lingua page translation demo</title>
<style>
  :root{ color-scheme: light; }
  body{margin:0;background:#fbf8f4;color:#1a1714;
    font:15px/1.65 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"PingFang SC",sans-serif;}
  nav{display:flex;gap:22px;align-items:center;padding:14px 28px;border-bottom:1px solid #e6ddd1;background:#fff;}
  nav a{color:#4a423a;text-decoration:none;font-weight:600;font-size:14px;}
  main{max-width:720px;margin:0 auto;padding:34px 28px 60px;}
  h1{font:600 30px/1.25 "Iowan Old Style",Palatino,Georgia,serif;margin:0 0 10px;}
  h2{font:600 19px/1.3 "Iowan Old Style",Palatino,Georgia,serif;margin:30px 0 8px;}
  p{margin:0 0 16px;color:#332e28;}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0 24px;}
  .card{border:1px solid #e6ddd1;border-radius:12px;padding:12px;background:#fff;}
  .card b{display:block;font-size:13px;margin-bottom:4px;}
  .card span{font-size:12.5px;color:#7d7368;}
  ul{padding-left:20px;} li{margin-bottom:6px;}
  pre{background:#221e19;color:#f6f1ea;padding:14px;border-radius:10px;font:12.5px/1.6 ui-monospace,monospace;overflow:auto;}
  table{border-collapse:collapse;width:100%;margin:12px 0 20px;font-size:14px;}
  td,th{border:1px solid #e6ddd1;padding:8px 10px;text-align:left;}
  footer{border-top:1px solid #e6ddd1;padding:18px 28px;color:#7d7368;font-size:12.5px;background:#fff;}
</style></head>
<body>
<nav><a href="#">Home</a><a href="#">Documentation</a><a href="#">Pricing</a></nav>
<main>
  <h1>Build a translation extension that survives real websites</h1>
  <p>This paragraph mixes <b>inline markup</b>, a <a href="#">link</a> and plain text, so the whole run must be
     treated as a single translation unit instead of three fragments.</p>
  <h2>What the layout test covers</h2>
  <div class="cards">
    <div class="card"><b>Flex &amp; grid</b><span>Containers are never rewritten, so layout stays intact.</span></div>
    <div class="card"><b>Nested blocks</b><span>Each leaf block becomes its own unit.</span></div>
    <div class="card"><b>Skip rules</b><span>Code, forms and opt-out markers are left alone.</span></div>
  </div>
  <ul>
    <li>Priority follows the viewport, so visible text is translated first.</li>
    <li>Dynamically added content is picked up by a debounced observer.</li>
  </ul>
  <pre><code>const units = Lingua.page.units.collect(document.body);
// code blocks are never touched</code></pre>
  <table><tbody>
    <tr><th>Mode</th><th>Result</th></tr>
    <tr><td>Bilingual</td><td>Original text stays, translation is appended below.</td></tr>
    <tr><td>Replace</td><td>Original is wrapped and hidden, toggling is a class flip.</td></tr>
  </tbody></table>
</main>
<footer>Lingua demo fixture — no network requests are made.</footer>

<script src="src/content/page/units.js"></script>
<script src="src/content/page/render.js"></script>
<script>
(function () {
  function report(e) {
    var el = document.getElementById('__lingua_errs');
    if (!el) {
      el = document.createElement('div');
      el.id = '__lingua_errs';
      el.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c0392b;color:#fff;' +
        'font:11px/1.5 ui-monospace,monospace;padding:6px 8px;white-space:pre-wrap');
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent += 'ERR ' + String(e) + '\\n';
  }
  window.addEventListener('error', function (e) { report(e.message); });
  /*
   * Real translations, keyed by the fixture's English source text.
   *
   * This used to repeat one filler sentence until it reached the source length,
   * purely to test line wrapping. That was fine as a layout test and wrong as a
   * README screenshot: the hero image for every English reader showed the same
   * Chinese sentence looping down the page, which reads as a machine that has
   * lost the plot. The lengths still vary, so the wrap test still holds.
   *
   * A miss falls back to the old filler, so adding a paragraph to the fixture
   * degrades to a layout test rather than to a blank unit.
   */
  var ZH = {
    'Home': '首页',
    'Documentation': '文档',
    'Pricing': '定价',
    'Build a translation extension that survives real websites': '做一个能在真实网站上活下来的翻译扩展',
    'This paragraph mixes inline markup, a link and plain text, so the whole run must be treated as a single translation unit instead of three fragments.': '这一段混排了行内标记、一个链接和纯文本，所以整段必须当成一个翻译单元，而不是三个碎片。',
    'What the layout test covers': '排版测试覆盖了什么',
    'Flex & grid': '弹性盒与网格',
    'Containers are never rewritten, so layout stays intact.': '容器永远不会被重写，所以版式保持不变。',
    'Nested blocks': '嵌套块',
    'Each leaf block becomes its own unit.': '每个叶子块各自成为一个单元。',
    'Skip rules': '跳过规则',
    'Code, forms and opt-out markers are left alone.': '代码、表单和退出标记一律不碰。',
    'Priority follows the viewport, so visible text is translated first.': '优先级跟随视口，所以可见文本先被翻译。',
    'Dynamically added content is picked up by a debounced observer.': '动态加入的内容由去抖观察器接住。',
    'Mode': '模式',
    'Result': '结果',
    'Bilingual': '双语',
    'Original text stays, translation is appended below.': '原文保留，译文附在下面。',
    'Replace': '仅译文',
    'Original is wrapped and hidden, toggling is a class flip.': '原文被包裹并隐藏，切换只是一个 class 翻转。',
    'Lingua demo fixture — no network requests are made.': 'Lingua 演示页——不发起任何网络请求。'
  };
  /*
   * Translations for blocks that contain a link.
   *
   * Keyed by the marker-stripped source, valued with the marker pair already in
   * place around the translated link text. Writing these out by hand beats
   * re-inserting the markers programmatically: where a link lands in the
   * translated sentence is a translation decision (Chinese word order moves it),
   * not something a position ratio can guess.
   */
  var ZH_LINKED = {
    'This paragraph mixes inline markup, a link and plain text, so the whole run must be treated as a single translation unit instead of three fragments.':
      '这一段混排了行内标记、一个⟦1⟧链接⟦/1⟧和纯文本，所以整段必须当成一个翻译单元，而不是三个碎片。'
  };
  function fake(text) {
    if (ZH[text]) return ZH[text];
    // Strip marker pairs, and the stray space units.js leaves before punctuation.
    // Every backslash below is doubled on purpose: this fixture is ONE JS template
    // literal, so the outer literal eats a lone backslash-d or backslash-s and the
    // regex that reaches the page is a different (still valid) one matching
    // nothing. That is how the translations above briefly vanished. For the same
    // reason there must be no backtick anywhere in this fixture.
    var plain = text.replace(/⟦\\/?\\d+⟧/g, '').replace(/\\s+([,.!?;:])/g, '$1');
    if (ZH_LINKED[plain]) return ZH_LINKED[plain];
    if (ZH[plain]) return ZH[plain];
    var len = Math.min(70, Math.max(2, Math.round(text.length / 2)));
    var base = '（未提供该句的示例译文）';
    var out = '';
    while (out.length < len) out += base;
    return out.slice(0, len);
  }
  var units = Lingua.page.units.collect(document.body, { skipSelectors: '' });
  Lingua.page.render.ensureStyle();
  units.forEach(function (u) {
    Lingua.page.render.apply(u, fake(u.text), { mode: ${JSON.stringify(mode)}, style: ${JSON.stringify(style)} });
  });
})();
</script>
</body></html>`;
}

let bad = 0;

/**
 * Render one page with headless Chrome.
 *
 * Chrome does not exit after writing a screenshot, so a blocking spawnSync sits
 * on its timeout for every single page — 60s x 10 pages of doing nothing. Bail
 * out as soon as the closing tag arrives instead; test-dom.mjs and check-pages
 * already use this trick.
 *
 * `--dump-dom` rides along in the same run on purpose. It costs nothing extra
 * and it is the only way to notice a fixture that threw: a demo page whose
 * script list has drifted from its module's imports renders a red banner
 * instead of the component, and the bare screenshot looks like a plausible but
 * empty page rather than a failure.
 */
function renderChrome(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        /* ignore */
      }
      resolve({ stdout: out, stderr: err });
    };
    const timer = setTimeout(finish, timeoutMs);
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (out.includes('</html>')) setTimeout(finish, 80);
    });
    proc.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    proc.on('exit', () => setTimeout(finish, 80));
  });
}

/**
 * Headless Chrome follows the OS appearance, so a machine in dark mode renders
 * every page dark. To preview the other half of the theme the palette has to be
 * forced. Extract it from theme.css rather than duplicating the values here —
 * otherwise the preview silently drifts from the real theme.
 *
 * The override is injected after the stylesheets, so a later `:root` rule wins
 * over the media-query block that theme.css already contains.
 */
function themeOverride(which) {
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/theme.css'), 'utf8');
  if (which === 'dark') {
    const m = css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n\s*\}\s*\n\}/);
    if (!m) throw new Error('could not extract the dark theme block from theme.css');
    return `<style id="__force-dark">\n:root{${m[1]}}\n</style>`;
  }
  const m = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!m) throw new Error('could not extract the light theme block from theme.css');
  return `<style id="__force-light">\n:root{${m[1]}}\n</style>`;
}

for (const page of PAGES) {
  if (ONLY && page.name !== ONLY) continue;
  let srcPath;
  let tmpPath;
  let tmpDir;
  const override = page.dark ? themeOverride('dark') : page.light ? themeOverride('light') : '';
  const baseHref = pathToFileURL(
    page.build ? ROOT + path.sep : path.dirname(path.join(ROOT, page.html)) + path.sep
  ).href;

  // Keep generated pages out of the extension tree. Chrome refuses to load an
  // unpacked extension while a sibling filename starts with "_", which made
  // `npm run preview` and `npm run test:e2e` fail when run in parallel.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `lingua-preview-${page.name}-`));
  tmpPath = path.join(tmpDir, 'page.html');

  if (page.build) {
    let html = page.build(page);
    html = html.replace(/<head([^>]*)>/i, (m) => `${m}\n<base href="${baseHref}">`);
    if (override) html = html.replace(/<\/head>/i, `${override}</head>`);
    fs.writeFileSync(tmpPath, html);
  } else {
    srcPath = path.join(ROOT, page.html);
    let html = fs.readFileSync(srcPath, 'utf8');
    html = html.replace(
      /<head([^>]*)>/i,
      (m) => `${m}\n<base href="${baseHref}">\n${STUB(page.tabUrl || 'https://example.com/', page.patch)}`
    );
    if (override) html = html.replace(/<\/head>/i, `${override}</head>`);
    // `script` lets a page entry drive the UI into the state worth photographing
    // (e.g. the popup's second panel) before the capture.
    if (page.script) html = html.replace(/<\/body>/i, `<script>${page.script}</script></body>`);
    fs.writeFileSync(tmpPath, html);
  }

  const shotPath = path.join(OUT, `${page.name}.png`);
  const height = HEIGHT || page.height;
  // A fresh, throwaway profile per render. Two reasons: a persistent
  // --user-data-dir caches file:// resources (edit a fixture, get a stale
  // screenshot), and writing it next to the output would litter the repo.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `lingua-preview-${page.name}-`));
  const base = [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    `--user-data-dir=${profileDir}`,
    `--window-size=${page.width},${height}`,
    // 2x by default, so README images stay crisp on retina. A page that has to
    // come out at an exact pixel size (the 1280x800 store canvases) sets
    // `scale: 1`, because a store screenshot is measured, not displayed.
    `--force-device-scale-factor=${page.scale || 2}`,
    '--virtual-time-budget=3500',
    `--screenshot=${shotPath}`,
    '--dump-dom',
    `file://${tmpPath}${HASH}`,
  ];

  const run = await renderChrome(base);

  // Best-effort: Chrome may still be flushing its cache into the profile
  // directory, and an ENOTEMPTY here would abort the whole render pass. The
  // directory lives in os.tmpdir(), so a leftover copy costs nothing.
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  // PREVIEW_KEEP_TMP=1 keeps the generated page so it can be opened by hand —
  // the fastest way to see what the harness actually handed to Chrome.
  if (!process.env.PREVIEW_KEEP_TMP) fs.rmSync(tmpDir, { recursive: true, force: true });
  else console.log('      kept: ' + tmpPath);

  const label = page.html || page.name;
  // A demo page that threw leaves a red banner in the DOM instead of the
  // component under test. Without this the render is reported as "ok" and the
  // broken screenshot ships in the README.
  const errBanner = /id="__lingua_errs"[^>]*>([\s\S]*?)<\/div>/.exec(run.stdout);
  if (errBanner) {
    bad++;
    console.log(`FAIL ${label} — page reported an error`);
    console.log(`      ${errBanner[1].trim().split('\n').slice(0, 3).join(' | ')}`);
  } else if (!fs.existsSync(shotPath)) {
    bad++;
    console.log(`FAIL ${label} — no screenshot produced`);
    const stderr = (run.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' | ');
    if (stderr) console.log(`      ${stderr}`);
  } else {
    console.log(`ok   ${label} — rendered`);
  }
  console.log(`      screenshot: ${shotPath}`);
}

process.exitCode = bad ? 1 : 0;
