import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createExecutionRecorder, projectRootOf, MAX_BUFFERED_EVENTS } from "../src/pipeline-runner.js";
import { validatePipeline } from "../src/pipeline.js";

// 这组测试守的是串联层：把「事件 → 观察 → 归属 → 窗口 → 落盘」串起来的那一层。
// 它最要紧的两条性质：
//   ① 没开窗时**一个字都不记**（漏记可接受，编造不可）
//   ② 热路径上**永不抛**（宿主的一步不许被插件的可选能力带崩）

const PIPE = validatePipeline({
  id: "demo",
  name: "演示",
  project: "a/b",
  version: 0,
  status: "active",
  done: "走完",
  trigger: [{ kind: "phrase", value: "走一遍" }],
  steps: [
    { id: "P6", phase: "准备", title: "跑测试", when: "改完", do: "npm test", who: "main", tool: "npm test", done: "全绿", risk: "R0", needs: [], why: "因为" }
  ]
}, "demo.json");

/** 造一个假的 ctx：只实现 on()，并记下 listener 供测试手动触发。 */
function fakeCtx() {
  let listener = null;
  return {
    ctx: {
      on(event, fn) {
        if (event === "session/event") listener = fn;
        return () => { listener = null; };
      }
    },
    emit(session, event) { if (listener) listener(session, event); },
    hasListener: () => listener !== null
  };
}

function clockFrom(startMs) {
  let n = 0;
  return () => new Date(startMs + n++ * 1000);
}

function callAndResult(command, ok = true, callId = "c1") {
  return [
    { type: "tool/call", data: { callId, name: "pwsh", arguments: JSON.stringify({ command }) } },
    { type: "tool/result", data: { callId, message: { isError: ok === false } } }
  ];
}

test("没开窗时一个字都不记：事件到了也不缓冲（这是整个设计的地基）", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };

  for (const e of callAndResult("npm test")) f.emit(session, e);
  assert.deepEqual(rec.status({ session }), { open: false }, "没开窗就该没有窗口");
  assert.equal(rec.stop({ session }).reason, "no-open-window");
});

test("开窗 → 走一遍 → 结账：产出并落盘一条账", () => {
  const f = fakeCtx();
  let written = null;
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: (root, id, run) => { written = { root, id, run }; },
    now: clockFrom(Date.UTC(2026, 9, 16, 12, 0, 0))
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };

  const started = rec.start({ session, pipelineId: "demo" });
  assert.equal(started.ok, true);
  assert.equal(started.steps, 1);

  for (const e of callAndResult("npm test")) f.emit(session, e);

  // P2 契约：stop **不再落盘**，只产出「请你确认」的提案
  const stopped = rec.stop({ session });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state, "awaiting-confirmation");
  assert.equal(stopped.observations, 1);
  assert.equal(written, null, "没人确认之前，一个字节都不许落盘");

  // 自动归属的结果只作提示（PIPE 里 P6 的 tool 正是 npm test，所以这里会有 hint）
  assert.deepEqual(stopped.proposal.steps.map((s) => s.id), ["P6"]);

  // 人确认之后才写账——这是唯一入口
  const confirmed = rec.confirm({ session, answers: { P6: "done" } });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.steps, 1);
  assert.equal(written.id, "demo");
  assert.equal(written.root, "C:\\proj");
  assert.deepEqual(written.run.steps.map((s) => s.id), ["P6"]);
  assert.equal(written.run.by, "human", "人确认的账，by 应当是人");
});

test("P2：hint 只是提示，不预选——人不回答就什么都不写", () => {
  const f = fakeCtx();
  let written = null;
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: (root, id, run) => { written = { id, run }; }
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  for (const e of callAndResult("npm test")) f.emit(session, e);
  rec.stop({ session });

  // 人什么都不说（全没答）→ 不产 run，也不写盘
  const r = rec.confirm({ session, answers: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-answers");
  assert.deepEqual(r.unanswered, ["P6"]);
  assert.equal(written, null, "没回答 = 没确认 = 不写");
});

test("P2：unsure 与 notDone 在落盘结果里必须分得开", () => {
  const f = fakeCtx();
  let written = null;
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: (root, id, run) => { written = { id, run }; }
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  rec.stop({ session });

  const r = rec.confirm({ session, answers: { P6: "unsure" } });
  // 全 unsure → 无记录可写
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-answers");
  assert.deepEqual(r.unsure, ["P6"]);
  assert.equal(written, null);
});

test("P2：非法回答保留待确认状态，让人重答（不丢掉、不静默少记）", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  rec.stop({ session });

  const bad = rec.confirm({ session, answers: { P6: "yes" } });
  assert.equal(bad.reason, "bad-answer-value");
  // 状态还在，可以重答
  assert.equal(rec.status({ session }).awaitingConfirmation, true);
  const ok = rec.confirm({ session, answers: { P6: "done" } });
  assert.equal(ok.ok, true);
});

test("P2：没结账就确认 → 说清「没什么可确认的」", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  assert.equal(rec.confirm({ session, answers: { P6: "done" } }).reason, "nothing-to-confirm");
});

