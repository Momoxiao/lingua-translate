# Lingua 隐私政策

**生效日期：2026-10-06**
**适用版本：Lingua 浏览器扩展（Chrome / Edge，Manifest V3）**

---

## 一句话

Lingua **没有自己的服务器，不收集、不上传、不存储你的任何数据**。唯一离开你设备的内容，是你正在翻译的文本——它直接发往**你自己配置的那个翻译服务**，不经过我们。

---

## 一、什么数据会离开你的设备

只有一项：**你正在翻译的文本**。

| 场景 | 发送的内容 | 发给谁 |
|---|---|---|
| 视频字幕 | 该视频字幕的文本（按批次切分） | 你在设置页选定的翻译服务 |
| 网页翻译 | 被识别为需要翻译的正文段落 | 同上 |

除此之外没有第二条数据流。我们没有自建后端、没有埋点、没有统计、没有账号体系。

## 二、什么数据只留在本地

以下内容保存在浏览器的 `chrome.storage.local` 里，**不会**发送给任何人（唯一例外见下一节）：

- **翻译服务的凭据**：API Key、区域、Base URL。只在向**你选定的那个服务**发起请求时，作为该服务的认证信息随请求发出。
- **翻译缓存**：已翻译的句子，用于避免重复调用。可在设置页「清空缓存」一键删除。
- **扩展设置**：目标语言、显示方式、字号、站点规则（哪些站点自动翻译 / 不翻译）等。
- **页面地址**：仅在你本地用于判断「本站规则」是否命中。

## 三、权限与它们各自的用途

| 权限 | 用途 | 说明 |
|---|---|---|
| `storage` | 保存上面的设置、凭据与缓存 | 全部在本地 |
| `*://*.youtube.com/*`、`*://*.youtube-nocookie.com/*` | 读取播放器已加载的字幕轨、在播放器上叠加双语字幕层 | 仅在这些域名下运行 |
| `<all_urls>` | 网页翻译需要在你指定的任意页面上运行；两个固定供应商（微软 Azure、自定义供应商）的接口地址由你填写，无法预先限定域名 | **不会**后台读取页面：只有你点了悬浮球或把该站点设为「自动翻译」，才会扫描并翻译当前页面的正文 |

## 四、诊断信息（只在你主动操作时才产生）

设置页的「诊断」会读取扩展在**某个标签页**上的运行状态，生成一段纯文本，供你复制后贴到 Issue 里。它的用途是让远程定位不靠猜。

其中**不包含**：

- 你的 API Key 或任何凭据
- 译文内容
- 浏览历史、Cookie

其中**可能包含**：

- 当前页面的完整地址（含查询参数）

这段文本只在你点「复制诊断信息」并被你自己粘贴出去（例如贴到 GitHub Issue）时才会公开。**地址一栏你可以自行删除再粘贴**——诊断页和 Issue 模板都写了这一点。

## 五、第三方

你选择的翻译服务由**你**配置，其数据处理遵循**其自身**的隐私政策。常见几项：

| 供应商 | 隐私政策 |
|---|---|
| OpenAI 兼容（OpenAI / DeepSeek / Kimi / 智谱 / 通义 / 硅基流动 / OpenRouter / Groq 等，以及自建的 Ollama、LM Studio、one-api） | 见该服务自身 |
| DeepL | <https://www.deepl.com/privacy> |
| Google 翻译 | <https://policies.google.com/privacy> |
| 微软 Azure Translator | <https://privacy.microsoft.com/privacystatement> |
| 自定义供应商 | 见你自己填写的那个接口提供方 |

发往该服务的内容如何被保留、是否用于训练，由该服务的条款决定，我们无法控制也无法代为承诺。**如果你翻译的内容敏感，请选择你信任的服务，或选择本地部署（Ollama / LM Studio 等）——那样文本根本不会离开你的机器。**

## 六、我们不做什么

- 不收集、不出售、不共享任何用户数据
- 不读取浏览历史、书签、下载记录
- 不注入广告、不修改页面上的非翻译内容
- 不使用远程代码（Manifest V3 全量打包，无法在运行时下载并执行任何脚本）

## 七、数据保留与删除

- 本地设置、凭据、缓存：卸载扩展即全部删除；也可在设置页手动清空缓存或重置设置。
- 服务商侧：超出我们的控制范围，见第五节。

## 八、儿童

本扩展不面向 13 岁以下儿童，也不会有意收集其信息。

## 九、政策变更

本政策的变更会随扩展版本一起提交到本仓库，修订记录见 Git 历史。重大变更会在版本说明中注明。

## 十、联系方式

有问题或发现与本政策不符的行为，请开 Issue：
<https://github.com/Momoxiao/lingua-translate/issues>

---

# Privacy Policy (English)

**Effective: 2026-10-06**

Lingua has **no server of its own and collects no user data**. The only content that leaves your device is **the text being translated**, and it goes directly to **the translation service you configured yourself** — never through us.

- **Stored locally only** (`chrome.storage.local`): your API credentials, the translation cache, and your settings. Credentials are sent only to the service you selected, as that service's own auth header.
- **Permissions**: `storage` (local settings); YouTube host permissions (read the player's caption tracks and overlay bilingual subtitles there); `<all_urls>` (web-page translation runs on whatever site you choose to translate, and self-hosted/custom translation endpoints cannot be pre-declared). No page is scanned in the background — only after you click the floating ball or mark that site for automatic translation.
- **Diagnostics**: a plain-text report you generate by clicking a button. It contains no API key and no translated text. It does contain the current page URL, which you can delete before pasting it anywhere.
- **Third parties**: your chosen translation provider's own privacy policy governs what it does with the text it receives. For sensitive content, use a locally hosted provider (Ollama, LM Studio, …) and nothing leaves your machine.
- **We do not** collect, sell or share data; read your browsing history, bookmarks or downloads; inject ads; or use remotely hosted code.
- **Contact**: <https://github.com/Momoxiao/lingua-translate/issues>
