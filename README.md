<p align="center">
  <img src="images/mneme-banner-hero.webp" alt="Mneme — The Memory That Dreams" width="100%" />
</p>

```
$ whoami
mneme — the memory that dreams

$ cat /etc/mneme
cross-session memory for DeepSeek Harness
every memory keeps its provenance
conflicts freeze until you decide
the only copy stays on your machine

$ ls ~/.dsh/memory
memory.db  constraints.md  decisions.md  documents.md  history.md
patterns.md  pitfalls.md  preferences.md  projects.md
rejected-solutions.md  summary.md
```

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

### 01 · 它是什么

*每次新开对话，AI 都像第一次认识你。*

**dsh-mneme** 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装上跨会话记忆。聊过的项目、提过的偏好、做过的决定——关掉窗口再打开，它还记得。

它不是一个向量库。记忆落在你本机的一份 SQLite 里，旁边配一份 Markdown 镜像：那个文件你随时能打开、能改，改完不会被机器盖掉。

### 02 · 凭什么信它

*看不见的地方，才决定它能不能长期用。*

- **每条记忆都带着来历** — 从哪段对话来的、什么时候改过、被谁动过。自动整理同样留账：输入快照、决策明细、结果哈希，同一次整理可以复现回放。
- **矛盾不替你做主** — 两条记忆打架时先冻结，并排摆在状态页，等你说保留哪条。
- **你改的优先** — 记忆就是本地 Markdown；手改过的内容在合并回库时优先保留。
- **空闲时才动手** — 常看的留在热区，久不用的压成摘要，陈旧的归档。越用越精炼，不是越堆越大。
- **隔离与离线** — 可按 agent / 工作区隔离；把嵌入换成本地模型后，语义检索完全离线，不需要任何 API Key。
- **删对话 ≠ 删记忆** — 记忆是跨会话的全局知识，清空聊天窗口不影响已经存下的部分。

> 它和 Zep / Mem0 / Letta / Hindsight 各差在哪？有一张 11 行的逐项对照——存储、检索、写入时抽取、离线巩固、冲突处理、遗忘、作用域、可审计性、多宿主、离线、许可证。**「—」不等于「差」**：[能力对比](docs/COMPARISON.md)。

### 03 · 装

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

### 04 · 面板

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

### 05 · 接到别处

| 方式 | 你能得到什么 |
|------|--------------|
| **MCP** | 零依赖 stdio 服务端（独立包 `mneme-memory`），Claude Code / Cursor / Codex / OpenCode 等任意 MCP 客户端都能挂上记忆六件套 |
| **独立 daemon** | `dsh-mneme-serve` 让记忆库常驻：DSH 关着，脚本、网页桥接、自有面板照样读写同一份记忆 |
| **社区适配器** | 比如 [Mneme-Bridge](https://github.com/SternChiri/Mneme-Bridge)，把 DeepSeek 网页端也接进同一个记忆库 |

### 06 · 文档

| 想了解 | 去哪 |
|--------|------|
| 功能、安装、配置、架构（完整） | [dsh-mneme/README.md](dsh-mneme/README.md) |
| 全部配置键 | [配置说明](dsh-mneme/docs/CONFIGURATION.md) |
| 目录归属：`~/.dsh/memory` ≠ `~/.dsh/mneme` | [目录说明](dsh-mneme/docs/DIRECTORIES.md) |
| 与 Zep / Mem0 / Letta / Hindsight 的对照 | [能力对比](docs/COMPARISON.md) |
| 版本历史 | [CHANGELOG](dsh-mneme/CHANGELOG.md) |

### 07 · 一路走来

*版本表由发版准备脚本维护，当前版本行随 tag 更新。*

| 版本 | 主题 | 状态 |
|------|------|------|
| **v0.14** | 图像与情绪都成了记忆；修掉两处静默召回截断（词法语料 500 行、注入候选池 200 行） | ✅ 已发布（v0.14.0） |
| **v0.13** | 情绪终于有地方可放：单次场合与稳定倾向在存储上分开 | ✅ 已发布（v0.13.0） |
| **v0.12** | pin 显式化（`memory_pin`），并上下文本地自适应 | ✅ 已发布（v0.12.0） |
| **v0.9 / v0.10** | 归因与闸门：蒸馏归因落到运行身份、会话级无痕闸门、防谄媚补到写入面 | ✅ 已发布 |

---

## 隐私承诺

- **只落在本机。** SQLite 存储加一份可手工编辑的 Markdown 镜像，中间没有任何 mneme 服务器。
- **记忆是你能打开的文件。** Markdown，人类可读、可手改，手改过的内容在合并回库时优先保留。
- **不需要 mneme 自己的 API Key。** 巩固与摘要走你已配置的宿主模型（`autoDream` / `autoSummarize` 默认开）。
- **想连巩固也完全离线**：把宿主换成本地模型，并清空 `dreamProvider` / `dreamModel` 与 `summarizeProvider` / `summarizeModel`（配了这两组会绕过宿主直连，只换宿主不生效），或直接关掉这两个开关。
- **无遥测、无分析、无远程日志。**

<div align="center">

&nbsp;

> *"记忆不是把对话存下来，是让下一次对话从上次继续。"*

&nbsp;

<sub>© 2026 MODUSENSUS · MIT</sub>

&nbsp;

</div>

---

<a name="english"></a>

```
$ whoami
mneme — the memory that dreams

$ cat /etc/mneme
cross-session memory for DeepSeek Harness
every memory keeps its provenance
conflicts freeze until you decide
the only copy stays on your machine
```

### 01 · What it is

*Every new chat, the AI meets you for the first time.*

**dsh-mneme** gives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) cross-session memory. Projects you discussed, preferences you mentioned, decisions you made — close the window, open it later, and it still remembers.

