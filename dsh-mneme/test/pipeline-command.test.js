import test from "node:test";
import assert from "node:assert/strict";
import { parseMoRunInput, createMoRunHandler, registerMoRunCommand, MO_RUN_COMMAND } from "../src/pipeline-command.js";

// 这组测试守的是 `/mo-run` 的回执质量。命令回执是这个功能**唯一的对外窗口**
// （面板侧还没做），所以最要紧的性质是：**失败必须说清是哪种失败**，
// 尤其「一条观察都没认出来」绝不能被含糊成「完成」。

test("解析：三种子命令 + 默认看状态 + 不认识的词给用法", () => {
  assert.deepEqual(parseMoRunInput("start dsh-mneme-release"), { action: "start", pipelineId: "dsh-mneme-release" });
  assert.deepEqual(parseMoRunInput("stop"), { action: "stop" });
  assert.deepEqual(parseMoRunInput("status"), { action: "status" });
  // 不带参数 = 看状态：最安全的默认，不会误开窗
  assert.deepEqual(parseMoRunInput(""), { action: "status" });
  assert.deepEqual(parseMoRunInput("   "), { action: "status" });
  assert.deepEqual(parseMoRunInput(null), { action: "status" });
  assert.equal(parseMoRunInput("whatever").action, "help");
  // 大小写不敏感，id 里带空格也能取全
  assert.deepEqual(parseMoRunInput("START a b"), { action: "start", pipelineId: "a b" });
});

/** 造一个受控的假记录器，回执里只看它返回的东西怎么被翻译。 */
function fakeRecorder({ start, stop, status, confirm } = {}) {
  return {
    start: start ?? (() => ({ ok: true, pipelineId: "demo", steps: 3 })),
    stop: stop ?? (() => ({ ok: true, pipelineId: "demo", steps: 2 })),
    // P2 起 stop 不再落盘，默认返回"待确认"
    status: status ?? (() => ({ open: false })),
    confirm: confirm ?? (() => ({ ok: true, pipelineId: "demo", steps: 1, notDone: [], unsure: [], unanswered: [] }))
  };
}

const invocation = (rawInput) => ({ rawInput, agent: { session: { id: "s1" } } });

test("start 成功：说清开了哪条、几步", () => {
  const h = createMoRunHandler({ recorder: fakeRecorder(), language: () => "zh" });
  const r = h(invocation("start demo"));
  assert.equal(r.kind, "success");
  assert.match(r.text, /已开窗/);
  assert.match(r.text, /demo/);
  assert.match(r.text, /3 步/);
});

test("start 已开着窗口：给的是「先 stop」，而不是静默顶掉", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({ start: () => ({ ok: false, reason: "already-open", pipelineId: "old" }) }),
    language: () => "zh"
  });
  const r = h(invocation("start demo"));
  assert.match(r.text, /already|已经开着|旧|old|先/);
});

test("start 找不到工作流：把可用清单给出来（别让人猜）", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({ start: () => ({ ok: false, reason: "pipeline-not-found", available: ["a", "b"] }) }),
    language: () => "zh"
  });
  const r = h(invocation("start nope"));
  assert.match(r.text, /a/);
  assert.match(r.text, /b/);
});

test("start 读不出来与没有这条是两种话——不许合并成同一句", () => {
  const unreadable = createMoRunHandler({
    recorder: fakeRecorder({ start: () => ({ ok: false, reason: "pipeline-unreadable", detail: "坏 JSON" }) }),
    language: () => "zh"
  });
  const notFound = createMoRunHandler({
    recorder: fakeRecorder({ start: () => ({ ok: false, reason: "pipeline-not-found", available: [] }) }),
    language: () => "zh"
  });
  assert.notEqual(unreadable(invocation("start demo")).text, notFound(invocation("start demo")).text);
  assert.match(unreadable(invocation("start demo")).text, /坏 JSON/);
});

