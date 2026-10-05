# Lingua — 浏览器翻译扩展（YouTube 双语字幕 + 整页翻译）

高性能的 Chrome / Edge 扩展（Manifest V3）：

- **YouTube 双语字幕**：整片预取字幕，边播边翻，双语叠加在播放器上
- **整页翻译**：任意网站整页翻译，原文不被破坏，可随时还原
- 两者共用同一套翻译引擎与缓存

**核心特点**

- **可接入任意云端 API**：OpenAI 兼容接口、DeepL、Google、微软 Azure，以及一个完整的「自定义 API 模板」——任何 HTTP 翻译接口都能接。
- **整片预取 + 优先级调度**：进入视频即取回整条字幕轨，先翻播放位置附近，再向前推进；拖动进度条会自动重排优先级。
- **整页翻译按视口优先**：先翻屏幕内的段落，滚动时自动重新排优先级，动态加载的内容也会持续跟进。
- **快**：批量合并翻译（40 句 ≈ 3 个请求）、并发池、命中缓存则零请求、自适应降级修复漏译。
- **零构建**：不用打包器，直接「加载已解压的扩展程序」即可运行。

| 弹窗 · 视频字幕 | 弹窗 · 网页翻译 | 设置页 |
| --- | --- | --- |
| ![视频字幕](docs/popup.png) | ![网页翻译](docs/popup-page.png) | ![设置](docs/options.png) |

| 页面悬浮球（悬停展开） | 整页翻译 · 原文 + 译文 | 整页翻译 · 仅译文 |
| --- | --- | --- |
| ![悬浮球](docs/ball.png) | ![双语](docs/page-bilingual.png) | ![仅译文](docs/page-replace.png) |

---

## 一、为什么不能直接请求字幕接口

2025 年起，YouTube 给字幕接口 `/api/timedtext` 加上了 **PoToken**（BotGuard 生成、与视频 ID 绑定的证明令牌）。任何脱离页面的直接请求都会拿到 **HTTP 200 + 空 body**——不报错，只是空。

浏览器扩展有一个天然优势：**它就跑在已经解出这道题的页面里**。所以本扩展不去自己伪造 token，而是**复用播放器自己铸造的 `pot`**：

1. 从 `ytInitialPlayerResponse` 拿到轨道列表，**用 `audioTracks[].defaultCaptionTrackIndex` 定位视频的原始语言轨**（见下方「为什么必须选原始语言轨」）
2. 先用页面上下文直接请求该轨的 `baseUrl`（部分视频仍然可用）
3. 失败则**复用已经截获到的播放器的 `pot`**，把它合并进目标轨的 URL 再请求
4. 还没有 `pot` 就**主动触发一次播放器的字幕请求**（用播放器 API 切到目标轨 + 循环一次 CC 开关，原生字幕被我们的 CSS 隐藏所以用户看不到闪烁），截获它的 `pot` 后重试
5. 再兜底 `/youtubei/v1/get_transcript`
6. 直播场景读取页面已渲染的字幕行做实时翻译

对应代码：`src/content/inject.js`（MAIN world 拦截）与 `src/content/youtube.js` 的 `extractCues()`。

**为什么必须选原始语言轨**：实测某个视频有 22 条轨，其中唯一的「非自动生成」轨 `zh-Hant` 只包含**前 34 秒**的翻译内容，而 `defaultCaptionTrackIndex` 指向的 `en/asr` 覆盖了**全部 336 秒**。按「优先人工字幕」的直觉去选，反而会挑到残缺的轨。

**贴片广告**：广告播放期间 `movie_player.getPlayerResponse()` 返回的是**广告自己的**播放器响应，轨道和时长都属于广告。所以检测到 `#movie_player.ad-showing` 时会先等广告放完再加载字幕。

---

## 二、安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本目录 `yt-subtitle-translator/`
4. 首次安装会自动打开设置页；填入翻译服务后即可使用

