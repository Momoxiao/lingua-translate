# Lingua

**English** · [简体中文](README.zh-CN.md)

[![CI](https://github.com/Momoxiao/lingua-translate/actions/workflows/ci.yml/badge.svg)](https://github.com/Momoxiao/lingua-translate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![No dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#no-build-step-no-dependencies)

> **Bilingual YouTube subtitles and whole-page translation, powered by your own translation API.**
> No account. No server of ours. Your API key never leaves your machine.

A Chrome / Edge extension (Manifest V3) that translates **YouTube captions in sync with playback** and **web pages without destroying the original**. You bring the translation service — OpenAI-compatible (OpenAI, DeepSeek, Kimi, GLM, Qwen, SiliconFlow, OpenRouter, Groq, or your own Ollama / LM Studio / one-api), DeepL, Google, Microsoft Azure, or literally any HTTP endpoint you describe yourself.

| Web page · bilingual | Web page · translated only | Popup · video panel | Diagnostics |
| --- | --- | --- | --- |
| ![bilingual web page](docs/page-bilingual.png) | ![translated-only web page](docs/page-replace.png) | ![popup video panel](docs/popup.png) | ![diagnostics page](docs/diagnostics.png) |

More: [floating ball](docs/ball.png) · [settings](docs/options.png) · [custom provider](docs/options-custom.png) · [dark mode](docs/options-dark.png)

---

## Why this exists

Translation extensions usually make one of three trades. This one refuses all three.

| | The usual trade | Here |
| --- | --- | --- |
| **Data** | Text (and often the page URL) passes through the vendor's own servers | Text goes **directly** from your browser to the service **you** configured. There is no server of ours to pass through. |
| **Money** | A free tier that is really an upsell, with your own key locked behind a subscription | **Bring your own key, every feature unlocked.** MIT licensed, no paid tier, nothing withheld. |
| **Opacity** | Minified bundle, "trust us" | **10,347 lines across 37 files, zero build step, zero dependencies.** Read the whole extension in an afternoon. |

It is also honest about the one thing it cannot promise — see [Known limitations](#known-limitations).

## What it does

- **Bilingual YouTube subtitles.** Fetches the whole caption track up front and translates it ahead of the playhead, so the line is already there when it is spoken — not two seconds after. Drag the scrubber and the priority re-sorts around the new position. Manual and auto-generated (`asr`) tracks both work; you can pin the source language manually.
- **Whole-page translation that preserves the page.** Two modes: **bilingual**, or **translated only**. Nothing is overwritten — the original stays in the DOM, hidden with CSS. "Temporarily hide the translation" is a class flip, so there is no re-render, no flash, and a failed translation can never lose the original text.
- **Links stay clickable.** A translated link is the **original element**, moved — not a clone. Cloning copies attributes but not event listeners, so a cloned link looks right and does nothing. Hover states, click handlers, and `target` all survive.
- **It adapts the register to the page.** Technical documentation, academic papers, news, forum threads, e-commerce listings, or general prose — a small set of register rules is picked per page, so API names, citation markers, code identifiers and brand names are kept intact instead of being mangled into fluent nonsense.
- **Any translation service.** OpenAI-compatible, DeepL, Google, Microsoft Azure, or a fully user-defined HTTP provider: you write the URL, method, headers, body template, and the path to pull the text out of the response.
- **A diagnostics page, because "it doesn't work" is not a bug report.** One click reads the extension's real state on the current tab — was the content script injected, is the background connection alive, how many caption tracks were found, how many cues, which layer the translation stalled at — and copies it as text you can paste into an issue.

## Install

**From the store** *(coming — see [the launch playbook](docs/launch-playbook.md))*

**From source** (works today):

```bash
git clone https://github.com/Momoxiao/lingua-translate.git
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the repo root. On Edge use `edge://extensions`. On first install the settings page opens by itself.

Or grab `lingua-<version>.zip` from [Releases](https://github.com/Momoxiao/lingua-translate/releases/latest), unzip it, and point **Load unpacked** at the unzipped folder. Verify the download with the `.sha256` published next to it:

```bash
shasum -a 256 -c lingua-0.1.2.zip.sha256
```

## Configure

Settings → **Translation service** → pick a provider → paste your API key. The **Test connection** button tells you whether it works before you rely on it. If you run Ollama or LM Studio locally, choose *OpenAI-compatible* and point the base URL at `http://localhost:11434/v1` (or similar) — then nothing leaves your machine at all.

## How it works

Three problems were hard enough to be worth writing down. The full set of ~30 engineering notes is in the [Chinese README](README.zh-CN.md#十设计取舍记录).

**1. YouTube signs caption requests, so a plain `fetch` returns nothing.**
Since 2025 `/api/timedtext` is signed with a Proof-of-Origin token minted by BotGuard, and the URL in `ytInitialPlayerResponse` carries no `pot`. Fetching it yields **HTTP 200 with an empty body** — a failure that looks like success. The extension reuses the token the player itself already obtained, falling back through four strategies, the last of which is "whatever track the player happened to fetch".

**2. Timing.** The scheduler is priority-ordered around the playhead, not sequential. Chunk sizes adapt, the first batch is deliberately small (four lines on screen in about a second beats sixteen lines in three), and retries skip units that already succeeded — otherwise a single render error inside a chunk re-translates the whole chunk and a double-count shows up as *"translated 391 / 381"*.

**3. Rendering without breaking the page.** Grouping by *element* rather than by text node keeps `<p>Hello <b>world</b></p>` as one translation unit with its context, at the cost of having to exclude flex/grid layout containers explicitly. And `display`'s **computed** value lies: a flex container blockifies its children, so `<nav style="display:flex"><a>Home</a></nav>` reports `display:block` for the link — trust that and every nav link's translation lands *below* the link, wrapping the navbar onto two lines.

## No build step, no dependencies

`package.json` has no `dependencies` and no `devDependencies`. There is no bundler, no transpiler, and no `node_modules`. The extension is the source you read — `manifest.json` plus `src/`, loaded as-is. That is a deliberate constraint, not a gap:

- **You can audit it.** ~10k lines, plain ES2020, no generated code.
- **Nothing can rot.** No lockfile to drift, no transitive update to break the build in two years.
- **Packaging is reproducible.** `npm run dist` produces a byte-identical zip for the same source (fixed timestamps, sorted entries), which is what makes a published SHA-256 meaningful.

## Tests

```bash
npm run check       # 393 assertions across three suites, no bundler, no deps
npm test            # 157 — core logic: batching, parsing, all five providers
npm run test:dom    # 164 — paragraph detection, link handling, real doc sites
npm run test:pages  #  72 — popup, settings page, diagnostics verdicts
npm run test:e2e    #  74 — real Chrome, unpacked extension, real HTTP page

npm run preview     # render every UI surface to PNG
npm run smoke       # live captions against real YouTube (throwaway profile)
npm run inspect     # read the extension's real state out of YOUR browser
```

`npm test` needs neither a browser nor a network. The rest drive a real headless Chrome through a hand-written CDP client in `scripts/lib/` (Node's built-in WebSocket is rejected by Chrome's DevTools endpoint, so the transport is ~120 lines of `node:net`).

CI runs the three offline suites. `test:e2e` and `smoke` are deliberately not in CI: the first loads an unpacked extension into a real profile, the second hits real YouTube and its result depends on the browser profile.

## Known limitations

- **The caption path depends on YouTube's private interface and is not covered by CI.** `youtube.js` / `inject.js` / `bridge.js` lean on the player's internal response and on a Proof-of-Origin token. YouTube can change it without notice. This is the project's single largest risk and it is stated here rather than buried.

  **What has actually been measured, and what has not.** A zero-cue result was first blamed on the throwaway, signed-out profile "not being handed a PoToken". That explanation is **wrong**, and measurably so: against a real, signed-in session, the same video answers the same `fetch(baseUrl&fmt=json3&c=WEB)` with **HTTP 200 and a 0-byte body** — identical to the throwaway profile — and its `baseUrl` carries no `pot` either. Login state is not the variable.

  The untested variable is **playback**. The player only fetches a caption track once it is genuinely playing and rendering captions, and neither automated environment gets there:

  | Environment | Result |
  | --- | --- |
  | Headless / headed / headed with GPU | Video plays (`paused=false`, `t≈15s`), player issues **0** caption requests |
  | Background tab in a real Chrome | `video.readyState=0`, `networkState=2`, `document.hidden=true` — throttled; `play()` neither resolves nor rejects, so playback never starts and **0** requests are made |

  So a red smoke run currently proves only that **captions never began rendering**. It does not prove the extension is broken, and it does not prove YouTube changed the interface. Settling it requires a **visible, foreground** tab playing for ~15 seconds, then `npm run inspect:refresh`. **That test has not been run.**

  `npm run smoke` records every `/api/timedtext` request over CDP — its `pot`, its HTTP status, and the **initiator** that issued it. Attribution prefers CDP's initiator and says "unknown" when there is none, rather than guessing: `inject.js` builds its URL *from the player's own baseUrl*, so the extension's request and the player's can be byte-identical and the URL alone cannot tell them apart.
- Only the Chinese UI ships today. `_locales` is on the roadmap; the settings page and popup are Chinese until then.
- Subtitles work on `youtube.com` / `youtube-nocookie.com` watch pages only.
- Web-page translation runs in the top document — iframes and text inside images are not translated.
- Live streams fall back to per-sentence realtime translation, which is slower and less accurate than the whole-track pre-fetch used for VOD.
- Verified on Chrome on macOS. Edge is untested; **Firefox would need separate MV3 work.**
- The `<all_urls>` host permission is what makes whole-page translation and the user-defined provider possible. If you only want YouTube subtitles, delete the third `content_scripts` entry and `<all_urls>` from `manifest.json`.

## Privacy

**No server, no account, no analytics, no data collection.** The only thing that leaves your machine is the text being translated, sent straight to the translation service you configured. Credentials, cache and settings live in `chrome.storage.local`. Full detail — including what the diagnostics report does and does not contain: [`PRIVACY.md`](PRIVACY.md).

## Contributing

**The most useful thing you could contribute right now:** a screenshot or a 10-second GIF of the YouTube subtitle overlay. The headline feature is the one thing that has never been captured in automation — the paragraph harness renders web pages, not video players — so it is currently the only feature without a picture. (Windows and Linux screenshots of the overlay are welcome too; this has only been verified on macOS so far.)

Issues and PRs welcome. Before reporting a caption problem, please run the **diagnostics page** (extension icon → 诊断 → **copy**) and paste the output: "no captions found" and "captions found but the fetch came back empty" are entirely different failures with entirely different fixes, and that report is the only thing that tells them apart. It contains no API key and no translated text.

## License

[MIT](LICENSE). Use it, modify it, ship it commercially — just keep the copyright notice.
