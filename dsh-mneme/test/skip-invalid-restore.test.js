// --- Issue #89 恢复功能的全量单测（v0.7.22）----------------------------------
// v0.7.22 把 v0.6.9（Issue #26）的 skipInvalid 宽容校验路径原样搬回。核心行为
// 契约：单条非法决策只跳过该条（记入 skipped、不 claim 任何 id），合法子集照常
// 应用、run 记 degraded；但全局信号（update/create 上限、显式覆盖率下限）不受
// 该开关影响、始终整单拒绝。以下测试逐条锁死恢复后的分支：非法动作按原因分类
// 跳过（create/unknown/archived/summary/重复 claim/merge 参数/update 参数/
// conflict 参数）、skipInvalid 与覆盖率下限/上限/allowCrossTypeMerge 的交互，
// 以及 runDream 层"全非法仍 failed / 部分非法 degraded 如实进审计"。
import test from "node:test";
import assert from "node:assert/strict";
import { validateDecisions, createDreamScheduler, parseReceipt } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { mockCtx } from "./helpers/dream-mock.js";
import { testConfig } from "./helpers/test-config.js";

function dreamSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  return { store, service };
}

// 合法记忆快照工厂：id 首字母作 type 前缀（p=preference / 其余 project），
// created_at 默认 2020 年（保证 update 保护期检查放行）。
function makeSnap(ids) {
  return new Map(ids.map((id) => [
    id,
    {
      id,
      type: id.startsWith("p") ? "preference" : "project",
      title: `标题${id}`,
      content: `内容${id}`,
      importance: 3,
      archived: false,
      forgotten: false,
      created_at: "2020-01-01T00:00:00.000Z"
    }
  ]));
}

// ------------------------------------------------------------- 按原因逐条跳过

test("validateDecisions skipInvalid: create with empty title is skipped; strict mode rejects it", () => {
  const emptySnap = new Map(); // create 不 claim id：空快照下覆盖率恒 1
  const decisions = [
    { action: "create", title: "", content: "body", type: "pattern" },
    { action: "create", title: "ok", content: "c", type: "pattern" }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, emptySnap, { skipInvalid: true });
  assert.equal(ok, true, `valid create should survive, got: ${errors.join("; ")}`);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].error, /create needs non-empty title/);
  assert.deepEqual(decisions.map((d) => d.action), ["create"], "empty-title create spliced out");
  assert.deepEqual(decisions[0].title, "ok");

  const strict = validateDecisions([{ action: "create", title: "", content: "b", type: "pattern" }], emptySnap);
  assert.equal(strict.ok, false, "strict mode hard-rejects a bad create");
  assert.ok(strict.errors.some((e) => e.includes("create needs non-empty title")));
});

test("validateDecisions skipInvalid: unknown id, archived, and summary targets are skipped, valid siblings survive", () => {
  const snap = new Map([
    ...makeSnap(["b", "c"]),
    ["arch", { id: "arch", type: "project", title: "旧arch", content: "x", importance: 3, archived: true, forgotten: false, created_at: "2020-01-01T00:00:00.000Z" }],
    ["s", { id: "s", type: "summary", title: "总览", content: "y", importance: 3, archived: false, forgotten: false, created_at: "2020-01-01T00:00:00.000Z" }]
  ]);
  const decisions = [
    { action: "archive", ids: ["zzz"], reason: "gone" },
    { action: "archive", ids: ["arch"], reason: "stale" },
    { action: "archive", ids: ["s"], reason: "stale" },
    { action: "archive", ids: ["b"], reason: "stale" },
    { action: "archive", ids: ["c"], reason: "stale" }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, snap, { skipInvalid: true });
  assert.equal(ok, true, `valid archives should survive, got: ${errors.join("; ")}`);
  assert.equal(skipped.length, 3);
  assert.match(skipped[0].error, /unknown id/);
  assert.match(skipped[1].error, /archived or summary/);
  assert.match(skipped[2].error, /archived or summary/);
  // claimed = {b,c} = 2/4 = 50% 恰好过下限；arch/s 未 claim → 隐式 keep
  assert.deepEqual(decisions.map((d) => d.action), ["archive", "archive", "keep", "keep"]);
  assert.deepEqual(decisions[0].ids, ["b"]);
});

