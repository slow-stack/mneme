# 配置说明（全键参考）

> 正本是 `src/config.js` 的 schema——本文与其同步维护，键名、默认值、取值范围以代码为准；
> 行为动机与踩坑出处在 schema 注释里（含 issue 编号），本文只保留「怎么配、配了会怎样」。
> 改 schema 时顺手更新对应行（新改动自查清单第 2 条）。

**怎么读这张表**

- 「默认」列即 `config.js` schema 的解析默认值；默认值本身 = 未配置时的行为。
- 标 **light** 的键会被 lightMode 预设强制关闭（文末附完整清单）；lightMode 是预设不是
  强制——用户显式写在 feature_flags 里的值优先于预设。
- 行为开关（布尔键）默认关的即 opt-in：不开 = 行为与该键存在之前逐字节一致。
- 绝大多数行为开关与部分阈值/路由键在 `settings.js` 的白名单里，可在面板「功能开关」
  逐项启停（线上回滚开关）；未入白名单的键（路径、词典、枚举外的杂项）只能改 bundle 配置。

## 全局与存储

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `language` | `zh` | 记忆语言：生成条目、注入标题、后台提示词所用语言（`zh`/`en`） | 切换后重启生效 |
| `memoryDir` | `~/.dsh/memory` | SQLite 记忆库目录 | WAL + busy_timeout 已为多进程就绪；两个宿主共用库时 `externalApiEnabled` 与 `autoDream` 只能一边开 |
| `lightMode` | `false` | 轻量档总闸：一键关掉全部重型路径，保留核心循环（见文末清单） | 面板 `panel_mode=light` 等效为 `true` 且优先于 bundle 配置 |

## scope 隔离（issue #17）

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `scopeEnabled` | `false` | 存储层总开关：写入标注 agent_scope / workspace_scope，去重键扩展；检索与注入排序按当前会话作用域加权（命中 ×1.25、他 scope ×0.5 保留可见，issue #339 补齐注入通道） | opt-in；关 = 写入不标注、行为与 A1 前逐字节一致 |
| `strictScope` | `false` | 硬过滤模式（A3）：他 scope 完全不可见、未标注恒可见（fail-closed）；硬过滤先于软加权执行 | 依赖 `scopeEnabled` 打开才有意义；关 = A2 软隔离（他 scope 降权保留可见，检索与注入同权重） |

## 审计

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `llmAudit.enabled` | `true` | 后台 LLM 调用全量落 `llm_audit_logs`（tokens / 时长 / 状态 / 触发源） | 覆盖 autoDream / autoSummarize / sleep / entityExtract 与写入准入测量点；关 = 一行不写 |
| `llmAudit.retentionDays` | `90` | 审计表滚动清理保留天数（≤3650） | 启动时清理旧行 |

## 写入准入（#254）

写入前判定「这条该不该进库」，与 `memoryQualityFilter` 的分工是**时点**不是判据：那个是写入后打分归档（扣分可以错，只影响排序与归档），这个是写入前判定（硬拒不能错）。两个键都默认关，分层是为了把「先观察」和「开始拦」分成两次上线。

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `writeAdmission.enabled` | `false` | 跑第 1 级确定性判据：空白 / 纯噪声 + 密钥 / PII（判据来源是 #164 A2，经 `sensitiveScan` 注入） | 关 = 不判定、不拒绝，`evaluate` 返回与只计量阶段逐字段一致。命中 → 审计行带 `metadata.deny` |
| `writeAdmission.enforce` | `false` | 命中时真的拒绝（`store.save` 之前返回） | 关 = 仅告警：判据照跑、审计照留、写入不拦（读审计时「`deny` 非空且 `decision=allow`」即这一档的指纹）。被拒写入不落库、不通知、不排嵌入，`memory_save` 返回 `action:"denied"` + `reason` |

第 1 级的判据面刻意收窄：**去重键命中不进第 1 级**（归 write-update 放行——同步近重复门跑在异步矛盾检测之前会把本该被裁决的矛盾直接拒掉），G1/G2 阈值也只是计量。两个键都走 feature_flags 白名单（面板可启停）。

