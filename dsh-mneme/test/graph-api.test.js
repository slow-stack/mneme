import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { FAKE_API_TOKEN } from "./helpers/fake-auth-values.js";
import { testConfig } from "./helpers/test-config.js";

// Ego-graph read API (graph panel P1). The routes under test:
//   GET /api/dsh-mneme/semantic/graph/ego?entity=&depth=&limit=
//   GET /api/dsh-mneme/semantic/graph/entity-attrs?entity=
// Both are read-only: they must stay reachable without an apiToken, exactly
// like list/search/semantic.

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path) {
  const r = new EventEmitter();
  r.url = path;
  r.method = "GET";
  r.headers = {};
  return r;
}

function setup(apiToken = "") {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken);
  return { store, service, routes };
}

function graphRoute(routes, path) {
  return routes.find((r) => r.path === path);
}

function buildChain(service, names, linkType = "related_to") {
  // names → entities; each consecutive pair gets one relation. Returns a
  // name→entity map so tests can assert on ids.
  const map = new Map();
  for (const n of names) map.set(n, service.createEntity({ name: n, type: "concept" }));
  for (let i = 0; i < names.length - 1; i++) {
    service.saveRelation({
      from_entity: map.get(names[i]).id,
      to_entity: map.get(names[i + 1]).id,
      relation_type: linkType
    });
  }
  return map;
}

test("ego route is registered and open without apiToken", async () => {
  const { routes } = setup(FAKE_API_TOKEN);
  const ego = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const attrs = graphRoute(routes, "/api/dsh-mneme/semantic/graph/entity-attrs");
  assert.ok(ego, "ego route must be registered");
  assert.ok(attrs, "entity-attrs route must be registered");
  // read-only: no 401 even with a token configured
  const res = new FakeRes();
  await ego.handler(req("/api/dsh-mneme/semantic/graph/ego"), res);
  assert.equal(res.statusCode, 400, "missing param is a 400, not a 401");
});

test("ego depth 1 returns root + direct neighbors with distances", async () => {
  const { routes, service } = setup();
  const map = buildChain(service, ["A", "B", "C"]);
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=1"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.root.name, "A");
  assert.equal(data.nodes.length, 2, "root + B only (C is 2 hops)");
  assert.equal(data.edges.length, 1);
  const b = data.nodes.find((n) => n.name === "B");
  assert.equal(b.distance, 1);
  assert.equal(data.nodes.find((n) => n.name === "A").distance, 0);
  // edge shape: ids + relation_type, memory_id nullable
  const edge = data.edges[0];
  assert.ok(edge.id && edge.from && edge.to);
  assert.equal(edge.relation_type, "related_to");
  assert.equal(edge.memory_id, null);
});

test("ego depth 2 includes 2-hop nodes, not 3-hop", async () => {
  const { routes, service } = setup();
  buildChain(service, ["A", "B", "C", "D"]);
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=2"), res);
  const data = JSON.parse(res.body);
  const names = data.nodes.map((n) => n.name).sort();
  assert.deepEqual(names, ["A", "B", "C"], "D is 3 hops away and must be excluded");
  assert.equal(data.nodes.find((n) => n.name === "C").distance, 2);
  assert.equal(data.edges.length, 2);
});

test("ego respects limit and keeps only in-graph edges", async () => {
  const { routes, service } = setup();
  const map = buildChain(service, ["A", "B", "C"]);
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=2&limit=2"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.nodes.length, 2, "limit caps node count");
  assert.equal(data.edges.length, 1, "edges to cut nodes are dropped");
});

test("ego reports 404 for unknown entity and 400 without entity", async () => {
  const { routes } = setup();
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=ghost"), res);
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "entity-not-found");
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego"), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "missing-entity");
});

test("entity-attrs returns current valid attrs only", async () => {
  const { routes, service } = setup();
  const mem = service.saveWithDedupe({ type: "project", title: "t", content: "c" });
  const entity = service.createEntity({ name: "X", type: "technology" });
  service.saveAttr({ entity_id: entity.id, attr_key: "version", attr_value: "1", memory_id: mem.id, confidence: 0.9 });
  // a second save of the same key invalidates the first: only one row stays valid
  service.saveAttr({ entity_id: entity.id, attr_key: "version", attr_value: "2", memory_id: mem.id, confidence: 0.8 });
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/entity-attrs");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/entity-attrs?entity=X"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.entity.name, "X");
  assert.equal(data.attrs.length, 1);
  assert.equal(data.attrs[0].value, "2", "latest valid attr wins");
  assert.equal(data.attrs[0].confidence, 0.8);
  // unknown / missing entity
  let r2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/entity-attrs?entity=nope"), r2);
  assert.equal(r2.statusCode, 404);
  r2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/entity-attrs"), r2);
  assert.equal(r2.statusCode, 400);
});