test("P2：status 要能分辨「窗口开着」与「等你确认」两种状态", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  assert.equal(rec.status({ session }).open, true);
  assert.equal(rec.status({ session }).awaitingConfirmation, undefined);

  rec.stop({ session });
  const s = rec.status({ session });
  assert.equal(s.open, false);
  assert.equal(s.awaitingConfirmation, true);
  assert.equal(s.pipelineId, "demo");
});

test("P2：结账时不再报「没认出来」为失败——认不出只是没 hint，人照样能确认", () => {
  const f = fakeCtx();
  let written = null;
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: (root, id, run) => { written = { run }; }
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });

  // 只有无关命令：认不出任何步骤
  f.emit(session, { type: "tool/call", data: { callId: "x", name: "read", arguments: '{"file_path":"a.md"}' } });
  f.emit(session, { type: "tool/result", data: { callId: "x", message: { isError: false } } });
  const stopped = rec.stop({ session });

  // 这一步和 P1 的不同：认不出**不再是"失败"**，而是"等你自己说"
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state, "awaiting-confirmation");
  assert.equal(stopped.observations, 0);
  assert.equal(stopped.notCommands, 1);
  // 人来说"这一步走了"，照样能记
  const confirmed = rec.confirm({ session, answers: { P6: "done" } });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(written.run.steps.map((s) => s.id), ["P6"]);
});

test("同会话重复开窗被拒，不顶掉前一个（顶掉会让前一次执行悄无声息地消失）", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };

  assert.equal(rec.start({ session, pipelineId: "demo" }).ok, true);
  const second = rec.start({ session, pipelineId: "demo" });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already-open");
});

test("不同会话各开各的窗口，互不干扰", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const a = { id: "sa", header: { cwd: "C:\\proj" } };
  const b = { id: "sb", header: { cwd: "C:\\proj" } };

  rec.start({ session: a, pipelineId: "demo" });
  rec.start({ session: b, pipelineId: "demo" });
  for (const e of callAndResult("npm test")) f.emit(a, e);

  // 事件是**缓冲到 stop 才配对**的（结果可能比调用晚很久），所以开着窗时
  // observations 本来就是 0——这里该验的是缓冲隔离，不是计数。
  assert.equal(rec.status({ session: a }).bufferedEvents, 2, "a 的事件只进 a 的窗口");
  assert.equal(rec.status({ session: b }).bufferedEvents, 0, "b 一条都不该收到");
});

test("找不到工作流时说清是「没有」还是「读不出来」，并给可用清单", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => null, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };

  const missing = rec.start({ session, pipelineId: "nope" });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "pipeline-not-found");

  const f2 = fakeCtx();
  const rec2 = createExecutionRecorder({
    ctx: f2.ctx,
    resolvePipeline: () => { throw new Error("坏 JSON"); },
    persistRun: () => {}
  });
  const broken = rec2.start({ session: { id: "s2", header: { cwd: "C:\\proj" } }, pipelineId: "demo" });
  assert.equal(broken.reason, "pipeline-unreadable", "读不出来与没有这条是两件事");
  assert.match(broken.detail, /坏 JSON/);
});

test("拿不到会话工作目录时拒开，而不是硬塞一个别处的项目", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const noCwd = { id: "s1", header: {} };
  assert.equal(rec.start({ session: noCwd, pipelineId: "demo" }).reason, "no-project-root");
  // 没有 session 也一样
  assert.equal(rec.start({ pipelineId: "demo" }).reason, "no-session");
});

test("P2：一条观察都没认出来也不写账——但也不再当成失败（等人自己说）", () => {
  const f = fakeCtx();
  let wrote = false;
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: () => { wrote = true; }
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });

  // 只有无关工具调用：认不出命令执行器，配不出观察
  f.emit(session, { type: "tool/call", data: { callId: "x", name: "read", arguments: '{"file_path":"a.md"}' } });
  const stopped = rec.stop({ session });

  // 旧行为是 ok:false + reason:no-observations；P2 起认不出不再是"失败"，
  // 因为账本来就该由人来说，机器的认不出只是"没给 hint"。
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state, "awaiting-confirmation");
  assert.equal(stopped.observations, 0);
  assert.equal(wrote, false, "仍然不写空账");
});

test("P2：写盘失败发生在 confirm 阶段，如实回报且不留悬着的待确认状态", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: () => { throw new Error("磁盘满"); }
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  for (const e of callAndResult("npm test")) f.emit(session, e);

  // stop 阶段不该碰磁盘——它是"请你确认"，不是"写账"
  const stopped = rec.stop({ session });
  assert.equal(stopped.ok, true);

  const confirmed = rec.confirm({ session, answers: { P6: "done" } });
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.reason, "write-failed");
  assert.match(confirmed.detail, /磁盘满/);
  // 写失败后不该留一个悬着的待确认状态（否则人会以为还要再确认一次）
  assert.equal(rec.status({ session }).awaitingConfirmation, undefined);
});

