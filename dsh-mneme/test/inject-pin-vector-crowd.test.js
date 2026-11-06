import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

// 回归（pin 池被向量路封顶饿死）：`injectCandidates` 里 hybrid 分支先把
// `vectorIndex.search(qv, {limit: poolSize})` 的结果全量 push 进 merged，随后
// `if (merged.length >= poolSize) break;` 在**pin 筛选之前**就封顶——生产
// maxItems=5 → poolSize=10，向量路一次正好返回 10 条即 break，规则窗口里那些
// constraint/preference 一条都进不了 candidates，pin 池只能从这 10 条里筛，
// 命中几条纯看它们碰巧是什么类型。
//
// 代码注释向来自称「pin 不占 maxItems 名额」，实现里却把名额占掉了。实测真库
// maxItems=5 时 pin shown 只有 2/5，补回后恒 5/5；maxItems=10（poolSize=20）
// 时前后都是 5/5——所以修法不是多给名额，是把被向量路吃掉的 pin 候选补回来。
//
// 修法位置：不在 hybrid 分支之前提前摘（那样会绕过下面 strictScope 与
// scopeState 两道闸门，而 :1907 的注释明确写着「pin 池 eligible 取自过滤之后的
// 候选，顺带保证越权行进不了 pin」），而是在合并之后、闸门之前把被甩掉的 pin
// 类行补回候选池尾部——闸门照旧作用其上。
//
// 本文件锁三件事：
//   ① 向量路把 poolSize 填满时，pin 池照旧拿满预算（缺口本体）
//   ② 补回的是规则窗口（items）里的 pin，与向量命中集无关——即使查询向量与
//      pin 条目毫不相干，它们也能进块（这是 pin 的定义：每轮必进）
//   ③ 预算关时行为逐字节不变

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const vectorIndex = createVectorIndex({ store });
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex };
}

// 向量路上与查询完全同向的普通条目：正好填满 poolSize 个名额，且一条都不是 pin 类型。
function seedVectorCrowd(service, vectorIndex, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const m = service.saveWithDedupe({
      type: "decision",
      title: `决定条目${i}`,
      content: `第 ${i} 条与查询同向的普通决定，不该占掉 pin 的名额`,
      importance: 5
    }).memory;
    vectorIndex.saveEmbedding(m.id, [1, 0, 0]);
    ids.push(m.id);
  }
  return ids;
}

// 与查询向量正交的 pin 条目：向量路永远检索不到它们，只能靠规则窗口进块。
function seedPinnedPreferences(service, vectorIndex, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const m = service.saveWithDedupe({
      type: "preference",
      title: `硬偏好${i}`,
      content: `第 ${i} 条约束/偏好，每轮必进，与查询向量正交`,
      importance: 5
    }).memory;
    vectorIndex.saveEmbedding(m.id, [0, 1, 0]);
    ids.push(m.id);
  }
  return ids;
}

const titlesOf = (list) => list.map((m) => m.title);

test("pin 池不被向量路封顶：poolSize 被填满时仍拿满 pinnedInjectBudget", () => {
  // maxItems=5 → poolSize=10，与生产默认值一致；预算是 5，满额。
  const { service, vectorIndex } = setup({
    maxInjectedItems: 5,
    pinnedInjectBudget: 5,
    importanceThreshold: 3
  });
  seedVectorCrowd(service, vectorIndex, 10); // 正好 poolSize 条，全是 decision
  seedPinnedPreferences(service, vectorIndex, 5);

  const pinnedStats = {};
  const selected = service.injectCandidates({
    query: "随便问一个与偏好无关的问题",
    maxItems: 5,
    queryVector: [1, 0, 0],
    pinnedStats
  });

  // 缺口本体的断言：修前这里是 0（向量路 10 条里一条 preference 都没有）。
  assert.equal(pinnedStats.shown, 5, "pin 池必须拿满预算，不能被向量路的 poolSize 截断");
  const pinnedTitles = titlesOf(selected).filter((t) => t.startsWith("硬偏好"));
  assert.equal(pinnedTitles.length, 5, "5 条 pin 必须真的进块（不只是计数对）");
  // pin 前置在块内：前 5 位必须全是 pin 条目（同 importance/updated_at 的
  // 同批条目内部次序由 id 决定，不是本用例要锁的东西，故只断言集合）。
  const head = titlesOf(selected).slice(0, 5);
  assert.ok(head.every((t) => t.startsWith("硬偏好")), `pin 前置到块内排序之前：${head.join(" / ")}`);
  assert.deepEqual([...head].sort(), [...pinnedTitles].sort(), "前 5 位就是那 5 条 pin");
});

