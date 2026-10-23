# 记忆分享包（memory share pack）设计

- **日期**：2026-10-22
- **状态**：待评审（未开工）
- **范围**：把本机记忆做成一个可外发的包文件，好友在同款 DSH + dsh-mneme 上导入，得到可用但不属于他的记忆
- **相关文档**：[存储与回收](../dsh-mneme/docs/STORAGE.md) · [语义增强](../dsh-mneme/docs/SEMANTIC.md) · [配置](../dsh-mneme/docs/CONFIGURATION.md) · [SECURITY.md](../SECURITY.md)

正文里的 `src/…`、`lib/…`、`test/…` 一律相对包目录 `dsh-mneme/`。

## 1. 问题

有人想把插件存的本地记忆发给朋友，让朋友的 AI 直接用。今天这条路是断的，三道墙：

| 墙 | 事实 | 位置 |
|---|---|---|
| `/import` 是回填不是合并 | 每条先 `store.getById(edit.id)`，取不到就 `continue` —— 对方库没有这批 id，导入结果恒为 0 条 | `src/service.js:1947-1949` |
| scope 标签跨机必然失配 | `agent_scope` = agentPreset 名、`workspace_scope` = 本机 canonical 路径；`strictScope` 默认关时降权、开时硬过滤，且路径里含本机用户名目录 | `src/scope.js:78-118`、`src/config.js:872` |
| 现有导出口径不能外发 | `/export` 是「全库 + 含 archived/forgotten 全字段」，2026-10 审计 P0 才补上鉴权 | `src/api.js:1415-1462` |

`strictScope` 默认关（A2 软隔离）这条让第二道墙比看上去软：即使带着标签入库也只是被降权，不会静默消失。但分享包仍必须抹掉这两维 —— 不为可见性，为路径泄露。

## 2. 已定决策

| # | 决策 | 选择 | 代价 |
|---|---|---|---|
| 1 | 接收端 | 也装 DSH + dsh-mneme，走真正的合并入库 | 非插件接收端不在本设计内 |
| 2 | 合并语义 | 独立外来包：一律建新行，绝不改写他本人的行 | 库里有「外来区」，需要来源规则 + 面板筛选 |
| 3 | 分享口径 | 默认脱敏分享档：只导活跃行 + 敏感整条跳过 + 机器标识抹除 | 偶尔确实想发被拦的那条，v1 只能看跳过清单 |
| 4 | 入库路径 | CLI / API 受控入库 | 不动镜像回灌的陌生 id 语义（防御段） |
| 5 | 超限口径 | share 侧卡体积，超限走分批 | 库大时要点几次 |
| 6 | 撤销 | v1 带「整包一键退出」 | 多一条路由与几条测试 |

## 3. 包格式

单文件 JSON，`mneme.share/v1`。**刻意不带行主键**：我的 `id` 到他库里没有意义，而且「按 id 找既有行」正是今天导入 0 条的病根。

```
{
  kind: "mneme.share/v1",
  pack_id: "<16 hex>",
  alias: "<分享者自报别名，可空>",
  generated_at, source_version,
  report: {
    included, deduped,
    skipped: { archived, forgotten, readonly_type, excluded_type, blank_or_noise, sensitive },
    skip_list: [ { title, reason } ]
  },
  memories: [ { external_id, type, title, content, tags, importance,
                epistemic_status, created_at, updated_at, content_hash } ]
}
```

超限的答复不是包，是另一份形状：`{ error: "too-large", bytes, limitBytes, hint, report }`——`bytes` 只在这里出现（成功包体里没这个键，量过水位就直接出包，不必自报体积）。

- `pack_id` 是 `randomBytes(8).toString("hex")`，16 位。**车道 C 的形状校验必须按 16 位写**，本节的初稿写的是 12 位，按它校验等于拒掉每一个真包。
- `skip_list` 截到 50 条，`skipped` 的六个计数仍是全量——截的是清单不是账。清单里的 `title` 已在源头脱敏；
  **整行命中密钥/PII 判据的那几条不给标题**（空串，原因计数照记）。理由：判据认的是「关键词 + 赋值号 + 值的形状」，
  正文写着 `password: 那个值` 的行常常把同一个值也写在标题里，而这份清单随包外发（413 那次拒发也带同一份 report）；
  不给哈希摘要，因为摘要是递给收侧的离线爆破 oracle。CLI 对空标题打「（标题不外发）」。

