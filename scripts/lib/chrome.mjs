/**
 * Lingua — locate a Chrome/Chromium binary.
 *
 * Four harnesses need this and each used to carry its own copy of the list.
 * They drifted: preview.mjs was missing the Linux paths the other three had, so
 * the screenshot tool silently no-op'd anywhere but macOS. One list, one place.
 *
 * CHROME_PATH wins when set — the escape hatch for a browser installed somewhere
 * unusual (a CI image, a snap, a custom prefix).
 */
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
];

const NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/** Absolute path to a usable browser, or null when there is none. */
export function resolveChrome() {
  const override = process.env.CHROME_PATH;
  if (override) return isFile(override) ? override : null;

  for (const p of CANDIDATES) if (isFile(p)) return p;

  // Scanning PATH ourselves keeps this free of a subprocess (and of `which`,
  // which is not guaranteed to exist).
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of NAMES) {
      const p = path.join(dir, name);
      if (isFile(p)) return p;
    }
  }
  return null;
}
