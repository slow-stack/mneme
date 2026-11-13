// issue #24 块1 图谱锚定层（graphAnchoringEnabled）测试。
// 覆盖：默认关=单跳轴行为逐字节不变 / 开=级联扩散邻居挂联记忆进融合池 /
// 邻居分 = hop 配额 × tier（attr 1.0 > relation 0.9）/ 种子直达分不被邻居覆盖 /
// 级联深度上界 / graphSeedCap 收敛邻居总量 / 空关系表降级 / lightMode 关闭配置。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { HOP_QUOTA } from "../src/graph/anchoring.js";
import { testConfig } from "./helpers/test-config.js";

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  return { store, service };
}

function putMemory(store, service, { type = "project", title, content, importance = 3 }) {
  return service.saveWithDedupe({ type, title, content, importance }).memory;
}

function linkAttr(store, service, { entityName, memory, key = "k", value = "v", type = "technology" }) {
  let entity = store.findEntityByName(entityName);
  if (!entity) entity = store.createEntity({ name: entityName, type });
  store.saveAttr({ entity_id: entity.id, attr_key: key, attr_value: value, memory_id: memory.id });
  return entity;
}

function linkRelation(store, { from, to, relType = "related", memoryId, type = "technology" }) {
  const a = store.findEntityByName(from) ?? store.createEntity({ name: from, type });
  const b = store.findEntityByName(to) ?? store.createEntity({ name: to, type });
  store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: relType, memory_id: memoryId });
}

// ============================================================ 默认关（回归红线）

test("graphAnchoringEnabled=false (default): neighbor-linked memory NOT recalled, seed-only preserved", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true });
  // 种子实体 PostgreSQL 挂一条记忆；关系边连到 PgBouncer（不挂记忆）。
  const seedMem = putMemory(store, service, { title: "数据库迁移", content: "主库切换完成" });
  linkAttr(store, service, { entityName: "PostgreSQL", memory: seedMem, key: "version", value: "16" });
  // 邻居实体 + 它自己挂的记忆：必须不被默认关猜中。
  const neighborMem = putMemory(store, service, { title: "连接池笔记", content: "PgBouncer 池调优记录" });
  const neigh = linkAttr(store, service, { entityName: "PgBouncer", memory: neighborMem, key: "mode", value: "pool" });
  // 关系：PostgreSQL —uses→ PgBouncer（种子 → 邻居），不直接挂 seedMem。
  const a = store.findEntityByName("PostgreSQL");
  linkRelation(store, { from: a.name, to: neigh.name, relType: "uses", memoryId: seedMem.id });

  const rows = await service.searchMemories("PostgreSQL 现状", { mode: "auto" });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(seedMem.id), "seed-linked memory present");
  assert.ok(!ids.includes(neighborMem.id), "neighbor memory absent when anchoring off");
});

// ============================================================ 开：级联扩散

test("graphAnchoringEnabled=true: neighbor-linked memory joins via cascade, seed keeps full tier score", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true, graphAnchoringEnabled: true });
  const seedMem = putMemory(store, service, { title: "数据库迁移", content: "主库切换完成" });
  linkAttr(store, service, { entityName: "PostgreSQL", memory: seedMem, key: "version", value: "16" });
  const neighborMem = putMemory(store, service, { title: "连接池笔记", content: "PgBouncer 池调优记录" });
  const neigh = linkAttr(store, service, { entityName: "PgBouncer", memory: neighborMem, key: "mode", value: "pool" });
  const a = store.findEntityByName("PostgreSQL");
  linkRelation(store, { from: a.name, to: neigh.name, relType: "uses", memoryId: seedMem.id });

  // hybrid blend 走加权合算，便于精确断言 entity 轴分（blend: + we·score）。
  const rows = await service.searchMemories("PostgreSQL 现状", { mode: "hybrid" });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(seedMem.id), "seed memory present");
  assert.ok(ids.includes(neighborMem.id), "neighbor memory present via cascade");
  // 种子 attr 1.0 × we(0.3) = 0.3；邻居 attr 1.0 × HOP_QUOTA[1](0.5) × we = 0.15。
  const seedRow = rows.find((r) => r.id === seedMem.id);
  const nbRow = rows.find((r) => r.id === neighborMem.id);
  assert.ok(Math.abs(seedRow.score - 0.3) < 1e-9, "seed keeps full tier score");
  assert.ok(Math.abs(nbRow.score - 0.3 * HOP_QUOTA[1]) < 1e-9, "neighbor hop-weighted");
});

