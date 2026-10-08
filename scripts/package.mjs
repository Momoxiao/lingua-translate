/**
 * Lingua — build the distributable zip.
 *
 * A GitHub Release auto-attaches "Source code (zip)", which is the whole repo:
 * tests, screenshots, CI config, README. That is not something you can point
 * Chrome's "Load unpacked" at. This builds the real artifact — manifest, src,
 * icons, LICENSE — and nothing else.
 *
 * Hand-rolled instead of shelling out to `zip`: the project has no build step
 * and no dependencies, and a system zip binary is not guaranteed to exist.
 * Node's zlib does the compression; the container is written by hand.
 *
 * The output is deterministic (fixed timestamps, sorted entries), so rebuilding
 * the same source yields the same bytes and a published SHA-256 stays
 * meaningful.
 *
 * Usage: node scripts/package.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Everything the extension needs at runtime, and nothing else. */
const INCLUDE_DIRS = ['src', 'icons'];
const INCLUDE_FILES = ['manifest.json', 'LICENSE'];
const SKIP = /(^|\/)(\.DS_Store|Thumbs\.db)$/;

// ---------------------------------------------------------------------------
// Minimal ZIP writer
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// 2026-01-01 00:00:00 in DOS format. Fixed so the archive is reproducible.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Store uncompressed when deflating made it bigger (already-compressed PNGs).
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra field
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attributes
    // `<< 16` overflows into the sign bit, so coerce back to unsigned.
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: regular file
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralBuf, end]);
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------
function walk(dir, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (SKIP.test(rel)) continue;
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push({ name: rel, data: fs.readFileSync(full) });
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

const entries = [];
for (const dir of INCLUDE_DIRS) walk(path.join(ROOT, dir), entries);
for (const file of INCLUDE_FILES) {
  entries.push({ name: file, data: fs.readFileSync(path.join(ROOT, file)) });
}
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// Guard: a release zip that is missing a file the manifest points at installs
// fine and then fails at runtime, which is exactly the kind of thing nobody
// notices until a user reports it. Check every referenced path up front.
const packed = new Set(entries.map((e) => e.name));
const referenced = [
  manifest.background && manifest.background.service_worker,
  manifest.action && manifest.action.default_popup,
  manifest.options_ui && manifest.options_ui.page,
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
].filter(Boolean);

const missing = [...new Set(referenced)].filter((p) => !packed.has(p));
if (missing.length) {
  console.error('manifest 引用了包里没有的文件：');
  for (const p of missing) console.error(`  ${p}`);
  process.exit(1);
}

const zip = buildZip(entries);

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `lingua-${version}.zip`);
fs.writeFileSync(outPath, zip);

const sha = crypto.createHash('sha256').update(zip).digest('hex');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

// Written next to the zip instead of only printed. The published checksum has to
// match the published bytes, and "copy the hash out of the terminal into a file"
// is exactly the manual step where the two drift apart — most quietly when the
// zip is rebuilt after a source change and the old hash is left in place.
// Format is what `shasum -a 256 -c` expects: hash, two spaces, filename.
const shaPath = `${outPath}.sha256`;
fs.writeFileSync(shaPath, `${sha}  lingua-${version}.zip\n`);

console.log(`lingua-${version}.zip`);
console.log(`  文件数: ${entries.length}`);
console.log(`  manifest 引用: ${new Set(referenced).size} 条，全部存在`);
console.log(`  大小:   ${kb(zip.length)}（未压缩 ${kb(entries.reduce((s, e) => s + e.data.length, 0))}）`);
console.log(`  sha256: ${sha}`);
console.log(`  校验:   ${path.relative(ROOT, shaPath)}`);
console.log(`  路径:   ${path.relative(ROOT, outPath)}`);
console.log('');
for (const e of entries) console.log(`  ${e.name}`);
