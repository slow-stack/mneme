<p align="center">
  <img src="images/mneme-banner-hero.webp" alt="Mneme — The Memory That Dreams" width="100%" />
</p>

<h1 align="center">dsh-mneme</h1>

<p align="center">
  <b>DeepSeek Harness 的跨会话长期记忆</b><br/>
  聊过的项目 · 提过的偏好 · 做过的决定 —— 关掉窗口，它还记着
</p>

<p align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/v/@modusensus/dsh-mneme?style=flat-square&label=npm&labelColor=B03A2E&color=EFE7D8&logoColor=1C1C1C"><img src="https://img.shields.io/npm/v/@modusensus/dsh-mneme?style=flat-square&label=npm&labelColor=B03A2E&color=111111&logoColor=FFFFFF" alt="npm version"></picture>
<picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/d18m/@modusensus/dsh-mneme?style=flat-square&label=downloads&labelColor=B03A2E&color=EFE7D8&logoColor=1C1C1C"><img src="https://img.shields.io/npm/d18m/@modusensus/dsh-mneme?style=flat-square&label=downloads&labelColor=B03A2E&color=111111&logoColor=FFFFFF" alt="npm downloads"></picture>
<picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/github/actions/workflow/status/slow-stack/mneme/ci.yml?style=flat-square&label=CI&labelColor=B03A2E&color=EFE7D8"><img src="https://img.shields.io/github/actions/workflow/status/slow-stack/mneme/ci.yml?style=flat-square&label=CI&labelColor=B03A2E&color=111111" alt="CI"></picture>
<picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/tests-3446%20total-EFE7D8?style=flat-square"><img src="https://img.shields.io/badge/tests-3446%20total-111111?style=flat-square" alt="tests"></picture>
<picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/license-MIT-EFE7D8?style=flat-square&label=license&labelColor=B03A2E&logoColor=1C1C1C"><img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square&label=license&labelColor=B03A2E&logoColor=FFFFFF" alt="license"></picture>
<a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome"></a>
</p>

<p align="center">中文 · <a href="#english">English</a></p>

---

> **Mneme**（Μνήμη）是记忆女神 **Mnemosyne** 的名字。希腊人把记忆交给她，也把梦交给她——名字落在插件上是同一个意思：白天记住，夜里整理。`autoDream` 就在你空闲时做这件事，把常看的留在热区，把陈旧的压成摘要、归档。

## 它解决什么

每次新开对话，AI 都像第一次认识你。你重新讲一遍项目背景，重新交代偏好，重新说服它别改那个已经定下来的决定。

**dsh-mneme** 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 一份跨会话的记忆：对话结束，值得留下的部分自动蒸馏进本机；下次开口，相关的几条自己浮上来。记忆不是锁在向量库里的一堆浮点数——它落在本机的一份 SQLite，旁边配一份 Markdown 镜像，你随时能打开、能改，改了不会被机器盖掉。

## 安装

