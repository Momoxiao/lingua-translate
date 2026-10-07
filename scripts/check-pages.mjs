/**
 * Lingua — runtime-error smoke check for the extension's own HTML pages.
 *
 * The preview harness (scripts/preview.mjs) injects a chrome.* stub and renders
 * any uncaught error as a red banner with id="__lingua_errs". This script reuses
 * that stub, dumps the DOM, and fails if the banner is non-empty — i.e. if the
 * popup or the options page throws while booting.
 *
 * Usage: node scripts/check-pages.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveChrome } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const chromePath = resolveChrome();
if (!chromePath) {
  console.log('No Chrome/Chromium binary found — skipping page check.');
  process.exit(0);
}

/** Reuse the stub from preview.mjs so the two harnesses cannot drift apart. */
function loadStub() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/preview.mjs'), 'utf8');
  const m = src.match(/const STUB = \(tabUrl, patch\) => `([\s\S]*?)`;\n/);
  if (!m) throw new Error('could not extract STUB from scripts/preview.mjs');
  // eslint-disable-next-line no-new-func
  const stub = new Function('return (tabUrl, patch) => `' + m[1] + '`;')();

  // The injected block is a <script>. If it does not parse, its own try/catch
  // and error reporter never run, window.chrome is never installed, and every
  // page silently falls back to defaults — which these assertions would happily
  // pass. Parse it once, up front.
  const raw = stub('https://example.com/', {});
  try {
    // eslint-disable-next-line no-new-func
    new Function(raw.slice(raw.indexOf('<script>') + 8, raw.lastIndexOf('</script>')));
  } catch (e) {
    console.error('the injected chrome.* stub does not parse:');
    console.error(`  ${e.message}`);
    process.exit(1);
  }
  return stub;
}

const STUB = loadStub();

/**
 * Interaction probe for the settings page.
 *
 * Switching provider is the one place where the pane below the picker has to be
 * rebuilt from freshly-saved settings. Rendering it before the async save has
 * resolved leaves the pane showing the PREVIOUS service while the card says the
 * new one — the two halves of the screen disagree. This probe clicks a card and
 * reports both halves, so the mismatch can never come back silently.
 */
const OPTIONS_PROBE = `
<script>
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const name = (card) => (card ? (card.querySelector('.providerCard__name') || {}).textContent || '' : '');
  const cards = () => Array.prototype.slice.call(document.querySelectorAll('.providerCard'));
  const pick = (label) => cards().filter((c) => name(c) === label)[0];
  const issueCount = (tone) => document.querySelectorAll('#customIssues .customAids__issue[data-tone="' + tone + '"]').length;

  function snap() {
    const s = $('paneStatus');
    return {
      pane: $('paneTitle').textContent,
      pressed: name(document.querySelector('.providerCard[aria-pressed="true"]')),
      status: s.textContent,
      state: s.dataset.state || '',
      fields: Array.prototype.map
        .call(document.querySelectorAll('#fields input, #fields select, #fields textarea'), (i) => i.id)
        .join(','),
    };
  }
  function type(id, value) {
    const el = $(id);
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function report(payload) {
    const el = document.createElement('pre');
    el.id = '__probe';
    el.textContent = JSON.stringify(payload);
    document.body.appendChild(el);
  }

  try {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
    await sleep(300);

    const before = snap();
    const heightBefore = document.documentElement.scrollHeight;
    const google = pick('Google 翻译');
    if (!google) {
      report({ error: 'provider card not found', cards: cards().map(name) });
      return;
    }
    google.click();
    await sleep(250);
    const afterGoogle = snap();

    // Walk every provider in turn, so a picker/pane mismatch or a
    // self-contradictory status line is caught for all of them.
    const all = [];
    for (const label of ['OpenAI 兼容', 'DeepL', 'Google 翻译', '微软 Azure', '自定义供应商']) {
      const card = pick(label);
      if (!card) continue;
      card.click();
      await sleep(140);
      all.push(Object.assign(snap(), { card: label }));
    }

    // Azure: a key alone used to render "使用中 · 未填区域", which contradicts itself.
    pick('微软 Azure').click();
    await sleep(150);
    type('f_microsoft_apiKey', 'probe-key');
    await sleep(600);
    const azureWithKey = snap();

    // Custom provider: a template that cannot work must be reported up front.
    pick('自定义供应商').click();
    await sleep(150);
    const customClean = { errs: issueCount('err'), hasPreview: !!$('customPreview') };
    type('f_custom_headers', '{not json');
    type('f_custom_body', '{"q": "no placeholder"}');
    await sleep(700);
    const customBroken = {
      errs: issueCount('err'),
      warns: issueCount('warn'),
      text: ($('customIssues') || {}).textContent || '',
    };

    report({
      before,
      afterGoogle,
      all,
      azureWithKey,
      customClean,
      customBroken,
      // reported, not asserted: the settings page should stay scannable, and a
      // sudden jump here means something added a lot of vertical space
      heightBefore,
      pageHeight: document.documentElement.scrollHeight,
    });
  } catch (e) {
    report({ error: String((e && e.message) || e) });
  }
})();
</script>`;

