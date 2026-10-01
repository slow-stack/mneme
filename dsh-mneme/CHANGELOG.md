# Changelog

## [0.8.12] - 2026-10-01

## 🐛 修复

- （待填）

## [Unreleased]

## 🐛 修复

- **巩固阈值基线跨重启持久化（issue #89 基线半边）**：#291 只把时间闸门 `lastRunAt` 从 `dream_runs` 恢复了回来，阈值基线 `baseline{count,chars}` 仍是调度器闭包里的内存变量，进程重启归零。库里记忆远多于阈值（默认 10 条 / 5000 字符）时，重启后第一条写入（`notifyWrite` → `dreamHook` → `maybeSchedule`，更新类写入同样计入）就让 `overBase` 成立——**阈值被整个绕过**，直接开跑一整轮巩固。0.8.11 实测一天四次重启，其后第一轮巩固发生时窗口内只新增 6 / 7 / 0 / 8 条记忆（1427 / 1488 / 0 / 1509 字符），每轮约 16 万 tokens（consolidate ≈7.5 万 + 总览 ≈8.8 万，`llm_audit_logs` 实测）。现在成功轮把「本轮结束后的活跃库规模」写进 `dream_runs.store_count` / `store_chars`（新增两列，幂等迁移，两列同时有值或同时为 NULL），调度器构造时按 `run_type='auto'` 播种；认不出行（新库、升级后还没跑过成功轮、老行两列为 NULL）就退回零基线——**不假装知道基线**，行为与升级前逐字节一致。阈值口径抽成 `activeStoreSize()` 单一实现，`shouldTrigger` 与落库共用：两处各写一份过滤条件的话，重启播种读到的基线会与运行期判定漂移（一个把 document 算进去、一个不算），而这种漂移只在重启后才显形。run 自报的基线与审计行是同一份数字，进程内刷新改用它，两条路径不再各算一次。

## 🆕 新增

- **图谱锚定层 Activation Anchoring（issue #24 块1）**：在 `entityRecallEnabled` 的「查询命中实体 → 挂联记忆进融合池」之上再加一层级联——命中实体作锚定种子（`graphSeedCap` 封顶，默认 12），沿 `entity_relations` 按 `graphCascadeDepth`（默认 2）向邻居扩散，邻居挂联的记忆以跳数配额权重（1:2:3-hop = 0.5/0.3/0.2）补位进池，恒低于种子直达分（attr 1.0 / relation 0.9）。级联 BFS 逐层懒取邻居（>1 跳真正可达），邻接查询双向绑定（方向写反的关系行不丢）。默认关=检索行为与 #219 单跳轴逐字节一致（关档连种子裁剪都不生效）。新增三键 `graphAnchoringEnabled`/`graphSeedCap`/`graphCascadeDepth` 注册进 feature_flags 白名单，面板可启停；lightMode 强制关。
- **边权重演化 Weight Evolution（issue #24 块2）**：`entity_relations` 加 `weight`/`source` 两列（幂等迁移，存量行按 manual 1.0 认账）——建边来源决定初值（manual/confirmed 1.0、llm 0.4、tag 0.3），LLM 抽取自动建的边标 `source='llm'`；演化走 `bumpRelationWeight`（只加不减、封顶 1.0，单条 `UPDATE ... MIN(1.0, weight + ?)` 原子抬升，负/非有限增量在存储边界拒绝）。新增两键 `graphWeightEnabled`/`graphWeightDelta` 注册进 feature_flags 白名单，面板可启停；lightMode 强制关。触达侧接线见块4（被动确认）。
- **关联提示防幻觉 Injection Budget（issue #24 块3）**：图召回候选进注入时默认只参与排序、不改变注入块构成（`graphInjectHint` 关，保守档）；开启后以固定句式「[检索线索]」标注、并在首个线索行前加引导语（链路信息非事实断言），条数由独立预算 `graphInjectBudget` 约束——既不受 document 预算约束、也不挤占 `maxItems` 槽位。线索行不进 pin 池（pin 会在保守档下把它放回块内，绕过开关）。新增两键注册进 feature_flags 白名单；lightMode 强制关。

- **被动确认 Passive Confirmation（issue #24 块4）**：把「人工认可/删除/忽略」的确认门槛收敛成例外管理——正常触达（记忆被召回/注入）即视为对挂联关系边的被动确认，`store.getRelationsByMemory` 反查关联边后 `bumpRelationWeight` 抬一格（只加不减、封顶 1.0，自激回路由封顶遏制）。`graphPassiveConfirm` 与 heat 是独立闸门（`heatEnabled=false` 时仍可演化边权），且受块2 总闸 `graphWeightEnabled` 约束——两键同开才生效，单开通道键绕不过「演化默认关」。仅异常路径暴露给用户复核的复核 UI 留后续块。新增键注册进 feature_flags 白名单；lightMode 强制关。

## 🧹 工程

- **基线持久化回归集 9 条，全量测试 1441 → 1450**：无种子对照组与播种组同库同写入（一个仍触发、一个被拦下——锁的正是这个差异，否则播种被忽略时两条断言同真同假）、阈值照常累积（+10 条仍触发）、run 自报基线优先于现场计算（运行后再长 15 条仍不触发）、成功轮落库 / 失败轮不落、sleep 行不进 auto 基线、半个基线被拒、老库补列幂等、非法种子（半个 / 负数 / 非整数 / 非对象）一律按「没有基线」处理、收尾取证失败既不反噬审计行也不写假基线、`index.js` 接线源码锁。**变异检验**：把播种改成忽略种子（`toBaseline(baselineSeed)` 恒为空）→ 2 条变红；把「成功轮落基线」分支短路 → 1 条变红。

## [0.8.11] - 2026-09-30

## 🐛 修复

- **侧边栏入口不再盖住「新会话」图标（PR #338）**：宿主 0.2 的侧边栏收起时只把开关（`left:12px`）与「新会话」（`left:48px`）固定在 Windows 标题栏上，而记忆入口沿用了同一个 left —— 两者完全重叠，宿主的「新会话」被压在下面，左上角只剩两颗图标。现在入口用一条更具体的规则排到「新会话」右侧 84px，并让 `--dsh-windows-menu-start` 顺延到 120px、「应用 / 编辑」菜单右移让位；这段覆盖只在收起且入口确实挂上时生效（`:has([data-sidebar-collapsed=true]):has([data-plugin-entry=…])`）。真机确认收起态为 `[开关][新会话][记忆] 应用 编辑`，无重叠。
- **冻结冲突裁决后，入口红点立刻消失（PR #338）**：裁决成功时冲突队列本就广播 `mneme:conflicts-changed`，但只有状态卡订阅了它，侧边栏红点漏订——只能等 60s 兜底轮询才更新，用户反馈「消失得很慢」。现在红点订阅该广播立即重取，打开面板时也重取；计数收进模块级单例，两处入口（portal 与 footer 回退）共享一条轮询（原先各起一条且互不同步），并发请求去重，最后一个订阅者离开即停表。60s 兜底轮询保留：后台 autoDream 自己产生/消解冲突时没人广播，靠它浮现。

## 🆕 新增

- **记忆入口改为低调面板行（PR #338）**：展开态入口 portal 进宿主 `nav.panelList`，套用 `panelRow` 的实时类名与图标/标题槽位类名，成为「插件 / 自动化任务」之后的第三个面板行。此前它套用「新会话」按钮的类名，展开后与「新会话」长得一模一样（同款高亮大按钮）——根因是**宿主 CSS 后注入，同特异性时宿主赢**，插件自己的配色覆盖从未生效。类名一律从活元素读（哈希前缀随宿主构建变），并剔掉激活态修饰类 `panelActive`，免得入口跟着宿主当前选中的面板常亮。
- **自绘 mneme mark，替换借来的「归档」图标（PR #338）**：不再用宿主的 `IconArchiveOutline*`——「归档盒」与记忆库里的归档动作是同一个符号，用户看不出这是记忆插件；而且宿主图标名换代时（#287：`Outline20` → `OutlineRegular` / `OutlineMedium`）只认一代就会把 undefined 交给 `h()`，落成 React #130 把整个 slot entry 崩掉。改为自绘螺旋（记忆痕迹 / 召回回路），规格逐条对齐宿主：16 栅格、`fill:none`、`stroke:currentColor`、描边 1；路径是 6 段三次贝塞尔拟合（与逐点采样版逐像素一致），源码里只有 200 字符。四处入口（浮层标题栏 / footer 回退 / 侧边栏 portal / better-sidebar tab）共用同一颗。
- **插件列表的图标与文案（PR #338）**：`package.json` 声明 `icon`，宿主 `iconOf()` 只收包内相对路径、realpath 不许跑出包目录、仅 SVG/PNG/JPEG/WebP、≤256KiB，命中后内联成 data URI；`assets/icon.svg` 自带品牌蓝 `#4176e6`（宿主 `--dsw-static-deepseek-500`），因为列表把它渲染成 `<img>`、继承不到 `currentColor`。列表标题与描述改读包内 `locale/en.json` 与 `locale/zh.json`（英文 `mneme`、中文 `mneme 记忆库`），`exports` 放行 `"./locale/*"`——少了这一行，宿主用 ESM resolver 读不到字典（`ERR_PACKAGE_PATH_NOT_EXPORTED`）且**静默**回落成裸包名 `@modusensus/dsh-mneme`，文件乖乖躺在包里也永不生效。

## 🧹 工程

- **面板守卫净增 6 条，全量测试 1431 → 1437**：收起态不遮挡（锁 84px / 120px 两条规则与 `:has` 守卫）、`panelActive` 不外溢、badge store **真执行**时序用例（用 `new Function` 抠出源码里那段 store，注入受控 `apiFetch`/`setInterval` 断言请求去重与定时器引用计数）、mark 自绘且不再探测宿主图标名、列表图标的声明/文件/同源漂移校验、locale 的 exports 门槛与字段形状。红点用例做过**变异检验**：把 `listeners.size === 1` 改成 `> 0`，两条用例立刻变红（"still one timer for both entry buttons"），确认测试不是空转。

## [0.8.9] - 2026-09-28

## 🐛 修复

- **V4 写入准入兼容（issue #326，PR #327）**：全部 16 处会话消息写入点（蒸馏、注入续接、巩固、
  睡眠、实体抽取、连通性探测）的 `source.kind` 从裸 `"plugin"` 改为生产者自有 kind
  `"plugin:dsh-mneme"`（`plugin` 字段保留）。DSH 0.1.7-alpha.1 起的 V4 写入校验把
  kind 缺失/空串/恰好等于 `"plugin"` 的消息整条拒绝
  （`format v4 message requires a producer-owned source kind`）：0.8.8 在新版宿主上
  压缩边缘触发时当前轮直接报错（continuity 注入点，实测见 #326），且该次抢救因边缘
  消费即删不会重试；其余 LLM 管线写入点同批统一，防宿主后续收紧时扩大受害面。
  读侧过滤（`kind === undefined || kind === "user"` 白名单）不受影响，历史库里的旧形状
  事件无需迁移。新增静态形状锁（`test/llm-message-source.test.js`）防止新增写入点回退
  到裸 kind。

## 🆕 新增

- **面板状态页与设置页重排版（PR #328）**：状态页九张卡拆成「库内一览 / 后台运转」两个扫读分组，
  多指标卡片（记忆分类 / 实体分类 / 记忆复用 / 注入预览）从「·」串联的说明长句改成一行
  一条的指标行（label 左、数值右），热度分布卡改三档堆叠条 + 分档计数——原「热门数」
  大数字易误读成总量；注入预览的 `maxItems=` / `threshold=` 裸键名改白话标签。
  设置页重组为「个性化 / 记忆引擎 / 搜索 / 连接与安全 / 帮助」五个分组（运行模式提前到
  功能开关之前、向量搜索并入搜索组、API Token 与外部访问 API 相邻为「连接与安全」），
  全部小节统一 boxed 卡片样式；功能开关说明全面白话化（document 记忆 / 严格隔离 /
  高峰时段等），逐行「重启 DSH 后生效」后缀收敛到卡片级一处——生效语义不变
  （feature_flags 仍是启动时合并，见 `src/index.js`）。意见与反馈入口重做：图标行 +
  副标说明 + 版本 footer（兼当「关于」收尾）。补 `memory.tab.summary` 中文标签
  （此前状态卡直接漏出英文 "summary"）。
- **状态卡网格排布规整化（PR #328）**：概览区三卡改 `auto-fit` 恒铺满（行尾不再留洞）；「记忆复用 /
  注入预览」在宽容器下各跨两列补齐引擎区的奇数行，跨列仅在 ≥2 列容器生效
  （container query 守卫，单列下撤掉避免隐式轨道撑爆布局）；向量卡在 2 列档位跨满整行。
- **面板星形全线统一（PR #328）**：详情抽屉编辑态的重要度下拉（文本星号，角尖锐且无法与 SVG 星
  同形）改为 SVG 星形按钮行（实心/描边与查看态同一规则，radiogroup + 逐星 aria-label）；
  重要度筛选 chip、图谱侧卡提及数、注入预览的行内星号统一走共享 `StarGlyph`
  （同一份 Lucide 路径）。`test/client.test.js` 星形守卫同步收紧为「全文零文本星号」。

## [0.8.10] - 2026-09-29

## 🐛 修复

- **注入路径 4 处截断点切开 emoji 代理对 → 会话级 400（issue #334，PR #335）**：UTF-16 `slice` 切在代理对中间会留下孤立高位代理项，序列化成非法 UTF-8，DeepSeek API 对每个请求回 400；畸形文本随注入消息被永久写进会话历史，此后每一轮都带着它（换话题/重启都不恢复）。新增 `safeSlice`（尾字符是高位代理即丢弃），热上下文查询/回复、lastUserQuery、记忆条目 4 处截断点全部换用；回归测试以「孤立代理项不存在」锁语义，配阴性对照。

- **恢复 v0.7.11 误删的对话开始时间注入（issue #34，报告 #333，PR #335）**：`injectTimePrefix` 于 v0.7.2 引入（issue #34），v0.7.11 面板大改版时随一次批量删除静默消失、CHANGELOG 无登记（同刀误删的 `escapePromptVars` 已随 #162/#165 恢复，本函数漏了）——用户按 CHANGELOG 开着开关实际什么都不会发生。本次按 v0.7.2 语义原样恢复：键名/默认值（false）/格式 `[当前时间: YYYY-MM-DD 周X HH:MM]` 不变，存量 feature_flags 恢复即生效；per-session 闩锁保证每个新会话只注入一次。

- **saveWithDedupe 透传显式 epistemic_status（trustEpistemicWeighting 写入通路缺口）**：创建路径此前丢弃显式字段，store 回退内容标记推断（中文正则）——英文/无标记内容一律落 subjective，EPISTEMIC_WEIGHTS 对整池均匀 ×0.7，`trustEpistemicWeighting` 的重排对工具主路径写入的记忆**整体空转**（v0.4.5 起消费者在、写入通路断；patch 路径 store.update 本来就通）。E 系列四臂实验现场抓到（重排臂与对照臂注入序逐条相同）。修复后 undefined 保持推断行为（存量零变化），显式值优先（契约同 resolveEpistemicStatus）；回归测试锁「observation 加权前后分数不变——字段丢失则全体缩放当场红」。

## 🆕 新增

- **写入准入第 1 级：确定性硬拒（issue #254，PR #332，贡献者 heptaspirit）**：saveWithDedupe 写入前对内容做确定性扫描——空白/噪声行（blank）与密钥/PII 形状（sensitiveScan：AWS Key、GitHub PAT、JWT、私钥块、邮箱、手机号、身份证）直接拒收不入库；`writeAdmission.enforce` 默认关（第一阶段只计量），审计行打 `gate=level1` 落 `llm_audit_logs` 供真实流量回看；被拒内容不进去重键、不占写入预算，审计回填跳过被拒行。sensitiveScan 语料全用 GitHub 官方文档示例值（运行时拼接成完整形状，源码与提交历史零真实凭据）。

## 🧹 工程

- **supersede 旧值探针进 recall benchmark（anti-update，E6/#280 链，PR #330）**：benchmark-recall 的 TEST_CASES 支持可选 `forbidden` 字段（forbidden id 进 top-K 即记 `forbiddenHit` + LEAK 标记），seed 复刻 applySupersede 落库状态（loser archived=1 + superseded-by 注记）。新增 `test/recall-anti-update.test.js` 6 例钉成回归锁：四路默认检索对归档行是**排除**不是降权、取代是归档不是删除、`includeArchived` 显式口子仍在。依据 StatemenBench anti-update probes。测试 1405 → 1411（当轮）。

## [0.8.8] - 2026-09-27

## 🆕 新增

- **蒸馏思考强度设置项（issue #315，PR #316）**：`summarizeReasoningEffort`（`off`/`low`/`medium`/`high`/`none`，默认 `none` = 不发送字段、行为不变）。思考型模型蒸馏时推理烧光输出预算、总结为空，配 `off`/`low` 可封顶推理；档位被拒自动去字段重试一次（`withEffortFallback` 共享、拒收判别式 `EFFORT_REJECT_RE` 提单一来源）；面板「功能开关 → 自动总结」下新增档位下拉。
- **压缩边缘双落点（issue #249 N3，PR #314）**：`continuityRescueEnabled`（默认关）——宿主压缩前抢救「正在做什么」：连续性提案落新表 `continuity_proposals`（`(session_id, kind)` 唯一、满 200 弃新）+ 同一份快照追加为序列末尾插件消息（压缩摘要器只看对话内容）。三字段确定性抽取、全程不调模型；降级为持久规则不算失败。新增回归 14 条（`test/continuity.test.js`），文档见 [docs/CONTINUITY.md](docs/CONTINUITY.md)。
- **错峰队列镜像到巩固（issue #239 第 4 项，PR #320）**：`dreamPeakHours` + `dreamPeakMaxDeferMinutes`（默认 120）——高峰不调模型，skip 审计 + 择时补跑，baseline 不刷新（攒到非高峰一次大 run）；时段解析三件套抽零依赖模块 `src/peak-hours.js`，顺带消除 #316 引入的 dream↔summarize 循环依赖。新增回归（`test/dream-peak-hours.test.js`）。
- **autoDream 连续失败退避（issue #292，PR #322）**：`autoDreamFailureBackoff`（默认关 = 行为逐字节不变）——开启后有效最小间隔 = `dreamMinIntervalMinutes` × 2^连续失败数，成功清零，封顶 30 分钟（只拦增长、不压小用户配的大基数）。计数内存态，跨重启冷却由 #291 持久化负责。新增回归 5 条（`test/dream-failure-backoff.test.js`）。
- **配置说明一页（issue #290，PR #322）**：新增 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)——以 `src/config.js` schema 为唯一正本，147 键全覆盖：按功能面分组，每键给默认值 / 作用 / 开启后果与冲突；lightMode 联动键逐行标注。两个 README 文档索引各加一行。

## 🧹 工程

- **GitHub issue 模板三件套（PR #321）**：bug / feature YAML forms（双语、环境字段对齐历史高质量报告）+ config.yml（空白 issue 关闭、问答引导 Discussions、漏洞引导私密通告）；feature 模板内置实现口径自查与 AI 辅助披露。
- **双 README 重复徽章行去重（PR #319）**：9-24 合并解冲突复制出的 tests 徽章与 `npm test` 注释重复行（根 README 三处、包内两处）手工去重——`badge:sync` 全文替换只会一起刷新、永不自愈。

## [0.8.7] - 2026-09-24

## 🐛 修复

- **DSH 0.1.7 系宿主上面板入口整块消失（issue #287 / #309，PR #310）**：宿主 `dsh-client-ui-primitives`
  在 0.1.7-alpha.1 起把图标命名从「像素后缀」（`IconArchiveOutline20`）换成「字重后缀」
  （`OutlineRegular` / `OutlineMedium`）且不留旧名别名，`lib/client.js` 取到 `undefined`
  交给 `h()` 渲染，落成 React #130，宿主 slot 把崩溃的 entry 整条摘除——侧栏「记忆」入口
  与记忆库面板一起消失（0.8.5/0.8.6 均受影响，跨 Windows/macOS 实测一致）。修复：运行时
  按旧名 → `Regular` → `Medium` 顺序探测，全缺时降级为无图标而非崩溃；0.1.6 系旧宿主
  链首命中不丢图标。回归守卫锁链序、裸常量不得直达 `h()`、4 个渲染点全过助手。
  感谢 chengxinshengglj-png（#257/#258/#287 三份高质量报告 + 本修复）、idoall（0.1.7-rc.1
  macOS 复现与 0.8.6 未带修复的拆包证据）、idonweb（五版本 primitives 拆包对拍钉住断点）、
  lqs50（Windows 复现与控制台日志）。

## 🆕 新增

- **存储无损回收维护入口（issue #275 第一批，PR #307）**：新增 `src/maintenance.js` 与
  `dsh-mneme reclaim` 子命令（standalone 数据面 `POST /maintenance/reclaim`）。两项零价值
  判断、零条数变化的回收：`dream_runs.input` 按保留窗口（默认 7 天）置空（run 的骨架、
  LLM 决策原文与 receipt 一律留住、永不删行）；归档行向量置空（检索 SQL 恒带 `archived = 0`、
  按定义不可达）。刻意不挂启动路径、不接定时器、不开 `auto_vacuum`：这是不可逆的内容丢弃，
  只由人显式触发（默认 dry-run，带 `--apply` 才执行，`--vacuum` 单独指定）。报告口径按
  VACUUM 前后体积量，列文本大小只作上界；执行留一行 receipt。取消归档时服务端重新排队嵌入，
  回收不是单程票。实测（活库副本：177 个 run 的输入快照 + 295 行归档向量，磁盘足迹
  69.5 MiB → 50.8 MiB，VACUUM 含 checkpoint 1.2 s）与代价见 `docs/STORAGE.md`。