> 需要 Chrome 111+（用到了 content script 的 `world: "MAIN"`）。

---

## 三、配置翻译服务

### 3.1 OpenAI 兼容（推荐，覆盖面最广）

设置页 →「翻译服务」→ 选 **OpenAI 兼容**，点击预设按钮一键填充，再填 API Key。

内置预设：

| 服务 | Base URL | 默认模型 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-2.0-flash-exp:free` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5:7b` |
| LM Studio（本地） | `http://localhost:1234/v1` | `local-model` |

任何实现 `/chat/completions` 的网关（one-api / new-api / vLLM / LiteLLM…）都可以直接填 Base URL 使用。

### 3.2 DeepL / Google / 微软

- **DeepL**：填 API Key 即可（Free 与 Pro 的接口地址不同，设置里可改）。
- **Google**：留空 Key 走免费网页接口；填 Google Cloud Translation v2 的 Key 则走官方接口。
- **微软 Azure**：填 Subscription Key 与区域。

### 3.3 自定义 API 模板

选择「自定义 API 模板」，用占位符拼装任意接口：

| 占位符 | 含义 |
| --- | --- |
| `{{text}}` | 整批字幕文本（已编号的多行字符串） |
| `{{texts}}` | 原始句子数组（JSON 字面量）——出现它即切换为「数组模式」 |
| `{{from}}` / `{{to}}` | 语言代码 |
| `{{source}}` / `{{target}}` | 语言名称 |
| `{{key}}` | API Key |

占位符可用于 **请求地址、请求头、请求体** 三处。

**示例 A — 返回编号文本的自建接口**

```
POST https://api.example.com/translate
Body: { "text": "{{text}}", "source": "{{from}}", "target": "{{to}}" }
响应取值路径: (留空)
```

只要接口按 `1. …\n2. …` 的编号格式返回，就会自动对齐到原句。

**示例 B — 返回数组的接口**

```
POST https://api.example.com/v1/translate
Body: { "q": {{texts}}, "target": "{{to}}" }
响应取值路径: data.translations
```

数组长度与输入句数一致时按索引对齐。

**示例 C — 带 Bearer 鉴权**

```
Headers: { "Authorization": "Bearer {{key}}", "Content-Type": "application/json" }
```

---

## 四、整页翻译

点击扩展图标 → 切到「网页翻译」标签 → 打开「翻译此页面」。也可在设置里开启自动翻译，或用弹窗的「本站规则」按域名单独设置。

### 页面悬浮球

页面上常驻一个可拖动的悬浮球，**点一下就开始翻译**，不用再去点工具栏图标：

| 操作 | 行为 |
| --- | --- |
| 单击 | 开始 / 停止翻译 |
| 悬停 | 向左展开操作面板：显示原文 · 重新翻译 · 关闭 |
| 拖动 | 移动位置，**按站点记住**（松手自动吸附到最近的左右边缘） |
| 右键 | 直接打开设置 |

球的外圈就是进度环——翻译时显示进度，不需要额外的进度条。状态用颜色区分：灰=未翻译，橙=翻译中/已翻译，红=出错，完成后右上角有一个小绿点。

整个球活在 **Shadow DOM** 里，站点的样式进不来，球的样式也漏不出去。设置页和弹窗里都可以关掉它。

### 它是怎么决定翻译哪些内容的

这是整页翻译最容易做坏的地方。规则是：

> 一个元素是「翻译单元」 ⟺ 它的子树里没有任何块级元素，且它不是布局关键容器（flex / grid / display:contents）

由此自然得到几个正确行为：

