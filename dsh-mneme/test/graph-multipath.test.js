// issue #24 块1 三路起点的回归（tag 桥接 / 向量 / 零分种子）。
// 这三条都在钉「调用点真的接上了」：能力早就写在 graph/anchoring.js 里，
// 之前的病是 service.js 只喂了一路 exact，另两路永远等不到自己被调用。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { HOP_QUOTA } from "../src/graph/anchoring.js";

function mockEmbedder(vec = [1, 0, 0, 0]) {
  return {
    embedSingle: async () => vec,
    embed: async (texts) => texts.map(() => vec),
    schedule: () => {},
    modelHash: "mock#abc",
    dimension: 4
  };
}

function makeService(config = {}, { withEmbedder = false } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  if (withEmbedder) {
    const vectorIndex = createVectorIndex({ store });
    service.setEmbedder(mockEmbedder());
    service.setVectorIndex(vectorIndex);
    return { store, service, vectorIndex };
  }
  return { store, service, vectorIndex: null };
}

function putMemory(store, service, { type = "project", title, content, tags = [], importance = 3 }) {
  return service.saveWithDedupe({ type, title, content, tags, importance }).memory;
}

function linkAttr(store, entityName, memory, { key = "k", value = "v", type = "technology" } = {}) {
  let entity = store.findEntityByName(entityName);
  if (!entity) entity = store.createEntity({ name: entityName, type });
  store.saveAttr({ entity_id: entity.id, attr_key: key, attr_value: value, memory_id: memory.id });
  return entity;
}

function linkEntities(store, fromName, toName, { relType = "uses", type = "technology" } = {}) {
  const a = store.findEntityByName(fromName) ?? store.createEntity({ name: fromName, type });
  const b = store.findEntityByName(toName) ?? store.createEntity({ name: toName, type });
  store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: relType });
  return { a, b };
}

// ---- Tag 桥接 -------------------------------------------------------------
// 查询「数据库迁移」既不是任何实体名，也不含实体名的子串。tag 命中一条记忆后，
// 该记忆挂联的实体就是「这次在谈的东西」，沿它级联出去的邻居记忆才有机会进池。
// 判别点：farMem 只能经 PgTuner → PgCache 这条边到达；tag 路不接线时它必然缺席。
test("tag path bridges a tag hit into an entity seed (query names no entity)", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true, graphAnchoringEnabled: true });
  // nearMem 带 tag，标题正文都不含查询词——但 store.search 的 tags LIKE 也会命中它，
  // 所以它的存在不是本条用例的判别点，判别点是 farMem。
  const nearMem = putMemory(store, service, {
    title: "alpha", content: "beta gamma", tags: ["数据库迁移"]
  });
  const farMem = putMemory(store, service, { title: "delta", content: "epsilon zeta" });
  linkAttr(store, "PgTuner", nearMem);
  linkAttr(store, "PgCache", farMem);
  linkEntities(store, "PgTuner", "PgCache");

  const rows = await service.searchMemories("数据库迁移", { mode: "hybrid" });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(farMem.id), "1-hop memory reached only via the tag-bridged seed");
  const far = rows.find((r) => r.id === farMem.id);
  assert.ok(
    Math.abs(far.score - 1.0 * HOP_QUOTA[1] * 0.3) < 1e-9,
    `hop-quota weighting preserved through the tag path, got ${far.score}`
  );
});

// 关锚定时 tag 路一次都不许查：否则「默认关=旧单跳轴逐字节不变」这条承诺就破了。
test("tag path is not consulted when anchoring is off", async () => {
  const { store, service } = makeService({ entityRecallEnabled: true });
  const nearMem = putMemory(store, service, {
    title: "alpha", content: "beta gamma", tags: ["数据库迁移"]
  });
  const farMem = putMemory(store, service, { title: "delta", content: "epsilon zeta" });
  linkAttr(store, "PgTuner", nearMem);
  linkAttr(store, "PgCache", farMem);
  linkEntities(store, "PgTuner", "PgCache");

  const rows = await service.searchMemories("数据库迁移", { mode: "hybrid" });
  assert.ok(!rows.some((r) => r.id === farMem.id), "no cascade when anchoring is off");
});

// ---- 向量起点 -------------------------------------------------------------
// 查询里没有实体名、也没有 tag 命中，唯一能给出种子的是向量。早退条件若仍以
// 「名字没命中」收场，第三路接上了也永远不被调用——这条用例正是钉那个早退。
test("vector path seeds from near memories when the query names no entity", async () => {
  const { store, service, vectorIndex } = makeService(
    { entityRecallEnabled: true, graphAnchoringEnabled: true },
    { withEmbedder: true }
  );
  const nearMem = putMemory(store, service, { title: "alpha", content: "beta gamma" });
  const farMem = putMemory(store, service, { title: "delta", content: "epsilon zeta" });
  vectorIndex.saveEmbedding(nearMem.id, [1, 0, 0, 0]); // farMem 刻意不嵌：它只能经图轴到达
  linkAttr(store, "VecSeed", nearMem);
  linkAttr(store, "VecNeighbor", farMem);
  linkEntities(store, "VecSeed", "VecNeighbor");

  const rows = await service.searchMemories("omega", { mode: "hybrid" });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(farMem.id), "1-hop memory reached through the vector seed");
  const far = rows.find((r) => r.id === farMem.id);
  assert.ok(
    Math.abs(far.score - HOP_QUOTA[1] * 0.3) < 1e-9,
    `vector seed keeps hop-quota weighting, got ${far.score}`
  );
});

