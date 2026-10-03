<p align="center">
  <img src="横幅.png" alt="dsh-mneme banner" width="100%" />
</p>

<h1 align="center">dsh-mneme</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@modusensus/dsh-mneme"><img src="https://img.shields.io/npm/v/@modusensus/dsh-mneme?style=flat-square&color=3E63DD&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@modusensus/dsh-mneme"><img src="https://img.shields.io/npm/d18m/@modusensus/dsh-mneme?style=flat-square&color=3E63DD&label=downloads" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3E63DD?style=flat-square" alt="license"></a>
  <a href="https://github.com/slow-stack/mneme/actions"><img src="https://img.shields.io/github/actions/workflow/status/slow-stack/mneme/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22%2B-3E63DD?style=flat-square&logo=nodedotjs&logoColor=white" alt="node"></a>
  <a href="https://github.com/slow-stack/mneme"><img src="https://img.shields.io/badge/tests-1529%20passed-3E63DD?style=flat-square" alt="tests"></a>
  <a href="https://codecov.io/gh/slow-stack/mneme"><img src="https://img.shields.io/codecov/c/github/slow-stack/mneme/main?style=flat-square" alt="coverage"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome"></a>
</p>

<p align="center">🌏 <a href="#中文">简体中文</a> · <a href="#english">English</a></p>

---

<a name="中文"></a>

# 🧬 给 LLM 装上会自我进化的记忆

**dsh-mneme** 是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的跨会话记忆插件。它不只「存得下」，更「管得好」：后台自动去重合并、矛盾先冻结等你裁决、全程可回放审计、默认全离线，还支持导出成人可读的 Markdown。

> **Mneme**（Μνήμη）源自希腊记忆女神 **Mnemosyne**。她掌管记忆与梦境——正如 `autoDream` 在后台默默巩固你的记忆库。

## 它解决什么问题

每次新开对话，AI 都像第一次认识你？

**dsh-mneme 给 DeepSeek Harness 装上跨会话记忆。** 你聊过的项目、提过的偏好、做过的决定，AI 都记得——即使关掉了窗口，下次打开还在。

| 场景 | 没装插件 | 装了插件 |
|------|---------|---------|
| 周一聊完项目需求，周三继续 | "能再描述一下你的项目吗？" | "你指的是上周提到的博客重构吗？当时你说想用 Astro。" |
| 告诉 AI 你的编码习惯 | 每轮都要重复交代 | 一次设定，长期生效 |
| 整理大量资料后关窗口 | 资料丢了 | 自动归档，随时检索找回 |

> 但 dsh-mneme 的可信之处，恰恰在你**看不见**的后台。下面这些，才是它和「一个会存东西的插件」的本质区别。

## 为什么可以信任它

- 🧾 **可回放、可追责** — 每次自动整理都留一张「决策凭证」：输入快照 + 决策明细 + 结果哈希，同样的整理可复现回放，**不默默吞错、不留无法追溯的改动**。
- ⚖️ **矛盾先冻结，等你裁决**（可关）— 两条记忆打架时，不擅自替你做主。可疑冲突会**挂起待审**，状态页冲突队列里并排对比、一键裁决（保留 A / 保留 B / 仅标记），确认后才生效。复杂判断，人永远在线。
- 🔐 **记忆按 agent 与工作区隔离**（可关）— `scopeEnabled` 开启后，每条记忆标注由哪个 agent、在哪个工作区写入；检索时本会话作用域优先（命中加权，他 scope 降权仍可见）；`strictScope` 再进一步——**显式声明**收窄到他者作用域的记忆在检索/注入里完全不可见（载体自动标注只降权，不硬挡）。多 Agent、多项目互不串台。
- 🌙 **夜深人静才动手**（可关）— 空闲时自动分层归档：常看的留在热区、久不用的压成摘要、陈旧的彻底归档。记忆库**越用越精炼，不膨胀**。
- 🧠 **本地语义检索，默认离线** — 自带本地 Embedding 与精排，不强求 API Key，网络断了也能检索。
- 📝 **Markdown 双向同步** — 记忆就是本地 `.md` 文件，随时打开编辑；**人工改动会被优先尊重**，不会被机器覆盖。
- 💾 **删对话 ≠ 删记忆** — 清空聊天窗口，已保存的记忆仍在（可配置）。

