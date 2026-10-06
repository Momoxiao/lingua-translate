/**
 * Lingua — adaptive translation profile detection.
 *
 * Picks which "translation expert" should handle this page. A human translator
 * does not apply one style everywhere: a Rust reference manual, a news report
 * and a Reddit thread want different registers, different terminology rules and
 * different things left untranslated. This module infers that from the page
 * itself so the user does not have to configure it per site.
 *
 * Two halves, deliberately split:
 *   collectSignals()  reads the DOM (impure, browser only)
 *   score(signals)    pure function: signals -> score per profile
 * The split is what makes the decision testable without a browser.
 *
 * Only the chosen id is sent to the background; the directives live in
 * constants.js, so a page can never inject prompt text.
 *
 * Registers onto Lingua.page.profile.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const page = (NS.page = NS.page || {});
  const { PAGE_PROFILES } = NS.constants;

  /** Profiles that compete on evidence; `general` is the fallback, not a peer. */
  const CANDIDATES = ['tech', 'academic', 'news', 'forum', 'commerce'];

  /**
   * Minimum score before we override the neutral profile. Below it the evidence
   * is too thin to justify changing how the page is translated — a stray <pre>
   * on a blog post should not turn it into API documentation.
   */
  const CONFIDENCE_THRESHOLD = 4;

  // ---------------------------------------------------------------------------
  // Signals
  // ---------------------------------------------------------------------------
  function count(sel) {
    try {
      return document.querySelectorAll(sel).length;
    } catch (e) {
      return 0;
    }
  }

  function meta(sel) {
    try {
      const el = document.querySelector(sel);
      return el ? el.getAttribute('content') || '' : '';
    } catch (e) {
      return '';
    }
  }

  /** schema.org types anywhere in the page's JSON-LD blocks. */
  function jsonLdTypes() {
    const out = [];
    let blocks = [];
    try {
      blocks = document.querySelectorAll('script[type="application/ld+json"]');
    } catch (e) {
      return out;
    }
    // A page with dozens of JSON-LD blocks (listing pages) is not worth parsing.
    for (let i = 0; i < Math.min(blocks.length, 6); i++) {
      let data = null;
      try {
        data = JSON.parse(blocks[i].textContent || '');
      } catch (e) {
        continue;
      }
      (function walk(v, depth) {
        if (depth > 4 || !v) return;
        if (Array.isArray(v)) {
          for (const item of v) walk(item, depth + 1);
          return;
        }
        if (typeof v !== 'object') return;
        if (v['@type']) {
          const t = v['@type'];
          if (Array.isArray(t)) for (const x of t) out.push(String(x));
          else out.push(String(t));
        }
        if (v['@graph']) walk(v['@graph'], depth + 1);
      })(data, 0);
    }
    return out;
  }

  function collectSignals() {
    if (typeof document === 'undefined') return null;
    const codeBlocks = count('pre');
    return {
      host: (location.hostname || '').replace(/^www\./, ''),
      path: location.pathname || '',
      lang: document.documentElement.getAttribute('lang') || '',
      ogType: meta('meta[property="og:type"]').toLowerCase(),
      jsonLd: jsonLdTypes(),
      codeBlocks,
      // inline code, excluding the <code> that lives inside a <pre> block
      inlineCode: count('code:not(pre code)'),
      mathNodes: count('math, .katex, .MathJax, mjx-container'),
      citations: count('[class*="citation"], [class*="references"], sup.reference'),
      timeStamps: count('time[datetime]'),
      articles: count('article'),
      comments: count('[class*="comment"], [id*="comment"], [class*="discussion"], .reply'),
      prices: count('[itemprop="price"], [class*="price"], [data-price]'),
    };
  }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------
  /**
   * Pure: signals -> { profileId: score }.
   *
   * Weights are hand-tuned and intentionally blunt. Structural evidence (a
   * schema.org type, a code-block density) is worth far more than a hostname
   * guess, and no single signal is enough on its own to cross the threshold.
   */
  function score(signals) {
    const s = { tech: 0, academic: 0, news: 0, forum: 0, commerce: 0, general: 0 };
    if (!signals) return s;
    const host = signals.host || '';
    const path = signals.path || '';
    const ld = signals.jsonLd || [];
    const has = (re) => ld.some((t) => re.test(t));

    // --- technical documentation ---
    // Weights here are deliberately eager. A false positive only adds a
    // terminology rule that is harmless on non-technical prose, while a false
    // negative loses the "don't translate API names" guidance exactly where it
    // matters. One strong structural or URL signal is therefore enough.
    if (signals.codeBlocks >= 3) s.tech += 4;
    if (signals.codeBlocks >= 12) s.tech += 2;
    if (signals.inlineCode >= 25) s.tech += 2;
    if (/^(docs?|developer|developers|api|learn|wiki)\./.test(host)) s.tech += 4;
    if (/(^|\/)(docs?|guide|reference|api|manual|handbook)(\/|$)/.test(path)) s.tech += 4;
    if (/(github\.io|readthedocs\.io|gitbook\.io|netlify\.app|vercel\.app)$/.test(host)) s.tech += 2;
    if (has(/TechArticle|APIReference|SoftwareSourceCode|SoftwareApplication/)) s.tech += 4;

    // --- academic ---
    if (signals.mathNodes >= 5) s.academic += 3;
    if (signals.mathNodes >= 25) s.academic += 2;
    if (signals.citations >= 3) s.academic += 2;
    if (/(arxiv\.org|doi\.org|pubmed|springer|sciencedirect|nature\.com|ieee\.org|acm\.org)/.test(host)) s.academic += 4;
    if (/(^|\/)(abs|pdf|paper|article)\//.test(path)) s.academic += 2;
    if (has(/ScholarlyArticle|MedicalScholarlyArticle/)) s.academic += 4;

    // --- news ---
    if (has(/NewsArticle|ReportageNewsArticle|BlogPosting/)) s.news += 4;
    if (signals.ogType === 'article') s.news += 2;
    if (signals.timeStamps >= 3) s.news += 2;
    if (signals.articles >= 1 && signals.codeBlocks < 3) s.news += 1;

    // --- forum / user-generated ---
    if (signals.comments >= 5) s.forum += 3;
    if (signals.comments >= 20) s.forum += 2;
    if (has(/QAPage|DiscussionForumPosting|Question|Answer/)) s.forum += 4;
    if (/(news\.ycombinator\.com|reddit\.com|stackoverflow\.com|stackexchange\.com|v2ex\.com|zhihu\.com|discourse|forum\.)/.test(host)) s.forum += 3;

    // --- commerce ---
    if (signals.prices >= 1) s.commerce += 3;
    if (signals.ogType === 'product' || signals.ogType === 'product.item') s.commerce += 3;
    if (has(/Product|Offer|AggregateOffer/)) s.commerce += 4;
    if (/(amazon\.|taobao\.com|tmall\.com|jd\.com|ebay\.|etsy\.com|shopify)/.test(host)) s.commerce += 3;

    return s;
  }

  /** The profile definition, for callers that need the label only. */
  function byId(id) {
    return PAGE_PROFILES.filter((p) => p.id === id)[0] || PAGE_PROFILES[PAGE_PROFILES.length - 1];
  }

  /**
   * @param {string} [mode] 'auto' (default) or a profile id to force
   * @returns {{id:string,label:string,confidence:'manual'|'auto'|'low',scores?:object}}
   */
  function detect(mode) {
    if (mode && mode !== 'auto') {
      const forced = PAGE_PROFILES.filter((p) => p.id === mode)[0];
      if (forced) return { id: forced.id, label: forced.label, confidence: 'manual' };
    }

    const signals = collectSignals();
    const scores = score(signals);
    let best = null;
    let bestScore = 0;
    for (const id of CANDIDATES) {
      if (scores[id] > bestScore) {
        bestScore = scores[id];
        best = id;
      }
    }
    if (!best || bestScore < CONFIDENCE_THRESHOLD) {
      const g = byId('general');
      return { id: g.id, label: g.label, confidence: 'low', scores };
    }
    const p = byId(best);
    return { id: p.id, label: p.label, confidence: 'auto', scores };
  }

  /** The prompt-facing description of a profile, resolved from constants. */
  function labelFor(id) {
    return byId(id).label;
  }

  page.profile = { collectSignals, score, detect, labelFor, CONFIDENCE_THRESHOLD };
})(typeof globalThis !== 'undefined' ? globalThis : self);