// ---- 向量起点也要看关系端点 -----------------------------------------------
// 与 Tag 路同一条病：一条近邻记忆若只通过关系挂到实体上（phaseRelations 不建
// attr 行），只读 entity_attrs 的反查会漏掉它，向量路就凭空少了种子。
test("vector path seeds from relation-only memories, not just attr rows", async () => {
  const { store, service, vectorIndex } = makeService(
    { entityRecallEnabled: true, graphAnchoringEnabled: true },
    { withEmbedder: true }
  );
  const nearMem = putMemory(store, service, { title: "alpha", content: "beta gamma" });
  const farMem = putMemory(store, service, { title: "delta", content: "epsilon zeta" });
  vectorIndex.saveEmbedding(nearMem.id, [1, 0, 0, 0]);
  // nearMem 不写 attr，只通过一条关系挂到 RelSeed / RelNeighbor 上。
  const seed = store.createEntity({ name: "RelSeed", type: "module" });
  const neighbor = store.createEntity({ name: "RelNeighbor", type: "module" });
  store.saveRelation({
    from_entity: seed.id, to_entity: neighbor.id, relation_type: "uses",
    memory_id: nearMem.id, metadata: { source: "sleep_relation_completion" }
  });
  linkAttr(store, "RelNeighbor", farMem, { key: "k2" });

  const rows = await service.searchMemories("omega", { mode: "hybrid" });
  assert.ok(rows.some((r) => r.id === farMem.id),
    "a relation-only near memory must still produce vector seeds");
});

// 对照：没有 embedder 就没有向量路，三路全空时必须老实返回空，而不是凭空造种子。
test("vector path absent leaves the axis empty (no phantom seeds)", async () => {  const { store, service } = makeService({ entityRecallEnabled: true, graphAnchoringEnabled: true });
  const nearMem = putMemory(store, service, { title: "alpha", content: "beta gamma" });
  const farMem = putMemory(store, service, { title: "delta", content: "epsilon zeta" });
  linkAttr(store, "VecSeed", nearMem);
  linkAttr(store, "VecNeighbor", farMem);
  linkEntities(store, "VecSeed", "VecNeighbor");

  const rows = await service.searchMemories("omega", { mode: "hybrid" });
  assert.ok(!rows.some((r) => r.id === farMem.id), "no seed sources → no cascade");
});

// ---- 零分种子 -------------------------------------------------------------
// min-max 会把连续通路里**最弱的那条**压成 0。0 分种子仍会被 anchorSeeds 收下，
// 而下游给种子挂联记忆的是**固定满权 tier**（不看种子自己的分数）——于是「这一路
// 里最不像的那条」会以最强的姿态把记忆拉进池。
//
// 两条近邻记忆都必须拿到**正分**：若让第二条与查询正交（cos=0），它在进向量
// 路时就被 score > 0 挡掉了，min-max 根本轮不到把它压成 0——那样这条用例会
// 以「从没发生过」的方式通过，看着绿、其实什么都没验。
//
// zeroMem 必须**挂在 0 分种子自己身上**（VoZero 同时挂 nearB 与 zeroMem）。
// 首版把它挂在另一个孤立实体上，于是无论滤不滤 0 分种子它都到不了——变异自证
// 当场抓到那条用例是空转的。
test("a zero-score seed does not inject its linked memory at full tier", async () => {
  const { store, service, vectorIndex } = makeService(
    { entityRecallEnabled: true, graphAnchoringEnabled: true },
    { withEmbedder: true }
  );
  const nearA = putMemory(store, service, { title: "alpha", content: "beta" });
  const nearB = putMemory(store, service, { title: "gamma", content: "delta" });
  const zeroMem = putMemory(store, service, { title: "iota", content: "kappa" });
  vectorIndex.saveEmbedding(nearA.id, [1, 0, 0, 0]);       // cos = 1.0
  vectorIndex.saveEmbedding(nearB.id, [0.7, 0.7, 0, 0]);   // cos ≈ 0.707，正分但更低 → min-max 压成 0
  linkAttr(store, "VoSeed", nearA);
  linkAttr(store, "VoZero", nearB);
  linkAttr(store, "VoZero", zeroMem, { key: "k2" }); // 同一实体挂第二条记忆，只能经这颗 0 分种子到达
  // VoSeed 与 VoZero 之间不建边：zeroMem 拿不到任何别的到达路径。

  const rows = await service.searchMemories("omega", { mode: "hybrid" });
  assert.ok(rows.some((r) => r.id === nearB.id), "the weak memory itself still comes back via vector");
  assert.ok(
    !rows.some((r) => r.id === zeroMem.id),
    "a 0-score seed must not pull its linked memory in at full tier"
  );
});

