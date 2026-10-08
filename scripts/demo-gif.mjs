/**
 * Lingua — build the README demo GIF.
 *
 * The caption pipeline itself cannot be automated: whether YouTube hands the
 * player a usable Proof-of-Origin token is a race, and the player only renders
 * captions in a real foreground player. A live recording therefore cannot be a
 * reproducible CI artifact.
 *
 * This script keeps the honest half reproducible: the player chrome and the
 * playback clock are fixtures, but every subtitle frame goes through the real
 * `src/content/overlay.js` render path. It asks `scripts/preview.mjs` to render
 * one PNG per cue with `PLAYER_CUE`, then hands those frames to ffmpeg. If the
 * overlay's CSS, visibility rules or bilingual layout change, the frames change
 * with them.
 *
 * Zero npm dependencies. ffmpeg is required only for this optional demo asset;
 * `npm run check`, the release package and a normal install do not need it.
 *
 * Usage: node scripts/demo-gif.mjs [outDir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs'));
const FRAMES = path.join(os.tmpdir(), `lingua-demo-frames-${process.pid}`);
const FPS = 8;
const HOLD_FRAMES = 10; // 1.25 s per cue at 8 fps
const CUES = 4;

function hasFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

if (!hasFfmpeg()) {
  console.error('ffmpeg not found — skipping demo GIF. Install ffmpeg and rerun:');
  console.error('  node scripts/demo-gif.mjs');
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(FRAMES, { recursive: true });

try {
  for (let i = 0; i < CUES; i++) {
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'preview.mjs'), FRAMES, 'player-yt-1x'],
      {
        cwd: ROOT,
        env: { ...process.env, PLAYER_CUE: String(i) },
        stdio: 'inherit',
      }
    );
    const rendered = path.join(FRAMES, 'player-yt-1x.png');
    if (!fs.existsSync(rendered)) throw new Error(`frame ${i} was not rendered`);
    fs.renameSync(rendered, path.join(FRAMES, `cue-${i}.png`));
  }

  const gif = path.join(OUT, 'lingua-demo.gif');
  const palette = path.join(FRAMES, 'palette.png');
  const input = String(HOLD_FRAMES) + ' * ' + String(CUES);

  // Build one long stream by repeating each still, then quantise once. A
  // per-frame palette makes the dark player chrome flicker; a shared palette
  // keeps the UI stable and the file much smaller.
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-framerate', '1',
      '-i', path.join(FRAMES, 'cue-%d.png'),
      '-vf', `fps=${FPS},tpad=stop_mode=clone:stop_duration=0.25,palettegen=stats_mode=full`,
      palette,
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );

  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-framerate', '1',
      '-i', path.join(FRAMES, 'cue-%d.png'),
      '-i', palette,
      '-lavfi',
      `fps=${FPS},tpad=stop_mode=clone:stop_duration=0.25[p];[p][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
      '-loop', '0',
      gif,
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );

  const stat = fs.statSync(gif);
  if (!stat.size || stat.size > 8 * 1024 * 1024) {
    throw new Error(`demo GIF is ${stat.size} bytes; expected a non-empty file under 8 MB`);
  }
  console.log(`ok   ${path.relative(ROOT, gif)} — ${Math.round(stat.size / 1024)} KB`);
} finally {
  try {
    fs.rmSync(FRAMES, { recursive: true, force: true });
  } catch (e) {
    /* the temp directory is disposable */
  }
}
