import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { Config } from "../src/config.js";
import { createSettings } from "../src/settings.js";
import { createDreamScheduler, validateDecisions } from "../src/dream.js";
import { mockCtx } from "./helpers/dream-mock.js";

// 回归（#135 成本审计派生）：merge 决策的单轮数量闸 dreamMaxMergePerRun。
//
// 为什么需要这道闸：merge 是巩固里唯一**回吐正文**的动作——每条 merge 都要求模型
// 重新写出合并后的 content（实测 2113 条 merge 平均 550 字符/条），而 keep /
// archive / conflict 都不带正文。单轮 merge 数因此是「输出里正文占比」唯一可控的
// 杠杆。此前 update(2) / create(5) / archive(8) 都有上限，唯独 merge 没有。
//
// 闸门形态与现有三道**完全一致**：全局信号，skipInvalid 也不豁免，超限整单拒绝。
// 这一点是本文件的锁点之一——若有人把 merge 闸改成「逐条跳过」，就与另外三道闸
// 的语义分叉了，而超限（模型一轮要合并几十条）恰恰是整体失控信号，必须整单拒绝。
//
// 默认值 40 的校准依据（只读探针：全库 246 轮 / 近 10 天 88 轮 dream_runs.decisions）：
//   每轮 merge 数  全库 p50 7 / p90 15 / p99 28 / max 39
//                  近 10 天 p50 9 / p90 20 / p99 39 / max 39
// 取 40 = 观测分布上沿（历史命中 0/246），与 archive 闸默认 8 恰为其 p90=max 同
// 一校准法：面向未来的尾险护栏，不是成本削减工具。刻意保守的理由是代价不对称：
// 整单拒绝 = run 记 failed = 调度器不刷新 baseline（src/dream.js:905-915）=
// 下一次写入用同一批输入重跑，一次误伤约等于该轮成本 ×2。
//
// 相关但**不是**本闸目标的实测事实（防后人误用本闸去省 token）：dream_consolidate
// 的输出 token 里只有约 11.8% 是决策正文，其余是推理与 JSON 骨架，那部分由
// dreamReasoningEffort / 模型选择决定，调 merge 上限影响不到。

function snap(entries) {
  return new Map(
    entries.map(([id, type]) => [
      id,
      { id, type, title: `t-${id}`, content: `c-${id}`, importance: 3, archived: false, forgotten: false }
    ])
  );
}

/** 造 n 条互不相干的普通类型记忆，配对成 merge（每条 merge 需要 title+content）。 */
function mergeDecisions(n) {
  const entries = Array.from({ length: n * 2 }, (_, i) => [`m${i}`, "project"]);
  const decisions = [];
  for (let i = 0; i < n; i += 1) {
    decisions.push({
      action: "merge",
      ids: [`m${2 * i}`, `m${2 * i + 1}`],
      title: `merged-${i}`,
      content: `合并后的正文 ${i}`,
      keepSource: `m${2 * i}`
    });
  }
  return { entries, decisions };
}

// ---------------------------------------------------------- 数量闸（纯函数）

test("#135-cost: merge count above the cap rejects the whole batch (global gate)", () => {
  const { entries, decisions } = mergeDecisions(41);
  const s = snap(entries);
  const { ok, errors } = validateDecisions(decisions, s, { skipInvalid: true });
  assert.equal(ok, false, "41 merges > default cap 40 → reject even under skipInvalid");
  assert.ok(
    errors.some((e) => e.includes("too many merge decisions")),
    `cap error present, got: ${errors.join("; ")}`
  );
});

test("#135-cost: merge count at the cap passes (boundary is inclusive)", () => {
  const { entries, decisions } = mergeDecisions(40);
  const s = snap(entries);
  const { ok, errors } = validateDecisions(decisions, s, { skipInvalid: true });
  assert.equal(ok, true, `exactly 40 merges is allowed, got: ${errors.join("; ")}`);
});

test("#135-cost: merge cap is configurable and defaults to the observed upper bound (40)", () => {
  const { entries, decisions } = mergeDecisions(41);
  const s = snap(entries);
  // 默认值本身是本次改动的契约：实测分布上沿 39 → 闸门取 40。
  const raised = validateDecisions(structuredClone(decisions), s, { skipInvalid: true, maxMergePerRun: 60 });
  assert.equal(raised.ok, true, `raised cap lets the batch through, got: ${raised.errors.join("; ")}`);
  const lowered = validateDecisions(structuredClone(decisions), s, { skipInvalid: true, maxMergePerRun: 20 });
  assert.equal(lowered.ok, false, "lowered cap catches the same batch");
});

test("#135-cost: merge cap does not fire on ordinary runs (calibrated to the tail, not the median)", () => {
  // p90 = 15、p99 = 28：常态与「偏大但正常」的轮都不该被拦。若有人把默认值调到
  // p90 附近（用覆盖换成本），这条用例会红——这是刻意的：默认值必须落在尾险区。
  for (const n of [7, 15, 28, 39]) {
    const { entries, decisions } = mergeDecisions(n);
    const { ok, errors } = validateDecisions(decisions, snap(entries), { skipInvalid: true });
    assert.equal(ok, true, `${n} merges (within observed distribution) must pass, got: ${errors.join("; ")}`);
  }
});

test("#135-cost: merge cap is independent of the other three caps", () => {
  // 31 条 merge + 1 条 update + 1 条 archive：三道老闸都在限内，只有 merge 超限时
  // 才应该报 merge 的错——确认新闸不是被别的计数顺带触发的。
  const { entries, decisions } = mergeDecisions(41);
  const s = snap([...entries, ["u1", "project"], ["a1", "decision"]]);
  const all = [
    ...decisions,
    { action: "update", ids: ["u1"], changes: { title: "改标题" } },
    { action: "archive", ids: ["a1"], reason: "重复或过时" }
  ];
  const { ok, errors } = validateDecisions(all, s, { skipInvalid: true });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("too many merge decisions")));
  assert.equal(errors.some((e) => e.includes("too many update decisions")), false, "update cap must not fire");
  assert.equal(errors.some((e) => e.includes("too many archive decisions")), false, "archive cap must not fire");
});