| 页面结构 | 结果 |
| --- | --- |
| `<p>Hello <b>bold</b> world</p>` | 合成**一个**单元（`Hello bold world`），不会碎成三段 |
| `<div class="flex"><span>Label</span><span>Value</span></div>` | flex 容器被排除，两个 span 各自成为单元 —— **flex 布局完全不受影响** |
| `<button>Platform<svg/></button>`（`display:flex`） | **容器自己的文本也会被翻译**：只把那段文本节点包进一个行内 span，位置正好顶替原来的匿名 flex item，布局不变 |
| `<nav><a>Home</a><a>About</a></nav>` | nav 只作容器，两个链接各自成单元（否则会被合并成一句） |
| `<div><p>a</p><p>b</p></div>` | 外层 div 只作容器，两个 p 各自成单元 |
| `<pre>` `<code>` `<textarea>` `<script>` | 直接跳过 |
| `translate="no"` / `.notranslate` / `contenteditable` | 整棵子树跳过 |
| 纯数字、纯符号、单字符 | 不发请求 |
| 视频播放器区域 | 内置忽略（`.html5-video-player` 等） |

### 两个反直觉的坑

**① flex/grid 会把子元素「块级化」。** 一个 `<span>` 一旦成为 flex item，它的 computed `display` 就变成 `block`。如果拿 computed display 去判断「这个子元素是不是块级边界」，就会把普通的 flex 容器误判成容器，导致**容器自己的文本被整段跳过** —— GitHub 导航栏的 `Platform` 按钮就是这么漏掉的。修法是：父元素是 flex/grid 时，不用 computed display 判断子元素是否分隔内容。

**② 「仅译文」模式会连超链接一起藏掉。** 把原文整体隐藏，里面的 `<a>` 自然也看不见了。

解法是**占位符对齐**：把链接包成 `⟦1⟧链接文字⟦/1⟧` 一起送去翻译，提示词要求模型原样保留标记，译文回来后按标记重建，于是**译文里也有可点的链接**：

```
输入  Read the ⟦1⟧documentation⟦/1⟧ for details.
译文  详情请阅读⟦1⟧文档⟦/1⟧。
渲染  <p><span class="lingua-pg-dst">详情请阅读<a href="…">文档</a>。</span></p>
```

实测 Wikipedia：**453 段里 427 段真正替换了原文**（此前只有 75 段），**519 个链接全部可见可点**，链接文字也跟着翻译了（`Donate` → `捐赠`）。

**模型偶尔会写坏标记**（实测 519 个链接里出现 1 次：`⟦1⟧X⟦/1⟧` 被写成 `X⟧/1⟧`）。这时**该段落自动退回「保留原文 + 译文」**，链接照常可用，并且会清洗掉残缺标记——绝不会在页面上留下 `⟦` 之类的乱码。

设置页可以三选一：「译文里保留链接」（默认）/「保留原文 + 译文」/「严格替换（链接会丢失）」。

### 搬元素，不克隆元素

重建译文时**必须搬运真实的元素，不能用 `cloneNode()`**。克隆体只复制属性、**不复制事件监听器**，会静默废掉挂在元素上的一切：悬浮预览、SPA 路由、埋点统计。

搬运时记录原始父节点与位置，还原时精确放回；同时**文字没变化就一个字节都不动**——引用标注 `[1]`、数字、代码这类内容本来就不需要翻译，保持原样意味着它的内部结构和事件完全不受影响。

### 搬运的必须是「原子行内单元」，而不是 `<a>` 本身

Wikipedia 的引用标注长这样：

```html
<sup class="reference"><a href="#cite_note-1">[1]</a></sup>
```

如果只把 `<a>` 搬进译文，它的父级 `<sup>` 会留在原地（隐藏的原文里）——整个引用标注连同挂在 `<sup>` 上的悬浮预览就一起消失了。实测修复前 **50 个引用标注有 44 个留在隐藏原文里、0 个在译文中**。

所以标记时要向上找到「只为包裹这个链接而存在」的最外层行内元素：父元素是行内元素、且只有这一个有意义子节点时继续上溯。修复后 **44/50 进入译文，0 个残留**。

### 渲染方式

**原文永远不会被破坏。**

