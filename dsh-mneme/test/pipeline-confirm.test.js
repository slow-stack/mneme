import test from "node:test";
import assert from "node:assert/strict";
import { buildProposal, normalizeAnswers, runFromAnswers } from "../src/pipeline-confirm.js";
import { validatePipeline } from "../src/pipeline.js";

// 这组测试守的是 P2 的核心语义：**机器不猜，人确认才写账**。
// 最要紧的三条：
//   ① 提案不改动任何东西（纯函数）
//   ② unsure / 没回答 ≠ notDone——前者什么都不写，后者记 skipped
//   ③ 一步都没确认走过 → 不产 run（账本契约不许零步），而不是伪造一条空的

function makePipeline() {
  return validatePipeline({
    id: "demo", name: "演示", project: "a/b", version: 0, status: "active", done: "走完",
    trigger: [{ kind: "phrase", value: "走一遍" }],
    steps: [
      { id: "P6", phase: "p", title: "跑测试", when: "w", do: "d", who: "main", tool: "npm test", done: "dn", risk: "R0", needs: [], why: "y" },
      { id: "V2", phase: "p", title: "推分支", when: "w", do: "d", who: "main", tool: "git push", done: "dn", risk: "R2", needs: ["P6"], why: "y" }
    ]
  }, "demo.json");
}

test("提案：列出流程步骤与观察到的动作，但**不预选任何一步**", () => {
  const p = makePipeline();
  const prop = buildProposal({
    pipeline: p,
    activities: [{ key: "npm test", count: 5, flags: [] }, { key: "git status", count: 3, flags: ["--porcelain"] }]
  });
  assert.equal(prop.ok, true);
  assert.deepEqual(prop.steps.map((s) => s.id), ["P6", "V2"]);
  // 步骤里带的是"作者写的 tool 原文"，给对照用；没有任何自动勾选
  assert.equal(prop.steps[0].declared, "npm test");
  assert.equal(prop.steps[0].hintCount, 0, "没给候选时次数是 0");
  assert.deepEqual(prop.activities.map((a) => a.key), ["npm test", "git status"]);
});

test("提案：候选只作提示（一个次数），不预选、不带命令行原文", () => {
  const p = makePipeline();
  const prop = buildProposal({ pipeline: p, hints: { P6: 3 } });
  assert.equal(prop.steps[0].hintCount, 3);
  // 关键：hintCount 只说明"见到过相近命令"，没有任何字段表示"已经确认"
  assert.equal("answer" in prop.steps[0], false);
  assert.equal("selected" in prop.steps[0], false);
  // 也不存命令行原文——原文含绝对路径（路径含本机用户名），而这条会进回执
  assert.equal(JSON.stringify(prop).includes("command"), false);
});

test("提案：没有工作流时如实拒绝", () => {
  assert.equal(buildProposal({ pipeline: null }).reason, "no-pipeline");
  assert.equal(buildProposal({ pipeline: { id: "x" } }).reason, "no-pipeline");
});

test("校验回答：只认三类值，非法值一律拒（静默当「没发生」是编造）", () => {
  const p = makePipeline();
  assert.equal(normalizeAnswers({ P6: "done" }, p).ok, true);
  const bad = normalizeAnswers({ P6: "yes" }, p);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "bad-answer-value");
  const unknown = normalizeAnswers({ NOPE: "done" }, p);
  assert.equal(unknown.reason, "unknown-step");
  assert.equal(normalizeAnswers(null, p).reason, "bad-answers");
  assert.equal(normalizeAnswers([], p).reason, "bad-answers");
});

test("✅ 核心语义：done → uses；notDone → skipped；unsure/没答 → 什么都不写", () => {
  const p = makePipeline();
  const r = runFromAnswers({
    pipeline: p,
    answers: { P6: "done" },   // V2 没回答
    now: () => new Date("2026-10-17T00:00:00.000Z")
  });
  assert.equal(r.kind, "run");
  assert.deepEqual(r.run.steps.map((s) => s.id), ["P6"], "没回答的步骤不许进账");
  assert.equal(r.run.steps[0].skipped, false);
  assert.deepEqual(r.unanswered, ["V2"], "没答的要如实列出来");
  assert.equal(r.run.by, "human", "人确认的账，by 应当是人");
});

