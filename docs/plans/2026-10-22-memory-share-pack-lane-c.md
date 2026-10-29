# 记忆分享包 车道 C（入库与整包退出）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让接收方把车道 A 产出的分享包吃进自己的库——校验、幂等入库、外来行不参与巩固、以及「整包退出」，全程命令行可达。

**Architecture:** 三层各管一件事。`src/share.js` 继续做**格式**（新增 `validateSharePack`，纯函数，不碰库）；`src/service.js` 新增 `importSharePack` / `deleteSharePack` 两个方法，是唯一碰 store 写路径的地方（`createApi` 手里没有 `store`，`src/service.js:2670` 明写「api 层不直接摸 store」）；`src/share-http.js` 仍是两张皮共用的唯一一份解析与答复。`src/store.js` 加两列 + 一条 UNIQUE 部分索引 + 三条查询/批删方法。车道 B 的守卫已经在线（`src/memory-source.js`），本车道是它第一次真的被用到。

**Tech Stack:** Node 22/24，ESM（`"type": "module"`），`node:test` + `node:assert/strict`，`node:sqlite`（`DatabaseSync`），测试一律落**文件库**（temp 目录），HTTP 侧用 `EventEmitter` 假 req/res 或真 `createStandaloneApi` + `fetch`。

**Spec:** [../specs/2026-10-22-memory-share-pack-design.md](../specs/2026-10-22-memory-share-pack-design.md) —— 特别是 §5（receive 侧）、§7（路由与 policy）、§14 的六条修订、§15 的两条边界裁定。车道 A/B 的落地事实以 `dsh-mneme/docs/SHARE.md` 为准。

## Global Constraints

每一条隐含作用于每个任务：

- 所有路径相对包目录 `dsh-mneme/`。`lib/` 是 `npm run sync` 产物，禁止手改；改了 `src/` 的任务收尾必须 sync，`lib/` 与 `src/` 逐字节相同。
- **不加任何新配置键**：`src/settings.js` 白名单与 `test/api.test.js:753` 的 `assert.equal(Object.keys(data.effective).length, 103)` 一律不动。理由同车道 A：receive / undo 全是人主动敲的命令，不产生常驻行为。
- **写路径只能在 `service.transaction(fn)` 里**。`scheduleEmbed`（`src/service.js:310-351`）在 `txDepth > 0` 时只是入队，**只有 `transaction()` 最外层提交时才排空**（`:1234`）；裸用 `store.runAtomically` 会静默不嵌入。
- **`created_at` / `content_hash` 由 store 自己落**，不接受调用方传值（`src/store.js:1154`、`:1160`、`:1200-1201`，AGENTS.md 纪律 5 的单调时间戳防御段）。包里的 `created_at` 不入库。
- **幂等主路径是事务内先查 `share_external_id`**，命中即跳过；UNIQUE 索引只兜两个宿主并发的竞态（输的一侧整笔回滚、重跑得 `created = 0`）。约束报错**不许**被 catch 后继续跑。
- **批删必须跟 `store.remove()` 一样清 side table**（`src/store.js` 的 `remove()` 先删 `memory_provenance` 再删 `memories`，并在同一事务里 `incrementGeneration()`）。清的理由**不是**「外键没开」：C1 实测 `node:sqlite` 默认就开着 `PRAGMA foreign_keys`，级联是活的；留显式删除是因为**不该让清理依赖一个没人钉住的驱动默认值**。
- 新路由必须显式声明 `policy`（`token-write`），`createRouteRegistrar` 漏声明即抛错。`token-write` 只存在于宿主内侧 `src/api.js`；standalone 侧是一道全局 Bearer 门（`src/api-standalone.js:326`），**不许发明同名分支**。
- `token-write` 路由要进 SECURITY.md **两处 × 中英两份**（`test/security-doc.test.js` 一个过滤器取 `open||token-write`，另一个取 `token||token-write`），并同步 `README.md` 与 `docs/DAEMON.md` 的清单——后者不在任何测试的视野里。
- 每张皮对 `GET /receive`、`GET /receive/undo` 都答 **405**（车道 A 已定的纪律：两张皮只许差在鉴权、路径、以及面板侧独有的 `Content-Disposition`/logger）。
- 每个 POST handler 必须 `if (text === null) return;`（`readBody` 自己答过 413）；standalone 侧的 `void readBody(...).then(...)` 必须带 `.catch`（#410）。
- **外来行身份不可被手改摘掉**：经镜像回灌改写正文之后，`source` 仍必须是 `imported`、两个 scope 仍必须为 NULL（spec §15 二）。
- 发布只在 `dsh-mneme/` 包目录内；本计划不发版、不 `npm publish`、不 push。
- 提交信息**不得有 AI 署名，不得有任何 `Co-Authored-By` trailer**；`git add` 一律点名文件，禁止 `-A` / `.`。
- 注释写「为什么」不写「是什么」（AGENTS.md 自查 8）；测试同样适用——锁形状/锁字面量的用例要写清它防哪类回归。

---

## 文件结构

| 动作 | 文件 | 负责什么 |
|---|---|---|
| Modify | `src/store.js`（迁移块 `:860` 附近、`toRow` `:522-556`、INSERT `:1170-1202`、方法表 `:3337-3460`） | 两列 + UNIQUE 部分索引 + `getByShareExternalId` / `listBySharePackId` / `deleteBySharePackId` |
| Modify | `src/share.js` | `validateSharePack`（纯函数）、`SHARE_ALLOWED_TYPES`、`importedTagFor(alias)` |
| Modify | `src/service.js` | `importSharePack` / `deleteSharePack`，加进 `createService` 返回表（`:2576` 起） |
| Modify | `src/document.js:281-288` | evidence 吸收跳过外来行，并把跳过数报出来（spec §15 一） |
| Modify | `src/share-http.js` | `parseReceiveBody` / `receiveReply` / `undoReply`（两张皮共用） |
| Modify | `src/api.js`（车道 A 的 share 路由之后） | `POST /api/dsh-mneme/receive`、`POST /api/dsh-mneme/receive/undo`，policy `token-write` |
| Modify | `src/api-standalone.js` | `POST /receive`、`POST /receive/undo`，GET → 405 |
| Modify | `bin/cli.mjs` | `receive <包文件> [--apply]`、`undo-share <包文件> [--apply]` + `KNOWN_FLAGS` + `USAGE` |
| Create | `test/share-store.test.js`、`test/share-validate.test.js`、`test/share-import.test.js`、`test/share-receive-http.test.js`、`test/share-imported-identity.test.js`、`test/cli-receive.test.js` | 各层锁 |
| Modify | `test/share-imported-guard.test.js` | 补 organize 之外第二个非惰性用例（document 吸收） |
| Modify | `SECURITY.md`、`README.md`、`dsh-mneme/README.md`、`dsh-mneme/docs/DAEMON.md`、`dsh-mneme/docs/SHARE.md`、`AGENTS.md` | 文档是代码的投影 |

任务顺序不可乱：C1 → C2 → C3 → C4 是硬依赖；C5 依赖 C3/C4；C6 依赖 C5；C7 依赖 C6；C8/C9 独立，可与 C5 之后并行；C10 最后。

---

### Task C1: store 的两列、索引与查询

**Files:**
- Modify: `src/store.js`（迁移块、`toRow`、INSERT、方法表）
- Test: `test/share-store.test.js`

**Interfaces:**
- Consumes: 无
- Produces: 列 `memories.share_pack_id TEXT`、`memories.share_external_id TEXT`（+ UNIQUE 部分索引、+ 普通 pack 索引）；行对象多出 `share_pack_id` / `share_external_id`（缺省 `undefined`）；方法 `getByShareExternalId(externalId) -> row | undefined`、`listBySharePackId(packId) -> row[]`、`deleteBySharePackId(packId) -> number`

- [ ] **Step 1: 写失败测试**

创建 `test/share-store.test.js`：

