import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { normalizeExplicitScope } from "../src/scope.js";
import { FAKE_API_TOKEN } from "./helpers/fake-auth-values.js";
import { testConfig } from "./helpers/test-config.js";

// v0.8.1 底座（issue #170）：scope 归属的显式声明与人工纠偏。
//   - 三列可空迁移（agent_scope_source / workspace_scope_source / scope_decided_at），
//     来源拆 agent/workspace 两列：混合来源（agent 显式 + workspace 自动）必须可表达；
//   - 显式参数逐维覆盖载体自动标注并盖 explicit 章；"global"/"*"/空白 = 显式全局；
//   - scope_changes 审计表记录每次归属决策（actor: tool | panel）；
//   - 面板抽屉可编辑 + 放宽可见性需二次确认。
// 夹具一律中性主题（暗色/亮色偏好），不得使用可辨识真实记忆。

// ---------------------------------------------------------------------------
// 存储层
// ---------------------------------------------------------------------------
test("migration adds three nullable scope provenance columns without defaults", () => {
  const store = createStore(":memory:");
  const cols = store.db.prepare("PRAGMA table_info(memories)").all();
  for (const name of ["agent_scope_source", "workspace_scope_source", "scope_decided_at"]) {
    const col = cols.find((c) => c.name === name);
    assert.ok(col, `column ${name} should exist`);
    assert.equal(col.notnull, 0, `${name} must be nullable`);
    assert.equal(col.dflt_value, null, `${name} must not carry a DEFAULT (存量零重写)`);
  }
  const tables = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='scope_changes'"
  ).all();
  assert.equal(tables.length, 1, "scope_changes audit table must exist");
});

test("store.save persists/normalizes scope provenance; dirty source lands as NULL", () => {
  const store = createStore(":memory:");
  const kept = store.save({
    type: "preference",
    title: "editor theme",
    content: "prefers dark theme in editors",
    agent_scope: "coder",
    agent_scope_source: "explicit",
    workspace_scope: "D:\\proj",
    workspace_scope_source: "auto",
    scope_decided_at: "2026-09-14T10:00:00+08:00"
  });
  assert.equal(kept.agent_scope_source, "explicit");
  assert.equal(kept.workspace_scope_source, "auto");
  assert.equal(kept.scope_decided_at, "2026-09-14T02:00:00.000Z");

  const dirty = store.save({
    type: "preference",
    title: "dirty provenance",
    content: "body",
    agent_scope_source: "hacked",
    workspace_scope_source: 42,
    scope_decided_at: "not-a-date"
  });
  assert.equal(dirty.agent_scope_source, undefined);
  assert.equal(dirty.workspace_scope_source, undefined);
  assert.equal(dirty.scope_decided_at, undefined);
});

test("store.update rewrites scope columns only when the patch carries the key", () => {
  const store = createStore(":memory:");
  const row = store.save({
    type: "project",
    title: "build notes",
    content: "body",
    agent_scope: "coder",
    agent_scope_source: "auto"
  });

  // undefined=不动（来源与值原样保留）。
  const untouched = store.update(row.id, { content: "v2" });
  assert.equal(untouched.agent_scope, "coder");
  assert.equal(untouched.agent_scope_source, "auto");

  // null=清空为未标注/global。
  const cleared = store.update(row.id, { agent_scope: null, agent_scope_source: "explicit", scope_decided_at: "2026-09-14T00:00:00Z" });
  assert.equal(cleared.agent_scope, undefined);
  assert.equal(cleared.agent_scope_source, "explicit");
  assert.equal(cleared.scope_decided_at, "2026-09-14T00:00:00.000Z");

  // 字符串=收窄/改标。
  const narrowed = store.update(row.id, { agent_scope: "writer" });
  assert.equal(narrowed.agent_scope, "writer");
  // 未携带 source 键 → 来源列保留 explicit。
  assert.equal(narrowed.agent_scope_source, "explicit");
});