test("ego 2-hop traversal work is bounded by limit, not by graph size (#409)", async () => {
  const { routes, service } = setup();
  // star-of-stars: hub → 20 spokes, each spoke → 5 leaves = 121 nodes, 120 edges
  const hub = service.createEntity({ name: "hub", type: "project" });
  for (let i = 0; i < 20; i++) {
    const spoke = service.createEntity({ name: `spoke-${i}`, type: "technology" });
    service.saveRelation({ from_entity: hub.id, to_entity: spoke.id, relation_type: "uses" });
    for (let j = 0; j < 5; j++) {
      const leaf = service.createEntity({ name: `leaf-${i}-${j}`, type: "concept" });
      service.saveRelation({ from_entity: spoke.id, to_entity: leaf.id, relation_type: "related_to" });
    }
  }
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  // #409：这条用例原先断言墙钟 < 50ms，而那个「spec §7」预算在仓库文档里找不到出处。
  // 全量并行跑实测最坏 60.4ms，于是它偶发翻车。ego 路由真正要钉住的性质是「遍历工作量
  // 由 limit 卡死、不随图规模增长」——那是个确定性事实：请求内 getRelations 的唯一调用方
  // 就是这次遍历，所以计数即工作量。墙钟只保留一条离群告警（放到最后）。
  const realGetRelations = service.getRelations.bind(service);
  let lookups = 0;
  service.getRelations = (id) => { lookups++; return realGetRelations(id); };
  const res = new FakeRes();
  const start = process.hrtime.bigint();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=hub&depth=2&limit=100"), res);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const data = JSON.parse(res.body);
  assert.equal(data.nodes.length, 100, "limit caps the traversal");
  assert.ok(data.edges.length > 0);
  // 两趟（BFS + 边收集）各至多 limit 次，BFS 还会为「已满之后剩下的 frontier」多问几次，
  // 所以上界留到 3×limit；数量级级别的退化会立刻越界。
  assert.ok(lookups <= 300, `traversal work must be bounded by the limit, saw ${lookups} adjacency lookups`);

  // 同一个查询打到约 13× 大的图上：limit 没变，该做的活就不该变。这一条不含时钟。
  const big = setup();
  const bigHub = big.service.createEntity({ name: "hub", type: "project" });
  for (let i = 0; i < 40; i++) {
    const spoke = big.service.createEntity({ name: `s-${i}`, type: "technology" });
    big.service.saveRelation({ from_entity: bigHub.id, to_entity: spoke.id, relation_type: "uses" });
    for (let j = 0; j < 15; j++) {
      const leaf = big.service.createEntity({ name: `l-${i}-${j}`, type: "concept" });
      big.service.saveRelation({ from_entity: spoke.id, to_entity: leaf.id, relation_type: "related_to" });
    }
  }
  const bigReal = big.service.getRelations.bind(big.service);
  let bigLookups = 0;
  big.service.getRelations = (id) => { bigLookups++; return bigReal(id); };
  const bigRes = new FakeRes();
  await graphRoute(big.routes, "/api/dsh-mneme/semantic/graph/ego")
    .handler(req("/api/dsh-mneme/semantic/graph/ego?entity=hub&depth=2&limit=100"), bigRes);
  assert.equal(JSON.parse(bigRes.body).nodes.length, 100, "the same limit caps the bigger graph too");
  assert.ok(bigLookups <= lookups + 100,
    `${1 + 40 + 600} nodes cost ${bigLookups} lookups vs ${lookups} on 121 — work must track the limit, not the graph`);

  // 墙钟只留一条离群告警，不再是规格线：它抓不到的那类退化已由上面的工作量断言确定性钉死，
  // 250ms（≈4× 实测最坏值）只为兜住数量级级别的性能崩塌（#409）。
  assert.ok(ms < 250, `2-hop query took ${ms.toFixed(1)}ms — the work bound above is the lock; 250ms is only an outlier guard`);
});

// #619 可见化 B：情感边的 metadata 必须原样出 API。
// 这条边上的全部信息量（情绪 / 谁对谁 / 几个场合 / 几条证据）都只存在 metadata 里，
// 上一版这里只映射 id/from/to/relation_type/memory_id/created_at/weight/source，于是
// 数据在库里有、在 store.toRelation 里也有，却在最后一跳被丢掉——面板上看起来就是
// 「这个功能没做」。所以这里钉的不是「字段存在」，而是「一个不认识的字段也能穿过去」。
test("#619 ego edges carry relation metadata through untouched", async () => {
  const { routes, service } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const target = service.createEntity({ name: "答辩", type: "concept" });
  const meta = {
    emotion: "焦虑",
    attribution: "occasion",
    why: "答辩前一晚睡不着",
    evidence: ["m-1", "m-2"],
    sessionCount: 2,
    model: "mock:affective-model",
    runId: "run-1",
    // 故意塞一个现在没人认识的字段：API 层不许按白名单裁剪，否则下一个新字段
    // 又会「写进去了但看不见」，这正是这一轮要修的那类静默。
    futureField: { nested: [1, 2, 3] }
  };
  service.saveRelation({
    from_entity: person.id,
    to_entity: target.id,
    relation_type: "affective_context",
    memory_id: "m-1",
    source: "llm",
    metadata: meta
  });

  const res = new FakeRes();
  await graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego")
    .handler(req("/api/dsh-mneme/semantic/graph/ego?entity=桉桉&depth=1"), res);
  assert.equal(res.statusCode, 200);
  const edge = JSON.parse(res.body).edges.find((e) => e.relation_type === "affective_context");
  assert.ok(edge, "the affective edge is on the ego graph");
  assert.deepEqual(edge.metadata, meta, "metadata passes through field for field, including unknown ones");
});

