/**
 * Lingua — LLM output normalisation shared by all chat-style providers.
 * Registers onto Lingua.bg.llm.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});
  const { parseBatchResponse } = NS.subtitles;

  /** Remove markdown fences, leading prose and stray sentinels. */
  function stripDecoration(text) {
    let s = String(text || '').trim();
    s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
    s = s.replace(/^\[\[LINGUA\]\]\s*/i, '');
    return s.trim();
  }

  /**
   * Turn a chat completion into an index-aligned array of length `count`.
   * Falls back to the raw text when the model ignored the numbering and we only
   * asked for a single line.
   */
  function parseOutput(content, count) {
    const clean = stripDecoration(content);
    if (!clean) return new Array(count).fill(null);
    const parsed = parseBatchResponse(clean, count);
    if (count === 1) {
      const first = parsed[0];
      if (!first) {
        // Model answered without numbering — accept the cleaned text verbatim.
        return [clean.replace(/^\s*[\[\(]?\s*1\s*[\]\)]?\s*[.、:：)）\-—]?\s*/, '')];
      }
    }
    return parsed;
  }

  BG.llm = { stripDecoration, parseOutput };
})(typeof globalThis !== 'undefined' ? globalThis : self);
