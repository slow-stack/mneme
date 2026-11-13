import test from "node:test";
import assert from "node:assert/strict";
import { createDreamScheduler } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

// Issue #239（第 4 项，错峰队列）镜像到巩固：dreamPeakHours / dreamPeakMaxDeferMinutes。
//
// 这些用例锁的是「排程语义」，不是实现细节——它们防的回归是：
//   ① 错峰闸门被写反/失效 → 高峰期又开始做梦（省钱能力静默消失）；
//   ② 顺延路径把 skip 做成静默 → 用户看到「不再巩固了」却查不出原因；
//   ③ 顺延没有上限 → 长高峰（如全天）把巩固永久饿死；
//   ④ 非法时段串被当成「全天高峰」→ 一个笔误把功能整个停掉；
//   ⑤ dispose 漏清顺延定时器 → 进程关掉后仍触发一次巩固。
//
// 时钟与定时器全部注入（同 src/dream/sleep.js 的房型）：排程不绑死真实时钟，
// 「高峰顺延 → 非高峰补跑」才能被确定性覆盖，也不会在 CI 上留下真实等待。
function dreamSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  return { store, service };
}

/** 本地墙钟时间：用本地时区构造，getHours() 在 ubuntu/windows CI 上都等于入参。 */
function at(hour, minute = 0) {
  return new Date(2026, 5, 15, hour, minute, 0, 0).getTime();
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

/** 造出「超过阈值」的写入量（thresholdCount=2）。 */
function fill(service, n = 2) {
  for (let i = 0; i < n; i++) service.saveWithDedupe({ type: "project", title: `m${i}`, content: "x".repeat(50) });
}

test("dreamPeakHours: 命中高峰不调模型，登记 skip 审计并顺延", () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(at(10, 0)); // 本地 10:00，落在 09:00-18:00 内
  let runs = 0;
  const audits = [];
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: true }; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 0,
    peakHours: "09:00-18:00",
    peakMaxDeferMinutes: 0, // 不设上限：顺延应落在真正的高峰结束时刻
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    auditPeakSkip: (info) => audits.push(info)
  });
  fill(service);
  assert.equal(dream.maybeSchedule(service), false, "高峰内不排「马上跑」");
  assert.equal(runs, 0, "高峰内绝不调 LLM");
  assert.equal(audits.length, 1, "skip 必须留痕，否则「为什么不再巩固」不可观测");
  assert.equal(audits[0].count, 2, "审计带上窗口里积了多少（阈值继续累积，不是丢弃）");
  assert.equal(clock.timers.length, 1, "挂了一个顺延定时器");
  assert.equal(clock.timers[0].at, at(18, 0), "顺延到最近的高峰结束时刻");
  store.close();
});

test("dreamPeakHours: 顺延到点后补跑（非高峰真的会跑）", async () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(at(10, 0));
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: true }; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 0,
    peakHours: "09:00-18:00",
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    auditPeakSkip: () => {}
  });
  fill(service);
  dream.maybeSchedule(service);
  const deferred = clock.timers[0];
  clock.setNow(deferred.at); // 走到 18:00
  await deferred.fn();
  assert.equal(runs, 1, "出高峰后补跑一次");
  store.close();
});

test("dreamPeakHours: 重复触发不叠加顺延定时器", () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(at(10, 0));
  let audits = 0;
  const dream = createDreamScheduler({
    onRun: async () => ({ ok: true }),
    thresholdCount: 2, thresholdChars: 5000, delayMs: 0,
    peakHours: "09:00-18:00",
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    auditPeakSkip: () => { audits++; }
  });
  fill(service);
  dream.maybeSchedule(service);
  dream.maybeSchedule(service); // 顺延期间又来一次写入触发
  assert.equal(clock.timers.length, 1, "同一时刻只有一个顺延定时器");
  assert.equal(audits, 1, "不重复刷审计行");
  store.close();
});

test("dreamPeakMaxDeferMinutes: 上限截断后到点照跑，长高峰不饿死巩固", async () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(at(10, 0));
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: true }; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 0,
    peakHours: "00:00-23:59", // 全天高峰：不设上限就会顺延到 23:59
    peakMaxDeferMinutes: 120,
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    auditPeakSkip: () => {}
  });
  fill(service);
  dream.maybeSchedule(service);
  const t = clock.timers[0];
  assert.equal(t.at, at(12, 0), "被上限截断到 120 分钟后（而不是等到 23:59）");
  clock.setNow(t.at);
  await t.fn();
  assert.equal(runs, 1, "截断放行：仍在高峰也照跑，避免无限顺延");
  store.close();
});

test("dreamPeakHours: 非法时段串按「未配置」处理（宁可不省，也不能误停）", async () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(at(10, 0));
  let runs = 0;
  let audits = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: true }; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 0,
    peakHours: "10:00-99:00", // 非法：解析失败必须回落成「关闭」
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    auditPeakSkip: () => { audits++; }
  });
  fill(service);
  assert.equal(dream.maybeSchedule(service), true, "非法串 = 未配置 → 走原有触发路径");
  assert.equal(audits, 0, "不写 skip 审计");
  const t = clock.timers[0];
  clock.setNow(t.at);
  await t.fn();
  assert.equal(runs, 1, "巩固照常进行");
  store.close();
});

test("dreamPeakHours: 非高峰时段不受影响（行为与现状一致）", async () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(at(20, 0)); // 本地 20:00，在 09:00-18:00 之外
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: true }; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 5,
    peakHours: "09:00-18:00",
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    auditPeakSkip: () => { throw new Error("非高峰不该写 skip 审计"); }
  });
  fill(service);
  assert.equal(dream.maybeSchedule(service), true, "非高峰照常排程");
  const t = clock.timers[0];
  assert.equal(t.at, at(20, 0) + 5, "走的是 delayMs 的「马上跑」路径，不是顺延路径");
  clock.setNow(t.at);
  await t.fn();
  assert.equal(runs, 1);
  store.close();
});

test("dreamPeakHours: dispose 清掉顺延定时器，进程关闭后不再触发巩固", async () => {
  const { store, service } = dreamSetup();
  const clock = fakeClock(at(10, 0));
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: true }; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 0,
    peakHours: "09:00-18:00",
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    auditPeakSkip: () => {}
  });
  fill(service);
  dream.maybeSchedule(service);
  const t = clock.timers[0];
  await dream.dispose();
  assert.equal(clock.timers.length, 0, "顺延定时器已清");
  clock.setNow(t.at);
  await t.fn(); // 模拟「定时器已经进了事件队列，清不掉」的那一帧
  assert.equal(runs, 0, "disposed 守卫拦住补跑");
  store.close();
});