// 反方向同样要钉：没有 metadata 的边给 null，不给 {}。
// 前端要靠这个区分「老边本来就没有情绪」和「有 metadata 但情绪字段丢了」——
// 给空对象会让两种情形在界面上长得一模一样。
test("#619 ego edges without metadata report null, not an empty object", async () => {
  const { routes, service } = setup();
  const map = buildChain(service, ["A", "B"]);
  assert.ok(map.size === 2);
  const res = new FakeRes();
  await graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego")
    .handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=1"), res);
  assert.equal(res.statusCode, 200);
  const edge = JSON.parse(res.body).edges[0];
  assert.equal(edge.metadata, null, "absent metadata is null so the UI can tell it apart from a populated one");
});

// #619 可见化 C：情绪归因一览。ego 只能从某个实体往外看，回答不了「库里有
// 哪些情绪」。这条路由是全局的反向视角，三条断言各自钉一件会骗人的事。
test("#619 affective overview groups by person, target, emotion and keeps occasion apart from trait", async () => {
  const { routes, service } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const defense = service.createEntity({ name: "答辩", type: "concept" });
  const interview = service.createEntity({ name: "面试", type: "concept" });
  // 同一情绪、两个对象、两个归属档：四组，不能被合掉任何一组。
  service.saveRelation({
    from_entity: person.id, to_entity: defense.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "焦虑", attribution: "occasion", sessionCount: 1, evidence: ["m-1"] }
  });
  service.saveRelation({
    from_entity: person.id, to_entity: interview.id, relation_type: "affective_context",
    memory_id: "m-2", source: "llm",
    metadata: { emotion: "焦虑", attribution: "occasion", sessionCount: 1, evidence: ["m-2"] }
  });
  service.saveRelation({
    from_entity: person.id, to_entity: defense.id, relation_type: "affective_context",
    memory_id: "m-3", source: "llm",
    metadata: {
      emotion: "焦虑", attribution: "trait", sessionCount: 1, traitSessionCount: 3,
      promotedToTrait: true, evidence: ["m-1", "m-3", "m-4"]
    }
  });
  // 没有情绪名的边：不进聚合，但要被计入 skippedEdges 而不是消失。
  service.saveRelation({
    from_entity: person.id, to_entity: defense.id, relation_type: "affective_context",
    memory_id: "m-5", source: "llm", metadata: { attribution: "occasion" }
  });
  // 别的类型不受影响。
  service.saveRelation({ from_entity: person.id, to_entity: defense.id, relation_type: "uses" });

  const res = new FakeRes();
  await graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective")
    .handler(req("/api/dsh-mneme/semantic/graph/affective"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 3, "两个对象 × occasion + 一个 trait = 三组");
  assert.equal(data.skippedEdges, 1, "没有情绪名的边要单独计数，不能静默消失");

  const trait = data.items.find((i) => i.attribution === "trait");
  assert.ok(trait, "trait 组必须存在");
  assert.equal(trait.person, "桉桉");
  assert.equal(trait.target, "答辩");
  assert.equal(trait.traitSessionCount, 3, "trait 要能说出跨了几个独立会话");
  assert.equal(trait.promotedToTrait, true);
  assert.equal(data.items[0].attribution, "trait", "trait 排在 occasion 前面");

  const occasions = data.items.filter((i) => i.attribution === "occasion");
  assert.equal(occasions.length, 2);
  assert.deepEqual(occasions.map((o) => o.target).sort(), ["答辩", "面试"],
    "同一情绪对不同对象是两组，不能被合并");
});

// 读不到的时候必须是 500，不能给空列表——空列表在面板上跟「你从没记过情绪」
// 长得一模一样，而这两件事对用户的含义正好相反。
test("#619 affective overview reports 500 when the store cannot answer", async () => {
  const { routes, service } = setup();
  const original = service.relationsByType;
  service.relationsByType = undefined;
  const res = new FakeRes();
  await graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective")
    .handler(req("/api/dsh-mneme/semantic/graph/affective"), res);
  assert.equal(res.statusCode, 500, "取不到就是取不到，不能假装是空的");
  assert.equal(JSON.parse(res.body).error, "unavailable");
  service.relationsByType = original;
});

// --- #726：聚合端点扩展（why/downgradedFrom 透出、promoted 归组、过滤、cursor 分页） ---

// #726：相位采集了 why 与 downgradedFrom，此前到聚合层被丢掉。前端要做「为什么
// 记下这条」的悬浮和「曾被判成特质又降级」的标示，没有这两个字段就只能瞎猜。
test("#726 affective overview exposes why and downgradedFrom", async () => {
  const { routes, service } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "紧张", attribution: "occasion", why: "提到答辩就手心出汗", evidence: ["m-1"] }
  });
  service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-2", source: "llm",
    metadata: { emotion: "不安", attribution: "occasion", downgradedFrom: "trait", why: "只出现过一次", evidence: ["m-2"] }
  });
  const res = new FakeRes();
  await graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective")
    .handler(req("/api/dsh-mneme/semantic/graph/affective"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  const tense = data.items.find((i) => i.emotion === "紧张");
  assert.equal(tense.why, "提到答辩就手心出汗", "why 要透出到聚合层");
  assert.equal(tense.downgradedFrom, null, "没降级过的边 downgradedFrom 是 null，不是 undefined 或空串");
  const demoted = data.items.find((i) => i.emotion === "不安");
  assert.equal(demoted.downgradedFrom, "trait", "降级痕迹要透出，前端才标得出「曾被判成特质」");
});

