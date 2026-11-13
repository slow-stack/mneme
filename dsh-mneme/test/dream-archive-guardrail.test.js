import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler, validateDecisions } from "../src/dream.js";
import { mockCtx } from "./helpers/dream-mock.js";
import { testConfig } from "./helpers/test-config.js";

// 回归（issue #104 方向 2）：archive 决策语义越界 + 批量大扫除。
// 实测事故：一轮 12 条互不相关主题被批量 archive，LLM 自述理由是「价值判断」
// （对核心知识库长期参考价值较低、保持整洁和高信噪比），而提示词对 archive 的
// 定义是「重复或过时」；12 条中 8 条疑似误伤，含 rejected_solution ×2、
// constraint ×3、pitfall ×1 等长保留类型——这些类型的存在意义即长期保存，
// 误归档损失最大。修复：
//   1. 类型护栏——长保留类型（preference / pattern / rejected_solution /
//      constraint / pitfall）的 archive 必须命中「重复/过时」类理由，否则单条
//      跳过记 skipped（run 记 degraded），绝不整单拒绝；
//   2. 批量上限——单轮 archive 条数封顶（dreamMaxArchivePerRun，默认 8），
//      与 update 上限同类的全局闸门：skipInvalid 也不豁免，超限整单拒绝；
//   3. 提示词同步强化（辅助防线）。
// conflict 裁决的败者归档不经过 archive action，不受护栏影响。

function snap(entries) {
  return new Map(entries.map(([id, type]) => [id, { id, type, title: `t-${id}`, content: `c-${id}`, importance: 3, archived: false, forgotten: false }]));
}

// ---------------------------------------------------------- 类型护栏（纯函数）

test("#104-2: long-retention archive with a duplicate/outdated rationale passes", () => {
  const s = snap([["p1", "preference"], ["rs1", "rejected_solution"]]);
  const decisions = [
    { action: "archive", ids: ["p1"], reason: "与后续偏好重复，已被新条目取代" },
    { action: "archive", ids: ["rs1"], reason: "duplicate of an earlier rejected approach (stale)" }
  ];
  const { ok, skipped } = validateDecisions(decisions, s, { skipInvalid: true });
  assert.equal(ok, true);
  assert.deepEqual(skipped, [], "duplicate/outdated rationales are accepted");
});

test("#104-2: long-retention archive with a value-judgment rationale is skipped (run degrades)", () => {
  const s = snap([["c1", "constraint"], ["k1", "project"]]);
  const decisions = [
    { action: "archive", ids: ["c1"], reason: "多为一次性调试细节，对核心知识库长期参考价值较低，保持整洁和高信噪比" },
    { action: "archive", ids: ["k1"], reason: "价值较低" }
  ];
  const { ok, skipped } = validateDecisions(decisions, s, { skipInvalid: true });
  assert.equal(ok, true, "guard skips the single decision instead of rejecting the run");
  assert.equal(skipped.length, 1, "only the guarded long-retention archive is skipped");
  assert.match(skipped[0].error, /long-retention type\(s\) constraint/);
  assert.match(skipped[0].error, /duplicate\/outdated rationale/);
  // 幸存列表：普通类型照常归档，c1 被跳过后由隐式 keep 补位
  assert.deepEqual(decisions.map((d) => d.action), ["archive", "keep"]);
});

test("#104-2: plain-type archive needs no rationale keywords (guard boundary)", () => {
  const s = snap([["d1", "decision"], ["f1", "factor"]]);
  const decisions = [
    { action: "archive", ids: ["d1"], reason: "阶段性结论，已沉淀进项目记忆" },
    { action: "archive", ids: ["f1"], reason: "清理" }
  ];
  const { ok, skipped } = validateDecisions(decisions, s, { skipInvalid: true });
  assert.equal(ok, true);
  assert.deepEqual(skipped, [], "guard applies to long-retention types only");
});

test("#104-2: conflict-loser archive is exempt (adjudication, not archive action)", () => {
  const s = snap([["w", "preference"], ["l", "preference"]]);
  const decisions = [{ action: "conflict", winner: "w", loser: "l", reason: "内容矛盾，保留更新的信息" }];
  const { ok, skipped } = validateDecisions(decisions, s, { skipInvalid: true });
  assert.equal(ok, true);
  assert.deepEqual(skipped, [], "conflict adjudication does not go through the archive guard");
});

// ---------------------------------------------------------- 批量上限（纯函数）

test("#104-2: archive count above the cap rejects the whole batch (global gate)", () => {
  const entries = Array.from({ length: 10 }, (_, i) => [`d${i}`, "decision"]);
  const s = snap(entries);
  const decisions = entries.map(([id]) => ({ action: "archive", ids: [id], reason: "stale" }));
  const { ok, errors } = validateDecisions(decisions, s, { skipInvalid: true });
  assert.equal(ok, false, "9 archives > default cap 8 → reject even under skipInvalid");
  assert.ok(errors.some((e) => e.includes("too many archive decisions")), `cap error present, got: ${errors.join("; ")}`);
});

test("#104-2: archive cap is configurable", () => {
  const entries = Array.from({ length: 10 }, (_, i) => [`d${i}`, "decision"]);
  const s = snap(entries);
  const decisions = entries.map(([id]) => ({ action: "archive", ids: [id], reason: "stale" }));
  const { ok, errors } = validateDecisions(decisions, s, { skipInvalid: true, maxArchivePerRun: 20 });
  assert.equal(ok, true, `raised cap lets the sweep through, got: ${errors.join("; ")}`);
});

// ---------------------------------------------------------- 端到端（runDream）

test("#104-2: runDream skips a value-judgment archive of a long-retention type and lands the rest", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  service.saveWithDedupe({ type: "project", title: "旧项目", content: "已完结并被取代", importance: 3 });
  service.saveWithDedupe({ type: "constraint", title: "接口约束", content: "v1 接口只能串行调用", importance: 3 });
  const ctx = mockCtx({
    onConsolidation: (listText) => {
      const entries = [...listText.matchAll(/id=([^\s|]+)\s*\|\s*type=(\w+)/g)].map((m) => ({ id: m[1], type: m[2] }));
      const projectId = entries.find((e) => e.type === "project").id;
      const constraintId = entries.find((e) => e.type === "constraint").id;
      return JSON.stringify([
        { action: "archive", ids: [projectId], reason: "重复或过时" },
        { action: "archive", ids: [constraintId], reason: "保持知识库整洁，参考价值较低" }
      ]);
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.notEqual(result.status, "failed", "guard skips instead of failing the run");
  const constraint = service.all().find((m) => m.type === "constraint");
  assert.equal(constraint.archived, false, "value-judgment archive of a long-retention type must not land");
  store.close();
});
