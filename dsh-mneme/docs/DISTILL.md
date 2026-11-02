# dsh-mneme 蒸馏原文留存与记忆级溯源（issue #399）

- **日期**：2026-10-12
- **状态**：✅ 已实现（opt-in，默认关）
- **范围**：把蒸馏从「替换」降级为「叠加索引」——窗口原文旁路留存 + 记忆回指来源窗口
- **相关文档**：[存储与回收](STORAGE.md)（#275 第一批，同一条 reclaim 入口） · [配置参考](CONFIGURATION.md) · [压缩边缘抢救](CONTINUITY.md)

## 1. 问题

蒸馏（`src/summarize.js`）是一条**有损**管道：它把一段会话窗口喂给 LLM，拿回几条结构化
记忆，然后**消费掉游标**——窗口原文此后在库内没有任何痕迹。于是三件事同时成立：

1. 记忆里没写进去的细节，事后**无法回查**（不是「没保存」，是「没地方找」）；
2. 一条记忆**说不清自己出自哪段对话**，人工复核只能靠标题猜；
3. 蒸馏质量出问题时，**没有基线可比**（原文已经不在手上）。

信息论的依据很直白（arXiv 2609.36059 §3 Eq.1）：旁路索引不丢信息——
`I(Y;M,H,X) = I(Y;M,H)`，留存原文 `X` 不改变 `Y` 与已蒸馏产物 `(M,H)` 的互信息，
但**取回** `X` 的能力被保住了。所以这不是「再存一份」的冗余，而是把单向替换变成
可回指的叠加索引。

## 2. 形态：两张表，只增不改

```
distill_records(session_id TEXT, seq INTEGER, role TEXT, text TEXT,
                window_id TEXT, distilled_at TEXT, PRIMARY KEY(session_id, seq))
idx_distill_records_window(window_id)
idx_distill_records_distilled_at(distilled_at)

memory_provenance(memory_id TEXT, session_id TEXT, seq_start INTEGER, seq_end INTEGER,
                  created_at TEXT)
UNIQUE idx_memory_provenance_link(memory_id, session_id, seq_start, seq_end)
```

- `CREATE TABLE IF NOT EXISTS`：**无 ALTER、无回填**，存量库启动即建表，旧库零迁移成本。
- **不动 `memories`**：溯源是旁路，不往记忆表加列。删掉这两张表，插件行为逐字节回到 #399 之前。
- `memory_id` 用 **TEXT**（issue 草稿里写的是 INTEGER）：`memories.id` 在本仓一直是 TEXT
  （`src/store.js` 的 `save()` 铸 UUID 风格字符串），写成 INTEGER 只会让 SQLite 按
  TEXT 亲和存进去、却在类型声明上误导后来人。
- 主键 `(session_id, seq)` 决定了**一个事件一行**：`seq` 是会话事件序号，一次事件可能携带
  多条公开文本（`agent-message` / `inbox` / `spliced` 可以一次投递多条子会话消息），它们
  按事件合并成一行（`role` 取首条、`text` 以换行连接）。各写各的行会被
  `INSERT OR IGNORE` 静默丢掉后几条——那是**丢数据**，不是去重。
- 幂等靠 `INSERT OR IGNORE`（记录）+ 唯一索引 `ON CONFLICT DO NOTHING`（链接）：
  同一窗口重蒸一次不翻倍，且**保留首次落盘时间**（`distilled_at` 是「原文何时被留下」的
  事实，重跑改写它才是撒谎）。

## 3. 写入点：蒸馏时顺手落，不新建常驻管道

`summarize()` 触发时已经持有会话事件、已经算出窗口边界（`previousSeq` / `triggerSeq`），
原文留存就在那里顺带落盘——**不新开监听器、不常驻订阅会话事件**。好处是留存范围与
蒸馏范围**天然一致**：蒸过的窗口才留，没蒸过的窗口不留（见 §7 已知坑 2）。

落盘与记忆写入同事务（`service.transaction`）：两者要么一起进，要么一起退。游标消费也在
同一个事务里——「记忆写了但原文没落」这种半截状态不存在。

## 4. 隐私：渲染与落盘共用同一谓词

