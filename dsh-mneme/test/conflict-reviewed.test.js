import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";

// Issue #529（B 项）：冲突裁决台账（conflict_reviewed）的存储层契约。
//
// 为什么单开一张表而不是复用 conflict_pending：后者是**人工**队列——面板徽标数
// 就是 countConflictPending()（resolved_at IS NULL 的行数），机器每判一对就写一行
// 会把那个数字淹掉，人再也看不出"有哪些待我裁决"。台账是机器记账，零用户界面。
//
// 这些用例锁三件事，防的回归是：
//   ① pair 键不归一化 → 同一对（A,B）与（B,A）会记成两行，下一轮照样重送；
//   ② 重复记账不是幂等 upsert → 同一对判过 N 次就堆 N 行，表无界增长；
//   ③ 记账误落 conflict_pending → 人工队列被机器行淹没（这是最贵的一种）。

test("issue#529 conflict_reviewed：写入后可读回，键归一化为 (a,b)", () => {
  const store = createStore(":memory:");
  store.saveConflictReviewed({
    run_id: "run-1",
    memory_a: "b-id",
    memory_b: "a-id",
    outcome: "conflict",
    judged_at: "2026-10-31T00:00:00.000Z"
  });
  const all = store.loadConflictReviewed();
  assert.equal(all.size, 1, "只落一行");
  const key = [...all.keys()][0];
  assert.equal(key, "a-id\u0000b-id", "键按字典序归一化——反着传也是同一个键");
  const row = all.get(key);
  assert.equal(row.outcome, "conflict");
  assert.equal(row.run_id, "run-1");
  assert.equal(row.judged_at, "2026-10-31T00:00:00.000Z");
  store.close();
});

test("issue#529 conflict_reviewed：同一对重复记账是 upsert，不堆行", () => {
  const store = createStore(":memory:");
  for (let i = 0; i < 3; i++) {
    store.saveConflictReviewed({
      run_id: "run-" + i,
      memory_a: "a-id",
      memory_b: "b-id",
      outcome: "keep",
      judged_at: "2026-10-31T00:00:0" + i + ".000Z"
    });
  }
  const all = store.loadConflictReviewed();
  assert.equal(all.size, 1, "同一对只留一行");
  assert.equal(all.get("a-id\u0000b-id").run_id, "run-2", "后写的覆盖先写的");
  assert.equal(all.get("a-id\u0000b-id").judged_at, "2026-10-31T00:00:02.000Z");
  store.close();
});

test("issue#529 conflict_reviewed：记账不进人工待裁决队列", () => {
  const store = createStore(":memory:");
  for (let i = 0; i < 5; i++) {
    store.saveConflictReviewed({
      run_id: "run-" + i,
      memory_a: "a-" + i,
      memory_b: "b-" + i,
      outcome: "keep",
      judged_at: "2026-10-31T00:00:00.000Z"
    });
  }
  assert.equal(store.countConflictPending(), 0, "关键：机器记账不涨人工队列的徽标数");
  assert.deepEqual(store.listConflictPending(), []);
  assert.equal(store.listConflictReviewed().length, 5, "但台账里确实有 5 行");
  store.close();
});

test("issue#529 conflict_reviewed：listConflictReviewed 按判时倒序", () => {
  const store = createStore(":memory:");
  store.saveConflictReviewed({ memory_a: "a", memory_b: "b", outcome: "keep", judged_at: "2026-10-30T00:00:00.000Z", run_id: "r1" });
  store.saveConflictReviewed({ memory_a: "c", memory_b: "d", outcome: "conflict", judged_at: "2026-10-31T00:00:00.000Z", run_id: "r2" });
  const rows = store.listConflictReviewed();
  assert.equal(rows[0].judged_at, "2026-10-31T00:00:00.000Z", "最新的在前");
  assert.equal(rows[1].judged_at, "2026-10-30T00:00:00.000Z");
  store.close();
});