- **升格吸收的 evidence 随之归档 + 归档侧第五指标（issue #275 拍板 5，PR #312）**：
  `memory_document` 注册成功后同一事务把被吸收的原子 evidence 行翻归档（只翻标志位、
  内容与审计全留、可还原；`keep_evidence_active: true` 可退出；pinned 池 constraint /
  preference 永不自动归档；document / summary 两类自有生命周期不吸收）。重注册新版文档时
  认回自己此前吸收过的 evidence 行（窄口径：别的文档引用照旧拒绝、捏造判据不变）。
  `recall-stats` 新增 `archive` 块（归档总行数 / 窗口内净增 / 日均速率 / 按内容哈希可压掉
  行数），面板「记忆复用」卡同步展示；判据用内容哈希而不用向量近重复——回收动作本身会清
  归档行向量，指标不能建在会被自己回收掉的数据上。
- **写入准入第一阶段：只计量、不拦截（issue #254，PR #305 + #311）**：新增
  `src/write-admission.js`。三个确定性测量点随每次会话内新建行落进 `llm_audit_logs`
  （一行一个新建行，全程旁路、任一步失败只 warn、绝不反噬写入）：
  ① g1 会话写入预算——`session_key` 可空列 + 索引，按会话直接计数即得「会话内新建条数」分布；
  ② g2 同话题冷却——话题锚只收机械可判的两类（issue/PR 引用、文件路径），重复时附
  `metadata.g2`（topic + gap_ms）即得「同话题重写间隔」分布；
  ③ dup 内容哈希——`memories.content_hash` 派生列（归一化 NFKC/小写/去标点/空白折叠后取
  sha256，存量回填 + 索引 + 五个写入口全重算），归档行与已遗忘行一并纳入去重候选集，
  命中区分活区 / 归档 / 遗忘三个出口分字段落盘——「出口止体积、不止重复」的另一半由
  去重候选集兜住。
  口径收口：只在新行上取测量点（并入已有行不算）；pinned 类型不进预算也不进基准，仍照记
  一行（穿透频率可观测）；无会话身份的写入（dream / summarize / import / organize）不进
  预算；`llmAudit.enabled=false` 时一行都不写。不装阈值、不加拦截分支，N 与 X 等真实分布
  再定（2026-09-23/24 拍板）。
- **MCP server 拆出独立包 `mneme-memory`（讨论 #300 双包方案第一批，PR #302）**：根目录
  新增 `mcp/` 包目录（bin 名 `mneme-mcp`），零依赖单文件从 `dsh-mneme/bin/` 迁出——工具面、
  渲染与 standalone API 数据面完全不变，插件包内旧 bin `dsh-mneme-mcp` 原样保留（向后
  兼容，已部署挂载零迁移）。新增 env 别名 `MNEME_URL` / `MNEME_TOKEN`（与 `DSH_MNEME_*`
  同级、后者优先）；跨包平价回归测试锁新包工具定义与 `src/tools.js` 逐字一致。
  `mneme-memory@0.1.1` 已上 npm 并带 `mcpName` 字段（官方 MCP Registry 发布准备，PR #304）。
- **MCP 生态收录配套（PR #306 / #308）**：`mcp/server.json` description 压到官方 Registry
  校验的 100 字符上限内；新增 Dockerfile 与 `glama.json`（Glama 目录的 running-server
  检查用，`slow-stack/mneme` 已通过 Glama 提交与徽章检查）。
- **recall_runs 审计回执附带 per-source 检索信号（PR #299）**：`searchMemories` 的 recall
  回执里每个 candidate 附 `signals`——keyword/vector/bm25/entity 四路的融合前原始分。
  纯加字段：无 schema 迁移、无新配置开关、不改任何排序行为。动机：自适应融合加权的收益
  已被消融实验锚定（AssoMem, arXiv 2510.10397），权重画像要靠这组逐路分数才能在真实
  工作负载上算。

## 🧹 清理

- **README 版本历史瘦身**（PR #301）：包 README 移除「最近版本亮点」逐版本大表与逐小版本
  路线图表（~140 行），压缩为指向 CHANGELOG 与 GitHub Releases 的短节 + 一行进化链——
  版本说明以 Release 为唯一事实来源，日后发版不再需要同步改 README。新增「用在其他 AI
  工具里（MCP）」速查节（根 README 双语）：六客户端最小挂载配置表。移除过时文档：
  `docs/devlog/`（6 篇 v0.1.x 开发日志）、`docs/MIGRATION.md`（迁移幂等自动执行）、根目录
  `IDEA.md`（未跟踪草稿）。
- **仓库更名 slow-stack/dsh-mneme → slow-stack/mneme**（讨论 #300 拍板，PR #303）：旧链
  GitHub 自动 301，协作者零操作；源码内活引用（徽章图片源、package.json 元数据、运行时
  issue 链接等 30 处）同步清扫。npm scope `@modusensus/` 不随仓库改名而变。

## [0.8.6] - 2026-09-23

## 🆕 新增

- **Sleep Mode 与实体抽取接入 LLM 审计（issue #250，#286）**：三条从未记账的后台 LLM 链路补进
  `llm_audit_logs`——sleep 冲突裁决与模式挖掘（`dream/sleep.js` 有自己的一份 `streamText` 副本，
  此前漏接 `onUsage`，现按 #242 同口径读 `chunk.usage`）与**每次写入记忆都会触发**的实体抽取
  （适配器此前没有 `service`，根本无记账能力，补 `service`/`config` 入参）。新增 `operation_type`：
  `sleep_conflict` / `sleep_pattern` / `entity_extract`，`trigger_source` 记 `sleep` / `entityExtract`。
  不新增配置键——三条链路共用 `llmAudit.enabled` 一个闸门；审计写失败只 warn、绝不反噬功能本体；
  顺带修审计诚实性（流式成功但输出无 JSON 时记 `status='error'`，与 dream_runs 不再自相矛盾），
  README 审计节覆盖面改准（autoDream 实为三次调用）。测试 1277 → **1285**。

## 🐛 修复

- **autoDream / sleep 的节流与冷却时刻跨重启持久化（issue #89 连发根因）**：两个调度器的
  `lastRunAt` 只活在内存里，进程重启即归零——最小间隔 / 冷却闸对新实例放行，重启后立刻连发
  （#89 Sample A/C 实测：横跨重启边界的 8.7 / 23.1 分钟间隔连发）。修复走审计表：`dream_runs`
  本来就逐 run 落库（failed/degraded 也算 run），新增 `store.lastDreamRunAt(runType)` 读回最近
  一次开跑时刻，构造 dream 调度器（`run_type='auto'`）与 sleep 调度器（`run_type='sleep'`）时
  注入种子——零 schema 迁移、零新配置键。审计行 `created_at` 同时改为记录**开跑时刻**而非完成
  时刻（run 耗时不应计入下一轮间隔窗口）。回归测试 +5（审计读回与 run_type 过滤、dream/sleep
  重启闸、index.js 接线源码锁 ×2）。

- **本地嵌入对 BGE 系用错池化（静默偏差，不报错，#285）**：`LocalEmbedder.embed()` 对所有本地模型硬编码
  `pooling: "mean"`，但 BGE 系（含默认的 `Xenova/bge-small-zh-v1.5`）是按 **CLS** 训练的——模型自带的
  `1_Pooling/config.json` 明确写着 `pooling_mode_cls_token: true` / `pooling_mode_mean_tokens: false`，
  官方 README 亦为「select the last hidden state of the first token」+ L2 normalize。此前每次嵌入都用了
  非训练口径的池化，向量系统性偏移、检索排序受损，且因为不抛错而完全不可观测。
  新增 `localEmbedPooling`（`auto` 默认 = 按模型族判定，BGE → `cls`，其余 → `mean` 保持既有行为；
  也可显式钉 `cls` / `mean`）。池化同时进 `modelHash`：默认 `mean` 保持历史指纹形状（未受影响的索引
  无需重建），`cls` 独立成指纹 ⇒ 既有 mean 空间的索引会被索引一致性闸门判失配并自动重建。
  测试 1275 → **1277**。

## [0.8.5] - 2026-09-21

## 🆕 新增

- **工具暴露开关：`disableMemorySearch` / `disableMemoryArchive` + 工具描述的调用纪律（默认关＝行为不变）**：跨会话记忆已由注入每轮带上，`memory_search` 只在「注入块里没有、需要深挖」时才值得一次串行往返（生成参数 → 执行 → 回填 → 再生成），`memory_archive` 是整理动作、正常会话很少需要——轻量/慢模型对「何时该调」判断弱，容易顺手每轮调一遍。两个开关把对应工具直接从注册表摘掉（模型看不到就不会调，比在描述里劝更可靠），走 feature_flags 白名单、面板可启停＝线上回滚开关；默认关即工具全暴露，隐藏仅对全新会话生效（live patch reload 下宿主不会反注册已注册的工具）。同批收紧两份常驻文案：`memory_search` 描述点明「相关记忆每轮已注入，只在注入块没有所需内容时才搜」，`memory_archive` 描述补「只在用户要求或条目确已过时时归档，不要中途主动整理」。
- **agent 主动整理接口（issue #231）：dryRun 比对报告 → 判断 → apply，全程留审计**：内聚块 `src/organize.js`，service 层只做依赖注入 + barrel 出口（`service.organize`，一个入口带 mode 参数——`{ mode: "dryRun" | "apply" }`）。按维护者口径只做功能本体：**不进工具列表、不加独立 opt-in 开关**，#249 到位时只差「注册工具 + 注入指引」一步。① `dryRun({ candidates, agent_scope?, workspace_scope?, sensitivity? })`：逐条与库内**同类型同 scope** 的行比对（精确层 = 标题归一后相等；向量层 = `MIN_SIM 0.92`，与 document 的 C2 档和 `findSessionDuplicate` 的 vector 档同源，不在第三个地方发明阈值），产出 `verdict: exact | near | new` 与命中行（含相似度），**不写记忆表**、只落一行 `dream_runs`（`run_type='organize'`）；行扫描与向量读取按 type 缓存，候选硬上限 50 条（整理不是批量导入）。② `apply({ run_id, decisions })`：`save`（走 `saveWithDedupe`，复用常规写路径的镜像/通知/重嵌入语，不另起一套 epilogue）/ `discard`（只进回执）/ `archive`（**筛除 = 归档，绝不物理删除**），整批一个事务；apply 回执行经 `outcome.dry_run_id` 指回它所依据的那份报告，审计可还原「报告 → 判断 → 落地」三步，receipt 走 `buildReceipt`——与 dream 同一格式，`parseReceipt` 可解。三条硬规则都是「宁可什么都不做」形态：dryRun 不写库；apply 必须引用一次真实 dryRun（没有比对过的候选一律不落库，堵死「跳过报告直接写」的绕过路径）；筛除只归档。宽容形态同仓库红线 4：单条非法候选/决策跳过 + 应用合法子集 + run 记 `degraded`（逐条明细进 `skipped` 列），基础设施级错误记 `failed` 并原样上抛——绝不虚报 ok。`document` 候选在 dryRun 即被拦（唯一铸造口是 `registerDocument`，#230）。`dream_runs.run_type` 的注释补第三档 `organize`（列本身无需迁移）。测试 1220 → **1228**。
- **注入形态（issue #249 第一批）：能力说明 + 约束/偏好分池逐字保真**：两个 opt-in 键，默认关/零，默认档下注入块与既有行为逐字节一致。① `injectGuidanceEnabled`（默认关）——把「怎么用记忆」的判断指引落到两个零注入成本的位置：`memory_search` / `memory_save` 的工具描述尾部各追加一句判断指引（工具描述常驻、不进每轮上下文），以及一段 order 150 的系统提示段（常量文本、`[dsh-mneme memory]` 前缀——常驻段内容必须同会话内稳定，否则每轮变化会作废其后的前缀缓存；宿主不提供 section seam 时静默跳过，能力说明仍落在工具描述上，不算失败）。指引只加在「何时不该用」真有歧义处：`memory_list` / `memory_get` / `memory_update` 的触发是机械的，`memory_register_document`（#230 已内建 `Use for … lookups`）与 `memory_runtime`（已自带 provision 成本告诫）不重复；跨工具的克制判断进总则段——第 5 条点明可逆替代品（`memory_archive` 隐藏、`memory_forget` 只停注入，两者均可恢复）与**不可逆**的 `memory_delete`，这是全 guide 里唯一有数据损失后果的一句（回归测试锁它在场）。指引写**英文单一正本**（新内聚块 `src/guide.js`）：注入指引的三条参照实现（ACP 的 `ACP_SYSTEM_PROMPT` + `HOW_TO_COMPRESS_RULES`、mnemon 的 `ROUTING_GUIDANCE`、宿主压缩摘要规则）全为英文，仓库既有先例也是工具描述硬编码英文，而 `memory.language` 管的是「生成出来的记忆内容与块内标题」，与本模块是两件事——故不并入 `STR`、不做 zh/en 双写（双写只会让两份文本日后漂移）。② `pinnedInjectBudget`（0–5，默认 0 = 关闭）——约束/偏好类进独立 pin 池：不进相关性竞争（取满预算后前置到块内排序之前）、不参与跨轮轮换（也不进轮换历史——每轮固定出现的 pin 若记进去只会占满轮换窗口、挤掉情景候选的新鲜度）、逐字保真（不受 `injectContentMaxChars` 的常规截断，只受 2000 字硬顶：逐字不等于无界，一条超长约束若无上限会每轮把常驻段吃满，超顶照旧带截断提示）。独立预算的意义是 pin 不占 `maxInjectedItems` 名额、也不会把当前任务需要的情景候选挤出去；超预算条数在块内如实标注「另有 N 条未展示」，绝不静默。选路统计经可选出参 `pinnedStats` 透出，`injectCandidates` 的「返回数组」契约不变。待维护者拍板（PR 内说明，本批次不自行决定）：`constraint` 同属 `CODING_MEMORY_TYPES`，非编码任务里已被 `codingGate` 滤掉、pin 池同样拿不到它。测试 1220 → **1228**。
- **注入预览（issue #179）**：面板状态页新增「注入预览」卡——展示最近一帧 prompt 组装实际注入了什么：条目构成（类型/标题/重要性/字符数）、hot memory 与总体积、生效参数（maxItems / threshold / 自适应条数 / scope / 轮换抑制）。实现走旁路快照：`src/inject.js` 在真实渲染路径上缓存同一份候选与最终文本（`getInjectionSnapshot()`，不二次检索、零额外开销），`GET /api/dsh-mneme/inject-preview` 只读透传，无快照（autoInject 关闭 / 新会话 / 旧宿主）整卡退化为「暂无预览」不猜；注入器卸载即清空快照，不跨生命周期存留。与 #182 的「极简模式注入关闭」提示卡同区呈现，状态页至此覆盖注入可观测性两端：为什么没注入（minimal 压制）+ 注入了什么（本卡）。另含 #178 无障碍批次一（面板 aria-live 播报网络 / 状态卡语义标题 / 弹层焦点圈 / 冲突按钮可区分标签 / ego 图摘要，对比度审计待宿主主题联调）。

- **document 型记忆——agent 产长文档入库为指针行（issue #230）**：写入权分离——全文归 agent（管线零读零写零改），库里只存摘要 + doc_path + evidence 三样；新工具 `memory_register_document({path,title,summary,tags,importance,evidence})` 作唯一铸造口（内聚块 `src/document.js`，service barrel 出口）：注册校验（~ 展开后绝对路径、存在 + 非空常规文件、evidence 与库求交——合法子集落库 + `evidence_degraded` 系统标记、全捏造整单拒绝）；C2 vector 档比对（minSim 0.92 复用 #127 档语义；同 doc_path/同标题 = 出新版显式 supersede——旧行归档 + `[superseded by <id>]` 指针注记 + content_history 存旧摘要，旧文件不删；仅向量近重复而路径标题都不同 = 拒绝并指路，不越 C1 矛盾检测替 agent 裁决）；store 新增 doc_path 列（幂等迁移），toApiList 条件透出 doc_path（普通行 DTO 逐字节同形），memory_get 渲染亮出文件路径；`documentMemoryEnabled`（默认关，白名单 + lightMode 强制关，面板「记忆增强」组第三处落位）+ `documentInjectBudget`（1–5 默认 2）；注入档位合并拍板（#164 评审线，#230 内一次落地）：叙述条（source=narrative）从纯按需解禁进注入落次优先档（受 dreamNarrativeEnabled 约束，语义/检索路径不变），document 摘要行同档 + 独立预算封顶（超预算跳过由后续候选补位），dream/sleep 五个候选池排除 document（互不代管），heat 免疫（λ=0，指针行不衰减）；写入权分离守卫双保险（saveWithDedupe / updateMemory 拒绝铸造或改入 document，standalone API 数据面给 400 `document-requires-register`），MCP 六件套 memory_list 枚举平价同步 +document（注册工具不进 MCP，接口面归 #231）。
- **总览（dream_summarize）独立路由与输入硬上限（issue #258）**：`dreamSummaryProvider` / `dreamSummaryModel`（默认空 = 沿用巩固路由，行为逐字节不变）——consolidate 有 `dreamMaxSnapshotSize` 窗口而总览输入为全库无界，两者 ctx 需求差数倍却强制共用 dream 路由：`dreamProvider` 指向小 ctx 模型时总览当场 `CONTEXT_WINDOW_EXCEEDED`（实测 120,969 > 32,768 tokens），指向大 ctx 模型则 consolidate 的卸载收益归零；`dreamSummaryMaxInputs`（默认 0 = 不设上限，0–100000 可调）>0 时按 `updated_at` 倒序保留最新 N 条（与 consolidate 窗口同一排序口径），总览口径脚注的条数随实际输入变化。三键 schema 与 settings 白名单成对落位，面板可调。

- **注入命中留痕与注入命中率（issue #217 增量，2026-09-19 口径确认）**：注入终选集落一行 `mode='inject'` 审计（candidates 存实际注入条目，跟随 `recallRecordDefault` 不设新配置键；`heatEnabled=false` 时照写——留痕与消费解耦）；recall-stats 新增注入口径（轮数 / 注入条数 / 槽位填充率 `slotFillRate`，注入候选计入 Top-N 与僵尸零曝光判定）；面板「记忆复用」卡追加注入段（窗口内无注入行时省略）。

- **蒸馏的成本感知级联与有界检查点（issue #239，第一批）**：两个 opt-in 旋钮，默认 `0` = 行为逐字节不变。① `summarizeMinWindowChars`——**蒸馏前的零 LLM 预判**：窗口内可蒸馏文本不足阈值时直接跳过 LLM 调用（纯规则判定、无模型参与；被挡下的窗口照常消费游标，否则每个 `turn/end` 都会重评同一段短文本），skip 原因写进 `llm_audit_logs`（`status='skipped'` / `error_message='window-too-small'`）——此前只有最小间隔一档留痕，「这一轮为什么没蒸馏」基本不可观测；② `summarizeMaxRunsPerSession`——每会话最多发起多少次蒸馏，只统计**真正发起过** LLM 调用的 run（被预判挡下的窗口不占额度），aborted 调用按既有口径回滚，游标刻意不消费（预算恢复或重启后仍能蒸馏到该窗口）。两键在 `config.js` schema 与 `settings.js` 整数白名单成对落位，面板可调；第 4 项（错峰队列）与第 5 项（注入侧不确定性召回）留后续批次。

- **注入条数的查询自适应（issue #239 第 5 项）**：`injectUncertaintyAdaptive`（默认关）。开启后：确定性强的话题把注入条数收缩到一半（下限 1），模糊话题（回指/时间线索，或极短查询）维持 `maxInjectedItems` 上限——**只做单向收缩**，绝不越过用户配置的上限。依据是不确定性驱动的读路径（模糊多召回、确定少召回），但「注入相关却带偏生成」的内容可能比不注入更糟（两处独立出处），所以宁可少注入也不新增这个风险面。判据只看查询本身、零额外检索（先探针检索等于白付一次 `fuseRecall`）；拿不到查询时维持现状不猜。纯函数 `needsBroadRecall` / `adaptiveInjectBudget` 落在 `src/search/adaptive.js`（与既有的查询自适应向量阈值同源），可单测。

- **蒸馏错峰队列（issue #239 第 4 项）**：`summarizePeakHours`（本地时间时段串，逗号分隔、支持跨零点，**可带星期前缀** `mon-fri` / `1-5` / `sat,sun`，省略 = 每天；如按高峰计费的供应商可写 `mon-fri 08:00-12:00,14:00-18:00`）+ `summarizePeakMaxDeferMinutes`（顺延上限，默认 120 分钟）。命中高峰时不调模型——只登记一行 `status='skipped'` / `error_message='peak-hours'` 审计并择时补跑；**游标刻意不消费**，窗口在高峰期间继续累积，非高峰一次蒸馏（批量比逐轮碎蒸更省）。被上限截断后到点仍处高峰则由 `bypassPeak` 照跑，长高峰不会把蒸馏饿死。跨零点段按「开窗那天」认星期（`mon-fri 23:00-06:00` 的周六凌晨仍算高峰）；任一写法非法则整串按「未配置」处理——排程是省钱手段，绝不该因为写错格式把蒸馏停掉。时钟与定时器可注入（房型同 `dream/sleep.js`），补跑定时器 `unref` 且 `dispose` 时清理。429 自适应退避沿用既有 `distillRateLimit*` 路径，本批次不重复造。

