# dsh-mneme 与其他记忆工具的能力对比 / Capability Comparison

> 更新于 2026-11-13（上一版 2026-10-16）。对比基于各项目公开文档与源码（出处见文末），只比较**能力结构**，不回答「谁更准」——效果类问题请以各系统在公开基准上的实测为准。dsh-mneme 是为 DSH 设计的记忆插件（SQLite + Markdown 镜像、完全离线），同时自带独立服务：stdio MCP server（npm 包 `mneme-memory`，任意 MCP 客户端可挂载）与不开 DSH 的常驻 daemon（`dsh-mneme-serve`），第三方集成读写同一份记忆库；其余为通用记忆服务/库，定位不同，读表时请带着这个前提。
>
> **本版做了什么**：补上 dsh-mneme 0.14.0 才有的三项（情感记忆、图像描述与溯源、第三方写入），检索行同步到全量语料增量索引；竞品侧逐列复核，改掉 9 处（其中 4 处原先把「我们没找到」写成了「对方没有」），并把新增的三行 × 四家共 12 格查实。许可证于 2026-11-13 重核四家 LICENSE 实文，与上一版一致。
>
> **一列的前提**：Zep 是托管的企业上下文层（自研 Konig 图库），Graphiti 是它的开源框架（自带 Neo4j / FalkorDB / Neptune）。下面这列以**开源 Graphiti 的实现**为准，不拿 Zep 的托管能力给 Graphiti 加分。

