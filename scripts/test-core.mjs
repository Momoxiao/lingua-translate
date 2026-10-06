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
// youtube.js parses URLs, so it needs a `location` to read. The rest of its
// browser surface (store / bridge / overlay) is only touched inside functions
// this file never calls — the exported helpers below are deliberately the pure
// ones, because track selection and caption-URL handling are what actually
// breaks when YouTube changes, and they are the part of that file a test can
// reach without a network.
globalThis.location = { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', origin: 'https://www.youtube.com' };

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
  'src/content/page/profile.js',
  'src/content/youtube.js',
]) {
  load(f);
}

const NS = globalThis.Lingua;
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
console.log('\nyoutube: video id from URL');
// ---------------------------------------------------------------------------
const Y = NS.youtube;

/** youtube.js reads the real `location`, so point it somewhere for one call. */
function atUrl(href, fn) {
  const prev = location.href;
  location.href = href;
  const out = fn();
  location.href = prev;
  return out;
}

check('watch page', atUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', Y.videoIdFromUrl) === 'dQw4w9WgXcQ');
check(
  'extra query params are ignored',
  atUrl('https://www.youtube.com/watch?v=abc123&t=42&list=PL1', Y.videoIdFromUrl) === 'abc123'
);
check('shorts', atUrl('https://www.youtube.com/shorts/xyz789', Y.videoIdFromUrl) === 'xyz789');
check('embed', atUrl('https://www.youtube.com/embed/emb123', Y.videoIdFromUrl) === 'emb123');
check('live', atUrl('https://www.youtube.com/live/liv123', Y.videoIdFromUrl) === 'liv123');
check('nocookie embed', atUrl('https://www.youtube-nocookie.com/embed/nc123', Y.videoIdFromUrl) === 'nc123');
check('watch without v is empty', atUrl('https://www.youtube.com/watch', Y.videoIdFromUrl) === '');
check('the home page is empty', atUrl('https://www.youtube.com/', Y.videoIdFromUrl) === '');
check('a non-YouTube host still parses (the host check lives elsewhere)',
  atUrl('https://example.com/watch?v=nope', Y.videoIdFromUrl) === 'nope');

// ---------------------------------------------------------------------------
console.log('\nyoutube: track selection');
// ---------------------------------------------------------------------------
const TRACKS = [
  { languageCode: 'en', name: 'English', kind: '' },
  { languageCode: 'en', name: 'English (auto-generated)', kind: 'asr' },
  { languageCode: 'ja', name: '日本語', kind: '' },
  { languageCode: 'de', name: 'Deutsch', kind: 'asr' },
];

check('no tracks -> null', Y.pickTrack([], 'auto', -1) === null);
check('an explicit source language wins', Y.pickTrack(TRACKS, 'ja', 0) === TRACKS[2]);
check('an explicit language wins even when it is ASR', Y.pickTrack(TRACKS, 'de', 0) === TRACKS[3]);
check('a loose language match is accepted', Y.pickTrack(TRACKS, 'en-US', -1) === TRACKS[0]);
check(
  'an unknown source language falls back instead of returning nothing',
  Y.pickTrack(TRACKS, 'xx', -1) === TRACKS[0]
);
check('auto is not treated as a language code', Y.pickTrack(TRACKS, 'auto', 2) === TRACKS[2]);
// The track YouTube pairs with the audio is the video's original language, and
// the only one guaranteed to span the whole video — a partial manual track is
// worse. So defaultIndex outranks the manual-over-ASR preference.
check(
  'the default index outranks the manual-over-ASR preference',
  Y.pickTrack(TRACKS, 'auto', 1) === TRACKS[1]
);
check('without a default index, manual beats ASR', Y.pickTrack(TRACKS, 'auto', -1) === TRACKS[0]);
check('an out-of-range default index falls through', Y.pickTrack(TRACKS, 'auto', 99) === TRACKS[0]);
const asrOnly = [
  { languageCode: 'fr', kind: 'asr' },
  { languageCode: 'en', kind: 'asr' },
];
check('with only ASR tracks, en/zh is preferred', Y.pickTrack(asrOnly, 'auto', -1) === asrOnly[1]);
check(
  'with only ASR tracks and no en/zh, the first is used',
  Y.pickTrack([{ languageCode: 'fr', kind: 'asr' }], 'auto', -1).languageCode === 'fr'
);

// ---------------------------------------------------------------------------
console.log('\nyoutube: caption URL handling');
// ---------------------------------------------------------------------------
const SIGNED =
  'https://www.youtube.com/api/timedtext?v=abc&lang=en&pot=TOKEN123&potc=1&c=WEB&fmt=json3&signature=xyz';
const BAD_URL = 'http://[';

const pot = Y.potParamsFrom(SIGNED);
check('pot params extracted', !!pot && pot.pot === 'TOKEN123', JSON.stringify(pot));
check('pot defaults fmt to json3', !!pot && pot.fmt === 'json3');
check('pot carries potc and c through', !!pot && pot.potc === '1' && pot.c === 'WEB');
check('a URL without pot yields null', Y.potParamsFrom('https://www.youtube.com/api/timedtext?v=abc') === null);
check('an empty URL yields null', Y.potParamsFrom('') === null);
check('a malformed URL yields null rather than throwing', Y.potParamsFrom(BAD_URL) === null);
const potDefaults = Y.potParamsFrom('https://www.youtube.com/api/timedtext?pot=T&signature=s');
check('missing potc/c get the documented defaults', potDefaults.potc === '1' && potDefaults.c === 'WEB');

// The whole point of withParams: the signature and the token must survive.
const signedMerged = Y.withParams(SIGNED, { fmt: 'json3', tlang: 'zh-Hans' });
check('withParams keeps the signature', /signature=xyz/.test(signedMerged), signedMerged);
check('withParams keeps the pot', /pot=TOKEN123/.test(signedMerged), signedMerged);
check('withParams sets a new param', /tlang=zh-Hans/.test(signedMerged), signedMerged);
check('withParams replaces rather than duplicates', (signedMerged.match(/fmt=/g) || []).length === 1, signedMerged);
check('withParams skips null values', !/tlang=/.test(Y.withParams(SIGNED, { tlang: null })));
check('withParams returns the input on a bad URL', Y.withParams(BAD_URL, { a: 'b' }) === BAD_URL);

check('langOf reads the track language', Y.langOf(SIGNED) === 'en', Y.langOf(SIGNED));
check('langOf is empty when absent', Y.langOf('https://www.youtube.com/api/timedtext?v=abc') === '');
check('langOf tolerates a malformed URL', Y.langOf(BAD_URL) === '');

// ---------------------------------------------------------------------------
console.log('\nyoutube: transcript panel parsing');
// ---------------------------------------------------------------------------
const seg = (text, startMs, endMs) => ({
  transcriptSegmentRenderer: { snippet: { runs: [{ text }] }, startMs, endMs },
});
const transcriptResponse = (segments) => ({
  actions: [
    { someUnrelatedAction: {} },
    {
      updateEngagementPanelAction: {
        content: {
          transcriptRenderer: {
            body: {
              transcriptSearchPanelRenderer: {
                body: { transcriptSegmentListRenderer: { initialSegments: segments } },
              },
            },
          },
        },
      },
    },
  ],
});

const parsed = Y.parseTranscript(
  transcriptResponse([
    seg('Hello', 0, 1500),
    seg('world', 1500, 3000),
    { transcriptSegmentRenderer: { snippet: {}, startMs: 3000, endMs: 4000 } },
    { notASegment: true },
  ])
);
check('transcript segments -> cues', parsed.length === 2, `got ${parsed.length}`);
check('transcript ms -> seconds', parsed[0].start === 0 && Math.abs(parsed[0].end - 1.5) < 1e-9, JSON.stringify(parsed[0]));
check('transcript text comes from the runs', parsed[1].text === 'world', parsed[1].text);
check('segments without runs are skipped', !parsed.some((c) => !c.text));

// endMs is optional in this payload, and a zero-length cue would be invisible to
// the scheduler, so it has to be defaulted rather than taken literally.
const noEnd = Y.parseTranscript(transcriptResponse([seg('Only start', 2000, 0)]));
check('a missing end time gets a sane default', noEnd[0].end > noEnd[0].start, JSON.stringify(noEnd[0]));

check('an unrelated action yields no cues', Y.parseTranscript({ actions: [{ updateEngagementPanelAction: {} }] }).length === 0);
check('a missing actions array yields no cues', Y.parseTranscript({}).length === 0);
check('null yields no cues rather than throwing', Y.parseTranscript(null).length === 0);

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
check('page prompt documents the link placeholders', /⟦1⟧/.test(pagePrompt) && /⟦\/1⟧/.test(pagePrompt));
check('page prompt tells the model to keep the markers intact', /never translate, rename, renumber/.test(pagePrompt));
check('subtitle prompt does NOT mention link placeholders', !/⟦/.test(subPrompt));

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
console.log('\nreasoning control (default off, with graceful fallback)');
// ---------------------------------------------------------------------------
const rSettings = await NS.settings.getSettings();
rSettings.provider = 'openai';
rSettings.providers.openai.baseUrl = 'https://example.test/v1';
rSettings.providers.openai.model = 'm';
rSettings.providers.openai.apiKey = 'k';
rSettings.cacheEnabled = false;

let lastBody = null;
const okReply = (b) => {
  const lines = b.messages[1].content.split('\n').filter((l) => l.trim());
  const out = lines.map((l) => l.replace(/^(\d+)\.\s*/, '$1. 译'));
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: out.join('\n') } }] }), { status: 200 });
};