## 🐛 修复

- **旧版 service 缺游标 API 时降级为内存游标，不再打断每轮蒸馏（#274 回归修复）**：第三方宿主用旧版 service 构造时没有 `setDistillCursor`，此前直接抛错、一轮都蒸不了——改为记一条 warn 后降级为内存游标（#274 之前的行为）：本进程内不重复蒸馏，重启后的窗口重放由 `saveWithDedupe` 的 (type,title,scope) 三元组兜底；**方法存在但抛错仍向上传播**，那是「写失败须回滚」的恰一次语义，两条语义各带回归锁。
- **蒸馏游标持久化：重启不再重放历史窗口（issue #229）**：新增 `distill_cursors` 表（幂等迁移，按 `session.id` 记最近成功消费的事件序），游标只向前推进——较小 seq 不覆盖已存进度；记忆写入与游标推进同一事务，LLM 失败 / 解析失败 / 中止 / 记忆写入失败 / 游标写入失败任一处出错都保留窗口、回滚并如实记失败审计（此前游标只在内存里，进程重启后历史窗口被重复蒸馏）。
- **能力说明第 5 条写全 `memory_forget` 的副作用面，`memory_save` 尾句收短（#249 文案精确性）**：原文只写「`memory_forget` 只停注入」，比工具实况窄——它实际让条目从注入、检索结果与列表三处消失，写窄会让模型低估其影响面；改为与 `memory_archive`（从列表 / 检索 / 注入 / 巩固四处隐藏）同口径，回归测试锁完整短语在场。
- **运行时完整性判据从未生效：状态词对不上，而且结论根本没读（issue #268）**：`verifyPayload` 只认 `integrity.status === "sha512-matched"`，而下载通道在 `mneme-runtime.json` 里记的是 `{status: "verified", checked, detail}`（`src/runtime/download.js`，自 #133 起）——这份结论一喂进来就恒判 `ok:false`，接线即系统性判失败；更根本的是两个生产调用方（`memory_runtime` 的 verify 分支、`scripts/mneme-runtime.mjs` 的 `runVerify`）都只传 `cacheDir`，**这一层在生产路径上从未运行过**：清单里明写的 mismatch 也被静默放过（红测试证实）。附带第二处形状违约：`loader.js` 把清单里的**对象**直接填进 `describeLocalRuntime` 里声明为 `string|null` 的 `integrity` 字段，经免鉴权的 `/api/dsh-mneme/semantic` 外发，CLI `status` 还会把它打印成 `[object Object]`。修法收成一处：新增 `layout.js` 的 `recordedIntegrity()` 归一清单字段的两种形态（对象 / 缺失），判据与投影都只调它——`verifyPayload` 在调用方未显式传结论时读 `describePayload` 已解析的清单，判据同时认 `verified` 与 `sha512-matched`，并把显式 `unverified` 与「没传」同判（原先一个 `ok:true`、一个 `ok:false`）；不一致的结论（含清单里记下的 mismatch）照样判失败。


- **睡眠冲突/模式阶段的输出预算可配（issue #257）**：`src/dream/sleep.js` 冲突消解与模式发现两处 `maxTokens: 2048` 硬编码提为 `sleepMaxTokens`（默认 8192，schema + 整数白名单成对落位，面板可调）。实测依据（报告者 llama.cpp 环境）：默认档 24 对裁决需 2097 token，恰好压在 2048 边界（53 次运行 48 败 5 胜的「间歇性失败」指纹）；`sleepActionSet: full` 六分支实测需 6967（3.4 倍越界）——该档位自 #126 引入起从未跑通过。流式计费按实际用量，调大不增加成本。

- **审计记账改读 `chunk.usage`，token 不再恒为 0（issue #242）**：dsh-llm 的 StreamChunk 契约把用量嵌在 `{type:"usage", usage:TokenUsage}`（TokenUsage = inputTokens / outputTokens / …），chunk 顶层没有 token 字段——dream / summarize 的审计读取把整个 chunk 当用量对象，input/output 恒为 undefined，审计行落 0（实测 7 天 49 次 success 调用 token 全 0，面板「LLM 消耗」长期显示 0）。改读 `chunk.usage ?? chunk`，`?? chunk` 兜底兼容用量平铺在顶层的替身（嵌套 + 平铺双形状回归测试）。

## 🧪 工程

- **CI 与徽章口径收敛**：tests 徽章改为本地手工对齐（`npm run badge:sync` 自跑全量取套件总数），ci.yml / release.yml 里的 badge job 全部撤除——github-actions[bot] 推不进受保护的 main（GH006），徽章不再由 CI 自动刷；新增安全扫描三件套（gitleaks 全历史密钥扫描 + PR 依赖审查 + OSV 提醒级兜底，warn-first 起步）；仓库 slug 由 modusensus 迁移至 slow-stack（npm scope 与包名不变）。
- **依赖告警清零（GitHub code-scanning 四条 open）**：`@huggingface/transformers` 4.2.0 → **4.3.0**（其 sharp 依赖声明升至 `^0.35.4`，消掉 sharp 的两条 high——path 处理与 DoS），`package.json` overrides 的 `adm-zip` 0.6.0 → **0.6.1**（消掉 adm-zip 的 high + medium 各一条；两者均处 devDependency 链——本地嵌入运行时构建面，npm 用户装不到）。连带项：runtime-manifest 闭包在 sharp 0.35 下新走到无 `os` 约束的 `@img/sharp-wasm32` 及 freebsd/webcontainers 两个 WASM 回退包（Node 构建从不 import），按 onnxruntime-web 先例加入 `scripts/build-runtime-manifest.mjs` 的 EXCLUDED 并重生成清单；`test/runtime-manifest.test.js` 的 payloadId 断言由硬编码版本号改为取生成器输出本身（锁格式不锁版本，升级不再碎）。`npm audit`（含 dev 与 --omit=dev 双口径）0 vulnerabilities；全量测试 1243/1242 pass/0 fail/1 skip。

- **全工具矩阵的「DTO 键集 ⊆ output schema」系统性断言（issue #195）**：#184（memory_get 内联 schema 漏声明 v0.8.1 的 scope 来源三键 → 任何被标注过的行都过不了 in-process 校验）此前只有单点回归护住 `memory_get` 一个工具，换一个工具、换一个键，同类事故可以原样重演。新增 `test/tools-dto-schema-matrix.test.js`，四层断言各管一段：① 9 个工具每个可安全触达分支的**真实 execute 返回值**过生产同款校验器 `validateJsonSchemaValue`（不写手抄期望值）；② DTO 唯一产地 `toApiList` 在全形态（极简 / 敏感度 / 事件时间 / 单维与全量 scope 标注）下的输出 ⊆ `MEMORY_ITEM_SCHEMA`，并**反向**要求声明里的每个键都被至少一种形态真实产出（死声明会在下次增键时暴露）；③ 全部工具 schema 的结构不变量（闭合、required ⊆ properties、每项带 type——否则前两层会因校验器形同虚设而静默失效）；④ 负例锁：注入未声明键**必须**报错。护栏自证：两次变异测试（删共享 schema 一个键 / 给 memory_get 塞手抄小副本）分别让 2 条与 3 条断言转红。`memory_runtime` 的 provision（联网下载）与 verify 命中载荷（真实加载模型）不在单测内驱动，由 ③ 兜底声明合规。

- **supersede 旧值回归集（anti-update 探针，E6/#280 链）**：`scripts/benchmark-recall.js` 的 TEST_CASES 支持可选 `forbidden` 字段——forbidden id 出现在 top-K 即记 `forbiddenHit`，legacy/fused 与三融合配方全配置判定，CLI 报告加 LEAK 标记；seed 复刻 applySupersede 的落库状态（loser `archived=1` + 正文 superseded-by 注记，无专属取代列）。新增 `test/recall-anti-update.test.js` 6 例，把三件事钉成回归锁：四路默认检索对归档行是**排除**不是降权（谁把排除改成降权立刻红）、取代是归档不是删除（行还在、未遗忘、注记在）、`includeArchived` 显式口子仍在（排除发生在检索层而非行消失）。依据 StatemenBench anti-update probes。测试 1198 → **1204**。

## 🏗️ 工程

- 致谢：heptaspirit（#247 注入命中留痕 + #267 agent 主动整理接口 + #277 能力说明文案精确性）、davidekingsss（#248 审计记账修复 + #253 审计边界测试）。

## [0.8.4] - 2026-09-19

## 🆕 新增

- **面板标注「极简模式下注入按宿主设计关闭」（issue #182）**：`GET /api/dsh-mneme/inject-status`（只读）返回 `{autoInject, agentPreset, suppressed}`——preset 探测走 `session/event` 钩子记最近会话头（注入回调在 minimal 下被宿主整体压制，#175 定论，不能作检测源；读法与 scope.js 同源），`suppressed` 需同时满足 autoInject 生效值开启 + 观测到 `agentPreset === "minimal"`；面板状态页在 suppressed 时渲染提示卡（含解法：标准模式 / `agent-presets.default: standard` / AGENTS.md 过渡），standard 会话与 preset 未知的宿主零渲染零打扰。不新增配置键。

- **记忆复用统计端点与面板卡（issue #217）**：`GET /api/dsh-mneme/recall-stats?window=30`（整数天数，1-365 钳制，缺省 30）只读聚合——Top-N 召回（按窗口内 recall_runs 候选计数，join memories 补 type/source，已删记忆 type=null）、僵尸记忆率（活跃且窗口内零曝光，豁免期 7 天单独报数）、覆盖度标注（earliestRunAt / 扫描超上限 truncated）；纯读聚合独立成模块 `src/recall-stats.js`（service.js 过 2000 行参考线，barrel 出口调用方零改动）；面板状态页新增「记忆复用」卡（自门控，窗口内无回执整卡不渲染）。注入命中率与「入池未中」零召回语义（B）待注入留痕口径拍板后接入。
- **heat 广义指数衰减 + 注入排序热度乘数（issue #218）**：衰减式由幂律 `H=1/(1+λΔt)^α` 换为广义指数 `H=exp(-λ·Δt^β)`（FadeMem v2 Eq4，维护者拍板选型；幂律在 Wixted & Ebbesen 1991 / Rubin & Wenzel 1996 / FSRS 有支持但不在 #164 论文集内，留待真实负载回放两族 A/B）；`heatGlobalAlpha` → `heatGlobalBeta`（0.5–2，默认 1.0，默认关期间零迁移成本），λ=0 免疫位语义不变；`heatEnabled` 补进面板「记忆增强」组（feature flags 白名单第三处落位，面板可启停=回滚开关）；开启后注入排序规则路在优先级层内乘 heat——同级内乘数，priority 分层与 `order=chrono` 分页序不动，关闭时排序逐字节一致；touch 回温 / sleep 热联合判定 / 前端热度投影沿用存量路径。
- **stdio MCP server——记忆六件套进入任意 MCP 客户端（issue #181，PR #214）**：`bin/dsh-mneme-mcp.mjs` 零依赖 stdio MCP server（JSON-RPC 2.0 换行帧，不引 SDK，Node ≥ 20 全局 fetch）；工具面 memory_save / memory_search / memory_list / memory_get / memory_update / memory_delete 六件套与 `src/tools.js` 逐字对齐、平价回归测试锁漂移；配置沿用 CLI 约定（`DSH_MNEME_URL` / `DSH_MNEME_TOKEN` > `~/.dsh-mneme/cli.json` > 默认 8790）；配套 api-standalone 补齐六件套数据面（PUT /memories/:id 字段补丁、POST /memories 透传 sensitivity/occurred_at/显式 scope、GET /memories 与 /search 补 include_archived 与 occurred_from/to）。
- **图召回轴——实体挂联记忆并入检索融合池（issue #219，PR #222）**：`entityRecallEnabled`（默认 false，feature_flags 白名单可启停，lightMode 强制关）开启后检索融合池三源扩四源——store 新增 `findEntitiesMentionedIn` / `getLinkedMemoryIds` 反查原语 + `idx_relations_memory` 索引，fuseRecall 的 blend / rrf / minmax 全配方参与；实体轴与 BM25 同为确认/回填信号（we 并入 wb 后共用 0.3 回填权重），永不主导语义排序，失败降级空数组；keyword 模式契约不变（纯文本路径不吃实体轴）。
- **冷启动——从仓库文件反向构建初始记忆（issue #220，PR #223）**：`src/bootstrap.js` 确定性解析、零 LLM 必有产出——package.json scripts / README 概览 / CONTRIBUTING 规范 / CI 工作流清单 / 顶层目录树（跳过产物目录），git 仓库追加近期提交主题（execFile 5s 超时，非仓库静默跳过）；幂等骑 saveWithDedupe 的 (type,title,scope) 去重 + `_overwrite` 原地刷新，重跑零重复行，产物 source='bootstrap'；standalone API 新增 POST /bootstrap（Bearer 门内，dir 显式必填）。
- **注入截断上限可配 + 截断不再静默（#164①，PR #225）**：`injectContentMaxChars`（默认 300=既有行为，60–4000 可调）+ 面板整数档；截断尾部带提示——上限/原长/全文 `memory_get` 指引（BUDGET_EXCEEDED 原则，agent 永远拿得到取全文的路径），双语；块预算 `Math.max(1500, 上限+600)` 随上限放大，调大单条上限不被旧 1500 闸卡死；`_full_content` 压缩注入路径保持逐字不加提示，短正文零变化。
- **dream 总览升级常驻状态条——状态叙述 + 快照口径脚注（#164 对齐，PR #227）**：dreamSummary prompt 由泛化总览改为「当前状态」叙述（在做什么/最近变化/明显走向，只陈述有据事实），作为唯一常驻注入的 summary tier 0；内容尾部带快照口径脚注（整理后条数 + run 片段 + 日期），常驻答案的生成口径永远可查；`_overwrite` supersede 语义与标题不变（dedupe 键稳定，跨版本平滑）。
- **叙述条——按主题合成叙述 + evidence 证据链（#164 对齐，PR #228）**：`dreamNarrativeEnabled`（默认 false，白名单 + lightMode 强制关）+ `dreamNarrativeMinCluster`（2–20，默认 3）；`src/dream/narratives.js` 纯函数 clusterByTag（共享 tag 主题簇，≥K 门槛、降序、cap 3/轮）+ intersectEvidence（模型 evidence 与簇成员求交，捏造 id 剔除、交空回落全簇）；dream 新增 generateNarratives 阶段单次 LLM 调用按簇合成叙述（source=narrative、`_overwrite` 原地刷新、标题=叙述：<tag> 确定性键跨 run 稳定），失败降级零条不反噬主流程；store 新增 memories.evidence JSON 列（幂等迁移）；注入候选排除 source=narrative（按需检索，常驻位只留 dream 总览）。
- **路由旧值显式标记 + 行级提示与测试说明（issue #191，PR #213）**：巩固/睡眠/实体抽取的级联下拉刻意保留不在列表里的旧值（不静默丢配置），但此前与正常选项无差别展示——切 Provider 后残留的旧 model id 照常保存，分不清「改错了」还是「还没生效」。旧值收起即带「（不在可用列表）」标记，路由行给 ⚠ 提示（改选，或点「测试连通性」当场验证；改动保存后重启 DSH 生效）；标记只在适配器列表非空时判定（防误报），旧值保留保持无条件（列表为空不静默丢已存值）；「测试连通性」接上 modelTestHint 作说明行，与结果行同槽位二选一。不新增配置键。

## 🐛 修复

- **连通性测试透传 reasoningEffort（issue #215，PR #216）**：面板「测试连通性」三条路由各传各的档位键（dreamReasoningEffort / sleepReasoningEffort / entityExtractionReasoning），'none'/未配置省略字段，与后端 src/api.js 同口径——此前测试按钮不发档位，sleep 无回退重试时档位被拒只能等真实 run 才暴露；服务端零改动。
- **按事件序增量蒸馏会话窗口（PR #226）**：summarize 由「整轮转录」改为按会话事件 seq 游标增量蒸馏——只读上次成功游标之后、当前 turn/end 之前的事件；解析失败 / 流失败 / 中止不推进游标，下次仍重试同一窗口；同批记忆写入收进 `service.transaction` 原子提交（第 N 条失败不残留前 N-1 条），最后一条写入 + 解析全成功才提交已消费 seq；`lastRunAt` 节流改到真正发起 LLM 调用时才占。
- **summarize 补齐工具结果与子会话交付蒸馏（PR #232）**：tool/result 与 tool/code-dispatch 改读新消息形状（`data.message.content` 的 tool-result 块与 `data.content`，isError 判定）——旧字段废弃后工具结果一度静默消失、pitfall 根因蒸馏断供；新增子会话交付蒸馏（agent-message / subagent-settled / agent/inbox/spliced 三类消息去重进入转录），agent 委派结果不再只进工具槽；空数组语义收紧——模型明确判断无内容（合法空数组）才消费窗口，非空但全部无效不推进 seq 游标。

## 🏗️ 工程

- **复杂度自查收尾——实体召回与冷启动 5 处瘦身（PR #224）**：对 #222/#223 diff 的过度设计自查落地——bootstrap SKIP 集合去掉 .v2c、readHead 删无人覆盖的 limit 参数；findEntitiesMentionedIn 去掉等于默认值的实参、fuseRecall 删唯一调用方恒传的 entity/we 默认值、we 并入 wb（实体轴与 BM25 共用 0.3 回填权重，等 #217 数据说话再议独立权重）。
- 测试 1160 项全绿（较 0.8.3 新增 81 项：MCP stdio 帧级 / 实体召回 / 冷启动 / 注入截断 / 增量蒸馏 / 叙述条 / 常驻状态条 / 复用统计 / heat 广义指数 / 极简模式注入状态）。
- 致谢：heptaspirit（#213 路由旧值标记 + #216 reasoningEffort 透传）、z2Ace0107（#226 增量蒸馏 + #232 工具结果与子会话蒸馏）。

## [0.8.3] - 2026-09-17

## 🆕 新增

- **注入位跨轮轮换 `injectRotationTurns`（issue #205，PR #206）**：同一会话里相邻轮次反复注入同一条记忆——注入窗口只看当前轮，转出去的条目下一轮又原样转回来。新旋钮 `injectRotationTurns`（默认 0 = 关，行为不变）：记住最近 N 轮已注入的条目避免原地重复，同查询的工具轮不推进、不转自己；状态按 sessionId 分桶（FIFO 上限 32），轮换集合随 `injectCandidates` 传递（Philia-FY 报告 + A/B 验证）。
- **轮换窗口随候选池扩容（PR #208，#205 补测）**：注入候选池在语义 / bm25 / merged / 规则四处各有 `maxItems` 级硬上限，`injectRotationTurns` 开大后轮换窗口被池子卡死——条目出不了箱。四处统一扩容 `poolSize = maxItems × (轮换窗口 + 1)`（下限 200），旋钮开多大、池子就够多大（报告者读码定位 + 数学闭合验证；旧测试恰好按 maxItems×2 构造，测不到这个盲区）。
- **模型文件下载断点续传与重试 `resilientModelDownload`（issue #194，PR #207）**：本地嵌入 / 重排模型的下载一次中断就从头再来，大文件 + 不稳网络下反复白费。env.fetch 弹性层：HTTP Range / If-Range 断点续传、416 / 偏移失配自动重置重下、单写者锁 + 降级直通（不支持 Range 的源照常工作）、空闲看门狗回收半死连接；默认开启，设置页有开关与白名单双语说明（heptaspirit 报告 + 实现）。

## 🏗️ 工程

- 测试 1079 项全绿（较 0.8.2 新增 18 项：跨轮轮换 / 候选池扩容 / 断点续传与重试路径）。
- 致谢：Philia-FY（#205 报告 + A/B 复测 + 池子盲区定位）、heptaspirit（#194 报告 + 实现）。

## [0.8.2] - 2026-09-16

## 🐛 修复

