<p align="center"><strong>中文 | <a href="docs/SEMANTIC.md">English（语义增强）</a></strong></p>

# dsh-mneme

[![npm version](https://img.shields.io/npm/v/@modusensus/dsh-mneme?color=blue&label=npm)](https://www.npmjs.com/package/@modusensus/dsh-mneme)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Awesome](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![tests](https://img.shields.io/badge/tests-1479%20passed-success)](https://github.com/slow-stack/mneme)
[![CI](https://img.shields.io/github/actions/workflow/status/slow-stack/mneme/ci.yml)](https://github.com/slow-stack/mneme/actions)
[![node](https://img.shields.io/badge/node-22%2B-blue)](https://nodejs.org)
[![npm downloads](https://img.shields.io/npm/d18m/@modusensus/dsh-mneme.svg?color=blue&label=downloads)](https://www.npmjs.com/package/@modusensus/dsh-mneme)
[![coverage](https://img.shields.io/codecov/c/github/slow-stack/mneme/main)](https://codecov.io/gh/slow-stack/mneme)

> 给 DeepSeek Harness 的跨会话记忆插件：让 Agent 记住你、记住项目、自动整理记忆。**Mneme**（Μνήμη）——希腊记忆女神 Mnemosyne 之名，掌管记忆与梦境，正如 autoDream 在后台巩固记忆。

`dsh-mneme` 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Agent 提供持久的跨会话记忆能力。它借鉴了 Claude 的 **Dream 机制** 与 cc-haha / Claude Code 的 **autoDream** 记忆巩固功能——不仅**存储**记忆，还会**自动巩固**（去重、合并、冲突裁决、摘要生成），让记忆库越用越精炼。完整溯源与致谢见文末「[🙏 致谢](#-致谢)」。

## ⏱️ 30 秒理解

**一句话**：给 Agent 装上跨会话记忆——记住你、记住项目，并在后台自动整理，越用越懂你；**v0.8.0 起**记忆可按 agent 与工作区隔离（`scopeEnabled`），多 Agent / 多项目互不串台。

| ① 写入 | ② 存储 | ③ 进化 |
|--------|--------|--------|
| 对话中模型主动记录（`memory_save`，可带敏感度与事件时间）；会话结束自动提炼（`autoSummarize`） | SQLite 主库 + 人类可编辑 Markdown 镜像；实体 / 属性 / 时间轴三层结构化；记忆带 agent / workspace / 敏感度 / 发生时间标注 | 新会话自动注入相关记忆（按当前作用域加权，strictScope 开启后显式收窄的归属硬隔离）；autoDream 后台去重 / 合并 / 归档，冲突冻结待人工裁决 |

```bash
# 30 秒上手
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

**它不是什么**（边界声明）：

- 不是向量数据库——语义搜索是可选增强，默认零额外依赖
- 不替代会话日志——它存的是「值得跨会话记住的」精炼知识
- 不改变模型本身——进化的是记忆库与每次注入的上下文
- 删对话 ≠ 删记忆——记忆是跨会话的全局知识（v0.7.11 起不再与会话绑定），删除会话不影响已存入的记忆

## ✨ 功能

### 记忆存储（SQLite + Markdown 镜像）

- **SQLite 主存储**：`~/.dsh/memory/memory.db`，`node:sqlite` 内置，零原生依赖
- **Markdown 镜像**：按类型分文件（`preferences.md` / `projects.md` / `decisions.md` / `history.md` / `summary.md` / `patterns.md` / `pitfalls.md` / `constraints.md` / `rejected-solutions.md`，外加只读视图 `documents.md`），文件头是 YAML frontmatter（`type` / `generated.by` / `generated.at` / `covered` / `coverage` / `tags`）。人类可读，条目标题与正文可手工编辑（**人工修改优先**合并回库）；`documents.md` 例外：它只有 document 指针行（id、标题、摘要首句、文件路径），不含正文也不参与人工回填。文件头与条目元数据行由机器维护
- **9 种记忆类型**：`preference` 偏好 / `project` 项目 / `decision` 决策 / `history` 历史 / `summary` 会话总览 / `pattern` 模式 + 编码记忆三型 `rejected_solution` 被否方案 / `pitfall` 踩坑 / `constraint` 约束（v0.7.13 起，`codingRetrospect` 默认关；v0.7.11 近重写已收窄删除 user/fact 两型）
- **镜像同步状态机（v0.3.6+）**：mirror 与主库强一致，用 `generation`（期望轮次）/ `applied_generation`（已应用轮次）建模同步债务
  - 业务写操作在**自身事务内原子递增** desired generation——崩溃在 COMMIT 后、渲染前，重启也能凭 durable 债务恢复，绝不静默跳过（v0.3.8）
  - `generation` 用 SQLite 原子语句递增，多进程并发零丢失；带 `CHECK` 上界，负数/溢出拒绝
  - 逐 type 记录 `committed / failed / pending` 回执，健康端点区分 `ok / degraded / unknown`
  - 状态写失败不静默：同步失败落日志并留债务，重启自动收敛

### 模型工具（9 个）

| 工具 | 功能 |
|------|------|
| `memory_save` | 记录一条记忆（自动按标题去重合并；v0.8.0 起去重键含 agent/workspace/scope 作用域，可选 `sensitivity` / `occurred_at` 参数） |
| `memory_search` | 全文搜索（中文子串友好，可启用向量语义搜索；可选 `occurred_from` / `occurred_to` 按事件发生时间过滤） |
| `memory_list` | 按类型分页列出（`include_archived=true` 可查看已归档；可选 `occurred_from` / `occurred_to` 时间过滤） |
| `memory_get` | 读取单条记忆完整正文（v0.7.25，按 id；memory_search / memory_list 命中后读全文） |
| `memory_update` | 修改已有记忆 |
| `memory_delete` | 删除记忆（按记忆 ID 精确删除） |
| `memory_forget` | 抑制注入（降权不删除，可恢复） |
| `memory_archive` | 归档/恢复记忆（v0.2.5；归档后隐藏于列表/搜索/注入/整理，`archived=false` 可恢复） |
| `memory_runtime` | 本地推理运行时的状态 / 供给 / 校验（v0.7.32，自管运行时三档取件） |

### 自动注入 + 会话摘要

- **自动注入**：新会话开局注入记忆摘要（`summary` 优先 + 少量高重要性条目）
- **会话摘要**：`turn/end` 时用 LLM 提炼本次会话的偏好/决策/教训，自动入库（过滤 plugin 注入上下文，避免污染）

### autoDream 自动记忆整理 🧠

> **溯源**：autoDream 的理念源自 Claude Code 的 Auto Dream 记忆巩固功能（Anthropic，Memory 2.0 的后台整理子代理），其「离线巩固」思路与 UC Berkeley & Letta 的 *Sleep-time Compute* 论文（[arXiv:2504.13171](https://arxiv.org/abs/2504.13171)）一脉相承。dsh-mneme 将其引入 DSH 插件生态，并发展为自己的实现——K-Means++ 聚类预分组、类型化决策清单与可回放的 sha256 摘要审计链，详见文末「[🙏 致谢](#-致谢)」。

- **触发**：记忆数 > 10 或总字符 > 5000 时，异步自动触发（不阻塞写入）
- **决策清单式整理**：LLM 输出 `keep` / `merge` / `archive` / `conflict` / `update` 决策清单，服务端校验后逐条应用
  - `merge`：合并主题相近的条目，保留信息最完整者
  - `archive`：归档过时/冗余条目（可恢复，不物理删除）
  - `conflict`：裁决矛盾信息，胜者保留、败者归档并追加溯源注释；`conflictFreezeEnabled`（默认关）开启后矛盾对不自动裁决，改为冻结进**冲突队列**（状态页并排对比，人工选保留方，#166）
  - `update`（v0.2.1）：直接修正单条记忆的过时/错误内容（单 id / 必须实际变化 / 非 summary / 24h 保护 / 每次 ≤2）
- **失败追踪（v0.2.1）**：用户纠正记忆时写入 `failure_memories` 表（旧值/新值），为后续自进化积累数据
- **摘要生成**：整理后生成"记忆库总览"（单一实例），作为下次会话的优先注入
- **Fail-safe**：非法 LLM 输出（未知 id / 非法 action / 越界 importance / 跨类型合并等"单条非法"决策，Issue #26）默认跳过该条并应用合法子集（run 记为 `degraded`），绝不破坏记忆库
- **裁决审计**：每次运行写入 `dream_runs` 审计表（输入快照 sha256 digest + 完整输入快照 + 决策清单 + 逐 id 去向 + receipt），可离线回放；merge / conflict / update 幂等应用，重放/并发重复执行无累积副作用；update 记录 `_before` 快照

#### dreamMaxTokens 调优指南

默认 `131072`（即上限，#135）已为思考型模型预留推理+正文的双重预算（部分思考型模型仅推理就可能消耗 8k+ token），常规记忆库无需调整。若**记忆量大**（数万字符以上）且正文仍被截断，优先按下方「巩固模型分类声明」换非思考模型 / 配 `dreamReasoningEffort` 压低思考，再考虑调大输入侧上限（如 `distillMaxChars`）——`dreamMaxTokens` 本身已无上调空间。

> 若使用**思考型模型**（如 deepseek-v4-flash / DeepSeek-R1 类），模型可能把全部预算花在 reasoning 上导致正文为空（日志出现 `no json array in llm output`）。#135 修复后：未配置 `dreamReasoningEffort` 时会**自动取模型支持的最低档**发流（不再省略字段让模型自带默认档——v4-flash 系默认 high——顶上烧光预算），默认配置即生效；显式 `none` = 不发送字段用服务商默认，`off`/`low`/`medium`/`high` 原样传递，模型不支持的档位自动换用（拒绝原因记入 llm_audit）。正文仍为空时配置 `dreamProvider`/`dreamModel` 指向非思考模型（`dreamMaxTokens` 默认已是上限 131072，无上调空间）。sleep 侧对应 `sleepReasoningEffort`。

**巩固模型分类声明**（settings panel「巩固模型」= `dreamProvider`/`dreamModel`，睡眠侧对应 `sleepProvider`/`sleepModel`）：

| 模型类别 | 例子 | 说明 |
|---------|------|------|
| **非思考模型（推荐）** | glm-5-2 类等 | 无 reasoning 声明；即使配了 effort 被 harness 拒绝，fallback 去掉字段重试即成功。空体风险最低 |
| **思考模型（需实测）** | deepseek-v4-flash-ga 等 v4-flash-ga 系 | 默认开推理，可能烧光 token 预算返回空体；部分型号（如 v4-flash-ga）在 harness 侧被声明为**不接受任何 reasoning effort**（去掉 effort 时 harness 的 `defaultEffort` 会顶上来再次拒绝）。v0.7.26+ 已根治：`resolveDreamEffort` 发流前探测模型支持的档位，不支持的配置档位自动换用模型默认/首个支持档位，声明无 reasoning 能力的型号则省略字段。选用时建议配 `dreamReasoningEffort` 实测（未配置时自动取最低档），不行就换非思考模型 |

### Sleep Mode 系统级睡眠 💤（v0.4.0，opt-in）

从 autoDream 的"被动阈值触发"升级为"主动定时维护 + 分层压缩"。系统空闲 `sleepIdleMinutes` 分钟自动执行深度维护，**默认关闭**（`sleepModeEnabled: false`），开启后行为：

- **可中断**：AbortController 实现，用户恢复活动即中止当前周期（`noteWrite` 重置空闲计时 + 中断信号）
- **串行安全**：睡眠周期走 `service.enqueue` 串行队列，与 autoDream 严格不重叠；`minRefTimeMs` 防止快照后被召回的记忆被误降级
- **四阶段深度维护**：
  1. `conflict_resolution`：全库冲突消解，strictness 三级可配（gentle 0.92 / normal 0.85 / aggressive 0.75）
  2. `archival_demotion`：按 `last_accessed_at` 分层——30 天未召回压成摘要（原文进 `_full_content`，可无损恢复）、90 天完全归档
  3. `pattern_discovery`：LLM 扫描近期记忆提炼规律，产出 `type=pattern` 记忆，evidence 强校验防伪造
  4. `relation_completion`：检测孤立实体并补全隐含关系（共现 `related_to` / 项目 `part_of` / 技术 `depends_on`）
- **Fail-safe**：每阶段独立 try/catch，LLM 故障只跳过对应阶段；无 LLM 路由时纯规则降级（demotion/relations）照常执行
- **审计延续**：睡眠周期写入 `dream_runs`，`run_type='sleep'`，与 autoDream 共用审计表可追溯

> 配置详见 `docs/SLEEP.md`。

官方设置面板 → 「记忆库设置」→「记忆」标签：按类型浏览、全文搜索；启用向量搜索后可用「语义」切换做向量召回。

### 用户设置（画像 / 规则）与自定义指令 ⚙️

官方设置面板 → 「记忆库设置」标签：

- **用户画像**：一段自由文本描述用户自己（角色、背景、偏好），**每轮注入**到系统提示，让 Agent 始终遵循
- **规则**：Agent 必须遵守的行为规则列表（如"回答先给结论"），同样每轮注入
- **自定义指令**：注册斜杠命令（`/名称 [补充说明]`），触发时把用户定义的指令内容作为一条用户消息提交给当前 Agent，命令后缀会作为补充说明一并提交；界面仅显示提交回执（宿主不支持 followup 提交时退回旧行为，指令原文会显示在界面，便于复制后手动发送）。命令持久化到 SQLite，启动时自动注册到 DSH 命令表，增删实时生效

> 画像与规则通过独立的 `[用户设置]` 注入区块（优先级高于记忆库），即使记忆为空也会注入。

### 向量搜索（语义搜索）🔎

可选能力：接入 OpenAI 兼容的 embeddings API，让搜索能命中**字面不同但语义相近**的记忆。

**配置**：官方设置 → 「记忆库设置」→ 滚动到底部「向量搜索」区块：

| 字段 | 说明 |
|------|------|
| `启用向量搜索` | 总开关；开启后记忆面板出现「语义」切换 |
| `API 地址 (Base URL)` | OpenAI 兼容端点，如 `https://api.openai.com/v1`；也支持 SiliconFlow、智谱、本地 Ollama 等 |
| `API Key` | 对应服务的密钥 |
| `模型名` | embedding 模型，如 `text-embedding-3-small`、`text-embedding-v3`、`bge-m3` 等 |

保存配置后点「重建索引」，为已有记忆批量补建向量（新写入的记忆会自动嵌入）。之后在记忆面板输入查询并点「语义」，即可用向量召回语义相关结果；向量服务不可用时自动回退全文搜索。

> ⚠️ 密钥仅保存在本机 `~/.dsh/memory/memory.db` 的 `user_settings` 表，不会上传，也不会写入代码仓库。
> 需要 embedding 而非 rerank 模型：如阿里云 `text-embedding-v3` 可用，`qwen3-vl-rerank` 是 rerank 模型（不走 `/embeddings`）。

### 语义增强（Semantic）🧠

v0.2 起新增**完全离线的语义记忆引擎**（本地模型 + 精排 + 聚类）：

- **本地 Embedding**：三后端可选——ONNX（`Xenova/bge-small-zh-v1.5`，离线）/ Ollama / OpenAI 兼容，失败自动逐级降级，最差回退关键词搜索
- **Rerank 精排**：`Xenova/bge-reranker-base` 对召回候选交叉编码精排，提升 Top-K 准确率
- **autoDream 语义增强**：对记忆向量聚类（`clusterMemories`），自动发现主题相近 / 疑似矛盾的记忆，巩固更精准
- **搜索流水线**：混合召回（关键词 + 向量）→ Rerank → Top-K
- **自管运行时**：本地推理的依赖闭包（`@huggingface/transformers` + `onnxruntime-node` + `sharp`，从宿主收编时本机实测 49 个包 / 约 393MB）可收编到 `~/.dsh/mneme/runtime/`，与 profile 的依赖图解耦——由于 profile 是所有插件共用的依赖图，这份闭包留在此前的位置会让「安装任何插件」都替它重走一遍整条依赖链；收编优先硬链接，同盘时几乎不额外占盘。`@huggingface/transformers` 已从 `dependencies` 降为**可选 peer**，因此安装插件不再携带它；正在使用本地嵌入的用户请先按文档收编，否则升级后本地嵌入不可用（读写信道不受影响）
- **取回运行时的三条来源**：① 收编本机已有（零网络、同盘硬链接）→ ② 本地 `.tgz` 目录（`runtimeTarballDir`，某个包网络下不到时用）→ ③ npm registry（`runtimeMirror` 可换镜像），按随包发布的 `runtime-manifest.json` 逐个取并**先校验 sha512 再落盘**（win32-x64 实测约 33 个包 / 2142 个文件 / 数百 MB；清单平台无关，一份覆盖 win32/darwin/linux × x64/arm64；剔除 `onnxruntime-web`——Node 构建从不 import 它）。面板「向量索引」卡片在不就绪时会给出这段代价说明并提供一个按钮；不想开面板也可以让 agent 用 `memory_runtime` 工具（`status` / `provision` / `verify`）代做

配置只需在 `cordis.patch.yml` 里设置 `embedProvider`（默认 `openai`，保持 v0.1 行为；改为 `local` 即离线）。升级无需迁移数据。

```bash
node scripts/mneme-runtime.mjs status    # 运行时在哪、来源、结构是否完整（不加载模型）
node scripts/mneme-runtime.mjs adopt --from ~/.dsh/profiles/<profile>/node_modules
node scripts/mneme-runtime.mjs verify    # 真加载运行时并跑一次推理
```

> 三个命令的退出码为 `0` 健康 / `1` 不健康 / `2` 用法错误，便于脚本 gate；`--json` 输出机器可读结果。运行时不可用时不会崩——检索降级为关键词/BM25，读写不受影响。详见 [本地模型部署指南 §2.5](docs/LOCAL_MODEL.md)。

### 实体结构化记忆（Entity Gene）🧬

v0.3.0 起新增**记忆基因**层：从记忆里抽取**命名实体**、**带时间轴的属性**、**实体间关系**，让搜索从"字面关键词"升级为"按实体/属性精确召回"。

- **三表**：`entities` / `entity_attrs`（`valid_until` 快照式时间轴）/ `entity_relations`，旧库打开自动建表，幂等无迁移成本
- **自动抽取**：`entityExtractionEnabled=true` 后，新写入的记忆 fire-and-forget 触发 LLM 抽取（同名实体去重、属性存时间轴、关系追加；失败绝不阻塞写入）
- **实体搜索**（`searchMemories` 前缀路由，`entitySearchEnabled` 默认开）：
  - `entity:阿尔托` → 属性精确关联的记忆（`_score 1.0`）排在关键词提及（`_score 0.7`）之前
  - `attr:国籍=芬兰` → 精确匹配该属性值的记忆
  - `attr:国籍` → 该属性键的**全部**当前有效记忆（value 为空契约）
- **autoDream 联动**：update 决策写 `supersedes` 自引用（属性版本被替代）；merge 决策把 loser 的属性归属迁移到 keeper（keeper 已有同键当前值则失效）

> 📖 详见 [实体结构化记忆设计](docs/ENTITIES.md) · [语义增强架构](docs/SEMANTIC.md) · [本地模型部署指南](docs/LOCAL_MODEL.md)

### 记忆质量过滤 🧼（v0.4.6，默认开）

写库前对每条记忆做**启发式质量打分**（纯函数，无 I/O、无共享状态）：元记忆词汇（谈论记忆系统本身）、自指类型标签、内容过短、重复度高、与近期记忆近似重复都会扣分（0-100）：

- `score ≥ 60`：正常存储
- `30 ≤ score < 60`：`quality_score` 落库，注入排序改为按 `importance × quality/100` 降权（degraded）
- `score < 30`：归档并标记 `low_quality`——仍可显式搜索召回，只是**永不自动注入**。**例外（#135）**：`importance ≥ memoryQualityFilter.exemptImportance`（默认 4）的记忆只降权不归档——评分与信号标签照常落库，归档决定不再静默越过用户标注的重要性

`memoryQualityFilter.enabled` 可整体关闭，`archiveThreshold` / `degradeThreshold` / `minContentLength` / `exemptImportance`（1=全部豁免，5=仅最重要豁免）可调。此外更新记忆（`memory_update` 等）不会抹掉系统信号标签（`low_quality` / `duplicate` / `meta` / `self_referential` / `repetitive` / `short_content`）——它们是「为什么被降权/归档」的审计线索，与用户自传标签并集保留（#135）。

### LLM 消耗审计 📊（v0.4.6，默认开）

每次**后台 LLM 调用**都会写入 `llm_audit_logs` 表：`tokens` / `duration` / `status` / `source`（由哪个触发产生）。失败调用记为 `status=error`，绝不阻塞功能本体；`retentionDays`（默认 90）在启动时清理超期行。

覆盖的后台调用（`source` 即触发源，`operation_type` 区分同一源下的不同调用）：

| `source` | `operation_type` | 说明 |
|---|---|---|
| `autoDream` | `dream_consolidate` / `dream_summarize` | 巩固的整理裁决与总览摘要，各一行 |
| `autoDream` | `dream_narrative` | 叙述条合成，需 `dreamNarrativeEnabled`（默认关）才跑 |
| `autoSummarize` | `summarize_compress` | 空闲蒸馏的压缩 |
| `sleep` | `sleep_conflict` / `sleep_pattern` | Sleep Mode 的冲突裁决与模式挖掘，两阶段各一行 |
| `entityExtract` | `entity_extract` | 实体抽取，**每次写入记忆都会跑** |

> 后两条链路见 #250——它们是结构上漏接的后台路径（sleep 的 `streamText` 副本没有 `onUsage`、实体抽取适配器拿不到 `service`），不是刻意收窄口径。

新增两个只读 API：

- `GET /api/dsh-mneme/semantic/llm-audit?page=&pageSize=&source=` — 分页查询 + 按 source 过滤
- `GET /api/dsh-mneme/semantic/llm-audit/stats?days=` — 近 N 天按 source 汇总预算（tokens / 次数 / 失败数）

`/llm-audit/stats` 的 `by_source` 是服务端 `GROUP BY trigger_source`，不做任何白名单过滤，因此新链路自动进入汇总。

面板侧现状（#250 之后，未改面板）：

- 「LLM 消耗」卡读 `/llm-audit/stats`，但只渲染 `total_calls` / `total_tokens` 两个总数。新链路的 token 与次数**已经计入这两个总数**，所以「mneme 总共花了多少」现在是对的；
- 按链路的拆分（`by_source`）目前只能从 API 读，面板不展示——「哪条链路最费」在面板上还答不了；
- 状态页活动流仍只显示 `autoDream` / `autoSummarize` 两个硬编码来源（`lib/client.js`），新链路不会出现在活动流里。

这三处要动面板（活动流还有一处来源白名单加一处二元标签兜底，且 `pageSize=12` 会被每次写入都跑的实体抽取占满），留到面板批次，不在 #250 内。

> 实体抽取是**每次写入记忆都会跑**的链路，计入审计后 `llm_audit_logs` 的行数会随写入量线性增长（`retentionDays` 只约束上界、不约束增速）。若实测增速过快，再考虑按 `operation_type` 采样或单独保留期。

> 只读端点，与 list/search/semantic 一样在设置 `apiToken` 后仍保持开放。

### 记忆库主区视图与记忆图谱 🕸️（v0.5.0）

记忆功能从侧边栏抽屉收进**主内容区全宽 tab**（conversation.view 插槽，与「对话 / Trajectory」并列），侧边栏「记忆」入口点击后直接激活该 tab。页面顶部子 tab 行切换三个子视图：

- **记忆（三栏浏览）**：左栏分类树（类型 + 计数）/ 中栏时间树（月 → 日两级倒序、可折叠）/ 右栏详情（**全文不截断** + 复制全文）；语义搜索内嵌工具栏开关（防抖 250ms），`entity:` 前缀可「在图谱中查看」
- **图谱**：输入实体名，加载以该实体为中心的关联网络——
  - 服务端只读 ego-graph API：`GET /api/dsh-mneme/semantic/graph/ego?entity=<name>&depth=1|2`（BFS 层级遍历，`limit` 防大图失控，实体不存在 404；配套 `/semantic/graph/entity-attrs` 查实体属性）
  - 前端**零依赖手写 SVG 力导向布局**（插件运行时无法 require vis-network 等第三方库）：斥力 + 弹簧 + 向心引力物理模拟，节点按类型着色、按提及次数定半径，支持拖拽、点节点看属性、点边跳回来源记忆
- **设置**：画像 / 规则 / 指令 / 向量配置，限宽居中

图谱 ↔ 记忆双向互跳：图谱详情侧的关联记忆可点击，记忆边的「来源记忆」按 memory_id 直跳三栏视图并自动定位。

### 四路召回融合与会话热记忆 🔎（v0.5.0，v0.8.4 扩四路）

- **BM25 稀疏第三路召回**（`src/search/bm25.js`）：与向量召回、FTS5/LIKE 关键词并列——ASCII 词元 + CJK bigram 分词、IDF 加权（归一化 [0,1]），专有名词 / ID / 代码片段等散词查询不再依赖子串命中。融合规则：未召回行按 `0.3×BM25分` 回填；仅向量召回行获得词法加分；LIKE 已命中行不叠分。`bm25SearchEnabled` 可关
- **实体图召回轴（第四路，v0.8.4）**（`entityRecallEnabled` 默认关）：开启后检索融合池三源扩四源——store 新增 `findEntitiesMentionedIn` / `getLinkedMemoryIds` 反查原语 + `idx_relations_memory` 索引，命中实体所在记忆按边入池，fuseRecall 的 blend / rrf / minmax 全配方参与；实体轴与 BM25 同为确认/回填信号（we 并入 wb 共用 0.3 回填权重），永不主导语义排序，失败降级空数组；keyword 模式纯文本路径不吃实体轴
- **自适应阈值**（`src/search/adaptive.js`）：取代固定 `0.65` 截断——`entity:`/`attr:` 前缀放宽 0.5，短查询（<5 字符）收紧 0.7，长查询（>50）放宽 0.6，Top1/Top5 分差 > 0.3 时放宽让尾部进 Rerank；显式传 `threshold` 或 `adaptiveThresholdEnabled=false` 走旧行为
- **会话级短期热记忆**（`src/hot-memory.js`）：最近 N 轮对话（默认 5 轮，`hotMemoryRounds`）按 token 预算（默认 2000，`hotMemoryMaxTokens`）滚动截断，从会话事件日志无状态重建、不落库；注入顺序为「短期上下文 → 长期记忆召回 → 摘要」
- **选择性注入**：query 向量可用时注入候选按主题相似度重排（`selectiveInjectEnabled` 可关）；**搜索时语义去重**为激进选项（`searchSemanticDedup=true` 显式开启，近重复行 Rerank 前丢弃）
- **召回基准**（`scripts/benchmark-recall.js`）：标准查询集驱动，计算 Recall@5 与 MRR，`legacy`（三特性全关）vs `fused`（默认配置）双跑对比

## 📜 版本历史与路线图

> 完整版本说明见 [CHANGELOG](CHANGELOG.md) 与各版本 [GitHub Release](https://github.com/slow-stack/mneme/releases)；当前特性以本 README 正文与[配置表](#-配置)为准。早期版本中的实验性功能（Wiki-Link、tag 系统等）已在 v0.7.11 移除，详见 CHANGELOG 对应条目。

🧬 Gene → 🛡️ 审计加固 → 💤 Sleep Mode → 🕸️ 召回融合与图谱 → ✨ 面板体验 → 🌡️ 自进化记忆 → 🔐 作用域隔离 → 🌐 MCP 生态

## 📦 安装

### 前置条件

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）— 兼容 DSH 0.1.x 与 0.2.x（三段式 peer 范围见 `package.json`）；开发与 CI 已对齐 0.2 线，`0.2.0-rc.1` / `0.2.0-rc.2` 实测全绿。旧版兼容垫片（`Session.events` → `snapshotEvents()`，v0.7.9 起确保进入发布产物 lib/）保留
- Node 24+（`node:sqlite`）

### 安装步骤

#### 方式一：npm 安装（推荐）

dsh-mneme 是一个 **bundle**（声明了 `dsh.bundle` manifest），安装即自动激活，无需手动写配置：

```bash
# 1. 安装插件（自动注册 bundle 层）
dsh plugin --profile web add @modusensus/dsh-mneme

# 2. 重启
dsh web
```

> 如需自定义配置（阈值、延迟等），可在 `~/.dsh/profiles/web/cordis.patch.yml` 中按 `id: dsh-mneme` 覆盖默认值（见下方配置表）。

#### 方式二：从源码安装

```bash
git clone https://github.com/slow-stack/mneme.git
cd dsh-mneme
dsh plugin --profile web add .
dsh web
```

#### 自定义配置（可选）

默认配置即可用。如需调整，在 `~/.dsh/profiles/web/cordis.patch.yml` 中覆盖：

```yaml
- id: dsh-mneme
  name: '@modusensus/dsh-mneme'
  config:
    memoryDir: ~/.dsh/memory
    language: zh
    autoInject: true
    autoSummarize: true
    maxInjectedItems: 5
    importanceThreshold: 3
    autoDream: true
    dreamThresholdCount: 10
    dreamThresholdChars: 5000
    dreamDelayMs: 2000
```

## ⚙️ 配置

| 键 | 默认值 | 说明 |
|----|--------|------|
| `memoryDir` | `~/.dsh/memory` | 记忆存储目录（SQLite + Markdown） |
| `language` | `zh` | 记忆语言：生成的记忆条目、注入标题与后台 LLM 提示词所用语言（`zh` / `en`） |
| `autoInject` | `true` | 会话启动自动注入记忆 |
| `autoSummarize` | `true` | 会话结束自动提炼摘要 |
| `summarizeProvider` / `summarizeModel` | 空 | 摘要的 LLM 路由覆盖（空=使用当前会话模型）；推荐轻量模型节省主模型 token |
| `summarizeMinIntervalMinutes` | `0` | autoSummarize 最小触发间隔（0-10080，0=不限）：两次蒸馏之间最短间隔，失败/degraded run 也占用（#127） |
| `summarizeMaxEntriesPerRun` | `0` | 单次蒸馏产出记忆条数上限（0-50，0=不限）：节流防单会话大量重复条目（#127） |
| `summarizeMinWindowChars` | `0` | 蒸馏前零 LLM 预判：窗口可蒸馏文本不足此字符数直接跳过调用（0-100000，0=关）；skip 原因写入审计（#239） |
| `summarizeMaxRunsPerSession` | `0` | 每会话最多发起多少次蒸馏 LLM 调用（0-1000，0=不限）；只计真实调用，被预判拦下的不占额度（#239） |
| `summarizePeakHours` | 空 | 高峰时段（本地时间，逗号分隔、可带星期前缀，支持跨零点）：空=关；命中时蒸馏顺延到非高峰、窗口累积后一次蒸、skip 原因入审计。例：按高峰计费的供应商可写 `mon-fri 08:00-12:00,14:00-18:00`（如 DeepSeek，以其官方定价页为准）（#239） |
| `summarizePeakMaxDeferMinutes` | `120` | 高峰顺延上限（0-1440 分钟，0=不设上限）：到点仍处高峰就照常跑，避免长高峰把蒸馏饿死（#239） |
| `summarizeDedupeMode` | `off` | 落库前去重档位：`off`（默认=现状）/ `title`（零成本，仅拦完全同名）/ `vector`（复用 embedding 列做同会话语义近邻，无 LLM 调用，#127） |
| `summarizeDedupeMinSim` | `0.92` | vector 去重档的相似度阈值（0.5-0.99） |
| `summarizeDedupeWindowHours` | `24` | vector 去重的同会话时间窗（小时，0-168） |
| `distillMaxChars` | `24000` | 蒸馏输入的正文截断上限（1000-200000）：防止单轮转录把 LLM 输入撑爆 |
| `distillRateLimitIntervalMs` | `1000` | 蒸馏 LLM 调用全局串行队列的最小间隔（ms，0-60000，429 保护默认开） |
| `distillRateLimitRetries` | `3` | 命中 429 限流时的指数退避重试次数（0-10） |
| `distillRateLimitBaseDelayMs` | `1000` | 429 退避基准延迟（ms）：1s→2s→4s… |
| `maxInjectedItems` | `5` | 最多注入几条记忆 |
| `injectUncertaintyAdaptive` | `false` | 注入条数的查询自适应：确定性强的话题把条数收缩到一半（下限 1），模糊话题（回指/时间线索，或极短查询）维持 `maxInjectedItems` 上限；**只做单向收缩**，判据只看查询本身、不做额外检索（#239 第 5 项） |
| `injectRotationTurns` | `0` | 注入位跨轮轮换：同一条记忆在最近 N 个查询轮次注入过后本轮不再优先（新鲜优先、不足回填，槽位数不变；会话边界自动重置；`0` = 关闭保持现状） |
| `injectContentMaxChars` | `300` | 注入单条正文截断上限（60-4000，原硬编码 300，#164①/#225）：截断尾部带上限/原长/全文 `memory_get` 指引；块预算 `Math.max(1500, 上限+600)` 随上限放大 |
| `importanceThreshold` | `3` | 注入的最低重要性（1-5） |
| `autoDream` | `true` | 自动记忆整理开关 |
| `dreamThresholdCount` | `10` | 触发整理的记忆条数阈值 |
| `dreamThresholdChars` | `5000` | 触发整理的总字符阈值 |
| `dreamDelayMs` | `2000` | 整理异步延迟（去抖） |
| `dreamProvider` / `dreamModel` | 空 | dream 的 LLM 路由覆盖（显式配置优先于 agent 默认模型；留空则回退到 agent 默认模型） |
| `dreamMaxTokens` | `131072` | dream LLM 调用最大 token 数（上限 131072；#135 起默认即上限——思考型模型的 reasoning 与正文共享该预算，正文仍为空时优先换非思考模型或调 `dreamProvider`/`dreamModel`，见下方调优指南） |
| `dreamReasoningEffort` | 未配置=最低档 | dream LLM 推理强度透传：`off` / `low` / `medium` / `high` / `none`（未配置 = 自动取模型支持的最低档，避免思考模型用自带默认档烧光预算；`none`=不传该字段、用服务商自带默认；v0.7.26+ 模型不支持配置档位时自动换用其支持的默认/首个档位，无 reasoning 能力的型号省略字段） |
| `dreamCandidateMode` | `window` | dream 候选集构造：`window`（只取最近 `dreamMaxSnapshotSize` 条）/ `hybrid`（在此基础上并入向量翻出的高相似组）。纯时间窗口下，实测 45 对「双方活跃且 sim≥0.85」里 0 对能同时进窗口——该合并的一对几乎永远碰不到面。**已知边界**：dream 侧动作集仍是五分支（keep / merge / archive / update / conflict），hybrid 翻出的互补型 / 演进型对在 dream 里没有 `differentiate` / `supersede` 出口；正确出口在 sleep 侧（`sleepActionSet: full`）|
| `dreamCandidateMax` | `0` | hybrid 的候选总量上限；`0` = 复用 `dreamMaxSnapshotSize`。候选总量与库总量解耦，输入成本不随库增长 |
| `dreamCandidateMinSim` | `0.85` | hybrid 判「高相似」的阈值（与 sleep 的 normal 档对齐，两个模块共用同一个「高相似」定义） |
| `dreamMaxArchivePerRun` | `8` | 单轮 archive 决策上限（超限整单拒绝，防一次性大扫除；正常清理可调高） |
| `dreamSkipInvalid` | `true` | 单条非法决策跳过 + 合法子集应用 + run 记 degraded（#89）；`false` 恢复严格模式整单拒绝 |
| `allowCrossTypeMerge` | `false` | 显式放宽跨类型合并（默认关，类型边界由用户承担）；跨类型意图的正确出口是 `sleepActionSet: full` |
| `dreamImplicitKeep` | `true` | 显式决策覆盖率不足时的隐式 keep（未提及条目保持原样）；`false` + `dreamMinExplicitCoverage: 0` 恢复旧严格行为 |
| `dreamMinExplicitCoverage` | `0.5` | 显式决策覆盖率下限（0-1）：合法子集低于该值降级 degraded 而非整单拒绝（#104 方向 1，PR #200） |
| `dreamMaxSnapshotSize` | `200` | autoDream 滑动窗口上限：每次只对最近 N 条做 consolidation，窗口外不进 snapshot（防 LLM 输入撑爆） |
| `dreamSummaryProvider` / `dreamSummaryModel` | 空 | 总览（dream_summarize）专用模型路由（留空 = 沿用 `dreamProvider`/`dreamModel`）。consolidate 有窗口（`dreamMaxSnapshotSize`）而总览输入随库增长，ctx 需求差数倍——用小 ctx 模型跑巩固时把总览指到大 ctx 模型（issue #258） |
| `dreamSummaryMaxInputs` | `0` | 总览输入条数硬上限（0 = 不设上限）：超过时按 `updated_at` 倒序只保留最新 N 条进总览，防小 ctx 模型被全库输入撑爆；总览口径脚注的条数随实际输入变化 |
| `dreamMinIntervalMinutes` | `0` | autoDream 最小触发间隔（0-10080，0=不限）：失败/degraded run 也占用 |
| `dreamPeakHours` | 空 | 巩固侧高峰时段（本地时间，与 `summarizePeakHours` **同一份语法**）：空=关；命中时不调模型、baseline 不刷新（阈值继续累积，留到非高峰一次性巩固）、登记 `skipped`/`peak-hours` 审计并顺延到最近的高峰结束时刻。适合「白天要留算力给交互、巩固挪到夜里」的场景（#239 第 4 项镜像到巩固） |
| `dreamPeakMaxDeferMinutes` | `120` | 巩固侧高峰顺延上限（0-1440 分钟，0=不设上限）：到点仍处高峰就照常跑，避免长高峰把巩固饿死（#239） |
| `dreamNarrativeEnabled` | `false` | 叙述条总开关（#164 对齐，v0.8.4）：按共享 tag 主题簇合成叙述 + evidence 证据链，注入候选排除（按需检索，常驻位只留 dream 总览）；也走 feature_flags 白名单，lightMode 强制关 |
| `dreamNarrativeMinCluster` | `3` | 主题簇合成叙述的最小成员数（2-20，v0.8.4） |
| `apiToken` | 空 | 可选 API 鉴权 token；设置后写操作与密钥接口要求 `Authorization: Bearer <apiToken>` |
| `externalApiEnabled` | `false` | 独立 HTTP API 服务开关（v0.7.12）：开 standalone API（CLI 依赖它） |
| `externalApiHost` | `127.0.0.1` | standalone API 监听地址 |
| `externalApiPort` | `8790` | standalone API 监听端口 |
| `lightMode` | `false` | 轻量模式（v0.7.12）：关闭所有重型增强（语义/实体/叙述/heat 等，见 feature_flags 白名单），纯存储+注入 |
| `policyEpoch` | `0` | 冲突裁决规则版本：bump 后旧 dream_runs 降级为历史证据（receipt 不再驱动实时裁决） |
| `embedProvider` | `openai` | 语义后端：`openai`（默认，兼容 v0.1）/ `local`（ONNX 离线）/ `ollama` |
| `localEmbedModel` | `Xenova/bge-small-zh-v1.5` | 本地 ONNX embedding 模型 |
| `localEmbedDimension` | `512` | 本地 embedding 向量维度 |
| `localEmbedDevice` | `cpu` | 本地推理设备：`cpu` / `gpu` |
| `localEmbedBatchSize` | `8` | 本地 embedding 批大小（1-64） |
| `ollamaBaseUrl` | `http://localhost:11434` | Ollama 服务地址 |
| `ollamaModel` | `nomic-embed-text` | Ollama embedding 模型 |
| `embedModelCacheDir` | 空 | 模型缓存目录（空 = 用户级 `~/.dsh/mneme/models`） |
| `embedModelMirror` | `https://hf-mirror.com` | 模型下载镜像源 |
| `resilientModelDownload` | `true` | 模型文件下载断点续传与重试（v0.8.3，#194/#207）：Range/If-Range 续传、416/偏移失配重置、单写者锁+降级直通、空闲看门狗；`false` 恢复 env.fetch 原样 |
| `runtimeDir` | 空 | 自管运行时目录（#131）：空 = `~/.dsh/mneme/runtime`，放收编/下载的 transformers+onnxruntime 闭包（不留宿主 profile 依赖图） |
| `runtimeTarballDir` | 空 | 运行时离线取件：本地 `.tgz` 目录（如 onnxruntime-node 网络下不到时 `npm pack` 丢进去），有则优先于联网 |
| `runtimeMirror` | 空 | 运行时 registry 镜像前缀（如 `https://npmmirror.com/mirrors/npm/`）；留空用 runtime-manifest.json 官方地址 |
| `vectorSearchTopK` | `20` | 向量搜索返回 Top-K |
| `vectorSearchThreshold` | `0.65` | 向量搜索相似度阈值 |
| `hybridSearchVectorWeight` | `0.6` | 混合搜索向量权重 |
| `hybridSearchKeywordWeight` | `0.4` | 混合搜索关键词权重 |
| `recallFusion` | `blend` | 召回融合配方：`blend`（默认，加权求和）/ `rrf`（Reciprocal Rank Fusion）/ `minmax`（min-max 归一化加权）——后两者按 rank/尺度感知融合，修复原始分数单位不匹配 |
| `signalTransparency` | `false` | 给每条检索结果附加 `signals` 对象（{keyword, vector, bm25, final}）便于调试；只装饰不改排序 |
| `rerankEnabled` | `false` | 是否启用 Rerank 精排（显式开启才加载本地 onnxruntime 模型） |
| `rerankProvider` | `none` | Rerank 后端：`local` / `none`（默认 `none`） |
| `rerankModel` | `Xenova/bge-reranker-base` | Rerank 交叉编码模型 |
| `rerankBatchSize` | `8` | Rerank 批大小 |
| `rerankMaxCandidates` | `30` | Rerank 最大候选数 |
| `rerankScoreThreshold` | `0.1` | Rerank 分数阈值（低于丢弃） |
| `rerankDtype` | `q8` | Rerank 模型量化档（`q8` ≈ fp32 体积的 1/4，`fp32` 可关） |
| `reflectionUpdateEnabled` | `true` | update 决策总开关 |
| `reflectionFailureTracking` | `true` | 失败追踪总开关 |
| `reflectionUpdateMaxPerRun` | `2` | 每次整理最多 update 数 |
| `reflectionUpdateMinAgeHours` | `24` | 新建记忆保护期（小时） |
| `codingRetrospect` | `false` | 编码记忆蒸馏（v0.7.13，默认关）：完整转录提炼编码原子记忆（rejected_solution/pitfall/constraint 三类型） |
| `codingKeywords` | 内置词表 | 编码任务识别词表（读取侧门控）：命中即视为编码类任务，编码记忆才注入 |
| `codingBoostFactor` | `2` | 编码记忆注入排序的 boost 倍数（1-5） |
| `entityExtractionEnabled` | `false` | 实体抽取总开关（v0.3.0；存储层恒可用） |
| `entityExtractionModel` | 空 | 抽取专用模型（空 = 用 agent 默认模型） |
| `entityExtractionProvider` | 空 | 抽取专用模型服务商（空 = 用 agent 默认 provider/model，v0.7.29） |
| `entityExtractionReasoning` | 未配置=最低档 | 实体抽取推理档位（同 dreamReasoningEffort 语义，v0.7.29）：被模型拒绝时自动去 effort 重试 |
| `entityExtractionMaxEntities` | `10` | 每次抽取实体数上限 |
| `entityRecallEnabled` | `false` | 图召回轴（v0.8.4，#219）：实体挂联记忆并入检索融合池（三源扩四源，blend/rrf/minmax 全配方参与）；依赖实体抽取产出，也走 feature_flags 白名单，lightMode 强制关 |
| `entityExtractionMaxAttrs` | `20` | 每实体属性数上限 |
| `entitySearchEnabled` | `true` | `entity:` / `attr:` 前缀搜索开关 |
| `trustEpistemicWeighting` | `false` | 记忆可信度加权（v0.4.5，opt-in 默认关）：记忆按来源分级 `observation`> `inferred` > `subjective`，开启后检索排序优先高可信记忆、注入对 observation 标注 `[verified]`、dream merge/conflict 偏向高可信一方；关闭时 `epistemic_status` 仅随保存落库、不参与行为 |
| `evalPersistTestResults` | `false` | 检索评估落库（v0.4.5，opt-in 默认关）：开启后 `evaluateRetrieval` 把 precision/recall/mrr 快照写入 `recall_evals`；默认关时仅返回调用方不落库。生产 `searchMemories` 审计始终走 `recall_runs`，无条件不触碰 `recall_evals` |
| `autoReindexOnBoot` | `true` | 存量记忆缺 embedding 时，向量已配置则启动后延迟后台按批次限速自动回填重建（设为 `false` 仅手动重建）。只补**活跃**记忆（归档/遗忘行不参与召回，#128）；模型指纹一致时照常补缺失行、不再短路（#128） |
| `hybridInject` | `true` | 注入语义召回优先（v0.4.6，Bug4）：`injectCandidates` 带非空 query 时先走向量索引语义召回候选，规则筛选补足/去重；空 query / 无向量回退旧逻辑 |
| `bm25SearchEnabled` | `true` | BM25 稀疏第三路召回（v0.5.0）：ASCII 词元 + CJK bigram，IDF 加权，散词/ID/代码片段查询不再依赖子串命中 |
| `adaptiveThresholdEnabled` | `true` | 自适应相似度阈值（v0.5.0）：按查询形态动态截断（前缀 0.5 / 短查询 0.7 / 长查询 0.6 / 头部分差大放宽 0.5），显式传 `threshold` 走旧行为 |
| `hotMemoryEnabled` | `true` | 会话级短期热记忆总开关（v0.5.0）：关闭后热记忆块不再注入（长期召回不受影响） |
| `heatEnabled` | `false` | 热度模型总开关（v0.7.0 / v0.7.20 回归，**默认关**——v0.7.12 起用户已习惯无 heat 行为）：开启后提供热度字段 / sleep 热联合降级保护 / 前端热度投影，并在注入排序的优先级层内乘热度（#218；`order=chrono` 分页序与召回融合序不动）；关闭则跳过 heat 计算与热度触达，sleep 降级退回纯时间分层。也走 feature_flags 白名单（面板可启停=回滚开关），lightMode 预设强制关 |
| `heatGlobalBeta` | `1.0` | 广义指数形状参数 β（`H=exp(-λ·Δt^β)`，issue #218 拍板）：β=1 纯指数；以 Δt>1 小时为准，β<1 衰减更慢（亚线性长尾）、β>1 衰减更快（超线性）；0<Δt<1 的首小时内方向相反（Δt^β 随 β 增大而变小） |
| `heatTypeDecay` | 内置 TYPE_DECAY | per-type 衰减因子 λ；λ=0 的类型免疫（preference/pattern/summary 热度恒 1.0，sleep 永不降级） |
| `sleepHeatThreshold` | `0.05` | sleep 降级联合判定热度下限：heat<该值 **且** importance<5 才允许降级 |
| `sleepModeEnabled` | `false` | Sleep Mode 总开关（v0.4.0，opt-in）：会话空闲 `sleepIdleMinutes` 后触发深维护（巩固/降级/模式发现），与 autoDream 串行不重叠 |
| `sleepIdleMinutes` | `5` | 触发 sleep 的空闲窗口（分钟，1-60） |
| `sleepMinIntervalHours` | `8` | 两次 sleep 最小间隔（小时，1-168）：间隔内再次空闲不重复触发 |
| `sleepConflictStrictness` | `normal` | 冲突裁决严格度：`gentle`（高置信，阈值 0.92）/ `normal`（标准，0.85）/ `aggressive`（低置信也裁决，0.75） |
| `sleepActionSet` | `conflict` | sleep 冲突阶段动作集：`conflict`（默认=现状，只用 conflict/keep，后台流程不静默扩张）/ `full`（六分支 merge/update/supersede/differentiate/conflict/keep，#126） |
| `sleepArchiveDays` | `30` | 降级分层一：N 天未访问 → 缩为摘要（正文进 `_full_content`） |
| `sleepCompressDays` | `90` | 降级分层二：N 天未访问 → 直接归档（实体关系保留） |
| `sleepPatternMinMemories` | `100` | 模式发现扫描窗口（最近 N 条记忆，10-1000） |
| `sleepPatternLookbackDays` | `30` | 模式发现回看实体属性变更的天数（1-90） |
| `sleepMaxPatternPerRun` | `3` | 每轮模式记忆产出上限（0=禁用，0-10） |
| `sleepProvider` / `sleepModel` | 空 | sleep 深维护专用 LLM 路由覆盖（留空用巩固模型或当前模型；建议同巩固模型选非思考模型） |
| `sleepReasoningEffort` | 未配置=最低档 | sleep 各阶段 LLM 推理档位（同 dreamReasoningEffort 语义，v0.7.26） |
| `recallRecordDefault` | `true` | recall_runs 记录默认开（显式传 `recordRecall:false` 的调用方不受影响）；注入同样落账（`mode='inject'`，随本开关，#217） |
| `recallRetentionDays` | `90` | recall_runs 滚动清理保留天数 |
| `hotMemoryRounds` | `5` | 会话级短期热记忆轮次（v0.5.0）：最近 N 轮对话滚动注入，从会话事件日志无状态重建、不落库 |
| `hotMemoryMaxTokens` | `2000` | 热记忆 token 预算（v0.5.0，200-32000），超出滚动截断 |
| `selectiveInjectEnabled` | `true` | 选择性注入（v0.5.0）：query 向量可用时注入候选按主题相似度重排，替代固定规则序 |
| `searchSemanticDedup` | `false` | 搜索时语义去重（v0.5.0，激进选项默认关）：embedding 余弦 ≥0.95 近重复行在 Rerank 前丢弃 |
| `searchSemanticDedupThreshold` | `0.95` | 语义去重相似度阈值（v0.5.0，默认 0.95，范围 0.5-1.0）：`searchSemanticDedup=true` 时生效，调整可防小模型误折叠 |
| `memoryQualityFilter` | `{enabled:true, archiveThreshold:30, degradeThreshold:60, minContentLength:10, exemptImportance:4}` | 记忆质量过滤（v0.4.6，默认开）：写库前启发式打分 0-100，元记忆词汇/自指/过短/重复/近似重复扣分；≥60 正常存储，30-60 降权（注入排序按 importance×quality/100），<30 归档标记 `low_quality`（显式搜索仍可召回，永不自动注入；`exemptImportance` 豁免：importance ≥ 该值只降权不归档，#135） |
| `llmAudit` | `{enabled:true, retentionDays:90}` | LLM 消耗审计（v0.4.6，默认开）：每次后台 LLM 调用（`autoDream` / `autoSummarize` / `sleep` / `entityExtract`，对应 `operation_type` 为 `dream_consolidate` / `dream_summarize` / `dream_narrative`、`summarize_compress`、`sleep_conflict` / `sleep_pattern`、`entity_extract`）写 `llm_audit_logs`（tokens/duration/status/source）；失败记 error 不阻塞；只读 API `/api/dsh-mneme/semantic/llm-audit` + `/llm-audit/stats` |
| `scopeEnabled` | `false` | 作用域隔离总开关（v0.8.0，issue #17）：memory_save 按会话身份写入 agent / workspace 标注（agentPreset / 工作区路径，registry 反查取不到回退 header.cwd，再取不到 NULL）；去重键扩展含作用域三元——跨作用域同标题不再物理合并；检索与注入排序按当前会话作用域加权（命中 ×1.25、他 scope ×0.5 保留可见，issue #339 补齐注入通道）。也走 feature_flags 白名单（面板可启停） |
| `strictScope` | `false` | 作用域硬过滤（v0.8.0 引入，v0.8.1 起只认显式声明；依赖 `scopeEnabled`）：检索 / 注入 / 列表 / 单取四路过滤，**显式声明**收窄到他者作用域的记忆完全不可见；载体自动标注只降权保留可见——真正的物理隔离请用 sensitivity。会话身份解析不到时 fail-closed 只挡显式行。关闭时全部为软隔离（降权保留可见）。也走 feature_flags 白名单 |
| `writeAdmission` | `{enabled:false, enforce:false}` | 写入准入（issue #254，默认关）：把「这条该不该进库」前移到 LLM 之前。第 1 级是零 LLM 的确定性判据——空白 / 纯噪声 + 密钥 / PII（判据来源是 #164 A2，经 `sensitiveScan` 注入，本批只定义接口）。`enabled` 跑判据并落审计行（`llm_audit_logs` 的 `metadata.deny`），`enforce` 才真的拒（`store.save` 之前返回，`memory_save` 返回 `action:"denied"` + `reason`）；只开 `enabled` = 仅告警、写入不拦。去重键命中不进第 1 级（归 write-update 放行），G1/G2 阈值只计量。也走 feature_flags 白名单 |
| `conflictFreezeEnabled` | `false` | 冲突冻结（v0.4.4）：dream 发现矛盾对不自动裁决，冻结进冲突队列；状态页「冲突队列」支持并排对比与人工确认（保留 A / 保留 B / 仅标记已处理，v0.8.0） |
| `conflictFreezeMaxPending` | `100` | 冲突冻结队列最大挂起数（1-1000）：超出后不再入队（防队列无限膨胀） |
| `escapePromptVariables` | `true` | 注入文本花括号转义（v0.8.0 恢复，issue #162）：注入边界把 `{{...}}` 转义，防止 hot memory / 记忆原文里的 Go template / Vue 语法触发宿主 interpolate 抛错卡死会话（v0.7.4 曾修复、v0.7.11 误删） |

> 🔐 **API 安全**：DSH 无内置鉴权且默认仅监听 `127.0.0.1`。插件 API 默认开放（便于 Web 面板即装即用）。如需防护（如局域网暴露），在配置中设置 `apiToken`：写操作（画像/规则/命令）与密钥端点（`vector-config`、`vector-reindex`）需携带 `Authorization: Bearer <token>`（前端设置面板可填入同一 token），只读的 `list` / `search` / `semantic` 保持开放。`/api/dsh-mneme/vector-config` 返回的 `apiKey` 已掩码（`sk-***…`），存储仍保留明文供调用；前端回传空或掩码值表示"不改 key"。


> ⚠️ **已知边界：极简模式（minimal agent preset）下不注入**（宿主设计，非插件缺陷）：minimal 预设的组合文件显式 `complete: true` + `includeRuntimeContext: false`——整条系统提示词被 persona 钉死、全部 runtime context 快照被压制，**记忆注入 / 用户画像 / hot memory 在极简模式会话中一律不送达模型**（宿主内置 context 同样消失）。判断与解法：会话头部显示「极简模式」即为该形态；需要记忆注入请改用标准模式（会话级切换，或 `~/.dsh/settings.yaml` 设 `agent-presets.default: standard`——注意 `--dump-config` 显示的是 bundle 默认值，会被用户层覆盖，不能反映实际生效值）；极简模式下的过渡方案是把画像/规则写入 `AGENTS.md`（agent-instructions 走 section 路径，不受该压制影响）。

## 外部 API 与 CLI

除 DSH 内部端口外，插件还可以开启一个**独立的 HTTP 外部 API**（默认 `http://127.0.0.1:8790`，Bearer token 鉴权），供其他插件、CLI 脚本或桌面工具读写记忆，不依赖 DSH 内部端口。

### 启用与鉴权

- 在插件设置中开启外部 API（默认监听 `127.0.0.1:8790`，仅本机可访问）；
- 访问 token 在插件设置 / 面板「设置 → 外部访问」中查看；
- 除 `GET /health`（免鉴权）外，所有路由需携带 `Authorization: Bearer <token>`，无效 token 返回 `401 {"error":"unauthorized"}`。

主要路由：

| 方法 | 路由 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查（免鉴权），返回 `{ok:true}` |
| `GET` | `/status` | 版本、记忆统计、实体数、运行时长 |
| `GET` | `/profile` | 用户画像，返回 `{profile:"..."}`；未设置时为空字符串 |
| `GET` | `/rules` | 行为规则列表，返回 `{rules:[...]}`；未设置时为空数组 |
| `GET` | `/memories?limit&offset&type&minImportance&source&order=chrono&include_archived&occurred_from&occurred_to` | 分页列出记忆（`include_archived=true` 含归档；occurred 时间窗按 `occurred_at` 回退 `created_at`） |
| `GET` | `/memories/:id` | 单条记忆 |
| `POST` | `/memories` | 新增记忆 `{type,title,content,importance?,tags?,source?,sensitivity?,occurred_at?,agent_scope?,workspace_scope?}`；响应含 `action: created\|merged` |
| `PUT` | `/memories/:id` | 局部更新 `{title?,content?,type?,importance?,tags?,reason?,agent_scope?,workspace_scope?}`；content 改写按 human_override 入档 |
| `DELETE` | `/memories/:id` | 删除记忆 |
| `GET` | `/search?q&mode=keyword\|vector\|hybrid\|auto&topK&occurred_from&occurred_to` | 搜索（关键词 / 向量 / hybrid=向量领位关键词补位 / 自动） |
| `POST` | `/bootstrap` | 冷启动（v0.8.4）：从仓库目录反向构建初始记忆，body `{dir}` 必填；幂等（(type,title,scope) 去重 + `_overwrite` 原地刷新），零 LLM、必有产出 |

### curl 示例

```bash
# 服务状态
curl -s -H "Authorization: Bearer $DSH_MNEME_TOKEN" http://127.0.0.1:8790/status

# 列出最近 5 条记忆
curl -s -H "Authorization: Bearer $DSH_MNEME_TOKEN" \
  "http://127.0.0.1:8790/memories?limit=5"

# 新增一条决策记忆
curl -s -X POST http://127.0.0.1:8790/memories \
  -H "Authorization: Bearer $DSH_MNEME_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"decision","title":"采用 SQLite","content":"存储层使用 node:sqlite","importance":4,"tags":["存储"]}'
```

### CLI 安装

插件自带零依赖 CLI（随 npm 包一起发布）：

```bash
npm i -g @modusensus/dsh-mneme
dsh-mneme --help
```

首次使用先配置服务地址与 token（也可用环境变量 `DSH_MNEME_URL` / `DSH_MNEME_TOKEN`，或 `--url` / `--token` 参数临时覆盖）：

```bash
dsh-mneme config set http://127.0.0.1:8790 <你的token>
```

### CLI 常用命令

```bash
dsh-mneme status                                     # 服务状态
dsh-mneme list --type project --limit 10             # 列出记忆
dsh-mneme search "部署流程" --mode vector --topk 5    # 语义搜索
dsh-mneme add --type decision --title "采用 SQLite" \
  --content "存储层使用 node:sqlite" --importance 4 --tags 存储,决策
dsh-mneme get 42                                     # 查看单条
dsh-mneme delete 42                                  # 删除
dsh-mneme config show                                # 查看当前配置（token 打码）
```

> 所有读取/写入命令支持 `--json` 输出原始 JSON；`config path` 打印配置文件路径（`~/.dsh-mneme/cli.json`）。

### MCP Server（任意 MCP 客户端接入）

> Claude Code / Codex / Hermes / OpenCode / OpenClaw 等各客户端的最小挂载配置速查表见[根 README](../README.md#用在其他-ai-工具里mcp)；本节是完整配置与安全说明。规划中的独立分发包 `mneme-memory` 落地后，挂载命令将保持兼容（详见仓库 Discussions #300）。

插件自带 stdio MCP server（`bin/dsh-mneme-mcp.mjs`，零依赖，随 npm 包发布，bin 名 `dsh-mneme-mcp`）。任何支持 Model Context Protocol 的客户端（Claude Code、Cursor 等）挂载后即可获得与 DSH 内一致的记忆工具六件套：`memory_save` / `memory_search` / `memory_list` / `memory_get` / `memory_update` / `memory_delete`——工具名、参数与去重合并、重要性等语义与 DSH 内工具对齐（测试锁漂移）。

数据面走上面的**独立外部 API**（8790，Bearer）：写入并发由 DSH 单点负责；DSH 未运行（外部 API 未启动）时 MCP 侧调用会报连接失败。scope 语义注意：外部 API 无会话上下文，`memory_save` 不做自动标注，只认显式 `agent_scope` / `workspace_scope` 声明。

配置优先级沿用 CLI 约定：环境变量 `DSH_MNEME_URL` / `DSH_MNEME_TOKEN` > `~/.dsh-mneme/cli.json` > 默认 `http://127.0.0.1:8790`。安全注意：服务默认只绑 `127.0.0.1`；若把 `DSH_MNEME_URL` 指向非回环的明文 HTTP 地址，Bearer token 将明文过网（启动时会有 stderr 警告）——远程场景建议走 SSH 隧道。

Claude Code 挂载示例（项目根 `.mcp.json`；token 在面板「设置 → 外部访问 API」查看）：

```json
{
  "mcpServers": {
    "dsh-mneme": {
      "command": "dsh-mneme-mcp",
      "env": { "DSH_MNEME_TOKEN": "<你的token>" }
    }
  }
}
```

未全局安装 npm 包时，把 `command` 换成 `npx`、加 `args: ["-p", "@modusensus/dsh-mneme", "dsh-mneme-mcp"]` 即可。

## 🏗️ 架构

```
┌─────────────────────────────────────────────────┐
│  存储层：SQLite (archived/forgotten 状态)         │
│         + Markdown 镜像（人工可编辑，双向同步）    │
├─────────────────────────────────────────────────┤
│  服务层：saveWithDedupe / injectCandidates        │
│         / mergeHumanEdits / onWrite 钩子          │
├─────────────────────────────────────────────────┤
│  模型接口：9 个工具 + 自动注入 + 会话摘要          │
├─────────────────────────────────────────────────┤
│  autoDream：阈值调度 → LLM 决策清单               │
│            → 校验（fail-safe）→ 应用 → 摘要       │
├─────────────────────────────────────────────────┤
│  Web 面板：设置面板内嵌 + 浏览/搜索（含向量）    │
└─────────────────────────────────────────────────┘
```

**源码结构**：

```
src/
├── store.js          # SQLite 存储（CRUD、搜索、归档/遗忘、schema 迁移、scope 四列）
├── mirror.js         # Markdown 镜像（渲染/解析，人工优先）
├── service.js        # 领域逻辑（去重合并、注入筛选、写入钩子、scope 加权/硬过滤、冲突队列）
├── scope.js          # 作用域解析（agentPreset + workspace registry 反查，issue #17）
├── config.js         # schemastery 配置 schema
├── tools.js          # 9 个模型工具（defineTool）
├── inject.js         # systemPrompt.context 动态注入（含花括号转义）
├── summarize.js      # 会话结束 LLM 摘要
├── dream.js          # autoDream 调度 + runDream（LLM 决策 + 摘要）
├── dream/decisions.js# 决策校验（fail-safe）+ 决策应用
├── dream/clustering.js # 候选集聚类（k-means++ seeding）
├── dream/sleep.js    # Sleep Mode 分层压缩
├── entities/extractor.js # 实体抽取器（v0.3.0：LLM JSON 抽取 + 去重 + fail-safe）
├── search/bm25.js    # BM25 稀疏召回（v0.5.0：分词 + IDF 索引）
├── search/adaptive.js# 自适应相似度阈值（v0.5.0）
├── hot-memory.js     # 会话级短期热记忆（v0.5.0：滚动轮次 + token 预算；注入剥离 reasoning）
├── runtime/          # 自管本地推理运行时（收编 / 本地 .tgz / registry 三档取件 + 校验）
├── embedding.js      # OpenAI 兼容 embeddings 客户端 + 向量检索
├── api.js            # HTTP 路由（Web 面板数据通道，含 /conflicts 冲突队列）
└── index.js          # 插件接线
lib/                  # src 的同步分发产物（npm run sync；发布前由 root prepack 的 check-sync.js 校验一致性；唯一手写例外 lib/client.js——Web 面板 bundle，sync 不覆盖）
test/                 # 1479 个 node:test 测试（审计与三轴线压测不变量；src↔lib 一致性由 scripts/check-sync.js 发布闸门校验）
scripts/              # e2e-dsh.js 端到端演示 · stress-dsh.js 三轴线压测 · sync-lib.js 同步 · check-sync.js 发布闸门 · benchmark-recall.js / benchmark-embed.js / benchmark-rerank.js 基准 · sync-test-badge.mjs 测试徽章 · build-runtime-manifest.mjs 运行时清单
```

## 🧪 开发

```bash
cd dsh-mneme
npm install        # 安装 peer 依赖（以 devDependencies 形式，用于本地测试）
npm test           # 运行 1479 个测试
npm run stress     # 三轴线压测：长会话检索 / 冲突仲裁 / 多 Agent 并发（离线 mock LLM）
npm run sync       # 把 src/ 同步到 lib/（发布时由 prepack 钩子自动执行）
```

> 压测（`npm run stress`）三条轴线：**长会话检索**（Recall@k、陈旧残留率）、**冲突裁决**（可重放仲裁集：审计快照 hash + receipt + 幂等回放）、**多 Agent 并发**（丢更新、重复合并、事务/崩溃恢复）。每次 autoDream 运行都会写入审计表 `dream_runs`（输入快照 digest + 决策清单 + 逐 id 去向 + receipt），让高通过率下也能定位静默错误。

> `lib/` 是 `src/` 的同步分发产物（`npm run sync`）：除 **`lib/client.js`**（Web 面板 bundle）为 lib 独有的手写文件、sync 与 check-sync 均不触碰外，其余全部由 src 复制而来。改 src 必 `npm run sync` 并提交 lib，否则发布产物静默失效（issue #65 教训）。

## 📄 设计文档

> 设计文档位于仓库根 `docs/`，链接以 `../docs/` 相对路径指向（GitHub 上从本目录打开可正常跳转）。

- [配置说明（全键参考）](docs/CONFIGURATION.md)
- [实体结构化记忆设计](docs/ENTITIES.md)
- [语义增强架构](docs/SEMANTIC.md)
- [本地模型部署指南](docs/LOCAL_MODEL.md)

## 🙏 致谢

autoDream 的理念溯源（理念借鉴、实现原创）：

- **[Claude Code 的 Auto Dream](https://code.claude.com/docs/en/memory)**（Anthropic，Memory 2.0）：理念源头——会话间隙由后台子代理整理记忆文件（去重、修矛盾、清衰减）。
- **[Sleep-time Compute: Beyond Inference Scaling at Test-time](https://arxiv.org/abs/2504.13171)**（UC Berkeley & Letta，arXiv:2504.13171）：Auto Dream「离线巩固」思想背后的学术脉络。
- **cc-haha**：早期实现思路的参照之一。

在上述工作之上，dsh-mneme 做了自己的工程发展：K-Means++ 聚类预分组（`src/dream/clustering.js`）、类型化决策清单（keep / merge / archive / conflict / update，及 sleep 侧 supersede / differentiate）与可回放的 sha256 摘要审计链（`dream_runs` / `receipt_chain`）。如有遗漏的灵感来源，欢迎提 issue 指出。

## 📜 License

MIT
