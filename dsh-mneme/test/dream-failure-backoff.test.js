import test from "node:test";
import assert from "node:assert/strict";
import { createDreamScheduler } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

// Issue #292：autoDream 同会话内连续失败退避（autoDreamFailureBackoff，opt-in）。
//
// 这些用例锁的是「调度器节流语义」，不是实现细节——防的回归是：
//   ① 退避闸失效/写反 → 恒定失败的模型（#135 空体面）按 dreamMinIntervalMinutes
//      的固定节奏连发刷配额（#89 只挡了间隔内重试，间隔本身不会变长）；
//   ② 成功后连败计数不清零 → 模型恢复正常后仍被旧失败拖着重试推迟（巩固变相停摆）；
//   ③ 30 分钟封顶失效 → 指数无限翻倍，一整天都不再巩固；
//   ④ 默认关路径被顺手改掉 → 未 opt-in 用户的重试间隔漂移（默认关 = 行为与
//      现状逐字节一致的承诺）；
//   ⑤ 0 基数被偷偷补了间隔 → 未配 dreamMinIntervalMinutes 的用户开退避即被限流
//      （文档口径：基数 0 时本键不自己产生间隔）。
//
// 时钟与定时器全部注入（同 test/dream-peak-hours.test.js 的房型）：「失败 → 推迟
// → 放行」才能被确定性覆盖，也不在 CI 上留真实等待。退避从上次开跑（lastRunAt）
// 起算：失败 run 本就占用基数间隔（#89 现状，lastRunAt 在开跑时刷新），退避放大
// 的是同一道闸，不新增状态面。
function dreamSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  return { store, service };
}

function fakeClock(startMs) {
  let nowMs = startMs;
  const timers = [];
  let seq = 1;
  return {
    now: () => nowMs,
    setNow: (v) => { nowMs = v; },
    timers,
    setTimeoutFn: (fn, delay) => { const t = { id: seq++, at: nowMs + delay, fn }; timers.push(t); return t.id; },
    clearTimeoutFn: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
  };
}

const T0 = new Date(2026, 8, 27, 10, 0, 0, 0).getTime();

/**
 * 触发一次并等 run 真正落完：断言闸门这次是放行的、恰好挂了一个 delayMs=0 的
 * 执行定时器，点火后用 setImmediate 冲掉 startRun 的 Promise 链（纯微任务冲刷，
 * 不留真实等待）。失败路径下 baseline 不刷新，同一份写入可持续触发。
 */
async function runOnce(clock, dream, service) {
  assert.equal(dream.maybeSchedule(service), true, "前置：阈值已过、间隔闸放行");
  const ts = clock.timers.splice(0);
  assert.equal(ts.length, 1, "前置：恰好挂了一个执行定时器");
  ts[0].fn();
  await new Promise((r) => setImmediate(r));
}

test("默认关：失败后重试间隔与现状一致（基数，不翻倍）", async () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(T0);
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: false, error: "llm failed" }; },
    thresholdCount: 1, thresholdChars: 0, delayMs: 0, minIntervalMs: 100,
    failureBackoff: false, // 显式默认值：锁「默认关 = 行为逐字节不变」
    logger: { warn: () => {} },
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  await runOnce(clock, dream, service); // 失败一次：失败 run 占用基数间隔（#89 现状）
  assert.equal(runs, 1);
  clock.setNow(T0 + 50);
  assert.equal(dream.maybeSchedule(service), false, "基数间隔内照旧跳过");
  clock.setNow(T0 + 100);
  assert.equal(dream.maybeSchedule(service), true, "关键：基数间隔一到即放行——不翻倍");
  store.close();
});

test("开启：连续失败 2 次 → 第 3 次触发被指数推迟", async () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(T0);
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: false, error: "empty body" }; },
    thresholdCount: 1, thresholdChars: 0, delayMs: 0, minIntervalMs: 100,
    failureBackoff: true,
    logger: { warn: () => {} },
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  await runOnce(clock, dream, service); // 败 1：effective = 100 × 2^1 = 200
  assert.equal(runs, 1);
  clock.setNow(T0 + 100);
  assert.equal(dream.maybeSchedule(service), false, "关键：基数到点不放行（现状会在 +100 放行）");
  clock.setNow(T0 + 200);
  await runOnce(clock, dream, service); // 败 2：effective = 100 × 2^2 = 400
  assert.equal(runs, 2);
  clock.setNow(T0 + 200 + 300);
  assert.equal(dream.maybeSchedule(service), false, "关键：2 次连败后 400ms 内不放行");
  clock.setNow(T0 + 200 + 400);
  assert.equal(dream.maybeSchedule(service), true, "自上次开跑起满 400ms 才放行第 3 次");
  store.close();
});

test("成功一次后计数清零、间隔恢复基数", async () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(T0);
  let failNext = true;
  const dream = createDreamScheduler({
    onRun: async () => ({ ok: !failNext }),
    thresholdCount: 1, thresholdChars: 0, delayMs: 0, minIntervalMs: 100,
    failureBackoff: true,
    logger: { warn: () => {} },
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  await runOnce(clock, dream, service); // 败 1：effective = 200
  clock.setNow(T0 + 100);
  assert.equal(dream.maybeSchedule(service), false, "前置：退避确实在挡（基数到点不放行）");
  clock.setNow(T0 + 200);
  failNext = false;
  await runOnce(clock, dream, service); // 成功：连败清零、baseline 刷新为当前库量
  service.saveWithDedupe({ type: "project", title: "b", content: "y" }); // 补过刷新后的阈值
  clock.setNow(T0 + 300); // 距上次开跑 +100 = 基数
  assert.equal(dream.maybeSchedule(service), true, "关键：成功清零后基数即放行（未清零要等 +400）");
  store.close();
});

test("cap：连败 10 次 → 推迟量封顶 30 分钟（未封顶需等约 34 小时）", async () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(T0);
  const BASE = 2 * 60000; // 2 分钟基数：2^10 × 基数 ≈ 34h，30 分钟封顶必被触发
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: false }; },
    thresholdCount: 1, thresholdChars: 0, delayMs: 0, minIntervalMs: BASE,
    failureBackoff: true,
    logger: { warn: () => {} },
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  let lastFailAt = T0;
  for (let i = 1; i <= 10; i++) {
    if (i > 1) {
      const wait = Math.min(BASE * 2 ** (i - 1), 30 * 60000); // 与实现同一口径的期望间隔
      clock.setNow(lastFailAt + wait);
    }
    await runOnce(clock, dream, service);
    lastFailAt = clock.now();
  }
  assert.equal(runs, 10);
  clock.setNow(lastFailAt + 30 * 60000 - 1);
  assert.equal(dream.maybeSchedule(service), false, "关键：封顶后 30 分钟内仍不放行");
  clock.setNow(lastFailAt + 30 * 60000);
  assert.equal(dream.maybeSchedule(service), true, "封顶生效：恰好 30 分钟放行，不再随失败数翻倍");
  store.close();
});

test("基数为 0 时退避不自己产生间隔（需先配 dreamMinIntervalMinutes）", async () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(T0);
  const dream = createDreamScheduler({
    onRun: async () => ({ ok: false }),
    thresholdCount: 1, thresholdChars: 0, delayMs: 0, minIntervalMs: 0,
    failureBackoff: true,
    logger: { warn: () => {} },
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  await runOnce(clock, dream, service); // 失败一次
  clock.setNow(T0);
  assert.equal(dream.maybeSchedule(service), true, "关键：0 基数无闸可翻倍，开退避也不限流");
  store.close();
});