- **memory_get 输出 schema 与共享 DTO 同源（issue #184，PR #186）**：内联 schema 副本漏掉 v0.8.1 的 scope 来源三键，`additionalProperties: false` 下任何被标注过的行都过不了 in-process 校验；改回与 memory_search / memory_list 复用同一份 item schema 并导出防漂移护栏（lujfsd 报告 + 三段式取证）。
- **LLM 消息补 source 字段（issue #189，PR #190，社区 PR）**：dsh-llm 契约要求每条消息携带 `source`，mneme 手拼的 13 处消息缺该字段——遇到会读 `message.source.kind` 的第三方 provider 适配器时，请求在序列化阶段（0–8 ms、零网络请求）抛 TypeError，dream / summarize / sleep / 实体抽取四条管线全灭；内置 dsh-llm-deepseek 不读该字段所以长期潜伏。13 处全部补 `{ kind: "plugin", plugin: "dsh-mneme" }`，system 消息一并补齐（heptaspirit 报告 + 修复 + 严格桩回归测试 + A/B）。
- **sleep 计时器撞 CD 不再丢轮（issue #187，PR #192）**：idle 计时器到点时若 `sleepMinIntervalHours` 未满，整轮被静默丢弃且无人重排——「CD 到期」成了没有监听者的时刻，要等下一次写入才救回来。改为按「剩余 CD / 剩余静默」更晚者重排 + 构造即挂表（Philia-FY 报告，注入时钟最小复现）。
- **本地重排器单 logit 头恒 0.5（issue #188，PR #193）**：`sigmoid(l1 - l0)` 只对双 logit 头成立，`Xenova/bge-reranker-base` 这类单 logit 交叉编码器的全部分数被压成常量 0.5——不抛错、日志照常 ready，重排静默失效。按 `cols` 分支：单 logit 取 `sigmoid(logit)`（双 logit 逐字节等价不变）；恒分批 warn 一次的绊线；顺带把 `embedModelMirror` 死配置接成 transformers 下载镜像（嵌入 + 重排双侧）、重排层补 dtype 默认 q8（新配置 `rerankDtype` 可回 fp32）、README 配置表补行（AoooooE 报告 + 三条补充全部有实测数据）。
- **连通性探测改发 user 消息（PR #197）**：0.1.6-alpha.1 起 system-only 对话被官方 API 整单拒绝（适配器把 system 抽成顶层参数），面板「测试连通性」502。探测改为一条 user 消息（保留 source 标注），回归断言锁定 role 与 source。
- **首轮注入跑偏——BM25 同步兜底（issue #198，PR #199）**：注入渲染是同步的（宿主 systemPrompt 不支持异步 text），查询向量只能异步 prefetch 给下一轮——首轮必 miss，落到静态排序后被老的高重要性 preference 占满全部槽位，当前话题的 decision/project 进不来。首轮（无向量、无缓存召回）改用 BM25 词法召回领位（纯进程内、零等待），语义命中时行为不变；优先级链：向量 > 缓存召回 > BM25 > 静态排序（lqs50 报告，根因行号级准确）。

## 🛠️ autoDream 宽容路径（issue #104 三方向闭环）

- **coverage 不足降级为 degraded（PR #200，方向 1）**：`dreamMinExplicitCoverage`（默认 0.5）护栏把提示词自己要求的「挑重点」输出整单拒绝——提示词硬性规则明文「无问题的条目无需输出」，实测官方路由 + 强模型 81 轮 failed 全是 coverage（10%–49%）、另一位报告者把门槛降到 0.3 后覆盖率仍 13%–22% 全线不达标。合法子集照常应用 + 未提及条目隐式 keep，降级理由随 `outcome.degradations` 落库；防洗白核心保留——全部决策被跳过、合法子集为空时仍整单拒绝（零幸存护栏）；`dreamImplicitKeep: false` / `dreamMinExplicitCoverage: 0` 可恢复旧严格行为。
- **archive 类型护栏 + 批量上限（PR #201，方向 2）**：长保留类型（preference / pattern / rejected_solution / constraint / pitfall）的 archive 决策必须命中「重复/过时」类理由（中英词表，宁宽勿误拦），「价值判断」式大扫除单条跳过记 skipped（明细进 `dream_runs.skipped`，run 记 degraded）——conflict 裁决的败者归档不受影响；新配置 `dreamMaxArchivePerRun`（默认 8）与 update 上限同类的全局闸门；提示词中英同步加固。`allowCrossTypeMerge` 维持 false（288 条 skipped 明细里 94% 跨类型 merge = 护栏正确工作，跨类型意图的正确出口是 `sleepActionSet: full`）。方向 3（失败审计明细）此前已由 #137 + `dream_runs.skipped` 列闭环。

## 🚀 性能（issue #202 第一批，PR #203）

- **检索路径三处固定成本**：`updated_at` 索引入 schema（幂等迁移，ORDER BY 不再走临时 B 树）；`all()` 显式列清单排除 embedding 列（5k 行少搬 ~9.4 MB，toRow 本就不输出向量）；`searchVector` 重写为 id 列查询 + 解析缓存（FIFO 上限 4000）+ Top-N 主键回表，`getParsedEmbedding` 共享读路径（vector-index / 语义去重同源），失效点覆盖 setEmbedding / update / compareAndUpdate。5k 行 / 1000×512 维向量实测：`all()` 231.6 → **50.9 ms**，`searchVector` ~140 → **16.3 ms**（lengduan 报告 + 量化脚本；第二批 TEXT→BLOB 迁移另行跟进）。

## 🆕 新增

- **standalone API 补 profile / rules 只读路由（issue #180，PR #185，社区 PR）**：8790 独立 API 对齐 DSH 内工具的画像 / 规则读取（根路径 GET /profile → {profile}、GET /rules → {rules}，Bearer 同款），MCP server v1（#181）的前置（z2Ace0107 从认领到 PR 不足一小时）。

## 🏗️ 工程

- 测试 1061 项全绿（1060 pass + 1 环境 skip；较 0.8.1 新增 35 项：source 契约四管线 / CD 重排 / 单 logit 两路 / BM25 兜底 / coverage 降级 / archive 护栏 / 向量缓存与失效 / memory_get schema 护栏）。
- 致谢本轮社区贡献者与报告者：z2Ace0107（#185）、heptaspirit（#190 及 #104 数据）、Philia-FY（#187）、AoooooE（#188）、lqs50（#198）、lujfsd（#184）、lengduan（#202 报告与 #104/#135 数据）、483218131（#104 数据）。

## [0.8.1] - 2026-09-15

## 🆕 新增

- **归属显式声明与人工纠偏（issue #170 三步，PR #171/#172/#173）**：记忆归属从「自动标注一把抓」升级为三段式可控回路——① per-dim 来源列落库 + memory_save / update 新增 scope 参数 + 面板详情抽屉可编辑（显式声明的底座，#171）；② sleep 跨 scope 相似对不再自动裁决，停车进冲突队列人工判定，纠偏回路与 #166 队列打通（#172）；③ `strictScope` 硬过滤只认显式声明——自动载体标注降为纯软加权（保留可见），硬隔离与软降噪语义分离（#173，4.3 已确认的行为口径）。
- **版本自检（PR #176，#174 后续）**：独立插件自报新版本——`GET /api/dsh-mneme/version-check` 只读路由（运行版本 vs npm registry latest）+ 设置页偏差横幅（仅 outdated 渲染，up-to-date / ahead / 查询失败全部零渲染零打扰）；registry.npmjs.org https + 精确 host 白名单（构造性排除本机/内网地址）、TTL 1h 缓存、5s 超时、全失败静默返 null；文案带 pnpm 钉子警示（安装时指定过版本的常规升级不跨 minor/major，#174 报障者的实际成因）与市场 ~1 天收录延迟说明（zh/en）。

## 🏗️ 工程

- 测试 1026 项全绿（1026 pass + 1 环境 skip；较 0.8.0 新增 38 项：scope 显式声明 / 纠偏队列 / 版本比对与白名单拒绝矩阵）。

## [0.8.0] - 2026-09-13

## 🆕 新增

- **作用域隔离（issue #17 批次 A，PR #153/#155/#156/#157 + #163）**：记忆按 agent 与 workspace 双维标注（agent_scope / workspace_scope），检索加权（本会话命中 ×1.25、他 scope ×0.5 保留可见），opt-in `strictScope` 硬过滤贯通检索/注入/列表/单取四路（身份解析不到 fail-closed 只见未标注行）；`scopeEnabled` / `strictScope` 默认关、进面板设置页「作用域隔离」组；去重键扩展 +agent_scope +workspace_scope +sensitivity——跨作用域同标题不再物理合并；memory_save 新增 sensitivity / occurred_at 参数；面板新增「作用域」徽章与详情抽屉四行（scope 标注在 web 会话全空的修复含于 #163）。
- **occurred_at 时间维度（PR #155）**：memories 新增事件发生时间列（区别于入库时间 created_at），occurred_from / occurred_to 闭区间过滤贯通 memory_search / memory_list 与搜索融合池；未标注行回退 created_at，存量数据可比。
- **冲突集中处理（PR #166）**：conflictFreezeEnabled 冻结的矛盾对新增人工出口——GET /api/dsh-mneme/conflicts 队列接口 + POST /conflicts/resolve 人工确认（盖章审计 + dream 同款处置：保留方追加已否决注记、另一方归档，CAS + 事务 + 幂等同源）；状态页新增冲突队列视图（双方并排对比 + 保留 A/B / 仅标记已处理）。
- **自定义斜杠命令提交 Agent（PR #152，issue #151）**：斜杠命令的指令内容经 agent.followup 真正提交给模型执行，不再只是 UI 提示；声明 input.hint；无 followup 的宿主回退旧行为。

## 🐛 修复

- **注入边界花括号转义恢复 + hot memory 跳过 reasoning（PR #165，issue #162）**：v0.7.4 的 escapePromptVars 在 v0.7.11 重构中被整块误删（0.7.32 受影响）——恢复三处注入出口的转义；hot memory 的 textOf 跳过 reasoning part，模型思考里出现的 `{{.Server.Version}}` 类文本不再让会话永久卡死；恢复 `escapePromptVariables` 配置（默认 true）。
- **scope 标注 web 会话全空（PR #163）**：scope 解析器先读 requestHeader()（EpochHeader 请求级路由头）遮蔽了 session.header——改为 session.header 优先；v0.8.0 发版前 web 实测发现并修复。

## 🏗️ 工程

- **autoDream 溯源致谢（PR #158）**：README 增补理念来源与致谢章节（Claude Code Auto Dream / Sleep-time Compute 论文 arXiv:2504.13171 / cc-haha）。
- 988 项测试全绿（988 pass + 1 环境 skip；较 0.7.32 新增 72 项：作用域隔离全链路、冲突集中处理、注入转义回归等）。

## [0.7.32] - 2026-09-12

## 🆕 新增

- **记忆/提示语言选项（#124）**：新增 `memory.language`（zh/en）配置，prompt 提示词、注入与镜像语言可选，中文用户不必再依赖默认英文镜像。
- **自管本地推理运行时（#131：PR #132 + #133）**：transformers 改为可选 peerDependencies + 三档取件（收编 / 本地 .tgz / registry）——运行时依赖不再强制捆绑安装，宿主可按需选择自管或沿用插件内置。
- **summarize 节流、产出上限与同会话去重（#127，PR #143）**：新增最小触发间隔（节流）+ 每会话产出上限 + 同会话写入端去重，长会话不再反复蒸馏同一主题。
- **dream 候选集向量驱动 hybrid 档（#125，PR #147）**：巩固/睡眠的候选集召回新增 hybrid 档（关键词 + 向量语义混合），配置项与设置面板同步接入。
- **sleep 冲突动作集扩展（#126，PR #146 + #149）**：`sleepActionSet` 新增 `full` 档——supersede（取代：赢家正文干净、输家归档并附「已被取代」注记）/ differentiate（双留 + 差异注记）/ update / merge / conflict / keep 六分支；默认 `conflict`，**零行为变化**；被跳决策带 phase 名落库 `dream_runs.skipped`（审计可见）；PR #149 补档位白名单、supersede 预填、索引维护等 6 处 review 修复。
- **sleep 校验路径接入 skipInvalid 宽容策略**：sleep 冲突校验现遵循 `dreamSkipInvalid`（默认 true），从「一票否决」变宽容——与 autoDream/consolidation（#104 方向）对齐；需严格一票否决可设 `dreamSkipInvalid: false`。

## 🐛 修复

- **注入助手内容读取（#129，PR #136）**：assistant 正文改从 `data.message.content` 读取，适配宿主消息结构。
- **决策前缀唯一解析 + 失败路径校验明细落库（#135，PR #137）**：8 位 UUID 前缀与整串校验对齐；失败轮次校验明细不再静默丢弃。
- **effort 未配置自动最低档 + `dreamMaxTokens` 默认抬至 131072（#135，PR #138）**：默认档位不被模型支持时自动降最低档，思考模型不再因预算不足产生空体。
- **质量过滤 importance 豁免 + 系统信号标签不被 update 抹掉（#135，PR #139）**：低 importance 豁免与信号标签保留，避免合法记忆被质量门误伤。
- **semantic ready 区分「未配置」与「初始化中」+ 索引覆盖度降级告警（#135，PR #140）**：embedder 不可达不再与「未配置」混淆，覆盖度不足时降级并告警。
- **vector boot 回填不被模型指纹短路 + 只补活跃行（#128，PR #141）**：重启回填不再因指纹不匹配整体跳过，且只补活跃记忆行。
- **degraded 轮跳过明细落库 `dream_runs.skipped`（#104，PR #142）**：降级轮被跳的决策带原因落库，审计不再只记「run degraded」一个笼统状态。

## 🏗️ 工程

- **#127 fail-safe 边界补覆盖（#144）**：审计写入器抛错不打断蒸馏、aborted run 回滚间隔打点（下一次被接纳）、候选查询异常降级 undefined、去重不可用时仍落库不丢条目。
- **runtime 测试 import 归一 src/ + 覆盖补齐**：runtime 测试从 `lib/` 切到 `src/`（c8 排除 `lib/**`，原统计把 runtime 覆盖低估到 65%），并补 embedding 成功/降级路径、`reindexMissing`、`defaultEngine` 假 transformers 驱动等 9 项用例——`src/runtime` 65.7% → 96.0%，总覆盖回到 **92.7%**（embedding 100%、verify 97.9%、index 71.6%）。
- 916 测试全绿（新增 sleep 冲突动作集 15 项 + summarize fail-safe 4 项 + embedding/runtime 覆盖补齐 9 项）。

## [0.7.31] - 2026-09-11

## 🐛 修复

- **peerDependencies 宿主版本声明不匹配中间预发布版本（#121）**：原 `^0.1.0-rc.6` 按 node-semver 预发布元组规则不匹配 `0.1.5-rc.1` 等中间预发布版本（当前 dsh 用户安装会 ERESOLVE），也违反 awesome-dsh-plugin 的 peer-range 预发布分支规范。改为显式三段式预发布分支 `>=0.1.0-rc.6 <0.2.0 || >=0.1.5-rc.0 <0.3.0 || >=0.2.0-rc.0 <0.3.0`：覆盖当前全部已发布 0.1.x（含 `0.1.5-rc.1`），未来 0.2 预发布留显式分支不静默排除，0.3 以上待验证后另行放开。

## 🏗️ 工程

- 745 测试全绿（新 peer 范围实测匹配 dsh `0.1.5-rc.1`、`0.1.0-rc.6`、`0.2.0-rc.x`）。

## [0.7.30] - 2026-09-10

## 🐛 修复

- **状态页「向量索引」卡片改读 `/semantic`（issue #118）**：旧实现读带鉴权的 `/vector-config`——无存储 token 时 401，卡片显示「加载失败」；且其 `enabled` 只反映 OpenAI 兼容外部服务，ollama/local 模式恒显「未启用」。改读开放的 `/semantic`（覆盖全部 embedder 提供方 + 索引统计），新增「初始化中（embedder 不可达，正在重试）」与「已索引 N / M 条」回填进度两种显示；清理不再使用的 `vectorOn` i18n 死键。
- **legacy OpenAI 兼容 embedder 显示「Object · 0D」**：`createEmbedder` 返回对象字面量，`constructor.name` 为 "Object"，且进程首次嵌入成功前 `dimension` 为 undefined——卡片渲染成「Object · 0D」。embedder 显式携带 `name: "OpenAI"`，`/semantic` 的 `embedProvider` 优先读 `embedder.name`；客户端维度回退索引元数据 `index.dimension`。
- **「已索引 N / M 条」分子大于分母**：`store.embeddedCount()` 不过滤归档/遗忘记忆（如实测库 269 条含 246 条归档），而 `count()` 默认只数活跃记忆（36）。embeddedCount 补齐 `forgotten = 0 AND archived = 0`，与分母同口径。
- **embedder init 失败不再永久降级（issue #118）**：Ollama 等异步初始化 embedder 在启动时不可达（服务未就绪）原先一次性判死为关键词搜索、只能重启恢复。改为有界重试（共 5 次：初始 + 4×15s），期间搜索降级关键词，重试耗尽才降级并告警；插件卸载清理重试定时器。`OllamaEmbedder` 暴露 `ready` 生命周期位，`/semantic` 新增 `ready` 字段（无 embedder 为 null、初始化中 false、就绪 true；legacy 无 `ready` 属性视为就绪）。

## 🏗️ 工程

- 745 测试全绿（新增 `/semantic` ready 三态与显式显示名优先断言、embeddedCount 剔除归档/遗忘断言、`OllamaEmbedder.ready` 生命周期断言）。

## [0.7.29] - 2026-09-10

## 🐛 修复

- **实体抽取静默失败（#108/#109）**：实体抽取的 LLM 路由契约缺陷——`provider`/`model` 未显式配置时兜底读取默认路由选择有误，且 reasoning effort 被模型拒绝后无重试路径，导致抽取静默失败或结果为空。修复：`streamEntityText` 抽取为可测试导出的 `createEntityStreamAdapter` 工厂（显式 `provider`/`model` 优先，缺省兜底读 `agentDefaultModel.currentSelection`）；配置的 `reasoningEffort` 被模型拒绝时自动去掉重试一次（与 autoDream/sleep 同一降级策略）；新增实体抽取思考强度配置（`entityExtractionReasoning`）。

## ✨ 新增

- **面板实体抽取控件**：设置页新增实体抽取 `provider`/`model`/思考强度三个控件，与巩固/睡眠一致的级联下拉 + 连通性测试。
- **「帮助与反馈」卡片**：设置页底部新增反馈入口——GitHub issue 预填（自动附插件版本 + 平台）+ 邮件 `work@modusensus.space` + 浏览已知问题去重；配套新增 `GET /api/dsh-mneme/info`（返回插件版本，供反馈环境信息）。

## 🏗️ 工程

- 744 测试全绿（新增 effort 拒绝重试 / 显式路由优先 / info 版本一致性 / 反馈卡片源码断言 用例）。

## [0.7.28] - 2026-09-09

## 🐛 修复

- **连通性测试 `reply` 恒空（思考模型）**：`POST /api/dsh-mneme/test-model` 的最小调用 `maxTokens` 仅 16，思考模型（如 deepseek-v4-flash / glm-5.3-flash）的推理过程即可将其耗尽，正文一个字都吐不出来——`reply` 恒为空，「真的答了 ok 而非只报通」对思考模型不成立。提到 1024（按实际用量计费，手动按钮无放大成本）。
- **连通性测试按钮串扰**：测试结果状态为巩固/睡眠两组共享单份，点任一「测试连通性」按钮两组同时进入「测试中…」、互相禁用、结果行双份显示。拆为巩固/睡眠各持一份，互不影响。
- **睡眠路由显示「被重置」**：面板挂载时初始化草稿的键名单漏 `sleepProvider`/`sleepModel`——后端一直保存正常，但重挂载（切页签/退出重进）后下拉恒显「跟随默认路由」，看起来像设置丢失。补键后正常回填（历史已保存的值无需重填）。

## [0.7.27] - 2026-09-09

## 🐛 修复

- **v0.7.26 端点遗漏补齐（发版树缺端点分支）**：v0.7.26 的 CHANGELOG/Release 已宣告 `llm-providers` / `test-model` 两个设置面板端点，但承载它们的 `fix/dream-effort-trap` 分支未合入 main——发版树里面板「级联下拉 + 测试连通性」调用会 404。本版将该分支 rebase 到 main 后合入（PR #100），端点实际落地；与 main 已合内容重复的提交（docs 及 effort 陷阱修复等价补丁）rebase 时自动丢弃。

## [0.7.26] - 2026-09-09

## 🐛 修复

- **记忆巩固 `UNSUPPORTED_REASONING_EFFORT` 根治（defaultEffort 陷阱）**：harness 在调用方省略 effort 参数时注入 `reasoning.defaultEffort`（模型声明的最低档），若该默认档位本身不被模型支持（如火山 coding 适配器声明 `defaultEffort="low"` 而模型只收某固定档位），则任何重试策略都无效——换 effort 或去掉 effort 都会被同一个理由拒绝。修复：新增 `resolveDreamEffort`，在发流**前**经 `ctx.llm.resolveModelInfo()` 探测路由模型支持的 effort 档位，再发送受支持的档位——
  - 配置档位（`dreamReasoningEffort` / `sleepReasoningEffort`）被支持 → 原样发送；
  - 配置档位不被支持 → 自动换用模型声明的 `defaultEffort`（若也支持）或首个支持档位，并 `logger.warn` 留痕；
  - 模型声明无 reasoning 能力 → 省略 effort 字段（发送普通补全请求）；
  - `resolveModelInfo` 查询失败 → 按配置原样发送（fail-open，不因探测失败卡死巩固）。
  - 影响面：autoDream（`dream.js`）与 sleep（`dream/sleep.js`）两条路径共用该 helper。
- **设置面板巩固/睡眠模型字段选型提示**：`dreamProvider`/`dreamModel`/`dreamReasoningEffort`/`sleepProvider`/`sleepModel`/`sleepReasoningEffort` 6 字段补 `.description()`——引导选非思考模型（思考模型可能烧光 token 预算返回空体导致巩固失败），并说明 effort 不支持时会自动换档。

## ✨ 新增

