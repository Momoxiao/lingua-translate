/**
 * Lingua — probe whether YouTube's transcript endpoint is an unsigned caption path.
 *
 * The problem this answers, precisely:
 *
 * `youtube.js` already knows how to parse `/youtubei/v1/get_transcript` (see
 * `parseTranscript`), and `inject.js` already forwards it, and `bridge.js`
 * already routes it to a listener. All three pieces exist. What does NOT exist
 * anywhere in the codebase is anything that makes the page ISSUE that request —
 * `forceCaptionRequest()` only clicks the CC button, which produces a signed
 * `/api/timedtext` request instead.
 *
 * That matters because `/api/timedtext` is the path measured to fail: with the
 * video genuinely playing and captions switched on, YouTube answers it HTTP 200
 * with a 0-byte body and no `pot` (see `npm run smoke`). The transcript
 * endpoint is a different endpoint, used by YouTube's own "Show transcript"
 * panel, and panels are not PoToken-gated in the same way.
 *
 * So this script drives a real window, clicks YouTube's own transcript button,
 * and reports whether a get_transcript response with real segments came back —
 * without the extension in the picture at all. If it works, the fix in
 * `youtube.js` is a fifth strategy; if it does not, the honest README stays as
 * it is and no speculative code gets written.
 *
 * Usage: node scripts/probe-transcript.mjs [videoId] [--headed]
 * Exit code 0 only when an unsigned caption response was actually observed.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveChrome } from './lib/chrome.mjs';
import { connect, attach } from './lib/cdp.mjs';

const VIDEO = (process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1])) || 'dQw4w9WgXcQ';
const HEADED = process.argv.includes('--headed');
const PORT = 9333;

const chromePath = resolveChrome();
if (!chromePath) {
  console.error('No Chrome/Chromium/Edge found — cannot probe.');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lingua-probe-'));

const args = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  'about:blank',
];
if (HEADED) args.unshift('--window-size=1280,900');
else args.unshift('--disable-gpu', '--headless=new');

const chrome = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

let cdp;
try {
  await sleep(2500);
  ({ cdp } = await connect(PORT));
} catch (e) {
  console.error('could not attach to Chrome:', e.message);
  try { chrome.kill('SIGKILL'); } catch (x) { /* ignore */ }
  process.exit(1);
}

const { targetInfos } = await cdp.send('Target.getTargets');
const page = targetInfos.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target');
  try { chrome.kill('SIGKILL'); } catch (e) { /* ignore */ }
  process.exit(1);
}

// Record every get_transcript request/response BEFORE the page loads, in the
// page's own world, so the extension is not involved at any point.
await cdp.send(
  'Page.addScriptToEvaluateOnNewDocument',
  {
    source: `(() => {
      window.__lt = [];
      const rec = (u, s, b) => { try { window.__lt.push({ u: String(u).slice(0, 140), s: s, len: b.length, head: b.slice(0, 300) }); } catch (e) {} };
      const of = window.fetch;
      window.fetch = function (i, init) {
        const u = typeof i === 'string' ? i : (i && i.url);
        const p = of.apply(this, arguments);
        if (/get_transcript/.test(u || '')) {
          p.then(function (r) { r.clone().text().then(function (b) { rec(u, r.status, b); }).catch(function () {}); }).catch(function () {});
        }
        return p;
      };
      const XO = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return XO.apply(this, arguments); };
      const XS = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        const u = this.__u, self = this;
        if (/get_transcript/.test(u || '')) {
          this.addEventListener('loadend', function () { try { rec(u, self.status, self.responseText || ''); } catch (e) {} });
        }
        return XS.apply(this, arguments);
      };
    })();`,
  },
  (await attach(cdp, page.targetId)).sessionId
).catch(() => {});

const view = await attach(cdp, page.targetId);
await cdp.send('Page.navigate', { url: `https://www.youtube.com/watch?v=${VIDEO}` }, view.sessionId);
console.log(`[probe] ${HEADED ? 'headed' : 'headless'} · https://youtube.com/watch?v=${VIDEO}`);
await sleep(10000);

const player = await view.evalPage(`(function(){
  var v = document.querySelector('video');
  var b = document.querySelector('.ytp-subtitles-button');
  return JSON.stringify({ hasVideo: !!v, paused: v ? v.paused : null, t: v ? Math.round(v.currentTime) : null,
    ccButton: !!b, ccPressed: b ? b.getAttribute('aria-pressed') : null });
})()`);
console.log('[probe] player:', player);

// The transcript entry lives inside the collapsed description panel, so open it
// first. Clicking while collapsed finds nothing, which reads as "no such path"
// when it is really "the button was not in the DOM yet".
const expanded = await view.evalPage(`(function(){
  var b = document.querySelector('#expand, tp-yt-paper-button#expand, ytd-text-inline-expander #expand');
  if (!b) return 'no expand button';
  b.click();
  return 'expanded description';
})()`);
console.log('[probe] description:', expanded);
await sleep(2500);

// Click YouTube's own "Show transcript" button, exactly as a user would. The
// label is localised and is NOT the same word as "caption": on the zh locale it
// reads 转写文稿 / 内容转文字, so match every observed spelling.
const clicked = await view.evalPage(`(function(){
  var all = Array.prototype.slice.call(document.querySelectorAll('button, ytd-button-renderer, tp-yt-paper-button, yt-button-shape'));
  var t = all.find(function (b) {
    var s = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || ''));
    return /transcript|transcri|转写|转文字|转录|字幕文稿|文字起こし/i.test(s);
  });
  if (!t) return JSON.stringify({ found: false, saw: all.map(function (b) { return (b.textContent || '').trim().slice(0, 22); }).filter(Boolean).slice(0, 30) });
  t.click();
  return JSON.stringify({ found: true, label: (t.textContent || t.getAttribute('aria-label') || '').trim().slice(0, 48) });
})()`);
console.log('[probe] show-transcript click:', clicked);
await sleep(7000);

const log = JSON.parse((await view.evalPage('JSON.stringify(window.__lt || [])')) || '[]');
const segs = await view.evalPage(`(function(){
  var s = document.querySelectorAll('ytd-transcript-segment-renderer');
  return JSON.stringify({ count: s.length, first: s.length ? (s[0].textContent || '').trim().slice(0, 80) : null });
})()`);
console.log('[probe] get_transcript responses:', log.length);
for (const r of log) console.log(`         HTTP ${r.s} · ${r.len}B · ${r.u}`);
console.log('[probe] transcript panel:', segs);

const good = log.some((r) => r.len > 200);
console.log('');
if (good) {
  console.log('RESULT  the transcript endpoint returned real data with no PoToken.');
  console.log('        => a fifth caption strategy is worth wiring into extractCues().');
} else {
  console.log('RESULT  no unsigned caption payload observed here.');
  console.log('        => do NOT add speculative code; the README limitation stands.');
}

try { chrome.kill('SIGKILL'); } catch (e) { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(good ? 0 : 1);