```js
// 车道 C 的存储层。这里盯的不是「列在不在」，而是三件容易写错的事：
//   a) 存量库重开即建列，且存量行的新列是 NULL 而不是被填成某个假值；
//   b) UNIQUE 索引只对外来行生效——普通本地行必须能无限多条共享 NULL；
//   c) 批删清 side table 且 generation 前移，否则镜像恢复会把删掉的行当「没跟上」。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/store.js";
import { IMPORTED_SOURCE } from "../src/memory-source.js";

const temp = () => mkdtempSync(join(tmpdir(), "dsh-mneme-share-store-"));

test("an existing library gains both columns on reopen, legacy rows stay NULL", () => {
  const dir = temp(), path = join(dir, "memory.db");
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
    forgotten INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT, source TEXT, content_history TEXT, content_hash TEXT, embedding TEXT,
    epistemic_status TEXT NOT NULL DEFAULT 'subjective', last_accessed_at TEXT,
    _full_content TEXT, evidence TEXT, doc_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  raw.prepare(`INSERT INTO memories (id, type, title, content, created_at, updated_at)
    VALUES ('legacy-1','decision','旧条目','正文','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  raw.close();

  const store = createStore(path);
  try {
    const row = store.getById("legacy-1");
    assert.equal(row.share_pack_id, undefined, "legacy row must not be stamped as imported");
    assert.equal(row.share_external_id, undefined);
    store.close();
    const again = createStore(path);     // 幂等重开
    assert.ok(again.getById("legacy-1"));
    again.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("foreign rows are unique per external_id while local rows share NULL freely", () => {
  const dir = temp(), store = createStore(join(dir, "memory.db"));
  try {
    store.save({ type: "decision", title: "a", content: "x", source: IMPORTED_SOURCE, share_external_id: "deadbeef00000001" });
    assert.throws(() => store.save({ type: "decision", title: "b", content: "y", source: IMPORTED_SOURCE, share_external_id: "deadbeef00000001" }),
      /UNIQUE constraint failed/);
    for (const t of ["p1", "p2", "p3"]) store.save({ type: "decision", title: t, content: "x" });
    assert.equal(store.list({ type: "decision", limit: null }).length, 4, "NULL must not collide");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("share columns round-trip through toRow and are queryable", () => {
  const dir = temp(), store = createStore(join(dir, "memory.db"));
  try {
    const row = store.save({ type: "preference", title: "t", content: "c", source: IMPORTED_SOURCE,
      share_pack_id: "packA", share_external_id: "deadbeef00000002" });
    assert.equal(row.share_pack_id, "packA");
    assert.equal(row.share_external_id, "deadbeef00000002");
    assert.equal(store.getByShareExternalId("deadbeef00000002").id, row.id);
    assert.equal(store.getByShareExternalId("nope"), undefined);
    store.save({ type: "preference", title: "t2", content: "c2", source: IMPORTED_SOURCE, share_pack_id: "packA", share_external_id: "deadbeef00000003" });
    assert.deepEqual(store.listBySharePackId("packA").map((m) => m.share_external_id).sort(),
      ["deadbeef00000002", "deadbeef00000003"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("deleteBySharePackId removes the whole pack, cleans provenance, and bumps generation", () => {
  const dir = temp(), store = createStore(join(dir, "memory.db"));
  try {
    const a = store.save({ type: "preference", title: "t1", content: "c", source: IMPORTED_SOURCE, share_pack_id: "packA", share_external_id: "deadbeef00000011" });
    store.save({ type: "preference", title: "t2", content: "c", source: IMPORTED_SOURCE, share_pack_id: "packA", share_external_id: "deadbeef00000012" });
    store.save({ type: "preference", title: "keep", content: "c", source: IMPORTED_SOURCE, share_pack_id: "packB", share_external_id: "deadbeef00000013" });
    store.db.prepare("INSERT INTO memory_provenance (memory_id, ref) VALUES (?, 'x')").run(a.id);
    const before = store.count();
    const deleted = store.deleteBySharePackId("packA");
    assert.equal(deleted, 2);
    assert.equal(store.count(), before - 2);
    assert.equal(store.getByShareExternalId("deadbeef00000011"), undefined, "UNIQUE slot must be freed for a clean re-import");
    assert.equal(store.listBySharePackId("packA").length, 0);
    assert.equal(store.listBySharePackId("packB").length, 1);
    assert.equal(store.deleteBySharePackId("packA"), 0, "idempotent");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a UNIQUE collision aborts the whole transaction — nothing lands partially", () => {
  const dir = temp(), store = createStore(join(dir, "memory.db"));
  try {
    store.save({ type: "decision", title: "seed", content: "x", source: IMPORTED_SOURCE, share_external_id: "cafe000000000001" });
    assert.throws(() => store.runAtomically(() => {
      store.save({ type: "decision", title: "dup", content: "y", source: IMPORTED_SOURCE, share_external_id: "cafe000000000001" });
      store.save({ type: "decision", title: "later", content: "z", source: IMPORTED_SOURCE, share_external_id: "cafe000000000002" });
    }), /UNIQUE constraint failed/);
    assert.equal(store.getByShareExternalId("cafe000000000002"), undefined, "the row after the collision must not have landed");
    assert.equal(store.list({ limit: null }).length, 1, "the batch left nothing behind");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

最后那条锁的是 spec §5 的「输的那一侧整笔失败」：两个宿主同时吃同一个包时，后提交的那笔不是部分入库，而是一条都没落，重跑得到 `created = 0`。`IMPORTED_SOURCE` 从 `../src/memory-source.js` 取（本文件顶部已 import）。

`store.saveProvenance` / `saveMemoryProvenance` 的真实签名要在实施时按 `src/store.js` 的方法表核对：`memory_provenance` 的列名与是否 NOT NULL 都以上面那行 INSERT 能真的执行为准。若这张表的必填列不止这两个，补齐再跑——**目的只有一个**：让「批删要清 provenance」这条断言不是空的。核到的行号写进报告。

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-store.test.js`
Expected: FAIL —— 第一条报 `no such column: share_pack_id`（`toRow` 读不到），或 `getByShareExternalId is not a function`

- [ ] **Step 3: 加列、索引与查询**

3a. 迁移块：紧跟 `addColumn("memories", "agent_scope", ...)` 那一段的**同一处**（读 `src/store.js:855-900`，落在最后一个 `addColumn("memories", ...)` 之后、下一个表的迁移之前）：

```js
  // 车道 C：外来行的身份两件套。share_pack_id 是「整包退出」的寻址键，share_external_id
  // 是导入的幂等键。它们只对自己铸造的行有意义，所以缺省是 NULL 而不是 ''。
  addColumn("memories", "share_pack_id", "ALTER TABLE memories ADD COLUMN share_pack_id TEXT");
  addColumn("memories", "share_external_id", "ALTER TABLE memories ADD COLUMN share_external_id TEXT");
  // 索引建在加列之后（本文件 :876-878 的既有注释：存量库上 CREATE TABLE 是 no-op，
  // 把索引写进 SCHEMA 会因列不存在直接失败）。部分索引是刻意的：本地行这一格恒为 NULL，
  // SQLite 允许多个 NULL，所以「NULL 不参与唯一性」这件事得靠 WHERE 明写，
  // 不能指望它自然成立——否则第二条本地记忆就撞响了。
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_share_external ON memories(share_external_id) WHERE share_external_id IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_share_pack ON memories(share_pack_id)");
```

3b. `toRow`（`:522-556`，硬编码白名单）加两键，跟 `archived_at` 同款写法：

```js
    share_pack_id: row.share_pack_id ?? undefined,
    share_external_id: row.share_external_id ?? undefined,
```

3c. INSERT（`:1170-1202`）扩两列两参。列清单末尾从 `... content_hash, created_at, updated_at)` 变成：

```js
        `INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, archived_at, source, content_history, quality_score, embedding, epistemic_status, agent_scope, workspace_scope, agent_scope_source, workspace_scope_source, scope_decided_at, sensitivity, occurred_at, evidence, doc_path, content_hash, share_pack_id, share_external_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
```

参数顺序里，`contentHash` 之后、两个 `now` 之前插入：

```js
        typeof memory.share_pack_id === "string" && memory.share_pack_id.trim() ? memory.share_pack_id.trim() : null,
        typeof memory.share_external_id === "string" && memory.share_external_id.trim() ? memory.share_external_id.trim() : null,
```

3d. 三个新方法，形状照本文件既有的 `getById`（`:1121-1124`）与批删先例 `purgeRecallRunsOlderThan`（`:2158-2161`）：

```js
  function getByShareExternalId(externalId) {
    if (typeof externalId !== "string" || !externalId) return undefined;
    return toRow(db.prepare("SELECT * FROM memories WHERE share_external_id = ?").get(externalId));
  }

  function listBySharePackId(packId) {
    if (typeof packId !== "string" || !packId) return [];
    return db.prepare("SELECT * FROM memories WHERE share_pack_id = ? ORDER BY updated_at DESC, id DESC").all(packId).map(toRow);
  }

  /**
   * 整包退出。删空一个不存在的包是幂等的 0，不是错误——对方点第二次「收起这个包」
   * 与「收起一个从来没导入过的包」都该是这个答案。
   * provenance 同事务清掉是双保险，而不是因为外键没开：C1 实测 node:sqlite 默认
   * 开着 PRAGMA foreign_keys，级联是活的。不把清理押在一个没人钉住的驱动默认值上
   * （与 remove() 同一处置）。
   */
  function deleteBySharePackId(packId) {
    if (typeof packId !== "string" || !packId) return 0;
    return runAtomically(() => {
      const ids = db.prepare("SELECT id FROM memories WHERE share_pack_id = ?").all(packId).map((r) => r.id);
      if (!ids.length) return 0;
      const marks = ids.map(() => "?").join(", ");
      db.prepare(`DELETE FROM memory_provenance WHERE memory_id IN (${marks})`).run(...ids);
      const result = db.prepare(`DELETE FROM memories WHERE id IN (${marks})`).run(...ids);
      incrementGeneration();
      return result.changes;
    });
  }
```

三个名字加进 `createStore` 的返回对象（方法表在 `:3337-3460`，挨着 `getById` / `remove` 放）。

> 实施时先读 `src/store.js:1333-1346`：如果 `remove()` 还删了别的 side table 或清了别的缓存，`deleteBySharePackId` 要照它补齐，而不是只删 `memory_provenance`。**把核到的行号写进报告。**

- [ ] **Step 4: 跑到通过**

Run: `node --test test/share-store.test.js`
Expected: PASS（5 个测试）

- [ ] **Step 5: 回归 + 同步 + 提交**

```bash
node --test test/store.test.js test/share-store.test.js
npm run sync
node --test test/lib-smoke.test.js
git add src/store.js test/share-store.test.js lib/store.js
git commit -m "feat(share): give memories their foreign-pack identity columns"
```

---

### Task C2: `validateSharePack` 与包侧共用的两个小件

**Files:**
- Modify: `src/share.js`
- Test: `test/share-validate.test.js`

**Interfaces:**
- Consumes: `SHARE_KIND`、`deriveExternalId`、`SHARE_READONLY_TYPES`、`SHARE_EXCLUDED_TYPES`（车道 A）
- Produces: `PACK_ID_RE`（`/^[0-9a-f]{16}$/`）、`SHARE_ALLOWED_TYPES`（`Set`，8 类）、`importedTagFor(alias) -> string`、`validateSharePack(pack) -> {ok:true, pack, count} | {ok:false, error, index?, detail?}`

- [ ] **Step 1: 写失败测试**

创建 `test/share-validate.test.js`：

```js
// 接收侧的格式闸门。锁三件事：
//   a) 一个不合规的包**整包**不合格（车道 C 不许半途入库）；
//   b) 键必须可重算——包是别人发来的，重算对不上就是被人改过，幂等键失效；
//   c) 允许的类型集合不许偷偷跟着 mirror 扩：这里刻意重述一遍，并由静态锁比对
//      TYPE_FILE 的键集减去两个排除项，将来加第 9 类时它会转红提醒人来决定。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACK_ID_RE, SHARE_ALLOWED_TYPES, importedTagFor, validateSharePack, deriveExternalId, SHARE_KIND } from "../src/share.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = (over = {}) => {
  const base = { type: "decision", title: "选 SQLite", content: "正文正文", tags: ["x"], importance: 4,
    epistemic_status: "subjective", created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", content_hash: "ab" };
  return { ...base, external_id: deriveExternalId("f0f0f0f0f0f0f0f0", base.type, base.title, base.content_hash), ...over };
};
const packOf = (memories, over = {}) => ({
  kind: SHARE_KIND, pack_id: "f0f0f0f0f0f0f0f0", alias: "桉", generated_at: "2026-10-22T00:00:00.000Z",
  source_version: "0.9.4", report: { included: memories.length, skipped: {}, skip_list: [], deduped: 0 },
  memories, ...over
});

test("pack_id is exactly 16 lowercase hex", () => {
  assert.match("f0f0f0f0f0f0f0f0", PACK_ID_RE);
  assert.doesNotMatch("f0f0f0f0f0f0f0", PACK_ID_RE);       // 车道 A 铸的是 16 位，不是 12
  assert.doesNotMatch("F0F0F0F0F0F0F0F0", PACK_ID_RE);
});

test("a well-formed pack validates and reports its count", () => {
  const out = validateSharePack(packOf([entry()]));
  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
});

test("every rejection names a code and never a partial success", () => {
  assert.equal(validateSharePack({}).error, "invalid-kind");
  assert.equal(validateSharePack(packOf([entry()], { kind: "other" })).error, "invalid-kind");
  assert.equal(validateSharePack(packOf([entry()], { pack_id: "nope" })).error, "invalid-pack-id");
  assert.equal(validateSharePack(packOf([])).error, "empty-pack");
  assert.equal(validateSharePack({ ...packOf([entry()]), memories: "x" }).error, "invalid-memories");
  const badType = validateSharePack(packOf([entry({ type: "document" })]));
  assert.equal(badType.error, "invalid-type");
  assert.equal(badType.index, 0);
  assert.equal(validateSharePack(packOf([entry({ title: "  " })])).error, "invalid-entry");
  assert.equal(validateSharePack(packOf([entry({ content: "" })])).error, "invalid-entry");
  assert.equal(validateSharePack(packOf([entry({ importance: "high" })])).error, "invalid-entry");
});

test("a recomputed key that disagrees means the pack was edited by hand", () => {
  const out = validateSharePack(packOf([entry({ external_id: "0000000000000000" })]));
  assert.equal(out.ok, false);
  assert.equal(out.error, "external-id-mismatch");
  assert.equal(out.index, 0);
});

test("duplicate external_id inside one pack is rejected, not folded here", () => {
  // 折叠是出包侧的义务（§3 的 deduped）；收到重复键说明包被人改过，按不合格处置。
  const dup = packOf([entry(), entry({ content: "另一条" })]);
  assert.equal(validateSharePack(dup).error, "duplicate-external-id");
});

test("the tag is derived in one place and never from the sharer's identity", () => {
  assert.equal(importedTagFor("桉"), "from-桉");
  assert.equal(importedTagFor(""), "from-shared");
  assert.equal(importedTagFor(undefined), "from-shared");
  assert.equal(importedTagFor("a\nb  c"), "from-ab-c");        // 空白折成 -，标签不许带换行
  assert.equal(importedTagFor("x".repeat(80)).length, 32);      // 上限：别人的字符串不许无限长
});

test("the allowed type set is the mirror's minus the two exclusions", () => {
  const mirror = readFileSync(resolve(here, "../src/mirror.js"), "utf8");
  const keys = [...mirror.matchAll(/^\s{2}([a-z_]+): "[^"]+\.md",$/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 8, `parse TYPE_FILE from mirror.js, got ${keys.length}`);
  const minus = new Set(keys.filter((k) => !SHARE_READONLY_TYPES.has(k) && !SHARE_EXCLUDED_TYPES.has(k)));
  assert.deepEqual([...SHARE_ALLOWED_TYPES].sort(), [...minus].sort());
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-validate.test.js`
Expected: FAIL —— `PACK_ID_RE is not exported`（或同类）

- [ ] **Step 3: 写实现**

追加到 `src/share.js`：

```js
// 车道 A 铸 pack_id 用的是 randomBytes(8) 的 hex，16 位；接收侧按这个形状判。
// 本行不是抄文档：spec §3 初稿写过 12 位，按它校验会把每一个真包拒掉。
export const PACK_ID_RE = /^[0-9a-f]{16}$/;

// 能入库的类型 = TYPE_FILE 的键集减去两个不随包走的排除项。这里重述一份而不是
// import mirror 的表，与 SHARE_READONLY_TYPES 同一理由：包的兼容面比镜像宽，
// 镜像哪天放开某个类型不该自动扩大接收侧的入库范围。形状由测试静态锁比对防漂。
export const SHARE_ALLOWED_TYPES = new Set([
  "preference", "project", "decision", "history", "pitfall", "constraint", "rejected_solution", "pattern"
]);

const IMPORTED_TAG_MAX = 32;

/** 外来行的来源标签。别名是分享者自报的自由字符串，在这里被压成一条安全标签；
 *  空别名走中性值，绝不拿对面的机器身份（用户名、路径）兜底。 */
export function importedTagFor(alias) {
  const flat = String(alias ?? "").replace(/[\r\n\t]+/g, "-").replace(/\s+/g, "-").trim().slice(0, IMPORTED_TAG_MAX);
  return flat ? `from-${flat}` : "from-shared";
}

/**
 * 整包校验。返回第一个不合格项就停：半途入库是最难复盘的失败，而「哪一条不合格」
 * 对发送方已经足够（index + 一个码）。
 */
export function validateSharePack(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return { ok: false, error: "invalid-kind" };
  if (pack.kind !== SHARE_KIND) return { ok: false, error: "invalid-kind" };
  if (typeof pack.pack_id !== "string" || !PACK_ID_RE.test(pack.pack_id)) return { ok: false, error: "invalid-pack-id" };
  if (!Array.isArray(pack.memories)) return { ok: false, error: "invalid-memories" };
  if (!pack.memories.length) return { ok: false, error: "empty-pack" };
  const seen = new Set();
  for (let index = 0; index < pack.memories.length; index++) {
    const m = pack.memories[index];
    if (!m || typeof m !== "object") return { ok: false, error: "invalid-entry", index };
    if (!SHARE_ALLOWED_TYPES.has(m.type)) return { ok: false, error: "invalid-type", index, detail: String(m.type ?? "") };
    if (typeof m.title !== "string" || !m.title.trim()) return { ok: false, error: "invalid-entry", index, detail: "title" };
    if (typeof m.content !== "string" || !m.content.trim()) return { ok: false, error: "invalid-entry", index, detail: "content" };
    if (m.tags !== undefined && !Array.isArray(m.tags)) return { ok: false, error: "invalid-entry", index, detail: "tags" };
    if (m.importance !== undefined && !Number.isInteger(m.importance)) return { ok: false, error: "invalid-entry", index, detail: "importance" };
    if (typeof m.external_id !== "string" || !/^[0-9a-f]{16}$/.test(m.external_id)) return { ok: false, error: "invalid-entry", index, detail: "external_id" };
    const expect = deriveExternalId(pack.pack_id, m.type, m.title, typeof m.content_hash === "string" ? m.content_hash : null);
    if (expect !== m.external_id) return { ok: false, error: "external-id-mismatch", index };
    if (seen.has(m.external_id)) return { ok: false, error: "duplicate-external-id", index };
    seen.add(m.external_id);
  }
  return { ok: true, pack, count: pack.memories.length };
}
```

- [ ] **Step 4: 跑到通过**

Run: `node --test test/share-validate.test.js`
Expected: PASS（7 个测试）

> 若静态锁那条因为 `TYPE_FILE` 的正则没解析出键而失败，**改正则而不是放宽断言**——它是这条计划里唯一防「第 9 类悄悄进包」的锁。

- [ ] **Step 5: 同步 + 提交**

```bash
npm run sync
node --test test/share-pack.test.js test/share-validate.test.js
git add src/share.js test/share-validate.test.js lib/share.js
git commit -m "feat(share): validate an inbound pack before anything is written"
```

---

### Task C3: `service.importSharePack`（干跑与真导入）

**Files:**
- Modify: `src/service.js`
- Test: `test/share-import.test.js`

**Interfaces:**
- Consumes: `validateSharePack` / `importedTagFor`（C2）、`getByShareExternalId` / `store.save` 的两列（C1）、`transaction` / `scheduleEmbed`（既有闭包）
- Produces: `service.importSharePack(pack, { dryRun = false } = {}) -> { pack_id, alias, created, skipped_existing, unchanged, title_conflicts, conflicts_checked }`；校验不合格时抛 `ShareImportError`，`err.code ∈ C2 的码集`

- [ ] **Step 1: 写失败测试**

创建 `test/share-import.test.js`：

```js
// 导入的动作面。四条锁，一条比一条容易被「顺手重构」拆掉：
//   a) 不改写别人——既有非 imported 行的 updated_at 逐字节不动（决策 2 的直接锁）；
//   b) 幂等——同包第二次导入 created = 0 且不删任何东西；
//   c) 外来行带着守卫要的身份落地（source / 两个 scope），否则车道 B 的九个池子白挡；
//   d) 真的排进了嵌入队列（在 transaction 里），否则对面的向量检索吃不到这批。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { deriveExternalId, importedTagFor, SHARE_KIND } from "../src/share.js";
import { IMPORTED_SOURCE } from "../src/memory-source.js";

const PACK_ID = "f0f0f0f0f0f0f0f0";
const pack = (entries, alias = "桉") => ({
  kind: SHARE_KIND, pack_id: PACK_ID, alias, generated_at: "2026-10-22T00:00:00.000Z",
  source_version: "0.9.4", report: { included: entries.length, skipped: {}, skip_list: [], deduped: 0 },
  memories: entries
});
const entry = (type, title, content) => ({
  type, title, content, tags: ["t"], importance: 4, epistemic_status: "verifiable",
  created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
  content_hash: "anchor", external_id: deriveExternalId(PACK_ID, type, title, "anchor")
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-share-import-"));
  const store = createStore(join(dir, "memory.db"));
  const embedded = [];
  const service = createService({ store, mirror: null, config: { embeddingModel: "stub" } });
  service.setEmbedder({ embedSingle: async (t) => [0, t.length], embed: async (xs) => xs.map(() => [0, 1]) });
  const rows = () => store.list({ limit: null, includeArchived: true, includeForgotten: true });
  return { store, service, dir, rows, embedded,
    close() { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

test("a foreign pack lands as new rows with the guard's identity", () => {
  const h = setup();
  try {
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(out.created, 1);
    assert.equal(out.pack_id, PACK_ID);
    const row = h.rows().find((m) => m.title === "选 SQLite");
    assert.equal(row.source, IMPORTED_SOURCE);
    assert.equal(row.agent_scope, undefined);
    assert.equal(row.workspace_scope, undefined);
    assert.equal(row.share_pack_id, PACK_ID);
    assert.ok(row.tags.includes(importedTagFor("桉")));
    assert.notEqual(row.created_at, "2026-10-01T00:00:00.000Z", "created_at is the store's, not the pack's");
  } finally { h.close(); }
});

test("re-importing the same pack creates nothing and deletes nothing", () => {
  const h = setup();
  try {
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    const before = h.rows().length;
    const again = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    assert.equal(again.created, 0);
    assert.equal(again.skipped_existing, 2);
    assert.equal(h.rows().length, before, "idempotent means nothing removed either");
  } finally { h.close(); }
});

test("a name clash with the host's own memory is reported, never merged into", () => {
  const h = setup();
  try {
    const mine = h.store.save({ type: "decision", title: "选 SQLite", content: "我自己的结论", tags: [] });
    const before = h.store.getById(mine.id);
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(out.created, 1);
    assert.equal(out.title_conflicts.length, 1);
    assert.equal(out.title_conflicts[0].existing_id, mine.id);
    const after = h.store.getById(mine.id);
    assert.equal(after.content, before.content);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.archived, before.archived);
  } finally { h.close(); }
});

test("dry-run answers the same shape and writes nothing", () => {
  const h = setup();
  try {
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), { dryRun: true });
    assert.equal(out.created, 1);
    assert.equal(h.rows().length, 0, "a dry run must leave the library byte-identical");
    const real = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(real.created, 1);
  } finally { h.close(); }
});

test("an invalid pack throws before any row is written", () => {
  const h = setup();
  try {
    const bad = pack([entry("decision", "选 SQLite", "正文 A"), entry("decision", "第二条", "x")]);
    bad.memories[1].external_id = "0000000000000000";
    assert.throws(() => h.service.importSharePack(bad, {}), (e) => e.code === "external-id-mismatch");
    assert.equal(h.rows().length, 0);
  } finally { h.close(); }
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-import.test.js`
Expected: FAIL —— `h.service.importSharePack is not a function`

- [ ] **Step 3: 写实现**

`src/service.js` 顶部 import 区补：

```js
import { validateSharePack, importedTagFor } from "./share.js";
import { IMPORTED_SOURCE } from "./memory-source.js";
```

在 `mergeHumanEdits` 附近（它同属「外部文本进库」那一族）加：

```js
  /** 导入的错误：带 code，让两张皮映射成同一个 400 码而不是各写一份文案。 */
  class ShareImportError extends Error {
    constructor(code, detail) { super(`share import: ${code}`); this.name = "ShareImportError"; this.code = code; this.detail = detail; }
  }

  /**
   * 车道 C 的入库。整包在一个 transaction 里：scheduleEmbed 只在最外层提交时排空
   * （本文件 :313-316 与 :1234），用 store.runAtomically 会静默不嵌入。
   *
   * 幂等主路径是先查 share_external_id，命中即跳过；UNIQUE 索引只兜两个宿主共用同一
   * memoryDir 时的竞态，那条报错从这里穿出是**整笔回滚**，不 catch、不续跑（spec §5）。
   *
   * 走 store.save 而不是 saveWithDedupe：后者命中就 appendContent 并入既有行，
   * 而「把别人的正文并进我的条目」正是这条契约要禁的动作。
   */
  function importSharePack(pack, { dryRun = false } = {}) {
    const v = validateSharePack(pack);
    if (!v.ok) throw new ShareImportError(v.error, v.detail);
    const tag = importedTagFor(pack.alias);
    // 撞名清单要按「对面会不会真的看不见这条」来判：scope 同为未标注、且不是别人的行。
    const ownKeys = new Set(store.list({ limit: null }).filter((m) => !m.archived && !isImportedRow(m)
      && !scopeKeyOf(m.agent_scope) && !scopeKeyOf(m.workspace_scope)).map((m) => `${m.type}\u0000${m.title}`));
    const result = transaction(() => {
      let created = 0, skippedExisting = 0, unchanged = 0;
      const conflicts = [];
      for (const entry of pack.memories) {
        const existing = store.getByShareExternalId(entry.external_id);
        if (existing) {
          skippedExisting++;
          // 「unchanged」比的是同一把尺：两侧都用 normalizeForHash 归一后的锚。
          // 分享侧的脱敏与接收侧重算若不同（比如两边的 home 前缀本来就不一样），
          // 这里就判为 changed——它是给人看的计数，不是动作依据。
          if (typeof existing.content_hash === "string" && existing.content_hash === entry.content_hash) unchanged++;
          continue;
        }
        const clashes = ownKeys.has(`${entry.type}\u0000${entry.title}`);
        if (clashes) conflicts.push({ type: entry.type, title: entry.title, existing_id: null });
        if (dryRun) { created++; continue; }
        const row = store.save({
          type: entry.type,
          title: entry.title,
          content: entry.content,
          tags: [...new Set([...(Array.isArray(entry.tags) ? entry.tags.map(String) : []), tag])],
          importance: Number.isInteger(entry.importance) ? entry.importance : 3,
          epistemic_status: entry.epistemic_status,
          source: IMPORTED_SOURCE,
          agent_scope: null,
          workspace_scope: null,
          share_pack_id: pack.pack_id,
          share_external_id: entry.external_id
        });
        scheduleEmbed(row);
        created++;
      }
      return { created, skippedExisting, unchanged, conflicts };
    });
    return {
      pack_id: pack.pack_id,
      alias: pack.alias,
      created: result.created,
      skipped_existing: result.skippedExisting,
      unchanged: result.unchanged,
      title_conflicts: result.conflicts,
      conflicts_checked: pack.memories.length
    };
  }
```

> 两个实施细节不许含糊：`isImportedRow` 与 `scopeKeyOf` 在本文件里是否已经可用（车道 B1 引入了 `isImportedRow`，`scopeKeyOf` 来自 `src/scope.js`），缺哪个就补哪条 import；`store.save` 的入参若拒收未知字段（`src/store.js:1150` 只校 `type`，未知字段静默丢弃），两列能落是因为 C1 扩了 INSERT——把这条验证写进报告的断言里（第三、四个用例已经覆盖）。
>
> `setup()` 里那个 `setEmbedder({...})` 的**方法名要对齐实现**：`src/service.js:231` 一带是按 `embedder.embedSingle` / `embedder.embed` 探测的，`scheduleEmbed`（`:310-351`）用的就是它。名字猜错的话第四条用例会「绿得没意义」——嵌入根本没被调用也测不出来。做法：先让第四个用例断言「事务提交后 `store` 里那条行的 embedding 列非空」（或 `service.embeddedCount()` 涨 1），跑红，再接对 embedder 让它转绿。

把 `importSharePack` 加进 `createService` 的返回表（`:2576` 起，挨着 `mergeHumanEdits`）。

- [ ] **Step 4: 跑到通过**

Run: `node --test test/share-import.test.js`
Expected: PASS（5 个测试）

- [ ] **Step 5: 证一条最要紧的锁会咬**

把 `if (existing) { skippedExisting++; ... continue; }` 整块注释掉，跑 `node --test test/share-import.test.js`：第二个用例应转红（`created` 变 2）。恢复。

```bash
npm run sync
node --test test/service.test.js test/share-import.test.js test/share-imported-guard.test.js
git add src/service.js test/share-import.test.js lib/service.js
git commit -m "feat(share): import a validated pack as foreign rows in one transaction"
```

---

### Task C4: 整包退出与外来行的可查性

**Files:**
- Modify: `src/service.js`
- Test: `test/share-import.test.js`（追加）

**Interfaces:**
- Consumes: `store.deleteBySharePackId` / `store.listBySharePackId`（C1）
- Produces: `service.deleteSharePack(packId, { dryRun = false } = {}) -> { pack_id, deleted, sample: [{type,title}] }`（`sample` 最多 20 条，供人核对「我要收起的到底是哪一批」）

- [ ] **Step 1: 写失败测试**

追加到 `test/share-import.test.js`：

```js
test("undo removes exactly one pack's rows and frees the idempotency keys", () => {
  const h = setup();
  try {
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    const kept = h.store.save({ type: "decision", title: "我自己的", content: "正文", tags: [] });
    const preview = h.service.deleteSharePack(PACK_ID, { dryRun: true });
    assert.equal(preview.deleted, 2);
    assert.equal(h.rows().length, 3, "dry-run removes nothing");
    const out = h.service.deleteSharePack(PACK_ID, {});
    assert.equal(out.deleted, 2);
    assert.equal(h.rows().length, 1);
    assert.ok(h.store.getById(kept.id), "the host's own rows must survive");
    assert.equal(h.service.deleteSharePack(PACK_ID, {}).deleted, 0, "undo is idempotent");
    const again = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    assert.equal(again.created, 2, "the UNIQUE slots were freed, so the pack can land again");
  } finally { h.close(); }
});

test("undo of an unknown pack answers zero, not an error", () => {
  const h = setup();
  try {
    const out = h.service.deleteSharePack("0000000000000000", {});
    assert.equal(out.deleted, 0);
    assert.deepEqual(out.sample, []);
  } finally { h.close(); }
});

test("the sample is capped so a huge pack still answers in bounded bytes", () => {
  const h = setup();
  try {
    const many = Array.from({ length: 30 }, (_, i) => entry("pattern", `模式 ${i}`, `正文 ${i}`));
    h.service.importSharePack(pack(many), {});
    const out = h.service.deleteSharePack(PACK_ID, { dryRun: true });
    assert.equal(out.deleted, 30);
    assert.equal(out.sample.length, 20);
  } finally { h.close(); }
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-import.test.js`
Expected: FAIL —— `h.service.deleteSharePack is not a function`

- [ ] **Step 3: 写实现**

`src/service.js`，紧接 `importSharePack`：

```js
  /**
   * 整包退出。**物删不归档**（spec §5 已定，理由写在这里）：归档行仍占着
   * share_external_id 的 UNIQUE 位，会造成「撤了却导不回来」的死角——那个形态
   * 比多删更坏，而原始包还在分享者手里，随时能重导。
   * 本方法与 reclaim 的「一条记忆都不删」哲学相反：那是自动回收面，这是人
   * 显式按下的一次撤销。
   */
  function deleteSharePack(packId, { dryRun = false } = {}) {
    const id = typeof packId === "string" ? packId.trim() : "";
    if (!id) return { pack_id: "", deleted: 0, sample: [] };
    const rows = store.listBySharePackId(id);
    const sample = rows.slice(0, 20).map((m) => ({ type: m.type, title: m.title }));
    if (dryRun || !rows.length) return { pack_id: id, deleted: rows.length, sample };
    const deleted = transaction(() => store.deleteBySharePackId(id));
    return { pack_id: id, deleted, sample };
  }
```

加进返回表（挨着 `importSharePack`）。

> `transaction` 返回回调值 ✓；`store.deleteBySharePackId` 内部还有自己的 `runAtomically`——`runAtomically` 在 `db.isTransaction` 为真时直接跑回调（`src/store.js:3306-3317`），所以嵌套安全。确认这一点后再提交，别默认它安全。

- [ ] **Step 4: 跑到通过**

Run: `node --test test/share-import.test.js`
Expected: PASS（8 个测试）

- [ ] **Step 5: 同步 + 提交**

```bash
npm run sync
node --test test/share-import.test.js test/maintenance.test.js
git add src/service.js test/share-import.test.js lib/service.js
git commit -m "feat(share): let a whole imported pack be withdrawn by its id"
```

---

### Task C5: 两张皮共用的 receive 层 + 宿主内路由

**Files:**
- Modify: `src/share-http.js`
- Modify: `src/api.js`（车道 A 的 share 路由之后）
- Test: `test/share-receive-http.test.js`

**Interfaces:**
- Consumes: `service.importSharePack` / `service.deleteSharePack`（C3/C4）
- Produces: `parseReceiveBody(text) -> {ok:true, pack, dryRun} | {ok:false, error}`、`receiveReply({ service, body, warn }) -> {status, body}`、`parseUndoBody(text)`、`undoReply({ service, body, warn })`、`SHARE_IMPORT_ERRORS`（错误码 → HTTP 状态的唯一映射表）

- [ ] **Step 1: 写失败测试**

创建 `test/share-receive-http.test.js`：

```js
// receive 的 HTTP 口径 + 反分叉锁。口径本身表驱动跑全量边界；最后一条静态锁
// 盯「两张皮不许各写一份」——#410/#411 那次就是面板侧修好了、数据面停在旧形态。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReceiveBody, receiveReply, parseUndoBody, undoReply, SHARE_IMPORT_ERRORS } from "../src/share-http.js";
import { deriveExternalId, SHARE_KIND } from "../src/share.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(resolve(here, "../src", f), "utf8");
const PACK_ID = "f0f0f0f0f0f0f0f0";
const goodPack = () => ({ kind: SHARE_KIND, pack_id: PACK_ID, alias: "桉", generated_at: "x", source_version: "0.9.4",
  report: { included: 1, skipped: {}, skip_list: [], deduped: 0 },
  memories: [{ type: "decision", title: "t", content: "c", tags: [], importance: 3, content_hash: "h",
    external_id: deriveExternalId(PACK_ID, "decision", "t", "h") }] });

test("the body must carry a pack; a bare pack is refused", () => {
  assert.equal(parseReceiveBody("").error, "invalid-body");
  assert.equal(parseReceiveBody("{}").error, "missing-pack");
  assert.equal(parseReceiveBody("{oops").error, "invalid-json");
  const parsed = parseReceiveBody(JSON.stringify({ pack: goodPack(), confirm: true }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, false, "confirm:true means really write");
  assert.equal(parseReceiveBody(JSON.stringify({ pack: goodPack() })).dryRun, true, "no confirm means dry-run");
});

test("receive without confirm answers the dry-run shape, with confirm the same shape marked applied", () => {
  const service = { importSharePack: (pack, { dryRun } = {}) => ({ pack_id: pack.pack_id, alias: pack.alias, created: 1, skipped_existing: 0, unchanged: 0, title_conflicts: [], conflicts_checked: 1, dryRun }) };
  const out = receiveReply({ service, pack: goodPack() });
  assert.equal(out.status, 200);
  assert.equal(out.body.created, 1);
  assert.equal(out.body.dry_run, true);
  const applied = receiveReply({ service, pack: goodPack(), dryRun: false });
  assert.equal(applied.body.dry_run, false);
});

test("every import error code maps to exactly one status", () => {
  for (const code of ["invalid-kind", "invalid-pack-id", "empty-pack", "invalid-type", "invalid-entry", "external-id-mismatch", "duplicate-external-id", "invalid-memories"]) {
    assert.equal(SHARE_IMPORT_ERRORS[code], 400, `${code} must answer 400`);
  }
  const throwing = { importSharePack: () => { const e = new Error("x"); e.code = "invalid-type"; throw e; } };
  const out = receiveReply({ service: throwing, pack: goodPack(), dryRun: false });
  assert.equal(out.status, 400);
  assert.equal(out.body.error, "invalid-type");
});

test("a service without the import method answers unavailable, not 500", () => {
  const out = receiveReply({ service: {}, pack: goodPack() });
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "share-import-unavailable");
});

test("an unexpected throw is logged and answered as internal", () => {
  const logs = [];
  const out = receiveReply({ service: { importSharePack: () => { throw new Error("database is locked"); } },
    pack: goodPack(), dryRun: false, warn: (m) => logs.push(m) });
  assert.equal(out.status, 500);
  assert.equal(out.body.error, "internal");
  assert.equal(logs.length, 1, "a swallowed 500 must leave a trace");
});

test("undo takes a pack_id and answers the same shape", () => {
  assert.equal(parseUndoBody("{}").error, "missing-pack-id");
  assert.equal(parseUndoBody(JSON.stringify({ packId: PACK_ID, confirm: true })).packId, PACK_ID);
  const out = undoReply({ service: { deleteSharePack: (id, { dryRun } = {}) => ({ pack_id: id, deleted: 2, sample: [], dryRun }) },
    packId: PACK_ID, dryRun: true });
  assert.equal(out.status, 200);
  assert.equal(out.body.deleted, 2);
  assert.equal(out.body.dry_run, true);
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-receive-http.test.js`
Expected: FAIL —— `SHARE_IMPORT_ERRORS is not exported`

> 跨面的反分叉静态锁**不在本任务**（此时 standalone 还没接上，锁了必红）。它在 C6 Step 1 补进同一份文件——车道 A 的同一先例。

- [ ] **Step 3: 写共用层**

追加到 `src/share-http.js`：

```js
// 接收侧与分享侧同属一份「两张皮只许差在鉴权与路径」的纪律（#411）。
// 注意这里刻意**不**复用 pack 的字段校验：validateSharePack 住在 share.js，
// service 也调它——校验只许有一处，否则路由与工具各判一套，包就有没有准信了。

/** 导入错误码 → HTTP 状态。只一张表，两张皮都从这儿取。 */
export const SHARE_IMPORT_ERRORS = Object.freeze({
  "invalid-kind": 400, "invalid-pack-id": 400, "invalid-memories": 400, "empty-pack": 400,
  "invalid-type": 400, "invalid-entry": 400, "external-id-mismatch": 400, "duplicate-external-id": 400
});

export const SHARE_IMPORT_UNAVAILABLE = "share-import-unavailable";

function readConfirm(body) {
  // 与 reclaim 同脾气：没有显式 confirm 就是干跑。导入是写别人的库，
  // 「不带参数就动数据」这条路一律不给。
  return body?.confirm === true ? false : true;
}

export function parseReceiveBody(text) {
  if (text === undefined || text === null || String(text).trim() === "") return { ok: false, error: "invalid-body" };
  let body;
  try { body = JSON.parse(String(text)); } catch { return { ok: false, error: "invalid-json" }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid-body" };
  if (!body.pack || typeof body.pack !== "object") return { ok: false, error: "missing-pack" };
  return { ok: true, pack: body.pack, dryRun: readConfirm(body) };
}

export function parseUndoBody(text) {
  if (text === undefined || text === null || String(text).trim() === "") return { ok: false, error: "invalid-body" };
  let body;
  try { body = JSON.parse(String(text)); } catch { return { ok: false, error: "invalid-json" }; }
  const packId = typeof body?.packId === "string" ? body.packId.trim() : "";
  if (!packId) return { ok: false, error: "missing-pack-id" };
  return { ok: true, packId, dryRun: readConfirm(body) };
}

function withDryRun(reply, dryRun) {
  return { ...reply, dry_run: dryRun === true };
}

export function receiveReply({ service, pack, dryRun = false, warn = null }) {
  if (typeof service?.importSharePack !== "function") {
    return { status: 503, body: { error: SHARE_IMPORT_UNAVAILABLE } };
  }
  try {
    return { status: 200, body: withDryRun(service.importSharePack(pack, { dryRun }), dryRun) };
  } catch (e) {
    const code = typeof e?.code === "string" ? e.code : null;
    if (code && SHARE_IMPORT_ERRORS[code]) {
      return { status: SHARE_IMPORT_ERRORS[code], body: { error: code, ...(e.detail ? { detail: e.detail } : {}) } };
    }
    try { warn?.(`[dsh-mneme] share import failed: ${String(e?.message ?? e)}`); } catch { /* 日志故障不许吃掉答复 */ }
    return { status: 500, body: { error: "internal" } };
  }
}

export function undoReply({ service, packId, dryRun = false, warn = null }) {
  if (typeof service?.deleteSharePack !== "function") {
    return { status: 503, body: { error: SHARE_IMPORT_UNAVAILABLE } };
  }
  try {
    return { status: 200, body: withDryRun(service.deleteSharePack(packId, { dryRun }), dryRun) };
  } catch (e) {
    try { warn?.(`[dsh-mneme] share undo failed: ${String(e?.message ?? e)}`); } catch { /* 日志故障不许吃掉答复 */ }
    return { status: 500, body: { error: "internal" } };
  }
}
```

然后宿主内侧两条路由（紧接车道 A 的 share 路由；`warn` 照车道 A 的接法）：

```js
  // --- 分享包入库（车道 C）--------------------------------------------------
  // token-write：写库。GET 一律 405，与数据面同码（#411 的「只许差在鉴权与路径」）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/receive",
    policy: "token-write",
    handler(req, res) {
      try {
        if (req.method !== "POST") { sendJson(res, 405, { error: "method-not-allowed" }); return; }
        return readBody(req, res).then((text) => {
          if (text === null) return;
          const parsed = parseReceiveBody(text);
          if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return; }
          const out = receiveReply({ service, pack: parsed.pack, dryRun: parsed.dryRun, warn: (msg) => ctx.logger?.warn?.(msg) });
          sendJson(res, out.status, out.body);
        }).catch(() => sendJson(res, 500, { error: "internal" }));
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/receive/undo",
    policy: "token-write",
    handler(req, res) {
      try {
        if (req.method !== "POST") { sendJson(res, 405, { error: "method-not-allowed" }); return; }
        return readBody(req, res).then((text) => {
          if (text === null) return;
          const parsed = parseUndoBody(text);
          if (parsed.ok !== true) { sendJson(res, 400, { error: parsed.error }); return; }
          const out = undoReply({ service, packId: parsed.packId, dryRun: parsed.dryRun, warn: (msg) => ctx.logger?.warn?.(msg) });
          sendJson(res, out.status, out.body);
        }).catch(() => sendJson(res, 500, { error: "internal" }));
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });
```

import 区补 `parseReceiveBody, receiveReply, parseUndoBody, undoReply`。

- [ ] **Step 4: 跑到通过**

```bash
node --check src/share-http.js
node --test test/share-receive-http.test.js test/route-policy.test.js
```
Expected: 语法检查过，本文件 6 条全绿（跨面锁不在这里，见 C6）。`src/api.js` 装配一条路由后 `route-policy` 的下界断言只会更高，不会红。

- [ ] **Step 5: 同步 + 提交**

```bash
npm run sync
node --test test/share-http.test.js test/share-routes.test.js
git add src/share-http.js src/api.js test/share-receive-http.test.js lib/share-http.js lib/api.js
git commit -m "feat(share): add the receive protocol and the panel routes"
```

---

### Task C6: 数据面两条路由 + 跨面锁转绿

**Files:**
- Modify: `src/api-standalone.js`
- Test: `test/share-receive-http.test.js`（追加真 HTTP 用例）、`test/share-routes.test.js`（追加）

**Interfaces:**
- Consumes: `receiveReply` / `undoReply` / `parseReceiveBody` / `parseUndoBody`（C5）
- Produces: `POST /receive`、`POST /receive/undo`（本面只有 Bearer 一道门，无 policy 名），GET → 405

- [ ] **Step 1: 写失败测试**

先把跨面的反分叉静态锁补进 `test/share-receive-http.test.js`（`src()` helper 本文件已有；此时 standalone 还没接上，这条必红）：

```js
test("both surfaces call the shared receive builders", () => {
  for (const file of ["api.js", "api-standalone.js"]) {
    const text = src(file);
    for (const needle of ["receiveReply(", "undoReply(", "parseReceiveBody(", "parseUndoBody("]) {
      assert.ok(text.includes(needle), `${file} must call ${needle}`);
    }
    assert.ok(!text.includes("share-import-unavailable"), `${file} must not re-implement the unavailable literal`);
  }
});
```

再补真 HTTP 用例（装配照 `test/standalone-api.test.js:18` 与车道 A 的 C6 已用过的 `createStandaloneApi` + `ready`/`port`/`token`/`server.close` 形状）：

```js
test("the data plane gates receive and lands a pack", async () => {
  const h = await standaloneSetup();
  try {
  const packJson = JSON.stringify({ pack: goodPack() });
    const anon = await fetch(`${h.base}/receive`, { method: "POST", body: packJson });
    assert.equal(anon.status, 401, "本面除 /health 外一律要 Bearer");
    const dry = await fetch(`${h.base}/receive`, { method: "POST", headers: h.auth, body: packJson });
    assert.equal(dry.status, 200);
    const dryBody = await dry.json();
    assert.equal(dryBody.dry_run, true);
    assert.equal(dryBody.created, 1);
    assert.equal(h.store.list({ limit: null }).length, 0, "no confirm must write nothing");
    const real = await fetch(`${h.base}/receive`, { method: "POST", headers: h.auth, body: JSON.stringify({ pack: goodPack(), confirm: true }) });
    assert.equal((await real.json()).created, 1);
    assert.equal(h.store.list({ limit: null }).length, 1);
    const again = await fetch(`${h.base}/receive`, { method: "POST", headers: h.auth, body: JSON.stringify({ pack: goodPack(), confirm: true }) });
    assert.equal((await again.json()).created, 0, "idempotent through HTTP");
    const get = await fetch(`${h.base}/receive`, { headers: h.auth });
    assert.equal(get.status, 405, "GET must not build anything");
    const bad = await fetch(`${h.base}/receive`, { method: "POST", headers: h.auth, body: JSON.stringify({ pack: { kind: "nope" } }) });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid-kind");
    const undo = await fetch(`${h.base}/receive/undo`, { method: "POST", headers: h.auth, body: JSON.stringify({ packId: PACK_ID, confirm: true }) });
    assert.equal((await undo.json()).deleted, 1);
    assert.equal(h.store.list({ limit: null }).length, 0);
  } finally { await h.close(); }
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-receive-http.test.js`
Expected: FAIL —— 404（本面还没有这两条路径）

- [ ] **Step 3: 写实现**

紧接车道 A 的 `/share` 块：

```js
      if (pathname === "/receive" || pathname === "/receive/undo") {
        const isUndo = pathname === "/receive/undo";
        if (req.method !== "POST") { sendJson(res, 405, { error: "method-not-allowed" }); return; }
        void readBody(req, res).then((text) => {
          if (text === null) return;
          const parsed = isUndo ? parseUndoBody(text) : parseReceiveBody(text);
          if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return; }
          const out = isUndo
            ? undoReply({ service, packId: parsed.packId, dryRun: parsed.dryRun, warn: (msg) => logger?.warn?.(msg) })
            : receiveReply({ service, pack: parsed.pack, dryRun: parsed.dryRun, warn: (msg) => logger?.warn?.(msg) });
          sendJson(res, out.status, out.body);
        }).catch(() => sendJson(res, 500, { error: "internal" }));
        return;
      }
```

两个解析器都返回 `{ok:true,…}|{ok:false,error}`，所以一处 `if (!parsed.ok)` 就够。**别把这条判断写成「有 error 就 400」**——那会让本面缺路径时落到的 404 与真正的坏 body 混成一种答案，排查时看不出是哪一层没接上。

- [ ] **Step 4: 跨面锁与全套转绿**

```bash
node --test test/share-receive-http.test.js test/standalone-api.test.js test/route-policy.test.js test/security-doc.test.js
npm run sync && node --test test/lib-smoke.test.js
```
Expected: 全绿，含 C5 留红的那条静态锁。`security-doc.test.js` 此刻会红：两条 `token-write` 路由还没进 SECURITY.md——**不要**在这里顺手改文档，把清单核对留给 C10（它要求四处：`open||token-write` 与 `token||token-write` 两个过滤器 × 中英）。若宁愿不留红窗，就把 C10 的 SECURITY.md 那一小步提前到本任务，并在报告里写明。

- [ ] **Step 5: 提交**

```bash
git add src/api-standalone.js test/share-receive-http.test.js lib/api-standalone.js
git commit -m "feat(share): serve receive from the bearer data plane"
```

---

### Task C7: CLI `receive` 与 `undo-share`

**Files:**
- Modify: `bin/cli.mjs`（`KNOWN_FLAGS`、`USAGE`、`switch (cmd)`、新增两个 cmd + 打印器）
- Test: `test/cli-receive.test.js`

**Interfaces:**
- Consumes: `apiRequest(cfg,'POST','/receive',{body})`、`/receive/undo`（C6）
- Produces: `dsh-mneme receive <包文件> [--apply]`、`dsh-mneme undo-share <包文件> [--apply]`

- [ ] **Step 1: 写失败测试**

创建 `test/cli-receive.test.js`（装配照 `test/cli-share.test.js`：spawn `bin/cli.mjs`、假数据面把请求体记下来、`DSH_MNEME_URL` 指向 fixture 而不是清空）：

```js
// CLI 的入库面。盯的四条都是「人会踩到」的：
//   a) 不带 --apply 就一个字都不写（照 reclaim 的 confirm 脾气）；
//   b) 包文件是本地读的，CLI 要把**包内容**送上去，不是只送一个路径；
//   c) undo-share 认的是包文件里的 pack_id，不是让人去抄 16 位十六进制；
//   d) 干跑报告里的撞名条数要说出来——那是决策 2 唯一的可见性。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { deriveExternalId, SHARE_KIND } from "../src/share.js";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/cli.mjs");
const PACK_ID = "f0f0f0f0f0f0f0f0";
const packFile = (dir) => {
  const pack = { kind: SHARE_KIND, pack_id: PACK_ID, alias: "桉", generated_at: "x", source_version: "0.9.4",
    report: { included: 1, skipped: {}, skip_list: [], deduped: 0 },
    memories: [{ type: "decision", title: "t", content: "c", tags: [], importance: 3, content_hash: "h",
      external_id: deriveExternalId(PACK_ID, "decision", "t", "h") }] };
  const path = join(dir, "pack.json");
  writeFileSync(path, JSON.stringify(pack), "utf8");
  return { path, pack };
};

function fakePlane(handler) {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      let text = "";
      req.on("data", (c) => { text += c; });
      req.on("end", () => {
        const reply = handler({ pathname: req.url, method: req.method, body: text });
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port,
      close: () => new Promise((r) => server.close(r)) }));
  });
}

const scratchHome = mkdtempSync(join(tmpdir(), "dsh-mneme-cli-recv-home-"));
// 旗标显式指 fixture，并且把 HOME/USERPROFILE 也折到临时目录：
// 车道 A 留过一条账——清空 DSH_MNEME_URL 会回落到 DEFAULT_URL 127.0.0.1:8790，
// 于是漏传 auth 的调用点会打到用户**活的**实例上。这里一律显式给。
const run = (port, args) => spawnSync(process.execPath, [cli, ...args, "--url", `http://127.0.0.1:${port}`, "--token", "fixture-token"], {
  encoding: "utf8", timeout: 15000,
  env: { ...process.env, HOME: scratchHome, USERPROFILE: scratchHome, DSH_MNEME_URL: "", DSH_MNEME_TOKEN: "" }
});

test("receive without --apply posts confirm absent and reports the dry-run numbers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-cli-recv-"));
  const seen = [];
  const plane = await fakePlane(({ pathname, body }) => {
    seen.push({ pathname, body: JSON.parse(body || "{}") });
    return { status: 200, body: { pack_id: PACK_ID, alias: "桉", created: 3, skipped_existing: 1, unchanged: 0, title_conflicts: [{ type: "decision", title: "t", existing_id: "own-1" }], conflicts_checked: 4, dry_run: true } };
  });
  try {
    const f = packFile(dir);
    const out = run(plane.port, ["receive", f.path]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(seen[0].pathname, "/receive");
    assert.equal(seen[0].body.confirm, undefined, "no --apply means no confirm");
    assert.deepEqual(seen[0].body.pack, f.pack, "the pack body must travel, not just a path");
    assert.match(out.stdout, /3/);
    assert.match(out.stdout, /撞名|冲突/);
  } finally { rmSync(dir, { recursive: true, force: true }); await plane.close(); }
});

test("receive --apply sends confirm and prints the created count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-cli-recv-"));
  const seen = [];
  const plane = await fakePlane(({ body }) => { seen.push(JSON.parse(body)); return { status: 200, body: { pack_id: PACK_ID, created: 4, skipped_existing: 0, unchanged: 0, title_conflicts: [], conflicts_checked: 4, dry_run: false } }; });
  try {
    const f = packFile(dir);
    const out = run(plane.port, ["receive", f.path, "--apply"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(seen[0].confirm, true);
  } finally { rmSync(dir, { recursive: true, force: true }); await plane.close(); }
});

test("a missing or unreadable pack file fails before any request", async () => {
  const plane = await fakePlane(() => ({ status: 200, body: {} }));
  try {
    const out = run(plane.port, ["receive", join(tmpdir(), "definitely-not-here.json")]);
    assert.notEqual(out.status, 0);
    assert.match(`${out.stdout}${out.stderr}`, /包|文件|read|ENOENT/i);
  } finally { await plane.close(); }
});

test("undo-share reads the pack_id out of the file the user already has", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-cli-undo-"));
  const seen = [];
  const plane = await fakePlane(({ body }) => { seen.push(JSON.parse(body)); return { status: 200, body: { pack_id: PACK_ID, deleted: 7, sample: [{ type: "decision", title: "t" }], dry_run: false } }; });
  try {
    const f = packFile(dir);
    const out = run(plane.port, ["undo-share", f.path, "--apply"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(seen[0].packId, PACK_ID);
    assert.equal(seen[0].confirm, true);
  } finally { rmSync(dir, { recursive: true, force: true }); await plane.close(); }
});

test("a 400 from receive keeps the server's error code visible", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-cli-recv-"));
  const plane = await fakePlane(() => ({ status: 400, body: { error: "external-id-mismatch", detail: "index 2" } }));
  try {
    const f = packFile(dir);
    const out = run(plane.port, ["receive", f.path]);
    assert.notEqual(out.status, 0);
    assert.match(`${out.stdout}${out.stderr}`, /external-id-mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); await plane.close(); }
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test test/cli-receive.test.js`
Expected: FAIL —— 未知命令（USAGE 里也没有 `receive`）

- [ ] **Step 3: 写实现**

`KNOWN_FLAGS`（`:122`）的布尔旗标段加 `'apply'`（已在表里就别重复），并确认 `--apply` 走 `flagBool`。

```js
async function cmdReceive(cfg, rest, flags) {
  requireToken(cfg);
  const file = rest[0];
  if (!file) fail(cfg, `receive 需要包文件：${CLI_NAME} receive <包文件>（不带 --apply 只干跑）`);
  const { readFileSync } = await import("node:fs");
  let pack;
  try {
    pack = JSON.parse(readFileSync(expandHome(file), "utf8"));
  } catch (e) {
    fail(cfg, `读不到包文件 ${file}：${String(e?.message ?? e)}\n包文件是对方 share --out 出来的那个 .json。`);
  }
  const applied = flagBool(flags, "apply");
  const body = { pack };
  if (applied) body.confirm = true;   // 与 reclaim 同纪律：不可逆的写要显式确认。
  const data = await apiRequest(cfg, "POST", "/receive", { body });
  if (cfg.jsonMode) { console.log(stringify(data)); return; }
  printReceive(data, { applied });
  if (!applied) console.log(`  没写库：确认数字之后加 --apply 真的导入`);
}

async function cmdUndoShare(cfg, rest, flags) {
  requireToken(cfg);
  const file = rest[0];
  if (!file) fail(cfg, `undo-share 需要当初那个包文件（从里面取 pack_id）：${CLI_NAME} undo-share <包文件>`);
  const { readFileSync } = await import("node:fs");
  let pack;
  try { pack = JSON.parse(readFileSync(expandHome(file), "utf8")); }
  catch (e) { fail(cfg, `读不到包文件 ${file}：${String(e?.message ?? e)}`); }
  const packId = typeof pack?.pack_id === "string" ? pack.pack_id : "";
  if (!packId) fail(cfg, `这个文件里没有 pack_id，收起不了：${file}`);
  const applied = flagBool(flags, "apply");
  const body = { packId };
  if (applied) body.confirm = true;
  const data = await apiRequest(cfg, "POST", "/receive/undo", { body });
  if (cfg.jsonMode) { console.log(stringify(data)); return; }
  printReceive({ ...data, created: data?.deleted, alias: "" }, { applied, undo: true });
  if (!applied) console.log(`  没删：确认条数之后加 --apply 真的收起这个包`);
}

function printReceive(d, { applied, undo = false }) {
  const conflicts = Array.isArray(d?.title_conflicts) ? d.title_conflicts : [];
  console.log(`${undo ? (applied ? "已收起" : "将收起") : applied ? "已导入" : "干跑"}: ${d?.created ?? 0} 条` +
    (d?.alias ? `  来自 ${d.alias}` : "") + (d?.skipped_existing ? `  已存在 ${d.skipped_existing}` : ""));
  if (conflicts.length) {
    console.log(`  与你自己的记忆撞名 ${conflicts.length} 条（同类型同标题，不会被并入，需要你处置）：`);
    for (const c of conflicts.slice(0, 10)) console.log(`    - [${c.type}] ${c.title}`);
    if (conflicts.length > 10) console.log("    … 只列前 10 条");
  }
  for (const s of (Array.isArray(d?.sample) ? d.sample : []).slice(0, 10)) console.log(`    · [${s.type}] ${s.title}`);
}
```

`switch (cmd)` 里加 `case 'receive': return cmdReceive(cfg, rest, flags);`、`case 'undo-share': return cmdUndoShare(cfg, rest, flags);`——**照本文件现有 case 的实参形状取 `rest`**（`config` 那条用的是 `rest[0]`/`rest.slice(1)`，`reclaim` 那条没有位置参数），别处若位置参数来源不同就以那里为准。

USAGE（`:47`）在 `share` 段之后加：

```
  receive <包文件> [--apply]
                               把对方 share 出来的包吃进自己的库（默认干跑，一个字都不写）
                               外来行标 source=imported，不参与本机的巩固/降级，也不并入你的条目
                               --apply 才真的写；重复吃同一个包不会多出第二份
  undo-share <包文件> [--apply]
                               按 pack_id 收起整包（物删：包还能重新导入，归档位会占住 UNIQUE）
```

- [ ] **Step 4: 跑到通过**

```bash
node --check bin/cli.mjs
node --test test/cli-receive.test.js test/cli-flag-value.test.js test/cli-share.test.js
node bin/cli.mjs --help | grep -A 5 "receive <"
```
Expected: 全绿，帮助里有两段。

- [ ] **Step 5: 提交**

```bash
git add bin/cli.mjs test/cli-receive.test.js
git commit -m "feat(share): add receive and undo-share to the CLI"
```

---

### Task C8: 关掉 document 吸收那条旁路（spec §15 一）

**Files:**
- Modify: `src/document.js:281-288`
- Test: `test/share-imported-guard.test.js`（追加）

**Interfaces:**
- Consumes: `isImportedRow`（车道 B1）
- Produces: `registerDocument` 的结果里多一个 `evidenceSkipped`（外来证据行**不归档**的条数），报告可见不是静默

- [ ] **Step 1: 写失败测试**

追加到 `test/share-imported-guard.test.js`：

```js
test("registerDocument's evidence absorb never archives a foreign row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-doc-absorb-"));
  const store = createStore(join(dir, "memory.db"));
  try {
    const service = createService({ store, mirror: null, config: {} });
    const foreign = store.save({ type: "pattern", title: "别人的模式", content: "正文正文正文", tags: [], source: IMPORTED_SOURCE });
    const own = store.save({ type: "pattern", title: "我的模式", content: "正文正文正文", tags: [] });
    const out = await service.registerDocument({
      title: "文档", summary: "摘要句子。", content: "正文正文", docPath: join(dir, "docs/x.md"),
      evidence: [foreign.id, own.id]
    });
    assert.equal(store.getById(foreign.id).archived, 0, "a machine-driven absorb must not archive someone else's memory");
    assert.equal(store.getById(own.id).archived, 1, "own evidence still absorbs");
    assert.equal(out.evidenceSkipped, 1, "the skipped count must be visible, not silently dropped");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

> `registerDocument` 的调用形状（参数名 `docPath`/`doc_path`、是模块函数还是 service 方法、返回字段名）以 `src/document.js` 与 `src/service.js:registerDocument` 为准。实施时先读再写，把核到的行号写进报告——这条断言若因为调用形状不对而永远不执行，就是假绿。

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-imported-guard.test.js`
Expected: FAIL —— 外来行 `archived` 变 1，或 `evidenceSkipped` 是 `undefined`

- [ ] **Step 3: 写实现**

`src/document.js` 吸收循环：

```js
    for (const id of kept) {
      const row = store.getById(id);
      if (!row || row.archived || row.forgotten) continue;
      if (isImportedRow(row)) { evidenceSkipped += 1; continue; }
      if (pinnedTypes.has(row.type) || ABSORB_EXEMPT_TYPES.has(row.type)) continue;
      store.setArchived(id, true);
      evidenceArchived += 1;
    }
```

计数初值与返回字段加进结果对象（`evidenceSkipped`）。顶部补 `import { isImportedRow } from "./memory-source.js";`。

注释要写：这条旁路**不经任何 `service.all()` 池**，所以车道 B 的九个池子挡不住它；证据 id 是调用方给的，机器发起的批量归档正是决策 2 要禁的动作。

- [ ] **Step 4: 跑到通过 + 回归**

```bash
node --test test/share-imported-guard.test.js test/document.test.js test/service.test.js
npm run sync
```
Expected: 全绿（`test/document.test.js` 名字以仓库实际为准，找不到就跑全量）。

- [ ] **Step 5: 提交**

```bash
git add src/document.js test/share-imported-guard.test.js lib/document.js
git commit -m "feat(share): evidence absorb never archives foreign rows"
```

---

### Task C9: 手改外来行不许摘掉守卫（spec §15 二）

**Files:**
- Modify: `dsh-mneme/docs/SHARE.md`
- Test: `test/share-imported-identity.test.js`

**Interfaces:**
- Consumes: `service.mergeHumanEdits`（`src/service.js:1949-1995`）、`store.update`
- Produces: 一条行为锁 —— 手改之后 `source` 仍为 `imported`、两个 scope 仍为 NULL

- [ ] **Step 1: 写失败测试**

创建 `test/share-imported-identity.test.js`：

```js
// spec §15 二：镜像里手改一条外来记忆是**允许**的（那是接收方自己磁盘上的字，
// 静默改回去比改写更糟）。这里锁的不是「改不了」，而是改完之后身份还在——
// 否则「编辑一次正文」就成了绕过车道 B 九个池子的合法手段。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { IMPORTED_SOURCE } from "../src/memory-source.js";
import { parseHumanEdits } from "../src/mirror.js";

test("a hand edit rewrites the body but never the guard identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-imported-identity-"));
  const store = createStore(join(dir, "memory.db"));
  try {
    const service = createService({ store, mirror: null, config: {} });
    const row = store.save({ type: "preference", title: "别人的偏好", content: "原文", tags: [],
      source: IMPORTED_SOURCE, share_pack_id: "f0f0f0f0f0f0f0f0", share_external_id: "deadbeef00000099" });
    const markdown = `## 别人的偏好\n\n- **ID**: \`${row.id}\`\n- **类型**: preference\n- **重要性**: 3\n- **标签**: \n- **更新**: ${row.updated_at}\n\n<!-- mirror-digest: 0000 -->\n\n我改过的正文\n`;
    service.mergeHumanEdits("preference", parseHumanEdits(markdown));
    const after = store.getById(row.id);
    assert.equal(after.content, "我改过的正文", "the edit lands");
    assert.equal(after.source, IMPORTED_SOURCE, "editing the body must not demote it out of the foreign set");
    assert.equal(after.share_external_id, "deadbeef00000099");
    assert.equal(after.agent_scope, undefined);
    assert.equal(after.workspace_scope, undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑到失败或确认现状**

Run: `node --test test/share-imported-identity.test.js`

这条**今天可能就绿**（`store.update` 的 patch 不该动 `source`）。这是允许的：它的价值是防未来有人给 `update` 加「按 source 重归属」这类便利。如果不绿，**不许改实现让它绿**——先读 patch 白名单（`src/store.js:1247` 起的 `update`）确认是哪一列被顺手动了，报告出来。若绿，在报告里写「本条为回归锁，当前通过」。若镜像文本的字段标签对不上解析器，照 `src/mirror.js` 的 `STR.mirrorLabel` 实际标签改文本，别改解析器。

- [ ] **Step 3: 文档写下这条边界**

在 `dsh-mneme/docs/SHARE.md` 的外来区一节加（照该文件现有语气）：

```markdown
### 手改外来行：允许，但身份不变
`preferences.md` 里改一条别人发来的记忆，正文会落地（这是你磁盘上的文件，把刚打进去的字
静默改回去比改写更糟）。不变的是 `source=imported` 与两个 scope —— 由
`test/share-imported-identity.test.js` 钉住。也就是说：手改之后那条记忆不再是发件人的原文，
但它仍然不会被本机的巩固、降级或整理并走。
```

- [ ] **Step 4: 全量**

```bash
node --test test/share-imported-identity.test.js test/mirror.test.js test/service.test.js
npm test
```
Expected: 全绿（基线 2329 pass / 0 fail / 1 skipped，加上本车道的新增）。

- [ ] **Step 5: 提交**

```bash
git add test/share-imported-identity.test.js dsh-mneme/docs/SHARE.md
git commit -m "test(share): a hand edit keeps a foreign row's guard identity"
```

---

### Task C10: 文档扫面、清单核对与实测数

**Files:**
- Modify: `SECURITY.md`（四处）、`README.md`、`dsh-mneme/README.md`、`dsh-mneme/docs/DAEMON.md`、`dsh-mneme/docs/SHARE.md`、`AGENTS.md`

- [ ] **Step 1: 让双向比对告诉你缺哪些**

```bash
cd dsh-mneme && node --test test/security-doc.test.js
```
Expected: FAIL，报出 `/receive`、`/receive/undo` 缺在哪条清单。按它说的补，**四处都要**：英文与中文各两份（一个过滤器取 `open||token-write`，另一个取 `token||token-write`）。只往清单里加路径名，不新起 bullet。

Run again → `node --test test/security-doc.test.js`，Expected: PASS。

- [ ] **Step 2: 测试看不见的那几处**

- `dsh-mneme/README.md`：端点表加 `/receive` 与 `/receive/undo` 两行，并修「独立面只有 POST」这类已被车道 A 的 405 事实推翻的全局说法（若已改准就跳过）；`README.md:502` 那一族「敏感读」清单要收 `/receive*`（它们是写操作，收进受门控那一族）。
- `dsh-mneme/docs/DAEMON.md`：数据面能力清单加两条，并写明独立服务无 LLM、入库只是结构落库。
- `AGENTS.md`：模块地图把 `src/share.js` / `src/share-http.js` 挂上（车道 A 只留了 `memory-source.js` 那行），一句话写清「两张皮共用一份解析」这条纪律归它俩。

- [ ] **Step 3: `docs/SHARE.md` 补 receive 一节**

必须包含（用测出来的真数，不许留空表）。跑这一段拿数，它只打印聚合量：

```bash
cd dsh-mneme && node - <<'JS'
// 导入侧的实测：包条数 → 建行的墙钟时间。真库副本，用完即删。
// 只打印条数与毫秒，正文一个字都不进 stdout、不进文档。
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./src/store.js";
import { createService } from "./src/service.js";
import { buildSharePack } from "./src/share.js";

const dir = mkdtempSync(join(tmpdir(), "mneme-c-measure-"));
const src = process.env.MNEME_SRC_DB;          // 指向你自己的库；不设就退回合成数据
if (!src) { console.log("没设 MNEME_SRC_DB：用 5,778 条合成行"); }
const store = createStore(src ? join(dir, "copy.db") : join(dir, "fresh.db"));
if (src) for (const suf of ["", "-wal", "-shm"]) { try { copyFileSync(src + suf, join(dir, "copy.db" + suf)); } catch {} }
const service = createService({ store, mirror: null, config: {} });
const { pack } = buildSharePack({ rows: store.all(), homeDir: "/fake/home", packageVersion: "dev", filters: { type: ["decision", "pitfall", "preference", "constraint", "pattern", "project", "history", "rejected_solution"] } });
const n = pack.memories.length;
const t0 = Date.now();
const out = service.importSharePack(pack, {});
const ms = Date.now() - t0;
console.log(`包 ${n} 条 → 导入 ${out.created} 条，用时 ${ms} ms（每 ${Math.max(1, Math.round(ms / Math.max(1, out.created)))} 微秒/条）`);
store.close();
rmSync(dir, { recursive: true, force: true });
JS
```

- 用法三条命令（`receive <包文件>` 干跑 / `--apply` / `undo-share <包文件>`）；
- 「吃什么、不吃什么」表：`document`/`summary` 不收、撞名不并入只报数、`source=imported`、`created_at` 是导入时刻；
- 实测一节：包条数 → 建行的墙钟时间、嵌入队列排空是否跟着提交、UNIQUE 位释放后可重导；
- 「已知还没做」：面板按钮属车道 D，`included` 在 `deduped` 之后不等于合格条数（面板不许误读，车道 D 的账）。

- [ ] **Step 4: 全套绿 + 平价**

```bash
npm run sync && npm test
node --test test/lib-smoke.test.js
```
Expected: 全绿；`check-sync` 平。

- [ ] **Step 5: 提交**

```bash
git add SECURITY.md README.md dsh-mneme/README.md dsh-mneme/docs/DAEMON.md dsh-mneme/docs/SHARE.md AGENTS.md
git commit -m "docs(share): document receive, its gates, and the measured cost"
```

---

## 收尾清单（合完逐项确认）

- [ ] `npm test` 全绿；`test/api.test.js:753` 的 `103` 没动过。
- [ ] 两张皮的 `GET` 都答 405、`receiveReply`/`undoReply` 各只有一份实现（跨面静态锁为绿）。
- [ ] 两次真导入（同一包跑两遍）在 CLI 输出里 `created = 0`，且第一次的 `dry_run` 报告与真导入同形状。
- [ ] 每个提交的 `git log --format=%B` 里没有 AI 署名、没有任何 `Co-Authored-By`。
- [ ] 车道 D 的账记在 `docs/SHARE.md`：面板三件（分享弹层、接收弹层含干跑预览、外来区筛选与「收起这个包」），以及 `included`/`deduped` 的读法。
- [ ] 真机端到端：她 relink 插件之后跑 `share --dry-run` → 把包发给第二台机器 → `receive` → `undo-share`。在此之前，`/share` 在她当前运行的构建上是 404。
