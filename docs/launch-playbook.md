# 上架与冷启动手册

这份是给自己看的工作文档，不是给用户看的。**里面的竞品对比不要搬进 README**——读者自己会得出那个结论，写出来反而廉价。

---

## 一、先把期望对齐，否则后面每一步都会做错

第三方统计（2026-10-06 取自 OSSEAN / GitGenius，非一手数据，仅供参考）：

| | immersive-translate |
|---|---|
| star | 19.2k（近 28 天 +397，约 14/天） |
| 创建时间 | 2022-12-07（走了近 4 年） |
| 近 30 天提交 | 有（Sep 30） |
| open issues | ~380 |
| 一年内从未被回复的 issue | 约 18% |
| 三个月无动静的 open issue | 约 85% |
| **LICENSE** | **Unknown（未提供开源授权）** |
| 商业模式 | 有商业产品与付费额度 |

**star 不是代码质量的函数**，是「被多少个对的人看到」×「那一眼是否值得点收藏」。所以：

- 合理目标：英文 README + 商店上架 + 一次打得准的发布，一年 **1–3k star**。
- 19k 需要多年积累 + 商业化投入 + 中文社区的大规模推广，不是靠技术好。
- **对「自带 key」这类工具，装的人比 star 重要。** 有人装了、用着、来提 issue，star 是副产品。反过来追 star 会做出错误决定（见第六节）。

## 二、杠杆排序（从大到小，就按这个顺序做）

| # | 动作 | 为什么排这个位置 |
|---|---|---|
| 1 | **上架商店**（Edge / Chrome） | 唯一会**持续**带流量的渠道。商店搜索流量自己会来，且 listing 里能挂 GitHub 链接。其他所有动作都是一次性的脉冲。 |
| 2 | **英文 README + 界面英文** | 现在 README 和 UI 都只有中文——等于把 GitHub 上绝大多数观众在 3 秒内劝退，而且英文用户即使装了也用不了。**这一条从「i18n 往后放」变成了关键路径**：目标一旦是国际受众，它是前置条件，不是收尾工作。 |
| 3 | **Demo GIF** | 可视化工具的第一秒决定一切。目前**头号功能连一张截图都没有**（见第五节）。 |
| 4 | **一次打得准的发布** | Show HN / Reddit / V2EX / 少数派，按顺序、**一次只打一个**。 |
| 5 | **Topics + awesome-list PR** | 便宜、长期有效、不需要看人脸色。 |

## 三、定位：一句话

> **自带 key、无服务器、MIT 的翻译扩展。10k 行、零依赖，一个下午能读完。**

对照事实（**给自己看的，不要写进 README**）：那个 19.2k star 的同行，LICENSE 字段是 Unknown；免费额度走它自己的服务器；386 个 open issue。

不点名对比的理由：① 显得心虚；② 会招来不必要的口水；③ 把「我们是 MIT、我们不过服务器」平静地说出来，读者自己会去查。**用事实，不用形容词。**

## 四、每个渠道怎么发

### 4.1 Hacker News（Show HN）——收益最高，也最难

规则：**不要营销腔**。HN 的人会因为一句「revolutionary」直接关掉，但会因为一个真实的技术坑读到最后。所以把 PoToken 那段放在显眼处。

标题：

```
Show HN: Lingua – Bilingual YouTube subtitles using your own translation API
```

正文（可直接贴）：

