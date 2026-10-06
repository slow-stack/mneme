import z from "@deepseek-ai/schemastery";
import { TYPE_DECAY_DEFAULTS } from "./heat.js";

export const Config = z.object({
  // 记忆语言：生成记忆、注入标题与后台 LLM 提示词所用语言；'zh'（默认，
  // 行为不变）/ 'en'。启动时读入，切换后重启生效。
  language: z.union([z.const("zh"), z.const("en")]).default("zh")
    .description("记忆语言：生成的记忆条目、注入标题与后台 LLM 提示词所用语言（zh=默认中文，en=英文）。"),
  memoryDir: z.string().default("~/.dsh/memory"),
  autoInject: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
  // Optional model override for summarization. When both are non-empty, they
  // take priority over the session's current model. Empty = use the session's
  // active provider/model (same as before).
  summarizeProvider: z.string().default(""),
  summarizeModel: z.string().default(""),
  // 蒸馏转录上限（字符）。借鉴 Codex「保留原始、替代压缩摘要」的思路：
  // 蒸馏把完整对话上下文交给 LLM 提炼，不硬裁到 8000 字就截断语义；默认
  // 24000 字符（约覆盖一整轮中等对话），需要更完整可调大。
  distillMaxChars: z.natural().min(1000).max(200000).default(24000),
  // autoSummarize 节流、产出上限与写入端同会话去重（Issue #127，默认全 0/off =
  // 零行为变化）。此前每个 turn/end 必跑、产出条数由模型输出决定、写入端只按
  // 「同类型 + 标题 trim 全等」去重——本机实测单日 84 次、单会话一天 198 条、
  // 同一事实 6 小时铸出 28+ 条。阀门交给用户按需拧，升级本身不改行为。
  summarizeMinIntervalMinutes: z.natural().min(0).max(10080).default(0),
  summarizeMaxEntriesPerRun: z.natural().min(0).max(50).default(0),
  // Issue #239（成本感知级联第一级）：蒸馏前的零 LLM 预判——窗口内可蒸馏文本
  // 不足此字符数时直接跳过 LLM 调用（0 = 关闭，行为与现状逐字节一致）。判定
  // 纯规则、无模型参与；被挡下的窗口照常消费游标（否则每个 turn/end 都会重新
  // 评估同一段短文本），并留一行 status='skipped' 审计，error_message 写明原因
  // ——「这一窗为什么没蒸馏」必须可观测，否则阀门等于黑盒。
  summarizeMinWindowChars: z.natural().min(0).max(100000).default(0),
  // Issue #239（有界检查点）：同一会话最多发起多少次蒸馏（0 = 不限，等同现状）。
  // 只统计真正发起过 LLM 调用的 run——被预判挡下的窗口不占预算，否则阀门会把
  // 额度浪费在零成本窗口上。计数是进程内 per-session（与最小间隔闸门同生命
  // 周期），宿主重启即清零，与 #229 的游标持久化是两件事。
  summarizeMaxRunsPerSession: z.natural().min(0).max(1000).default(0),
  // Issue #239（第 4 项，错峰队列）：高峰期蒸馏顺延。空串 = 关闭，行为与现状逐
  // 字节一致。取值是本地时间的时段列表（逗号分隔，支持跨零点），可带**星期前缀**
  // （可省；ISO 1=周一…7=周日，也认 mon..sun；省略 = 每天）：
  //   "09:00-18:00"                      每天 09:00-18:00
  //   "mon-fri 08:00-12:00,14:00-18:00"  工作日两段（按高峰计费的供应商即此形态）
  //   "sat,sun 23:00-06:00"              周末跨零点段
  // 命中高峰时：不调 LLM、不消费游标（窗口继续累积，留到非高峰一次性蒸馏——批量
  // 比逐轮碎蒸更省），登记一行 status='skipped' / error_message='peak-hours' 审计，
  // 并按下面的上限择时补跑。任一写法非法则整串按「未配置」处理：排程是省钱
  // 手段，绝不该因为写错格式把蒸馏停掉。
  summarizePeakHours: z.string().default(""),
  // 高峰顺延上限（分钟，0 = 不设上限）：到点仍处高峰就照常跑，避免整天高峰把蒸馏
  // 饿死。默认 120 分钟。仅在上面的时段串非空时生效。
  summarizePeakMaxDeferMinutes: z.natural().min(0).max(1440).default(120),
  // 落库前去重档位：off（默认，等同现状）/ title（零成本，仅拦完全同名）/
  // vector（复用已有 embedding 列做同会话语义近邻，无 LLM 调用）。
  summarizeDedupeMode: z.union([z.const("off"), z.const("title"), z.const("vector")]).default("off"),
  summarizeDedupeMinSim: z.number().min(0.5).max(0.99).default(0.92),
  summarizeDedupeWindowHours: z.natural().min(0).max(168).default(24),
  // 智能调速器（429 保护，默认开）：蒸馏 LLM 调用全局串行排队，相邻请求
  // 间隔 distillRateLimitIntervalMs（默认 1s 一次）；命中 429 限流时按
  // distillRateLimitBaseDelayMs 指数退避（1s→2s→4s…）自动重试
  // distillRateLimitRetries 次，全程对用户透明，不把 429 错误码抛给用户。
  distillRateLimitIntervalMs: z.natural().min(0).max(60000).default(1000),
  distillRateLimitRetries: z.natural().min(0).max(10).default(3),
  distillRateLimitBaseDelayMs: z.natural().min(100).max(60000).default(1000),
  maxInjectedItems: z.natural().min(1).max(20).default(5),
  // Issue #205：注入位跨轮轮换。同一会话里，最近 N 个不同用户查询轮次注入过
  // 的记忆本轮不再优先（新鲜优先、原序回填，槽位数不变）；长会话中避免相邻
  // 轮次反复注入同一条（实测 15.5h 会话 86 次注入 93% 重复）。0 = 关闭（默认，
  // 保持既有行为）。会话边界自动重置：新会话从零开始。
  injectRotationTurns: z.natural().min(0).max(20).default(0),
  // Issue #164①：注入单条正文截断上限可配（原硬编码 300）。截断时尾部带
  // 提示：上限/原长/全文 memory_get 指引（BUDGET_EXCEEDED 原则——绝不静默）。
  // 默认 300 = 与既有行为一致。
  injectContentMaxChars: z.natural().min(60).max(4000).default(300),
  // Issue #34（v0.7.2 引入；v0.7.11 误删后随 #333 恢复）：对话开始注入一次当前
  // 时间。默认关 = 与既有行为一致；格式与键名不变，存量 feature_flags 恢复即生效。
  injectTimePrefix: z.boolean().default(false),
  importanceThreshold: z.natural().min(1).max(5).default(3),
  // Issue #239（第 5 项）：注入条数的查询自适应（默认关）。确定性强的话题收缩注入
  // 条数（减半、下限 1），模糊话题（回指/时间线索，或极短查询）维持
  // maxInjectedItems 上限——只做**单向收缩**，绝不越过用户配置的上限；判据只看
  // 查询本身，不做额外检索（先探针检索等于白付一次 fuseRecall）。
  injectUncertaintyAdaptive: z.boolean().default(false),
  // #249（第一批；第二批归位为注入子开关）：能力说明——「怎么用记忆」的判断
  // 指引。落两个零注入成本的位：①`memory_search` / `memory_save` 的工具描述补
  // 一句判断指引（工具描述是常驻文本，不进每轮上下文）；②一段 order 150 的
  // 系统提示段（一次性、同会话内不随轮次变化，因此不作废前缀缓存），只讲总则
  // （优先序、何时查、何时写、何时 no-op）。默认开＝基础档：#249 §10 的判据是
  // 「只修正既有位、不引入新注入时机／新表面／额外 LLM 调用」的子项随父开关
  // 生效——「agent 不知道何时该查、何时该写」是已实测的缺口，把它默认关着是反的。
  // 父开关 `autoInject` 关闭时它不生效（闸门见 injectChildEnabled）；用户显式写进
  // feature_flags 的值永远优先于这里的默认值。
  injectGuidanceEnabled: z.boolean().default(true),
  // #249 N3（压缩边缘双落点）：上下文即将大幅精简前抢救「正在做什么」。默认关。
  // 触发靠宿主自己的压缩事件（`compaction/start|summary|end`，都在事件白名单里），
  // 不自定一套阈值参数——「压缩边缘」由宿主定义，我们再校准一份只会与之漂移。
  // 为什么是「新时机 + 新表面」因而默认关：它往对话里**追加消息**（新的注入表面，
  // 参照实现里最容易累积成一堆历史的那类），并多写一张提案表。按 §10 判据，引入
  // 新时机/新表面/新成本的子项独立成键、默认关；只修正既有块的（基础内容分池、
  // 库可见性行）才随父开关默认开。`pinnedInjectBudget` 与它同批，但属前者之外：
  // 那是既有块内的预算，不是新表面。
  // 双落点是硬要求，不能只留一半：宿主的压缩摘要器**只看对话里的内容**，只落库不
  // 注入，等于在摘要重建里什么都没留下；只注入不落库，则压缩一过就随旧消息一起
  // 消失。两者都做，且落库先于注入（注入失败不该丢提案）。
  // 祖先：`autoInject`（父关则本项不生效，闸门见 injectChildEnabled）。轻量档默认
  // 置关（见 LIGHT_MODE_OFF）：轻量档多一份注入物是反的，与 injectGuidanceEnabled
  // 同一取舍。注意预设只是默认值而非强制——装配时用户显式开关在它之后展开，勾了就赢
  // （合并顺序见 index.js 装配处）。
  continuityRescueEnabled: z.boolean().default(false),
  // #249（第一批）：B1 pin 池预算——约束/偏好类注入条目的独立小上限。约束与
  // 偏好被静默降级是本议题的立项核心（同类知识与情景日志同池同速率摘要，实测
  // 一轮压缩后仅保 53%、五轮 10%），故这两类不进相关性竞争、不参与跨轮轮换、
  // 逐字保真（仅受超大条目的硬顶保护，截断仍带提示）并排在块内排序之前。
  // 独立预算的意义：pin 不占 maxInjectedItems 名额，不会把当前任务需要的情景
  // 候选挤出预算（另一种「批量塞历史」）。0（默认）= 关闭，注入块构成与既有
  // 行为逐字节一致；超出预算的条数在块内如实标注未展示条数，绝不静默。
  pinnedInjectBudget: z.natural().min(0).max(5).default(0),
  // 编码记忆蒸馏（codingRetrospect，opt-in，默认关）。开启时，turn/end 蒸馏
  // 额外提取三类编码专属记忆：rejected_solution（被否决方案）/ pitfall（踩坑）/
  // constraint（工程约束）。蒸馏上下文为整轮完整对话（用户输入 → 助手思考/回答
  // → 工具调用与结果 → 代码执行），不再只看用户消息，便于提炼踩坑根因。
  // 关闭时行为与之前完全一致。
  codingRetrospect: z.boolean().default(false),
  // 编码任务识别词表（读取侧门控用）：命中即视为编码类任务，编码记忆才注入。
  codingKeywords: z.array(z.string()).default([
    "代码", "编码", "写一个", "写个", "实现", "函数", "方法", "类",
    "接口", "bug", "调试", "报错", "错误", "异常", "堆栈", "脚本",
    "python", "javascript", "typescript", "node", "js", "ts",
    "sql", "sqlite", "数据库", "算法", "重构", "优化", "性能",
    "测试", "单测", "修复", "补丁", "依赖", "npm", "pip",
    "命令行", "shell", "配置", "配置文件", "yaml", "json",
    "插件", "开发", "编译", "构建", "部署", "git", "commit",
    "review", "前端", "后端", "页面", "组件", "dsh", "memos"
  ]),
  // 编码记忆注入加权系数：编码任务时对 rejected_solution/pitfall/constraint
  // 记忆的 importance 乘以该系数排序，让编码记忆在编码场景更靠前。
  codingBoostFactor: z.number().min(1).max(5).default(2),
  // 注入边界花括号转义（issue #162，v0.7.4 曾修后被 v0.7.11 重构误删）：默认开启，
  // 在 memory / 短期上下文 / 用户设置三处注入出口对连续 2+ 个花括号插 `\`
  // （`{{a}}`→`{\{a\}\}`），让 DSH 的 interpolate() 不再扫到非法变量名而 throw。
  // 关闭时按原样透传。
  escapePromptVariables: z.boolean().default(true),
  autoDream: z.boolean().default(true),
  dreamThresholdCount: z.natural().min(1).max(1000).default(10),
  dreamThresholdChars: z.natural().min(100).max(100000).default(5000),
  dreamDelayMs: z.natural().min(0).max(60000).default(2000),
  // autoDream 触发最小间隔（分钟，0 = 不限制，Issue #89 请求 2）：高频写入
  // 场景下防止巩固调用（含失败重试）连发刷爆配额。间隔从每次实际开跑时刻
  // 起算，失败/degraded 的 run 也占用间隔；间隔内的触发请求静默跳过，下一次
  // 写入事件会重新评估。
  dreamMinIntervalMinutes: z.natural().min(0).max(10080).default(0),
  // Issue #292（#135 派生）：autoDream 连续失败退避（opt-in，默认关 = 行为与
  // 现状逐字节一致）。开启后调度器对连续失败做指数退避：有效最小间隔 =
  // dreamMinIntervalMinutes × 2^连续失败数（成功一次清零恢复），封顶 30 分钟。
  // #89 的最小间隔闸失败 run 也占用，但间隔恒定——恒定失败的模型（#135 空体
  // 面）会按固定节奏连发刷爆配额；退避把下次重试按失败次数指数推远。基数取
  // dreamMinIntervalMinutes：基数为 0 时无闸可翻倍，本键不自己产生间隔（先配
  // dreamMinIntervalMinutes 再开本键）。与 dreamPeakHours / dreamMinIntervalMinutes
  // 同族（节流阀，不新增任何 LLM 调用），故不进 LIGHT_MODE_OFF。
  autoDreamFailureBackoff: z.boolean().default(false),
  // Issue #239（第 4 项，错峰队列）镜像到巩固：高峰期不做梦。与
  // summarizePeakHours 同一份时段语法（复用 src/summarize.js 的 parsePeakSpec /
  // isInPeakWindow / nextOffPeakAt，不另写解析器）：逗号分隔、可带星期前缀、支持
  // 跨零点。空串 = 关闭，行为与现状逐字节一致。
  //   "09:00-18:00"                      每天 09:00-18:00
  //   "mon-fri 08:00-12:00,14:00-18:00"  工作日两段（按高峰计费的供应商即此形态）
  // 为什么巩固比蒸馏更该有这道闸：单次巩固的输入是整窗快照（dreamMaxSnapshotSize
  // 条），实测一次 run 的 LLM 时长可达数分钟量级，撞上高峰时既贵又慢；而它由写入
  // 事件触发、没有天然的「等到空闲再跑」路径。命中高峰时：不调 LLM、不刷新
  // baseline（阈值继续累积，留到非高峰一次性巩固），登记一行 status='skipped' /
  // error_message='peak-hours' 审计，并按下面的上限择时补跑。任一写法非法则整串
  // 按「未配置」处理——排程是省钱手段，绝不该因为写错格式把巩固停掉。
  dreamPeakHours: z.string().default(""),
  // 高峰顺延上限（分钟，0 = 不设上限）：到点仍处高峰就照常跑，避免整天高峰把巩固
  // 饿死。默认 120，与 summarizePeakMaxDeferMinutes 对齐。仅在时段串非空时生效。
  dreamPeakMaxDeferMinutes: z.natural().min(0).max(1440).default(120),
  // 巩固模型路由（settings panel「巩固模型」/ dreamProvider+dreamModel）：
  // dream 的记忆沉淀专用 LLM 路由，显式配置优先于 agent 默认模型（config-first，
  // Issue #25）。模型分类声明：
  //   - 非思考模型（推荐，如 glm-5-2 类）：无 reasoning 声明，effort 请求被 harness
  //     拒绝后 withEffortFallback 去掉字段重试即成功；空体/no json array 风险最低。
  //   - 思考模型（如 deepseek-v4-flash-ga 等 v4-flash-ga 系）：默认开推理，可能烧光
  //     token 预算返回空体；且部分（如 v4-flash-ga）在 harness 侧被声明为不接受任何
  //     reasoning effort —— 即使去掉 effort 重试，harness 的 defaultEffort 也会顶上来
  //     再次拒绝（UNSUPPORTED_REASONING_EFFORT），插件 fallback 无法绕开。
  //     选用时建议配 dreamReasoningEffort 并实测；不行就换非思考模型。
  dreamProvider: z.string().description("记忆巩固专用模型的服务商（settings「巩固模型」）。巩固反复失败时，优先改用官方非思考模型的服务商（如 deepseek / glm）。"),
  dreamModel: z.string().description("记忆巩固专用模型。建议选非思考模型（如 deepseek-chat、glm-5-2 类）：思考模型可能烧光 token 预算返回空体，导致巩固失败（UNSUPPORTED_REASONING_EFFORT）。"),
  // Issue #135 建议 3：#9 只抬了 max（8192→131072），default 停在 32768。思考型
  // 模型的推理与正文共享该预算，effort 未压低时 32768 恰好被推理烧光 → 空体
  // （"no json array in llm output"，报告实测 146 轮因此失败）。默认抬到上限，
  // 让默认配置也留足正文预算；流式计费按实际用量，不按上限。
  dreamMaxTokens: z.natural().min(256).max(131072).default(131072),
  // Pass-through reasoning effort for dream's LLM calls (Issue #135 建议 4/5).
  // Unset (no value) resolves to the LOWEST effort the model declares before
  // streaming: background consolidation must produce JSON, and omitting the
  // field lets the harness substitute the model's defaultEffort (thinking-type
  // models often default to high/max) — the reasoning then drains the whole
  // token budget and the run dies with an empty body. Explicit 'none' still
  // omits the field (provider default applies); off/low/medium/high are
  // forwarded verbatim, unsupported values are remapped (v0.7.26+).
  // Caveat: on some thinking models (e.g. v4-flash-ga) the harness declares NO
  // supported effort, so even the fallback retry (field stripped) is rejected
  // again via its defaultEffort — prefer a non-reasoning dreamProvider/dreamModel.
  dreamReasoningEffort: z.union([
    z.const("off"),
    z.const("low"),
    z.const("medium"),
    z.const("high"),
    z.const("none")
  ]).description("巩固模型的推理档位：未配置 = 自动取模型支持的最低档（避免思考模型用自带默认档烧光预算返回空体，#135）；显式 'none' = 不发送字段、用服务商自带默认；off/low/medium/high 原样传递。模型不支持的值会自动换用其支持的档位（v0.7.26+）。"),
  // 滑动窗口上限（v0.4.4）：autoDream 每次只对最近 dreamMaxSnapshotSize 条
  // 记忆做 consolidation。大记忆量下全量快照会把 LLM 输入撑爆（636 记忆 →
  // 677 "missing" errors、applied=0），窗口外的旧记忆不进 snapshot。
  dreamMaxSnapshotSize: z.natural().min(1).max(1000).default(200),
  // Issue #104 方向 2：单轮 archive 决策上限。一次性大扫除（12 条互不相关主题
  // 被批量归档，其中 8 条疑似误伤长保留类型）是失控信号，与 update 上限同类的
  // 全局闸门：skipInvalid 也不豁免，超限整单拒绝。正常清理可调高。
  dreamMaxArchivePerRun: z.natural().min(1).max(200).default(8),
  // Issue #125：候选集构造方式。"window"（默认，等同现状）只取最近
  // dreamMaxSnapshotSize 条；"hybrid" 在此基础上并入**向量翻出的高相似组**——
  // 本机实测 45 对「双方活跃且 sim≥0.85」里 0 对能同时进窗口（窗口覆盖率 11.7%），
  // 纯时间窗口让"该合并的一对"几乎永远碰不到面。候选总量仍由下面的上限封顶、
  // 与库总量解耦，这是相对"调大窗口"的核心收益：输入成本不随库增长。
  dreamCandidateMode: z.union([
    z.const("window"),
    z.const("hybrid")
  ]).default("window"),
  // hybrid 的候选总量上限；0 = 复用 dreamMaxSnapshotSize（不迁移，需要时显式覆盖）。
  dreamCandidateMax: z.natural().min(0).max(5000).default(0),
  // Issue #258：总览（dream_summarize）独立路由。consolidate 有 dreamMaxSnapshotSize
  // 窗口、总览原为全库无界——两者对 ctx 的需求差 4 倍以上却强制共用 dream 路由，
  // dreamProvider 指向小 ctx 模型时总览当场 CONTEXT_WINDOW_EXCEEDED（实测 120,969
  // tokens > 32,768），指向大 ctx 模型则 consolidate 的卸载收益归零。未配置 = 回落
  // dream 路由，行为逐字节不变。
  dreamSummaryProvider: z.string().default("").description("记忆总览（dream_summarize）专用模型服务商，留空用巩固模型。总览输入为全库（或 dreamSummaryMaxInputs 上限），ctx 需求远大于 consolidation，建议大 ctx 模型（issue #258）。"),
  dreamSummaryModel: z.string().default("").description("记忆总览（dream_summarize）专用模型，留空用巩固模型；总览输入随库增长，建议大 ctx 非思考模型（issue #258）。"),
  // Issue #258：总览输入条数硬上限。0 = 不设上限（历史行为，库增长可能撑爆小
  // ctx 模型）；>0 时按 updated_at 倒序保留最新的 N 条（与 consolidate 窗口同一
  // 排序口径）。总览是常驻叙述而非逐条巩固，限输入只影响口径脚注里的条数。
  dreamSummaryMaxInputs: z.natural().min(0).max(100000).default(0),
  // hybrid 判"高相似"的阈值；0.85 与 sleep normal 档对齐——两个模块对"高相似"
  // 保持同一个定义。
  dreamCandidateMinSim: z.number().min(0.5).max(0.99).default(0.85),
  // 叙述条（#164 对齐，opt-in）：dream 期间按共享 tag 主题聚类（dream/
  // narratives.js），每簇 LLM 合成一条叙述落库（source=narrative、evidence
  // 回链簇内原子记忆、求交防捏造）。按需检索、不常驻注入。默认关=行为与
  // 此前一致；lightMode 强制关闭。
  dreamNarrativeEnabled: z.boolean().default(false),
  // 成簇门槛：共享同一 tag 的记忆 ≥ 此值才合成叙述条。
  dreamNarrativeMinCluster: z.natural().min(2).max(20).default(3),
  // document 型记忆（#164/#230，opt-in）：agent 产长文档的指针行——注册校验
  // （文件存在 + 路径合法 + evidence 求交）、摘要 + doc_path 落库、C2 比对
  // 去重、supersede 记账。全文归 agent，管线零触碰；默认关=行为与此前一致；
  // lightMode 强制关闭。
  documentMemoryEnabled: z.boolean().default(false),
  // document 摘要行的注入预算（#230 拍板）：次优先档内最多注入的 document
  // 行数，超预算跳过由后续候选补位。只约束注入，不约束检索。
  documentInjectBudget: z.natural().min(1).max(5).default(2),
  // document 的 managed 落盘目录（#296 第二批）：空串 = 跟随 memoryDir 的
  // `<memoryDir>/documents/`。`~` / `~/` / `~\` 展开到 home，绝对路径原样用，相对
  // 路径落在 memoryDir 下（这是本键自己的规则：memoryDir 的相对路径是原样留着的
  // cwd 语义，两者刻意不同；`~user` 形式两边都不展开）。目录由 mneme 建，里面的
  // `index.md`
  // 整文件机器所有。这个目录**之外**的文件只登记指针行，正文一个字节都不碰
  // （= #230 的「管线对正文零读零写」）；与 memoryDir 一样是路径配置，不是
  // 行为开关，故不进 settings.js 的 feature flags 白名单、也不上面板。
  documentDir: z.string().default(""),
  // 隐式 keep（v0.4.4）：LLM 未提及的 snapshot 记忆自动补 {action:"keep"}，
  // 避免"未覆盖即全拒"白白浪费整轮 run。设为 false 时保留旧的严格校验
  // （未覆盖即拒绝整单）。
  dreamImplicitKeep: z.boolean().default(true),
  // 显式决策覆盖率下限（v0.4.4 fix）：dreamImplicitKeep 开启时，LLM 输出被
  // 截断只显式 claim 少量 snapshot 记忆（claimed.size / snapshot.size < 该阈值）
  // → 整单拒绝，防止残缺输出被隐式 keep 洗白成 ok 后再被真实 apply。0-1，
  // 默认 0.5（至少显式覆盖一半 snapshot）。
  dreamMinExplicitCoverage: z.number().min(0).max(1).default(0.5),
  // Issue #89：v0.6.9（Issue #26）的宽容路径回归。默认跳过单条非法决策
  // （未知 id / 跨类型合并等）、应用合法子集、run 记 degraded；设 false 恢复
  // 整单拒绝的严格模式。全局上限与覆盖率下限不受此开关影响、始终整单拒绝。
  dreamSkipInvalid: z.boolean().default(true),
  // 显式开启后放宽跨类型合并检查（类型边界由用户自行承担）；配合
  // dreamSkipInvalid 理解：关闭 skipInvalid 时跨类型 merge 直接整单拒绝。
  allowCrossTypeMerge: z.boolean().default(false),
  // issue #339 / E8 考卷：merge 护栏（默认开）。开启后合并对象命中长保留类型
  // （preference/pattern/rejected_solution/constraint/pitfall，与 archive 护栏
  // 同一张表）的 merge 决策整条跳过——E8 实测巩固损耗里 10/26 条被丢约束已归位
  // guarded 类型仍被 merge 吃掉，而 archive 护栏只挡 archive 不挡 merge，
  // 「更精炼的摘要」恰是约束失真的主通道（同类压缩管线实测：安全规则被同速压缩
  // 一轮只剩 53%、五轮只剩 10%，且全程无任何报错信号）。skipInvalid（默认开）
  // 时被跳条目进 dream_runs.skipped、run 记 degraded；关闭 skipInvalid 时整单
  // 拒绝。设为 false 才恢复旧行为：guarded 类型的 merge 不再被跳过，约束可被
  // 「更精炼的摘要」吃掉。与 allowCrossTypeMerge 同用时长 guard 先判。
  dreamMergeGuard: z.boolean().default(true),
  // Rule version for dream adjudication: when this bumps, older dream_runs
  // degrade to historical evidence (their receipts no longer drive live
  // decisions). Default 0 = no versioning in use yet.
  policyEpoch: z.natural().min(0).max(1000000).default(0),

  // --- API protection ------------------------------------------------------
  // Optional shared token for the plugin's HTTP API. Empty (default) keeps
  // the API open (DSH binds to 127.0.0.1 and has no built-in auth); when set,
  // sensitive endpoints (vector-config, vector-reindex, and all write ops on
  // profile/rules/commands) require `Authorization: Bearer <apiToken>` (or
  // `X-DSH-Mneme-Token`). Read-only list/search/semantic stay open so the
  // Web panel keeps working without the token.
  apiToken: z.string(),

  // --- semantic: local embedding provider (v0.2) --------------------------
  // "openai" keeps the legacy external-API path (settings vector config);
  // "local" runs an ONNX model in-process; "ollama" calls a local Ollama.
  embedProvider: z.union([z.const("openai"), z.const("local"), z.const("ollama")]).default("openai"),

  // Local ONNX embedder (transformers.js / onnxruntime).
  localEmbedModel: z.string().default("Xenova/bge-small-zh-v1.5"),
  localEmbedDimension: z.natural().default(512),
  localEmbedDevice: z.union([z.const("cpu"), z.const("gpu")]).default("cpu"),
  localEmbedBatchSize: z.natural().min(1).max(64).default(8),
  // 本地嵌入的池化方式（**bug 修复，不是新能力**）：BGE 系是按 CLS 池化训练的——
  // 模型自带的 `1_Pooling/config.json` 明确写着 `pooling_mode_cls_token: true` /
  // `pooling_mode_mean_tokens: false`，官方 README 也是「select the last hidden state of
  // the first token」+ L2 normalize；而 transformers.js 的 `feature-extraction` 默认 mean。
  // ⇒ 此前本地嵌入对 BGE 系一直用错池化：**不报错、只是向量系统性偏差**，检索质量静默受损。
  // 'auto' = 按模型族判定（BGE → cls，其余 → mean，未受影响的模型行为不变）；也可显式钉住。
  // ⚠️ 池化决定向量空间，改它会改变 modelHash（见 local-embedder.js），既有索引会被判失配并重建。
  localEmbedPooling: z.union([
    z.const("auto"),
    z.const("cls"),
    z.const("mean")
  ]).default("auto"),

  // Ollama embedder.
  ollamaBaseUrl: z.string().default("http://localhost:11434"),
  ollamaModel: z.string().default("nomic-embed-text"),

  // Model download/cache. When empty (default), models are cached under the
  // user-level path ~/.dsh/mneme/models (resolved in local-embedder/reranker);
  // a non-empty value is used verbatim.
  embedModelCacheDir: z.string().default(""),
  embedModelMirror: z.string().default("https://hf-mirror.com"),

  // issue #194：模型文件下载的断点续传与重试。开启时 transformers.js 的 env.fetch 被
  // 替换为带断点续传的实现（已收字节落盘、Range/If-Range 续传、空闲看门狗），大文件
  // 中断后不必整份重来；关闭 = env.fetch 保持原样（线上回滚开关）。
  resilientModelDownload: z.boolean().default(true),

  // 自管运行时目录（issue #131）。空 = ~/.dsh/mneme/runtime：里面放收编或下载来的
  // transformers + onnxruntime 闭包，插件经 src/runtime/loader.js 的三层解析加载它。
  // 目的就是让这条重依赖不必留在宿主 profile 的依赖图里——profile 是所有插件共用的
  // 依赖图，留在里面会让「装任何插件都要替它重走一遍这条链」。
  runtimeDir: z.string().default(""),

  // 运行时取件的两个来源（issue #131 / PR-C）。都是「克制」的默认：留空 = 不额外改变行为。
  // - runtimeTarballDir：本地 .tgz 目录。某个包网络下不到时（例如 onnxruntime-node），
  //   把 `npm pack <pkg>` 出来的 tgz 丢进这个目录即可离线取件；有它就优先于联网。
  // - runtimeMirror：registry 镜像前缀，例如 https://npmmirror.com/mirrors/npm/ 。
  //   留空则用 runtime-manifest.json 里写死的官方地址（那是随包发布的固定清单）。
  runtimeTarballDir: z.string().default(""),
  runtimeMirror: z.string().default(""),

  // Vector search tuning.
  vectorSearchTopK: z.natural().min(1).max(100).default(20),
  vectorSearchThreshold: z.number().min(0).max(1).default(0.65),
  hybridSearchVectorWeight: z.number().min(0).max(1).default(0.6),
  hybridSearchKeywordWeight: z.number().min(0).max(1).default(0.4),
  // Lazy auto-backfill of missing embeddings on boot (Bug2): when the vector
  // API is configured and rows still lack an embedding, the index is rebuilt
  // in the background after a short delay, rate-limited in batches. On by
  // default; set false to keep the backfill manual only.
  autoReindexOnBoot: z.boolean().default(true),
  // Semantic-first injection (Bug4): when enabled, injectCandidates with a
  // non-empty query recalls via the vector index first and falls back to the
  // rule-based pick to fill/dedupe. Empty query / no vector → legacy behavior.
  hybridInject: z.boolean().default(true),

  // --- recall optimization (v0.5.0) ----------------------------------------
  // BM25 third recall path beside vector + LIKE keyword (1.1): per-token IDF
  // scoring recalls rows whose query terms are scattered — identifiers, code
  // fragments, mixed CJK/ASCII — where substring LIKE cannot match.
  bm25SearchEnabled: z.boolean().default(true),
  // Query-aware vector cutoff (1.2) replacing the fixed 0.65: entity:/attr:
  // prefixes loosen to 0.5, short queries tighten to 0.7, long queries loosen
  // to 0.6, and a decisive top-1/top-5 score gap loosens to 0.5 so the tail
  // still reaches the reranker. Off = legacy fixed threshold behavior.
  adaptiveThresholdEnabled: z.boolean().default(true),
  // Session-scoped hot memory (1.3): the latest N dialogue rounds rendered
  // ahead of the long-term recall block — short-term context that never
  // enters the memory store.
  hotMemoryEnabled: z.boolean().default(true),
  hotMemoryRounds: z.natural().min(1).max(50).default(5),
  hotMemoryMaxTokens: z.natural().min(200).max(32000).default(2000),
  // Topic-ranked injection (2.2): when a query vector is available the whole
  // injection candidate list is re-ordered by similarity to the current
  // query instead of keeping the rule-based order.
  selectiveInjectEnabled: z.boolean().default(true),
  // Search-time semantic dedup (2.3): greedy pass over the merged candidate
  // list dropping rows whose embedding cosine-similarity to an already-kept
  // row exceeds the threshold — duplicates are filtered at recall time
  // instead of waiting for a dream consolidation. Opt-in aggressive mode:
  // small embedding models can collapse legitimately distinct rows, so the
  // default keeps every recalled row.
  searchSemanticDedup: z.boolean().default(false),
  searchSemanticDedupThreshold: z.number().min(0.5).max(1).default(0.95),

  // Recall fusion recipe (plan #1): how the keyword/vector/BM25 ranked lists
  // are combined into the final ranking. `blend` (default) is the legacy
  // behavior — weighted sum for vector/hybrid, union backfill for auto —
  // unchanged. `rrf` (Reciprocal Rank Fusion) and `minmax` (min-max normalized
  // weighted sum) are rank/scale-aware recipes that fix the unit mismatch the
  // issue describes (raw cosine vs keyword score vs normalized IDF are added
  // directly). Off by default so existing behavior holds exactly.
  recallFusion: z.union([z.const("blend"), z.const("rrf"), z.const("minmax")]).default("blend"),
  // Attach a `signals` object { keyword, vector, bm25, final } to each search
  // result for transparency/debugging (plan #2). Default off; when on it only
  // decorates the returned rows, never changes the ranking.
  signalTransparency: z.boolean().default(false),

  // --- semantic: rerank layer (v0.2) --------------------------------------
  // Opt-in by default (item ⑥): the local cross-encoder pulls in onnxruntime
  // (transformers.js) at init, so a bare install must not load it. Only an
  // explicit rerankEnabled=true + rerankProvider="local" constructs LocalReranker.
  rerankEnabled: z.boolean().default(false),
  rerankProvider: z.union([z.const("local"), z.const("none")]).default("none"),
  rerankModel: z.string().default("Xenova/bge-reranker-base"),
  rerankBatchSize: z.natural().min(1).max(64).default(8),
  rerankMaxCandidates: z.natural().min(5).max(100).default(30),
  rerankScoreThreshold: z.number().min(0).max(1).default(0.1),
  // #188：量化档，与嵌入层的 useDtype 同语义（q8 = model_quantized.onnx，约为
  // fp32 体积的 1/4）。此前重排层不传 dtype，即使缓存里已有量化文件也会去下载
  // 1GB 级的 model.onnx。非法值由 transformers 在 init 时抛出 → 重排降级并告警。
  rerankDtype: z.string().default("q8"),

  // --- reflection: update decision + failure tracking (v0.2.1) ------------
  reflectionUpdateEnabled: z.boolean().default(true),
  reflectionFailureTracking: z.boolean().default(true),
  reflectionUpdateMaxPerRun: z.natural().min(0).max(5).default(2),
  reflectionUpdateMinAgeHours: z.natural().min(0).max(168).default(24),

  // --- conflict freeze: manual review for conflicting memories (v0.2.1) ---
  // Opt-in by default: when true, conflicting memories are not auto-merged
  // and are marked as pending manual review instead.
  conflictFreezeEnabled: z.boolean().default(false),
  // Maximum number of frozen conflicts to keep pending for manual review.
  conflictFreezeMaxPending: z.natural().min(1).max(1000).default(100),

  // --- entity gene (v0.3.0) -----------------------------------------------
  // Opt-in: when false (default) nothing in the pipeline extracts entities.
  // The storage layer (entities/entity_attrs/entity_relations tables + CRUD)
  // is always available regardless of this flag.
  entityExtractionEnabled: z.boolean().default(false),
  // Optional provider override for entity extraction; empty = use the caller's
  // default provider/model. Combined with entityExtractionModel — provider
  // without model (or vice versa) falls through to the caller default.
  entityExtractionProvider: z.string().default(""),
  // Optional model override for entity extraction; empty = use the caller's
  // default provider/model.
  entityExtractionModel: z.string().default(""),
  // Reasoning effort for entity extraction (issue #109), mirrors
  // dreamReasoningEffort pass-through: 'none' omits the field / provider
  // default; off/low/medium/high passed through. A provider that rejects the
  // effort retries once without it, so opting in is safe to experiment with.
  entityExtractionReasoning: z.union([
    z.const("low"),
    z.const("medium"),
    z.const("high"),
    z.const("none")
  ]).default("none"),
  // Cap on entities per extraction pass and attributes per entity.
  entityExtractionMaxEntities: z.natural().min(1).max(20).default(10),
  entityExtractionMaxAttrs: z.natural().min(1).max(50).default(20),
  // Prefix/semantic search over entity names (used by recall).
  entitySearchEnabled: z.boolean().default(true),
  // 图召回轴（issue #219）：查询文本命中实体名时，把该实体挂联的记忆并入
  // 检索融合池（与 BM25 同级的确认/回填信号）。默认关=检索行为与 #219 前
  // 逐字节一致；走 feature_flags 面板可启停，lightMode 强制关闭。
  entityRecallEnabled: z.boolean().default(false),
  // 边权重演化（issue #24 块2）：touch 门控是否把被寻回路径的边权重抬升。
  // 默认关=边初值纯由建边来源决定（store.RELATION_SOURCE_DEFAULTS），演化
  // 不生效；开=被激活的边经 bumpRelationWeight 上涨（只加不减、封顶 1.0）。
  graphWeightEnabled: z.boolean().default(false),
  // 单次有效触达的抬升幅度。
  graphWeightDelta: z.number().min(0).max(1).default(0.1),
  // 被动确认（issue #24 块4）：heat 触达（记忆被召回/注入=被用）即对该记忆
  // 挂联的关系边做被动确认——bumpRelationWeight 抬一格。默认关=零行为变化；
  // 开=正常触达演化边权，「关系是用出来的」闭环落地（异常路径复核留后续块）。
  graphPassiveConfirm: z.boolean().default(false),

  // --- 图谱锚定层（issue #24 · 块1 Activation Anchoring）-------------------
  // entityRecallEnabled 之上再开一层：以查询命中的实体为种子，沿实体关系表
  // 级联扩散（默认深度 2），把「邻居实体挂联的记忆」也带进融合池。种子集
  // 上限 graphSeedCap、级联深度 graphCascadeDepth 一并下发到 anchorSeeds /
  // cascadeDepths（见 src/graph/anchoring.js）。默认关=行为与 #219 单跳轴
  // 逐字节一致；走 feature_flags 面板可启停，lightMode 强制关闭。
  graphAnchoringEnabled: z.boolean().default(false),
  graphSeedCap: z.natural().min(1).max(30).default(12),
  graphCascadeDepth: z.natural().min(1).max(3).default(2),

  // 关联提示防幻觉（issue #24 块3）：图召回的候选（查询命中实体的挂联记忆）
  // 进注入时默认只参与排序、不改变注入块构成（graphInjectHint=false 保守档）；
  // 开启后注入文本里以固定句式「[检索线索] …」标出，引导语说明这是链路信息
  // 非事实断言，防 LLM 单次消费把桥接召回当有依据的事实回头扩散。
  graphInjectHint: z.boolean().default(false),
  // 图召回候选在注入块里的独立预算（条数上限）。与 pin/document 预算同构：
  // 不占 maxInjectedItems 名额、只约束「桥接线索」这类低信任信息的常驻占比。
  graphInjectBudget: z.natural().min(0).max(5).default(1),

  // --- sleep mode: idle-triggered deep maintenance (v0.4.0) ---------------
  // Opt-in, off by default. Unlike autoDream (threshold-triggered, lightweight)
  // sleep fires when the store has been quiet for sleepIdleMinutes and deep-
  // maintains the whole library: conflict resolution, archival demotion,
  // pattern discovery and entity relation completion. Abortable on user
  // activity, audited into dream_runs (run_type='sleep'), and serialized with
  // autoDream so the two never overlap.
  sleepModeEnabled: z.boolean().default(false),
  // Quiet window before a cycle fires (minutes).
  sleepIdleMinutes: z.natural().min(1).max(60).default(5),
  // Minimum gap between two sleep runs (hours) — a second idle window within
  // this interval does not retrigger.
  sleepMinIntervalHours: z.natural().min(1).max(168).default(8),
  // Conflict adjudication strictness:
  //   gentle    only high-confidence conflicts (threshold 0.92) are resolved
  //   normal    standard dream-level (threshold 0.85)
  //   aggressive low-confidence pairs are also adjudicated (threshold 0.75)
  sleepConflictStrictness: z.union([
    z.const("gentle"),
    z.const("normal"),
    z.const("aggressive")
  ]).default("normal"),
  // Issue #126：冲突阶段的动作集。"conflict"（默认 = 现状）只用 conflict/keep——
  // 后台自动流程不静默扩张行为；"full" 开放六分支（merge / update / supersede /
  // differentiate / conflict / keep），互补型与演进型重复因此有了正确出口，不再
  // 被迫"输赢化"（实测抽样 10 对里 2 对属演进型/互补型，用 conflict 处理会丢信息）。
  sleepActionSet: z.union([
    z.const("conflict"),
    z.const("full")
  ]).default("conflict"),
  // Archival demotion tiering (days since last access):
  //   >= sleepArchiveDays  → shrink to summary, full body kept in _full_content
  //   >= sleepCompressDays → archived outright (entity relations preserved)
  sleepArchiveDays: z.natural().min(7).max(365).default(30),
  sleepCompressDays: z.natural().min(7).max(365).default(90),
  // Pattern discovery scan window (most recent memories to scan).
  sleepPatternMinMemories: z.natural().min(10).max(1000).default(100),
  // How far back pattern discovery considers entity attr changes (days).
  sleepPatternLookbackDays: z.natural().min(1).max(90).default(30),
  // Max pattern memories minted per run (0 = disabled).
  sleepMaxPatternPerRun: z.natural().min(0).max(10).default(3),
  // Optional LLM route override for sleep's bulk passes (empty = use dream
  // route / agent default model).
  sleepProvider: z.string().default("").description("sleep 深维护专用模型服务商，留空用巩固模型或当前模型。"),
  sleepModel: z.string().default("").description("sleep 深维护专用模型，留空用巩固模型或当前模型；建议同巩固模型选非思考模型。"),
  // Pass-through reasoning effort for sleep's LLM passes, same semantics as
  // dreamReasoningEffort (Issue #135 建议 4/5): unset resolves to the lowest
  // effort the model declares; explicit 'none' omits the field; off/low/
  // medium/high are forwarded verbatim.
  sleepReasoningEffort: z.union([
    z.const("off"),
    z.const("low"),
    z.const("medium"),
    z.const("high"),
    z.const("none")
  ]).description("同 dreamReasoningEffort：sleep 各阶段 LLM 的推理档位，未配置 = 自动取模型支持的最低档；显式 'none' = 不发送字段、用服务商自带默认。"),
  // Pass-through reasoning effort for the distill (summarize) LLM call
  // (issue #315). Mirrors entityExtractionReasoning rather than dream: the
  // default 'none' omits the field entirely (provider default), so current
  // behavior is unchanged until the user opts in — no auto-lowest resolution
  // here, distill failures are retried at the window level anyway. off/low/
  // medium/high are forwarded verbatim; a provider that rejects the effort
  // retries once without it (withEffortFallback), so opting in is safe to
  // experiment with. The failure being addressed is the #9 shape on the
  // distill path: a thinking model drains the output budget on reasoning and
  // the summary comes back empty/truncated.
  summarizeReasoningEffort: z.union([
    z.const("off"),
    z.const("low"),
    z.const("medium"),
    z.const("high"),
    z.const("none")
  ]).default("none").description("蒸馏（会话总结提炼）LLM 的推理档位：默认 'none' = 不发送字段、用服务商自带默认；off/low/medium/high 原样传递，被模型拒收时自动去掉字段重试一次（与巩固/睡眠同款降级，#315）。思考型模型建议 off/low，避免推理烧光输出预算。"),
  // Issue #257：sleep 冲突/模式两阶段的输出预算（原硬编码 2048）。实测默认档
  // 每对裁决约 90 token、24 对 2097——2048 恰好压在边界（53 次运行 48 败）；
  // full 档六分支实测约 290 token/对、24 对 6967，2048 必然截断。默认 8192
  // 覆盖实测峰值（候选对按「每记忆至多一对」去重，饱和在 ~25 对、不随库无限
  // 增长）；流式计费按实际用量，不按上限。
  sleepMaxTokens: z.natural().min(256).max(131072).default(8192).description("sleep 冲突消解与模式发现阶段的 LLM 输出预算上限（token）。原为硬编码 2048，sleepActionSet=full 实测需约 7000 导致裁决被截断而整轮失败；流式计费按实际用量，调大不增加成本。"),

  // --- epistemic trust: memory source credibility (v0.4.5) -----------------
  // Distinguish memories by source: observation (measured / witnessed),
  // subjective (opinion / guess) and inferred (derived from other evidence).
  // Opt-in by default: when false (default) retrieval ranking, injection
  // marking and dream merge/conflict keepSource are untouched and
  // epistemic_status stays inert data (still written + inferred on save, just
  // never used to influence behavior).
  trustEpistemicWeighting: z.boolean().default(false),

  // --- memory quality filter (Bug7) ------------------------------------------
  // Heuristic gate on what deserves the injection/recall surface. When enabled,
  // saveWithDedupe scores each new memory after dedupe and before write:
  //   score >= degradeThreshold (60) → stored normally
  //   archiveThreshold (30) <= score < 60 → quality_score persisted and the
  //       injection sort re-ranks by importance * quality_score/100 (degraded)
  //   score < 30 → archived + tagged low_quality (still explicitly searchable)
  // Meta-memory markers, near-duplicates and repetitive filler lose points.
  memoryQualityFilter: z.object({
    enabled: z.boolean().default(true),
    archiveThreshold: z.natural().min(1).max(100).default(30),
    degradeThreshold: z.natural().min(1).max(100).default(60),
    minContentLength: z.natural().min(1).max(1000).default(10),
    // Issue #135 附属发现 1：importance ≥ 该值的记忆不参与静默自动归档——评分
    // 与信号标签照常写入（可观测）、注入排序照常降权，但 setArchived 跳过。
    // 报告实测 150 条低分归档里 128 条 importance ≥ 4（51 条 = 5）。设 1 = 全部
    // 豁免（等效关闭自动归档），设 5 = 仅最重要的豁免。
    exemptImportance: z.natural().min(1).max(5).default(4)
  }).default({}),

  // --- LLM audit trail (Bug8) ------------------------------------------------
  // Records every background LLM call into llm_audit_logs: tokens, duration,
  // status and which trigger produced it. Failures are recorded as
  // status='error' and never block the feature. retentionDays bounds the table:
  // older rows are purged on boot.
  //
  // Covered trigger_source values: autoDream (consolidation + summary),
  // autoSummarize (compression), sleep (conflict + pattern) and entityExtract
  // (issue #250 — the last two were structurally missing the hook, not a
  // deliberate narrowing). entityExtract runs on every memory write, so row
  // growth scales with write volume; retentionDays caps the ceiling but not the
  // rate. If that turns out too fast, sample by operation_type or give it a
  // separate retention — do not add a second gate: this flag is the single one.
  llmAudit: z.object({
    enabled: z.boolean().default(true),
    retentionDays: z.natural().min(1).max(3650).default(90)
  }).default({}),

  // --- write admission (#254) ------------------------------------------------
  // 写入准入：把「这条该不该进库」前移到 LLM 之前。与 memoryQualityFilter 的分工
  // 是时点不是判据——那个是**写入后**打分归档（扣分可以错，只影响排序与归档），
  // 这个是**写入前**判定（硬拒不能错）。
  //
  // 两个开关都默认关（验收第 1 条「默认关零行为变化」）：
  //   enabled — 跑第 1 级确定性判据。关时 evaluate 的返回与只计量那一阶段逐字段
  //     一致，写入路径完全不碰。
  //   enforce — 命中时真的拒绝。关时判据照跑、审计照留，决策回落 allow（仅告警）。
  //     读审计时「metadata.deny 非空且 metadata.decision=allow」就是这一档的指纹。
  // 分层是为了能把「先观察」和「开始拦」分成两次上线：enforce 打开前先在真实流量
  // 里看误杀面，而不是靠回滚开关当保险。
  //
  // 第 1 级的判据面刻意收窄到两类：密钥/PII（#164 A2 是判据来源，经
  // createWriteAdmission 的 sensitiveScan 注入；本批只定义它怎么被消费）与空白/
  // 纯噪声文本。去重键命中**不**进第 1 级——按维护者 09-22 的判定归 write-update
  // 放行（2606.24535 的失效模式：同步近重复门跑在异步矛盾检测之前，把本该被裁决
  // 的矛盾直接拒掉）；G1/G2 的阈值继续只计量，等遥测有分布再单独提。
  writeAdmission: z.object({
    enabled: z.boolean().default(false),
    enforce: z.boolean().default(false)
  }).default({}),

  // --- #380: pre-injection gate (preInjectGate) -------------------------------
  // 注入前判定：意见/立场记忆先判定后处置（E12 D1 裁决落地，opt-in 默认关）。
  // 两级语义与上面的 writeAdmission 同构，落点在注入面而非写入面：
  //   enabled — 每轮注入候选出池后异步预取一次池级 LLM 判定（E12 口径：1 次调用
  //     判整池），标出携带意见/立场的条目。enforce 关时被标记者照常注入（仅审计
  //     ——先在真实负载里看意见占比与误杀面，再决定开不开拦截）。
  //   enforce — 被判定为意见/立场的候选不注入（真过滤）。E12 实测：过滤是唯一过
  //     预注册判据的处置（D1 −24.4pp；D2 标记 −6.8pp 且与 D1 差 +17.6pp，给模型
  //     看标记的线已被 E2/E3 关闭，本闸不做标记）。
  // 同步约束：注入渲染必须保持同步（systemPrompt contexts 无异步 text），判定
  // 结果按查询缓存、下一轮生效；首轮/判定失败/解析失败一律全量放行——防线失效
  // 绝不丢注入功能。判定不可用 ≠ 拦截一切，E1 已证个性化同灭无效。
  // 也走 feature_flags（点号键平铺），面板可启停；lightMode 默认关（额外 LLM
  // 调用 + 延迟一轮生效，轻量档不默认背）。
  preInjectGate: z.object({
    enabled: z.boolean().default(false),
    enforce: z.boolean().default(false)
  }).default({}),

  // --- #164 A2: secret / PII scan at the write boundary ----------------------
  // 写入边界的密钥 / PII 判据（src/sensitive-scan.js）自身的闸。与 writeAdmission
  // 的 enabled 分开是有意的：那一个管 #254 第 1 级的空白 / 噪声判据，本键管 A2 这
  // 一类判据，两批的误杀面差一个量级（空白 / 噪声没有解释空间，邮箱 / 手机号有），
  // 绑在同一个开关上就没法单独观察 A2 的命中分布。
  //
  // 分层必须写清：判据的唯一调用点在 #254 第 1 级的闸门里（write-admission.js 的
  // firstLevelHit），闸门不走第 1 级就没人来调这个扫描器。所以本键是「闸门内这一批
  // 判据参不参与」，不是一条能独立跑的链路——单开本键就是零行为变化：
  //   writeAdmission.enabled 关                  → 第 1 级整个不跑，本键开也没用
  //   enabled 开 + 本键关                        → 只跑空白 / 噪声那一批
  //   enabled 开 + 本键开 + enforce 关           → 命中留审计，写入照常（观察档）
  //   enabled 开 + 本键开 + enforce 开           → 命中即拒绝
  // 默认关 = 只计量那一阶段的行为逐字节保留（#332 合并时 sensitiveScan 就是 null）。
  // #164 的「默认仅告警、拦截 opt-in」落在 enforce 上：命中落一条审计
  // （metadata.deny.kind）但照常写入，真要拦得 enabled 与 enforce 同时开。
  // 也走 feature_flags（FEATURE_FLAG_BOOLEANS 白名单），面板可启停=线上回滚开关。
  sensitiveScanEnabled: z.boolean().default(false),

  // --- recall evaluation: test-result storage (v0.4.6, 方案 B) --------------
  // Separate retrieval evaluation snapshots from the production recall audit.
  // When false (default) evaluateRetrieval still computes precision/recall/mrr
  // and returns them to the caller, but writes nothing to recall_evals — the
  // eval table only grows when the operator opts in. Production searchMemories
  // audits to recall_runs and NEVER touches recall_evals, regardless of this
  // flag (production isolation is unconditional).
  evalPersistTestResults: z.boolean().default(false),

  // --- standalone external API (v0.7.12) ------------------------------------
  // A plain node:http server for ecosystem integrations that cannot reach the
  // DSH-internal webServer. Disabled by default; when enabled the Bearer token
  // is persisted in the settings kv ("external_api"), auto-generated on first
  // boot. Bind host: keep the loopback default — moving it to a non-loopback
  // address exposes the whole memory store to the network and is the
  // operator's responsibility.
  externalApiEnabled: z.boolean().default(false),
  externalApiPort: z.natural().default(8790),
  externalApiHost: z.string().default("127.0.0.1"),

  // --- light mode preset (v0.7.12) -------------------------------------------
  // One switch for low-resource setups: turns off every background/semantic
  // heavy path (dream consolidation, entity extraction, vector pipeline,
  // reranker, BM25, semantic dedup / selective inject, sleep mode) while
  // keeping the core loop (autoInject, autoSummarize, hot memory, quality
  // filter, keyword search). Applied by applyLightModePreset before the config
  // reaches any service; a persisted panel_mode="light" (settings kv) counts
  // as lightMode=true too and wins over the bundle config.
  lightMode: z.boolean().default(false),

  // --- heat: v0.7.0 self-evolution (heat + interest drift) ----------------
  // 总开关，默认关（v0.7.12+ 用户已习惯无 heat 行为，默认开=全员行为变更）。
  // 开启后：提供热度字段 / sleep 降级联合判定保护 / 前端热度投影，并只在
  // 注入排序的优先级层内乘 heat（#218 v1；store 的 order=chrono 分页序与
  // 召回融合序不动）。关闭则跳过所有 heat 计算与热度触达，注入排序乘数
  // 恒 1，sleep 降级退回纯时间分层。
  // 也走 feature_flags（FEATURE_FLAG_BOOLEANS 白名单），面板可启停=线上回滚开关。
  heatEnabled: z.boolean().default(false),
  // issue #218 / E5 效用考卷：heat 乘进注入排序在真实年龄混合下饿死老约束
  // （现行量级 ≡ 拟合参数，注入集逐条相同；importance-only 遵从 +12.7pp），
  // 故注入侧 heat 改为独立 opt-in：默认关 = heatEnabled 开启后热度字段/sleep
  // 保护/前端投影照常，但注入排序乘数恒 1（与 heat 关闭逐字节一致）；
  // 显式开启才恢复「层内乘 heat」的旧序。召回侧时钟（touchLastAccess）与
  // sleep 降级联判不受本键影响——它们不参与注入排序。
  injectHeatEnabled: z.boolean().default(false),
  // 广义指数形状参数 β（heat = exp(-λ·Δt^β)，issue #218 拍板）：β=1 纯指数。
  // 快慢以 Δt>1 小时为准——β<1 衰减更慢（亚线性长尾）、β>1 更快（超线性）；
  // 0<Δt<1 的首小时内方向相反（Δt^β 随 β 增大而变小）。专家调优项，不进面板白名单。
  heatGlobalBeta: z.number().min(0.5).max(2).default(1.0),
  // per-type 衰减因子 λ；λ=0 的类型免疫（热度恒 1.0，sleep 永不降级）。
  // 未知类型走默认 0.002。dict 的键为 type 字符串、值为数字 λ。
  heatTypeDecay: z.dict(z.number(), z.string()).default({ ...TYPE_DECAY_DEFAULTS }),
  // sleep 降级联合判定的热度下限：heat < 该值 且 importance<5 才允许降级。
  sleepHeatThreshold: z.number().min(0).max(1).default(0.05),
  // recordRecall 默认值（recall_runs 记录默认开；显式传 false 的调用方不受影响）。
  recallRecordDefault: z.boolean().default(true),
  // recall_runs 滚动清理保留天数。
  recallRetentionDays: z.natural().min(1).max(3650).default(90),

  // --- tool exposure: 慢模型/轻量模型的工具往返节流（v0.8.5）----------------
  // 跨会话记忆已由 inject.js 每轮自动注入系统提示词，memory_search 只用于
  // 「注入里没有、需要深挖」的补充检索；memory_archive 是隐藏/恢复条目的整理
  // 操作，正常会话里很少需要。轻量模型对「何时该用工具」判断弱，容易每轮
  // 顺手调一遍——每次工具调用都是一次串行往返（生成参数→执行→回填→再生成），
  // 在慢模型上会被放大成明显卡顿。这两个开关允许直接隐藏对应工具（默认全
  // 开=行为不变），隐藏后模型根本看不到它，也就不会调。也走 feature_flags
  // 白名单，面板可启停=线上回滚开关。
  disableMemorySearch: z.boolean().default(false),
  disableMemoryArchive: z.boolean().default(false),

  // --- scope: v0.8.0 A1 存储层（issue #17）--------------------------------
  // 总开关默认关：关闭时写入不标注 scope、去重维持 (type, title) 现状，行为
  // 逐字节不变。开启后 memory_save 写入 agent_scope（session header 的
  // agentPreset）与 workspace_scope（registry 反查 canonical path，header.cwd
  // 兜底，取不到 NULL——解析绝不阻塞写入），去重键扩展为 (type, title,
  // agent_scope, workspace_scope, sensitivity)。检索侧加权/过滤在 A2/A3 落地。
  // 也走 feature_flags（FEATURE_FLAG_BOOLEANS 白名单），面板可启停=线上回滚开关。
  scopeEnabled: z.boolean().default(false),
  // strictScope（A3）：硬过滤模式。关闭=A2 软隔离（他 scope 降权保留可见，
  // 检索与注入排序同权重，issue #339 补齐注入通道）；
  // 开启后检索/注入/list/get 按 issue #17 四象限可见性公式硬过滤——带他 scope
  // 的记忆完全不可见，未标注（NULL）恒可见；当前会话某维度解析不到时该维度
  // 带标注的记忆一律不可见（fail-closed：身份不明只见全局）。依赖 scopeEnabled
  // 打开才有意义（没有写入标注就无可过滤维度），但独立成键：可先开标注积累
  // 数据、观察 A2 加权质量后再切硬过滤。
  strictScope: z.boolean().default(false),
});

