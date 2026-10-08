# Launch copy

Ready-to-paste copy for channels where the repository owner has an account.
Nothing here should be posted without explicit approval from the owner.

## V2EX 分享创造

**标题**

```text
做了一个自带 API Key 的 YouTube 双语字幕 + 网页翻译扩展
```

**正文**

```text
最近花了几周做了一个浏览器翻译扩展 Lingua，Chrome / Edge 都能用：

https://github.com/Momoxiao/lingua-translate

出发点是我不想再订阅一个翻译服务。现在这些扩展通常有三种做法：把页面文本送到自己的服务器、把自带 Key 锁在付费墙后面，或者塞一个几十万行的编译产物。Lingua 绕开了这三件事：

- 不经过项目自己的服务器。文本直接发到你配置的翻译接口，Key 只存在本地。
- OpenAI 兼容（OpenAI、DeepSeek、Kimi、GLM、Qwen、OpenRouter、Groq，本地 Ollama / LM Studio 等）、DeepL、Google、微软 Azure，或者自定义 HTTP 接口都能接。
- 无构建、无依赖、MIT。manifest.json 加 src/ 一共约 1.2 万行，能一下午读完。

真正花时间的是 YouTube 字幕这条链路。2025 年之后 /api/timedtext 需要播放器自己拿到的 Proof-of-Origin token，直接 fetch 会返回 HTTP 200 但 body 是 0 字节 —— 看起来像成功，实际什么都没拿到。现在的做法是让播放器请求字幕，然后截获它自己的 token，并做四层兜底；如果整轨来不及拿，就退到实时读取播放器已经渲染出来的字幕行。

这条链路依赖 YouTube 私有接口，随时可能失效，所以 README 里明确写了边界和实测结果，没有假装有公开 API。

安装包和 SHA-256：
https://github.com/Momoxiao/lingua-translate/releases/latest

这个项目目前只有 macOS Chrome 的实测，欢迎 Windows / Linux 用户反馈。发现字幕问题请带诊断页输出，里面不含 Key 和译文。
```

## Hacker News (Show HN)

Use the fuller engineering narrative in `docs/launch-playbook.md`. HN ranks in
the first 30 minutes, so do not post until you can stay in the thread and answer
questions for one to two hours.

**Title**

```text
Show HN: Lingua - Bilingual YouTube subtitles using your own translation API
```

## Reddit

Do not cross-post the V2EX copy. Read each subreddit's rules first and tailor
the technical angle:

| community | angle | avoid |
|---|---|---|
| r/selfhosted | Ollama / LM Studio keeps text on the machine | pure promotion; explain the problem and tradeoffs |
| r/LocalLLaMA | OpenAI-compatible API and local models | claiming local operation when a cloud provider is configured |
| r/Chrome_Extensions | installable extension and permissions | copying the same post to many communities |
| r/languagelearning | bilingual subtitles as a reading aid | marketing a translation tool as language learning |
| r/TranslationStudies | reversible page translation and register preservation | overclaiming translation quality |

## awesome-list

The researched, active target and exact one-line entry are in
[`awesome-list-submission.md`](awesome-list-submission.md). Submit only after
the repository owner approves the public PR.

## Posting sequence

1. Start with one Chinese developer community (V2EX) and stay for comments.
2. Fix the first real issues before trying a second channel.
3. Save Show HN for after the install path and English copy have survived that
   first round.
4. Submit the awesome-list PR separately; it is evergreen, not a launch pulse.
