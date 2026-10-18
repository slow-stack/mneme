import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";

// issue #471：作用域级可逆闸门（政策轴）。
//
// 与 #17 / #170 那条事实轴（scope 标注与可见性）是两条不同的轴：
//   - 事实轴回答「这条记忆归谁」，答案写在记忆行上，改了它就是在改事实；
//   - 政策轴回答「这一路现在通不通」，答案写在 scope_state 表里，可逆、
//     不改任何记忆行、不改作用域标注、不动向量与归档位。
//
// 三道验收线（对应 issue 正文的三处落点）：
//   1. 默认关：gateByScope 的输出与改动前**逐字段一致**，且是**同一个数组引用**
//      （引用相等才钉得住「零行为变化」，内容相等会让「悄悄复制一份」蒙过去）；
//   2. 按下与松开：同一作用域的候选进不来，松开后原样回来——两个方向都要断言，
//      只锁「进不来」的话，一个「永远返回空」的实现也能过；
//   3. 观察档：enabled 开、enforce 关 → 留一条 llm_audit_logs 但注入照常，
//      这条是两级开关的意义所在（先在真实流量里看「如果按下会少掉多少」）。

function setup(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

const PAUSED_CONFIG = { scopeState: { enabled: true, enforce: true } };
const OBSERVE_CONFIG = { scopeState: { enabled: true, enforce: false } };

/** 造一批带 workspace 标注的记忆，一半属于 `proj-a`，一半无标注。 */
function seed(store) {
  store.save({ type: "decision", title: "a-1", content: "alpha beta gamma", importance: 4, workspace_scope: "proj-a", workspace_scope_source: "explicit" });
  store.save({ type: "decision", title: "a-2", content: "alpha beta gamma", importance: 4, workspace_scope: "proj-a", workspace_scope_source: "explicit" });
  store.save({ type: "decision", title: "b-1", content: "alpha beta gamma", importance: 4, workspace_scope: "proj-b", workspace_scope_source: "explicit" });
  store.save({ type: "decision", title: "g-1", content: "alpha beta gamma", importance: 4 });
}

const titles = (rows) => rows.map((m) => m.title).sort();

// --- 验收线 1：默认关时逐字段一致，且引用不变 -----------------------------

test("默认关：gateByScope 原样返回同一个数组（引用相等，不是等值副本）", () => {
  const { store, service } = setup({});
  seed(store);
  const rows = store.list({});
  const out = service.filterPaused(rows);
  // 引用相等：内容相等的副本会让「复制一份再返回」蒙过去，那样后续每次
  // 检索都白复制一遍，而「零行为变化」这条验收就退化成「看起来一样」。
  assert.equal(out, rows);
});

test("默认关：按下过状态也不生效——开关不打开时状态表根本不被读", () => {
  const { store, service } = setup({});
  seed(store);
  // 即便有人在开关关着的时候写进了状态（比如另一台机器同步过来），也不生效。
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });
  const rows = store.list({});
  assert.equal(service.filterPaused(rows), rows);
});

test("默认关：注入候选集与无闸门时逐条相同", () => {
  const off = setup({});
  seed(off.store);
  const baseline = titles(off.service.injectCandidates({ maxItems: 10, threshold: 1 }));

  const pressed = setup({});
  seed(pressed.store);
  pressed.service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });
  const after = titles(pressed.service.injectCandidates({ maxItems: 10, threshold: 1 }));

  assert.deepEqual(after, baseline);
});

// --- 验收线 2：按下与松开（两个方向都锁） ---------------------------------

test("按下后：被按下作用域的候选进不来注入池，别的照常进", () => {
  const { store, service } = setup(PAUSED_CONFIG);
  seed(store);
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });

  const got = titles(service.injectCandidates({ maxItems: 10, threshold: 1 }));
  assert.deepEqual(got, ["b-1", "g-1"]);
  // 反向断言：不是「全都进不来」。
  assert.ok(got.includes("b-1") && got.includes("g-1"));
});

test("松开后：原样回来（同一个 service 实例，不重开库）", () => {
  const { store, service } = setup(PAUSED_CONFIG);
  seed(store);
  const before = titles(service.injectCandidates({ maxItems: 10, threshold: 1 }));

  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });
  assert.deepEqual(titles(service.injectCandidates({ maxItems: 10, threshold: 1 })), ["b-1", "g-1"]);

  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "active" });
  // 逐条相同（不只「数量相同」）：松开要真的恢复原样，不是恢复个大概。
  assert.deepEqual(titles(service.injectCandidates({ maxItems: 10, threshold: 1 })), before);
});

