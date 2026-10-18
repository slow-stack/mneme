# AGENTS.md — 给维护者、贡献者与 AI agent 的项目入口

dsh-mneme 是 DSH 宿主的记忆插件（蒸馏 / 注入 / 检索 / 巩固 / scope 隔离）。本文件是模块地图与闸门清单：接手任何 PR 之前先读这里，改完结构顺手更新这里。

**定位（讨论 #221 定）**：本文件是**薄入口**——只放纪律与索引，模块地图为附表；正文随域文档演进（`dsh-mneme/docs/`，按「职责边界 / 对外接口 / 内部文件 / 已知坑」统一模板），不在这里堆细节。

## 仓库布局

- `dsh-mneme/` — 包本体
  - `src/` — 源码（唯一手写处）
  - `lib/` — **同步产物，禁止手改**：`npm run sync` 从 src 生成，`scripts/check-sync.js` 锁平价
  - `test/` — `node --test`（`npm test`）
  - `scripts/` — 同步、徽章、基准与压测脚本
- 仓库根 — README（双语）、CHANGELOG、CONTRIBUTING、docs/、
  `package.json`（**仓库壳**：`private`、`0.0.0`、刻意不带 `dsh` 字段与 `type` 字段，
  供 dshfind 这类单仓多包探测器找到子包，**绝不发布**）、`pnpm-workspace.yaml`（子包声明）
- `.mneme/`（仓库根）— **项目级**工作流（M.O.）：`pipelines/<id>.json`，属于项目不属于插件。
  住 `dsh-mneme/pipelines/` 会让它在**每个**项目里都读得到（见 [docs/WORKFLOWS.md](dsh-mneme/docs/WORKFLOWS.md)）。

## 并行工作区与多 agent 协作

本仓库的开发常由多个 agent / 多个终端并行推进。**并行时一条硬规则：一个工作进程一棵树**，不共用同一个工作目录；单人串行开发不受影响。

- 用 `git worktree add .worktrees/<lane> -b <branch>` 开独立车道；`.worktrees/` 已忽略，**检索、清点、批量替换一律排除它**，否则会数出两份副本；
- 车道内的 `node_modules` 可以软链到主树那份（Windows 用 junction），省下重复安装：**任一侧 `npm install` 前先确认另一侧没在跑测试**；
- `lib/` 是 sync 产物（见上）：各自树内同步，`npm run sync` **只在准备提交前跑一次**，别当保存键用；
- 共享资源同一时刻只有一个写入者：`npm install`、`npm publish`（且只在 `dsh-mneme/` 内执行；发布走 GitHub Actions 的 release.yml，不在本机跑）、插件 relink——**被 link 的那棵树才是「活」的**；
- 不 `amend` / force-push 别人的提交，不把别人未提交的改动 `stash` 走；
- **提交不得有 AI 署名**，且**任何 `Co-Authored-By` trailer 都不许**（不管它指向人、bot 还是 AI 工具），也不许 "Generated with" 之类的工具署名。规则自 2026-09-19 生效，此前的历史提交不追溯、不改写——见 [CONTRIBUTING](CONTRIBUTING.md)；
- **本机私有信息不进公开文件**：车道分配、端口占用、记忆库路径这类只对某台机器成立的东西，放不进库的本地板（`.worktrees/coordination.md`）或 `.git/info/exclude`；本文件只放对所有人都成立的纪律（定位见开头：薄入口）；
- 两个宿主都加载本插件时：`memoryDir` 可共用（`src/store.js` 的 `busy_timeout` + WAL 已为多进程就绪），但 `externalApiEnabled`（默认端口 8790）与 `autoDream` 后台任务**只能一边开**，否则 EADDRINUSE + 重复做梦（镜像/审计双写）。独立服务（`dsh-mneme-serve`）同理：与 DSH 外部访问抢同一端口、**二选一**；它第一期无 LLM，巩固结构性只在宿主侧，不构成第二个做梦者。

## 模块地图（按功能面）

