/**
 * Lingua — live inspection of a running Chrome.
 *
 * Connects to a Chrome started with --remote-debugging-port, then reads the
 * extension's real state out of a page's content-script isolated world:
 * which modules are loaded, whether the background bridge is alive, how many
 * caption tracks / cues were found, and what the page pipeline is doing.
 *
 * Use this whenever "it doesn't work" needs an actual diagnosis instead of a guess.
 *
 * `--refresh` is the one that answers "is the caption path broken in MY
 * browser": it watches /api/timedtext over CDP, asks the content script to
 * reload the captions from scratch, and reports **which side** issued each
 * request. That attribution is the difference between a result you can act on
 * and a number you have to guess about — see scripts/lib/captions.mjs.
 *
 * Read-only on purpose: it never writes settings or storage, which is what makes
 * it safe to point at the browser you actually use. `smoke-youtube.mjs` is the
 * opposite trade — a throwaway profile, but it installs a mock provider.
 *
 * Usage:
 *   node scripts/inspect-live.mjs                        # all tabs, read state
 *   node scripts/inspect-live.mjs youtube.com            # only matching URLs
 *   node scripts/inspect-live.mjs --port 9222 github.com
 *   node scripts/inspect-live.mjs --refresh youtube.com  # reload captions, watch
 *   INSPECT_TIMEOUT=40 node scripts/inspect-live.mjs --refresh youtube.com
 */
import { connect, attach } from './lib/cdp.mjs';
import { watchCaptionRequests } from './lib/captions.mjs';

const args = process.argv.slice(2);
let port = 9222;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else rest.push(args[i]);
}
const REFRESH = rest.includes('--refresh');
const filter = rest.filter((a) => !a.startsWith('--'))[0] || '';
const TIMEOUT_MS = (Number(process.env.INSPECT_TIMEOUT) || 30) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_PROBE = `(function () {
  if (typeof Lingua === 'undefined' || !Lingua) {
    return JSON.stringify({ injected: false });
  }
  var st = Lingua.store && Lingua.store.state;
  var mp = document.getElementById('movie_player');
  var v = document.querySelector('video.html5-main-video') || document.querySelector('video');
  var btn = document.querySelector('.ytp-subtitles-button');
  return JSON.stringify({
    injected: true,
    hasPageModule: !!Lingua.page,
    hasLiveModule: !!Lingua.live,
    bridgeAlive: Lingua.bridge ? Lingua.bridge.isAlive() : null,
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
      liveMode: st.liveMode,
      firstCue: st.cues[0] ? st.cues[0].text.slice(0, 70) : null,
      firstTranslation: st.translations[0] || null
    } : null,
    player: {
      moviePlayer: !!mp,
      subtitleButton: !!btn,
      subtitlesPressed: btn ? btn.getAttribute('aria-pressed') : null,
      paused: v ? !!v.paused : null,
      currentTime: v ? Math.round(v.currentTime * 10) / 10 : null
    },
    page: Lingua.page ? Lingua.page.status() : null
  });
})()`;

function line(label, value) {
  console.log(`  ${String(label).padEnd(18)} ${value}`);
}

/**
 * Reload the captions from scratch and watch what the page does about it.
 * `load()` is fired without awaiting it: it only resolves after the 10s
 * wire-caption fallback has given up, which would hide the whole timeline.
 */
async function refreshAndWatch(cdp, view, iso) {
  await cdp.send('Network.enable', {}, view.sessionId);
  const net = watchCaptionRequests(cdp, view.sessionId);

  const started = await view.evalIn(
    `(function () {
      try {
        if (!Lingua.youtube || !Lingua.youtube.load) return 'no-youtube-module';
        Lingua.youtube.load();
        return 'started';
      } catch (e) { return 'error: ' + ((e && e.message) || e); }
    })()`,
    iso.id
  );
  console.log(`\n  --refresh: ${started}`);
  if (started !== 'started') return { net, state: null };

  const t0 = Date.now();
  let last = '';
  let final = null;
  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(2000);
    let state;
    try {
      state = JSON.parse(await view.evalIn(STATE_PROBE, iso.id));
    } catch (e) {
      continue;
    }
    final = state;
    const s = state.subtitle || {};
    const row = `${s.status || '?'}${s.reason ? '/' + s.reason : ''} · 轨 ${s.trackCount || 0} · cue ${s.cueCount || 0} · 译 ${s.translated || 0} · 字幕请求 ${net.all.length}`;
    if (row !== last) {
      console.log(`     t+${((Date.now() - t0) / 1000).toFixed(0)}s  ${row}`);
      last = row;
    }
    // Settled: nothing more will change on its own.
    if (s.status === 'empty' || s.status === 'error') break;
    if (s.status === 'ready' && s.translated > 0) break;
    if (s.status === 'idle' && Date.now() - t0 > 8000) break;
  }
  return { net, state: final };
}

