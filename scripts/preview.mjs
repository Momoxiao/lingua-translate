/**
 * Lingua — headless render check for the extension's HTML pages.
 *
 * Uses the locally installed Chrome in headless mode (no npm dependencies, no
 * CDP): a temporary copy of the page is written next to the original — so all
 * relative script/CSS paths keep working — with a chrome.* stub injected as the
 * first script. Any runtime error is written into the DOM, which we read back
 * via --dump-dom. A PNG screenshot is captured alongside it.
 *
 * Usage: node scripts/preview.mjs [outDir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || '/tmp/lingua-preview';
const ONLY = process.argv[3] || ''; // optional: render a single page by name
// Optional viewport-height override, so a very long page can be captured in
// readable slices (PREVIEW_HEIGHT=1100 node scripts/preview.mjs out options).
const HEIGHT = Number(process.env.PREVIEW_HEIGHT) || 0;
// Optional anchor, so a slice of a long page can be captured directly
// (PREVIEW_HASH=#language node scripts/preview.mjs out options).
const HASH = process.env.PREVIEW_HASH || '';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
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
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: TAB_URL }]),
      sendMessage: (id, msg, cb) => {
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
    script: `(async () => {
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
    })();`,
  },
  { html: 'src/popup/popup.html', tabUrl: 'https://news.ycombinator.com/item?id=1', width: 356, height: 527, name: 'popup-page', light: true },
  { html: 'src/popup/popup.html', tabUrl: 'https://news.ycombinator.com/item?id=1', width: 356, height: 527, name: 'popup-page-dark', dark: true },
  { html: 'src/options/options.html', width: 1180, height: 2620, name: 'options', light: true },
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
  { build: buildPageDemo, mode: 'bilingual', style: 'underline', width: 900, height: 1180, name: 'page-bilingual' },
  { build: buildPageDemo, mode: 'replace', style: 'highlight', width: 900, height: 1180, name: 'page-replace' },
  { build: buildBallDemo, state: 'translating', width: 760, height: 420, name: 'ball' },
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
  <p>外圈就是进度环，不需要额外的进度条。悬停向左展开操作面板：只显示原文 / 重新翻译 / 停止。右键打开设置。</p>
  <p>三处不可见的悬停桥：球与面板之间、贴边滑走后让出的那条带、以及进度环所在的一圈。少任何一处，鼠标移过去都会中途丢失 hover，球就缩回去。</p>
  <p class="hint">下面是状态预览（静态截图，实际可交互）</p>
</div>
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
    var el = document.getElementById('__errs');
    if (!el) {
      el = document.createElement('div');
      el.id = '__errs';
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
  function fake(text) {
    var n = Math.min(70, Math.max(2, Math.round(text.length / 2)));
    var base = '这是用于验证双语排版的示例译文，长度与原文大致接近。';
    var out = '';
    while (out.length < n) out += base;
    return out.slice(0, n);
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
  const override = page.dark ? themeOverride('dark') : page.light ? themeOverride('light') : '';

  if (page.build) {
    tmpPath = path.join(ROOT, '__preview-' + page.name + '.html');
    let html = page.build(page);
    if (override) html = html.replace(/<\/head>/i, `${override}</head>`);
    fs.writeFileSync(tmpPath, html);
  } else {
    srcPath = path.join(ROOT, page.html);
    const dir = path.dirname(srcPath);
    tmpPath = path.join(dir, '__preview.html');
    let html = fs.readFileSync(srcPath, 'utf8');
    html = html.replace(/<head([^>]*)>/i, (m) => `${m}\n${STUB(page.tabUrl || 'https://example.com/', page.patch)}`);
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
    '--force-device-scale-factor=2',
    '--virtual-time-budget=3500',
    `--screenshot=${shotPath}`,
    `file://${tmpPath}${HASH}`,
  ];

  const run = spawnSync(chromePath, base, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });

  // Best-effort: Chrome may still be flushing its cache into the profile
  // directory, and an ENOTEMPTY here would abort the whole render pass. The
  // directory lives in os.tmpdir(), so a leftover copy costs nothing.
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  fs.unlinkSync(tmpPath);

  const label = page.html || page.name;
  if (!fs.existsSync(shotPath)) {
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