这是本次改动**最要紧**的约束。原文留存一旦与喂给 LLM 的转录各写一份过滤逻辑，两条路径
就会漂移，而漂移的方向必然是「**存下来的比 LLM 看过的更多**」——最糟的方向：模型没看到的
私有内容反而落进了持久库。

所以两边都从 `publicTranscriptParts(event)`（`src/summarize.js`）取数，同一个函数、同一份
判定。口径：

| 内容 | 进 LLM 转录 | 落 distill_records |
|---|---|---|
| 真实 `user/message`（`kind` 缺失 / `user` / `agent-message` / `subagent-settled`） | ✅ | ✅ |
| 助手公开 `text` 块 | ✅ | ✅ |
| 助手 `reasoning` 块（私有推理链） | ❌ | ❌ |
| 插件注入机器内容（`kind: "plugin:dsh-mneme"` / skill 正文 / AGENTS.md / 文件变更通知） | ❌ | ❌ |
| 工具调用入参、工具结果、code 输出 | ✅（截断） | ❌ |

最后一行是**刻意的路径差异**，不是漂移：`codingRetrospect` 靠工具输出沉淀踩坑根因，所以
渲染路径必须带它；但它体积大、含路径与命令、且不属于「对话内容」，落盘只留对话。
差异方向仍满足「落盘的 ⊆ 渲染的」。

## 5. 留存不受喂模型的裁剪约束

喂 LLM 的转录受三道裁剪：`distillMaxChars`（默认 24000，超长保**尾部**）、工具入参
`trim(args, 300)`、工具结果 `trim(out, 500)`。这三刀**不作用于落盘**——原文就是原文，
截断过的「原文」没有回查价值。

代价是库体积：一条超长提示会原样落库。所以留存默认**关**，并且有保留期（§6）。
`test/summarize.test.js` 有一条锁专门钉「两条路径的差异」：超长用户提示在记录里逐字全文，
在喂模型的转录里找不到头部标记。

## 6. 生命周期与开关

```yaml
distillRecords:
  enabled: false        # 默认关（opt-in）
  retentionDays: 90     # 保留期，1-3650
```

| 层级 | 键 | 默认 |
|---|---|---|
| 父 | `autoSummarize` | 开（既有总闸） |
| 子 | `distillRecords.enabled` | **关**（引入新的持久化面，独立成键） |
| 子 | `distillRecords.retentionDays` | `90` |

两个键都进 `settings.js` 白名单（面板可改）；`enabled` 进 `config.js` 的 `LIGHT_MODE_OFF`
（轻量模式关掉留存这个成本/隐私面），`retentionDays` **不进**——它是时长而非行为面，用户
显式设过就照旧。两个键都进 `api.js` 的 `NESTED_FLAG_PATHS`（漏了 effective 会静默缺键，
#254 踩过）。

**到期裁剪只删 `distill_records`**，`memory_provenance` 保留——链接从此指向空区间，面板
显示「来源已过期」，而不是查无此记忆。**裁剪原文绝不级联删记忆**：原文是索引，记忆是资产。
两处裁剪，**窗口各自独立**：启动期（`src/index.js`，只在 `enabled === true` 时动手——默认关时
一张空表不该被每次启动扫一遍）按 `retentionDays` 裁；`dsh-mneme reclaim`（默认 dry-run）
**不读这个键**，跟同一条 `--older-than`（默认 7 天）走——两个窗口互不联动，想一次对齐就把
`--older-than` 显式传成与 `retentionDays` 相同的值。

删记忆是另一条路：`store.remove(id)` 在事务内**显式**清掉它的溯源链接。这条显式清理**不是**
「外键没开才要手工补」——`createStore` 走 `new DatabaseSync(path)` 不带选项，而 node:sqlite 的
`enableForeignKeyConstraints` 默认为真（C1 实测：新库上 `PRAGMA foreign_keys` 返回 1，删父行
确实级联清掉本表），所以 `ON DELETE CASCADE` 今天一直是**活的**。显式 DELETE 留着是为了不把
清理押在一份没人钉过的驱动默认值上：连接哪天以 `enableForeignKeyConstraints: false` 打开，
悬空链接只有那条 DELETE 挡得住（口径见 `src/store.js:278-283` 与 `:1387-1391` 的注释，
`deleteBySharePackId` 同处置）。本库一共**两条**外键，都是活的——这一条与
`recall_evals(recall_run_id) → recall_runs(id)`；此前本节写的 `recall_events` 那张表并不存在。
声明式约束因此既是意图记录、也是今天实际生效的执行，两边不矛盾。

