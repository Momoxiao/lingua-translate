/**
 * Lingua — release-asset guard.
 *
 * The store listings, README and GitHub social card all quote exact image
 * dimensions. Those files are generated, but a regeneration on a machine with
 * a different device scale factor can silently produce 2560x1600 instead of the
 * required 1280x800, or put an alpha channel back into a file the store
 * rejects. This checks the bytes that are actually committed, before upload.
 *
 * Zero dependencies, like the rest of the repository: a PNG header and chunk
 * walk is enough to read the width, height and alpha channel.
 *
 * Usage: node scripts/check-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
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

function read(file) {
  return fs.readFileSync(path.join(ROOT, file));
}

function readText(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read the metadata the stores care about without an image library.
 *
 * `tRNS` matters in addition to the colour type: a truecolour PNG can carry
 * transparency in a separate chunk while still reporting colour type 2, and the
 * stores reject that too.
 */
function readPng(file) {
  const data = read(file);
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { error: 'not a PNG' };
  }

  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const colorType = data[25];
  let hasAlpha = colorType === 4 || colorType === 6;
  let sawIend = false;

  for (let offset = 8; offset + 12 <= data.length; ) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (type === 'tRNS') hasAlpha = true;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
    offset += 12 + length;
  }

  return { width, height, hasAlpha, error: sawIend ? '' : 'missing IEND' };
}

const IMAGE_RULES = [
  { file: 'icons/icon16.png', width: 16, height: 16, alpha: 'any' },
  { file: 'icons/icon32.png', width: 32, height: 32, alpha: 'any' },
  { file: 'icons/icon48.png', width: 48, height: 48, alpha: 'any' },
  { file: 'icons/icon128.png', width: 128, height: 128, alpha: 'any' },
  { file: 'store/icon-300.png', width: 300, height: 300, alpha: 'any' },
  { file: 'store/promo-440x280.png', width: 440, height: 280, alpha: 'none' },
  { file: 'store/promo-1400x560.png', width: 1400, height: 560, alpha: 'none' },
  { file: 'docs/social-preview.png', width: 1280, height: 640, alpha: 'none' },
];

for (const rule of IMAGE_RULES) {
  const file = path.join(ROOT, rule.file);
  if (!fs.existsSync(file)) {
    failed++;
    console.log(`  FAIL ${rule.file} exists`);
    continue;
  }

  const png = readPng(rule.file);
  check(!png.error, `${rule.file} is a complete PNG`, png.error);

  const sizeOk = png.width === rule.width && png.height === rule.height;
  check(
    sizeOk,
    `${rule.file} is exactly ${rule.width}x${rule.height}`,
    png.error ? png.error : `got ${png.width}x${png.height}`
  );

  if (rule.alpha === 'none') {
    check(!png.hasAlpha, `${rule.file} has no alpha channel`, 'store rejected metadata');
  }
}

const SCREENSHOT_NAMES = [
  '01-youtube-bilingual.png',
  '02-page-bilingual.png',
  '03-page-replace.png',
  '04-popup.png',
  '05-diagnostics.png',
];

for (const dir of ['store/screenshots', 'store/screenshots-en']) {
  const expected = SCREENSHOT_NAMES.map((name) => `${dir}/${name}`);
  const actual = fs.existsSync(path.join(ROOT, dir))
    ? fs.readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith('.png')).sort()
    : [];

  check(
    actual.length === SCREENSHOT_NAMES.length,
    `${dir} contains exactly ${SCREENSHOT_NAMES.length} screenshots`,
    `found ${actual.length}`
  );

  for (const file of expected) {
    if (!fs.existsSync(path.join(ROOT, file))) {
      failed++;
      console.log(`  FAIL ${file} exists`);
      continue;
    }
    const png = readPng(file);
    check(png.width === 1280 && png.height === 800, `${file} is exactly 1280x800`, `got ${png.width}x${png.height}`);
    check(!png.hasAlpha, `${file} has no alpha channel`, 'store rejected metadata');
  }
}

const manifest = JSON.parse(readText('manifest.json'));
const pkg = JSON.parse(readText('package.json'));
check(
  typeof manifest.description === 'string' && manifest.description.length <= 132,
  'manifest description fits the store limit',
  `got ${manifest.description ? manifest.description.length : 0} characters`
);
check(
  manifest.version === pkg.version,
  'manifest and package versions agree',
  `manifest=${manifest.version}, package=${pkg.version}`
);

const readme = readText('README.md');
const referencedDocs = [
  ...readme.matchAll(/<img[^>]+src="(docs\/[^"]+)"[^>]*>/g),
  ...readme.matchAll(/!\[[^\]]*\]\((docs\/[^)]+)\)/g),
].map((m) => m[1]);

for (const file of [...new Set(referencedDocs)].sort()) {
  check(fs.existsSync(path.join(ROOT, file)), `README image exists: ${file}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
