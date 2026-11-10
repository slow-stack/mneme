import test from "node:test";
import assert from "node:assert/strict";
import { validateDecisions } from "../src/dream.js";
import { STR } from "../src/lang.js";

// reflectionUpdateEnabled 的消费者：这个键从 v0.7.1 拷进配置表起就没有任何运行时代码
// 读它（2026-11-09 审计：#290 的 CONFIGURATION.md 写「检索后的反思更新既有记忆」，但
// 那段从未接上），面板上它是个拨了没反应的开关。本次接上双闸：
//   1. 校验侧：allowUpdate=false 时所有 update 决策单条跳过（skipInvalid 通路，
//      不整单拒绝——关掉的是「改写已有记忆」这一种动作，不该连带丢掉同批 merge）；
//   2. prompt 侧：noUpdateSuffix 追加一句「不要输出 update」，避免每轮白付一批
//      必然被拒的输出 token。
// 关键不变量：默认（不传 allowUpdate）必须逐字节零变化——这个键默认 true。

function snap(entries) {
  const now = Date.now();
  return new Map(entries.map(([id, type, ageHours = 100]) => [id, {
    id,
    type,
    title: `t-${id}`,
    content: `c-${id}`,
    importance: 3,
    archived: false,
    forgotten: false,
    created_at: new Date(now - ageHours * 3600000).toISOString(),
    updated_at: new Date(now - ageHours * 3600000).toISOString()
  }]));
}

// ------------------------------------------------------------------ 零变化默认

test("reflectionUpdateEnabled: omitted allowUpdate leaves update decisions untouched", () => {
  const s = snap([["m1", "project"]]);
  const decisions = [{ action: "update", ids: ["m1"], content: "修正后的内容" }];
  const { ok, errors, skipped } = validateDecisions(decisions, s, { skipInvalid: true });
  assert.equal(ok, true);
  assert.deepEqual(skipped, []);
  assert.deepEqual(errors, []);
});

test("reflectionUpdateEnabled: allowUpdate=true behaves exactly like omitting it", () => {
  const s = snap([["m1", "project"]]);
  const decisions = [{ action: "update", ids: ["m1"], content: "修正后的内容" }];
  const a = validateDecisions(decisions, s, { skipInvalid: true });
  const b = validateDecisions(decisions, s, { skipInvalid: true, allowUpdate: true });
  assert.deepEqual(a, b);
});

// ------------------------------------------------------------------ 关闭时拦截

test("reflectionUpdateEnabled=false: update is skipped with a reason naming the flag", () => {
  const s = snap([["m1", "project"]]);
  const decisions = [{ action: "update", ids: ["m1"], content: "修正后的内容" }];
  const { ok, errors, skipped } = validateDecisions(decisions, s, { skipInvalid: true, allowUpdate: false });
  assert.equal(ok, true, "a disabled action is a per-decision skip, not a whole-run rejection");
  assert.deepEqual(errors, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].action, "update");
  assert.match(skipped[0].error, /reflectionUpdateEnabled=false/);
});

test("reflectionUpdateEnabled=false: other actions in the same batch still apply", () => {
  const s = snap([["m1", "project"], ["a1", "project"], ["a2", "project"], ["k1", "project"]]);
  const decisions = [
    { action: "update", ids: ["m1"], content: "会被拦下" },
    { action: "archive", ids: ["a1"], reason: "重复" },
    { action: "merge", ids: ["a2", "k1"], keepSource: "a2", title: "合并", content: "合并内容" }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, s, { skipInvalid: true, allowUpdate: false });
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(skipped.map((x) => x.action), ["update"], "only the update is dropped");
});

test("reflectionUpdateEnabled=false: strict mode (skipInvalid off) also refuses the run, not silently", () => {
  const s = snap([["m1", "project"]]);
  const decisions = [{ action: "update", ids: ["m1"], content: "修正后的内容" }];
  const { ok, errors } = validateDecisions(decisions, s, { allowUpdate: false });
  assert.equal(ok, false, "without skipInvalid the invalid decision propagates");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /reflectionUpdateEnabled=false/);
});

test("reflectionUpdateEnabled=false: the update branch reports the gate before field-level errors", () => {
  // 顺序锁：同一条既不合规（缺少 content）又被关闭时，日志里应看到「动作被禁用」
  // 这一句而不是字段错误——否则排查时读不出真正原因。
  const s = snap([["m1", "project"]]);
  const decisions = [{ action: "update", ids: ["m1"] }];
  const { skipped } = validateDecisions(decisions, s, { skipInvalid: true, allowUpdate: false });
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].error, /reflectionUpdateEnabled=false/);
  assert.doesNotMatch(skipped[0].error, /must change at least one field/);
});

test("reflectionUpdateEnabled=false: updateCount limit no longer fires (nothing claims update)", () => {
  // 关闭后 survivors 里不会有 update，于是「too many updates」这道全局闸不可能再
  // 触发——否则会出现「明明关掉了却报超出上限」这种自相矛盾的整单拒绝。
  const s = snap([["m1", "project"], ["m2", "project"], ["m3", "project"]]);
  const decisions = [
    { action: "update", ids: ["m1"], content: "a" },
    { action: "update", ids: ["m2"], content: "b" },
    { action: "update", ids: ["m3"], content: "c" }
  ];
  const { ok, errors } = validateDecisions(decisions, s, { skipInvalid: true, allowUpdate: false, maxUpdatePerRun: 2 });
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

// ------------------------------------------------------------------ prompt 后缀

test("reflectionUpdateEnabled=false: noUpdateSuffix exists in both languages and forbids update", () => {
  for (const lang of ["zh", "en"]) {
    const text = STR.prompts.noUpdateSuffix[lang];
    assert.equal(typeof text, "string");
    assert.match(text, /update/);
  }
  assert.match(STR.prompts.noUpdateSuffix.zh, /不要输出 update/);
  assert.match(STR.prompts.noUpdateSuffix.en, /do not output update/);
});

test("reflectionUpdateEnabled=false: suffix is additive, never a replacement prompt", () => {
  // 后缀只能追加。若哪天有人把它改成一份完整 prompt，下面这条会转红：完整 prompt
  // 会丢掉 freeze 后缀以及既有任务清单，两个开关的语义互相覆盖。
  for (const lang of ["zh", "en"]) {
    const suffix = STR.prompts.noUpdateSuffix[lang];
    assert.ok(suffix.length < 400, `${lang} suffix should stay a short addendum, got ${suffix.length}`);
    assert.equal(suffix.includes("keepSource"), false, `${lang} suffix must not restate the decision schema`);
  }
});
