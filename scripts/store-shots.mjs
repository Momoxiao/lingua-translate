/**
 * Lingua — compose the Chrome Web Store / Edge Add-ons screenshots.
 *
 * Why this is a separate pass from preview.mjs: the store imposes an exact
 * canvas (1280x800, 16:10) and requires the UI to be *composed* onto it with a
 * caption, not merely scaled. `preview.mjs` renders each surface at its own
 * natural size, which is right for the README and wrong for a store listing.
 * Keeping them apart also means a README layout tweak cannot silently break the
 * store listing.
 *
 * The UI images are read from docs/ and inlined as data URIs, because the canvas
 * is a generated file written outside the repo tree and relative <img> paths
 * would not resolve from it.
 *
 * Zero dependencies: composition is HTML+CSS in the Chrome we already locate,
 * exactly like every other harness here. Pillow and ImageMagick are NOT used —
 * requiring either would break the project's "clone and run" promise.
 *
 * Usage:
 *   node scripts/preview.mjs docs          # refresh the UI images first
 *   node scripts/store-shots.mjs [outDir] # default: store/screenshots
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveChrome } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'store', 'screenshots'));
const DOCS = path.join(ROOT, 'docs');

const W = 1280;
const H = 800;

/**
 * The five store screenshots, in the order the stores show them.
 *
 * `fit` decides how a source image meets the card, and it matters more than it
 * looks: an `object-fit: cover` card cropped the 16:9 player frame on both sides
 * and sliced the video title in half, which is the one line that explains the
 * feature. So:
 *
 *   natural — scale to the card width, keep the source's own aspect ratio. The
 *             card grows to suit. Anything taller than the card crops from the
 *             TOP, which is right for a page screenshot (the interesting part is
 *             the header and hero) and wrong for a screenshot whose point is at
 *             the bottom.
 *   contain — show the whole image, centred, letterboxed on paper. Used for
 *             surfaces that are narrow and tall, where cropping would cut off
 *             the very controls the screenshot exists to show.
 */
const SHOTS = [
  {
    name: '01-youtube-bilingual',
    kicker: 'YouTube',
    title: 'Bilingual subtitles, already translated',
    body: 'The whole caption track is fetched up front and translated ahead of the playhead, so the line is there when it is spoken.',
    src: 'player-yt.png',
    url: 'youtube.com/watch?v=…',
    fit: 'natural',
  },
  {
    name: '02-page-bilingual',
    kicker: 'Web pages',
    title: 'Read the original and the translation together',
    body: 'The original stays in the DOM. Nothing is overwritten, so the page keeps its layout, its links and its meaning.',
    src: 'page-bilingual.png',
    url: 'developer.mozilla.org/…',
    fit: 'natural',
  },
  {
    name: '03-page-replace',
    kicker: 'Web pages',
    title: 'Or translated only, one click back',
    body: 'Replacing is a CSS class flip, not a re-render: no flash, and a failed translation can never lose the original text.',
    src: 'page-replace.png',
    url: 'developer.mozilla.org/…',
    fit: 'natural',
  },
  {
    name: '04-popup',
    kicker: 'Popup',
    title: 'Everything live, next to the video',
    body: 'Progress, source track, display mode and language — shown for the page you are actually on, not a generic settings screen.',
    src: 'popup-yt-page.png',
    url: 'chrome-extension://lingua/popup.html',
    fit: 'contain',
  },
  {
    name: '05-diagnostics',
    kicker: 'Diagnostics',
    title: 'When it fails, it tells you which layer failed',
    body: 'Was the content script injected? Is the worker alive? How many cues arrived? Which stage stalled? One click, pasteable.',
    src: 'diagnostics.png',
    url: 'chrome-extension://lingua/diagnostics.html',
    fit: 'natural',
  },
];

const chromePath = resolveChrome();
if (!chromePath) {
  console.error('No Chrome/Chromium/Edge binary found — cannot compose store screenshots.');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });

/** Inline a PNG as a data URI, or null when the UI image has not been rendered yet. */
function dataUri(file) {
  const p = path.join(DOCS, file);
  if (!fs.existsSync(p)) return null;
  return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
}

