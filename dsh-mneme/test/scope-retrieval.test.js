import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { testConfig } from "./helpers/test-config.js";

// v0.8.0 A2（issue #17）：检索加权 + occurred_at 时间过滤。
// 当前 scope 加成、他 scope 降权但保留可见；occurred 窗在 store.list/count 与
// 搜索融合池两处同口径（COALESCE 回退 created_at）。

test("store.list/count filter by occurred_at with created_at fallback", () => {
  const store = createStore(":memory:");
  store.save({ type: "project", title: "aug", content: "x", occurred_at: "2026-08-15T00:00:00Z" });
  store.save({ type: "project", title: "sep", content: "x", occurred_at: "2026-09-01T00:00:00Z" });
  // 未标注 occurred_at → 回退 created_at（今天，2026-09-13）参与比较。
  store.save({ type: "project", title: "legacy", content: "x" });

  const aug = store.list({ occurredFrom: "2026-08-01", occurredTo: "2026-08-31" });
  assert.deepEqual(aug.map((m) => m.title), ["aug"]);
  assert.equal(store.count("project", { occurredFrom: "2026-08-01", occurredTo: "2026-08-31" }), 1);

  // 回退方向：窗口从「今天」起（日期从刚写入行的 created_at 推导，不依赖
  // 测试机时钟/时区），未标注行靠 created_at 落入；sep 的 occurred 是月初，
  // 在窗口外。
  const legacyRow = store.list({}).find((m) => m.title === "legacy");
  const today = legacyRow.created_at.slice(0, 10);
  const sinceToday = store.list({ occurredFrom: today }).map((m) => m.title);
  assert.deepEqual(sinceToday, ["legacy"]);

  // 非法边界值被忽略（不进 WHERE），三行都在。
  assert.equal(store.list({ occurredFrom: "garbage", occurredTo: 42 }).length, 3);
});

test("service.list/count pass the occurred window through", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  store.save({ type: "decision", title: "old", content: "x", occurred_at: "2026-01-10T00:00:00Z" });
  store.save({ type: "decision", title: "new", content: "x", occurred_at: "2026-06-10T00:00:00Z" });
  const rows = service.list({ occurredFrom: "2026-06-01" });
  assert.deepEqual(rows.map((m) => m.title), ["new"]);
  assert.equal(service.count("decision", { occurredFrom: "2026-06-01" }), 1);
});

test("searchMemories applies the occurred window to the fused pool", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  store.save({ type: "project", title: "needle aug", content: "hit", occurred_at: "2026-08-15T00:00:00Z" });
  store.save({ type: "project", title: "needle legacy", content: "hit" });

  const all = await service.searchMemories("needle", { mode: "keyword" });
  assert.equal(all.length, 2);

  const windowed = await service.searchMemories("needle", {
    mode: "keyword",
    occurredFrom: "2026-08-01",
    occurredTo: "2026-08-31"
  });
  assert.deepEqual(windowed.map((m) => m.title), ["needle aug"]);
});

test("searchMemories scope weighting: current scope boosted, foreign demoted but visible", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ scopeEnabled: true }) });
  // 打分构造（scoreKeyword：标题命中 1 × 0.8，正文命中 0.6 × 0.8）：
  // 无加权时 alpha (0.8) 排在 beta (0.48) 前。
  store.save({ type: "project", title: "alpha needle", content: "x", agent_scope: "coder" });
  store.save({ type: "project", title: "beta", content: "needle", agent_scope: "novelist" });

  // 当前会话是 novelist：beta 命中 ×1.25=0.6，alpha 他 scope ×0.5=0.4 → 翻转，
  // 但 alpha 仍可见（降权不是过滤）。
  const weighted = await service.searchMemories("needle", {
    mode: "keyword",
    scope: { agent_scope: "novelist", workspace_scope: null }
  });
  assert.deepEqual(weighted.map((m) => m.title), ["beta", "alpha needle"]);

  // 无 scope 传参 → 不动分，保持基线排序。
  const neutral = await service.searchMemories("needle", { mode: "keyword" });
  assert.deepEqual(neutral.map((m) => m.title), ["alpha needle", "beta"]);

  // scope 全 NULL（解析不出）→ 同样不动分。
  const nullScope = await service.searchMemories("needle", {
    mode: "keyword",
    scope: { agent_scope: null, workspace_scope: null }
  });
  assert.deepEqual(nullScope.map((m) => m.title), ["alpha needle", "beta"]);
});

