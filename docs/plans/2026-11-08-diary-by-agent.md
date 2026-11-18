> **本文是设计原委，不是待办。** 方案已于 2026-11-15 由 #613 整体实现并关闭，
> 落点 `dsh-mneme/src/diary/agent-bucket.js`（文件头即标注「#613 §2」），
> 条目见 `dsh-mneme/CHANGELOG.md` 的 0.16.0 节。下面是起草时的原文，**不要照着做**；
> 实现与草案的三处差异见文末「实现时的偏移」。

# 日记本 v2：「一个 Agent 一本」实现方案（挂在 #606 后面）

状态：草案 v2.1（Ephor 起草 2026-11-08；三处实测数字经 Amarre 逐条复验、双方口径已对齐，Amarre 2026-11-08 20:2x 确认可开 issue）
前置：#606（feat/606-persona-by-session，29df548，已开 PR #609）先落地；本方案不动 #603 的 worktree。
冻结状态：桉桉已解除日记本这条线的冻结（2026-11-08），可以直接动代码，push/PR 仍按纪律等点头。

## 0. 四条决定性事实（v1 的错误已更正）

**v1 错在把 sessionId 当 Agent 的键。** 实测：Amarre 名下 24 个会话（13 个「Amarre · 记忆研究」+ 11 个「Amarre」），Ephor 4 个；近三天每天 23/36/27 个不同 session 源。按 sessionId 分区，一个 bot 会散成 N 本，与「一个 Agent 一本」正相反。

正确的分区键来自宿主标题事件：

1. **`sessionProjections` 插件能拿到**（不用改宿主）。它是注册进 cordis 服务表的正式服务，宿主自己的插件都按名字注入：`dsh-action-cards` 是 `static inject = ["tools","agents","sessionProjections","remoteAccess"]`；`AgentLoop` 与 `agentPresets` 同样 inject 它。mneme 加进 inject 数组即可，读法 `const { asOfSeq, values } = ctx.sessionProjections.snapshot(session, keys)`。
2. **但 projection 里没有 `source`。** `titleProjectionDefinition.apply` 是 `event.type === "session/title" ? event.data.title : state` —— 只抄 title 字符串，`source.kind` 被丢掉。要判「user vs fallback」必须读事件日志：`session.snapshotEvents().findLast(e => e.type === "session/title").data.source`。宿主自己的 `foldSessionTitle(events)` 正是这么做的，返回 `{title, messageSeqs, source, eventSeq, updatedAt}`。
3. **日界是 UTC，不是本地。** `created_at` 存 `2026-11-08T10:41:28.375Z`；实测 UTC 日 105 条 vs 本地日 210 条（今天这批 session: 行，**差一倍**）。SQL 必须 `datetime(x, '+8 hours')`。`occurred_at` 空值实测 **4417/8126 = 54.4%**，`COALESCE(occurred_at, created_at)` 是必需项不是优化。
4. **source 有两种形态且零重叠。** 6492 条 `session:session-<uuid>` + 1146 条裸 `session:<uuid>`，同一会话不会两种并存；今天 top 10 会话有 3 个只有裸形。另外还有 97 条别的（`session:onebot-private-*` 95 条 + 2 条自由文本脏数据）。按会话取素材必须两形都匹配。
5. **`occurred_at` 有一批整 8 小时的偏移，必须先修正。** 偏移 `[-490,-470]` 分钟带内 854 行（活跃口径），全部 `.000Z` 整秒精度、`+8h` 后与 `created_at` 最大差 10.3 分钟 —— 是外部写入把本地时间当 UTC 存了，单向可复原，不是无规律脏数据。详见 §4。

## 1. 面板接 bySession（#606 缺口一）