## 5 分钟上手

```bash
# 安装插件
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

装完即可用。想在 5 分钟内看到它的价值：

1. **聊**：新开对话，跟 AI 聊几句关于你的偏好或手头项目（比如"我写代码更喜欢 4 空格缩进"）。
2. **等**：关掉窗口，重开新对话。如果它还记得刚才的事，说明记忆已经写入。
3. **调**：去「设置 → 记忆库设置」按需打开下面三个开关（见快速配置）。

## 快速配置（可选）

| 需求 | 配置项 | 默认值 | 改法 |
|------|--------|--------|------|
| 完全离线运行 | `embedProvider` | `openai` | 改为 `local` |
| 删除对话时保留记忆 | `sessionLifecycleEnabled` | `false` | 改为 `true` |
| 自动提取结构化实体 | `entityExtractionEnabled` | `false` | 改为 `true` |
| 多 Agent / 多项目记忆隔离 | `scopeEnabled`（需要更强隔离再加 `strictScope`，硬隔离只对显式声明生效） | `false` | 改为 `true` |

> 以上均在 DSH 设置面板 → 记忆库设置 中修改。完整配置见 [配置章节](dsh-mneme/README.md)。

## 一图看懂记忆闭环

```
  写入 ──► 质量过滤（无用信息先拦下）
    │
    ▼
  SQLite + 本地 Markdown 镜像
    │（空闲时）
    ├─ autoDream ：去重 / 合并 / 归档 / 修正 / 冲突冻结
    └─ Sleep Mode ：分层压缩 + 模式发现 + 关系补全（可关）
    │
    ▼
  召回（混合检索 + 精排）──► 注入会话上下文
