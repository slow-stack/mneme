import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { createScopeResolver } from "../src/scope.js";
import { testConfig } from "./helpers/test-config.js";

// v0.8.0 A1（issue #17）：scope 隔离存储层。
// 四列可空（agent_scope/workspace_scope/sensitivity/occurred_at）、迁移纯增量
// 不带 DEFAULT；写入标注走 scopeEnabled 门控；去重键扩展 (type, title, scope…)。

test("migration adds four nullable scope columns without defaults", () => {
  const store = createStore(":memory:");
  const cols = store.db.prepare("PRAGMA table_info(memories)").all();
  for (const name of ["agent_scope", "workspace_scope", "sensitivity", "occurred_at"]) {
    const col = cols.find((c) => c.name === name);
    assert.ok(col, `column ${name} should exist`);
    assert.equal(col.notnull, 0, `${name} must be nullable`);
    assert.equal(col.dflt_value, null, `${name} must not carry a DEFAULT (存量零重写)`);
  }
});

test("rows written without scope fields read back unscoped (legacy semantics)", () => {
  const store = createStore(":memory:");
  const row = store.save({ type: "project", title: "legacy shape", content: "body" });
  assert.equal(row.agent_scope, undefined);
  assert.equal(row.workspace_scope, undefined);
  assert.equal(row.sensitivity, undefined);
  assert.equal(row.occurred_at, undefined);
});

test("store.save persists and normalizes scope fields; dirty input lands as NULL", () => {
  const store = createStore(":memory:");
  const kept = store.save({
    type: "project",
    title: "scoped",
    content: "c",
    agent_scope: "  coder-agent  ",
    workspace_scope: "D:\\proj",
    sensitivity: "personal",
    occurred_at: "2026-09-13T10:00:00+08:00"
  });
  assert.equal(kept.agent_scope, "coder-agent");
  assert.equal(kept.workspace_scope, "D:\\proj");
  assert.equal(kept.sensitivity, "personal");
  // 时区归一：A2 的时间过滤按 ISO 字典序直接比较。
  assert.equal(kept.occurred_at, "2026-09-13T02:00:00.000Z");

  const dirty = store.save({
    type: "project",
    title: "dirty",
    content: "c",
    agent_scope: "   ",
    workspace_scope: 42,
    sensitivity: "",
    occurred_at: "not-a-date"
  });
  assert.equal(dirty.agent_scope, undefined);
  assert.equal(dirty.workspace_scope, undefined);
  assert.equal(dirty.sensitivity, undefined);
  assert.equal(dirty.occurred_at, undefined);
});

test("store.update keeps scope columns untouched (write-time annotation is immutable)", () => {
  const store = createStore(":memory:");
  const saved = store.save({ type: "decision", title: "t", content: "old", agent_scope: "a1", workspace_scope: "w1" });
  store.update(saved.id, { content: "new", importance: 4 });
  const row = store.getById(saved.id);
  assert.equal(row.content, "new");
  assert.equal(row.agent_scope, "a1");
  assert.equal(row.workspace_scope, "w1");
});

test("scopeEnabled=false: cross-scope same-title does NOT merge (issue #170 复核项 1)", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  // A1 时代本测试断言「flag 关=跨 scope 合并」；显式声明落地后那是内容挂错
  // 归属的 bug（strictScope 下原主人反而看不见）——去重键恒按 scope 比较。
  store.save({ type: "project", title: "T", content: "scoped body", agent_scope: "agentA" });
  const { action } = service.saveWithDedupe({ type: "project", title: "T", content: "new body" });
  assert.equal(action, "created", "unscoped write never merges into a labeled row (flag off included)");
  assert.equal(store.count("project"), 2);
});

