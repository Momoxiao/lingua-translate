/**
 * Lingua — live smoke test against real YouTube.
 *
 * This is the answer to the one question no other script can answer: *does the
 * caption pipeline still work on YouTube today?* `youtube.js` / `inject.js` /
 * `bridge.js` lean on YouTube's private player response, so they cannot run in
 * CI, and everything else in this repo runs against a local fixture.
 *
 * It boots a local OpenAI-compatible mock (so no API key is needed), loads the
 * unpacked extension into a throwaway Chrome, opens a real watch page, and reads
 * the same state the diagnostics page shows — printing the same verdict.
 *
 * Usage:
 *   node scripts/smoke-youtube.mjs [watchUrl]
 *   SMOKE_TIMEOUT=60 node scripts/smoke-youtube.mjs
 *   node scripts/smoke-youtube.mjs --headed        # real window, real playback
 *   SMOKE_PROFILE=~/Library/Application\ Support/Google/Chrome npm run smoke
 *
 * A red result here does NOT mean the extension is broken, and the reason is not
 * the one it first looked like. It was blamed on the signed-out profile "not
 * being handed a PoToken" — that was wrong, and measurably so: against a real,
 * signed-in session the same video answers the same `fetch(baseUrl&fmt=json3)`
 * with HTTP 200 and a 0-byte body, and its baseUrl carries no `pot` either.
 * Login state is not the variable.
 *
 * It was then blamed on *playback* — "the player only fetches a caption track
 * once it is genuinely playing, and automation never gets there". That was
 * wrong too, and it stood for longer because it sounded unfalsifiable. Measured
 * with a headed window (`npm run smoke:headed`):
 *
 *   - a playing video with captions ON issues 6-9 `/api/timedtext` requests;
 *   - requests WITHOUT `pot` come back HTTP 200 with a 0-byte body — a failure
 *     that looks exactly like success, and the actual trap;
 *   - requests WITH `pot` come back with ~1.1-1.3 KB of real caption data.
 *
 * The "zero requests" runs that produced the playback theory were runs where
 * nothing had asked the player to show captions. Absence of a request was read
 * as evidence about the request path, which is a non-sequitur.
 *
 * So the fetch is *timing-dependent*, not broken: `extractCues()` nudges the
 * player and sniffs the token out of the request the player then makes, and
 * whether that lands inside its window decides the outcome. Consecutive runs of
 * this same script have produced both `60/60 cues translated` and a fall-through
 * to the realtime path. That is why `live.js` exists and why the verdict below
 * judges it on lines actually read and translated.
 *
 * Exit code is 0 only when captions were found AND the page reached a settled
 * state. Read the verdict, not just the code.
 *
 * Why the request counter matters: before it existed, a zero-cue result was
 * reported as "probably the PoToken path" — a guess. Counting `/api/timedtext`
 * over CDP turns it into a fact:
 *   0 requests   -> the player never tried; the page, not the extension, is broken here
 *   >0, empty    -> the player asked and YouTube answered with nothing; that IS the PoToken path
 *   >0, refused  -> the request was rejected (HTTP code shown); a different bug again
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, attach } from './lib/cdp.mjs';
import { resolveChrome } from './lib/chrome.mjs';
import { watchCaptionRequests } from './lib/captions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_UNDER_TEST = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const HEADED = process.argv.includes('--headed') || process.env.SMOKE_HEADED === '1';
const TIMEOUT_MS = (Number(process.env.SMOKE_TIMEOUT) || 45) * 1000;

const chromePath = resolveChrome();
if (!chromePath) {
  console.log('No Chrome/Chromium binary found — skipping the live smoke test.');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP_PORT = 9500 + Math.floor(Math.random() * 200);
const HTTP_PORT = 9700 + Math.floor(Math.random() * 200);
/**
 * A throwaway profile by default, so a run never touches the browser you are
 * logged into. `SMOKE_PROFILE` points it at a real one instead — quit Chrome
 * first, or it will refuse the lock.
 *
 * Being throwaway is a caveat, but not the caveat it was assumed to be: a
 * signed-out profile is NOT why captions fail here (measured — see the header).
 * Failures come from the environment never reaching real playback.
 */
const THROWAWAY_PROFILE = !process.env.SMOKE_PROFILE;
const PROFILE = process.env.SMOKE_PROFILE
  ? path.resolve(process.env.SMOKE_PROFILE.replace(/^~(?=\/)/, os.homedir()))
  : path.join(os.tmpdir(), `lingua-smoke-${process.pid}`);

