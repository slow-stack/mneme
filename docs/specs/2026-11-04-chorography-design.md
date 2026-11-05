# 仓库地志（chorography）子系统设计

状态：待评审。作者：Qoder + 桉桉。日期：2026-11-04。

## 1. 一句话

读一个 JS/TS 代码仓库，把它的地貌（模块划分、依赖边、技术栈、约定、构建命令）编译成仓库内可维护的 Markdown 页面与溯源知识卡，人可以随时手改且改动不会被机器抹掉；生成吃 DSH 宿主模型额度，不要求任何额外的模型商 key。

对标的是 Qoder 的知识库 / Repo Wiki，不是 langchain-ai/openwiki。选这个方向的直接原因是实测：`dsh-openwiki` 2.0.5 在本机装得上、两半都激活、请求发得出去，但它必须自带一份 provider key（host 侧只认 `llm-deepseek` / `llm-pi-ai` 两个 namespace 映射出的四类 wire），并且默认对所有工作区开启自动更新、还会往仓库里装一个每日 CI 工作流。前者我们没有额度，后者与"只手动、只提醒"直接冲突。

## 2. 已定决策

| # | 决策 | 代价 | 被否的备选与否决理由 |
| --- | --- | --- | --- |
| D1 | 做进 mneme，作为子系统，不新开发布包 | 投稿目录时 `category` 只能选一个，能力藏在记忆包里不显眼；发版与 mneme 绑定 | 独立插件：要再下一个本地向量模型、再写一遍存储/注入/检索，纯重复 |
| D2 | 同一个包，两条 Cordis 条目（`dsh-mneme` / `dsh-mneme-wiki`） | 装载与 patch 行数增加，需要文档写清可单独禁用 | 单条目：wiki 的 headless 轮一旦卡住会连累记忆库冷启动，本机有"一个坏插件阻塞启动"的前科 |
| D3 | 产物真源是仓库内的 Markdown，不塞 memory 行，自建三张表 | 多一份 schema、多一套迁移 | 走 document 子系统：那边契约是"正文归 agent、机器只维护指针、手工改动下次同步被覆盖"，与 wiki 页的所有权模型正好相反；且 autoDream 会以"长期参考价值低"归档这些行 |
| D4 | 自有格式，不兼容 openwiki 磁盘契约 | 读不了机器上已有的旧 openwiki 产物，蹭不到它的 visualize | 兼容：不用它的引擎却把它的格式当标准，而上游 0.4→0.7.3 已证明格式会漂（`--dry-run` 直接消失） |
| D5 | 两档生成：T0 零 LLM 确定性骨架 + T1 逐模块 headless 会话 | T1 依赖桌面版 headless 会话能跑通（V1 未验） | 一次性 prompt：只能写出"看起来对"的架构描述，答不出结论来自哪个文件；全程 agent 轮：成本不可控、无法断点续跑 |
| D6 | 只手动触发，过期只提示 | 新鲜度靠人记得点 | 自动更新 / git hook / 定时：三者的实测事故与偏好冲突都在 openwiki 那轮验证过了 |
| D7 | 仓库内 `plan.yaml` 做正面控制（白黑名单 + 每页模板 + 作图笔记） | 多一个要校验、要报错体验的配置面 | 只给排除（`.openwikiignore` 式）：vendored 与生成代码会灌出一堆垃圾页且按不住；全自动：模块划分不可控；全手动：一重就是几十页 |
| D8 | 只出中文，术语/文件名/API 名保留原文 | 对外公示要再过一遍 | 中英孪本：token 与体积翻倍，而"两边一起过期"是隐形坑 |
| D9 | 扫描器 v1 只做 JS/TS 的 import 图 | Java/Python 仓库退化为目录启发式 | 四语言全上：等于四个生态各做 40%，最后没有一个仓库能真用；语言无关不做图：分出来的是物理目录不是逻辑模块 |
| D10 | 消费面 = 只读工具 + 开局注入提纲 | 每多一个注入插件就多一份提示词开销，故与 mneme 现有注入合并成一次 | 只给人看：花 token 生成的东西没人读；只注册工具：模型不知道自己不知道 |

## 3. 落点与边界

宿主包：mneme，代码放 `dsh-mneme/src/wiki/`（T0 扫描、分块、生成编排）、`dsh-mneme/src/wiki-client/`（面板）。

复用：同一个 SQLite 文件、同一个本地 embedder（`local-embedder`）、`inject` 里现成的 `llm` / `agentDefaultModel` / `systemPrompt` / `tools` / `commands`、四路召回的检索实现、`slots` 挂载写法。

不复用：memory 行池（wiki 有自己的表）、autoDream 巩固（不碰 wiki 行）、记忆图谱视图（wiki 要的是模块依赖图，语义不同）。

