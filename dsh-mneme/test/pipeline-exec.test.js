import test from "node:test";
import assert from "node:assert/strict";
import { openRun, OBSERVED, UNATTRIBUTED, AMBIGUOUS } from "../src/pipeline-exec.js";
import { validatePipeline } from "../src/pipeline.js";

// 这组测试守的是 M.O. 的**执行窗口**：有人显式说「按 X 走一遍」，窗口才开；窗口内的
// 工具调用才可能被记账；关窗产出一条 run。
//
// 最要紧的三条性质（都是「不许编造」的具体形态）：
//   ① 窗口外发生的事一个字都不记——漏记可接受，编造不可
//   ② 归属认不出来 → 进 unattributed，**不写进 run.steps**（不是「这步跳过了」）
//   ③ 没观察到的步骤 → 进 unobserved，既不写 skipped 也不写 used（缺席 ≠ 跳过）

function pipelineOf(steps) {
  return validatePipeline({
    id: "demo",
    name: "演示",
    project: "someone/repo",
    version: 0,
    status: "active",
    done: "走完",
    trigger: [{ kind: "phrase", value: "走一遍" }],
    steps: steps.map((s) => ({
      id: s.id,
      phase: "准备",
      title: `第 ${s.id} 步`,
      when: "需要时",
      do: "做事",
      who: "main",
      tool: s.tool ?? "",
      done: "做完",
      risk: "R0",
      needs: s.needs ?? [],
      why: "因为"
    }))
  }, "demo.json");
}

const clock = (() => {
  let n = 0;
  return () => new Date(Date.UTC(2026, 9, 16, 12, 0, n++));
})();

test("开窗需要一条工作流：没有 steps 直接拒，不静默建一个空窗口", () => {
  assert.throws(() => openRun({ pipeline: null }), /需要一条工作流/);
  assert.throws(() => openRun({ pipeline: { id: "x" } }), /需要一条工作流/);
});

test("显式点名归属：人说了算，不再走匹配", () => {
  const p = pipelineOf([{ id: "A1", tool: "npm test" }]);
  const run = openRun({ pipeline: p, by: "human", triggeredBy: "发版", now: clock });
  const r = run.observe({ tool: "bash", command: "随便什么命令" }, { stepId: "A1" });
  assert.equal(r.result, OBSERVED);
  assert.equal(r.resolved, "explicit", "人给的归属不该被自动匹配覆盖");

  const closed = run.close();
  assert.equal(closed.run.steps.length, 1);
  assert.equal(closed.run.steps[0].id, "A1");
  assert.equal(closed.run.by, "human");
  assert.equal(closed.run.triggeredBy, "发版");
});

test("自动归属只认唯一 exact：weak 与多候选走歧义桶，绝不自选一条", () => {
  const p = pipelineOf([
    { id: "P6", tool: "npm test" },
    { id: "P5", tool: "npm run badge:sync" }
  ]);
  const run = openRun({ pipeline: p, now: clock });

  // 唯一 exact → 自动记账
  assert.equal(run.observe({ command: "npm test" }).result, OBSERVED);

  // weak（词前缀但不相等）→ 歧义，不记账
  const weak = run.observe({ command: "npm run badge:sync --all" });
  assert.equal(weak.result, AMBIGUOUS, "弱匹配必须请人确认，不能自动写账");

  // 认不出来 → unattributed
  assert.equal(run.observe({ command: "docker ps" }).result, UNATTRIBUTED);

  const closed = run.close();
  assert.deepEqual(closed.run.steps.map((s) => s.id), ["P6"], "只有被确认的那步进账");
  assert.equal(closed.ambiguous.length, 1);
  assert.equal(closed.unattributed.length, 1);
});

test("同一步被观察到多次只计一次，次数进 note（tallyRuns 按 run 计数，重复会让 uses 虚高）", () => {
  const p = pipelineOf([{ id: "P6", tool: "npm test" }]);
  const run = openRun({ pipeline: p, now: clock });
  run.observe({ command: "npm test" });
  run.observe({ command: "npm test" });
  run.observe({ command: "npm test" });
  const closed = run.close();
  assert.equal(closed.run.steps.length, 1, "三次观察仍是一步");
  assert.match(closed.run.steps[0].note, /3 次/);
});

