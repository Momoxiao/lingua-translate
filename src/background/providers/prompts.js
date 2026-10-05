/**
 * Lingua — LLM prompt templates for subtitle translation.
 * Registers onto YTST.bg.prompts.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});
  const BG = (NS.bg = NS.bg || {});
  const { LANG_NAMES } = NS.constants;

  function langName(code) {
    if (!code || code === 'auto') return 'the source language';
    return LANG_NAMES[code] || LANG_NAMES[NS.subtitles.normalizeLang(code)] || code;
  }

  /**
   * The system prompt is deliberately strict about numbering because the whole
   * batching strategy depends on being able to re-align lines by index.
   * `kind` switches between subtitle lines and full-page text blocks.
   */
  function systemPrompt(from, to, kind) {
    const src = langName(from);
    const dst = langName(to);

    if (kind === 'page') {
      return [
        `You are a professional web page translator. Translate from ${src} into ${dst}.`,
        '',
        'The user message contains text blocks from a web page, each prefixed with an index like "1." or "12.".',
        '',
        'Rules:',
        '1. Output ONLY the translated blocks. Prefix every block with the SAME index it had in the input, followed by a period and a space.',
        '2. Output exactly one line per input block. Never merge two blocks, never split one block into two.',
        '3. Never output the source text, explanations, notes, quotes, or markdown fences.',
        '4. Preserve inline formatting markers, numbers, units, product names, code identifiers and URLs exactly.',
        '5. Translate UI labels, buttons, menus and navigation items concisely — match the tone of the surrounding product.',
        '6. Keep the register of the original: marketing copy stays persuasive, docs stay neutral and precise.',
        '7. If a block is untranslatable (a code snippet, a symbol, a bare number), output it unchanged.',
      ].join('\n');
    }

    return [
      `You are a professional subtitle translator. Translate from ${src} into ${dst}.`,
      '',
      'The user message contains subtitle lines, each prefixed with an index like "1." or "12.".',
      '',
      'Rules:',
      '1. Output ONLY the translated lines. Prefix every line with the SAME index it had in the input, followed by a period and a space.',
      '2. Output exactly one line per input line. Never merge two lines, never split one line into two.',
      '3. Never output the source text, explanations, notes, quotes, or markdown fences.',
      '4. Keep names, numbers, units, timestamps, HTML-ish tags and emoji exactly as they are.',
      '5. The result must read like natural, concise on-screen subtitles for a native speaker.',
      '6. If a line is untranslatable (a code, a symbol, a proper noun), output it unchanged.',
    ].join('\n');
  }

  /** Optional short instruction for non-LLM engines is not needed. */
  function singlePrompt(from, to) {
    const src = langName(from);
    const dst = langName(to);
    return `Translate the following subtitle line from ${src} into ${dst}. Output only the translation, with no quotes and no explanation.`;
  }

  BG.prompts = { systemPrompt, singlePrompt, langName };
})(typeof globalThis !== 'undefined' ? globalThis : self);