// ---------------------------------------------------------------------------
// scope.js 归一化
// ---------------------------------------------------------------------------
test("normalizeExplicitScope: global sentinels land as null; labels are trimmed", () => {
  assert.equal(normalizeExplicitScope("global"), null);
  assert.equal(normalizeExplicitScope("  GLOBAL "), null);
  assert.equal(normalizeExplicitScope("*"), null);
  assert.equal(normalizeExplicitScope("   "), null);
  assert.equal(normalizeExplicitScope(" coder "), "coder");
  assert.equal(normalizeExplicitScope(42), null);
});

// ---------------------------------------------------------------------------
// service 层
// ---------------------------------------------------------------------------
test("saveWithDedupe passes provenance through to the created row", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const out = service.saveWithDedupe({
    type: "preference",
    title: "editor theme",
    content: "prefers dark theme in editors",
    agent_scope: "coder",
    agent_scope_source: "auto"
  });
  assert.equal(out.action, "created");
  assert.equal(out.memory.agent_scope_source, "auto");
});

test("explicit save with the same scope values upgrades a merged auto row to explicit", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ scopeEnabled: true }) });
  const first = service.saveWithDedupe({
    type: "preference", title: "editor theme", content: "v1",
    agent_scope: "coder", agent_scope_source: "auto"
  });
  assert.equal(first.action, "created");
  assert.equal(first.memory.agent_scope_source, "auto");

  // 同键显式写入 → 并入 + 来源升级 + decided_at 刷新；值不变。
  const second = service.saveWithDedupe({
    type: "preference", title: "editor theme", content: "v2",
    agent_scope: "coder", agent_scope_source: "explicit"
  });
  assert.equal(second.action, "merged");
  assert.equal(second.memory.id, first.memory.id);
  assert.equal(second.memory.agent_scope, "coder");
  assert.equal(second.memory.agent_scope_source, "explicit");
  assert.ok(second.memory.scope_decided_at, "merged upgrade must stamp scope_decided_at");

  // review 3（#170）：来源升级也是归属性质改变 → 落 scope_changes 审计行。
  const audit = service.listScopeChanges(first.memory.id);
  assert.equal(audit.length, 1, "exactly one audit row for the one-time upgrade");
  assert.equal(audit[0].actor, "tool");
  assert.equal(audit[0].prev_agent_scope, "coder");
  assert.equal(audit[0].next_agent_scope, "coder");
  assert.equal(audit[0].agent_scope_source, "explicit");

  // 再次显式并入（来源已是 explicit）→ 不重复升级、不重复审计。
  service.saveWithDedupe({
    type: "preference", title: "editor theme", content: "v3",
    agent_scope: "coder", agent_scope_source: "explicit"
  });
  assert.equal(service.listScopeChanges(first.memory.id).length, 1, "no duplicate audit rows on idempotent merges");
});

