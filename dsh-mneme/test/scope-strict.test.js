import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";

// v0.8.0 A3（issue #17）→ v0.8.1 第 3 步（issue #170 4.3，作者已确认）：
// strictScope 硬过滤只认显式声明。可见性公式收窄为：记忆可见 ⇔ 对每一维
// （该维标注存在且来源=explicit 时：命中当前会话）AND。
//   - explicit 行为硬墙：他者维度不可见（含 memory_get 无存在性泄漏）；
//   - auto / 存量 NULL 来源（v0.8.0 自动标注）不进硬过滤，只吃 A2 软加权
//     （foreign ×0.5 保留可见）；
//   - 当前会话维度解析不到 → 该维 explicit 行一律不可见（fail-closed 收窄）。

function setup(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

test("visibility predicate: explicit rows keep four-quadrant semantics", () => {
  const { service } = setup({ scopeEnabled: true, strictScope: true });
  const vis = service.isVisibleInScope;
  const me = { agent_scope: "coder", workspace_scope: "D:\\p" };
  const E = "explicit";

  // 全局（未标注）对谁都可见。
  assert.equal(vis({}, me), true);
  // agent 专属：同 agent 任意 workspace 可见，他人不可见。
  assert.equal(vis({ agent_scope: "coder", agent_scope_source: E }, me), true);
  assert.equal(vis({ agent_scope: "novelist", agent_scope_source: E }, me), false);
  // workspace 专属：同 workspace 任意 agent 可见，别的 workspace 不可见。
  assert.equal(vis({ workspace_scope: "D:\\p", workspace_scope_source: E }, me), true);
  assert.equal(vis({ workspace_scope: "D:\\q", workspace_scope_source: E }, me), false);
  // 双标注：精确命中才可见。
  assert.equal(vis({ agent_scope: "coder", agent_scope_source: E, workspace_scope: "D:\\p", workspace_scope_source: E }, me), true);
  assert.equal(vis({ agent_scope: "coder", agent_scope_source: E, workspace_scope: "D:\\q", workspace_scope_source: E }, me), false);
  assert.equal(vis({ agent_scope: "novelist", agent_scope_source: E, workspace_scope: "D:\\p", workspace_scope_source: E }, me), false);
});

test("visibility predicate: auto and legacy rows are NOT hard walls (soft only)", () => {
  const { service } = setup({ scopeEnabled: true, strictScope: true });
  const vis = service.isVisibleInScope;
  const me = { agent_scope: "coder", workspace_scope: "D:\\p" };

  // auto（v0.8.1 载体自动标注）与存量 NULL 来源（v0.8.0 自动标注）他者维度
  // 也可见——硬过滤只认 explicit。
  assert.equal(vis({ agent_scope: "novelist" }, me), true, "legacy NULL source");
  assert.equal(vis({ agent_scope: "novelist", agent_scope_source: "auto" }, me), true);
  assert.equal(vis({ workspace_scope: "D:\\q", workspace_scope_source: "auto" }, me), true);
  // 混合：agent 维 auto + workspace 维 explicit → 只 workspace 维构成硬墙。
  assert.equal(vis({ agent_scope: "novelist", agent_scope_source: "auto", workspace_scope: "D:\\q", workspace_scope_source: "explicit" }, me), false);
  assert.equal(vis({ agent_scope: "novelist", agent_scope_source: "explicit", workspace_scope: "D:\\q", workspace_scope_source: "auto" }, me), false);
});

test("visibility predicate: anonymous session fail-closes only explicit rows", () => {
  const { service } = setup({ scopeEnabled: true, strictScope: true });
  const vis = service.isVisibleInScope;
  const anon = { agent_scope: null, workspace_scope: null };
  assert.equal(vis({}, anon), true);
  assert.equal(vis({ agent_scope: "coder", agent_scope_source: "explicit" }, anon), false);
  assert.equal(vis({ workspace_scope: "D:\\p", workspace_scope_source: "explicit" }, anon), false);
  // auto/存量行照常可见（不冒认，但也不因身份缺失误杀软标注）。
  assert.equal(vis({ agent_scope: "coder" }, anon), true);
  assert.equal(vis({ agent_scope: "coder", agent_scope_source: "auto" }, anon), true);
});

test("searchMemories: explicit foreign filtered, auto/legacy foreign stay visible under strictScope", async () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: true });
  store.save({ type: "project", title: "global needle", content: "x" });
  store.save({ type: "project", title: "mine needle", content: "x", agent_scope: "me", agent_scope_source: "explicit" });
  store.save({ type: "project", title: "explicit foreign needle", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  store.save({ type: "project", title: "auto foreign needle", content: "x", agent_scope: "other", agent_scope_source: "auto" });
  store.save({ type: "project", title: "legacy foreign needle", content: "x", agent_scope: "other" });

  const rows = await service.searchMemories("needle", {
    mode: "keyword",
    scope: { agent_scope: "me", workspace_scope: null }
  });
  // explicit 他者出局；auto/存量他者保留（A2 降权仍可见）；未标注与命中行保留。
  assert.deepEqual(rows.map((m) => m.title).sort(), [
    "auto foreign needle", "global needle", "legacy foreign needle", "mine needle"
  ]);
});