globalThis.fetch = async (url, opts) => {
  lastBody = JSON.parse(opts.body);
  return okReply(lastBody);
};

rSettings.providers.openai.reasoning = 'off';
await NS.bg.translator.translate(['alpha one', 'beta two'], { settings: rSettings, from: 'en', to: 'zh-Hans' });
check('reasoning=off sends reasoning_effort=none', lastBody.reasoning_effort === 'none', JSON.stringify(lastBody.reasoning_effort));
check('reasoning=off sends thinking.type=disabled', !!lastBody.thinking && lastBody.thinking.type === 'disabled', JSON.stringify(lastBody.thinking));
check('reasoning=off still sends the normal payload', lastBody.model === 'm' && Array.isArray(lastBody.messages));

rSettings.providers.openai.reasoning = 'auto';
await NS.bg.translator.translate(['gamma three'], { settings: rSettings, from: 'en', to: 'zh-Hans' });
check('reasoning=auto omits reasoning_effort', lastBody.reasoning_effort === undefined);
check('reasoning=auto omits thinking', lastBody.thinking === undefined);

// An endpoint that rejects unknown fields must not break translation.
const seen = [];
globalThis.fetch = async (url, opts) => {
  const b = JSON.parse(opts.body);
  seen.push(b.reasoning_effort !== undefined);
  if (b.reasoning_effort !== undefined) {
    return new Response(JSON.stringify({ error: { message: 'Unrecognized field: reasoning_effort' } }), { status: 400 });
  }
  return okReply(b);
};
rSettings.providers.openai.reasoning = 'off';
const fallbackOut = await NS.bg.translator.translate(['delta four'], { settings: rSettings, from: 'en', to: 'zh-Hans' });
check('a 400 on the hints triggers exactly one retry without them', seen.length === 2 && seen[0] === true && seen[1] === false, JSON.stringify(seen));
check('the retry still returns a translation', !!(fallbackOut.results[0] || '').includes('译'), fallbackOut.results[0]);

