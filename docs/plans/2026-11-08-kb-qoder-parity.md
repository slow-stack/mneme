# 知识库对齐 Qoder（v1）实现计划 —— 车道 kb-qoder / 分支 feat/kb-qoder-parity

依据：issue #607（面板文案把 CLI 当人可以执行的命令、空态无操作入口、开关位置未说明）
+ 桉桉 2026-11-08 决定「整个照 Qoder 补齐」（Repo Wiki 自动更新 / 自动导出 / T1 一键生成 / AI-Native 知识库第二层）。

基线：origin/main @ 7461768。本车道从它开分支，**不基于本地 main**（本地 main 落后 65 个提交）。

## 一、Qoder 四个能力 → 本仓的落点

| Qoder 面 | 本仓现状 | v1 做什么 |
| --- | --- | --- |
| Repo Wiki 一键生成 | T0 秒级已有、T1 只能 CLI | 面板空态/浏览态都能一键跑 T0；**T1 改成面板发起的后台任务**（轮询进度） |
| 自动更新（代码变→增量更新） | 无，只有 state.json 过期标记 | `chorographyAutoRefresh` 开：读侧发现 fingerprint/git HEAD 变了就**自动重跑 T0**（零模型），带冷却 |
| 自动导出到 `.qoder/repowiki` | **天然满足**——真源本来就在 `<repo>/.chorography/` 的 Markdown 里 | 不加开关，文档里说清「我们本来就是仓库内真源」，面板加一行说明 |
| AI-Native 知识库（第二层：文件/网页 → 供 agent 检索） | **完全没有** | 新增 `src/kb/`：集合 + 文档入库（本地文件 / 网页 / 仓库地志页）+ 分块 + BM25 检索 + 三只读工具 + 面板页 |

## 二、车道划分（写作用域互不相交，谁也别碰别人的文件）

```
A 线 接线 + choro 后端     src/config.js src/settings.js test/api.test.js
                          src/api.js src/index.js src/tools.js
                          src/wiki/*.js src/choro-command.js bin/dsh-mneme-choro.mjs
                          test/wiki-*.test.js test/choro-command.test.js test/tools*.js
B 线 知识库子系统           src/kb/*.js（新建） src/store.js
                          test/kb-*.test.js docs/KB.md（新建）
C 线 面板                   lib/client.js test/client*.test.js test/contrast.test.js
```

**B 线不许改** api.js / tools.js / index.js / config.js / settings.js——那四个文件的接线由 A 线按本文档的契约做，最后由 Lead 复核。
**C 线只许改** client.js 与面板侧测试。

## 三、冻结契约（三条线按此实现，不再互相商量）

### 3.1 配置键（A 线负责加进 config.js + settings.js 白名单 + test/api.test.js 旗标计数锁）

| 键 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `chorographyAutoRefresh` | boolean | `false` | 读侧发现仓库变了就自动重跑 T0（零模型）；关=行为与现在逐字节一致 |
| `chorographyT1FromPanel` | boolean | `true` | 面板是否允许发起 T1 后台任务（T1 花模型额度，故单独一闸；总闸仍是 chorographyEnabled） |
| `kbEnabled` | boolean | `false` | 知识库第二层总闸：工具不注册 / 路由 409 / 面板页空态 |

全部进 `FEATURE_FLAG_BOOLEANS`；都不进 `LIGHT_MODE_OFF`（理由同 chorographyEnabled：是「开不开子系统」不是「每轮付多少」）。`test/api.test.js` 的旗标计数锁 +3。

### 3.2 choro 路由（A 线；全部 `policy: "token-write"`，都过 `choroGate`）

```
GET  /api/dsh-mneme/choro/repos
  → 200 { repos: [{ id, name, rootPath, modules, pages, claims, legacy,
                    stale: boolean, staleReason: "git"|"plan"|null, lastRunAt }] }

POST /api/dsh-mneme/choro/run          （已有，扩容不破约）
  body { repo?: string|number, refresh?: boolean }
  → 200 { ok:true, autoRefreshed?:boolean, receipt:{...} }

POST /api/dsh-mneme/choro/t1
  body { repo?: string|number, module?: string, retryFailed?: boolean }
  → 200 { jobId: string, started: true }        // 立即返回，后台跑
  → 409 { error:"disabled" }                    // chorographyT1FromPanel=false
  → 409 { error:"job-running", jobId }          // 同 repo 已有任务

GET  /api/dsh-mneme/choro/t1/status?jobId=<id>
  → 200 { jobId, repo, state:"running"|"done"|"failed",
          startedAt, finishedAt?, modules:{total,done,failed},
          logTail: string[], error? }
```

T1 任务实现：spawn `process.execPath` + `bin/dsh-mneme-choro.mjs --t1 --json`（Windows 下 `ELECTRON_RUN_AS_NODE` 只在 headless 轮里需要，CLI 自己处理），
stdout 逐行收进 ring buffer（上限 200 行），进程退出码落 state。**不写文件之外的东西、不改 state.json 语义**（沿用既有的失败不推进）。

### 3.3 知识库数据结构（B 线，store.js 幂等迁移；照本仓 PRAGMA 检查 + CREATE TABLE IF NOT EXISTS 惯例）

