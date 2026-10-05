/**
 * Lingua — full-page translation: floating action ball.
 *
 * The always-available entry point. Before this existed the only way to
 * translate a page was the toolbar popup, which meant leaving the page.
 *
 * Behaviour
 *   - click        : translate / stop
 *   - hover        : expands a pill with the status and secondary actions
 *   - drag         : moves it; the position is remembered per hostname
 *   - progress     : an arc around the ball, no separate progress bar needed
 *
 * Lives in a shadow root so no site stylesheet can reach it, and it can never
 * leak styles into the page.
 *
 * Registers onto YTST.page.ball.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});
  const page = (NS.page = NS.page || {});

  const HOST_ID = 'lingua-ball';
  const POS_KEY = 'lingua:ball:positions';
  const SIZE = 44;
  const MARGIN = 12;
  const DRAG_SLOP = 5;

  let host = null;
  let shadow = null;
  let el = null; // cached refs
  let handlers = {};
  let pos = null; // {x, y} in viewport px, or null = default (right, vertically centred)
  let visible = true;
  let labelTimer = 0;
  let drag = null;
  let state = { active: false, status: 'idle', done: 0, total: 0, error: '' };

  const CSS = `
:host{ all:initial; }
*{ box-sizing:border-box; }

/* The wrap fills the host box. Everything else is absolutely positioned so
   expanding the pill never pushes the ball around the screen. */
.wrap{
  position:relative; width:100%; height:100%;
  font:500 12px/1.4 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"PingFang SC",sans-serif;
  user-select:none; -webkit-user-select:none;
  transition:opacity .18s ease;
}
.wrap[hidden]{ display:none; }

/* --- pill: opens towards the middle of the screen --- */
.pill{
  position:absolute; top:50%; right:calc(100% + 10px);
  transform:translateY(-50%) scale(.94);
  transform-origin:right center;
  display:flex; align-items:center; gap:2px;
  padding:5px 6px 5px 12px;
  background:rgba(22,19,15,.95);
  border:1px solid rgba(255,255,255,.10);
  border-radius:999px;
  box-shadow:0 8px 26px rgba(0,0,0,.30);
  color:#f6f1ea;
  opacity:0; pointer-events:none;
  transition:opacity .18s ease, transform .18s ease;
  white-space:nowrap;
}
.wrap.open-right .pill{
  right:auto; left:calc(100% + 10px);
  transform-origin:left center;
}
.wrap:hover .pill, .wrap.pinned .pill{
  opacity:1; pointer-events:auto; transform:translateY(-50%) scale(1);
}
.status{ font-size:11.5px; opacity:.82; padding-right:8px; letter-spacing:.01em; }
.act{
  font:inherit; font-size:11.5px; color:#f6f1ea;
  background:transparent; border:0; border-radius:999px;
  padding:5px 10px; cursor:pointer; white-space:nowrap;
}
.act:hover{ background:rgba(255,255,255,.13); }
.act[hidden]{ display:none; }

