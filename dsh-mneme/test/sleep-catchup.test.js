import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { createSleepScheduler, runSleep } from "../src/dream/sleep.js";

// Issue #529（续排）：本轮被预算截断（conflict 相位还有没进这一轮的对）且送出去的每一对
// 都落地了时，调度器不该等满一个 sleepMinIntervalHours（默认 8h）才跑下一轮——池子没清空，
// 剩下的对只能等到下一次到点，等于把"分批"变成"隔夜慢慢分批"。
//
// 这一组用例锁的是续排语义，防的回归是：
//   ① 判据拿 status 反推 → 全判 keep 的轮次 applied 恒为 0、status 是 noop（永远到不了 ok），
//      续排在最该追的场景静默失效；
//   ② 只把冷却项改成 0、不在回调里补挂闹钟 → 续排只追一轮就断，剩下的对又回到隔夜等；
//   ③ 不限制连击 → 用户持续写入时池子进得比追得快，变成永不落地的每五分钟一轮，
//      而审计上每轮都"有产出"，肉眼很难发现；
//   ④ 失败轮也追 → 与连败退避抢同一只闹钟，退避被自己踩空。

const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

function mockCtx(responder) {
  let call = 0;
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        let reply = "[]";
        if (options.purpose === "sleep-conflict") reply = responder(userText, ++call);
        yield { type: "text-delta", index: 0, text: reply };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex };
}

// 全部推到同一个方向附近：任意两条的 cosine 都 ≈ 1，findPotentialConflicts 生成 C(n,2) 对，
// 去重阶段按相似度留下 n/2 对（每记忆至多一对）。
function seedSimilarPairs(service, vectorIndex, n) {
  for (let i = 0; i < n; i++) {
    const m = service.saveWithDedupe({ type: "project", title: `主题${i}`, content: `内容${i}`, importance: 3 }).memory;
    vectorIndex.saveEmbedding(m.id, [1, 0, 0]);
  }
}

function baseConfig(overrides = {}) {
  return {
    sleepModeEnabled: true,
    sleepIdleMinutes: 5,
    sleepMinIntervalHours: 8,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,
    sleepCompressDays: 90,
    sleepPatternMinMemories: 100,
    sleepMaxPatternPerRun: 3,
    ...overrides
  };
}