test("updateMemory stamps explicit scope, records audit row, and honors actor", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const row = store.save({ type: "preference", title: "editor theme", content: "body", agent_scope: "coder", agent_scope_source: "auto" });

  // 工具路径（默认 actor=tool）：global 归一化为 NULL + explicit 章。
  const widened = service.update(row.id, { agent_scope: "GLOBAL" });
  assert.equal(widened.agent_scope, undefined);
  assert.equal(widened.agent_scope_source, "explicit");
  assert.ok(widened.scope_decided_at);
  const auditTool = service.listScopeChanges(row.id);
  assert.equal(auditTool.length, 1);
  assert.equal(auditTool[0].actor, "tool");
  assert.equal(auditTool[0].prev_agent_scope, "coder");
  assert.equal(auditTool[0].next_agent_scope, undefined);
  assert.equal(auditTool[0].agent_scope_source, "explicit");

  // 面板路径（actor=panel）：收窄到具体标签。
  const narrowed = service.update(row.id, { agent_scope: "writer" }, { actor: "panel" });
  assert.equal(narrowed.agent_scope, "writer");
  const auditPanel = service.listScopeChanges(row.id);
  assert.equal(auditPanel.length, 2, "audit rows are newest-first and append per decision");
  assert.equal(auditPanel[0].actor, "panel");
  assert.equal(auditPanel[0].prev_agent_scope, undefined);
  assert.equal(auditPanel[0].next_agent_scope, "writer");

  // workspace 维独立盖章，agent 维不动。
  const wsOnly = service.update(row.id, { workspace_scope: null }, { actor: "panel" });
  assert.equal(wsOnly.agent_scope, "writer");
  assert.equal(wsOnly.agent_scope_source, "explicit");
  assert.equal(wsOnly.workspace_scope_source, "explicit");
  assert.equal(service.listScopeChanges(row.id).length, 3);

  // 不带 scope 键的普通更新不盖章、不写审计。
  service.update(row.id, { content: "v3" });
  assert.equal(service.listScopeChanges(row.id).length, 3);
});

// ---------------------------------------------------------------------------
// tools 层
// ---------------------------------------------------------------------------
function setupTools(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const registered = [];
  createTools(
    { tools: { register(def) { registered.push(def); return () => {}; } } },
    service,
    config
  );
  return { store, service, registered };
}

const EXEC = { agent: { session: { id: "s1", header: { agentPreset: "coder", cwd: "D:\\proj" } } } };

test("memory_save: explicit 'global' overrides the carrier auto label and stamps explicit", async () => {
  const { store, registered } = setupTools({ scopeEnabled: true });
  const memorySave = registered.find((d) => d.name === "memory_save");
  const out = await memorySave.execute.bind(memorySave)(
    { type: "preference", title: "editor theme", content: "prefers dark theme in editors", agent_scope: "global" },
    EXEC
  );
  const row = store.getById(out.id);
  // agent 维显式全局（值 NULL + explicit）；workspace 维保持载体自动标注。
  assert.equal(row.agent_scope, undefined);
  assert.equal(row.agent_scope_source, "explicit");
  assert.ok(row.agent_scope_source === "explicit" && row.workspace_scope === "D:\\proj");
  assert.equal(row.workspace_scope_source, "auto");
});

test("memory_save: explicit label wins over the carrier preset; mixed provenance is preserved", async () => {
  const { store, registered } = setupTools({ scopeEnabled: true });
  const memorySave = registered.find((d) => d.name === "memory_save");
  const out = await memorySave.execute.bind(memorySave)(
    { type: "pitfall", title: "port conflict", content: "kill the stale listener first", agent_scope: "writer" },
    EXEC
  );
  const row = store.getById(out.id);
  assert.equal(row.agent_scope, "writer");
  assert.equal(row.agent_scope_source, "explicit");
  assert.equal(row.workspace_scope, "D:\\proj");
  assert.equal(row.workspace_scope_source, "auto");
});

test("memory_save: explicit declarations are honored even with scopeEnabled off", async () => {
  const { store, registered } = setupTools({});
  const memorySave = registered.find((d) => d.name === "memory_save");
  const out = await memorySave.execute.bind(memorySave)(
    { type: "preference", title: "editor theme", content: "body", agent_scope: "global" },
    EXEC
  );
  const row = store.getById(out.id);
  assert.equal(row.agent_scope, undefined);
  assert.equal(row.agent_scope_source, "explicit");
  // 自动标注仍被 flag 关闭：workspace 一个字段都不标。
  assert.equal(row.workspace_scope, undefined);
  assert.equal(row.workspace_scope_source, undefined);
});

