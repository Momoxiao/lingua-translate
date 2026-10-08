# 上架提交材料（Chrome Web Store / Edge Add-ons）

两个商店的表单字段高度重合，所以这里只写一份，标注差异处。**可以直接复制粘贴到后台。**

配套文件：[`PRIVACY.md`](../PRIVACY.md)（两个商店都要的那个 URL）。

---

## 一、先纠正一个前提

「Edge 免费，所以可以先绕开隐私政策」**不成立**。Edge 后台的提交流程里有一段 **Privacy** 页（Single Purpose / Permission justification / Remote code / Data usage / Privacy policy），和 Chrome 的 Privacy practices 是一回事；只要扩展会读取或传输用户数据，就必须给一个可访问的隐私政策 URL，否则连提交都不允许。

所以结论反而更简单：**隐私政策是两个商店共同的、也是唯一共同的硬前置。写一次，两边用。**（已经写好了，见 `PRIVACY.md`。）

| | Chrome Web Store | Edge Add-ons |
|---|---|---|
| 开发者费用 | 一次性 $5（按账号，不按扩展） | 免费 |
| 账号额外要求 | Google 账号必须开两步验证 | Microsoft 账号 |
| 隐私政策 URL | 必须 | 必须（处理用户数据时） |
| 单句用途 / 权限理由 / 数据用途声明 | 必须 | 必须 |
| EU 交易者身份声明 | 必须 | — |
| 截图 | 1–5 张，1280×800 或 640×400 | 最多 6–10 张，640×480 或 1280×800 |
| 图标 | 128×128 | 300×300 推荐（最小 128×128） |
| 审核时长 | 通常几小时–3 天；**首次发布且带宽泛主机权限会转人工，可能数周** | 数天 |

---

## 二、时间线建议

`<all_urls>` 会把 Chrome 的审核推进人工队列，这是唯一一个「不以你的意志为转移」的耗时项。所以：

1. **尽早交 Chrome**——付费、提交、排队。被拒也没关系，拒信会写明是哪条政策，当天改完重交。占住队列比打磨文案重要。
2. **Edge 并行提交**，不占队列成本。
3. 两个链接都拿到之后再去找人试用。此时「装上试试」是一句话，而不是让对方去 `chrome://extensions` 打开开发者模式、拖目录。

---

## 三、可直接粘贴的字段

### 单句用途（Single purpose）

> 把网页与 YouTube 视频字幕翻译成用户指定的语言，使用用户自行配置的翻译服务。

> Translates web pages and YouTube video subtitles into the user's chosen language, using a translation service the user configures.

### 摘要（≤132 字符，改 `manifest.json` 的 `description` 即可同步）

现用值 104 字符，合规，无需改动：

> YouTube 双语字幕 + 网页翻译。接入你自己的翻译服务（OpenAI 兼容 / DeepL / Google / 微软 / 自定义供应商）：全片预取、并发翻译、缓存加速；网页译文不破坏原文，随时可还原。

### 详细描述

> Lingua 是一个不代替你做决定、也不替你保管凭据的翻译扩展。
>
> **视频字幕**：在 YouTube 上叠加双语字幕（或只显示译文 / 只显示原文）。整片预取 + 并发翻译 + 本地缓存，首屏先出 4 句，剩下的边看边补。支持手动字幕轨与自动生成轨，可在弹窗里手动指定源语言。
>
> **网页翻译**：双语或仅译文两种模式。译文不覆盖原文，用包裹 + CSS 实现，「暂时收起译文」是一键切换、无闪烁、不会因为翻译失败而丢原文。会按页面类型自动选择语体（技术文档 / 学术论文 / 新闻 / 社区讨论 / 电商 / 通用），保留 API 名、引用标注、代码标识符与真实链接——译文里的链接是可以点的那个**原元素本身**，不是复制品。
>
> **翻译服务由你自带**：OpenAI 兼容（OpenAI、DeepSeek、Kimi、智谱、通义、硅基流动、OpenRouter、Groq，以及自建的 Ollama、LM Studio、one-api）、DeepL、Google、微软 Azure，或任意 HTTP 接口（自己写 URL、方法、请求头、请求体模板与取值路径）。**凭据只存在本地，不经过任何第三方服务器。**
>
> **出问题的时候不用靠猜**：内置诊断页能读出扩展在当前页面上走到了哪一步——内容脚本是否注入、后台连接是否存活、找到几条字幕轨、取到几条字幕、翻译卡在哪一层，一键复制成可粘贴的文本。
>
> 开源、无埋点、无账号、无自建后端。

### 权限理由（后台逐条填写）