## 蒸馏（会话 → 记忆）

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `autoSummarize` | `true` | 会话/回合结束自动蒸馏记忆 | 关 = 只剩工具与命令写入口 |
| `summarizeProvider` / `summarizeModel` | 空 | 蒸馏专用模型路由 | 两者都非空才生效；空 = 用会话当前模型 |
| `distillMaxChars` | `24000` | 喂给蒸馏 LLM 的完整转录上限（字符，1000–200000） | 调大更完整、更贵 |
| `summarizeMinIntervalMinutes` | `0` | 同会话两次蒸馏的最小间隔（分钟，≤10080） | 0 = 不限（#127 节流三键之一） |
| `summarizeMaxEntriesPerRun` | `0` | 单次蒸馏最多落库条数（≤50） | 0 = 不限 |
| `summarizeMinWindowChars` | `0` | 窗口可蒸馏文本下限（字符），不足直接跳过 LLM（#239） | 被挡窗口照常消费游标并留 skip 审计 |
| `summarizeMaxRunsPerSession` | `0` | 每会话蒸馏次数预算，只计真实发起的调用（≤1000） | 0 = 不限；进程内计数，重启清零 |
| `summarizePeakHours` | `""` | 高峰时段串（`"09:00-18:00"` / `"mon-fri 08:00-12:00,14:00-18:00"`，支持跨零点） | 命中高峰不调 LLM、顺延补跑；任一写法非法整串按未配置处理 |
| `summarizePeakMaxDeferMinutes` | `120` | 高峰顺延上限（分钟，≤1440） | 0 = 不设上限；到点仍处高峰照跑（bypassPeak） |
| `summarizeDedupeMode` | `off` | 落库前去重档位：`off` / `title`（拦完全同名）/ `vector`（同会话语义近邻） | `vector` 复用已有 embedding 列，无 LLM 调用 |
| `summarizeDedupeMinSim` | `0.92` | `vector` 档并入阈值（0.5–0.99） | 仅 `vector` 档生效 |
| `summarizeDedupeWindowHours` | `24` | `vector` 档回看窗口（小时，≤168） | 仅 `vector` 档生效 |
| `distillRateLimitIntervalMs` | `1000` | 蒸馏请求全局串行排队的相邻间隔（毫秒） | 0 = 关闭排队（默认开的 429 保护随之失效） |
| `distillRateLimitRetries` | `3` | 命中 429 的指数退避重试次数（≤10） | 重试全程对用户透明 |
| `distillRateLimitBaseDelayMs` | `1000` | 429 退避基数（毫秒，100–60000） | 1s→2s→4s… |
| `summarizeReasoningEffort` | `none` | 蒸馏 LLM 推理档位：`off`/`low`/`medium`/`high`/`none`（#315） | `none` = 不发字段用服务商默认；思考模型建议 `off`/`low` 防推理烧光输出预算 |
| `codingRetrospect` | `false` | 编码记忆蒸馏：rejected_solution / pitfall / constraint 三类 | opt-in；开启后蒸馏上下文为整轮完整对话 |
| `codingKeywords` | 内置词表 | 编码任务识别词表（读取侧门控） | 命中才注入编码记忆 |
| `codingBoostFactor` | `2` | 编码任务时编码记忆的 importance 加权系数（1–5） | — |
| `memoryQualityFilter.enabled` | `true` | 写入质量打分：≥60 正常 / 30–60 降权 / <30 归档打 low_quality 标 | 归档行仍可显式搜到 |
| `memoryQualityFilter.archiveThreshold` | `30` | 自动归档线 | 与 `exemptImportance` 联动 |
| `memoryQualityFilter.degradeThreshold` | `60` | 降权线（注入排序乘 quality_score） | — |
| `memoryQualityFilter.minContentLength` | `10` | 最短内容长度（字符） | — |
| `memoryQualityFilter.exemptImportance` | `4` | importance ≥ 此值豁免静默自动归档（#135） | 设 1 = 等效关自动归档 |