```bash
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

两条硬要求，不满足装不上：

- **Node 24+** —— 记忆库用的是 `node:sqlite`，Node 22 起不来库。
- **DSH 0.1.x 或 0.2.x** —— 两条线都在兼容范围内；CI 对 0.2 线全绿。

> 本仓库是**单仓多包**：可安装的本体在 `dsh-mneme/`，根目录那份 `package.json` 只是仓库壳（`private`、无 `dsh` 字段）。走 Git 或 tarball 时路径必须指到子目录，否则装到的是壳本身。四种安装来源的写法见[完整文档](dsh-mneme/README.md)。

它落在你机器的哪几个地方：

| 目录 | 是什么 |
|------|--------|
| `~/.dsh/memory` | 记忆库本体：SQLite 正本，加十份可手改的 Markdown 镜像 |
| `~/.dsh/mneme` | 本地嵌入模型与运行时缓存，删掉会自动重下 |
| `~/.dsh-mneme` | CLI / MCP 的连接配置（url 与 token） |

想卸掉：

```bash
dsh plugin --profile web remove @modusensus/dsh-mneme
```

插件目录没了，`~/.dsh/memory` 里的记忆还在——想清干净就自己删这个目录。三个目录名字很像，别认错：[目录说明](dsh-mneme/docs/DIRECTORIES.md)。

## 你会用到的

- **自动记住** — 对话结束时蒸馏出值得留的事实、偏好、决定，不需要你手动「保存到记忆」。
- **按需注入** — 下次开口，相关的几条自己进上下文；热度、近因、重要度一起算，不是简单按时间堆。
- **空闲巩固** — `autoDream` 在你不用的时段合并重复、压缩陈旧、归档过期。越用越精炼，不是越堆越大。
- **矛盾不替你做主** — 两条记忆打架时先冻结，并排摆在状态页，等你说保留哪条。
- **记忆是文件** — 十份 Markdown 镜像，能看到、能改、能导出；手改过的内容在合并回库时优先保留。
- **一块面板** — 记录、浏览、筛选、搜索、改、删，都在设置页里。

## 凭什么信它

- **每条记忆都带着来历** — 从哪段对话来的、什么时候改过、被谁动过。自动整理同样留账：输入快照、决策明细、结果哈希，同一次整理可以复现回放。
- **隔离与离线** — 可按 agent / 工作区隔离；把嵌入换成本地模型后，语义检索完全离线，不需要任何 API Key。
- **删对话 ≠ 删记忆** — 记忆是跨会话的全局知识，清空聊天窗口不影响已经存下的部分。
- **随时能接管** — 记忆库就是本机 SQLite 加一堆 Markdown，没有私有格式把你锁在里面。

对比 Zep / Mem0 / Letta / Hindsight 的 11 行逐项表（存储、检索、写入时抽取、离线巩固、冲突处理、遗忘、作用域、可审计性、多宿主、离线、许可证）：[能力对比](docs/COMPARISON.md)。**「—」不等于「差」**。

## 面板

<p align="center">
  <img src="images/screenshot-memories.png" alt="记忆库浏览" width="760"/><br/>
  <i>记录、浏览与筛选你的记忆。</i>
</p>

<p align="center">
  <img src="images/screenshot-entities.png" alt="实体与关系图谱" width="760"/><br/>
  <i>从记忆里提炼实体，构建带属性的关系图谱。</i>
</p>

<p align="center">
  <img src="images/screenshot-status.png" alt="状态与审计" width="760"/><br/>
  <i>向量索引、LLM 消耗、自动巩固记录，一眼看完。</i>
</p>

## 接到别处

| 方式 | 你能得到什么 |
|------|--------------|
| **MCP** | 一个零依赖 stdio server（独立包 `mneme-memory`）；Claude Code / Cursor / Codex / OpenCode 等任何 MCP 客户端都能挂上六个记忆工具 |
| **独立 daemon** | `dsh-mneme-serve` 让记忆库常驻：DSH 关着时，脚本、网页端、你自己的面板读写同一份记忆 |
| **外部 API** | HTTP 接口，别的插件想把记忆写进来，走 API 就行 |
| **社区适配器** | 如 [Mneme-Bridge](https://github.com/SternChiri/Mneme-Bridge)，把 DeepSeek 网页版接进同一个库 |

## 隐私承诺

- **只落在本机。** SQLite 存储加一份可手工编辑的 Markdown 镜像，中间没有任何 mneme 服务器。
- **记忆是你能打开的文件。** Markdown，人类可读、可手改，手改过的内容在合并回库时优先保留。
- **不需要 mneme 自己的 API Key。** 巩固与摘要走你已配置的宿主模型（`autoDream` / `autoSummarize` 默认开）。
- **想连巩固也完全离线**：把宿主换成本地模型，并清空 `dreamProvider` / `dreamModel` 与 `summarizeProvider` / `summarizeModel`（配了这两组会绕过宿主直连，只换宿主不生效），或直接关掉这两个开关。
- **无遥测、无分析、无远程日志。**

## 文档

| 想找什么 | 去哪 |
|----------|------|
| 完整参考：全部配置项、CLI、外部 API、架构 | [dsh-mneme/README.md](dsh-mneme/README.md) |
| 每个配置键的默认值与含义 | [docs/CONFIGURATION.md](dsh-mneme/docs/CONFIGURATION.md) |
| 和别的记忆系统的能力对照 | [docs/COMPARISON.md](docs/COMPARISON.md) |
| 每个版本改了什么 | [CHANGELOG](dsh-mneme/CHANGELOG.md) · [Releases](https://github.com/slow-stack/mneme/releases) |
| 三个目录到底谁是谁 | [docs/DIRECTORIES.md](dsh-mneme/docs/DIRECTORIES.md) |
| 致谢与相关研究 | [完整文档 · 致谢](dsh-mneme/README.md#-致谢) |

<div align="center">

&nbsp;

> *"记忆不是把对话存下来，是让下一次对话从上次继续。"*

&nbsp;

<sub>© 2026 MODUSENSUS · MIT</sub>

&nbsp;

</div>

---

<a name="english"></a>

<h1 align="center">dsh-mneme</h1>

<p align="center">
  <b>Long-term, cross-session memory for DeepSeek Harness</b><br/>
  projects · preferences · decisions — still there after you close the window
</p>

> **Mneme** (Μνήμη) is the name of **Mnemosyne**, the goddess of memory — and of dreams. The name means the same thing here: remember by day, tidy up at night. `autoDream` does that while you are idle: hot memories stay hot, stale ones compress into summaries, old ones archive.

## What it is for

Every new chat, the AI meets you for the first time. You explain the project again, restate your preferences, and re-argue a decision that was already settled.

**dsh-mneme** gives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) memory that outlives a conversation: when a chat ends, what is worth keeping is distilled into your machine, and the relevant pieces surface on their own next time. The memories are not a pile of floats locked in a vector store — they live in a local SQLite file with a Markdown mirror beside it: open it, read it, edit it, and your edits are not overwritten.

## Install

```bash
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

Two hard requirements — without them it will not install:

- **Node 24+** — the store uses `node:sqlite`; on Node 22 the database will not open.
- **DSH 0.1.x or 0.2.x** — both lines are in range, and CI is green on the 0.2 line.

