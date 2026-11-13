// v0.3.0 entity gene（记忆基因）测试。
// 测试点由 Kimi K2.7 设计（maas_client → kimi-k2.7-code），
// 再映射到本插件的真实 API 名（store/service/extractor/applyDecisions）。
// 覆盖：Schema / 实体 CRUD / 属性时间轴(valid_until) / findMemoriesByAttr
// （含空 value 契约修复）/ 抽取器 / entity:/attr: 前缀搜索 / autoDream / fail-safe。
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { extractEntities } from "../src/entities/extractor.js";
import { applyDecisions } from "../src/dream/decisions.js";
import { testConfig } from "./helpers/test-config.js";

function openStore() {
  return createStore(":memory:");
}

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  return { store, service };
}

function seedAttr(store, service, { entityName, type = "person", key, value, title, content = "记忆内容" }) {
  let entity = store.findEntityByName(entityName);
  if (!entity) entity = store.createEntity({ name: entityName, type });
  const mem = service.saveWithDedupe({ type: "preference", title, content, importance: 3 });
  store.saveAttr({ entity_id: entity.id, attr_key: key, attr_value: value, memory_id: mem.memory.id });
  return { entity, mem: mem.memory };
}

// mock LLM 输出：抽取器约定 callLLM(messages, options) => Promise<string>
const jsonLLM = (payload) => async () => JSON.stringify(payload);

// ============================================================ Schema

test("createStore creates the three entity tables alongside memories", () => {
  const store = openStore();
  for (const t of ["memories", "entities", "entity_attrs", "entity_relations"]) {
    const row = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.ok(row, `${t} table exists`);
  }
  store.close();
});

test("entity tables carry the expected indexes", () => {
  const store = openStore();
  const names = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name));
  for (const i of [
    "idx_entities_name", "idx_entities_type",
    "idx_attrs_entity", "idx_attrs_key", "idx_attrs_valid", "idx_attrs_memory",
    "idx_relations_from", "idx_relations_to", "idx_relations_type"
  ]) {
    assert.ok(names.has(i), `index ${i} exists`);
  }
  store.close();
});

test("legacy database without entity tables auto-creates them (idempotent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-entity-"));
  const path = join(dir, "legacy.db");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
      forgotten INTEGER NOT NULL DEFAULT 0, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    legacy.close();
    // 打开即自动建实体三表
    const store = createStore(path);
    for (const t of ["entities", "entity_attrs", "entity_relations"]) {
      assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t), `${t} auto-created`);
    }
    store.close();
    // 幂等：重复打开不会报错，且可正常写入实体
    const store2 = createStore(path);
    store2.createEntity({ name: "幂等实体", type: "concept" });
    assert.ok(store2.findEntityByName("幂等实体"), "reopen is writable");
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================ 实体 CRUD

test("createEntity records first_seen/last_seen and mention_count=1", () => {
  const store = openStore();
  const ent = store.createEntity({ name: "React", type: "technology" });
  assert.ok(ent.id, "has id");
  assert.equal(ent.name, "React");
  assert.equal(ent.type, "technology");
  assert.equal(ent.mention_count, 1);
  assert.ok(ent.first_seen, "has first_seen");
  assert.equal(ent.last_seen, ent.first_seen);
  assert.equal(store.findEntityByName("React").id, ent.id);
  store.close();
});

test("findEntityByName / findEntityById resolve; unknown returns undefined", () => {
  const store = openStore();
  const ent = store.createEntity({ name: "Node", type: "technology" });
  assert.equal(store.findEntityByName("Node").id, ent.id);
  assert.equal(store.findEntityById(ent.id).name, "Node");
  assert.equal(store.findEntityByName("不存在"), undefined);
  assert.equal(store.findEntityById("ghost"), undefined);
  store.close();
});

test("updateEntity bumps mention_count and refreshes last_seen", () => {
  const store = openStore();
  const ent = store.createEntity({ name: "Vite", type: "technology" });
  const updated = store.updateEntity(ent.id, {});
  assert.equal(updated.mention_count, 2, "empty patch = a fresh sighting");
  assert.ok(updated.last_seen > ent.last_seen, "last_seen advances");
  assert.equal(updated.name, "Vite", "name preserved");
  assert.equal(updated.type, "technology");
  store.close();
});

test("updateEntity applies partial patch and honors explicit mention_count", () => {
  const store = openStore();
  const ent = store.createEntity({ name: "Rust", type: "technology" });
  const updated = store.updateEntity(ent.id, { type: "language", mention_count: 5 });
  assert.equal(updated.type, "language");
  assert.equal(updated.mention_count, 5, "explicit mention_count wins");
  assert.equal(updated.name, "Rust", "untouched field preserved");
  assert.equal(store.updateEntity("ghost", {}), undefined);
  store.close();
});

// ============================================================ 属性时间轴 (valid_until)