## 注入

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `autoInject` | `true` | 每轮自动注入记忆块的父总闸 | 关 = 两个子开关一并失效（持久值保留，不重置） |
| `maxInjectedItems` | `5` | 注入条数上限（1–20） | — |
| `importanceThreshold` | `3` | 注入候选的 importance 下限（1–5） | 低于该值的记忆不进注入面 |
| `injectRotationTurns` | `0` | 跨轮轮换：最近 N 轮注入过的不再优先（#205） | opt-in；会话边界自动重置 |
| `injectContentMaxChars` | `300` | 单条正文截断上限（60–4000，#164①） | 截断带「上限/原长/全文指引」提示，不静默 |
| `injectUncertaintyAdaptive` | `false` | 确定性强的话题收缩注入条数（减半、下限 1，#239 第 5 项） | 只做单向收缩，绝不越过 `maxInjectedItems` |
| `injectGuidanceEnabled` **light** | `true` | 工具描述 + order 150 系统段讲「何时查/何时写」（#249） | `autoInject` 子开关；lightMode 强制关 |
| `continuityRescueEnabled` **light** | `false` | 压缩边缘双落点：连续性提案落库 + 追加注入（#249 N3） | opt-in（新注入表面）；`autoInject` 子开关；订阅宿主压缩事件，无该时机则降级为持久规则 |
| `pinnedInjectBudget` | `0` | 约束/偏好 pin 池独立预算（0–5，#249 B1） | 0 = 关；pin 不占 `maxInjectedItems` 名额 |
| `hotMemoryEnabled` | `true` | 会话近期对话渲染在长期记忆块之前 | — |
| `hotMemoryRounds` | `5` | 热记忆覆盖最近几轮对话（≤50） | — |
| `hotMemoryMaxTokens` | `2000` | 热记忆块 token 上限（200–32000） | — |
| `escapePromptVariables` | `true` | 注入内容连续花括号转义（#162） | 关 = 原样透传（DSH interpolate 可能 throw） |

## 巩固（autoDream）

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `autoDream` **light** | `true` | 阈值触发的后台巩固（LLM 合并/归档/降重） | lightMode 强制关；与 sleepMode 串行、不重叠 |
| `dreamThresholdCount` / `dreamThresholdChars` | `10` / `5000` | 触发阈值（新增条数 / 字符，双过才跑） | — |
| `dreamDelayMs` | `2000` | 触发后的延迟（毫秒） | — |
| `dreamMinIntervalMinutes` | `0` | 两次开跑最小间隔（分钟，≤10080，#89） | 失败/degraded run 也占用；0 = 不限 |
| `autoDreamFailureBackoff` | `false` | 连续失败指数退避：有效间隔 = 基数 × 2^连败，封顶 30 分钟（#292） | opt-in；基数取 `dreamMinIntervalMinutes`（0 = 无闸可翻倍）；成功一次清零；重启归零 |
| `dreamPeakHours` | `""` | 巩固错峰，与 `summarizePeakHours` 同一份时段语法（#239） | 命中高峰不做梦、阈值继续累积、留 skip 审计；非法写法按未配置 |
| `dreamPeakMaxDeferMinutes` | `120` | 巩固顺延上限（分钟） | 0 = 不设上限；到点仍处高峰照跑 |
| `dreamProvider` / `dreamModel` | 空 | 巩固专用路由（settings「巩固模型」） | 建议非思考模型——思考模型易烧光预算返回空体（#135） |
| `dreamMaxTokens` | `131072` | 巩固输出预算（256–131072） | 流式计费按实际用量，调大不增加成本 |
| `dreamReasoningEffort` | 未配置 | 巩固推理档位（同 `summarizeReasoningEffort` 的枚举） | 未配置 = 自动取模型支持的最低档（#135）；显式 `none` = 不发字段 |
| `dreamSummaryProvider` / `dreamSummaryModel` | 空 | 记忆总览（dream_summarize）专用路由（#258） | 空 = 回落巩固路由；总览输入为全库，建议大 ctx 非思考模型 |
| `dreamSummaryMaxInputs` | `0` | 总览输入条数硬上限（按 updated_at 倒序取最新 N 条） | 0 = 不设上限（库增长可能撑爆小 ctx 模型） |
| `dreamMaxSnapshotSize` | `200` | 滑动窗口：每次只巩固最近 N 条（≤1000） | 窗口外旧记忆不进快照 |
| `dreamCandidateMode` | `window` | 候选集构造：`window` / `hybrid`（并入向量高相似组，#125） | `hybrid` 让该合并的对能碰面；输入成本不随库增长 |
| `dreamCandidateMax` | `0` | `hybrid` 候选总量上限（≤5000） | 0 = 复用 `dreamMaxSnapshotSize` |
| `dreamCandidateMinSim` | `0.85` | `hybrid` 判「高相似」的阈值 | 与 sleep normal 档同一个定义 |
| `dreamMaxArchivePerRun` | `8` | 单轮 archive 决策上限（≤200，#104） | 超限整单拒绝，`dreamSkipInvalid` 不豁免 |
| `dreamImplicitKeep` | `true` | LLM 未提及的快照记忆自动补 keep | `false` = 恢复严格校验（未覆盖即拒绝整单） |
| `dreamMinExplicitCoverage` | `0.5` | 显式决策覆盖率下限（0–1） | 防截断输出被隐式 keep 洗白 |
| `dreamSkipInvalid` | `true` | 跳过单条非法决策、应用合法子集、run 记 degraded（#89） | `false` = 恢复整单拒绝 |
| `allowCrossTypeMerge` | `false` | 放宽跨类型合并检查 | opt-in；`dreamSkipInvalid` 关时跨类型 merge 直接整单拒绝 |
| `dreamMergeGuard` | `false` | guarded 类型 merge 护栏（#339/E8）：合并对象命中长保留类型（与 archive 护栏同表：preference/pattern/rejected_solution/constraint/pitfall）的 merge 决策整条跳过——E8 实测巩固损耗里 10/26 条被丢约束已归位 guarded 类型仍被 merge 吃掉 | opt-in；`dreamSkipInvalid`（默认开）时被跳条目进 `dream_runs.skipped`、run 记 degraded，关闭时整单拒绝 |
| `dreamNarrativeEnabled` **light** | `false` | dream 期间按共享 tag 聚类合成叙述条（#164 对齐） | opt-in；按需检索、不常驻注入 |
| `dreamNarrativeMinCluster` | `3` | 成簇门槛（共享同一 tag 的记忆数，2–20） | — |
| `documentMemoryEnabled` **light** | `false` | document 型记忆：长文档指针行，全文归 agent（#230） | opt-in；注册校验 + C2 去重 + supersede 记账 |
| `documentInjectBudget` | `2` | document 摘要行的注入预算（1–5） | 只约束注入，不约束检索 |
| `documentDir` | `""` | managed 落盘目录（#296） | 空 = `<memoryDir>/documents/`；目录之外只登记指针、正文零读零写 |
| `policyEpoch` | `0` | 裁决规则版本号 | bump 后旧 dream_runs 降为历史证据（receipt 不再驱动现行决策） |

