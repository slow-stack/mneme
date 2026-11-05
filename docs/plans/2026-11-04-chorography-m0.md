# chorography M0 实现计划（车道 choro / 分支 feat/chorography-m0）

对应 spec：`docs/specs/2026-11-04-chorography-design.md`（本车道首个 commit 5fa0f12）。
范围只到 spec §10 的 M0 档：**T0 确定性骨架 + 表 + plan.yaml 校验 + CLI 入口，无面板、无模型、无注入**。
M1+（面板、只读工具、T1 headless 轮、注入）不在本计划内。

## 已定实现决策（spec 之外的补口）

| # | 决策 | 理由 | 被否备选 |
| --- | --- | --- | --- |
| P1 | 新增运行时依赖 `yaml`（唯一一个） | plan.yaml 是用户手写的正面控制面，spec 降级表要求「未知键整轮不跑 + 报出键名与允许列表」——手写 YAML 子集解析器会在注释/锚点/多行字符串上静默错解，错解直接违背 D7 的存在理由 | 手写子集解析器：省一个依赖，换来用户配置被静默错解的永续风险 |
| P2 | 表是五张不是四张：spec §5 的四张 + `choro_repos` | spec 的 `choro_modules.repo_id` 必须指向一个仓库登记行；多仓库共存（消费面 §7「按工作目录匹配已登记仓库」）也要求登记表 | 把 root_path 反规范化进 modules：多仓库唯一性与改名都要靠约定 |
| P3 | T0 前端 frontmatter 不含生成时刻列，`generatedAt` 只进 state.json 并由下次 run 沿用 | spec §9 的字节稳定不变量（同状态两次生成逐字节相同）与「每页记生成时刻」直接冲突；把时刻收进 state.json（失败不推进，红线 5）两头都成立 | 放弃字节稳定不变量：那是对齐 document 索引可重建性的锚，不能放 |
| P4 | CLI 独立成 `bin/dsh-mneme-choro.mjs`，不动 `bin/cli.mjs` | CONTRIBUTING「The CLI is dependency-free by contract」禁止给 cli.mjs 加 import；T0 可离线（零 LLM、不开 daemon），循 `dsh-mneme-serve` 的独立 bin 先例 | 挂 cli.mjs 子命令：违约；走 standalone API：把「可离线」变成「必须先起服务」 |
| P5 | CLI 缺省 dry-run，`--apply` 才写 | 仓库纪律（`dsh-mneme reclaim` 同款）：会写盘的东西先给数字再执行；T0 幂等可重跑，dry-run 零成本 | 直接写：与「产出物能 git diff」的人工复核流冲突 |
| P6 | 保留区（`<!-- CHORO:HUMAN -->` 块）回填位置 = 页尾按原相对顺序 | 重生成后的新正文里，旧块的原锚点位置可能已不存在；「页尾 + 原顺序」是唯一不需要猜测位置的确定性规则 | 原位回填：需要位置映射，模板一改就对不上 |
| P7 | DB 写入是「整仓替换」不是逐行 upsert | 「重跑必须幂等」（红线 5）在替换语义下是删了重插一个事务，不用逐行对账 | 逐行 upsert：模块划分一变就留下孤儿行，还要写清理逻辑 |

## 里程碑内步骤

1. `store.js`：五张 `choro_*` 表进 SCHEMA（幂等，`CREATE TABLE IF NOT EXISTS`；唯一性走独立索引，本仓惯例）+ 三个方法（查/登仓库、整仓替换图）。
2. `src/wiki/plan.js`：plan.yaml 加载 + 严格校验（未知键/类型错/缺 path 全部收集后一次报出；无 plan.yaml 用默认启发式）。
3. `src/wiki/scan.js`：文件清单（默认排除目录 + gitignore 子集匹配 + 二进制跳过）+ import 图（ESM 静态/动态、CJS require、Vue SFC `<script>`、workspace/exports；解析失败记 skipped 不中断）。
4. `src/wiki/partition.js`：目录初稿 → 兄弟组交叉边合并 → 超 `max_files_per_page` 逐级下切；slug 稳定生成；父子关系按目录包含。
5. `src/wiki/render.js`：骨架页 + index.md 渲染（全排序、零时间戳于正文；`generatedAt` 从 state.json 沿用）；保留区抽取/回填（字节级）。
6. `src/wiki/t0.js`：编排（git 基线 → plan → 扫描 → 划分 → 渲染 → dry-run 报告 / apply 写盘 + 落库 + state.json 收尾）；所有写路径断言在 `.chorography/` 前缀内（红线 1 的机械面）。
7. `bin/dsh-mneme-choro.mjs` + `package.json` bin 注册。
8. 测试（`node --test`）：
   - `wiki-plan.test.js`：未知键拒绝且报键名与允许列表、默认启发式、pages 形状错。
   - `wiki-scan.test.js`：ESM/CJS/动态/Vue SFC/workspace 六类 fixture、外部依赖聚合、unresolved 计数、exclude 匹配。
   - `wiki-partition.test.js`：同输入两次划分逐项相同、合并与下切、slug 稳定。
   - `wiki-t0.test.js`：dry-run 零写入（树快照对比）；apply 后**仓库里除 `.chorography/` 外一个字节不变**（红线 1 的契约测试）；两次 apply 字节相同（可重建不变量）；保留区逐字节存活；非 git 拒绝。
   - `wiki-store.test.js`：表存在性（新库）、整仓替换幂等（跑两遍行数不翻倍、唯一索引生效）。

## 明确不做（M0 边界内）

向量写入（`choro_vectors` 空壳建表不灌数据，embedder 是 M1/M2 的事）、
evidence/ 文件（T0 零 claims，M2 才有）、stale 检测（M3）、面板与只读工具（M1）、
任何配置键与行为开关（M0 不碰宿主运行时行为，故 AGENTS.md 自查清单第 1/2 条不适用）、
README（readme-claims 锁的存在使新增能力声明要配证据，M1 一起写）。

## 待实测回填

V2（import 图在三个真实仓库上的模块划分准不准）跑法：M0 收尾后对
dsh-baleen / dsh-study-desk / 本仓各跑一次 `--apply`，人判划分；结果记回本文件。

### V2 结果（2026-11-05 实测，临时 DB，三仓 `.chorography/` 已落盘待人判）

- **dsh-baleen**（175 文件）：默认启发式 15 模块——代码模块形状正确
  （lib-adapters 7 文件 6 边 / src-client 16 文件 21 边 / test 40 文件），
  但 9 个是会话产物目录（superpowers-sdd-* ×5、docs×2、.qoder-credits）。
  写 plan.yaml（include: src/lib/test*/package.json）重跑 → **8 模块全代码**，
  正控演示成立（D7 的存在理由被证实：目录初稿没有能力分辨「代码」与「躺在
  仓库里的会话产物」）。
- **dsh-study-desk**（58 文件）：5 模块里 3 个是 .shots / .v2c / .qoder-credits
  ——同理收口。点开头目录默认不排除（.shots 可能是截图资产，属用户资产不是
  垃圾），是否把「明显会话产物的 dot 目录」进默认排除表**留给维护者拍**。
- **mneme 本仓**（460 文件 → 38 模块）：lib/ 与 src/ 互为 sync 副本，默认扫描
  全部翻倍（lib 40+29 续、src 40+28 续）——本仓用 plan.yaml 必须排除 lib/
  （或 src/）；超限切块（-2 续）是字典序不是语义，靠 include 收窄或调
  max_files_per_page。结论：**文档没有发现划分算法错误，发现的是默认启发式
  的固有边界——正面控制（plan.yaml）就是为这个边界存在的**。
