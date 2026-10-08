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
    return `  ${pad(label, 14)}${value}`;
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

  function browserLine() {
    const ua = navigator.userAgent;
    const m = /(Edg|Chrome|Chromium)\/([\d.]+)/.exec(ua);
    const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    const name = m ? `${m[1]} ${m[2]}` : '未知浏览器';
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
            resolve({ ok: false, error: (err && err.message) || '内容脚本没有响应' });
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
        text: '内容脚本没有响应，后面几项无法检查。常见原因：这个页面在安装或更新扩展之前就已经打开（刷新本页即可），或者它是受限制的页面（chrome://、扩展商店等）。',
      };
    }
    const s = res.state;
    if (s.bridgeAlive === false) {
      return {
        tone: 'err',
        text: '内容脚本在，但扩展的后台上下文已经失效——多半是刚更新或重新加载过扩展。刷新本页即可恢复。',
      };
    }

    const sub = s.subtitle || {};
    if (!s.isWatchPage) {
      return {
        tone: 'idle',
        text: '当前不是 YouTube 视频播放页，所以不会加载字幕；网页翻译不受影响。',
      };
    }
    if (sub.error) {
      return { tone: 'err', text: `取字幕时报错：${sub.error}` };
    }
    if (sub.status === 'loading') {
      return { tone: 'idle', text: '正在读取字幕轨，稍等几秒再点一次「重新检查」。' };
    }
    if (sub.status === 'idle') {
      return {
        tone: 'idle',
        text: '字幕翻译当前是关闭的。检查弹窗里的「翻译视频字幕」开关，以及设置页的总开关。',
      };
    }
    if (!sub.cueCount) {
      return {
        tone: 'warn',
        text: '页面已连通，但一条字幕轨都没找到。可能是这个视频确实没有字幕；如果你确认它有，那就是 YouTube 改了字幕接口——这正是最需要上报的情况。',
      };
    }
    if (!s.providerReady) {
      return {
        tone: 'warn',
        text: `字幕已取到 ${sub.cueCount} 条，但没有配置翻译服务，所以不会翻译。去设置页填写凭据。`,
      };
    }
    if (!sub.translated) {
      return {
        tone: 'warn',
        text: `字幕已取到 ${sub.cueCount} 条，但一条都没翻译成功。多半是接口报错（Key、额度或网络）——去设置页点「测试连接」看看。`,
      };
    }
    return { tone: 'ok', text: `看起来正常：${sub.translated}/${sub.cueCount} 条字幕已翻译。` };
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  function buildReport(res, tab) {
    const out = [];
    out.push(`Lingua ${chrome.runtime.getManifest().version}`);
    out.push(row('生成时间', stamp()));
    out.push(row('浏览器', browserLine()));

    out.push(section('页面'));
    out.push(row('地址', (tab && tab.url) || '—'));
    if (res.ok) {
      out.push(row('站点', res.state.host || '—'));
      out.push(row('视频播放页', res.state.isWatchPage ? '是' : '否'));
    }

    out.push(section('内容脚本'));
    if (!res.ok) {
      out.push(row('已注入', '否'));
      out.push(row('错误', res.error));
      return out.join('\n');
    }
    const s = res.state;
    out.push(row('已注入', '是'));
    out.push(row('页面模块', s.hasPageModule ? '已加载' : '未加载'));
    out.push(row('后台连接', s.bridgeAlive ? '正常' : '已失效'));
    if (s.bridgeError) out.push(row('连接错误', s.bridgeError));

    const sub = s.subtitle || {};
    out.push(section('视频字幕'));
    out.push(row('状态', sub.status || '—'));
    out.push(row('视频 ID', sub.videoId || '—'));
    const tracks = sub.tracks || [];
    out.push(row('字幕轨', tracks.length ? `${tracks.length} 条：${tracks.map(trackLabel).join(', ')}` : '0 条'));
    if (sub.sourceTrack) out.push(row('当前字幕轨', trackLabel(sub.sourceTrack)));
    out.push(row('字幕条数', String(sub.cueCount || 0)));
    out.push(row('已翻译', String(sub.translated || 0)));
    out.push(row('直播模式', sub.liveMode ? '是' : '否'));
    if (sub.error) out.push(row('错误', sub.error));

    const p = s.page;
    out.push(section('网页翻译'));
    if (p) {
      out.push(row('状态', p.status || '—'));
      out.push(row('已翻译', `${p.done || 0}/${p.total || 0}`));
      out.push(row('站点规则', p.rule || '—'));
      out.push(row('翻译风格', (p.profile && p.profile.label) || '—'));
      if (p.error) out.push(row('错误', p.error));
    } else {
      out.push(row('状态', '页面模块未加载'));
    }

    out.push(section('设置'));
    const provider = PROVIDERS[s.provider];
    out.push(row('供应商', provider ? provider.label : String(s.provider || '—')));
    out.push(row('凭据就绪', s.providerReady ? '是' : '否'));
    out.push(row('目标语言', labelOfLang(s.targetLang)));
    out.push(row('总开关', s.enabled ? '已启用' : '已停用'));

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
      o.textContent = '当前窗口没有可检查的网页';
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
      $('report').textContent = '当前窗口没有可检查的网页。';
      $('verdict').dataset.tone = 'idle';
      $('verdictText').textContent = '换个窗口，或者先在要排查的页面上点一次扩展图标。';
      return;
    }

    let tab = null;
    try {
      tab = await chrome.tabs.get(id);
    } catch (e) {
      /* tab closed between listing and reading */
    }
    if (!tab) {
      $('report').textContent = '页面已经关闭。';
      return;
    }

    $('report').textContent = '检查中…';
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
      state.textContent = '已复制。粘贴到 Issue 里即可。';
    } catch (e) {
      // Clipboard access can be denied; fall back to selecting the block so the
      // user can copy it by hand rather than being told "copied" when it was not.
      const range = document.createRange();
      range.selectNodeContents($('report'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      state.textContent = '无法自动复制，已为你选中，按 ⌘C / Ctrl+C 复制。';
      state.style.color = 'var(--warn)';
    }
  }

  (async function boot() {
    $('issue').href = ISSUE_URL;
    $('copy').addEventListener('click', copy);
    $('refresh').addEventListener('click', refresh);
    $('target').addEventListener('change', refresh);

    await fillTabs();
    await refresh();
  })();
})();
