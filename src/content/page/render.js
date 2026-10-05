/**
 * Lingua — full-page translation: rendering.
 *
 * Strategy: never destroy the original DOM. Every translated unit gets a
 * sibling <span class="lingua-pg-dst"> holding the translation.
 *   - bilingual mode: original stays visible, translation is appended below
 *   - replace mode:   the original children are wrapped into
 *                     <span class="lingua-pg-src"> and hidden with CSS, so the
 *                     "show original" toggle is a pure class flip (no DOM churn)
 *
 * Colours are derived from `currentColor`, so translated text stays readable on
 * any site theme (light, dark, or a custom one) without us knowing the palette.
 *
 * Registers onto YTST.page.render.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});
  const page = (NS.page = NS.page || {});

  const STYLE_ID = 'lingua-page-style';
  const SRC_CLASS = 'lingua-pg-src';
  const DST_CLASS = 'lingua-pg-dst';
  const ROOT_FLAG = 'lingua-pg-show-src';

  const CSS = `
.lingua-pg-dst{
  display:block; margin:.22em 0 0; padding-left:.55em;
  border-left:2px solid color-mix(in srgb, currentColor 38%, transparent);
  font-size:.95em; line-height:1.55; opacity:.95;
  white-space:normal; text-align:inherit; text-transform:none; letter-spacing:inherit;
}
.lingua-pg-dst.lingua-pg-inline{
  display:inline; margin:0 0 0 .35em; padding:0 0 0 .35em;
}
.lingua-pg-dst.lingua-pg-plain{ border-left:0; padding-left:0; margin-left:0; }
.lingua-pg-dst.lingua-pg-highlight{
  border-left:0; padding:.06em .38em; margin-left:0; border-radius:3px;
  background:color-mix(in srgb, currentColor 10%, transparent);
}
.lingua-pg-replace > .lingua-pg-src{ display:none; }
html.${ROOT_FLAG} .lingua-pg-replace > .lingua-pg-src{ display:revert; }
`;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function styleClass(styleName) {
    if (styleName === 'plain') return ' lingua-pg-plain';
    if (styleName === 'highlight') return ' lingua-pg-highlight';
    return '';
  }

  /** Create or reuse the translation node for a text unit. */
  function ensureDst(el, unit) {
    let dst = null;
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      if (kids[i].classList && kids[i].classList.contains(DST_CLASS)) {
        dst = kids[i];
        break;
      }
    }
    if (dst) return dst;

    dst = document.createElement('span');
    dst.className = DST_CLASS;
    dst.setAttribute('translate', 'no');
    dst.setAttribute('data-lingua-node', '1');
    if (unit && unit.inline) dst.classList.add('lingua-pg-inline');
    el.appendChild(dst);
    return dst;
  }

  /** Wrap the original children so they can be hidden without losing them. */
  function ensureSrc(el, dst) {
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].classList && kids[i].classList.contains(SRC_CLASS)) return kids[i];
    }
    const wrap = document.createElement('span');
    wrap.className = SRC_CLASS;
    wrap.setAttribute('translate', 'no');
    wrap.setAttribute('data-lingua-node', '1');
    const nodes = Array.prototype.slice.call(el.childNodes);
    for (const n of nodes) {
      if (n === dst) continue;
      wrap.appendChild(n);
    }
    el.insertBefore(wrap, el.firstChild);
    return wrap;
  }

  /**
   * @param {object} unit   from units.collect()
   * @param {string} text   translated text
   * @param {{mode:string,style:string}} opts
   */
  function apply(unit, text, opts) {
    if (!unit || !unit.el || !unit.el.isConnected) return;
    const mode = (opts && opts.mode) || 'bilingual';
    const style = (opts && opts.style) || 'underline';

    if (unit.type === 'attr') {
      const el = unit.el;
      const origKey = `data-lingua-orig-${unit.attr}`;
      const trKey = `data-lingua-tr-${unit.attr}`;
      if (!el.getAttribute(origKey)) el.setAttribute(origKey, unit.text);
      el.setAttribute(trKey, text);
      el.setAttribute(unit.attr, text);
      if (el.dataset) el.dataset.linguaAttr = '1';
      return;
    }

    const el = unit.el;
    let dst = ensureDst(el, unit);
    if (mode === 'replace') ensureSrc(el, dst);
    el.classList.toggle('lingua-pg-replace', mode === 'replace');

    dst.className = DST_CLASS + (unit.inline ? ' lingua-pg-inline' : '') + styleClass(style);
    if (dst.textContent !== text) dst.textContent = text;
    if (el.dataset) el.dataset.lingua = 'done';
  }

  /** Mark a unit as in-flight so a re-scan does not queue it twice. */
  function markPending(unit) {
    if (!unit || !unit.el) return;
    if (unit.type === 'attr') {
      if (unit.el.dataset) unit.el.dataset.linguaAttr = 'pending';
      return;
    }
    if (unit.el.dataset) unit.el.dataset.lingua = 'pending';
  }

  function unmark(unit) {
    if (!unit || !unit.el || !unit.el.dataset) return;
    if (unit.type === 'attr') delete unit.el.dataset.linguaAttr;
    else delete unit.el.dataset.lingua;
  }

  /** Re-style every already-rendered node (used when settings change). */
  function restyle(opts) {
    const mode = (opts && opts.mode) || 'bilingual';
    const style = (opts && opts.style) || 'underline';
    const nodes = document.querySelectorAll('.' + DST_CLASS);
    for (const node of nodes) {
      const inline = node.classList.contains('lingua-pg-inline');
      node.className = DST_CLASS + (inline ? ' lingua-pg-inline' : '') + styleClass(style);
      const parent = node.parentElement;
      if (parent) parent.classList.toggle('lingua-pg-replace', mode === 'replace');
    }
    if (mode === 'replace') {
      // Make sure every replace-mode unit has its source wrapper.
      for (const parent of document.querySelectorAll('.lingua-pg-replace')) {
        const dst = parent.querySelector(':scope > .' + DST_CLASS);
        if (dst && !parent.querySelector(':scope > .' + SRC_CLASS)) ensureSrc(parent, dst);
      }
    }
  }

  function setShowOriginal(on) {
    document.documentElement.classList.toggle(ROOT_FLAG, !!on);
    // Attribute units have no room for two values — swap the whole attribute.
    const nodes = document.querySelectorAll('[data-lingua-attr]');
    for (const el of nodes) {
      for (const attr of page.units.ATTRS) {
        const orig = el.getAttribute(`data-lingua-orig-${attr}`);
        if (orig == null) continue;
        const tr = el.getAttribute(`data-lingua-tr-${attr}`);
        if (on) el.setAttribute(attr, orig);
        else if (tr != null) el.setAttribute(attr, tr);
      }
    }
  }

  /** Remove everything we injected and restore the page. */
  function removeAll() {
    for (const node of document.querySelectorAll('.' + DST_CLASS)) node.remove();

    for (const wrap of document.querySelectorAll('.' + SRC_CLASS)) {
      const parent = wrap.parentElement;
      if (!parent) continue;
      while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
      wrap.remove();
    }

    for (const el of document.querySelectorAll('[data-lingua]')) {
      delete el.dataset.lingua;
      el.classList.remove('lingua-pg-replace');
    }

    for (const el of document.querySelectorAll('[data-lingua-attr]')) {
      delete el.dataset.linguaAttr;
      for (const attr of page.units.ATTRS) {
        const origKey = `data-lingua-orig-${attr}`;
        const trKey = `data-lingua-tr-${attr}`;
        const orig = el.getAttribute(origKey);
        if (orig != null) {
          el.setAttribute(attr, orig);
          el.removeAttribute(origKey);
        }
        el.removeAttribute(trKey);
      }
    }

    document.documentElement.classList.remove(ROOT_FLAG);
  }

  page.render = { ensureStyle, apply, markPending, unmark, restyle, setShowOriginal, removeAll, DST_CLASS, SRC_CLASS };
})(typeof globalThis !== 'undefined' ? globalThis : self);
