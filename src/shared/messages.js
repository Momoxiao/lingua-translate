/**
 * Lingua — user-visible messages, in Chinese and English.
 *
 * Why a hand-written catalogue and not chrome.i18n `_locales`:
 *   - the same strings are needed by the service worker, the content scripts and
 *     the three extension pages, and `_locales` cannot serve all of them without
 *     duplicating the catalogue;
 *   - `chrome.i18n.getMessage` is unavailable in the CDP harnesses this repo uses
 *     for tests, so a `_locales`-only implementation would ship untested;
 *   - two locales is the actual requirement, and a plain object is auditable.
 *
 * Chinese is the author-facing source of truth and the fallback. English is a
 * complete second catalogue: `en` is used for every non-Chinese browser.
 *
 * Registers onto Lingua.i18n. Loaded before every other source file.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});

  const EN = {
    // -- brand / shared nouns ------------------------------------------------
    'app.name': 'Lingua',
    'app.subtitle': 'Subtitles & web-page translation',
    'app.action.title': 'Lingua — Translate this page',
    'verb.translate': 'Translate',
    'verb.save': 'Save',
    'verb.cancel': 'Cancel',
    'verb.close': 'Close',
    'verb.retry': 'Try again',
    'common.configured': 'Configured',
    'common.notConfigured': 'Not configured',
    'common.ready': 'Ready',
    'common.loading': 'Loading…',
    'common.none': '—',
    'common.done': 'Done',
    'common.error': 'Error',
    'common.warning': 'Warning',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.on': 'On',
    'common.off': 'Off',

    // -- providers -----------------------------------------------------------
    'provider.openai.label': 'OpenAI-compatible',
    'provider.openai.short': 'DeepSeek / Kimi and others',
    'provider.openai.hint':
      'Works with every /chat/completions endpoint: OpenAI, DeepSeek, Kimi, Zhipu GLM, Qwen, SiliconFlow, OpenRouter, Groq, and local deployments such as Ollama, LM Studio and one-api',
    'provider.deepl.label': 'DeepL',
    'provider.deepl.short': 'Official API',
    'provider.deepl.hint': 'The official DeepL API (Free / Pro). Fast and strong for straightforward translation',
    'provider.google.label': 'Google Translate',
    'provider.google.short': 'No key, fastest',
    'provider.google.hint': 'The free web endpoint, no credentials needed. Fastest option, good for a quick preview',
    'provider.microsoft.label': 'Microsoft Azure',
    'provider.microsoft.short': 'Azure API',
    'provider.microsoft.hint': 'Azure Translator text API. Requires a key; regional resources also need a region',
    'provider.custom.label': 'Custom provider',
    'provider.custom.short': 'Any HTTP endpoint',
    'provider.custom.hint':
      'Connect any HTTP translation endpoint: write the URL, method, headers and body template yourself, then point at the value in the response',

    // -- adaptive page profiles ---------------------------------------------
    'profile.tech.label': 'Technical documentation',
    'profile.tech.hint': 'Keep APIs, code identifiers and CLI flags; do not force a translation for established English terms',
    'profile.academic.label': 'Academic paper',
    'profile.academic.hint': 'Formal academic register; keep citations, formulas and variable names; add the source term on first use',
    'profile.news.label': 'News',
    'profile.news.hint': 'Neutral journalistic register; keep names, organisations and quotes faithful without over-localising',
    'profile.forum.label': 'Community discussion',
    'profile.forum.hint': 'Keep slang, tone and jokes; do not turn casual writing into formal prose',
    'profile.commerce.label': 'E-commerce',
    'profile.commerce.hint': 'Never translate brands or model numbers; keep sizes, units and currency symbols',
    'profile.general.label': 'General',
    'profile.general.hint': 'No special handling; keep the original register',

    // -- custom-provider presets --------------------------------------------
    'preset.deeplx': 'Self-hosted DeepLX',
    'preset.libretranslate': 'Self-hosted LibreTranslate',
    'preset.array': 'Array endpoint',
    'placeholder.text': 'The whole batch as a numbered multiline string',
    'placeholder.texts': 'The raw sentence array as a JSON literal (switches to array mode)',
    'placeholder.from': 'Source language code',
    'placeholder.to': 'Target language code',
    'placeholder.source': 'Source language name',
    'placeholder.target': 'Target language name',
    'placeholder.key': 'API key',

    // -- settings page: shell ------------------------------------------------
    'options.title': 'Lingua Settings',
    'options.nav.basic': 'BASIC',
    'options.nav.service': 'Translation service',
    'options.nav.language': 'Language & subtitles',
    'options.nav.page': 'Web-page translation',
    'options.nav.advanced': 'ADVANCED',
    'options.nav.perf': 'Performance & cache',
    'options.nav.help': 'Guide',
    'options.heading': 'Settings',
    'options.lead':
      'Connect your own translation service. Every request goes straight from the extension to the endpoint you configured, with no server in between.',

    'options.save.saving': 'Saving',
    'options.save.saved': 'Saved',
    'options.save.failed': 'Could not save',

    // -- settings page: service ---------------------------------------------
    'options.service.title': 'Translation service',
    'options.service.desc':
      'Pick a provider and enter its credentials. <strong>OpenAI-compatible</strong> covers most cloud and local models.',
    'options.service.test': 'Test connection',
    'options.service.test.busy': 'Contacting the endpoint…',
    'options.service.test.ok': 'Connected. Sample translation: {sample}',
    'options.service.test.fail': 'Connection failed: {error}',
    'options.service.inUse': 'In use',
    'options.service.notConfigured': 'Not configured',
    'options.service.missingModel': 'No model set',
    'options.service.missingUrl': 'No request URL set',
    'options.service.region': 'region {region}',
    'options.service.official': 'Official API',
    'options.service.free': 'Free web endpoint',

    // -- settings page: language & subtitles --------------------------------
    'options.language.title': 'Language & subtitles',
    'options.language.desc': 'Leaving the source language on Auto is usually best; the extension picks the highest-quality track.',
    'options.language.source': 'Source language',
    'options.language.target': 'Target language',
    'options.language.displayMode': 'Subtitle display',
    'options.language.bilingual': 'Bilingual',
    'options.language.translated': 'Translation only',
    'options.language.original': 'Original only',
    'options.language.fontSize': 'Font size',
    'options.language.bottomOffset': 'Distance from bottom',
    'options.language.backgroundOpacity': 'Background opacity',
    'options.language.align': 'Alignment',
    'options.language.alignCenter': 'Center',
    'options.language.alignLeft': 'Left',
    'options.language.alignRight': 'Right',
    'options.language.auto': 'Automatically start translating on a video',
    'options.language.hideNative': 'Hide YouTube captions',
    'options.language.hideNativeHint': 'Prevents overlap with the translated line',
    'options.language.autoOption': 'Auto (recommended)',
    'unit.sentences': 'lines',
    'unit.paragraphs': 'blocks',
    'unit.characters': 'chars',

    // -- settings page: web page --------------------------------------------
    'options.page.title': 'Web-page translation',
    'options.page.desc':
      'Detects body text, translates what is near the viewport first, and follows content loaded later. The original is never destroyed and can be restored at any time.',
    'options.page.profile': 'Translation style',
    'options.page.profileAuto': 'Detect automatically (recommended)',
    'options.page.profileHint':
      'Switches the translation register by page content: technical docs keep APIs and code identifiers, papers get an academic register, forums keep their tone. Only affects OpenAI-compatible providers.',
    'options.page.notes': 'Additional instructions',
    'options.page.notesPlaceholder': 'For example: keep terminology in English, do not paraphrase',
    'options.page.notesHint': 'Appended to the prompt to express your preferences.',
    'options.page.mode': 'Display',
    'options.page.modeBilingual': 'Bilingual',
    'options.page.modeReplace': 'Translation only',
    'options.page.modeHint': 'Bilingual = append the translation below the original',
    'options.page.style': 'Translation style',
    'options.page.styleUnderline': 'Left marker',
    'options.page.stylePlain': 'Plain text',
    'options.page.styleHighlight': 'Highlight',
    'options.page.linkMode': 'How “translation only” handles links',
    'options.page.linkTranslate': 'Keep links in the translation (recommended)',
    'options.page.linkKeep': 'Fall back to bilingual (links stay clickable)',
    'options.page.linkStrict': 'Strict replacement (links are lost)',
    'options.page.linkHint':
      'With “keep links”, links become placeholders for the translation and are rebuilt afterwards, so they stay clickable. If the model breaks a placeholder that paragraph falls back to bilingual.',
    'options.page.ball': 'Floating ball',
    'options.page.ballHint': 'Draggable; click to translate; position remembered per site',
    'options.page.auto': 'Translate pages automatically on open',
    'options.page.autoHint': 'Can also be set per site from the popup',
    'options.page.advanced': 'Advanced',
    'options.page.batchSize': 'Paragraphs per batch',
    'options.page.maxChars': 'Character limit per batch',
    'options.page.concurrency': 'Page concurrency',
    'options.page.skipSelectors': 'Ignore selectors',
    'options.page.autoSites': 'Sites to translate automatically',
    'options.page.skipSites': 'Sites to never translate',
    'options.page.hostHint': 'One domain per line',
    'options.page.inputs': 'Translate input hints',
    'options.page.inputsHint': 'Form placeholders, title, alt and similar attributes',

    // -- settings page: performance -----------------------------------------
    'options.perf.title': 'Performance & cache',
    'options.perf.desc':
      'Captions are prefetched in full and translated in batches, prioritising lines near the playhead. Bigger batches mean fewer requests, but one failure affects more at once.',
    'options.perf.batchSize': 'Sentences per batch',
    'options.perf.concurrency': 'Subtitle concurrency',
    'options.perf.cache': 'Enable translation cache',
    'options.perf.cacheHint': 'Reuse translations across videos and sites, so the same sentence is only translated once',
    'options.perf.cached': 'cached',
    'options.perf.clear': 'Clear',
    'options.perf.cleared': 'Cleared',
    'options.perf.debug': 'Debug log',
    'options.perf.debugHint': 'Print detailed progress to the console',

    // -- settings page: help ------------------------------------------------
    'options.help.title': 'Guide',
    'options.help.page': '<strong>Web-page translation</strong>: click the floating ball on the page, or the toolbar icon.',
    'options.help.video': '<strong>Subtitles</strong>: opening a YouTube video starts translation automatically and overlays bilingual captions.',
    'options.help.site': '<strong>Per-site rules</strong>: use the toolbar icon to switch display mode and per-site behaviour.',
    'options.help.report':
      '<strong>If something breaks</strong>: open the toolbar icon → Diagnostics (bottom right) and paste the copied text into an issue.',
    'options.help.whyTitle': 'Why captions are fetched inside the page',
    'options.help.why':
      'Since 2025 YouTube protects its caption endpoint with a PoToken. Any direct request from outside the page returns an empty body. Lingua runs inside the YouTube page and reuses the player’s own credential, so it can fetch the whole caption track.',
    'options.help.speedTitle': 'Speed tips',
    'options.help.speed1': 'Prefer a <strong>non-reasoning model</strong>: reasoning is pure overhead for translation and measured about twice as slow.',
    'options.help.speed2': 'Bigger batches mean fewer requests but a wider blast radius on failure; too much concurrency can hit rate limits.',
    'options.help.speed3': 'The cache works across videos and sites, so the same sentence is translated once.',

    // -- provider field schema ----------------------------------------------
    'field.baseUrl': 'Base URL',
    'field.baseUrlHint': 'Ending in /v1 is enough; the extension appends /chat/completions automatically.',
    'field.apiKey': 'API Key',
    'field.apiKeyHint': 'Can be left empty for a local model.',
    'field.model': 'Model',
    'field.modelHint': 'A non-reasoning model is recommended.',
    'field.temperature': 'Temperature',
    'field.stream': 'Streaming',
    'field.streamOn': 'On (recommended; the first line appears sooner)',
    'field.streamOff': 'Off (wait for the full batch)',
    'field.streamHint':
      'When on, a line appears as soon as the model finishes it instead of waiting for the whole batch; endpoints without streaming fall back automatically.',
    'field.reasoning': 'Model reasoning',
    'field.reasoningOff': 'Off (recommended; about 2.7× faster)',
    'field.reasoningAuto': 'Use the model default',
    'field.reasoningHint':
      'Translation has no ambiguity, so reasoning only costs time. Turning it off sends a “do not think” hint; endpoints that reject the field fall back automatically.',
    'field.prompt': 'System prompt (leave empty to use the built-in prompt)',
    'field.deeplKeyHint': 'Free keys end in :fx.',
    'field.endpoint': 'Endpoint',
    'field.googleKey': 'API Key (optional)',
    'field.googleKeyHint':
      'Leave empty to use the free web endpoint; enter a Google Cloud Translation v2 key to use the official API.',
    'field.subscriptionKey': 'Subscription Key',
    'field.region': 'Region',
    'field.regionHint': 'Required for a regional resource; leave empty for a global one. A wrong value returns 401.',
    'field.requestUrl': 'Request URL',
    'field.requestUrlHint': 'Supports placeholders, for example …/translate?to={{to}}',
    'field.method': 'Method',
    'field.methodHint': 'GET does not send a body.',
    'field.customKey': 'API Key',
    'field.customKeyHint': 'Reference it as {{key}} in the template',
    'field.headers': 'Headers (JSON)',
    'field.body': 'Body template',
    'field.bodyHint': 'Use {{text}} or {{texts}} to send the content to translate.',
    'field.responsePath': 'Response path',
    'field.responsePathHint': 'Leave empty to take text from the whole response.',
    'field.placeholderExample': 'data.translations or result[0].text',

    'custom.placeholders': 'Available placeholders',
    'custom.preview': 'Request preview (sample values)',
    'custom.noUrl': '(no request URL set)',
    'custom.err.headersJson': 'Headers must be a JSON object, for example {"Content-Type":"application/json"}.',
    'custom.err.headersParse': 'Headers are not valid JSON ({message}); the request cannot be sent until this is fixed.',
    'custom.err.getBody': '{method} requests do not send a body; move the placeholders into the request URL.',
    'custom.warn.noText': 'The body has no {{text}} or {{texts}}, so the endpoint will not receive anything to translate.',
    'custom.warn.noTarget': 'The target language is not sent to the endpoint ({{to}} or {{target}} is missing), so the output language may be wrong.',
    'custom.info.noResponsePath':
      'No response path set: text is taken from the whole response. For nested responses, set something like data.translations.',

    // -- popup ---------------------------------------------------------------
    'popup.mode.video': 'Subtitles',
    'popup.mode.page': 'Web page',
    'popup.status.reading': 'Reading',
    'popup.tab.video': 'Subtitles',
    'popup.tab.page': 'Web-page translation',
    'popup.video.enable': 'Translate subtitles',
    'popup.video.target': 'Translate into',
    'popup.video.displayMode': 'Subtitle display',
    'popup.video.track': 'Caption source',
    'popup.video.retranslate': 'Translate again',
    'popup.video.start': 'Start translating',
    'popup.page.title': 'Web-page translation',
    'popup.page.display': 'Display',
    'popup.page.mode': 'Display',
    'popup.page.style': 'Translation style',
    'popup.page.showOriginal': 'Hide translation temporarily',
    'popup.page.showOriginalHint': 'The translation is kept and can be restored',
    'popup.page.site': 'This site',
    'popup.page.siteRule': 'When this page opens',
    'popup.page.ruleManual': 'Translate manually',
    'popup.page.ruleAuto': 'Translate automatically',
    'popup.page.ruleSkip': 'Never translate',
    'popup.page.ball': 'Floating ball',
    'popup.page.ballHint': 'Docks to the edge; click to translate',
    'popup.page.retranslate': 'Translate again',
    'popup.foot.diagnostics': 'Diagnostics',
    'popup.foot.options': 'Settings',
    'popup.track.auto': 'Auto',
    'popup.track.asr': ' (auto-generated)',
    'popup.provider.none': 'No provider selected',
    'popup.provider.unconfigured': 'Not configured',
    'popup.foot.none': 'No translation service configured',
    'popup.state.untranslated': 'Not translated',
    'popup.state.scanning': 'Scanning',
    'popup.state.translating': 'Translating',
    'popup.state.done': 'Translated',
    'popup.state.error': 'Error',
    'popup.state.videoIdle': 'Disabled',
    'popup.state.videoLoading': 'Loading captions',
    'popup.state.videoTranslating': 'Translating',
    'popup.state.videoReady': 'Ready',
    'popup.state.videoEmpty': 'No captions',
    'popup.state.videoError': 'Error',
    'popup.state.videoLive': 'Live mode',
    'popup.state.parseFailed': 'Parse failed',
    'popup.state.fetchFailed': 'Caption fetch failed',
    'popup.state.liveFallback': 'Live fallback',
    'popup.progress.waitingFirst': 'Realtime translation (waiting for the first line)',
    'popup.progress.doomed': 'Captions unavailable on this page',
    'popup.progress.realtime': 'Realtime translation',
    'popup.progress.lines': '{count} lines',
    'popup.progress.complete': 'Translation complete',
    'popup.progress.live': 'Realtime translation',
    'popup.note.notWatch': 'This is not a YouTube video page.',
    'popup.note.paused': 'Paused; subtitles will not be translated.',
    'popup.note.noProvider': 'No translation service configured yet. Open Settings and enter your credentials.',
    'popup.note.scriptMissing': 'The page script is not ready yet. Reload the page and try again.',
    'popup.note.notSupported': 'This page cannot be translated (only http/https pages are supported).',
    'popup.note.siteSkip': 'This site is set to “never translate”. Switch it back to translate manually to resume.',
    'popup.note.ballHint': 'Tip: the floating ball on the page can also start translation.',
    'popup.note.startFailed': 'Could not start page translation',
    'popup.note.profileManual': '{label} · manual',
    'popup.unsupported': 'Unsupported',
    'popup.track.lines': '{count} lines',
    'popup.video.retranslateAgain': 'Translate again',
    'popup.video.startNow': 'Start translating',
    'popup.pageStop': 'Stop',
    'popup.pageRestore': 'Restore original',
    'popup.pageStart': 'Start translating',
    'popup.pageError': 'Translation failed',
    'popup.pageErrorDetail': 'Error: {error}',
    'popup.pageScanning': 'Scanning page…',
    'popup.pageTranslating': 'Translating {done}/{total}',
    'popup.pageTranslated': 'Translated {done}/{total}',
    'popup.pageEnabled': 'Enabled',
    'popup.pageProfileManual': '{label} · manual',
    'popup.status.notInjected': 'Not injected',
    'popup.note.startFailedShort': 'Could not start page translation',

    // -- floating ball -------------------------------------------------------
    'ball.status.translationError': 'Translation failed',
    'ball.status.error': 'Error: {error}',
    'ball.status.translating': 'Translating {done}/{total}',
    'ball.status.scanning': 'Scanning page…',
    'ball.status.translated': 'Translated {done}/{total}',
    'ball.status.active': 'Enabled',
    'ball.status.translatePage': 'Translate this page',
    'ball.action.showOriginal': 'Hide translation',
    'ball.action.restoreTranslation': 'Restore translation',
    'ball.action.retranslate': 'Translate again',
    'ball.action.stop': 'Stop',
    'ball.tooltip': 'Click to translate / right-click for settings',
    'ball.aria': 'Lingua web-page translation',
    'ball.notify.done': 'Translation complete',
    'ball.notify.empty': 'No translatable content found',
    'ball.notify.notReady': 'The page is not ready yet',
    'ball.notify.startFailed': 'Translation failed',
    'ball.action.start': 'Translate this page',
    'ball.action.enabled': 'Enabled',
    'ball.status.errorDetail': 'Error: {error}',
    'ball.status.translatingProgress': 'Translating {done}/{total}',
    'ball.status.translatedProgress': 'Translated {done}/{total}',
    'ball.action.restore': 'Restore translation',
    'ball.action.hideTranslation': 'Hide translation',
    'ball.action.temporaryHide': 'Hide translation',
    'ball.tooltipDetailed': 'Click to translate / right-click for settings',
    'ball.ariaLabel': 'Lingua web-page translation',

    // -- diagnostics page ----------------------------------------------------
    'diag.title': 'Lingua Diagnostics',
    'diag.subtitle': 'Diagnostics',
    'diag.lead':
      'When you open an issue, paste the report below. It shows how far the extension got on this page — <strong>“cannot fetch captions” and “captions arrived but would not translate” are different failures</strong> and have different fixes.',
    'diag.target': 'Which page to inspect',
    'diag.copy': 'Copy diagnostics',
    'diag.refresh': 'Check again',
    'diag.issue': 'Open an issue',
    'diag.verdict': 'Verdict',
    'diag.checking': 'Checking…',
    'diag.reportWhat': 'What this report contains',
    'diag.reportContains':
      'Page address and site, extension and browser version, whether the content script is injected, whether the page module loaded, whether the background connection is alive, caption-track count and languages, caption and translated counts, page-translation state, current provider and whether credentials are present.',
    'diag.reportExcludes':
      '<strong>It does not contain</strong> your API key, translated or source text, browsing history or cookies. The only potentially private value is the current page address; delete anything you would rather not share before posting.',
    'diag.copy.ok': 'Copied. Paste it into the issue.',
    'diag.copy.fallback': 'Copy failed automatically; the text is selected, press ⌘C / Ctrl+C.',
    'diag.noTabs': 'No inspectable page in this window',
    'diag.noTabsReport': 'No inspectable page in this window.',
    'diag.noTabsHelp': 'Switch windows, or first open the extension on the page you want to inspect.',
    'diag.tabClosed': 'The page has been closed.',
    'diag.unknownBrowser': 'Unknown browser',
    'diag.contentNoResponse': 'The content script did not respond',
    'diag.reportTitle': 'Lingua {version}',

    // -- diagnostics report labels ------------------------------------------
    'diag.section.videoSubtitles': 'Video subtitles',
    'diag.label.error': 'Error',
    'diag.label.rawReason': 'Reason code',
    'diag.value.liveStreamExpected': 'live stream (expected)',
    'diag.value.vodDegraded': 'VOD fallback (PoToken timing)',
    'diag.value.tracksCount': '{count} tracks: {list}',
    'diag.value.trackCountZero': '0 tracks',
    'diag.value.containerMissing': 'missing — realtime fallback cannot read any line',
    'diag.value.yesLower': 'yes',
    'diag.value.noLower': 'no',
    'diag.value.loadedLower': 'loaded',
    'diag.value.notLoadedLower': 'not loaded',
    'diag.value.aliveLower': 'alive',
    'diag.value.deadLower': 'dead',
    'diag.value.enabledLower': 'enabled',
    'diag.value.disabledLower': 'disabled',
    'diag.value.pageModuleMissingLower': 'page module not loaded',
    'diag.value.numberTracks': '{count} tracks: {list}',
    'diag.value.zeroTracks': '0 tracks',
    'diag.value.bytesLower': '{count} bytes',
    'diag.report.provider': 'Provider',
    'diag.label.generated': 'Generated',
    'diag.label.browser': 'Browser',
    'diag.section.page': 'Page',
    'diag.label.url': 'URL',
    'diag.label.site': 'Site',
    'diag.label.watchPage': 'YouTube video page',
    'diag.section.content': 'Content script',
    'diag.label.injected': 'Injected',
    'diag.label.pageModule': 'Page module',
    'diag.label.bridge': 'Background connection',
    'diag.label.bridgeError': 'Connection error',
    'diag.section.subtitles': 'Subtitles',
    'diag.label.status': 'Status',
    'diag.label.reason': 'Status reason',
    'diag.label.videoId': 'Video ID',
    'diag.label.tracks': 'Caption tracks',
    'diag.label.currentTrack': 'Current track',
    'diag.label.cueCount': 'Caption count',
    'diag.label.trackBytes': 'Caption response size',
    'diag.label.translated': 'Translated',
    'diag.label.liveMode': 'Live mode',
    'diag.label.modeSource': 'Mode source',
    'diag.label.liveLines': 'Realtime lines read',
    'diag.label.liveTranslated': 'Realtime lines translated',
    'diag.label.captionContainer': 'Player caption container',
    'diag.section.pageTranslation': 'Web-page translation',
    'diag.label.rule': 'Site rule',
    'diag.label.profile': 'Translation style',
    'diag.section.settings': 'Settings',
    'diag.label.provider': 'Provider',
    'diag.label.credentials': 'Credentials',
    'diag.label.targetLang': 'Target language',
    'diag.label.masterSwitch': 'Master switch',
    'diag.value.loaded': 'loaded',
    'diag.value.notLoaded': 'not loaded',
    'diag.value.alive': 'alive',
    'diag.value.dead': 'dead',
    'diag.value.enabled': 'enabled',
    'diag.value.disabled': 'disabled',
    'diag.value.yes': 'yes',
    'diag.value.no': 'no',
    'diag.value.bytes': '{count} bytes',
    'diag.value.trackCount': '{count} tracks: {list}',
    'diag.value.noTracks': '0 tracks',
    'diag.value.pageModuleMissing': 'page module not loaded',
    'diag.value.streamExpected': 'live stream (expected)',
    'diag.progress.lines': '{count} lines',
    'diag.status.lines': '{count} lines',
    'diag.status.translating': 'Translating {done}/{total}',
    'diag.status.translated': 'Translated {done}/{total}',
    'diag.status.enabled': 'Enabled',

    // -- diagnostics verdicts ----------------------------------------------
    'diag.verdict.contentMissing':
      'The content script did not answer, so the remaining checks cannot run. Common causes: the page was open before the extension was installed or updated (reload it), or the page is restricted (chrome://, the extension store).',
    'diag.verdict.bridgeDead':
      'The content script is present but the extension background context is gone — usually because the extension was updated or reloaded. Reload this page.',
    'diag.verdict.notWatch': 'This is not a YouTube video page, so captions are not loaded. Web-page translation is unaffected.',
    'diag.verdict.captionError': 'Caption fetch failed: {error}',
    'diag.verdict.loading': 'The caption track is loading. Wait a few seconds and check again.',
    'diag.verdict.idle': 'Subtitle translation is off. Check “Translate subtitles” in the popup and the master switch in Settings.',
    'diag.verdict.liveStream':
      'Live captions use realtime capture (reading the line the player is already showing) instead of the caption-track API, so there is no count here — that is normal.',
    'diag.verdict.rtUnparsed':
      'The full track returned a non-empty body ({bytes} bytes) but none of it parsed, so the extension switched to realtime capture. This is our parser, not a PoToken timing problem — reloading will not fix it. Captions still work, but arrive one line later than the prefetched path. Copy the report below and open an issue.',
    'diag.verdict.rtEmpty':
      'The full caption track did not come back (YouTube PoToken timing), so the extension switched to realtime capture: it reads and translates the line the player is showing, which is why there is no count. Captions work, but arrive later than the prefetched path. Reloading the page often recovers the full-track path.',
    'diag.verdict.unparsed':
      'A non-empty caption body arrived ({bytes} bytes) and produced no cues — this is our parser: the data arrived and we failed to read it. Retrying will not help. Copy the report below and open an issue; the response size identifies the format.',
    'diag.verdict.emptyTrack':
      'The player reported {count} caption tracks but no caption data came back — the video does have captions, and the failing step is the fetch. This is the case most worth reporting: copy the report below and open an issue.',
    'diag.verdict.noCaptions':
      'The page is connected but the player reported no caption tracks. The video may genuinely have none; if you can see captions on the web page, YouTube changed its caption API — please report it.',
    'diag.verdict.noProvider':
      '{count} captions were fetched, but no translation service is configured, so they will not be translated. Enter credentials in Settings.',
    'diag.verdict.noTranslation':
      '{count} captions were fetched, but not one translated. This usually means the endpoint returned an error (key, quota or network) — press “Test connection” in Settings.',
    'diag.verdict.ok': 'Looks healthy: {done}/{total} captions translated.',

    // -- diagnostics reason labels ------------------------------------------
    'reason.not-a-video': 'page is not a video page',
    'reason.no-captions': 'the player reported no caption track',
    'reason.empty-track': 'the track exists but the caption body was empty',
    'reason.unparsed-track': 'non-empty caption data arrived but nothing parsed',
    'reason.ad': 'an ad is playing; caption loading is deferred',

    // -- runtime messages ----------------------------------------------------
    'runtime.notConfigured':
      'Lingua: no translation service configured yet. Open the toolbar icon to set one up.',
    'runtime.needProvider': 'Configure a translation service first',
    'runtime.translateFailed': 'Translation failed',
    'runtime.requestFailed': 'Request failed',
    'runtime.backgroundGone': 'The background connection was closed',
    'runtime.contextGone': 'The extension was updated or reloaded. Refresh this page to continue',
    'runtime.unknownMessage': 'Unknown message type: {type}',
    'runtime.handlerFailed': 'Handler failed',
    'runtime.adPlaying': 'An ad is playing; captions load when it ends',
    'runtime.videoNoCaptions': 'This video has no available captions, so it cannot be translated',
    'runtime.captionUnparsed': 'Caption data arrived but could not be parsed. Retrying will not help; copy the diagnostics report and open an issue.',
    'runtime.captionMissing': 'Could not fetch caption data. Make sure the video has captions, or reload the page and try again.',
    'runtime.liveDoomed':
      'Neither the full caption track nor the player-rendered captions came through — captions cannot be fetched for this video, so page translation is unavailable. Open Diagnostics to report it.',
    'runtime.liveMode': 'Live mode: translating captions as they appear, with streaming text when supported',
    'runtime.liveFallback': 'The full caption fetch failed (YouTube signature restriction); switched to line-by-line realtime translation',
    'runtime.translateFailedDetail': 'Translation failed: {error}',
    'runtime.pageNotReady': 'The page is not ready yet',
    'runtime.noContent': 'No translatable content found',
    'runtime.emptyNotVideo': 'This is not a YouTube video page, so captions are not loaded.',
    'runtime.emptyUnparsed':
      'Caption data came back (the response was not empty) but none of it parsed — this is our parser, not a missing caption or a network problem. Retrying will not help. Copy the diagnostics report and open an issue; it includes the response size.',
    'runtime.emptyTrack':
      'This video has {count} caption tracks, but no caption data came back — the fetch failed, not the video. Copy the diagnostics report and open an issue.',
    'runtime.emptyNoCaptions': 'This video has no available captions, so it cannot be translated.',

    // -- provider errors -----------------------------------------------------
    'error.baseUrl': 'Base URL is empty',
    'error.defaultProvider': 'Translation failed',
    'error.http': '{label} request failed (HTTP {status})',
    'error.httpAuth': '{label} authentication failed (HTTP {status}); check the API key',
    'error.httpRate': '{label} rate limit reached (HTTP 429); backing off and retrying',
    'error.httpNotFound': '{label} endpoint not found (HTTP 404); check the Base URL',
    'error.badJson': '{label} returned a non-JSON response',
    'error.timeout': '{label} request timed out or was cancelled',
    'error.network': '{label} network error: {message}',
    'error.emptyResponse': 'The endpoint returned an empty response (check the model name)',
    'error.reasoningOnly':
      'The model returned only reasoning and no translation. Confirm “Model reasoning” is off in Settings, or use a non-reasoning model',
    'error.customHeaders': 'Headers are not valid JSON; check the Headers configuration',
    'error.customUrl': 'Custom endpoint URL is empty',
    'error.cancelled': 'Cancelled',
    'error.unknownProvider': 'Unknown translation service: {provider}',
    'error.testUnsupported': 'This service does not support connection tests',
    'error.handlerFailed': 'Handler failed',
    'error.unknownMessage': 'Unknown message type: {type}',
    'providerLabel.openai': 'OpenAI-compatible endpoint',
    'providerLabel.custom': 'Custom endpoint',
    'providerLabel.microsoft': 'Microsoft Translator',
  };

  const ZH = {}; // Chinese lives in the source defaults; see t()

  const CATALOGUES = { en: EN, zh: ZH };

  /**
   * zh is the default and deliberately absent from the catalogue: every message
   * passed to t() is already Chinese text, so a missing English translation
   * silently keeps the original instead of showing a key.
   */
  function normalizeLang(tag) {
    const s = String(tag || '').toLowerCase();
    return s.startsWith('zh') ? 'zh' : s ? 'en' : 'zh';
  }

  function detect() {
    if (typeof navigator === 'undefined') return 'zh';
    let ui = '';
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) ui = chrome.i18n.getUILanguage();
    } catch (e) {
      /* not an extension page */
    }
    return normalizeLang(ui || (navigator.languages && navigator.languages[0]) || navigator.language || '');
  }

  let current = detect();

  function setLang(lang) {
    current = normalizeLang(lang);
    return current;
  }

  function getLang() {
    return current;
  }

  /** True when a translation is active (i.e. we are not on Chinese). */
  function isEnglish() {
    return current === 'en';
  }

  /**
   * Translate. `zh` is the source text itself, so callers can keep writing
   * Chinese literals and the fallback is always the correct product wording.
   *
   * @param {string} zh Chinese source text (also the zh value)
   * @param {string} key catalogue key
   * @param {object} [vars] {name} placeholders
   */
  function t(zh, key, vars) {
    const catalogue = CATALOGUES[current] || ZH;
    let out = catalogue && catalogue[key] != null ? catalogue[key] : zh;
    if (vars) {
      out = String(out).replace(/\{(\w+)\}/g, (m, name) => (vars[name] == null ? m : String(vars[name])));
    }
    return out;
  }

  /** Shorthand for a fixed key with no interpolation. */
  function k(key, vars) {
    const catalogue = CATALOGUES[current] || ZH;
    const value = catalogue && catalogue[key] != null ? catalogue[key] : '';
    if (!vars) return value;
    return String(value).replace(/\{(\w+)\}/g, (m, name) => (vars[name] == null ? m : String(vars[name])));
  }

  /**
   * Translate the static parts of a page.
   *
   * `data-i18n` replaces textContent; `data-i18n-html` sets innerHTML (a small
   * fixed set of strings with inline <strong>); `data-i18n-attr` is a
   * semicolon-separated `attr:key` list. Chinese elements carry no attribute and
   * are left untouched, so a Chinese browser renders the original markup byte
   * for byte.
   */
  function apply(rootEl) {
    const host = rootEl || (typeof document !== 'undefined' ? document : null);
    if (!host || current !== 'en') return;
    const scope = host.querySelectorAll ? host : null;
    const all = scope ? scope.querySelectorAll('[data-i18n], [data-i18n-html], [data-i18n-attr]') : [];
    for (const el of all) {
      const key = el.getAttribute('data-i18n');
      if (key) {
        const value = k(key);
        if (value) el.textContent = value;
      }
      const htmlKey = el.getAttribute('data-i18n-html');
      if (htmlKey) {
        const value = k(htmlKey);
        if (value) el.innerHTML = value;
      }
      const attrs = el.getAttribute('data-i18n-attr');
      if (attrs) {
        for (const pair of attrs.split(';')) {
          const i = pair.indexOf(':');
          if (i < 1) continue;
          const attr = pair.slice(0, i).trim();
          const attrKey = pair.slice(i + 1).trim();
          const value = k(attrKey);
          if (attr && value) el.setAttribute(attr, value);
        }
      }
    }
  }

  NS.i18n = {
    t,
    k,
    setLang,
    getLang,
    isEnglish,
    normalizeLang,
    detect,
    apply,
    catalog: { en: EN },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
