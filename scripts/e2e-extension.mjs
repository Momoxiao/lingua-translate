/**
 * Lingua — real-browser end-to-end test.
 *
 * Boots a local OpenAI-compatible mock, launches Chrome with a clean profile,
 * loads the unpacked extension through CDP (the `--load-extension` flag no
 * longer works in Chrome 137+), drives a real page over real HTTP, and asserts
 * the whole pipeline: content-script injection -> unit discovery -> batched
 * translation request -> DOM rendering -> restore.
 *
 * Zero npm dependencies: the CDP transport is a ~120-line WebSocket client built
 * on node:net / node:crypto (Node's built-in WebSocket is rejected by Chrome's
 * DevTools endpoint, and pulling in `ws` would break the project's no-dep rule).
 *
 * Usage: node scripts/e2e-extension.mjs [--headed] [--keep]
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');
const CDP_PORT = 9333 + Math.floor(Math.random() * 40);

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// 1. Minimal WebSocket client (CDP transport)
// ===========================================================================
class TinyWS {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.onText = null;
    this.onClose = null;
    this.open = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const isSecure = this.url.protocol === 'wss:';
      const port = Number(this.url.port || (isSecure ? 443 : 80));
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(port, this.url.hostname);
      this.socket = socket;

      const timer = setTimeout(() => reject(new Error('ws handshake timeout')), 10000);
      let handshake = Buffer.alloc(0);
      let upgraded = false;

      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      socket.on('data', (chunk) => {
        if (!upgraded) {
          handshake = Buffer.concat([handshake, chunk]);
          const end = handshake.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = handshake.subarray(0, end).toString('latin1');
          if (!/^HTTP\/1\.1 101/.test(head)) {
            clearTimeout(timer);
            reject(new Error('ws upgrade failed: ' + head.split('\r\n')[0]));
            return;
          }
          upgraded = true;
          this.open = true;
          clearTimeout(timer);
          const rest = handshake.subarray(end + 4);
          handshake = Buffer.alloc(0);
          resolve();
          if (rest.length) this._feed(rest);
          return;
        }
        this._feed(chunk);
      });

      socket.on('close', () => {
        this.open = false;
        if (this.onClose) this.onClose();
      });

      const req =
        `GET ${this.url.pathname || '/'} HTTP/1.1\r\n` +
        `Host: ${this.url.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        `Origin: http://${this.url.host}\r\n\r\n`;
      socket.write(req);
    });
  }

  _feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const buf = this.buffer;
    let off = 0;
    while (buf.length - off >= 2) {
      const b0 = buf[off];
      const b1 = buf[off + 1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let p = off + 2;
      if (len === 126) {
        if (buf.length - p < 2) break;
        len = buf.readUInt16BE(p);
        p += 2;
      } else if (len === 127) {
        if (buf.length - p < 8) break;
        len = Number(buf.readBigUInt64BE(p));
        p += 8;
      }
      let mask = null;
      if (masked) {
        if (buf.length - p < 4) break;
        mask = buf.subarray(p, p + 4);
        p += 4;
      }
      if (buf.length - p < len) break;
      let payload = buf.subarray(p, p + len);
      if (mask) {
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      off = p + len;

      if (opcode === 0x8) {
        this.open = false;
        this._sendFrame(Buffer.alloc(0), 0x8);
        this.socket.end();
        if (this.onClose) this.onClose();
        return;
      }
      if (opcode === 0x9) {
        this._sendFrame(payload, 0xa); // pong
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          if (this.onText) this.onText(text);
        }
      }
    }
    this.buffer = buf.subarray(off);
  }

  _sendFrame(payload, opcode) {
    const len = payload.length;
    const lenBytes = len < 126 ? 0 : len < 65536 ? 2 : 8;
    const out = Buffer.alloc(2 + lenBytes + 4 + len);
    out[0] = 0x80 | opcode;
    let off = 2;
    if (lenBytes === 0) out[1] = 0x80 | len;
    else if (lenBytes === 2) {
      out[1] = 0x80 | 126;
      out.writeUInt16BE(len, off);
      off += 2;
    } else {
      out[1] = 0x80 | 127;
      out.writeBigUInt64BE(BigInt(len), off);
      off += 8;
    }
    const mask = crypto.randomBytes(4);
    mask.copy(out, off);
    off += 4;
    for (let i = 0; i < len; i++) out[off + i] = payload[i] ^ mask[i & 3];
    this.socket.write(out);
  }

  send(str) {
    this._sendFrame(Buffer.from(str, 'utf8'), 0x1);
  }

  close() {
    try {
      this._sendFrame(Buffer.alloc(0), 0x8);
      this.socket.end();
    } catch (e) {
      /* ignore */
    }
  }
}