## 睡眠模式（sleep，空闲深维护）

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `sleepModeEnabled` **light** | `false` | 库静默后全库深维护：冲突消解/归档降级/模式发现/关系补全 | opt-in；可被用户活动中止，与 autoDream 串行 |
| `sleepIdleMinutes` | `5` | 静默多久触发（1–60 分钟） | — |
| `sleepMinIntervalHours` | `8` | 两次 run 最小间隔（小时，≤168） | — |
| `sleepConflictStrictness` | `normal` | 冲突裁决档：`gentle`(0.92) / `normal`(0.85) / `aggressive`(0.75) | — |
| `sleepActionSet` | `conflict` | 动作集：`conflict` / `full`（六分支，#126） | `full` 让互补型/演进型重复有正确出口 |
| `sleepArchiveDays` / `sleepCompressDays` | `30` / `90` | 归档降级分层（天）：先缩为摘要、再彻底归档 | 实体关系保留 |
| `sleepPatternMinMemories` | `100` | 模式发现的扫描窗口（条） | — |
| `sleepPatternLookbackDays` | `30` | 属性变更回看（天） | — |
| `sleepMaxPatternPerRun` | `3` | 单轮模式条上限（0–10） | 0 = 关闭模式发现 |
| `sleepProvider` / `sleepModel` | 空 | sleep 专用路由 | 空 = 用巩固路由 / 当前模型 |
| `sleepReasoningEffort` | 未配置 | 同 `dreamReasoningEffort` | — |
| `sleepMaxTokens` | `8192` | 冲突/模式阶段输出预算（#257） | 原硬编码 2048 对 `full` 档必然截断 |
| `sleepHeatThreshold` | `0.05` | 降级联合判定的热度下限（heat < 值且 importance<5 才降） | `heatEnabled` 关时退回纯时间分层 |