- 位置：`lib/client.js:4422-4425` 读回 persona 时只认 `default/byAgent`（`isMulti = "default" in pj || "byAgent" in pj`）；`:4647` 保存时 `body: JSON.stringify({ persona: { default: nextDefault, byAgent: nextByAgent } })`。
- 改法（纯加法）：
  1. `:4423` 的 isMulti 判定加 `"bySession" in pj`；
  2. 读回 `pj.bySession`（`{ <sessionId>: card }`）渲染成第三组卡片，卡片头显示 agentId（§2 的解析结果），拿不到就显示「未命名」；
  3. `:4647` 的保存体加 `bySession: nextBySession`；
  4. 服务端 `src/settings.js:562` 已兼容三键形（`if ("default" in input || "byAgent" in input || "bySession" in input)`），**无需改后端**——这一条要加回归用例锁住（面板保存后 readback 三维都在，防止前端悄悄回落两维形）。
- 不做 UI 上的会话选择器：bySession 的键是内部 session id，人不用记；入口放在「人格设计页」每张卡上，值来自当前会话上下文（保存当前会话的卡时自动落 bySession）。

## 2. agentId 的解析规则（v1 的「三级」已重写）

写日记时对一个会话解析 agentId，顺序：

1. **#606 bySession 卡上有名字** → 用卡名（满足桉桉「导航栏是不同 Agent 的名字」）。
2. **没有绑卡，但能拿到 live session** → 读事件日志的 `session/title`：
   - `source.kind === "user"` 且标题含「·」→ 取「·」前的前缀；
   - **该前缀必须命中已知 bot 名单**（由宿主 roster / 当前会话可见成员得出），否则不认；
   - `source.kind === "fallback"` → 不认（fallback 标题是整句，如「可以生图吧？这是我给你Amarre角色形象与Live2D素材」）。
3. **冷行（无 live session）** → 默认进「未命名」一组：日记照写、按天归档，导航栏合并成一本。**不拒写**：冷行素材照样有价值，只是归不了人。
   - 可选一次性回填开关 `diaryBackfillColdAgents`（默认 false）：解压磁盘上的 `session.v4.jsonl.zstd` 读 `session/title` 事件拿 source。成本不可忽略（707 个会话目录级别），必须显式开、且只在启动时跑一次。
4. 都拿不到 → 同样进「未命名」，不退全局、不静默合并。

**为什么要「前缀必须在名单里」**：桉桉手改一个叫「公共管理复习」的会话，前缀就是整串，「·」规则会造出一个叫「公共管理复习」的假 agent 目录。名单守卫把脏数据挡在目录层。

## 3. 存储布局

现状：`<memoryDir>/diaries/<项目键>/YYYY-MM-DD.md`，按项目分桶（live：attune-dd7a5103、dsh-mneme-54f4c9ae、QQ---4f061790、QQ对话-4f061790、workspace-e9be35f6，各 1 篇）。`dir.js:43-45` 项目根拿不到时返回 null、拒绝写。

新布局：**`<memoryDir>/diaries/agents/<agentId>/YYYY-MM-DD.md`**（含 `_unnamed/YYYY-MM-DD.md` 作为未命名组）

- 目录名做文件名安全化（与现有 projectKey 同款处理）；`agents/` 前缀与项目桶天然隔离。
- 侧栏导航 = 扫 `diaries/agents/*/` 目录列表，每目录一篇当天、可回看历史。路由 id 用 `dsh-mneme-diary`（不能复用记忆库的 `dsh-mneme` 座位）。

**存量 5 个项目桶不迁移。** 理由：①它们按项目分桶，与按 Agent 分桶是两个正交维度，把项目日记归属给某个 Agent 需要人判（QQ 桶和 QQ对话 桶就是同一项目的两个名字）；②每桶只有 1 篇、都是当天产物，价值低；③迁移 = 复制 + 改名，不值得。处理：旧桶保留原样继续可读（只读入口收进「按项目」分组），新日记全部进 `agents/`。留桉桉否决权。

## 4. 全局素材的 SQL 口径（核心改动）

现状：`session-provider.js:86-121` 的 `collectSessionTranscript` 只读当前会话转录，QQ inbox 只是启动补写的兜底。

新增素材源 `memory-provider.js`（与 session-provider 并列，compose.js 里按优先级合并）：

