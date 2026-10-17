import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observationDir, validateObservationLine, saveObservations,
  loadObservations, toolMismatches
} from "../src/pipeline-observations.js";

// P3 核心三件事的锁：
//   ① 观察旁挂（丙）：append-only、幂等、🔴 不许命令原文进观察行
//   ② toolMismatches：人确认 done 但声明 tool 没出现 → 提议修表
//   ③ unsure/没答不进判据（那不是「做了但没看到」，是「没确认」）

const tmp = mkdtempSync(join(tmpdir(), "mo-p3-"));
test.after(() => { rmSync(tmp, { recursive: true, force: true }); });

const PIPE = {
  id: "demo",
  steps: [
    { id: "P6", title: "跑测试", tool: "npm test" },
    { id: "V2", title: "推分支", tool: "git push" },
    { id: "T4", title: "过闸门", tool: "node scripts/publish-gate.mjs" },
    { id: "V1", title: "人过目", tool: "" }               // 纯人判步骤，无从矛盾
  ]
};

test("observationDir：项目键分桶，空键拒绝", () => {
  assert.equal(observationDir({ memoryDir: "D:/mem", projectKey: "proj-a1b2" }), join("D:/mem", "observations", "proj-a1b2"));
  assert.equal(observationDir({ projectKey: "" }), null);
  assert.equal(observationDir({}), null);
});

test("🔴 隐私闸：命令原文/参数/分段出现在观察行里一律拒收", () => {
  // 完整命令行含绝对路径（路径含本机用户名），这是第二道闸：上游漏了这里也不放行
  for (const bad of [
    { key: "npm test", count: 1, command: "npm test 2>&1" },
    { key: "npm test", count: 1, args: { a: 1 } },
    { key: "npm test", count: 1, segments: ["npm test"] },
    { key: "", count: 1 },
    { key: "npm test", count: 0 },
    { key: "npm test", count: 1.5 },
    { key: "npm test", count: 1, flags: "not-array" },
    null, "x", 42
  ]) {
    const r = validateObservationLine(bad);
    assert.equal(r.ok, false, JSON.stringify(bad) + " 不该通过");
  }
  // 合法形状（flags 可选）
  assert.equal(validateObservationLine({ key: "npm test", count: 3 }).ok, true);
  assert.equal(validateObservationLine({ key: "git status", count: 1, flags: ["--porcelain"] }).ok, true);
});

test("saveObservations：append-only + 按 confirmAt 幂等", () => {
  const dir = join(tmp, "obs-1");
  const acts = [{ key: "npm test", count: 5 }, { key: "git status", count: 2, flags: ["--porcelain"] }];
  const r1 = saveObservations({ dir, pipelineId: "demo", confirmAt: "2026-10-17T01:00:00.000Z", activities: acts });
  assert.equal(r1.ok, true);
  assert.equal(r1.lines, 2);
  assert.equal(existsSync(r1.file), true);

  // 同一 confirmAt 再写 → 幂等，不追加
  const r2 = saveObservations({ dir, pipelineId: "demo", confirmAt: "2026-10-17T01:00:00.000Z", activities: acts });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.lines, 0);
  assert.equal(readFileSync(r1.file, "utf8").trim().split("\n").length, 1, "文件只有一行");

  // 不同 confirmAt → 追加
  saveObservations({ dir, pipelineId: "demo", confirmAt: "2026-10-17T02:00:00.000Z", activities: acts });
  assert.equal(readFileSync(r1.file, "utf8").trim().split("\n").length, 2);
});