// Fields forced to false by the light-mode preset. Everything not listed here
// (autoInject, autoSummarize, hotMemory*, memoryQualityFilter, dream
// thresholds/delays, ...) is left untouched — those are the core loop.
const LIGHT_MODE_OFF = [
  "entityExtractionEnabled",
  "autoDream",
  "sleepModeEnabled",
  "rerankEnabled",
  "autoReindexOnBoot",
  "hybridInject",
  // #249 第二批：能力说明在轻量档保持关闭——它是工具描述与提示段上的额外常驻
  // 文本，轻量档（小模型 / 小上下文）不该因默认值翻转而多付这份提示成本。
  "injectGuidanceEnabled",
  "searchSemanticDedup",
  "selectiveInjectEnabled",
  "bm25SearchEnabled",
  // 轻量模式不开图召回轴（#219，依赖实体抽取产出；抽取本身已被关掉）。
  "entityRecallEnabled",
  // 轻量模式不开图谱锚定层级联（#24 块1，依赖实体抽取 + 关系表，抽取已关则无边可扩）。
  "graphAnchoringEnabled",
  // 轻量模式不开边权重演化（#24 块2，依赖实体抽取产出；抽取关则无 v08 边可抬升）。
  "graphWeightEnabled",
  // 轻量模式不开关联提示标注（#24 块3，常驻注入文本多一段提示成本）。
  "graphInjectHint",
  // 轻量模式不开被动确认（#24 块4，依赖实体抽取产出；抽取关则无 v08 边可抬升）。
  "graphPassiveConfirm",
  // 轻量模式不开叙述条（额外 LLM 调用；#164 对齐，opt-in）。
  "dreamNarrativeEnabled",
  // 轻量模式不开 document 指针行（#230，opt-in：注册/注入/检索增强全随闸）。
  "documentMemoryEnabled",
  // 轻量模式不开热计算（heat 属于重型增强；关掉后 sleep 降级也退回纯时间分层）。
  "heatEnabled",
  // #249 N3：轻量档默认不开压缩边缘双落点——它往对话里追加消息（新的注入表面），
  // 轻量档（小模型 / 小上下文）最不该再多一份注入物。这是预设给的默认值、不是强制：
  // 用户显式勾选仍然赢（合并顺序「用户开关 > 轻量预设 > bundle 配置」，同
  // injectGuidanceEnabled）。
  "continuityRescueEnabled",
  // #380：注入前判定在轻量档默认关——每轮多一次池级 LLM 调用且延迟一轮生效，
  // 轻量档（小模型 / 小上下文 / 成本敏感）不默认背这份成本。预设默认值非强制，
  // 用户显式勾选仍然赢（合并顺序同上）。
  "preInjectGate.enabled",
  "preInjectGate.enforce"
];

