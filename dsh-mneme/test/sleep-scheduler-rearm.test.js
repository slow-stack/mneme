import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSleepScheduler } from "../src/dream/sleep.js";
import { testConfig } from "./helpers/test-config.js";

// 回归（issue #187）：idle 计时器到点时若撞上 sleepMinIntervalHours（CD）未满，
// maybeSchedule 返回 false 后没有任何东西重排——armIdleTimer 的回调把返回值丢掉、
// idleTimer 已被置 null，"CD 到期"成了没有监听者的时刻，库里攒着待清理的新写入
// 却什么都不发生，要等用户恰好再写一次才救回来。两个断言方向：
//   1. 撞 CD 后必须按剩余窗口重排，CD 到点自行起跑；
//   2. 调度器构造时就该挂表——重启后零写入也应有闹钟（同族缺陷：无表可 firing）。
// 全程注入时钟/定时器，不依赖真实等待。

function makeHarness(overrides = {}) {
  let nowMs = 1_000_000;
  const timers = [];
  let seq = 1;
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  let runs = 0;
  const sched = createSleepScheduler({
    service,
    config: testConfig({ sleepModeEnabled: true, sleepIdleMinutes: 5, sleepMinIntervalHours: 1, ...overrides }),
    logger: { warn: () => {} },
    onRun: async () => { runs++; return { ok: true }; },
    now: () => nowMs,
    setTimeoutFn: (fn, delay) => {
      const t = { id: seq++, at: nowMs + delay, fn };
      timers.push(t);
      return t.id;
    },
    clearTimeoutFn: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    }
  });
  // 触发最早到点的那个表；回调内部可能再挂新表，继续留在队列里等下一次触发。
  const fireNext = async () => {
    timers.sort((a, b) => a.at - b.at);
    const t = timers.shift();
    if (!t) throw new Error("no armed timer to fire");
    nowMs = t.at;
    await t.fn();
  };
  return {
    sched,
    store,
    timers,
    fireNext,
    runs: () => runs,
    now: () => nowMs,
    write: () => { nowMs += 1000; sched.noteWrite(); }
  };
}

test("sleep #187: CD collision re-arms a timer instead of dropping the round", async () => {
  const h = makeHarness();
  h.write();
  await h.fireNext();
  assert.equal(h.runs(), 1, "first run fires after the idle window");
  const firstRunAt = h.now();

  h.write(); // 落在 CD 窗口内的写入（默认 8h 时几乎必中）
  await h.fireNext(); // idle 到点 → CD 未满 → 修复前：整轮被静默丢弃
  assert.ok(h.timers.length > 0, "a timer must be re-armed after the CD collision");
  await h.fireNext(); // 重排的表 → CD 到点 → 自行起跑
  assert.equal(h.runs(), 2, "second run fires on its own at the CD boundary");
  assert.ok(
    h.now() >= firstRunAt + 3_600_000,
    `second run must wait out the full min interval (fired at +${h.now() - firstRunAt}ms)`
  );
  h.store.close();
});

test("sleep #187: scheduler arms its first timer at construction (no write needed)", async () => {
  const h = makeHarness();
  assert.equal(h.timers.length, 1, "construction arms the idle timer");
  await h.fireNext();
  assert.equal(h.runs(), 1, "a quiet boot still reaches its first sleep cycle");
  h.store.close();
});

test("sleep #187: dispose cancels the construction-armed timer", async () => {
  const h = makeHarness();
  await h.sched.dispose();
  assert.equal(h.timers.length, 0, "dispose clears the armed timer");
  h.store.close();
});
