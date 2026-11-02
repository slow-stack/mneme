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

// Issue #533：differentiate 的裁决账本。正文不再追加注记，改由这张表记住「这一对
// 已经判过、两条都留」，候选构造阶段读它避免同一对每轮重判。
test("Issue #533: differentiated_pairs survives a reopen and normalizes pair order", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-diffpair-"));
  const path = join(dir, "memory.db");
  const s1 = createStore(path);
  // 送审顺序与存储顺序相反也要落到同一行（账本按 id 排序归一）。
  s1.saveDifferentiatedPair({ run_id: "r1", memory_a: "mb", memory_b: "ma", hash_a: "hb", hash_b: "ha", distinctions: ["只看甲", "只看乙"] });
  assert.equal(s1.listDifferentiatedPairs().length, 1);
  s1.close();
  const s2 = createStore(path);
  const found = s2.findDifferentiatedPair("ma", "mb");
  assert.ok(found, "lookups work in either argument order");
  assert.equal(found.memory_a, "ma", "the row is stored sorted");
  assert.equal(found.hash_a, "ha", "hashes travel with their side");
  assert.deepEqual(found.distinctions, ["只看甲", "只看乙"]);
  assert.equal(s2.listDifferentiatedPairs().length, 1, "re-saving the same pair updates instead of duplicating");
  s2.saveDifferentiatedPair({ run_id: "r2", memory_a: "ma", memory_b: "mb", hash_a: "ha2", hash_b: "hb2" });
  assert.equal(s2.listDifferentiatedPairs().length, 1, "still one row for one pair");
  const updated = s2.findDifferentiatedPair("ma", "mb");
  assert.equal(updated.hash_a, "ha2", "the refresh overwrites the hashes");
  assert.equal(updated.distinctions, undefined, "an empty distinctions lands as NULL, not as an empty array");
  s2.close();
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

// Issue #495：listDreamRuns 的 excludeRunType 是**下推**条件而不是调用方后置过滤——
// 后置过滤在 limit 生效之后就晚了：5 个名额已经被 organize 占掉，再筛只能得到空。
// 三条一起钉：默认不过滤（审计面要看全量）、指定值真的排除、白名单之外的值不生效
// （这个参数拼进 SQL 的 != 条件，任意外来字符串不能改变查询形状）。
test("Issue #495: listDreamRuns excludes a run type by pushdown, and only accepts known types", () => {
  const store = openMemory();
  store.saveDreamRun({ created_at: "2026-01-01T00:00:00.000Z", status: "ok", snapshot_hash: "h", input_count: 0, run_type: "auto", receipt: "r1" });
  store.saveDreamRun({ created_at: "2026-01-02T00:00:00.000Z", status: "ok", snapshot_hash: "h", input_count: 0, run_type: "organize", receipt: "r2" });
  store.saveDreamRun({ created_at: "2026-01-03T00:00:00.000Z", status: "ok", snapshot_hash: "h", input_count: 0, run_type: "organize", receipt: "r3" });

  assert.equal(store.listDreamRuns().length, 3, "no filter by default — the audit surface keeps every run type");
  assert.equal(store.listDreamRuns({ limit: 1 })[0].run_type, "organize", "limit applies to the full set");

  const onlyConsolidation = store.listDreamRuns({ limit: 1, excludeRunType: "organize" });
  assert.equal(onlyConsolidation.length, 1);
  assert.equal(onlyConsolidation[0].run_type, "auto", "the pushdown must apply before LIMIT, not after");

  // 白名单之外的值按「不过滤」处理，不静默返回空集。诚实说：这条断言钉得住
  // 「未知值 ⇒ 不过滤」这个可观测契约，钉不住白名单本身——把 includes 判断换成裸绑定，
  // 四条断言仍然全绿（不存在的 run_type 本来也筛不掉任何行）。白名单的价值是纵深：
  // 值来自调用方时只允许已知的三个字面量进 SQL 的 != 条件，查询形状不随外部字符串改变。
  assert.equal(store.listDreamRuns({ excludeRunType: "auto' OR 1=1 --" }).length, 3,
    "a hostile value is bound as a parameter and filters nothing, never widens the query");
  assert.equal(store.listDreamRuns({ excludeRunType: "nope" }).length, 3);
  store.close();
});

// ============================ #512 蒸馏 run 归因

test("#512 迁移：老库补上 distill_run_id 列与两张新表，存量链接留 NULL 不猜", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-migrate-run-"));
  const dbPath = join(dir, "legacy.db");
  try {
    // 存量库：#399 时代的形状——memory_provenance 没有 distill_run_id，也没有
    // distill_runs 与 memory_mints。这一行代表「改造之前就落盘的链接」，它没有 run 可指。
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("CREATE TABLE memories (" +
      "id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, " +
      "tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3, " +
      "forgotten INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, " +
      "source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);");
    legacy.exec("CREATE TABLE memory_provenance (" +
      "memory_id TEXT NOT NULL, session_id TEXT NOT NULL, " +
      "seq_start INTEGER NOT NULL, seq_end INTEGER NOT NULL, created_at TEXT NOT NULL);");
    legacy.exec("INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, source, created_at, updated_at) " +
      "VALUES ('old1', 'history', '老记忆', '内容', '[]', 3, 0, 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');");
    legacy.exec("INSERT INTO memory_provenance (memory_id, session_id, seq_start, seq_end, created_at) " +
      "VALUES ('old1', 's-old', 1, 5, '2026-01-02T00:00:00.000Z');");
    legacy.close();

    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(memory_provenance)").all().map((c) => c.name);
    assert.ok(cols.includes("distill_run_id"), "存量库重开即补上 distill_run_id");
    for (const table of ["distill_runs", "memory_mints"]) {
      const row = store.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      assert.ok(row, "存量库重开即建 " + table);
    }

    const links = store.provenanceFor("old1");
    assert.equal(links.length, 1);
    assert.equal(
      links[0].distill_run_id,
      null,
      "历史链接保持 NULL：反推一个合成 run id 比不填更坏（读数正常、实际是猜的）"
    );
    assert.equal(store.mintsFor("old1").length, 0, "历史记忆不补铸造记录——那时根本没有 run 概念");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#512 迁移幂等：重开已升级的库不重复 ALTER、不动已落盘的 run 归因", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-migrate-run2-"));
  const dbPath = join(dir, "upgraded.db");
  try {
    const first = createStore(dbPath);
    const m = first.save({ type: "history", title: "t", content: "c" });
    first.saveDistillRun({
      id: "run-a",
      status: "ok",
      run_type: "autoSummarize",
      trigger_source: "autoSummarize",
      session_id: "s1",
      seq_start: 1,
      seq_end: 2,
      memory_count: 1
    });
    first.saveMemoryProvenance({
      memoryId: m.id, sessionId: "s1", seqStart: 1, seqEnd: 2,
      createdAt: "2026-11-01T00:00:00.000Z", distillRunId: "run-a"
    });
    first.close();

    const second = createStore(dbPath);
    const cols = second.db.prepare("PRAGMA table_info(memory_provenance)")
      .all().filter((c) => c.name === "distill_run_id");
    assert.equal(cols.length, 1, "列只存在一份，没被重复 ALTER");
    assert.equal(second.provenanceFor(m.id)[0].distill_run_id, "run-a", "重开不动已落盘的归因");
    assert.equal(second.getDistillRun("run-a").status, "ok");
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#512 distill_runs：同 id replay 覆写而不重复", () => {
  const store = openMemory();
  store.saveDistillRun({
    id: "r1", status: "failed", error: "boom",
    run_type: "autoSummarize", trigger_source: "autoSummarize",
    session_id: "s1", seq_start: 1, seq_end: 3, memory_count: 0,
    created_at: "2026-11-01T00:00:00.000Z"
  });
  // 同一轮重放（等价于宿主重启后重试同一逻辑轮）：必须覆写，不能变成两行。
  store.saveDistillRun({
    id: "r1", status: "ok",
    run_type: "autoSummarize", trigger_source: "autoSummarize",
    session_id: "s1", seq_start: 1, seq_end: 3, memory_count: 2,
    created_at: "2026-11-01T00:00:00.000Z"
  });
  const runs = store.listDistillRuns();
  assert.equal(runs.length, 1, "一轮只有一行");
  assert.equal(runs[0].status, "ok", "replay 覆写成最新的事实");
  assert.equal(runs[0].error, undefined, "覆写清掉上一次的错误");
  assert.equal(runs[0].memory_count, 2);
  assert.equal(runs[0].audit_id, undefined, "没有 audit 行时是 undefined，不是 0");
  store.close();
});

test("#512 distill_runs：audit_id 事后补注，补不存在的 run 静默返回 0", () => {
  const store = openMemory();
  store.saveDistillRun({ id: "r2", status: "ok", run_type: "autoSummarize", trigger_source: "autoSummarize" });
  assert.equal(store.attachDistillRunAudit("r2", 42), 1);
  assert.equal(store.getDistillRun("r2").audit_id, 42);
  assert.equal(store.attachDistillRunAudit("missing", 42), 0, "行不存在时不动任何东西");
  assert.equal(store.attachDistillRunAudit("r2", null), 0, "非整数 audit id 一律不写");
  store.close();
});

test("#512 memory_mints：同一 (记忆, run) 只记一次，删记忆时显式清掉归因", () => {
  const store = openMemory();
  const m = store.save({ type: "pattern", title: "抽出来的规律", content: "c", source: "dream" });
  const mint = { memoryId: m.id, runId: "run-d", runType: "dream", triggerSource: "autoDream", createdAt: "2026-11-01T00:00:00.000Z" };
  assert.equal(store.saveMemoryMint(mint), 1);
  assert.equal(store.saveMemoryMint(mint), 0, "INSERT OR IGNORE：重放不重复记一次铸造");
  const rows = store.mintsFor(m.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_type, "dream");
  assert.equal(rows[0].trigger_source, "autoDream");

  store.remove(m.id);
  assert.equal(
    store.db.prepare("SELECT count(*) AS c FROM memory_mints WHERE memory_id = ?").get(m.id).c,
    0,
    "记忆没了，归因不许悬空（CASCADE 之外仍显式清，与 memory_provenance 同一口径）"
  );
  store.close();
});

// ============================ #493 补充：失败计数持久化（读侧失效）
// 这张表只服务一道默认关的护栏（summarizeParseFailureMaxRetries），但它的语义有三处
// 容易写错、且错法都不可见：计数不落库（重启即清零）、失效不在读侧（几周前的失败
// 直接熔断当前窗口）、清零写成 0（「从没失败过」与「刚清零」变得不可区分）。
test("#493 补充：解析失败计数持久化、读侧带失效窗口、清零是真 DELETE", () => {
  const store = openMemory();
  const sid = "s-streak";
  assert.equal(store.getDistillParseFailureStreak(sid), 0, "没有记录就是 0，不是 undefined");

  assert.equal(store.bumpDistillParseFailureStreak(sid), 1);
  assert.equal(store.bumpDistillParseFailureStreak(sid), 2, "累计加一");
  assert.equal(store.getDistillParseFailureStreak(sid), 2);

  // 读侧失效：时间戳挪到 30 天前，7 天窗口下必须当 0（不判失效时它仍是 2）。
  const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  store.db.prepare("UPDATE distill_parse_failures SET updated_at = ? WHERE session_id = ?").run(ancient, sid);
  assert.equal(store.getDistillParseFailureStreak(sid), 2, "staleAfterMs 缺省不判失效（调用方显式要才判）");
  assert.equal(store.getDistillParseFailureStreak(sid, { staleAfterMs: 7 * 24 * 60 * 60 * 1000 }), 0,
    "过期的 streak 必须读成 0：拿几周前的失败去熔断当前窗口，护栏就成了新的误伤路径");

  // 失效之后再加一，必须从 1 起（不是在旧值上 +1）——这条是本块实现的首版 bug，
  // 被 summarize.test.js 的端到端用例抓出来：SQL 里写 streak + 1 会让失效判断失效。
  assert.equal(store.bumpDistillParseFailureStreak(sid, { staleAfterMs: 7 * 24 * 60 * 60 * 1000 }), 1,
    "过期的旧行不许把「新的第一次失败」加成 2");

  // 清零是真删除：没有任何在途失败时不该留一行 0。
  assert.equal(store.clearDistillParseFailureStreak(sid), 1);
  assert.equal(store.getDistillParseFailureStreak(sid), 0);
  assert.equal(store.db.prepare("SELECT count(*) AS c FROM distill_parse_failures").get().c, 0,
    "清零是 DELETE，不是写 0——写 0 会让「从没失败过」与「刚清零」不可区分");
  store.close();
});
