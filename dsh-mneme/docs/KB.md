# 知识库（Knowledge base，第二层）

给 agent 一个「用户自己的参考资料」检索面：本地文件、网页、仓库地志页进来，分块后用 BM25 检索。
与记忆库（第一层）**物理隔离**——它不是记忆，不参与注入、不参与巩固、不参与质量过滤。

## 职责边界

**它是**：一个只读给模型的语料检索面（三个只读工具）+ 一组面板可管理的集合/文档（写路由）。
**它不是**：文件的真源、向量库、记忆库的旁支。

- 真源在 SQLite 的 `kb_*` 三张表里，**不在磁盘上**。用户随时可能把原文件挪走或删掉，
  检索面不能跟着消失——所以 `readDoc` 从库里拼回正文，读侧零 IO（`src/kb/index.js` 顶部有同样的话）。
- 与 chorography 的区别：地志以盘上的 MD 为真源（重扫即重建），知识库收的是外来原文的副本。
- **绝不写 `memories`**，也绝不进 `saveWithDedupe` / `dream` / 质量过滤的任何行池。
  这条与 wiki 行同源，是 §3.3 的红线；`test/kb-collections.test.js` 第一条用例钉它。

## 对外接口

### 程序面（`src/kb/index.js`）

```js
const kb = createKb({ store, embedder = null, cfg = {} });
```

| 方法 | 形状 |
|---|---|
| `listCollections()` | `[{key,title,description,docs,chunks,updatedAt}]` |
| `upsertCollection({key,title,description})` | `{key,title,description}`；同 key 再调 = 改名，`created_at` 不动 |
| `deleteCollection(key)` | `boolean`；连带删它的文档与分块（一个事务，不留孤儿行） |
| `listDocs({collection})` | `[{relKey,kind,title,bytes,indexedAt,status,error}]` |
| `ingest({collection,kind,source,title?})` | `{docId,chunks,skipped,error?}` |
| `search({query,collection?,limit?})` | `{hits:[{collection,relKey,title,heading,line,excerpt,score}],unreadable:[]}` |
| `readDoc({collection,relKey})` | `{title,content,kind,relKey,status,error}` 或 `null` |
| `dispose()` | 清索引缓存；可重复调用，不丢数据 |

`kind` 三选一：`file` / `url` / `choro_page`。`url` 走 `fetch`；`choro_page` 的 `source`
就是该地志页 MD 的**绝对路径**，读取路径与 `file` 完全一致——不为它去跨域读 `choro_*` 表，
那会把两条线的写作用域搅在一起。

### HTTP 面（`src/kb/routes.js`，契约 §3.6）

| 方法 | 路径 | policy |
|---|---|---|
| GET | `/api/dsh-mneme/kb/collections` | `token-write`（与 POST/DELETE 同路径，取更严的） |
| POST | `/api/dsh-mneme/kb/collections` `{key,title,description}` | 同上 |
| DELETE | `/api/dsh-mneme/kb/collections?key=<key>` | 同上 |
| GET | `/api/dsh-mneme/kb/docs?collection=<key>` | `token` |
| GET | `/api/dsh-mneme/kb/doc?collection=<key>&relKey=<rel>` | `token` |
| POST | `/api/dsh-mneme/kb/ingest` `{collection,kind,source,title?}` | `token-write` |
| POST | `/api/dsh-mneme/kb/search` `{query,collection?,limit?}` | `token-write` |

`/kb/collections` 一条路径上读和写混着，只能声明一个 policy，取更严的 `token-write`
（与 `/profile` 同款）。`register` 对同一 `kind+path` 重复登记直接抛错，所以不能拆两条。

**状态码语义**（面板据此渲染，改之前先想清楚空态）：

- `409 {error:"disabled",reason:"kb-not-enabled"}` — 开关没开。判定在 `src/api.js` 的 `kbGate`，
  本模块**不自己判** `cfg.kbEnabled`（一处判定，不两处分叉）。
- `503 {error:"unavailable"}` — 开了开关但 kb 没装配（headless / 测试）。#497 先例：503 = 环境缺件，409 = 用户没开。
- `404 {error:"collection-not-found"}` — 入库目标集合不存在。**不静默建集合**：拼错的 key
  会把资料塞进一个凭空出现的集合，用户永远找不到。
