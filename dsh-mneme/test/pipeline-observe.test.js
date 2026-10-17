import test from "node:test";
import assert from "node:assert/strict";
import { commandFromToolCall, outcomeOfToolResult, pairObservations } from "../src/pipeline-observe.js";

// 这组测试守的是「会话事件 → 观察」这一层的三条纪律。它们都来自接线前的实测：
// 真实会话里的工具名是 pwsh/read/glob，而工作流写的是 npm/git/gh 命令行——两者不重叠。

test("命令执行器：从 pwsh 的参数里抽出命令行（实测唯一能对上的通路）", () => {
  assert.deepEqual(
    commandFromToolCall("pwsh", '{"command":"npm test","description":"跑测试"}'),
    { tool: "pwsh", command: "npm test" }
  );
  // 对象形状与 JSON 串形状都要认：宿主两种都出现过。
  assert.deepEqual(
    commandFromToolCall("pwsh", { command: "git push origin main" }),
    { tool: "pwsh", command: "git push origin main" }
  );
  assert.equal(commandFromToolCall("bash", '{"cmd":"npm run sync"}').command, "npm run sync");
});

test("非命令执行器一律不给观察：read/glob/grep 是代理日常动作，不是工作流的一步", () => {
  // 硬把 read 的文件路径拼成「命令行」去匹配，只会制造噪声——噪声的代价是凭空染色。
  assert.equal(commandFromToolCall("read", '{"file_path":"C:\\\\x\\\\y.md"}'), null);
  assert.equal(commandFromToolCall("glob", '{"pattern":"**/*.js"}'), null);
  assert.equal(commandFromToolCall("grep", '{"pattern":"foo"}'), null);
  assert.equal(commandFromToolCall("write", '{"content":"hello"}'), null);
});

test("是执行器但抽不出命令行：不猜，返回 null（形状变了也不硬凑）", () => {
  assert.equal(commandFromToolCall("pwsh", '{"description":"忘了给命令"}'), null);
  assert.equal(commandFromToolCall("pwsh", "不是 JSON"), null);
  assert.equal(commandFromToolCall("pwsh", "[]"), null);
  assert.equal(commandFromToolCall("", '{"command":"npm test"}'), null);
  assert.equal(commandFromToolCall("pwsh", '{"command":"   "}'), null);
});

test("成败三态：只有布尔才算数，「不知道」不许折叠成「失败」", () => {
  assert.equal(outcomeOfToolResult({ data: { message: { isError: false } } }), true);
  assert.equal(outcomeOfToolResult({ data: { message: { isError: true } } }), false);
  // 拿不到 isError 时留 null——当成 false 会给这一步打上不该有的 refuted 标记。
  assert.equal(outcomeOfToolResult({ data: { message: {} } }), null);
  assert.equal(outcomeOfToolResult({ data: {} }), null);
  assert.equal(outcomeOfToolResult({}), null);
  // 旧形状：isError 挂在 content 的 tool-result 块上。
  assert.equal(outcomeOfToolResult({ data: { message: { content: [{ type: "tool-result", isError: true }] } } }), false);
  assert.equal(outcomeOfToolResult({ data: { message: { content: [{ type: "tool-result", isError: false }] } } }), true);
});

test("配对靠 callId，且只有拿到结果的调用才产观察", () => {
  const events = [
    { type: "tool/call", at: "2026-10-16T12:00:00.000Z", data: { callId: "c1", name: "pwsh", arguments: '{"command":"npm test"}' } },
    { type: "tool/result", data: { callId: "c1", message: { isError: false } } },
    { type: "tool/call", at: "2026-10-16T12:00:05.000Z", data: { callId: "c2", name: "pwsh", arguments: '{"command":"git push"}' } },
    { type: "tool/result", data: { callId: "c2", message: { isError: true } } }
  ];
  const { observations, dangling, notCommands } = pairObservations(events);
  assert.equal(observations.length, 2);
  assert.deepEqual(observations[0], { tool: "pwsh", command: "npm test", ok: true, at: "2026-10-16T12:00:00.000Z" });
  assert.equal(observations[1].ok, false, "失败要如实带出来");
  assert.equal(dangling.length, 0);
  assert.equal(notCommands, 0);
});

test("调了但没结果：进 dangling，既不产观察也不假装失败", () => {
  // 「中断了」既不是成功也不是失败；拿它当一次成功使用是编造。
  const { observations, dangling } = pairObservations([
    { type: "tool/call", data: { callId: "c9", name: "pwsh", arguments: '{"command":"npm publish"}' } }
  ]);
  assert.equal(observations.length, 0);
  assert.equal(dangling.length, 1);
  assert.match(dangling[0].why, /没有等到结果/);
});

test("没有 callId 的调用不硬凑配对，如实进 dangling", () => {
  const { observations, dangling } = pairObservations([
    { type: "tool/call", data: { name: "pwsh", arguments: '{"command":"npm test"}' } }
  ]);
  assert.equal(observations.length, 0);
  assert.equal(dangling.length, 1);
  assert.match(dangling[0].why, /没有 callId/);
});

test("非命令工具的调用计入 notCommands，不产观察也不出错", () => {
  const { observations, notCommands } = pairObservations([
    { type: "tool/call", data: { callId: "r1", name: "read", arguments: '{"file_path":"x.md"}' } },
    { type: "tool/result", data: { callId: "r1", message: { isError: false } } },
    { type: "tool/call", data: { callId: "p1", name: "pwsh", arguments: '{"command":"npm test"}' } },
    { type: "tool/result", data: { callId: "p1", message: { isError: false } } }
  ]);
  assert.equal(notCommands, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].command, "npm test");
});

test("坏输入不抛：空、非数组、缺字段一律返回空结果", () => {
  for (const bad of [null, undefined, [], [{}], [{ type: "tool/call" }], [{ type: "tool/result" }], [0, "x"]]) {
    const r = pairObservations(bad);
    assert.equal(Array.isArray(r.observations), true);
    assert.equal(Array.isArray(r.dangling), true);
    assert.equal(typeof r.notCommands, "number");
  }
});

test("观察能直接喂给执行窗口：两个模块的契约对得上", async () => {
  const { openRun } = await import("../src/pipeline-exec.js");
  const { validatePipeline } = await import("../src/pipeline.js");
  const p = validatePipeline({
    id: "demo", name: "演示", project: "a/b", version: 0, status: "active", done: "走完",
    trigger: [{ kind: "phrase", value: "走一遍" }],
    steps: [{
      id: "P6", phase: "准备", title: "跑测试", when: "改完", do: "npm test",
      who: "main", tool: "npm test", done: "全绿", risk: "R0", needs: [], why: "因为"
    }]
  }, "demo.json");

  const { observations } = pairObservations([
    { type: "tool/call", at: "2026-10-16T12:00:00.000Z", data: { callId: "c1", name: "pwsh", arguments: '{"command":"npm test"}' } },
    { type: "tool/result", data: { callId: "c1", message: { isError: false } } }
  ]);

  const run = openRun({ pipeline: p, now: () => new Date("2026-10-16T12:00:10.000Z") });
  for (const obs of observations) run.observe(obs);
  const closed = run.close();

  assert.deepEqual(closed.run.steps.map((s) => s.id), ["P6"], "实测链路：事件 → 观察 → 归属 → 一步进账");
  assert.equal(closed.run.steps[0].refuted, false);
});