- `external_id = sha256(pack_id \x00 type \x00 title \x00 content_hash)` 前 16 位：幂等键，不是主键。接收方自己铸 `id`。**内容锚必须在键里**：库的去重键是 `(type, content_hash, agent_scope, workspace_scope, sensitivity)`，同 type 同 title 不同正文的两条是合法的两行，旧三项派生会让它们共用一个 `external_id`，接收侧的幂等先查会跳掉第二条、`report.included` 从此谎报。（本条初稿只写 `pack_id/type/title`，A3 评审按代码推翻，代码为准。）
- 不带 `id / embedding / content_history / _full_content / evidence / doc_path / agent_scope / workspace_scope / sensitivity`。前三样是体积大户，后三样是本机标识。
- **`content_hash` 与上面 `skip_list` 那条是不对称的，这里是看见了才这么定的**：`skip_list` 为了不给离线
  爆破 oracle 而把标题留空，`memories[].content_hash` 却是发件人**遮 home 之前**的归一化锚，随包外发——
  对遮过前缀的那几行，它就是一个能对「候选用户名」离线核验的弱 oracle（核验，不是提取）。留着的理由是它是
  `deriveExternalId` 的第四个入参：删掉它或换成遮后的字节，等于给每一个已发出去的包换一套幂等键，收件人
  重跑同一文件会把同一批原文再建一遍全量行。代价、发件人该怎么做，如实写在
  [docs/SHARE.md](../dsh-mneme/docs/SHARE.md) 的信任边界那一节；本车道不改代码、不加开关。
- `deduped` 是**包内折叠**的计数，`included` 从此只数实际发出的条数。键的四个入参里没有 scope，而库里同 type、同标题、同内容锚、scope 不同的两条是合法的两行（`store.js:1233` 的去重键吃三维 scope），它们在包里必然共用一把 `external_id`。留在包里发给对面不是「多一行重复」：那第二条撞的是它自己的 `share_external_id` UNIQUE 索引，抛错穿出 `runAtomically` 的 ROLLBACK = 整包吃不进去，而「事务内先查」在包内两条之间查不出任何东西（那时一行都还没落），重跑也救不了——撞的是同一个死键。所以出包侧折成一条：标题与内容锚都相同的两条到对面那台**没有 scope** 的库里本来就是同一条记忆。由此得一条车道 C 可以依赖的前提：**`memories` 里的 `external_id` 恒不重复**；`included + deduped` 才是够格进包的行数，两个数都在报告里，没有静默吃掉的账。
- `importance` 与 `epistemic_status` 保留 —— 它们决定对面怎么排序和怎么信这条，属于该带的内容。
- 上面这个 `report` 是**分享侧**的导出报告；接收侧的答复另有一份形状（见 §5）。两份都叫 `report` 会让实现顺手把它们合并成一个对象，而它们的字段没有一样重合。

## 4. share 侧

**取行口径**：`archived = 0` 且 `forgotten = 0`；排除 `document`（只读指针行，正文文件不随包走，与 `MIRROR_READONLY_TYPES` 同口径）；排除 `summary`（它是对分享者会话的总览，对面没有上下文可读，且会与对面 dream 自己的 summary 抢注入档位）；**正文 trim 后为空的不进包**（记 `blank_or_noise`）。最后这一条是分享边界自己补的，不是抄来的：`informationlessReason` 判的是 title+content 的**组合**，「标题有字、正文一片空白」在它眼里有信息，而收侧 `content` 列 NOT NULL 且 §5 逐条校验非空——一条空正文不是少发一条，是把整包毒掉。六个原因键已被文档表、CLI 档位名与计数测试三方钉死，不为它开第七个（「没有正文」本来就属于空白那一格）。余下 8 类进包。