test("memory_save: flag on without explicit args keeps A1 behavior (auto stamps only)", async () => {
  const { store, registered } = setupTools({ scopeEnabled: true });
  const memorySave = registered.find((d) => d.name === "memory_save");
  const out = await memorySave.execute.bind(memorySave)(
    { type: "preference", title: "editor theme", content: "body" },
    EXEC
  );
  const row = store.getById(out.id);
  assert.equal(row.agent_scope, "coder");
  assert.equal(row.agent_scope_source, "auto");
  assert.equal(row.workspace_scope, "D:\\proj");
  assert.equal(row.workspace_scope_source, "auto");
});

test("memory_save: dirty (non-string) scope args are rejected at the schema layer, never silently widened", async () => {
  const { store, registered } = setupTools({ scopeEnabled: true });
  const memorySave = registered.find((d) => d.name === "memory_save");
  // review 2（#170）复核结论：工具入参 schema（type: "string"）在 execute 之前
  // 就拒绝非字符串——脏值到不了 normalizeExplicitScope，不存在「静默变显式全局」
  // 的路径（API 路径 400 同理）。本测试钉死该保证防回归。
  await assert.rejects(
    () => memorySave.execute.bind(memorySave)(
      { type: "preference", title: "editor theme", content: "body", agent_scope: 42 },
      EXEC
    ),
    /agent_scope.*string/i
  );
  assert.equal(store.count("preference"), 0, "rejected call must not write");
});

test("dedupe compares scope keys even with scopeEnabled off (review item 1: explicit rows never cross-merge)", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  // flag 关 + 显式声明：不同归属的同标题行绝不物理合并（否则内容挂错归属，
  // strictScope 下原主人反而看不见）。
  const first = service.saveWithDedupe({
    type: "preference", title: "editor theme", content: "v1",
    agent_scope: "writer", agent_scope_source: "explicit"
  });
  assert.equal(first.action, "created");
  const second = service.saveWithDedupe({
    type: "preference", title: "editor theme", content: "v2",
    agent_scope: "global", agent_scope_source: "explicit"
  });
  assert.equal(second.action, "created", "explicit global never merges into an explicitly scoped row");
  const third = service.saveWithDedupe({ type: "preference", title: "editor theme", content: "v3" });
  assert.equal(third.action, "created", "unscoped row does not merge into the labeled row either");
  assert.equal(store.count("preference"), 3);

  // 同归属显式行仍然并入 + 来源升级。
  const fourth = service.saveWithDedupe({
    type: "preference", title: "editor theme", content: "v4",
    agent_scope: "writer", agent_scope_source: "explicit"
  });
  assert.equal(fourth.action, "merged");
  assert.equal(fourth.memory.id, first.memory.id);
  assert.equal(store.count("preference"), 3);

  // 存量形状（全 NULL）flag 关下仍互相合并（A1 前行为不变）。
  const l1 = service.saveWithDedupe({ type: "project", title: "legacy note", content: "a" });
  const l2 = service.saveWithDedupe({ type: "project", title: "legacy note", content: "b" });
  assert.equal(l2.action, "merged");
  assert.equal(l2.memory.id, l1.memory.id);
});

test("memory_update: explicit scope correction applies, stamps explicit, and audits", async () => {  const { store, service, registered } = setupTools({ scopeEnabled: true });
  const memoryUpdate = registered.find((d) => d.name === "memory_update");
  assert.ok(memoryUpdate, "memory_update registered");
  const saveDef = registered.find((d) => d.name === "memory_save");
  const saved = await saveDef.execute.bind(saveDef)(
    { type: "preference", title: "editor theme", content: "body" },
    EXEC
  );
  const result = await memoryUpdate.execute.bind(memoryUpdate)(
    { id: saved.id, agent_scope: "global", reason: "user says this applies everywhere" }
  );
  assert.ok(result.memory.id);
  const row = store.getById(saved.id);
  assert.equal(row.agent_scope, undefined);
  assert.equal(row.agent_scope_source, "explicit");
  const audit = service.listScopeChanges(saved.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, "tool");
  assert.equal(audit[0].prev_agent_scope, "coder");
});

