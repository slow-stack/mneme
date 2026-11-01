import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSleepScheduler } from "../src/dream/sleep.js";

// Issue #529（C 项）：sleep 连续失败退避（sleepFailureBackoff，opt-in）。
//
// 报告里 C 的原案是「同一 snapshot_hash 连续失败就拉长间隔」，但 sleep 的
// snapshot_hash 是**跑完之后**对 phases 结果算的哈希（dream/sleep.js runSleep 里
// createHash(JSON.stringify(phases))），不是输入快照——同一批输入跑两次结果不同就
// 得到不同哈希，判据不成立。这里改用与 #292（autoDreamFailureBackoff）同构的
// 连续失败计数：有效间隔 = sleepMinIntervalHours × 2^连败数，成功清零，封顶 24h。
//
// 这些用例锁的是「退避语义」，防的回归是：
//   ① 退避闸失效/写反 → 恒定失败的模型按 sleepMinIntervalHours 的固定节奏连发
//      （#529 实测连续 23 轮 llm failed）；
//   ② 成功不清零 → 模型恢复后仍被旧失败拖着推迟，sleep 变相停摆；
//   ③ 24h 封顶失效 → 指数无限翻倍（8h 基数 × 2^5 = 10 天），睡眠维护彻底静默；
//   ④ 默认关路径被顺手改掉 → 未 opt-in 用户的重试间隔漂移；
//   ⑤ noop 被当成失败 → LLM 通路正常、只是库里没活干的库被越退越长。
//
// 时钟与定时器全部注入（同 test/sleep-scheduler-rearm.test.js 的房型）。

function makeHarness(overrides = {}) {
  let nowMs = 10_000_000;
  const timers = [];
  let seq = 1;
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  let runs = 0;
  let outcome = () => ({ ok: false, status: "failed" });
  const sched = createSleepScheduler({
    service,
    config: {
      sleepModeEnabled: true,
      sleepIdleMinutes: 5,
      sleepMinIntervalHours: 1,
      ...overrides
    },
    logger: { warn: () => {} },
    onRun: async () => {
      runs++;
      return outcome();
    },
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
    setOutcome: (fn) => { outcome = fn; },
    write: () => { nowMs += 1000; sched.noteWrite(); }
  };
}

const HOUR = 3_600_000;

test("issue#529 默认关：失败一次后重试间隔仍是基数，不翻倍", async () => {
  const h = makeHarness({ sleepFailureBackoff: false });
  h.write();
  await h.fireNext();
  assert.equal(h.runs(), 1, "idle 到点起跑一次");
  const t0 = h.now();
  assert.equal(h.sched.shouldRun(t0 + HOUR - 1), false, "基数间隔内照旧不放行");
  assert.equal(h.sched.shouldRun(t0 + HOUR), true, "关键：基数一到即放行——默认关不翻倍");
  h.store.close();
});

test("issue#529 开启：连败把下次放行时刻指数推迟", async () => {
  const h = makeHarness({ sleepFailureBackoff: true });
  h.write();
  await h.fireNext(); // 败 1 → 有效间隔 1h × 2^1 = 2h
  assert.equal(h.runs(), 1);
  const t1 = h.now();
  assert.equal(h.sched.shouldRun(t1 + HOUR), false, "关键：基数到点不放行（现状会放行）");
  assert.equal(h.sched.shouldRun(t1 + 2 * HOUR), true, "满 2h 才放行第 2 次");

  await h.fireNext(); // 败 2 → 有效间隔 4h
  assert.equal(h.runs(), 2);
  const t2 = h.now();
  assert.equal(h.sched.shouldRun(t2 + 3 * HOUR), false, "连败 2 次后 4h 内不放行");
  assert.equal(h.sched.shouldRun(t2 + 4 * HOUR), true, "满 4h 放行第 3 次");
  h.store.close();
});

test("issue#529 成功一次即清零、间隔回到基数", async () => {
  const h = makeHarness({ sleepFailureBackoff: true });
  h.write();
  await h.fireNext(); // 败 1 → 2h
  const t1 = h.now();
  assert.equal(h.sched.shouldRun(t1 + HOUR), false, "前置：退避确实在挡");

  h.setOutcome(() => ({ ok: true, status: "ok" }));
  await h.fireNext(); // 成功 → 连败清零
  const t2 = h.now();
  assert.equal(h.sched.shouldRun(t2 + HOUR), true, "关键：清零后基数即放行（未清零要等 2h）");
  h.store.close();
});

test("issue#529 封顶：连败 5 次推迟 24h 即止（未封顶需等 32h）", async () => {
  const h = makeHarness({ sleepFailureBackoff: true });
  h.write();
  await h.fireNext();
  for (let i = 2; i <= 5; i++) {
    const wait = Math.min(HOUR * 2 ** (i - 1), 24 * HOUR); // 与实现同一口径的期望间隔
    assert.equal(h.sched.shouldRun(h.now() + wait), true, `第 ${i} 次起跑前满 ${wait / HOUR}h`);
    await h.fireNext();
  }
  assert.equal(h.runs(), 5);
  const t = h.now();
  assert.equal(h.sched.shouldRun(t + 24 * HOUR - 1), false, "关键：封顶后 24h 内仍不放行");
  assert.equal(h.sched.shouldRun(t + 24 * HOUR), true, "封顶生效：24h 放行，不再翻倍");
  h.store.close();
});

test("issue#529 noop 不算失败：没活干的库不该被退避越拖越稀", async () => {
  const h = makeHarness({ sleepFailureBackoff: true });
  h.setOutcome(() => ({ ok: false, status: "noop" }));
  h.write();
  await h.fireNext();
  assert.equal(h.runs(), 1);
  const t0 = h.now();
  assert.equal(h.sched.shouldRun(t0 + HOUR), true, "关键：noop 后基数即放行（当作失败要等 2h）");
  h.store.close();
});

test("issue#529 抛错同样计入连败", async () => {
  const h = makeHarness({ sleepFailureBackoff: true });
  h.setOutcome(() => { throw new Error("boom"); });
  h.write();
  await h.fireNext();
  const t0 = h.now();
  assert.equal(h.sched.shouldRun(t0 + HOUR), false, "关键：抛错也退避到 2h");
  assert.equal(h.sched.shouldRun(t0 + 2 * HOUR), true);
  h.store.close();
});