**脱敏两类处置，不是一锅端**：
1. 结构性抹除 —— scope 两维不进包（对面落 NULL = 全局可见，语义见 `src/scope.js:159-173`）；`content` 里命中的本机 home 前缀替换为 `~`。
2. 判据命中则整条不进 —— 空白/噪声走 `informationlessReason()`（`src/write-admission.js:117`，已导出、纯函数），密钥/PII 走 `scanSensitive()`（`src/sensitive-scan.js:165`，其文档明写它是给「写入边界之外的消费方」直调的那张脸）。选整条跳过而非就地打码：半条打码的记忆到对面只会是读不通的噪声，且跳过项会进 `report`，分享者看得见漏了什么。**扫描每行一次、且排在判序之前**：跳过分支给的标题也在这份包的射程里（`skip_list` 随包走、413 答复带 report），所以要先把整行照一遍才知道标题能不能给——归档行因此不再免扫，代价上界见 §3 与 §12 那一格。

**share 侧恒开，不看 `writeAdmission.enabled` / `sensitiveScanEnabled`**。理由要写进注释：那两个键是「闸门」与「闸门内一批判据」的关系，服务于写入侧的可观测性；分享边界本身就是安全边界，不能因为对面没开闸门就变成裸发。

**体积水位**：包体超过 3 MiB 直接不出文件，`report` 说明原因并提示按 `--type` / `--tag` 分批。4 MiB 是 #462 审计加的写死上限（`src/api.js:57`、`src/api-standalone.js:31`），留 1 MiB 余量给 JSON 包装与编码膨胀。

**面**：`dsh-mneme share --alias <名字> [--type t] [--tag t] [-o <文件>]`，stdout 打印 `report`（跳过清单里那些还允许外发的标题；整行命中密钥判据的那几条只有原因，见 §3）。share 是纯读、不改库，所以**不套 reclaim 的 dry-run 纪律**——那条纪律是为「不可逆的内容丢弃」设的。

## 5. receive 侧

**校验在前，整包成败一致**：`kind` 恒等 `mneme.share/v1`、`pack_id` 形状过、每条 `type` ∈ `TYPE_FILE` 键集且 ∉ `MIRROR_READONLY_TYPES`、`title`/`content` 非空、`external_id` 可重算且与包内值一致。任何一条不过 → 不导入任何东西。出包侧对其中两条有**先验**（§3 的包内 id 唯一、§4 的正文非空），车道 C 照旧逐条校验，只是别把这两条写成「撞上就折叠/修剪」的处理——一个违反它们的包是被人改过的包，按下一段处置。

「重算不一致就整包拒绝」与镜像那套「人可以手改文件、改完回灌」的哲学是**相反**的，这是刻意的：镜像文件是分享者自己库的可编辑视图，改它改的是他自己的记忆；分享包是别人发来的文件，`external_id` 一算就对不上，意味着包的 `pack_id`/`type`/`title`/`content_hash` 四者至少有一处不是发件人铸的，此时幂等键失效 —— 收下它，第二次导入同一份手改包就会建行。要改内容请改完重新 share，别改包。

**接收答复形状**（与 §3 的分享侧 `report` 不是一份东西）：

```
{ pack_id, alias, created, skipped_existing, unchanged,
  title_conflicts: [ { type, title, existing_id } ], conflicts_checked }
```

`dry-run` 与真导入返回同一形状，`created` 在干跑时是「将会新建」的计数。

**幂等要落库**，tag 塞不住。新增两列，配 AGENTS.md 纪律 4 的幂等迁移（PRAGMA 检查 + ALTER，存量库启动即建）：

```
share_pack_id      TEXT
share_external_id  TEXT   -- UNIQUE 索引（WHERE share_external_id IS NOT NULL）
```

用 UNIQUE 索引而不是「先查再写」：`memoryDir` 可被两个宿主共用（AGENTS.md 并行工作区一节），并发导入同一个包时只有数据库约束挡得住重复行。**但幂等的主路径仍是事务内先查** `share_external_id` 命中即跳过 —— 因为约束报错会从 `.run()` 穿出 `runAtomically` 的 ROLLBACK，把整包一起带走。两条各管一件事：先查管常规重复导入（`created = 0`，正常答复），UNIQUE 管两个宿主同时导入的竞态，输的那一侧整笔失败、重跑一次就成了 `created = 0`。这不是「冲突回落 skip」，写清楚免得实现去 catch 约束错误继续跑。**这条索引不该被包自身的内容撞响**：分享侧在出包时就把同键的孪生行折成一条并记 `report.deduped`（§3），所以合规包里的 `external_id` 恒不重复——落不到「整包因为别人库里两条同正文的记忆而回滚」那种形态。校验阶段仍值得按「包内 id 唯一」判一次形状（拒收一个手改出来的重复包），但它是防线，不是折叠的替代品。