| 功能面 | 文件 | 一句话 |
|---|---|---|
| 宿主挂载入口 | `src/index.js` | ctx 接线、memoryDir 解析、各管线启动、实体抽取触发点 |
| 存储 | `src/store.js` | SQLite schema（memories / 实体三表 / dream_runs / recall_runs / 审计表）、幂等迁移 |
| 存储生命周期 | `src/maintenance.js` | 无损回收维护入口（#275 第一批；`dsh-mneme reclaim`，默认 dry-run，VACUUM 单独指定） |
| 回收 HTTP 口径 | `src/reclaim-http.js` | 面板路由与 Bearer 数据面共用的唯一一份解析与答复（#411）；两张皮只许剩鉴权与路径不同 |
| 服务层 | `src/service.js` | saveWithDedupe（去重键 type+title+scope 三元组）、fuseRecall 检索融合（keyword/vector/bm25/entity）、注入候选、镜像同步、冲突队列 |
| 写入准入 | `src/write-admission.js` | 写入前的会话写入预算与同话题冷却（#254）。第 1 级确定性判据（空白 / 噪声 / 密钥 PII）只在三个条件同时成立时才跑：有 `sessionKey`、`llmAudit.enabled` 未被显式关、`writeAdmission.enabled === true`；都成立且**命中**时，再由 `writeAdmission.enforce` 决定是否真拒绝（`ADMISSION_DECISION_DENY`）。只开 `enforce` 不跑判据、也不拦写入。默认只计量，测量点落 `llm_audit_logs` |
| 注入 | `src/inject.js` | 注入位构造、内容截断、跨轮轮换 |
| 蒸馏 | `src/summarize.js` + `src/quality-filter.js` | 会话 → 记忆；质量打分与处置（归档/降权） |
| 巩固与睡眠 | `src/dream.js` + `src/dream/{decisions,clustering,sleep}.js` | LLM 巩固决策、dream_runs 审计回执 |
| 实体 | `src/entities/extractor.js`（存储侧在 store 三表） | 写入时 LLM 抽取实体/属性/关系 |
| 检索辅助 | `src/search/{bm25,adaptive}.js`、`src/vector-index.js`、`src/embedding.js`、`src/local-embedder.js`、`src/reranker.js` | BM25 / 自适应阈值 / 向量索引 / 嵌入 / 重排 |
| 热度 | `src/heat.js` | 纯函数遗忘曲线（opt-in） |
| 复用统计 | `src/recall-stats.js` | recall_runs 只读聚合（#217，Top-N 召回 + 僵尸率） |
| 工作流 | `src/pipeline.js` + `.mneme/pipelines/*.json`（项目级） | M.O.（手法）读侧：两层来源（项目层优先、包内 `pipelines/` 为全局兜底）→ `mneme.pipeline/v1` 投影（[docs/WORKFLOWS.md](dsh-mneme/docs/WORKFLOWS.md)） |
| 绕行与候选 | `src/candidates.js`（+ `<memoryDir>/candidates/<项目键>/`） | M.O. 的出口与草稿层：绕行的分档判定（R0/R1 记账先走、R2/R3 停下问人 + 机械兜底清单 + 闸门保护）、候选的归并/归档/升格（进仓库要人批） |
| 冷启动 | `src/bootstrap.js` | 从仓库文件反向构建初始记忆（POST /bootstrap） |
| 配置 | `src/config.js`（schema + lightMode）、`src/settings.js`（feature flags 白名单） | 一切行为开关的家 |
| API 面 | `src/api.js`（宿主内 /api/dsh-mneme/*）、`src/api-standalone.js`（Bearer 数据面）、`bin/dsh-mneme-mcp.mjs`（MCP stdio）、`src/serve.js` + `bin/dsh-mneme-serve.mjs`（独立服务 daemon，无 LLM 数据面） | 对外四张脸 |
| 面板 | `lib/client.js` | 面板侧产物，无 src 对应物 |
| 运行时 | `src/runtime/*` | 模型下载（断点续传）/ 校验 / adopt |
| 命令 | `src/commands.js` | 斜杠命令注册与派发 |
| 双语 | `src/lang.js` | 文案与语言解析 |

## 新改动自查清单

1. 行为开关一律 **opt-in 默认关** + `settings.js` 白名单注册 + 考虑 lightMode（`config.js` 的 `LIGHT_MODE_OFF`）；
2. 新配置键：`config.js` schema 与 `settings.js` 白名单**成对出现**，`test/api.test.js` 的旗标计数锁要同步 +1；
3. 改 `src/` 必跑 `npm run sync`（lib-smoke 测试会抓未同步）；
4. 新行为必须带回归测试；schema 变更配幂等迁移（PRAGMA 检查 + ALTER，存量库启动即建）；
5. **防御段改动要保守**：幂等迁移、单调时间戳、scope 归一化、审计 receipt——都是踩坑沉淀，动前先读注释；
6. 提交署名可归属与 AI 内容核验义务见 [CONTRIBUTING](CONTRIBUTING.md)（硬性要求）；
7. **发布/打包只在 `dsh-mneme/` 包目录内执行**——根目录历史上发出过坏包（0.6.9、0.7.0–0.7.10），此条为防复发红线；
8. **注释写「为什么」，不写「是什么」**：非常规实现、防御段、行为开关的动机（issue 编号、消融数据、基准数字）必须落注释，代码含义靠命名与测试名表达；测试同样适用——锁形状/锁字面量的用例要注释写清它在防哪类回归（例：`test/recall-evals.test.js` 的 signals 形状锁）。
9. **新路由必须声明 `policy`**（`open` / `token` / `token-write`）：`src/api.js` 的 `createRouteRegistrar` 对漏声明与重复路径直接抛错，插件起不来。归完类同步 `SECURITY.md` 的安全模型表——那张表是代码的投影，不是愿望清单；
10. **面板配色走 `--mneme-*` 语义色层**：宿主 `label-tertiary` / `label-dimmed` 是分隔线/占位符用的低对比层，**不是正文色**，直接拿来当 `color` 会在浅色或深色主题下掉到 AA 以下（#178 实测 70 条）。正文与图形一律用 `.mneme-x,.mneme-overlay,.mneme-triggerwrap,.mneme-topentry` 上定义的语义变量；新增或改动颜色后 `test/contrast.test.js` 会自动重算全部 `color` 声明的对比度（解析不出的颜色记失败，不静默跳过），并锁死「引用的 `--dsw-*` 必须真实存在」「四个渲染根一个不少」「图形色按 3:1」「虚线边不得靠 `opacity` 区分」。

## 闸门清单

- `npm test`（CI 矩阵：ubuntu + windows × node 22/24；另有一条宿主兼容腿 `test-host-legacy`，把 peer 声明的 0.1.x 两段也真跑一遍）
- check-sync（src ↔ lib 平价）
- CodeRabbit 自动评审（每个 PR）
- codecov 补丁覆盖率
- CONTRIBUTING 署名要求

## 尺寸约定与拆分方向（2026-09 讨论 #221）

- 单文件参考线约 **2000 行**；超线文件被功能改动碰到时，顺手把一个内聚块拆出去（advisory，不拦合并）；
- 拆法：原文件保留为 barrel 出口、调用方零改动；纯搬移走独立 PR；防御段最后动或不动；
- **前置**：`scripts/sync-lib.js` 支持子目录映射之后，才可做 store/ 目录化这类拆分（否则平价锁误伤纯搬移）；
- 已知热点：`src/store.js`、`src/service.js`、`lib/client.js`。