```sql
WITH src AS (
  SELECT type, title, content, importance, source,
    CASE WHEN CAST(round((julianday(occurred_at) - julianday(created_at)) * 1440) AS INTEGER)
              BETWEEN -490 AND -470
         THEN datetime(substr(occurred_at,1,19), '+8 hours')   -- 修 -480，见下
         ELSE COALESCE(substr(occurred_at,1,19), substr(created_at,1,19))
    END AS ts                                                   -- ts 已是 UTC 语义
  FROM memories
  WHERE forgotten = 0 AND archived = 0
    AND source LIKE :sourceClause        -- 未命名桶 'session:%'
                                         -- 定 agentId 时改写成 source IN (两形)，见下
)
SELECT type, title, content, importance, source, ts
FROM src
WHERE datetime(ts, '+8 hours') >= :dayStartLocal
  AND datetime(ts, '+8 hours') <  :dayEndLocal
ORDER BY ts ASC
LIMIT 400
```

- **`occurred_at` 有 8 小时偏移，必须先修正再参与日界**（v2.1 新增，Amarre 定位、我复验）。偏移分钟直方图是尖峰不是散布：偏移 `0` 801 条、**`-480` 705 条**、`-481` 73 条，`[-490,-470]` 全带命中 **854 条**（活跃口径；不过滤 archived/forgotten 则 1085）。这 854 行**全部是 `.000Z` 整秒精度**（全库整秒 3471 条、带毫秒 246 条），即来自外部批量写入而非本机生成；把整带 `+8h` 后与 `created_at` 的最大偏差降到 **10.3 分钟**，是单向可复原的错误。判据只能按偏移量认，不能按「相差 >12h 就回落」——那批 854 行**全部**落在 12h 以内，一条都挡不住；反过来非 8h 带里还有 195 条确实相隔 12h 以上的（真实「回忆往事」型记忆），阈值法会把它们一起误判成不可信。
- **修正结果必须在测试里锁死，且要防「NULL 日」**：`ELSE` 分支漏掉 `COALESCE` 时（我第一版就照抄踩了），活跃行里 4429 条 `occurred_at` 为 NULL 的会全部落进 `date = null` 桶 —— 实测 **4037 条进 null 桶**，10-17 从 1004 塌到 **478**（丢 526）、11-07 从 489 掉到 **358**（丢 131）、10-09 从 365 掉到 **7**（丢 358），而且 SQL 不报错、结果看着还是个正常数字。验收用例要断言「结果集里没有任何一行 `date(ts,'+8 hours') IS NULL`」，再加一条更硬的：「给定一条 `occurred_at IS NULL` 的已知行，它必须出现在 `created_at` 的本地日」——条数巧合对上了也可能掩盖错位。

- **日界用 `datetime(..., '+8 hours')` 与本地日字符串比较**，不用 `date('now')`、不用裸 `created_at` 前 10 位。
- **窄口径必须匹配两种 source 形态，不能只 LIKE 前缀形**（这条是 v2 草案的 bug，实测抓出来的）：
  ```sql
  AND source IN ('session:session-<uuid>', 'session:<uuid>')
  ```
  实测理由：库里有 6492 条 `session:session-<uuid>` 和 1146 条裸 `session:<uuid>`，**两者零重叠**（同一 uuid 不会两种形态并存）。今天 top 10 会话里有 3 个只有裸形，只用前缀 LIKE 会各漏 7–8 条，整篇日记就少了这一段。用 `IN` 精确匹配两形还顺便消掉 LIKE 前缀串味的风险（比 `LIKE 'session:session-<id>%'` 更严，不需要再防 `session-2fbb2400xyz`）。