// once rejected, later requests skip the hints entirely
const seen2 = [];
globalThis.fetch = async (url, opts) => {
  const b = JSON.parse(opts.body);
  seen2.push(b.reasoning_effort !== undefined);
  return okReply(b);
};
await NS.bg.translator.translate(['epsilon five'], { settings: rSettings, from: 'en', to: 'zh-Hans' });
check('the hints are not retried again in the same session', seen2.length === 1 && seen2[0] === false, JSON.stringify(seen2));

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
console.log('\nprovider readiness matches what each service really needs');
// ---------------------------------------------------------------------------
const D = NS.constants.DEFAULT_SETTINGS;
const readyFor = (provider, cfg) =>
  NS.settings.providerReady({
    provider,
    providers: Object.assign({}, D.providers, { [provider]: Object.assign({}, D.providers[provider], cfg) }),
  });

check('google needs nothing (free endpoint)', readyFor('google', {}) === true);
check('deepl needs a key', readyFor('deepl', { apiKey: '' }) === false && readyFor('deepl', { apiKey: 'k' }) === true);
check(
  'openai needs baseUrl + model (local endpoints need no key)',
  readyFor('openai', { baseUrl: '', model: '' }) === false &&
    readyFor('openai', { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', apiKey: '' }) === true
);
check('custom needs a url', readyFor('custom', { url: '' }) === false && readyFor('custom', { url: 'https://x' }) === true);
// Azure's region header is only mandatory for a regional resource, so requiring
// it here would lock out anyone on a global one. A missing region is surfaced in
// the pane instead of gating the pipeline.
check(
  'microsoft needs a key, but not a region (global resources omit it)',
  readyFor('microsoft', { apiKey: '', region: 'eastasia' }) === false &&
    readyFor('microsoft', { apiKey: 'k', region: '' }) === true
);

// ---------------------------------------------------------------------------
console.log('\nadaptive translation profile');
// ---------------------------------------------------------------------------
const apProf = NS.page.profile;
const apBase = { host: '', path: '/', lang: 'en', ogType: '', jsonLd: [], codeBlocks: 0, inlineCode: 0, mathNodes: 0, citations: 0, timeStamps: 0, articles: 0, comments: 0, prices: 0 };
const apSig = (over) => Object.assign({}, apBase, over);
const apWinner = (over) => {
  const s = apProf.score(apSig(over));
  let best = 'general';
  let top = 0;
  for (const id of ['tech', 'academic', 'news', 'forum', 'commerce']) {
    if (s[id] > top) {
      top = s[id];
      best = id;
    }
  }
  return top >= apProf.CONFIDENCE_THRESHOLD ? best : 'general';
};

check('a docs site with code blocks reads as technical', apWinner({ host: 'vuejs.org', path: '/guide/introduction.html', codeBlocks: 8, inlineCode: 40 }) === 'tech');
check('a /docs path alone is enough to lean technical', apWinner({ host: 'example.com', path: '/docs/api/overview', codeBlocks: 0 }) === 'tech');
check('a docs subdomain alone is enough', apWinner({ host: 'docs.example.com', path: '/', codeBlocks: 0 }) === 'tech');
check('a code-heavy tutorial reads as technical', apWinner({ host: 'blog.example.com', path: '/post/1', codeBlocks: 4 }) === 'tech');
check('a paper on arxiv reads as academic', apWinner({ host: 'arxiv.org', path: '/abs/2401.00001', mathNodes: 30, citations: 5 }) === 'academic');
check('a NewsArticle schema reads as news', apWinner({ host: 'example.com', jsonLd: ['NewsArticle'], ogType: 'article', timeStamps: 4, articles: 1 }) === 'news');
check('a comment-heavy thread reads as forum', apWinner({ host: 'news.ycombinator.com', comments: 25 }) === 'forum');
check('a Product schema with prices reads as commerce', apWinner({ host: 'shop.example.com', jsonLd: ['Product'], ogType: 'product', prices: 3 }) === 'commerce');

// The interesting failure mode is over-triggering: a blog post with one code
// sample must NOT be treated as API documentation.
check('a single code block does not make a page technical', apWinner({ host: 'blog.example.com', path: '/post/1', codeBlocks: 1 }) === 'general');
check('an ordinary page stays general', apWinner({ host: 'example.com', path: '/about' }) === 'general');
check('no signals at all is safe', apWinner({}) === 'general');

check('an explicit mode wins over detection', apProf.detect('academic').id === 'academic' && apProf.detect('academic').confidence === 'manual');
check('an unknown mode falls back to detection', apProf.detect('nonsense').id === 'general');
check('detect() without a DOM degrades to general', apProf.detect().id === 'general');
check('detect() always reports a label', !!apProf.detect().label && !!apProf.detect('tech').label);

const apP = NS.bg.prompts;
check('the neutral profile adds nothing to the prompt', apP.profileLines({ id: 'general' }).length === 0);
check('a user note alone is still injected', apP.profileLines({ id: 'general', notes: '保留英文术语' }).join('\n').indexOf('保留英文术语') !== -1);
const apTechLines = apP.profileLines({ id: 'tech' }).join('\n');
check('the technical profile names the context', apTechLines.indexOf('technical documentation') !== -1, apTechLines);
check('the technical profile carries its directives', apTechLines.indexOf('code identifiers') !== -1, apTechLines);

const apPagePrompt = apP.systemPrompt('en', 'zh-Hans', 'page', { id: 'tech' });
check('the page prompt includes the profile', apPagePrompt.indexOf('technical documentation') !== -1);
check(
  'the output-format rules still come last',
  apPagePrompt.indexOf('technical documentation') < apPagePrompt.indexOf('Rules:'),
  `profile@${apPagePrompt.indexOf('technical documentation')} rules@${apPagePrompt.indexOf('Rules:')}`
);
check('the subtitle prompt is untouched by default', apP.systemPrompt('en', 'zh-Hans', 'subtitle').indexOf('Context:') === -1);
check('profileSuffix is empty for the neutral profile', apP.profileSuffix({ id: 'general' }) === '');
check('profileSuffix starts a new paragraph', apP.profileSuffix({ id: 'tech' }).indexOf('\n\n') === 0);

// ---------------------------------------------------------------------------
console.log('\ntypography is one system across four surfaces');
// ---------------------------------------------------------------------------
// The popup and options page read their stacks from theme.css custom
// properties; the floating ball and the subtitle overlay build styles in a JS
// template string inside a shadow root and read them from constants.js. A CSS
// custom property cannot be imported into a JS string, so the duplication is
// unavoidable — what is avoidable is letting the two drift apart.
const themeCss = fs.readFileSync(path.join(ROOT, 'src/ui/theme.css'), 'utf8');
const cssFont = (name) => {
  const m = new RegExp(`--font-${name}\\s*:([\\s\\S]*?);`).exec(themeCss);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
};
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
check('theme.css defines --font-body', !!cssFont('body'));
check(
  'theme.css --font-body matches constants.FONTS.body',
  cssFont('body') === norm(NS.constants.FONTS.body),
  `css=${cssFont('body')}\n         js =${norm(NS.constants.FONTS.body)}`
);
check(
  'theme.css --font-display matches constants.FONTS.display',
  cssFont('display') === norm(NS.constants.FONTS.display),
  `css=${cssFont('display')}`
);
check(
  'theme.css --font-mono matches constants.FONTS.mono',
  cssFont('mono') === norm(NS.constants.FONTS.mono),
  `css=${cssFont('mono')}`
);

// The content-script surfaces must actually use the shared stack, not a
// hand-written near-copy of it (ui-sans-serif vs system-ui is exactly the kind
// of difference that goes unnoticed until the two look subtly off).
const ballSrc = fs.readFileSync(path.join(ROOT, 'src/content/page/ball.js'), 'utf8');
const overlaySrc = fs.readFileSync(path.join(ROOT, 'src/content/overlay.js'), 'utf8');
check('the floating ball uses the shared stack', ballSrc.indexOf('${FONTS.body}') !== -1);
check('the subtitle overlay uses the shared stack', overlaySrc.indexOf('${FONTS.body}') !== -1);
check(
  'no surface hard-codes its own sans stack any more',
  !/(system-ui|ui-sans-serif),-apple-system/.test(ballSrc + overlaySrc),
  'found a hand-written stack'
);

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('failing checks: ' + failures.join(', '));
  process.exit(1);
}
