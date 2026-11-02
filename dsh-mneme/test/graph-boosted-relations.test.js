// issue #24 块4（被动确认）的复核出口：
//   GET /api/dsh-mneme/semantic/graph/boosted-relations
// 复核的对象是「权重被抬过的边」——抬升是唯一会改变检索形状的动作，所以它自己
// 就是证据，不必再开一张记账表。这里同时钉住 ego 边的 weight/source 形状：
// 少了那两个字段，面板就分不清「这条边被用过」和「这条边从没被用过」。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";

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

function setup({ config = {}, apiToken = "" } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken, config);
  return { store, service, routes };
}

const BOOSTED = "/api/dsh-mneme/semantic/graph/boosted-relations";

test("boosted-relations route is registered and open without apiToken", async () => {
  const { routes } = setup({ apiToken: "secret-token" });
  const route = routes.find((r) => r.path === BOOSTED);
  assert.ok(route, "route must be registered");
  const res = new FakeRes();
  await route.handler(req(BOOSTED), res);
  assert.equal(res.statusCode, 200, "read-only route must not demand a token");
});

test("boosted-relations lists only edges whose weight rose above its source baseline", async () => {
  const { store, service, routes } = setup();
  const a = service.createEntity({ name: "A", type: "concept" });
  const b = service.createEntity({ name: "B", type: "concept" });
  const c = service.createEntity({ name: "C", type: "concept" });
  // tag 边初值 0.3，抬两次 → 0.5，gain 0.2，必进表。
  const boosted = service.saveRelation({
    from_entity: a.id, to_entity: b.id, relation_type: "uses", source: "tag"
  });
  store.bumpRelationWeight(boosted.id, 0.1);
  store.bumpRelationWeight(boosted.id, 0.1);
  // manual 边留在初值 1.0：gain 为 0，不得进表。
  service.saveRelation({ from_entity: b.id, to_entity: c.id, relation_type: "uses", source: "manual" });

  const res = new FakeRes();
  await routes.find((r) => r.path === BOOSTED).handler(req(BOOSTED), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.count, 1, "only the raised edge qualifies");
  const item = data.items[0];
  assert.equal(item.id, boosted.id);
  assert.equal(item.from, a.id);
  assert.equal(item.to, b.id);
  assert.equal(item.from_name, "A", "both endpoint names ride along so the panel need not re-query");
  assert.equal(item.to_name, "B");
  assert.equal(item.source, "tag");
  assert.ok(Math.abs(item.base_weight - 0.3) < 1e-9, "baseline comes from RELATION_SOURCE_DEFAULTS");
  assert.ok(Math.abs(item.weight - 0.5) < 1e-9, `weight rose to 0.5, got ${item.weight}`);
  assert.ok(Math.abs(item.gain - 0.2) < 1e-9, `gain = weight − base, got ${item.gain}`);
});

test("boosted-relations reports an empty table honestly, with the gate that explains why", async () => {
  const { service, routes } = setup();
  const a = service.createEntity({ name: "A", type: "concept" });
  const b = service.createEntity({ name: "B", type: "concept" });
  service.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "uses", source: "llm" });

  const res = new FakeRes();
  await routes.find((r) => r.path === BOOSTED).handler(req(BOOSTED), res);
  const data = JSON.parse(res.body);
  assert.equal(data.count, 0, "an unraised edge is not a finding");
  assert.equal(data.passiveConfirmEnabled, false, "the gate is off by default — the panel can say so");
});

test("boosted-relations surfaces passiveConfirmEnabled=true when the gate is on", async () => {
  const { routes } = setup({ config: { graphPassiveConfirm: true, graphWeightEnabled: true } });
  const res = new FakeRes();
  await routes.find((r) => r.path === BOOSTED).handler(req(BOOSTED), res);
  assert.equal(JSON.parse(res.body).passiveConfirmEnabled, true);
});

// 只有 graphPassiveConfirm 开着不算「会继续产生新提升」：touchRecalled 里
// passive = graphPassiveConfirm && graphWeightEnabled，只看前者面板会说
// 「会自动提升」而实际一条都不会抬（评审指出）。
test("boosted-relations reports the gate as off when only graphPassiveConfirm is set", async () => {
  const { routes } = setup({ config: { graphPassiveConfirm: true, graphWeightEnabled: false } });
  const res = new FakeRes();
  await routes.find((r) => r.path === BOOSTED).handler(req(BOOSTED), res);
  assert.equal(JSON.parse(res.body).passiveConfirmEnabled, false,
    "passive confirmation only bites when weight evolution is also on");
});