It is not a vector store. Memories live in a local SQLite file, with a Markdown mirror beside it: a file you can open, read, and edit, and your edits are not overwritten by the machine.

### 02 · Why you can trust it

*The parts you never see decide whether it holds up over months.*

- **Every memory carries its provenance** — which conversation it came from, when it changed, who touched it. Consolidation leaves a receipt too: input snapshot, decision detail, result hash, so the same run can be replayed.
- **Conflicts are not decided for you** — when two memories disagree, both are frozen and shown side by side, and you pick which one stays.
- **Your edits win** — memories are local Markdown; hand-edited text is kept when it is merged back into the store.
- **It works when you are idle** — frequently used memories stay hot, stale ones compress into summaries, old ones archive. The store gets leaner, not fatter.
- **Isolation and offline** — memories can be scoped per agent and workspace; point the embedder at a local model and semantic search runs fully offline, with no API key.
- **Delete the session ≠ delete the memory** — memories are cross-session knowledge; clearing a chat window leaves what was saved alone.

> How does it compare with Zep / Mem0 / Letta / Hindsight? There is an 11-row table — storage, retrieval, write-time extraction, offline consolidation, conflicts, forgetting, scoping, auditability, multi-host, offline, license. **"—" does not mean "worse"**: [capability comparison](docs/COMPARISON.md) (Chinese).

### 03 · Install

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

### 04 · The panel

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

### 05 · Elsewhere

| Way in | What you get |
|--------|--------------|
| **MCP** | A zero-dependency stdio server (standalone package `mneme-memory`); Claude Code / Cursor / Codex / OpenCode and any other MCP client can mount the six memory tools |
| **Standalone daemon** | `dsh-mneme-serve` keeps the store running: with DSH closed, scripts, web bridges and your own panels read and write the same memories |
| **Community adapters** | Such as [Mneme-Bridge](https://github.com/SternChiri/Mneme-Bridge), which brings the DeepSeek web chat into the same store |

### 06 · Docs

| To learn | Where |
|----------|-------|
| Features, install, config, architecture (full) | [dsh-mneme/README.md](dsh-mneme/README.md) |
| Every configuration key | [Configuration](dsh-mneme/docs/CONFIGURATION.md) |
| Which directory is which: `~/.dsh/memory` ≠ `~/.dsh/mneme` | [Directories](dsh-mneme/docs/DIRECTORIES.md) |
| Head-to-head with Zep / Mem0 / Letta / Hindsight | [Comparison](docs/COMPARISON.md) |
| Version history | [CHANGELOG](dsh-mneme/CHANGELOG.md) |

### 07 · The road here

*Rows are maintained by the release-prep script; the current one is updated with the tag.*

| Version | Theme | Status |
|---------|-------|--------|
| **v0.14** | Images and moods became memories; two silent recall truncations removed (500-row lexical corpus, 200-row injection pool) | ✅ Released (v0.14.0) |
| **v0.13** | Moods finally had somewhere to live: one-off occasions kept apart from stable tendencies | ✅ Released (v0.13.0) |
| **v0.12** | Explicit pins (`memory_pin`) and an adaptive context budget | ✅ Released (v0.12.0) |
| **v0.9 / v0.10** | Attribution and gates: distillation runs carry an identity, session-level no-trace gate, anti-sycophancy on the write path | ✅ Released |

---

## Privacy

- **Local only.** A SQLite store plus an editable Markdown mirror, with no mneme server in the path.
- **Memory is a file you can open.** Markdown, human-readable and hand-editable; your edits win when it merges back.
- **No mneme API key of its own.** Consolidation and summarization use the host model you already configured (`autoDream` / `autoSummarize` are on by default).
- **Fully offline if you want it** — point the host at a local model *and* clear `dreamProvider` / `dreamModel` plus `summarizeProvider` / `summarizeModel` (setting those routes talks straight to that provider, so switching the host alone will not help), or just turn both switches off.
- **No telemetry, no analytics, no remote logging.**

<div align="center">

&nbsp;

> *"Memory is not what you save from a conversation. It is what lets the next one continue."*

&nbsp;

<sub>© 2026 MODUSENSUS · MIT</sub>

&nbsp;

</div>