- **巩固/睡眠模型连通性测试（Web 设置面板配套后端）**：
  - `GET /api/dsh-mneme/llm-providers`：宿主侧 LLM provider/model 发现（`ctx.llm.listProviders()`/`listModels()`，逐 provider best-effort），返回 `{ providers: [{ provider, models: [{ id, name }] }] }`，无 `ctx.llm` 时 501；**密钥仅存宿主侧，不经插件侧、不入本端点**。
  - `POST /api/dsh-mneme/test-model`：`{ provider?, model?, reasoningEffort? }` 连通性探测——最小流式调用（maxTokens 16）实测模型真实可通。**空 body = 按巩固路由解析**（`dreamProvider/dreamModel > agent 默认模型`，解析不出返回 400 `no-route`）；部分输入（有 provider 缺 model）400 `missing-provider-or-model`；成功 200 `{ ok:true, durationMs, modelId }`（+`reply` 预览），失败 502 `{ ok:false, error, durationMs, modelId }`；requireAuth 鉴权。

## 🏗️ 工程

- **测试清理**：`client.test.js` 移除 identity `.replace()`（CodeQL `js/identity-replacement` 告警 #1，测试死代码）。
- 732 测试全绿。

## [0.7.25] - 2026-09-09

## 🆕 新增

- **`memory_get` 工具（第 8 个模型工具）**：按 id 读取单条记忆完整正文，用于 memory_search / memory_list 命中后读取全文。
- **`memory_search` / `memory_list` 输出内容预览**：render 现在嵌入命中条目标题、ID/type/importance 元数据与正文预览（不再只输出「命中 N 条」计数）——宿主只透传 render 文本时，模型也能直接读到记忆内容。
- **记忆巩固模型选型引导**：config 注释与 README 增加巩固模型分类声明（非思考模型 / 思考模型差异与建议），设置面板换巩固模型有据可依。

## 🐛 修复

- **`memory_get` 执行崩溃：`userExecute is not a function`**：memory_get 的 execute 被误嵌套进 output 属性内（defineTool 拿不到 options.execute），模型调用必报错；此前测试只数工具名未执行该工具，714 全绿掩盖。已移回 defineTool 顶层 + 补回归测试。
- **工具重复注册（DSH live patch reload）**：热补丁重载同一 registry 时 `tool "memory_search" is already registered`——新增按 registry 的 WeakMap 工具名去重，重复跳过并告警。
- **Standalone API 端口冲突（EADDRINUSE）**：多 DSH profile / 实例共用默认端口时 API 永久不可用——新增 listenWithRetry（最多 20 次递增 + 最终落 OS 分配端口 0），实际绑定端口回传调用方。
- **client inject 声明与实际消费不一致**：声明 `["slots","locale","layout","connection"]`，实际只消费 slots/locale——对齐为 `["slots","locale"]`。
- **better-sidebar 集成加固**：peer 依赖 `*` → `^0.18.0`（仍可选）；registerTab 前 getTab 查重跳过重复 tab；注册失败告警并降级回原生侧边栏入口，不再直接报错。

## 🏗️ 工程

- 718 测试全绿（+4 回归测试：memory_get 执行 / 缺失 id、memory_search / memory_list render 内容嵌入）。

## [0.7.24] - 2026-09-09

## 🐛 修复

- **DSH Desktop 插件树加载崩溃（v0.7.23 回归）：`cannot get property "webServer" without inject`**：v0.7.23 把 webServer 从 inject 声明中去掉想支持 headless，但 cordis 4 的 ctx 是 Proxy——**直接访问未在 inject 声明的属性会抛错而非返回 undefined**，`if (ctx.webServer)` 守卫因此失效；且去掉 inject 后 cordis 不再等待宿主 webServer 服务就绪，Windows 桌面端重启即插件树加载失败。修复两处：
  - **恢复 webServer 到 inject 声明**：cordis 等宿主服务激活后再 apply，路由注册不落时序（回退到 v0.7.22 已知正确行为）。
  - **apply/register 守卫改 `ctx.reflect.get`**（cordis 免 inject 读取，未提供返回 undefined 不抛错）：即使未来把 webServer 移出 inject 支持 headless，apply 也安全跳过 API 注册而不崩。
  - **真实 cordis + dsh-host-webserver 插件本地实测**：API 路由真实注册（GET /api/dsh-mneme/list → 200 JSON）、未知路径 404 JSON、headless 无 webServer 时静默不激活。
- **回归测试（真实 cordis Context 两种宿主形态）**：有 webServer 时插件 boot 且注册 exact 路由 / 无 webServer 时不抛错——直接覆盖本次崩溃根因，防止再犯。

## 🏗️ 工程

- 714 测试全绿（+2 回归测试）。

## [0.7.23] - 2026-09-09

## 🐛 修复

- **记忆沉淀「反复失败」根治：consolidation 合法空数组 `[]` 不再误判失败**：CONSOLIDATION_PROMPT 明确允许「无问题的条目无需输出」，模型在记忆库无冗余时输出合法 JSON `[]`（**不是**空体/截断）——`validateDecisions` 却硬判 `decision list must be a non-empty array` → runDream 整单 failed、审计表反复记失败，**记忆越健康越容易「失败」**。与 sleep 空模式（skipped no-op）语义不一致，且**与模型无关**（任何遵守 prompt 的模型都会踩中，ChatGPT/Claude 同样）。修复：对空数组显式短路 `{ok:true, applied:0}` no-op（不可简单放行——隐式 keep 的覆盖率检查 0%<50% 会拦截）。Linux 本地真实 LLM（火山 coding OpenAI 端点）实测验证：无冗余场景 `ok:true applied:0 summary:true`，审计记 ok。
- **空体修复第二段：`dreamMaxTokens` 默认 8192→32768**：思考型模型（v4 系）默认推理全开，8192 预算被 reasoning 烧光正文为空 → 默认预算翻四倍给推理留余量；上限 131072 不变，非思考模型实际用量远低无成本影响；设置面板可调。
- **skipInvalid 恢复代码 splice 残留 bug（v0.6.9 原版就带，issue #89 回归路径）**：`decisions.splice` 守卫用长度相等代理「内容一致」——当「被跳非法决策数 == 隐式补齐 keep 数」时长度回等但内容已变，被跳决策残留进 apply/audit（重复 claim 的 merge 会被照样应用）→ 改无条件 splice。由本次新增的 skipInvalid 全量测试揪出。

## 🏗️ 工程

- **skipInvalid 恢复路径全量测试补全**（12 条：逐原因跳过 + 全局闸门交互 + runDream e2e）。
- **合法空数组 e2e**：consolidation 返回 `[]` → run ok / applied 0 / summary 照跑 / audit+receipt 记 ok。
- ~~**webServer 可选化**：inject 声明去掉必填 webServer（headless/无 UI 宿主兼容），API 注册改运行时守卫。~~ ⚠️ **失败已回退**：cordis 4 直接访问未注入属性抛错（`if (ctx.webServer)` 守卫失效）+ 去掉 inject 后 cordis 不再等待宿主 webServer 服务 → **桌面端插件树加载崩溃**，见 [0.7.24] 修复。
- **712 测试全绿**。

## [0.7.22] - 2026-09-09

## 🐛 修复

- **恢复 v0.6.9 的 skipInvalid 宽容校验路径（issue #89 回归，v0.7.11 重写丢失）**：v0.6.9（issue #26）实现的 `dreamSkipInvalid`（单条非法决策跳过 + 合法子集应用 + run 记 degraded）与 `allowCrossTypeMerge` 开关在 v0.7.11 近重写时丢失，README Fail-safe 一节承诺的宽容行为自此与代码错讹；qwen3.8-flash 等弱模型决策合规抖动下 4/4 全败，整单拒绝白烧 LLM 调用。恢复三件：
  - **`decisions.js` 原样移植 skipInvalid 双轨结构**：单条错误进 local，skipInvalid 时记入 skipped 并从 decisions 原地剔除、不 claim 任何 id；严格模式（不传开关）行为不变，sleep 路径维持严格。
  - **`allowCrossTypeMerge` 显式放宽跨类型合并**；全局上限/覆盖率下限仍整单拒绝（刷爆上限=模型坏了，不是轻微 schema 漂移）。
  - **`dream.js` 透传 config 开关**：skipped 非空时 run 状态如实记为 degraded（ok:true 保持基线刷新语义），跳过明细进 warn 日志。
- **autoDream 最小触发间隔（issue #89 请求 2）**：新增 `dreamMinIntervalMinutes`（0-10080，默认 0=不限）；`minIntervalMs` 节流——失败/degraded run 也占用间隔（节流目的正是防失败调用连发），间隔内触发静默跳过。

## 🏗️ 工程

- 三个新 feature flags（`dreamSkipInvalid` 默认 true / `allowCrossTypeMerge` 默认 false / `dreamMinIntervalMinutes` 默认 0）入白名单，**34 键**。
- 696 测试全绿（+8：v0.6.9 五用例移植 + degraded/严格 e2e + 节流 + 白名单计数）。

## [0.7.21] - 2026-09-08

## 🐛 修复

- **autoDream/sleep 的 effort 回退在流式路径上是死代码（v0.7.16 补的 catch 式回退不生效）**：dsh-llm rc.1 的 `adapterStream` 把 adapter 阶段异常（含 `resolveCallWithInfo` 抛出的 `UNSUPPORTED_REASONING_EFFORT`）转成终态 error finish chunk，不再向上抛出；`streamText` 丢弃 `chunk.reason.failure`，导致配置 `dreamReasoningEffort`/`sleepReasoningEffort` 后巩固/睡眠请求被 provider 即时拒绝（tok=0、duration≈0）时，catch 式回退永远不触发，`llm_audit` 只记笼统的 `llm stream aborted or errored`。修复三处：
  - **`streamText`（dream.js 与 sleep.js 两份）捕获 finish-chunk 失败原因**：新增 `describeStreamFailure` 把 `chunk.reason.failure` 归一化为 `{code, message}` 并导出。
  - **`withEffortFallback` 增加 `getStreamError` 访问器**：结果为 `undefined` 且原因匹配 `reasoning effort` / `UNSUPPORTED_REASONING_EFFORT` 时去掉 effort 重试一次（流式路径与 catch 路径同等对待）。
  - **`runAuditedLlm` 支持 `spec.streamError`**：audit 行 `error_message` 携带真实原因（如 `llm stream aborted or errored (UNSUPPORTED_REASONING_EFFORT: ...)`）；`run.error` 保持稳定的 `"llm failed"` 不变（对外契约不动）。

## 🏗️ 工程

- 688 测试全绿（+3：dream/sleep 流级 effort 拒绝触发去 effort 重试；非 effort 流失败不盲目重试且真实原因进审计行）。

## [0.7.20] - 2026-09-08

## 🆕 新功能

- **heat 热度模型回归（issue #87 社区反馈）**：v0.7.11 近重写时与 Wiki-Link/tag 等一并被移除的 v0.7.0「自进化记忆 heat 热度模型」完整找回：
  - `src/heat.js` 纯函数模块恢复：幂律衰减 `H=1/(1+λΔt)^α` + per-type 差异化半衰期（`TYPE_DECAY`，preference/pattern/summary 免疫 λ=0）
  - 配置恢复：`heatEnabled` / `heatGlobalAlpha` / `heatTypeDecay` / `sleepHeatThreshold` / `recallRecordDefault` / `recallRetentionDays`
  - **sleep 降级热联合双保护**：phaseDemotion 需「时间窗冷 + heat<阈值 + importance<5」才降级，免疫类型永不因 sleep 降级；ref 语义恢复 `last_accessed_at ?? created_at`（updated_at 不算访问）
  - **touchRecalled 门控**由 `heatEnabled` 接管；**实体热投影**回归（ego 图谱节点 heat 字段 + 前端 nodeRadius/fillOpacity 随热度缩放）
  - **recall_runs 默认记录**恢复（`recallRecordDefault: true`）
- **阶段二前端（验收清单完成）**：/list 在 `heatEnabled=true` 时逐条下发 heat 投影（`heat.js` 纯函数，λ=0 免疫类型恒 1.0；字段缺省前端自动隐藏）；HeatBadge 三档徽章（Lucide flame + 整数百分比：热≥66% 橙 / 温 33-66% / 冷<33% 弱化藏百分比，卡片页脚与详情抽屉共用）；状态页热度分布卡（采样最近 200 条三档统计，自门控）；**order=heat 页内排序**——热度是运行时投影无存储序、SQL 排不了且分页切片后页内非全局序，走前端页内排：卡片网格对已加载条目按 heat 降序、时间树保持 chrono 不受影响；「热度优先」chip 自门控，时间线视图开启时自动切卡片视图

## ⚠️ 行为变更（验收清单落地）

- **heatEnabled 默认关**（`false`）：v0.7.12 起用户已习惯无 heat 行为，默认开=全员行为变更。默认关时 sleep 降级退回纯时间分层（v0.7.12 行为），touch 零写入。
- **feature_flags 白名单接线**：`heatEnabled` 加入 `FEATURE_FLAG_BOOLEANS`（现成 30 键机制的 31 键）——面板可启停 = 线上回滚开关，首次线上事故无需回滚版本。
- **lightMode 联动关停**：`heatEnabled` 加入 `LIGHT_MODE_OFF`，轻量模式不开热计算。
- **sleep 降级审计暴露**：`/api/dsh-mneme/dream-status` 返回 `run_type` + `demotion {demoted, archived}` 计数（数据来自 runSleep 已写入 dream_runs 的 `decisions.demotion`）——状态页工作动态可展示「降级 N 条 / 归档 M 条」，自动改记忆留痕。
- **updated_at ⊥ last_accessed_at 契约**：heat/sleep ref 永不 fallback 到 `updated_at`（只用 `last_accessed_at ?? created_at`）；heat 是运行时投影不写盘；heat 加权不进入 `order=chrono`（记忆库分页/月份树/无限滚动稳定序不受影响）。

## 🐛 修复

- **better-sidebar 软集成无 bs 环境启动失败（issue #88，用户打不开文件）**：根因是模块级/manifest 的 `inject: ['betterSidebar']` 声明被 loader 硬等待——未安装 `dsh-better-sidebar` 的环境整个 entry pending（`'1 entry did not activate'` → Failed to load plugins）。改为 dsh-server-deck 同款双模式：外层入口零 inject 立即激活（独立模式保底），tab 注册挪进 `ctx.plugin({ inject: ['betterSidebar'] })` 内层动态子插件由 cordis 原生等待——bs 未装时内层 fiber 永远 INACTIVE，静默无害；模块与 manifest（`package.json dsh.client.inject`）同步移除。

## 🏗️ 工程

- 685 测试全绿（heat 后端 +15、阶段二前端 +2：/list heat 投影契约 + client HeatBadge/分布卡结构断言；better-sidebar 修复改结构断言锁定内层子插件模式）

## 📝 历史补记与勘误（issue #87 全仓审计）

- **删除版本勘误**：v0.7.11（发布提交 `ce4658e`）近重写时移除了一批 v0.6.x/v0.7.0 实验功能（Wiki-Link、tag 系统/目录/tag 加权、user/fact 分层类型、前缀 id 解析、/stats 与 /directory 端点、heat、内置面板 client.js 内联面板）——此前本 CHANGELOG 与 README 中英 archival note 把删除归因于 v0.7.12，已统一勘误。v0.7.11 与 v0.7.12 同日发布，v0.7.12 相对其父提交未删除任何文件。
- **静默丢失补记**（此前全文档零记载，本次如实补录，**不找回**）：
  1. **provenance 出生会话溯源（`session_id`）**：v0.6.1 引入，v0.7.11 连测试一并删除；`source` 字段与 `epistemic_status` 来源分级仍保留
  2. **会话生命周期（`session_disposed_at` 软隐藏）**：v0.6.0 引入，v0.7.11 从存活的 store/service 静默剥离；README 死文档与死配置键（`sessionLifecycleEnabled`/`showSidebarTrigger`）已清理；留待 issue #47 无痕会话重做
  3. **normalizeDecisions 决策字段归一化**：v0.5.3 引入，v0.7.11 删除，功能由「提示词硬规范字段名 + extractJsonArray 解包」取代

## [0.7.18] - 2026-09-08

## 🆕 新功能

- **better-sidebar 软集成（生态第一步）**：声明 `betterSidebar` inject + optional peer `dsh-better-sidebar`，运行时软探测注册「记忆库」tab（id `dsh-mneme:memory`，复用记忆库/实体/状态/设置四视图，10×1s 重试兜服务时序）；未安装时安全跳过，独立入口（侧边栏 sheet）完整保留。`.mneme-x` 加 container-type:inline-size，`@container ≤640px` 隐藏卡片/时间线 seg 防窄容器重叠。双模式真机实测：无 bs 环境回退完好，有 bs 环境经「+」菜单进入四视图正常。
- **记忆库沉淀/归档筛选**：新增 `GET /list?deposited=only`——沉淀视图 = receipt_chain 的 merge/update live verdict（record_id 即保留/更新目标）∪ source="dream" 直写，total 同过滤，conflict 不算沉淀；筛选栏「来源」分组新增「沉淀」「已归档」chip，可与类型/重要性/时间筛选叠加（deposited ∩ archived 组合有效）。

## ✨ 优化

- **状态页仪表盘化**：沉淀/归档长列表收敛为「小页预览 + 服务端 total + 查看全部」，点击跳转记忆库并预置对应筛选——查询收敛到有搜索与分页的浏览视图，状态页保持轻量。
- **详情抽屉「恢复」**：归档记忆在抽屉内一键回主列表，与「归档」操作对称。

## 🧪 测试

- deposited 视图组合过滤（∪ source=dream、∩ archived=only、默认列表不受影响）+ client 结构断言（chip/跳转/恢复/服务端 total）；667 测试全绿。

## [0.7.17] - 2026-09-08

## ✨ 优化

- **侧边栏入口持续对齐宿主**：入口按钮的类名此前在挂载时刻快照一次，宿主/皮肤异步改写「新会话」按钮类名后会停留在旧类上（宽度/对齐失配）。改为 MutationObserver 监听类名变化持续同步，并加 `width:100%` 与宿主行同宽；去掉自作的 label 左对齐覆盖（`flex:1; text-align:left`），交还原生居中。
- **重要性星级改为星形图标**：内联 Lucide v1.42 star 路径数据（morphicons 官方配套的数据包；插件运行时禁止 require 第三方库，沿用既有内联惯例），新增 `ImportanceStars` 实心/空心星形组件，替换详情抽屉与卡片页脚的文本 ★（编辑态 `<option>` 保留文本形式，SVG 无法渲染进 option）。
- **导出/导入菜单不再被吸顶月份头遮挡**：`.mneme-xtools` 的 `transform` 会自建层叠上下文，菜单自身的 `z-index` 出不去、被时间线吸顶月份头（z-index:2）盖住。z-index 提升到容器（3：高于吸顶头、低于详情抽屉 6），下拉菜单与导入对话框随容器整体上浮。

## 🧪 测试

- 新增 client 结构断言：宿主类名持续同步（MutationObserver + attributeFilter）、入口宽度与对齐、工具栏容器 z-index、星形组件与文本 ★ 的保留范围；合并远端补测（API 路由空白 + lib 运行时冒烟）；664 测试全绿。

## [0.7.16] - 2026-09-08

## 🐛 修复

- **autoDream 在 thinking 模型上输出预算被推理吞掉、整单 failed**：consolidation 走主模型（volcano deepseek-v4-flash，v4 系默认开推理）且 `dreamReasoningEffort` 默认 `none`（不带 reasoning 控制）时，推理会耗尽 `dreamMaxTokens` 预算、正文返回空体，5 次连续 failed（`no json array in llm output`）。三处配套修复：
  - **路由优先级恢复 config-first（Issue #25）**：v0.7.11 曾把 `resolveRoute`/`resolveSleepRoute` 改回 agent 默认模型优先，导致 `dreamProvider`/`dreamModel`（设置面板「巩固模型」）在标准 DSH 安装下恒为死代码——设置页把 dream 指到非思考型模型根本不会生效。恢复「显式 config 优先、agent 默认回退」，README §config 契约与代码重新一致。
  - **reasoningEffort 被拒时回退重试一次**：配置的 effort 被 provider 拒收（volcano 实测连 `off` 都报 `UNSUPPORTED_REASONING_EFFORT`）原本整单失败；现自动去掉该字段重试一次，effort 配置（low/medium/high）可安全实测——接受就封顶推理、拒绝则退化 provider 默认并打日志。
  - **解析失败如实记账 + 原始输出日志**：`runAuditedLlm` 新增 `auditError` 检查器，「流式成功但输出不可解析」不再假记 `success`（此前 llm_audit 全是 success 却 run failed），`no json array` 时带原始输出前 300 字节日志便于定位。

## 🏗️ 工程

- 662 测试全绿（+17：config-first 路由、解析失败 audit 记 error、effort 被拒回退重试，另补 API 路由空白 /delete·/entities·/external-api 与 lib 运行时冒烟）。

## [0.7.15] - 2026-09-08

## 🆕 新功能