`reclaim` 报告因此从两项变三项：

```
planned: { dream_run_inputs, archived_embeddings, distill_records }
column_bytes: { ... }
cleared: { dream_run_inputs, archived_embeddings, distill_records }
```

`reclaim` 的入口语义（默认 dry-run、`--apply` 才动手、`--vacuum` 单独指定）**一字未动**。

## 7. 已知坑

1. **无历史回填**：本批只对**此后**发生的蒸馏生效。升级前已蒸过的窗口原文已经丢了，
   没有补回来的路（也不该假装能——从记忆反推原文是编造）。
2. **从未蒸馏过的窗口不留记录**：留存挂在蒸馏上，所以四类窗口天然无记录——① 窗口太小
   （`window-too-small` 门，游标已被消费）；② 插件当时是关的；③ 该窗口没触发过蒸馏
   （`autoSummarize` 关 / 限流挡住 / 会话结束得太早）；④ 蒸过了但那一轮 LLM 调用 abort。
   这些不是 bug，是「留存范围 = 蒸馏范围」的直接推论，但排查时容易误判成丢数据。
3. **不覆盖工具结果与 code 输出**（§4 末行）：想回查某次命令的真实输出，这两张表帮不上忙
   ——那是渲染路径的事，且落盘会带来体积与敏感信息两个问题。

## 8. 非目标（本批刻意不做）

不嵌入、不进 `fuseRecall`、不进注入、不做「哪份更权威」的取代判定、不做 value histories
查询接口、不动 `distillMaxChars` / `trim(args,300)` / `trim(out,500)` 三刀。这两张表是
**旁路索引**，不是第二条检索路——把它接进召回是另一个决定（成本与召回质量都要重新测），
不该跟着留存一起顺手打开。

## 9. 验收锚点

`test/summarize.test.js` 五条 + `test/maintenance.test.js` / `test/llm-audit.test.js` /
`test/settings.test.js` / `test/api.test.js` / `test/pre-inject-gate.test.js` 各一条：

- **幂等**：删掉持久化游标 + 换新 summarizer 实例重跑同一窗口 → 记录仍一行、链接无重复；
- **隐私**：reasoning / AGENTS.md / skill 正文 / 文件变更通知绝不落盘，工具输出不落盘而
  渲染路径仍带它；
- **未截断**：超长提示在记录里逐字全文，喂 LLM 的转录仍受 `distillMaxChars` 约束；
- **裁剪不毁资产**：到期裁剪后原文为 0、链接仍在、记忆数不变、`provenanceFor` 仍可查；
- **默认关零写入**：`enabled=false` 时连收集都不做（写入调用计数为 0），两表均 0 行，
  记忆写入照旧；
- **进 reclaim 报告**：dry-run 报出真实行数与列文本大小且一个字节不改，执行只删窗口外原文；
- **启动期裁剪**：读装配后的 cfg（面板改了保留期也认），且默认关时不动手；
- **白名单与往返**：两个键过 `settings` 校验（含范围外整数被拒），PUT 往返后 effective 读得回；
- **轻量模式**：预设关 `enabled`、保留用户显式设的 `retentionDays`、不污染用户对象。

## 10. 读出口：`/memory/provenance` 与 `distillRecords.enabled` 门（#421 写、#509 整改、#524 补方向 2）

两张表自 #399 起只有写入路径：库里有答案、`service.provenanceFor` 能查，外部拿不到——
「这条记忆是从哪几句蒸出来的」只能开 sqlite 手写 JOIN。#421 补上读出口，两个入口共用
一份实现：

- 宿主内面板路由 `GET /api/dsh-mneme/memory/provenance`（`policy: token`）；
- Bearer 数据面 `GET /memory/provenance`（daemon 与宿主外部访问同享）。

