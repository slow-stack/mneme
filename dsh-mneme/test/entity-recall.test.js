// Issue #219 图召回轴（entityRecall）测试。
// 覆盖：默认关=检索行为不变 / 开启后实体挂联记忆进融合池 / 大小写不敏感 /
// 层级分（attr 1.0 > relation 0.9，blend·hybrid 精确断言）/ archived 排除 /
// 空实体表降级 / keyword 模式契约（实体轴不参与）/ 三配方（blend/rrf/minmax）
// 都吃实体源 / signalTransparency 暴露 entity 信号 / store 侧反查原语。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  return { store, service };
}

/** 造一条与实体名无文本重叠的记忆并挂到实体 attr 上（隔离关键词/BM25 通路）。 */
function linkAttr(store, service, { entityName, type = "technology", key, value, title, content }) {
  let entity = store.findEntityByName(entityName);
  if (!entity) entity = store.createEntity({ name: entityName, type });
  const mem = service.saveWithDedupe({ type: "project", title, content, importance: 3 }).memory;
  store.saveAttr({ entity_id: entity.id, attr_key: key, attr_value: value, memory_id: mem.id });
  return { entity, mem };
}

/** 挂一条 relation 边指向既有记忆。 */
function linkRelation(store, { fromName, toName, relType, memoryId }) {
  const from = store.findEntityByName(fromName) ?? store.createEntity({ name: fromName, type: "technology" });
  const to = store.findEntityByName(toName) ?? store.createEntity({ name: toName, type: "technology" });
  store.saveRelation({ from_entity: from.id, to_entity: to.id, relation_type: relType, memory_id: memoryId });
}

// ============================================================ 默认关（回归红线）

test("entityRecallEnabled=false (default): entity-linked memory is not recalled", async () => {
  const { store, service } = makeService();
  linkAttr(store, service, {
    entityName: "PostgreSQL", key: "version", value: "16",
    title: "数据库迁移", content: "主库切换完成，复制延迟归零"
  });
  const rows = await service.searchMemories("PostgreSQL 现状", { mode: "auto" });
  assert.equal(rows.length, 0);
});

// ============================================================ 开启后：融合池

test("entityRecallEnabled=true: attr-linked memory joins the fusion pool (auto)", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true });
  const { mem } = linkAttr(store, service, {
    entityName: "PostgreSQL", key: "version", value: "16",
    title: "数据库迁移", content: "主库切换完成，复制延迟归零"
  });
  const rows = await service.searchMemories("PostgreSQL 现状", { mode: "auto" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, mem.id);
  assert.equal(rows[0].source, "entity");
});

test("entity name match is case-insensitive", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true });
  const { mem } = linkAttr(store, service, {
    entityName: "PostgreSQL", key: "version", value: "16",
    title: "数据库迁移", content: "主库切换完成，复制延迟归零"
  });
  const rows = await service.searchMemories("postgresql 现状", { mode: "auto" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, mem.id);
});

test("blend/hybrid: attr tier scores we*1.0, relation tier we*0.9", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true });
  const { mem: attrMem } = linkAttr(store, service, {
    entityName: "PostgreSQL", key: "version", value: "16",
    title: "数据库迁移", content: "主库切换完成，复制延迟归零"
  });
  const relMem = service.saveWithDedupe({
    type: "project", title: "扩容计划", content: "只读副本再添两台", importance: 3
  }).memory;
  linkRelation(store, { fromName: "PostgreSQL", toName: "PgBouncer", relType: "uses", memoryId: relMem.id });

  const rows = await service.searchMemories("PostgreSQL 现状", { mode: "hybrid" });
  assert.deepEqual(rows.map((r) => r.id), [attrMem.id, relMem.id]);
  assert.ok(Math.abs(rows[0].score - 0.3) < 1e-9);
  assert.ok(Math.abs(rows[1].score - 0.27) < 1e-9);
});