- **记忆库面板重设计（桌面端适配）**：面板从「挤在对话里的 tab」升级为独立交互页面——撤 `conversation.view` tab，改为居中非全屏 sheet（上限 1240×920，背板 Esc / 点击关闭）；侧边栏入口上移到工作区上方，运行时借用宿主「新会话」按钮原生类名对齐盒模型（wrapper `display:contents`），展开态与收起态（rail）都和原生图标零位移对齐；`sidebar.footer.action` 注册保留为锚点与失效回退。
- **卡片视图 / 时间线双视图**：卡片网格（类型色点 / 标题 / 摘要 / 星级 / 来源 / 相对时间）与月度时间树一键切换，偏好本地记住；无限滚动两视图通用。
- **详情抽屉与手动操作**：右侧滑出抽屉展示全文、来源、质量分、标签与**关联实体**（`GET /memories/entities?memoryId=`）；支持直接**编辑**（`POST /update`，content_history 语义不变、镜像自动重渲染）、**归档**、复制全文与两步删除；操作提示升级为 sheet 级 toast。
- **功能开关（0.7.13/0.7.14 后端能力首次上 UI）**：`GET/PUT /api/dsh-mneme/features` 30 键白名单（布尔 / 整数 / 字符串 / URL / 枚举，含 `memoryQualityFilter.enabled`、`llmAudit.enabled` 两个嵌套键与 `ollamaBaseUrl` 协议白名单），设置页分组展示（核心 / 记忆增强 / 巩固与睡眠 / 高级折叠）；**巩固模型**与 **embedding 提供方**（openai/local/ollama）可配；启动按「用户开关 > 轻量预设 > bundle 配置」合并。429 调速器参数、`distillMaxChars` 等调优项留在配置文件不上 UI。
- **状态页工作台**：新增「最近巩固」「待确认冲突」卡（`GET /dream-status`）；**工作动态流**展示 autoDream/autoSummarize 每次后台调用的状态、token 与沉淀条数；**沉淀的记忆**按 audit 关联 id 解析标题；**已归档的记忆**一键恢复。
- **导入 / 导出**：`GET /export?format=json|markdown`（Markdown 与磁盘镜像字节同构，可被导入直接吃回）+ `POST /import`（`parseHumanEdits` 重构为纯函数后复用）；面板「更多操作」菜单直达。
- **时间范围筛选**：`/list` 支持 `updatedFrom`/`updatedTo` 闭区间（date-only 归一化到整天）与 `archived=only` 归档视图，list/count 同过滤保证分页 total 一致。

## 🔒 安全

- **外部 API Token 面板默认遮蔽**：只显示首尾少量字符（显示/隐藏切换），完整值仅经「复制」通道离开面板，不再明文铺在页面上。

## 🐛 修复

- 新记忆类型 `rejected_solution` / `pitfall` / `constraint` 标签与配色补齐（此前浏览 / 筛选 / 详情里显示原始英文 key）。
- 模型工具严格输出 schema 不受面板字段扩展影响：`archived` / `quality_score` 只在 HTTP 层补充 wire DTO，`toApiList` 保持精简。

## 🧪 测试

- 645 全绿（+28：feature flags 全类型校验与嵌套键、update 往返与 404/400、entities 映射、export→import 黄金闭环、dream-status、archived=only 与默认列表互斥、面板结构断言重写）。

## [0.7.14] - 2026-09-08

## 🐛 修复

- **蒸馏不再采集私有推理块（安全，CWE-200）**：`collectMessages` 原会把 `assistant/message` 里的 `reasoning` block 作为「助手思考」送进蒸馏上下文，生成的记忆可能沉淀模型私有思考链；现只采集公开 `text` 块，私有推理不进记忆库。CodeRabbit 评审（PR #76）指出后修复。

## 🏗️ 工程

- 617 测试全绿（+1：私有 reasoning 块不进入蒸馏上下文，公开文本照常蒸馏）。

## [0.7.13] - 2026-09-08

## 🆕 新功能

- **编码记忆蒸馏（`codingRetrospect`，默认关）**：turn/end 蒸馏改用**完整转录**（用户输入 + 助手思考/回复 + 工具调用/结果 + 代码执行）提炼原子记忆，蒸馏模型能看到工具报错与调试全过程，不再只盯着用户打了什么字。新增三种编码专属记忆类型，专治重复踩坑 / 遗忘被否决方案 / 丢失工程约束：
  - `rejected_solution`（被否决/废弃的实现方案：方案简述 + 被否决原因 + 最终采用方案）
  - `pitfall`（调试踩坑记录：现象/报错 + 根因 + 解决/规避方法）
  - `constraint`（项目工程约束：约束描述 + 来源）
  - 读取侧按需加权：`isCodingTask` 判定编码任务（`codingKeywords` 关键词命中），命中时编码类记忆注入排序权重 ×`codingBoostFactor`（默认 2，封顶 5）；普通闲聊检索不到编码记忆，不污染通用召回。`tools.js` 的 `memory_save/search/list/update` 类型枚举同步扩到 7 种。
- **智能调速器（429 保护）**：对话一多时 turn/end 会批量触发蒸馏，多个 LLM 请求「一拥而上」正是 429 的来源。所有蒸馏调用进**全局串行队列**（`distillRateLimitIntervalMs` 默认 1000ms 分批放行，单次蒸馏零延迟），命中 429 按 `distillRateLimitBaseDelayMs`（默认 1000ms）**指数退避**（1s→2s→4s…）自动重试 `distillRateLimitRetries`（默认 3）次，全程对用户透明，不把 429 错误码抛出去。
- **语义保留（原子记忆）**：蒸馏 prompt 改为「每条记忆只装一个独立事实/偏好/决策，短小、自带完整上下文（数字/名字/路径/结论保留原文），宁可拆成多条也绝不合并丢细节」；完整转录上限由 `distillMaxChars`（默认 24000，可调大）控制。

## 🐛 修复

- **v0.7.12 CI 回归**：v0.7.11（ce4658e）移除 c8 与 `test:coverage` 脚本但 `test.yml` 仍调用 → 两版测试工作流 `Missing script: "test:coverage"` 直接红；恢复 `c8@^12.0.0` devDependency + `test:coverage` 脚本，覆盖率流水线复原。

## 🏗️ 工程

- 616 测试全绿（+4）：蒸馏全局串行队列、429 指数退避重试（`distillRateLimitRetries:3` 实测 3 次退避）、完整转录原子记忆 prompt、`codingRetrospect` 落库 `rejected_solution`（tags 空数组，读取侧靠 `m.type` 门控）。

## [0.7.12] - 2026-09-08

## 🆕 新功能

- **独立外部 API（生态集成）**：插件可启动自己的 HTTP 服务（默认 `127.0.0.1:8790`，仅回环绑定），其他插件/CLI/桌面工具经 Bearer token 读写记忆，不再依赖 DSH 内部端口。路由：`GET /health`（免鉴权）、`GET /status`、`GET/POST/DELETE /memories`、`GET /memories/:id`、`GET /search`；token 首次启用自动生成并持久化（设置面板可查看复制）。配置：`externalApiEnabled/externalApiPort/externalApiHost` + 面板设置持久化（重启生效）；非回环绑定的安全责任由操作者承担。
- **CLI 工具 `dsh-mneme`**：零依赖命令行（`bin/cli.mjs`）——`status` / `list` / `search` / `get` / `add` / `delete` / `config set|show|path`，配置优先级 参数 > 环境变量（DSH_MNEME_URL/TOKEN）> `~/.dsh-mneme/cli.json`；`--json` 机器输出。
- **轻量模式（lightMode）**：面向非技术用户的简化预设——只保留核心的记忆读写与自动注入（autoInject/autoSummarize/hot memory/质量过滤），关闭 autoDream 巩固、实体抽取、语义搜索、rerank、bm25、选择性注入等重资源项；`applyLightModePreset` 纯函数 + `panel_mode` 持久化（持久化优先于 bundle 配置），设置面板一键切换（重启生效）。
- **设置面板新卡片**：「运行模式」（轻量/标准）与「外部访问 API」（开关/地址端口/Token 复制），中英文案齐备。

## 🏗️ 工程

- 612 测试全绿（+17）：独立 API 10 例（401/health/CRUD 闭环/搜索/400 校验）、mode 路由 3 例、external_api kv 2 例、light 预设与 config 用例；`store.count` 支持 minImportance/source 后 total 与行一致。

## [0.7.11] - 2026-09-08

## 🆕 新功能

- **记忆库面板改版（可扩展性 + 实时性）**：
  - **按月分页 + 无限滚动**：记忆浏览从一次性 `limit=500`（超限即静默丢失）改为 100 条/页的时间序分页（`list?order=chrono`，`store.list` 新增 `order` 参数、`/api/dsh-mneme/list` 透传），滚动到底自动拉下一页（IntersectionObserver 哨兵 + 「加载更多」按钮兜底），底栏常显 `已加载/总数`。
  - **月份默认折叠**：仅最新一个月展开，历史月份收起为一行标题（带条目计数），月份表头吸顶；几千条记忆也只渲染少量 DOM。
  - **搜索全局化**：关键词/语义搜索都改走服务端（`mode=keyword|vector`），命中全库而不仅已加载页；`type` 过滤在搜索结果上继续生效。
  - **数据实时性**：记忆子视图激活时即刷新第一页，打开期间每 30s 静默刷新（页面不可见时暂停），新记忆无需手动刷新即可出现；图跳转的记忆若在未加载页，以单条结果呈现并选中。
  - **图标与视觉**：内联 Lucide 风格 stroke 图标（路径数据打包进 bundle，运行时零依赖；与 morphicons 消费的 lucide 数据同源），替换文字箭头/子 tab 图标/搜索/刷新/复制等；月份表头、加载更多、空态样式梳理。
- **bundle 默认开启实体抽取**：`cordis.patch.yml` 增加 `entityExtractionEnabled: true`（此前默认 false，图谱实体只在显式配置过的环境增长）。新记忆落库即自动抽取实体/关系，图谱随对话自动生长。
- **记忆库「状态」子页**：记忆总数（含分类型小计）、实体计数（含分类型小计）、向量索引开关状态、近 7 天 LLM 调用/消耗四张卡片，分区独立加载互不阻塞。
- **记忆删除（两步确认）**：详情面板新增红色「删除」按钮——首次点击变为实心红「确认删除？」+「取消」，确认后走新增的 `POST /api/dsh-mneme/delete`（`{id}`，复用 requireAuth 围栏；400 缺 id / 404 不存在），本地列表与计数同步移除。
- **重要性过滤**：分类栏新增 全部/★3+/★4+/★5 服务端过滤芯片（`list?minImportance=`），`store.count` 同步接受过滤参数使分页 total 与行一致；浏览分页、加载更多、自动刷新共用同一过滤态。
- **双语 README**：新增 `README.en.md`（与中文版逐节对齐），两版互挂语言切换链接。

## 🐛 修复

- **Issue #72：窗口最大化后图谱节点不可见**：力导向模拟此前以 SVG 元素的 CSS 宽度（`clientWidth`）为布局边界——最大化窗口下元素宽达上千 CSS px，重心（`clientWidth/2`）与钳制区间都落到 380×300 viewBox 之外，节点整体被裁剪出画布（窗口较小时两个空间近似重合，所以一切正常）。现在模拟全程在 viewBox 用户单位（`VIEW_W`/`VIEW_H`）中运行，与绘制空间严格一致；浏览器把 viewBox 等比缩放到元素实际尺寸，小窗、隐藏 tab、最大化均可见、可拖拽，布局不再依赖挂载时的容器测量。
- **Issue #59：DSH ≥0.1.2-rc 上 autoSummarize 从不执行**：DSH 0.1.2-rc 起移除了 `Session.events` 属性，事件只能经 `snapshotEvents()` 获取——`collectMessages()` 拿到的恒为空数组导致 `summarize()` 直接退出，`llm_audit_logs` 全空、从未发起 LLM 调用。`summarize.js` 与 `inject.js`（`lastUserQuery` / `extractRounds`）三处统一改为 `session.snapshotEvents?.() ?? session.events ?? []` 兼容垫片：新 DSH 走 snapshot 方法，老版本回退 `.events`，两边都不破坏。

## 🏗️ 工程

- 595 测试全绿：新增 snapshotEvents 回归 2 例——summarize（仅暴露 `snapshotEvents()`、无 `.events` 的会话必须触发 LLM 调用并入库 2 条记忆）与 inject（无 `.events` 会话下「短期上下文」热记忆块照常渲染）。

## [0.7.10] - 2026-09-07

## 🆕 新功能

- **记忆类型色点体系**：新增 `MEMORY_TYPE_COLORS` 调色板（preference 琥珀 / project 绿 / decision 蓝 / summary 紫 / user 琥珀 / fact 绿 / history 灰，与图谱实体色同一风格的中饱和固定色相，明暗主题均可读）与 `.mneme-xdot` 色点组件，贯穿三处——类型筛选行（「全部」为空心环保持对齐）、时间树每一行、详情 meta。同一颜色在任何位置都代表同一记忆类型，扫视时间树即可分辨构成。分类计数改为 `margin-left:auto` 右对齐，色点不挤计数。
- **图谱画布平移 + 滚轮缩放 + 重置视图**：此前画布仅有节点拖拽，`cursor: grab` 暗示的画布拖动从未实现。新增 `viewRef`（translate+scale）视口状态与 `<g transform>` 包裹层——空白处按住拖动平移整图；滚轮缩放以光标为锚点（0.5x–3x，native 非 passive wheel 监听，React 合成 `onWheel` 为 passive 无法 `preventDefault`）；节点 `mousedown` 增加 `stopPropagation` 防止误触发平移；节点拖拽灵敏度按缩放系数换算，放大后拖节点不再"飘"；图谱工具栏新增「重置视图」一键复原；画布高度提升至 320px；操作提示更新为「拖拽节点调整布局 · 空白处拖动平移 · 滚轮缩放」。
- **设置页分区重排（借鉴 Claude App 设置排版）**：设置内容改为 `.mneme-set-sec` 分区呈现——用户画像 → 规则 → 自定义指令 → 自动打标签 → 侧边栏入口 → 向量搜索 → API Token（高级项移至最后），每区标题 + 一句话说明 + 细分隔线；规则行重做：编号圆点 + 圆角行 + 悬停浮现删除按钮，输入框回车直接添加；命令行 `/名称` 主题蓝高亮；全部输入控件统一 `.mneme-set-input`（聚焦品牌蓝描边）与 `.mneme-btn`。中英文提示全部重写为口语化文案（如规则区"给 Agent 立下必须遵守的规矩，随时增删，下一轮即生效"）。0.7.3 引入的自动打标签与侧边栏入口开关功能原样保留，仅归入新排版。
- **详情 meta 精排**：来源 `session:<uuid>` 截断为 200px 省略（完整值悬停可见），创建时间只显日期、更新时间改相对时间（超一周回退日期，完整时间戳保留在 tooltip），meta 恢复单行。
- **新增只读端点 `GET /api/dsh-mneme/entities`**：实体清单（名称/类型/提及次数/首末见时间，`limit` 上限 1000），为实体目录 UI 与后续视图供数；exact 路由 19 → 20 条。

## 🐛 修复

- **侧边栏入口同标签冲突**：会话 tab 在 DOM 上不带注册 id，旧激活逻辑取"文档中第一个文字匹配的 `[role=tab]`"——安装其他插件后，同名标签或隐藏的设置分页会被误激活（表现为点击「记忆」无反应或跳错视图）。现改为 `findExplorerTabs` 多候选：先以 `offsetParent` 过滤不可见面板，点击后验证 `.mneme-x` 确实渲染才算成功，失败自动尝试下一个候选，全部失败仍回退全屏覆盖层。`test/client.test.js` 新增两条契约断言（渲染验证 + 隐藏面板过滤）。

## 🏗️ 工程

- `scripts/e2e-dsh.js` 的路由数断言从失真的 9 条修正为与 `src/api.js` 返回值一致的 20 条；client 测试同步适配新激活契约。
- 全套 **815 测试通过**（含 client 激活契约 2 个新断言）。

## [0.7.9] - 2026-09-06

### 🐛 修复：v0.7.8 的 rc.1 snapshotEvents 适配未同步到 lib/（issue #65）

- **现象**：v0.7.8 为兼容 DSH 0.1.2-rc.1（`Session.events` → `snapshotEvents()`）只改了 `src/inject.js` 与 `src/summarize.js`，发布产物 `lib/` 从未同步——npm 包实际加载的是 `lib/`（`main` 指向 `lib/index.js`），用户在 rc.1 下安装 0.7.8 运行的仍是未适配代码。因代码带 `?.` / `?? []` 容错，**不报错但热记忆注入与会话摘要静默失效**。
- **修复**：将 src 的兼容垫片同步到 `lib/`（两文件 3 处），`src/` 与 `lib/` 逐文件一致。
- **防再犯（双保险）**：
  - 新增 `scripts/check-sync.js`：断言 `src/` 与 `lib/` 一致性，root `prepack` 钩子调用——发布前不一致直接 fail；
  - 新增 `test/lib-smoke.test.js`：从 `lib/` 直接导入复跑 snapshotEvents 关键用例 + 静态断言 src→lib 逐文件一致，CI 每次全量测试拦截。
- 新增 3 个用例（lib 版 snapshotEvents 注入/摘要 + 一致性断言），全套 **815 通过**。

## [0.7.8] - 2026-09-06

### 🐛 修复：DSH 0.1.2-rc.1 兼容（issues #58 #59）

- **现象**：DSH 0.1.2-rc.1 起官方移除 `Session.events` 属性、改为 `snapshotEvents()` 方法。autoSummarize（会话摘要）与 hot-context（短期上下文）注入都依赖 `session.events` 读取会话事件，升级后取到 undefined 而**静默失效**——会话摘要不再落库、短期上下文块不再渲染。
- **修复**：`src/summarize.js` 与 `src/inject.js` 两处取事件统一改为兼容垫片 `session.snapshotEvents?.() ?? session.events`——0.1.2-rc.1 及以后走新方法，更早 0.1.x 仍走 `.events`，**新旧 DSH 通吃**。
- **说明**：兼容垫片，老版本 DSH（0.1.x 早期）行为完全不受影响，无需任何配置改动。
- 新增 2 个回归用例（会话只提供 `snapshotEvents()` 时 hot-context 渲染与会话摘要均恢复），全套 **812 通过**。

## [0.7.7] - 2026-09-05

### 🆕 issue #23：sleep 批量实体抽取回填实体图谱

- **背景**：写路径抽取（index.js）只有 `entityExtractionEnabled` 开启才触发——每次写入一次 LLM 调用，是刻意的成本取舍——所以默认安装下记忆从不累积实体，这正是 issue #23 报的"实体图谱面板一片空白"（用户明明有很多记忆）。
- **新增 sleep 批量抽取 phase**：默认关 `sleepEntityExtractionEnabled`，开睡循环时按**最老优先**把没有实体属性的记忆逐条过 `extractEntities`（每轮上限 `sleepEntityExtractionMaxPerRun` 默认 20）。
- **下沉为有界 SQL 查询**：新增 `store.listForEntityExtraction({limit, offset})`，`WHERE` 只留行级条件（未归档/未遗忘/非 summary/内容非空/`metadata.entity_extracted_at` 为空），`ORDER BY created_at LIMIT ? OFFSET ?` 分页取最老候选；实体是否已存在是跨表检查（`getAttrsByMemory`），由 JS 在每页上过滤。不再 `service.all()` 全表加载。
- **幂等防重**：抽取前先 stamp `metadata.pending_extracted_at`，成功后替换为 `entity_extracted_at`，失败清除 pending——一条记忆不会被并发/崩溃重复抽取，失败的下轮重试。
- **metadata 合并不覆盖**：`store.setMemoryMetadata` 改为 merge 语义，打实体时间戳不会抹掉其他路径刚写入的 metadata 字段。
- **失败不阻断**：单条抽取失败只跳过该条、记入 `failed` 计数，整轮状态由 `deriveStatus` 正确折叠 `failed`——一次 LLM 抖动不会 abort 整个 sleep 周期。
- **node:sqlite 兼容修复**：初版实现用 better-sqlite3 的 `.pluck()`（node:sqlite 不存在），改为 `.all().map(row => getById(row.id))`；`listForEntityExtraction` 的 `forgotten IS NULL` 条件与 `save` 硬编码写入的 `forgotten=0` 永不匹配导致查询恒空，修正为 `(forgotten = 0 OR forgotten IS NULL)`（与 archived 同构）。
- 新增 9 个用例（禁用/跳过、stamp 不重复、无实体也 stamp、backfill、失败重试、metadata merge、pending 清除、failed 状态折叠、分页最老优先），全套 **810 通过**。

## [0.7.6] - 2026-09-02

### 🐛 issue #48：截断的短 id 也能精确操作

- **现象**：`memory_update` / `memory_delete` / `memory_forget` / `memory_archive` 此前对 id 做**严格精确匹配**（`WHERE id = ?`，无任何前缀/模糊逻辑）。若宿主上下文压缩或手抄把 36 位 UUID 截断，`memory_delete` 会静默返回 `{deleted:false}`（无 warn、无日志），其余三个工具抛错——对用户都表现为"操作不进也不出"。
- **新增 `service.resolveMemoryId`**：精确命中优先，否则把传入值当 id 前缀解析（主键前缀走索引，无性能问题）；命中多条 → 拒绝操作并列出候选完整 id，**绝不瞎猜**。
- **四工具统一接入**：`memory_update` / `memory_forget` / `memory_archive` 未命中抛错并提示"请传完整 id（`memory_list` / `memory_search` 输出均为完整 id）"；`memory_delete` 保持幂等返回 `{deleted:false}`，未命中补 `logger.warn` 留痕，可被服务日志定位。
- 完整 id 直连不受影响（精确命中优先，不会因"恰好是另一条的前缀"被误判歧义）。
- 复验加固：纯通配符 id（`%`/`_`）剥空后按无匹配处理，杜绝退化成 `LIKE '%'` 全表误删单条记忆；id 首尾空白自动 trim。
- 补 11 个用例（前缀删除/更新/归档/遗忘、歧义拒绝、未命中兜底、精确优先、通配符兜底、空白 trim、warnMiss 日志），全套 **801 通过**。