**建行走 `store.save`，明确绕开 `saveWithDedupe`** —— 后者命中即 `appendContent` 并入既有行，正是决策 2 否掉的行为。落值：`agent_scope` / `workspace_scope` = NULL、`source = 'imported'`、`tags` 追加 `from-<alias>`（空别名时 `from-shared`）、`updated_at` = 导入时刻、`share_pack_id` / `share_external_id` 落值。写完 `scheduleEmbed` 排队，否则对面的向量检索吃不到这批。

三处代码层的事实在这里落地，都是评审时对着 `src/store.js` 验过的，先记下来免得实现时当成能商量的：

1. **`created_at` 拿不到「包里原值」**。`insertMemoryRow` 恒写 `nowIso()`（`src/store.js:1154`、`:1200-1201`），要保留原时刻得改那条 INSERT —— 而单调时间戳是 AGENTS.md 纪律 5 点名的防御段。v1 用导入时刻，包里的 `created_at` 只作给人看的时间感，不写列。
2. **`content_hash` 传不进去**（`src/store.js:1208` 一律按本行 title/content 重算）。这是对的：包的哈希只用于分享侧自证，入库哈希必须由对面自己算，两份哈希不得混用。
3. **新列不进 INSERT 白名单就存不住**（列清单硬编码在 `src/store.js:1171-1172`），`toRow()`（`:522-555`）同样是硬编码白名单 —— 列加了、行读出来还是没有这两键，两处都要改。索引跟着 `addColumn` 之后一条 `db.exec("CREATE INDEX IF NOT EXISTS …")` 走，不放基础 SCHEMA 串（`:876-878` 的注释：存量库上 `CREATE TABLE` 是 no-op，schema 里的索引会因为列还不存在而失败）。

**入口层**：`createApi` 手里没有 `store`（`src/api.js:185`，`src/service.js:2670` 明写「api 层不直接摸 store」）。所以导入与整包退出必须做成 **service 的两个新方法** `importSharePack()` / `deleteSharePack()`，由 service 去摸 store；两张皮各自只是薄壳。批删沿用 `remove()` 的 `runAtomically` + `incrementGeneration()` + 清 embedding 缓存的形状，仓里没有 memories 的批删先例，得新写一条。

**撞名不并入，但要说出来**：接收答复的 `title_conflicts` 列出「同 type 同标题、scope 同为 NULL 的既有非 imported 行」，由他自己决定要不要手动处理。

**「不改写」不是一个点，是九个行池加一个汇流口**。评审时按代码数过一遍，凡 `.filter(m => !m.archived …)` 之后会把行交给 LLM 裁决、归档或降级的位置都要挂 `isImportedRow(m)`：

| 位置 | 它在做什么 |
|---|---|
| `src/dream.js:60` | 触发阈值用的活跃数（挡它等于挡这次做梦，不够） |
| `src/dream.js:1017` | **巩固真正读的那份快照** —— 只改 `:60` 拦不住改写 |
| `src/dream.js:489` | 叙述生成输入 |
| `src/dream.js:1479` | dream 总览输入 |
| `src/dream/sleep.js:208` | 睡眠期的记忆池 |
| `src/dream/sleep.js:447` | 按时间/热度分层，里面直接 `setArchived` 与 `demoteToSummary` |
| `src/dream/sleep.js:~498` | `service.list({limit:200})` 的模式扫描池 |
| `src/dream/sleep.js:589` | 关系补全池 |
| `src/organize.js:155-164` | `rowsFor()` 的并入候选查询 —— 一处覆盖 `bestNear` 与精确标题命中两条判定 |

外加汇流口 `src/service.js:1389-1402`：`saveWithDedupe` 解析「并入目标」的那段。它是 `appendContent` 改写的总入口（蒸馏路径、`_mergeInto` 显式目标都从这过），把 imported 行从候选里剔掉，等于在所有写入侧同时封口 —— 这一处是**必做**，九处池子是补枪。`clustering.js` 是纯几何、`decisions.js` 收的是 id，都不需要各自加谓词。

