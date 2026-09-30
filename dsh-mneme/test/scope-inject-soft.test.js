import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// issue #339 / E7 考卷补齐：A2 软加权（foreign ×0.5 / 命中 ×1.25）此前只作用于
// searchMemories——E7 实测「explicit 标注 + 软档」的注入集与无标注逐条相同
// （80/80），主泄露面上软档形同虚设。本文件锁注入通道的软加权语义：
//   - softScope 激活（scopeEnabled + scope 至少一维可解析）→ foreign 行在层内
//     数值积上 ×0.5，压不过同档自己行；未标注行同列吃 BOOST 不被压制；
//   - flag 关 / scope 两维全空 → 注入序与改动前逐字节一致（锁平价）；
//   - strictScope 硬过滤先行，被滤行不会被二次降权；
//   - 加权后的序流入 pin 池选取（pin 拿到的是加权后次序）。

function setup(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

const SCOPE_ME = { agent_scope: "me", workspace_scope: null };

test("injectCandidates soft weight demotes explicit foreign rows below same-importance own rows", () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: false });
  // 同 importance 档（E7 的同档设计）：无软加权时全靠插入序，foreign 在前。
  store.save({ type: "decision", title: "foreign-a", content: "x", importance: 4, agent_scope: "other", agent_scope_source: "explicit" });
  store.save({ type: "decision", title: "mine-a", content: "x", importance: 4, agent_scope: "me", agent_scope_source: "explicit" });
  store.save({ type: "decision", title: "foreign-b", content: "x", importance: 4, agent_scope: "other", agent_scope_source: "explicit" });

  const injected = service.injectCandidates({ maxItems: 5, threshold: 3, scope: SCOPE_ME });
  const titles = injected.map((m) => m.title);
  // foreign ×0.5 = 2.0 < 自己 ×1.25 = 5.0：自己行第一；两条 foreign 同分，
  // 相对序随 store.list 的同分序（updated_at），不锁。
  assert.equal(titles[0], "mine-a");
  assert.deepEqual(titles.slice(1).sort(), ["foreign-a", "foreign-b"]);
});

test("injectCandidates soft tier keeps unlabeled rows ranked with matches, not suppressed", () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: false });
  store.save({ type: "decision", title: "global", content: "x", importance: 4 });
  store.save({ type: "decision", title: "foreign", content: "x", importance: 4, agent_scope: "other", agent_scope_source: "explicit" });

  const injected = service.injectCandidates({ maxItems: 5, threshold: 3, scope: SCOPE_ME });
  // 未标注 = 全局可见，与命中行同列（×1.25）而非被压到 foreign 之后。
  assert.deepEqual(injected.map((m) => m.title), ["global", "foreign"]);
});

test("injectCandidates order is byte-identical when scopeEnabled is off or scope is anonymous", () => {
  const seed = (store) => {
    store.save({ type: "decision", title: "foreign-a", content: "x", importance: 4, agent_scope: "other", agent_scope_source: "explicit" });
    store.save({ type: "decision", title: "mine-a", content: "x", importance: 4, agent_scope: "me", agent_scope_source: "explicit" });
    store.save({ type: "decision", title: "global", content: "x", importance: 3 });
  };
  // flag 关：不传 scope（改动前后必须同序——锁平价）。
  const off = setup({ scopeEnabled: false, strictScope: false });
  seed(off.store);
  // flag 开但身份两维全空：软加权门不激活，也不得改序。
  const anon = setup({ scopeEnabled: true, strictScope: false });
  seed(anon.store);

  // 平价锁：两种情况的注入序必须一致（比较器与改动前逐字节相同）。
  const baseline = off.service.injectCandidates({ maxItems: 5, threshold: 3 }).map((m) => m.title);
  assert.deepEqual(
    anon.service.injectCandidates({ maxItems: 5, threshold: 3, scope: { agent_scope: null, workspace_scope: null } }).map((m) => m.title),
    baseline
  );
});

test("strictScope hard filter runs before soft weighting: filtered rows are not double-demoted", () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: true });
  store.save({ type: "decision", title: "foreign", content: "x", importance: 4, agent_scope: "other", agent_scope_source: "explicit" });
  store.save({ type: "decision", title: "global", content: "x", importance: 3 });

  const injected = service.injectCandidates({ maxItems: 5, threshold: 3, scope: SCOPE_ME });
  // 硬墙先删 foreign；剩下的 global（未标注）吃 BOOST 保留——若软加权先跑会把
  // foreign 压到后面再被删，成员虽同但语义不同；此处锁成员与顺序。
  assert.deepEqual(injected.map((m) => m.title), ["global"]);
});

test("soft-weighted order feeds the pin pool (pin picks the weighted-first candidates)", () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: false, pinnedInjectBudget: 1 });
  // pin 池只收 constraint/preference——两条都用 preference，同档靠软加权分序。
  store.save({ type: "preference", title: "foreign-pin", content: "x", importance: 4, agent_scope: "other", agent_scope_source: "explicit" });
  store.save({ type: "preference", title: "mine", content: "x", importance: 4, agent_scope: "me", agent_scope_source: "explicit" });

  const pinnedStats = {};
  const injected = service.injectCandidates({
    maxItems: 5, threshold: 3, scope: SCOPE_ME, pinnedStats,
  });
  // 加权后 mine 在前：pin 池取的是加权后次序的第一条。
  assert.equal(pinnedStats.shown, 1);
  assert.equal(injected[0].title, "mine");
});