test("pin 池取自规则窗口，不取自被封顶的 candidates", () => {
  // 这条锁的是「怎么修」而不是「修没修」：向量路返回的 10 条与 pin 类型完全
  // 不相交，若 eligible 仍从 candidates 过滤，pin 恒为 0——无论 poolSize 多大。
  const { service, vectorIndex } = setup({
    maxInjectedItems: 2,
    pinnedInjectBudget: 2,
    importanceThreshold: 3
  });
  seedVectorCrowd(service, vectorIndex, 4); // poolSize = maxItems*2 = 4，正好填满
  seedPinnedPreferences(service, vectorIndex, 2);

  const pinnedStats = {};
  const selected = service.injectCandidates({
    query: "另一个与偏好无关的问题",
    maxItems: 2,
    queryVector: [1, 0, 0],
    pinnedStats
  });

  assert.equal(pinnedStats.shown, 2, "maxItems=2 时 pin 也要拿满 2 条");
  const head = titlesOf(selected).slice(0, 2);
  assert.ok(
    head.every((t) => t.startsWith("硬偏好")),
    `pin 从规则窗口取，与向量命中集无关：${head.join(" / ")}`
  );
});

test("pin 池关闭时行为不变：pinnedInjectBudget=0 不得凭空引入偏好", () => {
  // 关闭态必须与改动前逐字节一致——补回的 pin 只在预算 > 0 时发生，
  // 预算关时 candidates 与改前完全一样。
  const { service, vectorIndex } = setup({
    maxInjectedItems: 5,
    pinnedInjectBudget: 0,
    importanceThreshold: 3
  });
  seedVectorCrowd(service, vectorIndex, 10);
  seedPinnedPreferences(service, vectorIndex, 5);

  const pinnedStats = {};
  const selected = service.injectCandidates({
    query: "又一个与偏好无关的问题",
    maxItems: 5,
    queryVector: [1, 0, 0],
    pinnedStats
  });

  assert.equal(pinnedStats.shown, 0, "预算 0 → pin 池关闭");
  assert.equal(selected.length, 5, "槽位数不变");
  assert.ok(
    titlesOf(selected).every((t) => t.startsWith("决定条目")),
    "关闭态下 preference 不得被前置（顺序与改动前一致）"
  );
});

// 安全底线：补回 pin 是在 strictScope 与 scopeState 两道闸门**之前**做的，
// 所以这两道闸必须照旧能拦住被补回来的 pin 行。service.js 里那条位置纪律
// （「pin 池 eligible 取自过滤之后的候选，顺带保证越权行进不了 pin」）就是靠
// 这两条用例守住的——不然「补回」会顺带开一个越权口子。
test("补回的 pin 仍受 strictScope 硬过滤：越权偏好不得因补回而进块", () => {
  const { store, service, vectorIndex } = setup({
    maxInjectedItems: 5,
    pinnedInjectBudget: 5,
    importanceThreshold: 3,
    strictScope: true
  });
  seedVectorCrowd(service, vectorIndex, 10);
  // 一条属于 proj-a 的偏好：调用方 scope 是 proj-b 时它必须进不来。
  const m = service.saveWithDedupe({
    type: "preference",
    title: "越权偏好",
    content: "只属于 proj-a 的偏好，不该泄进 proj-b 的注入块",
    importance: 5,
    workspace_scope: "proj-a",
    workspace_scope_source: "explicit"
  }).memory;
  vectorIndex.saveEmbedding(m.id, [0, 1, 0]);

  const pinnedStats = {};
  const selected = service.injectCandidates({
    query: "与偏好无关的问题",
    maxItems: 5,
    queryVector: [1, 0, 0],
    scope: { agent_scope: null, workspace_scope: "proj-b" },
    pinnedStats
  });

  assert.ok(
    !titlesOf(selected).includes("越权偏好"),
    `strictScope 必须挡住被补回的越权 pin：${titlesOf(selected).join(" / ")}`
  );
  assert.equal(pinnedStats.shown, 0, "被 scope 挡下的行不能算成已 pin");
});

test("补回的 pin 仍受 scopeState 拦截档约束：暂停作用域的偏好不得进块", () => {
  const { service, vectorIndex } = setup({
    maxInjectedItems: 5,
    pinnedInjectBudget: 5,
    importanceThreshold: 3,
    scopeState: { enabled: true, enforce: true }
  });
  seedVectorCrowd(service, vectorIndex, 10);
  const m = service.saveWithDedupe({
    type: "preference",
    title: "暂停域偏好",
    content: "属于 proj-a 的偏好，而 proj-a 此刻被按下",
    importance: 5,
    workspace_scope: "proj-a",
    workspace_scope_source: "explicit"
  }).memory;
  vectorIndex.saveEmbedding(m.id, [0, 1, 0]);
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });

  const pinnedStats = {};
  const selected = service.injectCandidates({
    query: "与偏好无关的问题",
    maxItems: 5,
    queryVector: [1, 0, 0],
    pinnedStats
  });

  assert.ok(
    !titlesOf(selected).includes("暂停域偏好"),
    `scopeState 拦截档必须挡住被补回的 pin：${titlesOf(selected).join(" / ")}`
  );
  assert.equal(pinnedStats.shown, 0, "被闸门拦下的行不能算成已 pin");
});
