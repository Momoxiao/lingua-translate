/**
 * Lingua — i18n catalogue guard.
 *
 * English is the second product catalogue, but it is not a separate source:
 * every `tr("Chinese", "catalogue.key")` call silently falls back to Chinese
 * when the key is missing. That makes a typo invisible in the English UI,
 * exactly where a missing string is hardest for the author to notice.
 *
 * This guard reads the catalogue and the source, then fails when a referenced
 * key is missing or an English value still contains Chinese. It also reports
 * unused entries as a warning rather than deleting strings the UI may still be
 * migrating toward. It understands static `tr()` / `k()` calls, HTML data-i18n
 * attributes, popup status keys and the one deliberately dynamic `reason.*`
 * prefix.
 *
 * Zero dependencies, like the rest of the repository. The small tokenizer is
 * intentional: a regex that stops at the first `)` misreads calls whose first
 * argument contains an interpolated template.
 *
 * Usage: node scripts/check-i18n.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_ASSERTIONS = 8;

let passed = 0;
let failed = 0;
let warnings = 0;
function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function warn(label, detail) {
  warnings++;
  console.log(`  warn ${label}${detail ? ` — ${detail}` : ''}`);
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function walk(dir, extensions, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(relative, extensions, out);
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) out.push(relative);
  }
  return out;
}

// The catalogue is a plain classic script so the extension can load it without
// a bundler. Loading it here through Node's normal module path keeps the audit
// tied to the exact object shipped to the browser.
const messagesUrl = pathToFileURL(path.join(ROOT, 'src/shared/messages.js')).href;
await import(`${messagesUrl}?i18n-audit=${Date.now()}`);
const EN = globalThis.Lingua && globalThis.Lingua.i18n && globalThis.Lingua.i18n.catalog.en;
if (!EN || typeof EN !== 'object') {
  console.error('FAIL could not load src/shared/messages.js');
  process.exit(1);
}

const sourceFiles = walk('src', new Set(['.js', '.html']));
const jsFiles = sourceFiles.filter((file) => file.endsWith('.js'));
const htmlFiles = sourceFiles.filter((file) => file.endsWith('.html'));
const sources = new Map(sourceFiles.map((file) => [file, read(file)]));
const catalogueSource = read('src/shared/messages.js');

/**
 * Tokenize just enough JavaScript to find call arguments without treating
 * punctuation inside strings or templates as structure.
 */
function tokenize(code) {
  const tokens = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      i = code.indexOf('\n', i + 2);
      if (i === -1) break;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      const start = i++;
      let value = '';
      while (i < code.length) {
        if (code[i] === '\\') {
          value += code.slice(i, i + 2);
          i += 2;
        } else if (code[i] === quote) {
          i++;
          break;
        } else {
          value += code[i++];
        }
      }
      tokens.push({ type: 'string', value, raw: code.slice(start, i), index: start });
      continue;
    }
    if (c === '`') {
      const start = i++;
      let depth = 0;
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 2;
        } else if (code[i] === '`' && depth === 0) {
          i++;
          break;
        } else if (code[i] === '$' && code[i + 1] === '{') {
          depth++;
          i += 2;
        } else if (code[i] === '}' && depth > 0) {
          depth--;
          i++;
        } else {
          i++;
        }
      }
      tokens.push({ type: 'template', raw: code.slice(start, i), index: start });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i++;
      while (i < code.length && /[A-Za-z0-9_$]/.test(code[i])) i++;
      tokens.push({ type: 'identifier', value: code.slice(start, i), index: start });
      continue;
    }
    tokens.push({ type: 'punct', value: c, index: i++ });
  }
  return tokens;
}

function splitCallArguments(tokens, openIndex) {
  const args = [];
  let current = [];
  let depth = 0;
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) {
      depth++;
    } else if (token.type === 'punct' && (token.value === ')' || token.value === ']' || token.value === '}')) {
      if (token.value === ')' && depth === 0) {
        args.push(current);
        return args;
      }
      depth--;
    } else if (token.type === 'punct' && token.value === ',' && depth === 0) {
      args.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  return args;
}

function stringValue(tokens) {
  if (!tokens || tokens.length !== 1) return null;
  const token = tokens[0];
  if (token.type === 'string' && !token.raw.includes('\\')) return token.value;
  return null;
}

