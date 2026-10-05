/**
 * Lingua — core logic smoke test (no browser required).
 *
 * Loads the real shared/ + background/ sources into this Node context with a
 * minimal chrome.* / fetch stub, then exercises the parts that are easiest to
 * get subtly wrong: subtitle parsing, batch alignment, adaptive repair, caching.
 *
 * Usage: node scripts/test-core.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
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

function load(rel) {
  const file = path.join(ROOT, rel);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

// ---------------------------------------------------------------------------
// Environment stubs
// ---------------------------------------------------------------------------
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return { [key]: store[key] };
      },
      async set(obj) {
        Object.assign(store, obj);
      },
      async remove(key) {
        delete store[key];
      },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};

let fetchCalls = [];
let dropThirdLine = true;
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const user = body.messages[1].content;
  const lines = user.split('\n').filter(Boolean);
  fetchCalls.push({ url, count: lines.length });

  let outLines = lines.map((l) => l.replace(/^(\d+)\.\s*/, '$1. 译『') + '』');
  if (dropThirdLine && lines.length > 4) {
    outLines = outLines.filter((_, i) => i !== 2); // simulate a dropped line
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: outLines.join('\n') } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

// ---------------------------------------------------------------------------
// Load the real sources
// ---------------------------------------------------------------------------
for (const f of [
  'src/shared/constants.js',
  'src/shared/utils.js',
  'src/shared/settings.js',
  'src/shared/subtitles.js',
  'src/background/cache.js',
  'src/background/providers/http.js',
  'src/background/providers/prompts.js',
  'src/background/providers/llm.js',
  'src/background/providers/openai.js',
  'src/background/providers/deepl.js',
  'src/background/providers/google.js',
  'src/background/providers/microsoft.js',
  'src/background/providers/custom.js',
  'src/background/translator.js',
  'src/content/page/units.js',
]) {
  load(f);
}

const NS = globalThis.YTST;
const S = NS.subtitles;

// ---------------------------------------------------------------------------
console.log('\nsubtitle parsing');
// ---------------------------------------------------------------------------
const json3 = {
  events: [
    { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'Hello' }] },
    { tStartMs: 1200, dDurationMs: 1500, segs: [{ utf8: 'Hello world' }] },
    { tStartMs: 2700, dDurationMs: 1800, segs: [{ utf8: 'world &amp; <i>friends</i>' }] },
    { tStartMs: 5000, dDurationMs: 0, segs: [{ utf8: '' }] },
  ],
};
const c1 = S.parseJson3(json3);
check('json3 -> cues parsed', c1.length >= 2, `got ${c1.length}`);
check('json3 entities decoded', c1.some((c) => c.text.includes('&')), JSON.stringify(c1.map((c) => c.text)));
check('json3 inline tags stripped', !c1.some((c) => c.text.includes('<i>')));
check('json3 empty segs skipped', !c1.some((c) => !c.text));
check('json3 times in seconds', c1[0].start === 0 && c1[0].end > c1[0].start);

const srv3 = `<timedtext><body><p t="1000" d="2000"><s>Hi</s><s> there</s></p><p t="3000" d="1500"><s>Bye</s></p></body></timedtext>`;
const c2 = S.parseSrv3(srv3);
check('srv3 -> cues parsed', c2.length === 2, `got ${c2.length}`);
check('srv3 ms -> seconds', c2[0].start === 1 && Math.abs(c2[0].end - 3) < 1e-9);
check('srv3 text joined', c2[0].text === 'Hi there', c2[0].text);

const xml = `<transcript><text start="1.5" dur="2.5">One &amp; two</text><text start="4" dur="1">Three</text></transcript>`;
const c3 = S.parseXml(xml);
check('xml -> cues parsed', c3.length === 2, `got ${c3.length}`);
check('xml seconds kept', c3[0].start === 1.5);
check('xml entity decoded', c3[0].text === 'One & two', c3[0].text);

check('parseTimedText auto-detects json', S.parseTimedText(JSON.stringify(json3)).length >= 2);
check('parseTimedText auto-detects xml', S.parseTimedText(xml).length === 2);
check('parseTimedText handles empty', S.parseTimedText('').length === 0);

// rolling auto-caption dedupe
const rolling = [
  { start: 0, end: 1, text: 'the quick brown' },
  { start: 1, end: 2, text: 'the quick brown fox' },
  { start: 2, end: 3, text: 'the quick brown fox jumps' },
];
const c4 = S.dedupe(rolling);
check('dedupe collapses rolling window', c4.length === 1, `got ${c4.length}`);
check('dedupe keeps longest text', c4[0].text === 'the quick brown fox jumps', c4[0].text);

// binary search
const cues = S.parseJson3(json3);
check('cueAt finds cue', S.cueAt(cues, cues[0].start + 0.1) === 0);
check('cueAt returns -1 in a gap', S.cueAt(cues, 99999) === -1);

// ---------------------------------------------------------------------------
console.log('\nbatch build / parse');
// ---------------------------------------------------------------------------
const batch = S.buildBatchText(['a', 'b\nc', 'd']);
check('buildBatchText numbers lines', batch === '1. a\n2. b c\n3. d', JSON.stringify(batch));