test("saveAttr persists key/value/confidence/source/memory_id with valid_until null", () => {
  const store = openStore();
  const mem = store.save({ type: "preference", title: "助手", content: "用 Kimi", importance: 3 });
  const ent = store.createEntity({ name: "Kimi", type: "person" });
  const attr = store.saveAttr({
    entity_id: ent.id, attr_key: "role", attr_value: "测试助手",
    memory_id: mem.id, confidence: 0.8, source: "llm_extract"
  });
  assert.ok(attr.id, "has id");
  assert.equal(attr.attr_key, "role");
  assert.equal(attr.attr_value, "测试助手");
  assert.equal(attr.confidence, 0.8);
  assert.equal(attr.source, "llm_extract");
  assert.equal(attr.memory_id, mem.id);
  assert.ok(attr.valid_from, "has valid_from");
  assert.equal(attr.valid_until, undefined, "new row is live");
  store.close();
});

test("saveAttr twice invalidates the old row; only the newest stays current", () => {
  const store = openStore();
  const ent = store.createEntity({ name: "X", type: "concept" });
  store.saveAttr({ entity_id: ent.id, attr_key: "k", attr_value: "v1" });
  store.saveAttr({ entity_id: ent.id, attr_key: "k", attr_value: "v2" });
  const current = store.getCurrentAttrs(ent.id);
  assert.equal(current.length, 1, "one current row per entity+key");
  assert.equal(current[0].attr_value, "v2");
  assert.equal(current[0].valid_until, undefined);
  store.close();
});

test("getCurrentAttrs only live rows; getAttrHistory all rows oldest-first", () => {
  const store = openStore();
  const ent = store.createEntity({ name: "Y", type: "concept" });
  store.saveAttr({ entity_id: ent.id, attr_key: "k", attr_value: "v1" });
  store.saveAttr({ entity_id: ent.id, attr_key: "k", attr_value: "v2" });
  const history = store.getAttrHistory(ent.id);
  assert.equal(history.length, 2, "history keeps the superseded row");
  assert.equal(history[0].attr_value, "v1");
  assert.ok(history[0].valid_until, "old row closed with valid_until");
  assert.equal(history[1].attr_value, "v2");
  assert.equal(history[1].valid_until, undefined);
  assert.equal(store.getCurrentAttrs(ent.id).length, 1);
  store.close();
});

test("getAttrsByMemory returns the attrs referencing a given memory", () => {
  const store = openStore();
  const ent = store.createEntity({ name: "Z", type: "concept" });
  const m1 = store.save({ type: "decision", title: "决定一", content: "c" });
  const m2 = store.save({ type: "decision", title: "决定二", content: "c" });
  store.saveAttr({ entity_id: ent.id, attr_key: "a", attr_value: "1", memory_id: m1.id });
  store.saveAttr({ entity_id: ent.id, attr_key: "a", attr_value: "2", memory_id: m2.id });
  const for1 = store.getAttrsByMemory(m1.id);
  assert.equal(for1.length, 1);
  assert.equal(for1[0].attr_value, "1");
  assert.equal(for1[0].memory_id, m1.id);
  assert.equal(store.getAttrsByMemory(m2.id).length, 1);
  assert.equal(store.getAttrsByMemory("ghost").length, 0);
  store.close();
});

test("invalidateOldAttr closes live rows and returns the count", () => {
  const store = openStore();
  const ent = store.createEntity({ name: "W", type: "concept" });
  store.saveAttr({ entity_id: ent.id, attr_key: "k", attr_value: "v1" });
  assert.equal(store.invalidateOldAttr(ent.id, "k", new Date().toISOString()), 1);
  assert.equal(store.getCurrentAttrs(ent.id).length, 0, "no live rows left");
  assert.equal(store.invalidateOldAttr(ent.id, "k", new Date().toISOString()), 0, "second pass is a no-op");
  store.close();
});

// ============================================================ findMemoriesByAttr

test("findMemoriesByAttr exact key=value match, deduped across entities", () => {
  const store = openStore();
  const m = store.save({ type: "preference", title: "记忆", content: "c" });
  const e1 = store.createEntity({ name: "实体A", type: "concept" });
  store.saveAttr({ entity_id: e1.id, attr_key: "tag", attr_value: "tech", memory_id: m.id });
  const e2 = store.createEntity({ name: "实体B", type: "concept" });
  store.saveAttr({ entity_id: e2.id, attr_key: "tag", attr_value: "tech", memory_id: m.id });
  const rows = store.findMemoriesByAttr("tag", "tech");
  assert.equal(rows.length, 1, "same memory via two entities still returns once");
  assert.equal(rows[0].id, m.id);
  store.close();
});

