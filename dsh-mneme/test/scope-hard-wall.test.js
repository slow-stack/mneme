// 2026-11-15 裁决：把「导入区」做成真正的硬墙记忆区。
//
// 背景（实测，别当成推测）：strictScope 的硬墙只对 workspace_scope_source ===
// "explicit" 的行生效（src/service.js:143,147 与 src/store.js:2008,2011 同口径，
// 是 issue #170 4.3 的刻意设计：auto 可信度不足，只吃软加权）。而导入、蒸馏、
// 工具自动标注三条路原本都落 auto，于是「固定写进某个工作区就天然封闭」并不
// 成立——实测 auto 行会经 searchMemories 与 injectCandidates 跨区现身。
//
// 本文件的约定：被列入硬墙名单的工作区，写入时直接落 explicit，让墙真的立起来。
// 值必须非空——explicit + NULL 等于全局可见，那等于把墙拆了（见 scope.js 的
// normalizeExplicitScope：'global'/'*'/空白都归一成 NULL）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { createSummarizer } from "../src/summarize.js";
import { normalizeExplicitScope, scopeKeyOf, isHardWallWorkspace, resolveScopeStamp } from "../src/scope.js";
import { FAKE_API_TOKEN } from "./helpers/fake-auth-values.js";
import { testConfig } from "./helpers/test-config.js";

const IMPORTS = "D:\\DSH\\workspaces\\deepseek-app";
const OTHER = "D:\\DSH\\.dsh\\bot\\workspace";

function harness(extra = {}) {
  const store = createStore(":memory:");
  const service = createService({
    store,
    mirror: null,
    config: testConfig({ scopeEnabled: true, strictScope: true, ...extra })
  });
  return { store, service };
}

// 三面不可见：谓词、检索、注入。这是验收表的核心，缺一面就有静默通道。
test("hard wall: an explicit-stamped import-area row is invisible on all three faces", async () => {
  const { store, service } = harness();

  store.save({
    type: "preference", title: "导入区私事", content: "我怕蛇，别给我看蛇",
    importance: 5, workspace_scope: IMPORTS, workspace_scope_source: "explicit"
  });
  store.save({ type: "preference", title: "全局的事", content: "我讨厌开会", importance: 5 });

  const otherScope = { agent_scope: null, workspace_scope: OTHER };
  const selfScope = { agent_scope: null, workspace_scope: IMPORTS };

  const row = service.list({ type: "preference" }).find((m) => m.title === "导入区私事");
  assert.ok(row, "夹具本身要能取到那一行，否则下面的断言是在考空值");
  // 面 1：谓词
  assert.equal(service.isVisibleInScope(row, otherScope), false, "谓词面：区外应不可见");
  assert.equal(service.isVisibleInScope(row, selfScope), true, "谓词面：本区应可见");

  // 面 2：检索
  const outside = await service.searchMemories("蛇", {
    mode: "keyword", scope: otherScope
  });
  assert.ok(!outside.some((m) => m.title === "导入区私事"), "检索面：区外不该召回");
  const inside = await service.searchMemories("蛇", {
    mode: "keyword", scope: selfScope
  });
  assert.ok(inside.some((m) => m.title === "导入区私事"), "检索面：本区应召回");

  // 面 3：注入
  const injOutside = service.injectCandidates({
    query: "我怕什么", maxItems: 10, threshold: 0, scope: otherScope
  });
  const injRows = injOutside.items ?? injOutside.candidates ?? injOutside ?? [];
  assert.ok(!injRows.some((m) => m.title === "导入区私事"), "注入面：区外不该被带进上下文");
});

test("hard wall: explicit value must be non-empty, otherwise the wall silently opens", () => {
  // explicit + NULL = 全局可见。这条把「墙立起来但标了个空值」这种假成功挡住。
  for (const bad of ["global", "GLOBAL", "*", "", "   ", null, 42]) {
    assert.equal(normalizeExplicitScope(bad), null, `${JSON.stringify(bad)} 应归一成 NULL`);
  }
  // scopeKeyOf 与 store/service 的可见性比较同一把钥匙
  assert.equal(scopeKeyOf("  "), null);
  assert.equal(scopeKeyOf(IMPORTS), IMPORTS);
});

