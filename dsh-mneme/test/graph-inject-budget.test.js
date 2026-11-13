// issue #24 块3 关联提示防幻觉（graphInjectHint / graphInjectBudget）测试。
// 覆盖：图候选打标 graphHint / 保守档（默认关）线索行不进注入块 / 开档受独立
// 预算 graphInjectBudget 约束且不挤占 maxItems / [检索线索] 引导语与线索行文本。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { STR, langOf } from "../src/lang.js";
import { testConfig } from "./helpers/test-config.js";

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  return { store, service };
}

function linkEntityMem(store, service, { name, title, content, key = "k", value = "v", type = "technology" }) {
  const mem = service.saveWithDedupe({ type: "project", title, content, importance: 3 }).memory;
  let ent = store.findEntityByName(name);
  if (!ent) ent = store.createEntity({ name, type });
  store.saveAttr({ entity_id: ent.id, attr_key: key, attr_value: value, memory_id: mem.id });
  return mem;
}

test("graphHint candidates are tagged when entityRecallEnabled, and do NOT enter the block by default (conservative)", () => {
  const { store, service } = setup({ entityRecallEnabled: true, maxInjectedItems: 5 });
  // 一条与查询无关的普通记忆（避免规则路占用），一条实体挂联记忆。
  linkEntityMem(store, service, {
    name: "PostgreSQL", title: "数据库迁移", content: "主库切换完成，复制延迟归零"
  });
  service.saveWithDedupe({ type: "decision", title: "无关决策", content: "今天天气不错", importance: 4 });
  const selected = service.injectCandidates({ maxItems: 5, query: "PostgreSQL" });
  // 保守档默认 graphInjectHint=false：图线索行被 general 选取跳过——
  // 候选池里能查到 graphHint 标记，但注入终集会排除它。
  assert.ok(selected.every((m) => m.graphHint !== true), "conservative: no graph hint rows in the injected set");
});

test("graphInjectHint=true admits graph hint rows under independent budget", () => {
  const { store, service } = setup({
    entityRecallEnabled: true, maxInjectedItems: 5, graphInjectHint: true, graphInjectBudget: 2
  });
  // 两条实体挂联记忆（都命中查询实体），一条普通规则记忆。
  linkEntityMem(store, service, { name: "PostgreSQL", title: "数据库迁移", content: "主库切换完成", key: "k1" });
  linkEntityMem(store, service, { name: "PostgreSQL", title: "连接池调优", content: "PgBouncer 配置", key: "k2" });
  service.saveWithDedupe({ type: "decision", title: "无关决策", content: "其他内容", importance: 5 });
  const selected = service.injectCandidates({ maxItems: 5, query: "PostgreSQL" });
  const hints = selected.filter((m) => m.graphHint === true);
  assert.equal(hints.length, 2, "both graph hint rows fit within budget 2");
  // 普通规则记忆仍在（graph 行不挤占 maxItems 槽）。
  assert.ok(selected.some((m) => !m.graphHint), "non-graph rows still present");
  store.close();
});

test("graphInjectBudget caps graph hint rows even when more match the query", () => {
  const { store, service } = setup({
    entityRecallEnabled: true, maxInjectedItems: 10, graphInjectHint: true, graphInjectBudget: 1
  });
  // 三条候选实体挂联记忆，预算只有 1。
  for (const i of [1, 2, 3]) {
    linkEntityMem(store, service, { name: "PostgreSQL", title: `PG 记录 ${i}`, content: `内容 ${i}`, key: `k${i}` });
  }
  const selected = service.injectCandidates({ maxItems: 10 });
  const hints = selected.filter((m) => m.graphHint === true);
  assert.ok(hints.length <= 1, `budget 1 caps at 1, got ${hints.length}`);
  store.close();
});

test("graphHint=false (default) + entityRecallEnabled returns zero candidate set change (conservative = sorting only)", () => {
  const { store, service } = setup({ entityRecallEnabled: true, maxInjectedItems: 5 });
  // 仅实体挂联记忆，保守档下不该有任何候选进块。
  linkEntityMem(store, service, { name: "PostgreSQL", title: "数据库迁移", content: "主库切换完成" });
  const selected = service.injectCandidates({ maxItems: 5, query: "PostgreSQL 现状" });
  assert.equal(selected.filter((m) => m.graphHint).length, 0);
  store.close();
});

test("[检索线索] 引导语与线索行文本渲染正确（zh/en 双语）", () => {
  assert.ok(STR.graphHintHeader.zh.includes("检索线索"));
  assert.ok(STR.graphHintHeader.zh.includes("非事实断言"));
  assert.ok(STR.graphHintHeader.en.includes("Retrieval hints"));
  assert.ok(STR.graphHintHeader.en.toLowerCase().includes("not factual"));
  const lineZh = STR.graphHintLine.zh("entity", "某某", "内容");
  assert.ok(lineZh.startsWith("- [线索/entity]"));
  const lineEn = STR.graphHintLine.en("technology", "Foo", "bar");
  assert.ok(lineEn.startsWith("- [hint/technology]"));
});

// ---- 复审回归 ---------------------------------------------------------------

// 保守档（graphInjectHint 关）下线索行不许从 pin 池侧漏进注入块：pin 池取自打标
// 之后、又不占 maxItems 名额，pin 若不排除 graphHint 行，「图召回 + 约束型记忆」
// 就会在默认关档下照常进常驻注入文本，把线索开关整个绕过去。
test("conservative mode: a graph hint row cannot leak in via the pin pool", () => {
  const { store, service } = setup({ entityRecallEnabled: true, maxInjectedItems: 5, pinnedInjectBudget: 1 });
  // 约束型记忆 + 命中查询实体：同时是 pin 候选与图线索候选（最坏交叉）。
  const mem = service.saveWithDedupe({
    type: "constraint", title: "部署约束", content: "生产环境不许直接改库", importance: 4
  }).memory;
  const ent = store.createEntity({ name: "PostgreSQL", type: "technology" });
  store.saveAttr({ entity_id: ent.id, attr_key: "k", attr_value: "v", memory_id: mem.id });

  const selected = service.injectCandidates({ maxItems: 5, query: "PostgreSQL" });
  assert.equal(selected.filter((m) => m.graphHint === true).length, 0, "hint rows stay out while graphInjectHint is off");
  store.close();
});