test("findMemoriesByAttr empty value returns ALL current memories for the key", () => {
  const store = openStore();
  const m1 = store.save({ type: "preference", title: "甲", content: "c" });
  const m2 = store.save({ type: "preference", title: "乙", content: "c" });
  // 同一 entity+key 的第二次 saveAttr 会失效前一行，因此用两个实体各存一条当前值
  const e1 = store.createEntity({ name: "设备甲", type: "concept" });
  const e2 = store.createEntity({ name: "设备乙", type: "concept" });
  store.saveAttr({ entity_id: e1.id, attr_key: "brand", attr_value: "apple", memory_id: m1.id });
  store.saveAttr({ entity_id: e2.id, attr_key: "brand", attr_value: "huawei", memory_id: m2.id });
  for (const empty of ["", undefined, null]) {
    const rows = store.findMemoriesByAttr("brand", empty);
    assert.equal(rows.length, 2, `empty=${String(empty)} returns all current`);
    assert.deepEqual(new Set(rows.map((r) => r.id)), new Set([m1.id, m2.id]));
  }
  store.close();
});

test("findMemoriesByAttr only matches live rows; expired values are excluded", () => {
  const store = openStore();
  const m1 = store.save({ type: "preference", title: "旧记忆", content: "c" });
  const m2 = store.save({ type: "preference", title: "新记忆", content: "c" });
  const e = store.createEntity({ name: "E", type: "concept" });
  store.saveAttr({ entity_id: e.id, attr_key: "state", attr_value: "old", memory_id: m1.id });
  store.saveAttr({ entity_id: e.id, attr_key: "state", attr_value: "new", memory_id: m2.id });
  assert.deepEqual(store.findMemoriesByAttr("state", "old").map((r) => r.id), [], "superseded value not matched");
  assert.deepEqual(store.findMemoriesByAttr("state", "new").map((r) => r.id), [m2.id]);
  assert.deepEqual(store.findMemoriesByAttr("state", "").map((r) => r.id), [m2.id], "empty value still filters to live rows");
  store.close();
});

test("findMemoriesByAttr unknown key returns []", () => {
  const store = openStore();
  const m = store.save({ type: "preference", title: "m", content: "c" });
  const e = store.createEntity({ name: "F", type: "concept" });
  store.saveAttr({ entity_id: e.id, attr_key: "real", attr_value: "x", memory_id: m.id });
  assert.deepEqual(store.findMemoriesByAttr("nope", "x"), []);
  assert.deepEqual(store.findMemoriesByAttr("nope", ""), []);
  store.close();
});

// ============================================================ 抽取器

test("extractor writes entities, attrs and relations from mock LLM output", async () => {
  const store = openStore();
  const memory = store.save({ type: "preference", title: "技术栈", content: "我用 React 和 Node", importance: 3 });
  const callLLM = jsonLLM({
    entities: [
      { name: "React", type: "technology", attrs: [{ key: "category", value: "前端框架", confidence: 0.95 }] },
      { name: "Node", type: "technology", attrs: [{ key: "category", value: "运行时", confidence: 0.9 }] }
    ],
    relations: [{ from: "React", to: "Node", type: "depends_on" }]
  });
  const result = await extractEntities(memory, { store, config: testConfig({}), callLLM });
  assert.equal(result.ok, true);
  assert.equal(result.entities.length, 2);
  assert.equal(result.attrs.length, 2);
  assert.equal(result.relations.length, 1);

  const react = store.findEntityByName("React");
  assert.ok(react, "entity row created");
  assert.equal(react.type, "technology");
  assert.equal(react.mention_count, 1);
  const current = store.getCurrentAttrs(react.id);
  assert.equal(current.length, 1);
  assert.equal(current[0].attr_value, "前端框架");
  assert.equal(current[0].source, "llm_extract");
  assert.equal(current[0].memory_id, memory.id);
  const rels = store.getRelations(react.id);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].relation_type, "depends_on");
  assert.equal(rels[0].to_entity, store.findEntityByName("Node").id);
  store.close();
});

test("extractor refuses to write affective_context, which belongs to the sleep phase", async () => {
  // #619：affective_context 只有一个写入者——sleep 的 affective 相位。实体抽取发生
  // 在写入当下，手里没有会话边界，判不了「一次场合」和「反复出现的特质」，写进去的
  // 只会是一条没有 emotion/attribution/sessionCount 的半成品边，同一张表两种 schema。
  // 所以抽取器把它当未知类型拒收，而不是当一等公民放行。
  const store = openStore();
  const memory = store.save({ type: "history", title: "答辩前一晚", content: "答辩前一晚他很焦虑", importance: 3 });
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(String(msg)), info: () => {} };
  const callLLM = jsonLLM({
    entities: [
      { name: "他", type: "person", attrs: [] },
      { name: "答辩", type: "concept", attrs: [] }
    ],
    relations: [{ from: "他", to: "答辩", type: "affective_context" }]
  });
  const result = await extractEntities(memory, { store, config: testConfig({}), callLLM, logger });
  assert.equal(result.ok, true);
  assert.equal(result.relations.length, 0);
  assert.deepEqual(result.rejectedRelationTypes, ["affective_context"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /affective_context/);
  assert.equal(store.getRelations(store.findEntityByName("他").id).length, 0);
  store.close();
});