### 🧹 工程：client.js 改为 src 正源

- Web 面板 bundle `client.js` 历史上是 lib/ 下**手写、无 src 副本**的唯一例外（重蹈过 v0.6.7 源码漏提交）；现补 `src/client.js` 为唯一正源，`npm run sync` 统一同步出 `lib/client.js`，guard 测试改为断言两文件字节一致，杜绝 drift。

## [0.7.5] - 2026-09-02

### 🆕 新功能：分层记忆类型 user/fact

- 借鉴 meow-memory 的七层分层概念，贴合 dsh-mneme 单表 `memories` + `type` 字段架构，只补最轻量的两个分层，不动表结构：
  - **`user`** — 用户画像（身份/背景/偏好档案）
  - **`fact`** — 原子事实（不随时间漂移的客观事实）
- 全链路打通：`store.TYPES` / `tools` 工具枚举与描述 / `summarize` VALID 集合与提炼 prompt / `quality-filter` 标签 / `mirror` 镜像文件（`user.md` / `facts.md`）/ `service.INJECT_TYPES` 注入（user 与 preference 同级常注入，fact 按重要性阈值注入）
- Web 面板「总览」视图：记忆分层卡片（六类型+summary/pattern）+ 用户画像卡 + 类型分布面板 + 近 7 天创建趋势

### 🆕 新功能：stats 统计端点

- `GET /api/dsh-mneme/stats?days=N`：按类型分布 + 近 N 天（默认 7，夹紧 1..30）逐日创建趋势，SQL 聚合不受 list 50 条限制，排除归档/遗忘/会话销毁

### 🔧 复验修复（kimi-k2.7-code）

- `days` 参数整数化：`?days=7.5` 不再产生 8 个趋势点（`parseInt` 夹紧 + store 层防御）
- store 单次 `Date.now()` 读取，避免趋势窗口跨天边界不一致
- 前端趋势图 0 值天渲染 0 高度柱（不再伪装成有数据）；INJECT_TYPES 注入注释说明"常注入 vs 按重要性阈值"

### 测试

- 新增 8 个测试（分层类型/镜像/提炼/list 过滤/stats 分布+趋势/归档遗忘排除/days 夹紧与整数化），全套 **790 通过**

## [0.7.4] - 2026-09-01

### 🐛 修复（issue #40）

