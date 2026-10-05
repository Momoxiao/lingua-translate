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
 * Two special cases:
 *   - `unit.wrap`: the unit is a flex/grid container whose own text nodes are
 *     the target. Only those text nodes get wrapped, so the layout is untouched.
 *   - `unit.hasLink`: replace mode would hide the hyperlink along with the text,
 *     so such units always keep their source visible.
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
  const TEXTWRAP_CLASS = 'lingua-pg-textwrap';
  const ROOT_FLAG = 'lingua-pg-show-src';
  const LINK_MARK = 'linguaLink';
  const LINK_OK = 'linguaLinkKept';
  const MOVED_ATTR = 'data-lingua-moved';

  /** Links we relocated into a translation, so they can be put back exactly. */
  const movedLinks = new WeakMap();

  const MARK_RE = /⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/g;
  /**
   * Tolerant cleanup for placeholder residue. Models occasionally emit a mangled
   * marker (observed in the wild: `⟦1⟧X⟦/1⟧` came back as `X⟧/1⟧`, losing the
   * opening bracket). A strict pattern would leave that on screen, so match any
   * bracket run that still looks like a marker.
   */
  const MARK_ANY_RE = /⟦\s*\/?\s*\d*\s*⟧?|⟧\s*\/?\s*\d*\s*⟧?|\/\s*\d+\s*⟧/g;

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

  function createDst(unit) {
    const dst = document.createElement('span');
    dst.className = DST_CLASS;
    dst.setAttribute('translate', 'no');
    dst.setAttribute('data-lingua-node', '1');
    if (unit && unit.inline) dst.classList.add('lingua-pg-inline');
    return dst;
  }

  /** The dst that is a direct child of `host`, if any. */
  function directDst(host) {
    const kids = host.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      if (kids[i].classList && kids[i].classList.contains(DST_CLASS)) return kids[i];
    }
    return null;
  }

  function directSrc(el) {
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].classList && kids[i].classList.contains(SRC_CLASS)) return kids[i];
    }
    return null;
  }

  /**
   * Wrap ONLY the element's own text nodes into an inline span. This is
   * layout-neutral inside a flex/grid container: the span simply takes the place
   * of the anonymous flex item that used to hold the text.
   */
  function ensureTextWrap(el) {
    const existing = directSrc(el);
    if (existing) return existing;
    const nodes = [];
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) nodes.push(n);
    }
    if (!nodes.length) return null;
    const wrap = document.createElement('span');
    wrap.className = SRC_CLASS + ' ' + TEXTWRAP_CLASS;
    wrap.setAttribute('translate', 'no');
    wrap.setAttribute('data-lingua-node', '1');
    el.insertBefore(wrap, nodes[0]);
    for (const n of nodes) wrap.appendChild(n);
    return wrap;
  }

  /** Wrap every child except the translation, so the source can be hidden. */
  function ensureSrc(el, dst) {
    const existing = directSrc(el);
    if (existing) return existing;
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

  /** Walk up from a dst node to the element the unit belongs to. */
  function unitElementOf(dst) {
    const parent = dst.parentElement;
    if (!parent) return null;
    if (parent.classList.contains(SRC_CLASS)) return parent.parentElement;
    return parent;
  }

  /** Remove any leftover placeholders (used for bilingual display and safety). */
  function stripMarks(text) {
    return String(text || '').replace(MARK_ANY_RE, '');
  }

  /**
   * Split a translated block back into text runs and link runs using the
   * placeholders the scanner inserted. Returns null when the model dropped,
   * duplicated or renumbered a marker — the caller then keeps the original
   * visible instead of silently losing the links.
   *
   * @returns {Array<{type:'text'|'link', value:string, index?:number}>|null}
   */
  function parseMarked(text, expected) {
    const src = String(text || '');
    if (!expected) return null;
    const parts = [];
    const seen = new Set();
    let last = 0;
    let m;
    MARK_RE.lastIndex = 0;
    while ((m = MARK_RE.exec(src))) {
      const idx = Number(m[1]);
      if (!(idx >= 1 && idx <= expected) || seen.has(idx)) return null;
      seen.add(idx);
      if (m.index > last) parts.push({ type: 'text', value: src.slice(last, m.index) });
      parts.push({ type: 'link', index: idx, value: m[2] });
      last = m.index + m[0].length;
    }
    if (last < src.length) parts.push({ type: 'text', value: src.slice(last) });
    if (seen.size !== expected) return null;
    return parts;
  }

  /** Rebuild the translated block, reusing the REAL links so they stay live. */
  function buildMarked(parts, marks) {
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      if (p.type === 'text') {
        const value = stripMarks(p.value);
        if (value.trim()) frag.appendChild(document.createTextNode(value));
        continue;
      }
      const src = marks[p.index - 1];
      if (src) frag.appendChild(takeLink(src, stripMarks(p.value)));
    }
    return frag;
  }

  /**
   * Move a real link into the translation instead of cloning it.
   *
   * `cloneNode()` copies attributes but NOT event listeners, which silently kills
   * everything attached to the element: Wikipedia's hover previews, SPA routers,
   * analytics handlers. Moving the original keeps all of it working. The original
   * position and text are recorded so `restoreMovedLinks()` can undo it exactly.
   */
  function takeLink(src, value) {
    if (!movedLinks.has(src)) {
      const nodes = collectTextNodes(src);
      movedLinks.set(src, {
        parent: src.parentElement,
        next: src.nextSibling,
        texts: nodes.map((n) => n.nodeValue),
        addedTextNode: nodes.length === 0,
      });
    }
    setLinkText(src, value);
    src.setAttribute(MOVED_ATTR, '1');
    return src;
  }

  function collectTextNodes(root) {
    const out = [];
    (function walk(node) {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 3) out.push(kids[i]);
        else if (kids[i].nodeType === 1) walk(kids[i]);
      }
    })(root);
    return out;
  }

  /**
   * Replace an element's visible text without touching nested markup.
   *
   * When the text is unchanged (citation markers like `[7]`, numbers, code) this
   * does nothing at all — the internal structure and every listener stay exactly
   * as the page built them.
   */
  function setLinkText(a, value) {
    if ((a.textContent || '') === value) return;
    const nodes = collectTextNodes(a);
    if (!nodes.length) {
      a.appendChild(document.createTextNode(value));
      return;
    }
    nodes[0].nodeValue = value;
    for (let i = 1; i < nodes.length; i++) nodes[i].nodeValue = '';
  }

  /** Put every moved link back where it came from, with its original text. */
  function restoreMovedLinks(root) {
    const links = (root || document).querySelectorAll(`[${MOVED_ATTR}]`);
    for (const a of links) {
      a.removeAttribute(MOVED_ATTR);
      const rec = movedLinks.get(a);
      if (!rec) continue;
      movedLinks.delete(a);

      const nodes = collectTextNodes(a);
      if (rec.addedTextNode) {
        if (nodes.length) nodes[0].remove();
      } else {
        for (let i = 0; i < nodes.length && i < rec.texts.length; i++) nodes[i].nodeValue = rec.texts[i];
      }

      if (rec.parent && rec.parent.isConnected) {
        if (rec.next && rec.next.parentElement === rec.parent) rec.parent.insertBefore(a, rec.next);
        else rec.parent.appendChild(a);
      }
    }
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
    const linkMode = (opts && opts.linkMode) || 'translate';
    const showOriginal = !!(opts && opts.showOriginal);

    // Decide whether the source can be hidden. "Show original" always means both
    // copies are on screen, which is exactly bilingual rendering.
    let replacing = mode === 'replace' && !showOriginal;
    let parts = null;
    if (replacing && unit.hasLink) {
      if (linkMode === 'keep') {
        replacing = false; // keep the original so its links stay usable
      } else if (linkMode === 'translate') {
        // Rebuild the translation with its own links; if the model broke the
        // placeholders we cannot, so fall back to keeping the original.
        parts = unit.marks && unit.marks.length ? parseMarked(text, unit.marks.length) : null;
        if (!parts) replacing = false;
      }
      // linkMode === 'strict': replace and accept that the links are lost
    }

    const host = unit.wrap ? ensureTextWrap(el) : el;
    if (!host) return;

    let dst = directDst(host);
    if (dst) {
      // A previous render may have relocated real links into this translation.
      // Put them back before rebuilding, otherwise they would be stranded.
      restoreMovedLinks(dst);
    } else {
      dst = createDst(unit);
      host.appendChild(dst);
    }
    if (!unit.wrap && replacing) ensureSrc(el, dst);

    el.classList.toggle('lingua-pg-replace', replacing);
    if (unit.hasLink && el.dataset) {
      el.dataset[LINK_MARK] = '1';
      if (parts) el.dataset[LINK_OK] = '1';
      else delete el.dataset[LINK_OK];
    }

    dst.className = DST_CLASS + (unit.inline ? ' lingua-pg-inline' : '') + styleClass(style);
    if (parts) {
      dst.textContent = '';
      dst.appendChild(buildMarked(parts, unit.marks));
    } else {
      const plain = stripMarks(text);
      if (dst.textContent !== plain) dst.textContent = plain;
    }
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
    const linkMode = (opts && opts.linkMode) || 'translate';
    const showOriginal = !!(opts && opts.showOriginal);

    for (const node of document.querySelectorAll('.' + DST_CLASS)) {
      const inline = node.classList.contains('lingua-pg-inline');
      node.className = DST_CLASS + (inline ? ' lingua-pg-inline' : '') + styleClass(style);
      const el = unitElementOf(node);
      if (!el) continue;
      // A linked unit may only be hidden when the translation itself carries the
      // links (or the user asked for strict replacement).
      const linked = el.dataset && el.dataset[LINK_MARK] === '1';
      const keptLinks = el.dataset && el.dataset[LINK_OK] === '1';
      const canHide = !linked || linkMode === 'strict' || (linkMode === 'translate' && keptLinks);
      el.classList.toggle('lingua-pg-replace', mode === 'replace' && !showOriginal && canHide);
    }

    if (mode === 'replace') {
      // Make sure every replace-mode unit has its source wrapper.
      for (const el of document.querySelectorAll('.lingua-pg-replace')) {
        const dst = directDst(el);
        if (dst && !directSrc(el)) ensureSrc(el, dst);
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
    // Put relocated links back BEFORE the translations holding them disappear.
    restoreMovedLinks(document);

    for (const node of document.querySelectorAll('.' + DST_CLASS)) node.remove();

    for (const wrap of document.querySelectorAll('.' + SRC_CLASS)) {
      const parent = wrap.parentElement;
      if (!parent) continue;
      while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
      wrap.remove();
    }

    for (const el of document.querySelectorAll('[data-lingua]')) {
      delete el.dataset.lingua;
      delete el.dataset[LINK_MARK];
      delete el.dataset[LINK_OK];
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

  page.render = {
    ensureStyle,
    apply,
    markPending,
    unmark,
    restyle,
    setShowOriginal,
    removeAll,
    DST_CLASS,
    SRC_CLASS,
    TEXTWRAP_CLASS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
