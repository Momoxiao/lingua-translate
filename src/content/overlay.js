/**
 * Lingua — subtitle overlay renderer (isolated world).
 * Performance notes:
 *   - a single requestAnimationFrame loop, driven by video.currentTime
 *   - binary search over cues; the DOM is touched ONLY when the active cue
 *     changes (no per-frame writes, no layout thrash)
 *   - the overlay lives inside #movie_player, so fullscreen/theater mode work
 *     for free; the font scales with the player via a CSS custom property
 * Registers onto Lingua.overlay.
 */
(function (g) {
  'use strict';
  const NS = (g.Lingua = g.Lingua || {});
  const { store } = NS;
  const { FONTS } = NS.constants;

  const STYLE_ID = 'lingua-overlay-style';

  let root = null; // .lingua-overlay
  let elOriginal = null;
  let elTranslated = null;
  let elNotice = null;
  let noticeTimer = 0;
  let player = null;
  let video = null;
  let rafId = 0;
  let lastIndex = -2;
  let lastOriginal = '';
  let lastTranslated = '';
  let visible = true;
  let settings = null;
  let resizeObserver = null;
  let liveText = null; // set by live.js: { original, translated }

  const CSS = `
  .lingua-overlay{
    position:absolute; left:0; right:0; bottom:var(--lingua-bottom,12%);
    display:flex; flex-direction:column; align-items:center; gap:.3em;
    pointer-events:none; z-index:60; padding:0 5%;
    text-align:center; font-family:${FONTS.body};
    transform:translateZ(0); will-change:opacity;
  }
  .lingua-overlay[data-hidden="1"]{opacity:0}
  .lingua-line{
    display:inline-block; max-width:100%;
    padding:.2em .62em; border-radius:.36em;
    line-height:1.34; font-weight:600; letter-spacing:.01em;
    text-wrap:balance; white-space:pre-wrap; word-break:break-word;
    transition:opacity .12s linear;
  }
  /* The translated line is the hero: brightest, largest, with a shadow strong
     enough to stay readable over a bright frame. */
  .lingua-translated{
    font-size:calc(var(--lingua-font,24px) * var(--lingua-scale,1));
    color:#fff;
    text-shadow:0 1px 3px rgba(0,0,0,.9),0 0 12px rgba(0,0,0,.5);
    background:rgba(10,9,8,var(--lingua-bg,.72));
  }
  .lingua-original{
    font-size:calc(var(--lingua-font,24px) * var(--lingua-scale,1) * .72);
    color:#f1ebe3; font-weight:500;
    text-shadow:0 1px 3px rgba(0,0,0,.9);
    background:rgba(10,9,8,calc(var(--lingua-bg,.72) * .6));
  }
  .lingua-line:empty{display:none}
  .lingua-notice{
    display:inline-block;
    font:500 calc(13px * var(--lingua-scale,1))/1.45 ${FONTS.body};
    color:#f6f1ea; background:rgba(10,9,8,.86);
    border-left:3px solid #e4572e;
    padding:.5em .85em; border-radius:.35em; margin-top:.5em;
    box-shadow:0 6px 20px rgba(0,0,0,.35);
  }
  .lingua-notice:empty{display:none}
  html.lingua-hide-native .ytp-caption-window-container{opacity:0 !important}
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function findPlayer() {
    return (
      document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player') ||
      document.querySelector('ytd-player #container')
    );
  }

  function mount() {
    const p = findPlayer();
    if (!p) return false;
    if (root && player === p && p.contains(root)) return true;
    unmount();
    ensureStyle();
    player = p;

    root = document.createElement('div');
    root.className = 'lingua-overlay';
    elOriginal = document.createElement('div');
    elOriginal.className = 'lingua-line lingua-original';
    elTranslated = document.createElement('div');
    elTranslated.className = 'lingua-line lingua-translated';
    root.appendChild(elTranslated);
    root.appendChild(elOriginal);
    elNotice = document.createElement('div');
    elNotice.className = 'lingua-notice';
    root.appendChild(elNotice);
    p.appendChild(root);

    applyScale();
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(applyScale);
      resizeObserver.observe(p);
    }
    if (settings) applyStyles(settings);
    return true;
  }

  function unmount() {
    clearTimeout(noticeTimer);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    elOriginal = null;
    elTranslated = null;
    elNotice = null;
    player = null;
    video = null;
    lastIndex = -2;
    lastOriginal = '';
    lastTranslated = '';
  }

  /** Short-lived inline hint rendered above the captions. */
  function setNotice(text, ms = 6000) {
    clearTimeout(noticeTimer);
    if (!root) mount();
    if (!elNotice) return;
    elNotice.textContent = text || '';
    if (text && ms > 0) {
      noticeTimer = setTimeout(() => {
        if (elNotice) elNotice.textContent = '';
      }, ms);
    }
  }

  /** Keep the caption roughly the same visual size in windowed & fullscreen. */
  function applyScale() {
    if (!root || !player) return;
    const h = player.clientHeight || 480;
    const scale = Math.min(2.2, Math.max(0.72, h / 620));
    root.style.setProperty('--lingua-scale', scale.toFixed(3));
  }

  function applyStyles(s) {
    settings = s;
    if (!root) return;
    root.style.setProperty('--lingua-font', `${s.fontSize}px`);
    root.style.setProperty('--lingua-bottom', `${s.bottomOffset}%`);
    root.style.setProperty('--lingua-bg', String(s.backgroundOpacity));
    root.style.textAlign = s.textAlign || 'center';
    root.style.alignItems = s.textAlign === 'left' ? 'flex-start' : s.textAlign === 'right' ? 'flex-end' : 'center';
    document.documentElement.classList.toggle('lingua-hide-native', !!s.hideNativeCaptions);
  }

  function setVisible(v) {
    visible = v;
    if (root) root.dataset.hidden = v ? '0' : '1';
  }

  function pickVideo() {
    if (video && video.isConnected) return video;
    video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    return video;
  }

  /** Write to the DOM only when something actually changed. */
  function render(index, original, translated) {
    if (index === lastIndex && original === lastOriginal && translated === lastTranslated) return;
    lastIndex = index;
    lastOriginal = original;
    lastTranslated = translated;

    const mode = (settings && settings.displayMode) || 'bilingual';
    const showOriginal = mode === 'bilingual' || mode === 'original';
    const showTranslated = mode === 'bilingual' || mode === 'translated';

    if (elTranslated) {
      const text = showTranslated ? translated || (mode === 'translated' ? original : '') : '';
      if (elTranslated.textContent !== text) elTranslated.textContent = text;
      elTranslated.style.opacity = translated || mode === 'translated' ? '1' : '.55';
    }
    if (elOriginal) {
      const text = showOriginal && mode !== 'translated' ? original || '' : '';
      if (elOriginal.textContent !== text) elOriginal.textContent = text;
    }
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!visible) return;
    const v = pickVideo();
    if (!v) return;

    // Live mode: live.js owns the text, we just render it.
    if (liveText) {
      render(-3, liveText.original || '', liveText.translated || '');
      return;
    }

    const cues = store.state.cues;
    if (!cues.length) {
      render(-1, '', '');
      return;
    }
    const idx = store.cueAt(v.currentTime);
    if (idx < 0) {
      render(-1, '', '');
      return;
    }
    render(idx, cues[idx].text, store.state.translations[idx] || '');
  }

  function setLive(original, translated) {
    liveText = original == null ? null : { original, translated: translated || '' };
  }

  function start() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  NS.overlay = { mount, unmount, applyStyles, setVisible, setLive, setNotice, start, stop, findPlayer, ensureStyle };
})(typeof globalThis !== 'undefined' ? globalThis : self);
