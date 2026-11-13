import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";
import { createSleepScheduler } from "../src/dream/sleep.js";

// 回归（issue #89）：调度器的 lastRunAt 只活在内存里，进程重启即归零——
// 最小间隔/冷却闸对新实例放行，重启后 autoDream/sleep 立即连发（Sample A/C 的
// 根因）。修复 = 构造调度器时从 dream_runs 审计表恢复种子（store.lastDreamRunAt，
// failed/degraded 也算 run，审计表本来就是逐 run 落库）。本文件锁三点：
//   1. lastDreamRunAt 读回最近一次 run 的开跑时刻（含 run_type 过滤）；
//   2. dream 调度器带种子构造后，重启场景下最小间隔闸门立即生效；
//   3. sleep 调度器带种子构造后，冷却期内不起跑、且按剩余窗口重排不丢触发权。

test("issue#89: store.lastDreamRunAt recovers the last run timestamp (with run_type filter)", () => {
  const store = createStore(":memory:");
  assert.equal(store.lastDreamRunAt(), 0, "empty trail → 0 (never ran)");
  assert.equal(store.lastDreamRunAt("sleep"), 0);
  store.saveDreamRun({ status: "ok", snapshot_hash: "h1", input_count: 1, receipt: "r", created_at: "2026-09-10T01:05:23.640Z", run_type: "auto" });
  store.saveDreamRun({ status: "ok", snapshot_hash: "h2", input_count: 1, receipt: "r", created_at: "2026-09-09T20:00:00.000Z", run_type: "sleep" });
  assert.equal(store.lastDreamRunAt(), Date.parse("2026-09-10T01:05:23.640Z"), "latest run regardless of type");
  assert.equal(store.lastDreamRunAt("sleep"), Date.parse("2026-09-09T20:00:00.000Z"), "filtered by run_type");
  assert.equal(store.lastDreamRunAt("auto"), Date.parse("2026-09-10T01:05:23.640Z"), "auto filter ignores sleep rows");
  store.close();
});

test("issue#89: dream scheduler seeded from the audit trail — restart no longer bypasses the min interval", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  // 模拟上一进程刚跑过一轮（10ms 前开跑）并留下审计行，然后「重启」：
  // minIntervalMs 取 1min——断言窗口远宽于用例执行时间，真实时钟抖动（调度、
  // 慢盘）不会把 10ms 偏移推出闸门外造成间歇性假失败。
  store.saveDreamRun({
    status: "ok", snapshot_hash: "h", input_count: 1, receipt: "r",
    created_at: new Date(Date.now() - 10).toISOString(), run_type: "auto"
  });
  const dream = createDreamScheduler({
    onRun: async () => ({ ok: false, error: "llm failed" }),
    thresholdCount: 1, thresholdChars: 0, delayMs: 0, minIntervalMs: 60000,
    lastRunAtSeed: store.lastDreamRunAt("auto"),
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  // 无种子时这里会返回 true（旧缺陷：重启后立刻连发）；带种子必须被闸门拦下。
  assert.equal(dream.maybeSchedule(service), false, "seeded gate blocks immediately after 'restart'");
  store.close();
});

test("issue#89: sleep scheduler seeded — cooldown survives a restart", async () => {
  let nowMs = 1_000_000;
  const timers = [];
  let seq = 1;
  let runs = 0;
  const lastRunAt = nowMs - 10 * 60_000; // 上一进程 10 分钟前跑过，CD 1h 还剩 50min
  const sched = createSleepScheduler({
    service: { enqueue: (fn) => fn() },
    config: testConfig({ sleepModeEnabled: true, sleepIdleMinutes: 5, sleepMinIntervalHours: 1 }),
    logger: { warn: () => {} },
    onRun: async () => { runs++; return { ok: true }; },
    now: () => nowMs,
    lastRunAtSeed: lastRunAt,
    setTimeoutFn: (fn, delay) => { const t = { id: seq++, at: nowMs + delay, fn }; timers.push(t); return t.id; },
    clearTimeoutFn: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
  });
  nowMs += 1000;
  sched.noteWrite(); // 挂 idle 闹钟
  const idleTimer = timers[0];
  assert.ok(idleTimer, "idle timer armed on write");
  nowMs = idleTimer.at;
  timers.length = 0;
  await idleTimer.fn();
  assert.equal(runs, 0, "restored cooldown blocks the run");
  const rearm = timers[0];
  assert.ok(rearm, "re-armed for the remaining cooldown window (not dropped, #187 semantics)");
  assert.equal(rearm.at, lastRunAt + 3_600_000 + 1000, "re-arms at CD expiry (+1s guard)");
});

// --- CodeRabbit #291 findings 5/6：index.js 的 seed 注入是单行无分支接线，仓库
// 没有插件级挂载 harness（apply 需要完整宿主 ctx），起全量挂载只为准两条断言
// 不成比例——改为源码级锁：删掉 index.js 的对应注入行即红。import 用绝对路径，
// 不依赖测试进程 CWD。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { testConfig } from "./helpers/test-config.js";
const indexSrc = readFileSync(fileURLToPath(new URL("../src/index.js", import.meta.url)), "utf8");

test("issue#89: index.js wires the dream scheduler seed from the audit trail", () => {
  assert.match(
    indexSrc,
    /lastRunAtSeed:\s*store\.lastDreamRunAt\("auto"\)/,
    "dream scheduler must seed its min-interval gate from dream_runs (run_type='auto') — remove this line and restart-bypass returns"
  );
});

test("issue#89: index.js wires the sleep scheduler seed from the audit trail", () => {
  assert.match(
    indexSrc,
    /lastRunAtSeed:\s*store\.lastDreamRunAt\("sleep"\)/,
    "sleep scheduler must seed its cooldown gate from dream_runs (run_type='sleep') — remove this line and restart-bypass returns"
  );
});