```
I built a translation extension that works with whatever translation service you
already pay for, instead of bundling a subscription. No account, no server of
ours, MIT licensed: https://github.com/Momoxiao/lingua-translate

Two things that turned out to be genuinely hard, in case they're useful:

1. YouTube signs caption requests. Since 2025 /api/timedtext needs a
   Proof-of-Origin token minted by BotGuard, and the URL in ytInitialPlayerResponse
   doesn't carry one. Fetch it and you get HTTP 200 with an empty body — a failure
   that looks exactly like success. So the extension reuses the token the player
   already obtained, with four fallbacks.

   While testing this I got the diagnosis wrong twice, which turned out to be the
   more useful story. First I blamed headless mode; it reproduces headed, with the
   GPU on. Then I blamed the signed-out throwaway profile "not being handed a
   token" — and that is measurably false: against a real, signed-in session, the
   same video answers the same fetch with HTTP 200 and a 0-byte body, and its
   baseUrl carries no pot either. Login state is not the variable.

   Then I blamed *playback* — "the player only fetches a caption track once it is
   genuinely playing, and automation never gets there". Also false, and it stood
   for longer because it sounded unfalsifiable. A headed run shows the player
   issuing 6-9 /api/timedtext requests while the video plays; the requests
   without a pot come back HTTP 200 with a 0-byte body, and the ones with a pot
   come back with ~1.1-1.3 KB of real caption data. The "zero requests" runs the
   theory rested on were simply runs where nothing had asked the player to show
   captions — I read an absence of requests as evidence about the request path,
   which does not follow.

   The real property is timing: the extension nudges the player and sniffs the
   token out of the request the player then makes, so whether that token arrives
   inside the window decides the outcome. Same command, same video, consecutive
   runs: sometimes 60/60 cues translated, sometimes a fall-through. So I added a
   realtime fallback that reads the lines the player renders into the DOM and
   translates them one at a time. You get subtitles either way; the fallback just
   costs the pre-fetch ahead of the playhead, and it says so on screen instead of
   going blank.

   The test now records each /api/timedtext request's pot, status and CDP
   initiator, and says "unknown" when there is no initiator instead of guessing
   from the URL — because inject.js builds its URL from the player's baseUrl, so
   the two can be byte-identical.

2. display's *computed* value lies. A flex container blockifies its children, so
   <nav style="display:flex"><a>Home</a></nav> reports display:block for the link.
   Trusting that put every nav link's translation *below* the link and wrapped
   navbars onto two lines. The rule now treats "inline tag + flex/grid parent" as
   still inline, but only for short text.

There's no build step and no dependencies — manifest.json plus src/, 12,688 lines.
package.json has no dependencies field at all, and the zip is byte-reproducible so
the published SHA-256 means something. 632 assertions, including a real Chrome e2e.

Known limitation, stated up front: the caption path depends on YouTube's private
interface and is not covered by CI. It can break without warning.
```

发完之后**守着评论区**一到两小时。HN 的排名在头 30 分钟决定，答不上来就沉了。

### 4.2 Reddit

| sub | 切入点 | 注意 |
|---|---|---|
| r/selfhosted | **本地模型**：Ollama / LM Studio 时文本不出机器 | 版规通常禁纯推广，要讲「我怎么解决的」 |
| r/LocalLLaMA | 同上，强调 OpenAI 兼容接口通用性 | 这个 sub 对 BYO-key 很友好 |
| r/Chrome_Extensions | 直接介绍功能 | 阅读量小但转化高 |
| r/languagelearning | 双语字幕的学习用途 | **别把翻译扩展当选修课工具推销**，会很反感 |
| r/TranslationStudies | 术语保留、语体自适应 | 小众但专业 |

**每个 sub 的版规都要先读。** 同一份文案原样复制粘贴到 5 个 sub 会被当成 spam。

### 4.3 中文渠道

- **V2EX**（分享创造节点）：开发者密度最高，技术细节受欢迎。可直接使用 [`launch-copy.md`](launch-copy.md) 里的短版文案和标题。
- **少数派**：要成稿，适合放 GIF + 完整体验流程，review 周期长但长尾好。
- **小众软件**：投稿制，接受度高，适合工具类。
- **阮一峰周刊**：不是直接投稿，是被收录。**做法是先把 README 和技术写作做好，等人来收。**

### 4.4 awesome-list（可以提 PR，成本极低）

- **`xyNNN/awesome-chrome`**：目前最值得提交的目标。README 持续更新，已有 **Language & Translation** 分类，最近一次合并 PR 是 2026-08-02。
- **`mbiesiad/awesome-translations`**：仍在维护，但更偏 i18n / l10n 工具链；只有在条目描述能贴合其分类时才提交。
- **`stefanbuck/awesome-browser-extensions-for-github`**：与 Lingua 的用途不匹配，不提交。

PR 只要一行，但要**先确认它真的在收**（很多列表已经不维护了）。已准备好的目标、单行条目、标题和正文在 [`awesome-list-submission.md`](awesome-list-submission.md)；**公开提交前需要仓库所有者明确同意**。

### 4.5 Product Hunt