// ---------------------------------------------------------- 配置面（schema + 白名单成对）

test("#135-cost: dreamMaxMergePerRun defaults to 40 and clamps to [1, 200]", () => {
  assert.equal(Config({}).dreamMaxMergePerRun, 40, "default = observed upper bound of merge-per-run distribution");
  assert.equal(Config({ dreamMaxMergePerRun: 1 }).dreamMaxMergePerRun, 1, "lower bound accepted");
  assert.equal(Config({ dreamMaxMergePerRun: 200 }).dreamMaxMergePerRun, 200, "upper bound accepted");
  assert.throws(() => Config({ dreamMaxMergePerRun: 0 }), "zero rejected");
  assert.throws(() => Config({ dreamMaxMergePerRun: 201 }), "above max rejected");
});

test("#135-cost: dreamMaxMergePerRun is in the settings whitelist with the same bounds as the schema", () => {
  // 新配置键必须 config.js schema 与 settings.js 白名单成对出现（AGENTS.md 自查清单 2）。
  // 走公开的 setFeatureFlags 路径：validateFlag 是 settings.js 的模块内私有函数，
  // 而「键不在白名单 → 静默丢弃、不报错」正是这条用例要防的失败模式。
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  assert.deepEqual(settings.getFeatureFlags(), {}, "nothing stored initially");
  assert.equal(settings.setFeatureFlags({ dreamMaxMergePerRun: 40 }).dreamMaxMergePerRun, 40, "whitelisted");
  assert.equal(settings.getFeatureFlags().dreamMaxMergePerRun, 40, "persisted and re-read");
  assert.throws(
    () => settings.setFeatureFlags({ dreamMaxMergePerRun: 0 }),
    /must be an integer in \[1, 200\]/
  );
  assert.throws(
    () => settings.setFeatureFlags({ dreamMaxMergePerRun: 201 }),
    /must be an integer in \[1, 200\]/
  );
  assert.throws(() => settings.setFeatureFlags({ dreamMaxMergePerRun: 1.5 }), /must be an integer/);
  // 越界被拒后不得留下脏值。
  assert.equal(settings.getFeatureFlags().dreamMaxMergePerRun, 40, "rejected write did not corrupt the stored value");
  store.close();
});

// ---------------------------------------------------------- 端到端（runDream）

test("#135-cost: runDream rejects a runaway merge batch and leaves the memories untouched", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  // 84 条普通记忆 → 42 对 merge，超过默认闸 40。
  for (let i = 0; i < 84; i += 1) {
    service.saveWithDedupe({ type: "project", title: `记忆 ${i}`, content: `正文 ${i}`, importance: 3 });
  }
  const ctx = mockCtx({
    onConsolidation: (listText) => {
      const ids = [...listText.matchAll(/id=([^\s|]+)/g)].map((m) => m[1]);
      const decisions = [];
      for (let i = 0; i + 1 < ids.length; i += 2) {
        decisions.push({
          action: "merge",
          ids: [ids[i], ids[i + 1]],
          title: `合并 ${i}`,
          content: `合并后的正文 ${i}`,
          keepSource: ids[i]
        });
      }
      return JSON.stringify(decisions);
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.ok, false, "42 merges > cap 40 → run fails as a whole");
  assert.match(result.error, /invalid decisions/);
  // 整单拒绝 = 一条都没落：merge 不得半途生效（这正是「全局闸门」与「逐条跳过」的区别）。
  // 注意 service.all() 含已归档行，所以必须数「未归档」的条数：merge 生效会把 source
  // 置 archived，84 条里若有任何一条落了，未归档数就会掉下来。
  assert.equal(service.all().filter((m) => !m.archived).length, 84, "no memory was merged away");
  const audit = store.listDreamRuns().at(-1);
  assert.equal(audit.status, "failed");
  // decisions 是 store 层已 JSON.parse 的列，序列化后查错误串（_validationFailed 哨兵）。
  assert.match(JSON.stringify(audit.decisions), /too many merge decisions/);
  store.close();
});

test("#135-cost: runDream lands a merge batch below the cap", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  for (let i = 0; i < 20; i += 1) {
    service.saveWithDedupe({ type: "project", title: `记忆 ${i}`, content: `正文 ${i}`, importance: 3 });
  }
  const ctx = mockCtx({
    onConsolidation: (listText) => {
      const ids = [...listText.matchAll(/id=([^\s|]+)/g)].map((m) => m[1]);
      const decisions = [];
      for (let i = 0; i + 1 < ids.length; i += 2) {
        decisions.push({
          action: "merge",
          ids: [ids[i], ids[i + 1]],
          title: `合并 ${i}`,
          content: `合并后的正文 ${i}`,
          keepSource: ids[i]
        });
      }
      return JSON.stringify(decisions);
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.status, "ok", `10 merges must pass, got: ${result.error ?? ""}`);
  // 10 对 merge → 10 个 keeper 留下，其余 10 条被归档；再加上本轮落库的 summary
  // 记忆（未归档），未归档数应为 11。这条断言同时证明「闸门放行」与「merge 真的
  // 生效了」——只断言 notEqual(failed) 会被「什么都没做」蒙混过去。
  assert.equal(service.all().filter((m) => !m.archived).length, 11, "10 keepers + 1 summary survived");
  assert.equal(result.applied, 10, "all 10 merges committed");
  store.close();
});