**两个读方向共用同一条路径**（#524）：`?id=<memoryId>` 是「这条记忆派生自哪些窗口」
（方向 1，`store.provenanceFor`），`?sessionId=<sid>` 是「这个会话蒸出了哪些窗口」
（方向 2，`store.distillWindowsFor`）。两个主键**互斥**：都缺 `400 missing-id`、都给
`400 ambiguous-id`。**刻意不做「都给则择一」**——择一意味着调用方可以发一个自己也不
知道会被读哪个主键的请求，而两个方向的答复形状不同（`memoryId` / `sessionId` 各认
领自己那一侧），那种静默选择只会在出事之后才被发现。

为什么不新开一条路径：多一条路径就多四处要登记的地方（`SECURITY.md` 两张表、包
README 路由表、`test/security-doc.test.js` 的清单锁），而两个方向读的是**同一批数
据**，只是入口不同。`SECURITY.md` 只登记路径、不登记 query 形状，所以方向 2 不需要
在那两张表里再加一行。

口径只写在 `src/provenance-http.js` 一处，两个壳都调它——#411 已经为 reclaim / share 各
踩过一次「两张皮整段复制必然漂移」，`test/provenance-http.test.js` 的静态锁把「错误码字面
量与开关判据只许出现在本模块、两个壳都真的把 `config` 转交进来、读侧判据与写侧
`src/summarize.js:988` 逐字同源」写成断言。

**形状**：窗口在 `{session_id, seq_start, seq_end, created_at, records[]}` 之外按方向分叉——方向 1（`?id=`）每行是一个溯源链接，另带 `distill_run_id / run_type / trigger_source / run_status`（后四个字段见 §11），答复级再带 `mints[]`；方向 2（`?sessionId=`）把同一窗口的多条链接合并成一行，另带 `link_count`。**run 归因只挂在方向 1 上**：方向 2 的一行是一个窗口、通常派生多条记忆，没有单一归因主体，要逐条查仍走方向 1。
`records` 是区间内的逐条会话原文（按 `seq` 升序、不越界）。没有链接的记忆返回**空
`windows`**——「不是蒸馏来的」是有效答案，不是错误；未知 id 同样回空 `windows`（读端点
不替调用方判断记忆是否存在）。到期裁剪后链接保留、指向空区间，面板据此显示「原文已过期」。

`link_count` 只有方向 2 会真的不等于 1（方向 1 的每一行本来就是「一条记忆 → 一个窗
口」，用 `?? 1` 兜住，免得答复凭空多一个 null 键）。方向 2 的存储读法是
`GROUP BY session_id, seq_start, seq_end`——`memory_provenance` 的粒度是「一条记忆 →
一个窗口」，一次蒸馏窗口通常产出**多条**记忆，逐链接返回会让「这个会话蒸了几次」这
个唯一有意义的计数被重复行淹没。`link_count` 是按窗口看的第二维；**刻意不回
`memory_id` 列表**——方向 1 已经是「记忆 → 窗口」，把 id 也塞进这一侧会让两个方向不
再正交（同一份映射有两条读法就得有两处维护），真要逐条查仍走方向 1。
`ORDER BY seq_start` 而不是 `created_at`：seq 是事件序号、就是会话内的先后，按它排才
是「这个会话按时间蒸了哪几段」，按 `created_at` 会把同一批重跑的行打散。

**开关门（#509 评审整改）**：读出口吃 `distillRecords.enabled`——与写侧**同一枚开关、同一
个判据表达式**（`config?.distillRecords?.enabled === true`，读侧唯一一份在
`isDistillRecordsEnabled`）。此前全树只有 `src/index.js:270`（启动期裁剪）与
`src/summarize.js:988`（写入）行为性读它，读出口一处都不读，于是「把 distill_records 关
掉」的实际语义是*不再写、也永久不再删*，却还多一个能把历史原文读出去的口。状态码阶梯：

