import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCommand,
  commandParts,
  attributionCandidates,
  unattributableSteps,
  normalizeObservation
} from "../src/pipeline-attribution.js";

// 这组测试守的是 M.O. 的**归属规则**：把宿主的一次工具动作映射到「可能是工作流的哪一步」。
// 它最要紧的性质不是「能匹配上」，而是**认不出来时绝不许猜**——误匹配会让错误的步骤
// 被染成可信，而漏匹配只是少一条账。所以下面失败的用例和成功的用例一样重要。

function pipeline(steps) {
  return {
    id: "demo",
    steps: steps.map((s) => ({
      id: s.id,
      tool: s.tool ?? "",
      who: s.who ?? "main",
      gate: s.gate === true
    }))
  };
}

// ── 归一化 ────────────────────────────────────────────────────────────────────

test("归一化：大小写、占位符、多余空白都不影响比较", () => {
  assert.equal(normalizeCommand("  NPM   Test  "), "npm test");
  // 占位符是给人的读法，不是字面量——留着它会让 `git push <tag>` 谁都匹配不上。
  assert.equal(normalizeCommand("git push <tag>"), "git push");
  assert.equal(normalizeCommand("node script.mjs <版本>"), "node script.mjs");
});

test("占位符去掉而不是换成通配：不许宽到能匹配一切", () => {
  // 若把 <tag> 换成 .*，下面这条就会命中——那是把「推 tag」与「推分支」混为一谈。
  const p = pipeline([{ id: "T2", tool: "git push <tag>" }]);
  const c = attributionCandidates({ command: "git push --force origin main" }, p);
  assert.equal(c.every((x) => x.confidence !== "exact"), true, "占位符不该让任意参数都算「完全一致」");
});

test("并列命令按分隔符拆开，但路径里的斜杠不能把命令切碎", () => {
  assert.deepEqual(commandParts("git log / gh pr list"), ["git log", "gh pr list"]);
  assert.deepEqual(commandParts("npm run badge:sync"), ["npm run badge:sync"]);
  // 这一段是防回归的关键：脚本路径里的 `/` 两侧无空白，不该被当分隔符。
  assert.deepEqual(commandParts("node dsh-mneme/scripts/publish-gate.mjs <版本>"),
    ["node dsh-mneme/scripts/publish-gate.mjs"]);
});

// ── 匹配 ──────────────────────────────────────────────────────────────────────

test("完全一致：命令与步骤里写的对得上，给 exact 候选", () => {
  const p = pipeline([{ id: "P6", tool: "npm test" }]);
  const c = attributionCandidates({ command: "npm test" }, p);
  assert.equal(c.length, 1);
  assert.equal(c[0].stepId, "P6");
  assert.equal(c[0].confidence, "exact");
});

test("抗噪：同前缀但不同子命令的步骤不该成为候选", () => {
  // 真实工作流里 `git` 出现 5 次、`gh pr` 出现 4 次。若按「第一个词相同」匹配，
  // 一次 `npm test` 会把所有 npm 步骤都报成候选——噪声盖过信号，人看一眼就放弃了。
  const p = pipeline([
    { id: "P5", tool: "npm run badge:sync" },
    { id: "P6", tool: "npm test" }
  ]);
  const c = attributionCandidates({ command: "npm test" }, p);
  assert.deepEqual(c.map((x) => x.stepId), ["P6"], "只该报真正对得上那一条");
});

test("词前缀才算 weak：同一步多带了参数应被认出来", () => {
  const p = pipeline([{ id: "P3", tool: "gh pr create" }]);
  const c = attributionCandidates({ command: "gh pr create --base main --title 补开发版" }, p);
  assert.equal(c.length, 1);
  assert.equal(c[0].confidence, "weak", "人写的是步骤名，agent 跑的是带参命令行——这该认出来");
  assert.match(c[0].why, /gh pr create/);
});

test("命令头相同但参数对不上：给 weak 候选，并如实说明差在哪", () => {
  const p = pipeline([{ id: "V2", tool: "git push" }]);
  const c = attributionCandidates({ command: "git push --delete origin lane" }, p);
  assert.equal(c.length, 1);
  assert.equal(c[0].confidence, "weak");
  // 理由里必须能看出「步骤写的是什么、这次是什么」，否则人没法判断该不该认。
  assert.match(c[0].why, /git push/);
  assert.match(c[0].why, /--delete/);
});

test("认不出来就是空数组——不许猜", () => {
  const p = pipeline([{ id: "P6", tool: "npm test" }, { id: "T2", tool: "git tag" }]);
  assert.deepEqual(attributionCandidates({ command: "docker compose up" }, p), []);
  // 拼不出命令行时同样返回空，而不是退回「第一条」。
  assert.deepEqual(attributionCandidates({ tool: "bash" }, p), []);
});