function captionVerdict(state, net) {
  const s = (state && state.subtitle) || {};
  const { ours, theirs, potty } = net.counts();
  if (!s.trackCount) return { tone: 'warn', text: '没有解析出任何字幕轨。' };
  if (!s.cueCount) {
    if (!net.all.length) {
      return {
        tone: 'warn',
        text: `有 ${s.trackCount} 条轨，但一次 /api/timedtext 都没发出去——播放器没走到取字幕那一步。`,
      };
    }
    if (theirs === 0) {
      return {
        tone: 'warn',
        text:
          `有 ${s.trackCount} 条轨，只有扩展自己发了 ${ours} 次请求（带 pot 的 ${potty} 次），body 是空的；` +
          '播放器一次都没请求字幕——没有 pot 可以复用，「嗅探播放器请求」这条兜底路径无事可做。',
      };
    }
    return {
      tone: 'warn',
      text:
        `有 ${s.trackCount} 条轨，播放器请求了 ${theirs} 次、扩展请求了 ${ours} 次（带 pot 的 ${potty} 次），` +
        '但一条 cue 都没解析出来。',
    };
  }
  if (!s.translated) {
    return { tone: 'warn', text: `取到 ${s.cueCount} 条 cue，但一条都没翻译成功——卡在翻译那一层。` };
  }
  return { tone: 'ok', text: `正常：${s.trackCount} 条轨，${s.translated}/${s.cueCount} 条已翻译。` };
}

(async function main() {
  const { cdp, ws } = await connect(port);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  const { targetInfos } = await cdp.send('Target.getTargets');
  const pages = targetInfos.filter(
    (t) => (t.type === 'page' || t.type === 'service_worker' || t.type === 'background_page') &&
      (!filter || t.url.includes(filter))
  );

  const extWorkers = targetInfos.filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
  console.log(`\nextension service workers (${extWorkers.length}):`);
  for (const w of extWorkers) console.log(`  ${w.url}`);

  for (const t of pages) {
    if (t.type !== 'page') continue;
    console.log(`\n=== ${t.url.slice(0, 110)}`);
    try {
      const view = await attach(cdp, t.targetId);
      const iso = await view.findWorld();

      const raw = await view.evalPage(`document.querySelectorAll('.lingua-overlay').length + '|' +
        document.querySelectorAll('.lingua-pg-dst').length + '|' +
        document.querySelectorAll('.lingua-pg-src').length + '|' +
        ((document.querySelector('.lingua-notice') || {}).textContent || '') + '|' +
        document.documentElement.className`);
      const [ov, dst, src, notice, cls] = String(raw).split('|');
      line('overlay nodes', ov);
      line('page dst/src', `${dst} / ${src}`);
      line('notice text', notice || '(none)');
      line('html classes', cls || '(none)');

      if (!iso) {
        console.log('  content script     NOT INJECTED (no isolated world)');
        continue;
      }

      let state = JSON.parse(await view.evalIn(STATE_PROBE, iso.id));
      if (!state.injected) {
        console.log('  content script     isolated world exists but Lingua is undefined');
        continue;
      }

      // Only a watch page has captions to reload; anywhere else --refresh would
      // just query a module that is not running.
      const isWatch = /\/watch/.test(t.url);
      let net = null;
      if (REFRESH && isWatch) {
        const out = await refreshAndWatch(cdp, view, iso);
        net = out.net;
        if (out.state) state = out.state;
      }

      line('has page module', state.hasPageModule);
      line('bridge alive', state.bridgeAlive);
      if (state.subtitle) {
        const s = state.subtitle;
        line('subtitle status', `${s.status}${s.reason ? ` · reason=${s.reason}` : ''}`);
        line('video id', s.videoId || '(none)');
        line('tracks', s.trackCount ? `${s.trackCount} [${s.trackLangs.join(', ')}]` : '0');
        line('source track', s.sourceTrack || '(none)');
        line('cues', `${s.cueCount} (translated ${s.translated})`);
        if (s.firstCue) line('first cue', s.firstCue);
        if (s.firstTranslation) line('first trans', s.firstTranslation);
        if (s.error) line('subtitle error', s.error);
      }
      if (state.player && isWatch) {
        const p = state.player;
        line(
          'player',
          `movie_player=${p.moviePlayer} 字幕按钮=${p.subtitleButton} pressed=${p.subtitlesPressed} 暂停=${p.paused} t=${p.currentTime}`
        );
      }
      if (net) {
        line('caption requests', net.describe());
        const params = net.sample();
        if (params) line('sample params', params);
        const v = captionVerdict(state, net);
        console.log(`\n  ${v.tone === 'ok' ? 'OK  ' : 'WARN'}  ${v.text}`);
      }
      if (state.page) {
        const p = state.page;
        line('page status', `${p.status} ${p.done}/${p.total} rule=${p.rule} active=${p.active}`);
        if (p.error) line('page error', p.error);
      }

      if (view.consoleErrors.length) {
        console.log(`  console errors (${view.consoleErrors.length}):`);
        for (const e of view.consoleErrors.slice(0, 5)) console.log(`    - ${String(e).split('\n')[0]}`);
      }
    } catch (e) {
      console.log(`  [attach failed] ${e.message}`);
    }
  }

  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('inspect failed:', e.message);
  process.exit(1);
});