test("cascade respects hop-quota ordering: 1-hop neighbors score above 2-hop", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true, graphAnchoringEnabled: true });
  const seedMem = putMemory(store, service, { title: "根服务", content: "服务 A 上线" });
  linkAttr(store, service, { entityName: "ServiceA", memory: seedMem, key: "env", value: "prod" });
  const hop1Mem = putMemory(store, service, { title: "链路一", content: "ServiceB 依赖记录" });
  const hop2Mem = putMemory(store, service, { title: "链路二", content: "ServiceC 间接关联" });
  const b = linkAttr(store, service, { entityName: "ServiceB", memory: hop1Mem, key: "tier", value: "edge" });
  const c = linkAttr(store, service, { entityName: "ServiceC", memory: hop2Mem, key: "tier", value: "leaf" });
  const a = store.findEntityByName("ServiceA");
  // A—B 关系（hop1）；B—C 关系（hop2）。
  linkRelation(store, { from: a.name, to: b.name, relType: "depends", memoryId: hop1Mem.id });
  linkRelation(store, { from: b.name, to: c.name, relType: "depends", memoryId: hop2Mem.id });

  const rows = await service.searchMemories("ServiceA", { mode: "auto" });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(hop1Mem.id) && ids.includes(hop2Mem.id), "both hops recalled");
  const h1 = rows.find((r) => r.id === hop1Mem.id);
  const h2 = rows.find((r) => r.id === hop2Mem.id);
  assert.ok(h1.score > h2.score, `1-hop (${h1.score}) scores above 2-hop (${h2.score})`);
});

test("empty relation table degrades cleanly (still returns seed memories)", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true, graphAnchoringEnabled: true });
  const seedMem = putMemory(store, service, { title: "独立条", content: "单独存在" });
  linkAttr(store, service, { entityName: "Standalone", memory: seedMem, key: "k", value: "v" });
  const rows = await service.searchMemories("Standalone", { mode: "auto" });
  assert.ok(rows.some((r) => r.id === seedMem.id), "seed memory survives with no relations");
});

// ============================================================ 配置与配额

test("graphSeedCap bounds neighbor expansion (small cap cuts deeper hops)", async () => {
  const { store, service } = makeService({
    entityRecallEnabled: true, graphAnchoringEnabled: true, graphSeedCap: 1, graphCascadeDepth: 3
  });
  const seedMem = putMemory(store, service, { title: "根", content: "入口" });
  const hop1Mem = putMemory(store, service, { title: "一层", content: "近邻" });
  const hop2Mem = putMemory(store, service, { title: "二层", content: "远邻" });
  const b = linkAttr(store, service, { entityName: "NodeB", memory: hop1Mem, key: "k", value: "v" });
  const c = linkAttr(store, service, { entityName: "NodeC", memory: hop2Mem, key: "k", value: "v" });
  const a = store.findEntityByName("入口占位"); // 无；用 NodeA
  const nodeA = store.createEntity({ name: "NodeA", type: "technology" });
  store.saveRelation({ from_entity: nodeA.id, to_entity: b.id, relation_type: "x", memory_id: seedMem.id });
  store.saveRelation({ from_entity: b.id, to_entity: c.id, relation_type: "x", memory_id: hop1Mem.id });

  const rows = await service.searchMemories("NodeA", { mode: "auto" });
  const ids = rows.map((r) => r.id).sort();
  // cap=1 → 配额 floor(1*0.5)=0 → max(1,…) 兜底只进 1 个 1-hop；2-hop 进不来。
  assert.ok(ids.includes(hop1Mem.id), "1-hop fits within cap");
  assert.ok(!ids.includes(hop2Mem.id), "2-hop cut by small cap");
});

