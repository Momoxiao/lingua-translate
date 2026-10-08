/**
 * Static guard for scripts/smoke-youtube.mjs.
 *
 * The live smoke test only runs against real YouTube, so a typo in its output
 * path can survive every offline suite and only surface after a long browser
 * run. That happened with a local `state` variable referenced outside its
 * scope, which hid the useful diagnosis behind "state is not defined".
 *
 * This is deliberately narrow: it checks the two output blocks that need the
 * parsed state and verifies they reference `final`, the variable in scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'scripts', 'smoke-youtube.mjs'), 'utf8');

const outputStart = source.indexOf('    if (final) {');
const outputEnd = source.indexOf('    const v = verdict(final, net, capLog);', outputStart);
if (outputStart === -1 || outputEnd === -1) {
  console.error('smoke script output block could not be located');
  process.exit(1);
}

const outputBlock = source.slice(outputStart, outputEnd);
const badState = /\bstate\.capDom\b/.test(outputBlock);
const goodState = /\bfinal\.capDom\b/.test(outputBlock);
if (badState || !goodState) {
  console.error('smoke output block must read capDom from `final`, not the loop-scoped `state`');
  process.exit(1);
}

console.log('ok   scripts/smoke-youtube.mjs — output block reads capDom from the parsed final state');