// ---------------------------------------------------------------------------
// A minimal OpenAI-compatible endpoint, so translation is exercised for real
// without needing anyone's API key. It echoes each numbered line back wrapped in
// a marker, which is enough to prove the round trip and the line mapping.
// ---------------------------------------------------------------------------
function startMock() {
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404).end('{}');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let content = '';
      try {
        const user = JSON.parse(body).messages.slice(-1)[0].content;
        content = String(user)
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const m = /^(\d+)\.\s*([\s\S]*)$/.exec(l);
            return m ? `${m[1]}. 〔译〕${m[2]}` : l;
          })
          .join('\n');
      } catch (e) {
        /* fall through with an empty completion */
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------
// Track every /api/timedtext request the page makes — the measurement that
// separates "YouTube refused us" from "the player never even asked". The
// watcher itself lives in scripts/lib/captions.mjs because `inspect-live.mjs`
// needs exactly the same attribution against a real signed-in browser.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The probe: the same fields the diagnostics page reads, plus the player state
// and the first cue, so the output is verifiable by eye.
// ---------------------------------------------------------------------------
const PROBE = `(function () {
  if (typeof Lingua === 'undefined' || !Lingua) return JSON.stringify({ injected: false });
  var st = Lingua.store && Lingua.store.state;
  var mp = document.getElementById('movie_player');
  var v = document.querySelector('video.html5-main-video') || document.querySelector('video');
  var btn = document.querySelector('.ytp-subtitles-button');
  return JSON.stringify({
    injected: true,
    bridgeAlive: Lingua.bridge ? Lingua.bridge.isAlive() : null,
    hasPlayerResponse: !!(window.ytInitialPlayerResponse),
    player: {
      moviePlayer: !!mp,
      subtitleButton: !!btn,
      subtitlesPressed: btn ? btn.getAttribute('aria-pressed') : null,
      hasVideo: !!v,
      paused: v ? !!v.paused : null,
      currentTime: v ? Math.round(v.currentTime * 10) / 10 : null
    },
    subtitle: st ? {
      status: st.status,
      reason: st.reason,
      videoId: st.videoId,
      error: st.error,
      trackCount: st.tracks.length,
      trackLangs: st.tracks.map(function (t) { return t.languageCode + (t.kind ? '/' + t.kind : ''); }),
      sourceTrack: st.sourceTrack ? st.sourceTrack.languageCode : null,
      cueCount: st.cues.length,
      translated: Lingua.store.translatedCount(),
      firstCue: st.cues[0] ? st.cues[0].text.slice(0, 60) : null,
      firstTranslation: (st.translations && st.translations[0]) || null,
      // The realtime fallback keeps its own counters: it never writes cues into
      // the store, so without this a "live" status says only that polling began,
      // not that anything was read or translated.
      live: Lingua.live && Lingua.live.stats ? Lingua.live.stats() : null
    } : null
  });
})()`;

/**
 * The verdict. `net` is the caption-request log — read it, do not guess.
 * Mirrors src/diagnostics/diagnostics.js so the two never disagree.
 */
function verdict(state, net, capLog) {
  if (!state || !state.injected) {
    return { ok: false, tone: 'err', text: '内容脚本没有注入到这个页面。' };
  }
  if (state.bridgeAlive === false) {
    return { ok: false, tone: 'err', text: '后台连接失效。' };
  }
  const s = state.subtitle || {};
  const p = state.player || {};
  if (s.error) return { ok: false, tone: 'err', text: `取字幕报错：${s.error}` };
  if (!s.trackCount) {
    return {
      ok: false,
      tone: 'warn',
      text: state.hasPlayerResponse
        ? '页面有播放器响应，但一条字幕轨都没解析出来——最可能是 YouTube 改了响应结构。'
        : '页面里没有 ytInitialPlayerResponse，多半是页面没加载起来（同意墙 / 无头环境限制），不一定是扩展的问题。',
    };
  }
  if (s.reason && s.reason !== 'empty-track') {
    return { ok: false, tone: 'warn', text: `状态停在 ${s.status}，原因 ${s.reason}。` };
  }
  // The realtime fallback: the whole-track fetch failed, but the player renders
  // captions into the DOM and we translate them line by line. Judge it on what
  // it actually read, not on the cue store — it never writes there.
  if (s.status === 'live' || (s.live && (s.live.lines || s.live.translated))) {
    const L = s.live || {};
    if (L.translated > 0) {
      return {
        ok: true,
        tone: 'ok',
        text:
          `实时兜底生效：整轨字幕取不到，但播放器自己渲染了字幕，已逐句读取 ${L.lines} 行、翻译 ${L.translated} 行。` +
          `最后一行「${(L.lastOriginal || '').slice(0, 40)}」→「${(L.lastTranslated || '').slice(0, 40)}」。`,
      };
    }
    if (L.lines > 0) {
      return {
        ok: false,
        tone: 'warn',
        text: `实时兜底读到了 ${L.lines} 行字幕，但一行都没翻译出来——问题在翻译调用，不在取字幕。`,
      };
    }
    return {
      ok: false,
      tone: 'warn',
      text:
        '已切到实时兜底，但一行字幕都没读到。可能是这段时间里播放位置没有落在任何字幕上，' +
        '也可能是播放器的字幕并没有真的渲染到 DOM。多等一会儿再跑一次即可区分。',
    };
  }
  if (!s.cueCount) {
    const reqs = net.all;
    const c = net.counts();
    // Attribution caveat, always visible when it applies: CDP gives no initiator
    // for a request whose origin is below JS, and our URL is derived from the
    // player's baseUrl, so "we sent it" is not something the URL can prove.
    const vague = c.unknown ? `其中 ${c.unknown}/${c.total} 条无法判定来源（CDP 未给出 initiator）。` : '';

    if (!c.total) {
      return {
        ok: false,
        tone: 'warn',
        text:
          `找到 ${s.trackCount} 条字幕轨，但一次 /api/timedtext 都没发出去` +
          `（movie_player=${p.moviePlayer} 字幕按钮=${p.subtitleButton} pressed=${p.subtitlesPressed}）。` +
          '这一条不能归给扩展：没有任何一方要求播放器显示字幕，所以没有请求可观察。' +
          '字幕按钮关着（pressed=false）时播放器不会去取字幕轨——先确认字幕是开着的。' +
          '注意：请求数不是关键指标，**带不带 pot、正文多少字节**才是——带 pot 的请求实测返回约 1.1–1.3KB 真实数据，' +
          '不带 pot 的返回 HTTP 200 加 0 字节正文（一个看起来像成功的失败）。',
      };
    }
    const refused = reqs.filter((r) => r.failed || (r.status !== null && r.status >= 400));
    if (refused.length === reqs.length) {
      return {
        ok: false,
        tone: 'err',
        text: `${c.total} 次字幕请求全部被拒（${net.describe()}）——字幕接口这一层的问题。${vague}`,
      };
    }
    // What the responses actually contained, captured on the way in. This is
    // the evidence; the wire byte counts are not (they include headers).
    const emptyBodies = (capLog || []).filter((c) => c.len === 0).length;
    const withBody = (capLog || []).length - emptyBodies;
    const bodyNote = !capLog || !capLog.length
      ? '响应体没能抓到，所以「空 body」这个说法在这次运行里未经验证。'
      : withBody
        ? `其中 ${withBody} 条**有正文**（响应体抓取），说明拿到数据了却没解析出来——问题在解析这一步。`
        : `${emptyBodies} 条响应体全部读为 **0 字节**（响应体抓取，不是字节数推算）——YouTube 确实什么都没返回。`;

    const pl = net.payload ? net.payload() : null;
    if (!c.withPot) {
      return {
        ok: false,
        tone: 'warn',
        text:
          `${c.total} 次字幕请求里，一个 pot 都没有（${net.describe()}）。` +
          '正是 youtube.js 注释里写的那个 PoToken 陷阱：extractCues 的第 2/3 步（复用嗅到的 pot）在这种情况下无事可做，' +
          `因为根本没有 pot 可复用。${bodyNote}${vague}`,
      };
    }
    return {
      ok: false,
      tone: 'warn',
      text:
        `${c.total} 次字幕请求里有 ${c.withPot} 次带了 pot（${net.describe()}），但一条 cue 都没解析出来。` +
        `${bodyNote}${vague}`,
    };
  }
  if (!s.translated) {
    return {
      ok: false,
      tone: 'warn',
      text: `取到 ${s.cueCount} 条 cue（${s.trackCount} 条轨），但一条都没翻译成功——翻译这一层的问题，不是字幕。`,
    };
  }
  return { ok: true, tone: 'ok', text: `正常：${s.trackCount} 条轨，${s.translated}/${s.cueCount} 条已翻译。` };
}

const TONE_MARK = { ok: 'OK  ', warn: 'WARN', err: 'FAIL' };

(async function main() {
  const mock = await startMock();
  console.log(`[smoke] mock translation endpoint on http://127.0.0.1:${HTTP_PORT}/v1`);
  console.log(`[smoke] target: ${URL_UNDER_TEST}`);
  console.log(`[smoke] mode: ${HEADED ? 'headed（真实窗口，GPU 开，允许自动播放）' : 'headless（--disable-gpu）'}`);
  console.log(
    `[smoke] profile: ${
      THROWAWAY_PROFILE
        ? '一次性、未登录 —— 已实测：登录状态不是字幕成功与否的变量（带 pot 的请求照样能拿到正文）'
        : PROFILE
    }`
  );

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    // Without this the player stays paused, and a paused player is not obliged
    // to fetch any caption track — which reads as "the caption path is broken"
    // when it is only "nothing asked for captions".
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ];
  if (HEADED) {
    // Deliberately NOT --disable-gpu here. Minting a PoToken runs through
    // YouTube's BotGuard VM, which wants a real rendering stack; disabling the
    // GPU is the cheapest way to get a browser that loads the page and can mint
    // nothing. Leaving it out is what makes --headed a meaningful control
    // instead of a second copy of the same broken configuration.
    args.unshift('--window-size=1280,860');
  } else {
    args.unshift('--disable-gpu', '--headless=new');
  }

  const chrome = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let ws;
  let view;
  let net = {
    all: [],
    counts: () => ({
      extension: 0, page: 0, unknown: 0, total: 0,
      withPot: 0, finished: 0, emptyBodies: 0, withData: 0,
    }),
    describe: () => '0',
    initiators: () => [],
    payload: () => null,
  };
  let code = 1;
  try {
    const { cdp, ws: sock } = await connect(CDP_PORT);
    ws = sock;
    console.log(`[smoke] chrome ready on ${CDP_PORT}`);

    const loaded = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    const extId = loaded.id || loaded.extensionId;
    console.log(`[smoke] extension loaded: ${extId}`);

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    let swTarget = null;
    for (let i = 0; i < 60 && !swTarget; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      swTarget = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
      if (!swTarget) await sleep(250);
    }
    if (!swTarget) throw new Error('the extension service worker never appeared');

    const swSession = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swSession);

    // Point the default provider at the mock, so the pipeline runs end to end
    // without anyone's credentials.
    await cdp.send(
      'Runtime.evaluate',
      {
        expression: `chrome.storage.local.set({'lingua:settings:v1': ${JSON.stringify({
          enabled: true,
          provider: 'openai',
          sourceLang: 'auto',
          targetLang: 'zh-Hans',
          autoTranslate: true,
          page: { autoTranslate: false },
          providers: {
            openai: {
              baseUrl: `http://127.0.0.1:${HTTP_PORT}/v1`,
              apiKey: 'smoke',
              model: 'smoke-model',
              temperature: 0,
              prompt: '',
              reasoning: 'off',
            },
          },
        })}})`,
        awaitPromise: true,
      },
      swSession
    );

    // A fresh profile lands on YouTube's consent wall, which would hide the
    // player. The cookie is the documented way to skip it.
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const pageSession = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await cdp.send('Network.enable', {}, pageSession);
    net = watchCaptionRequests(cdp, pageSession);
    for (const name of ['SOCS', 'CONSENT']) {
      await cdp
        .send(
          'Network.setCookie',
          { name, value: name === 'SOCS' ? 'CAI' : 'YES+', domain: '.youtube.com', path: '/' },
          pageSession
        )
        .catch(() => {});
    }
    await cdp.send('Page.enable', {}, pageSession);

    // Capture the *content* of caption responses, installed before any page
    // script runs. `Network.getResponseBody` fails here, and re-fetching the
    // signed URL later returns 0 bytes — the URL carries `expire`/`signature` and
    // is time-limited. So the only reliable way to see what YouTube sent is to
    // read it as it arrives.
    //
    // TRADE-OFF, deliberately taken and visible in the output: wrapping
    // `window.fetch` here makes this script the outermost caller, so CDP's
    // initiator stack no longer names `inject.js` and attribution degrades to
    // "来源未知". Body evidence beats attribution here — attribution was already
    // established in runs without this block, and remains available from
    // `npm run smoke` invocations that skip it. To get both at once, hook
    // `Lingua.subtitles.parseTimedText` in the isolated world after load instead
    // of the page's fetch; that sees every body `extractCues` parses without
    // touching the page's call chain. Not done yet.
    await cdp
      .send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: `