test("strictScope off keeps A2 behavior: foreign rows demoted but visible", async () => {
  const { store, service } = setup({ scopeEnabled: true });
  store.save({ type: "project", title: "foreign needle", content: "x", agent_scope: "other" });
  const rows = await service.searchMemories("needle", {
    mode: "keyword",
    scope: { agent_scope: "me", workspace_scope: null }
  });
  assert.deepEqual(rows.map((m) => m.title), ["foreign needle"]);
});

test("store.list/count visibility: explicit hard wall + auto/legacy pass, consistent totals", () => {
  const { store } = setup({ scopeEnabled: true, strictScope: true });
  store.save({ type: "decision", title: "g", content: "x" });
  store.save({ type: "decision", title: "mine", content: "x", agent_scope: "me", agent_scope_source: "explicit", workspace_scope: "D:\\p", workspace_scope_source: "explicit" });
  store.save({ type: "decision", title: "theirs-explicit", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  store.save({ type: "decision", title: "theirs-auto", content: "x", agent_scope: "other", agent_scope_source: "auto" });
  store.save({ type: "decision", title: "theirs-legacy", content: "x", agent_scope: "other" });
  store.save({ type: "decision", title: "other-ws-explicit", content: "x", workspace_scope: "D:\\q", workspace_scope_source: "explicit" });

  const vis = { agentScope: "me", workspaceScope: "D:\\p" };
  const titles = store.list({ visibility: vis }).map((m) => m.title).sort();
  assert.deepEqual(titles, ["g", "mine", "theirs-auto", "theirs-legacy"]);
  assert.equal(store.count("decision", { visibility: vis }), 4);

  // 匿名会话：explicit 行全出局，auto/存量/未标注放行。
  const anonTitles = store.list({ visibility: { agentScope: null, workspaceScope: null } }).map((m) => m.title).sort();
  assert.deepEqual(anonTitles, ["g", "theirs-auto", "theirs-legacy"]);
  assert.equal(store.count("decision", { visibility: { agentScope: null, workspaceScope: null } }), 3);
});

test("injectCandidates hard-filters explicit foreign rows when strictScope is on", () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: true });
  store.save({ type: "decision", title: "global", content: "x", importance: 4 });
  store.save({ type: "decision", title: "foreign", content: "x", importance: 4, agent_scope: "other", agent_scope_source: "explicit" });
  store.save({ type: "decision", title: "auto-foreign", content: "x", importance: 4, agent_scope: "other", agent_scope_source: "auto" });

  const injected = service.injectCandidates({
    maxItems: 5,
    threshold: 3,
    scope: { agent_scope: "me", workspace_scope: null }
  });
  assert.deepEqual(injected.map((m) => m.title).sort(), ["auto-foreign", "global"]);

  // flag 下（scope 不传）→ 他 scope 照常注入（A2 前行为）。
  const unscoped = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.deepEqual(unscoped.map((m) => m.title).sort(), ["auto-foreign", "foreign", "global"]);
});

