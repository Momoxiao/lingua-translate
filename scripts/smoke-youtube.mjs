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
 * The last one is the honest control and the reason it exists: this script uses
 * a throwaway, signed-out profile, and YouTube does not hand a PoToken to a
 * profile like that. So a red result here says "this browser could not get the
 * captions", NOT "the extension is broken" — `npm run inspect` against your own
 * signed-in Chrome is what answers the second question. Quit Chrome before
 * pointing SMOKE_PROFILE at it, or Chrome will refuse the profile lock.
 *
 * Exit code is 0 only when captions were found AND the page reached a settled
 * state. Read the verdict, not just the code: a red result here can mean
 * "YouTube changed something" OR "this browser could not boot the player", and
 * the timeline plus the caption-request counter is what tells the two apart.
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
 * logged into. That isolation is also the single biggest caveat of this script:
 * on a fresh, signed-out profile YouTube hands out 6 caption tracks but mints no
 * PoToken, the player never asks for a caption, and every result reads red even
 * though the extension works fine in a real session. `SMOKE_PROFILE` exists so
 * that difference can be tested instead of assumed — quit Chrome first, or it
 * will refuse the lock.
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
// Track every /api/timedtext request the page makes. This is the measurement
// that separates "YouTube refused us" from "the player never even asked" —
// parsed responses we can only ever see as "empty".
// ---------------------------------------------------------------------------
function watchCaptionRequests(cdp, sessionId) {
  const byRequestId = new Map();
  const seen = [];
  cdp.onEvent((ev) => {
    if (ev.sessionId !== sessionId) return;
    const p = ev.params || {};
    if (ev.method === 'Network.requestWillBeSent' && /\/api\/timedtext/.test(p.request?.url || '')) {
      byRequestId.set(p.requestId, { url: p.request.url, status: null, failed: '' });
      seen.push(byRequestId.get(p.requestId));
    }
    if (ev.method === 'Network.responseReceived' && byRequestId.has(p.requestId)) {
      byRequestId.get(p.requestId).status = p.response?.status ?? null;
    }
    if (ev.method === 'Network.loadingFailed' && byRequestId.has(p.requestId)) {
      byRequestId.get(p.requestId).failed = p.errorText || 'failed';
    }
  });
  return {
    get all() {
      return seen;
    },
    /** One line per request, for the report. */
    describe() {
      if (!seen.length) return '0（播放器一次都没请求过 /api/timedtext）';
      return seen
        .map((r) => {
          const pot = /[?&]pot=/.test(r.url) ? 'pot=有' : 'pot=无';
          // initiator tells ours from the player's: inject.js's fetchTrack is
          // the only thing that forces fmt=json3, the player asks for its own
          // format. Without this the count is ambiguous — and "we asked and got
          // nothing" is a different bug from "the player never asked".
          const who = /[?&]fmt=json3/.test(r.url) ? '扩展' : '播放器';
          const state = r.failed ? r.failed : r.status === null ? 'pending' : `HTTP ${r.status}`;
          return `${who} ${pot} ${state}`;
        })
        .join(' · ');
    },
    /** How many came from each side. The split is the whole point. */
    counts() {
      let ours = 0;
      let theirs = 0;
      for (const r of seen) (/[?&]fmt=json3/.test(r.url) ? (ours++) : (theirs++));
      return { ours, theirs, total: seen.length };
    },
  };
}

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
      firstTranslation: (st.translations && st.translations[0]) || null
    } : null
  });
})()`;

/**
 * The verdict. `net` is the caption-request log — read it, do not guess.
 * Mirrors src/diagnostics/diagnostics.js so the two never disagree.
 */
function verdict(state, net) {
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
  if (!s.cueCount) {
    const reqs = net.all;
    const { ours, theirs } = net.counts();
    if (!reqs.length) {
      return {
        ok: false,
        tone: 'warn',
        text:
          `找到 ${s.trackCount} 条字幕轨，但一次 /api/timedtext 都没发出去` +
          `（movie_player=${p.moviePlayer} 字幕按钮=${p.subtitleButton}）。` +
          '这一条不是扩展的锅：这个环境里播放器根本没走到请求字幕那一步。' +
          '用 --headed 再跑一次，如果 headed 下能取到，就说明是无头环境的限制。',
      };
    }
    const refused = reqs.filter((r) => r.failed || (r.status !== null && r.status >= 400));
    if (refused.length === reqs.length) {
      return {
        ok: false,
        tone: 'err',
        text: `播放器请求了 ${reqs.length} 次字幕，但全部被拒（${net.describe()}）——字幕接口这一层的问题。`,
      };
    }
    const potty = reqs.filter((r) => /[?&]pot=/.test(r.url)).length;
    if (theirs > 0 && !potty) {
      return {
        ok: false,
        tone: 'warn',
        text:
          `播放器自己请求了 ${theirs} 次字幕，但请求里一个 pot 都没有（${net.describe()}），` +
          'HTTP 200 却是空 body——正是 youtube.js 注释里写的那个 PoToken 陷阱。' +
          'extractCues 的第 2/3 步（复用嗅到的 pot）在这种环境下无从下手，因为根本没有 pot 可复用。',
      };
    }
    if (theirs === 0) {
      // Reproduced in three configurations — headless, headed, and headed with
      // the GPU left on: the player turns captions on (`aria-pressed=true`) and
      // never asks for the track. That rules out the two obvious suspects. What
      // is left is the session: a signed-out throwaway profile gets no PoToken,
      // and a player with no token has nothing to fetch. Say so, and name the
      // experiment that settles it — the alternative is a red light nobody can
      // act on.
      const detail = `只有扩展自己发了 ${ours} 次请求（${net.describe()}），body 是空的；播放器一次都没请求字幕。`;
      return {
        ok: false,
        tone: 'warn',
        text: THROWAWAY_PROFILE
          ? detail +
            'headless 和 headed 都是这个结果（headed 还特意开着 GPU 跑过一次），所以不是无头环境的老问题，' +
            '最可能是这个一次性、未登录的 profile：YouTube 不给它签 pot，播放器也就不去取。' +
            '先拿 npm run inspect 对着你自己那个已登录的 Chrome 跑同一支视频（README 里 cues 163 那份输出就是这么来的）；' +
            '要在这里直接对照，先完全退出 Chrome，再跑 ' +
            'SMOKE_PROFILE="$HOME/Library/Application Support/Google/Chrome" npm run smoke。'
          : detail + '这是个真实 profile，所以更值得深挖：播放器为什么在字幕已开启的情况下不重新请求字幕。',
      };
    }
    return {
      ok: false,
      tone: 'warn',
      text:
        `播放器请求了 ${theirs} 次、扩展请求了 ${ours} 次（${net.describe()}），` +
        '但一条 cue 都没解析出来——请求发出去了、返回是空的。',
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
        ? '一次性、未登录 —— YouTube 不会给它签 pot，所以红灯是预期内的，别当成扩展坏了'
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
  let net = { all: [], describe: () => '0' };
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
    await cdp.send('Page.navigate', { url: URL_UNDER_TEST }, pageSession);

    view = await attach(cdp, target.targetId);

    // Poll rather than sleep once: the interesting question is not just the final
    // state but how long each step took, which is what the timeline shows.
    const started = Date.now();
    let last = '';
    let final = null;
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
      let state;
      try {
        state = JSON.parse(await view.evalIn(PROBE, iso.id));
      } catch (e) {
        continue;
      }
      final = state;
      const s = state.subtitle || {};
      const line = `${s.status || '?'}${s.reason ? '/' + s.reason : ''} · 轨 ${s.trackCount || 0} · cue ${s.cueCount || 0} · 译 ${s.translated || 0} · 字幕请求 ${net.all.length}`;
      if (line !== last) {
        console.log(`  t+${((Date.now() - started) / 1000).toFixed(0)}s  ${line}`);
        last = line;
      }
      // Settled states: nothing more will change on its own.
      if (s.status === 'ready' && s.translated > 0) break;
      if (s.status === 'empty' || s.status === 'error') break;
    }

    console.log('');
    if (final) {
      const s = final.subtitle || {};
      const p = final.player || {};
      console.log(`  ${'视频 ID'.padEnd(12)} ${s.videoId || '(无)'}`);
      console.log(`  ${'字幕轨'.padEnd(12)} ${s.trackCount ? `${s.trackCount} 条：${(s.trackLangs || []).join(', ')}` : '0 条'}`);
      console.log(`  ${'当前轨'.padEnd(12)} ${s.sourceTrack || '(无)'}`);
      console.log(`  ${'cue'.padEnd(12)} ${s.cueCount || 0}（已译 ${s.translated || 0}）`);
      console.log(`  ${'状态'.padEnd(12)} ${s.status || '?'}${s.reason ? ` · reason=${s.reason}` : ''}`);
      console.log(`  ${'播放器'.padEnd(12)} movie_player=${p.moviePlayer} 字幕按钮=${p.subtitleButton} pressed=${p.subtitlesPressed} 暂停=${p.paused} t=${p.currentTime}`);
      console.log(`  ${'字幕请求'.padEnd(12)} ${net.describe()}`);
      if (s.firstCue) console.log(`  ${'首条原文'.padEnd(12)} ${s.firstCue}`);
      if (s.firstTranslation) console.log(`  ${'首条译文'.padEnd(12)} ${s.firstTranslation}`);
      if (s.error) console.log(`  ${'错误'.padEnd(12)} ${s.error}`);
    }

    const v = verdict(final, net);
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