function callKeys(code, names) {
  const tokens = tokenize(code);
  const found = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type === 'template') {
      // Calls inside `${…}` are real calls too. Recursing over the template
      // body catches them without having to model the full expression grammar.
      found.push(...callKeys(tokens[i].raw.slice(1, -1), names));
      continue;
    }
    if (tokens[i].type !== 'identifier' || !names.has(tokens[i].value)) continue;
    if (tokens[i + 1].type !== 'punct' || tokens[i + 1].value !== '(') continue;
    const args = splitCallArguments(tokens, i + 1);
    const key = stringValue(names.has('tr') && tokens[i].value === 'tr' ? args[1] : args[0]);
    if (key) found.push(key);
  }
  return found;
}

const literalKeys = [...catalogueSource.matchAll(/^ {4}'([^']+)':/gm)].map((match) => match[1]);
const catalogueKeys = Object.keys(EN);
const uniqueLiteralKeys = new Set(literalKeys);
check(
  literalKeys.length === catalogueKeys.length && uniqueLiteralKeys.size === literalKeys.length,
  'the English catalogue has no duplicate keys',
  `${literalKeys.length} literals / ${uniqueLiteralKeys.size} unique / ${catalogueKeys.length} parsed`
);

const chineseValues = Object.entries(EN).filter(([, value]) => /[\u3400-\u9fff]/.test(String(value)));
check(
  chineseValues.length === 0,
  'the English catalogue contains no untranslated Han characters',
  chineseValues.map(([key]) => key).join(', ')
);

const emptyValues = Object.entries(EN).filter(([, value]) => !String(value).trim());
check(
  emptyValues.length === 0,
  'every English catalogue entry is non-empty',
  emptyValues.map(([key]) => key).join(', ')
);

const usedKeys = new Set();
const references = new Map();
function addReference(key, file) {
  if (!key) return;
  usedKeys.add(key);
  if (!references.has(key)) references.set(key, []);
  references.get(key).push(file);
}

for (const file of jsFiles) {
  const code = sources.get(file);
  for (const key of callKeys(code, new Set(['tr', 'k']))) addReference(key, file);
  for (const match of code.matchAll(/\bkey\s*:\s*(['"])([a-z][A-Za-z0-9_.-]*)\1/g)) {
    if (match[2].includes('.')) addReference(match[2], file);
  }
}

for (const file of htmlFiles) {
  const html = sources.get(file);
  for (const match of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) addReference(match[1], file);
  for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(';')) {
      const colon = pair.indexOf(':');
      if (colon > 0) addReference(pair.slice(colon + 1).trim(), file);
    }
  }
}

const missing = [...usedKeys].filter((key) => !(key in EN)).sort();
check(
  usedKeys.size > 0,
  'the audit found translation references in the source',
  `found ${usedKeys.size}`
);
check(
  missing.length === 0,
  'every static translation reference exists in the English catalogue',
  missing.join(', ')
);

const dynamicPrefixes = new Set();
for (const file of jsFiles) {
  for (const match of sources.get(file).matchAll(/(['"])([a-z][A-Za-z0-9_.-]*\.)\1\s*\+/g)) {
    dynamicPrefixes.add(match[2]);
  }
}
const dynamicKeys = new Set();
for (const prefix of dynamicPrefixes) {
  for (const key of catalogueKeys) if (key.startsWith(prefix)) dynamicKeys.add(key);
}
check(
  dynamicPrefixes.has('reason.'),
  'the dynamic reason-prefix reference is still discovered',
  [...dynamicPrefixes].join(', ')
);
check(
  dynamicKeys.size >= 5,
  'the dynamic reason-prefix resolves to real catalogue entries',
  `found ${dynamicKeys.size}`
);

// Unused entries are not a correctness failure: a few generic verbs are kept
// deliberately while the UI is still changing, and removing them wholesale
// would make this guard noisier than the bug it exists to catch. Report them so
// the count stays visible and cannot grow silently.
const orphaned = catalogueKeys.filter((key) => !usedKeys.has(key) && !dynamicKeys.has(key));
if (orphaned.length) {
  const byPrefix = new Map();
  for (const key of orphaned) {
    const prefix = key.split('.')[0];
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(key);
  }
  warn(
    `${orphaned.length} English catalogue entries are not referenced`,
    [...byPrefix.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([prefix, keys]) => `${prefix}=${keys.length}`)
      .join(', ')
  );
}

const malformed = catalogueKeys.filter((key) => !/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)+$/.test(key));
check(
  malformed.length === 0,
  'every catalogue key follows the namespace.key format',
  malformed.join(', ')
);

console.log(
  `\ni18n catalogue · ${catalogueKeys.length} keys / ${usedKeys.size} static references / ${warnings} warning${warnings === 1 ? '' : 's'}`
);
if (passed !== EXPECTED_ASSERTIONS) {
  failed++;
  console.log(`FAIL assertion count drifted: the pin says ${EXPECTED_ASSERTIONS}, this run made ${passed}`);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