test("memory_update/memory_delete hide explicit foreign-scope rows under strictScope (review item 4, aligned with memory_get)", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true, strictScope: true });
  const theirs = store.save({ type: "pitfall", title: "theirs", content: "c", agent_scope: "other", agent_scope_source: "explicit" });
  const autoTheirs = store.save({ type: "pitfall", title: "auto-theirs", content: "c", agent_scope: "other", agent_scope_source: "auto" });
  const update = pick("memory_update");
  const del = pick("memory_delete");

  // explicit 他 scope：update 按不存在拒绝、delete 视作不存在——不能凭 id 直改直删。
  await assert.rejects(() => runHandler(update, { id: theirs.id, content: "tampered" }, STRICT_EXEC), /memory not found/);
  assert.equal(store.getById(theirs.id).content, "c", "row untouched by the rejected update");
  const delOut = await runHandler(del, { id: theirs.id }, STRICT_EXEC);
  assert.equal(delOut.deleted, false, "delete treats invisible rows as absent (no existence leak)");
  assert.ok(store.getById(theirs.id), "row NOT deleted");

  // auto 他 scope：不构成硬墙，照常可改（与 get 的可见性口径一致）。
  const updAuto = await runHandler(update, { id: autoTheirs.id, content: "updated" }, STRICT_EXEC);
  assert.equal(updAuto.memory.id, autoTheirs.id);

  // 行主人自己照常可改。
  const ownerOut = await runHandler(update, { id: theirs.id, content: "owner edit" }, OTHER_EXEC);
  assert.equal(ownerOut.memory.id, theirs.id);

  // strictScope 关：update/delete 不做可见性校验（管理语义回归）。
  const { store: store2, pick: pick2 } = setupTools({ scopeEnabled: true });
  const t2 = store2.save({ type: "pitfall", title: "theirs", content: "c", agent_scope: "other", agent_scope_source: "explicit" });
  await runHandler(pick2("memory_update"), { id: t2.id, content: "edited" }, STRICT_EXEC);
  assert.equal(store2.getById(t2.id).content, "edited");
  const del2 = await runHandler(pick2("memory_delete"), { id: t2.id }, STRICT_EXEC);
  assert.equal(del2.deleted, true);
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
  return { store, pick };
}

async function runHandler(def, args, exec) {
  const handler = def.execute.bind(def);
  return handler(args, exec);
}

const STRICT_EXEC = { agent: { session: { id: "s1", header: { agentPreset: "me", cwd: "D:\\p" } } } };
const OTHER_EXEC = { agent: { session: { id: "s2", header: { agentPreset: "other", cwd: "D:\\q" } } } };

test("memory_get hides explicit foreign-scope rows under strictScope, resolvable for the owner", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true, strictScope: true });
  const mine = store.save({ type: "pitfall", title: "mine", content: "c", agent_scope: "me", agent_scope_source: "explicit" });
  const theirs = store.save({ type: "pitfall", title: "theirs", content: "c", agent_scope: "other", agent_scope_source: "explicit" });
  const autoTheirs = store.save({ type: "pitfall", title: "auto-theirs", content: "c", agent_scope: "other", agent_scope_source: "auto" });
  const get = pick("memory_get");

  const out = await runHandler(get, { id: mine.id }, STRICT_EXEC);
  assert.equal(out.memory.title, "mine");

  // explicit 他 scope → 按不存在处理（无存在性泄漏）。
  await assert.rejects(() => runHandler(get, { id: theirs.id }, STRICT_EXEC), /memory not found/);
  // auto 他 scope → 可见（软加权不进硬过滤）。
  const autoOut = await runHandler(get, { id: autoTheirs.id }, STRICT_EXEC);
  assert.equal(autoOut.memory.title, "auto-theirs");
  // 行主人自己照常可取。
  const ownerOut = await runHandler(get, { id: theirs.id }, OTHER_EXEC);
  assert.equal(ownerOut.memory.title, "theirs");
});

test("memory_get without strictScope returns any row regardless of scope annotation", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true });
  const theirs = store.save({ type: "pitfall", title: "theirs", content: "c", agent_scope: "other", agent_scope_source: "explicit" });
  const get = pick("memory_get");
  const out = await runHandler(get, { id: theirs.id }, STRICT_EXEC);
  assert.equal(out.memory.title, "theirs");
});