test("validateDecisions skipInvalid: a later decision re-claiming an already-claimed id is skipped, first survives", () => {
  const snap = makeSnap(["a", "b", "c"]);
  const decisions = [
    { action: "merge", ids: ["a", "b"], keepSource: "a", title: "合并", content: "m", importance: 4 },
    { action: "merge", ids: ["b", "c"], keepSource: "b", title: "合并2", content: "m2", importance: 4 }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, snap, { skipInvalid: true });
  assert.equal(ok, true, `first merge should survive, got: ${errors.join("; ")}`);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].index, 1);
  assert.match(skipped[0].error, /claimed by multiple/);
  // claimed = {a,b} = 2/3 = 67% 过下限；c 隐式 keep，绝不因重复 claim 双 keep
  assert.deepEqual(decisions.map((d) => d.action), ["merge", "keep"]);
  assert.deepEqual(decisions[0].ids, ["a", "b"]);
});

test("validateDecisions skipInvalid: merge with keepSource outside ids is skipped", () => {
  const snap = makeSnap(["a", "b"]);
  const decisions = [
    { action: "merge", ids: ["a", "b"], keepSource: "zzz", title: "t", content: "c", importance: 4 },
    { action: "archive", ids: ["a"], reason: "stale" }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, snap, { skipInvalid: true });
  assert.equal(ok, true, `valid archive should survive, got: ${errors.join("; ")}`);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].error, /keepSource must be one of ids/);
  assert.deepEqual(decisions.map((d) => d.action), ["archive", "keep"]);
});

test("validateDecisions skipInvalid: update targeting multiple ids / no change / summary / too-young memory is skipped", () => {
  const now = Date.now();
  const snap = new Map([
    ...makeSnap(["a", "b"]),
    ["s", { id: "s", type: "summary", title: "总览", content: "y", importance: 3, archived: false, forgotten: false, created_at: "2020-01-01T00:00:00.000Z" }],
    ["y", { id: "y", type: "project", title: "Y", content: "新Y", importance: 3, archived: false, forgotten: false, created_at: new Date(now).toISOString() }]
  ]);
  const decisions = [
    { action: "update", ids: ["a", "b"], content: "x" },
    { action: "update", ids: ["a"], content: "内容a" },
    { action: "update", ids: ["s"], content: "x" },
    { action: "update", ids: ["y"], content: "x" },
    { action: "update", ids: ["a"], content: "新A" },
    { action: "update", ids: ["b"], content: "新B" }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, snap, { skipInvalid: true });
  assert.equal(ok, true, `valid updates should survive, got: ${errors.join("; ")}`);
  assert.equal(skipped.length, 4);
  assert.match(skipped[0].error, /exactly one id/);
  assert.match(skipped[1].error, /change at least one field/);
  assert.match(skipped[2].error, /cannot update summary/);
  assert.match(skipped[3].error, /too young/);
  // claimed = {a,b} = 2/4 = 50% 过下限；s/y 隐式 keep
  assert.deepEqual(decisions.map((d) => d.action), ["update", "update", "keep", "keep"]);
});

test("validateDecisions skipInvalid: conflict without a distinct winner/loser is skipped", () => {
  const snap = makeSnap(["w", "l", "c"]);
  const decisions = [
    { action: "conflict", winner: "w", loser: "l" },
    { action: "conflict", loser: "c" }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, snap, { skipInvalid: true });
  assert.equal(ok, true, `valid conflict should survive, got: ${errors.join("; ")}`);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].error, /conflict needs distinct winner and loser/);
  assert.deepEqual(decisions.map((d) => d.action), ["conflict", "keep"]);
});

// ------------------------------------------------------- skipInvalid 与全局闸门

test("validateDecisions skipInvalid: valid subset below the coverage floor degrades (Issue #104 方向 1)", () => {
  const snap = makeSnap(["p", "j", "x"]);
  const decisions = [
    { action: "archive", ids: ["p"], reason: "stale" },
    { action: "merge", ids: ["p", "j"], keepSource: "p", title: "跨类型", content: "m", importance: 4 }
  ];
  const { ok, errors, skipped, coverageShortfall } = validateDecisions(decisions, snap, { skipInvalid: true });
  assert.equal(ok, true, "valid subset applies — shortfall degrades instead of rejecting");
  assert.deepEqual(errors, []);
  assert.equal(skipped.length, 1);
  assert.match(String(coverageShortfall), /coverage/, "shortfall reason surfaced for audit");
  // claimed {p} = 1/3 = 33% < 50%；j/x 隐式 keep 补齐
  assert.deepEqual(decisions.map((d) => d.action), ["archive", "keep", "keep"]);
});

