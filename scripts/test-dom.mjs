/**
 * Lingua — DOM-level test for full-page translation unit discovery.
 *
 * The heuristic in src/content/page/units.js is the riskiest part of the
 * feature (it decides what gets translated and, more importantly, what must NOT
 * be touched). This runs it inside a real browser against a fixture that covers
 * every case that has bitten real extensions: flex/grid containers, nested
 * blocks, inline markup, skip tags and already-processed nodes.
 *
 * Chrome is driven through `--dump-dom`. Chrome does not exit on its own after
 * dumping, so we kill it as soon as the closing </html> arrives.
 *
 * Usage: node scripts/test-dom.mjs
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
  console.log('No Chrome/Chromium binary found — skipping DOM test.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fixture: every element carries an id so assertions can reference it.
// ---------------------------------------------------------------------------
const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
  .flex{display:flex} .grid{display:grid} .inlineblock{display:inline-block}
  .hidden{display:none} .contents{display:contents}
</style></head>
<body>
  <p id="p1">Hello <b>bold</b> world</p>
  <div class="flex" id="f1"><span id="s1">Label</span><span id="s2">Value</span></div>
  <div class="grid" id="g1"><span id="gs1">Grid cell</span></div>
  <div id="n1"><p id="n1a">nested one</p><p id="n1b">nested two</p></div>
  <pre id="pre1">const x = 1;</pre>
  <code id="code1">foo()</code>
  <h1 id="h1">A heading</h1>
  <ul id="u1"><li id="l1">item one</li><li id="l2">item two</li></ul>
  <div id="done1" data-lingua="done">already handled</div>
  <div id="no1" translate="no">do not touch</div>
  <p id="p2">12345 67890</p>
  <p id="p3">OK</p>
  <table><tbody><tr><td id="td1">cell text</td></tr></tbody></table>
  <button id="btn1">Click me</button>
  <p id="p4">Hello <span id="inner">inner</span></p>
  <a id="a1" href="#">A link</a>
  <div id="empt"><br></div>
  <textarea id="ta1">textarea text</textarea>
  <nav id="nav1"><a id="nav1a">Home</a></nav>
  <nav id="nav2"><a id="nav2a">Home</a><a id="nav2b">About</a></nav>
  <footer id="ft1">Plain footer text</footer>
  <section id="sec1">Loose section text</section>
  <header id="hd1"><h1 id="hd1h">Header heading</h1></header>
  <footer id="ft2"><img src="x.png" alt=""><span id="ft2s">Caption</span></footer>
  <ul id="ul3"><li id="ul3li"><span id="ul3s">Nested span item</span></li></ul>
  <div id="hidden1" class="hidden">not rendered</div>
  <div class="inlineblock" id="ib1">inline block text</div>
  <div class="contents" id="ct1">contents text</div>
  <div id="card1"><b id="card1t" style="display:block">Card title</b><span id="card1s">Card body</span></div>
  <div id="card2"><b id="card2t">Inline title</b><span id="card2s">Inline body</span></div>
  <button class="flex" id="flexbtn">Platform<svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"></path></svg></button>
  <button type="button" class="flex" id="ghbtn" aria-expanded="false" aria-controls="_R_nd_">Platform<svg data-component="Octicon" aria-hidden="true" focusable="false" class="octicon octicon-triangle-right" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="m6.427 4.427 3.396 3.396a.25.25 0 0 1 0 .354l-3.396 3.396A.25.25 0 0 1 6 11.396V4.604a.25.25 0 0 1 .427-.177Z"></path></svg></button>
  <div class="flex" id="flexdiv">Direct text in a flex box<span id="flexspan">child span</span></div>
  <p id="linkp">Read the <a href="https://example.com">documentation</a> for details</p>
  <p id="citep">Text with a citation<sup class="reference" id="cite1"><a href="#cite_note-1"><span class="cite-bracket">[</span>1<span class="cite-bracket">]</span></a></sup> and more.</p>
  <p id="twolinks">See <a href="https://en.wikipedia.org">Wikipedia</a> and <a href="https://developer.mozilla.org">MDN</a> for background.</p>
  <p id="plainp">No links in this paragraph at all</p>
  <div id="cls1" class="lingua-pg-dst">our own node</div>
  <script>window.__noise = 1;</script>
  <pre id="out"></pre>
</body></html>`;

// ---------------------------------------------------------------------------
// Runner appended to the fixture: loads the real units.js and dumps results.
// ---------------------------------------------------------------------------
function buildPage(unitsSource) {
  const runner = `
<script>
(function () {
  const units = YTST.page.units.collect(document.body, { skipSelectors: '' });
  const attrs = YTST.page.units.collectAttributes(document.body, { skipSelectors: '' });
  const payload = {
    units: units.map(function (u) { return { id: u.el.id || u.el.tagName, text: u.text, inline: !!u.inline, display: u.display, wrap: !!u.wrap, hasLink: !!u.hasLink, marks: u.marks ? u.marks.length : 0, markTags: u.marks ? u.marks.map(function (m) { return m.tagName + '.' + String(m.className || ''); }) : [] }; }),
    attrs: attrs.map(function (u) { return { id: u.el.id || u.el.tagName, attr: u.attr, text: u.text }; })
  };
  document.getElementById('out').textContent =
    'LINGUA_B64:' + btoa(unescape(encodeURIComponent(JSON.stringify(payload)))) + ':END';
})();
</script>`;
  // The scripts must come AFTER #out exists — they run during parsing.
  return FIXTURE.replace('<script>window.__noise = 1;</script>', '').replace(
    '<pre id="out"></pre>',
    `<pre id="out"></pre><script>${unitsSource}</script>${runner}`
  );
}

// ---------------------------------------------------------------------------
// Run Chrome and grab the dumped DOM
// ---------------------------------------------------------------------------
function dumpDom(file, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--allow-file-access-from-files',
      `--user-data-dir=${path.join(os.tmpdir(), 'lingua-domtest-profile')}`,
      '--virtual-time-budget=2500',
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
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString();
      // Chrome hangs after dumping — bail out as soon as we have the document.
      if (out.includes('</html>')) setTimeout(finish, 60);
    });
    proc.on('exit', () => setTimeout(finish, 60));
  });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

(async function main() {
  const unitsSource = fs.readFileSync(path.join(ROOT, 'src/content/page/units.js'), 'utf8');
  const tmp = path.join(os.tmpdir(), 'lingua-domtest.html');
  fs.writeFileSync(tmp, buildPage(unitsSource));

  const dom = await dumpDom(tmp);
  fs.unlinkSync(tmp);

  const m = dom.match(/LINGUA_B64:([A-Za-z0-9+/=]+):END/);
  if (!m) {
    console.log('FAIL — could not read results out of the page');
    process.exit(1);
  }
  const data = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  const byId = new Map(data.units.map((u) => [u.id, u]));
  const ids = data.units.map((u) => u.id);

  console.log('\nfull-page unit discovery (real DOM)');
  check('paragraph with inline markup is one unit', byId.has('p1') && byId.get('p1').text === 'Hello bold world', JSON.stringify(byId.get('p1')));
  check('inline element inside it is not a separate unit', !byId.has('inner'));
  check('flex container itself is rejected', !byId.has('f1'));
  check('flex children become units', byId.has('s1') && byId.has('s2'), JSON.stringify(ids));
  check('grid container itself is rejected', !byId.has('g1'));
  check('grid child becomes a unit', byId.has('gs1'));
  check('container with nested blocks is rejected', !byId.has('n1'));
  check('nested blocks become units', byId.has('n1a') && byId.has('n1b'));
  check('<pre> is skipped', !byId.has('pre1'));
  check('<code> is skipped', !byId.has('code1'));
  check('heading is a unit', byId.has('h1'));
  check('list container rejected, items are units', !byId.has('u1') && byId.has('l1') && byId.has('l2'));
  check('already-processed node skipped', !byId.has('done1'));
  check('translate="no" subtree skipped', !byId.has('no1'));
  check('digits-only text skipped', !byId.has('p2'));
  check('short text with letters kept', byId.has('p3'));
  check('table cell is a unit', byId.has('td1'));
  check('button label is a unit', byId.has('btn1'));
  check('anchor is a unit and flagged inline', byId.has('a1') && byId.get('a1').inline === true, JSON.stringify(byId.get('a1')));
  check('<br>-only block skipped', !byId.has('empt'));
  check('<textarea> skipped', !byId.has('ta1'));
  check('nav container is rejected', !byId.has('nav1'));
  check('nav link is a unit', byId.has('nav1a'));
  check('multi-link nav does not merge into one unit', !byId.has('nav2') && byId.has('nav2a') && byId.has('nav2b'), JSON.stringify(ids));
  check('structural container with only text is still translated', byId.has('ft1'), JSON.stringify(ids));
  check('section with only text is still translated', byId.has('sec1'));
  check('header descends into its heading', !byId.has('hd1') && byId.has('hd1h'));
  check('footer with a real child descends', !byId.has('ft2') && byId.has('ft2s'), JSON.stringify(ids));
  check(
    'list item absorbs its inline span into one unit',
    byId.has('ul3li') && !byId.has('ul3s') && !byId.has('ul3'),
    JSON.stringify(ids)
  );

  // --- flex/grid containers that hold their OWN text (GitHub's nav button) ---
  check(
    'flex button with direct text becomes a wrap unit',
    byId.has('flexbtn') && byId.get('flexbtn').wrap === true && byId.get('flexbtn').text === 'Platform',
    JSON.stringify(byId.get('flexbtn'))
  );
  check('wrap unit is rendered inline', byId.has('flexbtn') && byId.get('flexbtn').inline === true);
  check(
    'real GitHub nav button markup is picked up',
    byId.has('ghbtn') && byId.get('ghbtn').wrap === true && byId.get('ghbtn').text === 'Platform',
    JSON.stringify(byId.get('ghbtn'))
  );
  check(
    'flex container with direct text and an element child yields both',
    byId.has('flexdiv') && byId.get('flexdiv').text === 'Direct text in a flex box' && byId.has('flexspan'),
    JSON.stringify(ids)
  );

  // --- hyperlink preservation ---
  check('unit containing a link is flagged', byId.has('linkp') && byId.get('linkp').hasLink === true, JSON.stringify(byId.get('linkp')));
  check('unit without a link is not flagged', byId.has('plainp') && byId.get('plainp').hasLink === false);
  check('link unit still captures the whole run', byId.has('linkp') && byId.get('linkp').text.indexOf('documentation') !== -1);
  check('link text is wrapped in placeholders', byId.has('linkp') && byId.get('linkp').text.indexOf('⟦1⟧documentation⟦/1⟧') !== -1, JSON.stringify(byId.get('linkp')));
  check('the link element is recorded as a mark', byId.has('linkp') && byId.get('linkp').marks === 1);
  check('non-link units carry no marks', byId.has('plainp') && byId.get('plainp').marks === 0);
  check(
    'multiple links are numbered in document order',
    byId.has('twolinks') && byId.get('twolinks').text === 'See ⟦1⟧Wikipedia⟦/1⟧ and ⟦2⟧MDN⟦/2⟧ for background.',
    JSON.stringify(byId.get('twolinks'))
  );
  check('both links recorded', byId.has('twolinks') && byId.get('twolinks').marks === 2);

  // --- citation markers: the whole <sup> must move, not just the <a> ---
  check(
    'citation paragraph produces one placeholder',
    byId.has('citep') && byId.get('citep').marks === 1,
    JSON.stringify(byId.get('citep'))
  );
  check(
    'citation placeholder wraps the whole <sup>, not the bare <a>',
    byId.has('citep') && byId.get('citep').markTags[0] && byId.get('citep').markTags[0].indexOf('SUP.') === 0,
    JSON.stringify(byId.get('citep') && byId.get('citep').markTags)
  );
  check(
    'citation text is captured intact',
    byId.has('citep') &&
      byId.get('citep').text.indexOf('⟦1⟧[1]⟦/1⟧') !== -1 &&
      byId.get('citep').text.indexOf('Text with a citation') === 0 &&
      byId.get('citep').text.indexOf('and more.') !== -1,
    JSON.stringify(byId.get('citep') && byId.get('citep').text)
  );
  check('display:none block skipped', !byId.has('hidden1'));
  check('inline-block element is a unit', byId.has('ib1'));
  check(
    'inline tag styled as block splits the card into two units',
    !byId.has('card1') && byId.has('card1t') && byId.has('card1s'),
    JSON.stringify(ids)
  );
  check(
    'purely inline card stays one merged unit',
    byId.has('card2') && !byId.has('card2t') && !byId.has('card2s'),
    JSON.stringify(ids)
  );
  check('display:contents container is translated via a text wrapper', byId.has('ct1') && byId.get('ct1').wrap === true, JSON.stringify(byId.get('ct1')));
  check('our own injected node skipped', !byId.has('cls1'));
  check('no duplicate ids in the result', new Set(ids).size === ids.length, JSON.stringify(ids));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('failing checks: ' + failures.join(', '));
    process.exit(1);
  }
})();
