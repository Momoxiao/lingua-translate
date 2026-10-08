/**
 * Lingua — diagnostics page.
 *
 * The single biggest risk in this project is the caption path: it leans on
 * YouTube's private player interface, it has no automated coverage, and when it
 * breaks the only thing a user can tell us is "it doesn't work". This page turns
 * that into something actionable by reading the extension's real state out of
 * the target tab and printing it as text the user can paste into an issue.
 *
 * `scripts/inspect-live.mjs` does the same thing over CDP, but it needs a
 * debug-port Chrome and a terminal. This is the version a normal user can run.
 */
(function () {
  'use strict';
  const NS = globalThis.Lingua;
  const { PROVIDERS, LANGUAGES } = NS.constants;
  const { emptySubtitleNote, emptyReasonLabel } = NS.utils;
  const tr = (zh, key, vars) => NS.i18n.t(zh, key, vars);

  const ISSUE_URL = 'https://github.com/Momoxiao/lingua-translate/issues/new?template=bug_report.yml';
  const OWN_URL = chrome.runtime.getURL('src/diagnostics/diagnostics.html');

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------------
  // Text helpers — the report is aligned, and CJK is two cells wide in a
  // monospace font, so padding by String#length would misalign every row.
  // ---------------------------------------------------------------------------
  const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

  function displayWidth(s) {
    let w = 0;
    for (const ch of String(s)) w += WIDE.test(ch) ? 2 : 1;
    return w;
  }

  function pad(s, n) {
    return s + ' '.repeat(Math.max(0, n - displayWidth(s)));
  }

  function row(label, value) {
    // Always keep at least one space: a label that reaches the column width
    // exactly (e.g. a 7-character CJK label at 14 columns) would otherwise butt
    // straight against its value, and since this text is copied into issue
    // reports, "播放器字幕容器不存在" reads as one run-on token.
    return `  ${label}${' '.repeat(Math.max(1, 14 - displayWidth(label)))}${value}`;
  }

  function section(title) {
    return `\n— ${title} —`;
  }

  function labelOfLang(code) {
    const l = LANGUAGES.find((x) => x.code === code);
    return l ? l.label : code || '—';
  }

  function trackLabel(t) {
    return `${t.languageCode}${t.kind ? '/' + t.kind : ''}${t.name ? ` (${t.name})` : ''}`;
  }

  function profileLabel(profile) {
    if (!profile) return '';
    const known = NS.constants.PAGE_PROFILES.find((p) => p.id === profile.id);
    return known ? known.label : profile.label || '';
  }

  function browserLine() {
    const ua = navigator.userAgent;
    const m = /(Edg|Chrome|Chromium)\/([\d.]+)/.exec(ua);
    const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    const name = m ? `${m[1]} ${m[2]}` : tr('未知浏览器', 'diag.unknownBrowser');
    return os ? `${name} · ${os}` : name;
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ---------------------------------------------------------------------------
  // Ask the target tab
  // ---------------------------------------------------------------------------
  function askContentScript(id) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(id, { type: 'lingua:get-state' }, (res) => {
          const err = chrome.runtime.lastError;
          if (err || !res || !res.ok) {
            resolve({ ok: false, error: (err && err.message) || tr('内容脚本没有响应', 'diag.contentNoResponse') });
            return;
          }
          resolve({ ok: true, state: res.state });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Verdict — the one line that says what is actually wrong
  // ---------------------------------------------------------------------------
  function verdictFor(res, tab) {
    if (!res.ok) {
      return {
        tone: 'err',
        text: tr(
          '内容脚本没有响应，后面几项无法检查。常见原因：这个页面在安装或更新扩展之前就已经打开（刷新本页即可），或者它是受限制的页面（chrome://、扩展商店等）。',
          'diag.verdict.contentMissing'
        ),
      };
    }
    const s = res.state;
    if (s.bridgeAlive === false) {
      return {
        tone: 'err',
        text: tr(
          '内容脚本在，但扩展的后台上下文已经失效——多半是刚更新或重新加载过扩展。刷新本页即可恢复。',
          'diag.verdict.bridgeDead'
        ),
      };
    }

    const sub = s.subtitle || {};
    if (!s.isWatchPage) {
      return {
        tone: 'idle',
        text: tr('当前不是 YouTube 视频播放页，所以不会加载字幕；网页翻译不受影响。', 'diag.verdict.notWatch'),
      };
    }
    if (sub.error) {
      return { tone: 'err', text: tr(`取字幕时报错：${sub.error}`, 'diag.verdict.captionError', { error: sub.error }) };
    }
    if (sub.status === 'loading') {
      return { tone: 'idle', text: tr('正在读取字幕轨，稍等几秒再点一次「重新检查」。', 'diag.verdict.loading') };
    }
    if (sub.status === 'idle') {
      return {
        tone: 'idle',
        text: tr(
          '字幕翻译当前是关闭的。检查弹窗里的「翻译视频字幕」开关，以及设置页的总开关。',
          'diag.verdict.idle'
        ),
      };
    }
    if (sub.status === 'live') {
      // This status now covers two different situations: a live stream, and a
      // VOD whose whole-track fetch came back empty (the PoToken timing case).
      // Describing both as "直播字幕" told a VOD user their ordinary video was a
      // stream, and hid the fact that the fast path had degraded.
      const isStream = !!sub.isLiveStream;
      // And the degraded case itself has two causes, which `reason` separates: a
      // zero-byte body is the PoToken race (a reload can win it), while a
      // non-empty body we failed to parse is a parser gap (a reload cannot).
      // Reporting the second as the first sent users to reload for something
      // reloading cannot touch — the same "wrong layer" mistake this page exists
      // to prevent.
      const unparsed = sub.reason === 'unparsed-track';
      if (isStream) {
        return {
          tone: 'ok',
          text: tr(
            '直播字幕走实时抓取（直接读播放器已经显示的那一行），不经过字幕轨接口，所以这里没有条数——属于正常。',
            'diag.verdict.liveStream'
          ),
        };
      }
      if (unparsed) {
        return {
          tone: 'warn',
          text: tr(
            `整轨字幕取回了非空数据（${sub.trackBytes || 0} 字节）却一条都没解析出来，已自动切换为实时抓取兜底。` +
              '这是本扩展的解析问题，不是 PoToken 时序问题——重新加载不会解决它。' +
              '能正常出字幕，但比点播的「提前翻译」慢半拍。请复制下面这段信息开 Issue。',
            'diag.verdict.rtUnparsed',
            { bytes: sub.trackBytes || 0 }
          ),
        };
      }
      return {
        tone: 'warn',
        text: tr(
          '整轨字幕没取回来（YouTube 的 PoToken 时序问题），已自动切换为实时抓取：' +
            '逐句读取播放器正在显示的那一行并翻译，所以这里没有条数。' +
            '能正常出字幕，但比点播的「提前翻译」慢半拍。重新加载页面常能让整轨路径成功。',
          'diag.verdict.rtEmpty'
        ),
      };
    }
    if (!sub.cueCount) {
      // "No subtitles" and "subtitles exist but the fetch came back empty" are
      // both `status: 'empty'`, and the report prints the track list right above
      // this line. Getting them the wrong way round told the user their video
      // was untranslatable when the fault was ours — the exact confusion this
      // page exists to prevent.
      const note = emptySubtitleNote(sub);
      const count = (sub.tracks || []).length;
      if (note.reason === 'unparsed-track') {
        // The body arrived and we could not read it. A retry will not help, so
        // this must not be phrased like the PoToken case above it.
        return {
          tone: 'warn',
          text: tr(
            `取回了非空的字幕数据（${sub.trackBytes || 0} 字节）却一条都没解析出来——` +
              '这是本扩展的解析问题：数据到了，是我们没读懂。重试没有意义，' +
              '直接复制下面这段信息开 Issue，响应大小能定位到是哪一种格式。',
            'diag.verdict.unparsed',
            { bytes: sub.trackBytes || 0 }
          ),
        };
      }
      if (note.reason === 'empty-track') {
        return {
          tone: 'warn',
          text: tr(
            `播放器报告了 ${count} 条字幕轨，但一条字幕数据都没取回来——视频本身是有字幕的，` +
              '卡住的是「取字幕」这一步。这是最需要上报的情况：直接复制下面这段信息开 Issue。',
            'diag.verdict.emptyTrack',
            { count }
          ),
        };
      }
      if (note.reason === 'no-captions') {
        return {
          tone: 'warn',
          text: tr(
            '页面已连通，但播放器没有报告任何字幕轨。可能这个视频确实没有字幕；' +
              '如果你在网页上能看到它，那就是 YouTube 改了字幕接口——请上报。',
            'diag.verdict.noCaptions'
          ),
        };
      }
      return { tone: 'idle', text: note.text };
    }
    if (!s.providerReady) {
      return {
        tone: 'warn',
        text: tr(`字幕已取到 ${sub.cueCount} 条，但没有配置翻译服务，所以不会翻译。去设置页填写凭据。`, 'diag.verdict.noProvider', {
          count: sub.cueCount,
        }),
      };
    }
    if (!sub.translated) {
      return {
        tone: 'warn',
        text: tr(
          `字幕已取到 ${sub.cueCount} 条，但一条都没翻译成功。多半是接口报错（Key、额度或网络）——去设置页点「测试连接」看看。`,
          'diag.verdict.noTranslation',
          { count: sub.cueCount }
        ),
      };
    }
    return {
      tone: 'ok',
      text: tr(`看起来正常：${sub.translated}/${sub.cueCount} 条字幕已翻译。`, 'diag.verdict.ok', {
        done: sub.translated,
        total: sub.cueCount,
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  function buildReport(res, tab) {
    const out = [];
    out.push(`Lingua ${chrome.runtime.getManifest().version}`);
    out.push(row(tr('生成时间', 'diag.label.generated'), stamp()));
    out.push(row(tr('浏览器', 'diag.label.browser'), browserLine()));

    out.push(section(tr('页面', 'diag.section.page')));
    out.push(row(tr('地址', 'diag.label.url'), (tab && tab.url) || '—'));
    if (res.ok) {
      out.push(row(tr('站点', 'diag.label.site'), res.state.host || '—'));
      out.push(row(
        tr('视频播放页', 'diag.label.watchPage'),
        res.state.isWatchPage ? tr('是', 'common.yes') : tr('否', 'common.no')
      ));
    }

    out.push(section(tr('内容脚本', 'diag.section.content')));
    if (!res.ok) {
      out.push(row(tr('已注入', 'diag.label.injected'), tr('否', 'common.no')));
      out.push(row(tr('错误', 'diag.label.error'), res.error));
      return out.join('\n');
    }
    const s = res.state;
    out.push(row(tr('已注入', 'diag.label.injected'), tr('是', 'common.yes')));
    out.push(row(
      tr('页面模块', 'diag.label.pageModule'),
      s.hasPageModule ? tr('已加载', 'diag.value.loaded') : tr('未加载', 'diag.value.notLoaded')
    ));
    out.push(row(
      tr('后台连接', 'diag.label.bridge'),
      s.bridgeAlive ? tr('正常', 'diag.value.alive') : tr('已失效', 'diag.value.dead')
    ));
    if (s.bridgeError) out.push(row(tr('连接错误', 'diag.label.bridgeError'), s.bridgeError));

    const sub = s.subtitle || {};
    out.push(section(tr('视频字幕', 'diag.section.videoSubtitles')));
    out.push(row(tr('状态', 'diag.label.status'), sub.status || '—'));
    // Raw code plus a readable gloss: whoever triages the issue needs to tell
    // "the video has no captions" from "our fetch failed" at a glance, and the
    // status alone does not say which.
    if (sub.reason) {
      out.push(row(
        tr('状态原因', 'diag.label.reason'),
        `${tr(emptyReasonLabel(sub.reason), 'reason.' + sub.reason)}（${sub.reason}）`
      ));
    }
    out.push(row(tr('视频 ID', 'diag.label.videoId'), sub.videoId || '—'));
    const tracks = sub.tracks || [];
    out.push(row(
      tr('字幕轨', 'diag.label.tracks'),
      tracks.length
        ? tr(`${tracks.length} 条：${tracks.map(trackLabel).join(', ')}`, 'diag.value.trackCount', {
            count: tracks.length,
            list: tracks.map(trackLabel).join(', '),
          })
        : tr('0 条', 'diag.value.noTracks')
    ));
    if (sub.sourceTrack) out.push(row(tr('当前字幕轨', 'diag.label.currentTrack'), trackLabel(sub.sourceTrack)));
    out.push(row(tr('字幕条数', 'diag.label.cueCount'), String(sub.cueCount || 0)));
    // Only meaningful when a track was attempted; it is the one number that
    // separates "the server sent nothing" from "we could not read what it sent".
    if (sub.trackBytes) {
      out.push(row(
        tr('字幕响应大小', 'diag.label.trackBytes'),
        tr(`${sub.trackBytes} 字节`, 'diag.value.bytes', { count: sub.trackBytes })
      ));
    }
    out.push(row(tr('已翻译', 'diag.label.translated'), String(sub.translated || 0)));
    out.push(row(tr('直播模式', 'diag.label.liveMode'), sub.liveMode ? tr('是', 'common.yes') : tr('否', 'common.no')));
    // `status: live` has two causes and the fix differs, so name which one this
    // is rather than leaving triage to infer it from a single status string.
    if (sub.status === 'live') {
      out.push(row(
        tr('模式来源', 'diag.label.modeSource'),
        sub.isLiveStream ? tr('直播间（预期行为）', 'diag.value.streamExpected') : tr('点播降级（PoToken 时序）', 'diag.value.vodDegraded')
      ));
    }
    // In realtime mode `字幕条数` is legitimately 0 — there is no cue list. On its
    // own that reads as "nothing worked" when lines may be flowing fine, so
    // report the counters that actually move. Counts only: this block is meant to
    // be pasted into a public issue, so it should not carry video dialogue.
    if (sub.live) {
      out.push(row(tr('实时已读行数', 'diag.label.liveLines'), String(sub.live.lines || 0)));
      out.push(row(tr('实时已译行数', 'diag.label.liveTranslated'), String(sub.live.translated || 0)));
      // The count above is 0 in two situations needing opposite advice: the
      // playhead is on silence (it will pass), or the player never created a
      // caption container (it never will). Without this row neither the reporter
      // nor a maintainer reading the issue can tell which one they have.
      if (sub.live.hasContainer === false) {
        out.push(row(tr('播放器字幕容器', 'diag.label.captionContainer'), tr('不存在 —— 实时兜底不可能读到任何一行', 'diag.value.containerMissing')));
      }
    }
    if (sub.error) out.push(row(tr('错误', 'diag.label.error'), sub.error));

    const p = s.page;
    out.push(section(tr('网页翻译', 'diag.section.pageTranslation')));
    if (p) {
      out.push(row(tr('状态', 'diag.label.status'), p.status || '—'));
      out.push(row(tr('已翻译', 'diag.label.translated'), `${p.done || 0}/${p.total || 0}`));
      out.push(row(tr('站点规则', 'diag.label.rule'), p.rule || '—'));
      out.push(row(tr('翻译风格', 'diag.label.profile'), profileLabel(p.profile) || '—'));
      if (p.error) out.push(row(tr('错误', 'diag.label.error'), p.error));
    } else {
      out.push(row(tr('状态', 'diag.label.status'), tr('页面模块未加载', 'diag.value.pageModuleMissing')));
    }

    out.push(section(tr('设置', 'diag.section.settings')));
    const provider = PROVIDERS[s.provider];
    out.push(row(tr('供应商', 'diag.label.provider'), provider ? provider.label : String(s.provider || '—')));
    out.push(row(tr('凭据就绪', 'diag.label.credentials'), s.providerReady ? tr('是', 'common.yes') : tr('否', 'common.no')));
    out.push(row(tr('目标语言', 'diag.label.targetLang'), labelOfLang(s.targetLang)));
    out.push(row(
      tr('总开关', 'diag.label.masterSwitch'),
      s.enabled ? tr('已启用', 'diag.value.enabled') : tr('已停用', 'diag.value.disabled')
    ));

    return out.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function inspectable(tab) {
    const url = tab.url || '';
    if (url.startsWith(OWN_URL)) return false;
    return /^https?:\/\//.test(url) || url.startsWith('file://');
  }

  async function fillTabs() {
    const select = $('target');
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const candidates = tabs.filter(inspectable);

    select.innerHTML = '';
    if (!candidates.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = tr('当前窗口没有可检查的网页', 'diag.noTabs');
      select.appendChild(o);
      return;
    }

    for (const t of candidates) {
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = t.title ? `${t.title.slice(0, 60)} — ${t.url}` : t.url;
      select.appendChild(o);
    }

    // Opened from the popup? Then it knows exactly which tab the user meant.
    const wanted = String(new URLSearchParams(location.search).get('tab') || '');
    if (wanted && candidates.some((t) => String(t.id) === wanted)) select.value = wanted;
  }

  async function refresh() {
    const id = Number($('target').value);
    $('copyState').textContent = '';
    if (!id) {
      $('report').textContent = tr('当前窗口没有可检查的网页。', 'diag.noTabsReport');
      $('verdict').dataset.tone = 'idle';
      $('verdictText').textContent = tr('换个窗口，或者先在要排查的页面上点一次扩展图标。', 'diag.noTabsHelp');
      return;
    }

    let tab = null;
    try {
      tab = await chrome.tabs.get(id);
    } catch (e) {
      /* tab closed between listing and reading */
    }
    if (!tab) {
      $('report').textContent = tr('页面已经关闭。', 'diag.tabClosed');
      return;
    }

    $('report').textContent = tr('检查中…', 'diag.checking');
    const res = await askContentScript(id);
    const verdict = verdictFor(res, tab);

    $('report').textContent = buildReport(res, tab);
    $('verdict').dataset.tone = verdict.tone;
    $('verdictText').textContent = verdict.text;
    $('report').dataset.ready = '1';
  }

  async function copy() {
    const text = $('report').textContent;
    const state = $('copyState');
    try {
      await navigator.clipboard.writeText(text);
      state.textContent = tr('已复制。粘贴到 Issue 里即可。', 'diag.copy.ok');
    } catch (e) {
      // Clipboard access can be denied; fall back to selecting the block so the
      // user can copy it by hand rather than being told "copied" when it was not.
      const range = document.createRange();
      range.selectNodeContents($('report'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      state.textContent = tr('无法自动复制，已为你选中，按 ⌘C / Ctrl+C 复制。', 'diag.copy.fallback');
      state.style.color = 'var(--warn)';
    }
  }

  (async function boot() {
    NS.i18n.apply();
    if (NS.i18n.isEnglish()) document.documentElement.lang = 'en';
    $('issue').href = ISSUE_URL;
    $('copy').addEventListener('click', copy);
    $('refresh').addEventListener('click', refresh);
    $('target').addEventListener('change', refresh);

    await fillTabs();
    await refresh();
  })();
})();