- **原文 + 译文**：把译文追加为 `<span class="lingua-pg-dst">`，原文原封不动
- **仅译文**：把原有子节点整体搬进 `<span class="lingua-pg-src">` 再用 CSS 隐藏 —— 所以「显示原文」只是切换一个 class，没有 DOM 重建，也不会有闪烁

译文配色用 `currentColor` 派生，因此在浅色站、深色站、自定义主题站上都能保证可读性，无需知道对方的调色板。

### 性能

- 按视口中心距离排序，先翻看得见的；滚动时重新排序
- 按**字符预算**分批（默认每批 12 段 / 1400 字），避免长段落把一批撑爆
- `MutationObserver` + 700ms 防抖跟进动态内容（SPA、无限滚动）
- 与字幕共用同一份缓存，重复句子零请求

---

## 五、性能设计

| 手段 | 位置 | 效果 |
| --- | --- | --- |
| 整片预取字幕轨 | `youtube.js` `extractCues()` | 一次拿到全部 cue，与播放进度解耦 |
| 批量合并翻译 | `subtitles.js` `buildBatchText` | 每批 16 句合并为一个请求，请求数降为 1/N |
| 并发池 | `translator.js` `pool()` | 可配置并发（默认 4），实测 40 句 3 个请求 |
| 优先级调度 | `youtube.js` `nextChunk()` | 按「距播放位置的加权距离」排序，先翻看得见的 |
| 自适应降级修复 | `translator.js` `translateChunk()` | 模型漏译某行 → 自动折半重试；4xx 致命错误不重试 |
| 两级缓存 | `background/cache.js` | 内存 LRU + `storage.local` 持久化，命中即 0 请求 |
| 渲染只在换行时写 DOM | `overlay.js` `tick()` | rAF + 二分查找，每帧最多几次整数比较，无布局抖动 |
| 直播实时模式 | `live.js` | 220ms 轮询 + 120ms 稳定判定 + 本地去重缓存 |
| 整页按视口排序 | `page/index.js` `nextChunk()` | 先翻屏幕内的段落，滚动时重新排序 |
| 整页按字符预算分批 | `page/index.js` | 长段落不会把一批撑爆（默认 24 段 / 2400 字） |
| 动态内容跟进 | `page/index.js` `onMutations()` | MutationObserver + 700ms 防抖，跳过已翻译块 |

### 首屏延迟做了哪些优化

| 优化 | 效果 |
| --- | --- |
| 字幕获取的「直取」与「让播放器去取」**并行** | 冷启动时直取必然返回空，串行等于白等一个来回；并行省下约 1 秒 |
| **首个翻译批次只有 4 句** | 用户盯着空 overlay 时，1 秒出 4 句好过 3 秒出 16 句；后续批次恢复正常大小 |
| 整页翻译在 **DOMContentLoaded** 就开始 | 不再等 `load`（重页面可能晚好几秒）；后到的内容交给 MutationObserver |
| 整页批量提到 24 段 / 2400 字、3 路并发 | 每次调用在后台再拆成多个子批并发发出 |
| **默认关闭模型推理** | 见下节，实测约 2 倍加速 |

实测：Wikipedia 447 段从约 60 秒 → 2.0 秒 → **1.0 秒**。

### 默认关闭模型推理

翻译任务没有歧义，推理模型的「思考」纯属浪费。实测同一批 16 句：

| | 延迟 | 推理 tokens | 译文行数 |
| --- | --- | --- | --- |
| 不传参数 | 2460ms | 1188 | 48/48 |
| **发送关闭推理的参数** | **1228ms** | **0** | 48/48 |

所以扩展默认会发送「不要思考」的参数。但**各家服务商的参数名不一样**（OpenAI 用 `reasoning_effort`、Anthropic / 智谱 / Kimi 用 `thinking`、通义用 `enable_thinking`），而**发送不认识的字段可能直接返回 HTTP 400**。

因此这里做了**自动回退**：默认发送最通用的两个参数，一旦接口以 400/422 拒绝，就自动去掉参数重试一次，并在本次会话内不再发送。这样既能拿到加速，又不会因为参数不被识别而把翻译打挂。

