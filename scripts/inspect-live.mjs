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
 * Usage:
 *   node scripts/inspect-live.mjs                       # all tabs
 *   node scripts/inspect-live.mjs youtube.com           # only matching URLs
 *   node scripts/inspect-live.mjs --port 9222 github.com
 */
import { connect, attach } from './lib/cdp.mjs';

const args = process.argv.slice(2);
let port = 9222;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else rest.push(args[i]);
}
const filter = rest[0] || '';

const STATE_PROBE = `(function () {
  if (typeof YTST === 'undefined' || !YTST) {
    return JSON.stringify({ injected: false });
  }
  const st = YTST.store && YTST.store.state;
  return JSON.stringify({
    injected: true,
    hasPageModule: !!YTST.page,
    hasLiveModule: !!YTST.live,
    bridgeAlive: YTST.bridge ? YTST.bridge.isAlive() : null,
    subtitle: st ? {
      status: st.status,
      videoId: st.videoId,
      error: st.error,
      trackCount: st.tracks.length,
      trackLangs: st.tracks.map(function (t) { return t.languageCode + (t.kind ? '/' + t.kind : ''); }),
      sourceTrack: st.sourceTrack ? st.sourceTrack.languageCode : null,
      cueCount: st.cues.length,
      translated: YTST.store.translatedCount(),
      liveMode: st.liveMode,
      firstCue: st.cues[0] ? st.cues[0].text.slice(0, 70) : null,
      firstTranslation: st.translations[0] || null
    } : null,
    page: YTST.page ? YTST.page.status() : null
  });
})()`;

function line(label, value) {
  console.log(`  ${String(label).padEnd(18)} ${value}`);
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
      } else {
        const state = JSON.parse(await view.evalIn(STATE_PROBE, iso.id));
        if (!state.injected) {
          console.log('  content script     isolated world exists but YTST is undefined');
        } else {
          line('has page module', state.hasPageModule);
          line('bridge alive', state.bridgeAlive);
          if (state.subtitle) {
            const s = state.subtitle;
            line('subtitle status', s.status);
            line('video id', s.videoId || '(none)');
            line('tracks', s.trackCount ? `${s.trackCount} [${s.trackLangs.join(', ')}]` : '0');
            line('source track', s.sourceTrack || '(none)');
            line('cues', `${s.cueCount} (translated ${s.translated})`);
            if (s.firstCue) line('first cue', s.firstCue);
            if (s.firstTranslation) line('first trans', s.firstTranslation);
            if (s.error) line('subtitle error', s.error);
          }
          if (state.page) {
            const p = state.page;
            line('page status', `${p.status} ${p.done}/${p.total} rule=${p.rule} active=${p.active}`);
            if (p.error) line('page error', p.error);
          }
        }
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
