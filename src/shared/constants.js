/**
 * Lingua — shared constants.
 * Loaded as a classic script in BOTH the MV3 service worker (via importScripts)
 * and the isolated content-script world. Registers onto globalThis.Lingua.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});

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

  /**
   * Translation providers shipped out of the box.
   *
   * Terminology (one word per concept, everywhere in the product — UI, README,
   * manifest, error messages):
   *   翻译服务   the feature area you configure
   *   供应商     one selectable option in that area  (NOT "服务商")
   *   凭据       key / region / endpoint the provider needs
   *   网页翻译   translating a whole web page       (NOT "整页翻译")
   *   视频字幕   translating YouTube captions
   *   双语       原文 + 译文 side by side            (NOT "原文 + 译文")
   */
  const PROVIDERS = {
    openai: {
      id: 'openai',
      label: 'OpenAI 兼容',
      short: 'DeepSeek / Kimi 等',
      hint: '适用于所有 /chat/completions 接口：OpenAI、DeepSeek、Kimi、智谱、通义、硅基流动、OpenRouter、Groq，以及 Ollama、LM Studio、one-api 等本地部署',
    },
    deepl: {
      id: 'deepl',
      label: 'DeepL',
      short: '官方 API',
      hint: 'DeepL 官方 API（Free / Pro）。纯翻译场景质量高、速度快',
    },
    google: {
      id: 'google',
      label: 'Google 翻译',
      short: '免凭据，最快',
      hint: '免费网页接口，无需凭据。速度最快，适合快速预览',
    },
    microsoft: {
      id: 'microsoft',
      label: '微软 Azure',
      short: 'Azure API',
      hint: 'Azure Translator 文本翻译 API，需要 Key；区域资源还需填写区域',
    },
    custom: {
      id: 'custom',
      label: '自定义供应商',
      short: '任意 HTTP 接口',
      hint: '任何 HTTP 翻译接口都能接：自己写 URL、方法、请求头、请求体模板，并指定从响应的哪一层取值',
    },
  };

  /**
   * Adaptive translation profiles — the "translation expert" the page picks.
   *
   * The content script only ever sends an id; the directives live here so the
   * prompt is built from a source the page cannot tamper with. Each profile is a
   * small set of register/terminology rules that a human translator would apply
   * on seeing the page, not a fixed persona.
   */
  const PAGE_PROFILES = [
    {
      id: 'tech',
      label: '技术文档',
      promptLabel: 'technical documentation',
      hint: '保留 API、代码标识符与命令行参数；业界通用的英文术语不硬译',
      directives: [
        'Keep API names, function and variable names, CLI flags, file paths, package names, CSS selectors and code identifiers exactly as they are.',
        'Use the established translation for well-known concepts, but keep the English word when Chinese developers normally use it as-is (props, hook, commit, token). Never invent a translation for a term that has no settled one.',
        'Headings and UI labels stay short and imperative, in the neutral register of developer documentation.',
      ],
    },
    {
      id: 'academic',
      label: '学术论文',
      promptLabel: 'an academic or scientific text',
      hint: '正式学术语体；保留引用标注、公式与变量名；关键术语首次出现时附原文',
      directives: [
        'Use a formal academic register and precise terminology.',
        'Keep citation markers, reference numbers, equation symbols and variable names exactly as they are.',
        'On the first mention of a key term, give the established translation and keep the original term in parentheses.',
      ],
    },
    {
      id: 'news',
      label: '新闻资讯',
      promptLabel: 'news or journalism',
      hint: '客观新闻语体；人名、机构名与引语忠实，不随意本地化',
      directives: [
        'Use a clear, neutral journalistic register.',
        'Keep proper nouns, organisation names, job titles and quoted speech faithful. Do not localise a name unless a well-established translation exists.',
        'Headlines stay tight; do not pad them for fluency.',
      ],
    },
    {
      id: 'forum',
      label: '社区讨论',
      promptLabel: 'user-generated discussion (forum, issue tracker or comment thread)',
      hint: '保留口语、语气与梗；不把随意表达改成书面语',
      directives: [
        'Keep the conversational tone: slang, sarcasm, hedging and casual grammar are part of the meaning. Do not formalise them.',
        'Keep usernames, @mentions, hashtags, emoji and inline quotes exactly as they are.',
        'If a sentence is deliberately ungrammatical or a typo, keep that flavour rather than smoothing it into clean prose.',
      ],
    },
    {
      id: 'commerce',
      label: '电商购物',
      promptLabel: 'an e-commerce listing',
      hint: '品牌与型号不译；保留尺寸、单位与价格符号；商品文案保持说服力',
      directives: [
        'Keep brand names, product names, model numbers, sizes, units and currency symbols exactly as they are.',
        'Use the persuasive register of product copy; keep the selling points punchy.',
        'Specification tables translate as short noun phrases, not sentences.',
      ],
    },
    {
      id: 'general',
      label: '通用',
      promptLabel: 'a general web page',
      hint: '不做特殊处理，保持原文语体',
      directives: ['Keep the register of the original and translate naturally.'],
    },
  ];
  const CUSTOM_PRESETS = [
    {
      name: 'DeepLX（自建）',
      url: 'http://localhost:1188/translate',
      method: 'POST',
      headers: '{\n  "Content-Type": "application/json"\n}',
      body: '{\n  "text": "{{text}}",\n  "source_lang": "{{from}}",\n  "target_lang": "{{to}}"\n}',
      responsePath: 'data',
    },
    {
      name: 'LibreTranslate（自建）',
      url: 'http://localhost:5000/translate',
      method: 'POST',
      headers: '{\n  "Content-Type": "application/json"\n}',
      body: '{\n  "q": "{{text}}",\n  "source": "{{from}}",\n  "target": "{{to}}",\n  "format": "text"\n}',
      responsePath: 'translatedText',
    },
    {
      name: '数组式接口',
      url: 'https://api.example.com/translate',
      method: 'POST',
      headers: '{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer {{key}}"\n}',
      body: '{\n  "texts": {{texts}},\n  "from": "{{from}}",\n  "to": "{{to}}"\n}',
      responsePath: 'data.translations',
    },
  ];

  /** Placeholders understood by the custom provider, for the settings UI. */
  const CUSTOM_PLACEHOLDERS = [
    { token: '{{text}}', desc: '整批文本（带编号的多行字符串）' },
    { token: '{{texts}}', desc: '原始句子数组（JSON 字面量，用了它即切换为数组模式）' },
    { token: '{{from}}', desc: '源语言代码' },
    { token: '{{to}}', desc: '目标语言代码' },
    { token: '{{source}}', desc: '源语言名称' },
    { token: '{{target}}', desc: '目标语言名称' },
    { token: '{{key}}', desc: 'API Key' },
  ];

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
      batchSize: 24, // blocks per request
      maxChars: 2400, // characters per request
      concurrency: 3, // chunks in flight (each fans out further in the worker)
      autoSites: [], // hostnames where translation starts automatically
      skipSites: [], // hostnames the extension never touches
      skipSelectors: '', // extra CSS selectors to ignore, comma separated
      translateInputs: false, // also translate placeholder/alt/title attributes
      replaceLinkMode: 'translate', // translate | keep | strict — how "translated only" treats blocks with links
      profileMode: 'auto', // auto | one of PAGE_PROFILES ids — which "expert" translates
      profileNotes: '', // free-form extra instruction appended to the prompt
      showBall: true, // floating action ball on the page
    },
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        temperature: 0,
        prompt: '',
        stream: true,
        /** 'off' = ask the model not to deliberate (much faster); 'auto' = leave it alone */
        reasoning: 'off',
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
    VERSION: 3,
    STORAGE_KEY: 'lingua:cache:v3',
    LEGACY_STORAGE_KEYS: ['lingua:cache:v1', 'lingua:cache:v2'],
    SHARD_COUNT: 16,
    MAX_ENTRIES: 15000,
    FLUSH_DEBOUNCE_MS: 5000,
  };

  /**
   * Type stacks — the single source of truth for all four surfaces.
   *
   * The popup and the options page consume these as CSS custom properties in
   * theme.css; the floating ball and the subtitle overlay build their styles in
   * a JS template string inside a shadow root, so they read them from here.
   * A CSS custom property cannot be imported into a JS template string, so the
   * two declarations are kept in step by a test rather than by hope —
   * scripts/test-core.mjs compares them.
   */
  const FONTS = {
    body: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    display: '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Songti SC", "Noto Serif CJK SC", serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  };

  NS.constants = {
    ID,
    MSG,
    BRIDGE,
    PROVIDERS,
    CUSTOM_PRESETS,
    CUSTOM_PLACEHOLDERS,
    PAGE_PROFILES,
    FONTS,
    LANGUAGES,
    LANG_NAMES,
    ENGINE_LANG,
    DEFAULT_SETTINGS,
    CACHE,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
