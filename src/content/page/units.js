/**
 * Lingua — full-page translation: DOM unit discovery.
 *
 * A "unit" is the smallest element that holds a self-contained run of text.
 * The rule that makes this safe on real sites:
 *
 *   an element is a unit  <=>  its subtree contains NO block-level element
 *                              AND it is not a layout-critical container
 *                              (flex / grid / display:contents)
 *
 * That naturally handles the two hard cases:
 *   <p>Hello <b>world</b> today</p>       -> one unit ("Hello world today")
 *   <div class="flex"><span>a</span></div> -> the flex div is rejected, its
 *                                             inline children become units,
 *                                             so the flex layout is untouched.
 *
 * Registers onto YTST.page.units.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});
  const page = (NS.page = NS.page || {});

  /** Elements whose content must never be touched (or traversed). */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE',
    'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'CANVAS', 'MAP', 'AREA',
    'SVG', 'MATH', 'VIDEO', 'AUDIO', 'TRACK', 'SOURCE', 'PICTURE',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'INPUT', 'SELECT', 'DATALIST',
    'OUTPUT', 'PROGRESS', 'METER', 'SLOT',
  ]);

  /**
   * Tags that act as block boundaries. If an element's subtree contains any of
   * these, the element itself is a container rather than a text unit.
   */
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD', 'DETAILS',
    'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'HTML', 'LEGEND',
    'LI', 'MAIN', 'NAV', 'OL', 'P', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD',
    'TFOOT', 'TH', 'THEAD', 'TR', 'UL', 'COLGROUP', 'OPTGROUP', 'OPTION', 'MENU',
    'DETAILS', 'SEARCH', 'DIALOG',
    // Skipped, but they still separate content from their siblings.
    'PRE', 'TEXTAREA', 'SELECT', 'IFRAME', 'OBJECT', 'EMBED',
  ]);

  /**
   * Structural containers that must NEVER be a translation unit themselves,
   * even when their subtree happens to contain no block-level element.
   * Without this, `<nav><a>Home</a><a>About</a></nav>` collapses into one
   * merged "Home About" unit and the navigation renders wrong.
   */
  const STRUCTURAL = new Set([
    'NAV', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'SECTION', 'ARTICLE', 'MENU',
    'FORM', 'FIELDSET', 'FIGURE', 'DETAILS', 'DIALOG', 'HGROUP', 'SEARCH',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP', 'UL', 'OL', 'DL',
    'SELECT', 'OPTGROUP',
  ]);

  /** Wrapping or appending inside these would reflow the page. */
  const LAYOUT_CRITICAL = /^(flex|inline-flex|grid|inline-grid|contents|table|ruby)$/;

  /** Attributes worth translating when the user opts in. */
  const ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];

  const MAX_UNIT_CHARS = 3000;
  const MIN_UNIT_CHARS = 2;

  /** Any letter in any script — digits/symbols alone are not worth a request. */
  const HAS_LETTER = /\p{L}/u;

  let extraSkipCache = { raw: null, list: [] };

  function compileSkip(raw) {
    if (extraSkipCache.raw === raw) return extraSkipCache.list;
    const list = String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const compiled = [];
    for (const sel of list) {
      try {
        compiled.push(sel);
      } catch (e) {
        /* ignore malformed selectors */
      }
    }
    extraSkipCache = { raw, list: compiled };
    return compiled;
  }

  function classNameOf(el) {
    const c = el.className;
    return typeof c === 'string' ? c : '';
  }

  function shouldSkip(el, extraSkip) {
    if (SKIP_TAGS.has(el.tagName)) return true;

    // Our own injected nodes (overlay, page translation spans).
    if (classNameOf(el).indexOf('lingua-') !== -1) return true;

    // Already queued or translated.
    if (el.dataset && el.dataset.lingua) return true;

    if (el.getAttribute('translate') === 'no') return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.isContentEditable) return true;

    for (let i = 0; i < extraSkip.length; i++) {
      try {
        if (el.matches(extraSkip[i])) return true;
      } catch (e) {
        /* ignore */
      }
    }
    return false;
  }

  /**
   * Bottom-up pass: which elements contain a block-level descendant?
   * A descendant counts as a boundary if its tag is a block tag, if it already
   * contains one, or if it is an inline tag rendered as a block.
   */
  function markContainers(root, display) {
    const containers = new WeakSet();
    (function dfs(el) {
      let has = false;
      // Inside a flex/grid container every child is blockified by CSS (an inline
      // <span> computes to `display:block` once it becomes a flex item). That is
      // the parent's doing, not the child's authoring, so the computed display
      // must NOT be used to decide whether the child separates content —
      // otherwise the container is wrongly treated as a container itself and its
      // own text run is skipped.
      const parentIsFlex = /^(inline-)?(flex|grid)$/.test(display(el));
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (SKIP_TAGS.has(c.tagName)) {
          // A skipped child still separates content when it is block-level
          // (<pre>, <textarea>), but an inline skipped node must NOT break the
          // parent's text run — `<button>Platform<svg/></button>` is the classic
          // case.
          if (BLOCK_TAGS.has(c.tagName) || (!parentIsFlex && BLOCK_LIKE.test(display(c)))) has = true;
          continue;
        }
        dfs(c);
        if (BLOCK_TAGS.has(c.tagName) || containers.has(c) || (!parentIsFlex && BLOCK_LIKE.test(display(c)))) has = true;
      }
      if (has) containers.add(el);
    })(root);
    return containers;
  }

  /** Visible text of a subtree, with skip-tags excluded and whitespace collapsed. */
  function textOf(el) {
    let out = '';
    (function dfs(node) {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (n.nodeType === 3) {
          out += n.nodeValue + ' ';
        } else if (n.nodeType === 1) {
          const tag = n.tagName;
          if (SKIP_TAGS.has(tag)) continue;
          if (classNameOf(n).indexOf('lingua-') !== -1) continue;
          if (tag === 'BR') {
            out += ' ';
            continue;
          }
          dfs(n);
        }
      }
    })(el);
    return out.replace(/\s+/g, ' ').trim();
  }

  function isTranslatable(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < MIN_UNIT_CHARS || t.length > MAX_UNIT_CHARS) return false;
    if (!HAS_LETTER.test(t)) return false;
    // A single repeated character (e.g. "----") is noise.
    if (t.length < 6 && !HAS_LETTER.test(t.replace(/[^\p{L}]/gu, ''))) return false;
    return true;
  }

  /**
   * @param {Element} root
   * @param {{skipSelectors?:string}} [opts]
   * @returns {Array<{type:string,el:Element,text:string,display?:string,top?:number,attr?:string}>}
   */
  function collect(root, opts) {
    const out = [];
    if (!root || root.nodeType !== 1) return out;
    const extraSkip = compileSkip(opts && opts.skipSelectors);
    const containers = markContainers(root, makeDisplayLookup());
    const scrollY = window.scrollY || window.pageYOffset || 0;

    (function walk(el, depth) {
      if (depth > 80) return;
      if (shouldSkip(el, extraSkip)) return;

      const structural = STRUCTURAL.has(el.tagName);
      if (!containers.has(el) && (!structural || !hasDescendableChild(el))) {
        const text = textOf(el);
        if (isTranslatable(text)) {
          let cs = null;
          try {
            cs = getComputedStyle(el);
          } catch (e) {
            cs = null;
          }
          if (cs && cs.display !== 'none' && cs.visibility !== 'hidden') {
            if (!LAYOUT_CRITICAL.test(cs.display)) {
              out.push({
                type: 'text',
                el,
                text,
                display: cs.display,
                inline: cs.display.indexOf('inline') === 0,
                hasLink: hasLinkChild(el),
                top: rectTop(el, scrollY),
              });
              return;
            }
            // A flex/grid container cannot host an appended block, but it very
            // often holds its own text: <button>Platform<svg/></button> is the
            // canonical case (GitHub's nav). Wrapping ONLY those direct text
            // nodes in an inline span is layout-neutral — the span takes the
            // place of the anonymous flex item that held the text — so the
            // container's own text is translatable after all.
            const direct = directText(el);
            if (isTranslatable(direct)) {
              out.push({
                type: 'text',
                el,
                text: direct,
                display: cs.display,
                inline: true,
                wrap: true,
                top: rectTop(el, scrollY),
              });
              // keep descending: inline children may be units of their own
            }
          }
        }
      }
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    })(root, 0);

    return out;
  }

  /** Text that belongs to this element directly, not to its descendants. */
  function directText(el) {
    let out = '';
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 3) out += kids[i].nodeValue + ' ';
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  /** Does this unit contain a real hyperlink? Hiding it would break navigation. */
  function hasLinkChild(el) {
    if (!el.children.length) return false;
    try {
      return !!el.querySelector('a[href]');
    } catch (e) {
      return false;
    }
  }

  /** Elements that carry no translatable text of their own. */
  const VOIDISH = new Set(['IMG', 'BR', 'HR', 'WBR', 'SOURCE', 'TRACK', 'INPUT', 'AREA', 'COL']);

  /**
   * Computed displays that behave like a block boundary even on an inline tag.
   * `<div class="card"><b style="display:block">Title</b><span>Body</span></div>`
   * must produce two units, not one merged "Title Body" line — card layouts
   * built from styled inline tags are everywhere in the wild.
   */
  const BLOCK_LIKE = /^(block|flow-root|list-item|table|table-row|table-cell|table-caption|table-header-group|table-footer-group|flex|grid|inline-flex|inline-grid)$/;

  function makeDisplayLookup() {
    const cache = new WeakMap();
    return (el) => {
      let d = cache.get(el);
      if (d === undefined) {
        try {
          d = getComputedStyle(el).display;
        } catch (e) {
          d = 'inline';
        }
        cache.set(el, d);
      }
      return d;
    };
  }

  /**
   * Does this element have a child we would descend into? A structural
   * container with nothing to descend into must still be translatable —
   * otherwise `<footer>plain text</footer>` silently loses its text.
   */
  function hasDescendableChild(el) {
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      if (!VOIDISH.has(kids[i].tagName)) return true;
    }
    return false;
  }

  function rectTop(el, scrollY) {
    try {
      return el.getBoundingClientRect().top + scrollY;
    } catch (e) {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  /**
   * Attribute units (placeholder / title / alt / aria-label). Cheap and
   * independent from the text walk.
   */
  function collectAttributes(root, opts) {
    const out = [];
    if (!root || root.nodeType !== 1) return out;
    const extraSkip = compileSkip(opts && opts.skipSelectors);
    const scrollY = window.scrollY || window.pageYOffset || 0;

    const nodes = root.querySelectorAll('[placeholder],[title],[alt],[aria-label]');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (shouldSkip(el, extraSkip)) continue;
      if (el.dataset && el.dataset.linguaAttr) continue;
      for (const attr of ATTRS) {
        const val = el.getAttribute(attr);
        if (!val || !isTranslatable(val)) continue;
        out.push({ type: 'attr', el, attr, text: val.trim(), top: rectTop(el, scrollY) });
        break; // one attribute per element per pass is enough
      }
    }
    return out;
  }

  /** Recompute document positions (used after scroll / layout changes). */
  function refreshPositions(units) {
    const scrollY = window.scrollY || window.pageYOffset || 0;
    for (const u of units) {
      if (u.el && u.el.isConnected) u.top = rectTop(u.el, scrollY);
    }
  }

  page.units = {
    collect,
    collectAttributes,
    refreshPositions,
    isTranslatable,
    textOf,
    SKIP_TAGS,
    BLOCK_TAGS,
    STRUCTURAL,
    ATTRS,
    MAX_UNIT_CHARS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
