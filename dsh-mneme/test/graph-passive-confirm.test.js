// issue #24 块4 被动确认（graphPassiveConfirm）测试。
// 覆盖：默认关=零行为变化 / 开启=命中记忆的关联边 bump / heat 关但 passive
// 开仍 bump（独立闸门）/ bump 只加不减封顶 / 无关联边的记忆触达安全降级。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  return { store, service };
}

function putMem(store, service, { title, content, importance = 3 }) {
  return service.saveWithDedupe({ type: "project", title, content, importance }).memory;
}

function linkRelToMem(store, { fromName, toName, memoryId, source = "llm" }) {
  const a = store.findEntityByName(fromName) ?? store.createEntity({ name: fromName, type: "technology" });
  const b = store.findEntityByName(toName) ?? store.createEntity({ name: toName, type: "technology" });
  return store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "uses", memory_id: memoryId, source });
}

/** 跑一次检索（内部 touchRecalled 触发触达），返回 rows。 */
async function searchOnce(service, query) {
  return service.searchMemories(query, { mode: "auto" });
}

test("graphPassiveConfirm=false (default): touched memory does NOT bump relation weight", async () => {
  const { store, service } = setup();
  const mem = putMem(store, service, { title: "数据库迁移", content: "主库切换完成" });
  const rel = linkRelToMem(store, { fromName: "A", toName: "B", memoryId: mem.id, source: "llm" });
  assert.equal(rel.weight, 0.4);
  await searchOnce(service, "数据库迁移");
  // 默认关：检索触达不 bump（weight 保持 0.4）。
  assert.equal(store.getRelationsByMemory(mem.id)[0].weight, 0.4, "weight unchanged by default");
  store.close();
});

test("graphPassiveConfirm=true: touched memory bumps its linked relation weight", async () => {
  const { store, service } = setup({ graphWeightEnabled: true, graphPassiveConfirm: true, graphWeightDelta: 0.1 });
  const mem = putMem(store, service, { title: "数据库迁移", content: "主库切换完成" });
  const rel = linkRelToMem(store, { fromName: "A", toName: "B", memoryId: mem.id, source: "llm" });
  assert.equal(rel.weight, 0.4);
  const rows = await searchOnce(service, "数据库迁移");
  assert.ok(rows.some((r) => r.id === mem.id), "memory surfaced");
  assert.ok(store.getRelationsByMemory(mem.id)[0].weight > 0.4, "weight bumped after touch");
  store.close();
});

test("heatEnabled=false does NOT gate passive confirm (independent gates)", async () => {
  const { store, service } = setup({ heatEnabled: false, graphWeightEnabled: true, graphPassiveConfirm: true, graphWeightDelta: 0.1 });
  const mem = putMem(store, service, { title: "数据库迁移", content: "主库切换完成" });
  linkRelToMem(store, { fromName: "A", toName: "B", memoryId: mem.id, source: "llm" });
  await searchOnce(service, "数据库迁移");
  assert.ok(store.getRelationsByMemory(mem.id)[0].weight > 0.4, "bumped even with heat off");
  // 但 touchLastAccess 不写（heat 关的既有语义保留：last_accessed_at 仍为空）。
  assert.equal(store.getById(mem.id).last_accessed_at, undefined);
  store.close();
});

test("repeated touches cap at 1.0 (never exceeds)", () => {
  const { store } = setup();
  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  const rel = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "x", source: "llm" }); // 0.4
  for (let i = 0; i < 5; i++) {
    store.bumpRelationWeight(rel.id, 0.3); // 0.4→0.7→1.0→1.0…
  }
  assert.equal(store.getRelations(a.id)[0].weight, 1.0, "capped at 1.0");
  store.close();
});

// 总闸（块2 的 graphWeightEnabled）关着时被动确认不许生效——单开通道键就能演化
// 边权的话，块2 立的「演化默认关」总闸形同虚设。
test("graphWeightEnabled=false gates passive confirm (master switch)", async () => {
  const { store, service } = setup({ graphPassiveConfirm: true, graphWeightDelta: 0.1 });
  const mem = putMem(store, service, { title: "数据库迁移", content: "主库切换完成" });
  linkRelToMem(store, { fromName: "A", toName: "B", memoryId: mem.id, source: "llm" });
  await searchOnce(service, "数据库迁移");
  assert.equal(store.getRelationsByMemory(mem.id)[0].weight, 0.4, "master switch off → weight untouched");
  store.close();
});

test("memory without relations survives touch (no crash)", async () => {
  const { store, service } = setup({ graphPassiveConfirm: true });
  const mem = putMem(store, service, { title: "孤立条", content: "无关联边" });
  await searchOnce(service, "孤立条");
  assert.ok(store.getById(mem.id), "memory still present");
  store.close();
});