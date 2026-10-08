/**
 * Lingua — release-facing images that are not UI screenshots.
 *
 * Two assets the stores and GitHub ask for and that `preview.mjs` / `store-shots.mjs`
 * deliberately do not produce:
 *
 *   store/icon-300.png         Edge Add-ons recommends a 300x300 icon.
 *   docs/social-preview.png    GitHub's 1280x640 link card.
 *
 * Both are rendered in Chrome from inline HTML, so there is no image library and
 * no binary build step to rot. The icon intentionally reuses the same geometry
 * and colors as the toolbar mark in `make-icons.py`; keeping two hand-drawn logo
 * implementations would guarantee they drift.
 *
 * Usage: node scripts/release-assets.mjs
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
  console.error('No Chrome/Chromium/Edge binary found — cannot render release assets.');
  process.exit(0);
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
  <rect x="6" y="6" width="288" height="288" rx="72" fill="#1a1714"/>
  <rect x="66" y="93" width="168" height="31.5" rx="13.5" fill="#a89e92"/>
  <rect x="66" y="163.5" width="120" height="31.5" rx="13.5" fill="#e4572e"/>
</svg>`;

const SOCIAL = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  html,body{width:1280px;height:640px;overflow:hidden}
  body{
    position:relative;
    color:#191612;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:
      radial-gradient(90% 110% at 88% 0%,#fff 0%,rgba(255,255,255,0) 58%),
      linear-gradient(145deg,#faf7f2 0%,#f2ece2 62%,#e9ddcd 100%);
    display:flex;align-items:center;padding:0 76px;gap:50px;
  }
  body::before{content:"";position:absolute;left:0;top:0;bottom:0;width:7px;background:#e4572e}
  .copy{width:600px;flex:0 0 auto}
  .mark{display:flex;align-items:center;gap:12px;margin-bottom:26px}
  .mark svg{display:block}
  .name{font:600 25px/1 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;letter-spacing:.01em}
  h1{font:600 54px/1.1 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;letter-spacing:-.012em;margin-bottom:20px}
  p{font-size:20px;line-height:1.5;color:#4b433a;width:570px}
  .chips{display:flex;gap:9px;margin-top:28px}
  .chip{font-size:12.5px;font-weight:700;color:#b23f1d;background:#fdeee8;border:1px solid #f6d8cc;border-radius:999px;padding:6px 11px}
  .frame{position:absolute;box-sizing:border-box;width:500px;right:76px;top:118px;border:1px solid #d8ccbd;border-radius:13px;overflow:hidden;background:#fff;
    box-shadow:0 25px 55px rgba(25,22,18,.19),0 3px 9px rgba(25,22,18,.09)}
  .frame img{width:100%;height:auto;display:block}
</style></head>
<body>
  <div class="copy">
    <div class="mark">
      <svg width="36" height="36" viewBox="0 0 300 300" aria-hidden="true">
        <rect x="6" y="6" width="288" height="288" rx="72" fill="#1a1714"/>
        <rect x="66" y="93" width="168" height="31.5" rx="13.5" fill="#a89e92"/>
        <rect x="66" y="163.5" width="120" height="31.5" rx="13.5" fill="#e4572e"/>
      </svg>
      <span class="name">Lingua</span>
    </div>
    <h1>Bilingual YouTube subtitles,<br>with your own translation API.</h1>
    <p>Whole-page translation too. No account, no server of ours, and your API key never leaves your machine.</p>
    <div class="chips"><span class="chip">OPEN SOURCE</span><span class="chip">MANIFEST V3</span><span class="chip">ZERO DEPENDENCIES</span></div>
  </div>
  <div class="frame"><img src="${dataUri('player-yt-1x.png')}" alt=""></div>
</body></html>`;

function dataUri(file) {
  const p = path.join(ROOT, 'docs', file);
  return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
}

function render(html, width, height, outPath) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(ROOT, `__release-${path.basename(outPath, '.png')}.html`);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lingua-release-'));
    fs.writeFileSync(tmp, html);
    const proc = spawn(chromePath, [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--force-device-scale-factor=1',
      '--virtual-time-budget=4000',
      `--screenshot=${outPath}`,
      `file://${tmp}`,
    ]);
    let err = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Chrome did not exit after writing the screenshot')), 60000);
    const finish = (failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      // Chrome on macOS can keep its main process alive after --screenshot has
      // written a valid file. The file is the deliverable; do not fail a good
      // render just because the process needed the timeout to reap.
      const ok = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
      if (ok) resolve();
      else reject(failure || new Error(err || 'Chrome produced no screenshot'));
    };
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('exit', () => finish());
    // macOS Chrome writes the screenshot and then may sit in its event loop.
    // Poll for the artifact so a valid render returns as soon as it is on disk.
    const poll = setInterval(() => {
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        clearInterval(poll);
        setTimeout(() => finish(), 120);
      }
    }, 100);
    proc.on('close', () => clearInterval(poll));
  });
}

const iconOut = path.join(ROOT, 'store', 'icon-300.png');
const socialOut = path.join(ROOT, 'docs', 'social-preview.png');
fs.mkdirSync(path.dirname(iconOut), { recursive: true });

await render(
  `<!doctype html><html><body style="margin:0;background:transparent"><div style="width:300px;height:300px">${ICON}</div></body></html>`,
  300,
  300,
  iconOut
);
await render(SOCIAL, 1280, 640, socialOut);

console.log(`ok   ${path.relative(ROOT, iconOut)} — 300x300`);
console.log(`ok   ${path.relative(ROOT, socialOut)} — 1280x640`);
