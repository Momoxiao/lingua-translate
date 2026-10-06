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
import { resolveChrome } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const chromePath = resolveChrome();
if (!chromePath) {
  console.log('No Chrome/Chromium binary found — skipping DOM test.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fixture: every element carries an id so assertions can reference it.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tag coverage matrix.
//
// One case per HTML content element, so "which tags do we actually translate?"
// has a checked answer instead of an opinion. `unit` is the intent, and the
// intent is derived from the two sets in units.js:
//   SKIP_TAGS   -> never translated and never traversed
//   void/empty  -> nothing to translate
// Everything else that holds text must produce exactly one unit.
// ---------------------------------------------------------------------------
const TAG_CASES = [
  // headings — note there is no <h7> in HTML; h1..h6 is the whole range
  { tag: 'h1', html: '<h1 id="tg_h1">Heading level one</h1>', unit: true },
  { tag: 'h2', html: '<h2 id="tg_h2">Heading level two</h2>', unit: true },
  { tag: 'h3', html: '<h3 id="tg_h3">Heading level three</h3>', unit: true },
  { tag: 'h4', html: '<h4 id="tg_h4">Heading level four</h4>', unit: true },
  { tag: 'h5', html: '<h5 id="tg_h5">Heading level five</h5>', unit: true },
  { tag: 'h6', html: '<h6 id="tg_h6">Heading level six</h6>', unit: true },

  // sectioning
  { tag: 'article', html: '<article id="tg_article">Article body text</article>', unit: true },
  { tag: 'aside', html: '<aside id="tg_aside">Aside body text</aside>', unit: true },
  { tag: 'footer', html: '<footer id="tg_footer">Footer body text</footer>', unit: true },
  { tag: 'header', html: '<header id="tg_header">Header body text</header>', unit: true },
  { tag: 'main', html: '<main id="tg_main">Main body text</main>', unit: true },
  { tag: 'nav', html: '<nav id="tg_nav">Loose nav text</nav>', unit: true },
  { tag: 'section', html: '<section id="tg_section">Section body text</section>', unit: true },
  { tag: 'hgroup', html: '<hgroup id="tg_hgroup">Grouped heading text</hgroup>', unit: true },
  { tag: 'search', html: '<search id="tg_search">Search area text</search>', unit: true },
  { tag: 'address', html: '<address id="tg_address">1 Infinite Loop</address>', unit: true },

  // grouping
  { tag: 'blockquote', html: '<blockquote id="tg_blockquote">Quoted passage text</blockquote>', unit: true },
  { tag: 'dd', html: '<dl><dd id="tg_dd">Definition text</dd></dl>', unit: true },
  { tag: 'div', html: '<div id="tg_div">Plain div text</div>', unit: true },
  { tag: 'dl', html: '<dl id="tg_dl">Loose definition list text</dl>', unit: true },
  { tag: 'dt', html: '<dl><dt id="tg_dt">Term text</dt></dl>', unit: true },
  { tag: 'figcaption', html: '<figure><figcaption id="tg_figcaption">Figure caption text</figcaption></figure>', unit: true },
  { tag: 'figure', html: '<figure id="tg_figure">Loose figure text</figure>', unit: true },
  { tag: 'li', html: '<ul><li id="tg_li">List item text</li></ul>', unit: true },
  { tag: 'menu', html: '<menu id="tg_menu">Loose menu text</menu>', unit: true },
  { tag: 'ol', html: '<ol id="tg_ol">Loose ordered list text</ol>', unit: true },
  { tag: 'p', html: '<p id="tg_p">Paragraph text here</p>', unit: true },
  { tag: 'ul', html: '<ul id="tg_ul">Loose unordered list text</ul>', unit: true },

  // text-level — placed at top level on purpose: inside a <p> they are absorbed
  // into the paragraph's single unit (that merging is asserted elsewhere), so a
  // wrapper would test the paragraph, not the tag.
  { tag: 'a', html: '<a id="tg_a" href="#">Anchor text</a>', unit: true },
  { tag: 'abbr', html: '<abbr id="tg_abbr" title="HyperText">HTML</abbr>', unit: true },
  { tag: 'b', html: '<b id="tg_b">Bold text</b>', unit: true },
  { tag: 'bdi', html: '<bdi id="tg_bdi">Bidi text</bdi>', unit: true },
  { tag: 'bdo', html: '<bdo id="tg_bdo" dir="rtl">Bidi override text</bdo>', unit: true },
  { tag: 'cite', html: '<cite id="tg_cite">Citation title</cite>', unit: true },
  { tag: 'data', html: '<data id="tg_data" value="1">Data label text</data>', unit: true },
  { tag: 'del', html: '<del id="tg_del">Deleted text</del>', unit: true },
  { tag: 'dfn', html: '<dfn id="tg_dfn">Defined term</dfn>', unit: true },
  { tag: 'em', html: '<em id="tg_em">Emphasised text</em>', unit: true },
  { tag: 'i', html: '<i id="tg_i">Italic text</i>', unit: true },
  { tag: 'ins', html: '<ins id="tg_ins">Inserted text</ins>', unit: true },
  { tag: 'label', html: '<label id="tg_label">Field label text</label>', unit: true },
  { tag: 'mark', html: '<mark id="tg_mark">Marked text</mark>', unit: true },
  { tag: 'q', html: '<q id="tg_q">Inline quotation</q>', unit: true },
  { tag: 's', html: '<s id="tg_s">Struck text</s>', unit: true },
  { tag: 'small', html: '<small id="tg_small">Small print text</small>', unit: true },
  { tag: 'span', html: '<span id="tg_span">Span text</span>', unit: true },
  { tag: 'strong', html: '<strong id="tg_strong">Strong text</strong>', unit: true },
  { tag: 'sub', html: '<sub id="tg_sub">subscript text</sub>', unit: true },
  { tag: 'sup', html: '<sup id="tg_sup">superscript text</sup>', unit: true },
  { tag: 'time', html: '<time id="tg_time">March 2026</time>', unit: true },
  { tag: 'u', html: '<u id="tg_u">Underlined text</u>', unit: true },
  { tag: 'ruby', html: '<ruby id="tg_ruby">Ruby base text</ruby>', unit: true },
  { tag: 'rt', html: '<ruby>漢<rt id="tg_rt">kan</rt></ruby>', unit: true },
  // <rp> only renders in browsers WITHOUT ruby support — Chrome hides it
  { tag: 'rp', html: '<ruby>漢<rp id="tg_rp">bracket</rp></ruby>', unit: false },

  // tables
  { tag: 'caption', html: '<table><caption id="tg_caption">Table caption text</caption></table>', unit: true },
  { tag: 'td', html: '<table><tbody><tr><td id="tg_td">Cell text here</td></tr></tbody></table>', unit: true },
  { tag: 'th', html: '<table><thead><tr><th id="tg_th">Header cell text</th></tr></thead></table>', unit: true },

  // forms and interactive
  { tag: 'button', html: '<button id="tg_button">Button label text</button>', unit: true },
  { tag: 'fieldset', html: '<fieldset id="tg_fieldset">Loose fieldset text</fieldset>', unit: true },
  { tag: 'form', html: '<form id="tg_form">Loose form text</form>', unit: true },
  { tag: 'legend', html: '<fieldset><legend id="tg_legend">Legend text here</legend></fieldset>', unit: true },
  { tag: 'option', html: '<select><option id="tg_option">Option label text</option></select>', unit: false },
  { tag: 'summary', html: '<details><summary id="tg_summary">Summary line text</summary></details>', unit: true },
  { tag: 'details', html: '<details id="tg_details">Loose details text</details>', unit: true },
  // a <dialog> without `open` is display:none — correctly skipped
  { tag: 'dialog', html: '<dialog id="tg_dialog">Loose dialog text</dialog>', unit: false },

  // deliberately skipped: code and everything that is not prose
  { tag: 'code', html: '<code id="tg_code">const x = 1</code>', unit: false },
  { tag: 'pre', html: '<pre id="tg_pre">preformatted text</pre>', unit: false },
  { tag: 'kbd', html: '<kbd id="tg_kbd">Ctrl</kbd>', unit: false },
  { tag: 'samp', html: '<samp id="tg_samp">sample output</samp>', unit: false },
  { tag: 'var', html: '<var id="tg_var">variable</var>', unit: false },
  { tag: 'textarea', html: '<textarea id="tg_textarea">textarea text</textarea>', unit: false },
  { tag: 'input', html: '<input id="tg_input" value="input value">', unit: false },
  { tag: 'select', html: '<select id="tg_select"></select>', unit: false },
  { tag: 'datalist', html: '<datalist id="tg_datalist"></datalist>', unit: false },
  { tag: 'output', html: '<output id="tg_output">output text</output>', unit: false },
  { tag: 'progress', html: '<progress id="tg_progress"></progress>', unit: false },
  { tag: 'meter', html: '<meter id="tg_meter"></meter>', unit: false },
  { tag: 'canvas', html: '<canvas id="tg_canvas">canvas fallback</canvas>', unit: false },
  { tag: 'video', html: '<video id="tg_video">video fallback</video>', unit: false },
  { tag: 'audio', html: '<audio id="tg_audio">audio fallback</audio>', unit: false },
  { tag: 'iframe', html: '<iframe id="tg_iframe" title="frame"></iframe>', unit: false },
  { tag: 'object', html: '<object id="tg_object"></object>', unit: false },
  { tag: 'embed', html: '<embed id="tg_embed">', unit: false },
  { tag: 'svg', html: '<svg id="tg_svg" width="10" height="10"><text>svg text</text></svg>', unit: false },
  { tag: 'math', html: '<math id="tg_math"><mi>x</mi></math>', unit: false },
  { tag: 'noscript', html: '<noscript id="tg_noscript">noscript text</noscript>', unit: false },
  { tag: 'template', html: '<template id="tg_template"><p>template text</p></template>', unit: false },
];

/**
 * Real-world heading shapes. VitePress (Vue, Vite, Vitest docs) renders
 * `<h1>Title <a class="header-anchor" aria-label="Permalink">&#8203;</a></h1>`
 * — the anchor holds a zero-width space, which is not matched by `\s` and so
 * survives whitespace collapsing.
 */
const HEADING_CASES = [
  {
    id: 'vueh1',
    html: '<h1 id="vueh1">Introduction <a class="header-anchor" href="#introduction" aria-label="Permalink to “Introduction”">&#8203;</a></h1>',
    text: 'Introduction',
  },
  {
    id: 'vueh2',
    html: '<h2 id="vueh2">What is Vue? <a class="header-anchor" href="#what-is-vue" aria-label="Permalink">&#8203;</a></h2>',
    text: 'What is Vue?',
  },
  {
    id: 'vueh3',
    html: '<h2 id="vueh3" class="title-text">Getting Started<!----></h2>',
    text: 'Getting Started',
  },
  {
    // the permalink shows a literal "#", so it stays a real (marked) link and the
    // text legitimately carries the marker pair
    id: 'vueh4',
    html: '<h2 id="vueh4">API Styles <a class="header-anchor" href="#api-styles">#</a></h2>',
    text: null,
    startsWith: 'API Styles',
  },
  {
    id: 'vueh5',
    html: '<h3 id="vueh5">Reactive <code>ref()</code> basics</h3>',
    text: 'Reactive basics',
  },
];

const TAG_MARKUP = TAG_CASES.map((c) => c.html).join('\n');
const HEADING_MARKUP = HEADING_CASES.map((c) => c.html).join('\n');

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
  <nav class="flex" id="navflex"><a id="navflexa">Home</a><a id="navflexb">Documentation</a></nav>
  <div class="flex" id="flexlong"><span id="flexlongs">A sentence long enough that its translation belongs on its own line rather than inline.</span></div>
  <p id="linkp">Read the <a href="https://example.com">documentation</a> for details</p>
  <p id="citep">Text with a citation<sup class="reference" id="cite1"><a href="#cite_note-1"><span class="cite-bracket">[</span>1<span class="cite-bracket">]</span></a></sup> and more.</p>
  <p id="twolinks">See <a href="https://en.wikipedia.org">Wikipedia</a> and <a href="https://developer.mozilla.org">MDN</a> for background.</p>
  <p id="plainp">No links in this paragraph at all</p>
${HEADING_MARKUP}
${TAG_MARKUP}
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
  const units = Lingua.page.units.collect(document.body, { skipSelectors: '' });
  const attrs = Lingua.page.units.collectAttributes(document.body, { skipSelectors: '' });
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
    // One throwaway profile per run. A persistent --user-data-dir both leaks a
    // profile per invocation and caches file:// resources, so a changed fixture
    // can be served from cache.
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingua-domtest-'));
    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--allow-file-access-from-files',
      `--user-data-dir=${profileDir}`,
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
      // Best-effort: Chrome may still be flushing its cache into the profile
      // directory, and an ENOTEMPTY here used to take the whole run down. The
      // directory lives in os.tmpdir(), so a leftover copy costs nothing.
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
      if (out.includes('</html>')) setTimeout(finish, 60);
    });
    proc.on('exit', () => setTimeout(finish, 60));
  });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
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
const EXPECTED_ASSERTIONS = 164;
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

  // --- blockified inline elements (CSS turns flex/grid children into blocks) ---
  // A nav link inside a flex nav reports display:block, but appending a
  // block-level translation under it stretches the navbar onto two rows.
  check(
    'flex nav is rejected, its links are units',
    !byId.has('navflex') && byId.has('navflexa') && byId.has('navflexb'),
    JSON.stringify(ids)
  );
  check(
    'link blockified by a flex parent is still flagged inline',
    byId.has('navflexa') && byId.get('navflexa').inline === true,
    JSON.stringify(byId.get('navflexa'))
  );
  check(
    'short blockified span is flagged inline',
    byId.has('s1') && byId.get('s1').inline === true,
    JSON.stringify(byId.get('s1'))
  );
  check(
    'long blockified span keeps a block translation',
    byId.has('flexlongs') && byId.get('flexlongs').inline === false,
    JSON.stringify(byId.get('flexlongs'))
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

  // --- real-world headings (VitePress shape) --------------------------------
  console.log('\nheadings on real doc sites');
  const EMPTY_MARKER = /⟦\d+⟧⟦\/\d+⟧/;
  const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;
  for (const c of HEADING_CASES) {
    const u = byId.get(c.id);
    check(`${c.id} is a unit`, !!u, JSON.stringify(ids.filter((i) => i.indexOf('vue') === 0)));
    if (!u) continue;
    check(`${c.id} text has no invisible characters`, !INVISIBLE.test(u.text), JSON.stringify(u.text));
    // A marker pair around nothing is what made headings fall back to English:
    // the model drops it, the placeholder check fails, the source is kept.
    check(`${c.id} sends no empty link marker`, !EMPTY_MARKER.test(u.text), JSON.stringify(u.text));
    if (c.text !== null) {
      check(`${c.id} text is exactly ${JSON.stringify(c.text)}`, u.text === c.text, JSON.stringify(u.text));
    }
    if (c.startsWith) {
      check(`${c.id} keeps its heading text`, u.text.indexOf(c.startsWith) === 0, JSON.stringify(u.text));
    }
  }

  const emptyMarkers = data.units.filter((u) => EMPTY_MARKER.test(u.text));
  check(
    'no unit anywhere sends an empty link marker pair',
    emptyMarkers.length === 0,
    JSON.stringify(emptyMarkers.slice(0, 3).map((u) => u.id))
  );

  // --- tag coverage matrix --------------------------------------------------
  console.log('\ntag coverage');
  const wrong = [];
  for (const c of TAG_CASES) {
    const u = byId.get('tg_' + c.tag);
    if (!!u === c.unit) {
      passed++;
    } else {
      wrong.push(`${c.tag}${c.unit ? ' (expected a unit)' : ' (expected to be skipped)'}`);
      failures.push(`tag ${c.tag}`);
    }
  }
  check(
    `every tag behaves as intended (${TAG_CASES.length} tags)`,
    wrong.length === 0,
    wrong.join(', ')
  );

  if (passed !== EXPECTED_ASSERTIONS) {
    failures.push(`assertion count drifted: the pin says ${EXPECTED_ASSERTIONS}, this run made ${passed}`);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('failing checks: ' + failures.join(', '));
    process.exit(1);
  }
})();
