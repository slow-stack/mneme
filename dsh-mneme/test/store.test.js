import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";

function openMemory() {
  return createStore(":memory:");
}

test("createStore initializes schema and opens db", () => {
  const store = openMemory();
  const row = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
  ).get();
  assert.ok(row, "memories table exists");
  const cursorTable = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='distill_cursors'"
  ).get();
  assert.ok(cursorTable, "distill cursor table exists");
  assert.equal(store.getDistillCursor("session-1"), undefined);
  const saved = store.setDistillCursor("session-1", 4);
  assert.equal(saved.last_seq, 4);
  assert.ok(saved.updated_at);
  assert.equal(store.setDistillCursor("session-1", 2).last_seq, 4, "cursor never moves backwards");
  store.close();
});

test("save inserts a memory and returns it with id/created_at", () => {
  const store = openMemory();
  const saved = store.save({
    type: "preference",
    title: "语言",
    content: "用户用中文交流",
    tags: ["偏好"],
    importance: 5,
    source: "manual"
  });
  assert.ok(saved.id, "has id");
  assert.ok(saved.created_at, "has created_at");
  assert.equal(saved.type, "preference");
  assert.equal(store.count(), 1);
  store.close();
});

test("getById returns the memory", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  const got = store.getById(saved.id);
  assert.equal(got.title, "t");
  assert.equal(got.content, "c");
  store.close();
});

test("update modifies fields and bumps updated_at", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  const updated = store.update(saved.id, { content: "new content", importance: 4 });
  assert.equal(updated.content, "new content");
  assert.equal(updated.importance, 4);
  assert.notEqual(updated.updated_at, saved.updated_at);
  store.close();
});

test("remove deletes the memory", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c" });
  store.remove(saved.id);
  assert.equal(store.getById(saved.id), undefined);
  assert.equal(store.count(), 0);
  store.close();
});

test("list filters by type and paginates", () => {
  const store = openMemory();
  for (let i = 0; i < 5; i++) store.save({ type: "preference", title: `p${i}`, content: "c" });
  for (let i = 0; i < 3; i++) store.save({ type: "project", title: `j${i}`, content: "c" });
  assert.equal(store.list({ type: "preference" }).length, 5);
  assert.equal(store.list({ type: "project" }).length, 3);
  assert.equal(store.list({ limit: 2 }).length, 2);
  assert.equal(store.list({ limit: 2, offset: 2 }).length, 2);
  store.close();
});

test("setForget toggles injection suppression", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 5 });
  store.setForget(saved.id, true);
  const got = store.getById(saved.id);
  // toRow maps SQLite 0/1 to boolean
  assert.equal(got.forgotten, true);
  store.close();
});

test("count excludes forgotten by default, includeForgotten opts in", () => {
  const store = openMemory();
  const a = store.save({ type: "project", title: "t1", content: "c" });
  store.save({ type: "project", title: "t2", content: "c" });
  store.save({ type: "preference", title: "p", content: "c" });
  store.setForget(a.id, true);
  assert.equal(store.count(), 2, "default excludes forgotten (matches list)");
  assert.equal(store.count("project"), 1);
  assert.equal(store.count("preference"), 1);
  assert.equal(store.count(undefined, { includeForgotten: true }), 3);
  assert.equal(store.count("project", { includeForgotten: true }), 2);
  store.close();
});

test("search matches title, content and tags", () => {
  const store = openMemory();
  store.save({ type: "project", title: "记忆插件", content: "c1", tags: [] });
  store.save({ type: "project", title: "t2", content: "用户用中文交流", tags: [] });
  store.save({ type: "preference", title: "t3", content: "c3", tags: ["偏好"] });
  assert.ok(store.search("记忆插件").some((m) => m.title === "记忆插件"));
  assert.ok(store.search("中文").some((m) => m.content === "用户用中文交流"));
  assert.ok(store.search("偏好").some((m) => m.tags.includes("偏好")));
  store.close();
});