test("同一档多条候选全部返回，不替人挑一条", () => {
  const p = pipeline([
    { id: "A1", tool: "npm test" },
    { id: "A2", tool: "npm test" }
  ]);
  const c = attributionCandidates({ command: "npm test" }, p);
  assert.deepEqual(c.map((x) => x.stepId), ["A1", "A2"], "两条步骤长得一样时该由人消歧，机器不许自己选");
  assert.equal(c.every((x) => x.confidence === "exact"), true);
});

test("空 tool 的步骤结构性地无法归属：不参与匹配，而不是匹配成「什么都能中」", () => {
  const p = pipeline([{ id: "P4", tool: "" }, { id: "P6", tool: "npm test" }]);
  const c = attributionCandidates({ command: "npm test" }, p);
  assert.deepEqual(c.map((x) => x.stepId), ["P6"]);
  assert.deepEqual(attributionCandidates({ command: "任意命令" }, pipeline([{ id: "P4", tool: "" }])), []);
});

test("exact 排在 weak 前面（给人看时先看最可能的那档）", () => {
  // 同一次动作能同时命中两种档位时，exact 必须在前——人从第一条开始看，
  // 把最可能的排在后面等于逼人先读完噪声。
  const p = pipeline([
    { id: "W", tool: "git push" },              // 这次跑的是 `git push --force`，只算 weak
    { id: "E", tool: "git push --delete origin lane" } // 这次跑的正是它，exact
  ]);
  const c = attributionCandidates({ command: "git push --delete origin lane" }, p);
  assert.equal(c[0].stepId, "E");
  assert.equal(c[0].confidence, "exact");
  assert.equal(c[1].stepId, "W");
  assert.equal(c[1].confidence, "weak");
});

test("弱匹配受得住真实工作流的规模：一次 git push 不会把六条 git 步骤全报出来", () => {
  // 真实那条 19 步的工作流里 git 系命令有 5 条。这条是抗噪的规模版回归锁。
  const real = pipeline([
    { id: "P1", tool: "git log / gh pr list" },
    { id: "V2", tool: "git push" },
    { id: "T1", tool: "git diff" },
    { id: "T2", tool: "git tag / git push <tag>" },
    { id: "F3", tool: "git push --delete / git worktree remove" }
  ]);
  const c = attributionCandidates({ command: "git push origin main" }, real);
  const ids = c.map((x) => x.stepId);
  // `git log` / `git diff` / `git push --delete` 都不算 `git push`（后者参数方向相反：
  // 步骤写的是「git push --delete」，这次是「git push origin main」，谁也不是谁的前缀）。
  assert.equal(ids.includes("P1"), false, "git log 不该被当成 git push");
  assert.equal(ids.includes("T1"), false, "git diff 不该被当成 git push");
  assert.equal(ids.includes("F3"), false, "git push --delete 与 git push origin main 是不同的两步");
  // 只剩真的以 `git push` 起头、只是多带了参数的那两条。
  assert.deepEqual(ids.sort(), ["T2", "V2"]);
  assert.ok(ids.length < real.steps.length, "候选数必须少于总步数，否则等于没筛");
});

// ── 结构性不可归属 ────────────────────────────────────────────────────────────

test("空 tool 的步骤被单独列出来：它是「为什么这一步永远没账」的答案", () => {
  const p = pipeline([{ id: "P6", tool: "npm test" }, { id: "P4", tool: "" }]);
  assert.deepEqual(unattributableSteps(p), ["P4"],
    "没写 tool 的步骤永远不会拿到账——它与「还没跑过」必须分得开");
  assert.deepEqual(unattributableSteps({ steps: [{ id: "X", tool: "   " }] }), ["X"], "空白 tool 同样不可归属");
  assert.deepEqual(unattributableSteps(null), [], "坏输入返回空数组，不抛");
});

// ── 观察对象的形状 ────────────────────────────────────────────────────────────

test("观察的三态 ok 必须保住：「失败」不能与「不知道」折叠成同一个值", () => {
  assert.equal(normalizeObservation({ command: "npm test", ok: true }).ok, true);
  assert.equal(normalizeObservation({ command: "npm test", ok: false }).ok, false);
  // 宿主没给成败时留 null——把它当 false 会让「跑失败」与「没记录」不可分。
  assert.equal(normalizeObservation({ command: "npm test" }).ok, null);
  assert.equal(normalizeObservation({ tool: "bash" }), null, "拼不出命令行的观察不进归属");
});

test("坏输入都不抛：没有 pipeline、没有观察、空对象一律返回空数组", () => {
  const p = pipeline([{ id: "A1", tool: "npm test" }]);
  for (const bad of [null, undefined, {}, { command: "" }, 0]) {
    assert.deepEqual(attributionCandidates(bad, p), [], `观察 ${JSON.stringify(bad)} 该返回空数组而不是抛`);
  }
  assert.deepEqual(attributionCandidates({ command: "x" }, null), []);
});