test("按下不动事实：记忆行、作用域标注、归档位一字段都不变", () => {
  const { store, service } = setup(PAUSED_CONFIG);
  seed(store);
  const snapshot = () => store.list({}).map((m) => ({
    id: m.id, title: m.title, workspace_scope: m.workspace_scope,
    workspace_scope_source: m.workspace_scope_source, archived: m.archived, forgotten: m.forgotten
  })).sort((x, y) => x.title.localeCompare(y.title));

  const before = snapshot();
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "active" });
  assert.deepEqual(snapshot(), before);
});

test("检索侧同款：被按下的作用域在 searchMemories 里也出局", async () => {
  const { store, service } = setup(PAUSED_CONFIG);
  seed(store);
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });

  const hits = await service.searchMemories("alpha", { mode: "keyword", limit: 10 });
  const got = titles(hits);
  assert.ok(!got.includes("a-1") && !got.includes("a-2"), `unexpected: ${got.join(",")}`);
  assert.ok(got.includes("b-1"));
});

test("全局按下（'*'）拦下该维度所有有标注的行，但不波及未标注行", () => {
  const { store, service } = setup(PAUSED_CONFIG);
  seed(store);
  service.setScopeState({ dimension: "workspace", scope_value: "*", state: "paused" });

  // g-1 无 workspace 标注 ⇒ 在 workspace 这一维上不参与比较，不受影响。
  assert.deepEqual(titles(service.injectCandidates({ maxItems: 10, threshold: 1 })), ["g-1"]);
});

test("维度独立：按下 agent 维不影响 workspace 维的行", () => {
  const { store, service } = setup(PAUSED_CONFIG);
  seed(store);
  service.setScopeState({ dimension: "agent", scope_value: "proj-a", state: "paused" });

  // 这批行没有 agent 标注，agent 维的按下一条都命中不了。
  const got = titles(service.injectCandidates({ maxItems: 10, threshold: 1 }));
  assert.deepEqual(got, ["a-1", "a-2", "b-1", "g-1"]);
});

// --- 验收线 3：观察档留审计但不拦 -----------------------------------------

test("观察档：注入照常，但留一条 scopeState 审计行", () => {
  const { store, service } = setup(OBSERVE_CONFIG);
  seed(store);
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });

  const got = titles(service.injectCandidates({ maxItems: 10, threshold: 1 }));
  // 观察档不拦：四条全在。
  assert.deepEqual(got, ["a-1", "a-2", "b-1", "g-1"]);

  const audits = store.listLlmAudits({ source: "scopeState" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operation_type, "scope_state_gate");
  assert.equal(audits[0].model_id, "-");
  assert.equal(audits[0].status, "skipped");
  assert.equal(audits[0].metadata.enforced, false);
  // gated 记的是「本应拦下几条」，不是「拦了几条」——观察档下后者恒 0，
  // 记它就等于没记。
  assert.equal(audits[0].metadata.gated, 2);
  assert.deepEqual(audits[0].metadata.paused, [{ dimension: "workspace", scope_value: "proj-a" }]);
});

test("拦截档：同一条审计行但 enforced=true，且真拦下了", () => {
  const { store, service } = setup(PAUSED_CONFIG);
  seed(store);
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });

  assert.deepEqual(titles(service.injectCandidates({ maxItems: 10, threshold: 1 })), ["b-1", "g-1"]);

  const audits = store.listLlmAudits({ source: "scopeState" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].metadata.enforced, true);
  assert.equal(audits[0].metadata.gated, 2);
});

test("没有候选被拦时不写审计行（门没经过人，不该留痕）", () => {
  const { store, service } = setup(OBSERVE_CONFIG);
  seed(store);
  service.setScopeState({ dimension: "workspace", scope_value: "proj-zzz", state: "paused" });
  service.injectCandidates({ maxItems: 10, threshold: 1 });
  assert.equal(store.listLlmAudits({ source: "scopeState" }).length, 0);
});