(function () {
  window.__capLog = [];
  function rec(url, status, body) {
    try { window.__capLog.push({ url: String(url).slice(-90), status: status, len: body.length, head: body.slice(0, 220) }); } catch (e) {}
  }
  var nf = window.fetch;
  if (typeof nf === 'function') {
    window.fetch = function (input, init) {
      var u = typeof input === 'string' ? input : (input && input.url);
      var p = nf.apply(this, arguments);
      if (/timedtext/.test(u || '')) {
        p.then(function (r) { r.clone().text().then(function (b) { rec(u, r.status, b); }).catch(function () {}); }).catch(function () {});
      }
      return p;
    };
  }
  var XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return XO.apply(this, arguments); };
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    var u = this.__u;
    if (/timedtext/.test(u || '')) {
      var self = this;
      this.addEventListener('loadend', function () {
        try { rec(u, self.status, self.responseText || ''); } catch (e) {}
      });
    }
    return XS.apply(this, arguments);
  };
})();
`,
        },
        pageSession
      )
      .catch(() => {});
    await cdp.send('Page.navigate', { url: URL_UNDER_TEST }, pageSession);

    view = await attach(cdp, target.targetId);

    // Poll rather than sleep once: the interesting question is not just the final
    // state but how long each step took, which is what the timeline shows.
    const started = Date.now();
    let last = '';
    let final = null;
    let isoWorld = null;
    let capLog = [];
    while (Date.now() - started < TIMEOUT_MS) {
      await sleep(2000);
      const iso = await view.findWorld();
      if (!iso) {
        if (last !== 'no-world') {
          console.log(`  t+${((Date.now() - started) / 1000).toFixed(0)}s  内容脚本尚未注入`);
          last = 'no-world';
        }
        continue;
      }
      isoWorld = iso;
      let state;
      try {
        state = JSON.parse(await view.evalIn(PROBE, iso.id));
      } catch (e) {
        continue;
      }
      final = state;
      const s = state.subtitle || {};
      const L = s.live || {};
      const line = `${s.status || '?'}${s.reason ? '/' + s.reason : ''} · 轨 ${s.trackCount || 0} · cue ${s.cueCount || 0} · 译 ${s.translated || 0} · 字幕请求 ${net.all.length}${L.lines ? ` · 实时 ${L.lines}行/译${L.translated}` : ''}`;
      if (line !== last) {
        console.log(`  t+${((Date.now() - started) / 1000).toFixed(0)}s  ${line}`);
        last = line;
      }
      // Settled states: nothing more will change on its own.
      if (s.status === 'ready' && s.translated > 0) break;
      if (s.status === 'empty' || s.status === 'error') break;
      // The realtime fallback reaches its useful conclusion as soon as one line
      // has been read AND translated; polling further just burns the remaining
      // budget, because each new line looks the same from here.
      if (s.status === 'live' && L.lines > 0 && L.translated > 0) break;
    }

    console.log('');
    if (final) {
      const s = final.subtitle || {};
      const p = final.player || {};

      // When nothing parsed, read what YouTube actually sent — through the
      // extension's own fetch path, so it is the same request `extractCues`
      // makes. Reading the body is the only way to tell "YouTube returned an
      // empty document" from "we got data and failed to parse it"; inferring it
      // from `cueCount === 0`, or from a byte count, is how the wrong
      // explanation got written down twice.
      let payloadProbe = null;
      if (!s.cueCount && isoWorld && (s.trackCount || 0) > 0) {
        try {
          payloadProbe = JSON.parse(
            await view.evalIn(
              `(function () {
                var tracks = (Lingua.store.state.tracks || []);
                var t = tracks.filter(function (x) { return x.languageCode === 'en'; })[0] || tracks[0];
                if (!t || !t.baseUrl) return JSON.stringify({ err: 'no baseUrl on the picked track' });
                return Lingua.bridge.fetchTrack(t.baseUrl).then(function (r) {
                  return JSON.stringify({ status: r.status, empty: !!r.empty, error: r.error || '', len: (r.body || '').length, head: (r.body || '').slice(0, 240) });
                });
              })()`,
              isoWorld.id
            )
          );
        } catch (e) {
          payloadProbe = { err: e.message };
        }
      }

      console.log(`  ${'视频 ID'.padEnd(12)} ${s.videoId || '(无)'}`);
      console.log(`  ${'字幕轨'.padEnd(12)} ${s.trackCount ? `${s.trackCount} 条：${(s.trackLangs || []).join(', ')}` : '0 条'}`);
      console.log(`  ${'当前轨'.padEnd(12)} ${s.sourceTrack || '(无)'}`);
      console.log(`  ${'cue'.padEnd(12)} ${s.cueCount || 0}（已译 ${s.translated || 0}）`);
      if (s.live && (s.live.lines || s.live.translated || s.status === 'live')) {
        const L = s.live;
        console.log(`  ${'实时兜底'.padEnd(12)} 读到 ${L.lines} 行 · 译出 ${L.translated} 行`);
        if (L.lastOriginal) {
          console.log(`  ${''.padEnd(12)} 最后一行：${L.lastOriginal.slice(0, 50)}`);
          console.log(`  ${''.padEnd(12)}        →  ${(L.lastTranslated || '(未译)').slice(0, 50)}`);
        }
      }
      console.log(`  ${'状态'.padEnd(12)} ${s.status || '?'}${s.reason ? ` · reason=${s.reason}` : ''}`);
      console.log(`  ${'播放器'.padEnd(12)} movie_player=${p.moviePlayer} 字幕按钮=${p.subtitleButton} pressed=${p.subtitlesPressed} 暂停=${p.paused} t=${p.currentTime}`);
      console.log(`  ${'字幕请求'.padEnd(12)} ${net.describe()}`);
      if (payloadProbe) {
        console.log(
          `  ${'重取字幕体'.padEnd(12)} ${
            payloadProbe.err
              ? `读不到：${payloadProbe.err}`
              : `HTTP ${payloadProbe.status} · ${payloadProbe.len}B · empty=${payloadProbe.empty} · ${payloadProbe.head}`
          }`
        );
      }
      // What YouTube actually sent, captured as it arrived.
      try {
        const got = JSON.parse(await view.evalPage('JSON.stringify(window.__capLog || [])'));
        if (Array.isArray(got)) capLog = got;
        if (capLog.length) {
          console.log(`  ${'响应体正文'.padEnd(12)} 抓到 ${capLog.length} 条：`);
          for (const c of capLog.slice(0, 4)) {
            console.log(`                 HTTP ${c.status} · ${c.len}B · ${String(c.head).replace(/\s+/g, ' ')}`);
          }
        }
      } catch (e) {
        /* capture script not installed (older Chrome) — nothing to add */
      }
      // The initiator is what attribution actually rests on, so print it rather
      // than leaving the reader to trust the label in the line above.
      const inits = net.initiators();
      if (inits.length) console.log(`  ${'发起者'.padEnd(12)} ${inits[0]}`);
      const pl = net.payload ? net.payload() : null;
      if (pl) console.log(`  ${'响应体'.padEnd(12)} ${pl.bytes}B  ${pl.text.slice(0, 150)}`);
      if (s.firstCue) console.log(`  ${'首条原文'.padEnd(12)} ${s.firstCue}`);
      if (s.firstTranslation) console.log(`  ${'首条译文'.padEnd(12)} ${s.firstTranslation}`);
      if (s.error) console.log(`  ${'错误'.padEnd(12)} ${s.error}`);
    }

    const v = verdict(final, net, capLog);
    console.log(`\n${TONE_MARK[v.tone]}  ${v.text}`);
    if (view.consoleErrors.length) {
      console.log(`\n  console errors (${view.consoleErrors.length}):`);
      for (const e of view.consoleErrors.slice(0, 4)) console.log(`    - ${String(e).split('\n')[0].slice(0, 160)}`);
    }
    code = v.ok ? 0 : 1;
  } catch (e) {
    console.log(`\nFAIL  smoke test could not run: ${e.message}`);
    code = 1;
  } finally {
    try {
      if (ws) ws.close();
    } catch (e) {
      /* ignore */
    }
    try {
      chrome.kill('SIGKILL');
    } catch (e) {
      /* ignore */
    }
    mock.close();
    await sleep(200);
    // Never touch a profile the user pointed us at — deleting that would be
    // catastrophic, and SMOKE_PROFILE exists precisely to point at a real one.
    if (THROWAWAY_PROFILE) {
      try {
        fs.rmSync(PROFILE, { recursive: true, force: true });
      } catch (e) {
        /* chrome may still be flushing; the profile lives in tmpdir */
      }
    }
  }
  process.exit(code);
})();