// #726：升格后的源边归「稳定倾向」组。睡眠相位铸 pattern 后只打 promotedToTrait 标，
// 边的字面 attribution 留在 occasion（边记录的是场合被观察到，不改写）——聚合层若
// 照字面归组，「稳定倾向」组在纯 sleep 流下永远空着。按展示语义归组，边本身不动。
test("#726 promoted occasion edges group under trait", async () => {
  const { routes, service } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "焦虑", attribution: "occasion", promotedToTrait: true, traitSessionCount: 3, evidence: ["m-1"] }
  });
  const res = new FakeRes();
  await graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective")
    .handler(req("/api/dsh-mneme/semantic/graph/affective"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].attribution, "trait", "promoted 边在展示语义下属于稳定倾向");
  assert.equal(data.items[0].traitSessionCount, 3);
  assert.equal(data.items[0].promotedToTrait, true);
  assert.equal(data.next, null, "不分页时 next 必须是 null——旧客户端多读一个字段不炸");
});

// #726：过滤参数。skipped/totalEdges 描述的是池子，不受过滤影响。
test("#726 affective overview filters by person, emotion and attribution", async () => {
  const { routes, service } = setup();
  const a = service.createEntity({ name: "桉桉", type: "person" });
  const b = service.createEntity({ name: "乙", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  const other = service.createEntity({ name: "面试", type: "concept" });
  const add = (from, to, emotion, attribution) => service.saveRelation({
    from_entity: from.id, to_entity: to.id, relation_type: "affective_context",
    memory_id: "m-" + emotion + to.name, source: "llm",
    metadata: { emotion, attribution, evidence: ["x"] }
  });
  add(a, thing, "焦虑", "occasion");
  add(a, other, "期待", "occasion");
  add(b, thing, "焦虑", "trait");
  // 没有情绪名的边：不进任何过滤结果，但 skipped 口径照常报出来。
  service.saveRelation({
    from_entity: a.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-none", source: "llm", metadata: { attribution: "occasion" }
  });
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective");
  const call = async (qs) => {
    const r = new FakeRes();
    await route.handler(req("/api/dsh-mneme/semantic/graph/affective" + qs), r);
    return JSON.parse(r.body);
  };

  const all = await call("");
  assert.equal(all.items.length, 3);
  assert.equal(all.skippedEdges, 1);
  assert.equal(all.next, null);

  const byPerson = await call("?person=桉桉");
  assert.equal(byPerson.items.length, 2, "按人过滤");
  assert.equal(byPerson.skippedEdges, all.skippedEdges, "过滤不动池子口径");
  const byPersonId = await call(`?person=${encodeURIComponent(a.id)}`);
  assert.equal(byPersonId.items.length, 2, "按实体 id 过滤等价");

  const byEmotion = await call("?emotion=焦虑");
  assert.equal(byEmotion.items.length, 2, "同一情绪跨人/跨档各一组");

  const byAttr = await call("?attribution=trait");
  assert.equal(byAttr.items.length, 1);
  assert.equal(byAttr.items[0].person, "乙");
});

// #726：cursor 分页。组数超过一页时 next 给出游标、翻页接着走；解不开的游标 400。
// 第一页也要带 cursor 参数（空串=从头翻）——分页模式下边帽才放宽，组才翻得出去。
test("#726 affective overview paginates by cursor", async () => {
  const { routes, service } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const things = ["一", "二", "三", "四"].map((n) => service.createEntity({ name: n, type: "concept" }));
  things.forEach((t, i) => service.saveRelation({
    from_entity: person.id, to_entity: t.id, relation_type: "affective_context",
    memory_id: "m-" + i, source: "llm",
    metadata: { emotion: "情绪" + i, attribution: "occasion", evidence: ["x"] }
  }));
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective");
  const call = async (qs) => {
    const r = new FakeRes();
    await route.handler(req("/api/dsh-mneme/semantic/graph/affective" + qs), r);
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };

  const page1 = await call("?limit=2&cursor=");
  assert.equal(page1.status, 200);
  assert.equal(page1.body.items.length, 2, "每页 limit 组");
  assert.ok(page1.body.next, "还有下一页时必须给游标");
  const page2 = await call(`?limit=2&cursor=${encodeURIComponent(page1.body.next)}`);
  assert.equal(page2.body.items.length, 2, "第二页接着走");
  assert.equal(page2.body.next, null, "翻到底 next 归位");
  const seen = [...page1.body.items, ...page2.body.items].map((i) => i.emotion).sort();
  assert.deepEqual(seen, ["情绪0", "情绪1", "情绪2", "情绪3"], "两页合起来是无重无漏的全集");

  const bad = await call("?limit=2&cursor=%%%not-a-cursor");
  assert.equal(bad.status, 400, "解不开的游标明确报错，不静默从头翻");
});

// #723：聚合键优先取 normalize_key——「开心/高兴」不再因措辞漂移裂成两组；
// 组透出主词、向性与全部原词；存量边（无 normalize_key）按词面兜底。
test("#723 affective overview merges synonym emotions via normalize_key", async () => {
  const { routes, service } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "高兴", normalize_key: "开心", valence: "positive", attribution: "occasion", evidence: ["m-1"] }
  });
  service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-2", source: "llm",
    metadata: { emotion: "开心", normalize_key: "开心", valence: "positive", attribution: "occasion", evidence: ["m-2"] }
  });
  // 存量边：没有 normalize_key，按词面兜底成自己的一组。
  service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-3", source: "llm",
    metadata: { emotion: "焦虑", attribution: "occasion", evidence: ["m-3"] }
  });
  const res = new FakeRes();
  await graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective")
    .handler(req("/api/dsh-mneme/semantic/graph/affective"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 2, "同义两词并作一组 + 存量词面一组");
  const merged = data.items.find((i) => i.normalizeKey === "开心");
  assert.ok(merged, "归一组存在");
  assert.deepEqual(merged.originals.sort(), ["开心", "高兴"], "两个原词都保留");
  assert.equal(merged.valence, "positive");
  assert.equal(merged.emotion, "开心", "组内 emotion 显示主词——原词序在同毫秒下不稳定，主词才是稳定锚");
  const legacy = data.items.find((i) => i.emotion === "焦虑");
  assert.equal(legacy.normalizeKey, "焦虑", "存量边按词面兜底");
  assert.equal(legacy.valence, null);
});