test("memory_list filters explicit rows and keeps total consistent under strictScope", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true, strictScope: true });
  store.save({ type: "decision", title: "g", content: "x" });
  store.save({ type: "decision", title: "mine", content: "x", agent_scope: "me", agent_scope_source: "explicit" });
  store.save({ type: "decision", title: "theirs", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  const list = pick("memory_list");

  const out = await runHandler(list, { type: "decision" }, STRICT_EXEC);
  assert.deepEqual(out.items.map((m) => m.title).sort(), ["g", "mine"]);
  assert.equal(out.total, 2);

  // flag 关（A2 默认）：他 scope 的行照常出现在浏览视图。
  const { store: store2, pick: pick2 } = setupTools({ scopeEnabled: true });
  store2.save({ type: "decision", title: "theirs", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  const out2 = await runHandler(pick2("memory_list"), { type: "decision" }, STRICT_EXEC);
  assert.deepEqual(out2.items.map((m) => m.title), ["theirs"]);
  assert.equal(out2.total, 1);
});

// --- entity: / attr: 前缀路的 scope 闸 ----------------------------------------
// 回归锁：这两条前缀路在 searchMemories 的入口就 return，早于融合池那道 strictScope
// 过滤，曾经整条绕过硬墙——显式他者 scope 的记忆用 `entity:` / `attr:` 就能原样读出，
// 而且是满分返回（连 A2 的 ×0.5 都没有）。所以除了「出局」，还要钉住「auto / 存量
// 他者保留」这条 A2 语义没有跟着塌掉。

/** 把若干记忆挂到同一个实体上。
 *  属性键必须各不相同：同一 (实体, 键) 有时间轴语义，后写的一条会把前一条作废，
 *  那样只有最后一条会被链接上（写这个测试时踩过，别改成同一个键）。 */
function linkToEntity(store, name, memories) {
  const entity = store.createEntity({ name, type: "person" });
  memories.forEach((mem, i) => {
    store.saveAttr({ entity_id: entity.id, attr_key: `attr${i}`, attr_value: `value${i}`, memory_id: mem.id });
  });
  return entity;
}

/** 五条覆盖各种 scope 来源的记忆，供下面两条用。 */
function saveScopeBattery(store) {
  return {
    global: store.save({ type: "project", title: "global", content: "x" }),
    mine: store.save({ type: "project", title: "mine", content: "x", agent_scope: "me", agent_scope_source: "explicit" }),
    theirs: store.save({ type: "project", title: "theirs", content: "x", agent_scope: "other", agent_scope_source: "explicit" }),
    autoForeign: store.save({ type: "project", title: "auto", content: "x", agent_scope: "other", agent_scope_source: "auto" }),
    legacyForeign: store.save({ type: "project", title: "legacy", content: "x", agent_scope: "other" })
  };
}

test("searchMemories entity: prefix honours the strictScope hard filter", async () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: true, entitySearchEnabled: true });
  const rows = saveScopeBattery(store);
  linkToEntity(store, "阿尔托", Object.values(rows));

  const asMe = await service.searchMemories("entity:阿尔托", { scope: { agent_scope: "me", workspace_scope: null } });
  assert.deepEqual(asMe.map((m) => m.title).sort(), ["auto", "global", "legacy", "mine"], "显式他者出局，auto / 存量他者按 A2 保留");

  // 原主人自己查：显式那条必须还在（否则上面是「谁都搜不到」的假绿）。
  const asOther = await service.searchMemories("entity:阿尔托", { scope: { agent_scope: "other", workspace_scope: null } });
  assert.ok(asOther.some((m) => m.title === "theirs"), "命中当前 agent 的显式行必须可见");
});

test("searchMemories attr: prefix honours the strictScope hard filter", async () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: true, entitySearchEnabled: true });
  const rows = saveScopeBattery(store);
  // 每条挂到各自实体上、共用一个属性键：这样 attr:key=value 能一次覆盖全部五条
  // （同实体同键会被时间轴作废，见 linkToEntity 的注释）。
  Object.values(rows).forEach((mem, i) => {
    const entity = store.createEntity({ name: `entity-${i}`, type: "person" });
    store.saveAttr({ entity_id: entity.id, attr_key: "国籍", attr_value: "芬兰", memory_id: mem.id });
  });

  const asMe = await service.searchMemories("attr:国籍=芬兰", { scope: { agent_scope: "me", workspace_scope: null } });
  assert.deepEqual(asMe.map((m) => m.title).sort(), ["auto", "global", "legacy", "mine"], "显式他者出局，auto / 存量他者按 A2 保留");

  const asOther = await service.searchMemories("attr:国籍=芬兰", { scope: { agent_scope: "other", workspace_scope: null } });
  assert.ok(asOther.some((m) => m.title === "theirs"), "命中当前 agent 的显式行必须可见");
});