test("search with empty query returns []", () => {
  const store = openMemory();
  store.save({ type: "project", title: "t", content: "c" });
  assert.deepEqual(store.search(""), []);
  assert.deepEqual(store.search("   "), []);
  store.close();
});

test("forgotten memories are excluded from list and search until un-forgotten", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "秘密", content: "c", importance: 5 });
  assert.ok(store.list().some((m) => m.id === saved.id));
  assert.ok(store.search("秘密").some((m) => m.id === saved.id));
  store.setForget(saved.id, true);
  assert.ok(!store.list().some((m) => m.id === saved.id));
  assert.ok(!store.search("秘密").some((m) => m.id === saved.id));
  store.setForget(saved.id, false);
  assert.ok(store.list().some((m) => m.id === saved.id));
  assert.ok(store.search("秘密").some((m) => m.id === saved.id));
  store.close();
});

test("search matches CJK substring", () => {
  const store = openMemory();
  store.save({ type: "project", title: "t", content: "用户用中文交流" });
  assert.equal(store.search("中文").length, 1);
  store.close();
});

test("search respects limit", () => {
  const store = openMemory();
  for (let i = 0; i < 3; i++) store.save({ type: "project", title: `m${i}`, content: "匹配词" });
  assert.equal(store.search("匹配词").length, 3);
  assert.equal(store.search("匹配词", { limit: 2 }).length, 2);
  store.close();
});

test("list sanitizes invalid limit/offset", () => {
  const store = openMemory();
  for (let i = 0; i < 3; i++) store.save({ type: "project", title: `t${i}`, content: "c" });
  assert.equal(store.list({ limit: -1 }).length, 3);
  assert.equal(store.list({ limit: 0 }).length, 3);
  assert.equal(store.list({ limit: 1.5 }).length, 3);
  assert.equal(store.list({ limit: 2, offset: -5 }).length, 2);
  store.close();
});

test("schema migration adds archived column to legacy database", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-migrate-"));
  const dbPath = join(dir, "legacy.db");
  try {
    // Create a legacy db WITHOUT archived column
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
      forgotten INTEGER NOT NULL DEFAULT 0, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    legacy.close();
    // Open with createStore → should ALTER TABLE
    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
    assert.ok(cols.includes("archived"), "archived column added");
    const cursorTable = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='distill_cursors'"
    ).get();
    assert.ok(cursorTable, "new cursor table is created for legacy databases");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setArchived marks entry archived; list excludes it by default", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  const archived = store.setArchived(saved.id, true);
  assert.equal(archived.archived, true);
  assert.equal(store.list().length, 0, "excluded from default list");
  assert.equal(store.list({ includeArchived: true }).length, 1, "included with flag");
  assert.equal(store.count(), 0, "excluded from default count");
  assert.equal(store.count(undefined, { includeArchived: true }), 1);
  store.close();
});

test("search excludes archived by default", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "secret", content: "hidden content", importance: 3 });
  store.setArchived(saved.id, true);
  assert.equal(store.search("secret").length, 0);
  assert.equal(store.search("secret", { includeArchived: true }).length, 1);
  store.close();
});

// ============================ #275 第二批：archived_at 精确归档时刻

