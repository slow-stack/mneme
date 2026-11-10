# 目录归属：哪个目录是什么（#278）

> 先记住这一句，它防的是本项目真实发生过的事故（#278：把模型缓存当成了记忆库）——
>
> **记忆数据在 `~/.dsh/memory`，模型与运行时缓存在 `~/.dsh/mneme`，CLI 连接配置在 `~/.dsh-mneme`。三个名字像、位置也近的目录互不相干。**

本文是落盘面的总账：每个目录是什么、谁拥有（人改还是机器写）、删了会怎样。它是**代码的投影，不是愿望清单**——每个条目都标了出处文件，改动写盘面的 PR 顺手核对本表；发现文档与代码不一致，以代码为准并回来改这里。单个子系统的细节仍归各自的域文档。

## 速查总表

| 根目录 | 是什么 | 谁拥有 | 全删会怎样 |
|---|---|---|---|
| `~/.dsh/memory`（`memoryDir` 默认值） | **记忆库本体**：SQLite 正本 + 镜像 md + 各类本地状态 | mneme 机器写；镜像 md 预期人改 | 见 [§ 记忆库](#记忆库-memorydir默认-dshmemory) |
| `~/.dsh/mneme` | **自管运行时**（transformers + onnxruntime 闭包）与**本地模型缓存**——不是记忆库 | mneme 机器所有 | 可整目录删掉重来（这正是挂在 `~/.dsh/mneme/` 下的设计原意，`src/runtime/layout.js`） |
| `~/.dsh-mneme` | `dsh-mneme` CLI / MCP 的连接配置（`cli.json`：url + token） | 用户 | 删了重新 `dsh-mneme config set` 一次 |
| `~/.dsh`（其余部分） | DSH 宿主的地盘：`sessions/`、`profiles/`、`skills/` 等 | 宿主 | 插件只读 `sessions/` 与 skills 目录，从不写 |
| `<项目>/.mneme/`、`<项目>/.chorography/` | 住用户仓库里的点目录（工作流、仓库地志），随 git 走 | 混合（见 [§ 用户仓库里的点目录](#用户仓库里的点目录)） | 按 git 规矩来 |
| `<os.tmpdir()>/mneme-choro-t1-*` | chorography T1 子进程的临时 overlay | mneme，用完即删 | 无关紧要 |

## 记忆库 `<memoryDir>`（默认 `~/.dsh/memory`）

除「用户仓库里的点目录」与「重运行时」两类例外，mneme 的一切本地状态都宿在 `memoryDir` 下——宿主挂载入口与独立 daemon 都会展开前导 `~` 并在启动时建目录（`src/index.js` / `src/serve.js`），全部路径配置键见 [§ 路径配置键](#路径配置键一张表)。这不是随意的堆放：写盘纪律是**「删掉插件的目录就回滚干净」**（`src/diary/dir.js`、`src/candidates.js`、`src/pipeline-observations.js` 三处注释同一条纪律）——记忆库不在了，用户的仓库里不该留下任何 mneme 的痕迹。

| 落点 | 内容 | 拥有者 | 出处与备注 |
|---|---|---|---|
| `memory.db`（+ `-wal` / `-shm`） | **唯一正本**：记忆行、实体三表、dream_runs / recall_runs / 审计表、`user_settings` 等 kv | 机器；**绝不手改** | `src/store.js` |
| `*.md`（十个，见下） | 磁盘镜像，按 type 一文件 | 机器写、**人可改**（`documents.md` 例外：只读） | `src/mirror.js`（`TYPE_FILE`）；**在 memoryDir 根上平铺，没有 `mirror/` 子目录** |
| `candidates/<项目键>/cand-*.json` | M.O. 绕行候选（草稿层） | 机器 | `src/candidates.js`；「候选层跟 memoryDir 一样是本地状态，不是仓库内容」——升格进仓库要人批 |
| `proposals/<项目键>/nudge-*.json` | 模式挖掘提议（比定稿松一档） | 机器 | `src/pipeline-nudge.js`；人的 counterfactual verdict 是唯一升格闸门 |
| `observations/<项目键>/<工作流id>.jsonl` | 观察旁挂（append-only 账本） | 机器 | `src/pipeline-observations.js`；只记 `{key, count, flags}`，**命令原文拒绝入内** |
| `diaries/<项目键>/YYYY-MM-DD.md` | 日记正文 | 用户的话，机器代笔 | `src/diary/dir.js` + `compose.js`；同目录 `runs.jsonl` 是「今天为什么没有日记」的审计账本 |
| `diaries/state.json` | 桶账本（桶键 → 项目根 / agent / chatId） | 机器 | `src/diary/compose.js`；面板日记本清单靠它反查项目 |
| `documents/`（+ `index.md`） | document 型记忆的 managed 落盘目录 | `index.md` 机器所有（删掉重启即逐字节重建，`src/document-index.js`）；**目录里其余文件 agent 所有，mneme 对正文零读零写零改** | `src/document.js`；`documentDir` 可改 |
| `../media/onebot/qq-inbox*.jsonl`（邻座） | QQ 收件箱，日记素材 | **外部**（onebot 写）；插件只读 | `src/diary/qq-inbox.js`；`diaryInboxDir` 可改，推出不来就报错、绝不猜别的位置 |

镜像的十个文件名（`src/mirror.js` 的 `TYPE_FILE`）：`preferences.md`、`projects.md`、`decisions.md`、`history.md`、`summary.md`、`pitfalls.md`、`constraints.md`、`rejected-solutions.md`、`patterns.md`、`documents.md`。它是**唯一预期用户手改的落点**：手改在每次镜像同步时经 `mirror-digest` 三方合并写回库（人改赢）；`documents.md` 是 document 型的只读指针视图，没有可编辑正文，手改一律被下次同步覆盖。

**别把 memoryDir 放进宿主的 profile 目录**：profile 被清理或迁移时记忆库会连带丢失（#218 的真实事故）。命中 profile 作用域时启动会告警（`src/index.js`，启发式边界见 `src/placement.js`）——只提示、不搬库。

## 运行时与模型缓存 `~/.dsh/mneme`（不是记忆库）

这里只有两样东西，全部机器所有、**可以整目录删掉重来**——`src/runtime/layout.js` 的注释原文就是「便于用户整个删掉重来」：

| 落点 | 内容 | 出处与备注 |
|---|---|---|
| `runtime/<payloadId>/` | 自管运行时：`mneme-runtime.json` 清单 + 扁平 `node_modules/` 依赖闭包（transformers + onnxruntime + sharp） | `src/runtime/{layout,adopt,download,loader}.js`；payloadId 形如 `transformers-<版本>-node-<平台>-<架构>`；存在理由是把约 200MB 的原生闭包挪出宿主 profile 的共用依赖图（#131）。daemon 可用 `DSH_MNEME_RUNTIME_DIR` 改 |
| `models/<org>/<model>/` | 本地模型缓存（embedder / reranker / verify 三方共用同一份，唯一字面量在 `defaultModelCacheDir`） | `src/local-embedder.js`；`embedModelCacheDir` 可改（[LOCAL_MODEL.md](LOCAL_MODEL.md)） |
| `models/.mneme-partial/` | 断点续传的分片暂存 | `src/runtime/model-fetch.js`（#194）；装完即清 |

细节与排障见 [LOCAL_MODEL.md](LOCAL_MODEL.md)（收编、校验、镜像源）。

## 用户仓库里的点目录

这些目录长在用户项目里、随 git 提交——「能 PR、能 review、能整版回退」是它们不住记忆库的理由（`src/pipeline.js`）：

| 落点 | 内容 | 拥有者 |
|---|---|---|
| `<项目>/.mneme/pipelines/*.json` | M.O. 项目层工作流 | **人写**；机器只补 `status:"draft"` 的新文件、绝不覆盖已有文件（`src/pipeline-nudge.js`：「已经在人手里的文件不能被机器改写」） |
| `<项目>/.mneme/pipelines/<id>.runs.jsonl` | 工作流运行账本 | 机器（`src/pipeline-runs.js`；与手写 json 分开是为了人改不被账本淹没） |
| `<项目>/.chorography/` | 仓库地志：`plan.yaml`（用户所有，**机器只读**）、`index.md`、`modules/`、`evidence/`、`state.json`（机器产物，可重跑 T0/T1 再生成） | 混合；写路径被机械断言钉在 `.chorography/` 内——T0 是 `assertInsideChoro`（`src/wiki/t0.js`），T1 复用同一语义、越界抛 `write-outside-chorography` 拒收（`src/wiki/t1.js`） |
| `<项目>/diary/` | 日记导出（用户在面板点「存到这个项目」才出现；复制不移动） | 用户 |

包内 `pipelines/` 是工作流的全局兜底层，**发布包里今天没有它**（目录为空即不进包）——「一条工作流该不该跨项目用，得是一个人说出来的动作」。

只读扫描（插件只读不写）：`.git`、`.github/workflows/`、`README*` / `CONTRIBUTING*`、`package.json`（冷启动 `src/bootstrap.js`）；`.dsh/skills/`、`.agents/skills/`（能力发现 `src/capabilities.js`）。仓库扫描刻意跳过一切点目录——里面常是提问原文、调试快照与第三方工具缓存（`src/wiki/scan.js`）。

## 宿主侧只读输入 `~/.dsh`

- `<DSH_HOME>/sessions/<工作区桶>/session*.jsonl.zstd`——会话转录，宿主写、插件只读（`src/session-usage.js`；`DSH_HOME` 环境变量推导，**仓库里出现盘符是红线**）。蒸馏、M.O. 挖掘与日记素材都从这里来。
- `~/.dsh` 这个目录本身可能只是 `mkdirSync(memoryDir)` 的副作用产物——默认配置下建 `~/.dsh/memory` 时顺带建的。

## CLI 配置、临时文件与包内只读资源

- `~/.dsh-mneme/cli.json`——`dsh-mneme config set` 写、CLI 与 MCP server 读（`bin/cli.mjs`；MCP 本身不写任何文件）。**它与 `~/.dsh/mneme` 无关**，差一个斜杠。
- `<os.tmpdir()>/mneme-choro-t1-*/`——T1 子进程的临时 overlay，跑完即删（`src/wiki/t1.js`）。
- 原子写会产生与目标同目录的 `<目标>.tmp-<pid>-<rand>` 兄弟文件，崩溃时自清（`writeFileAtomic`）。
- 分享包**没有固定目录**：`dsh-mneme share --out <path>` 由人指定落点（`bin/cli.mjs`）。
- 包内只读资源：`runtime-manifest.json`（下载清单）、`locale/`（宿主面板注入槽）、`assets/icon.svg`。daemon 无 pid / socket / 日志文件——HTTP 是 TCP，审计都在 `memory.db` 里。

## 删了会怎样

| 对象 | 能否安全删 | 后果 |
|---|---|---|
| `memory.db` | **不能** | 记忆正本，不可重建；备份就备份它（冷备整文件，含 `-wal` 时先停写） |
| 镜像 `*.md` | 能，但先想一下 | 下次同步从库重建；**尚未合并进库的手改会随文件一起丢**——有未合并编辑时先让它同步一次 |
| `documents/index.md` | 能 | 启动自愈，逐字节重建 |
| `candidates/` `proposals/` `observations/` | 能 | 草稿与 M.O. 证据没了，库与检索不受影响 |
| `diaries/` | **不能** | 那是用户自己的日记，任何地方都没有第二份；库里的 document 指针行会悬空 |
| `documents/` 里 agent 的文件 | mneme 不管 | 管线对正文零读零写；注册后再没有任何地方读它，删了也没有检测点——指针行悬空而已 |
| `~/.dsh/mneme` 整目录 | 能 | 重启后按需重下 / 重收编，代价是时间与流量 |
| `.mneme/` `.chorography/` | 按 git 规矩 | 机器产物可重跑再生成；`plan.yaml` 别随手删——删了就是回默认启发式 |
| `~/.dsh/sessions/` | 不归插件管 | 宿主的数据，别以插件的名义动它 |

## 路径配置键（一张表）

| 键 | 默认（空串语义） | `~` 展开 | 出处 |
|---|---|---|---|
| `memoryDir` | `~/.dsh/memory` | 展开 | `src/config.js`、`src/index.js` |
| `documentDir` | `<memoryDir>/documents/` | 展开；相对路径落 memoryDir 下 | `src/document.js`（#296） |
| `diaryDir` | `<memoryDir>/diaries/` | 展开；相对路径落 memoryDir 下 | `src/diary/dir.js` |
| `diaryInboxDir` | `<memoryDir>/../media/onebot` | 展开 | `src/diary/qq-inbox.js` |
| `embedModelCacheDir` | `~/.dsh/mneme/models` | **不展开，指别处写绝对路径** | `src/local-embedder.js` |
| `runtimeDir` | `~/.dsh/mneme/runtime`（daemon 另认 `DSH_MNEME_RUNTIME_DIR`） | **不展开** | `src/runtime/layout.js` |
| `runtimeTarballDir` | 空 = 不启用离线取件 | 不展开 | `src/runtime/download.js` |

全键语义见 [CONFIGURATION.md](CONFIGURATION.md)。

## 已知坑

1. **两个 CLI 的默认落点各站一边**：`dsh-mneme-choro.mjs` 的 `--db` 默认指 `~/.dsh/memory/memory.db`（数据侧），`scripts/mneme-runtime.mjs` 动的是 `~/.dsh/mneme`（运行时侧）。
2. **`documents.md` 与 `documents/` 是两回事**：前者是镜像里 document 型的只读指针视图（一个文件，在 memoryDir 根上）；后者是 managed 文档目录（一个目录，装 agent 的正文）。
3. **镜像手改的窗口**：人改在同步时赢，但只对有可编辑正文的 type 生效；`documents.md` 与镜像排除集（如未来新增的排除 type）里的手改一律被覆盖。
4. **路径键的展开规则不一致**（见上一节表）：`memoryDir` 一族做 `~` 展开与相对回落，模型 / 运行时一族不做——拿着 `~/models` 这类值去配 `embedModelCacheDir` 会得到一个字面叫 `~/models` 的目录。
5. **`<workspace>/.mneme/` 的记忆投影不存在**：#17 §五与 #278 早期讨论里提过「工作区投影」的草稿，那是未排期的设想；今天 `.mneme/` 里只有工作流与运行账本。`~/.dsh` 迁出与统一导出同样是 #278 里尚未落地的两个子项（大活，独立拆批）。