test("✅ 核心语义：unsure 与 notDone 决不能混——前者不写，后者记 skipped", () => {
  const p = makePipeline();
  const unsure = runFromAnswers({ pipeline: p, answers: { P6: "done", V2: "unsure" } });
  assert.deepEqual(unsure.run.steps.map((s) => s.id), ["P6"], "unsure 不进账");
  assert.deepEqual(unsure.unsure, ["V2"]);

  const notDone = runFromAnswers({ pipeline: p, answers: { P6: "done", V2: "notDone" } });
  const v2 = notDone.run.steps.find((s) => s.id === "V2");
  assert.equal(v2.skipped, true, "人明确说没做，才记 skipped");
  assert.match(v2.note, /人确认/);
  // 这条区分的意义：跳过计数正是 RETIRE_AFTER_SKIPS 提议删步的依据，
  // 把"忘了勾"记成"被跳过"就会多出错误提议。
  assert.notDeepEqual(unsure.run.steps.length, notDone.run.steps.length);
});

test("全部 notDone 仍是一条合法记录（人确认「这次一步都没做」是有信息的）", () => {
  const p = makePipeline();
  const r = runFromAnswers({ pipeline: p, answers: { P6: "notDone", V2: "notDone" } });
  // 这不叫"零步"——它明确记录了"这两步这次都没做"，是一条完整的、全跳过的 run。
  // 真正进 nothing 的是「什么都没确认」（见下一条）。
  assert.equal(r.kind, "run");
  assert.deepEqual(r.run.steps.map((s) => s.id), ["P6", "V2"]);
  assert.equal(r.run.steps.every((s) => s.skipped === true), true);
  assert.deepEqual(r.notDone, ["P6", "V2"]);
});

test("什么都没确认（全 unsure）：不产 run——这才是真正的「零步」", () => {
  const p = makePipeline();
  const r = runFromAnswers({ pipeline: p, answers: { P6: "unsure", V2: "unsure" } });
  assert.equal(r.kind, "nothing");
  assert.equal(r.reason, "no-steps-confirmed");
  assert.equal("run" in r, false, "不许伪造一条空 run");
  assert.deepEqual(r.unsure, ["P6", "V2"]);
  assert.deepEqual(r.notDone, []);
});

test("空回答也是 nothing（没答 ≠ 都没做）", () => {
  const p = makePipeline();
  const r = runFromAnswers({ pipeline: p, answers: {} });
  assert.equal(r.kind, "nothing");
  assert.deepEqual(r.unanswered, ["P6", "V2"]);
  assert.deepEqual(r.notDone, [], "没人说没做，就不该出现在 notDone 里");
});

test("非法回答进不来：runFromAnswers 会把它变成 error，而不是悄悄少记一步", () => {
  const p = makePipeline();
  const r = runFromAnswers({ pipeline: p, answers: { P6: "done", V2: "nope" } });
  assert.equal(r.kind, "error");
  assert.equal(r.reason, "bad-answer-value");
  assert.equal("run" in r, false);
});

test("产出的 run 能过账本 normalizer（两个契约对得上）", async () => {
  const { normalizeRun } = await import("../src/pipeline-runs.js");
  const p = makePipeline();
  const r = runFromAnswers({ pipeline: p, answers: { P6: "done", V2: "notDone" } });
  const normalized = normalizeRun(r.run);
  assert.equal(normalized.steps.length, 2);
  assert.equal(normalized.steps[0].skipped, false);
  assert.equal(normalized.steps[1].skipped, true);
  assert.equal(normalized.by, "human");
});

test("坏输入不抛", () => {
  const p = makePipeline();
  for (const bad of [null, undefined, [], "x", 0]) {
    assert.equal(runFromAnswers({ pipeline: p, answers: bad }).kind, "error");
  }
  assert.equal(runFromAnswers({ pipeline: null, answers: {} }).kind, "error");
});