```

## 界面预览

> 面板内置中英双语，跟随你的 DSH 界面语言显示。以下为中文截图，英文版请切至文末 [English](#english) 段落。

<p align="center">
  <img src="images/screenshot-memories.png" alt="记忆库浏览" width="720"/><br/>
  <i>记录、浏览与筛选你的记忆。</i>
</p>

<p align="center">
  <img src="images/screenshot-entities.png" alt="实体与关系图谱" width="720"/><br/>
  <i>自动从记忆里提炼实体，构建带属性的关系图谱。</i>
</p>

<p align="center">
  <img src="images/screenshot-status.png" alt="状态与审计" width="720"/><br/>
  <i>状态面板一眼看清向量索引、LLM 消耗与自动巩固记录。</i>
</p>

<p align="center">
  <img src="images/screenshot-settings.png" alt="记忆库设置" width="720"/><br/>
  <i>检索、实体抽取与记忆巩固开关都在设置里一站式配置。</i>
</p>

<p align="center">
  <img src="images/screenshot-help.png" alt="帮助与反馈" width="720"/><br/>
  <i>可选写保护 Token，以及本地化的反馈通道，让记忆库完全本地、可审计。</i>
</p>

## 隐私承诺

- 数据只存在你的电脑本地，不上传任何服务器
- 记忆是 Markdown 文件，人类可读、可手工编辑
- 默认零网络依赖，不需要 API Key
- 无遥测、无分析、无远程日志

## 用在其他 AI 工具里（MCP）

插件自带零依赖 stdio MCP server（独立 npm 包 **`mneme-memory`**，bin 名 `mneme-mcp`），任何 MCP 客户端都能挂载记忆六件套（`memory_save` / `memory_search` / `memory_list` / `memory_get` / `memory_update` / `memory_delete`）。

**前置条件（一次性）**：

1. DSH 在运行且插件已安装（MCP 数据面走插件的独立 API `127.0.0.1:8790`）
2. 在 DSH 面板「设置 → 外部访问 API」生成 token

**各客户端挂载**（`<你的token>` 替换为上一步生成的值）：

| 客户端 | 挂载方式 |
|--------|---------|
| **Claude Code** | 项目根 `.mcp.json`：`{"mcpServers": {"mneme-memory": {"command": "mneme-mcp", "env": {"MNEME_TOKEN": "<你的token>"}}}}` |
| **Cursor** | 设置 → MCP → Add Server，command 填 `mneme-mcp`，env 加 `MNEME_TOKEN` |
| **Codex** | `~/.codex/config.toml`：`[mcp_servers.mneme-memory]` 段，`command = "mneme-mcp"`，`env = { MNEME_TOKEN = "<你的token>" }` |
| **Hermes** | `~/.hermes/config.yaml` 的 `mcp_servers:` 段：`mneme-memory: {command: "mneme-mcp", env: {MNEME_TOKEN: "<你的token>"}}`，重启生效 |
| **OpenCode** | `opencode.json`：`{"mcp": {"mneme-memory": {"type": "local", "command": ["mneme-mcp"], "environment": {"MNEME_TOKEN": "<你的token>"}}}}` |
| **OpenClaw** | `openclaw mcp add mneme-memory --command mneme-mcp --env MNEME_TOKEN=<你的token>`，或 Control UI → Settings → MCP |

> **旧挂载兼容**：已部署的 `dsh-mneme-mcp` + `DSH_MNEME_TOKEN` 写法继续有效（bin 与 env 变量均保留，无需迁移）。未全局安装 npm 包时，把 `command` 换成 `npx` 并追加参数 `-p mneme-memory mneme-mcp`（Claude Code/OpenCode 写进 args 数组，Codex 写 `args = ["-p", "mneme-memory", "mneme-mcp"]`）。配置细节与安全注意事项见[完整文档](dsh-mneme/README.md#mcp-server任意-mcp-客户端接入)。

## 文档

| 文档 | 路径 |
|------|------|
| 插件完整文档（功能 / 安装 / 配置 / 架构） | [dsh-mneme/README.md](dsh-mneme/README.md) |
| stdio MCP server——Claude Code / Cursor 等任意 MCP 客户端接入记忆六件套 | [dsh-mneme/README.md · MCP Server](dsh-mneme/README.md#mcp-server任意-mcp-客户端接入) |
| 配置说明（全键参考） | [dsh-mneme/docs/CONFIGURATION.md](dsh-mneme/docs/CONFIGURATION.md) |
| 实体结构化设计 | [dsh-mneme/docs/ENTITIES.md](dsh-mneme/docs/ENTITIES.md) |
| 语义架构 | [dsh-mneme/docs/SEMANTIC.md](dsh-mneme/docs/SEMANTIC.md) |
| 本地模型部署指南 | [dsh-mneme/docs/LOCAL_MODEL.md](dsh-mneme/docs/LOCAL_MODEL.md) |
| 版本历史 | [dsh-mneme/CHANGELOG.md](dsh-mneme/CHANGELOG.md) |
| 安全策略 | [SECURITY.md](SECURITY.md) |

## 🗺️ 路线图

```
🧬 记忆基因 → 🛡️ 审计加固 → 💤 睡眠维护 → 🕸️ 召回融合与图谱 → ✨ 面板增强 → 🌡️ 自进化记忆 → 🕸️ 图谱增强
```

| 版本 | 主题 | 状态 |
|------|------|------|
| **v0.3** | 记忆基因：实体 / 属性（带时间轴）/ 关系 | ✅ |
| **v0.4** | Sleep Mode：空闲四阶段深度维护 | ✅ |
| **v0.5** | 召回融合与记忆可视化：BM25 + 图谱 + 热记忆 | ✅ |
| **v0.6** | 会话生命周期：删对话 ≠ 删记忆 | ✅ |
| **v0.7** | 自进化记忆：热度衰减 + 睡眠双保护 + 桌面端工作台/功能开关 | ✅ |
| **v0.8** | 作用域隔离（agent/workspace 双维隔离 + 检索加权 + opt-in 硬过滤）+ 冲突队列人工裁决 + 归属显式声明 + 生态化（stdio MCP server / 图召回轴 / 冷启动 / 注入截断与状态条 / 蒸馏可靠性 / 注入形态与 agent 主动整理接口 / 配置说明与 issue 模板） | ✅ 已发布（至 v0.8.9） |

> 完整逐小版本说明见 [CHANGELOG](dsh-mneme/CHANGELOG.md)。

## 🧪 本地开发

```bash
cd dsh-mneme && npm install
npm test        # 1529 个测试
npm run stress  # 三轴线压测
npm run sync    # src → lib 同步
```

---

---

## 🙏 致谢

autoDream 的理念溯源（理念借鉴、实现原创）：

- **[Claude Code 的 Auto Dream](https://code.claude.com/docs/en/memory)**（Anthropic，Memory 2.0）：理念源头——会话间隙由后台子代理整理记忆文件（去重、修矛盾、清衰减）。
- **[Sleep-time Compute: Beyond Inference Scaling at Test-time](https://arxiv.org/abs/2504.13171)**（UC Berkeley & Letta，arXiv:2504.13171）：Auto Dream「离线巩固」思想背后的学术脉络。
- **cc-haha**：早期实现思路的参照之一。

在上述工作之上，dsh-mneme 做了自己的工程发展：K-Means++ 聚类预分组、类型化决策清单（keep / merge / archive / conflict / update，及 sleep 侧 supersede / differentiate）与可回放的 sha256 摘要审计链（`dream_runs` / `receipt_chain`）。如有遗漏的灵感来源，欢迎提 issue 指出。

<a name="english"></a>

# 🧬 Give Your LLM a Memory That Evolves

**dsh-mneme** is a cross-session memory plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It does not just *store* your memories — it *manages* them: background deduplication and merging, conflicts frozen for your review, a fully replayable audit trail, offline by default, and export to human-readable Markdown.

> **Mneme** (Μνήμη) comes from **Mnemosyne**, the Greek goddess of memory and dreams — just as `autoDream` quietly consolidates your memory store in the background.

## What problem does it solve

Every time you start a new chat, the AI acts like it's never met you?

**dsh-mneme gives DeepSeek Harness cross-session memory.** Projects you've discussed, preferences you've mentioned, decisions you've made — the AI remembers them even after you close the window.

| Scenario | Without plugin | With plugin |
|----------|---------------|-------------|
| Continue a project discussion from Monday on Wednesday | "Can you describe your project again?" | "You mean the blog refactor from last week? You mentioned wanting to use Astro." |
| Tell the AI your coding habits | Repeat every session | Set once, remember forever |
| Close window after organizing research | Notes are lost | Auto-archived, retrievable anytime |

> But what makes dsh-mneme trustworthy lives in the background you never see. These are the traits that set it apart from "a plugin that just saves things."

## Why you can trust it

- 🧾 **Replayable, accountable** — every consolidation leaves a "decision receipt": input snapshot + decision detail + result hash. The same run reproduces the same outcome. **No silent mis-merges, no untraceable changes.**
- ⚖️ **Conflicts freeze, you decide** (opt-in) — when two memories contradict, it does not take sides for you. The suspected conflict is **parked for review**, compared side-by-side in the status-page conflict queue, and resolved with one click (keep A / keep B / mark reviewed). On hard judgments, a human stays in the loop.
- 🔐 **Memories isolated by agent & workspace** (opt-in) — with `scopeEnabled`, every memory is stamped with which agent wrote it and in which workspace; retrieval favors the current scope (weighted hits, out-of-scope demoted but visible); `strictScope` goes further — memories **explicitly** scoped to other agents/workspaces become invisible to search and injection (auto carrier labels are demoted only, never hard-blocked). Multiple agents and projects, zero cross-talk.
- 🌙 **It works while you sleep** (opt-in) — idle time triggers tiered archiving: frequent memories stay hot, stale ones compress to summaries, old ones archive. The store **stays lean as it grows**.
- 🧠 **Local semantic search, offline by default** — built-in local Embedding + reranking. No API key required; retrieval still works without a network.
- 📝 **Two-way Markdown sync** — memories are local `.md` files you can open and edit; **human edits are respected**, never clobbered by the machine.
- 💾 **Delete the session ≠ delete the memory** — clearing a chat window keeps what was saved (configurable).

## 5-minute quickstart

```bash
# Install the plugin
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