**整包退出**：`POST /api/dsh-mneme/receive/undo {pack_id}` → 删除该 pack 的行。**选物删不选归档**，理由要写进注释：归档行仍占 `share_external_id` 的 UNIQUE 位，会造成「撤了却导不回来」的死角，那个形态比多删更坏；原始包还在分享者手里，随时能重导。

## 6. 面板

骨架照抄现成的 `ImportDialog`（选文件 → 本地读文本 → POST → 提示条数，`lib/client.js:6133-6160`）与 `exportData` 的下载路径（`lib/client.js:6596-6612`）。

- **分享包弹层**：先出 `report` 再给下载 —— 导出 N 条 / 各类跳过计数 / 跳过清单可展开看标题，别名输入框默认空。**看见数字之前不给下载**是这一面的支点：CLI 那侧没人拦得住，面板至少要让「随手全库外发」停一步。
- **接收弹层**：选文件 → `dry-run` 预览（来自谁的包、N 条、`title_conflicts` K 条、幂等已吃过 T 条）→ 点「确认导入」才真写。沿用 `reclaim` 的脾气：`confirm` 不带就是干跑。
- **外来区**：记忆浏览器按 `source = imported` 可筛，行上显示 `from-<别名>`，并给「收起这个包」按钮（走 undo）。

三条面板纪律：`lib/client.js` 是手写的 lib-only 文件（`scripts/sync-lib.js:1-5`，sync 不 prune），改它不触发 check-sync；配色走 `--mneme-*` 语义色层，新增色由 `test/contrast.test.js` 自动重算（纪律 10）；文案要落 **`lib/client.js` 内联的那两份字典**（`:264` 起，`memory.explorer.<camelCase>` 扁平点键），不是 `locale/*.json` —— 那两个文件只有 `meta.title` / `meta.description`，本节的初稿把它当成面板字典是写错了。双语锁在 `test/client.test.js:930`：每个键必须恰好出现两次（zh + en），插值走 `.replace("{n}", …)`。

## 7. 路由与 policy

新路由必须显式声明 `policy`（纪律 9，漏声明装配期抛错），归完类同步改 SECURITY.md 的安全模型表：

| 面板路由（`src/api.js`，`/api/dsh-mneme/*`） | standalone 路径（`src/api-standalone.js`，无前缀） | policy | 归类理由 |
|---|---|---|---|
| `POST /api/dsh-mneme/share` | `POST /share` | `token` | 与 `/export` 同门：全库级读取 |
| `POST /api/dsh-mneme/receive` | `POST /receive` | `token-write` | 写库 |
| `POST /api/dsh-mneme/receive/undo` | `POST /receive/undo` | `token-write` | 删行 |

面板走宿主内路由，CLI 走 Bearer 数据面（standalone 侧路径不带 `/api/dsh-mneme` 前缀，照现成的 `/health`、`/maintenance/reclaim` 形状）。两侧**解析与答复只许有一份**（`src/reclaim-http.js` 的 #411 先例：两张皮只许剩鉴权与路径不同）。

**上表的 policy 列只对宿主内侧成立**。`token-write` 是 `src/api.js` 独有的三档声明（`ROUTE_POLICIES`，`:104`；`needsToken` 对 `token-write` 连 GET 也要 token，`:107`），standalone 侧没有档位概念 —— 它是「除 `GET /health` 外全要 Bearer」的一道全局门（`:326`）。把 `token-write` 当成两侧同名映射会写出一个不存在的分支。

另外两条硬约束：`readBody` 的 4 MiB 上限在两侧各自实现一份（`src/api.js:57`/`:161`、`src/api-standalone.js:31`/`:114`），超限由 readBody 自己答 413 并返回 `null`，**每个 POST handler 必须写 `if (text === null) return;`**；`sendJson` 的签名两侧不一样（宿主内侧有 `headers` 第四参，standalone 侧没有），所以「带 Content-Disposition 的下载答复」只能在宿主内侧出，两份代码不能为了同构硬拼成一个。SECURITY.md 那张表由 `test/security-doc.test.js` 双向比对，`token` 与 `token-write` 两类都要进「受门控」那一条目，**中英各一处**（`:157` 与 `:538`）。

## 8. 错误处理

