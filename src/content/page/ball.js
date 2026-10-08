/**
 * Lingua — full-page translation: floating action ball.
 *
 * The always-available entry point. Before this existed the only way to
 * translate a page was the toolbar popup, which meant leaving the page.
 *
 * Behaviour
 *   - click        : translate / stop
 *   - hover        : slides in from the edge and expands a pill with secondary actions
 *   - drag         : moves it; the position is remembered per hostname, and it
 *                    docks to the nearest edge where it rests mostly hidden
 *   - progress     : an arc around the ball, no separate progress bar needed
 *
 * Lives in a shadow root so no site stylesheet can reach it, and it can never
 * leak styles into the page.
 *
 * Registers onto Lingua.page.ball.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const page = (NS.page = NS.page || {});
  const { FONTS } = NS.constants;
  const tr = (zh, key, vars) => (NS.i18n ? NS.i18n.t(zh, key, vars) : zh);

  const HOST_ID = 'lingua-ball';
  const POS_KEY = 'lingua:ball:positions';
  const SIZE = 44;
  const MARGIN = 10;
  const PEEK = 12; // how much stays visible when docked at an edge
  /** Within this many px of an edge the ball rests half-hidden; further in it
   *  just sits where you put it. */
  const DOCK_ZONE = 24;
  const DRAG_SLOP = 5;

  let host = null;
  let shadow = null;
  let el = null;
  let handlers = {};
  let pos = null; // {x, y} in viewport px
  let dock = 'right'; // which edge it is parked against
  let visible = true;
  let labelTimer = 0;
  let drag = null;
  let state = { active: false, status: 'idle', done: 0, total: 0, error: '' };
  let transient = null; // temporary status override

  const CSS = `
:host{ all:initial; }
*{ box-sizing:border-box; }

/* The host IS the ball's box. Everything else is absolutely positioned, so
   expanding the pill can never push the ball around the screen. */
.wrap{
  position:absolute; inset:0;
  --ring-gap:3px;
  font:500 12px/1.4 ${FONTS.body};
  user-select:none; -webkit-user-select:none;
  transition:transform .22s cubic-bezier(.22,.61,.36,1), opacity .18s ease;
}
.wrap[hidden]{ display:none; }

/* The progress ring is drawn 3px outside the ball, so the band between them fell
   outside the hover box: grazing the ring dropped the hover, the ball docked,
   and the pointer was over the ball again — the same stutter, and the most
   likely thing a user means by "between the border and the ball". This pad makes
   the hit area match the drawn footprint. */
.wrap::before{
  content:''; position:absolute; inset:calc(-1 * var(--ring-gap));
  border-radius:50%;
}

/* --- docked at an edge: rest mostly hidden, slide out on hover --- */
.wrap.dock-left{ transform:translateX(calc(-100% + ${PEEK}px)); }
.wrap.dock-right{ transform:translateX(calc(100% - ${PEEK}px)); }
.wrap.dock-left:hover, .wrap.dock-right:hover, .wrap.dock-left.pinned, .wrap.dock-right.pinned,
.wrap.dock-left.dragging, .wrap.dock-right.dragging{ transform:translateX(0); }

/* Sliding out from under the pointer fires a pointerleave even though the user
   never moved: the ball docks again, the pointer is over it once more, it opens
   — a stutter that repeats as long as the cursor sits in the ${MARGIN}px band
   between the resting position and the screen edge. This invisible strip keeps
   the hover alive across exactly that band, which is where the docked ball was
   showing anyway, so it covers no part of the page the widget did not already
   occupy. */
.wrap.dock-right:hover::after, .wrap.dock-right.pinned::after{
  content:''; position:absolute; top:0; bottom:0; left:100%; width:${MARGIN}px;
}
.wrap.dock-left:hover::after, .wrap.dock-left.pinned::after{
  content:''; position:absolute; top:0; bottom:0; right:100%; width:${MARGIN}px;
}

/* --- pill: opens towards the middle of the screen --- */
.pill{
  position:absolute; top:50%; right:calc(100% + 8px);
  transform:translateY(-50%) scale(.94);
  transform-origin:right center;
  display:flex; align-items:center; gap:2px;
  padding:5px 5px 5px 12px;
  background:rgba(24,20,16,.96);
  border:1px solid rgba(255,255,255,.12);
  border-radius:999px;
  box-shadow:0 10px 30px rgba(0,0,0,.34), 0 2px 6px rgba(0,0,0,.26);
  color:#f6f1ea;
  opacity:0; pointer-events:none;
  transition:opacity .16s ease, transform .16s ease;
  white-space:nowrap;
}
/* invisible bridge across the gap, so the pointer can travel from the ball to
   the pill without leaving the hover area and collapsing it */
.pill::after{
  content:''; position:absolute; top:-6px; bottom:-6px; right:-10px; width:12px;
}
.wrap.open-right .pill{
  right:auto; left:calc(100% + 8px);
  transform-origin:left center;
}
.wrap.open-right .pill::after{ right:auto; left:-10px; }
.wrap:hover .pill, .wrap.pinned .pill, .pill:hover{
  opacity:1; pointer-events:auto; transform:translateY(-50%) scale(1);
}
/* The status reads as a caption and is separated from the actions by a
   hairline, so the row does not look like five equal buttons. */
.status{
  font-size:11.5px; font-weight:500; color:#f6f1ea; opacity:.78;
  padding-right:11px; margin-right:4px;
  border-right:1px solid rgba(255,255,255,.16);
  letter-spacing:.01em; max-width:210px; overflow:hidden; text-overflow:ellipsis;
}
.act{
  font:inherit; font-size:11.5px; font-weight:500; color:#f6f1ea;
  background:transparent; border:0; border-radius:999px;
  padding:5px 11px; cursor:pointer; white-space:nowrap;
  transition:background .14s ease, color .14s ease;
}
.act:hover{ background:rgba(255,255,255,.14); }
.act:focus-visible{ outline:2px solid #ff8a63; outline-offset:1px; }
.act[data-act="stop"]:hover{ background:rgba(224,112,95,.24); color:#ffb3a6; }
.act[hidden]{ display:none; }

/* --- the ball itself --- */
.ball{
  position:absolute; inset:0;
  border-radius:50%; cursor:pointer;
  background:rgba(24,20,16,.95);
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 6px 22px rgba(0,0,0,.32);
  display:grid; place-items:center;
  transition:transform .16s ease, background .18s ease, border-color .18s ease;
  touch-action:none;
}
.ball:hover{ transform:scale(1.06); }
.ball:focus-visible{ outline:2px solid #ff8a63; outline-offset:3px; }
.wrap.dragging .ball{ transform:scale(1.10); cursor:grabbing; }
.wrap.busy .ball{ border-color:rgba(228,87,46,.6); }
.wrap.on .ball{ background:#e4572e; border-color:#e4572e; }
.wrap.err .ball{ background:#c0392b; border-color:#c0392b; }

.glyph{ display:flex; align-items:baseline; gap:1px; color:#f6f1ea; font-weight:700; font-size:13px; line-height:1; }
.glyph .a{ opacity:.62; font-size:11px; }
.wrap.on .glyph, .wrap.err .glyph{ color:#fff; }
.wrap.on .glyph .a, .wrap.err .glyph .a{ opacity:.75; }

/* progress ring drawn around the ball.
   The box is derived from the ball's padding box, NOT from the SVG's intrinsic
   size: a replaced element that carries width/height attributes keeps that size
   and the over-constrained right/bottom insets get dropped, which anchored the
   ring at the top-left instead of centring it (measured: 50x50 offset +1,+1,
   leaving a 2px gap on one side and 4px on the other). Sizing the box explicitly
   and letting the viewBox letterbox inside it keeps the ring perfectly
   concentric.
   GAP=3px puts the stroke right on the ball's edge, so it is legible whatever
   the page background is — a ring floating in the page would vanish on a light
   site, where a white arc has nothing to sit against. */
.ring{
  position:absolute;
  left:calc(-1 * var(--ring-gap));
  top:calc(-1 * var(--ring-gap));
  width:calc(100% + var(--ring-gap) * 2);
  height:calc(100% + var(--ring-gap) * 2);
  transform:rotate(-90deg); pointer-events:none;
}
.ring circle{ fill:none; stroke-width:2.5; }
.ring .track{ stroke:rgba(255,255,255,.14); }
.ring .bar{ stroke:#ff8a63; stroke-linecap:round; transition:stroke-dashoffset .3s ease; }
.wrap.on .ring .bar{ stroke:#fff; }
.wrap.idle .ring{ display:none; }

/* tiny badge for completion / errors */
.dot{
  position:absolute; top:-1px; right:-1px; width:9px; height:9px; border-radius:50%;
  background:#ff8a63; border:2px solid rgba(22,19,15,.95); display:none;
}
.wrap.done .dot{ display:block; background:#7ac47a; }
.wrap.err .dot{ display:block; background:#e0705f; }
/* Parked on the right edge, the ball only shows its LEFT sliver — a dot in the
   top-right corner would sit off-screen. Keep it on whichever side faces the
   page, so it is visible in both the docked and the expanded state. */
.wrap.dock-right .dot{ right:auto; left:-1px; }
`;

  // ---------------------------------------------------------------------------
  // Position
  // ---------------------------------------------------------------------------
  function defaultPos() {
    return { x: window.innerWidth - SIZE - MARGIN, y: Math.round(window.innerHeight * 0.42) };
  }

  function clampPos(p) {
    const maxX = Math.max(MARGIN, window.innerWidth - SIZE - MARGIN);
    const maxY = Math.max(MARGIN, window.innerHeight - SIZE - MARGIN);
    return {
      x: Math.min(Math.max(p.x, MARGIN), maxX),
      y: Math.min(Math.max(p.y, MARGIN), maxY),
    };
  }

  function applyPos() {
    if (!host || !el) return;
    const p = clampPos(pos || defaultPos());
    host.style.left = `${p.x}px`;
    host.style.top = `${p.y}px`;

    // `dock` answers "is the ball resting against an edge", which is a different
    // question from "which way should the pill open". The old code answered both
    // with `x > innerWidth / 2`, so the dock transform was applied at any x —
    // including mid-drag coordinates, where it only escaped being visible
    // because `.dragging` happens to neutralise the transform. Splitting the two
    // means the transform can only ever apply where it means something.
    const maxX = Math.max(MARGIN, window.innerWidth - SIZE - MARGIN);
    const nearRight = p.x >= maxX - DOCK_ZONE;
    const nearLeft = p.x <= MARGIN + DOCK_ZONE;
    dock = nearRight && !nearLeft ? 'right' : nearLeft && !nearRight ? 'left' : 'none';
    // the pill opens towards the middle of the screen
    const opensRight = dock === 'left' || (dock === 'none' && p.x + SIZE / 2 <= window.innerWidth / 2);
    el.wrap.classList.toggle('dock-left', dock === 'left');
    el.wrap.classList.toggle('dock-right', dock === 'right');
    el.wrap.classList.toggle('open-right', opensRight);
  }

  async function loadPos() {
    try {
      const key = location.hostname.replace(/^www\./, '');
      const res = await chrome.storage.local.get(POS_KEY);
      const map = (res && res[POS_KEY]) || {};
      pos = map[key] || null;
    } catch (e) {
      pos = null;
    }
  }

  function savePos() {
    try {
      const key = location.hostname.replace(/^www\./, '');
      chrome.storage.local.get(POS_KEY).then((res) => {
        const map = (res && res[POS_KEY]) || {};
        map[key] = pos;
        chrome.storage.local.set({ [POS_KEY]: map });
      });
    } catch (e) {
      /* storage unavailable — position just won't persist */
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function paint() {
    if (!el) return;
    const { wrap, status, btnOriginal, btnRetranslate, btnStop, bar } = el;
    wrap.classList.toggle('busy', state.active && state.status === 'translating');
    wrap.classList.toggle('on', state.active);
    wrap.classList.toggle('err', state.status === 'error');
    wrap.classList.toggle('done', state.status === 'done' && state.active);
    wrap.classList.toggle('idle', !state.active);

    let text;
    if (transient) text = transient;
    else if (state.status === 'error') {
      text = state.error
        ? tr(`出错：${state.error}`, 'ball.status.errorDetail', { error: state.error })
        : tr('翻译出错', 'ball.status.translationError');
    } else if (state.status === 'translating') {
      text = tr(`翻译中 ${state.done}/${state.total}`, 'ball.status.translatingProgress', {
        done: state.done,
        total: state.total,
      });
    } else if (state.status === 'scanning') {
      text = tr('正在扫描页面…', 'ball.status.scanning');
    } else if (state.active) {
      text = state.total
        ? tr(`已翻译 ${state.done}/${state.total}`, 'ball.status.translatedProgress', {
            done: state.done,
            total: state.total,
          })
        : tr('已开启', 'ball.status.active');
    } else {
      text = tr('翻译此页面', 'ball.action.start');
    }
    status.textContent = text;
    status.title = text;

    btnOriginal.hidden = !state.active;
    btnRetranslate.hidden = !state.active;
    btnStop.hidden = !state.active;
    // The label reflects what clicking will do, and matches the wording of the
    // extension panel's "暂时收起译文" switch for the same state. Deliberately
    // not "只显示原文" — that reads as a synonym of the video panel's 仅原文
    // display mode, which is a different thing (persistent, not a toggle).
    btnOriginal.textContent = state.showSource
      ? tr('恢复译文', 'ball.action.restore')
      : tr('暂时收起译文', 'ball.action.temporaryHide');

    // progress arc
    const R = 23.5;
    const C = 2 * Math.PI * R;
    let pct = 0;
    if (state.status === 'error') pct = 1;
    else if (state.total) pct = Math.min(1, state.done / state.total);
    else if (state.active) pct = 0.08;
    bar.setAttribute('stroke-dasharray', `${C}`);
    bar.setAttribute('stroke-dashoffset', `${C * (1 - pct)}`);
  }

  function mount(h) {
    if (h) handlers = h;
    if (host && host.isConnected) return;
    if (!document.body && !document.documentElement) return;

    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('translate', 'no');
    host.setAttribute('data-lingua-node', '1');
    host.style.position = 'fixed';
    host.style.width = `${SIZE}px`;
    host.style.height = `${SIZE}px`;
    host.style.zIndex = '2147483645';

    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="pill">
        <span class="status" role="status" aria-live="polite"></span>
        <button class="act" type="button" data-act="original">${tr('暂时收起译文', 'ball.action.temporaryHide')}</button>
        <button class="act" type="button" data-act="retranslate">${tr('重新翻译', 'ball.action.retranslate')}</button>
        <button class="act" type="button" data-act="stop">${tr('停止', 'ball.action.stop')}</button>
      </div>
      <div class="ball" role="button" tabindex="0" title="${tr('点击翻译 / 右键设置', 'ball.tooltipDetailed')}" aria-label="${tr('Lingua 网页翻译', 'ball.ariaLabel')}">
        <!-- no width/height here on purpose — the CSS box defines the size -->
        <svg class="ring" viewBox="0 0 50 50" aria-hidden="true">
          <circle class="track" cx="25" cy="25" r="23.5"></circle>
          <circle class="bar" cx="25" cy="25" r="23.5" stroke-dasharray="147.6" stroke-dashoffset="147.6"></circle>
        </svg>
        <span class="glyph"><span class="a">A</span>文</span>
        <span class="dot"></span>
      </div>`;
    shadow.appendChild(wrap);

    el = {
      wrap,
      status: wrap.querySelector('.status'),
      bar: wrap.querySelector('.ring .bar'),
      ball: wrap.querySelector('.ball'),
      btnOriginal: wrap.querySelector('[data-act="original"]'),
      btnRetranslate: wrap.querySelector('[data-act="retranslate"]'),
      btnStop: wrap.querySelector('[data-act="stop"]'),
    };

    // --- interactions ---
    const ball = el.ball;
    ball.addEventListener('pointerdown', onPointerDown);
    ball.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggle();
      }
    });
    wrap.addEventListener('click', (ev) => {
      const btn = ev.target.closest && ev.target.closest('button[data-act]');
      if (!btn) return;
      ev.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'original' && handlers.onToggleOriginal) handlers.onToggleOriginal();
      if (act === 'retranslate' && handlers.onRetranslate) handlers.onRetranslate();
      if (act === 'stop' && handlers.onStop) handlers.onStop();
    });
    wrap.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (handlers.onOpenSettings) handlers.onOpenSettings();
    });

    window.addEventListener('resize', applyPos);
    (document.body || document.documentElement).appendChild(host);

    loadPos().then(() => {
      applyPos();
      paint();
    });
    applyPos();
    paint();
    setVisible(visible);
  }

  function toggle() {
    if (handlers.onToggle) handlers.onToggle();
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    const start = { x: ev.clientX, y: ev.clientY };
    const origin = clampPos(pos || defaultPos());
    drag = { start, origin, moved: false };
    el.wrap.classList.add('dragging');
    try {
      el.ball.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* ignore */
    }
    el.ball.addEventListener('pointermove', onPointerMove);
    el.ball.addEventListener('pointerup', onPointerUp);
    el.ball.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(ev) {
    if (!drag) return;
    const dx = ev.clientX - drag.start.x;
    const dy = ev.clientY - drag.start.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) drag.moved = true;
    if (!drag.moved) return;
    pos = clampPos({ x: drag.origin.x + dx, y: drag.origin.y + dy });
    applyPos();
  }

  function onPointerUp() {
    if (!drag) return;
    el.ball.removeEventListener('pointermove', onPointerMove);
    el.ball.removeEventListener('pointerup', onPointerUp);
    el.ball.removeEventListener('pointercancel', onPointerUp);
    el.wrap.classList.remove('dragging');
    const moved = drag.moved;
    drag = null;
    if (moved) {
      // dock to whichever horizontal edge is closer
      const p = clampPos(pos);
      p.x = p.x + SIZE / 2 > window.innerWidth / 2 ? window.innerWidth - SIZE - MARGIN : MARGIN;
      pos = clampPos(p);
      applyPos();
      savePos();
    } else {
      toggle();
    }
  }

  function setVisible(on) {
    visible = !!on;
    if (host) host.style.display = visible ? '' : 'none';
  }

  function setStatus(next) {
    state = Object.assign({}, state, next || {});
    paint();
  }

  /**
   * Show a message in the pill for a moment. Deliberately NOT a floating toast —
   * a bubble hovering over the page was more noise than signal; the ball's own
   * colour and the pill text carry the state instead.
   */
  function notify(text, tone, durationMs) {
    if (!el) return;
    transient = text;
    paint();
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => {
      transient = null;
      paint();
    }, durationMs || 3000);
  }

  function destroy() {
    clearTimeout(labelTimer);
    window.removeEventListener('resize', applyPos);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
    el = null;
    drag = null;
    transient = null;
  }

  page.ball = { mount, destroy, setStatus, setVisible, notify, toggle };
})(typeof globalThis !== 'undefined' ? globalThis : self);