| 权限 | 填这一段 |
|---|---|
| `storage` | Saves the user's settings, their own translation-service credentials, and a local translation cache. All of it stays in `chrome.storage.local`; it is never uploaded anywhere. |
| `*://*.youtube.com/*`、`*://*.youtube-nocookie.com/*` | Required to read the caption tracks the player has already loaded and to draw the bilingual subtitle overlay on top of the player. Runs only on these two domains. |
| `<all_urls>` | Web-page translation must run on whatever site the user chooses to translate, and that is a per-site decision the user makes inside the extension (the floating ball, or a per-site "always translate" rule). Two of the supported providers (Microsoft Azure, and the user-defined custom provider) have endpoints the user types in themselves, so no narrower host list can cover them. **The extension never scans a page in the background** — nothing is read until the user starts translation on that page. |

### 数据用途声明（Data usage 勾选）

- 收集身份信息？**否**
- 收集健康信息？**否**
- 收集财务/支付信息？**否**
- 收集**认证信息**？**否**——凭据由用户自己填写，只存在本地，只发往用户选定的那一个服务
- 收集**个人通信**？**否**
- 收集**位置信息**？**否**
- 收集**网页浏览活动**？**否**——页面地址仅在本地用于判断站点规则，不上传、不记录
- 收集**网站内容**？**是**——仅限「用户主动发起翻译的那一页 / 那条视频」的正文或字幕文本，发往**用户自己配置的翻译服务**。不收集、不留存、不转售。
- 出售用户数据？**否**
- 将数据用于与单一用途无关的目的？**否**
- 将数据用于判定信用度或放贷？**否**
- 使用远程代码？**否**（Manifest V3，全量打包）

---

## 四、素材清单与现状

| 素材 | 要求 | 现状 |
|---|---|---|
| 图标 | 128×128 PNG | ✅ `icons/icon128.png` 正好 128×128 |
| 商店图标（Edge 单独上传） | 300×300 推荐 | ✅ `store/icon-300.png`，按 300×300 单独重绘，未放大 128×128 |
| 小促销图（可选） | 440×280 | ✅ `store/promo-440x280.png`，由 `npm run release:assets` 生成 |
| 大幅促销图（可选） | 1400×560 | ✅ `store/promo-1400x560.png`，由 `npm run release:assets` 生成 |
| **截图** | **Chrome：1280×800 或 640×400；Edge：640×480 或 1280×800** | ✅ `store/screenshots/` 5 张，全部 1280×800、无 alpha |

截图已经不缺了：`store/screenshots/` 下 5 张是**按商店尺寸重新构图**的，不是缩放
出来的，且全部恰好 1280×800（商店要的 16:10）、无 alpha 通道。
用 `npm run shots` 重新生成（它会先读 `docs/` 里的界面图，所以改完 UI 先跑
`npm run preview` 再跑 `npm run shots`）。

顺序就是商店里的展示顺序：

1. `01-youtube-bilingual.png` — YouTube 双语字幕（头号功能）
2. `02-page-bilingual.png` — 网页翻译 · 双语模式
3. `03-page-replace.png` — 网页翻译 · 仅译文模式（同一页面对照）
4. `04-popup.png` — 弹窗（视频字幕面板）
5. `05-diagnostics.png` — 诊断页（差异点，占一张）

`docs/` 下那些仍是**文档配图**（2x 渲染、比例各异），不要拿去上架：

```
docs/popup.png              712×998      ← 2x of 356×499
docs/popup-yt-page.png      712×1156
docs/ball.png               1520×840
docs/diagnostics.png        1800×1800
docs/options.png            2360×5240
docs/page-bilingual.png     1800×2360
docs/e2e-real-page.png      756×469
```

**注意 Chrome 不接受带 alpha 通道的 JPG**，PNG 或 24-bit JPG 都可以；
上面这 5 张已确认无 alpha。

---

## 五、提交前自查

- [ ] `manifest.json` 的 `version` 严格高于已上传过的任何版本（**不可复用标签，不可回退**）
- [ ] zip 根目录直接是 `manifest.json`，不是套一层文件夹（`npm run dist` 已经是对的）
- [ ] zip 里不含 `scripts/`、`docs/`、`.github/`、`dist/` 自身——审阅者会看包里的东西，多出来的文件只会招问题
- [ ] 商店里的名称与描述和 `manifest.json` 一致（不一致会被当成 bait-and-switch）
- [ ] 隐私政策 URL 可公开访问（GitHub 上的 `PRIVACY.md` 链接即可）
- [ ] 隐私政策里的说法和实际行为逐条对得上——**这一条是两个商店最常拒的原因**，也是唯一能靠自查消除的
