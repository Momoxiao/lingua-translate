/**
 * Lingua — external link check.
 *
 * This deliberately is NOT part of `npm run check`. It makes real network
 * requests and third-party sites rate-limit, so putting it in CI would create
 * red builds that mean nothing. Run it by hand before a launch:
 *
 *   node scripts/check-links.mjs
 *
 * It flags links that return 404/410, which is what an actual visitor sees as
 * broken. 401/403 from a vendor API endpoint is reported as INFO, not a failure:
 * the repository links to these as configuration examples and they require a key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'README.md',
  'README.zh-CN.md',
  'docs/index.html',
  'PRIVACY.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'store/SUBMISSION.md',
];

/**
 * Links that are intentionally not real, or are documented as placeholders.
 * API base URLs belong here too: they are request endpoints, not pages. A GET
 * on the bare path legitimately returns 404 on several vendors, which says
 * nothing about whether the documented endpoint works.
 */
const SKIP = [
  /^https?:\/\/localhost[:/]/,
  /^https:\/\/api\.example\.com\//,
  /^https:\/\/www\.youtube\.com\/watch\?v=xxxx$/,
  /^https:\/\/api\.deepseek\.com\/v1$/,
  /^https:\/\/api\.groq\.com\/openai\/v1$/,
  /^https:\/\/api\.moonshot\.cn\/v1$/,
  /^https:\/\/api\.openai\.com\/v1$/,
  /^https:\/\/api\.siliconflow\.cn\/v1$/,
  /^https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1$/,
  /^https:\/\/open\.bigmodel\.cn\/api\/paas\/v4$/,
  /^https:\/\/openrouter\.ai\/api\/v1$/,
];

function collect() {
  const urls = new Set();
  for (const file of FILES) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const match of text.matchAll(/https?:\/\/[^\s")<>\]`]+/g)) {
      const url = match[0].replace(/[.,;:]+$/, '');
      if (SKIP.some((re) => re.test(url))) continue;
      urls.add(url);
    }
  }
  return [...urls].sort();
}

async function head(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; LinguaLinkCheck/1.0)' },
      signal: AbortSignal.timeout(20000),
    });
    // Docker Hub blocks HEAD; drain a little so the socket is not left hanging.
    try { await res.body?.cancel(); } catch (e) { /* ignore */ }
    return res.status;
  } catch (e) {
    return 0;
  }
}

const urls = collect();
console.log(`\n检查 ${urls.length} 个外部链接...\n`);

let broken = 0;
let warned = 0;
const results = await Promise.all(urls.map(async (url) => ({ url, status: await head(url) })));

for (const { url, status } of results) {
  if (status === 404 || status === 410) {
    broken++;
    console.log(`FAIL ${status}  ${url}`);
  } else if (status === 0 || status === 401 || status === 403 || status === 429) {
    warned++;
    console.log(`INFO ${status}  ${url}`);
  } else {
    console.log(`ok   ${status}  ${url}`);
  }
}

console.log(`\n${results.length - broken} 可访问 / ${broken} 断链 / ${warned} 需忽略（鉴权或限流）`);
process.exitCode = broken ? 1 : 0;
