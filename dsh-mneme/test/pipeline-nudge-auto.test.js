import test from "node:test";
import assert from "node:assert/strict";
import { createNudgeAutoRun } from "../src/pipeline-nudge-auto.js";
import { createSessionGate } from "../src/session-gate.js";

// 这组守的是**触发侧**（v0.9.3）：什么时候跑、跑几次、跑挂了怎么办。
// 挖掘算法本身在 pipeline-nudge.test.js 里守，这里只守接线，所以 runNudge 全部用假的。

/** 一个假 ctx：只提供 session/event 的订阅面（真宿主用同一个口）。 */
function fakeCtx() {
  const listeners = [];
  return {
    logger: { info() {}, warn() {} },
    on(name, fn) {
      if (name !== "session/event") throw new Error("unexpected event: " + name);
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    emit(session, event) {
      for (const fn of listeners.slice()) fn(session, event);
    },
    count: () => listeners.length
  };
}

function sessionAt(cwd, id = undefined) {
  return { ...(id ? { id } : {}), header: { cwd } };
}

/** 把 setTimeout(0) 排的活跑完：本模块刻意不用同步跑（见文件头）。 */
function tick(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等到条件成立。队列是**链式**排程（跑完一个再 defer 下一个），所以「两个项目都跑完」
 * 至少要等两个宏任务;固定 tick(30) 在满载的 CI 上会假阴性——全量跑时其它测试文件
 * 同时解压 zstd，一次 setTimeout(0) 被拉长就可能超过 30ms。这里只等该等的东西。
 */
async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

test("自动沉淀只认 turn/end：中途事件不排队、不预跑", async () => {
  const ctx = fakeCtx();
  const calls = [];
  const auto = createNudgeAutoRun({
    ctx,
    runNudge: (args) => { calls.push(args); return { counts: { savedProposals: 0 } }; },
    now: () => 1_000_000
  });
  ctx.emit(sessionAt("D:/proj"), { type: "turn/start" });
  ctx.emit(sessionAt("D:/proj"), { type: "message" });
  await tick();
  assert.deepEqual(calls, [], "一轮没结束就不是观测窗口");
  ctx.emit(sessionAt("D:/proj"), { type: "turn/end" });
  await tick();
  assert.equal(calls.length, 1);
  auto();
});

test("#539：无痕 turn/end 不触发全项目扫描，正常会话仍可触发", async () => {
  const ctx = fakeCtx();
  const calls = [];
  const gate = createSessionGate({ sessionGateEnabled: true, sessionGateSessions: ["private"] });
  const auto = createNudgeAutoRun({
    ctx,
    sessionGate: gate,
    runNudge: (args) => { calls.push(args); return { counts: { savedProposals: 0 } }; },
    now: () => 1_000_000
  });

  ctx.emit(sessionAt("D:/proj", "private"), { type: "turn/end" });
  await tick();
  assert.deepEqual(calls, [], "the incognito session itself cannot schedule a scan");
  assert.equal(auto.pendingCount(), 0);

  ctx.emit(sessionAt("D:/proj", "captain"), { type: "turn/end" });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionGate, gate, "later project scans still exclude incognito session files");
  auto();
});

test("自动跑永远是「只落提议、不落草稿」：materialize 恒 false", async () => {
  const ctx = fakeCtx();
  const calls = [];
  const auto = createNudgeAutoRun({
    ctx,
    memoryDir: "D:/memory",
    runNudge: (args) => { calls.push(args); return { counts: { savedProposals: 0 } }; },
    now: () => 1_000_000
  });
  ctx.emit(sessionAt("D:/proj"), { type: "turn/end" });
  await tick();
  assert.equal(calls.length, 1);
  // 这三条是边界，不是偏好：往别人仓库里塞文件必须是人的显式动作。
  assert.equal(calls[0].materialize, false, "自动跑不许落草稿");
  assert.equal(calls[0].persistProposals, true, "提议要落进记忆库");
  assert.equal(calls[0].memoryDir, "D:/memory");
  auto();
});

test("同一个项目在冷却期内不重跑（观测新鲜度，不是防重复写盘）", async () => {
  const ctx = fakeCtx();
  const calls = [];
  let clock = 1_000_000;
  const auto = createNudgeAutoRun({
    ctx,
    runNudge: (args) => { calls.push(args); return { counts: { savedProposals: 0 } }; },
    now: () => clock,
    minIntervalMs: 10_000
  });
  ctx.emit(sessionAt("D:/proj"), { type: "turn/end" });
  await tick();
  assert.equal(calls.length, 1);
  // 冷却期内：再来几轮也不跑。
  ctx.emit(sessionAt("D:/proj"), { type: "turn/end" });
  ctx.emit(sessionAt("D:/proj"), { type: "turn/end" });
  await tick();
  assert.equal(calls.length, 1, "十分钟内同一个项目只跑一次");
  // 过了冷却就该跑。
  clock += 20_000;
  ctx.emit(sessionAt("D:/proj"), { type: "turn/end" });
  await tick();
  assert.equal(calls.length, 2);
  auto();
});

test("冷却按项目分账：另一个项目不受影响，也不许并成一次", async () => {
  const ctx = fakeCtx();
  const roots = [];
  const auto = createNudgeAutoRun({
    ctx,
    runNudge: (args) => { roots.push(args.projectRoot); return { counts: { savedProposals: 0 } }; },
    now: () => 1_000_000,
    minIntervalMs: 10_000
  });
  ctx.emit(sessionAt("D:/a"), { type: "turn/end" });
  ctx.emit(sessionAt("D:/b"), { type: "turn/end" });
  assert.ok(await waitFor(() => roots.length === 2), "两个项目都该被跑到");
  assert.deepEqual(roots.sort(), ["D:/a", "D:/b"], "两个项目各跑一次，跨项目不并账");
  auto();
});

test("冷却键不区分大小写与尾斜杠（Windows 同一个项目别算成两个）", async () => {
  const ctx = fakeCtx();
  const calls = [];
  let clock = 1_000_000;
  const auto = createNudgeAutoRun({
    ctx,
    runNudge: (args) => { calls.push(args); return { counts: { savedProposals: 0 } }; },
    now: () => clock,
    minIntervalMs: 10_000
  });
  ctx.emit(sessionAt("D:/Proj"), { type: "turn/end" });
  await tick();
  ctx.emit(sessionAt("d:\\proj\\"), { type: "turn/end" });
  await tick();
  assert.equal(calls.length, 1, "同一个项目换个写法不该被当成新项目");
  auto();
});

test("挖挂了不许冒泡：session/event 那条链上还挂着摘要与续期", async () => {
  const ctx = fakeCtx();
  let ran = 0;
  const auto = createNudgeAutoRun({
    ctx,
    logger: { info() {}, warn() {} },
    runNudge: () => { ran += 1; throw new Error("boom"); },
    now: () => 1_000_000
  });
  ctx.emit(sessionAt("D:/proj"), { type: "turn/end" });
  await assert.doesNotReject(tick().then(() => {}), "定时回调里的异常不许掀翻宿主");
  assert.equal(ran, 1);
  auto();
});

test("没有 cwd 的会话不排队（归属不明就别猜）", async () => {
  const ctx = fakeCtx();
  const calls = [];
  const auto = createNudgeAutoRun({
    ctx,
    runNudge: (args) => { calls.push(args); return { counts: { savedProposals: 0 } }; },
    now: () => 1_000_000
  });
  ctx.emit({ header: {} }, { type: "turn/end" });
  ctx.emit(null, { type: "turn/end" });
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(auto.pendingCount(), 0);
  auto();
});

test("dispose 之后：取消订阅、清掉排队的活，runNow 也不再跑", async () => {
  const ctx = fakeCtx();
  const calls = [];
  const auto = createNudgeAutoRun({
    ctx,
    runNudge: (args) => { calls.push(args); return { counts: { savedProposals: 0 } }; },
    now: () => 1_000_000
  });
  ctx.emit(sessionAt("D:/proj"), { type: "turn/end" });
  auto();
  assert.equal(ctx.count(), 0, "订阅必须被摘掉");
  assert.equal(auto.pendingCount(), 0, "排队的活必须被清掉");
  await tick();
  // 关键：dispose 之前排进 timer 的那一次也不许再跑（否则卸载后还会写盘）。
  assert.deepEqual(calls, [], "卸载之后不许还有一次偷偷的写盘");
  assert.equal(auto.runNow("D:/proj"), null);
  assert.deepEqual(calls, []);
  // 再发事件也不排队了。
  ctx.emit(sessionAt("D:/proj"), { type: "turn/end" });
  await tick();
  assert.deepEqual(calls, []);
});

test("runNow 绕开冷却与 timer，手动入口可以直接驱动一次", () => {
  const ctx = fakeCtx();
  const calls = [];
  const auto = createNudgeAutoRun({
    ctx,
    runNudge: (args) => { calls.push(args); return { counts: { savedProposals: 0 } }; },
    now: () => 1_000_000,
    minIntervalMs: 10_000
  });
  const doc = auto.runNow("D:/proj");
  assert.ok(doc, "手动入口要有同步回执");
  assert.equal(calls.length, 1);
  // runNow 刻意**不走冷却**：它是人显式要的一次跑，人比定时器知道自己要什么。
  assert.ok(auto.runNow("D:/proj"));
  assert.equal(calls.length, 2);
  // 但它要把时间记上——否则紧接着的自动跑会立刻再来一次。
  assert.equal(typeof auto.lastRunAt("D:/proj"), "number");
  ctx.emit(sessionAt("D:/proj"), { type: "turn/end" });
  return tick().then(() => {
    assert.equal(calls.length, 2, "runNow 之后冷却生效，自动跑不许立刻重跑");
    auto();
  });
});