## 反思与冲突（dream 配套）

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `reflectionUpdateEnabled` | `true` | 检索后的反思更新既有记忆 | — |
| `reflectionFailureTracking` | `true` | 失败经验追踪 | — |
| `reflectionUpdateMaxPerRun` | `2` | 单轮 update 上限（0–5） | — |
| `reflectionUpdateMinAgeHours` | `24` | 可更新记忆的最短年龄（小时，≤168） | — |
| `conflictFreezeEnabled` | `false` | 冲突不自动合并、冻结待人工复核 | opt-in |
| `conflictFreezeMaxPending` | `100` | 冻结队列上限（≤1000） | — |

## 实体

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `entityExtractionEnabled` **light** | `false` | 写入时 LLM 抽取实体/属性/关系 | opt-in；存储三表与 CRUD 恒可用，本键只闸抽取 |
| `entityExtractionProvider` / `entityExtractionModel` | 空 | 抽取专用路由 | 单边为空时回落调用方默认 |
| `entityExtractionReasoning` | `none` | 抽取推理档位（#109） | `none` = 不发字段；拒收自动去掉字段重试一次 |
| `entityExtractionMaxEntities` / `entityExtractionMaxAttrs` | `10` / `20` | 单次抽取的实体数 / 每实体属性数上限 | — |
| `entitySearchEnabled` | `true` | 实体名前缀/语义搜索（供召回） | — |
| `entityRecallEnabled` **light** | `false` | 图召回轴：查询命中实体名时并入融合池（#219） | opt-in；依赖实体抽取产出（lightMode 下抽取已关） |

## 检索

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `embedProvider` | `openai` | 嵌入提供方：`openai`（外部 API）/ `local`（ONNX）/ `ollama` | — |
| `vectorSearchTopK` | `20` | 向量召回条数（≤100） | — |
| `vectorSearchThreshold` | `0.65` | 固定向量阈值 | `adaptiveThresholdEnabled` 开启时被动态阈值取代 |
| `adaptiveThresholdEnabled` | `true` | 查询感知动态阈值（实体前缀放宽、短查询收紧等） | 关 = 回到固定 0.65 |
| `bm25SearchEnabled` **light** | `true` | BM25 第三召回路径（标识符/代码碎片/混排） | — |
| `hybridSearchVectorWeight` / `hybridSearchKeywordWeight` | `0.6` / `0.4` | 混合检索加权 | — |
| `recallFusion` | `blend` | 融合配方：`blend`（现状）/ `rrf` / `minmax` | `rrf`/`minmax` 修「raw 余弦 + 关键词分直接相加」的量纲失配 |
| `signalTransparency` | `false` | 每条结果附带 `{keyword, vector, bm25, final}` 信号 | 只装饰返回行，不改排序 |
| `hybridInject` **light** | `true` | 注入前语义优先召回、规则序回填 | — |
| `selectiveInjectEnabled` **light** | `true` | 有查询向量时按相似度重排注入候选 | — |
| `searchSemanticDedup` **light** | `false` | 检索期语义去重（贪心剔除近重复） | opt-in 激进档：小嵌入模型易把不同条目坍缩 |
| `searchSemanticDedupThreshold` | `0.95` | 去重阈值 | — |
| `evalPersistTestResults` | `false` | 检索评测快照落 `recall_evals` | 生产检索恒只进 `recall_runs`，与此键无关 |
| `recallRecordDefault` | `true` | `recall_runs` 记录默认开 | 显式传 `false` 的调用方不受影响 |
| `recallRetentionDays` | `90` | `recall_runs` 滚动清理保留天数 | — |
| `trustEpistemicWeighting` | `false` | 来源可信度（observation/subjective/inferred）参与排序与标注 | opt-in；关时 epistemic_status 只是惰性数据 |

### 重排层

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `rerankEnabled` **light** | `false` | 本地交叉编码器重排 | opt-in：显式 `true` + `local` 才拉起 onnxruntime |
| `rerankProvider` | `none` | `local` / `none` | — |
| `rerankModel` | `Xenova/bge-reranker-base` | 重排模型 | — |
| `rerankBatchSize` | `8` | 批大小（≤64） | — |
| `rerankMaxCandidates` | `30` | 参与重排的候选上限（5–100） | — |
| `rerankScoreThreshold` | `0.1` | 重排分数阈值 | — |
| `rerankDtype` | `q8` | 量化档（#188） | 非法值由 transformers 抛出 → 重排降级告警 |