It works out of the box. To feel its value in five minutes:

1. **Chat** — start a session and tell the AI something about your preferences or a project (e.g. "I prefer 4-space indentation.").
2. **Verify** — close the window, open a new one. If it recalls what you said, the memory has landed.
3. **Tune** — open **Settings → Memory Settings** and flip the three switches below as needed.

## Quick config (optional)

| Need | Config key | Default | Change |
|------|-----------|---------|--------|
| Fully offline | `embedProvider` | `openai` | Change to `local` |
| Keep memories when deleting sessions | `sessionLifecycleEnabled` | `false` | Change to `true` |
| Structured entity extraction | `entityExtractionEnabled` | `false` | Change to `true` |
| Memory isolation per agent / workspace | `scopeEnabled` (add `strictScope` for stronger isolation — hard blocking applies to explicit declarations only) | `false` | Change to `true` |

> All of these live in DSH Settings → Memory Settings. Full config docs in the [Configuration section](dsh-mneme/README.md) (Chinese, bilingual file).

## The memory loop in one diagram

```
  write ──► quality filter (drop noise first)
    │
    ▼
  SQLite + local Markdown mirror
    │ (when idle)
    ├─ autoDream   : dedupe / merge / archive / fix / freeze-conflict
    └─ Sleep Mode  : tiered compression + pattern discovery + relation completion (opt-in)
    │
    ▼
  recall (hybrid search + rerank) ──► inject into the conversation
```