// ---------------------------------------------------------------------------
// API 层（面板路径）
// ---------------------------------------------------------------------------
class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function apiReq(path, method, body) {
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = {};
  if (body !== null) {
    process.nextTick(() => {
      r.emit("data", Buffer.from(JSON.stringify(body)));
      r.emit("end");
    });
  }
  return r;
}

function setupApi() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, FAKE_API_TOKEN);
  return { store, service, routes };
}

async function postUpdate(routes, body) {
  const route = routes.find((r) => r.path === "/api/dsh-mneme/update");
  const request = apiReq("/api/dsh-mneme/update", "POST", body);
  request.headers = { authorization: `Bearer ${FAKE_API_TOKEN}` };
  const res = new FakeRes();
  await route.handler(request, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

test("panel /update applies explicit scope corrections and audits as panel actor", async () => {
  const { store, service, routes } = setupApi();
  const row = store.save({ type: "preference", title: "editor theme", content: "body", agent_scope: "coder", agent_scope_source: "auto" });

  // 放宽到全局（null）。
  const widened = await postUpdate(routes, { id: row.id, agent_scope: null });
  assert.equal(widened.status, 200);
  assert.equal(widened.body.memory.agent_scope, undefined);
  assert.equal(widened.body.memory.agent_scope_source, "explicit");
  const audit = service.listScopeChanges(row.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, "panel");
  assert.equal(audit[0].prev_agent_scope, "coder");
  assert.equal(audit[0].next_agent_scope, undefined);

  // 收窄到具体标签。
  const narrowed = await postUpdate(routes, { id: row.id, workspace_scope: "D:\\proj" });
  assert.equal(narrowed.status, 200);
  assert.equal(narrowed.body.memory.workspace_scope, "D:\\proj");
  assert.equal(narrowed.body.memory.workspace_scope_source, "explicit");
});

test("panel /update rejects non-string scope values and accepts scope-only patches", async () => {
  const { store, routes } = setupApi();
  const row = store.save({ type: "preference", title: "editor theme", content: "body" });

  const bad = await postUpdate(routes, { id: row.id, agent_scope: 42 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid-agent-scope");

  const badWs = await postUpdate(routes, { id: row.id, workspace_scope: 42 });
  assert.equal(badWs.status, 400);
  assert.equal(badWs.body.error, "invalid-workspace-scope");

  // 纯 scope 补丁不算 no-fields。
  const ok = await postUpdate(routes, { id: row.id, agent_scope: null });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.memory.agent_scope_source, "explicit");
});

// ---------------------------------------------------------------------------
// 面板（源码级断言，同 A4 风格）
// ---------------------------------------------------------------------------
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

test("drawer ships editable scope rows with widen confirmation (issue #170)", () => {
  for (const key of [
    "memory.explorer.detail.scopeGlobal",
    "memory.explorer.detail.scopeSourceAuto",
    "memory.explorer.detail.scopeSourceExplicit",
    "memory.explorer.detail.scopeEditHint",
    "memory.explorer.detail.scopeWidenConfirm",
    "memory.explorer.detail.scopeWidenHint"
  ]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
  assert.ok(clientSource.includes("const [agentScope, setAgentScope]"), "drawer must hold agent scope edit state");
  assert.ok(clientSource.includes("const [workspaceScope, setWorkspaceScope]"), "drawer must hold workspace scope edit state");
  assert.ok(clientSource.includes("const [confirmWiden, setConfirmWiden]"), "widening must require a confirmation state");
  assert.ok(clientSource.includes("t(\"memory.explorer.detail.scopeWidenConfirm\")"), "widen confirm button must be wired");
  // 普通（无 scope 改动）编辑不得发送 scope 键。
  assert.ok(/if \(agentChanged\) patch\.agent_scope/.test(clientSource), "scope keys must only be sent when changed");
});