// 与 test/sleep-failure-backoff.test.js 同款房型：时钟与定时器全部注入。
function makeHarness(overrides = {}) {
  let nowMs = 10_000_000;
  const timers = [];
  let seq = 1;
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  let runs = 0;
  let outcome = () => ({ ok: true, status: "noop" });
  // 运行**期间**要发生的事（写入 / 耗时）——用来复现"跑完那一刻已挂着的表只剩几秒"。
  let duringRun = null;
  const sched = createSleepScheduler({
    service,
    config: { sleepModeEnabled: true, sleepIdleMinutes: 5, sleepMinIntervalHours: 1, ...overrides },
    logger: { warn: () => {} },
    onRun: async () => {
      runs++;
      if (duringRun) await duringRun();
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
    setDuringRun: (fn) => { duringRun = fn; },
    write: () => { nowMs += 1000; sched.noteWrite(); },
    advance: (ms) => { nowMs += ms; }
  };
}

const MIN = 60_000;
const HOUR = 3_600_000;

test("issue#529 续排：clean + 还有没进这一轮的对 ⇒ 下一个闹钟钉在静默窗口，不等最小间隔", async () => {
  const h = makeHarness();
  h.setOutcome(() => ({ ok: false, status: "noop", catchup: true, backlog: true }));
  h.write();
  await h.fireNext();
  assert.equal(h.runs(), 1, "静默到点起跑一轮");
  assert.equal(h.timers.length, 1, "关键：追 backlog 的轮次跑完必须自己补挂闹钟（此前一条都不挂）");
  const delay = h.timers[0].at - h.now();
  assert.equal(delay, 5 * MIN + 1000, "下限是一个静默窗口，不是 1 秒也不是 1 小时");

  await h.fireNext();
  assert.equal(h.runs(), 2, "关键：闹钟真的起跑了第二轮（只补挂不起跑等于没追）");
  h.store.close();
});

test("issue#529 续排：不 clean 时不追，间隔回到最小间隔", async () => {
  const h = makeHarness();
  h.setOutcome(() => ({ ok: true, status: "degraded", catchup: false, backlog: true }));
  h.write();
  await h.fireNext();
  assert.equal(h.runs(), 1);
  assert.equal(h.timers.length, 0, "有对没落地 ⇒ 不补挂短闹钟，等下一次写入重新起算");
  const t = h.now();
  assert.equal(h.sched.shouldRun(t + HOUR - 1), false, "冷却仍是基数间隔");
  assert.equal(h.sched.shouldRun(t + HOUR), true);
  h.store.close();
});

test("issue#529 续排：运行期间用户写入挂的表要在收尾时重挂，不能剩几秒就开下一批", async () => {
  const h = makeHarness();
  h.setOutcome(() => ({ ok: false, status: "noop", catchup: true, backlog: true }));
  h.write();
  // 运行一开始就按静默窗口挂好了表（at = 起跑时刻 + 5min + 1s）。
  const armedAt = h.timers[0].at;
  h.setDuringRun(async () => {
    // 运行早期用户又写了一次：noteWrite 撤表重挂，新表从**那一刻**起算。
    h.advance(MIN);
    h.write();
    // 这一轮本身跑了很久（LLM 往返 + 落库），早就越过那只表的到点时刻。真实环境里
    // 这只表此刻已经可以立即触发——收尾若不重挂，下一批就是"几秒后开跑"，
    // 「让库安静一个静默窗口再追」形同虚设。
    h.advance(10 * MIN);
  });
  await h.fireNext();
  assert.equal(h.runs(), 1);
  assert.ok(h.now() > armedAt, "前置：这一轮确实跑过了原来那只表的到点时刻");
  assert.equal(h.timers.length, 1, "收尾必须只剩（重挂的）一只表");
  assert.equal(h.timers[0].at - h.now(), 5 * MIN + 1000, "关键：从**收尾这一刻**重算整一个静默窗口，不是沿用运行期挂的旧表");
  h.store.close();
});

test("issue#529 续排：台账写入失败要让这一轮不 clean，不能每个静默窗口重问同一个冲突", async () => {
  const { service, store, vectorIndex } = setup();
  seedSimilarPairs(service, vectorIndex, 8);
  // 留痕写不进去：这一对既没被记成"已审"，下一轮还会原样回到候选池。若仍判 clean，
  // 续排会一个静默窗口问一次 LLM、直到连击上限，而审计上每轮都是干净的成功轮。
  service.saveConflictReviewed = () => {
    throw new Error("ledger unavailable");
  };
  const ctx = mockCtx(() => "[]");
  const config = baseConfig({ sleepConflictMaxPairs: 1, sleepConflictMaxPairsPerRun: 2 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.ok(result.phases.conflicts.ledgerFailed > 0, "前置：确实有留痕写入失败");
  assert.equal(result.phases.conflicts.clean, false, "关键：没记上账就不算落地");
  assert.equal(result.catchup, false, "不 clean ⇒ 不追下一批，回到正常节奏");
  store.close();
});

test("issue#529 续排：失败轮不追（与连败退避互斥）", async () => {
  const h = makeHarness({ sleepFailureBackoff: true });
  h.setOutcome(() => ({ ok: false, status: "failed", catchup: true, backlog: true }));
  h.write();
  await h.fireNext();
  // 失败本身仍然要补挂（#187：不补挂就永远等不到下一轮），但补的是**退避后的**长表，
  // 不是续排那张静默窗口的短表——这才是"互斥"的可观测形态。
  assert.equal(h.timers.length, 1, "失败轮按 #187 仍补挂一张表");
  assert.equal(h.timers[0].at - h.now(), 2 * HOUR + 1000, "补的是 1h × 2^1 的退避表，不是 5 分钟的续排表");
  const t = h.now();
  assert.equal(h.sched.shouldRun(t + 2 * HOUR - 1), false, "退避仍然生效（1h 基数 × 2^1）");
  assert.equal(h.sched.shouldRun(t + 2 * HOUR), true);
  h.store.close();
});

test("issue#529 续排：连击到上限即收手，闹钟回到正常间隔", async () => {
  const h = makeHarness();
  // 用 runSleep 的真实返回形状：全判 keep 的一轮 status 是 noop，而 ok 只在
  // ok/degraded 时为真——桩里写 ok:true 会让 maybeSchedule 走进与真实路径不同的分支
  // （!ran 那条），于是「到顶后没有定时器」测的其实是桩的偏差，不是实现的行为。
  h.setOutcome(() => ({ ok: false, status: "noop", catchup: true, backlog: true }));
  h.write();
  await h.fireNext();
  // 24 是实现里的 CATCHUP_STREAK_CAP：每轮都 clean 但池子永远追不完时，必须自己刹住。
  for (let i = 2; i <= 24; i++) {
    assert.equal(h.timers.length, 1, `第 ${i} 轮之前应当有一只已挂好的闹钟`);
    await h.fireNext();
  }
  assert.equal(h.runs(), 24, "连追 24 轮");
  const t = h.now();
  assert.equal(h.sched.shouldRun(t + 5 * MIN), false, "收手后回到最小间隔，不再按静默窗口放行");
  assert.equal(h.sched.shouldRun(t + HOUR), true);
  // 收手后既不能是「一直按静默窗口重排」（空转链），也不能是「什么都不挂」
  // （#187：CD 到期成了没有监听者的时刻）。正确形态是回到正常的最小间隔。
  assert.equal(h.timers.length, 1, "按 #187 补挂一张表，但不能是续排的短表");
  assert.equal(h.timers[0].at - h.now(), HOUR + 1000, "补的是正常最小间隔，不是 5 分钟的续排表");
  h.store.close();
});

test("issue#529 续排：全判 keep 的一轮 status=noop 仍是 clean，续排判据不依赖 status", async () => {
  const { service, store, vectorIndex } = setup();
  seedSimilarPairs(service, vectorIndex, 8);
  const ctx = mockCtx(() => "[]");
  const config = baseConfig({ sleepConflictMaxPairs: 1, sleepConflictMaxPairsPerRun: 2 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.applied, 0, "全判 keep ⇒ 没有任何落地");
  assert.equal(result.phases.conflicts.status, "noop", "关键：这一轮永远到不了 ok（拿 status 当判据就死在这里）");
  assert.ok(result.phases.conflicts.perRunSkipped > 0, "前置：本轮确实被预算截断");
  assert.equal(result.phases.conflicts.clean, true, "送出去的每一对都留了台账 ⇒ clean");
  assert.equal(result.catchup, true, "关键：noop 轮次也要能追");
  assert.equal(result.backlog, true);
  store.close();
});

test("issue#529 续排：坏批让这一轮不 clean，即使还有 backlog 也不追", async () => {
  const { service, store, vectorIndex } = setup();
  seedSimilarPairs(service, vectorIndex, 8);
  let call = 0;
  // 第一批吐空（stream 正常结束但没有 JSON 数组 ⇒ 这批 failed），后面的批正常。
  const ctx = mockCtx(() => (++call === 1 ? "" : "[]"));
  const config = baseConfig({ sleepConflictMaxPairs: 1, sleepConflictMaxPairsPerRun: 2 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.backlog, true, "前置：确实有对没进这一轮");
  assert.equal(result.phases.conflicts.clean, false, "有批没走通 ⇒ 不 clean");
  assert.equal(result.catchup, false, "关键：不 clean 时宁可少追一轮，也不要在失败状态里把间隔压到静默窗口");
  store.close();
});

test("issue#529 续排：连击到顶收手之后，下一次正常触发要能重新起算（刹车不能变成永久闸）", async () => {
  const h = makeHarness();
  h.setOutcome(() => ({ ok: false, status: "noop", catchup: true, backlog: true }));
  h.write();
  await h.fireNext();
  for (let i = 2; i <= 24; i++) await h.fireNext();
  assert.equal(h.runs(), 24);
  assert.equal(h.timers[0].at - h.now(), HOUR + 1000, "前置：到顶后已收手，闹钟回到正常间隔");

  // 收手若只把 catchupWanted 置 false、**不把连击清零**，这个进程此后每一轮都会被同一道闸
  // 挡下（streak 只增不减），"等下一个静默窗口重新起算"就成了一句空话。
  h.write();
  for (let i = 0; i < 5 && h.runs() < 25; i++) await h.fireNext();
  assert.equal(h.runs(), 25, "关键：收手之后仍能被正常触发救回来");
  assert.equal(h.timers.length, 1, "重新起算后又该补挂续排闹钟");
  assert.equal(h.timers[0].at - h.now(), 5 * MIN + 1000, "补的是静默窗口的短表，说明连击已从 0 重新算");
  h.store.close();
});

test("issue#529 续排：一轮抛错要把连击一并清零，不能把上一轮的进度带进下一次起算", async () => {
  const h = makeHarness();
  // 同上面两条：runSleep 在 status==="noop" 时给 ok:false，桩要照它写。
  const clean = () => ({ ok: false, status: "noop", catchup: true, backlog: true });
  h.setOutcome(clean);
  h.write();
  await h.fireNext();
  // 先追到 23（上限 24 的前一格）：此时连击若不被清掉，下一轮 clean 就会立刻撞上限。
  for (let i = 2; i <= 23; i++) await h.fireNext();
  assert.equal(h.runs(), 23);

  h.setOutcome(() => {
    throw new Error("boom");
  });
  h.write();
  await h.fireNext();
  assert.equal(h.runs(), 24, "第 24 轮抛错");
  assert.equal(h.timers.length, 1, "抛错仍按 #187 补挂一张表（补的是退避长表）");
  assert.equal(h.timers[0].at - h.now(), HOUR + 1000, "抛错后回落到最小间隔，续排的短表不再挂");

  // 关键：抛错回合若不把 catchupStreak 清零，接下来这一轮 clean 的连击会从 23 累到 24，
  // 于是"刚被救回来"的进程立刻又被同一道闸挡下。
  h.setOutcome(clean);
  await h.fireNext();
  assert.equal(h.runs(), 25, "抛错后的第一次干净轮次仍要真的跑");
  assert.equal(h.timers.length, 1, "关键：连击已清零，这一轮又能挂上续排闹钟");
  assert.equal(h.timers[0].at - h.now(), 5 * MIN + 1000);
  h.store.close();
});