设置页 → 翻译服务 → 模型推理，可以切回「跟随模型默认」。若模型只输出推理内容而没有译文，也会给出明确提示。

---

## 六、目录结构

```
yt-subtitle-translator/
├── manifest.json                  MV3 清单
├── icons/                         16/32/48/128 图标
├── docs/                          界面与效果截图
├── scripts/
│   ├── make-icons.py              纯 stdlib 图标生成（4x 超采样）
│   ├── test-core.mjs              核心逻辑测试（66 项，无需浏览器）
│   ├── test-dom.mjs               段落识别测试（29 项，真实浏览器）
│   └── preview.mjs                无头 Chrome 渲染检查 + 截图
└── src/
    ├── shared/                    后台与内容脚本共用（零构建关键）
    │   ├── constants.js           服务商/语言/默认设置/消息类型
    │   ├── utils.js               hash、retry、pool、deepMerge、getPath
    │   ├── settings.js            chrome.storage 读写 + 变更订阅
    │   └── subtitles.js           json3/srv3/xml 解析、去重、批量拼装/还原
    ├── background/
    │   ├── sw.js                  Service Worker 入口（importScripts）
    │   ├── translator.js          缓存 → 分块 → 并发 → 重试 → 降级修复
    │   ├── cache.js               两级缓存
    │   └── providers/             openai / deepl / google / microsoft / custom
    ├── content/
    │   ├── inject.js              【MAIN world】拦截 timedtext / player 响应
    │   ├── bridge.js              MAIN ↔ 隔离世界 ↔ 后台 的桥 + 上下文失效检测
    │   ├── youtube.js             轨道发现、cue 提取、字幕优先级调度
    │   ├── overlay.js             字幕叠加层（rAF + 二分查找）
    │   ├── live.js                直播/无轨道时的实时兜底
    │   ├── store.js               字幕与状态存储
    │   ├── page/
    │   │   ├── units.js           段落识别规则（翻译什么 / 绝不碰什么）
    │   │   ├── render.js          双语叠加、链接重建与还原
    │   │   ├── ball.js            页面悬浮球（Shadow DOM，可拖动，带进度环）
    │   │   └── index.js           整页调度：视口优先级 + 字符预算分批
    │   └── main.js                内容脚本入口
    ├── popup/                     工具栏弹窗（视频字幕 / 网页翻译 双标签）
    ├── options/                   完整设置页
    └── ui/theme.css               共享设计系统
```

### 关于「零构建」

MV3 的 Service Worker 支持 `importScripts`，内容脚本则只能加载普通脚本。因此 `src/shared/*.js` 统一写成**注册到 `globalThis.YTST` 的经典脚本**：Service Worker 用 `importScripts` 加载，内容脚本通过 `manifest.json` 的 `js` 数组加载，两边复用同一份源码，不需要任何打包步骤。

---

## 七、开发

```bash
npm test            # 核心逻辑测试（66 项，无需浏览器、无依赖）
npm run test:dom    # 段落识别测试：在真实 Chrome 里跑 units.js（36 项）
npm run test:e2e    # 真机端到端：起本地假接口 + 加载扩展 + 真实 HTTP 页面（20 项）
npm run inspect     # 连接你正在用的 Chrome，读某个页面里扩展的真实状态
npm run icons       # 重新生成图标
npm run preview     # 无头 Chrome 渲染弹窗、设置页与整页翻译效果并截图
```

`npm test` 不需要浏览器，也不需要安装任何依赖。其余脚本需要本机装有 Chrome。

### 排查「某个页面里扩展到底怎么了」

这是最省时间的工具。它直接读内容脚本隔离世界里的真实状态，而不是靠猜：

```bash
# 先用带远程调试的方式启动 Chrome（或在 chrome://inspect/#remote-debugging 里勾选授权）
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
npm run inspect -- youtube.com
```