- `404 {error:"doc-not-found"}` — 读整篇查不到。
- `400` — 缺必填字段 / `bad-kind` / `query-required`。
- 入库**来源级**失败（`file-not-found` / `too-large` / `http-404` …）回 **200 + `ok:false` + `error`**，
  不是 4xx。理由：`kb_docs` 里已经落了 `status='error'` 的留痕行，面板要能显示「这份为什么没进来」；
  回 4xx 会让面板把它当成「请求本身错了」而丢掉那条记录。

### 模型面（`src/kb/tools.js`）

三个**只读**工具，返回 `defineTool()` 兼容的描述对象数组，由 `src/tools.js` 在
`kbEnabled` 为真时展开进自己的数组（本文件不 import `defineTool`，装配顺序与开关归调用方）：

- `kb_list_collections` — 集合清单 + 文档/分块数。
- `kb_search` — BM25 检索，回 `collection/relKey/heading/line/excerpt`。
- `kb_read_doc` — 按 `collection + relKey` 读整篇。

写操作一个都不给模型：建集合、入库都是用户在面板上按的按钮。知识库收的是用户自己的资料，
模型不该有权决定往里塞什么（与 chorography「生成只走 CLI」同一条红线）。

## 内部文件

- `src/kb/index.js` — `createKb`、切块（`chunkContent`）、检索（`search`）、读整篇。
- `src/kb/routes.js` — `registerKbRoutes`，七个 handler 全在这里。
- `src/kb/tools.js` — `kbToolDefinitions`，三个工具描述对象 + render。
- `src/store.js` — `kb_collections` / `kb_docs` / `kb_chunks` 三张表与十个 `kb*` 方法
  （`kbCollectionByKey` / `listKbCollections` / `upsertKbCollection` / `deleteKbCollection` /
  `listKbDocs` / `kbDocByRelKey` / `kbChunksByDoc` / `replaceKbDoc` / `markKbDocError` /
  `kbChunksForSearch`）。
- `test/kb-collections.test.js` — 建表/集合/幂等/重切块/检索/readDoc/失败留痕/dispose。
- `test/kb-routes.test.js` — 路由表形状/policy/状态码/工具描述对象。

## 已知坑（都是踩过或刻意设计成这样的）

1. **切块必须严格按行连续、一个空行都不剥**。这是 `readDoc` 能逐字节还原原文、以及
   `search` 能回算准确行号（起始行 = 1 + 前面所有块的行数）的**共同前提**。破坏它两件事一起坏。
   空行不产生 token，对 BM25 的 `len` 分母零成本，剥它纯赔。
2. **幂等判据是正文 sha256，不是 mtime / size**。同 rel_key + 同 sha256 = 整件事 no-op
   （回执 `skipped:true`，`chunks` 是库里现有块数）。否则编辑器保存一次（mtime 变、内容没变）
   就要全量重切块，库和索引一起白忙。上一版 `status='error'` 的行不算命中——重来必须真跑。
3. **`## ` 是唯一的节边界**。一级标题 `# ` 不切节，它属于文件头那一块。这就是为什么
   `## 部署` 那块的起始行是标题自己的行号，而不是上一行。
4. **不带 `return` 的 `readBody().then(...)` 会吞掉回执**。handler 里凡是异步的那几条
   （collections 的 POST、ingest、search）都必须把 Promise 整条链 `return` 出去；不 return 的话
   请求会在响应发出之前就「完成」，面板拿到空 body。choro/search 踩过同一个坑
   （`src/api.js:2787-2788` 有注释）。
5. **索引缓存按集合懒物化，写路径必须 `invalidate`**。`ingest` / `upsertCollection` /
   `deleteCollection` 都会失效对应缓存（`markKbDocError` 走的是同一处）。漏一处 = 检索命中
   已删除的段落。
6. **Windows 上临时目录会被 Defender 短暂持锁**，`rmSync` 撞 `EPERM` 是抖动不是失败，
   测试里用 `rmTempEventually` 重试（与 `test/wiki-store.test.js` 同源）。