// ---------------------------------------------------------------------------
// 名单判定
// ---------------------------------------------------------------------------
test("hard wall: the list matches a workspace regardless of trailing separator or case", () => {
  // 值来自两条路（registry realpath / header.cwd），字面比会让墙时灵时不灵，
  // 而这种「有时拦不住」最难被发现，所以判定必须归一化后比。
  assert.equal(isHardWallWorkspace(IMPORTS, [IMPORTS]), true);
  assert.equal(isHardWallWorkspace(IMPORTS + "\\", [IMPORTS]), true);
  assert.equal(isHardWallWorkspace(IMPORTS.toLowerCase(), [IMPORTS]), true);
  assert.equal(isHardWallWorkspace(IMPORTS + "/", [IMPORTS]), true);
  assert.equal(isHardWallWorkspace(OTHER, [IMPORTS]), false);
  // 名单为空 / 不是数组 = 不命中（留空时必须逐字节不变）
  assert.equal(isHardWallWorkspace(IMPORTS, []), false);
  assert.equal(isHardWallWorkspace(IMPORTS, undefined), false);
  assert.equal(isHardWallWorkspace(IMPORTS, IMPORTS), false);
  // 取不到标签 = 不命中（不能靠 NULL 命中名单）
  assert.equal(isHardWallWorkspace(null, [IMPORTS]), false);
  assert.equal(isHardWallWorkspace("   ", [IMPORTS]), false);
});

test("hard wall: the stamp resolver falls back to auto rather than opening a wall with a NULL label", () => {
  // 正常翻章
  assert.deepEqual(
    resolveScopeStamp({ autoValue: IMPORTS, hardWall: true }),
    { value: IMPORTS, source: "explicit" }
  );
  // 硬墙但取不到非空标签 → 退回 auto（不是 explicit+NULL）
  for (const bad of [null, "", "   "]) {
    assert.deepEqual(
      resolveScopeStamp({ autoValue: bad, hardWall: true }),
      null,
      `${JSON.stringify(bad)} 取不到标签时应不盖章`
    );
  }
  // 未命中硬墙 = 老行为（auto）
  assert.deepEqual(
    resolveScopeStamp({ autoValue: IMPORTS, hardWall: false }),
    { value: IMPORTS, source: "auto" }
  );
  // 显式参数永远赢，且归一化口径不变（'global' → NULL + explicit）
  assert.deepEqual(
    resolveScopeStamp({ explicitValue: "global", autoValue: IMPORTS, hardWall: true }),
    { value: null, source: "explicit" }
  );
  assert.deepEqual(
    resolveScopeStamp({ explicitValue: OTHER, autoValue: IMPORTS, hardWall: true }),
    { value: OTHER, source: "explicit" }
  );
  // 没传显式、也没有自动标注 → 不加字段
  assert.equal(resolveScopeStamp({ explicitValue: undefined, autoValue: null }), null);
});

// ---------------------------------------------------------------------------
// 写入侧：工具与蒸馏都要盖章
// ---------------------------------------------------------------------------
function setupTools(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const registered = [];
  createTools(
    { tools: { register(def) { registered.push(def); return () => {}; } }, logger: { warn() {} } },
    service,
    config
  );
  return { store, service, registered };
}

const importExec = { agent: { session: { id: "s-import", header: { agentPreset: null, cwd: IMPORTS } } } };
const otherExec = { agent: { session: { id: "s-other", header: { agentPreset: null, cwd: OTHER } } } };

test("hard wall: memory_save in a listed workspace stamps explicit, elsewhere stays auto", async () => {
  const config = testConfig({ scopeEnabled: true, scopeHardWallWorkspaces: [IMPORTS] });
  const { store, registered } = setupTools(config);
  const save = registered.find((d) => d.name === "memory_save");

  const inWall = await save.execute.bind(save)(
    { type: "preference", title: "导入区的一条", content: "从旧会话导进来的私事" },
    importExec
  );
  const wallRow = store.getById(inWall.id);
  assert.equal(wallRow.workspace_scope, IMPORTS);
  assert.equal(wallRow.workspace_scope_source, "explicit", "命中名单必须盖 explicit 章，否则墙不成立");
  // agent 维不跟着翻：硬墙按工作区圈地，不能让同一 agent 在别的工作区的记忆一起被圈。
  // 这个夹具没有 agentPreset，所以 agent 维本来就没有标签（不是被翻成 explicit）。
  assert.equal(wallRow.agent_scope, undefined);
  assert.equal(wallRow.agent_scope_source, undefined);

  const outWall = await save.execute.bind(save)(
    { type: "preference", title: "常用区的一条", content: "日常记的事" },
    otherExec
  );
  const outRow = store.getById(outWall.id);
  assert.equal(outRow.workspace_scope, OTHER);
  assert.equal(outRow.workspace_scope_source, "auto", "未命中名单必须保持 auto（老行为逐字节不变）");
});

test("hard wall: an empty list leaves every write byte-identical to before", async () => {
  const config = testConfig({ scopeEnabled: true });
  const { store, registered } = setupTools(config);
  const save = registered.find((d) => d.name === "memory_save");
  const out = await save.execute.bind(save)(
    { type: "preference", title: "导入区的一条", content: "body" },
    importExec
  );
  const row = store.getById(out.id);
  assert.equal(row.workspace_scope, IMPORTS);
  assert.equal(row.workspace_scope_source, "auto");
});