test("任一环节失败就永久标记 refuted：后来的成功不许抹掉跑砸过一次这件事", () => {
  const p = pipelineOf([{ id: "P6", tool: "npm test" }]);
  const run = openRun({ pipeline: p, now: clock });
  run.observe({ command: "npm test", ok: false }); // 先失败
  run.observe({ command: "npm test", ok: true });  // 再成功
  const closed = run.close();
  assert.equal(closed.run.steps[0].refuted, true, "失败过就是失败过，不该被后一次成功洗掉");
});

test("没被观察到的步骤进 unobserved：既不写 skipped 也不写 used——缺席不等于跳过", () => {
  const p = pipelineOf([
    { id: "A1", tool: "npm test" },
    { id: "A2", tool: "git diff" },
    { id: "A3", tool: "" }          // 空 tool：结构性地无法被归属
  ]);
  const run = openRun({ pipeline: p, now: clock });
  run.observe({ command: "npm test" });
  const closed = run.close();

  assert.deepEqual(closed.run.steps.map((s) => s.id), ["A1"]);
  assert.deepEqual(closed.unobserved, ["A2", "A3"]);
  // 关键：没观察到的步骤不许出现在 steps 里被标成 skipped——那是编造「这步被跳过了」。
  assert.equal(closed.run.steps.some((s) => s.skipped === true), false);
  assert.equal(closed.run.steps.some((s) => s.detoured === true), false);
});

test("一步都没走成：如实返回 no-steps，不伪造一条空 run 去凑契约", () => {
  const p = pipelineOf([{ id: "A1", tool: "npm test" }]);
  const run = openRun({ pipeline: p, now: clock });
  run.observe({ command: "完全无关的命令" });
  const closed = run.close();

  assert.equal(closed.run, null, "账本契约要求至少一步，所以这里不能有 run");
  assert.equal(closed.reason, "no-steps");
  assert.equal(closed.unattributed.length, 1, "但这次观察要留着，别丢");
});

test("窗口关掉之后不再接受观察：不悄悄记进一个已经结完的账", () => {
  const p = pipelineOf([{ id: "A1", tool: "npm test" }]);
  const run = openRun({ pipeline: p, now: clock });
  run.observe({ command: "npm test" });
  const first = run.close();
  const after = run.observe({ command: "npm test" });

  assert.equal(after.accepted, false);
  assert.equal(after.result, "run-closed");
  assert.equal(run.close(), first, "重复 close 返回同一份，不产生第二份账");
});

test("state() 只报状态不结账：窗口开着时也能回答「走到哪了」", () => {
  const p = pipelineOf([{ id: "A1", tool: "npm test" }, { id: "A2", tool: "git diff" }]);
  const run = openRun({ pipeline: p, now: clock });
  run.observe({ command: "npm test" });
  run.observe({ command: "乱七八糟" });
  const s = run.state();

  assert.equal(s.open, true);
  assert.equal(s.observations, 2);
  assert.deepEqual(s.recorded, ["A1"]);
  assert.equal(s.unattributed, 1);
  assert.equal(s.ambiguous, 0);
});

test("产出的 run 能过账本的 normalizer：窗口与账本两个契约对得上", async () => {
  const { normalizeRun } = await import("../src/pipeline-runs.js");
  const p = pipelineOf([{ id: "A1", tool: "npm test" }]);
  const run = openRun({ pipeline: p, now: clock });
  run.observe({ command: "npm test", ok: false });
  const closed = run.close();

  // 不传 expectedStepIds：这里验的是形状能被账本接受
  const normalized = normalizeRun(closed.run);
  assert.equal(normalized.steps[0].id, "A1");
  assert.equal(normalized.steps[0].refuted, true);
  assert.equal(normalized.by, "main");
});
