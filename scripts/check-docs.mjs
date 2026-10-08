/**
 * Lingua — documentation drift guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * The READMEs and ci.yml quote numbers: how many lines of source there are, and
 * how many assertions each suite has. Those numbers are load-bearing claims —
 * the whole pitch is "audit this, nothing is hidden", so a stale count is the
 * exact kind of statement this project refuses to make elsewhere.
 *
 * They also go stale silently. Every time a test is added, four files keep the
 * old figure, and nothing fails. That happened twice in one afternoon.
 *
 * What this checks, in order of how much it actually buys:
 *
 *   1. Source size is measured, not remembered — `src/` is counted directly.
 *   2. Every suite's number agrees across README.md, README.zh-CN.md and ci.yml.
 *      A typo in one language is caught by the other.
 *   3. The "N assertions across M suites" total is the sum of the parts, and M
 *      is the number of suites actually listed.
 *   4. The two suites that need no browser are RUN, and their real totals are
 *      compared. The other two are not run here: they need Chrome, and this
 *      script must stay fast enough to sit in `npm run check`.
 *
 * Deliberately zero-dependency and Node-only, like everything else here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// 1. Source size, measured directly
// ---------------------------------------------------------------------------
function measureSource() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  })(path.join(ROOT, 'src'));

  let lines = 0;
  for (const f of files) lines += read(path.relative(ROOT, f)).split('\n').length - 1;
  return { files: files.length, lines };
}

const source = measureSource();
console.log(`\n文档数字一致性 · 源码实测量 ${source.lines} 行 / ${source.files} 个文件`);

const readmeEn = read('README.md');
const sizeClaim = readmeEn.match(/([\d,]+)\s+lines across\s+([\d,]+)\s+files/);
check(!!sizeClaim, 'README.md still states the source size', 'pattern not found');
if (sizeClaim) {
  const claimedLines = Number(sizeClaim[1].replace(/,/g, ''));
  const claimedFiles = Number(sizeClaim[2].replace(/,/g, ''));
  check(
    claimedLines === source.lines,
    'the documented line count matches src/',
    `README says ${claimedLines}, src/ has ${source.lines}`
  );
  check(
    claimedFiles === source.files,
    'the documented file count matches src/',
    `README says ${claimedFiles}, src/ has ${source.files}`
  );
}

// The source size appears more than once because the README and the launch copy
// use it in different ways. The first check above only proves that one sentence
// is true; a stale duplicate still reaches the audience. Audit every source-size
// claim in the public-facing copy, while ignoring unrelated counts such as the
// "120 lines of node:net" implementation note.
const sizeClaimFiles = ['README.md', 'docs/launch-playbook.md'];
const sizeClaims = [];
for (const file of sizeClaimFiles) {
  const text = read(file);
  for (const pattern of [
    /([\d,]+)\s+lines across/g,
    /([\d,]+)\s+lines,\s+plain ES2020/g,
    /src\/,\s*([\d,]+)\s+lines/g,
  ]) {
    for (const match of text.matchAll(pattern)) {
      sizeClaims.push({ file, value: Number(match[1].replace(/,/g, '')) });
    }
  }
}
check(
  sizeClaims.length >= 2 && sizeClaims.every((c) => c.value === source.lines),
  'every source-size claim in the README and launch copy matches src/',
  `src=${source.lines}; ${sizeClaims.map((c) => `${c.file}=${c.value}`).join(', ')}`
);

// ---------------------------------------------------------------------------
// 2. Per-suite counts agree across README.md, README.zh-CN.md and ci.yml
// ---------------------------------------------------------------------------
const SUITES = ['test', 'test:live', 'test:dom', 'test:pages'];

/**
 * First integer on the line naming this suite. In every file the number sits on
 * the same line as the command — `npm run test:dom  # 164 — …`,
 * `（164 项）` — so this needs no per-file format knowledge.
 */
function countsFromReadme(text) {
  const out = {};
  for (const suite of SUITES) {
    const cmd = suite === 'test' ? 'npm test' : `npm run ${suite}`;
    const line = text.split('\n').find((l) => l.includes(cmd));
    if (!line) continue;
    const m = line.match(/\d+/);
    if (m) out[suite] = Number(m[0]);
  }
  return out;
}