test("enforce 开、enabled 关：无效果（enforce 不单独生效，同 preInjectGate）", () => {
  const { store, service } = setup({ scopeState: { enabled: false, enforce: true } });
  seed(store);
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });
  assert.deepEqual(titles(service.injectCandidates({ maxItems: 10, threshold: 1 })), ["a-1", "a-2", "b-1", "g-1"]);
  assert.equal(store.listLlmAudits({ source: "scopeState" }).length, 0);
});

// --- 状态表本身的语义 -----------------------------------------------------

test("同一状态重复按下不刷新 decided_at（按两次不等于换了决定）", () => {
  const { service } = setup(PAUSED_CONFIG);
  const first = service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused", decided_at: "2026-01-01T00:00:00.000Z" });
  const again = service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused", decided_at: "2026-01-02T00:00:00.000Z" });
  assert.equal(first.decided_at, "2026-01-01T00:00:00.000Z");
  assert.equal(again.decided_at, "2026-01-01T00:00:00.000Z");

  const flipped = service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "active", decided_at: "2026-01-03T00:00:00.000Z" });
  assert.equal(flipped.decided_at, "2026-01-03T00:00:00.000Z");
  assert.equal(flipped.state, "active");
});

test("不带理由的重按不抹掉已有理由（理由被一次手滑抹掉是净损失）", () => {
  const { service } = setup(PAUSED_CONFIG);
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused", note: "等这轮重构完再开" });
  const again = service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "active" });
  assert.equal(again.note, "等这轮重构完再开");

  const replaced = service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused", note: "换了个理由" });
  assert.equal(replaced.note, "换了个理由");
});

test("非法维度/值/状态返回 undefined，不静默落一行永不生效的状态", () => {
  const { service, store } = setup(PAUSED_CONFIG);
  assert.equal(service.setScopeState({ dimension: "agent", scope_value: "ok", state: "maybe" }), undefined);
  assert.equal(service.setScopeState({ dimension: "nope", scope_value: "ok", state: "paused" }), undefined);
  assert.equal(service.setScopeState({ dimension: "agent", scope_value: "   ", state: "paused" }), undefined);
  assert.equal(store.listScopeStates().length, 0);
});

test("一次现读：另一个实例改了状态，本实例下一次判定立刻看得见（没有缓存要失效）", () => {
  const store = createStore(":memory:");
  const a = createService({ store, mirror: null, config: PAUSED_CONFIG });
  const b = createService({ store, mirror: null, config: PAUSED_CONFIG });
  store.save({ type: "decision", title: "a-1", content: "alpha beta gamma", importance: 4, workspace_scope: "proj-a", workspace_scope_source: "explicit" });

  assert.deepEqual(titles(a.injectCandidates({ maxItems: 10, threshold: 1 })), ["a-1"]);
  b.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });
  assert.deepEqual(titles(a.injectCandidates({ maxItems: 10, threshold: 1 })), []);
});

// --- 工具面 ---------------------------------------------------------------

function makeTools(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const ctx = {
    tools: { register() {} },
    logger: { warn() {}, info() {}, error() {} }
  };
  const tools = createTools(ctx, service, config, null);
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { store, service, tool: byName.get("set_scope_state") };
}

test("set_scope_state 回执回显库内当前值，不是回显入参", async () => {
  const { tool } = makeTools(PAUSED_CONFIG);
  const first = await tool.execute({ dimension: "workspace", scope_value: "proj-a", state: "paused", note: "先停一下" });
  assert.deepEqual(first.scope, {
    dimension: "workspace",
    scope_value: "proj-a",
    state: "paused",
    note: "先停一下",
    decided_at: first.scope.decided_at
  });

  // 同一状态重按：入参没带 note，但回执里 note 还在，decided_at 也没变。
  const again = await tool.execute({ dimension: "workspace", scope_value: "proj-a", state: "paused" });
  assert.equal(again.scope.decided_at, first.scope.decided_at);
  assert.equal(again.scope.note, "先停一下");
});

test("set_scope_state 对非法参数抛可行动的错，不是静默返回空", async () => {
  const { tool } = makeTools(PAUSED_CONFIG);
  await assert.rejects(() => tool.execute({ dimension: "nope", scope_value: "x", state: "paused" }), /dimension/);
  await assert.rejects(() => tool.execute({ dimension: "agent", scope_value: "x", state: "maybe" }), /state/);
  await assert.rejects(() => tool.execute({ dimension: "agent", scope_value: "", state: "paused" }), /scope_value/);
});