// #724：归档口径。默认档不出现归档边、archivedEdges 单列；?archived=1 只看归档区。
test("#724 affective overview keeps archived edges out by default and lists them on demand", async () => {
  const { routes, service } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "期待", normalize_key: "期待", valence: "positive", attribution: "occasion", evidence: ["m-1"] }
  });
  service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-2", source: "llm",
    metadata: { emotion: "不安", attribution: "occasion", archivedAt: "2026-11-01T00:00:00.000Z", evidence: ["m-2"] }
  });
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective");
  const call = async (qs) => {
    const r = new FakeRes();
    await route.handler(req("/api/dsh-mneme/semantic/graph/affective" + qs), r);
    return JSON.parse(r.body);
  };

  const def = await call("");
  assert.equal(def.items.length, 1, "默认档归档边不进 items");
  assert.equal(def.items[0].emotion, "期待");
  assert.equal(def.archivedEdges, 1, "归档数单列——「变少了」要能解释成归档了而不是丢了");
  assert.equal(def.skippedEdges, 0, "归档边有情绪名，不进 skipped 账本（两本账不能混）");
  const arc = await call("?archived=1");
  assert.equal(arc.items.length, 1, "归档档只看归档区");
  assert.equal(arc.items[0].emotion, "不安");
  assert.equal(arc.archivedEdges, 1);
});

// --- #725：人工修正通道（apply + journal）。token 未配置时 fail-open（写也可达），
// 与 api.test.js 的鉴权口径一致；带 token 的拒绝路径在最下一条。 ---
function reqPost(path, payload) {
  const r = new EventEmitter();
  r.url = path;
  r.method = "POST";
  r.headers = {};
  process.nextTick(() => {
    r.emit("data", Buffer.from(JSON.stringify(payload)));
    r.emit("end");
  });
  return r;
}

test("#725 affective apply renames, archives, restores — and writes the journal each time", async () => {
  const { routes, service } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  const e1 = service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "紧张", normalize_key: "紧张", valence: "negative", attribution: "occasion", evidence: ["m-1"] }
  });
  const apply = graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective/apply");
  const call = async (payload) => {
    const r = new FakeRes();
    await apply.handler(reqPost("/api/dsh-mneme/semantic/graph/affective/apply", payload), r);
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };

  const ren = await call({ op: "rename", edgeIds: [e1.id], emotion: "不安" });
  assert.equal(ren.status, 200);
  assert.equal(ren.body.applied, 1);
  let edge = service.relationById(e1.id);
  assert.equal(edge.metadata.emotion, "不安", "改词落库");
  assert.equal(edge.metadata.normalize_key, "不安", "词表内的词归一到组主词");
  assert.equal(edge.metadata.valence, "negative");

  const arch = await call({ op: "archive", edgeIds: [e1.id] });
  assert.equal(arch.status, 200);
  edge = service.relationById(e1.id);
  assert.ok(edge.metadata.archivedAt, "归档标记落库（与 #724 TTL 同一标记）");

  const rest = await call({ op: "restore", edgeIds: [e1.id] });
  assert.equal(rest.status, 200);
  edge = service.relationById(e1.id);
  assert.equal(edge.metadata.archivedAt, undefined, "恢复清掉归档标记");

  const bad = await call({ op: "rename", edgeIds: ["no-such-edge"], emotion: "平静" });
  assert.equal(bad.status, 404, "组内全部边失效时 404，不假装成功");

  const jr = graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective/journal");
  const jres = new FakeRes();
  await jr.handler(req("/api/dsh-mneme/semantic/graph/affective/journal"), jres);
  assert.equal(jres.statusCode, 200);
  const journal = JSON.parse(jres.body).items;
  assert.deepEqual(journal.map((j) => j.op).slice(0, 3), ["restore", "archive", "rename"], "三次成功操作各一条，新→旧");
  assert.equal(journal[0].actor, "manual", "人工通道的账，actor=manual");
});