| 能力 | dsh-mneme | Graphiti（Zep 开源内核） | Mem0 | Letta (MemGPT) | Hindsight |
|---|---|---|---|---|---|
| 存储底座 | SQLite 主库 + 人类可编辑 Markdown 镜像 | 时序知识图谱（Neo4j / FalkorDB / Neptune） | 向量 + 图混合的抽取式记忆 | 自编辑记忆块（core memory）+ MemFS 文件层 | PostgreSQL + pgvector（或 Oracle 23ai）；四层（事实/经历/观察/心智模型）是记忆类型，不是底座 |
| 检索 | BM25（0.14.0 起全量语料 + 增量索引）+ 图谱 + 会话热记忆，实体图第四路（RRF 融合） | 语义 + 关键词 BM25 + 时序图遍历 | 语义 + 关键词 + 图 | 递归检索 + 自编辑 | 四路并行（语义/BM25/图/时间）+ RRF + 重排 |
| 写入时 LLM 抽取 | 否（原文直存，巩固期才用 LLM） | 是（抽实体/关系） | 是（抽事实，Add-only：只累积、不覆盖） | 部分 | 是（retain 抽实体/时间） |
| 情感记忆 | 情绪归因写成关系边（`affective_context`）；跨会话达阈值的升为 pattern 进注入，单次场合的情绪经 `affectiveInjectEnabled` 附在注入行上（默认关） | 无专门机制：情绪只作为抽取内容，落成普通实体/关系 | 无专门类型：prompt 要求保留情绪状态，但仍是普通 memory | 无：MemFS 记忆文件只认 markdown，情绪只能塞进某个块 | 无：只有 bank 的 disposition traits（怀疑/字面/共情），那是推理风格不是情绪记忆 |
| 图像 / 多模态 | 描述档让能看图的模型给每张图写一句、并进蒸馏（`imageDescribeEnabled`）；`image_sources` 让记忆回指来源窗口与图（`imageMemoryEnabled`）。不存图字节、不做 OCR | 不支持：EpisodeType 只有 message / json / text / fact_triple，全库无 image_url | 只存描述：vision 模型生成文字后入库，原图不留，因而没有图像溯源 | 存原图：MemFS 收 png/jpg/webp/gif，返回 `kind:"image"` 与 mime，git 跟踪、可同步；另有 `view_image` 工具 | 存原图 + 溯源：retain 收图文交错附件，按内容寻址落盘，`(bank_id, document_id, attachment_hash)` 记行 |
| 第三方写入 | HTTP API + 常驻 daemon（`dsh-mneme-serve`），别的插件可直接写进同一份库；stdio MCP 另开六个工具 | 有，REST 与 MCP 均为参考实现，需自行部署 | 有，自托管 REST `POST /memories`（另有 PUT / DELETE / search / history） | 有，官方 REST `/v1/agents…`，默认走 Cloud | 有，REST + 每个 bank 一个 MCP 端点（retain / recall / reflect） |
| 离线巩固 | autoDream（快写慢巩固） | 无批处理式巩固（明说只增量、不重算） | 无后台巩固 | sleep-time compute，现称 dreaming（`/sleeptime`、`/dream`、`/reflect`） | 后台自动巩固 事实 → 观察 → 心智模型；近重复按 0.97 余弦合并；可按 scope 配 mission |
| 冲突处理 | 矛盾冻结 → 人工裁决队列 | 时序失效（边失效标注） | 单次 Add-only：不覆盖、只累积，冲突留给读者 | 无专门机制 | 证据回传更新观察 |
| 遗忘 | heat 热度衰减降权 + 显式 archive/delete，无静默淘汰 | 边失效 | 显式 DELETE（Add-only 后不再 UPDATE 覆盖） | 无 | 无自动衰减遗忘 |
| 作用域隔离 | agent / workspace 双维 + opt-in 硬过滤 | 用户/会话分 graph | user/agent/run 多层 | 多 agent | memory bank 按 bank |
| 可审计性 | sha256 审计链 + 幂等重放；图像链另存「记忆 ← 窗口 ← 图」的溯源行 | Episodes & Provenance：每个实体/关系可回溯到原始 episode | history 表（old / new / event / actor / role）+ `GET /memories/{id}/history` | MemFS：全部上下文（含记忆块）走 git，可同步到自建仓库 | 观察带 supporting evidence 原句 + proof count；raw facts 永久保留、可回溯 |
| 多宿主接入 | DSH 内直用 + stdio MCP（`mneme-memory`，任意 MCP 客户端）+ HTTP daemon（`dsh-mneme-serve`）+ 网页端桥接（[Mneme-Bridge](https://github.com/SternChiri/Mneme-Bridge)） | 托管 API + SDK | SDK / API | API / server | SDK / API / MCP |
| 完全离线 | ✅（可配本地嵌入模型） | 需 LLM/嵌入服务 | 需 LLM | 需 LLM | 需 LLM |
| 许可证 | MIT | Apache-2.0 | Apache-2.0 | Apache-2.0 | MIT |

**如何读这张表**

- 「—」不等于「差」：通用服务面向多租户在线场景，把裁决权交给调用方也是一种合理设计；dsh-mneme 的差异点在于**把记忆管理做成有账本、可人工复核、可回放的流水线**。
- 图像这一行没有「有/没有」的二分：四家分别是**不支持、只存描述、存原图、存原图带溯源**四档，所以写档位而不是打勾。dsh-mneme 选的是「描述进记忆 + 记忆回指来源图」，不存图字节。
- 情感记忆四家都没有专门机制，这条是我们的空位；但「没有专门机制」不等于他们记不住情绪——情绪能当普通内容存进去，只是没有结构、不进注入、不可按情绪检索。
- 效果类问题（检索准不准、巩固有没有用）看各系统的公开基准与本项目自己的评测，本表不回答跑分。
- 许可证为 2026-11-13 各仓库 LICENSE 实文核对结果。

## Capability Comparison (English)

> Updated 2026-11-13 (previous version 2026-10-16). Based on public docs and source code (sources below). This compares **capability structure**, not accuracy — effect questions belong to public benchmarks and our own evals. dsh-mneme is a memory plugin designed for DSH (SQLite + human-editable Markdown mirror, fully offline) that also ships standalone: a zero-dependency stdio MCP server (npm package `mneme-memory`, mountable by any MCP client) and a DSH-free daemon (`dsh-mneme-serve`), so third-party integrations read and write the same library; the others are general-purpose memory services/libraries.
>
> **What changed here**: it now covers three things that only exist since 0.14.0 (affective memory, image description with provenance, third-party writes) and updates retrieval to the full-corpus incremental index. The competitor side was re-checked column by column: nine cells changed, four of which had turned "we did not find it" into "they do not have it", and the twelve new cells across the three new rows were verified. Licenses re-verified against all four LICENSE files on 2026-11-13, unchanged from the previous version.
>
> **One column carries a caveat**: Zep is the hosted enterprise context layer (its own Konig graph store); Graphiti is its open-source framework (Neo4j / FalkorDB / Neptune). The column below follows the **open-source Graphiti implementation** and does not credit it with Zep's hosted capabilities.

| Capability | dsh-mneme | Graphiti (Zep's OSS core) | Mem0 | Letta (MemGPT) | Hindsight |
|---|---|---|---|---|---|
| Storage | SQLite + human-editable Markdown mirror | Temporal knowledge graph (Neo4j / FalkorDB / Neptune) | Vector + graph, extraction-based | Self-editing core-memory blocks + MemFS file layer | PostgreSQL + pgvector (or Oracle 23ai); the four layers (facts / experiences / observations / mental models) are memory types, not the store |
| Retrieval | BM25 (full corpus + incremental index since 0.14.0) + graph + hot session memory; entity-graph 4th path (RRF) | Semantic + keyword BM25 + temporal graph traversal | Semantic + keyword + graph | Recursive search + edits | 4 parallel strategies + RRF + rerank |
| LLM extraction at write | No (raw text stored; LLM only during consolidation) | Yes (entities/relations) | Yes (facts; add-only, accumulates rather than overwrites) | Partial | Yes (retain extracts entities/time) |
| Affective memory | Emotion attributions stored as relation edges (`affective_context`); recurring ones are promoted to injected patterns, one-off occasions attach via `affectiveInjectEnabled` (off by default) | No dedicated mechanism: emotion is just extraction content and lands as an ordinary entity/relation | No dedicated type: prompts ask to keep emotional state, but it stays an ordinary memory | None: MemFS memory files are markdown only, emotion fits only as text inside a block | None: only per-bank disposition traits (skepticism / literalism / empathy), which are reasoning style, not emotion memory |
| Images / multimodal | A description pass has a vision model write one line per image into distillation (`imageDescribeEnabled`); `image_sources` lets each memory point back to the window and image it came from (`imageMemoryEnabled`). No image bytes stored, no OCR | Unsupported: EpisodeType is message / json / text / fact_triple only, no image_url anywhere | Description only: a vision model writes text into the store, the image itself is not kept, so there is no image provenance | Stores originals: MemFS accepts png/jpg/webp/gif, returns `kind:"image"` and mime, git-tracked and syncable; a `view_image` tool exists | Stores originals with provenance: retain accepts inline text+image attachments, content-addressed on disk, with `(bank_id, document_id, attachment_hash)` rows |
| Third-party writes | HTTP API + standing daemon (`dsh-mneme-serve`) so another plugin can write into the same store; stdio MCP adds six tools | Yes; REST and MCP are reference implementations you deploy yourself | Yes; self-hosted REST `POST /memories` (plus PUT / DELETE / search / history) | Yes; official REST `/v1/agents…`, defaults to Cloud | Yes; REST plus one MCP endpoint per bank (retain / recall / reflect) |
| Offline consolidation | autoDream (fast write, slow consolidate) | No batch consolidation (incremental only, by design) | No background consolidation | sleep-time compute, now called dreaming (`/sleeptime`, `/dream`, `/reflect`) | Background consolidation facts → observations → mental models; near-duplicates merged at 0.97 cosine; per-scope mission |
| Conflict handling | Freeze → human review queue | Temporal edge invalidation | Add-only, no overwrite: conflicts are left to the reader | None specific | Evidence-fed observation updates |
| Forgetting | Heat decay (down-weight) + explicit archive/delete; no silent eviction | Edge invalidation | Explicit DELETE (add-only no longer overwrites) | None | No automatic decay/eviction |
| Scoping | agent + workspace dual-dim, opt-in hard filter | per-user/session graphs | user/agent/run layers | multi-agent | memory banks |
| Auditability | sha256 audit chain + idempotent replay; the image path also records "memory ← window ← image" provenance rows | Episodes & Provenance: every entity/relation traces back to its source episode | history table (old / new / event / actor / role) + `GET /memories/{id}/history` | MemFS: all context (memory blocks included) is git-tracked and syncable to your own repo | Observations carry supporting evidence quotes + proof count; raw facts retained, traceable |
| Multi-host access | in-DSH + stdio MCP (`mneme-memory`, any MCP client) + HTTP daemon (`dsh-mneme-serve`) + web-client bridge ([Mneme-Bridge](https://github.com/SternChiri/Mneme-Bridge)) | hosted API + SDKs | SDK / API | API / server | SDK / API / MCP |
| Fully offline | ✅ (local embedding model supported) | needs LLM/embedding service | needs LLM | needs LLM | needs LLM |
| License | MIT | Apache-2.0 | Apache-2.0 | Apache-2.0 | MIT |

**How to read this table**

- "—" does not mean "worse": general services target online multi-tenant settings where the caller owns adjudication; dsh-mneme's differentiator is turning memory management into an **accounted, human-reviewable, replayable pipeline**.
- The image row is not a yes/no: the four systems sit at **unsupported, description only, originals stored, originals with provenance**. dsh-mneme keeps a description inside memory and points back to the source image, without storing image bytes.
- None of the four has a dedicated affective mechanism; that is the gap we fill. "No dedicated mechanism" does not mean they cannot remember emotion — it can be stored as ordinary content, just with no structure, no injection path, no way to query by emotion.
- Accuracy questions belong to public benchmarks and this project's own evals; this table does not answer them.
- Licenses verified against each repository's LICENSE file on 2026-11-13.

## 核对记录 / Verification notes（2026-11-13）

- 许可证：四家 LICENSE 实文 —— Graphiti / Mem0 / Letta 为 Apache-2.0，Hindsight 为 MIT，与 2026-10-16 一致。
- Mem0：`mem0/memory/storage.py:150` 的 `add_history(...)` 与 `GET /memories/{id}/history` 是 history 表的出处；「Add-only」取自其 2026-04「New Memory Algorithm」说明（不再 UPDATE / DELETE，只累积）。情感：`mem0/configs/prompts.py:624`。图像：`mem0/memory/utils.py:161,186`、`mem0/memory/main.py:867`（描述入库、原图不留）。写入：`server/main.py:367 POST /memories`。
- Graphiti：「Episodes & Provenance」一节写明 derived fact 可回溯到 source episode；检索为语义 + BM25 + 图遍历三道。情感：`graphiti_core/prompts/extract_nodes_and_edges.py:130`。图像：`graphiti_core/nodes.py:54,74-77`（EpisodeType 无图像类型）。写入：`server/graph_service/routers/ingest.py:51,73`、`mcp_server/src/graphiti_mcp_server.py:402`。
- Letta：MemFS 说明全部上下文 git 跟踪；`/sleeptime`、`/dream`、`/reflect` 是现名 dreaming 的入口。情感/图像：`letta-code:src/websocket/listener/commands/memory.ts:24-31,40-42,323-338`（只认 markdown；图像收 png/jpg/webp/gif，`kind:"image"`）。写入：`letta-code:src/backend/api/agents.ts`（默认 Cloud）。**代码已从 `letta-ai/letta` 迁至 `letta-ai/letta-code`**，主仓现在是文档壳。
- Hindsight：v1.2.1 与 Hindsight Models 两次发布；存储为 PostgreSQL + pgvector 或 Oracle 23ai；观察层带 supporting evidence 与 proof count。情感：README:385（disposition traits）。图像：`hindsight-docs/docs/developer/configuration.mdx:2019,319-324`、`hindsight-api-slim/hindsight_api/engine/retain/attachment_store.py:24`（内容寻址 + 溯源键）。写入：README:166,263-271（REST + 每 bank 一个 MCP）。

## Sources

- Zep: arXiv:2501.13956 · repo [getzep/graphiti](https://github.com/getzep/graphiti)
- Mem0: arXiv:2504.19413 · repo [mem0ai/mem0](https://github.com/mem0ai/mem0)
- Hindsight: arXiv:2512.12818 · repo [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)
- Letta: [letta-ai/letta-code](https://github.com/letta-ai/letta-code)（代码仓；`letta-ai/letta` 现为文档壳）
- dsh-mneme: 本仓 README 与 [dsh-mneme/CHANGELOG.md](dsh-mneme/CHANGELOG.md)