// ---- Tag 桥接的排序 -------------------------------------------------------
// 「一个实体命中了几条记忆」是这条路的强弱信号，必须在 SQL 里数。
// 首版拿 entityIdsForMemories 的 DISTINCT 结果反推计数，每个实体恒为 1，
// 排序静默失效、只剩名字序（评审指出）。判别点：limit=1 时返回的是宽实体。
// 命名上必须让「宽实体」在字母序里排后面——首版把宽实体叫 AWide，于是字母序
// 也选它，用例空转通过（变异自证抓到的）。
test("findEntitiesByTags ranks entities by how many tagged memories they cover", async () => {
  const { store, service } = makeService();
  const m1 = putMemory(store, service, { title: "m1", content: "c1", tags: ["数据库迁移"] });
  const m2 = putMemory(store, service, { title: "m2", content: "c2", tags: ["数据库迁移"] });
  // ZWide 挂两条命中记忆；ANarrow 只挂一条。名字序让 ANarrow 排前面，
  // 所以只要计数生效，返回的必然是 ZWide。
  linkAttr(store, "ZWide", m1);
  linkAttr(store, "ZWide", m2, { key: "k2" });
  linkAttr(store, "ANarrow", m1);

  const hits = store.findEntitiesByTags("数据库迁移", { limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "ZWide",
    "the entity covering more tagged memories must win over the alphabetical order");
});

// ---- Tag 锚点的两个来源 ---------------------------------------------------
// phaseRelations 只写 entity_relations.memory_id，不建 attr 行。所以「只通过关系
// 挂到实体上」的记忆，若锚点只读 entity_attrs，关系两端一个种子都生不出来。
// 判别点：这两个实体都没有任何 attr 行，只能从关系侧被看到。
test("findEntitiesByTags sees relation endpoints, not only attr rows", () => {
  const { store, service } = makeService();
  const mem = putMemory(store, service, { title: "pg 调优", content: "一次调优", tags: ["postgres"] });
  const a = store.createEntity({ name: "PgTuner", type: "module" });
  const b = store.createEntity({ name: "PgCache", type: "module" });
  store.saveRelation({
    from_entity: a.id, to_entity: b.id, relation_type: "uses",
    memory_id: mem.id, metadata: { source: "sleep_relation_completion" }
  });

  const names = store.findEntitiesByTags("postgres", { limit: 5 }).map((h) => h.name).sort();
  assert.deepEqual(names, ["PgCache", "PgTuner"],
    "a memory linked only through a relation must seed both endpoints");
});

// 同一 (实体, 记忆) 被 attr 与关系同时覆盖时只算一条：UNION 去的是对，不是行。
test("findEntitiesByTags counts a memory once even when attr and relation both cover it", () => {
  const { store, service } = makeService();
  const m1 = putMemory(store, service, { title: "a", content: "b", tags: ["缓存"] });
  const m2 = putMemory(store, service, { title: "c", content: "d", tags: ["缓存"] });
  const wide = linkAttr(store, "ZBoth", m1);
  store.saveRelation({ from_entity: wide.id, to_entity: wide.id, relation_type: "related_to", memory_id: m1.id });
  linkAttr(store, "ABoth", m2);

  const hits = store.findEntitiesByTags("缓存", { limit: 2 });
  assert.deepEqual(hits.map((h) => h.name).sort(), ["ABoth", "ZBoth"]);
  // 两边都是 1 条记忆时按名字序；若 m1 被数成 2 条，ZBoth 会排到前面。
  assert.equal(hits[0].name, "ABoth",
    "duplicate coverage of the same memory must not inflate the count");
});

// ---- 分块后计数仍然正确 ---------------------------------------------------
// TAG_ID_CHUNK = 500，这条用例造 600 条命中记忆强制走两块：ZBulk 每块各 300 条
// （合计 600），ABulk 只有 400 条（全在第一块）。判别点：正确累加时 ZBulk 胜出；
// 若第二块覆盖而不是累加，ZBulk 只剩 300 < 400，字母序靠前的 ABulk 会赢。
test("findEntitiesByTags accumulates counts across chunk boundaries", () => {
  const { store } = makeService();
  const zBulk = store.createEntity({ name: "ZBulk", type: "module" });
  const aBulk = store.createEntity({ name: "ABulk", type: "module" });
  const makeTagged = (i) => store.save({
    type: "project", title: `t${i}`, content: `c${i}`, tags: ["分块测试"], importance: 3
  });
  // 600 条：前 300 条挂 ZBulk，后 300 条挂 ZBulk 的另一批 attr key，
  // 其中前 400 条同时挂 ABulk（跨两块）。
  for (let i = 0; i < 600; i++) {
    const m = makeTagged(i);
    store.saveAttr({ entity_id: zBulk.id, attr_key: `k${i % 2}`, attr_value: "v", memory_id: m.id });
    if (i < 400) store.saveAttr({ entity_id: aBulk.id, attr_key: "k", attr_value: "v", memory_id: m.id });
  }

  const hits = store.findEntitiesByTags("分块测试", { limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "ZBulk",
    "counts must be summed across chunks, not overwritten by the last batch");
});