## 热度

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `heatEnabled` **light** | `false` | 热度曲线（遗忘）：热度字段 / sleep 降级联判 / 注入优先级层乘 heat（#218） | opt-in；关 = 注入乘数恒 1、sleep 退回纯时间分层 |
| `heatGlobalBeta` | `1.0` | 广义指数形状参数 β（0.5–2） | 专家调优项，不进面板白名单 |
| `heatTypeDecay` | 内置默认 | per-type 衰减 λ（键为 type 字符串） | λ=0 的类型免疫（热度恒 1、sleep 永不降级） |

## API 与工具面

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `apiToken` | 空 | 宿主内 API 敏感端点的共享 token | 空 = 只读端点保持开放（DSH 绑 127.0.0.1 且无内建鉴权） |
| `externalApiEnabled` | `false` | 独立 `node:http` 数据面（生态集成用） | opt-in；双宿主共用库时只能一边开（端口冲突） |
| `externalApiPort` | `8790` | 端口 | — |
| `externalApiHost` | `127.0.0.1` | 绑定地址 | 改成非回环 = 把整个记忆库暴露给网络，自负其责 |
| `disableMemorySearch` | `false` | 对模型隐藏 `memory_search` 工具（v0.8.5） | 慢/轻量模型的工具往返节流；隐藏即不可调 |
| `disableMemoryArchive` | `false` | 对模型隐藏 `memory_archive` 工具 | 同上 |

## 运行时与本地模型

| 键 | 默认 | 作用 | 开启后果 / 冲突 |
|---|---|---|---|
| `localEmbedModel` | `Xenova/bge-small-zh-v1.5` | 本地嵌入模型（`embedProvider=local` 时） | — |
| `localEmbedDimension` | `512` | 向量维度 | — |
| `localEmbedDevice` | `cpu` | `cpu` / `gpu` | — |
| `localEmbedBatchSize` | `8` | 批大小（≤64） | — |
| `localEmbedPooling` | `auto` | 池化：`auto`（BGE→cls，其余→mean）/ `cls` / `mean` | 池化决定向量空间——改动会变 modelHash、触发既有索引重建 |
| `ollamaBaseUrl` | `http://localhost:11434` | Ollama 地址 | 只接受 http/https（SSRF 防线） |
| `ollamaModel` | `nomic-embed-text` | Ollama 嵌入模型 | — |
| `embedModelCacheDir` | `""` | 模型缓存目录 | 空 = `~/.dsh/mneme/models` |
| `embedModelMirror` | `https://hf-mirror.com` | 模型下载镜像 | — |
| `resilientModelDownload` | `true` | 模型下载断点续传 + 空闲看门狗（#194） | 关 = 恢复原生 fetch（线上回滚开关） |
| `runtimeDir` | `""` | 自管运行时目录（transformers + onnxruntime 闭包，#131） | 空 = `~/.dsh/mneme/runtime`；把重依赖挪出宿主 profile 的依赖图 |
| `runtimeTarballDir` | `""` | 本地 `.tgz` 离线取件目录 | 有货优先于联网（弱网下装 onnxruntime-node 用） |
| `runtimeMirror` | `""` | registry 镜像前缀（如 `https://npmmirror.com/mirrors/npm/`） | 空 = manifest 里的官方地址 |

## lightMode 强制关闭清单（`LIGHT_MODE_OFF`）

`lightMode: true`（或面板 `panel_mode=light`）时，以下键被预设强制为 `false`——都是
重型路径；核心循环（autoInject、autoSummarize、hotMemory*、质量过滤、关键词检索）不动：

`entityExtractionEnabled` · `autoDream` · `sleepModeEnabled` · `rerankEnabled` ·
`autoReindexOnBoot` · `hybridInject` · `injectGuidanceEnabled` · `searchSemanticDedup` ·
`selectiveInjectEnabled` · `bm25SearchEnabled` · `entityRecallEnabled` ·
`dreamNarrativeEnabled` · `documentMemoryEnabled` · `heatEnabled` · `continuityRescueEnabled`

预设只是默认值而非强制：用户显式写进 feature_flags 的值在装配顺序上后展开、仍然生效
（「用户开关 > 轻量预设 > bundle 配置」）。