test("schema migration adds archived_at column to legacy database", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-migrate-at-"));
  const dbPath = join(dir, "legacy.db");
  try {
    // 存量库：有 archived 标志位，但没有 archived_at（#275 第一批时代的库）
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
      forgotten INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    legacy.exec(`INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, source, created_at, updated_at)
      VALUES ('old1', 'history', 't', 'c', '[]', 3, 0, 1, NULL, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');`);
    legacy.close();

    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
    assert.ok(cols.includes("archived_at"), "archived_at column added");
    // 存量归档行零重写：不回填 updated_at（那等于把被推翻的代理口径固化进列里）
    const raw = store.db.prepare("SELECT archived_at FROM memories WHERE id = 'old1'").get();
    assert.equal(raw.archived_at, null, "legacy archived row keeps NULL, not backfilled from updated_at");
    assert.equal(store.getById("old1").archived_at, undefined, "NULL 读作 undefined，调用方须显式处理");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archived_at migration is idempotent: reopening the upgraded database is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-migrate-at2-"));
  const dbPath = join(dir, "upgraded.db");
  try {
    const first = createStore(dbPath);
    const m = first.save({ type: "history", title: "t", content: "c" });
    first.setArchived(m.id, true);
    const stamp = first.getById(m.id).archived_at;
    first.close();

    // 再开一次：addColumn 先 PRAGMA 后 ALTER，不该报错、不该重建、不该动已有值
    const second = createStore(dbPath);
    const cols = second.db.prepare("PRAGMA table_info(memories)").all().filter((c) => c.name === "archived_at");
    assert.equal(cols.length, 1, "列只存在一份，没被重复 ALTER");
    assert.equal(second.getById(m.id).archived_at, stamp, "重开不动已落盘的归档时刻");
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setArchived stamps archived_at on archive, clears it on restore", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  assert.equal(saved.archived_at, undefined, "新建行未归档 → 无时刻");

  const archived = store.setArchived(saved.id, true);
  assert.equal(archived.archived, true);
  assert.ok(archived.archived_at, "活跃 → 归档落时刻");
  assert.ok(
    Math.abs(Date.parse(archived.archived_at) - Date.now()) < 5000,
    "落的是当下时刻，不是别的行的 updated_at"
  );

  const restored = store.setArchived(saved.id, false);
  assert.equal(restored.archived, false);
  assert.equal(restored.archived_at, undefined, "取消归档清空");
  store.close();
});

test("setArchived keeps updated_at semantics (existing readers depend on it)", () => {
  // archived_at 是新增列，不是 updated_at 的替代品：面板排序、快照哈希、CAS 都读
  // updated_at，本函数自 v0.2 起就无条件刷它——改口径不得顺手改掉这条既有语义。
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  const before = store.getById(saved.id).updated_at;
  const archived = store.setArchived(saved.id, true);
  assert.ok(Date.parse(archived.updated_at) >= Date.parse(before), "updated_at 照旧被刷");
  const again = store.setArchived(saved.id, false);
  assert.ok(Date.parse(again.updated_at) >= Date.parse(archived.updated_at), "取消归档也刷");
  store.close();
});

test("save with archived:true stamps archived_at at insert time", () => {
  // 铸造即归档的行：archived=1 而 archived_at=NULL 会落进「存量行」语义，读侧只能
  // 当它时刻不可追溯——明明是当下发生的归档，白丢一条记录。
  const store = openMemory();
  const born = store.save({ type: "history", title: "生来就归档", content: "c", archived: true });
  assert.equal(born.archived, true);
  assert.ok(born.archived_at, "入库即归档 → 归档时刻 = 入库时刻");
  assert.equal(born.archived_at, born.created_at, "两列同源（同一个 nowIso）");

  const live = store.save({ type: "history", title: "活跃", content: "c" });
  assert.equal(live.archived_at, undefined);
  store.close();
});

test("update() cannot set archived_at (archived is not an updatable field)", () => {
  // 归档时刻只能由 setArchived 落。若 update 的 patch 能写它，就等于给精确口径开了
  // 一个绕过 setArchived 语义（幂等 / 清空）的后门，代理口径会从缝里长回来。
  const store = openMemory();
  const saved = store.save({ type: "history", title: "t", content: "c" });
  store.update(saved.id, { archived_at: "2020-01-01T00:00:00.000Z", content: "改过" });
  assert.equal(store.getById(saved.id).archived_at, undefined, "patch 里的 archived_at 被忽略");
  store.close();
});

// --- vector search ---

test("save/update persist embedding vector and searchVector ranks by cosine", () => {
  const store = openMemory();
  const a = store.save({ type: "preference", title: "猫", content: "喜欢猫", embedding: [1, 0, 0] });
  const b = store.save({ type: "preference", title: "狗", content: "喜欢狗", embedding: [0, 1, 0] });
  const c = store.save({ type: "preference", title: "猫狗", content: "都养", embedding: [0.9, 0.1, 0] });

  const hits = store.searchVector([1, 0, 0], { limit: 3 });
  assert.deepEqual(hits.map((m) => m.id), [a.id, c.id, b.id]);
  assert.equal(hits[0].score, 1);
  assert.ok(hits[1].score > hits[2].score);

  // update re-stores embedding
  store.update(b.id, { embedding: [1, 1, 0] });
  const hits2 = store.searchVector([1, 1, 0], { limit: 3 });
  assert.equal(hits2[0].id, b.id);
  store.close();
});

test("searchVector only considers rows with an embedding and filters forgotten/archived", () => {
  const store = openMemory();
  const plain = store.save({ type: "project", title: "无向量", content: "x" });
  const withVec = store.save({ type: "project", title: "有向量", content: "y", embedding: [1, 0, 0] });
  store.setForget(withVec.id, true);
  assert.deepEqual(store.searchVector([1, 0, 0]).map((m) => m.id), []);
  store.setForget(withVec.id, false);
  store.setArchived(withVec.id, true);
  assert.deepEqual(store.searchVector([1, 0, 0]).map((m) => m.id), []);
  store.setArchived(withVec.id, false);
  assert.deepEqual(store.searchVector([1, 0, 0]).map((m) => m.id), [withVec.id]);
  assert.equal(plain.id, plain.id, "plain row keeps id");
  store.close();
});

test("setEmbedding, embeddedCount, needsEmbedding and threshold filtering", () => {
  const store = openMemory();
  const t1 = store.save({ type: "project", title: "t1", content: "c1" });
  const m2 = store.save({ type: "project", title: "t2", content: "c2" });
  assert.equal(store.embeddedCount(), 0);
  store.setEmbedding(m2.id, [0, 1]);
  assert.equal(store.embeddedCount(), 1);
  // Status-card denominator alignment: count() defaults exclude archived and
  // forgotten rows, so embeddedCount must drop them too.
  store.setArchived(m2.id, true);
  assert.equal(store.embeddedCount(), 0, "archived rows leave the embedded count");
  store.setArchived(m2.id, false);
  store.setForget(m2.id, true);
  assert.equal(store.embeddedCount(), 0, "forgotten rows leave the embedded count");
  store.setForget(m2.id, false);
  assert.equal(store.embeddedCount(), 1);
  const missing = store.needsEmbedding(10);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, t1.id, "only the non-embedded row is listed");

  const t3 = store.save({ type: "project", title: "t3", content: "c3", embedding: [1, 1] });
  // threshold 0.99: only t3 (cos=1) survives; m2 ([0,1]) scores ~0.707.
  const near = store.searchVector([1, 1], { limit: 5, threshold: 0.99 });
  assert.deepEqual(near.map((m) => m.id), [t3.id]);
  store.close();
});