check(
  'parse numbered with brackets',
  JSON.stringify(S.parseBatchResponse('1. 甲\n2. 乙\n3. 丙', 3)) === JSON.stringify(['甲', '乙', '丙'])
);
check(
  'parse numbered with dots+parens',
  JSON.stringify(S.parseBatchResponse('[1] 甲\n[2] 乙', 2)) === JSON.stringify(['甲', '乙'])
);
const wrapped = S.parseBatchResponse('```\n1. 甲\n2. 乙\n```', 2);
check('parse tolerates stray prose on same line', wrapped[0] === '甲', JSON.stringify(wrapped));
const missing = S.parseBatchResponse('1. 甲\n3. 丙', 3);
check('parse reports missing lines as null', missing[1] === null && missing[0] === '甲');
const multiline = S.parseBatchResponse('1. 甲\n继续\n2. 乙', 2);
check('parse joins continuation lines', multiline[0] === '甲 继续', JSON.stringify(multiline));
const trailingNote = S.parseBatchResponse('1. 甲\n2. 乙\n希望这些翻译对你有帮助！', 2);
check('parse discards trailing note', JSON.stringify(trailingNote) === JSON.stringify(['甲', '乙']), JSON.stringify(trailingNote));
const noNumber = S.parseBatchResponse('甲\n乙\n丙', 3);
check('parse falls back to line split', JSON.stringify(noNumber) === JSON.stringify(['甲', '乙', '丙']));

// ---------------------------------------------------------------------------
console.log('\ntranslator pipeline (openai-compatible, with dropped-line repair)');
// ---------------------------------------------------------------------------
const settings = await NS.settings.getSettings();
settings.provider = 'openai';
settings.providers.openai.baseUrl = 'https://example.test/v1';
settings.providers.openai.apiKey = 'test-key';
settings.providers.openai.model = 'test-model';
settings.batchSize = 8;
settings.concurrency = 2;
settings.cacheEnabled = false;

const texts = Array.from({ length: 40 }, (_, i) => `line number ${i + 1}`);
fetchCalls = [];
let res = await NS.bg.translator.translate(texts, { settings, from: 'en', to: 'zh-Hans' });

check('returns one result per input', res.results.length === 40, `got ${res.results.length}`);
check('every line translated', res.results.every((r) => r && r.includes('译')), JSON.stringify(res.results.slice(0, 3)));
check('dropped lines were repaired', res.stats.failed === 0, `failed=${res.stats.failed}`);
check(
  'batching reduced request count',
  fetchCalls.length < 40,
  `${fetchCalls.length} requests for 40 lines`
);
check('concurrency respected batch size', fetchCalls.some((c) => c.count === 8), JSON.stringify(fetchCalls.slice(0, 4)));

// cache: second run must not hit the network
settings.cacheEnabled = true;
fetchCalls = [];
const first = await NS.bg.translator.translate(texts, { settings, from: 'en', to: 'zh-Hans' });
const callsAfterFirst = fetchCalls.length;
fetchCalls = [];
const second = await NS.bg.translator.translate(texts, { settings, from: 'en', to: 'zh-Hans' });
check('first run populates cache via network', callsAfterFirst > 0, `${callsAfterFirst} calls`);
check('second run served fully from cache', fetchCalls.length === 0, `${fetchCalls.length} calls`);
check('cached results identical', JSON.stringify(first.results) === JSON.stringify(second.results));
check('stats report cache hits', second.stats.cached === 40, JSON.stringify(second.stats));

// different target language must NOT reuse the cache
fetchCalls = [];
await NS.bg.translator.translate(texts, { settings, from: 'en', to: 'ja' });
check('cache is keyed by target language', fetchCalls.length > 0, `${fetchCalls.length} calls`);

// ---------------------------------------------------------------------------
console.log('\ncustom API template provider');
// ---------------------------------------------------------------------------
const customSettings = await NS.settings.getSettings();
customSettings.provider = 'custom';
customSettings.cacheEnabled = false;
customSettings.providers.custom = {
  url: 'https://custom.test/t?to={{to}}&key={{key}}',
  method: 'POST',
  apiKey: 'K123',
  headers: '{\n  "Content-Type": "application/json",\n  "X-Key": "{{key}}"\n}',
  body: '{\n  "text": "{{text}}",\n  "from": "{{from}}"\n}',
  responsePath: 'data.result',
};

let captured = null;
globalThis.fetch = async (url, opts) => {
  captured = { url, opts };
  const parsed = JSON.parse(opts.body);
  const n = parsed.text.split('\n').length;
  const lines = Array.from({ length: n }, (_, i) => `${i + 1}. 自定义${i + 1}`);
  return new Response(JSON.stringify({ data: { result: lines.join('\n') } }), { status: 200 });
};

const out = await NS.bg.translator.translate(['one', 'two'], { settings: customSettings, from: 'en', to: 'zh-Hans' });
check('custom URL placeholders substituted', captured.url === 'https://custom.test/t?to=zh-Hans&key=K123', captured.url);
check('custom header placeholder substituted', captured.opts.headers['X-Key'] === 'K123');
check('custom body placeholder substituted', JSON.parse(captured.opts.body).text === '1. one\n2. two');
check('custom responsePath extracted', out.results[0] === '自定义1', JSON.stringify(out.results));