test("extractor rejects unknown relation types instead of silently downgrading to related_to", async () => {
  // 变异自证：把 sanitizeRelationType 改回 `return "related_to"` 兜底，这条必红
  // ——既会多落一条假边，rejectedRelationTypes 也会变空、warn 不再触发。
  const store = openStore();
  const memory = store.save({ type: "project", title: "混入未知类型", content: "A 对 B 有种奇怪的关系", importance: 3 });
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(String(msg)), info: () => {} };
  const callLLM = jsonLLM({
    entities: [
      { name: "A", type: "concept", attrs: [] },
      { name: "B", type: "concept", attrs: [] }
    ],
    relations: [
      { from: "A", to: "B", type: "feels_weird_about" },
      { from: "A", to: "B", type: "related_to" }
    ]
  });
  const result = await extractEntities(memory, { store, config: testConfig({}), callLLM, logger });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rejectedRelationTypes, ["feels_weird_about"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /feels_weird_about/);
  const rels = store.getRelations(store.findEntityByName("A").id);
  assert.equal(rels.length, 1, "only the legitimate relation lands");
  assert.equal(rels[0].relation_type, "related_to");
  store.close();
});

test("extractor drops a relation whose type is not even a string", async () => {
  const store = openStore();
  const memory = store.save({ type: "project", title: "空类型", content: "A 和 B 有联系", importance: 3 });
  const callLLM = jsonLLM({
    entities: [
      { name: "A", type: "concept", attrs: [] },
      { name: "B", type: "concept", attrs: [] }
    ],
    relations: [{ from: "A", to: "B" }]
  });
  const result = await extractEntities(memory, { store, config: testConfig({}), callLLM });
  assert.equal(result.ok, true);
  assert.equal(result.relations.length, 0);
  assert.deepEqual(result.rejectedRelationTypes, ["undefined"]);
  assert.deepEqual(store.getRelations(store.findEntityByName("A").id), []);
  store.close();
});


test("resolveEntity dedups: re-extracting the same name bumps mention_count", async () => {
  const store = openStore();
  const memory = store.save({ type: "preference", title: "工具", content: "用 Vite", importance: 3 });
  const callLLM = jsonLLM({ entities: [{ name: "Vite", type: "technology", attrs: [] }], relations: [] });
  await extractEntities(memory, { store, config: testConfig({}), callLLM });
  const first = store.findEntityByName("Vite");
  assert.equal(first.mention_count, 1);
  const second = await extractEntities(memory, { store, config: testConfig({}), callLLM });
  assert.equal(second.ok, true);
  assert.equal(second.entities[0].entity_id, first.id, "reuses the same entity id");
  assert.equal(store.findEntityByName("Vite").mention_count, 2, "mention_count incremented, no duplicate row");
  assert.equal(store.db.prepare("SELECT count(*) AS c FROM entities WHERE name='Vite'").get().c, 1);
  store.close();
});

test("extractor fails safe on garbage JSON → {ok:false} without throwing", async () => {
  const store = openStore();
  const memory = store.save({ type: "preference", title: "坏输出", content: "x" });
  const result = await extractEntities(memory, {
    store,
    config: testConfig({}),
    callLLM: async () => "这不是 JSON，完全是乱写。"
  });
  assert.equal(result.ok, false);
  assert.ok(result.error, "carries an error reason");
  assert.equal(store.db.prepare("SELECT count(*) AS c FROM entities").get().c, 0, "nothing half-written");
  store.close();
});

test("entityExtractionEnabled gate: hook fires only when enabled", () => {
  // enabled → fires
  const { store, service } = makeService({ entityExtractionEnabled: true });
  let calls = 0;
  service.setEntityExtractor(() => { calls++; return Promise.resolve({ ok: true }); });
  service.saveWithDedupe({ type: "preference", title: "触发", content: "x" });
  assert.equal(calls, 1, "hook invoked after a created write when enabled");
  store.close();

  // disabled → never fires even with a hook installed
  const { store: s2, service: sv2 } = makeService({ entityExtractionEnabled: false });
  let calls2 = 0;
  sv2.setEntityExtractor(() => { calls2++; return Promise.resolve({ ok: true }); });
  sv2.saveWithDedupe({ type: "preference", title: "不触发", content: "x" });
  assert.equal(calls2, 0, "hook skipped when entityExtractionEnabled=false");
  s2.close();
});

// ============================================================ entity:/attr: 前缀搜索

