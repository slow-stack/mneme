import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// #619 回归：注入规则池此前是 store.list({ limit: 200 }) —— 窗口按 importance
// DESC 取，合格行 8410 条里 8210 条永远进不了窗（Loom 复核报告 A/B 的 B 条）。
// 现在规则池取全部活跃行的排序键、过滤与排序都在 JS 侧做，窗口只限制回表条数。
// 下面四条锁住：窗口外仍能进注入、排序键同水位只取一次、heat 消费侧绕开缓存、
// 回表真的把正文取回来了（排序键快照没有 content）。

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

// 按重要性序排不进前 200 的目标行（summary 优先档，但 importance 只有 1）
function seedWindowFillers(service, n = 250) {
  for (let i = 0; i < n; i++) {
    service.saveWithDedupe({
      type: "project",
      title: `填充条目${i}`,
      content: `普通项目记录第${i}条，内容与哨兵词无关`,
      importance: 5
    });
  }
}

test("#619: 200 行窗口外的高优先档记忆仍能进注入", () => {
  const { store, service } = setup();
  seedWindowFillers(service, 250);
  const target = service.saveWithDedupe({
    type: "summary",
    title: "哨兵摘要",
    content: "这条摘要排在重要性序第 251 位，但仍必须先于普通 project 进注入",
    importance: 1
  }).memory;

  const picked = service.injectCandidates({ maxItems: 5 });
  assert.ok(picked.length > 0, "注入不应为空");
  assert.ok(
    picked.some((m) => m.id === target.id),
    "窗口外的高优先档记忆必须能进注入候选（窗口只该限制回表条数）"
  );
  assert.equal(picked[0].id, target.id, "summary 优先档应排在最前");
  store.close();
});

test("#619: 同一 generation 内多次注入只取一次排序键", () => {
  const { store, service } = setup();
  seedWindowFillers(service, 30);
  let poolLoads = 0;
  const origPool = store.listInjectPool.bind(store);
  store.listInjectPool = () => {
    poolLoads += 1;
    return origPool();
  };

  service.injectCandidates({ maxItems: 5 });
  service.injectCandidates({ maxItems: 5 });
  assert.equal(poolLoads, 1, "无写入时排序键缓存应命中，只取一次");

  // 写入后水位推进，缓存失效
  service.saveWithDedupe({ type: "decision", title: "新决策", content: "新内容", importance: 4 });
  service.injectCandidates({ maxItems: 5 });
  assert.equal(poolLoads, 2, "写入后应先失效再重取");
  store.close();
});

test("#619: heat 双开关同时打开时每次注入都重取排序键", () => {
  const { store, service } = setup({ heatEnabled: true, injectHeatEnabled: true });
  seedWindowFillers(service, 30);
  let poolLoads = 0;
  const origPool = store.listInjectPool.bind(store);
  store.listInjectPool = () => {
    poolLoads += 1;
    return origPool();
  };

  service.injectCandidates({ maxItems: 5 });
  service.injectCandidates({ maxItems: 5 });
  // touchLastAccess 只写 last_accessed_at、刻意不 bump generation，heat 依赖它，
  // 所以这条路径必须绕开「按 generation 缓存」——否则 heat 停在上一轮的读数上。
  assert.equal(poolLoads, 2, "heat 消费侧必须每轮重读，不能被 generation 缓存挡住");
  store.close();
});

test("#619: 注入条目带完整字段（证明走回表而不是排序键快照）", () => {
  const { store, service } = setup();
  const target = service.saveWithDedupe({
    type: "decision",
    title: "回表校验",
    content: "正文必须回表取到，排序键快照里只有 12 列、没有 content",
    importance: 5,
    tags: ["回表"]
  }).memory;

  const picked = service.injectCandidates({ maxItems: 5 });
  const hit = picked.find((m) => m.id === target.id);
  assert.ok(hit, "目标行应入选");
  assert.equal(hit.content, "正文必须回表取到，排序键快照里只有 12 列、没有 content");
  assert.deepEqual(hit.tags, ["回表"]);
  store.close();
});
