/**
 * Lingua — LLM prompt templates for subtitle translation.
 * Registers onto Lingua.bg.prompts.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const BG = (NS.bg = NS.bg || {});
  const { LANG_NAMES, PAGE_PROFILES } = NS.constants;

  function langName(code) {
    if (!code || code === 'auto') return 'the source language';
    return LANG_NAMES[code] || LANG_NAMES[NS.subtitles.normalizeLang(code)] || code;
  }

  // ---------------------------------------------------------------------------
  // Adaptive translation profile
  // ---------------------------------------------------------------------------
  function profileById(id) {
    return PAGE_PROFILES.filter((p) => p.id === id)[0] || PAGE_PROFILES[PAGE_PROFILES.length - 1];
  }

  /**
   * The "translation expert" block.
   *
   * Built from constants.js, never from the page: the content script sends only
   * an id and a short user note, so a hostile page cannot inject instructions
   * into the prompt.
   *
   * Returns [] when there is nothing worth saying (neutral profile, no note).
   */
  function profileLines(profile) {
    if (!profile || !profile.id) return [];
    const def = profileById(profile.id);
    const notes = String(profile.notes || '').trim().slice(0, 300);
    if (def.id === 'general' && !notes) return [];
    const lines = ['Context:', `This text comes from ${def.promptLabel || 'a general web page'}.`];
    for (const d of def.directives || []) lines.push(`- ${d}`);
    if (notes) lines.push(`- Additional instruction from the user: ${notes}`);
    return lines;
  }

  /** Profile block for prompts the user wrote themselves — append-only. */
  function profileSuffix(profile) {
    const lines = profileLines(profile);
    return lines.length ? '\n\n' + lines.join('\n') : '';
  }

  /**
   * The system prompt is deliberately strict about numbering because the whole
   * batching strategy depends on being able to re-align lines by index.
   * `kind` switches between subtitle lines and full-page text blocks.
   *
   * The profile block sits between the intro and the rules on purpose: the
   * output-format contract has to be the LAST thing the model reads.
   */
  function systemPrompt(from, to, kind, profile) {
    const src = langName(from);
    const dst = langName(to);
    const ctx = profileLines(profile);

    if (kind === 'live') {
      return [
        `You are a realtime subtitle translator. Translate from ${src} into ${dst}.`,
        '',
        'The user message is one subtitle line that may still be growing word by word.',
        'Translate exactly what is present. Never invent a continuation.',
        '',
        'Rules:',
        '1. Output ONLY the translation, with no index, quotes, explanation or markdown.',
        '2. Keep names, numbers, units, timestamps and emoji exactly as they are.',
        '3. Be concise and natural, like an on-screen subtitle.',
      ].join('\n');
    }

    if (kind === 'page') {
      const rules = [
        'Rules:',
        '1. Output ONLY the translated blocks. Prefix every block with the SAME index it had in the input, followed by a period and a space.',
        '2. Output exactly one line per input block. Never merge two blocks, never split one block into two.',
        '3. Never output the source text, explanations, notes, quotes, or markdown fences.',
        '4. Preserve inline formatting markers, numbers, units, product names, code identifiers and URLs exactly.',
        '5. Translate UI labels, buttons, menus and navigation items concisely — match the tone of the surrounding product.',
        '6. Keep the register of the original: marketing copy stays persuasive, docs stay neutral and precise.',
        '7. If a block is untranslatable (a code snippet, a symbol, a bare number), output it unchanged.',
        '8. Inline markers look like ⟦1⟧link text⟦/1⟧ and ⟦c2⟧inline code⟦/c2⟧. Keep every marker pair EXACTLY as it is: never translate, rename, renumber, reorder, drop or duplicate them. Keep ⟦n⟧ matched with ⟦/n⟧ and ⟦cn⟧ matched with ⟦/cn⟧, and keep each marker where that item belongs in the translated sentence. Translate link text naturally; keep text inside code markers unchanged.',
      ];
      return [
        `You are a professional web page translator. Translate from ${src} into ${dst}.`,
        '',
        'The user message contains text blocks from a web page, each prefixed with an index like "1." or "12.".',
        ...(ctx.length ? ['', ...ctx] : []),
        '',
        ...rules,
      ].join('\n');
    }

    const rules = [
      'Rules:',
      '1. Output ONLY the translated lines. Prefix every line with the SAME index it had in the input, followed by a period and a space.',
      '2. Output exactly one line per input line. Never merge two lines, never split one line into two.',
      '3. Never output the source text, explanations, notes, quotes, or markdown fences.',
      '4. Keep names, numbers, units, timestamps, HTML-ish tags and emoji exactly as they are.',
      '5. The result must read like natural, concise on-screen subtitles for a native speaker.',
      '6. If a line is untranslatable (a code, a symbol, a proper noun), output it unchanged.',
    ];
    return [
      `You are a professional subtitle translator. Translate from ${src} into ${dst}.`,
      '',
      'The user message contains subtitle lines, each prefixed with an index like "1." or "12.".',
      ...(ctx.length ? ['', ...ctx] : []),
      '',
      ...rules,
    ].join('\n');
  }

  /** Optional short instruction for non-LLM engines is not needed. */
  function singlePrompt(from, to) {
    const src = langName(from);
    const dst = langName(to);
    return `Translate the following subtitle line from ${src} into ${dst}. Output only the translation, with no quotes and no explanation.`;
  }

  BG.prompts = { systemPrompt, singlePrompt, langName, profileLines, profileSuffix };
})(typeof globalThis !== 'undefined' ? globalThis : self);
