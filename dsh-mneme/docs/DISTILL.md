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

删记忆是另一条路：`store.remove(id)` 在事务内**显式**清掉它的溯源链接。之所以不靠
`ON DELETE CASCADE`，是因为 `src/store.js` 从不启用 `PRAGMA foreign_keys`（全库唯一的
`REFERENCES` 是 `recall_events → recall_runs`，翻这个 pragma 会顺带激活那条既有约束的
行为，不是本次改动的范围）。声明式约束保留在 schema 里作为意图记录，实际清理是显式的。

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