## Screenshots

> The panel is bilingual and follows your DSH interface language. English shots below; see the [Chinese](#中文) section for the localized UI.

<p align="center">
  <img src="images/screenshot-memories-en.png" alt="Memory browse" width="720"/><br/>
  <i>Record, browse and filter your memories.</i>
</p>

<p align="center">
  <img src="images/screenshot-entities-en.png" alt="Entities & relations" width="720"/><br/>
  <i>Entities are extracted from your memories, building a relation graph with attributes.</i>
</p>

<p align="center">
  <img src="images/screenshot-status-en.png" alt="Status & audit" width="720"/><br/>
  <i>The status panel shows your vector index, LLM spend and consolidation activity at a glance.</i>
</p>

<p align="center">
  <img src="images/screenshot-settings-en.png" alt="Memory settings" width="720"/><br/>
  <i>Retrieval, entity extraction and consolidation toggles are all configured in one place.</i>
</p>

<p align="center">
  <img src="images/screenshot-help-en.png" alt="Help & feedback" width="720"/><br/>
  <i>Optional write-protect token and feedback channels for a fully local, auditable setup.</i>
</p>

## Privacy

- Data stays on your machine only, never uploaded
- Memories are Markdown files, human-readable and editable
- Zero network dependency by default, no API key required
- No telemetry, no analytics, no remote logging

## Use it in other AI tools (MCP)

The plugin ships a zero-dependency stdio MCP server (standalone npm package **`mneme-memory`**, bin `mneme-mcp`). Any MCP client can mount the six memory tools (`memory_save` / `memory_search` / `memory_list` / `memory_get` / `memory_update` / `memory_delete`).

**One-time prerequisites**:

1. DSH is running with the plugin installed (the MCP data plane goes through the plugin's standalone API at `127.0.0.1:8790`)
2. Generate a token in the DSH panel under **Settings → External API**

**Per-client setup** (replace `<your-token>` with the value from the previous step):

| Client | Setup |
|--------|-------|
| **Claude Code** | Project-root `.mcp.json`: `{"mcpServers": {"mneme-memory": {"command": "mneme-mcp", "env": {"MNEME_TOKEN": "<your-token>"}}}}` |
| **Cursor** | Settings → MCP → Add Server; command `mneme-mcp`, env `MNEME_TOKEN` |
| **Codex** | `~/.codex/config.toml`: `[mcp_servers.mneme-memory]` section, `command = "mneme-mcp"`, `env = { MNEME_TOKEN = "<your-token>" }` |
| **Hermes** | `mcp_servers:` section of `~/.hermes/config.yaml`: `mneme-memory: {command: "mneme-mcp", env: {MNEME_TOKEN: "<your-token>"}}`, then restart |
| **OpenCode** | `opencode.json`: `{"mcp": {"mneme-memory": {"type": "local", "command": ["mneme-mcp"], "environment": {"MNEME_TOKEN": "<your-token>"}}}}` |
| **OpenClaw** | `openclaw mcp add mneme-memory --command mneme-mcp --env MNEME_TOKEN=<your-token>`, or Control UI → Settings → MCP |

> **Legacy mounts keep working**: `dsh-mneme-mcp` + `DSH_MNEME_TOKEN` remain supported (both the bin and env vars are preserved; no migration needed). If the npm package is not installed globally, use `npx` as the command with args `-p mneme-memory mneme-mcp` (an args array in Claude Code/OpenCode; `args = ["-p", "mneme-memory", "mneme-mcp"]` in Codex). Full config details and security notes: [full docs](dsh-mneme/README.md#mcp-server任意-mcp-客户端接入) (Chinese).

## Docs

| Doc | Path |
|-----|------|
| Full plugin docs (features / install / config / architecture) | [dsh-mneme/README.md](dsh-mneme/README.md)（中文） |
| stdio MCP server — plug the six memory tools into any MCP client (Claude Code / Cursor / …) | [dsh-mneme/README.md · MCP Server](dsh-mneme/README.md#mcp-server任意-mcp-客户端接入)（中文） |
| Configuration reference (all keys) | [dsh-mneme/docs/CONFIGURATION.md](dsh-mneme/docs/CONFIGURATION.md)（中文） |
| Entity structure design | [dsh-mneme/docs/ENTITIES.md](dsh-mneme/docs/ENTITIES.md) |
| Semantic architecture | [dsh-mneme/docs/SEMANTIC.md](dsh-mneme/docs/SEMANTIC.md) |
| Local model guide | [dsh-mneme/docs/LOCAL_MODEL.md](dsh-mneme/docs/LOCAL_MODEL.md) |
| Changelog | [dsh-mneme/CHANGELOG.md](dsh-mneme/CHANGELOG.md) |
| Security | [SECURITY.md](SECURITY.md) |

## 🗺️ Roadmap

```
🧬 Gene → 🛡️ Audit hardening → 💤 Sleep maintenance → 🕸️ Recall fusion & graph → ✨ Panel enhancement → 🌡️ Self-evolving memory → 🔐 Scope isolation
```

| Version | Theme | Status |
|---------|-------|--------|
| **v0.3** | Gene: entities / time-boxed attributes / relations | ✅ |
| **v0.4** | Sleep Mode: idle 4-phase deep maintenance | ✅ |
| **v0.5** | Recall fusion & visualization: BM25 + graph + hot memory | ✅ |
| **v0.6** | Session lifecycle: delete session ≠ delete memory | ✅ |
| **v0.7** | Self-evolving memory: heat decay + sleep dual-protection + desktop workbench/feature toggles | ✅ |
| **v0.8** | Scope isolation (agent/workspace stamping + retrieval weighting + opt-in hard filter) + conflict review queue + explicit attribution + ecosystem (stdio MCP server / graph recall axis / cold-start bootstrap / injection truncation & status bar / distill reliability / injection shaping & agent-driven organize / configuration reference & issue templates) | ✅ Released (up to v0.8.9) |

> Full per-minor-version changelog in [CHANGELOG](dsh-mneme/CHANGELOG.md).

## 🧪 Local development

```bash
cd dsh-mneme && npm install
npm test        # 1529 tests
npm run stress  # three-axis stress test
npm run sync    # src → lib sync
```

---

## Acknowledgements

Provenance of the autoDream concept (ideas credited, implementation original):

- **[Auto Dream in Claude Code](https://code.claude.com/docs/en/memory)** (Anthropic, Memory 2.0): the conceptual origin — a background sub-agent consolidates memory files between sessions (dedupe, resolve contradictions, prune decay).
- **[Sleep-time Compute: Beyond Inference Scaling at Test-time](https://arxiv.org/abs/2504.13171)** (UC Berkeley & Letta, arXiv:2504.13171): the academic thread behind the offline-consolidation idea.
- **cc-haha**: an early reference for the implementation approach.

On top of these, dsh-mneme adds its own engineering: K-Means++ cluster pre-grouping, a typed decision list (keep / merge / archive / conflict / update, plus supersede / differentiate on the sleep side), and a replayable sha256-digest audit chain (`dream_runs` / `receipt_chain`). If any source of inspiration is missing, please open an issue.

## 📜 License

MIT