test("saveObservations：dryRun 只校验不落盘", () => {
  const dir = join(tmp, "obs-dry");
  const r = saveObservations({ dir, pipelineId: "demo", confirmAt: "2026-10-17T03:00:00.000Z", activities: [{ key: "npm test", count: 1 }], dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(existsSync(r.file), false, "dryRun 不许写文件");
});

test("saveObservations：坏行整体拒绝，不写半截", () => {
  const dir = join(tmp, "obs-bad");
  const r = saveObservations({
    dir, pipelineId: "demo", confirmAt: "2026-10-17T04:00:00.000Z",
    activities: [{ key: "npm test", count: 1 }, { key: "git add src/x.js", count: 1 }]
  });
  // "git add src/x.js" 是合法 key 形状吗？——是。真正被拒的是带原文的：
  // 这里第二条换成显式违规形状再测
  assert.equal(r.ok, true);

  const r2 = saveObservations({
    dir, pipelineId: "demo", confirmAt: "2026-10-17T05:00:00.000Z",
    activities: [{ key: "npm test", count: 1, command: "npm test" }]
  });
  assert.equal(r2.ok, false, "带命令原文的行必须整体拒");
  assert.match(r2.reason, /forbidden-field/);
});

test("loadObservations：读回 + 坏行计数不静默", () => {
  const dir = join(tmp, "obs-load");
  saveObservations({ dir, pipelineId: "demo", confirmAt: "2026-10-17T06:00:00.000Z", activities: [{ key: "npm test", count: 3 }] });
  // 手工塞一行坏 JSON + 一行形状不对的
  appendFileSync(join(dir, "demo.jsonl"), "{broken\n", "utf8");
  appendFileSync(join(dir, "demo.jsonl"), JSON.stringify({ contract: "wrong/v9", activities: [] }) + "\n", "utf8");
  const { records, unreadable } = loadObservations(dir, "demo");
  assert.equal(records.length, 1);
  assert.equal(unreadable, 2, "坏行要计数，不许静默");
});

test("🔴 toolMismatches：人确认 done 但声明的 tool 没出现 → 提议修表", () => {
  const r = toolMismatches({
    pipeline: PIPE,
    confirmedDone: new Set(["P6", "V1"]),
    activities: [{ key: "node --test", count: 9 }, { key: "git status", count: 4 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1, "P6 声明 npm test 但没出现 → 唯一不符");
  assert.equal(r.items[0].stepId, "P6");
  assert.equal(r.items[0].declared, "npm test");
  assert.deepEqual(r.items[0].observedTop, ["node --test ×9", "git status ×4"]);
  // V1 无 tool 声明 → 无从矛盾，不该出现
});

test("🔴 多锚点（a / b）任一出现即算对上", () => {
  const pipe = { id: "x", steps: [{ id: "P1", title: "看历史", tool: "git log / gh pr list" }] };
  const hit = toolMismatches({ pipeline: pipe, confirmedDone: new Set(["P1"]), activities: [{ key: "gh pr list", count: 2 }] });
  assert.equal(hit.items.length, 0, "第二个锚点出现了 → 不算不符");
  const miss = toolMismatches({ pipeline: pipe, confirmedDone: new Set(["P1"]), activities: [{ key: "git status", count: 2 }] });
  assert.equal(miss.items.length, 1);
});

test("🔴 unsure 与没答不进判据（没确认 ≠ 做了但没看到）", () => {
  const r = toolMismatches({
    pipeline: PIPE,
    confirmedDone: new Set([]),          // 什么都没确认
    activities: [{ key: "git status", count: 1 }]
  });
  assert.equal(r.items.length, 0, "没人说 done，就不该有任何「不符」提议");
});

test("坏输入不抛", () => {
  assert.equal(toolMismatches({ pipeline: null, confirmedDone: new Set(), activities: [] }).reason, "no-pipeline");
  assert.equal(toolMismatches({ pipeline: PIPE, confirmedDone: [], activities: [] }).reason, "bad-confirmed");
  assert.equal(toolMismatches({ pipeline: PIPE, confirmedDone: new Set(), activities: "x" }).reason, "bad-activities");
  assert.equal(saveObservations({}).reason, "no-dir");
  assert.equal(loadObservations(null, "demo").records.length, 0);
});