- 未命名桶用宽口径 `source LIKE 'session:%'`。注意它会把 `session:onebot-private-*`（QQ 私聊，实测 95 条）也卷进来 —— 这是有意的：QQ 那一路本来就是 mneme 的输入源，素材该进日记。
- `agent_scope` 不进 WHERE，只进正文元信息（避免 standard 吃掉一切）；`workspace_scope` 也不做主键（一个 bot 可跨工作区）。
- 单条截断沿用 `MAX_ITEM_CHARS = 1200`（session-provider.js:20）；compose 管线（lang.js 的 200-500 字、第一人称、只写真发生、打码数字不补全）原样复用，日记 prompt 不用改。
- **`LIMIT 400` 不能当总量上限直接套在宽口径上**（v2.1 修正）。实测按本地日超过 400 的天有 10-17 **1004** 条、10-12 511、10-16 508、11-07 489、10-18 415、11-06 412。`ORDER BY ts ASC LIMIT 400` 会砍掉当天最后一段，而 11-07 那天的尾巴正好是 18 点 96 条、19 点 96 条、22 点 75 条 —— **日记会系统性漏掉她晚上做的事，且不报错**（与 #611「图被静默丢」同一病）。单会话单日峰值实测 **219 条**（10-09 `session-1a22c3a7`；10-17 `session-aa4d5ef2` 同为 219），不是先前估的 52 —— 那个数是只看当天得出的，不能外推全库。所以「定了 agentId 就够」不成立。
  处理定稿（Amarre 与我一致）：① 先按 agentId 分流、再卡上限（`_unnamed` 才按天卡）；② **超限必须落审计** `diaryTruncated: {total, used}` 并经 `diaryAuditPath` 记录；③ 日记正文末尾留一行「今天素材 N 条，本篇用了 400 条」。不许静默截断。
- 隐私黑名单（Amarre 原建议，维持）：`diaryMemoryExcludeTypes` 默认 `["constraint","preference"]`（这两类是她自己定的规矩和偏好，写进日记既冗余又等于复述规则给她看）；`diaryExcludeWorkspaces` 默认空。

## 5. 触发方式（无 cron，维持惰性 + 补写）

- 现状 `auto.js`：turn/end 判定 + 启动 catchUp 一次一篇，`createDiaryAutoRun` 已有同项目最短间隔节流。
- 改法：**改用 agentId 维度节流**。turn/end 时用当前会话的 agentId 判「这个 Agent 今天写了吗」，没写就走 compose；启动 catchUp 把「项目列表」换成「`diaries/agents/` 下有目录、但今天没写的 agentId 列表 + `_unnamed`」，仍一次补一篇（不抢 token）。
- 日记开关：`PERSONA_FIELDS`（settings.js:39）加 `diaryEnabled`。**默认值定稿为保持 `false`**（现状 `src/config.js:343` 已是 `default(false)`，不新增键、不改默认）。理由：这个开关会把日记从「按项目」切到「按 Agent」并开始写新目录，属于改变落盘行为；默认开等于桉桉重启一次后行为就变了却没人告她。`_unnamed` 兜底先就位，她在自己卡上打开后立刻见效。
- 不做固定时刻定时器：宿主退出即消失、还要配启动补写，复杂度买不来行为差；隔日补写天然容错。

## 6. 手绘风格与 Agent 自定义

- 预设纸样 4 种（格纸/横线/牛皮纸/便签）+ 自定义标题，存进 bySession 卡的新字段（`diaryPaper`、`diaryTitle`），同走 PERSONA_FIELDS 白名单。**不接受 Agent 自由生成 CSS**（无沙箱，Amarre 的判断维持）。
- 渲染在 `.mneme-diary-paper`（现成 `border-radius:16px 11px 15px 9px` + `rotate(.18deg)` 雏形）上加 4 套 class，纯前端。

## 7. 实施顺序与验收

1. **先合 #606**（面板补 bySession 是它的缺口，也是日记的前提）。验收：面板保存三维读回三维；旧两维调用方不回归。
2. 日记分支（建议 `feat/diary-by-agent`，从 606 合并后的 main 切）：
   - memory-provider + compose 合并改造（§4）；
   - agent-id 解析器（§2，含 roster 名单守卫）+ dir.js 的 agents/ 布局（§3）；
   - auto.js 改 agentId 维度节流（§5）；
   - 面板 diaryEnabled/diaryPaper/diaryTitle + 侧栏「ta的日记」页（§1/§6）。