```sql
kb_collections(id, key TEXT UNIQUE, title, description, created_at, updated_at)
kb_docs(id, collection_id, rel_key TEXT, kind 'file'|'url'|'choro_page',
        source_path, title, bytes, sha256, indexed_at, status 'ok'|'error', error)
   UNIQUE(collection_id, rel_key)
kb_chunks(id, doc_id, ordinal, heading, text, created_at)
   INDEX(doc_id, ordinal)
```
幂等：同一 `rel_key` + 同 `sha256` 重入库是 no-op（回执 `skipped`），变了才替换 chunks。
**不碰 `memories` 表、不进巩固/质量过滤任何行池**（与 wiki 行同一条物理隔离纪律）。

### 3.4 知识库模块出口（B 线必须导出，A 线按此接线）

```js
// src/kb/index.js
export function createKb({ store, embedder, cfg })  // → kb 对象
kb.listCollections() -> [{ key, title, description, docs, chunks, updatedAt }]
kb.upsertCollection({ key, title, description })
kb.deleteCollection(key) -> boolean
kb.ingest({ collection, kind, source, title? }) -> { docId, chunks, skipped, error? }
kb.search({ query, collection?, limit }) -> { hits: [{ collection, relKey, title, heading, line, excerpt }], unreadable: [] }
kb.readDoc({ collection, relKey }) -> { title, content }
kb.dispose()
// src/kb/routes.js
export function registerKbRoutes(register, { kb, cfg, sendJson, readBody, parseBody, gate })
// src/kb/tools.js
export function kbToolDefinitions({ kb, cfg }) -> [defineTool-compatible 描述对象数组]
```

工具三个：`kb_list_collections` / `kb_search` / `kb_read_doc`，全只读，`kbEnabled` 关着时 A 线一个都不注册。

A 线接线点（三处，各不超过 10 行）：
1. `src/index.js`：`kbEnabled` 为真时 `createKb(...)` 并塞进给 `createApi` 的 deps；工具注册处按 `kbToolDefinitions` 逐个 define。
2. `src/api.js`：`registerKbRoutes(routes.register, { kb, cfg, sendJson, readBody, parseBody, gate: kbGate })`，`kbGate` 关→409 `kb-not-enabled`，kb 未装配→503。
3. `src/tools.js`：只在 `kbEnabled` 时把 `kbToolDefinitions` 展开进返回数组。

### 3.5 面板契约（C 线）

- **607 修复**：空态（`phase==="no-repo"`）渲染「选择仓库目录 → 生成」按钮，直接 POST `/choro/run`；文案改写：说明这是 **mneme 插件**的「仓库地志」、开关在 **设置 → 记忆(mneme) → 功能 → 仓库地志**、命令要给**绝对路径**示例（`node "<profile>/node_modules/@modusensus/dsh-mneme/bin/dsh-mneme-choro.mjs" "<仓库路径>" --apply`），**不要说 cd**。
- **choro 页**：顶部两枚开关（自动更新 = `chorographyAutoRefresh`、面板可发起 T1 = `chorographyT1FromPanel`）；「补语义正文（T1）」按钮 → POST `/choro/t1` → 按钮进 running 态、轮询 `/choro/t1/status`（2s），完成 toast + 刷新模块树；`stale` 时行内显示「代码已变」标记。
- **知识库页**：左侧集合列表（建/删）、右侧文档列表（入库：本地路径 / URL / 从地志页导入）；空态文案照 607 的教训写清「这是什么、属于哪个插件、在哪开」。
- 所有文案中英双语同键成对；颜色只用 `--mneme-*` 语义层，`test/contrast.test.js` 必须绿。

### 3.6 知识库路由路径表（2026-11-08 裁决，C 线提问触发）

路径按 C 线提的方案定案，B 线 routes.js 与 C 线面板都以这张表为准，**不再各自猜**：

```
GET    /api/dsh-mneme/kb/collections                       → 200 { collections:[{key,title,description,docs,chunks,updatedAt}] }
POST   /api/dsh-mneme/kb/collections    body {key,title,description} → 200 { ok:true, key }
DELETE /api/dsh-mneme/kb/collections?key=<key>             → 200 { ok:true, deleted:boolean }   // key 走 query，路径里塞含斜杠的 key 太脏
GET    /api/dsh-mneme/kb/docs?collection=<key>             → 200 { docs:[{relKey,kind,title,bytes,indexedAt,status,error}] }
POST   /api/dsh-mneme/kb/ingest         body {collection,kind,source,title?} → 200 { ok,docId,chunks,skipped,error? }
POST   /api/dsh-mneme/kb/search         body {query,collection?,limit?}      → 200 { hits:[...],unreadable:[] }
GET    /api/dsh-mneme/kb/doc?collection=<key>&relKey=<rel> → 200 { title,content }
```

policy：读路由（collections 的 GET / docs / doc）= `token`；写路由（collections 的 POST/DELETE、ingest、search）= `token-write`。全部过 `kbGate`（cfg.kbEnabled !== true → 409 `{error:"disabled",reason:"kb-not-enabled"}`；kb 未装配 → 503）。

**kb 对象补一个方法**（C 线文档列表的数据源，原 §3.4 七法漏了）：

```js
kb.listDocs({ collection }) -> [{ relKey, kind, title, bytes, indexedAt, status, error }]
```

## 四、纪律（三条线都读）

- opt-in 默认关 + settings 白名单；改 `src/` 不手改 `lib/`（Lead 最后统一 `npm run sync`）；`lib/client.js` 例外，只在 lib 里改。
- 注释写「为什么」；测试名说清防哪类回归。
- 提交不得有 AI/Bot 署名，`modusensus / guanqishi26@gmail.com`；**不 push、不碰 main**。
- 本机私有路径不准进公开文件。
- 每条线自己跑自己那部分测试，全绿再交；交付时报告：改了哪些文件、测试命令与结果、没做完的点。