输出示例：

```
=== https://www.youtube.com/watch?v=xxxx
  overlay nodes      1
  page dst/src       0 / 0
  has page module    true
  bridge alive       true
  subtitle status    ready
  tracks             22 [ar/asr, pl/asr, de-DE/asr, ...]
  source track       en/asr
  cues               163 (translated 163)
  first cue          This video is sponsored by Autodesk
  first trans        本期视频由 Autodesk 赞助
```

`scripts/lib/cdp.mjs` 是自带的零依赖 CDP 客户端（Node 内置 WebSocket 会被 Chrome 拒绝，所以用 `node:net` 手写了握手与帧解析）。

---

## 八、常见问题

**「翻译失败：Extension context invalidated.」**

这是浏览器扩展的通用现象：在 `chrome://extensions` 里**重新加载/更新扩展**后，已经打开的页面里仍然跑着**旧版本的内容脚本**，它调用 `chrome.runtime` 时会抛这个错。

本扩展的做法是：检测到扩展上下文失效（`chrome.runtime.id` 消失）就**立即熔断**，并在播放器/页面上提示「扩展已更新，请刷新本页面后继续使用」，而不会把它当成普通翻译失败去无限重试。

**解决办法：刷新那个页面即可**（F5）。开发时每次改完代码 reload 扩展，都需要刷新页面。

**其他常见情况**

| 现象 | 原因与处理 |
| --- | --- |
| YouTube 显示「无字幕」 | 该视频确实没有字幕轨；或页面刚打开、播放器还没返回轨道，稍等或刷新 |
| 字幕只覆盖了视频开头一段 | 大概率是正在播放**贴片广告**（广告期间拿到的是广告的轨道）；等广告结束会自动重新加载 |
| 整页翻译漏了某些区域 | 该区域被识别为布局容器（flex/grid）或命中了忽略规则；可在设置里查看/调整「忽略选择器」 |
| 接口报 401 / 403 | API Key 或 Base URL 不对；用设置页的「测试连接」验证 |
| 接口报 429 | 触发限流；降低「并发请求数」，扩展本身也会自动退避重试 |
| 模型只输出推理内容、没有译文 | 在设置页把「模型推理」设为关闭，或换用非推理模型（如 `deepseek-chat`） |
| 提示「扩展已更新或重新加载」 | 在 `chrome://extensions` 重载扩展后，已打开的页面需要刷新一次 |

---

## 九、已知限制

- YouTube 字幕只在 `youtube.com` / `youtube-nocookie.com` 的播放页工作。
- 整页翻译暂不处理 iframe 内部（只在顶层文档运行），也不翻译图片内的文字。
- 直播场景的字幕走实时逐句翻译，质量与延迟不如点播的整片预取模式。
- `<all_urls>` 主机权限是整页翻译与「自定义 API 模板」所必需的；若只想要 YouTube 字幕，可把 `manifest.json` 里第三个 `content_scripts` 条目与 `<all_urls>` 一并删掉。
- 修改「服务商 / 语言 / 批量 / 并发」会触发当前页重新加载字幕；修改字号、对齐、译文样式等仅实时生效。
- 缓存不区分模型版本，换模型后如需重翻，可在设置页清空缓存。

---

## 十、设计取舍记录