/**
 * Apply the light-mode preset to a resolved config object (pure function,
 * exported for tests). When cfg.lightMode is not exactly true the config is
 * returned unchanged; otherwise a shallow copy carries false for every heavy
 * feature. Idempotent and side-effect free.
 */
export function applyLightModePreset(cfg) {
  if (cfg?.lightMode !== true) return cfg;
  const preset = { ...cfg, lightMode: true };
  for (const key of LIGHT_MODE_OFF) preset[key] = false;
  return preset;
}

/**
 * #249 第二批：注入形态的父／子开关。父 = `autoInject`（既有的挂载总闸，默认
 * 开）。子项按 #249 §10 的判据分档——看它是否引入**新的注入时机／新的注入
 * 表面／额外成本**：
 *
 * - 只修正既有每轮块内的位（能力说明）→ 随父开关生效，键的默认值给开；
 * - 需要新时机或新表面（N2 回合结束提醒、N3 压缩边缘）→ 独立开关、默认关，
 *   实现时挂到这张表下（今天还没有这两个键，故表里只有能力说明一项）。
 *
 * 语义：**父关 = 子项一律不生效，但子项的持久值原样保留**（父关是「不生效」，
 * 不是「重置用户配置」）。用户显式写进 kv 的值也不因父关被改写。
 *
 * 闸门放在消费点而不是合并后的 cfg 上：压 cfg 会让 `/features` 的 effective
 * 失去「子项自己勾着、父关时当前不生效」这个状态，面板就显示不出来。跨文件
 * 契约见 test/inject-parent-gate.test.js（含面板侧关系的漂移检查）。
 *
 * 表里只放**顶层扁平键**：点号键（如 `memoryQualityFilter.enabled`）在合并后的
 * cfg 里是嵌套对象，`cfg?.["a.b"]` 取不到，挂进来会恒判不生效且不报错。N2/N3
 * 是扁平键，不受这条限制。
 */
export const INJECT_CHILD_FLAGS = Object.freeze({
  autoInject: Object.freeze(["injectGuidanceEnabled", "continuityRescueEnabled"])
});

/** 子开关的运行时生效值：父开关显式关（false）时恒不生效。 */
export function injectChildEnabled(cfg, key) {
  for (const [parent, children] of Object.entries(INJECT_CHILD_FLAGS)) {
    if (children.includes(key) && cfg?.[parent] === false) return false;
  }
  return cfg?.[key] === true;
}