test("entity: / attr: 的 scope 闸在触达之前：出局的行不被回温，也不 bump 关联边", async () => {
  // 闸门若只加在「返回前」，出局的行仍会先被 touchRecalled 摸一遍——一次越权检索
  // 照样给它刷回温时钟、并在被动确认开启时 bump 它的关联边。所以这条钉的是次序。
  const { store, service } = setup({
    scopeEnabled: true, strictScope: true, entitySearchEnabled: true,
    heatEnabled: true, graphWeightEnabled: true, graphPassiveConfirm: true, graphWeightDelta: 0.1
  });
  const theirs = store.save({ type: "project", title: "theirs", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  const global = store.save({ type: "project", title: "global", content: "x" });
  linkToEntity(store, "阿尔托", [theirs, global]);

  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  for (const mem of [theirs, global]) {
    store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "uses", memory_id: mem.id, source: "llm" });
  }

  const rows = await service.searchMemories("entity:阿尔托", { scope: { agent_scope: "me", workspace_scope: null } });
  assert.deepEqual(rows.map((m) => m.title), ["global"], "只剩可见那条");

  // 正向对照：可见那条确实被触达了——否则下面两个「没被触达」可能是假绿。
  assert.ok(store.getRelationsByMemory(global.id)[0].weight > 0.4, "可见行照常 bump 关联边");
  assert.ok(store.getById(global.id).last_accessed_at, "可见行照常回温");

  assert.equal(store.getRelationsByMemory(theirs.id)[0].weight, 0.4, "出局行不该 bump 关联边");
  assert.equal(store.getById(theirs.id).last_accessed_at ?? null, null, "出局行不该被回温");
});

test("scope 闸先于 topK 截断：出局的候选不占名额（topK=1 仍有可见结果）", async () => {
  // 回归锁（评审发现）：先 slice 再 filter 的话，排在前面那条被闸掉的候选会占住唯一的
  // 槽位，明明还有可见匹配却返回空数组。用 topK=1 把次序钉死——排序不动，只是闸门要插
  // 在截断之前。
  const me = { agent_scope: "me", workspace_scope: null };

  const { store, service } = setup({ scopeEnabled: true, strictScope: true, entitySearchEnabled: true });
  const theirsE = store.save({ type: "project", title: "theirs", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  const mineE = store.save({ type: "project", title: "mine", content: "x", agent_scope: "me", agent_scope_source: "explicit" });
  // 先挂 theirs、后挂 mine：前者排在候选前面，正好充当那个「占位」的候选。
  linkToEntity(store, "阿尔托", [theirsE, mineE]);
  const viaEntity = await service.searchMemories("entity:阿尔托", { topK: 1, scope: me });
  assert.deepEqual(viaEntity.map((m) => m.title), ["mine"], "entity: 在 topK=1 下不该被出局候选挤空");

  // attr: 同理——两条挂同一个属性键、各挂自己的实体，theirs 先写入。
  const { store: s2, service: svc2 } = setup({ scopeEnabled: true, strictScope: true, entitySearchEnabled: true });
  const theirsA = s2.save({ type: "project", title: "theirs", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  const mineA = s2.save({ type: "project", title: "mine", content: "x", agent_scope: "me", agent_scope_source: "explicit" });
  for (const [i, mem] of [theirsA, mineA].entries()) {
    const entity = s2.createEntity({ name: `e${i}`, type: "person" });
    s2.saveAttr({ entity_id: entity.id, attr_key: "国籍", attr_value: "芬兰", memory_id: mem.id });
  }
  const viaAttr = await svc2.searchMemories("attr:国籍=芬兰", { topK: 1, scope: me });
  assert.deepEqual(viaAttr.map((m) => m.title), ["mine"], "attr: 在 topK=1 下不该被出局候选挤空");
});
