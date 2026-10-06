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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
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
  return new Function('return (tabUrl, patch) => `' + m[1] + '`;')();
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

const PAGES = [
  { file: 'src/popup/popup.html', tabUrl: 'https://news.ycombinator.com/item?id=1', width: 356, kind: 'popup', probe: popupProbe('网页翻译') },
  { file: 'src/popup/popup.html', tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', width: 356, kind: 'popup', probe: popupProbe('视频字幕') },
  { file: 'src/options/options.html', tabUrl: 'https://example.com/', width: 1180, kind: 'options', probe: OPTIONS_PROBE },
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

  const label = `${page.file} @ ${page.tabUrl.replace(/^https?:\/\//, '').slice(0, 32)}`;
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
  if (page.kind === 'popup') {
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

    if (p.expect === '视频字幕') {
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

console.log(`\n${passed} passed, ${bad} failed`);
process.exitCode = bad ? 1 : 0;