test("validateDecisions skipInvalid: updates skipped for other reasons do not count toward the update cap", () => {
  const snap = makeSnap(["a", "b", "c", "d"]);
  const decisions = [
    { action: "update", ids: ["a"], content: "内容a" },
    { action: "update", ids: ["b"], content: "内容b" },
    { action: "update", ids: ["c"], content: "新C" },
    { action: "archive", ids: ["d"], reason: "stale" }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, snap, { skipInvalid: true, maxUpdatePerRun: 2 });
  assert.equal(ok, true, `cap counts survivors only, got: ${errors.join("; ")}`);
  assert.equal(skipped.length, 2);
  // 3 条 update 输入 → 2 条跳过 → 幸存 1 条 ≤ cap 2；claimed {c,d} = 2/4 = 50%
  assert.deepEqual(decisions.map((d) => d.action), ["update", "archive", "keep", "keep"]);
});

test("validateDecisions skipInvalid: creates skipped for other reasons do not count toward the create cap", () => {
  const emptySnap = new Map();
  const decisions = [];
  for (let i = 0; i < 5; i++) decisions.push({ action: "create", title: `t${i}`, content: "c", type: "pattern" });
  decisions.push({ action: "create", title: "", content: "x", type: "pattern" });
  const { ok, errors, skipped } = validateDecisions(decisions, emptySnap, { skipInvalid: true, maxCreatePerRun: 5 });
  assert.equal(ok, true, `cap counts survivors only, got: ${errors.join("; ")}`);
  assert.equal(skipped.length, 1);
  assert.equal(decisions.length, 5, "only the 5 valid creates survive the cap");
});

test("validateDecisions skipInvalid + allowCrossTypeMerge compose: cross-type merge allowed, unrelated invalid entry still skipped", () => {
  const snap = makeSnap(["p", "j", "b", "c"]);
  const decisions = [
    { action: "merge", ids: ["p", "j"], keepSource: "p", title: "合并", content: "m", importance: 4 },
    { action: "archive", ids: ["zzz"], reason: "gone" }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, snap, { skipInvalid: true, allowCrossTypeMerge: true });
  assert.equal(ok, true, `flag-enabled merge survives, got: ${errors.join("; ")}`);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].error, /unknown id/);
  assert.deepEqual(decisions.map((d) => d.action), ["merge", "keep", "keep"]);
});

// ----------------------------------------------------------- runDream 层 e2e

test("issue#89: with default skipInvalid on, an all-invalid batch still fails the run (nothing valid survives)", async () => {
  const { store, service } = dreamSetup();
  const a = service.saveWithDedupe({ type: "project", title: "旧A", content: "过时A" }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "旧B", content: "过时B" }).memory;
  const pref = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" }).memory;
  const pref2 = service.saveWithDedupe({ type: "preference", title: "语气", content: "轻松" }).memory;
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [pref.id, a.id], keepSource: pref.id, title: "跨类型", content: "x", importance: 4 },
      { action: "merge", ids: [pref2.id, b.id], keepSource: pref2.id, title: "跨类型2", content: "y", importance: 4 }
    ])
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model" });
  assert.equal(result.ok, false, "all invalid → whole batch rejected, not silently kept");
  assert.match(result.error, /invalid decisions/);
  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "failed", "audit row marks failed, not degraded (nothing valid landed)");
  assert.equal(parseReceipt(run.receipt).status, "failed", "receipt marks failed");
  assert.equal(store.getById(a.id).archived, false, "nothing applied");
  assert.equal(store.getById(b.id).archived, false, "nothing applied");
  store.close();
});

test("issue#89: a partial-invalid run is marked degraded in the audit row and receipt", async () => {
  const { store, service } = dreamSetup();
  const a = service.saveWithDedupe({ type: "project", title: "旧A", content: "过时A" }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "旧B", content: "过时B" }).memory;
  const pref = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" }).memory;
  const c = service.saveWithDedupe({ type: "project", title: "旧C", content: "过时C" }).memory;
  const warnings = [];
  const ctx = {
    ...mockCtx({
      onConsolidation: () => JSON.stringify([
        { action: "merge", ids: [pref.id, a.id], keepSource: pref.id, title: "跨类型", content: "x", importance: 4 },
        { action: "archive", ids: [b.id], reason: "stale" },
        { action: "archive", ids: [c.id], reason: "stale" }
      ])
    }),
    logger: { warn: (m) => warnings.push(String(m)) }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model" });
  assert.equal(result.ok, true, "valid subset absorbed (ok for the baseline)");
  assert.equal(result.status, "degraded", "run marked degraded, not faked ok");
  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "degraded", "audit row records degraded, never ok");
  assert.equal(parseReceipt(run.receipt).status, "degraded", "receipt records degraded");
  assert.equal(store.getById(b.id).archived, true, "valid archive landed");
  assert.equal(store.getById(pref.id).archived, false, "invalid merge did not touch its targets");
  assert.ok(warnings.some((w) => w.includes("skipped") && w.includes("multiple types")), "skip reason logged");
  store.close();
});