test("#725 affective apply promotes via the decision channel and demote archives the minted pattern", async () => {
  const { routes, service } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  const e1 = service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "焦虑", attribution: "occasion", sessionCount: 3, evidence: ["m-1", "m-2"] }
  });
  const apply = graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective/apply");
  const call = async (payload) => {
    const r = new FakeRes();
    await apply.handler(reqPost("/api/dsh-mneme/semantic/graph/affective/apply", payload), r);
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };

  const pro = await call({ op: "promote", edgeIds: [e1.id] });
  assert.equal(pro.status, 200, "升格走决策通道成功");
  const patterns = service.list({ type: "pattern", limit: 50 });
  assert.equal(patterns.length, 1, "铸出一条 pattern");
  assert.match(patterns[0].title, /答辩/, "标题带对象（去重键同款约束）");
  let edge = service.relationById(e1.id);
  assert.equal(edge.metadata.promotedToTrait, true);
  assert.equal(edge.metadata.traitSessionCount, 3, "traitSessionCount 取组内最大");

  const dem = await call({ op: "demote", edgeIds: [e1.id] });
  assert.equal(dem.status, 200);
  edge = service.relationById(e1.id);
  assert.equal(edge.metadata.promotedToTrait, undefined, "降格清掉升格标记");
  const after = service.list({ type: "pattern", limit: 50, includeArchived: true });
  const minted = after.find((m) => m.title === patterns[0].title);
  assert.ok(minted, "降格不删铸出的行");
  assert.ok(minted.archived, "铸出的 pattern 行按同题归档（可恢复）");

  const demAgain = await call({ op: "demote", edgeIds: [e1.id] });
  assert.equal(demAgain.status, 200);
  assert.equal(demAgain.body.applied, 0, "没有升格标记时无事可做");
  assert.ok(demAgain.body.failures.length > 0, "无事可做要如实进 failures");
});

test("#725 affective apply is token-gated when a token is configured", async () => {
  const { routes } = setup(FAKE_API_TOKEN);
  const apply = graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective/apply");
  const noAuth = new FakeRes();
  await apply.handler(reqPost("/api/dsh-mneme/semantic/graph/affective/apply", { op: "archive", edgeIds: ["x"] }), noAuth);
  assert.equal(noAuth.statusCode, 401, "带 token 配置时无凭据写操作被拒");
});

// --- #734：升格/降格的四条回归（每一条都对应一个实测过的坑） ---

function setupCfg(cfg, apiToken = "") {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: cfg });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken, cfg);
  return { store, service, routes, cfg };
}

function applyCaller(routes) {
  const apply = graphRoute(routes, "/api/dsh-mneme/semantic/graph/affective/apply");
  return async (payload) => {
    const r = new FakeRes();
    await apply.handler(reqPost("/api/dsh-mneme/semantic/graph/affective/apply", payload), r);
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
}

// ① 200 行窗口：库里有 250 条别的 pattern 时，demote 必须仍能归档铸出的那一条。
//    修前它走 list({limit:200})，目标被挤出窗口 → 边标记清掉、行留活跃，双重口径。
test("#734 demote archives the minted pattern even when 250 other patterns crowd the list", async () => {
  const { routes, service } = setupCfg(testConfig({}));
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  const e1 = service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "焦虑", attribution: "occasion", sessionCount: 3, evidence: ["m-1", "m-2"] }
  });
  const call = applyCaller(routes);

  const pro = await call({ op: "promote", edgeIds: [e1.id] });
  assert.equal(pro.status, 200);
  const mintedId = service.relationById(e1.id).metadata.traitMemoryId;
  assert.ok(mintedId, "升格必须把 pattern id 写进边（降格按 id 找行）");

  // 塞 250 条别的 pattern，把 list({limit:200}) 那个窗口挤满。
  for (let i = 0; i < 250; i++) {
    service.saveWithDedupe({ type: "pattern", title: `别的倾向 ${i}`, content: `别的倾向 ${i} 的正文`, importance: 3 });
  }

  const dem = await call({ op: "demote", edgeIds: [e1.id] });
  assert.equal(dem.status, 200);
  assert.equal(dem.body.patternArchived, true, "pattern 必须真归档");
  const row = service.getById(mintedId);
  assert.equal(row.archived, true, "铸出的那一行被归档（不是被挤出窗口就算了）");
  assert.equal(service.relationById(e1.id).metadata.promotedToTrait, undefined, "边标记同时清掉");
});

// ② 切语言：中文铸的 pattern，界面切英文后 demote 仍要归档它。
//    修前按当前语言重算标题，与库里的中文标题对不上 → 查不到却报 applied:1。
test("#734 demote archives a zh-minted pattern after the language switches to en", async () => {
  const cfg = testConfig({ language: "zh" });
  const { routes, service } = setupCfg(cfg);
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  const e1 = service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "焦虑", attribution: "occasion", sessionCount: 3, evidence: ["m-1", "m-2"] }
  });
  const call = applyCaller(routes);

  const pro = await call({ op: "promote", edgeIds: [e1.id] });
  assert.equal(pro.status, 200);
  const mintedId = service.relationById(e1.id).metadata.traitMemoryId;
  const zhRow = service.getById(mintedId);
  assert.match(zhRow.title, /稳定倾向/, "中文界面铸出的标题是中文");

  // 界面切英文（config 是同一个对象，langOf 每次都现读）。
  cfg.language = "en";

  const dem = await call({ op: "demote", edgeIds: [e1.id] });
  assert.equal(dem.status, 200);
  assert.equal(dem.body.patternArchived, true, "语言变了也要归档到当初那一行");
  assert.equal(service.getById(mintedId).archived, true);
});

