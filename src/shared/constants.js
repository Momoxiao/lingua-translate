/**
 * Lingua — shared constants.
 * Loaded as a classic script in BOTH the MV3 service worker (via importScripts)
 * and the isolated content-script world. Registers onto globalThis.YTST.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});

  /** Extension-wide identifiers */
  const ID = 'lingua';

  /** Message channels (content <-> background) */
  const MSG = {
    TRANSLATE_BATCH: 'lingua:translate-batch',
    TRANSLATE_STATUS: 'lingua:translate-status',
    CANCEL_JOB: 'lingua:cancel-job',
    GET_SETTINGS: 'lingua:get-settings',
    TEST_PROVIDER: 'lingua:test-provider',
    CLEAR_CACHE: 'lingua:clear-cache',
    CACHE_STATS: 'lingua:cache-stats',
    PING: 'lingua:ping',
    PORT: 'lingua:port',
    BADGE: 'lingua:badge',
  };

  /** window.postMessage bridge between MAIN world and isolated world */
  const BRIDGE = {
    SOURCE: 'lingua-bridge',
    // MAIN -> ISOLATED
    READY: 'bridge:ready',
    PLAYER_RESPONSE: 'bridge:player-response',
    CAPTION_RESPONSE: 'bridge:caption-response',
    FETCH_RESULT: 'bridge:fetch-result',
    PLAYER_STATE: 'bridge:player-state',
    // ISOLATED -> MAIN
    FETCH_TRACK: 'bridge:fetch-track',
    PROBE: 'bridge:probe',
  };

  /** Translation providers shipped out of the box */
  const PROVIDERS = {
    openai: {
      id: 'openai',
      label: 'OpenAI 兼容',
      hint: '适用于 OpenAI、DeepSeek、Kimi、智谱、通义、硅基流动、OpenRouter、Groq、Ollama、LM Studio、one-api / new-api 等所有 /chat/completions 接口',
      fields: ['baseUrl', 'apiKey', 'model', 'temperature', 'prompt'],
    },
    deepl: {
      id: 'deepl',
      label: 'DeepL',
      hint: 'DeepL 官方 API（Free / Pro）。质量高、速度快，适合纯翻译场景',
      fields: ['apiKey', 'pro', 'baseUrl'],
    },
    google: {
      id: 'google',
      label: 'Google 翻译',
      hint: '免费网页接口，无需 Key。速度最快，适合快速预览',
      fields: ['apiKey'],
    },
    microsoft: {
      id: 'microsoft',
      label: '微软 Azure',
      hint: 'Azure Translator 文本翻译 API，需 Key 与区域',
      fields: ['apiKey', 'region', 'baseUrl'],
    },
    custom: {
      id: 'custom',
      label: '自定义 API 模板',
      hint: '任意 HTTP 接口：自定义 URL / 方法 / 请求头 / 请求体模板 / 响应取值路径',
      fields: ['url', 'method', 'apiKey', 'headers', 'body', 'responsePath'],
    },
  };

  /** Language catalogue. code = YouTube caption code, label = display name */
  const LANGUAGES = [
    { code: 'zh-Hans', label: '简体中文' },
    { code: 'zh-Hant', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'es', label: 'Español' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'ru', label: 'Русский' },
    { code: 'pt', label: 'Português' },
    { code: 'it', label: 'Italiano' },
    { code: 'ar', label: 'العربية' },
    { code: 'hi', label: 'हिन्दी' },
    { code: 'th', label: 'ไทย' },
    { code: 'vi', label: 'Tiếng Việt' },
    { code: 'id', label: 'Bahasa Indonesia' },
    { code: 'tr', label: 'Türkçe' },
    { code: 'nl', label: 'Nederlands' },
    { code: 'pl', label: 'Polski' },
    { code: 'uk', label: 'Українська' },
  ];

  /** Human-readable names used inside LLM prompts */
  const LANG_NAMES = {
    'zh-Hans': 'Simplified Chinese',
    'zh-Hant': 'Traditional Chinese',
    zh: 'Chinese',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    ru: 'Russian',
    pt: 'Portuguese',
    it: 'Italian',
    ar: 'Arabic',
    hi: 'Hindi',
    th: 'Thai',
    vi: 'Vietnamese',
    id: 'Indonesian',
    tr: 'Turkish',
    nl: 'Dutch',
    pl: 'Polish',
    uk: 'Ukrainian',
  };

  /** Target-language codes understood by non-LLM engines */
  const ENGINE_LANG = {
    deepl: { 'zh-Hans': 'ZH', 'zh-Hant': 'ZH', en: 'EN-US', ja: 'JA', ko: 'KO', es: 'ES', fr: 'FR', de: 'DE', ru: 'RU', pt: 'PT-BR', it: 'IT', ar: 'AR', pl: 'PL', nl: 'NL', tr: 'TR', uk: 'UK' },
    google: { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko', es: 'es', fr: 'fr', de: 'de', ru: 'ru', pt: 'pt', it: 'it', ar: 'ar', hi: 'hi', th: 'th', vi: 'vi', id: 'id', tr: 'tr', nl: 'nl', pl: 'pl', uk: 'uk' },
    microsoft: { 'zh-Hans': 'zh-Hans', 'zh-Hant': 'zh-Hant', en: 'en', ja: 'ja', ko: 'ko', es: 'es', fr: 'fr', de: 'de', ru: 'ru', pt: 'pt', it: 'it', ar: 'ar', hi: 'hi', th: 'th', vi: 'vi', id: 'id', tr: 'tr', nl: 'nl', pl: 'pl', uk: 'uk' },
  };

  /** Default settings — single source of truth for the whole extension */
  const DEFAULT_SETTINGS = {
    enabled: true,
    provider: 'openai',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    displayMode: 'bilingual', // bilingual | translated | original
    autoTranslate: true,
    hideNativeCaptions: true,
    fontSize: 24,
    bottomOffset: 12, // % of player height
    textAlign: 'center',
    backgroundOpacity: 0.72,
    batchSize: 16,
    concurrency: 4,
    lookahead: 25, // seconds translated ahead of playhead
    cacheEnabled: true,
    liveMode: false, // live streams: realtime DOM scraping
    debug: false,
    /** Full-page translation (works on any site, independent of the subtitle pipeline) */
    page: {
      autoTranslate: false, // off by default — the user opts in per site
      displayMode: 'bilingual', // bilingual | replace
      style: 'underline', // underline | plain | highlight
      batchSize: 12, // blocks per request
      maxChars: 1400, // characters per request
      concurrency: 3,
      autoSites: [], // hostnames where translation starts automatically
      skipSites: [], // hostnames the extension never touches
      skipSelectors: '', // extra CSS selectors to ignore, comma separated
      translateInputs: false, // also translate placeholder/alt/title attributes
    },
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        temperature: 0,
        prompt: '',
      },
      deepl: {
        baseUrl: 'https://api-free.deepl.com/v2/translate',
        apiKey: '',
        pro: false,
      },
      google: {
        apiKey: '',
      },
      microsoft: {
        baseUrl: 'https://api.cognitive.microsofttranslator.com/translate',
        apiKey: '',
        region: '',
      },
      custom: {
        url: '',
        method: 'POST',
        apiKey: '',
        headers: '{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer {{key}}"\n}',
        body: '{\n  "text": "{{text}}",\n  "from": "{{from}}",\n  "to": "{{to}}"\n}',
        responsePath: '',
      },
    },
  };

  /** Cache tuning */
  const CACHE = {
    STORAGE_KEY: 'lingua:cache:v1',
    MAX_ENTRIES: 15000,
    FLUSH_DEBOUNCE_MS: 5000,
  };

  NS.constants = { ID, MSG, BRIDGE, PROVIDERS, LANGUAGES, LANG_NAMES, ENGINE_LANG, DEFAULT_SETTINGS, CACHE };
})(typeof globalThis !== 'undefined' ? globalThis : self);