- **为什么用编号批量而不是 JSON 数组？** 编号文本对模型的容错更高，且解析失败时可逐行回退；数组模式下模型少一个元素就会整体错位。
- **为什么把翻译放后台而不是内容脚本？** 内容脚本的 `fetch` 受页面 CORS 约束，无法请求任意第三方接口；后台有 `host_permissions` 可以直接请求。
- **为什么用长连接 port？** MV3 Service Worker 会在空闲时被回收，长连接能在整个翻译会话中保持存活，并把进度事件流式回传。
- **为什么默认隐藏原生字幕？** 双语叠加会和 YouTube 原生字幕重叠；若取字幕走了「截获播放器请求」的兜底路径，原生字幕需要在 DOM 中保持开启（用 `opacity:0` 隐藏而非移除），否则播放器不再发起请求。
- **整页翻译为什么按「元素」而不是「文本节点」分组？** 按文本节点会把 `<p>Hello <b>world</b></p>` 拆成两段、丢失语境；按元素分组则能把整个行内文本流作为一个单元，代价是需要显式排除 flex/grid 这类布局容器。
- **整页翻译为什么坚持不破坏原文？** 「仅译文」模式用包裹 + CSS 隐藏实现，而不是直接覆盖文本，这样「显示原文」只是切 class，没有 DOM 重建、没有闪烁，也不会因为翻译失败而永久丢失原文。
- **为什么翻译失败的句子回退成原文而不是留空？** 用户至少能看到内容；同时用连续失败熔断（3 次）避免坏 key 把接口打爆。
- **扩展重载后旧页面怎么办？** 内容脚本会检测到 `chrome.runtime.id` 消失（即 "Extension context invalidated"），立即熔断并提示刷新页面，而不是把错误当成普通翻译失败无限重试。
- **进度消息为什么必须单独处理？** 长连接上既有「进度」又有「最终结果」两类消息。进度消息没有 `ok` 字段，如果让它穿透到最终响应的分支，就会被当成失败去 reject —— 表现是「前几批能翻、之后突然报翻译失败」。
- **为什么用播放器的 `pot` 而不是自己算？** BotGuard 的挑战需要一整套 VM，自己算既复杂又容易随 YouTube 更新失效；播放器已经把 token 拿到手了，直接复用最稳，而且实测该 token 绑定的是「视频+会话」而非具体轨道，可以跨轨复用。
- **为什么宁可选原始语言轨也不选人工字幕？** 人工轨未必完整（实测有一条只覆盖 34/336 秒），而原始语言轨是播放器自己依赖的轨，完整性有保证。用户仍可在弹窗里手动指定源语言覆盖这一默认行为。
- **为什么 flex 容器自己的文本要单独处理？** 直接在 flex 容器里追加一个块级译文会变成一个 flex item、改变布局；而把**它自己的文本节点**包进一个行内 span 是布局中性的（正好顶替原来的匿名 flex item）。代价是译文只能行内排布，双语模式下按钮可能因此变宽换行——这是双语模式的固有代价。
- **为什么「仅译文」不直接隐藏原文了事？** 隐藏原文会连带隐藏 `<a>`，用户就再也点不到链接。所以用占位符把链接保护起来、译文里重建；一旦模型写坏标记就退回双语，并把开关交给用户。
- **为什么占位符用 `⟦⟧` 这种少见字符？** 它必须足够罕见，才不会和正文冲突；同时在提示词里明确「原样保留」后，模型对成对标记的保留率很高（实测 519 个链接只坏 1 个）。
- **为什么搬运真实元素而不是克隆？** 克隆只复制属性、不复制监听器。译文里的链接如果点不动、悬浮没反应，用户会觉得「翻译把页面搞坏了」——比不翻译更糟。搬运 + 记录位置 + 精确还原，代价是多一点簿记，换来的是页面行为完全不受影响。
- **为什么「文字没变就不动」？** 引用标注 `[1]`、数字、代码这类内容翻译后和原文一模一样，此时去改写 DOM 只有坏处没有好处。保持原样 = 结构、属性、事件全部零损失。
- **为什么首屏优化选「小批次优先」而不是「更大并发」？** 并发受限于接口限流，而且用户感知的是**第一句出现的时间**，不是全部翻完的时间。先把 4 句放上屏幕，剩下的慢慢补。
- **为什么关闭推理要带自动回退？** 各家关闭推理的参数名不统一，而发送不认识的字段有接口会直接 400。默认关闭 + 400 时自动去掉参数重试，等于「有加速就拿，拿不到也不出错」，比让用户自己去查各家文档靠谱。