一条硬约束写在这儿而不是实现里：wiki 的任何行都不许进入 `saveWithDedupe` / dream 的候选池，也不许被质量过滤打分。它不是记忆，是文档。

## 4. 磁盘契约

目录：`<repo>/.chorography/`

```
chorography/
  plan.yaml            # 用户所有，机器只读
  index.md             # 机器所有，整文件可重算，逐字节稳定
  modules/<slug>.md    # 页面本体，混合所有权（见下）
  evidence/<slug>.json # 每页的 claims 与出处锚点，机器所有
  state.json           # 最后一次成功运行的 gitBaseline、模块表指纹、模板版本
```

页面 frontmatter（机器写，人不该改）：`slug` `title` `parents` `sourceFiles`（相对路径数组）`gitBaseline` `generatedAt` `templateVersion` `language: zh` `status`（`skeleton` / `enriched` / `stale` / `failed`）。

混合所有权规则，这是整个设计里最容易出事的地方，所以写成可测的：

- 页内 `<!-- CHORO:HUMAN:START -->` … `<!-- CHORO:HUMAN:END -->` 之间的内容重生成时**整块原样回填**，一个字不改；出现多个块按原相对顺序回填。
- 没有标记块时整页覆盖。
- 重生成永远不删标记块，即使 `plan.yaml` 改了模板。
- 人改在标记块之外的内容不保证存活，这是明确语义不是事故，面板上要在"编辑"处提示怎么把一段变成永久保留。

`plan.yaml` 允许键（多一个报错，不许静默忽略）：`include` `exclude`（gitignore 语法）`pages`（`path` `title` `template` `notes` 数组，白名单一旦非空则未列出的模块不建页）`templates`（自定义模板正文，可引用内置）`max_files_per_page`。

改了 `plan.yaml` = 重划边界，触发 T0 全量；没改 = 只处理 baseline 漂移的模块。判据是文件内容 sha256，不看 mtime。

## 5. 数据库 schema

四张表，全部 `choro_` 前缀，与记忆行物理隔离。

- `choro_modules(id, repo_id, slug, title, parent_id, file_count, fingerprint, updated_at)`
- `choro_pages(id, module_id, rel_path, status, git_baseline, template_version, generated_at, human_block_count)`
- `choro_claims(id, page_id, statement, kind, source_path, start_line, end_line, confidence, created_at)`，`kind` 限定 `architecture` / `convention` / `tech-stack` / `setup` / `unknown`
- `choro_vectors(owner_id, dim, model, created_at)`，`owner_id` 指向 `choro_claims` 或 `choro_pages`

出处锚点格式统一 `<相对路径>#L<起>-L<止>`，写页面正文时以 Markdown 行内引用落进去，检索返回时必须能原样还原成锚点，不允许只给章节名。

与记忆共用的只有向量模型本身（`model` 字段要与记忆的 embedder 版本一致，见 V4），表不共用、查询不混。

## 6. 生成生命周期与降级

T0 确定性，零 LLM，必有产出：

1. 读 `plan.yaml`，无则用默认启发式。
2. 列文件：应用 include/exclude，跳过 `node_modules`、构建产物、二进制。
3. 解析 import 图：ESM `import`、CJS `require`、Vue SFC 的 `<script>`、`package.json` 的 workspace 与 `exports`。解析失败的单文件记 skipped 但不中断。
4. 模块划分：目录为初稿，用图的内聚度做合并/拆分，超过 `max_files_per_page` 的再切。
5. 依赖边与外部依赖：内部边 + 按包名聚合的外部依赖表。
6. 建 `modules/<slug>.md` 骨架：文件清单、入口、外部依赖、脚本命令。**这一段完全不花钱**。
7. 写 `index.md` 与 `state.json`。
8. 表落库，状态 `skeleton`。

T1 语义，逐模块花钱，可跳过：

9. 对每个被选中（或被 stale 标记）的模块起一轮 `dsh --profile headless` 会话，注入章程与只读工具（read / glob / grep），工作目录锁在该仓库根。
10. 会话产出该页的架构/约定/技术栈/构建命令四段 + claims 锚点，写回同一文件，状态转 `enriched`。
11. 每模块三重上限：工具调用次数、token、墙钟时间。任一超限即中止该模块。
12. 失败两次即记 `failed`，保留该模块的 T0 骨架不动，继续下一个模块。

降级表：