// array-mode custom API
customSettings.providers.custom.body = '{ "texts": {{texts}}, "to": "{{to}}" }';
customSettings.providers.custom.responsePath = 'translations';
globalThis.fetch = async (url, opts) => {
  const parsed = JSON.parse(opts.body);
  return new Response(JSON.stringify({ translations: parsed.texts.map((t) => `A:${t}`) }), { status: 200 });
};
const out2 = await NS.bg.translator.translate(['x', 'y', 'z'], { settings: customSettings, from: 'en', to: 'ja' });
check('custom array mode -> index aligned', JSON.stringify(out2.results) === JSON.stringify(['A:x', 'A:y', 'A:z']), JSON.stringify(out2.results));

// ---------------------------------------------------------------------------
console.log('\nfull-page translation: prompts + unit heuristics');
// ---------------------------------------------------------------------------
const subPrompt = NS.bg.prompts.systemPrompt('en', 'zh-Hans', 'subtitle');
const pagePrompt = NS.bg.prompts.systemPrompt('en', 'zh-Hans', 'page');
check('subtitle prompt says subtitle translator', /subtitle translator/i.test(subPrompt));
check('page prompt says web page translator', /web page translator/i.test(pagePrompt));
check('page prompt differs from subtitle prompt', subPrompt !== pagePrompt);
check('page prompt keeps the numbering contract', /SAME index/.test(pagePrompt));
check('prompt names the target language', /Simplified Chinese/.test(pagePrompt));

// openai provider must send the page prompt when kind === 'page'
let lastSystem = '';
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  lastSystem = body.messages[0].content;
  const lines = body.messages[1].content.split('\n');
  const out = lines.map((l) => l.replace(/^(\d+)\.\s*/, '$1. 译'));
  return new Response(JSON.stringify({ choices: [{ message: { content: out.join('\n') } }] }), { status: 200 });
};
const pageSettings = await NS.settings.getSettings();
pageSettings.provider = 'openai';
pageSettings.providers.openai.baseUrl = 'https://example.test/v1';
pageSettings.providers.openai.model = 'm';
pageSettings.cacheEnabled = false;
await NS.bg.translator.translate(['Hello there', 'Second block'], {
  settings: pageSettings,
  from: 'en',
  to: 'zh-Hans',
  kind: 'page',
});
check('provider forwards kind to the prompt', /web page translator/i.test(lastSystem), lastSystem.slice(0, 60));

// unit heuristics (pure functions, no DOM needed)
const U = NS.page.units;
check('rejects empty / whitespace', !U.isTranslatable('') && !U.isTranslatable('   '));
check('rejects a single character', !U.isTranslatable('a'));
check('accepts normal prose', U.isTranslatable('Hello world'));
check('accepts CJK', U.isTranslatable('你好世界'));
check('rejects pure digits', !U.isTranslatable('12345 67890'));
check('rejects pure punctuation', !U.isTranslatable('--- ... ---'));
check('accepts a short CJK word', U.isTranslatable('设置'));
check('rejects oversized blocks', !U.isTranslatable('a'.repeat(U.MAX_UNIT_CHARS + 1)));
check('accepts a block at the size limit', U.isTranslatable('a'.repeat(U.MAX_UNIT_CHARS)));
check('skip list covers code/pre/script', ['CODE', 'PRE', 'SCRIPT', 'STYLE', 'SVG'].every((t) => U.SKIP_TAGS.has(t)));
check('block list covers the usual containers', ['DIV', 'P', 'LI', 'TD', 'H1'].every((t) => U.BLOCK_TAGS.has(t)));

// ---------------------------------------------------------------------------
console.log('\nlanguage mapping + settings merge');
// ---------------------------------------------------------------------------
check('normalizeLang zh-CN -> zh-Hans', S.normalizeLang('zh-CN') === 'zh-Hans');
check('normalizeLang zh-TW -> zh-Hant', S.normalizeLang('zh-TW') === 'zh-Hant');
check('normalizeLang en-US -> en', S.normalizeLang('en-US') === 'en');
check('ENGINE_LANG deepl maps zh-Hans -> ZH', NS.constants.ENGINE_LANG.deepl['zh-Hans'] === 'ZH');
check('ENGINE_LANG google maps zh-Hant -> zh-TW', NS.constants.ENGINE_LANG.google['zh-Hant'] === 'zh-TW');

const merged = NS.utils.deepMerge({ a: { b: 1, c: 2 }, d: 3 }, { a: { c: 9 } });
check('deepMerge merges nested', merged.a.b === 1 && merged.a.c === 9 && merged.d === 3, JSON.stringify(merged));

check('getPath dot path', NS.utils.getPath({ a: { b: { c: 7 } } }, 'a.b.c') === 7);
check('getPath bracket index', NS.utils.getPath({ r: [{ t: 'hi' }] }, 'r[0].t') === 'hi');

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('failing checks: ' + failures.join(', '));
  process.exit(1);
}