test("searchMemories entity: prefix → attr exact (1.0) sorts before keyword (0.7)", async () => {
  const { store, service } = makeService({ entitySearchEnabled: true });
  const { mem } = seedAttr(store, service, { entityName: "阿尔托", key: "国籍", value: "芬兰", title: "建筑师" });
  const kw = service.saveWithDedupe({ type: "history", title: "阿尔托大学", content: "位于赫尔辛基" });
  const rows = await service.searchMemories("entity:阿尔托", { topK: 10 });
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(mem.id)._score, 1.0, "attr-linked memory is the exact hit");
  assert.equal(byId.get(mem.id)._source, "entity_attr");
  assert.equal(byId.get(kw.memory.id)._score, 0.7, "keyword mention is the fill");
  assert.equal(rows[0].id, mem.id, "attr exact leads the result order");
  store.close();
});

test("searchMemories attr:key=value routes to exact attr match", async () => {
  const { store, service } = makeService({ entitySearchEnabled: true });
  const { mem } = seedAttr(store, service, { entityName: "柯布", key: "国籍", value: "法国", title: "马赛公寓" });
  const other = service.saveWithDedupe({ type: "preference", title: "无关", content: "别的" });
  const rows = await service.searchMemories("attr:国籍=法国", { topK: 10 });
  assert.deepEqual(rows.map((r) => r.id), [mem.id]);
  assert.ok(!rows.some((r) => r.id === other.memory.id));
  store.close();
});

test("searchMemories attr:key without =value returns all current for the key", async () => {
  const { store, service } = makeService({ entitySearchEnabled: true });
  seedAttr(store, service, { entityName: "设备一", type: "concept", key: "brand", value: "apple", title: "笔记本" });
  seedAttr(store, service, { entityName: "设备二", type: "concept", key: "brand", value: "huawei", title: "手机" });
  const rows = await service.searchMemories("attr:brand", { topK: 10 });
  assert.equal(rows.length, 2, "attr:key with no value covers every live value");
  assert.deepEqual(new Set(rows.map((r) => r.title)), new Set(["笔记本", "手机"]));
  // topK trims
  const capped = await service.searchMemories("attr:brand", { topK: 1 });
  assert.equal(capped.length, 1);
  store.close();
});

test("searchMemories entitySearchEnabled=false does not route entity:/attr: prefixes", async () => {
  const { store, service } = makeService({ entitySearchEnabled: false });
  seedAttr(store, service, { entityName: "阿尔托", key: "国籍", value: "芬兰", title: "建筑师" });
  // 前缀被当作普通关键词搜索："entity:阿尔托" 字面串无命中 → 空
  const rows = await service.searchMemories("entity:阿尔托", { topK: 10 });
  assert.equal(rows.length, 0, "entity: prefix falls through to plain keyword");
  const attrRows = await service.searchMemories("attr:国籍", { topK: 10 });
  assert.equal(attrRows.length, 0, "attr: prefix falls through to plain keyword");
  store.close();
});

// ============================================================ autoDream（实体基因联动）

test("applyUpdate writes supersedes self-relations for the updated memory's attrs", () => {
  const { store, service } = makeService({});
  const mem = service.saveWithDedupe({ type: "decision", title: "旧方案", content: "用方案A", importance: 4 });
  const ent = store.createEntity({ name: "项目X", type: "project" });
  store.saveAttr({ entity_id: ent.id, attr_key: "approach", attr_value: "A", memory_id: mem.memory.id });

  const { applied, conflicts, failures } = applyDecisions(
    [{ action: "update", ids: [mem.memory.id], content: "改用方案B" }],
    service, null, null, { entityExtractionEnabled: true }
  );
  assert.equal(applied, 1);
  assert.equal(conflicts.length, 0);
  assert.equal(failures.length, 0);
  const supersedes = store.getRelations(ent.id).filter((r) => r.relation_type === "supersedes");
  assert.equal(supersedes.length, 1, "one supersedes relation per attr");
  assert.equal(supersedes[0].from_entity, ent.id, "self-referencing from");
  assert.equal(supersedes[0].to_entity, ent.id, "self-referencing to");
  assert.equal(supersedes[0].memory_id, mem.memory.id);
  assert.equal(supersedes[0].metadata.attr_key, "approach");
  assert.equal(supersedes[0].metadata.old_value, "A");
  store.close();
});

test("applyMerge migrates loser attrs to the keeper memory", () => {
  const { store, service } = makeService({});
  const loser = service.saveWithDedupe({ type: "project", title: "旧项目", content: "旧内容" });
  const keeper = service.saveWithDedupe({ type: "project", title: "新项目", content: "新内容" });
  const ent = store.createEntity({ name: "项目X", type: "project" });
  store.saveAttr({ entity_id: ent.id, attr_key: "status", attr_value: "active", memory_id: loser.memory.id });

  const { applied } = applyDecisions(
    [{ action: "merge", ids: [loser.memory.id, keeper.memory.id], keepSource: keeper.memory.id, title: "合并项目", content: "合并内容" }],
    service, null, null, { entityExtractionEnabled: true }
  );
  assert.equal(applied, 1);
  const keeperAttrs = store.getAttrsByMemory(keeper.memory.id);
  assert.equal(keeperAttrs.length, 1, "loser attr re-pointed to keeper");
  assert.equal(keeperAttrs[0].attr_value, "active");
  assert.equal(store.getAttrsByMemory(loser.memory.id).length, 0, "no attrs left on the loser");
  store.close();
});