// ===========================================================================
// 2. Tiny CDP client (browser-level, flat sessions)
// ===========================================================================
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.onText = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (e) {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ' — ' + msg.error.data : ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        for (const h of this.listeners) h(msg);
      }
    };
    this.listeners = [];
  }

  onEvent(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

// ===========================================================================
// 3. Mock translation endpoint + fixture page
// ===========================================================================
const llmLog = [];

const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lingua E2E fixture</title>
<style>
  :root{color-scheme:light}
  body{margin:0;background:#fbf8f4;color:#1a1714;font:15px/1.65 system-ui,-apple-system,sans-serif}
  nav{display:flex;gap:20px;padding:14px 28px;border-bottom:1px solid #e6ddd1;background:#fff}
  nav a{color:#4a423a;text-decoration:none;font-weight:600}
  .navbtn{display:flex;align-items:center;gap:4px;border:0;background:none;font:600 15px system-ui;color:#4a423a;cursor:pointer}
  main{max-width:720px;margin:0 auto;padding:30px 28px 60px}
  h1{font-size:28px;margin:0 0 10px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0 22px}
  .card{border:1px solid #e6ddd1;border-radius:12px;padding:12px;background:#fff}
  .card b{display:block;font-size:13px;margin-bottom:4px}
  pre{background:#221e19;color:#f6f1ea;padding:14px;border-radius:10px;font:12.5px/1.6 monospace}
  table{border-collapse:collapse;width:100%;font-size:14px}
  td,th{border:1px solid #e6ddd1;padding:8px 10px;text-align:left}
  footer{border-top:1px solid #e6ddd1;padding:18px 28px;color:#7d7368;background:#fff}
</style></head>
<body>
<nav id="nav"><a href="#">Home</a><a href="#">Docs</a><a href="#">Pricing</a><button type="button" class="navbtn" id="flexnav" aria-expanded="false">Platform<svg data-component="Octicon" aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="m6.427 4.427 3.396 3.396a.25.25 0 0 1 0 .354l-3.396 3.396A.25.25 0 0 1 6 11.396V4.604a.25.25 0 0 1 .427-.177Z"></path></svg></button></nav>
<main>
  <h1 id="title">A translation extension must survive real pages</h1>
  <p id="para">This paragraph mixes <b>inline markup</b>, a <a href="#">link</a> and plain text.</p>
  <p id="linkp">Read the <a href="https://example.com/docs" id="doclink">documentation</a> for details.</p>
  <p id="plainp">No links in this paragraph at all.</p>
  <p id="brokenmark">A <a href="https://example.com/mangled">mangled link</a> the model will corrupt.</p>
  <p id="hoverp">Hover me: <a href="https://example.com/hover" id="hoverlink">preview link</a> here.</p>
  <div class="cards" id="cards">
    <div class="card"><b id="c1t">Flex &amp; grid</b><span id="c1s">Containers are never rewritten.</span></div>
    <div class="card"><b id="c2t">Nested blocks</b><span id="c2s">Each leaf block is its own unit.</span></div>
    <div class="card"><b id="c3t">Skip rules</b><span id="c3s">Code and forms are left alone.</span></div>
  </div>
  <ul id="list"><li id="li1">First list item</li><li id="li2">Second list item</li></ul>
  <pre id="code">const untouched = true; // must not be translated</pre>
  <table id="table"><tbody>
    <tr><th id="th1">Mode</th><th id="th2">Result</th></tr>
    <tr><td id="td1">Bilingual</td><td id="td2">Original stays visible.</td></tr>
  </tbody></table>
</main>
<footer id="footer">Footer text should also be translated.</footer>
<script>
  // Listeners attached to the ORIGINAL link, mirroring Wikipedia's hover
  // previews / SPA routers. They must keep working after translation.
  window.__linkClicks = 0;
  window.__linkHovers = 0;
  (function () {
    var a = document.getElementById('hoverlink');
    a.addEventListener('click', function (e) { e.preventDefault(); window.__linkClicks++; });
    a.addEventListener('mouseover', function () { window.__linkHovers++; });
  })();
  // Dynamic content is injected by the test itself (see addDynamicParagraph),
  // not on a timer: a timer made the assertion depend on how long the earlier
  // steps happened to take, so the paragraph sometimes existed before the first
  // scan and stopped being "dynamic" at all.
</script>
</body></html>`;

function startServer(port) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (url.pathname === '/fixture') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FIXTURE);
        return;
      }
      if (url.pathname === '/__log') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: llmLog.length, requests: llmLog }));
        return;
      }
      if (url.pathname === '/v1/chat/completions') {
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch (e) {
          res.writeHead(400).end('bad json');
          return;
        }
        const msgs = payload.messages || [];
        const sys = msgs.find((m) => m.role === 'system') || { content: '' };
        const usr = msgs.find((m) => m.role === 'user') || { content: '' };
        const lines = String(usr.content).split('\n').filter((l) => l.trim());
        llmLog.push({
          kind: /web page translator/i.test(sys.content) ? 'page' : 'subtitle',
          model: payload.model,
          batchSize: lines.length,
          first: lines[0] ? lines[0].slice(0, 60) : '',
        });
        const out = lines.map((l) => {
          const m = l.match(/^(\d+)\.\s*([\s\S]*)$/);
          const idx = m ? m[1] : '';
          const body = (m ? m[2] : l).trim();
          // Transform the content INSIDE each link placeholder too, so the test
          // can prove the marker content was routed into the link element.
          let marked = body.replace(/⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/g, (all, n, inner) => `⟦${n}⟧译:${inner.trim()}⟦/${n}⟧`);
          // Simulate a model that corrupts a placeholder (seen in the wild: the
          // opening bracket gets dropped), to prove we never leak residue.
          if (/mangle/i.test(body)) marked = marked.replace(/⟦(\d+)⟧/g, '⟧$1⟧');
          return `${idx}. 【译】${marked}`;
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            model: payload.model,
            choices: [{ index: 0, message: { role: 'assistant', content: out.join('\n') }, finish_reason: 'stop' }],
          })
        );
        return;
      }
      res.writeHead(404).end('not found');
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ===========================================================================
// 4. Assertions
// ===========================================================================
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}

// ===========================================================================
// 5. Main
// ===========================================================================
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.log('No Chrome/Chromium binary found — skipping E2E test.');
  process.exit(0);
}

const HTTP_PORT = 8799 + Math.floor(Math.random() * 60);
const PROFILE = path.join(os.tmpdir(), `lingua-e2e-profile-${process.pid}`);

/**
 * Sweep profiles left behind by earlier runs.
 *
 * The cleanup below only runs on a graceful exit, so a killed or interrupted run
 * (which happens a lot while iterating) strands a 40MB Chrome profile in the
 * system temp dir. This is self-healing: anything matching our own naming that
 * is not the profile for the current process is ours and safe to drop.
 */
function sweepStaleProfiles() {
  const tmp = os.tmpdir();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith('lingua-e2e-profile-')) continue;
      if (path.join(tmp, name) === PROFILE) continue;
      try {
        fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
        removed++;
      } catch (e) {
        /* in use — leave it */
      }
    }
  } catch (e) {
    /* temp dir unreadable — nothing to sweep */
  }
  if (removed) console.log(`[e2e] cleared ${removed} stale profile(s) from earlier runs`);
}
sweepStaleProfiles();

let chrome = null;
let server = null;
let cdp = null;

async function waitForCdp() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch (e) {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  server = await startServer(HTTP_PORT);
  console.log(`[e2e] mock server on http://127.0.0.1:${HTTP_PORT}`);

  chrome = spawn(
    chromePath,
    [
      ...(HEADED ? [] : ['--headless=new']),
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${PROFILE}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  const wsUrl = await waitForCdp();
  const ws = new TinyWS(wsUrl);
  await ws.connect();
  cdp = new CDP(ws);
  console.log(`[e2e] chrome ready on ${CDP_PORT}`);

  // --- load the unpacked extension (Chrome 137+ removed --load-extension) ---
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
  const extId = loaded.id || loaded.extensionId;
  console.log(`[e2e] extension loaded: ${extId}`);

  // --- find its service worker and configure it ---
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  let swTarget = null;
  for (let i = 0; i < 40 && !swTarget; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    swTarget = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    if (!swTarget) await sleep(250);
  }
  if (!swTarget) throw new Error('extension service worker never appeared');

  const swSession = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, swSession);

  const settings = {
    enabled: true,
    provider: 'openai',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    page: {
      autoTranslate: false,
      displayMode: 'bilingual',
      style: 'underline',
      batchSize: 6,
      maxChars: 800,
      concurrency: 2,
      autoSites: [],
      skipSites: [],
      skipSelectors: '',
      translateInputs: false,
    },
    providers: {
      openai: { baseUrl: `http://127.0.0.1:${HTTP_PORT}/v1`, apiKey: 'mock', model: 'mock-model', temperature: 0, prompt: '' },
    },
  };
  const setRes = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `chrome.storage.local.set({'lingua:settings:v1': ${JSON.stringify(settings)}}).then(() => 'settings-set')`,
      awaitPromise: true,
      returnByValue: true,
    },
    swSession
  );
  check('settings written through the extension service worker', setRes.result.value === 'settings-set', setRes.result.value);

  // --- open the fixture page ---
  const page = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${HTTP_PORT}/fixture` });
  const pageSession = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;

  const consoleErrors = [];
  const contexts = [];
  cdp.onEvent((ev) => {
    if (ev.sessionId !== pageSession) return;
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      consoleErrors.push(d.exception ? d.exception.description : d.text);
    }
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      consoleErrors.push(ev.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (ev.method === 'Runtime.executionContextCreated') {
      contexts.push(ev.params.context);
    }
  });
  await cdp.send('Runtime.enable', {}, pageSession);
  await cdp.send('Page.enable', {}, pageSession);

  // The content script runs in an isolated world: a non-default execution
  // context on the same frame. Find it so we can talk to the real Lingua object.
  let isoCtx = null;
  for (let i = 0; i < 40 && !isoCtx; i++) {
    isoCtx = contexts.find((c) => c.auxData && c.auxData.isDefault === false && c.name !== '');
    if (!isoCtx) await sleep(250);
  }
  if (!isoCtx) {
    console.log('  [debug] execution contexts seen:');
    for (const c of contexts) console.log(`    id=${c.id} name="${c.name}" origin=${c.origin} isDefault=${c.auxData && c.auxData.isDefault}`);
  }
  check('content script isolated world is present', !!isoCtx, contexts.map((c) => `${c.name}@${c.origin}`).join(' , '));

  const evalIso = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, contextId: isoCtx.id }, pageSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const evalPage = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, pageSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // --- start translation the way a user does: click the floating ball --------
  // This is the very first interaction on the page, which also covers the
  // "pipeline has no settings yet" path that an explicit page.start() would mask.
  const clickBall = () =>
    evalPage(`(function(){
      var b = document.getElementById('lingua-ball').shadowRoot.querySelector('.ball');
      var o = { bubbles: true, button: 0, pointerId: 1, clientX: 120, clientY: 120 };
      b.dispatchEvent(new PointerEvent('pointerdown', o));
      b.dispatchEvent(new PointerEvent('pointerup', o));
      return 1;
    })()`);

  // The isolated world appears as soon as the content script starts evaluating,
  // but the ball is mounted by boot() after an async storage read. Asserting on
  // the instant the context shows up is a race — poll instead.
  let ballMounted = false;
  for (let i = 0; i < 25 && !ballMounted; i++) {
    ballMounted = await evalPage(`!!document.getElementById('lingua-ball')`);
    if (!ballMounted) await sleep(100);
  }
  check('floating ball is mounted on the page', ballMounted);
  check(
    'ball host has a real hit-testable box',
    (await evalPage(
      `(function(){ var r = document.getElementById('lingua-ball').getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`
    )) === true,
    await evalPage(`JSON.stringify(document.getElementById('lingua-ball').getBoundingClientRect())`)
  );
  check(
    'ball starts in the idle state',
    (await evalPage(`document.getElementById('lingua-ball').shadowRoot.querySelector('.wrap').className`)).includes('idle')
  );

  // The badge must sit on the side that stays visible once the ball docks to an
  // edge — docking right hides everything but the left sliver.
  const dotGeo = JSON.parse(
    await evalPage(`(function(){
      var w = document.getElementById('lingua-ball').shadowRoot.querySelector('.wrap');
      var cs = getComputedStyle(w.querySelector('.dot'));
      return JSON.stringify({
        dockRight: w.classList.contains('dock-right'),
        dockLeft: w.classList.contains('dock-left'),
        left: cs.left,
        right: cs.right
      });
    })()`)
  );
  check(
    'the badge is anchored to the page-facing side of the ball',
    dotGeo.dockRight ? dotGeo.left === '-1px' && dotGeo.right === 'auto' : dotGeo.right === '-1px' && dotGeo.left === 'auto',
    JSON.stringify(dotGeo)
  );

  // --- the docked ball must not stutter under a resting pointer --------------
  // Docking is a transform, so hovering slides the ball out from under the
  // cursor. If the pointer sits in the strip the ball vacates, the hover is lost,
  // the ball docks, the pointer is over it again… a visible flicker at ~4Hz.
  // This drives a real pointer with CDP because CSS :hover only follows real
  // mouse input.
  const wrapTransform = () =>
    evalPage(
      `getComputedStyle(document.getElementById('lingua-ball').shadowRoot.querySelector('.wrap')).transform`
    );
  const ballBox = JSON.parse(
    await evalPage(`(function () {
      var r = document.getElementById('lingua-ball').getBoundingClientRect();
      return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height, vw: window.innerWidth });
    })()`)
  );
  check('the ball starts docked against an edge', dotGeo.dockRight || dotGeo.dockLeft, JSON.stringify(dotGeo));

  // The strip between the ball's resting position and the screen edge: the
  // popped-out ball no longer covers it, but the pointer is still "on" the ball
  // as far as the user is concerned.
  const stripX = dotGeo.dockRight ? ballBox.vw - 4 : 4;
  const stripY = Math.round(ballBox.y + ballBox.h / 2);
  // A single synthetic move cannot reproduce the stutter: Chrome only
  // re-evaluates :hover when the pointer MOVES, and a hand resting on a mouse
  // still jitters by a pixel or two. With one move and then nothing, the stale
  // hover simply persists and the ball looks perfectly stable. So drive the
  // pointer the way a real hand does.
  const jitter = (i) =>
    cdp.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: stripX + (i % 2 === 0 ? 0 : -2),
        y: stripY + (i % 3 === 0 ? 1 : 0),
        button: 'none',
        buttons: 0,
      },
      pageSession
    );

  // Warm-up: let the 220ms slide-out finish. Sampling through it would just
  // record the animation, which is not the bug.
  for (let i = 0; i < 16; i++) {
    await jitter(i);
    await sleep(70);
  }
  const frames = [];
  for (let i = 0; i < 8; i++) {
    await jitter(i);
    await sleep(90);
    frames.push(await wrapTransform());
  }
  const distinct = Array.from(new Set(frames));
  check(
    'the docked ball does not stutter while the pointer rests in the strip it vacates',
    distinct.length === 1,
    distinct.join('  |  ')
  );
  check(
    'the ball stays slid out while hovered',
    distinct[0] === 'matrix(1, 0, 0, 1, 0, 0)',
    distinct[0]
  );

  // The progress ring is drawn 3px outside the ball, so that band used to be a
  // dead zone: grazing it dropped the hover and the ball slid back. Probe the
  // TOP edge, which the dock bridge above does not cover — a right-side probe
  // would be inside the strip that bridge already protects.
  const ringPoint = JSON.parse(
    await evalPage(`(function () {
      var w = document.getElementById('lingua-ball').shadowRoot.querySelector('.wrap');
      var r = w.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top - 2) });
    })()`)
  );
  const ringFrames = [];
  for (let i = 0; i < 6; i++) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: ringPoint.x + (i % 2), y: ringPoint.y, button: 'none', buttons: 0 },
      pageSession
    );
    await sleep(90);
    ringFrames.push(await wrapTransform());
  }
  const ringDistinct = Array.from(new Set(ringFrames));
  check(
    'grazing the progress ring does not collapse the ball',
    ringDistinct.length === 1 && ringDistinct[0] === 'matrix(1, 0, 0, 1, 0, 0)',
    ringDistinct.join('  |  ')
  );

  // Move the pointer well away so the rest of the run starts from a clean state.
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: Math.round(ballBox.vw / 2), y: Math.round(ballBox.h + 40), button: 'none', buttons: 0 },
    pageSession
  );
  await sleep(350);

  await clickBall();
  await sleep(500);
  check('clicking the ball on a fresh page starts translation', (await evalIso('Lingua.page.state.active')) === true);
  check(
    'ball switches to the active state',
    (await evalPage(`document.getElementById('lingua-ball').shadowRoot.querySelector('.wrap').className`)).includes('on'),
    await evalPage(`document.getElementById('lingua-ball').shadowRoot.querySelector('.wrap').className`)
  );

  // The progress ring must be concentric with the ball. It used to drift by
  // (+1,+1): the SVG's width/height attributes made the `inset` over-constrained,
  // so right/bottom were dropped and the ring anchored at the top-left, leaving
  // a visibly uneven gap around the ball.
  const ringOffset = await evalPage(`(function () {
    var sr = document.getElementById('lingua-ball').shadowRoot;
    var b = sr.querySelector('.ball').getBoundingClientRect();
    var r = sr.querySelector('.ring').getBoundingClientRect();
    return [
      (r.left + r.width / 2) - (b.left + b.width / 2),
      (r.top + r.height / 2) - (b.top + b.height / 2)
    ];
  })()`);
  check(
    'progress ring is concentric with the ball',
    Math.abs(ringOffset[0]) < 0.5 && Math.abs(ringOffset[1]) < 0.5,
    `offset ${ringOffset.map((n) => n.toFixed(2)).join(',')}`
  );

  // --- wait for translation to land ---
  let count = 0;
  for (let i = 0; i < 60; i++) {
    count = await evalPage(`document.querySelectorAll('.lingua-pg-dst').length`);
    if (count >= 12) break;
    await sleep(500);
  }

  console.log('\nreal-browser end-to-end');
  check('translated nodes rendered into the page', count >= 12, `${count} nodes`);

  const status = await evalIso('JSON.stringify(Lingua.page.status())');
  const st = JSON.parse(status);
  check('page pipeline reports done', st.status === 'done', status);
  check('unit discovery found a realistic number of blocks', st.total >= 12, `${st.total} units`);

  const titleDst = await evalPage(`(document.querySelector('#title .lingua-pg-dst')||{}).textContent || ''`);
  check('heading got a translation', titleDst.includes('【译】'), titleDst);
  check('translation kept the source text intact', (await evalPage(`document.getElementById('title').textContent`)).includes('survive real pages'));

  const paraDst = await evalPage(`(document.querySelector('#para .lingua-pg-dst')||{}).textContent || ''`);
  check('inline-markup paragraph is one unit', paraDst.includes('inline markup') && paraDst.includes('link'), paraDst);

  // bilingual display must never leak the raw link placeholders
  check(
    'bilingual rendering strips the link placeholders',
    (await evalPage(`!/[⟦⟧]/.test(document.querySelector('#linkp .lingua-pg-dst').textContent)`)) === true,
    await evalPage(`document.querySelector('#linkp .lingua-pg-dst').textContent`)
  );

  check('code block left untouched', (await evalPage(`document.getElementById('code').querySelectorAll('.lingua-pg-dst').length`)) === 0);
  check('footer text translated', (await evalPage(`(document.querySelector('#footer .lingua-pg-dst')||{}).textContent||''`)).includes('【译】'));

  const gridCols = await evalPage(`getComputedStyle(document.getElementById('cards')).gridTemplateColumns.split(' ').length`);
  check('grid layout preserved (3 columns)', gridCols === 3, `${gridCols} columns`);
  check(
    'card title and body split into separate units',
    (await evalPage(`document.querySelectorAll('#cards .lingua-pg-dst').length`)) >= 6,
    `${await evalPage(`document.querySelectorAll('#cards .lingua-pg-dst').length`)} nodes`
  );

  // --- flex container holding its own text (GitHub's nav button shape) ---
  check(
    'flex nav button got a translation',
    (await evalPage(`document.querySelectorAll('#flexnav .lingua-pg-dst').length`)) === 1,
    await evalPage(`document.getElementById('flexnav').outerHTML.slice(0, 200)`)
  );
  check(
    'flex button kept its original label and its flex layout',
    (await evalPage(`document.getElementById('flexnav').textContent`)).includes('Platform') &&
      (await evalPage(`getComputedStyle(document.getElementById('flexnav')).display`)) === 'flex',
    await evalPage(`getComputedStyle(document.getElementById('flexnav')).display`)
  );
  // Bilingual mode inevitably makes text longer, so a nav button may wrap to a
  // second line. What must NOT happen is the flex layout collapsing.
  const flexBtnH = await evalPage(`document.getElementById('flexnav').getBoundingClientRect().height`);
  check('flex button did not collapse or explode', flexBtnH > 0 && flexBtnH < 64, `height=${flexBtnH}px`);

  // dynamic content must be picked up by the MutationObserver
  const addDynamicParagraph = () =>
    evalPage(`(function () {
      var d = document.createElement('p');
      d.id = 'dynamic';
      d.textContent = 'This paragraph arrived after the initial scan.';
      document.querySelector('main').appendChild(d);
      return 1;
    })()`);
  await addDynamicParagraph();
  let dynOk = false;
  for (let i = 0; i < 20 && !dynOk; i++) {
    dynOk = await evalPage(`!!document.querySelector('#dynamic .lingua-pg-dst')`);
    if (!dynOk) await sleep(500);
  }
  check('dynamically added paragraph got translated', dynOk);

  // --- progress accounting ---------------------------------------------------
  // `done` used to be a running counter, which drifted out of sync with the unit
  // list and produced "已翻译 391/381" on real sites. Progress is now derived
  // from per-unit flags, so this invariant must hold at every moment.
  const snap = JSON.parse(
    await evalIso(
      `JSON.stringify(Object.assign({}, Lingua.page.status(), { nodes: document.querySelectorAll('.lingua-pg-dst').length }))`
    )
  );
  check(
    'progress never reports more finished units than exist',
    snap.done <= snap.total,
    `done=${snap.done} total=${snap.total}`
  );
  check('dynamically added content grew the total', snap.total > st.total, `${st.total} -> ${snap.total}`);
  check(
    'the reported progress matches what is on screen',
    snap.done >= snap.nodes && snap.nodes > 0,
    `done=${snap.done} rendered=${snap.nodes}`
  );

  // --- batching / provider contract ---
  const log = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/__log`)).json();
  check('mock endpoint received page-kind requests', log.requests.some((r) => r.kind === 'page'), JSON.stringify(log.requests.slice(0, 2)));
  check('requests were batched (fewer calls than units)', log.count < st.total, `${log.count} requests / ${st.total} units`);
  check('mock endpoint received no subtitle-kind requests', !log.requests.some((r) => r.kind === 'subtitle'));

  // --- restore ---
  await evalIso('Lingua.page.stop()');
  await sleep(300);
  check('restore removed every injected node', (await evalPage(`document.querySelectorAll('.lingua-pg-dst,.lingua-pg-src').length`)) === 0);
  check('restore cleared the processed markers', (await evalPage(`document.querySelectorAll('[data-lingua]').length`)) === 0);
  check('original text fully recovered', (await evalPage(`document.getElementById('title').textContent`)) === 'A translation extension must survive real pages');

  check('no runtime errors in the page', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // --- replace mode must not swallow hyperlinks -----------------------------
  await evalIso(`Lingua.settings.setSettings({ page: { displayMode: 'replace' } }).then(function () { return Lingua.page.retranslate(); })`);
  for (let i = 0; i < 40; i++) {
    const s = JSON.parse(await evalIso('JSON.stringify(Lingua.page.status())'));
    if (s.status === 'done' || s.status === 'error') break;
    await sleep(500);
  }
  check(
    'replace mode hides the source on a plain paragraph',
    (await evalPage(`document.getElementById('plainp').classList.contains('lingua-pg-replace')`)) === true,
    await evalPage(`(document.getElementById('plainp')||{}).className`)
  );
  check(
    'replace mode also hides a link paragraph when the translation carries the links',
    (await evalPage(`document.getElementById('linkp').classList.contains('lingua-pg-replace')`)) === true,
    await evalPage(`document.getElementById('linkp').className`)
  );
  const linkInfo = JSON.parse(
    await evalPage(`(function(){
      var dst = document.querySelector('#linkp .lingua-pg-dst');
      var a = dst && dst.querySelector('a[href]');
      var src = document.querySelector('#linkp > .lingua-pg-src');
      var orig = src && src.querySelector('a[href]');
      return JSON.stringify({
        dstText: dst ? dst.textContent : null,
        hasLink: !!a,
        href: a ? a.getAttribute('href') : null,
        linkText: a ? a.textContent : null,
        linkVisible: a ? (function(){var r=a.getBoundingClientRect();return r.width>0&&r.height>0;})() : false,
        originalPreserved: !!orig,
        strayMarkers: dst ? /[⟦⟧]/.test(dst.textContent) : false
      });
    })()`)
  );
  check('the translation contains a real link', linkInfo.hasLink === true, JSON.stringify(linkInfo));
  check('the translated link keeps the original href', linkInfo.href === 'https://example.com/docs', String(linkInfo.href));
  check('the link text was translated too', linkInfo.linkText && linkInfo.linkText !== 'documentation', String(linkInfo.linkText));
  check('the translated link is visible/clickable', linkInfo.linkVisible === true);
  check('no stray placeholders leaked into the DOM', linkInfo.strayMarkers === false, String(linkInfo.dstText));
  check('link-bearing paragraph still got a translation', (await evalPage(`document.querySelectorAll('#linkp .lingua-pg-dst').length`)) === 1);

  // --- "show original" means original ONLY, not a bilingual view ------------
  await evalIso('Lingua.page.toggleOriginal()');
  await sleep(4000);
  check(
    'show-original hides every translation',
    (await evalPage(
      `(function(){ var d = document.querySelector('.lingua-pg-dst'); return !!d && getComputedStyle(d).display === 'none'; })()`
    )) === true,
    await evalPage(`(function(){ var d=document.querySelector('.lingua-pg-dst'); return d ? getComputedStyle(d).display : 'no dst'; })()`)
  );
  check(
    'show-original does NOT leave a bilingual view',
    (await evalPage(`document.querySelectorAll('.lingua-pg-dst').length`)) > 0 &&
      (await evalPage(
        `Array.prototype.every.call(document.querySelectorAll('.lingua-pg-dst'), function(d){ return getComputedStyle(d).display === 'none'; })`
      )) === true
  );
  check(
    'show-original leaves the source readable',
    (await evalPage(`document.getElementById('linkp').textContent`)).indexOf('documentation') !== -1,
    await evalPage(`document.getElementById('linkp').textContent.slice(0, 80)`)
  );
  check(
    'show-original keeps the original link usable',
    (await evalPage(
      `(function(){ var a = document.getElementById('doclink'); if(!a) return false; var r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`
    )) === true
  );
  await evalIso('Lingua.page.toggleOriginal()');
  await sleep(4000);
  check(
    'toggling back shows the translation again',
    (await evalPage(
      `(function(){ var d = document.querySelector('.lingua-pg-dst'); return !!d && getComputedStyle(d).display !== 'none'; })()`
    )) === true
  );
  check(
    'the page is still fully translated after the round trip',
    (await evalPage(`document.querySelectorAll('.lingua-pg-dst').length`)) >= 12,
    `${await evalPage(`document.querySelectorAll('.lingua-pg-dst').length`)} nodes`
  );

  // --- the translation must reuse the REAL link, not a clone ---
  check(
    'the translated link is the very same element as the original',
    (await evalPage(`document.querySelector('#hoverp .lingua-pg-dst a[href]') === document.getElementById('hoverlink')`)) === true
  );
  await evalPage(
    `(function(){ var a = document.querySelector('#hoverp .lingua-pg-dst a[href]');
       a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
       a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
       return 1; })()`
  );
  check('a click listener on the original link still fires', (await evalPage(`window.__linkClicks`)) === 1, `clicks=${await evalPage(`window.__linkClicks`)}`);
  check('a hover listener on the original link still fires', (await evalPage(`window.__linkHovers`)) === 1, `hovers=${await evalPage(`window.__linkHovers`)}`);

  // --- a corrupted placeholder must degrade gracefully, never leak residue ---
  const broken = JSON.parse(
    await evalPage(`(function(){
      var el = document.getElementById('brokenmark');
      var dst = el.querySelector('.lingua-pg-dst');
      return JSON.stringify({
        keptSource: !el.classList.contains('lingua-pg-replace'),
        dstText: dst ? dst.textContent : null,
        residue: /[\\u27e6\\u27e7]/.test(el.textContent),
        linkVisible: (function(){var a=el.querySelector('a[href]');if(!a)return false;var r=a.getBoundingClientRect();return r.width>0&&r.height>0;})()
      });
    })()`)
  );
  check('a corrupted placeholder falls back to keeping the source', broken.keptSource === true, JSON.stringify(broken));
  check('no placeholder residue leaks into the page', broken.residue === false, String(broken.dstText));
  check('the link stays usable after the fallback', broken.linkVisible === true);

  check('still no runtime errors after the replace pass', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  // --- restoring must hand the real link back, untouched -------------------
  await evalIso('Lingua.page.stop()');
  await sleep(250);
  check(
    'restore puts the link back inside its own paragraph',
    (await evalPage(`document.querySelector('#linkp > a[href]') === document.getElementById('doclink')`)) === true,
    await evalPage(`document.getElementById('linkp').outerHTML.slice(0, 160)`)
  );
  check(
    'restore returns the original link text',
    (await evalPage(`document.getElementById('doclink').textContent`)) === 'documentation',
    await evalPage(`document.getElementById('doclink').textContent`)
  );
  check(
    'the very same link element survived the whole round trip',
    (await evalPage(
      `(function(){ var a = document.getElementById('hoverlink');
         a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
         return window.__linkClicks; })()`
    )) === 2,
    `clicks=${await evalPage(`window.__linkClicks`)}`
  );
  check('no injected nodes remain after the final restore', (await evalPage(`document.querySelectorAll('.lingua-pg-dst,.lingua-pg-src').length`)) === 0);

  // --- the ball is a permanent control: it must survive stop() --------------
  // The restore above already stopped the pipeline, so the ball is idle here.
  check('ball is idle after the restore', (await evalPage(`document.getElementById('lingua-ball').shadowRoot.querySelector('.wrap').className`)).includes('idle'));
  await clickBall();
  await sleep(500);
  check('the ball can start translation again after a stop', (await evalIso('Lingua.page.state.active')) === true);

  for (let i = 0; i < 60; i++) {
    const s = JSON.parse(await evalIso('JSON.stringify(Lingua.page.status())'));
    if (s.status === 'done' || s.status === 'error') break;
    await sleep(500);
  }
  await clickBall();
  await sleep(700);
  check('clicking again stops translation', (await evalIso('Lingua.page.state.active')) === false);
  check(
    'ball returns to the idle state',
    (await evalPage(`document.getElementById('lingua-ball').shadowRoot.querySelector('.wrap').className`)).includes('idle'),
    await evalPage(`document.getElementById('lingua-ball').shadowRoot.querySelector('.wrap').className`)
  );
  check('ball survives stop (it is a permanent control)', (await evalPage(`!!document.getElementById('lingua-ball')`)) === true);
  check('page fully restored after using the ball', (await evalPage(`document.querySelectorAll('.lingua-pg-dst').length`)) === 0);

  // --- the page pushes its state, so the popup never lags behind -----------
  const patched = await evalIso(`(function(){
    window.__linguaBroadcasts = [];
    try {
      var orig = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function (msg, cb) {
        if (msg && msg.type === 'lingua:page-state') window.__linguaBroadcasts.push(msg.page.status);
        if (typeof cb === 'function') cb({ ok: true });
        return Promise.resolve();
      };
      window.__linguaOrigSend = orig;
      return 'patched';
    } catch (e) { return 'failed: ' + e.message; }
  })()`);
  check('page state broadcasts can be observed', patched === 'patched', String(patched));

  await clickBall();
  await sleep(1800);
  const bcasts = JSON.parse(await evalIso('JSON.stringify(window.__linguaBroadcasts || [])'));
  check('the page broadcasts its state for the popup', bcasts.length > 0, JSON.stringify(bcasts.slice(0, 8)));
  check(
    'the broadcast reports the pipeline becoming active',
    bcasts.some((s) => s === 'scanning' || s === 'translating' || s === 'done'),
    JSON.stringify(bcasts.slice(0, 8))
  );
  check(
    'the broadcast carries a state the popup can render',
    (await evalIso(`(function(){ var m = window.__linguaBroadcasts; return typeof m === 'object' && m.length > 0; })()`)) === true
  );
  await clickBall();
  await sleep(800);
  const afterStop = JSON.parse(await evalIso('JSON.stringify(window.__linguaBroadcasts || [])'));
  check('stopping also broadcasts (so the popup flips back)', afterStop.length > bcasts.length, `${bcasts.length} -> ${afterStop.length}`);

  // --- screenshot (reload so auto-translate runs again from a clean state) ---
  await cdp.send('Runtime.evaluate', { expression: 'location.reload()', returnByValue: true }, pageSession).catch(() => {});
  await sleep(4500);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, pageSession);
  const outDir = path.join(ROOT, 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  const shotPath = path.join(outDir, 'e2e-real-page.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`      screenshot: ${shotPath}`);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('failing checks: ' + failures.join(', '));
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('\n[e2e] fatal:', err && err.message);
  process.exitCode = 1;
} finally {
  if (cdp && !KEEP) {
    try {
      await cdp.send('Browser.close');
    } catch (e) {
      /* ignore */
    }
  }
  if (chrome && !KEEP) {
    try {
      chrome.kill('SIGKILL');
    } catch (e) {
      /* ignore */
    }
  }
  if (server) server.close();
  if (!KEEP) {
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      /* Chrome may still be flushing the profile — harmless */
    }
  }
  setTimeout(() => process.exit(process.exitCode || 0), 400);
}