test("热路径永不抛：listener 内部出错不冒泡到宿主的一步", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: () => {},
    logger: { warn() {} }
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });

  // 各种畸形事件都不该抛
  for (const bad of [null, undefined, {}, { type: "tool/call" }, { type: "tool/call", data: null }]) {
    f.emit(session, bad);
  }
  assert.equal(true, true, "走到这里没抛就算过");
});

test("缓冲封顶：忘了 stop 时标记 truncated，而不是无限吃内存", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: () => {},
    maxBufferedEvents: 3
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });

  for (let i = 0; i < 5; i += 1) {
    f.emit(session, { type: "tool/call", data: { callId: `c${i}`, name: "pwsh", arguments: '{"command":"npm test"}' } });
  }
  const s = rec.status({ session });
  assert.equal(s.truncated, true);
  assert.equal(s.bufferedEvents, 3);
});

test("dispose 摘掉监听，之后的窗口全清", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  assert.equal(f.hasListener(), true);

  rec.dispose();
  assert.equal(f.hasListener(), false);
  assert.equal(rec.status({ session }).open, false);
  rec.dispose(); // 重复 dispose 不报错
});

// ---------------------------------------------------------------------------
// P3（丙）：确认时刻的观察旁挂 + tool 不符检出
// 设计见 mneme-research/mo-foundations/10 号；丙 = 旁挂文件，不动已发布的账本契约
// ---------------------------------------------------------------------------
test("P3：给了 memoryDir 时，confirm 把观察旁挂 + 报出 tool 不符", () => {
  const f = fakeCtx();
  let written = null;
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: (root, id, run) => { written = { run }; },
    memoryDir: "D:/mem-test"     // 注入（真实现里来自 config.memoryDir）
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  // 实际敲的是 node --test，不是步骤声明的 npm test → 人确认后应报不符
  f.emit(session, { type: "tool/call", data: { callId: "c1", name: "pwsh", arguments: '{"command":"node --test test/x.test.js"}' } });
  f.emit(session, { type: "tool/result", data: { callId: "c1", message: { isError: false } } });
  rec.stop({ session });
  const confirmed = rec.confirm({ session, answers: { P6: "done" } });

  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.toolMismatches.length, 1, "声明 npm test 未出现 → 一条不符");
  assert.equal(confirmed.toolMismatches[0].declared, "npm test");
  assert.equal(confirmed.observationsSaved.ok, true, "观察已旁挂");
  assert.equal(confirmed.observationsSaved.lines, 1, "node --test 一条");
});

test("P3：没给 memoryDir 时静默关闭——旁挂 skipped，但 mismatch 照算（不落盘的那半不连累这半）", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  f.emit(session, { type: "tool/call", data: { callId: "c1", name: "pwsh", arguments: '{"command":"node --test x"}' } });
  f.emit(session, { type: "tool/result", data: { callId: "c1", message: { isError: false } } });
  rec.stop({ session });
  const confirmed = rec.confirm({ session, answers: { P6: "done" } });

  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.observationsSaved.skipped, true, "没配 memoryDir = P3 旁挂关");
  assert.equal(confirmed.toolMismatches.length, 1, "检出与旁挂是两件事，各自独立");
});

test("P3：旁挂写失败不连累记账（账本才是唯一事实）", () => {
  const f = fakeCtx();
  let written = false;
  // 占位文件：往「一个文件路径的下面」建目录必然 ENOTDIR（node mkdirSync 实测）
  const blocker = join(tmpdir(), "mo-p3-blocker-" + Date.now());
  writeFileSync(blocker, "x", "utf8");
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: () => { written = true; },
    memoryDir: blocker,          // <memoryDir>/observations/... 的父级是个文件 → mkdir 抛
    logger: { warn: () => {} }
  });
  try {
    const session = { id: "s1", header: { cwd: "C:\\proj" } };
    rec.start({ session, pipelineId: "demo" });
    f.emit(session, { type: "tool/call", data: { callId: "c1", name: "pwsh", arguments: '{"command":"npm test"}' } });
    f.emit(session, { type: "tool/result", data: { callId: "c1", message: { isError: false } } });
    rec.stop({ session });
    const confirmed = rec.confirm({ session, answers: { P6: "done" } });

    assert.equal(confirmed.ok, true, "旁挂炸了，记账也必须成功");
    assert.equal(written, true, "账本照写");
    assert.equal(confirmed.observationsSaved.ok, false, "旁挂如实报未成");
    assert.equal(confirmed.toolMismatches.length, 0, "声明 npm test 且观察到了它 → 无不符");
  } finally {
    rmSync(blocker, { force: true });
  }
});

test("projectRootOf 与 scope.js 同口径：header 优先，不在时退回请求头", () => {
  assert.equal(projectRootOf({ header: { cwd: "C:\\a" } }), "C:\\a");
  assert.equal(projectRootOf({ requestHeader: () => ({ config: { cwd: "C:\\b" } }) }), "C:\\b");
  assert.equal(projectRootOf({ header: {} }), null);
  assert.equal(projectRootOf(null), null);
});

test("缓冲上限常量存在且是个正整数", () => {
  assert.equal(Number.isInteger(MAX_BUFFERED_EVENTS), true);
  assert.ok(MAX_BUFFERED_EVENTS > 0);
});