// ③ 重复 promote 幂等：第二次必须 200 + reused，不再是「409 却 failures 为空」。
test("#734 repeated promote reuses the same pattern instead of failing with an empty failures array", async () => {
  const { routes, service } = setupCfg(testConfig({}));
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  const e1 = service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "焦虑", attribution: "occasion", sessionCount: 3, evidence: ["m-1", "m-2"] }
  });
  const call = applyCaller(routes);

  const first = await call({ op: "promote", edgeIds: [e1.id] });
  assert.equal(first.status, 200);
  assert.equal(first.body.reused, false, "第一次是真铸");
  const firstId = first.body.patternId;

  const second = await call({ op: "promote", edgeIds: [e1.id] });
  assert.equal(second.status, 200, "重复升格不是失败");
  assert.equal(second.body.reused, true, "第二次是复用");
  assert.equal(second.body.patternId, firstId, "复用同一行");
  assert.equal(service.list({ type: "pattern", limit: 100, includeArchived: true }).length, 1, "库里仍只有一行");
});

// ④ 三轮 promote→demote 循环不累积 archived 行（修前实测 3 轮留 3 条）。
test("#734 three promote/demote cycles leave a single reusable pattern row", async () => {
  const { routes, service } = setupCfg(testConfig({}));
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  const e1 = service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "焦虑", attribution: "occasion", sessionCount: 3, evidence: ["m-1", "m-2"] }
  });
  const call = applyCaller(routes);

  for (let round = 0; round < 3; round++) {
    const pro = await call({ op: "promote", edgeIds: [e1.id] });
    assert.equal(pro.status, 200, `第 ${round + 1} 轮升格`);
    assert.equal(service.relationById(e1.id).metadata.promotedToTrait, true);
    const dem = await call({ op: "demote", edgeIds: [e1.id] });
    assert.equal(dem.status, 200, `第 ${round + 1} 轮降格`);
    assert.equal(dem.body.patternArchived, true);
    assert.equal(service.relationById(e1.id).metadata.promotedToTrait, undefined);
  }
  const all = service.list({ type: "pattern", limit: 100, includeArchived: true });
  assert.equal(all.length, 1, "三轮之后库里仍只有一行 pattern（不新增 archived 行）");
  assert.equal(all[0].archived, true, "最后停在归档态");
});

// --- #739：跨组共用的 pattern 不能因为一组降格就被归档 ---
//
// 两组不同的情绪（担忧／焦虑）只要 person+target 一样，promote 的「按标题去重」
// 就让它们共用同一行 pattern。降格是「这一组」的动作：把它归档等于让另一组指着
// 一条已归档的 id——聚合面还报「稳定倾向」，注入面那条 pattern 已经不存在。

function twoGroups(routes, service) {
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  const make = (normalizeKey, memoryId) => service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: memoryId, source: "llm",
    metadata: {
      // 原词相同（标题模板只吃 emotion 原词，见 src/lang.js affectiveTrait.title），
      // 归一键不同（聚合键吃 normalize_key，见 src/api.js:1810）——这正是
      // 「面板上是两组、库里是同一行 pattern」的成因：词表归一或存量边缺键造成
      // 同词不同组。
      emotion: "担忧", normalize_key: normalizeKey,
      attribution: "occasion", sessionCount: 5, evidence: [memoryId]
    }
  });
  return { person, thing, e1: make("担忧", "m-1"), e2: make("焦虑", "m-2") };
}

test("#739 demote keeps a shared pattern alive and reports how many edges still use it", async () => {
  const { routes, service } = setupCfg(testConfig({}));
  const { e1, e2 } = twoGroups(routes, service);
  const call = applyCaller(routes);

  const pro1 = await call({ op: "promote", edgeIds: [e1.id] });
  assert.equal(pro1.status, 200);
  assert.equal(pro1.body.reused, false, "第一组铸行");
  const pro2 = await call({ op: "promote", edgeIds: [e2.id] });
  assert.equal(pro2.status, 200);
  assert.equal(pro2.body.reused, true, "第二组按标题去重复用同一行");
  assert.equal(pro2.body.patternId, pro1.body.patternId, "跨组共用同一行 pattern");
  const sharedId = pro1.body.patternId;

  const dem = await call({ op: "demote", edgeIds: [e1.id] });
  assert.equal(dem.status, 200);
  assert.equal(dem.body.applied, 1, "本组的边照样降格");
  assert.equal(dem.body.patternArchived, false, "还有别组在引用，不许归档");
  assert.equal(dem.body.patternRetained, true, "未归档这件事必须显式说出来");
  assert.deepEqual(dem.body.retainedPatternIds, [sharedId]);
  assert.equal(dem.body.retainedPatternRefs[0].edgeCount, 1, "回执报出还有几条边在引用");
  assert.deepEqual(dem.body.retainedPatternRefs[0].edgeIds, [e2.id], "点名是哪几条边");
  assert.equal(dem.body.retainedPatternRefs[0].edgeIdsTruncated, false, "没截断就明说没截断");

  assert.equal(service.getById(sharedId).archived, false, "共用行仍是活跃的");
  assert.equal(service.relationById(e1.id).metadata.promotedToTrait, undefined, "本组边已降格");
  assert.equal(service.relationById(e2.id).metadata.promotedToTrait, true, "别组的边不动");
  assert.equal(service.relationById(e2.id).metadata.traitMemoryId, sharedId, "别组仍指着这一行");

  // 第二组最后一位读者降格：这时候才该归档。
  const last = await call({ op: "demote", edgeIds: [e2.id] });
  assert.equal(last.status, 200);
  assert.equal(last.body.patternArchived, true, "没人再引用时正常归档");
  assert.equal(last.body.patternRetained, false);
  assert.equal(service.getById(sharedId).archived, true);
});