- 校验失败 / 体积超限：不动库，报告说清是哪一条。
- 导入过程中的任何一步抛错：整笔事务回滚（沿用 store 的事务口径），不做部分入库。
- `scheduleEmbed` 失败不阻断导入（现语义即 fire-and-forget 内部吞错）。
  **原稿这一条后面的「接收答复里如实标『向量待补』」已被删掉，是刻意的偏差而不是漏做**：车道 C 落地的
  答复只有 §5 那七个键（`src/share-import.js:173-187`），这一格从未上线，而答复形状已被两张皮的
  deepEqual 跨面锁钉死。为什么不改代码补上：v1 不加新线上字段，理由与 §11「不加配置键」是同一条纪律
  （新字段没有第二个消费者，却要多一处锁、一处 CLI 分支、一处「两张皮只许差在鉴权与路径」的例外）；
  最后一次整枝评审裁定**按代码改口径**，于是把这件事从答复里搬进文档：接收答复说的是「建了几条」，
  不说「有没有向量」，向量状态与补法见 [docs/SHARE.md](../dsh-mneme/docs/SHARE.md) 收侧那一节
  （查：`service.embeddedCount()` / `GET /api/dsh-mneme/semantic`；补：`POST /api/dsh-mneme/vector-reindex`）。
  代价如实写在那里：没挂 embedder、或挂了一个抛错的那两种情况下，这批行安静地没有向量。
- 对面库里已有同 pack 全量行时：`created = 0`、`unchanged` 给数、不删任何东西，也不报成错误。

## 9. 测试矩阵（验收锚点）

- `test/share-pack.test.js`：包 schema 形状锁（锁「不含 `id`/scope/向量」而非只锁含什么，防日后顺手加字段把泄露变成回归）、排除口径（archived/forgotten/document/summary）、home 前缀替换、空白噪声与密钥 PII 的整条跳过与 `report` 计数、体积水位拒绝、`external_id` 派生与手改检测。
- `test/share-receive.test.js`：陌生包建行 N 条；重复导入 0 新增；**既有非 imported 行的 `updated_at` 逐字节不动**（决策 2 的直接回归锁）；scope 落 NULL；`from-<alias>` tag；embed 排队；两个宿主并发导入同包不重复（UNIQUE 冲突回落 skip）；undo 后同包可干净重导。
- `test/share-imported-guard.test.js`：静态锁三个消费点都调 `isImportedRow`（照 `test/inject-parent-gate.test.js` 的跨文件断言形状）。
- store 迁移测试：存量库重开即建两列 + 索引。
- `test/client.test.js` + `test/contrast.test.js`：两个弹层渲染、四个渲染根一个不少、引用色存在。
- 旗标计数锁**不动**：v1 不加配置键（见 §11）。

## 10. 明确不做

非插件接收端的 markdown 便携档、目录投放自动摄入、跨版本增量包与删除墓碑、云端同步/多人共享、面板改动现有全库 `/export` 的口径（那是备份面，与分享面职责不同）。

## 11. 开关与配置

v1 **不加新配置键**，因此 `settings.js` 白名单与 `test/api.test.js` 的旗标计数锁都不动。理由：share / receive / undo 全是人主动敲的命令或点的按钮，不产生常驻行为；唯一碰既有路径的是「imported 行不参与巩固」，那是外来包契约的一部分，只对「只能靠导入才存在的行」生效，做成开关等于给一个安全属性留个可以关掉的口子。若评审否掉这条，退回「加旗标 + 白名单 + 计数锁 +1 + 考虑 lightMode 的 `LIGHT_MODE_OFF`」。

## 12. 实现时要实测的数

- 真库条数 → 包体积（决定 3 MiB 水位是否合理，以及典型场景要不要分批）。
- `scanSensitive` 逐条扫描在大库上的耗时（决定是否需要在 share 侧加进度输出）。
- home 前缀替换的实际命中率：如果大量记忆的正文里都有本机路径，说明正文层面的泄露比 scope 两维更严重，要回来改这一节的口径。

## 13. 交付切分（一车道一 PR）

本设计一次做完要碰 store 迁移、九处行池守卫、两张皮路由和面板弹层，不是一个 PR 的量。按能独立验收切四刀：