test("save/update preserve archived flag", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c" });
  store.setArchived(saved.id, true);
  const updated = store.update(saved.id, { content: "new" });
  assert.equal(updated.archived, true, "update keeps archived");
  store.close();
});

// --- compare-and-set update (item ①/③) ------------------------------------

test("compareAndUpdate applies when the version token still matches", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "count=0" });
  const before = store.getById(saved.id);
  const updated = store.compareAndUpdate(saved.id, before.updated_at, { content: "count=1" });
  assert.ok(updated, "CAS with the current version succeeds");
  assert.equal(updated.content, "count=1");
  assert.notEqual(updated.updated_at, before.updated_at, "version token advances");
  store.close();
});

test("compareAndUpdate rejects a stale version token without writing", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "count=0" });
  const stale = store.getById(saved.id).updated_at;
  store.update(saved.id, { content: "count=1" }); // concurrent write wins
  const result = store.compareAndUpdate(saved.id, stale, { content: "count=2" });
  assert.equal(result, undefined, "stale CAS is a miss");
  assert.equal(store.getById(saved.id).content, "count=1", "no lost update");
  store.close();
});

test("compareAndUpdate on unknown id throws like update", () => {
  const store = openMemory();
  assert.throws(() => store.compareAndUpdate("ghost", "any", { content: "x" }), /not found/);
  store.close();
});