- **记忆内容含 `{{...}}` 模板语法时整轮崩溃**：DSH 核心 `interpolate()` 会把 `{{name}}` 当 prompt 变量严格校验（变量名须匹配 `/^[a-z][a-z0-9_]*$/`），记忆/画像/规则里合法的模板语法（灰机 wiki 的 `{{hl|}}`、`{{黑幕}}`、学习占位符 `{{挖空}}`、`{{关键词}}`）因非法变量名直接 throw，整轮对话失败。修复：注入边界 **run-based 花括号转义**（连续 2+ 个花括号之间插 `\`：`{{a}}`→`{\{a\}\}`），**奇数连续括号（如 `{{{a}}}`）也不残留字面 `{{`**，`interpolate()` 不再扫描到；覆盖 memory 块 / 短期上下文 / 用户设置三处注入出口。新增配置 `escapePromptVariables`（默认开，关闭时原样透传）

### 🐛 修复（issue #41）

- **记忆窗口关闭按钮重叠无法关闭**：`MemoryOverlay` 全屏覆盖层顶栏右侧的关闭按钮与宿主窗口标题栏控制按钮（最小化/最大化/关闭）落在同一区域，宿主控制按钮浮在 web 内容最上层抢走点击热区。修复：顶栏改左对齐（标题 + 关闭按钮并排），关闭按钮离开右上角宿主控制按钮区，任何窗口尺寸下都可见可点

### 测试

- 新增 6 个回归测试（inject 5 + config 1，含 `{{{a}}}` 奇数括号回归），全套 **782 通过**

## [0.7.3] - 2026-08-29

### 🆕 新功能（issue #38）

- **左下角入口按钮可关闭**：新增配置 `showSidebarTrigger`（默认 `true`，关闭时行为与之前完全一致）。dsh-mneme 的记忆入口按钮注入在侧边栏底部 footer slot（左下角），与同样抢占该位置的插件（如 dsh-cost-meter）冲突时 UI 会叠加/错乱。现在可在 **Web 面板「设置」→「侧边栏入口按钮」**一键关闭；关闭仅隐藏按钮，记忆库仍可通过顶部「记忆库」标签访问，功能不受影响
- 设置走 settings-over-config（与 `autoTagEnabled` 同机制）：面板开关持久化到 `user_settings`，未触碰时回退插件配置默认值；`/api/dsh-mneme/config` 的 GET/PUT 同步支持该字段（PUT 只接受布尔，非法值 400）

### 测试

- 新增 7 个回归测试（api 3 + settings 2 + config 1 + client 1），全套 **776 通过**

## [0.7.2] - 2026-08-26

### 🐛 修复（issue #35）

- **目录页删除按钮点击无反应**：`lib/client.js` 的 `DirectoryPanel.handleDelete` 之前依赖宿主 `window.confirm`（在 DSH 宿主 web 环境不可靠，可能被拦截或直接返回 false，点击看起来无反应），且删除失败的所有路径都被静默吞掉。改为**面板内联两步确认**（点 ✕ → 按钮变「确认？」→ 再点才发 DELETE，3 秒自动重置，点击行内其它地方取消），不再依赖任何原生对话框；删除失败（网络 / 401 / 500 / `deleted!==true`）时行内红色错误提示「删除失败」，3.5 秒自动消失，不再静默

### 🆕 新功能（issue #34）

- **对话开始自动注入当前时间**：新增 opt-in 配置 `injectTimePrefix`（默认 `false`，关闭时行为与之前完全一致）。开启后，新对话开始时在注入文本头部注入一次当前日期时间（格式 `[当前时间: 2026-08-26 周二 19:30]`，星期中文），按 session 闩锁——同一会话只注入一次，新会话再注入，满足"只需对话开始时"

### 测试

- 新增 6 个回归测试（client 2 + inject 3 + config 1），全套 **770 通过**

## [0.7.1] - 2026-08-24

### 🐛 修复（issue #31）

- **memory_save / memory_update 的 tags 桥接进 entity_attrs 标签存储**：工具传入的 tags 之前只写 `memories.tags` 列，目录视图（`getDirectory`）/ `tag:` 检索 / tagBoost 从 `entity_attrs`（attr_key='tags' AND valid_until IS NULL）读取，导致看不到；现在 `saveWithDedupe` 创建/合并分支与 `service.update` 在写入后同步调 `store.setMemoryTags(id, tags)`，显式 `tags: []` 会把记忆移回 untagged
- **`store.setMemoryTags` 反向同步 `memories.tags` 列**：手动/autoTag 打标后，搜索结果与 API 返回的 `memory.tags` 不再和目录漂移
- **autoTag 面板开关成为运行时真正的消费方**：dream 的 autoTag 判定与 `service.setMemoryTags` 的 manual 门禁改为读取「settings 覆盖合并 plugin config」的有效值；`getAutoTagConfig()` 未存储键返回 `null` 而非 `false`，`setAutoTagConfig` 只持久化用户实际触碰的键（部分更新不再误关另一开关）；`manualTagEnabled` 默认统一为插件配置的 `true`
- 新增 7 个回归测试，全套 764 通过

## [0.7.0] - 2026-08-24

### 🆕 自进化记忆（heat 热度模型）

让记忆库从"存得准、召得回"进化为会自我衰减、识别兴趣漂移的智能体：

- **幂律衰减 + per-type 差异化半衰期**：`H = 1/(1+λ·Δt)^α`，预置 TYPE_DECAY（preference/pattern/summary 免疫 λ=0；project 慢衰减 0.0008；decision 中速 0.002；history 较快 0.006）；全局 `heatGlobalAlpha`(默认 1.2) 控制形状
- **sleep 热联合双保护**：降级需同时满足"冷"(heat < sleepHeatThreshold 0.05) +"非紧要"(importance < 5) +"非免疫类型"——冷但重要与热但低值均受保护，immune 类型永不因 sleep 降级
- **updated_at ≠ 访问语义修正**：合并/更新刷 updated_at 不再计为访问；sleep demotion ref 只用 `last_accessed_at ?? created_at`；touchRecalled 由 `heatEnabled` 门控而非 `sleepModeEnabled`
- **recall_runs injected 两档标记**：搜索帧 `injected:false`(被召回)，注入帧 `injected:true`(被注入上下文)；两路都受 `recallRecordDefault` 门控；mode="inject" 也记账
- **90 天滚动清理**：`purgeRecallRunsOlderThan(days)` 启动时按 `recallRetentionDays`(默认 90) 清理，防膨胀
- **实体热投影**：ego-BFS API 节点带 `heat` 字段（关联记忆 heat max）；前端 `nodeRadius`/`fillOpacity` 随热度变化，兴趣漂移在图谱上可见
- **配置新增**：`heatEnabled`(true)、`heatGlobalAlpha`(1.2)、`heatTypeDecay`(TYPE_DECAY)、`sleepHeatThreshold`(0.05)、`recallRecordDefault`(true)、`recallRetentionDays`(90)

### 修复

- **sleep 降级误保护问题修复**：既有 `sleep.test.js` 降级测试因新热闸变为 noop → 加 `demotionConfig()` 帮助函数把 project λ 调快到 0.02，复现旧路径（默认保守语义由 `sleep-heat.test.js` 单独覆盖）；`updated-at-semantics.test.js` 同理调整
- **注入帧 source 冲突**：注入帧 source 固定 `"inject"`，不与记忆行自带的来源列混淆

### 测试

735 → **757** 全绿（新增 `heat.js` 纯模块 6 测 + `sleep-heat.test.js` 5 测 + `recall-runs.test.js` 5 测 + `updated-at-semantics.test.js` 3 测 + `graph-api.test.js` ego-node heat 2 测 + `recall-layer.test.js` 2 测更新 + `sleep.test.js` + `sleep-heat.test.js` 适配 5 处 + `recal l-layer.test.js` 适配 2 处）。

## [0.6.11] - 2026-08-23

### 修复
- **memory 渲染器暴露记忆 ID 并抗注入（PR #27，社区贡献 Jstn-1g）**：工具结果会进入 Agent 上下文，现做有界渲染——限制条数（search 20 / list 50）、整体块预算上限，标题/标签/正文按 Unicode code point 边界截断（emoji 保持完整、不劈半 surrogate），转义换行、引号、反斜杠与 ` `/` ` 等防 JSONL 框架注入；`id` 作为后续操作句柄绝不截断，超限整条省略并在 summary 里报告而非输出无效句柄。关联 issue #14（Agent 无法自主删除记忆）。
### 测试
- 723 → **735** 全绿（新增 memory 渲染器 12 条边界用例）。

## [0.6.10] - 2026-08-23

### 质量优化（记忆面板卡片布局 polish）
- **清理死 CSS**：移除卡片式布局重构后遗留的 `.mneme-xside` / `.mneme-xside--filter` / `.mneme-xbrowse` / `.mneme-xtree` / `.mneme-xdetail` 5 行无引用的定义（三卡实际用 `mneme-card--search/tree/detail`）。
- **合并 `.mneme-xmain` 双定义**：旧 `row` 版并入唯一 `column` 版，消除同 selector 重复声明。
- **补无障碍（a11y）**：分类栏 `mneme-xtype` 按钮加 `aria-pressed`；三张卡片加 `role="region"` + `aria-label`；搜索框加 `aria-label`。
- **测试**：723 全绿（纯 CSS / aria 改动，用例数不变）。

## [0.6.9] - 2026-08-23

### 修复
- **autoDream 恒失败（Issue #26，P0：跳过非法决策）**：模型几乎必然为语义相关性产出跨类型 merge（`decision[4]: merge ids span multiple types (decision, preference)`），而 `validateDecisions` 硬性禁止跨类型合并（提示词亦注明「仅合并同类型」），此前「任意非法即整单拒绝」导致整批 consolidation 完全不应用（`applied=0`、空转一次 LLM 调用），并连带阻塞依赖 dream 成功的 `autoTag`。现改为：`dreamSkipInvalid`（默认 `true`）下逐条非法的决策被**跳过**、应用合法子集（`applied>0`），run 状态记为 **`degraded`**（不再是 `failed`），审计行 `outcome.skipped` 记录被跳过的决策、`error` 注明跳过数；`autoTag` 照常触发。防洗白语义不变：显式覆盖率不足（截断输出）、update/create 超量等**全局**错误仍整单拒绝。`dreamSkipInvalid:false` 可恢复旧的整单拒绝行为。

### 新增
- **`allowCrossTypeMerge`（Issue #26，P1：显式放开跨类型合并）**：默认 `false` 保持现有类型边界（`preference` 注入权重更高、`decision`/`project` 注入上下文不同，合并会丢类型信息）；显式开启后跨类型 merge 被视为合法、可被应用，类型边界由用户自行承担。

### 测试
- 716 → **723** 全绿（新增 skipInvalid 单元/集成、allowCrossTypeMerge、退出开关共 7 用例；环境既有 2 例除外：graph-api 时序 <50ms、reranker 本地缺 `@huggingface/transformers`）。

## [0.6.8] - 2026-08-22

### 修复
- **dream/sleep LLM 路由优先级（Issue #25）**：`resolveRoute` / `resolveSleepRoute` 原先总是先取 `agentDefaultModel.currentSelection()` 并直接返回，导致 `dreamProvider`/`dreamModel`、`sleepProvider`/`sleepModel` 在标准 DSH 安装下恒为死代码（`dream_runs` 审计表的 `provider`/`model` 始终是 agent 默认模型，配置的模型从未生效）。现改为显式 config 路由优先、agent 默认降为回退：dream 顺序为 `dreamProvider/dreamModel` → agent 默认；sleep 顺序为 `sleepProvider/sleepModel` → `dreamProvider/dreamModel` → agent 默认。这同时打通了 #9 的「换用非思考模型」出路——此前即便配置了廉价/非思考模型也无法生效。

### 测试
- 用例总数不变（716）；更新 `dream.test.js` / `llm-audit.test.js` 的 `model_id` 断言为配置路由（`deepseek:deepseek-chat`）。

## [0.6.7] - 2026-08-22

### 新增（记忆面板前端增强）
- **记忆删除端点**：新增 `DELETE /api/dsh-mneme/memories`（按 `id` 或 `query` 删除，对齐 `memory_delete` 工具）；`GET`/`PUT /api/dsh-mneme/config` 提供 `autoTagEnabled`/`manualTagEnabled` 读写（partial 更新，默认关）。
- **记忆删除 UI**：目录视图支持选中删除记忆（二次确认 + 本地不可变移除）；新增「编辑模式」开关（读写 `manualTagEnabled`），编辑态删除按钮常显，移动端可删。
- **autoTag 手动开关**：settings 面板新增 autoTag（自动打标签）开关，独立加载 `GET /api/dsh-mneme/config`（不阻塞 profile/rules/commands/vector），saveAutoTag 写 `autoTagEnabled`。
- **记忆页卡片式布局**：中间分类栏（`.mneme-xfilter-bar`）+ 底部三卡片（search/tree/detail，`.mneme-xcards`），替换原横向三栏。

### 修复
- **卡片布局 CRITICAL 括号错位**（子 agent 复核 + 逐层核验）：tree 卡嵌套 months.map 后缺一个关闭 `)`，导致 detail 卡被错误吞进 tree 卡内部（括号总数平衡故语法检查/测试均过，仅渲染时三卡布局错位）。修复：补关 tree 卡 + 去掉补偿性多余括号，核验三卡已平级为 xcards 直接子节点。

### 测试
- 710 → **716** 全绿（新增删除端点 / config 读写 / 目录文件树 / 卡片布局用例）。

## [0.6.6] - 2026-08-20

### 修复
- **kimi-k3 复验 2 项**：autoTag 跳过已打标记忆（不再每轮重复打同一批最新记忆、老记忆饿死；写时与现有 tags 合并，不覆盖人工标签）；`tag:` 搜索的召回统计（touchRecalled）改由 `recordRecall` 门控，面板搜索不再污染遗忘曲线。

### 测试
- 709 → **710** 全绿（新增 autoTag 跳过已打标用例）。

## [0.6.5] - 2026-08-20

### 新增
- **Tag 标签系统**：`#标签` 格式解析（规则 `[a-zA-Z0-9_一-龥-]+`，≤20字符，非法/超长自动丢弃）；autoDream 整理后 LLM 自动打标 1-3 个（fail-safe 保护，`autoTagMaxPerRun=10` 限频）；`tags` 统一落盘至 `entity_attrs`（`attr_key='tags'` JSON）；新增 `tag:` 搜索前缀（支持与关键词、`entity:`、`attr:` 自由组合）；Mirror 视图顶部渲染 `#tag` 标识行；记忆面板集成交互式标签 Chip（点击过滤/添加/移除）；全功能默认 opt-in，同步开放 3 组独立配置。
- **目录视图**：面板新增「目录」视图，按 tag 分组生成一级手风琴文件夹，无标签记忆归入「无标签」兜底组；组内按重要性/时间双降序排列；点击条目直跳详情页；新增 `GET /api/dsh-mneme/directory` 端点输出结构化树。
- **Tag 加权召回**：检索二次重排增强。候选记忆 tags 与 Query 提取 tags（含 `#xxx` 及已知列表）交集 → 基础分 `×1.15`；与 Session 热记忆 tags 交集 → `×1.08`；opt-in 设计（`tagBoostEnabled=false` 默认），支持开关对比调优。

### 修复
- **边界与稳定性**：自动清理空 tag 残留；严格拦截超长 tag；循环 wiki-link 无遍历死循环（读侧纯查询，不递归）。
- **数据同步**：多标签记忆在目录分组、搜索面板与底层 JSON 间的状态一致性校验。

### 测试
- 628 → **709** 全绿（新增 tag-boost 11 + 边界鲁棒性 6 + 版本内集成覆盖）。

> 📌 注：v0.6.2 / v0.6.3 / v0.6.4 为开发代号，功能随本版一并发布。

## [0.6.1] - 2026-08-20

### 新增

- **Wiki-Link 双向链接（笔记化记忆库第一步）**：记忆正文支持 `[[target]]` / `[[显示|target]]` 双括号链接语法，新解析器 `src/parser/wikilink.js` 统一在保存时抽取目标，写入 `entity_relations` 的 `links_to` 关系（新增 `partial` 唯一索引 `(source_memory_id, relation)` 仅对 `links_to` 去重，其余关系保持 append-only 不丢 supersedes 审计）。
- **service 三 API + 保存后异步解析**：`service.getBacklinks(memoryId)` / `service.getForwardLinks(memoryId)` / `service.resolveWikiLink(name)`；记忆保存后经 `enqueue` 串行 fire-and-forget 异步解析链接，不阻塞主保存流程。
- **3 只读 HTTP 端点**：backlinks / forward-links / wikilink-resolve，输出脱敏（不泄漏 source 原文），配套前端 BackLinksPanel React 组件 + 正文 wikilink 渲染。
- **`wikiLinkEnabled` 配置**：默认 `false`（opt-in），开启后才解析/渲染链接，保持旧行为。

### 修复

- **code review 2 项**：全表 UNIQUE 索引改为 `partial` 唯一索引（仅 `links_to`），防老库启动崩溃（存量其他关系撞唯一约束）；`saveRelation` 还原 append-only 语义，不再吞 supersedes 审计。

### 测试

- 628 → **654** 全绿（新增 `test/wiki-link.test.js`：parser 语法/别名/转义 + store partial 索引去重 + service 三 API + 异步解析串行 + 端点脱敏）。

## [0.6.0] - 2026-08-20

### 新增

- **会话生命周期（把会话当存档点）**：新配置 `sessionLifecycleEnabled`（默认 `false`）。开启后，会话被删除/销毁（`session/disposed` 宿主事件）时自动把该会话内出生（`session_id` 溯源）的记忆**软隐藏**——`session_disposed_at` 标记，隐藏于检索/注入/列表/整理，但不删除，随时可恢复。独立 `session_disposed_at` 字段与 `archived`（用户/AI 主动归档）**正交**：restore 只清 disposed 标记，绝不复活用户手动归档的记忆。存量无 `session_id` 的记忆视为全局，永不参与会话清理。默认关闭保持旧行为，销毁会话不影响记忆。
- **store/service 新增接口**：`store.setDisposedBySession(sessionId, disposed)`（幂等，状态守卫 WHERE 只动 IS NULL / IS NOT NULL 行，返回实际翻转行数）、`service.disposeBySession(sessionId)`、`service.restoreBySession(sessionId)`、`service.listBySession(sessionId, { includeDisposed })`（默认隐藏 disposed）。
- **memory_delete 支持描述删除**：`memory_delete` 增加 `query` 参数，可按描述匹配删除，不只靠记忆 ID（PR #16）。
- **事件订阅熔断**：`session/disposed` 事件回调内部异常 catch 住，不抛进 DSH 会话清理流程——用户删个对话不会搞崩插件。

### 修复

- **code-review 4 项（阿里云 kimi-k2.7-code 审查）**：`store.listBySession` 默认过滤 `session_disposed_at` + `service.listBySession` 透传 `includeDisposed`（已隐藏记忆不再从该路径重新暴露）；`toApiList` 条件输出 `disposed` 标记（restore 不再盲操作）；补 `(session_id, session_disposed_at)` 复合索引（置于 addColumn 迁移后，兼容 legacy 库）。

### 测试

- 613 → **628** 全绿（新增会话生命周期 13 例：store 4 例——迁移重启存活/dispose 幂等 round-trip/search+list 排除/searchVector 排除/setDisposedBySession 状态守卫，service 7 例——dispose 只影响该会话/restore 清标记/幂等/未知会话空操作/legacy 全局记忆/restore 不复活手动归档/正交性/listBySession 默认隐藏 + includeDisposed 可见 + DTO 携带 `disposed` 标记；另含 memory_delete `query` 删除 2 例）。

## [0.5.3] - 2026-08-20

### 新增

- **`dreamReasoningEffort` / `sleepReasoningEffort` 支持 `off`**：显式关闭思考。deepseek-v4-flash 等思考型模型即使 `none`（不传字段）也会按默认 thinking 把整个 token 预算烧在推理上，返回空正文（`no json array in llm output`；deepseek harness 实测 `finish_reason:"length"`、content 长度 0、8192 completion = 8192 reasoning）。设 `off` 后 12s / 2075 token 即完成，且 `dreamMaxTokens: 8192` 默认值保持够用。sleep 侧同步支持。

### 修复

- **决策字段名归一化兜底（deepseek harness 实测）**：`extractJsonArray` 后新增 `normalizeDecisions`，把 thinking 模型输出的别名键 / wrapper 对象重写到规范字段——`target_ids` / `targetIds` / `memory_ids` → `ids`、`keep_source` → `keepSource`、`winner_id` → `winner`、`loser_id` → `loser`、`new_title` / `merged_title` → `title`、`consolidation` 作 action 键或 action 值 → `merge` 等；顶层 `{consolidation:[...]}` 等 wrapper 对象自动解包；`ids` 单值字符串包成数组；create 决策的 `type` 字段绝不被误当 action。字段名不听话但语义正确的输出不再整单被拒（实测方案 A 输出 `consolidation`/`target_ids`、方案 B 输出 `targetIds` 均非规范名）。

### 测试

- 603 → **613** 全绿（新增 `test/normalize-decisions.test.js` 归一化 9 例、reasoning-effort `off` 用例）。

## [0.5.2] - 2026-08-20

### 新增

- **记忆溯源 `session_id`**：每条记忆记录出生会话 id——`memory_save` 工具从 `exec.agent.session.id` 取（无会话上下文置 null 不伪造），`autoSummarize` 从 turn/end 钩子的 `session.id` 取；merge 保留原记忆的出生会话（溯源只记出生点，`store.update` 不触碰该字段）。旧库打开自动补列（`addColumn` 幂等迁移，存量数据 session_id 为 null，无迁移成本）。为 v0.6.0 推理路径可视化与兴趣漂移分析攒原材料。

### 测试

- 597 → **603**（新增 `test/provenance.test.js` 6 例：写入/缺省置空/merge 保留原会话/工具路径带与不带 agent/旧库迁移）

## [0.5.1] - 2026-08-20

### 修复

- **热记忆负参数防御**（复验发现）：`createHotMemory` 的 `maxRounds`/`maxTokens` 非正整数/非有限值时 fallback 到默认 5/2000，堵死负数 `maxRounds` 触发的同步死循环（此前插件配置钳制 ≥1 不可达，但导出的公开 API 不设防）
- **#13 修复补全（reranker 侧）**：`reranker.js` 的 `defaultPipelineLoader` 镜像 `env.cacheDir = options.cache_dir`（与 `local-embedder.js` 同款），`rerankProvider=local` + `embedProvider=openai`（默认）场景下断网也能本地加载 tokenizer
- **融合分数钳制 [0,1]**：hybrid 三路召回融合后分数 `clamp` 到 0..1（sort 后 map，不改变排序相对顺序），修复向量+BM25 叠加可突破 1.0 的归一化契约破坏

### 文档

- 根/子 README 配置表补 `hotMemoryEnabled`、`searchSemanticDedupThreshold` 两键（此前 v0.5.0 漏写）
- 测试 593 → **597**（新增负参数边界 / 融合 clamp / cache_dir 镜像用例）

## [0.5.0] - 2026-08-19

### 新增

- **主区「记忆库」视图（conversation.view 插槽），取代侧边栏抽屉**：记忆功能全部收进主内容区全宽 tab，与「对话 / Trajectory」并列。侧边栏底部「记忆」入口点击后直接激活该 tab，不再弹出抽屉（tab 激活通过会话头部的 tab 按钮触发——框架的 setView 是 conversation 包私有 API，DOM tab click 是插件可用的稳定路径）。
  - **三个子视图**：「记忆」（三栏浏览）/「图谱」（实体网络）/「设置」（画像、规则、指令、向量配置，限宽居中），由页面顶部的子 tab 行切换——active 态为宿主同款「文字变主题蓝 + 底部下划线」。
  - **三栏布局**：左栏分类树（类型 + 计数，客户端过滤）；中栏时间树（按月 → 日两级分组、倒序，月份可折叠，条目带时间点）；右栏详情（标题、类型 · 重要性、来源、创建/更新时间、标签、**全文不截断**展示、「复制全文」）。月份/日期格式走宿主 locale。
  - **语义搜索内嵌**：向量服务启用时工具栏出现「语义」开关，开启后搜索走服务端向量召回（防抖 250ms），关闭则客户端标题/内容过滤；`entity:` 前缀语法保留，出现「在图谱中查看」跳转。
  - **图谱 ↔ 记忆互跳**：图谱详情侧的关联记忆条目可点击、记忆边的「来源记忆」按钮按 memory_id 直跳，落回三栏视图时自动重置过滤并定位选中目标。
  - **设计系统对齐**：页面画布平铺宿主 `bg-layer-1`，栏间用细边框分隔（无大圆角外框、无胶囊 chip），active/交互态走 `--dsw-alias-*` token，观感与宿主原生视图一致。
  - **数据零新增**：复用 `GET /api/dsh-mneme/list?limit=500`，一次拉取全量在客户端分组过滤。
- **记忆图谱可视化（P1）**：图谱子视图输入实体名，加载以该实体为中心的关联网络。
  - **服务端 ego-graph API**：`GET /api/dsh-mneme/semantic/graph/ego?entity=<name>&depth=1|2`，从根实体 BFS 层级遍历实体关系网络，返回节点（含 `distance` 跳数）、边及根实体信息；`limit` 防大图失控，实体不存在返回 404。配套 `GET /semantic/graph/entity-attrs` 查实体属性。两个端点均为只读，不触碰写入路径。
  - **前端零依赖 SVG 力导向图**：因 DSH 插件运行时无法 require 第三方库（vis-network 等不可用），图布局为纯手写物理模拟——节点两两斥力 + 边弹簧拉力 + 向心引力，速度衰减 0.85，300 帧或能量 < 0.4 后自动停帧。节点按类型着色、按提及次数定半径，支持节点拖拽（拖拽与点击以位移阈值区分）、点节点看属性与相关记忆、点边看关系详情并可跳回来源记忆。深度 1/2 一键切换。
- **图谱入口图标为自绘节点连线 SVG**：primitives 图标库无网络/图谱类图标，其分享样式图标易被误解为分享功能，故自绘 16px 三节点连线图标（GraphNodesIcon，currentColor 跟随主题）。
- **召回率优化（三路召回融合）**：
  - **BM25 稀疏向量第三路召回（`src/search/bm25.js`）**：与向量召回、FTS5/LIKE 关键词并列的第三路——ASCII 词元 + CJK bigram 分词、IDF 加权打分（归一化 [0,1]），专有名词、ID、代码片段等散词查询不再依赖子串命中。融合规则：未召回的行按 `0.3×BM25分` 回填；仅向量召回的行获得词法加分；LIKE 关键词已命中的行不叠分（子串命中必然包含查询词元，叠分等于重复计算词法证据）。`bm25SearchEnabled` 可整体关闭。
  - **自适应阈值（`src/search/adaptive.js`）**：取代固定 `0.65` 截断——`entity:`/`attr:` 前缀放宽至 0.5，短查询（<5 字符）收紧至 0.7，长查询（>50）放宽至 0.6，候选头部 Top1/Top5 分差 > 0.3 时放宽至 0.5 让尾部进入 Rerank。抓取阶段以最宽松分支下限执行、终cut按实际分布计算；显式传入 `threshold` 或 `adaptiveThresholdEnabled=false` 时完全走旧行为。
  - **会话级短期热记忆（`src/hot-memory.js`）**：与长期记忆库分离的会话内热上下文——最近 N 轮对话（默认 5，`hotMemoryRounds`）按 token 预算（默认 2000，`hotMemoryMaxTokens`）滚动截断，每次渲染从会话事件日志无状态重建，不落库。`hotMemoryEnabled` 为总开关（默认开，关闭后热记忆块不再注入）。注入顺序为「短期上下文 → 长期记忆召回 → 摘要」，热记忆块置于 memory 上下文块头部（不新增独立 context，系统提示装配保持两块稳定）。
- **部署优化（注入侧）**：
  - **上下文压缩注入**：sleep 降权记忆带 `_full_content` 时注入其摘要原文，不再对已压缩内容二次截断；普通长内容维持 300 字硬截断。
  - **选择性注入（主题匹配）**：query 向量可用时（异步预取缓存），注入候选按与当前查询的主题相似度重排，替代固定规则序；`selectiveInjectEnabled` 可关。
  - **搜索时语义去重（激进选项）**：`searchSemanticDedup=true` 显式开启后，合并候选按 embedding 余弦相似度贪心去重（阈值由 `searchSemanticDedupThreshold` 控制，默认 0.95），近重复行在 Rerank 前被丢弃，不等待 autoDream 合并。默认关闭——小模型可能误折叠语义相近但内容不同的记忆；keyword 纯文本模式永不参与。
- **评测体系（`scripts/benchmark-recall.js`）**：标准查询集驱动的召回基准——每用例给出期望命中 id，计算 Recall@5 与 MRR，`legacy`（三特性全关）与 `fused`（默认配置）双跑对比，可重复验证三路融合的召回增益。

### 修复

- **Issue #13：本地嵌入模型离线加载仍发远程请求**：`local-embedder` 的 `defaultPipelineLoader` 此前未设置 `env.cacheDir`，导致 transformers.js 在 tokenizer 元数据预检阶段绕过本地缓存直接请求 HF 远端。现在当 `cache_dir` 配置存在时同步写入 `env.cacheDir`，模型与 tokenizer 元数据全部走本地缓存，断网环境可完整加载。

### 测试

- 593 全绿：新增 `test/graph-api.test.js` 7 例（路由注册 / BFS 深度边界 / 孤岛节点 / 实体不存在 404 / limit 截断 / 100+ 节点 2 跳 < 50ms 性能）；client 侧重构断言（conversation.view 注册与稳定 entry id / 图标语义约束 / 无抽屉回归 / 子视图与图谱互跳链路 / entity: 语法 / 三栏结构 / 宿主设计 token 对齐）；召回优化新增 `test/search-fusion.test.js`（分词 / BM25 索引与 IDF / 自适应阈值分支）、`test/hot-memory.test.js`（热记忆轮次与 token 预算 / 三路融合散词召回 / 语义去重开与关 / 选择性注入重排）、`test/benchmark.test.js`（基准双配置运行 / fused 不劣于 legacy / 用例集覆盖散词场景）。

## [0.4.7] - 2026-08-19

### 修复

- **schema 迁移幂等化，修复并发 createStore 竞态**：并发打开同一 db 时 `PRAGMA table_info` 检查与 ALTER 非原子，可能重复 `ADD COLUMN` 报 `duplicate column name`（v0.4.6 CI peer 并发测试暴露）。改用 `addColumn` helper——检查 + try/catch 吞掉 duplicate 竞态，12 处迁移统一收口。

## [0.4.6] - 2026-08-19

### 修复

- **向量链路三连修（Bug1/2/3）**：
  - **embedSingle 适配（Bug1）**：向量链路统一走 `embedSingle`，消除 embed / embedSingle 不一致导致的静默跳过。
  - **存量自动回填（Bug2）**：新增 `autoReindexOnBoot`（默认 `true`）——向量 API 已配置且存量记忆缺 embedding 时，启动后延迟后台按批次限速自动重建索引；设为 `false` 可保持仅手动重建。
  - **vector_meta 元数据（Bug3）**：向量索引写入时记录模型/维度等元数据，`getStats` 可报告已嵌入/总数与模型信息。
- **注入语义召回优先（Bug4，`hybridInject` 默认 `true`）**：`injectCandidates` 带非空 query 时先走向量索引语义召回候选，再回退规则筛选补足/去重；query 向量异步预取 + 有界缓存（cap 8），系统提示渲染保持同步。空 query / 无向量时行为与旧版一致。
- **同标题追加（Bug5）**：同一标题再次写入不再覆盖，追加到 `content_history`，保留演进轨迹。
- **注入长度上限（Bug6）**：注入记忆块设双层预算——单条 content 截断 300 字（尾部 `…`），整块上限 1500 字；超预算条目塌缩为仅标题，注入上下文不会被长记忆撑爆。
- **记忆质量过滤（Bug7，`memoryQualityFilter` 默认开）**：写库前按启发式打分 0-100——元记忆词汇 / 自指类型标签 / 内容过短 / 重复度高 / 与近期记忆近似重复扣分。≥60 正常存储；30-60 降权（注入排序按 `importance × quality/100`）；<30 归档并标记 `low_quality`（显式搜索仍可召回，只是永不自动注入）。纯函数实现，无 I/O 可独立单测。
- **LLM 消耗审计（Bug8，`llmAudit` 默认开）**：每次后台 LLM 调用（autoDream 整理 + 摘要、autoSummarize 压缩）写入 `llm_audit_logs` 表——tokens / duration / status / source；失败记 `status=error` 不阻塞功能；`retentionDays`（默认 90）启动时清理超期行。新增只读 API：`/api/dsh-mneme/semantic/llm-audit`（分页 + source 过滤）与 `/llm-audit/stats`（近 N 天按 source 汇总预算）。

### 测试

- 553 全绿（新增 `test/quality-filter.test.js`：打分信号 / 阈值分档 / 降权排序；`test/llm-audit.test.js`：埋点 / 统计 / 保留期清理 / API）。

## [0.4.5] - 2026-08-19

### 新增

- **epistemic trust 记忆可信度（`trustEpistemicWeighting`，默认关闭）**：记忆按来源可信度分级——`observation`（观察/实测，可信最高）> `inferred`（推断）> `subjective`（主观/猜测）。开启后影响四类行为：检索排序优先高可信记忆、注入时对 observation 记忆标注 `[verified]`、dream 合并（merge keepSource）与冲突消解（conflict winner）自动偏向高可信一方。关闭时 `epistemic_status` 仍会随保存推断并落库，但不参与任何行为决策，完全向后兼容。
- **recall eval 检索评估（`evalPersistTestResults`，默认关闭）**：`evaluateRetrieval` 支持将检索评估快照（precision / recall / mrr 等）持久化到独立的 `recall_evals` 表。默认关闭时评估结果仅返回给调用方、不落库；开启后评估快照写入 `recall_evals`。生产路径 `searchMemories` 的审计始终走 `recall_runs`，**无条件不触碰** `recall_evals`，评估与线上数据严格隔离。

### 测试

- 518 全绿（新增 `test/epistemic.test.js`：可信度优先级/合并/冲突/inject 标记；`test/recall-evals.test.js`：评估落库 opt-in 与生产隔离）。

## [0.4.4] - 2026-08-18

### 修复

- **autoDream 决策覆盖全量拒绝（issue #9 方案C）**：大记忆量下 `validateDecisions` 要求 snapshot 每条记忆都被决策 claim，LLM 漏报即整单拒绝（636 记忆 → 677 errors、applied=0）。本次三件套修复：
  - **滑动窗口**：新增 `dreamMaxSnapshotSize`（默认 `200`），autoDream 每次只对最近 N 条记忆做 consolidation（按 `updated_at` 倒序截断），窗口外旧记忆不进 snapshot，从源头控制 LLM 输入规模。
  - **隐式 keep**：新增 `dreamImplicitKeep`（默认 `true`），LLM 未提及的 snapshot 记忆自动补 `{action:"keep"}`，不再"未覆盖即全拒"；设为 `false` 可恢复严格全量校验。
  - **覆盖率下限**：新增 `dreamMinExplicitCoverage`（默认 `0.5`），显式决策覆盖比例低于阈值时整单拒绝，防止被截断的残缺输出被静默应用。
- **固定决策 JSON schema**：`CONSOLIDATION_PROMPT` 显式写死 `action`/`ids`/`winner`/`loser` 字段（winner/loser 为单字符串 id），并禁止同一 id 跨决策重复 claim——提升 kimi 等模型输出合规率（本地真实 LLM 复验：qwen3-coder-plus / kimi-k2.7-code 成功轮均 applied=142、input_count=200、零 677 errors）。
- **代码审查加固**（kimi-k3 审查 + 本地真实 LLM 复验）：`dreamImplicitKeep` 透传到 `validateDecisions`（false 严格模式真正生效）；失败路径不再向入参追加 keep；`CONSOLIDATION_PROMPT` 消除"每条必须出现"与"未提及自动保留"的自相矛盾。

### 测试

- 487 全绿（新增：650 记忆滑动窗口/隐式 keep 回归、低覆盖拒单、覆盖率达标补 keep、runDream 级 `dreamImplicitKeep:false` 严格模式端到端、滑动窗口成员正确性、prompt 决策 schema 约束）。

## [0.4.3] - 2026-08-18

### 修复

- **autoDream 思考型模型正文为空（issue #9）**：大记忆量 + 思考型模型时，streamText 只收 `text-delta`，模型把 token 预算全花在 reasoning 上导致正文为空（`no json array in llm output`）。本次双管齐下：
  - **方案 B（放宽上限）**：`dreamMaxTokens` 上限由 `32768` 放宽至 `131072`，大记忆量决策清单/摘要不再被截断。默认仍为 `4096`，行为不变。
  - **方案 A（推理强度透传）**：新增 `dreamReasoningEffort`（`low` / `medium` / `high` / `none`，默认 `none`），透传到 dream 两次 LLM 调用；sleep 侧新增 `sleepReasoningEffort`，同样透传到冲突消解 / 模式发现两处调用。`none` 时不传该字段，完全沿用模型默认，向后兼容。

## [0.4.2] - 2026-08-18

### 新增

- **autoSummarize 支持自定义模型**：新增 `summarizeProvider` / `summarizeModel` 配置项，可指定独立模型用于会话摘要提取。空字符串时保持原有行为（使用当前会话模型）。推荐使用轻量模型（如 qwen3.6-plus）以节省主模型 token 消耗。（#8, @lqs50）

## [0.3.9] - 2026-08-17

### 核心修复（社区审计反馈）

- **A. 事务原子性收敛**：`compareAndUpdate` 的 CAS 更新与 `generation` 递增现由 `runAtomically` 封装至单一数据库事务。CAS miss 不再递增 generation，彻底消除崩溃后 `DB=CAS-New / mirror=Old / dirty=false` 且无债务的状态分裂窗口。
- **B. 降级状态透传**：mirror 状态写入失败时 `service.update` / `compareAndUpdate` 不再返回静默成功。失败时附加 `_mirror` 属性 `{status: 'degraded', error}`，上层可感知底层存储降级。
- **D. 逐 type 物理终态结算**：修复 project 文件已提交、decision 失败时两 type 被批量标 failed 的缺陷。`mirror.sync` 现逐 type 返回结果，`syncMirror` 依据实际落盘状态将各 type 独立持久化为 committed / failed。
- **F. Generation 强整数校验与脏值拦截**：`setMirrorState` 用 `Number.isInteger` fail-closed；SQL 层新增 `CHECK generation = CAST(generation AS INTEGER)`；迁移逻辑扫描历史遗留的 `-7 / 1.5` 等非整数脏值并抛错阻断，杜绝静默沿用。

### 基础设施与契约对齐

- **并发初始化优化**：`PRAGMA busy_timeout` 严格先于 `PRAGMA journal_mode=WAL` 执行，消除 8 进程并发初始化的 `database is locked`。
- **E2E 契约对齐**：断言对齐 7 个模型工具 / 9 条 exact 路由（prefix fallback 不计入）。
- **回归测试**：450/450 全绿（此前 446/447 有 1 个并发失败）。

## [0.3.8]

- audit peer 复验 6 项运行时阻断全部修复。
- desired generation 同事务原子递增（崩溃窗口不再静默跳过）。
- 逐 type committed / failed / pending 回执，健康端点区分 ok / degraded / unknown。
- generation 上界 / 负数 CHECK。