test("archived memories are excluded from the entity axis", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true });
  const { mem } = linkAttr(store, service, {
    entityName: "PostgreSQL", key: "version", value: "16",
    title: "数据库迁移", content: "主库切换完成，复制延迟归零"
  });
  store.setArchived(mem.id, true);
  const rows = await service.searchMemories("PostgreSQL 现状", { mode: "auto" });
  assert.equal(rows.length, 0);
});

// ============================================================ 降级与模式契约

test("empty entity table degrades to no-op (no crash)", async () => {
  const { service } = makeService({ entityRecallEnabled: true });
  const rows = await service.searchMemories("完全无关的查询", { mode: "auto" });
  assert.equal(rows.length, 0);
});

test("mode=keyword stays text-only even when the axis is enabled", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true });
  linkAttr(store, service, {
    entityName: "PostgreSQL", key: "version", value: "16",
    title: "数据库迁移", content: "主库切换完成，复制延迟归零"
  });
  const rows = await service.searchMemories("PostgreSQL 现状", { mode: "keyword" });
  assert.equal(rows.length, 0);
});

test("entity axis participates in rrf and minmax recipes", async () => {
  for (const recallFusion of ["rrf", "minmax"]) {
    const { store, service } = makeService({ entityRecallEnabled: true, recallFusion });
    const { mem } = linkAttr(store, service, {
      entityName: "PostgreSQL", key: "version", value: "16",
      title: "数据库迁移", content: "主库切换完成，复制延迟归零"
    });
    const rows = await service.searchMemories("PostgreSQL 现状", { mode: "auto" });
    assert.equal(rows.length, 1, `${recallFusion}: entity candidate present`);
    assert.equal(rows[0].id, mem.id, `${recallFusion}: correct memory`);
  }
});

// ============================================================ 信号透明

test("signalTransparency decorates entity rows with the entity signal", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true, signalTransparency: true });
  linkAttr(store, service, {
    entityName: "PostgreSQL", key: "version", value: "16",
    title: "数据库迁移", content: "主库切换完成，复制延迟归零"
  });
  const rows = await service.searchMemories("PostgreSQL 现状", { mode: "auto" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signals.entity, 1);
  assert.ok("final" in rows[0].signals);
});

// ============================================================ store 侧原语

test("findEntitiesMentionedIn prefers longer (more specific) names", () => {
  const store = createStore(":memory:");
  store.createEntity({ name: "Data", type: "concept" });
  store.createEntity({ name: "Database Schema", type: "concept" });
  const hits = store.findEntitiesMentionedIn("database schema review");
  assert.equal(hits[0].name, "Database Schema");
  assert.equal(hits.length, 2);
});

test("findEntitiesMentionedIn skips single-char names and empty text", () => {
  const store = createStore(":memory:");
  store.createEntity({ name: "图", type: "concept" });
  assert.equal(store.findEntitiesMentionedIn("图的遍历").length, 0);
  assert.equal(store.findEntitiesMentionedIn("").length, 0);
  assert.equal(store.findEntitiesMentionedIn(null).length, 0);
});

test("getLinkedMemoryIds: attr tier wins over relation for the same memory", () => {
  const store = createStore(":memory:");
  const a = store.createEntity({ name: "Alpha", type: "technology" });
  const b = store.createEntity({ name: "Beta", type: "technology" });
  const mem = store.save({ type: "project", title: "t", content: "c" });
  store.saveAttr({ entity_id: b.id, attr_key: "k", attr_value: "v", memory_id: mem.id });
  store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "uses", memory_id: mem.id });
  const linked = store.getLinkedMemoryIds([a.id, b.id]);
  assert.equal(linked.get(mem.id), "attr");
});

test("getLinkedMemoryIds excludes rows without a memory reference", () => {
  const store = createStore(":memory:");
  const a = store.createEntity({ name: "Alpha", type: "technology" });
  store.saveRelation({ from_entity: a.id, to_entity: a.id, relation_type: "related_to" });
  const linked = store.getLinkedMemoryIds([a.id]);
  assert.equal(linked.size, 0);
});