| 车道 | 内容 | 单独交付后能做什么 |
|---|---|---|
| A | 包格式纯函数核心 + share 侧 + `POST /share`（两张皮共用一份解析）+ `dsh-mneme share` + `docs/SHARE.md` | 能把合规的包文件发出去，对面还吃不了 |
| B | `isImportedRow` 谓词 + `saveWithDedupe` 汇流口 + 九处行池 + 静态锁测试 | 零可见变化（此时库里不可能有 imported 行），但把「不改写」提前变成既有性质 |
| C | store 两列 + 幂等迁移 + service 两个方法 + `POST /receive` 与 `/receive/undo` + `dsh-mneme receive` | 端到端第一次可用（命令行全程） |
| D | 面板四件：分享包弹层、接收弹层、外来区筛选、「收起这个包」 | 不熟命令行的人也能用 |

**B 排在 C 前面，取代评审时定过的「P2/P3 合一刀」。** 你当时选合一刀，是为了消灭「包导进去了但会被对方巩固改写」的空窗；读完代码后发现守卫在 C 之前是**完全惰性**的（B 合完、C 未合的那段时间里，没有任何一条 `source='imported'` 的行存在，谓词一次都不命中），所以「守卫先合、入库后合」同样没有空窗，而且每一刀都更小、review 面更短。合一刀的理由消失了。

B 单独发也不会有人察觉它改了什么 —— 这正是它该独立成一刀的理由：一条安全性质，配一条静态锁测试，不夹带任何新功能。

## 14. 评审后的修订记录

对着代码复核 spec 时改掉六处，都记在这里免得下次又按旧的写：

1. §5 的「三个消费点」是错的，实际九处行池 + 一个汇流口（§5 新表）。只改 `dream.js:60` 拦不住改写，真正被 LLM 读的那份快照在 `:1017`。
2. §5 的「`created_at` 用包里原值」做不到，除非动 `insertMemoryRow` 的 INSERT —— 那是纪律 5 点名的单调时间戳防御段。降为「导入时刻」，包内字段只给人看。
3. §5 的「UNIQUE 冲突回落 skip」与「整笔事务回滚」互相矛盾：约束错误会从 `.run()` 穿出 ROLLBACK 带走整包。改成事务内先查为主、UNIQUE 只兜并发竞态。
4. §7 的 `token-write` 在 standalone 侧不存在，那张表的 policy 列只对宿主内侧成立。
5. §6 的面板文案不在 `locale/*.json`（那两份只有 `meta.*`），在 `lib/client.js` 内联字典里，双语锁由 `test/client.test.js:930` 把守。
6. §5 的批删没有先例可抄（仓里 memories 只有逐条 `remove()`），且 `createApi` 拿不到 `store` —— 导入与退出必须做成 service 的两个新方法，不能写成路由里的裸 SQL。

## 15. 车道 C 的两条边界裁定

写车道 C 的计划之前定下来的两条，都是「不改写外来行」这条契约的边界：一条要改代码，一条刻意不改。

**一、`document.js` 的 evidence 吸收要过滤外来行（改代码）。** `registerDocument` 拿的是调用方给的 id 列表，吸收循环 `src/document.js:281-288` 对每条 `kept` 直接 `store.setArchived(id, true)`。这是**机器发起**的批量归档，正是决策 2 禁的那类动作，而九池框架看不见它（它不经任何 `service.all()` 池）。加 `isImportedRow` 跳过，并让被跳过的 id 在报告里可见——静默不算处理过。

**二、镜像里手改外来行：允许，但身份不许变（只写文档 + 一条锁）。** `reconcileHumanEdits`（`src/service.js:2134-2181`，每次 `syncMirror` 都跑）与 `mergeHumanEdits`（`:1949-1995`）都会对被改过的镜像文本 `store.update(...)`，今天两者都没有 `isImportedRow` 过滤。这里**不加**过滤，两个理由：

- 镜像文件躺在接收方磁盘上，是他刚打进去的字。把它静默改回去是比「改写」更糟的失效——他会以为编辑生效了，而下一次同步悄悄抹平；
- 这条契约原本禁的是**本机的模型**动别人的原文（巩固、降级、整理），不是本人改自己机器上的一份副本。

代价写清楚：手改之后那条记忆就不再是发件人的原文，这是接收方自己的决定，本设计不拦。要在锁里钉死的是另一半——手改之后行的 `source` 仍必须是 `imported`、两个 scope 仍必须是 NULL，否则「改一次正文」就能把守卫摘掉。