// ---------------------------------------------------------------------------
// 选料视图：按区列出（供人挑着搬）
// ---------------------------------------------------------------------------
test("hard wall: the picker filter lists exactly one workspace and stays out of the visibility gate", () => {
  const { store, service } = harness();
  store.save({ type: "preference", title: "区内 A", content: "a", workspace_scope: IMPORTS, workspace_scope_source: "explicit" });
  store.save({ type: "preference", title: "区内 B", content: "b", workspace_scope: IMPORTS, workspace_scope_source: "auto" });
  store.save({ type: "preference", title: "区外 C", content: "c", workspace_scope: OTHER, workspace_scope_source: "auto" });
  store.save({ type: "preference", title: "全局 D", content: "d" });

  // 精确列出：来源不同也要列（auto 行同样是这一区的行），别的区与全局都不列
  const listed = service.list({ type: "preference", workspaceScope: IMPORTS }).map((m) => m.title).sort();
  assert.deepEqual(listed, ["区内 A", "区内 B"]);
  // total 必须与行同过滤，否则分页的「还有更多」会算错
  assert.equal(service.count("preference", { workspaceScope: IMPORTS }), 2);

  // 它叠加在可见性闸门之上，而不是替换它：给了标签也翻不出硬墙挡住的行。
  // 注意这里同时是「auto 不构成硬墙」的书面证据：区内 B 是 auto，闸门放它过；
  // 区内 A 是 explicit 且不属于当前区，闸门挡掉。选料过滤没有放宽这一层。
  const gated = service.list({
    type: "preference",
    workspaceScope: IMPORTS,
    visibility: { agentScope: null, workspaceScope: OTHER }
  }).map((m) => m.title);
  assert.deepEqual(gated, ["区内 B"], "选料过滤不得把硬墙挡住的行翻出来");

  // 空标签 = 不过滤（老调用方逐字节不变）
  assert.equal(service.list({ type: "preference", workspaceScope: "  " }).length, 4);
});

// ---------------------------------------------------------------------------
// 出库：挑着搬到目标区 / global，逐条回执 + 审计
// ---------------------------------------------------------------------------
function setupApi(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const ctx = new EventEmitter();
  ctx.logger = { warn() {}, info() {}, debug() {}, error() {} };
  const routes = [];
  ctx.webServer = { register(def) { routes.push(def); return () => {}; } };
  const settings = createSettings(store.db);
  const api = createApi(ctx, service, settings, { register() {} }, null, null, FAKE_API_TOKEN, config);
  return { store, service, routes, api };
}

function fakeRes() {
  const res = { statusCode: 0, body: null, headers: {} };
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers ?? {}; return res; };
  res.end = (chunk) => { res.body = chunk ? JSON.parse(chunk) : null; };
  res.write = (chunk) => { res.body = chunk ? JSON.parse(chunk) : null; return true; };
  res.setHeader = () => {};
  res.headersSent = false;
  return res;
}

function req(path, method, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const stream = new EventEmitter();
  stream.method = method;
  stream.url = path;
  stream.headers = { authorization: `Bearer ${FAKE_API_TOKEN}`, "content-type": "application/json" };
  stream.on = stream.on.bind(stream);
  setImmediate(() => {
    if (payload !== null) stream.emit("data", Buffer.from(payload, "utf8"));
    stream.emit("end");
  });
  return stream;
}

function findHandler(routes, path) {
  const def = routes.find((r) => r.path === path);
  assert.ok(def, `route ${path} should be registered`);
  return def;
}