| 状态码 | 含义 | 为什么不是别的 |
|---|---|---|
| `401` | 没带 token | 两个壳各自的门，在共用模块之前 |
| `400 {"error":"missing-id"}` | 两个主键一个都没给 | 语法畸形，与服务端状态无关，所以排在功能开关之前（与 reclaim 的 `invalid-json` 同档） |
| `400 {"error":"ambiguous-id"}` | 两个主键都给了 | 不静默择一，理由见上；同为语法类，同样排在开关之前 |
| `400 {"error":"invalid-limit"}` | `limit` 畸形或越界（只收十进制整数字面量，1–100） | **不用 `Number()`**：它把 `""` / `" "` / `0x10` / `1e3` 都化成数，于是 `?limit=` 会静默变成 0 个窗口——一个畸形输入拿到最坏解释。越界也给 400 而不是截到 100：调用方要 1000 个窗口，实际给 100 却不吭声比直接拒更糟 |
| `409 {"error":"distill-records-disabled"}` | 用户关了 `distillRecords.enabled` | 与 `src/api.js:525` 的 `profileExtractEnabled` 同型：**用户关了 = 409，装配坏了 = 503**，两个答案必须可区分（`src/index.js:589-591`） |
| `503 {"error":"provenance-unavailable"}` | service 上缺**该方向**要用的方法（headless / 旧装配） | 「没接线」不是「这条记忆没有来源」，两种空必须分开读数。**按方向判**：只缺 session 那侧的方法时方向 1 仍然 200——把一个方向的问题报成整张脸坏了，会让人去查一个没坏的部署 |
| `200` | `{memoryId\|sessionId, windows, truncated}` | 空 `windows` = 不是蒸馏来的；`truncated` 见下 |

**limit 与 truncated（#524 的第 2 条前置）**：按会话读是这张脸里天然最容易放大
的方向——一个会话几十个窗口，每个窗口都是整段逐字原文，不限量就是「按会话导出全量转
录」，与 `/export`（一次拿全库）同量级，只是换了形状，而它同样受门控。所以 `limit`
不是可选的礼貌参数：默认 20、上限 100，两个方向共用同一个读数。20 这个数的取法是本
机实测一个蒸馏会话的窗口数在个位数，20 已覆盖正常排查；真要更多就显式往上要，**不
许**靠缺省值默默给全量。100 的上界比列表类接口（`MAX_PAGE_LIMIT` 1000 / `MAX_SEARCH_TOP_K`
200）小一档，因为每个窗口带的是一整段原文而不是一行元数据。

撞上 limit 时答复带 `truncated: true`。**少了它，被截断的答复与「本来就只有这么多」
逐字节相同**，调用方会把半份转录当成全部——那正是这张脸最容易骗人的地方。实现上
session 侧向 store 要 `limit + 1` 行、多出来那条只当探针不出口；memory 侧
`provenanceFor` 本来就全量返回，按长度判即可。store 侧只照 limit 取，**不替调用方判
断「还有没有」**——那是协议层的事，判据只许有一份。

**为什么不是 404**：本端点被明确设计成永远不就「这条记忆是否存在」作断言（缺 id 是 400、
未知 id 是 200 + 空 windows），而 404 在本仓已有稳定含义——未知路由与资源不存在
（`/memories/:id`、`entity-not-found`）。把「功能关了」塞进 404，调用方会在状态码这个
被代理 / 监控 / 重试逻辑唯一读取的通道上，把它读成「这条记忆不存在」；那两种误读的后续
动作完全不同（一个去开开关，一个去查这条记忆）。409 也不给 200 的形状加说明性键——响应
体只多一个 `windows`，开关状态走状态码通道。

**生效节奏**：`cfg` 是启动期冻结值（面板改开关与 `panel_mode` 一样在下次启动生效），读写
两侧取的是同一份快照，所以两道门永不分歧；该键在 settings 白名单与 `NESTED_FLAG_PATHS`
里都登记着，面板会显示「待重启」（#481「面板开着、功能却不注入」的教训）。

**daemon 这一面**：`src/serve.js` 把 `feature_flags` 里的 `distillRecords.enabled` 展开进
cfg（与宿主 `index.js:217-233` 同款展开，只取蒸馏这一组），与宿主共用同一个 memory.db 与
同一份 kv——面板开着，daemon 就读得到。残留不对称：daemon 结构上看不到宿主的 bundle
config，所以「只写在部署侧 bundle 配置里打开、从没在面板点过」的用户，宿主认、daemon 不
认（每个请求回 409）。这不是故障，写进 `docs/DAEMON.md` 的那条已知边界。