需要 GIF + 图标 + 落地页，收益对开发工具一般。**排在最后**，等商店上架后再考虑。

## 五、素材缺口（按性价比排序）

| # | 素材 | 现状 | 说明 |
|---|---|---|---|
| 1 | **YouTube 字幕覆盖层截图 / GIF** | ✅ README 动图已补齐；真机录像仍可加分 | `docs/lingua-demo.gif` 由 `npm run demo:gif` 生成：四段播放位置、四组双语字幕，全部走真实 `overlay.js` 的 `setLive()` 渲染路径；`docs/e2e-real-page.png` 则是真实 Chrome + 本地 fixture。两者都不是真实 YouTube 录像，**所以真机录像仍值得做**，但现在不再是零演示。 |
| 2 | 商店截图 1280×800 | ✅ 已补齐 | 中文界面 `store/screenshots/` 5 张、英文界面 `store/screenshots-en/` 5 张；两套都恰好 1280×800、无 alpha，按商店尺寸重新构图（非缩放）。`npm run shots` 一次重新生成两套。详见 [`store/SUBMISSION.md`](../store/SUBMISSION.md) |
| 3 | 300×300 商店图标 | ✅ 已补齐 | `store/icon-300.png`，由 `npm run release:assets` 单独重绘，未放大 128×128。 |
| 4 | GitHub social preview | ✅ 已补齐 | `docs/social-preview.png`，1280×640，由 `npm run release:assets` 单独排版。 |
| 5 | 商店促销图 440×280 / 1400×560 | ✅ 已补齐 | `store/promo-440x280.png`、`store/promo-1400x560.png`，由 `npm run release:assets` 重新生成 |

## 六、不要做的事

- **不要为了 star 加功能。** PDF、EPUB、悬停翻译——这些都是那个 19k star 项目 386 个 open issue 的来源。**一个功能做透比五个功能都半好更能拿 star。**
- **不要在界面里求 star。** 违反两个商店的政策，而且廉价。
- **不要让中英 README 内容分叉。** 一份写深、一份写浅，读者会看出敷衍。（现在的做法是：英文 README 是完整入口，中文 README 保留全部约 30 条工程笔记。**深度内容只在一边，但要链接过去**。）
- **不要在同一周打多个渠道。** 一次只打一个，才有精力回答问题、才有机会修正标题。第一个渠道的数据会告诉你第二个渠道该怎么写。
- **不要在 README 里点名踩同行。**
- **不要承诺「支持 YouTube 字幕」而不写那条已知限制。** 这条链路随时可能被 YouTube 改坏；写清楚反而涨信任——开发者会 star 一个诚实说明边界的项目，不会 star 一个假装没有边界的项目。

## 七、仓库设置清单（这些只能在网页后台点，我改不了）

- [x] **Topics**：已设置 13 个，覆盖 `chrome-extension`、`edge-extension`、`browser-extension`、`translation`、`youtube`、`subtitles`、`bilingual-subtitles`、`webpage-translation`、`openai`、`deepseek`、`ollama`、`manifest-v3`、`privacy`
- [x] **About 描述**：已设置为英文，与 README 的定位一致
- [x] **About 里的 Website**：已指向 GitHub Pages 官网 `https://momoxiao.github.io/lingua-translate/`；商店上架后可改为商店链接
- [ ] **Social preview 图片**：上传 `docs/social-preview.png`（1280×640）
- [x] **Discussions**：已打开
- [x] **Releases**：`v0.2.5` 已上传 zip + `.sha256`，发布说明保存在 `docs/releases/`
- [x] 确认 `LICENSE` 在仓库根目录能被 GitHub 识别（已识别为 MIT）

## 八、执行顺序（建议）

```
1. 上架商店（提交 Chrome 排队 + Edge 并行）        ← 长杆，先启动
2. 录 YouTube 字幕 GIF + 出 5 张商店截图           ← 上架和发布都要用
3. 界面 i18n（至少英文）                            ← 国际用户装了能用
4. 仓库设置清单（十分钟的事，别拖）
5. V2EX 发一次                                     ← 第一次发布用中文渠道试标题
6. 拿第一波反馈修一轮
7. Show HN                                         ← 英文打磨好再打，只有一次机会
```