test("hard wall: promoting selected rows out of the wall is per-row and audited", async () => {
  const { store, service, routes } = setupApi(testConfig({ scopeEnabled: true, strictScope: true }));
  const a = store.save({ type: "preference", title: "要搬走的 A", content: "a", workspace_scope: IMPORTS, workspace_scope_source: "explicit" });
  const b = store.save({ type: "preference", title: "要搬走的 B", content: "b", workspace_scope: IMPORTS, workspace_scope_source: "explicit" });
  const outside = store.save({ type: "preference", title: "别区的 C", content: "c", workspace_scope: OTHER, workspace_scope_source: "explicit" });

  const handler = findHandler(routes, "/api/dsh-mneme/scope/promote");
  const res = fakeRes();
  await handler.handler(req("/api/dsh-mneme/scope/promote", "POST", {
    ids: [a.id, b.id, outside.id, "no-such-id"],
    from: IMPORTS,
    to: "global"
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.applied, 2);
  assert.equal(res.body.requested, 4);
  // 逐条回执：搬错一条的代价是它在别处露头，必须让人看见是哪条、为什么
  const byId = new Map(res.body.results.map((r) => [r.id, r]));
  assert.equal(byId.get(a.id).ok, true);
  assert.equal(byId.get(b.id).ok, true);
  assert.equal(byId.get(outside.id).ok, false);
  assert.equal(byId.get(outside.id).error, "not-in-scope");
  assert.equal(byId.get(outside.id).actual, OTHER, "拒绝时必须点名实际所在区");
  assert.equal(byId.get("no-such-id").error, "not-found");

  // 搬出去 ≠ 只删标注：值改成 global(NULL) 且来源仍是 explicit（放宽），并落审计
  const moved = store.getById(a.id);
  assert.equal(moved.workspace_scope, undefined);
  assert.equal(moved.workspace_scope_source, "explicit");
  const audit = service.listScopeChanges(a.id);
  assert.ok(audit.length >= 1, "出库必须落 scope_changes 审计");
  assert.equal(audit[0].actor, "panel");
  assert.equal(audit[0].prev_workspace_scope, IMPORTS);

  // 搬完之后从**第三个区**看：搬出去的可见（放宽到全局），没点头的那条仍在墙里。
  const thirdScope = { agent_scope: null, workspace_scope: "D:\\somewhere\\else" };
  assert.equal(service.isVisibleInScope(store.getById(a.id), thirdScope), true);
  assert.equal(service.isVisibleInScope(store.getById(outside.id), thirdScope), false);
});

test("hard wall: promote rejects a malformed request instead of silently doing nothing", async () => {
  const { routes } = setupApi(testConfig({ scopeEnabled: true }));
  const handler = findHandler(routes, "/api/dsh-mneme/scope/promote");

  let res = fakeRes();
  await handler.handler(req("/api/dsh-mneme/scope/promote", "POST", { ids: [], to: "global" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "missing-ids");

  res = fakeRes();
  await handler.handler(req("/api/dsh-mneme/scope/promote", "POST", { ids: ["x"] }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "missing-to");

  res = fakeRes();
  const many = Array.from({ length: 51 }, (_, i) => `id-${i}`);
  await handler.handler(req("/api/dsh-mneme/scope/promote", "POST", { ids: many, to: "global" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "too-many-ids");
});

// ---------------------------------------------------------------------------
// 蒸馏路径：只改工具侧会留一个洞
// ---------------------------------------------------------------------------
// 蒸馏（summarize）是第二条落库通道：它不经过 tools.js，自己调 saveWithDedupe。
// 只给工具盖章的话，同一块地里蒸馏出来的行仍是 auto（软隔离）——墙上就有一个
// 由后台任务开着的门，而这条门没人看着。
function distillHarness(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const events = [];
  const ctx = {
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    on(name, fn) { events.push({ name, fn }); return () => {}; },
    llm: {
      stream() {
        const json = JSON.stringify([
          { type: "decision", title: "导入区蒸馏出来的一条", content: "窗口里说过的事", importance: 4 }
        ]);
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: json };
          yield { type: "block-end", block: { type: "text" } };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  createSummarizer(ctx, service, { ...config, autoSummarize: true, summarizeMinIntervalMinutes: 0, summarizeMaxRunsPerSession: 0, distillRateLimitIntervalMs: 0 }, {});
  return { store, service, handler: events.find((e) => e.name === "session/event").fn };
}

function distillSession(cwd, id) {
  return {
    id,
    header: { agentPreset: null, cwd },
    requestHeader: () => ({ config: testConfig({ provider: "deepseek", model: "deepseek-chat" }) }),
    events: [
      { seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "提问" }] } },
      { seq: 2, type: "turn/end" }
    ]
  };
}

test("hard wall: distillation inside a listed workspace also stamps explicit", async () => {
  const config = testConfig({ scopeEnabled: true, scopeHardWallWorkspaces: [IMPORTS] });
  const { store, handler } = distillHarness(config);
  await handler(distillSession(IMPORTS, "s-distill-wall"), { seq: 2, type: "turn/end" });

  const rows = store.list({ limit: null });
  const distilled = rows.find((r) => r.title === "导入区蒸馏出来的一条");
  assert.ok(distilled, "蒸馏应该落了一行");
  assert.equal(distilled.workspace_scope, IMPORTS);
  assert.equal(distilled.workspace_scope_source, "explicit", "蒸馏路径同样必须盖章，否则后台任务是一条没人看的门");
});

test("hard wall: distillation outside the list keeps the auto stamp", async () => {
  const config = testConfig({ scopeEnabled: true, scopeHardWallWorkspaces: [IMPORTS] });
  const { store, handler } = distillHarness(config);
  await handler(distillSession(OTHER, "s-distill-other"), { seq: 2, type: "turn/end" });

  const distilled = store.list({ limit: null }).find((r) => r.title === "导入区蒸馏出来的一条");
  assert.ok(distilled);
  assert.equal(distilled.workspace_scope, OTHER);
  assert.equal(distilled.workspace_scope_source, "auto", "未命中名单的蒸馏必须保持 auto（老行为逐字节不变）");
});