test("applyMerge invalidates the loser attr when the keeper already holds the same entity+key live", () => {
  const { store, service } = makeService({});
  const loser = service.saveWithDedupe({ type: "decision", title: "D旧", content: "旧" });
  const keeper = service.saveWithDedupe({ type: "decision", title: "D新", content: "新" });
  const ent = store.createEntity({ name: "目标", type: "concept" });
  store.saveAttr({ entity_id: ent.id, attr_key: "state", attr_value: "done", memory_id: loser.memory.id });
  store.saveAttr({ entity_id: ent.id, attr_key: "state", attr_value: "wip", memory_id: keeper.memory.id });

  const { applied } = applyDecisions(
    [{ action: "merge", ids: [loser.memory.id, keeper.memory.id], keepSource: keeper.memory.id, title: "D合并", content: "合并" }],
    service, null, null, { entityExtractionEnabled: true }
  );
  assert.equal(applied, 1);
  const current = store.getCurrentAttrs(ent.id);
  assert.equal(current.length, 1);
  assert.equal(current[0].attr_value, "wip", "keeper value wins");
  assert.equal(current[0].memory_id, keeper.memory.id);
  const history = store.getAttrHistory(ent.id);
  const doneRow = history.find((a) => a.attr_value === "done");
  assert.ok(doneRow.valid_until, "loser row invalidated, not re-pointed");
  assert.equal(doneRow.memory_id, loser.memory.id);
  store.close();
});

test("applyUpdate/applyMerge skip entity side-effects when entityExtractionEnabled=false", () => {
  const { store, service } = makeService({});
  const mem = service.saveWithDedupe({ type: "decision", title: "方案", content: "旧内容", importance: 4 });
  const ent = store.createEntity({ name: "项目X", type: "project" });
  store.saveAttr({ entity_id: ent.id, attr_key: "approach", attr_value: "A", memory_id: mem.memory.id });

  const r = applyDecisions(
    [{ action: "update", ids: [mem.memory.id], content: "新内容" }],
    service, null, null, { entityExtractionEnabled: false }
  );
  assert.equal(r.applied, 1, "update itself still applies");
  assert.equal(store.getRelations(ent.id).filter((x) => x.relation_type === "supersedes").length, 0, "no supersedes recorded");

  const loser = service.saveWithDedupe({ type: "project", title: "L项目", content: "旧" });
  const keeper = service.saveWithDedupe({ type: "project", title: "K项目", content: "新" });
  store.saveAttr({ entity_id: ent.id, attr_key: "status", attr_value: "active", memory_id: loser.memory.id });
  const m = applyDecisions(
    [{ action: "merge", ids: [loser.memory.id, keeper.memory.id], keepSource: keeper.memory.id, title: "M合并", content: "合并" }],
    service, null, null, { entityExtractionEnabled: false }
  );
  assert.equal(m.applied, 1, "merge itself still applies");
  assert.equal(store.getAttrsByMemory(keeper.memory.id).length, 0, "attrs not migrated when disabled");
  store.close();
});

// ============================================================ fail-safe

test("throwing / rejecting entityExtractor never breaks the memory write", () => {
  const { store, service } = makeService({ entityExtractionEnabled: true });
  service.setEntityExtractor(() => { throw new Error("sync boom"); });
  const r1 = service.saveWithDedupe({ type: "preference", title: "安全一", content: "写入不受影响" });
  assert.equal(r1.action, "created");
  assert.ok(r1.memory.id);
  service.setEntityExtractor(() => Promise.reject(new Error("async boom")));
  const r2 = service.saveWithDedupe({ type: "preference", title: "安全二", content: "写入不受影响" });
  assert.equal(r2.action, "created");
  assert.ok(r2.memory.id);
  store.close();
});

test("extractor fails safe on missing content → {ok:false}", async () => {
  const store = openStore();
  const result = await extractEntities({ id: "ghost", content: "" }, { store, config: testConfig({}), callLLM: async () => "{}" });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  store.close();
});

test("extractor fails safe when callLLM rejects → {ok:false}", async () => {
  const store = openStore();
  const memory = store.save({ type: "preference", title: "LLM 故障", content: "x" });
  const result = await extractEntities(memory, {
    store,
    config: testConfig({}),
    callLLM: async () => { throw new Error("llm down"); }
  });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  store.close();
});

// --- issue #109: provider/model override + reasoning effort pass-through -----

