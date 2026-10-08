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

  /**
   * Incremental parser for streamed numbered output.
   *
   * The stream can split anywhere, including in the middle of "12." or inside a
   * multi-byte character. This buffered parser only emits a line once a *later*
   * numbered line has been seen, which guarantees the earlier line is complete.
   * The final flush emits whatever remains.
   */
  function createStreamParser(count, onLine) {
    const pattern = /^\s*[\[\(]?\s*(\d{1,4})\s*[\]\)]?\s*[.、:：)）\-—]?\s*(.*)$/;
    const singleNumbered = /^\s*[\[\(]?\s*(\d{1,4})\s*[\]\)]?\s*[.、:：)）\-—]\s*([\s\S]*)$/;
    const seen = new Map();
    const emitted = new Set();
    let buf = '';
    let singleText = '';

    /** Strip a numbered prefix as soon as it has a complete line to expose. */
    function singleLineText(raw) {
      const clean = stripDecoration(raw);
      if (!clean) return '';
      const numbered = singleNumbered.exec(clean);
      if (numbered) return numbered[2].replace(/\s+/g, ' ').trim();
      // A model may stream `1.` before the translation text. Do not flash the
      // number as a partial result while that prefix is still arriving.
      if (/^\s*[\[\(]?\s*\d{1,4}\s*[\]\)]?\s*(?:[.、:：)）\-—])?\s*$/.test(clean)) return '';
      return clean.replace(/\s+/g, ' ').trim();
    }

    function consume(chunk, flush) {
      buf += String(chunk || '');

      // A live request contains exactly one line. Unlike a batch, there is no
      // later numbered line to prove this one is complete, so emit the text as
      // it grows instead of waiting for the stream to finish.
      if (count === 1) {
        const next = singleLineText(buf);
        if (next && next !== singleText) {
          singleText = next;
          if (onLine) onLine(0, next);
        }
        if (flush) buf = '';
        return;
      }

      const lines = [];
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== '\n') continue;
        lines.push(buf.slice(start, i).replace(/\r$/, ''));
        start = i + 1;
      }
      // Keep an unterminated tail in the buffer: it may be only half a line.
      // On the final flush the tail is the last real line.
      const tail = buf.slice(start);
      buf = flush ? '' : tail;
      if (flush && tail) lines.push(tail);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = pattern.exec(line);
        if (!m) continue;
        const index = Number(m[1]) - 1;
        if (index < 0 || index >= count) continue;
        const prev = seen.get(index);
        seen.set(index, prev ? `${prev} ${m[2].trim()}` : m[2].trim());
      }

      const indexes = Array.from(seen.keys()).sort((a, b) => a - b);
      for (const index of indexes) {
        // A later numbered line proves every earlier one is complete. On flush
        // there is no later line left to wait for, so everything is emitted.
        const complete = flush || indexes.some((later) => later > index);
        if (!complete || emitted.has(index)) continue;
        const text = seen.get(index);
        if (text) {
          emitted.add(index);
          if (onLine) onLine(index, text);
        }
      }
    }

    return {
      push(chunk) {
        consume(chunk, false);
      },
      /** Full raw text seen so far, for the non-numbered single-line fallback. */
      raw() {
        let s = '';
        for (const text of seen.values()) s += (s ? '\n' : '') + text;
        return s ? s + '\n' + buf : buf;
      },
      finish(chunk) {
        if (chunk) buf += String(chunk);
        consume('', true);
        const out = new Array(count).fill(null);
        if (count === 1) {
          if (singleText) out[0] = singleText;
          return out;
        }
        for (const [index, text] of seen) out[index] = text || null;
        return out;
      },
    };
  }

  BG.llm = { stripDecoration, parseOutput, createStreamParser };
})(typeof globalThis !== 'undefined' ? globalThis : self);
