/**
 * Lingua — subtitle parsing + batching primitives.
 * Shared by the content script (parse YouTube tracks) and the service worker
 * (build/parse batched LLM requests). Registers onto Lingua.subtitles.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});

  /** Decode the handful of HTML entities YouTube emits in caption payloads. */
  function decodeEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
      .replace(/&nbsp;/g, ' ');
  }

  function cleanText(s) {
    return decodeEntities(s)
      .replace(/<[^>]*>/g, '') // strip inline tags (<i>, <c.colorname>, <00:00:01.000>)
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** Parse YouTube `fmt=json3` payload -> cues. */
  function parseJson3(payload) {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const events = (data && data.events) || [];
    const cues = [];
    for (const ev of events) {
      if (!ev || !ev.segs) continue;
      const text = cleanText(ev.segs.map((s) => (s && s.utf8) || '').join(''));
      if (!text) continue;
      const start = (ev.tStartMs || 0) / 1000;
      const dur = (ev.dDurationMs || 0) / 1000;
      cues.push({ start, end: start + (dur || 2), text });
    }
    return dedupe(cues);
  }

  /** Parse YouTube `srv3` (XML with <p t= d=><s>) -> cues. Times in ms. */
  function parseSrv3(xml) {
    const cues = [];
    const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const inner = m[2];
      const t = /(?:^|\s)t="(\d+)"/.exec(attrs);
      const d = /(?:^|\s)d="(\d+)"/.exec(attrs);
      const start = t ? parseInt(t[1], 10) / 1000 : 0;
      const dur = d ? parseInt(d[1], 10) / 1000 : 0;
      const text = cleanText(inner);
      if (!text) continue;
      cues.push({ start, end: start + (dur || 2), text });
    }
    return dedupe(cues);
  }

  /** Parse classic timedtext XML (<text start= dur=>). Times in seconds. */
  function parseXml(xml) {
    const cues = [];
    const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const t = /(?:^|\s)start="([\d.]+)"/.exec(attrs);
      const d = /(?:^|\s)dur="([\d.]+)"/.exec(attrs);
      const start = t ? parseFloat(t[1]) : 0;
      const dur = d ? parseFloat(d[1]) : 0;
      const text = cleanText(m[2]);
      if (!text) continue;
      cues.push({ start, end: start + (dur || 2), text });
    }
    return dedupe(cues);
  }

  /** Auto-detect the timedtext flavour and parse. */
  function parseTimedText(body) {
    if (!body) return [];
    const s = String(body).trim();
    if (!s) return [];
    if (s[0] === '{' || s[0] === '[') {
      try {
        return parseJson3(s);
      } catch (e) {
        return [];
      }
    }
    if (s.indexOf('<p ') !== -1 || s.indexOf('<p>') !== -1) return parseSrv3(s);
    if (s.indexOf('<text') !== -1) return parseXml(s);
    return [];
  }

  /**
   * Collapse the rolling-duplicate lines that YouTube auto-captions produce
   * (e.g. "hello" -> "hello world" -> "world there") into discrete cues.
   */
  function dedupe(cues) {
    const out = [];
    for (const cue of cues) {
      if (!cue.text) continue;
      const prev = out[out.length - 1];
      if (prev) {
        if (prev.text === cue.text) {
          prev.end = Math.max(prev.end, cue.end);
          continue;
        }
        // rolling window: new line contains the old one -> replace, keep start
        if (cue.text.startsWith(prev.text) && cue.start <= prev.end + 0.35) {
          prev.text = cue.text;
          prev.end = Math.max(prev.end, cue.end);
          continue;
        }
        // near-duplicate: same words reordered within a rolling window
        if (prev.text.length > 12 && cue.text.length > 12 && cue.start < prev.end + 0.2) {
          const a = prev.text.slice(-24);
          const b = cue.text.slice(0, 24);
          if (a === b) {
            prev.text = prev.text + cue.text.slice(24);
            prev.end = Math.max(prev.end, cue.end);
            continue;
          }
        }
      }
      out.push({ start: cue.start, end: cue.end, text: cue.text });
    }
    // Guarantee monotonic, non-zero durations
    for (let i = 0; i < out.length; i++) {
      if (!(out[i].end > out[i].start)) out[i].end = out[i].start + 1.2;
      if (out[i + 1] && out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start + 0.4, out[i + 1].start);
    }
    return out;
  }

  /** Binary search: index of the cue covering time `t`, or -1. */
  function cueAt(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (t < c.start) hi = mid - 1;
      else if (t >= c.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  const BATCH_HEADER = '[[LINGUA]]';

  /**
   * Build the user-message body for a numbered batch.
   * The `[[LINGUA]]` sentinel lets us reject echoes / prompt leakage.
   */
  function buildBatchText(texts) {
    return texts.map((t, i) => `${i + 1}. ${t.replace(/\s*\n\s*/g, ' ')}`).join('\n');
  }

  /**
   * Parse a numbered batch response back into an index-aligned array.
   * Returns array of length `count`; entries are null when the model omitted them.
   *
   * Continuation handling: an un-numbered line that is followed by another
   * numbered line is treated as a wrap of the previous translation. An
   * un-numbered block at the very end is only appended when some index is still
   * missing — otherwise it is almost certainly a trailing note and is dropped.
   */
  function parseBatchResponse(raw, count) {
    const out = new Array(count).fill(null);
    if (!raw) return out;
    const text = String(raw).replace(/\r/g, '');
    const re = /^\s*[\[\(]?\s*(\d{1,4})\s*[\]\)]?\s*[.、:：)）\-—]?\s*(.*)$/;

    let matched = 0;
    let lastIdx = -1;
    let buffer = [];

    const flush = () => {
      if (!buffer.length) return;
      if (lastIdx >= 0) {
        const extra = buffer.join(' ').trim();
        if (extra) out[lastIdx] = out[lastIdx] ? `${out[lastIdx]} ${extra}` : extra;
      }
      buffer = [];
    };

    for (const line of text.split('\n')) {
      const m = line.match(re);
      const idx = m ? parseInt(m[1], 10) - 1 : -1;
      if (idx < 0 || idx >= count) {
        if (line.trim()) buffer.push(line.trim());
        continue;
      }
      flush();
      const val = m[2].trim();
      if (val) {
        out[idx] = out[idx] ? `${out[idx]} ${val}` : val;
        matched++;
      }
      lastIdx = idx;
    }
    if (matched < count) flush();

    if (matched < count * 0.5) {
      // Fallback: model dropped numbering — accept a clean line-for-line split.
      const lines = text
        .split('\n')
        .map((l) => l.replace(re, '$2').trim())
        .filter(Boolean);
      if (lines.length === count) return lines;
    }
    return out;
  }

  /** Map a YouTube caption code to our canonical target code. */
  function normalizeLang(code) {
    if (!code) return '';
    const c = String(code);
    if (/^zh(-|_)?(hans|cn|sg)?$/i.test(c)) return 'zh-Hans';
    if (/^zh(-|_)?(hant|tw|hk|mo)$/i.test(c)) return 'zh-Hant';
    return c.split('-')[0].toLowerCase();
  }

  NS.subtitles = {
    parseJson3,
    parseSrv3,
    parseXml,
    parseTimedText,
    dedupe,
    cueAt,
    buildBatchText,
    parseBatchResponse,
    normalizeLang,
    cleanText,
    BATCH_HEADER,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