test("extractor passes provider/model/reasoningEffort through to callLLM options", async () => {
  const store = openStore();
  let captured = null;
  const callLLM = async (_messages, options) => {
    captured = options;
    return JSON.stringify({ entities: [{ name: "Vite", type: "technology", attrs: [] }], relations: [] });
  };
  const config = { entityExtractionProvider: "openai", entityExtractionModel: "gpt-x", entityExtractionReasoning: "high" };
  const result = await extractEntities({ id: "m1", content: "Vite 是前端构建工具" }, { store, config, callLLM });
  assert.equal(result.ok, true);
  // memoryId 是 #405 加的归属通道（审计行靠它记 related_memory_ids），与 #109 的
  // provider/model/reasoningEffort 走同一条 options 缝；形状锁保持精确相等。
  assert.deepEqual(captured, { provider: "openai", model: "gpt-x", reasoningEffort: "high", memoryId: "m1" });
  store.close();
});

test("extractor omits empty provider/model and 'none' reasoning from options", async () => {
  const store = openStore();
  let captured = "unset";
  const callLLM = async (_m, options) => { captured = options; return JSON.stringify({ entities: [], relations: [] }); };
  await extractEntities({ id: "m2", content: "空文本" }, { store, config: testConfig({}), callLLM });
  assert.deepEqual(captured, { memoryId: "m2" }, "no provider/model/reasoning keys when unset");
  store.close();
});

test("#405: extractor omits memoryId when the memory has no id (no fabricated attribution)", async () => {
  const store = openStore();
  let captured = "unset";
  const callLLM = async (_m, options) => { captured = options; return JSON.stringify({ entities: [], relations: [] }); };
  await extractEntities({ content: "无 id 的记忆" }, { store, config: testConfig({}), callLLM });
  assert.deepEqual(captured, {}, "an id-less memory leaves the attribution channel empty");
  store.close();
});

// ============================================================ #372 事务内抽取被丢弃
// 回归锁：此前 scheduleEntityExtraction 在 txDepth>0 时直接 return（注释写
// deferred，实际 transaction() 从不补跑），自动蒸馏（summarize 全部走
// service.transaction）的写入 100% 抽不到实体。三把锁：提交后补跑恰一次、
// 回滚丢弃、合并分支也触发。锁的是「commit 才补跑」这个契约本身——任何一侧
// 改回丢弃或回滚也补跑，这里当场红。
test("#372: extraction queued inside transaction fires exactly once after commit", () => {
  const { store, service } = makeService({ entityExtractionEnabled: true });
  let calls = 0;
  const seen = [];
  service.setEntityExtractor((m) => { calls++; seen.push(m.title); return Promise.resolve({ ok: true }); });
  service.transaction(() => {
    service.saveWithDedupe({ type: "preference", title: "事务内创建", content: "x" });
    // 事务内此刻不得触发（排进队列而不是丢弃，也不是立即跑）
    assert.equal(calls, 0, "no extraction while txDepth > 0");
  });
  assert.equal(calls, 1, "extraction fires exactly once after commit");
  assert.deepEqual(seen, ["事务内创建"]);
  store.close();
});

test("#372: rolled-back transaction never extracts entities from rolled-back rows", () => {
  const { store, service } = makeService({ entityExtractionEnabled: true });
  let calls = 0;
  service.setEntityExtractor(() => { calls++; return Promise.resolve({ ok: true }); });
  assert.throws(() => {
    service.transaction(() => {
      service.saveWithDedupe({ type: "preference", title: "会被回滚", content: "x" });
      throw new Error("boom");
    });
  }, /boom/);
  assert.equal(calls, 0, "no extraction against rolled-back rows");
  assert.equal(store.count(), 0, "row itself rolled back");
  store.close();
});

test("#372: merged write path also schedules extraction", () => {
  const { store, service } = makeService({ entityExtractionEnabled: true });
  service.saveWithDedupe({ type: "project", title: "合并目标", content: "旧" });
  let calls = 0;
  service.setEntityExtractor(() => { calls++; return Promise.resolve({ ok: true }); });
  const r = service.saveWithDedupe({ type: "project", title: "合并目标", content: "新内容" });
  assert.equal(r.action, "merged");
  assert.equal(calls, 1, "merged branch schedules extraction too");
  store.close();
});