/* --- the ball itself --- */
.ball{
  position:relative; width:${SIZE}px; height:${SIZE}px;
  border-radius:50%; cursor:pointer;
  background:rgba(22,19,15,.94);
  border:1px solid rgba(255,255,255,.12);
  box-shadow:0 6px 22px rgba(0,0,0,.30);
  display:grid; place-items:center;
  transition:transform .16s ease, background .18s ease, border-color .18s ease;
  touch-action:none;
}
.ball:hover{ transform:scale(1.06); }
.wrap.dragging .ball{ transform:scale(1.10); cursor:grabbing; }
.wrap.busy .ball{ border-color:rgba(228,87,46,.55); }
.wrap.on .ball{ background:#e4572e; border-color:#e4572e; }
.wrap.err .ball{ background:#c0392b; border-color:#c0392b; }

.glyph{ display:flex; align-items:baseline; gap:1px; color:#f6f1ea; font-weight:700; font-size:13px; line-height:1; }
.glyph .a{ opacity:.62; font-size:11px; }
.wrap.on .glyph, .wrap.err .glyph{ color:#fff; }
.wrap.on .glyph .a, .wrap.err .glyph .a{ opacity:.75; }

/* progress ring drawn around the ball */
.ring{ position:absolute; inset:-3px; transform:rotate(-90deg); pointer-events:none; }
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

/* transient toast, anchored above the ball */
.toast{
  position:absolute; right:0; bottom:calc(100% + 10px);
  max-width:330px; padding:8px 12px;
  background:rgba(22,19,15,.96); color:#f6f1ea;
  border:1px solid rgba(255,255,255,.12); border-left:3px solid #e4572e;
  border-radius:9px;
  box-shadow:0 8px 26px rgba(0,0,0,.30);
  opacity:0; transform:translateY(6px); pointer-events:none;
  transition:opacity .2s ease, transform .2s ease;
  white-space:normal;
}
.wrap.open-right .toast{ right:auto; left:0; }
.toast.show{ opacity:1; transform:translateY(0); }
.toast.err{ border-left-color:#e0705f; }
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
    // The pill opens towards the middle of the screen so it never runs off-edge.
    const opensRight = p.x + SIZE / 2 < window.innerWidth / 2;
    el.wrap.classList.toggle('open-right', opensRight);
  }

  async function loadPos() {
    try {
      const host_ = location.hostname.replace(/^www\./, '');
      const res = await chrome.storage.local.get(POS_KEY);
      const map = (res && res[POS_KEY]) || {};
      pos = map[host_] || null;
    } catch (e) {
      pos = null;
    }
  }

  function savePos() {
    try {
      const host_ = location.hostname.replace(/^www\./, '');
      chrome.storage.local.get(POS_KEY).then((res) => {
        const map = (res && res[POS_KEY]) || {};
        map[host_] = pos;
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

    let text = '';
    if (state.status === 'error') text = state.error ? `出错：${state.error}` : '翻译出错';
    else if (state.status === 'translating') text = `翻译中 ${state.done}/${state.total}`;
    else if (state.status === 'scanning') text = '正在扫描页面…';
    else if (state.active) text = state.total ? `已翻译 ${state.done}/${state.total}` : '已开启';
    else text = '翻译此页面';
    status.textContent = text;

    btnOriginal.hidden = !state.active;
    btnRetranslate.hidden = !state.active;
    btnStop.hidden = !state.active;

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
    // The host IS the positioned box; the shadow content fills it. (Making the
    // inner element position:fixed instead leaves the host 0x0, so hit-testing
    // and getBoundingClientRect disagree with where the ball actually is.)
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
        <span class="status"></span>
        <button class="act" data-act="original">显示原文</button>
        <button class="act" data-act="retranslate">重新翻译</button>
        <button class="act" data-act="stop">关闭</button>
      </div>
      <div class="ball" role="button" tabindex="0" aria-label="Lingua 网页翻译">
        <svg class="ring" viewBox="0 0 50 50" width="50" height="50" aria-hidden="true">
          <circle class="track" cx="25" cy="25" r="23.5"></circle>
          <circle class="bar" cx="25" cy="25" r="23.5" stroke-dasharray="147.6" stroke-dashoffset="147.6"></circle>
        </svg>
        <span class="glyph"><span class="a">A</span>文</span>
        <span class="dot"></span>
      </div>
      <div class="toast"></div>`;
    shadow.appendChild(wrap);

    el = {
      wrap,
      toast: wrap.querySelector('.toast'),
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
      if (act === 'original' && handlers.onToggleOriginal) {
        const on = handlers.onToggleOriginal();
        btn.textContent = on ? '隐藏原文' : '显示原文';
      }
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

  function onPointerUp(ev) {
    if (!drag) return;
    el.ball.removeEventListener('pointermove', onPointerMove);
    el.ball.removeEventListener('pointerup', onPointerUp);
    el.ball.removeEventListener('pointercancel', onPointerUp);
    el.wrap.classList.remove('dragging');
    const moved = drag.moved;
    drag = null;
    if (moved) {
      // snap to whichever horizontal edge is closer
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

  function notify(text, tone, durationMs) {
    if (!host || !el) return;
    el.toast.textContent = text;
    el.toast.classList.toggle('err', tone === 'err');
    el.toast.classList.add('show');
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => el.toast.classList.remove('show'), durationMs || 4000);
  }

  function destroy() {
    clearTimeout(labelTimer);
    window.removeEventListener('resize', applyPos);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
    el = null;
    drag = null;
  }

  page.ball = { mount, destroy, setStatus, setVisible, notify, toggle };
})(typeof globalThis !== 'undefined' ? globalThis : self);