// 排序口径：按 gain 降序，不是按 weight 降序。不同 source 的 base 不同，
// 所以 weight 大的边 gain 可能更小。首版把排序交给 SQL 的 weight DESC 并在
// 循环里按 limit 提前 break，截断处丢掉的正是 gain 更大的边（评审指出）。
test("boosted-relations ranks by gain, not by raw weight", async () => {
  const { store, routes } = setup();
  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  const c = store.createEntity({ name: "C", type: "technology" });
  // llm 边：base 0.4，weight 0.95 → gain 0.55
  const llmEdge = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "uses", source: "llm" });
  store.bumpRelationWeight(llmEdge.id, 0.55);
  // tag 边：base 0.3，weight 0.90 → gain 0.60（weight 更小、gain 更大）
  const tagEdge = store.saveRelation({ from_entity: a.id, to_entity: c.id, relation_type: "uses", source: "tag" });
  store.bumpRelationWeight(tagEdge.id, 0.60);

  const res = new FakeRes();
  await routes.find((r) => r.path === BOOSTED).handler(req(BOOSTED), res);
  const items = JSON.parse(res.body).items;
  assert.ok(items.length >= 2);
  assert.ok(items[0].gain >= items[1].gain, "the list must be ordered by gain");
  assert.equal(items[0].to_name, "C",
    "the tag edge (weight 0.90, gain 0.60) must outrank the llm edge (weight 0.95, gain 0.55)");
});

// 截断也必须发生在按 gain 排完之后：limit=1 时留下的得是 gain 最大那条。
test("boosted-relations truncates after ranking by gain", async () => {
  const { store, routes } = setup();
  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  const c = store.createEntity({ name: "C", type: "technology" });
  const llmEdge = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "uses", source: "llm" });
  store.bumpRelationWeight(llmEdge.id, 0.55);
  const tagEdge = store.saveRelation({ from_entity: a.id, to_entity: c.id, relation_type: "uses", source: "tag" });
  store.bumpRelationWeight(tagEdge.id, 0.60);

  const res = new FakeRes();
  await routes.find((r) => r.path === BOOSTED).handler(req(BOOSTED + "?limit=1"), res);
  const items = JSON.parse(res.body).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].to_name, "C",
    "truncation must keep the largest gain, not the largest weight");
});

test("boosted-relations honours limit and never exceeds the hard cap", async () => {
  const { store, service, routes } = setup();
  for (let i = 0; i < 6; i++) {
    const a = service.createEntity({ name: `L${i}a`, type: "concept" });
    const b = service.createEntity({ name: `L${i}b`, type: "concept" });
    const r = service.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "x", source: "tag" });
    store.bumpRelationWeight(r.id, 0.1);
  }
  const route = routes.find((r) => r.path === BOOSTED);
  let res = new FakeRes();
  await route.handler(req(`${BOOSTED}?limit=2`), res);
  assert.equal(JSON.parse(res.body).count, 2, "limit caps the returned rows");
  res = new FakeRes();
  await route.handler(req(`${BOOSTED}?limit=9999`), res);
  assert.equal(JSON.parse(res.body).count, 6, "an absurd limit clamps to the cap, it does not error");
});

// ego 的边要带 weight/source：面板靠它区分「这条边被用过」与「从没被用过」。
test("ego edges carry weight and source", async () => {
  const { service, routes } = setup();
  const a = service.createEntity({ name: "A", type: "concept" });
  const b = service.createEntity({ name: "B", type: "concept" });
  const rel = service.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "uses", source: "llm" });

  const res = new FakeRes();
  await routes
    .find((r) => r.path === "/api/dsh-mneme/semantic/graph/ego")
    .handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=1"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  const edge = data.edges.find((e) => e.id === rel.id);
  assert.ok(edge, "the relation must appear among ego edges");
  assert.ok(Math.abs(edge.weight - 0.4) < 1e-9, `llm edge starts at 0.4, got ${edge.weight}`);
  assert.equal(edge.source, "llm");
});