/**
 * Popup probe: which half of the product did this page get, and can the user
 * reach the other one when both apply?
 *
 * The popup shows a single panel chosen by context. A YouTube video page is the
 * one case where both halves are useful — captions to translate AND the page
 * around them — so it is the only place the switcher appears. Everywhere else
 * an extra tab would be a dead end.
 */
const popupProbe = (expectMode) => `
<script>
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  function report(payload) {
    const el = document.createElement('pre');
    el.id = '__probe';
    el.textContent = JSON.stringify(payload);
    document.body.appendChild(el);
  }
  function snap() {
    const page = $('panel-page');
    const video = $('panel-video');
    const sel = document.querySelector('.tabs button[aria-selected="true"]');
    return {
      modeLabel: $('modeLabel').textContent,
      pageVisible: page ? !page.hidden : false,
      videoVisible: video ? !video.hidden : false,
      tabsVisible: !$('tabs').hidden,
      selectedTab: sel ? sel.dataset.tab : '',
      profileText: ($('pageProfileValue') || {}).textContent || '',
      hostText: ($('pageHost') || {}).textContent || '',
      // The two places the popup states a diagnosis. Both used to say "no
      // captions" for a failure that leaves the caption tracks perfectly intact,
      // so both are asserted against a fixture that has that exact shape.
      pill: $('statusText').textContent,
      pillTone: $('statusPill').dataset.tone,
      note: $('note').hidden ? '' : $('note').textContent,
      noteTone: $('note').dataset.tone || '',
      tracksVisible: !$('trackField').hidden,
      // Realtime mode translates line by line and stores no cue list, so these
      // four used to go blank/disabled while subtitles were visibly rendering.
      progressVisible: !$('progressBox').hidden,
      progressNum: ($('progressNum') || {}).textContent || '',
      progressLabel: ($('progressLabel') || {}).textContent || '',
      retranslateDisabled: $('retranslate').disabled,
      retranslateText: $('retranslate').textContent,
      // Chrome caps a popup at 600px and then scrolls, so this is a real budget,
      // not a style preference. Measure the .pop box itself — scrollHeight
      // reports the viewport when the content is shorter, which hides the fact.
      height: Math.round(document.querySelector('.pop').getBoundingClientRect().height),
    };
  }
  try {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
    await sleep(400);
    const initial = snap();
    initial.expect = ${JSON.stringify(expectMode)};

    let afterSwitch = null;
    if (initial.tabsVisible) {
      const other = Array.prototype.slice
        .call(document.querySelectorAll('.tabs button'))
        .filter((b) => b.dataset.tab !== initial.selectedTab)[0];
      if (other) {
        other.click();
        await sleep(160);
        afterSwitch = snap();
        afterSwitch.tab = other.dataset.tab;
      }
    }
    report({ initial, afterSwitch });
  } catch (e) {
    report({ error: String((e && e.message) || e) });
  }
})();
</script>`;

/**
 * Interaction probe for the diagnostics page.
 *
 * This page is the project's answer to "YouTube changed something and all we get
 * is 'it doesn't work'". Its whole value is that the verdict is right, so assert
 * the verdict — including on the dead-content-script path, which is the failure
 * people actually hit.
 */
const DIAGNOSTICS_PROBE = `
<script>
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function report(o) {
    const el = document.createElement('pre');
    el.id = '__probe';
    el.textContent = JSON.stringify(o);
    document.body.appendChild(el);
  }
  try {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
    await sleep(500);
    report({
      options: document.getElementById('target').options.length,
      tone: document.getElementById('verdict').dataset.tone,
      verdict: document.getElementById('verdictText').textContent,
      report: document.getElementById('report').textContent,
    });
  } catch (e) {
    report({ error: String((e && e.message) || e) });
  }
})();
</script>`;