function canvasHtml(shot) {
  const uri = dataUri(shot.src);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lingua — ${shot.name}</title>
<style>
  :root{ color-scheme: light; }
  *{ box-sizing:border-box; margin:0; }
  html,body{ width:${W}px; height:${H}px; overflow:hidden; }
  body{
    /* Warm editorial paper, matching src/ui/theme.css rather than a stock gradient. */
    background:
      radial-gradient(120% 90% at 8% 0%, #ffffff 0%, rgba(255,255,255,0) 55%),
      linear-gradient(150deg,#faf7f2 0%,#f2ece2 58%,#eadfd0 100%);
    color:#191612;
    font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;
    display:flex; align-items:center; gap:52px; padding:0 60px 0 68px;
  }
  /* A single vermilion hairline down the left edge — the brand mark, quiet. */
  body::before{ content:""; position:absolute; left:0; top:0; bottom:0; width:5px;
    background:linear-gradient(180deg,#e4572e,#b23f1d); }

  .copy{ width:436px; flex:0 0 auto; }
  .kicker{
    display:inline-block; font-size:12.5px; font-weight:700; letter-spacing:.14em;
    text-transform:uppercase; color:#b23f1d; background:#fdeee8;
    border:1px solid #f6d8cc; border-radius:999px; padding:5px 12px; margin-bottom:20px;
  }
  h1{
    font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
    font-size:41px; line-height:1.14; font-weight:600; letter-spacing:-.012em; margin-bottom:18px;
  }
  p{ font-size:16.5px; line-height:1.62; color:#4b433a; }

  /* The UI card: a browser-ish frame so a screenshot reads as a product, not a crop. */
  .card{
    flex:1 1 auto; border-radius:14px; overflow:hidden; background:#fff;
    border:1px solid #ddd2c4;
    box-shadow:0 26px 60px rgba(25,22,18,.20), 0 3px 10px rgba(25,22,18,.10);
  }
  .bar{
    height:34px; display:flex; align-items:center; gap:7px; padding:0 14px;
    background:#f2ece2; border-bottom:1px solid #e2d7c9;
  }
  .dot{ width:10px; height:10px; border-radius:50%; background:#d6caba; }
  .url{
    flex:1; margin-left:8px; height:20px; border-radius:5px; background:#fff;
    border:1px solid #e2d7c9; font-size:11.5px; color:#8a7f74;
    display:flex; align-items:center; padding:0 9px; font-family:ui-monospace,monospace;
    overflow:hidden; white-space:nowrap;
  }
  /*
   * The viewport clips; the image keeps its own proportions.
   *
   * Deliberately NOT object-fit cover: cover scales a SHORT image up to fill the
   * box, which cropped both sides of the 16:9 player frame and sliced the video
   * title in half. Here a short image simply rests at the top of a taller box
   * (the blank space below is honest), and a tall image is clipped at the bottom,
   * which is the right end to lose for a page screenshot.
   *
   * NB: this whole file is one JS template literal — there must be no backtick
   * anywhere inside it, comments included.
   */
  .viewport{ height:566px; overflow:hidden; background:#fff;
    display:flex; align-items:flex-start; justify-content:center; }
  .shot{ width:100%; height:auto; display:block; }
  /* The "contain" case: the whole image, centred. For narrow tall surfaces (the
     popup) where cropping would cut off the very controls the shot is about. */
  .viewport.contain{ align-items:center; }
  .viewport.contain .shot{ width:auto; height:100%; max-width:100%; }
  .missing{
    height:566px; display:flex; align-items:center; justify-content:center;
    color:#c0392b; font:12px/1.5 ui-monospace,monospace; text-align:center; padding:20px;
  }
</style></head>
<body>
  <div class="copy">
    <span class="kicker">${shot.kicker}</span>
    <h1>${shot.title}</h1>
    <p>${shot.body}</p>
  </div>
  <div class="card">
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="url">${shot.url || ''}</span></div>
    <div class="viewport${shot.fit === 'contain' ? ' contain' : ''}">
    ${uri ? `<img class="shot" src="${uri}" alt="">`
          : `<div class="missing">docs/${shot.src} not found — run: node scripts/preview.mjs docs</div>`}
    </div>
  </div>
</body></html>`;
}

function render(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
      resolve({ err });
    };
    const timer = setTimeout(finish, timeoutMs);
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('exit', () => setTimeout(finish, 80));
  });
}

let failed = 0;
for (const shot of SHOTS) {
  const tmp = path.join(ROOT, `__store-${shot.name}.html`);
  fs.writeFileSync(tmp, canvasHtml(shot));
  const out = path.join(OUT, `${shot.name}.png`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `lingua-store-${shot.name}-`));

  await render([
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    // 1x: the store measures the file, so 1280x800 must be the real pixel size.
    '--force-device-scale-factor=1',
    '--virtual-time-budget=4000',
    `--screenshot=${out}`,
    `file://${tmp}`,
  ]);

  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  fs.unlinkSync(tmp);

  if (!dataUri(shot.src)) {
    failed++;
    console.log(`FAIL ${shot.name} — docs/${shot.src} is missing`);
  } else if (!fs.existsSync(out)) {
    failed++;
    console.log(`FAIL ${shot.name} — no screenshot produced`);
  } else {
    const bytes = fs.statSync(out).size;
    console.log(`ok   ${shot.name} — ${W}x${H}, ${Math.round(bytes / 1024)} KB`);
  }
}

console.log(`\n${SHOTS.length - failed}/${SHOTS.length} store screenshots in ${OUT}`);
process.exitCode = failed ? 1 : 0;
