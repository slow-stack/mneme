import test from "node:test";
import assert from "node:assert/strict";
import { validatePipeline, suggestRetirements } from "../src/pipeline.js";

// R1/R2 + P3 投影的判据锁。
// 核心不变量：**四类提议互不吞并**（07 号文的教训——第一版 if/else if，
// 绕行把跳过吃掉了）。每类有自己的触发条件，可以并存，谁也不许吃掉谁。

function makePipeline(steps) {
  return validatePipeline({
    id: "demo", name: "演示", project: "a/b", version: 0, status: "active", done: "走完",
    trigger: [{ kind: "phrase", value: "走一遍" }],
    steps
  }, "demo.json");
}

const BASE_STEP = {
  phase: "p", when: "w", do: "d", who: "main", done: "dn", risk: "R0", why: "y"
};
const step = (id, extra = {}) => ({ id, title: id, tool: "", needs: [], ...BASE_STEP, ...extra });

const RUN = (at, steps) => ({ at, by: "human", triggeredBy: "demo", steps });

test("R2：optional 步骤被跳 3 次 → optional-skip-ok 信息项，绝不提议删", () => {
  const p = makePipeline([step("OPT", { optional: true, tool: "npm run lint" })]);
  const runs = [1, 2, 3].map((i) => RUN(`2026-10-0${i}T00:00:00Z`, [{ id: "OPT", at: "x", skipped: true }]));
  const out = suggestRetirements(p, { runs });
  const kinds = out.map((s) => s.kind);
  assert.equal(kinds.includes("drop-step"), false, "可选步骤绝不能被提议删");
  assert.equal(kinds.includes("optional-skip-ok"), true, "给一条信息项供人留意");
});

test("R2：必经步骤被跳 3 次 → drop-step 与 rework-path 并存（两种读法都给人）", () => {
  const p = makePipeline([step("REQ", { tool: "npm test" })]);
  const runs = [1, 2, 3].map((i) => RUN(`2026-10-0${i}T00:00:00Z`, [{ id: "REQ", at: "x", skipped: true }]));
  const out = suggestRetirements(p, { runs });
  // 必经的一步总被跳：既可能是「这步多余」（删），也可能是「流程写错」（修图）。
  // 两种读法同时给——07 号文教训的反面：不许 if/else 吞掉任何一种。
  assert.equal(out.some((s) => s.kind === "rework-path" && s.because.includes("必经")), true);
  assert.equal(out.some((s) => s.kind === "drop-step"), true, "从未 uses 的必经步骤，删步候选也在");
});

test("drop-step 只给「必经且从未 uses 且被跳够数」的步骤", () => {
  // never used：账本里只有 skipped 行、无 uses
  const p = makePipeline([step("GHOST", { tool: "gh pr merge --rebase" })]);
  const runs = [1, 2, 3].map((i) => RUN(`2026-10-0${i}T00:00:00Z`, [{ id: "GHOST", at: "x", skipped: true }]));
  const out = suggestRetirements(p, { runs });
  // 与 rework-path 并存（必经被跳也成立），但 drop-step 必须在
  assert.equal(out.some((s) => s.kind === "drop-step" && s.stepId === "GHOST"), true, "写进清单但从不执行 → 才是删步候选");
  // 而 optional 同形状不给 drop-step
  const p2 = makePipeline([step("G2", { optional: true, tool: "x" })]);
  const out2 = suggestRetirements(p2, { runs });
  assert.equal(out2.some((s) => s.kind === "drop-step"), false);
});

test("R1：前置违规一次就报——done 了后继但 needs 前置整条缺失", () => {
  const p = makePipeline([
    step("A", { tool: "npm test" }),
    step("B", { tool: "git push", needs: ["A"] })
  ]);
  // 只做了 B，A 连行都没有 → 违规
  const runs = [RUN("2026-10-17T00:00:00Z", [{ id: "B", at: "x" }])];
  const out = suggestRetirements(p, { runs });
  const v = out.filter((s) => s.kind === "violation-precedence");
  assert.equal(v.length, 1, "一次就报，不攒次数");
  assert.equal(v[0].stepId, "B");
  assert.match(v[0].because, /A/);
});

test("R1：前置做过（哪怕 skipped）不算违规；多前置断在缺的那条边上", () => {
  const p = makePipeline([
    step("A"), step("C"),
    step("B", { needs: ["A", "C"] })
  ]);
  // A 做了、C 被跳过 → 前置都「有着落」，不违规
  const ok = suggestRetirements(p, { runs: [RUN("t1", [{ id: "A", at: "x" }, { id: "C", at: "x", skipped: true }, { id: "B", at: "x" }])] });
  assert.equal(ok.filter((s) => s.kind === "violation-precedence").length, 0);
  // A 做了、C 整条没有 → 恰好一条，点名 C
  const bad = suggestRetirements(p, { runs: [RUN("t2", [{ id: "A", at: "x" }, { id: "B", at: "x" }])] });
  const v = bad.filter((s) => s.kind === "violation-precedence");
  assert.equal(v.length, 1);
  assert.match(v[0].because, /C/);
});