/**
 * The state that two screens used to describe wrongly.
 *
 * The video HAS caption tracks; the cue fetch came back empty. Both the popup
 * and the diagnostics page reported that as "no captions available", while the
 * track list sat an inch above the sentence saying so. It is the more common of
 * the two `status: 'empty'` causes, and it is the one a user must be told to
 * report rather than shrug at — so one fixture, asserted against both screens.
 */
const NO_CUES_STATE = {
  subtitle: {
    status: 'empty',
    reason: 'empty-track',
    videoId: 'dQw4w9WgXcQ',
    liveMode: false,
    error: '',
    cueCount: 0,
    translated: 0,
    tracks: [
      { languageCode: 'en', name: 'English', kind: '' },
      { languageCode: 'en', name: 'English (auto-generated)', kind: 'asr' },
      { languageCode: 'ja', name: '日本語', kind: '' },
      { languageCode: 'de-DE', name: 'Deutsch', kind: '' },
    ],
    sourceTrack: { languageCode: 'en', name: 'English' },
    enabled: true,
  },
};

/**
 * A caption response that arrived and could not be read.
 *
 * Same `status: 'empty'` and same zero cues as `NO_CUES_STATE`, but the cause is
 * the opposite: the server DID send a body (`trackBytes` > 0) and our parser
 * dropped it. Reporting this as "nothing came back" told the user to retry a
 * parser bug, which cannot work, and kept a real bug invisible in every issue
 * that got filed. The two must be distinguishable on screen and in the report.
 */
const UNPARSED_STATE = {
  subtitle: {
    status: 'empty',
    reason: 'unparsed-track',
    trackBytes: 4096,
    videoId: 'dQw4w9WgXcQ',
    liveMode: false,
    error: '',
    cueCount: 0,
    translated: 0,
    tracks: [{ languageCode: 'en', name: 'English', kind: '' }],
    sourceTrack: { languageCode: 'en', name: 'English' },
    enabled: true,
  },
};

/**
 * The state the realtime fallback produces — asserted against two screens.
 *
 * `cueCount` is 0 because realtime mode never fills the cue store: it reads and
 * translates the single line the player is speaking. Both the popup and the
 * diagnostics page read progress and status from `cueCount` alone, and both got
 * it wrong in the same way — the popup hid its progress row and disabled its
 * button while lines were being translated, and the page reported "0 条" with no
 * sign that anything had worked.
 *
 * `isLiveStream: false` makes this the VOD-degraded cause specifically. The two
 * causes of `status: 'live'` need different verdicts: a live stream has no whole
 * track by nature, while a VOD here means the PoToken race was lost and the fast
 * path degraded — recoverable by reloading, and worth reporting.
 */
const REALTIME_STATE = {
  subtitle: {
    status: 'live',
    reason: '',
    videoId: 'dQw4w9WgXcQ',
    liveMode: true,
    isLiveStream: false,
    error: '',
    cueCount: 0,
    translated: 0,
    live: { lines: 4, translated: 2, lastOriginal: 'Sage nie Goodbye', lastTranslated: '〔译〕别说再见' },
    tracks: [{ languageCode: 'de-DE', name: 'Deutsch', kind: '' }],
    sourceTrack: { languageCode: 'de-DE', name: 'Deutsch' },
    enabled: true,
  },
};

/**
 * The two causes of `status: 'live'`, which need different verdicts.
 *
 * A live stream legitimately has no whole track, so realtime is the normal path.
 * A VOD reaching the same status means the PoToken race was lost and the fast
 * path degraded — recoverable by reloading. Reporting both as "直播字幕" told a
 * VOD user their ordinary video was a stream, and hid a bug worth reporting.
 * `cueCount` is 0 in both, so the split has to come from `isLiveStream`.
 */
const LIVE_STREAM_STATE = {
  subtitle: {
    status: 'live',
    reason: '',
    videoId: 'dQw4w9WgXcQ',
    liveMode: true,
    isLiveStream: true,
    error: '',
    cueCount: 0,
    translated: 0,
    live: { lines: 3, translated: 3 },
    tracks: [{ languageCode: 'en', name: 'English', kind: 'asr' }],
    sourceTrack: { languageCode: 'en', name: 'English (auto-generated)' },
    enabled: true,
  },
};

/**
 * A degraded VOD whose caption body arrived and could not be read.
 *
 * Same `status: 'live'` and same `isLiveStream: false` as `REALTIME_STATE`, so
 * before `reason` travelled with the status this was described as the PoToken
 * timing problem — advice to reload, for a fault reloading cannot touch. The
 * response size is the tell, and it must show up in the report.
 */