test("#739 demote still archives when the group is the only reader", async () => {
  const { routes, service } = setupCfg(testConfig({}));
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "面试", type: "concept" });
  const e1 = service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "紧张", normalize_key: "紧张", attribution: "occasion", sessionCount: 3, evidence: ["m-1"] }
  });
  const call = applyCaller(routes);
  const pro = await call({ op: "promote", edgeIds: [e1.id] });
  const dem = await call({ op: "demote", edgeIds: [e1.id] });
  assert.equal(dem.status, 200);
  assert.equal(dem.body.patternArchived, true, "唯一读者降格 → 归档，行为不变");
  assert.equal(dem.body.patternRetained, false);
  assert.equal(service.getById(pro.body.patternId).archived, true);
});

test("#739 demote does not crash on relations whose metadata is not valid JSON", async () => {
  const { routes, service } = setupCfg(testConfig({}));
  const { e1, e2 } = twoGroups(routes, service);
  const call = applyCaller(routes);
  const pro1 = await call({ op: "promote", edgeIds: [e1.id] });
  await call({ op: "promote", edgeIds: [e2.id] });

  // 历史行里 metadata 可能为空或非 JSON —— 裸写 json_extract 会抛
  // `malformed JSON` 把整个请求打成 500。计数必须绕过脏行走「不匹配」。
  service.saveRelation({
    from_entity: e2.from_entity, to_entity: e2.to_entity, relation_type: "affective_context",
    memory_id: "m-dirty", source: "llm", metadata: "not json"
  });
  service.saveRelation({
    from_entity: e2.from_entity, to_entity: e2.to_entity, relation_type: "affective_context",
    memory_id: "m-null", source: "llm", metadata: undefined
  });

  const dem = await call({ op: "demote", edgeIds: [e1.id] });
  assert.equal(dem.status, 200, "脏 metadata 不能让降格变成 500");
  assert.equal(dem.body.patternArchived, false);
  assert.deepEqual(dem.body.retainedPatternIds, [pro1.body.patternId]);
  assert.equal(dem.body.retainedPatternRefs[0].edgeCount, 1, "脏行不算引用");
});

test("#739 demote reports the true reference count even when the edge list is truncated", async () => {
  const { routes, service } = setupCfg(testConfig({}));
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  // 52 条边共用一行 pattern：引用数超过 limit=50，回执里的 edgeIds 必然截断。
  const edges = [];
  for (let i = 0; i < 52; i++) {
    edges.push(service.saveRelation({
      from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
      memory_id: `m-${i}`, source: "llm",
      metadata: { emotion: "担忧", normalize_key: "担忧", attribution: "occasion", sessionCount: 3, evidence: [`m-${i}`] }
    }));
  }
  const call = applyCaller(routes);
  // promote 单次最多 50 条边，分两批。
  const pro1 = await call({ op: "promote", edgeIds: edges.slice(0, 50).map((e) => e.id) });
  assert.equal(pro1.status, 200);
  const pro2 = await call({ op: "promote", edgeIds: edges.slice(50).map((e) => e.id) });
  assert.equal(pro2.status, 200);
  assert.equal(pro2.body.reused, true, "后两条复用同一行");

  const dem = await call({ op: "demote", edgeIds: [edges[0].id] });
  assert.equal(dem.status, 200);
  const ref = dem.body.retainedPatternRefs[0];
  assert.equal(ref.edgeCount, 51, "总数是 COUNT(*) 的真值，不是被截断的数组长度");
  assert.equal(ref.edgeIds.length, 50, "点名列表受 limit 约束");
  assert.equal(ref.edgeIdsTruncated, true, "截断了就必须显式标出来");
  assert.equal(service.getById(pro1.body.patternId).archived, false);
});

test("#739 demote falls back to the title when the edge id points at a row that is gone", async () => {
  const { routes, service } = setupCfg(testConfig({}));
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const thing = service.createEntity({ name: "答辩", type: "concept" });
  const e1 = service.saveRelation({
    from_entity: person.id, to_entity: thing.id, relation_type: "affective_context",
    memory_id: "m-1", source: "llm",
    metadata: { emotion: "担忧", normalize_key: "担忧", attribution: "trait", sessionCount: 5, evidence: ["m-1"] }
  });
  const call = applyCaller(routes);
  const pro = await call({ op: "promote", edgeIds: [e1.id] });
  const mintedId = pro.body.patternId;

  // 边上的 id 指向一行已经不在了（被删/被合并走），标题行却还在活跃——这正是
  // 「有 id 但 id 无对应行」的情形。此时既没归档也没保留，条件若只看 id 是否为空
  // 就会跳过回落路径，又是一次静默：边标记清掉、pattern 还在说「稳定倾向」。
  const meta = service.relationById(e1.id).metadata;
  service.updateRelationMetadata(e1.id, { ...meta, traitMemoryId: "gone-pattern-id" });

  const dem = await call({ op: "demote", edgeIds: [e1.id] });
  assert.equal(dem.status, 200);
  assert.equal(dem.body.patternArchived, true, "回落路径照样要归档");
  assert.deepEqual(dem.body.archivedPatternIds, [mintedId]);
  assert.equal(service.getById(mintedId).archived, true);
});