// #372 复审补锁（CodeRabbit findings）：回滚条目滞留队列会被下一个成功事务误抽；
// 无上限队列防 cap 重引「静默丢抽取」；嵌套事务内层提交不 drain（防自旋）。
test("#372: inner rollback drops only inner entries; outer commit drains the rest", () => {
  const { store, service } = makeService({ entityExtractionEnabled: true });
  const seen = [];
  service.setEntityExtractor((m) => { seen.push(m.title); return Promise.resolve({ ok: true }); });
  service.transaction(() => {
    service.saveWithDedupe({ type: "preference", title: "外层A", content: "x" });
    try {
      service.transaction(() => {
        service.saveWithDedupe({ type: "preference", title: "内层回滚", content: "x" });
        throw new Error("inner boom");
      });
    } catch { /* 内层回滚，外层继续 */ }
    service.saveWithDedupe({ type: "preference", title: "外层B", content: "x" });
  });
  assert.deepEqual(seen.sort(), ["外层A", "外层B"], "inner rolled-back row never extracted; outer rows drain once");
  assert.equal(store.count(), 2);
  store.close();
});

test("#372: no unbounded cap — large transaction drains every entry", () => {
  const { service } = makeService({ entityExtractionEnabled: true });
  let calls = 0;
  service.setEntityExtractor(() => { calls++; return Promise.resolve({ ok: true }); });
  service.transaction(() => {
    for (let i = 0; i < 150; i++) {
      service.saveWithDedupe({ type: "preference", title: `批量${i}`, content: "x" });
    }
  });
  assert.equal(calls, 150, "no silent drop at any queue cap");
});

// ============================================================ #688 写入侧归一

// 归一的口径只有一条：查找键 = lower(trim(name)) + type。折叠不能预做在 JS 里
// 再绑参——JS 的 toLowerCase 与 SQLite 的 lower() 只在 ASCII 上一致，混用会在
// 特殊字符上造出「一行查不到自己」的孤儿（见 store.js 的索引注释）。
test("#688 findEntityByName folds case/whitespace and keeps the type dimension", () => {
  const store = openStore();
  const tech = store.createEntity({ name: "DeepSeek", type: "technology" });
  const org = store.createEntity({ name: "deepseek", type: "organization" });

  // 不带 type：仍能命中（面板/名字检索走这条），名字折叠生效。
  assert.ok(store.findEntityByName("  deepseek  "), "case + surrounding whitespace folded");

  // 带 type：类型必须一起进键。这 95 组跨类型同名正是 #688 不能裸折叠的理由——
  // 只按名字归一会把技术 DeepSeek 与组织 deepseek 并成一个。
  assert.equal(store.findEntityByName("deepseek", "technology").id, tech.id);
  assert.equal(store.findEntityByName("  DEEPSEEK ", "organization").id, org.id);
  assert.equal(store.findEntityByName("deepseek", "person"), undefined, "type still filters");

  // 版本号后缀不参与归一：DeepSeek-V3 与 V4 是两个模型，剥后缀就并错了。
  const v3 = store.createEntity({ name: "DeepSeek-V3", type: "technology" });
  assert.equal(store.findEntityByName("deepseek-v4", "technology"), undefined, "no version-suffix stripping");
  assert.equal(store.findEntityByName("deepseek-v3", "technology").id, v3.id);
  store.close();
});

test("#688 createEntity trims the stored name but preserves its case", () => {
  const store = openStore();
  const ent = store.createEntity({ name: "  Vite  ", type: "technology" });
  assert.equal(ent.name, "Vite", "surrounding whitespace is not stored");
  assert.equal(store.findEntityByName("vite", "technology").id, ent.id);
  store.close();
});

// 迁移：老库的 entities 带 canonical_memory_id（v0.7.1 的预留列，全仓无读取方）。
// 打开即删列；数据与其余列原样保留；二次打开不抛（判定条件是「列还在不在」）。
test("#688 legacy entities.canonical_memory_id is dropped on open, idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-entity-drop-"));
  const path = join(dir, "legacy-drop.db");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
      forgotten INTEGER NOT NULL DEFAULT 0, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    legacy.exec(`CREATE TABLE entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1, canonical_memory_id TEXT
    );`);
    legacy.prepare("INSERT INTO entities (id,name,type,first_seen,last_seen,mention_count,canonical_memory_id) VALUES (?,?,?,?,?,?,?)")
      .run("e1", "遗留实体", "concept", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 3, "mem-1");
    legacy.close();

    const store = createStore(path);
    const cols = store.db.prepare("PRAGMA table_info(entities)").all().map((c) => c.name);
    assert.ok(!cols.includes("canonical_memory_id"), "the orphan column is gone after open");
    const row = store.findEntityById("e1");
    assert.equal(row.name, "遗留实体", "existing row survives the drop");
    assert.equal(row.mention_count, 3, "other columns keep their values");
    assert.equal(row.canonical_memory_id, undefined, "row mapping no longer exposes it");
    store.close();

    // 幂等：第二次打开列已不在，不能让 PRAGMA 检查之外的路径抛错。
    const again = createStore(path);
    assert.ok(!again.db.prepare("PRAGMA table_info(entities)").all().map((c) => c.name).includes("canonical_memory_id"));
    again.createEntity({ name: "新实体", type: "concept" });
    assert.ok(again.findEntityByName("新实体", "concept"), "reopen stays writable");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