> This repository is a **multi-package repo**: the installable plugin lives in `dsh-mneme/`, and the root `package.json` is only a repo shell (`private`, no `dsh` field). Git and tarball specs must point at the subdirectory, or you install the shell itself. All four install sources are in the [full docs](dsh-mneme/README.md) (Chinese).

Where it lands on your machine:

| Path | What it is |
|------|------------|
| `~/.dsh/memory` | The store itself: the SQLite original plus ten hand-editable Markdown mirrors |
| `~/.dsh/mneme` | Local embedding model and runtime cache; delete it and it refetches |
| `~/.dsh-mneme` | CLI / MCP connection settings (url and token) |

To remove it:

```bash
dsh plugin --profile web remove @modusensus/dsh-mneme
```

The plugin directory goes away, the memories in `~/.dsh/memory` stay — delete that directory yourself if you want them gone. The three names are easy to mix up: [directories](dsh-mneme/docs/DIRECTORIES.md).

## What you get

- **Remembered automatically** — when a chat ends, the facts, preferences and decisions worth keeping are distilled; there is no "save to memory" step.
- **Injected on demand** — the relevant handful enters context next time, ranked by heat, recency and importance rather than simply by date.
- **Consolidated while idle** — `autoDream` merges duplicates, compresses what went stale, archives what expired. The store gets leaner, not fatter.
- **Conflicts are not decided for you** — when two memories disagree, both are frozen and shown side by side, and you pick which one stays.
- **Memories are files** — ten Markdown mirrors you can read, edit and export; hand-edited text wins when it is merged back.
- **A panel** — record, browse, filter, search, edit, delete, all in the settings page.

## Why you can trust it

- **Every memory carries its provenance** — which conversation it came from, when it changed, who touched it. Consolidation leaves a receipt too: input snapshot, decision detail, result hash, so the same run can be replayed.
- **Isolation and offline** — memories can be scoped per agent and workspace; point the embedder at a local model and semantic search runs fully offline, with no API key.
- **Delete the session ≠ delete the memory** — memories are cross-session knowledge; clearing a chat window leaves what was saved alone.
- **You can always take it over** — the store is a local SQLite file plus Markdown; no proprietary format holds your data.

How does it compare with Zep / Mem0 / Letta / Hindsight? An 11-row table — storage, retrieval, write-time extraction, offline consolidation, conflicts, forgetting, scoping, auditability, multi-host, offline, license: [capability comparison](docs/COMPARISON.md) (Chinese). **"—" does not mean "worse"**.

## The panel

<p align="center">
  <img src="images/screenshot-memories-en.png" alt="Memory browse" width="760"/><br/>
  <i>Record, browse and filter your memories.</i>
</p>

<p align="center">
  <img src="images/screenshot-entities-en.png" alt="Entities & relations" width="760"/><br/>
  <i>Entities are distilled from your memories into a relation graph with attributes.</i>
</p>

<p align="center">
  <img src="images/screenshot-status-en.png" alt="Status & audit" width="760"/><br/>
  <i>Vector index, LLM spend and consolidation activity at a glance.</i>
</p>

## Elsewhere

| Way in | What you get |
|--------|--------------|
| **MCP** | A zero-dependency stdio server (standalone package `mneme-memory`); Claude Code / Cursor / Codex / OpenCode and any other MCP client can mount the six memory tools |
| **Standalone daemon** | `dsh-mneme-serve` keeps the store running: with DSH closed, scripts, web bridges and your own panels read and write the same memories |
| **External API** | An HTTP surface, so another plugin can write memories in through the API |
| **Community adapters** | Such as [Mneme-Bridge](https://github.com/SternChiri/Mneme-Bridge), which brings the DeepSeek web chat into the same store |

## Privacy

- **Local only.** A SQLite store plus a hand-editable Markdown mirror; no mneme server sits in between.
- **Memories are files you can open.** Markdown, human readable and hand editable; your edits are kept when merged back.
- **No mneme API key required.** Consolidation and summaries go through the host model you already configured (`autoDream` / `autoSummarize`, on by default).
- **Fully offline consolidation** is possible: point the host at a local model, and clear `dreamProvider` / `dreamModel` and `summarizeProvider` / `summarizeModel` (if set, they bypass the host), or turn the two switches off.
- **No telemetry, no analytics, no remote logs.**

## Docs

| Looking for | Where |
|-------------|-------|
| Full reference: every setting, CLI, external API, architecture | [dsh-mneme/README.md](dsh-mneme/README.md) |
| Defaults and meaning of each config key | [docs/CONFIGURATION.md](dsh-mneme/docs/CONFIGURATION.md) |
| How it compares with other memory systems | [docs/COMPARISON.md](docs/COMPARISON.md) |
| What changed in each version | [CHANGELOG](dsh-mneme/CHANGELOG.md) · [Releases](https://github.com/slow-stack/mneme/releases) |
| Which of the three directories is which | [docs/DIRECTORIES.md](dsh-mneme/docs/DIRECTORIES.md) |
| Credits and related work | [full docs · credits](dsh-mneme/README.md#-致谢) (Chinese) |