test("P2：stop 产出待确认清单，明说「还没有写账」并给出步骤表", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({
      stop: () => ({
        ok: true, state: "awaiting-confirmation", notCommands: 5, truncated: false,
        activities: [{ key: "npm test", count: 3, flags: [] }],
        proposal: {
          pipelineId: "demo",
          steps: [
            { id: "P6", title: "跑测试", declared: "npm test", hintCount: 2 },
            { id: "V2", title: "推分支", declared: "git push", hintCount: 0 }
          ]
        }
      })
    }),
    language: () => "zh"
  });
  const r = h(invocation("stop"));
  assert.match(r.text, /还没有写账/, "必须明确说这一版不自动落盘");
  assert.match(r.text, /P6/, "步骤表要给出来供人勾");
  assert.match(r.text, /V2/);
  assert.match(r.text, /confirm/, "要给出怎么写确认");
  assert.match(r.text, /npm test ×3/, "观察到的动作清单也要给");
});

test("P2：confirm 成功 → 报步数，并把「没做」「不确定」「没提到」分开", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({
      confirm: () => ({ ok: true, pipelineId: "demo", steps: 1, notDone: ["V2"], unsure: [], unanswered: ["A3"] })
    }),
    language: () => "zh"
  });
  const r = h(invocation("confirm P6"));
  assert.equal(r.kind, "success");
  assert.match(r.text, /记入账本/);
  assert.match(r.text, /V2/);
  assert.match(r.text, /A3/);
});

test("P2：confirm 的关键一条——什么都没确认时明说没落盘，不许含糊成完成", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({
      confirm: () => ({ ok: false, reason: "no-answers", notDone: 0, unsure: 1, unanswered: 1 })
    }),
    language: () => "zh"
  });
  const r = h(invocation("confirm P6:?"));
  assert.equal(r.kind, "error");
  assert.match(r.text, /没有落盘/, "必须明确说没写账");
});

test("P2：confirm 解析——`P6` 表示做了，`V2:-` 没做，`A3:?` 不确定", () => {
  const seen = [];
  const h = createMoRunHandler({
    recorder: fakeRecorder({ confirm: (arg) => { seen.push(arg.answers); return { ok: true, pipelineId: "d", steps: 1, notDone: [], unsure: [], unanswered: [] }; } }),
    language: () => "zh"
  });
  h(invocation("confirm P6 V2:- A3:?"));
  assert.deepEqual(seen[0], { P6: "done", V2: "notDone", A3: "unsure" });
  // 非法标记不放进结果（不是「没做」，是「没答」）
  h(invocation("confirm P6:xyz"));
  assert.deepEqual(seen[1], {});
  // 逗号也当分隔符
  h(invocation("confirm P6,V2"));
  assert.deepEqual(seen[2], { P6: "done", V2: "done" });
});

test("P2：没待确认清单时 confirm 说清先做什么", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({ confirm: () => ({ ok: false, reason: "nothing-to-confirm" }) }),
    language: () => "zh"
  });
  const r = h(invocation("confirm P6"));
  assert.match(r.text, /没有待确认/);
  assert.match(r.text, /mo-run start/);
});

test("P2：非法回答/未知步骤各自说清", () => {
  const bad = createMoRunHandler({
    recorder: fakeRecorder({ confirm: () => ({ ok: false, reason: "bad-answer-value", stepId: "P6", value: "yes" }) }),
    language: () => "zh"
  });
  assert.match(bad(invocation("confirm P6:yes")).text, /不合法/);

  const unknown = createMoRunHandler({
    recorder: fakeRecorder({ confirm: () => ({ ok: false, reason: "unknown-step", stepId: "NOPE" }) }),
    language: () => "zh"
  });
  assert.match(unknown(invocation("confirm NOPE")).text, /NOPE/);
});