const REALTIME_UNPARSED_STATE = {
  subtitle: {
    status: 'live',
    reason: 'unparsed-track',
    trackBytes: 4096,
    videoId: 'dQw4w9WgXcQ',
    liveMode: true,
    isLiveStream: false,
    error: '',
    cueCount: 0,
    translated: 0,
    live: { lines: 2, translated: 1 },
    tracks: [{ languageCode: 'en', name: 'English', kind: '' }],
    sourceTrack: { languageCode: 'en', name: 'English' },
    enabled: true,
  },
};

const PAGES = [
  { file: 'src/popup/popup.html', tabUrl: 'https://news.ycombinator.com/item?id=1', width: 356, kind: 'popup', probe: popupProbe('网页翻译') },
  { file: 'src/popup/popup.html', tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', width: 356, kind: 'popup', probe: popupProbe('视频字幕') },
  {
    file: 'src/popup/popup.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patch: { __state: NO_CUES_STATE },
    width: 356,
    kind: 'popup-no-cues',
    label: '弹窗 · 字幕轨在但没取到数据',
    probe: popupProbe('视频字幕'),
  },
  {
    file: 'src/popup/popup.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patch: { __state: UNPARSED_STATE },
    width: 356,
    kind: 'popup-unparsed',
    label: '弹窗 · 取回非空数据但解析不出',
    probe: popupProbe('视频字幕'),
  },
  {
    file: 'src/popup/popup.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patch: { __state: REALTIME_STATE },
    width: 356,
    kind: 'popup-realtime',
    label: '弹窗 · 实时兜底模式',
    probe: popupProbe('视频字幕'),
  },
  {
    file: 'src/popup/popup.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patch: { __state: LIVE_STREAM_STATE },
    width: 356,
    kind: 'popup-live-stream',
    label: '弹窗 · 真实直播',
    probe: popupProbe('视频字幕'),
  },
  { file: 'src/options/options.html', tabUrl: 'https://example.com/', width: 1180, kind: 'options', probe: OPTIONS_PROBE },
  {
    file: 'src/diagnostics/diagnostics.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    width: 900,
    kind: 'diagnostics',
    label: '诊断页 · 一切正常',
    probe: DIAGNOSTICS_PROBE,
  },
  {
    file: 'src/diagnostics/diagnostics.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patch: { __state: NO_CUES_STATE },
    width: 900,
    kind: 'diagnostics-no-cues',
    label: '诊断页 · 字幕轨在但没取到数据',
    probe: DIAGNOSTICS_PROBE,
  },
  {
    file: 'src/diagnostics/diagnostics.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patch: { __state: UNPARSED_STATE },
    width: 900,
    kind: 'diagnostics-unparsed',
    label: '诊断页 · 取回非空数据但解析不出',
    probe: DIAGNOSTICS_PROBE,
  },
  {
    file: 'src/diagnostics/diagnostics.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patch: { __state: REALTIME_UNPARSED_STATE },
    width: 900,
    kind: 'diagnostics-realtime-unparsed',
    label: '诊断页 · 点播降级且响应非空',
    probe: DIAGNOSTICS_PROBE,
  },
  {
    file: 'src/diagnostics/diagnostics.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patch: { __state: REALTIME_STATE },
    width: 900,
    kind: 'diagnostics-realtime',
    label: '诊断页 · 点播降级为实时',
    probe: DIAGNOSTICS_PROBE,
  },
  {
    file: 'src/diagnostics/diagnostics.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patch: { __state: LIVE_STREAM_STATE },
    width: 900,
    kind: 'diagnostics-live-stream',
    label: '诊断页 · 真实直播',
    probe: DIAGNOSTICS_PROBE,
  },
  {
    file: 'src/diagnostics/diagnostics.html',
    tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patch: { __dead: true },
    width: 900,
    kind: 'diagnostics-dead',
    label: '诊断页 · 内容脚本没响应',
    probe: DIAGNOSTICS_PROBE,
  },
];

function dumpDom(file, width = 1180, timeoutMs = 25000) {
  return new Promise((resolve) => {
    // Throwaway profile, removed on the way out: one per page per run would
    // otherwise pile up tens of MB in the system temp dir every time.
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingua-pagecheck-'));
    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--allow-file-access-from-files',
      // Match the real viewport: the options page has a mobile breakpoint at
      // 860px, so probing at the default 800px window would measure a layout the
      // user never sees.
      `--window-size=${width},900`,
      `--user-data-dir=${profileDir}`,
      '--virtual-time-budget=6000',
      '--dump-dom',
      `file://${file}`,
    ];
    const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
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
      // Best-effort: Chrome may still be flushing its cache into the profile
      // directory, and an ENOTEMPTY here used to take the whole run down (and
      // leave the page's temp file behind). It lives in os.tmpdir(), so a
      // leftover copy costs nothing.
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString();
      // Chrome hangs after dumping — bail out as soon as we have the document.
      if (out.includes('</html>')) setTimeout(finish, 80);
    });
    proc.on('exit', () => setTimeout(finish, 80));
  });
}