test("🔴 四类互不吞并：同一 run 里能并存的都出现", () => {
  const p = makePipeline([
    step("OPT", { optional: true }),
    step("GHOST", { tool: "x" }),
    step("A", { tool: "npm test" }),
    step("B", { tool: "git push", needs: ["A"] })
  ]);
  const runs = [
    // OPT 被跳（optional-skip-ok）；GHOST 被跳（drop-step 候选）；
    // B done 而 A 缺（violation-precedence）
    RUN("t1", [{ id: "OPT", at: "x", skipped: true }, { id: "GHOST", at: "x", skipped: true }, { id: "B", at: "x" }]),
    RUN("t2", [{ id: "OPT", at: "x", skipped: true }, { id: "GHOST", at: "x", skipped: true }, { id: "B", at: "x" }]),
    RUN("t3", [{ id: "OPT", at: "x", skipped: true }, { id: "GHOST", at: "x", skipped: true }, { id: "B", at: "x" }])
  ];
  const kinds = suggestRetirements(p, { runs }).map((s) => s.kind);
  for (const k of ["optional-skip-ok", "drop-step", "violation-precedence", "rework-path"]) {
    assert.equal(kinds.includes(k), true, `缺 ${k}`);
  }
});

test("P3 投影：声明 tool 从未出现在观察里 + 被确认做过 → fix-step-tool", () => {
  const p = makePipeline([
    step("P6", { tool: "npm test" }),
    step("V2", { tool: "git push", needs: ["P6"] })
  ]);
  const runs = [RUN("t1", [{ id: "P6", at: "x" }])]; // 人确认 P6 做了
  const observed = { latest: { activities: [{ key: "node --test", count: 9 }, { key: "git status", count: 4 }] } };
  const out = suggestRetirements(p, { runs, observed });
  const f = out.filter((s) => s.kind === "fix-step-tool");
  assert.equal(f.length, 1, "P6 声明 npm test 未出现 → 一条");
  assert.equal(f[0].stepId, "P6");
  assert.deepEqual(f[0].observedTop, ["node --test ×9", "git status ×4"]);
});

test("P3 投影：多锚点任一命中即对上；optional/无 tool/未确认过 全部不进判据", () => {
  const p = makePipeline([
    step("P1", { tool: "git log / gh pr list" }),
    step("V1", { tool: "" }),
    step("OPT", { optional: true, tool: "npm run lint" })
  ]);
  const runs = [RUN("t1", [{ id: "P1", at: "x" }, { id: "V1", at: "x" }, { id: "OPT", at: "x" }])];
  // 观察里有 gh pr list → P1 对上；观察为空 → V1/OPT 也不该报（V1 无声明、OPT 可选）
  const out = suggestRetirements(p, { runs, observed: { latest: { activities: [{ key: "gh pr list", count: 2 }] } } });
  assert.equal(out.filter((s) => s.kind === "fix-step-tool").length, 0);
  // 换成啥都没有的观察：P1 的两个锚点都没出现 → 报
  const out2 = suggestRetirements(p, { runs, observed: { latest: { activities: [{ key: "docker ps", count: 1 }] } } });
  const f = out2.filter((s) => s.kind === "fix-step-tool");
  assert.equal(f.length, 1);
  assert.equal(f[0].stepId, "P1");
});

test("P3 投影：没传 observed 时行为与旧版完全一致（零回归）", () => {
  const p = makePipeline([step("A", { tool: "npm test" }), step("B", { needs: ["A"] })]);
  const runs = [RUN("t1", [{ id: "OPT0", at: "x", skipped: true }])];
  const a = suggestRetirements(p, { runs });
  const b = suggestRetirements(p, { runs, observed: null });
  assert.deepEqual(a, b);
});

test("坏输入不抛", () => {
  const p = makePipeline([step("A")]);
  assert.doesNotThrow(() => suggestRetirements(p, { runs: null }));
  assert.doesNotThrow(() => suggestRetirements(p, { runs: [{}] }));
  assert.doesNotThrow(() => suggestRetirements(p, { runs: [{ at: null, steps: null }] }));
});

// #461：violationSeen 跨整本账本共享，而键里的 `run.at ?? ""` 在 at 缺失时塌缩成
// 空串——于是所有无时间戳的 run，其同 (step, need) 违规会被并成一条。去重本意是
// 「同一轮里同一条只报一次」，不是「所有轮共享一条」。两条独立的 run 就该产出两条。
// run 没有 id 字段（normalizeRun 只产出 at/by/triggeredBy/steps），所以兜底用位置索引。
test("#461：两条无 run.at 的 run 的同类违规不被并成一条", () => {
  const p = makePipeline([
    step("A", { tool: "npm test" }),
    step("B", { tool: "git push", needs: ["A"] })
  ]);
  // 两条 run 都只做了 B、都没带 at：证据各自独立，该各报一条
  const runs = [
    { at: null, by: "human", triggeredBy: "demo", steps: [{ id: "B", at: "x" }] },
    { at: undefined, by: "human", triggeredBy: "demo", steps: [{ id: "B", at: "x" }] }
  ];
  const v = suggestRetirements(p, { runs }).filter((s) => s.kind === "violation-precedence");
  assert.equal(v.length, 2, "两条独立的 run 各报一条，不被键塌缩吞掉");
  assert.equal(v[0].stepId, "B");
  assert.equal(v[1].stepId, "B");
});

// at 存在时行为不变：同 at 的重复违规仍然只报一条（原有去重语义不能被修坏）。
test("#461：at 存在时同轮重复违规仍只报一条（回归保护）", () => {
  const p = makePipeline([
    step("A", { tool: "npm test" }),
    step("B", { tool: "git push", needs: ["A"] })
  ]);
  const runs = [
    RUN("2026-10-17T00:00:00Z", [{ id: "B", at: "x" }]),
    RUN("2026-10-17T00:00:00Z", [{ id: "B", at: "x" }])
  ];
  const v = suggestRetirements(p, { runs }).filter((s) => s.kind === "violation-precedence");
  assert.equal(v.length, 1, "同一 at 的同一违规仍然只报一次");
});