3. 测试红线：
   - **时区**：造一条 `2026-11-08T20:30:00Z`（本地 11-09 04:30）的记忆，断言它落在 11-09 的日记而不是 11-08 —— 这条能锁住 `+8 hours`，不做的话本地日与 UTC 日差一倍（实测 105 vs 210）的坑会复发；
   - **COALESCE（两条断言一起）**：① 结果集里没有任何 `date(ts,'+8 hours') IS NULL` 的行；② 造一条 `occurred_at` 为 NULL 的已知行，断言它出现在 `created_at` 的本地日。实测漏写会让 4037 行进 null 桶、10-17 从 1004 塌到 478、10-09 从 365 塌到 7，且不报错；
   - **-480 修正**：造一条 `created_at=2026-11-08T12:21:15Z`、`occurred_at=2026-11-08T04:20:00Z`（偏移 -480）的行，断言它出现在**本地 11-08**，而不是被当成前一天 04:20 落到 11-07（库里真实存在这种行 854 条）；
   - **source 两形都要匹配**：同一 uuid 造 `session:session-<id>` 与 `session:<id>` 各一条，断言两条都进当天日记（只匹配一形会静默少一半素材）；
   - **LIMIT 不静默**：造 500 条同日素材，断言元信息里记了「共 500 条、用了 400 条」，而不是无声砍尾；
   - **agentId 守卫**：标题「公共管理复习」不得造出同名目录，必须落 `_unnamed`；
   - `source.kind === "fallback"` 的整句标题不得被当 agentId；
   - 冷行默认进 `_unnamed`；`diaryBackfillColdAgents=true` 时才解 zstd；
   - `diaryEnabled=false` 一个字都不写；黑名单类型真的被排除；
   - 面板 bySession 保存/读回闭环。
4. 提交纪律照旧：modusensus 署名、无 AI 痕迹、src 改完跑 sync-lib、不 push 不开 PR 等点头。

## 8. 风险与不做项

- 不做：多 Agent 共用一本（桉桉已选一人一本）；跨项目转录抓取（宿主无接口，memories 是唯一稳源）；CSS 自由生成；固定时刻定时器；历史项目桶迁移（默认不迁，桉桉可否决）。
- 风险一：source 窄口径只覆盖「该会话被蒸馏的记忆」——Agent 在群里说的话若没进记忆库，日记看不见。这是「素材从转录换成记忆库」的固有权衡，换来跨项目跨工作区视野；日记会偏工作日志。嫌干的话二期把 QQ inbox 兜底扩成群消息源（`onebot-*` 的 source 已在库里，实测 98 条）。
- 风险二：`_unnamed` 桶会随历史会话增长而变厚。可控：它按天一篇、不按会话分本，只是「这一个 bot 不知道是谁」的日记。桉桉若嫌导航栏多一项，可以配置成隐藏。

## 实现时的偏移（2026-11-18 补记，与上文冲突时以此为准）

草案交付后，#613 落地时有一处扩展、一处改了方向、两处锚点失效。原文保留不动，差异记在这里。

1. **§2 的 Agent 解析是三级，实现是四级。** 实现多一层 `header.agentPreset`
   （`dsh-mneme/src/diary/agent-bucket.js` 文件头第 3 条：与人格卡的寻址同一来源），
   即：已落定的 `sessions.json` → 标题 `·` 前缀（只认 `source=user`）命中人格卡名单 →
   `agentPreset` → `_unnamed`。并且多了一条纪律：**只在首次写入时落定**，
   之后改标题只更新展示名，不再重算分桶（否则改一次标题就多出一本孤儿书）。
2. **§3 的「存量 5 个项目桶不迁移」不再成立。** 实现改成**正交并存 + 同 hash best-effort 归并**：
   日期不重叠就整篇归位，重叠则两份都留、标 `conflict` 副本，绝不静默覆盖；
   `runs.jsonl` 按行追加、不补写历史。
3. **两处代码锚点已失效**，文件在实现期重构过，`isMulti` 与 `nextByAgent` 现在全库零命中。
   要看现在的实现直接读 `dsh-mneme/src/diary/`，别再按 §1 的行号找。