**关开关 ≠ 删除已留存原文**（本轮之后唯一诚实的表述）：这道门只封 HTTP 读路径。关掉后
`src/index.js:270` 跳过启动期裁剪，已留的 `distill_records` 行永久冻在盘上，任何能摸到
memory.db 的进程仍可读；唯一出路是 `dsh-mneme reclaim`（`src/maintenance.js` 不读这个
键，手动可删）或重新开启后的启动裁剪。把「关 = 删掉」写进任何文档都是谎话。后续可做的
是让裁剪与写开关解耦（`retentionDays` 有值就裁，无论 `enabled`），那是让开关语义完全诚实
的唯一修法，超出本轮范围。

## 11. 运行归因：从「会话区间」到「哪一次蒸馏」（#512）

§10 的窗口只回答「这条记忆蒸自哪一段原文」。同一段区间被重蒸馏过几次、哪一轮失败了、
失败在哪一步——这些在 §10 的形状里读不出来，因为 `memory_provenance` 的粒度是
(memory, 会话, 区间)，而区间是**输入**的坐标，不是**运行**的身份。

拆成两层，因为它们回答的不是同一个问题：

| 层 | 表 | 回答 | 谁能填 |
|---|---|---|---|
| 窗口级 | `memory_provenance.distill_run_id` → `distill_runs` | 这条记忆是**哪一轮蒸馏**从这段原文里提出来的 | 只有按窗口写入的 autoSummarize 路径 |
| 行级 | `memory_mints(memory_id, run_id)` | 这条记忆**出生自哪一轮巩固** | dream / sleep 的 create 动作 |

**为什么行级要另开一张表**：dream / sleep 铸造的 pattern 没有会话区间——session 与 seq
都不存在。把合成区间塞进 `memory_provenance` 就是编造坐标，而一个错的坐标比没有坐标更坏
（它看起来完全合法，会让「能追到」变成谎话）。所以那一层只记 run id，不记区间。

**为什么行级只填 create**：merge / conflict / update / supersede 动的是**既有行**，
`receipt_chain` 已按 (run_id, record_id) 记过一遍。再造一份就是第二套账，两边迟早对不上。
create 是那边唯一的洞：`buildOutcome` 刻意不给 create 派 disposition，`receipt_chain`
也就不产行。

**为什么不复用 `llm_audit_logs.id` 当 run id**：`llmAudit.retentionDays` 到期裁剪会删掉
audit 行，归因会跟着悬空；而 `memory_provenance` 刻意活得比原文更久（§10 的「来源已过期」
就是这条设计的产物）。所以 run 是**归因主体**，audit 行只是它的**开销读数**，两边靠
`distill_runs.audit_id` 连——不是靠时间戳猜。

**为什么不复用 `dream_runs`**：那张表每一列都是巩固语义（`snapshot_hash` / `input_count` /
`decisions` / `outcome` / `receipt`），「每行都能回放一次巩固」是它对消费方的契约。硬塞
`run_type='autoSummarize'` 会让这条契约失效，而一个字段两种含义是这套 schema 里最容易腐烂
的那种设计。dream / sleep 的轮次仍只记在 `dream_runs`，不复制进 `distill_runs`——两张表
各说一件事，比一张表说两件事好。

**历史行不猜**：迁移只加列/加表，存量 `memory_provenance.distill_run_id` 一律 NULL。反推
一个「看起来能追」的合成 id 是最坏的一种坏：读数正常，实际是编的。面板遇到 NULL 显示
「无运行归因（历史行）」，不是空白。

**失败轮也记账**：`distill_runs.status` 取 `ok | degraded | noop | failed | aborted`。
模型侧流失败与解析失败都会留一行 `failed`——否则「这个窗口为什么一直没有记忆」在台账上
查不到原因。只有 dispose / 会话关闭才是 `aborted`（这一轮被主动打断），两者必须分得开。

**读出口**：`GET /api/dsh-mneme/memory/provenance?id=` 的窗口按上表带上
`distill_run_id / run_type / trigger_source / run_status`（读不到整组 null），答复级另带
`mints[]`（`{run_id, run_type, trigger_source, created_at}`）。面板详情抽屉有一个
「蒸发归因」区块渲染这两层。
