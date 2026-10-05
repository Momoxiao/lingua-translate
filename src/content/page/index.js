/**
 * Lingua — full-page translation orchestrator.
 *
 * Lifecycle: scan DOM -> build a priority queue ordered by distance from the
 * viewport centre -> translate in character-budgeted batches with bounded
 * concurrency -> render -> keep watching for dynamically added content.
 *
 * Registers onto YTST.page.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});
  const page = (NS.page = NS.page || {});
  const { bridge } = NS;

  const MAX_UNITS = 6000;
  const MAX_FAILURES = 3;
  const MUTATION_DEBOUNCE = 700;
  const SCROLL_DEBOUNCE = 300;

  /** Video players and our own nodes are never page-translation targets. */
  const BUILTIN_SKIP = '.html5-video-player, #movie_player, ytd-player, .lingua-pg-dst, .lingua-pg-src';

  const state = {
    active: false,
    status: 'idle', // idle | scanning | translating | done | error
    total: 0,
    done: 0,
    error: '',
    mode: 'bilingual',
    style: 'underline',
    showOriginal: false,
  };

  let settings = null;
  let units = [];
  let pending = new Set();
  let inflight = 0;
  let generation = 0;
  let failures = 0;
  let observer = null;
  let mutationTimer = 0;
  let scrollTimer = 0;
  let scrollBound = false;

  // ---------------------------------------------------------------------------
  // Site rules
  // ---------------------------------------------------------------------------
  function hostname() {
    try {
      return location.hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  function supportedScheme() {
    return /^https?:$/.test(location.protocol) || location.protocol === 'file:';
  }

  function siteRule(s) {
    const p = (s && s.page) || {};
    const h = hostname();
    if ((p.skipSites || []).indexOf(h) !== -1) return 'skip';
    if ((p.autoSites || []).indexOf(h) !== -1) return 'auto';
    return 'manual';
  }

  function isBlocked(s) {
    return siteRule(s) === 'skip';
  }

  function shouldAutoTranslate(s) {
    if (!s || !s.enabled) return false;
    if (!supportedScheme()) return false;
    if (!NS.settings.providerReady(s)) return false;
    if (isBlocked(s)) return false;
    return !!(s.page && s.page.autoTranslate) || siteRule(s) === 'auto';
  }

  function effectiveSkip() {
    const user = (settings && settings.page && settings.page.skipSelectors) || '';
    return user ? `${BUILTIN_SKIP}, ${user}` : BUILTIN_SKIP;
  }

  /** Render options derived from the current settings. */
  function renderOpts() {
    return {
      mode: state.mode,
      style: state.style,
      showOriginal: state.showOriginal,
      linkMode: (settings && settings.page && settings.page.replaceLinkMode) || 'translate',
    };
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------
  function collectFrom(root) {
    const opts = { skipSelectors: effectiveSkip() };
    const found = page.units.collect(root, opts);
    if (settings && settings.page && settings.page.translateInputs) {
      const attrs = page.units.collectAttributes(root, opts);
      for (const a of attrs) found.push(a);
    }
    return found;
  }

  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  // ---------------------------------------------------------------------------
  // Scheduler
  // ---------------------------------------------------------------------------
  function remainingCount() {
    let n = 0;
    for (let i = 0; i < units.length; i++) if (!pending.has(i)) n++;
    return n;
  }

  function nextChunk() {
    const maxCount = Math.max(1, (settings.page && settings.page.batchSize) || 12);
    const maxChars = Math.max(200, (settings.page && settings.page.maxChars) || 1400);
    const center = (window.scrollY || window.pageYOffset || 0) + window.innerHeight / 2;

    const cands = [];
    for (let i = 0; i < units.length; i++) {
      if (pending.has(i)) continue;
      const u = units[i];
      if (!u.el || !u.el.isConnected) {
        pending.add(i); // left the DOM — drop it
        continue;
      }
      cands.push(i);
    }
    if (!cands.length) return [];

    cands.sort((a, b) => Math.abs(units[a].top - center) - Math.abs(units[b].top - center));

    const chunk = [];
    let chars = 0;
    for (const i of cands) {
      if (chunk.length >= maxCount) break;
      const len = units[i].text.length;
      if (chunk.length && chars + len > maxChars) break;
      chunk.push(i);
      chars += len;
    }
    return chunk;
  }

  function dispatch(chunk) {
    for (const i of chunk) {
      pending.add(i);
      page.render.markPending(units[i]);
    }
    inflight++;
    const gen = generation;
    const texts = chunk.map((i) => units[i].text);

    bridge
      .translate(texts, {
        from: settings.sourceLang,
        to: settings.targetLang,
        kind: 'page',
      })
      .then(({ results }) => {
        if (gen !== generation) return;
        failures = 0;
        state.error = '';
        for (let k = 0; k < chunk.length; k++) {
          const u = units[chunk[k]];
          const t = results[k];
          if (t && u.el && u.el.isConnected) {
            page.render.apply(u, t, renderOpts());
            state.done++;
          } else {
            page.render.unmark(u);
          }
        }
      })
      .catch((err) => {
        if (gen !== generation) return;
        if (err && err.code === bridge.CODE_CONTEXT_LOST) {
          state.status = 'error';
          state.error = err.message;
          syncBall();
          page.ball.notify(err.message, 'err', 8000);
          teardown({ keepIndicator: true });
          return;
        }
        failures++;
        state.error = (err && (err.message || err.name || String(err))) || '翻译失败';
        if (err && err.code) state.error += ` [${err.code}]`;
        for (const i of chunk) {
          pending.delete(i);
          page.render.unmark(units[i]);
        }
        if (failures >= MAX_FAILURES) {
          state.status = 'error';
          syncBall();
          page.ball.notify(state.error, 'err', 8000);
          teardown({ keepIndicator: true });
        }
      })
      .finally(() => {
        inflight--;
        if (gen !== generation) return;
        if (state.status === 'error') return;
        report();
        if (state.active) pump();
      });
  }

  function pump() {
    if (!state.active || state.status === 'error') return;
    const limit = Math.max(1, (settings.page && settings.page.concurrency) || 3);
    while (inflight < limit) {
      const chunk = nextChunk();
      if (!chunk.length) break;
      dispatch(chunk);
    }
    if (!inflight && !remainingCount()) finish();
    else report();
  }

  function report() {
    syncBall();
  }

  function finish() {
    state.status = 'done';
    syncBall();
    page.ball.notify(`已翻译 ${state.done} 段`, 'ok', 2600);
  }

  /** Push the current pipeline state into the floating ball. */
  function syncBall() {
    if (!page.ball) return;
    page.ball.setStatus({
      active: state.active,
      status: state.status,
      done: state.done,
      total: state.total,
      error: state.error,
      showSource: state.showOriginal,
    });
  }

  /**
   * Mount or remove the floating ball. The ball is a permanent page control —
   * it stays put when translation stops, because clicking it is how you start
   * translation in the first place.
   */
  function ensureBall(s) {
    if (!page.ball) return;
    // Remember the settings: clicking the ball is the very first interaction on a
    // page, and toggle() -> start() needs them before anything else has run.
    if (s) settings = s;
    const allowed = s && s.enabled !== false && supportedScheme() && !isBlocked(s) && !(s.page && s.page.showBall === false);
    if (!allowed) {
      page.ball.destroy();
      return;
    }
    page.ball.mount({
      onToggle: () => toggle(),
      onRetranslate: () => retranslate(),
      onStop: () => stop(),
      onToggleOriginal: () => toggleOriginal(),
      onOpenSettings: () => {
        try {
          chrome.runtime.sendMessage({ type: 'lingua:open-options' });
        } catch (e) {
          /* context gone */
        }
      },
    });
    syncBall();
  }

  // ---------------------------------------------------------------------------
  // Dynamic content
  // ---------------------------------------------------------------------------
  function attachObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    if (!scrollBound) {
      window.addEventListener('scroll', onScroll, { passive: true });
      scrollBound = true;
    }
  }

  function detachObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(mutationTimer);
    clearTimeout(scrollTimer);
    if (scrollBound) {
      window.removeEventListener('scroll', onScroll);
      scrollBound = false;
    }
  }

  function onMutations(records) {
    if (!state.active) return;
    const added = [];
    for (const rec of records) {
      for (const n of rec.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.hasAttribute && n.hasAttribute('data-lingua-node')) continue;
        added.push(n);
      }
    }
    if (!added.length) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      if (!state.active) return;
      let found = [];
      for (const el of added) {
        if (units.length + found.length >= MAX_UNITS) break;
        if (!el.isConnected) continue;
        // Ignore anything injected inside an already-translated block.
        if (el.closest && el.closest('[data-lingua]')) continue;
        found = found.concat(collectFrom(el));
      }
      if (!found.length) return;
      for (const u of found) units.push(u);
      state.total = units.length;
      pump();
    }, MUTATION_DEBOUNCE);
  }

  function onScroll() {
    if (!state.active) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (!state.active) return;
      const rest = [];
      for (let i = 0; i < units.length; i++) if (!pending.has(i)) rest.push(units[i]);
      page.units.refreshPositions(rest);
      pump();
    }, SCROLL_DEBOUNCE);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  async function start(s, opts) {
    settings = s || settings;
    if (!settings) return;
    if (!bridge.isAlive()) {
      state.status = 'error';
      state.error = bridge.contextError().message;
      ensureBall(settings);
      syncBall();
      page.ball.notify(state.error, 'err', 8000);
      return;
    }
    if (!settings.enabled) return;
    if (state.active) return;

    const gen = ++generation;
    page.render.ensureStyle();
    state.active = true;
    state.status = 'scanning';
    state.error = '';
    state.mode = (settings.page && settings.page.displayMode) || 'bilingual';
    state.style = (settings.page && settings.page.style) || 'underline';
    state.total = 0;
    state.done = 0;
    units = [];
    pending = new Set();
    inflight = 0;
    failures = 0;

    ensureBall(settings);
    syncBall();

    await nextFrame();
    if (gen !== generation || !state.active) return;

    const body = document.body;
    if (!body) {
      state.status = 'error';
      state.error = '页面尚未就绪';
      syncBall();
      page.ball.notify(state.error, 'err', 6000);
      teardown({ keepIndicator: true });
      return;
    }

    units = collectFrom(body).slice(0, MAX_UNITS);
    state.total = units.length;

    if (!units.length) {
      state.status = 'done';
      syncBall();
      page.ball.notify('没有可翻译的内容', 'ok', 3000);
      teardown({ keepIndicator: true });
      return;
    }

    state.status = 'translating';
    attachObserver();
    pump();
  }

  function teardown(opts) {
    generation++;
    state.active = false;
    detachObserver();
    units = [];
    pending = new Set();
    inflight = 0;
    // The floating ball is deliberately NOT destroyed here — it is the page's
    // permanent control, and stopping a translation must not remove it.
  }

  /** Stop and restore the original page. */
  function stop() {
    teardown({});
    page.render.removeAll();
    state.status = 'idle';
    state.done = 0;
    state.total = 0;
    state.error = '';
    // Stopping means going back to the plain page: drop the "original only" flag
    // too, otherwise it would linger and hide the next translation.
    if (state.showOriginal) {
      state.showOriginal = false;
      page.render.setShowOriginal(false);
    }
    syncBall();
  }

  function toggle(s) {
    if (s) settings = s;
    if (state.active) stop();
    else start(settings);
  }

  /** Forget current results and translate again from scratch. */
  async function retranslate(s) {
    if (s) settings = s;
    teardown({});
    page.render.removeAll();
    state.status = 'idle';
    await start(settings);
  }

  /** React to settings changes without re-scanning. */
  function update(s) {
    if (!s) return;
    const prevMode = state.mode;
    const prevLinkMode = renderOpts().linkMode;
    settings = s;
    state.mode = (s.page && s.page.displayMode) || 'bilingual';
    state.style = (s.page && s.page.style) || 'underline';
    ensureBall(s);
    if (!s.enabled) {
      if (state.active) stop();
      return;
    }
    if (!state.active) return;

    if (state.mode !== prevMode || renderOpts().linkMode !== prevLinkMode) {
      // Switching between bilingual and "translated only" changes the DOM shape
      // (source wrapper, link placeholders), so rebuild from the cache rather
      // than trying to patch the existing nodes in place.
      retranslate();
      return;
    }
    page.render.restyle(renderOpts());
  }

  /** Toggle between "translated" and "original only". */
  function toggleOriginal() {
    state.showOriginal = !state.showOriginal;
    page.render.setShowOriginal(state.showOriginal);
    syncBall();
    // Units that own a hyperlink have to hand it to whichever copy is visible,
    // so the DOM is rebuilt from the cache (translations are cached: it is fast).
    if (state.active) retranslate();
    return state.showOriginal;
  }

  function status() {
    return {
      active: state.active,
      status: state.status,
      total: state.total,
      done: state.done,
      error: state.error,
      mode: state.mode,
      style: state.style,
      showOriginal: state.showOriginal,
      host: hostname(),
      rule: settings ? siteRule(settings) : 'manual',
      auto: settings ? shouldAutoTranslate(settings) : false,
    };
  }

  page.state = state;
  page.start = start;
  page.stop = stop;
  page.toggle = toggle;
  page.retranslate = retranslate;
  page.update = update;
  page.status = status;
  page.toggleOriginal = toggleOriginal;
  page.shouldAutoTranslate = shouldAutoTranslate;
  page.isBlocked = isBlocked;
  page.siteRule = siteRule;
  page.hostname = hostname;
  page.supportedScheme = supportedScheme;
  page.ensureBall = ensureBall;
  page.syncBall = syncBall;
})(typeof globalThis !== 'undefined' ? globalThis : self);