const enCounts = countsFromReadme(readmeEn);
const zhCounts = countsFromReadme(read('README.zh-CN.md'));

for (const suite of SUITES) {
  check(
    enCounts[suite] != null,
    `README.md documents a count for ${suite}`,
    'no numbered line found'
  );
  check(
    zhCounts[suite] != null,
    `README.zh-CN.md documents a count for ${suite}`,
    'no numbered line found'
  );
  if (enCounts[suite] != null && zhCounts[suite] != null) {
    check(
      enCounts[suite] === zhCounts[suite],
      `the two READMEs agree on ${suite}`,
      `en=${enCounts[suite]} zh=${zhCounts[suite]}`
    );
  }
}

// ci.yml carries the same figures in its step comments, ordered like the steps.
// Comparing only how MANY comments exist would be a presence check, not a truth
// check — a stale figure would sail through. Compare the values, positionally.
const ci = read('.github/workflows/ci.yml');
const ciCounts = [...ci.matchAll(/^[ \t]*#\s*([\d,]+)\s+assertions/gm)].map((m) =>
  Number(m[1].replace(/,/g, ''))
);
check(
  ciCounts.length === SUITES.length,
  'ci.yml still carries one comment per suite',
  `found ${ciCounts.length}, expected ${SUITES.length}`
);
SUITES.forEach((suite, i) => {
  if (ciCounts[i] == null) return;
  check(
    ciCounts[i] === enCounts[suite],
    `ci.yml's figure for ${suite} matches the README`,
    `ci.yml says ${ciCounts[i]}, README says ${enCounts[suite]}`
  );
});

// ---------------------------------------------------------------------------
// 2b. A documented suite must exist as an npm script, or the command is fiction
// ---------------------------------------------------------------------------
const pkg = JSON.parse(read('package.json'));
for (const suite of SUITES) {
  check(
    typeof pkg.scripts[suite] === 'string',
    `npm run ${suite} is a real script`,
    'not found in package.json'
  );
}

// ---------------------------------------------------------------------------
// 3. The total is the sum of its parts, and the suite count is real
// ---------------------------------------------------------------------------
const sum = SUITES.reduce((n, s) => n + (enCounts[s] || 0), 0);
const checkLine = readmeEn.split('\n').find((l) => l.includes('assertions across'));
const totalClaim = checkLine && checkLine.match(/([\d,]+)\s+assertions across/);
check(!!totalClaim, 'README.md states a combined total', 'pattern not found');
if (totalClaim) {
  const claimed = Number(totalClaim[1].replace(/,/g, ''));
  check(
    claimed === sum,
    'the combined total equals the sum of the suites',
    `total says ${claimed}, suites add to ${sum}`
  );
}

// Same failure mode for the test total: the README and launch copy both quote
// it, and updating only one leaves the older number in a place that still gets
// copied into launch posts.
const assertionClaims = [];
for (const file of ['README.md', 'docs/launch-playbook.md']) {
  const text = read(file);
  for (const match of text.matchAll(/([\d,]+)\s+assertions\b/g)) {
    assertionClaims.push({ file, value: Number(match[1].replace(/,/g, '')) });
  }
}
check(
  assertionClaims.length >= 2 && assertionClaims.every((c) => c.value === sum),
  'every assertion-total claim in the README and launch copy matches the suites',
  `sum=${sum}; ${assertionClaims.map((c) => `${c.file}=${c.value}`).join(', ')}`
);

const WORDS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
const wordClaim = checkLine && checkLine.match(/across\s+(\w+)\s+suites/);
check(!!wordClaim, 'README.md states how many suites run', 'pattern not found');
if (wordClaim) {
  check(
    wordClaim[1] === WORDS[SUITES.length],
    'the stated suite count matches the suites listed',
    `says ${wordClaim[1]}, lists ${SUITES.length}`
  );
}

// Same two claims on the Chinese side, which words them differently.
const zhTotalLine = read('README.zh-CN.md').split('\n').find((l) => l.includes('npm run check'));
const zhTotal = zhTotalLine && zhTotalLine.match(/共\s*([\d,]+)\s*项/);
check(!!zhTotal, 'README.zh-CN.md states a combined total', 'pattern not found');
if (zhTotal) {
  check(
    Number(zhTotal[1].replace(/,/g, '')) === sum,
    'the Chinese combined total matches too',
    `says ${zhTotal[1]}, suites add to ${sum}`
  );
}

// ---------------------------------------------------------------------------
// 4. Every suite pins its own count, and the docs must agree with the pin
// ---------------------------------------------------------------------------
// Re-running a suite is the strongest check, but only the two browser-free ones
// can be re-run here — the other two need Chrome. That gap was real: the docs
// claimed 104 for `test:pages` while the suite made 114, and this guard passed,
// because a count it never executed was a count it never verified. So every
// suite now declares `EXPECTED_ASSERTIONS` and fails its own run on a mismatch;
// reading that constant covers all four figures on any machine, browser or not.
const SUITE_SCRIPTS = {
  test: 'scripts/test-core.mjs',
  'test:live': 'scripts/test-live.mjs',
  'test:dom': 'scripts/test-dom.mjs',
  'test:pages': 'scripts/check-pages.mjs',
};

for (const suite of SUITES) {
  const file = SUITE_SCRIPTS[suite];
  const src = read(file);
  const m = /^const EXPECTED_ASSERTIONS = (\d+);/m.exec(src);
  check(!!m, `${suite} declares the count it expects to make`, 'no EXPECTED_ASSERTIONS found');
  if (!m) continue;
  const pinned = Number(m[1]);
  check(
    pinned === enCounts[suite],
    `${suite}'s pin matches the documented count`,
    `pin says ${pinned}, docs say ${enCounts[suite]}`
  );
  // A pin the suite never consults is decoration; require it to be used.
  check(
    /passed !== EXPECTED_ASSERTIONS/.test(src),
    `${suite} actually fails when it makes a different number of assertions`,
    'the pin is never compared against the run'
  );
}

// ---------------------------------------------------------------------------
// 5. Re-run the browser-free suites and compare their real totals
// ---------------------------------------------------------------------------
for (const [suite, script] of [
  ['test', 'scripts/test-core.mjs'],
  ['test:live', 'scripts/test-live.mjs'],
]) {
  let actual = null;
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, script)], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    const m = out.match(/^(\d+) passed,\s*(\d+) failed/m);
    if (m) actual = { passed: Number(m[1]), failed: Number(m[2]) };
  } catch (e) {
    check(false, `${suite} runs cleanly so its count can be trusted`, String(e.message).slice(0, 120));
    continue;
  }
  if (!actual) continue;
  check(actual.failed === 0, `${suite} has no failures`, `${actual.failed} failing`);
  check(
    actual.passed === enCounts[suite],
    `${suite}'s documented count is its real count`,
    `docs say ${enCounts[suite]}, the suite reports ${actual.passed}`
  );
}