test("stop 没有开着窗口 / 写盘失败：各自说清，不混为一谈", () => {
  const none = createMoRunHandler({
    recorder: fakeRecorder({ stop: () => ({ ok: false, reason: "no-open-window" }) }),
    language: () => "zh"
  });
  const failed = createMoRunHandler({
    recorder: fakeRecorder({ stop: () => ({ ok: false, reason: "write-failed", detail: "磁盘满" }) }),
    language: () => "zh"
  });
  assert.match(none(invocation("stop")).text, /没有开着窗口/);
  assert.match(failed(invocation("stop")).text, /磁盘满/);
  assert.notEqual(none(invocation("stop")).text, failed(invocation("stop")).text);
});

test("status：要能分辨「关着」「开着」「等你确认」三种状态", () => {
  const closed = createMoRunHandler({ recorder: fakeRecorder({ status: () => ({ open: false }) }), language: () => "zh" });
  assert.match(closed(invocation("status")).text, /没有开着/);

  const awaiting = createMoRunHandler({ recorder: fakeRecorder({ status: () => ({ open: false, awaitingConfirmation: true, pipelineId: "demo", steps: 3 }) }), language: () => "zh" });
  assert.match(awaiting(invocation("status")).text, /等你在确认|确认/, "等待确认是一个独立状态");

  const open = createMoRunHandler({
    recorder: fakeRecorder({
      status: () => ({ open: true, pipelineId: "demo", startedAt: "2026-10-16T12:00:00.000Z", bufferedEvents: 7, recorded: ["P6"], unattributed: 1, ambiguous: 0, truncated: false })
    }),
    language: () => "zh"
  });
  const r = open(invocation("status"));
  assert.match(r.text, /demo/);
  assert.match(r.text, /7 条事件/);
  assert.match(r.text, /P6/);
});

test("英文实例：同一组结果翻成英文，不落回中文", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({ confirm: () => ({ ok: false, reason: "no-answers", notDone: 0, unsure: 1, unanswered: 1 }) }),
    language: () => "en"
  });
  const r = h(invocation("confirm P6:?"));
  assert.match(r.text, /nothing was persisted/i);
});

test("注册默认关：旗标不是 true 时一个命令都不注册", () => {
  const registered = [];
  const ctx = { commands: { register: (c) => { registered.push(c); return () => {}; } } };
  assert.equal(registerMoRunCommand({ ctx, recorder: fakeRecorder(), enabled: false }), null);
  assert.equal(registerMoRunCommand({ ctx, recorder: fakeRecorder(), enabled: undefined }), null);
  assert.equal(registered.length, 0, "默认关时不许注册");
});

test("注册打开：命令名走小写字母起头的约定，且带描述与用法提示", () => {
  const registered = [];
  const ctx = { commands: { register: (c) => { registered.push(c); return () => {}; } } };
  const dispose = registerMoRunCommand({ ctx, recorder: fakeRecorder(), enabled: true, language: () => "zh" });
  assert.equal(typeof dispose, "function");
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, MO_RUN_COMMAND);
  assert.match(registered[0].name, /^[a-z][a-z0-9_-]*$/);
  assert.ok(registered[0].description);
  assert.ok(registered[0].input?.hint);
  assert.equal(typeof registered[0].handler, "function");
});

test("没有命令注册表时不硬注册（返回 null，由装配方决定要不要降级）", () => {
  assert.equal(registerMoRunCommand({ ctx: {}, recorder: fakeRecorder(), enabled: true }), null);
  assert.equal(registerMoRunCommand({ ctx: null, recorder: fakeRecorder(), enabled: true }), null);
});

test("handler 抛异常也不许把异常抛进宿主：退化成用法提示", () => {
  const h = createMoRunHandler({
    recorder: { start: () => { throw new Error("炸了"); }, stop: () => {}, status: () => {} },
    language: () => "zh"
  });
  const r = h(invocation("start demo"));
  assert.equal(r.kind, "error");
  assert.ok(r.text);
});