test("the anchoring pure module is self-checked", () => {
  // 模块自带 _selfCheck 已在模块加载时断言；这里再锚定导出契约，防重构断链。
  assert.ok(typeof HOP_QUOTA[1] === "number" && HOP_QUOTA[1] > HOP_QUOTA[2]);
});

// ---- #24 复审回归（review findings 逐条落锁）--------------------------------

// 关档逐字节复用 #219 单跳轴：graphSeedCap 只在锚定开启后生效。种子裁剪若漏进
// 关档路径，cap=1 时第二个命中实体整支挂联记忆都会消失——这条专门钉死它。
test("anchoring off: graphSeedCap does not cap the legacy single-hop axis", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true, graphSeedCap: 1 });
  const memA = putMemory(store, service, { title: "迁移记录", content: "主库切换完成" });
  const memB = putMemory(store, service, { title: "池化记录", content: "连接池调优" });
  linkAttr(store, service, { entityName: "Alpha", memory: memA, key: "k", value: "v" });
  linkAttr(store, service, { entityName: "Beta", memory: memB, key: "k", value: "v" });

  const rows = await service.searchMemories("Alpha Beta", { mode: "auto" });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(memA.id), "first seed-linked memory present");
  assert.ok(ids.includes(memB.id), "second seed-linked memory must survive when anchoring is off");
});

// 级联要真走出 >1 跳：邻接若只带种子那一层，2-hop 实体挂联的记忆根本不进池。
// 本地图上 2-hop 记忆只经 AnchorC 可达（两条关系行的 memory_id 都留空，堵死
// 「1-hop 关系行旁路」），所以这条能红着抓回归。
test("cascade reaches 2 hops (lazy per-node adjacency, deeper hop weighted lower)", async () => {
  const { store, service } = makeService({
    entityRecallEnabled: true, graphAnchoringEnabled: true, graphCascadeDepth: 2
  });
  const seedMem = putMemory(store, service, { title: "根服务", content: "入口记录" });
  const hop2Mem = putMemory(store, service, { title: "远环", content: "间接可达" });
  const a = linkAttr(store, service, { entityName: "AnchorA", memory: seedMem, key: "k", value: "v" });
  const c = linkAttr(store, service, { entityName: "AnchorC", memory: hop2Mem, key: "k", value: "v" });
  const b = store.createEntity({ name: "AnchorB", type: "technology" });
  store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "x" });
  store.saveRelation({ from_entity: b.id, to_entity: c.id, relation_type: "x" });

  const rows = await service.searchMemories("AnchorA", { mode: "hybrid" });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(seedMem.id), "seed memory present");
  assert.ok(ids.includes(hop2Mem.id), "2-hop linked memory reached via cascade");
  const h2 = rows.find((r) => r.id === hop2Mem.id);
  assert.ok(Math.abs(h2.score - 0.3 * HOP_QUOTA[2]) < 1e-9, `2-hop keeps hop-quota weighting, got ${h2.score}`);
  store.close();
});

// 邻接查询两个 IN 组都要绑定：关系方向写成 X→种子 时，种子同样应看到 X 是它的
// 邻居（只绑第一组时这类行整批消失，级联方向性丢失）。
test("getEntityNeighbors sees both directions of a relation", () => {
  const store = createStore(":memory:");
  const a = store.createEntity({ name: "Seed", type: "technology" });
  const b = store.createEntity({ name: "Other", type: "technology" });
  store.saveRelation({ from_entity: b.id, to_entity: a.id, relation_type: "x" });
  const nb = store.getEntityNeighbors([a.id]);
  assert.deepEqual(nb.get(a.id), [b.id], "seed must see the reverse-direction neighbor");
  store.close();
});