| 情况 | 行为 |
| --- | --- |
| 仓库不是 git | 拒绝生成并说明原因（锚点无法核验） |
| `plan.yaml` 有未知键 | 整轮不跑，报出键名与允许列表 |
| 某文件 import 解析失败 | 该文件计入清单但不建边，页脚注一行 |
| T1 会话超时/超限 | 该模块 `failed`，骨架保留，其余继续 |
| headless 会话根本起不来 | T1 整档关闭，面板显示"当前只有骨架"并给出关闭原因 |
| 宿主模型不可用 | 同上，不许退化成"模型盲写" |
| 页面被人在标记块外改过 | 覆盖，不提示（语义已定） |
| 磁盘写失败 | 整页放弃，库里状态退回上一次 |

## 7. 消费面

只读工具三个，注册时不带任何写工具：`choro_search`（关键词 + 模块过滤，返回命中小节正文与锚点）、`choro_read_page`（按 slug 给全页）、`choro_module_map`（模块表与依赖边）。

开局注入：会话工作目录匹配到已登记仓库时，注入模块提纲——模块名 + 一句摘要 + 页相对路径，**只注标题级不注正文**。与 mneme 现有 `systemPrompt` 注入合并成一次拼装，避免同一份提示里长两块。档位 `light`（≤8 行）/ `full`（全部模块）/ `off`，默认 `light`，开关在设置页。

面板：`sidebar.panellist` 入口 + `main` 槽同名 key（id 与 key 不同名宿主会抛，这条本机已验证，见 dsh-baleen 的 `src/client/_header.txt:13` 与 `_footer.txt:546`）。打开即在中间主区显示，左侧模块树、右侧正文、顶部按"浏览 / 生成 / 设置"分段。明暗双主题、只消费宿主 token、定稿前先出一版假数据 HTML 预览给人过目。

另立一个后续工作项（不属于本设计范围）：把记忆库入口从 `sidebar.footer.action` 自开页面迁到同样的 panellist + main 形态。

## 8. 红线

1. 不往仓库里写 `.github/`、`.gitignore`、`AGENTS.md` 或任何 CI/hook 配置。要装自动化就让用户自己装。
2. 生成轮永远只读代码，不执行被扫描仓库的任何脚本。
3. 不注册任何写工具给模型。
4. 不要求额外的模型商 key，也不许把 provider key 落到新文件里（宿主凭据留在原处）。
5. 失败不推进 `state.json`，重跑必须幂等。
6. 手工标记块内容一个字都不许改写，包括格式化。

## 9. 测试四层

- 单元：import 解析（ESM/CJS/SFC/workspace 四类 fixture）、模块划分的内聚合并、标记块抽取与回填的字节级一致、`plan.yaml` 校验的未知键报错。
- 集成：T0 在三个 fixture 仓库上产出稳定字节（同一状态两次生成必须逐字节相同，对齐 document 索引那条可重建不变量）；`choro_*` 工具在只读 ctx 下的返回结构。
- 契约：红线六条各配一条断言（尤其"不写 `.github`"和"标记块不改写"）。
- 现场：在 dsh-baleen / dsh-study-desk / mneme 自己三个真实仓库上跑 T0，人工判模块划分对不对（V2），再跑一轮 T1 记成本与失败率。

## 10. 里程碑

- M0：T0 + 四张表 + `plan.yaml` 校验 + CLI 入口，无面板无模型。产出物能 git diff。
- M1：面板浏览 + 三个只读工具 + 检索。
- M2：T1 生成轮 + 成本上限 + 降级路径。
- M3：开局注入 + 过期提示 + `/choro` 指令。
- M4：记忆库入口迁移（另议）。

## 11. 待实测

- V1 桌面版上 headless 会话会不会卡（baleen 的 V2 同题，T1 成立与否全押在这）。
- V2 import 图在三个真实仓库上划出的模块对不对——这是产品成败的判据，只能人工判。
- V3 与宿主现有 `systemPrompt` 注入的先后顺序与体积上限。
- V4 复用记忆的 embedder 时，模型版本是否被记忆侧锁死，换模型会不会让 `choro_vectors` 整体失效。
- V5 `.chorography/` 默认提交进仓库还是加进 `.gitignore` —— **已定（2026-11-05，维护者拍）：走 `.gitignore`**。只忽略目录内容、用 `!.chorography/plan.yaml` 把人工控制表反选回来（忽略整个目录会让白名单失效）；代价如实记：页内 `CHORO:HUMAN` 保留区只在本机存活，`git clean -fdX` 会连它一起删。规则先落在本仓（#572），两个邻仓 baleen / study-desk 同步补上。

## 12. 明确不做

多语言扫描、中英孪本、定时任务与 git hook、Obsidian/Notion 桥、PDF/docx 摄取（那是文档库不是仓库地志）、把 wiki 反向同步成记忆行、任何平台互动。

## 13. 拆 PR

按里程碑一个 PR：M0 骨架 / M1 面板与工具 / M2 生成轮 / M3 注入与指令。不要把 schema 迁移和面板改动混在同一个 PR 里。