test("scopeEnabled=true: dedupe key extends with agent_scope/workspace_scope/sensitivity", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ scopeEnabled: true }) });
  const save = (fields) => service.saveWithDedupe({ type: "project", title: "T", content: "body", ...fields });

  assert.equal(save({ agent_scope: "agentA" }).action, "created");
  // 同标题、不同 agent_scope → 独立行，绝不互相合并。
  assert.equal(save({ agent_scope: "agentB" }).action, "created");
  // 不同 workspace_scope → 独立行。
  assert.equal(save({ agent_scope: "agentA", workspace_scope: "D:\\proj-a" }).action, "created");
  // 不同 sensitivity → 独立行。
  assert.equal(save({ agent_scope: "agentA", sensitivity: "personal" }).action, "created");
  // 三元组全同 → 合并。
  assert.equal(save({ agent_scope: "agentA" }).action, "merged");
  assert.equal(store.count("project"), 4);
});

test("scopeEnabled=true: unscoped writes match legacy NULL rows but not stamped ones", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ scopeEnabled: true }) });
  // 存量形状（NULL scope）。
  store.save({ type: "preference", title: "P", content: "legacy" });
  // 未标注新写入与存量 NULL 行互相匹配。
  assert.equal(service.saveWithDedupe({ type: "preference", title: "P", content: "x" }).action, "merged");
  // 已标注行与 NULL 行不匹配 → 独立新行。
  assert.equal(service.saveWithDedupe({ type: "preference", title: "P", content: "x", agent_scope: "agentA" }).action, "created");
  assert.equal(store.count("preference"), 2);
});

test("scopeEnabled=true: _mergeInto across scopes is rejected and falls back to a fresh row", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ scopeEnabled: true }) });
  const scoped = store.save({ type: "project", title: "S", content: "scoped", agent_scope: "agentA" });
  const cross = service.saveWithDedupe({
    type: "project", title: "S", content: "summary text", _mergeInto: scoped.id
  });
  assert.equal(cross.action, "created", "cross-scope semantic merge must not leak into the scoped row");
  const same = service.saveWithDedupe({
    type: "project", title: "S2", content: "more text", agent_scope: "agentA", _mergeInto: scoped.id
  });
  assert.equal(same.action, "merged", "same-scope explicit target still merges");
  assert.equal(same.memory.id, scoped.id);
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
  const memorySave = registered.find((def) => def.name === "memory_save");
  assert.ok(memorySave, "memory_save registered");
  return { store, memorySave };
}

async function runMemorySave(memorySave, args, exec) {
  const handler = memorySave.execute.bind(memorySave);
  return handler(args, exec);
}

test("memory_save stamps resolved scope onto the row when the flag is on", async () => {
  const { store, memorySave } = setupTools({ scopeEnabled: true });
  const exec = { agent: { session: { id: "s1", header: { agentPreset: "coder", cwd: "D:\\proj" } } } };
  const args = { type: "pitfall", title: "T", content: "c", sensitivity: "personal", occurred_at: "2026-09-12T00:00:00Z" };
  const out = await runMemorySave(memorySave, args, exec);
  const row = store.getById(out.id);
  assert.equal(row.agent_scope, "coder");
  assert.equal(row.workspace_scope, "D:\\proj");
  assert.equal(row.sensitivity, "personal");
  assert.equal(row.occurred_at, "2026-09-12T00:00:00.000Z");
});

test("memory_save without exec context writes unscoped rows (flag on, nothing resolvable)", async () => {
  const { store, memorySave } = setupTools({ scopeEnabled: true });
  const out = await runMemorySave(memorySave, { type: "pitfall", title: "T", content: "c" }, undefined);
  const row = store.getById(out.id);
  assert.equal(row.agent_scope, undefined);
  assert.equal(row.workspace_scope, undefined);
});

test("memory_save with the flag off writes rows without any scope annotation", async () => {
  const { store, memorySave } = setupTools({});
  const exec = { agent: { session: { id: "s1", header: { agentPreset: "coder", cwd: "D:\\proj" } } } };
  const out = await runMemorySave(memorySave, { type: "pitfall", title: "T", content: "c" }, exec);
  const row = store.getById(out.id);
  assert.equal(row.agent_scope, undefined);
  assert.equal(row.workspace_scope, undefined);
});

