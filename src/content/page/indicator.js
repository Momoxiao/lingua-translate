/**
 * Lingua — full-page translation: floating progress indicator.
 * Lives in a shadow root so no site stylesheet can reach it, and so our own
 * styles cannot leak into the page.
 * Registers onto YTST.page.indicator.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});
  const page = (NS.page = NS.page || {});

  const HOST_ID = 'lingua-page-indicator';
  let host = null;
  let shadow = null;
  let bar = null;
  let label = null;
  let hideTimer = 0;
  let handlers = {};

  const CSS = `
:host{ all:initial; }
.wrap{
  position:fixed; right:16px; bottom:16px; z-index:2147483646;
  font:500 12px/1.4 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"PingFang SC",sans-serif;
  color:#f6f1ea; background:rgba(22,19,15,.94);
  border:1px solid rgba(228,87,46,.5); border-radius:10px;
  padding:8px 10px 9px; min-width:172px;
  box-shadow:0 6px 22px rgba(0,0,0,.34);
  transition:opacity .22s ease, transform .22s ease;
  transform:translateY(0); opacity:1;
}
.wrap[hidden]{ display:none; }
.wrap.fade{ opacity:0; transform:translateY(6px); pointer-events:none; }
.row{ display:flex; align-items:center; justify-content:space-between; gap:10px; }
.name{ display:flex; align-items:center; gap:6px; letter-spacing:.02em; }
.dot{ width:6px; height:6px; border-radius:50%; background:#e4572e; }
.dot.idle{ background:#8b8177; }
.dot.err{ background:#e0705f; }
.pct{ font-variant-numeric:tabular-nums; opacity:.72; font-size:11px; }
.bar{ height:3px; border-radius:999px; background:rgba(255,255,255,.14); margin-top:7px; overflow:hidden; }
.fill{ height:100%; width:0; background:#e4572e; transition:width .26s ease; }
.actions{ display:flex; gap:4px; margin-top:8px; }
button{
  font:inherit; font-size:11px; color:#f6f1ea; background:rgba(255,255,255,.09);
  border:1px solid rgba(255,255,255,.14); border-radius:6px; padding:3px 8px; cursor:pointer;
}
button:hover{ background:rgba(255,255,255,.16); }
`;

  function mount() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('translate', 'no');
    host.setAttribute('data-lingua-node', '1');
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="row"><span class="name"><span class="dot"></span><span class="txt">Lingua</span></span>' +
      '<span class="pct"></span></div><div class="bar"><div class="fill"></div></div>' +
      '<div class="actions"><button data-act="toggle">显示原文</button><button data-act="stop">停止</button></div>';
    shadow.appendChild(wrap);

    label = wrap.querySelector('.txt');
    bar = wrap.querySelector('.fill');
    const pct = wrap.querySelector('.pct');
    const dot = wrap.querySelector('.dot');

    wrap.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'stop' && handlers.onStop) handlers.onStop();
      if (act === 'toggle' && handlers.onToggleOriginal) {
        const on = handlers.onToggleOriginal();
        btn.textContent = on ? '隐藏原文' : '显示原文';
      }
    });

    (document.body || document.documentElement).appendChild(host);
    host.__parts = { wrap, pct, dot };
  }

  function show(text, percent, tone) {
    mount();
    clearTimeout(hideTimer);
    const { wrap, pct, dot } = host.__parts;
    wrap.hidden = false;
    wrap.classList.remove('fade');
    label.textContent = text;
    pct.textContent = percent == null ? '' : `${percent}%`;
    bar.style.width = `${percent == null ? 0 : percent}%`;
    dot.className = 'dot' + (tone ? ' ' + tone : '');
  }

  function done(text) {
    show(text || '翻译完成', 100, 'idle');
    hideTimer = setTimeout(hide, 2200);
  }

  function fail(text) {
    show(text || '翻译失败', 100, 'err');
    hideTimer = setTimeout(hide, 6000);
  }

  function hide() {
    if (!host || !host.__parts) return;
    const { wrap } = host.__parts;
    wrap.classList.add('fade');
    hideTimer = setTimeout(() => {
      if (wrap) wrap.hidden = true;
    }, 260);
  }

  function destroy() {
    clearTimeout(hideTimer);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
    bar = null;
    label = null;
  }

  function setHandlers(h) {
    handlers = h || {};
  }

  page.indicator = { mount, show, done, fail, hide, destroy, setHandlers };
})(typeof globalThis !== 'undefined' ? globalThis : self);
