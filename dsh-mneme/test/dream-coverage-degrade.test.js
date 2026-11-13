import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler, validateDecisions } from "../src/dream.js";
import { mockCtx } from "./helpers/dream-mock.js";
import { testConfig } from "./helpers/test-config.js";

// 回归（issue #104 方向 1）：dreamMinExplicitCoverage 覆盖率护栏误伤「挑重点」
// 型输出。提示词明文要求「无问题的条目无需输出」（lang.js 硬性规则），模型
// 只显式决策少数条目是提示词要求的行为；但护栏把显式覆盖率 < 下限判成
// 「截断 → 隐式 keep 洗白」整单拒绝——heptaspirit 实测官方路由 + 强模型也
// 天天命中（81 轮 failed 全是 coverage，applied=0，LLM 调用本身已成功）。
// 修复：coverage 不足降级为 degraded（合法子集照常应用 + 未提及条目隐式
// keep），降级理由落库 outcome.degradations；护栏以状态暴露而非一票否决。
// 明确异常信号（create 上限等）保持整单拒绝不变；dreamImplicitKeep=false 的
// 严格模式不受影响。

function snapshot(ids, type = "project") {
  return new Map(ids.map((id, i) => [id, { id, type, title: `t${i}`, content: `c${i}`, importance: 3, archived: false, forgotten: false }]));
}

// ---------------------------------------------------------- validateDecisions

test("#104-1: coverage shortfall degrades — ok:true + reason surfaced, implicit keeps fill", () => {
  const snap = snapshot(["a", "b", "c", "d"]);
  const decisions = [{ action: "update", ids: ["a"], title: "t-new", content: "c-new" }];
  const { ok, errors, coverageShortfall } = validateDecisions(decisions, snap, {
    dreamImplicitKeep: true,
    dreamMinExplicitCoverage: 0.5,
    skipInvalid: true
  });
  assert.equal(ok, true, "valid subset is applied instead of whole-order rejection");
  assert.deepEqual(errors, [], "coverage shortfall is not a per-decision error");
  assert.match(String(coverageShortfall), /coverage/, "degradation reason surfaced for audit");
  assert.equal(decisions.length, 4, "unclaimed ids filled with implicit keeps");
});

test("#104-1: sufficient coverage carries no shortfall marker", () => {
  const snap = snapshot(["a", "b"]);
  const decisions = [{ action: "archive", ids: ["a"], reason: "stale" }, { action: "keep", ids: ["b"] }];
  const { ok, coverageShortfall } = validateDecisions(decisions, snap, {
    dreamImplicitKeep: true,
    dreamMinExplicitCoverage: 0.5
  });
  assert.equal(ok, true);
  assert.equal(coverageShortfall ?? null, null);
});

test("#104-1: strict mode (implicitKeep=false) unchanged — missing ids still reject", () => {
  const snap = snapshot(["a", "b"]);
  const decisions = [{ action: "keep", ids: ["a"] }];
  const { ok } = validateDecisions(decisions, snap, { dreamImplicitKeep: false });
  assert.equal(ok, false, "strict mode keeps whole-order rejection");
});

// ---------------------------------------------------------- runDream 端到端

test("#104-1: runDream records degraded (not failed) with the coverage reason in the run row", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  for (let i = 0; i < 20; i++) {
    service.saveWithDedupe({ type: "project", title: `主题${i}`, content: `内容${i}`, importance: 3 });
  }
  // 只显式决策 1/20 = 5%（< 默认下限 50%）——提示词要求的「挑重点」形态
  const ctx = mockCtx({
    onConsolidation: (listText) => {
      const ids = [...listText.matchAll(/id=([^\s|]+)\s*\|\s*type=(\w+)/g)].map((m) => m[1]);
      return JSON.stringify([{ action: "archive", ids: [ids[0]], reason: "stale variant" }]);
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek",
    dreamModel: "deepseek-chat",
    dreamMinExplicitCoverage: 0.5
  });
  assert.equal(result.status, "degraded", "coverage shortfall degrades the run, not rejects it");
  assert.equal(result.ok, true, "valid subset absorbed — scheduler baseline advances");
  assert.ok(result.applied >= 1, "the explicit decision was applied");

  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "degraded");
  const degradations = run.outcome?.degradations ?? [];
  assert.ok(degradations.some((s) => String(s).includes("coverage")), "coverage reason persisted in outcome.degradations");
  store.close();
});
