import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// #218 v1：heat 作为注入排序的**同级内乘数**（issue #218 拍板口径）。
// 规则路 comparator 的层内权重 importance×quality 乘 heat；priority 分层
// （summary=0 / preference=1 / coding 同级 / 其余 2）与 store 的 order=chrono
// 分页序不动。
//
// issue #218 / E5 效用考卷：heat 乘进注入排序在真实年龄混合下饿死老约束
// （现行量级 ≡ 拟合参数，importance-only 遵从 +12.7pp），注入侧 heat 拆出
// 独立开关 injectHeatEnabled（默认关）——默认关档下 heatEnabled=true 的库
// 注入排序与 heat 关闭逐字节一致（平价锁）；显式开启才恢复旧序。
// 召回侧时钟（touchLastAccess）与 sleep 降级联判不受本键影响。

const HOUR = 3600000;

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

const titles = (candidates) => candidates.map((c) => c.title);

// 三个用例共用的「冷高重要性 + 新低重要性」库。
function seedColdAndFresh(service) {
  const cold = service.saveWithDedupe({ type: "decision", title: "冷的高重要性决策", content: "旧", importance: 4 }).memory;
  service.saveWithDedupe({ type: "decision", title: "新的低重要性决策", content: "新", importance: 3 });
  service.touchLastAccess(cold.id, new Date(Date.now() - 3000 * HOUR).toISOString());
  // 新记忆不触达：ref 退 created_at（≈现在），heat≈1，不影响本用例
}

test("heat off（默认）：层内维持 importance 序，与改动前一致", () => {
  const { store, service } = setup();
  seedColdAndFresh(service);
  const picked = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.deepEqual(titles(picked), ["冷的高重要性决策", "新的低重要性决策"]);
  store.close();
});

test("heat on 且 injectHeatEnabled 关（新默认）：注入序与 heat 关闭逐字节一致（E5 平价锁）", () => {
  const { store, service } = setup({ heatEnabled: true });
  seedColdAndFresh(service);
  const picked = service.injectCandidates({ maxItems: 5, threshold: 3 });
  // E5 效用考卷：heat 乘进注入排序饿死老约束——默认不再乘，冷的高重要性决策
  // 回到它 importance 应在的位置（与 heat off 用例逐条相同）。
  assert.deepEqual(titles(picked), ["冷的高重要性决策", "新的低重要性决策"]);
  store.close();
});

test("heat on 且 injectHeatEnabled 开：恢复旧序（老用户回滚口）", () => {
  const { store, service } = setup({ heatEnabled: true, injectHeatEnabled: true });
  seedColdAndFresh(service);
  const picked = service.injectCandidates({ maxItems: 5, threshold: 3 });
  // λ=0.002、3000h → 冷记忆权重 4×e^-6≈0.01，新鲜记忆 3×≈1 → 反超
  assert.deepEqual(titles(picked), ["新的低重要性决策", "冷的高重要性决策"]);
  store.close();
});

test("heat on 且 injectHeatEnabled 开 且 λ=0（免疫类型）：乘数恒 1，importance 序不受影响", () => {
  const { store, service } = setup({ heatEnabled: true, injectHeatEnabled: true, heatTypeDecay: { decision: 0 } });
  seedColdAndFresh(service);
  const picked = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.deepEqual(titles(picked), ["冷的高重要性决策", "新的低重要性决策"]);
  store.close();
});

test("heat 不跨层：再热的 decision 也不越过 summary 层（injectHeatEnabled 开）", () => {
  const { store, service } = setup({ heatEnabled: true, injectHeatEnabled: true });
  service.saveWithDedupe({ type: "summary", title: "会话总览", content: "总览", importance: 2 });
  service.saveWithDedupe({ type: "decision", title: "滚烫决策", content: "新", importance: 3 });
  const picked = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.equal(picked[0].type, "summary", "priority 分层不被 heat 打破");
  store.close();
});