let bad = 0;
let passed = 0;

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
const EXPECTED_ASSERTIONS = 145;

function check(ok, name, detail) {
  if (ok) {
    passed++;
    console.log(`     ok   ${name}`);
  } else {
    bad++;
    console.log(`     FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

for (const page of PAGES) {
  const src = path.join(ROOT, page.file);
  const tmp = src.replace(/\.html$/, '.__check.html');
  let html = fs.readFileSync(src, 'utf8');
  html = html.replace(/<head([^>]*)>/i, (m) => `${m}\n${STUB(page.tabUrl, page.patch)}`);
  if (page.probe) html = html.replace(/<\/body>/i, `${page.probe}</body>`);
  fs.writeFileSync(tmp, html);
  // try/finally so an interrupted run cannot leave the generated page sitting
  // next to its source (where it would show up as an untracked file).
  let dom;
  try {
    dom = await dumpDom(tmp, page.width);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      /* ignore */
    }
  }

  const label = page.label || `${page.file} @ ${page.tabUrl.replace(/^https?:\/\//, '').slice(0, 32)}`;
  const err = /id="__lingua_errs"[^>]*>([\s\S]*?)<\/div>/.exec(dom);
  const errText = err ? err[1].replace(/<[^>]*>/g, '').trim() : '';
  if (errText) {
    bad++;
    console.log(`FAIL ${label}\n     ${errText.slice(0, 400)}`);
    continue;
  }
  passed++;
  console.log(`ok   ${label} — boots without errors`);

  if (!page.probe) continue;

  const pm = /id="__probe"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  if (!pm) {
    bad++;
    console.log('     FAIL interaction probe produced no result');
    continue;
  }
  const probe = JSON.parse(pm[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  if (probe.error) {
    bad++;
    console.log(`     FAIL probe error: ${probe.error} ${probe.cards || ''}`);
    continue;
  }

  // --- popup: one contextual panel, plus a switcher only where both apply ----
  if (/^popup/.test(page.kind)) {
    const p = probe.initial;
    check(
      p.modeLabel === p.expect,
      `the popup opens on the ${p.expect} panel`,
      `modeLabel=${p.modeLabel}`
    );
    check(
      p.pageVisible === (p.expect === '网页翻译') && p.videoVisible === (p.expect === '视频字幕'),
      'exactly one panel is visible',
      `page=${p.pageVisible} video=${p.videoVisible}`
    );

    if (page.kind === 'popup-no-cues') {
      // The bug this fixture exists for: the pill and the note both said the
      // video had no captions while the track picker right above them listed
      // four. The user's takeaway would be "untranslatable" instead of "report
      // this" — the two outcomes could not be more different.
      check(p.pill !== '无字幕', 'the pill stops claiming there are no captions', p.pill);
      check(/取字幕失败/.test(p.pill), 'the pill names the step that actually failed', p.pill);
      check(/4 条字幕轨/.test(p.note), 'the note says how many tracks were found', p.note);
      // The old sentence was "这个视频没有可用字幕，无法翻译。" — the new one says
      // "不是视频没有字幕", so assert on the claim's distinctive wording rather
      // than on a bare /没有字幕/, which the correction itself contains.
      check(
        !/没有可用字幕/.test(p.note),
        'the note never falls back to the no-captions wording',
        p.note
      );
      check(/诊断页|上报/.test(p.note), 'the note tells the user to report it', p.note);
      check(p.tracksVisible === true, 'the track picker stays available — those tracks are real');
      check(p.noteTone === 'warn', 'the tone stays a warning, not an error', p.noteTone);
    } else if (page.kind === 'popup-unparsed') {
      // Same status and same zero cues as `popup-no-cues`, opposite cause: the
      // body came back and we dropped it. The pill must not say "无字幕" (the
      // tracks are listed right there) and must not be confused with the
      // fetch-failed case, which needs different advice.
      check(p.pill !== '无字幕', 'the pill stops claiming there are no captions', p.pill);
      check(/解析失败/.test(p.pill), 'the pill names parsing as the failed step', p.pill);
      check(p.pill !== '取字幕失败', 'it is not confused with the empty-response case', p.pill);
      check(/解析/.test(p.note), 'the note explains that the data arrived but was unreadable', p.note);
      check(!/没有可用字幕/.test(p.note), 'the note never claims there are no captions', p.note);
      check(/上报/.test(p.note), 'the note tells the user to report it', p.note);
      check(p.noteTone === 'warn', 'the tone stays a warning, not an error', p.noteTone);
    } else if (page.kind === 'popup-live-stream' || page.kind === 'popup-realtime') {
      // The pill must not call a degraded VOD a "直播模式": that tells the user
      // their ordinary video is a stream, and hides the actionable fact that the
      // whole-track fast path degraded and a re-run may recover it.
      if (page.kind === 'popup-live-stream') {
        check(/直播/.test(p.pill), 'a real stream is labelled as live', p.pill);
      } else {
        check(
          !/直播/.test(p.pill),
          'a degraded VOD is not labelled as a live stream',
          p.pill
        );
        check(/兜底|重试/.test(p.pill), 'it names the fallback instead', p.pill);
      }
      // Realtime mode stores no cues, so progress must NOT be read from
      // cueCount — that hid the row and disabled the button while lines were
      // being translated. This is the degraded path, so it is also the state a
      // user is most likely to open the popup in and look for a way out.
      // Scoped to the degraded VOD: the live-stream fixture has its own
      // translated count, and asserting its exact figure here would be
      // asserting the fixture rather than the behaviour.
      if (page.kind === 'popup-realtime') {
        check(p.progressVisible === true, 'the progress row is shown in realtime mode');
        check(/2/.test(p.progressNum), 'the progress figure counts translated lines', p.progressNum);
        check(/实时/.test(p.progressLabel), 'the label says this is realtime, not stuck', p.progressLabel);
        check(p.retranslateDisabled === false, 'the button stays usable — a retry often wins the race', String(p.retranslateDisabled));
        check(p.retranslateText === '重新翻译', 'the label reflects that lines have already landed', p.retranslateText);
      }
      check(p.pill !== '无字幕', 'the pill does not claim the video lacks captions', p.pill);
    } else if (p.expect === '视频字幕') {
      // The user's request: web-page translation must be reachable from a
      // YouTube video page, because the description and comments are prose.
      check(p.tabsVisible === true, 'the switcher appears where both halves apply');
      const s = probe.afterSwitch;
      check(!!s && s.tab === 'page', 'the switcher offers web-page translation', JSON.stringify(s && s.tab));
      check(!!s && s.pageVisible && !s.videoVisible, 'switching shows the page panel', JSON.stringify(s));
      check(!!s && s.modeLabel === '网页翻译', 'the header follows the switch', s ? s.modeLabel : 'missing');
      // Assert the switcher's own state, not the button we clicked: reporting
      // the clicked name back is a tautology, and it hid the fact that the
      // highlight stayed on the other tab.
      check(!!s && s.selectedTab === 'page', 'the switcher highlights the panel it shows', s ? s.selectedTab : 'missing');
      check(!!s && s.height <= 600, 'the page panel still fits the 600px budget', s ? `${s.height}px` : 'missing');
      if (s) console.log(`     info 网页翻译 on YouTube is ${s.height}px tall`);
    } else {
      check(p.tabsVisible === false, 'no dead-end switcher where only one half applies');
      check(p.hostText.length > 0 && p.hostText !== '—', 'the card names the page', p.hostText);
      check(
        /技术文档|学术论文|新闻资讯|社区讨论|电商购物|通用/.test(p.profileText),
        'the card names the translation style',
        p.profileText
      );
    }

    // Chrome scrolls a popup taller than 600px; the popup should fit outright.
    check(p.height <= 600, 'the popup fits without scrolling', `${p.height}px`);
    console.log(`     info ${p.expect} popup is ${p.height}px tall`);
    continue;
  }

  // --- diagnostics -----------------------------------------------------------
  if (/^diagnostics/.test(page.kind)) {
    const dead = page.kind === 'diagnostics-dead';
    const noCues = page.kind === 'diagnostics-no-cues';
    const unparsed = page.kind === 'diagnostics-unparsed';
    const rtUnparsed = page.kind === 'diagnostics-realtime-unparsed';
    check(probe.options >= 1, 'the page offers a tab to inspect', `options=${probe.options}`);
    check(
      /^Lingua \d/.test(probe.report || ''),
      'the report leads with the extension version',
      JSON.stringify((probe.report || '').slice(0, 24))
    );
    check(/— 内容脚本 —/.test(probe.report || ''), 'the report covers the content script');
    check(!/检查中/.test(probe.report || ''), 'the placeholder is replaced');

    if (dead) {
      // The case people actually hit: the page was open before the extension was
      // installed, so nothing answers. Reporting this as a generic failure would
      // send the user looking in the wrong place.
      check(probe.tone === 'err', 'a silent content script is reported as an error', probe.tone);
      check(/刷新/.test(probe.verdict || ''), 'the verdict says what to do about it', probe.verdict);
      check(/已注入\s+否/.test(probe.report || ''), 'the report records that nothing was injected');
      check(
        !/— 视频字幕 —/.test(probe.report || ''),
        'it does not print sections it could not read'
      );
    } else if (unparsed) {
      // The body arrived and we dropped it. This must NOT be described like the
      // empty-response case: retrying cannot fix a parser gap, and saying
      // "nothing came back" hides a bug that is entirely ours.
      check(probe.tone === 'warn', 'an unreadable caption body is a warning', probe.tone);
      check(/解析/.test(probe.verdict || ''), 'the verdict names parsing, not the network', probe.verdict);
      check(/重试没有意义|重试无用/.test(probe.verdict || ''), 'it says a retry will not help', probe.verdict);
      check(
        !/一条字幕数据都没取回来/.test(probe.report || '') && !/一条字幕数据都没取回来/.test(probe.verdict || ''),
        'it never claims nothing came back'
      );
      check(/字幕响应大小\s+\d+\s*字节/.test(probe.report || ''), 'the report shows the response size', probe.report);
    } else if (rtUnparsed) {
      // The fallback engaged, so the counters still move — but the verdict must
      // name our parser, not the PoToken race, and must not send the user to
      // reload for something a reload cannot fix.
      check(
        /实时已读行数\s+[1-9]/.test(probe.report || ''),
        'the report still counts what the fallback read',
        (probe.report || '').match(/实时已读行数.*/)?.[0] || 'missing'
      );
      check(probe.tone === 'warn', 'a degraded VOD is a warning', probe.tone);
      check(/解析/.test(probe.verdict || ''), 'the verdict names parsing as the cause', probe.verdict);
      // The correct text necessarily *mentions* PoToken in order to rule it out
      // ("不是 PoToken 时序问题"), so a bare /PoToken/ must-not-appear check would
      // fail on the right answer. Assert the disclaimer instead, and separately
      // that the empty-body explanation is not what got printed.
      check(
        /不是\s*PoToken/.test(probe.verdict || ''),
        'it explicitly rules out the PoToken timing race',
        probe.verdict
      );
      check(
        !/整轨字幕没取回来/.test(probe.verdict || ''),
        'it does not print the empty-body explanation',
        probe.verdict
      );
      check(
        /重新加载不会解决|重新加载无法/.test(probe.verdict || ''),
        'it says a reload will not help',
        probe.verdict
      );
      check(
        /字幕响应大小\s+\d+\s*字节/.test(probe.report || ''),
        'the report shows the response size that identifies the cause',
        probe.report
      );
    } else if (page.kind === 'diagnostics-realtime' || page.kind === 'diagnostics-live-stream') {
      const isStream = page.kind === 'diagnostics-live-stream';
      // In realtime mode `字幕条数` is legitimately 0. Reported alone it reads as
      // "nothing worked", so the counters that actually move must be present —
      // otherwise the report cannot tell a working fallback from a dead one.
      check(
        /实时已读行数\s+[1-9]/.test(probe.report || ''),
        'the report counts the lines the fallback actually read',
        (probe.report || '').match(/实时已读行数.*/)?.[0] || 'missing'
      );
      check(
        /实时已译行数\s+[1-9]/.test(probe.report || ''),
        'the report counts the lines the fallback actually translated',
        (probe.report || '').match(/实时已译行数.*/)?.[0] || 'missing'
      );
      // The two causes must not be described identically: one is expected, the
      // other is a degradation the user can act on.
      if (isStream) {
        check(/直播间|直播流/.test(probe.report || ''), 'a live stream is labelled as one');
        check(probe.tone === 'ok', 'a live stream is normal, not a warning', probe.tone);
        check(/重新加载/.test(probe.verdict || '') === false, 'it does not tell a stream user to reload');
      } else {
        check(/点播降级/.test(probe.report || ''), 'a degraded VOD is named as such', probe.report);
        check(probe.tone === 'warn', 'a degraded VOD is a warning, not ok', probe.tone);
        check(/重新加载/.test(probe.verdict || ''), 'it offers the reload that often recovers the fast path', probe.verdict);
      }
      // The report gets pasted into public issues; it must not carry dialogue.
      check(
        !/Sage nie Goodbye|别说再见/.test(probe.report || ''),
        'the report carries counts, never the video dialogue'
      );
    } else if (noCues) {
      // The report prints the track list; the verdict used to say no track was
      // found. Two lines of the same screen contradicting each other is worse
      // than either being vague, because it teaches the reader to distrust both.
      check(probe.tone === 'warn', 'a failed caption fetch is a warning, not an error', probe.tone);
      check(/— 视频字幕 —/.test(probe.report || ''), 'the report covers the captions');
      check(/字幕轨\s+4 条/.test(probe.report || ''), 'the report lists the tracks it did find');
      check(/empty-track/.test(probe.report || ''), 'the report names the raw reason, so it can be triaged');
      check(
        /取回的字幕数据是空的/.test(probe.report || ''),
        'the report glosses the reason in words too'
      );
      check(
        !/一条字幕轨都没找到/.test(probe.verdict || ''),
        'the verdict does not contradict the track list above it',
        probe.verdict
      );
      check(/4 条字幕轨/.test(probe.verdict || ''), 'the verdict quotes how many tracks exist', probe.verdict);
      check(/取字幕/.test(probe.verdict || ''), 'the verdict points at the fetch step, not at the video', probe.verdict);
    } else {
      check(probe.tone === 'ok', 'a healthy page is reported as ok', probe.tone);
      check(/— 视频字幕 —/.test(probe.report || ''), 'the report covers the captions');
      check(/字幕轨\s+3 条/.test(probe.report || ''), 'the report lists the caption tracks');
    }
    continue;
  }

  // --- options ---------------------------------------------------------------
  check(
    probe.before.pane === probe.before.pressed,
    'the picker and the pane agree before switching',
    `pane=${probe.before.pane} pressed=${probe.before.pressed}`
  );
  check(
    probe.afterGoogle.pressed === 'Google 翻译',
    'clicking a provider selects it',
    `pressed=${probe.afterGoogle.pressed}`
  );
  check(
    probe.afterGoogle.pane === probe.afterGoogle.pressed,
    'the pane below follows the selected provider',
    `pane=${probe.afterGoogle.pane} pressed=${probe.afterGoogle.pressed}`
  );
  check(
    /f_google_/.test(probe.afterGoogle.fields || ''),
    'the pane shows the selected provider fields',
    `fields=${probe.afterGoogle.fields}`
  );

  const all = probe.all || [];
  check(all.length >= 5, 'every provider was visited', `${all.length} cards`);
  const mismatched = all.filter((s) => s.pane !== s.card);
  check(mismatched.length === 0, 'every provider keeps its pane in sync', JSON.stringify(mismatched.slice(0, 2)));
  // "使用中 · 未填区域" is a contradiction: the status line must never claim to be
  // in use while simultaneously saying something is still missing.
  const contradictory = all.filter((s) => s.state === 'ready' && /未填/.test(s.status));
  check(contradictory.length === 0, 'no provider claims 使用中 while a field is unfilled', JSON.stringify(contradictory));

  const az = probe.azureWithKey;
  check(!!az && az.state === 'ready', 'a key alone makes Azure usable', JSON.stringify(az));
  check(
    !!az && !/未填/.test(az.status),
    'Azure with no region does not contradict itself',
    az ? az.status : 'missing'
  );

  // --- custom provider diagnostics ------------------------------------------
  const clean = probe.customClean || {};
  const broken = probe.customBroken || {};
  check(!!clean.hasPreview, 'the custom pane offers a request preview');
  check(clean.errs === 0, 'a valid custom template reports no errors', `errs=${clean.errs}`);
  check(
    broken.errs >= 1 && /不是合法 JSON/.test(broken.text || ''),
    'a malformed headers template is reported as an error',
    broken.text
  );
  check(
    broken.warns >= 1 && /没有 \{\{text\}\}/.test(broken.text || ''),
    'a body without a text placeholder is reported',
    broken.text
  );
  if (probe.heightBefore) {
    console.log(`     info settings page: ${probe.heightBefore}px (default provider), ${probe.pageHeight}px (custom)`);
  }
}

if (passed !== EXPECTED_ASSERTIONS) {
  console.log(`FAIL assertion count drifted: the pin says ${EXPECTED_ASSERTIONS}, this run made ${passed}`);
  bad++;
}
console.log(`\n${passed} passed, ${bad} failed`);
process.exitCode = bad ? 1 : 0;