test("searchMemories weighting is off entirely when the flag is off", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  store.save({ type: "project", title: "alpha needle", content: "x", agent_scope: "coder" });
  store.save({ type: "project", title: "beta", content: "needle", agent_scope: "novelist" });
  const rows = await service.searchMemories("needle", {
    mode: "keyword",
    scope: { agent_scope: "novelist", workspace_scope: null }
  });
  assert.deepEqual(rows.map((m) => m.title), ["alpha needle", "beta"]);
});

test("unscoped rows rank with matched rows under weighting (never suppressed)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ scopeEnabled: true }) });
  store.save({ type: "project", title: "global needle", content: "x" });
  store.save({ type: "project", title: "foreign", content: "needle", agent_scope: "someone-else" });
  const rows = await service.searchMemories("needle", {
    mode: "keyword",
    scope: { agent_scope: "me", workspace_scope: null }
  });
  // 未标注行与命中行同列吃 BOOST（×1.25），foreign 行 ×0.5——不被任何会话压掉。
  assert.deepEqual(rows.map((m) => m.title), ["global needle", "foreign"]);
});

function setupTools(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const registered = [];
  createTools(
    { tools: { register(def) { registered.push(def); return () => {}; } } },
    service,
    config
  );
  const pick = (name) => registered.find((def) => def.name === name);
  return { store, service, pick };
}

async function runHandler(def, args, exec) {
  const handler = def.execute.bind(def);
  return handler(args, exec);
}

test("toApiList surfaces scope annotation and occurred_at", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  store.save({
    type: "pitfall",
    title: "stamped",
    content: "x",
    agent_scope: "coder",
    workspace_scope: "D:\\proj",
    sensitivity: "personal",
    occurred_at: "2026-09-12T08:00:00Z"
  });
  const [row] = service.toApiList([store.getById(
    service.list({}).find((m) => m.title === "stamped").id
  )]);
  assert.equal(row.agent_scope, "coder");
  assert.equal(row.workspace_scope, "D:\\proj");
  assert.equal(row.sensitivity, "personal");
  assert.equal(row.occurred_at, "2026-09-12T08:00:00.000Z");
  // 未标注行四字段为 undefined（JSON 序列化时省略）。
  store.save({ type: "pitfall", title: "plain", content: "x" });
  const [plain] = service.toApiList([service.list({}).find((m) => m.title === "plain")]);
  assert.equal(plain.agent_scope, undefined);
  assert.equal(plain.occurred_at, undefined);
});

test("memory_search passes the session scope and occurred window through", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true });
  store.save({ type: "project", title: "alpha needle", content: "x", agent_scope: "coder" });
  store.save({
    type: "project", title: "beta", content: "needle", agent_scope: "novelist",
    occurred_at: "2026-08-15T00:00:00Z"
  });
  const search = pick("memory_search");
  const exec = { agent: { session: { id: "s1", header: { agentPreset: "novelist", cwd: "D:\\p" } } } };
  const args = { query: "needle", occurred_from: "2026-08-01", occurred_to: "2026-08-31" };
  const out = await runHandler(search, args, exec);
  // 窗口内只剩 beta；其 agent_scope 命中当前会话（novelist），标注随行透出。
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].title, "beta");
  assert.equal(out.items[0].agent_scope, "novelist");
  assert.equal(out.items[0].occurred_at, "2026-08-15T00:00:00.000Z");
});

test("memory_list filters by the occurred window and keeps total consistent", async () => {
  const { store, pick } = setupTools({});
  store.save({ type: "decision", title: "old", content: "x", occurred_at: "2026-01-10T00:00:00Z" });
  store.save({ type: "decision", title: "new", content: "x", occurred_at: "2026-06-10T00:00:00Z" });
  const list = pick("memory_list");
  const args = { type: "decision", occurred_from: "2026-06-01" };
  const out = await runHandler(list, args, undefined);
  assert.deepEqual(out.items.map((m) => m.title), ["new"]);
  assert.equal(out.total, 1);
});

test("memory_get returns scope annotation and occurred_at", async () => {
  const { store, pick } = setupTools({});
  const saved = store.save({
    type: "pitfall", title: "t", content: "c",
    agent_scope: "coder", occurred_at: "2026-09-12T08:00:00Z"
  });
  const get = pick("memory_get");
  const out = await runHandler(get, { id: saved.id }, undefined);
  assert.equal(out.memory.agent_scope, "coder");
  assert.equal(out.memory.occurred_at, "2026-09-12T08:00:00.000Z");
});