// --- conflict freeze: pending manual review -------------------------------

test("saveConflictPending inserts and listConflictPending excludes resolved by default", () => {
  const store = openMemory();
  const a = store.save({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const b = store.save({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const pending = store.saveConflictPending({ run_id: "run-1", memory_a: a.id, memory_b: b.id, reason: "日期更新" });
  assert.ok(pending.id, "has id");
  assert.equal(pending.run_id, "run-1");
  assert.equal(pending.reason, "日期更新");
  assert.ok(pending.created_at);
  assert.equal(pending.resolved_at, undefined);

  const list = store.listConflictPending();
  assert.equal(list.length, 1);
  assert.ok([list[0].memory_a, list[0].memory_b].includes(a.id), "pair holds both sides");
  assert.ok([list[0].memory_a, list[0].memory_b].includes(b.id));

  const resolved = store.resolveConflictPending(pending.id, { winner: a.id });
  assert.ok(resolved.resolved_at, "resolution stamped");
  assert.equal(resolved.resolved_winner, a.id);
  assert.equal(store.listConflictPending().length, 0, "resolved excluded by default");
  const all = store.listConflictPending({ includeResolved: true });
  assert.equal(all.length, 1, "resolved visible with includeResolved");
  assert.equal(all[0].resolved_winner, a.id);
  store.close();
});

test("saveConflictPending dedupes the same pair regardless of order", () => {
  const store = openMemory();
  const a = store.save({ type: "decision", title: "截止", content: "x" });
  const b = store.save({ type: "decision", title: "截止2", content: "y" });
  const p1 = store.saveConflictPending({ memory_a: a.id, memory_b: b.id, reason: "r1" });
  const p2 = store.saveConflictPending({ memory_a: b.id, memory_b: a.id, reason: "r2" });
  assert.equal(p2.id, p1.id, "same pair re-detected returns the existing pending row");
  assert.equal(p2.reason, "r1", "original reason preserved");
  assert.equal(store.listConflictPending().length, 1, "never a duplicate queue entry");
  store.close();
});

test("countConflictPending counts unresolved rows only; resolve unknown id is undefined", () => {
  const store = openMemory();
  const a = store.save({ type: "decision", title: "a", content: "x" });
  const b = store.save({ type: "decision", title: "b", content: "y" });
  const c = store.save({ type: "decision", title: "c", content: "z" });
  store.saveConflictPending({ memory_a: a.id, memory_b: b.id, reason: "ab" });
  const p2 = store.saveConflictPending({ memory_a: b.id, memory_b: c.id, reason: "bc" });
  assert.equal(store.countConflictPending(), 2);
  store.resolveConflictPending(p2.id, { winner: b.id });
  assert.equal(store.countConflictPending(), 1, "resolved no longer pending");
  assert.equal(store.resolveConflictPending("ghost"), undefined, "unknown id resolves to undefined");
  store.close();
});

test("conflict_pending table persists across store reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-conflict-"));
  const path = join(dir, "memory.db");
  const s1 = createStore(path);
  s1.saveConflictPending({ run_id: "run-1", memory_a: "ma", memory_b: "mb", reason: "x" });
  s1.close();
  const s2 = createStore(path);
  const pending = s2.listConflictPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, "x");
  s2.close();
});

// Issue #128：回填候选只取活跃行——归档/遗忘行不参与召回与聚类，不该吃掉
// 回填配额（报告实测 50 个 reindex 名额全部落在归档行，88 条活跃记忆永远轮不到）。
test("Issue #128: needsEmbedding skips archived and forgotten rows", () => {
  const store = openMemory();
  const active = store.save({ type: "preference", title: "活跃", content: "内容" });
  const archived = store.save({ type: "preference", title: "归档", content: "内容" });
  const forgotten = store.save({ type: "preference", title: "遗忘", content: "内容" });
  store.setArchived(archived.id, true);
  store.setForget(forgotten.id, true);
  const ids = store.needsEmbedding(50).map((r) => r.id);
  assert.deepEqual(ids, [active.id], "only the active row is a backfill candidate");
  store.close();
});