// ---------------------------------------------------------------------------
// 6. The realtime fallback is a rescue for the common case, not a guarantee
// ---------------------------------------------------------------------------
// An earlier revision claimed the fallback meant "you get subtitles either way".
// That was one measurement too confident: headed runs on the same video produced
// a fast-path success, a fallback that genuinely read lines with no `pot` in any
// request, AND a total failure (8 requests, all bodies 0 bytes, no caption
// container created, 0 lines read). Overclaiming here is the exact mistake this
// file exists to catch, so the correction is pinned rather than trusted to stay
// edited. Both READMEs must keep the measured wording, and the code comment must
// not re-acquire the specific figure that was never measured.
const readmeZh = read('README.zh-CN.md');
check(
  !/get subtitles either way/i.test(readmeEn),
  'the English README does not promise subtitles either way',
  'the overconfident claim is back'
);
check(
  !/两条路都能出字幕/.test(readmeZh),
  'the Chinese README does not promise subtitles either way',
  'the overconfident claim is back'
);
check(
  /读到 2 行/.test(readmeZh) && /0 bytes/.test(readmeEn),
  'both READMEs keep the measurements the correction rests on',
  'the evidence for "often, not always" was dropped'
);
const liveSrc = read('src/content/live.js');
check(
  !/five consecutive lines/.test(liveSrc),
  'no unmeasured figure is quoted as measurement in live.js',
  'the "five consecutive lines" claim is back'
);
check(
  /Often.*not.*always|not.*always/.test(liveSrc) || /一个 pot 都没有/.test(liveSrc) || /measured/.test(liveSrc),
  'live.js still records why this is a common-case rescue',
  'the caveat was dropped from live.js'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
