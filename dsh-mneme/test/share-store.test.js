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
    // toRow 读不到列时也返回 undefined，所以「列真的建了」「建的是 NULL 而不是 ''」
    // 这两件事只能在库里看——否则本用例对迁移毫无判别力。
    const cols = store.db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
    assert.ok(cols.includes("share_pack_id") && cols.includes("share_external_id"),
      "reopen must add both columns to a legacy library");
    const stored = store.db.prepare("SELECT share_pack_id, share_external_id AS e FROM memories WHERE id = 'legacy-1'").get();
    assert.equal(stored.share_pack_id, null, "legacy cells are NULL, not '' (empty string would collide in the UNIQUE index)");
    assert.equal(stored.e, null);
  } finally { store.close(); }
  // 幂等重开：第二个连接开在同一条路径上，列已在，迁移不许再动它一根手指。
  const again = createStore(path);
  try {
    assert.ok(again.getById("legacy-1"));
    assert.equal(again.getById("legacy-1").share_pack_id, undefined);
  } finally { again.close(); rmSync(dir, { recursive: true, force: true }); }
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
    const b = store.save({ type: "preference", title: "t2", content: "c", source: IMPORTED_SOURCE, share_pack_id: "packA", share_external_id: "deadbeef00000012" });
    store.save({ type: "preference", title: "keep", content: "c", source: IMPORTED_SOURCE, share_pack_id: "packB", share_external_id: "deadbeef00000013" });
    // 归档面也要一起收走：整包退出之后不许留下「来自一个已经收起的包」的行。
    // 行数用库级 count 而不是 store.count()——后者按活跃面过滤，归档行不在账上，
    // 拿它当「删了几行」的锚会把断言变成过滤器口径的探针（那不是本用例要锁的东西）。
    store.setArchived(b.id, true);
    const totalRows = () => store.db.prepare("SELECT count(*) AS c FROM memories").get().c;
    // 真实 schema 的必填列是 (memory_id, session_id, seq_start, seq_end, created_at) 全部
    // NOT NULL，走 store 自己的写入口 saveMemoryProvenance，不走手搓 INSERT。
    //
    // 这里先把 foreign_keys 关掉，不是随手配置：memory_provenance 挂着
    // ON DELETE CASCADE，而 node:sqlite 的 DatabaseSync 默认就把 PRAGMA foreign_keys 开成
    // 1（实测：新库上 `PRAGMA foreign_keys` 返回 1）。FK 开着时删记忆由级联代劳，本用例
    // 断言的「批删自己清链接」就永远测不到那行代码——变异检验证实：摘掉 deleteBySharePackId
    // 里那条 DELETE FROM memory_provenance，五条用例照绿。关掉之后级联不再代劳，
    // 断言测的才是显式清理本身。（`src/store.js` 的 `remove()` 注释在 C1 修复轮已经改成
    // 真口径：node:sqlite 默认就把外键开着、级联是活的，显式清理是为了不把清理押在一份没人
    // 钉过的驱动默认上——本用例反过来**临时关掉**它，恰恰就是为了让那句「不押注」可测。）
    store.db.exec("PRAGMA foreign_keys = OFF");
    store.saveMemoryProvenance({ memoryId: a.id, sessionId: "s-1", seqStart: 1, seqEnd: 3, createdAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(store.provenanceFor(a.id).length, 1, "the link must exist before the delete or the assertion below is empty");
    const before = totalRows();
    const genBefore = store.getMirrorState().generation;
    assert.equal(store.listBySharePackId("packA").length, 2, "the withdrawal inventory must see archived rows too");
    const deleted = store.deleteBySharePackId("packA");
    assert.equal(deleted, 2);
    assert.ok(store.getMirrorState().generation > genBefore,
      "batch delete must register mirror debt like remove() does, else recoverMirror reads the pack as 「not yet synced」");
    assert.equal(totalRows(), before - 2);
    assert.equal(store.provenanceFor(a.id).length, 0, "provenance links must not dangle after a batch delete");
    assert.equal(store.getByShareExternalId("deadbeef00000011"), undefined, "UNIQUE slot must be freed for a clean re-import");
    assert.equal(store.listBySharePackId("packA").length, 0);
    assert.equal(store.listBySharePackId("packB").length, 1);
    const genAfterDelete = store.getMirrorState().generation;
    assert.equal(store.deleteBySharePackId("packA"), 0, "idempotent");
    assert.equal(store.getMirrorState().generation, genAfterDelete,
      "a no-op withdrawal deletes nothing, so it must not register mirror debt either");
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
