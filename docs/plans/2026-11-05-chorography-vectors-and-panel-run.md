# chorography 收尾档实现计划（面板生成入口 + 向量检索；分支 feat/choro-panel-run-and-vectors）

M0–M3 与 v0.11.0 之后，spec 消费面还剩两块：**面板上的生成触发点**（spec §3「现在生成」）与
**向量检索**（choro_vectors 表自 M0 起是空壳）。本档收掉这两块。

| # | 决策 | 理由 | 被否备选 |
| --- | --- | --- | --- |
| P34 | 面板只接 T0 重建（POST `/choro/run`，policy `token-write`）；T1 不上 HTTP | T0 秒级同步回执；T1 单模块 30–240s 起步，同步 HTTP 会挂死面板请求、异步要引入 job 语义——一个按钮不值得背这套，T1 的 dry-run→apply 流程留在 CLI | 面板直跑 T1：长请求 + 额度双风险 |
| P35 | runT0Apply 作为 choro 对象的方法注入 createApi（queries 保持纯读） | 生成是写路径，与读侧分开装配；index.js 已有两个实例化点，合并成一个对象 | 把 store 塞进 queries：读侧模块从此不纯 |
| P36 | `choro_vectors` 补 `vector TEXT` / `source_generated_at TEXT` 列（SCHEMA 直改 + addColumn 幂等） | spec §5 的表定义漏了向量本体列——这是 spec 的实现缺陷，不是设计 | 存 memories.embedding 式的行外 JSON：跨子系统耦合 |
| P37 | 向量在**检索时惰性物化**（首次 /choro/search 且 embedder 可用时补嵌缺页），不在 T0/T1 写路径嵌 | T0 的「零模型、可离线、秒级」属性不能破；CLI 环境没有 embedder；host 侧检索时付一次性成本（40 页 × 短文本） | T0 完成后同步嵌：破「零模型」契约 |
| P38 | staleness = 页 `generated_at` 变了就重嵌；**dim 失配（换 embedder 模型）→ 惰性全量重建** | V4 的答案：model/dim 记行内，不与记忆向量锁死——choro 向量自成一套，换模型代价 = 40 页重嵌，秒级到分钟级 | 换模型作废整库：没必要，惰性重建更便宜 |
| P39 | 检索融合不混排序：keyword `hits` 原样，向量结果独立成 `semantic` 数组（slug/title/score） | 两路分数不可比（子串命中 vs 余弦），硬融合会造出假排序；调用方（面板/工具）各取所需 | 分数归一化融合：两路量纲不同，归一是伪科学 |
| P40 | 嵌入对象 = 页正文剥 frontmatter/T1 标记后的全文；embedder 缺席/失败 → 该页跳过、检索静默退关键词 | spec §5 owner_id 指 pages（v1 只做页级；claims 级留待真有精排需求） | 嵌 claims：40 页 × N claims，成本翻倍收益存疑 |

路由新增：`POST /api/dsh-mneme/choro/run`（`token-write`，SECURITY.md 双语受门控清单同步）；
`/choro/search` 响应加 `semantic` 字段（embedder 可用时）。

面板：wiki 顶栏加「重建骨架」按钮（POST `/choro/run` 成功后重载模块树；t1Loss 警告透出）；
client.test.js 加一例锁按钮与请求路径。