test("createScopeResolver returns identity even when scopeEnabled is off (gate lives at the write-annotation site, issue #170 复核项 2)", () => {
  const resolve = createScopeResolver({ ctx: {}, config: testConfig({}) });
  // flag 关只关自动标注：读取侧（strictVisibility/get/注入）与显式声明仍需身份。
  assert.deepEqual(
    resolve({ agent: { session: { id: "s1", header: { agentPreset: "coder", cwd: "D:\\p" } } } }),
    { agent_scope: "coder", workspace_scope: "D:\\p" }
  );
  // 真解析不到 → 双 null 对象（fail-closed 读取侧据此只放行未标注/非显式行）。
  assert.deepEqual(resolve({ agent: { session: { id: "s1" } } }), { agent_scope: null, workspace_scope: null });
});

test("resolver stamps agentPreset and header cwd; registry hit wins over header cwd", () => {
  const resolve = createScopeResolver({
    config: testConfig({ scopeEnabled: true }),
    ctx: { workspaceRegistry: { list: () => [{ path: "C:\\canon", sessionIds: ["s1"] }] } }
  });
  const exec = { agent: { session: { id: "s1", header: { agentPreset: "coder", cwd: "D:\\raw" } } } };
  assert.deepEqual(resolve(exec), { agent_scope: "coder", workspace_scope: "C:\\canon" });

  const resolveNoHit = createScopeResolver({
    config: testConfig({ scopeEnabled: true }),
    ctx: { workspaceRegistry: { list: () => [{ path: "C:\\canon", sessionIds: ["other"] }] } }
  });
  assert.deepEqual(resolveNoHit(exec), { agent_scope: "coder", workspace_scope: "D:\\raw" });
});

test("resolver falls back to the static .header property on old hosts", () => {
  const resolve = createScopeResolver({ config: testConfig({ scopeEnabled: true }), ctx: {} });
  const exec = { agent: { session: { id: "s1", header: { agentPreset: "novelist" } } } };
  assert.deepEqual(resolve(exec), { agent_scope: "novelist", workspace_scope: null });
});

test("session.header wins over requestHeader() (EpochHeader must not shadow the durable header)", () => {
  const resolve = createScopeResolver({ config: testConfig({ scopeEnabled: true }), ctx: {} });
  // 本地 web 复验（2026-09-13）实测踩中的形状：requestHeader() 返回请求级
  // EpochHeader（模型路由头，无 agentPreset/cwd），曾在首个请求后遮蔽
  // session.header，导致标注全空。
  const exec = {
    agent: {
      session: {
        id: "s1",
        header: { agentPreset: "coder", cwd: "D:\\proj" },
        requestHeader: () => ({ config: testConfig({ provider: "deepseek-official", model: "deepseek-v4-flash" }) })
      }
    }
  };
  assert.deepEqual(resolve(exec), { agent_scope: "coder", workspace_scope: "D:\\proj" });
});

test("hosts without .header fall back to requestHeader().config shape", () => {
  const resolve = createScopeResolver({ config: testConfig({ scopeEnabled: true }), ctx: {} });
  const exec = {
    agent: {
      session: {
        id: "s2",
        requestHeader: () => ({ config: testConfig({ agentPreset: "legacy", cwd: "E:\\old" }) })
      }
    }
  };
  assert.deepEqual(resolve(exec), { agent_scope: "legacy", workspace_scope: "E:\\old" });
});

test("resolver never throws: registry explosion degrades to header cwd and warns once", () => {
  const warnings = [];
  const resolve = createScopeResolver({
    config: testConfig({ scopeEnabled: true }),
    ctx: { workspaceRegistry: { list: () => { throw new Error("boom"); } } },
    logger: { warn: (m) => warnings.push(String(m)) }
  });
  const exec = { agent: { session: { id: "s1", header: { agentPreset: "coder", cwd: "D:\\raw" } } } };
  assert.deepEqual(resolve(exec), { agent_scope: "coder", workspace_scope: "D:\\raw" });
  assert.equal(warnings.length, 1, "warn exactly once, never block the write path");
});

test("resolver without a session or header lands all-NULL", () => {
  const resolve = createScopeResolver({ config: testConfig({ scopeEnabled: true }), ctx: {} });
  assert.deepEqual(resolve(undefined), { agent_scope: null, workspace_scope: null });
  assert.deepEqual(resolve({ agent: { session: { id: "s2" } } }), { agent_scope: null, workspace_scope: null });
});
