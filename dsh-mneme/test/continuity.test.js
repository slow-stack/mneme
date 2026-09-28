import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { Config, applyLightModePreset, injectChildEnabled } from "../src/config.js";
import {
  CONTINUITY_KIND,
  CONTINUITY_NOTICE_PREFIX,
  CONTINUITY_FIELD_MAX,
  deriveContinuity,
  renderContinuityNotice,
  createContinuityRescue
} from "../src/continuity.js";

// 回归（issue #249 N3）：压缩边缘双落点。
//
// 这个文件锁的是「形态」而不是「文案」：宿主的压缩摘要器只看对话里的内容，所以
// 双落点（落提案 + 末尾追加）缺一半功能就等于没做——每条用例都对应一处会静默退化
// 的形态，而不是某段文本正好长什么样。
//
// 事件形状照 summarize.js 的 collectMessages 口径：user/message 的文本在
// `data.content`、来源在 `data.source`，assistant/message 的在 `data.message.content`。

const KIND = CONTINUITY_KIND;

function userEvent(seq, text, source = { kind: "user" }) {
  return { type: "user/message", seq, data: { content: [{ type: "text", text }], source } };
}

function assistantEvent(seq, text) {
  return { type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } };
}

/** surfaceSeqs 给了才挂表面投影（`session.surface.nodes` 只存活节点的 seq）：判重按表面、
 *  抽取按全量日志，这两条口径必须能分开测。 */
function fakeSession(id, events, surfaceSeqs) {
  const session = { id, snapshotEvents: () => events, append() {} };
  if (surfaceSeqs) session.surface = { nodes: surfaceSeqs };
  return session;
}

/** 捕获 handler 的 ctx：fire 直接调被注册的函数，返回它的返回值（含 Promise）。 */
function mockCtx() {
  const handlers = new Map();
  const warnings = [];
  return {
    logger: { warn: (message) => warnings.push(String(message)) },
    warnings,
    on(name, fn) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    fire(name, ...args) {
      return handlers.get(name)?.(...args);
    }
  };
}

function toolDescriptions(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const registered = [];
  const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
  createTools(ctx, service, config, null);
  return new Map(registered.map((t) => [t.name, t.description]));
}

test("#249 N3：抽取口径——最后一句话的指令取头、最后一段回复取尾", () => {
  const long = "x".repeat(CONTINUITY_FIELD_MAX * 2);
  const fields = deriveContinuity(
    fakeSession("s1", [
      userEvent(1, "早期的指令"),
      assistantEvent(2, "早期的回复"),
      userEvent(4, `最新指令 ${long}`),
      assistantEvent(5, `最新回复 ${long}`),
      // 插件消息（我们自己的注入或别的插件）不是"用户当前指令"，必须跳过：否则注入物会被
      // 当成用户诉求、下一轮又抄进快照（自我强化）。**刻意放在最后一条 user/message**：
      // 夹在中间时"后写覆盖"会让这条断言恒绿，钉不住这层过滤（审查发现）。
      userEvent(6, "插件注入的一行", { kind: "plugin", plugin: "dsh-mneme" })
    ])
  );
  assert.equal(fields.currentWork, `最新指令 ${long}`.slice(0, CONTINUITY_FIELD_MAX), "取最近一条真实用户消息的头部");
  assert.equal(fields.nextStep, `最新回复 ${long}`.slice(-CONTINUITY_FIELD_MAX), "下一步活在回复末尾，故取尾部");
  assert.equal(fields.openQuestions, null, "确定性抽取判不出未决问题，字段留空而不编造");
});

test("#249 N3：渲染——统一前缀 + 三字段单行 + 空字段如实标 none", () => {
  const text = renderContinuityNotice({ currentWork: "改 注入\n第二行", nextStep: null, openQuestions: "要不要开 PR？" });
  assert.ok(text.startsWith(CONTINUITY_NOTICE_PREFIX), "统一前缀是剥离与判重的锚");
  assert.ok(!text.slice(CONTINUITY_NOTICE_PREFIX.length).includes("\n\n"), "字段内部换行被压平，一条消息仍是结构化的三行");
  assert.ok(text.includes("current_work: 改 注入 第二行"), "字段内换行压成空格");
  assert.ok(text.includes("next_step: (none)"), "空字段如实标 none");
  assert.ok(text.includes("open_questions: 要不要开 PR？"));
  assert.equal(renderContinuityNotice({ currentWork: "y".repeat(500) }, 40).length, 40, "整条有硬上限");
});

test("#249 N3：提案落库——同一会话同一类只一条（刷新而不是新增）", () => {
  const store = createStore(":memory:");
  const first = store.saveContinuityProposal({ sessionId: "s1", kind: KIND, currentWork: "第一版", edgeSeq: 7 });
  const created = store.getContinuityProposal("s1", KIND);
  assert.equal(first.created, true);
  const again = store.saveContinuityProposal({ sessionId: "s1", kind: KIND, currentWork: "第二版", edgeSeq: 9 });
  assert.equal(again.created, false, "同一 (session, kind) 是刷新");
  assert.equal(again.id, first.id);
  const row = store.getContinuityProposal("s1", KIND);
  assert.equal(row.current_work, "第二版", "刷新覆盖内容（最新的边缘赢）");
  assert.equal(row.created_at, created.created_at, "created_at 记首次落库，刷新不动它");
  assert.equal(row.edge_seq, 9, "edge_seq 记最近一次触发，是「实际触发率」的证据");
  assert.equal(store.countContinuityProposals({ status: "pending" }), 1);
  // 唯一键是「会话 + 类型」这一对：换任一维都是另一条提案。
  store.saveContinuityProposal({ sessionId: "s2", kind: KIND, currentWork: "别的会话" });
  store.saveContinuityProposal({ sessionId: "s1", kind: "other-kind", currentWork: "别的类" });
  assert.equal(store.countContinuityProposals(), 3);
  assert.equal(store.listContinuityProposals().length, 3, "读侧按 updated_at 倒序返回");
});

test("#249 N3：队列满则弃新——但不是淘汰旧行，且不影响刷新", () => {
  const store = createStore(":memory:");
  store.saveContinuityProposal({ sessionId: "s1", kind: KIND, currentWork: "旧会话的活状态" });
  const dropped = store.saveContinuityProposal({ sessionId: "s2", kind: KIND, currentWork: "新的", maxPending: 1 });
  assert.deepEqual(dropped, { id: null, created: false, dropped: true }, "达上限丢掉本次触发");
  assert.equal(store.countContinuityProposals(), 1, "旧行仍在——弃新不是淘汰旧，旧行是别的会话还没转正的工作状态");
  const refreshed = store.saveContinuityProposal({ sessionId: "s1", kind: KIND, currentWork: "刷新", maxPending: 1 });
  assert.equal(refreshed.created, false, "满队列不影响已有行的刷新");
  assert.equal(store.getContinuityProposal("s1", KIND).current_work, "刷新");
});

test("#249 N3：pre-step 双落点——压缩边缘落提案并往末尾追加一条", async () => {
  const store = createStore(":memory:");
  const ctx = mockCtx();
  const rescue = createContinuityRescue(ctx, store);
  const events = [userEvent(1, "把 N3 实现完"), assistantEvent(2, "接着写回归测试")];
  const nodes = [1, 2];
  const session = fakeSession("s1", events, nodes);

  const step = () => ctx.fire("agent/pre-step", { agent: { session } }, async () => ({ kind: "enter", messages: [] }));

  // 没有边缘时不追加：本功能只在宿主真的压缩之后动作，不自定阈值。
  assert.deepEqual((await step()).messages, [], "无压缩事件 → 不做任何事");

  ctx.fire("session/event", session, { type: "compaction/end", seq: 9 });
  const decision = await step();
  assert.equal(decision.messages.length, 1, "压缩边缘 → 追加一条");
  const message = decision.messages[0];
  assert.equal(message.source.plugin, "dsh-mneme");
  assert.equal(message.source.kind, "plugin:dsh-mneme", "插件来源会被蒸馏管线跳过，注入物不会变成记忆（也不会自我蒸馏）；裸 kind: \"plugin\" 被 V4 写入准入拒收（issue #326）");
  assert.ok(message.content[0].text.startsWith(CONTINUITY_NOTICE_PREFIX));
  assert.ok(message.content[0].text.includes("current_work: 把 N3 实现完"));
  const proposal = store.getContinuityProposal("s1", KIND);
  assert.equal(proposal.current_work, "把 N3 实现完", "落库先于注入：提案是脱离对话存活的那一半");
  assert.equal(proposal.edge_seq, 9);

  // 同一个边缘只消费一次（无新边缘 → 不再追加）。
  assert.deepEqual((await step()).messages, [], "边缘一次性消费，不会每步都追加");

  // 「不变不重复」：宿主已经把这条注入落进会话表面后，同文本不再追加第二次。
  events.push({ type: "user/message", seq: 11, data: { content: message.content, source: message.source } });
  nodes.push(11); // 宿主把这条注入落进了当前表面
  ctx.fire("session/event", session, { type: "compaction/end", seq: 12 });
  const sameText = await step();
  assert.deepEqual(sameText.messages, [], "同文本已在表面里 → 不重复追加（没有改写钩子，只能做到这一层）");
  assert.equal(store.getContinuityProposal("s1", KIND).edge_seq, 12, "但提案仍被刷新——两半各自独立");

  // 内容变了就允许再追加一次：判重按全文比较，不是"注入过就再不注入"。
  events.push(assistantEvent(13, "内容变了"));
  ctx.fire("session/event", session, { type: "compaction/end", seq: 14 });
  assert.equal((await step()).messages.length, 1, "快照内容变化 → 追加新的一份");

  // dispose 只能按行为断言：mockCtx 的 handler 是块体箭头函数、恒返回 undefined，拿 fire 的
  // 返回值断言"已摘除"是恒真的（审查发现的假断言）。pre-step 监听器活着时返回 decision、
  // 摘除后 fire 拿不到 handler，两者才是可分辨的。
  rescue.dispose();
  ctx.fire("session/event", session, { type: "compaction/end", seq: 15 });
  const afterDispose = await step();
  assert.equal(afterDispose, undefined, "dispose 后不再有 pre-step 监听器");
  assert.equal(store.getContinuityProposal("s1", KIND).edge_seq, 14, "dispose 后不再落库（edge_seq 停在最后一条边缘）");
});

test("#249 N3：宿主表面读取抛错时退回全量判重，也不打断宿主的一步", async () => {
  const ctx = mockCtx();
  const stub = { saveContinuityProposal: () => ({ id: "x", created: true, dropped: false }) };
  const rescue = createContinuityRescue(ctx, stub);
  const session = fakeSession("s1", [userEvent(1, "指令")]);
  // 宿主的 `surface.nodes` 是会抛的 getter（它自己内部的 projection 断言）。判重读不到就退回
  // 全量：可选的抢救功能绝不能因为读宿主状态失败而把 agent 的这一步变失败。
  Object.defineProperty(session, "surface", {
    get() {
      throw new Error('session message projection "X" was removed or replaced');
    }
  });
  ctx.fire("session/event", session, { type: "compaction/end", seq: 3 });
  const decision = await ctx.fire("agent/pre-step", { agent: { session } }, async () => ({ kind: "enter", messages: [] }));
  assert.equal(decision.messages.length, 1, "读不到表面不该 reject 这一步，注入照做");
  rescue.dispose();
});

test("#249 N3：压缩事件不带 seq 时仍要注入（「有没有边缘」不等于「序号的真假」）", async () => {
  const store = createStore(":memory:");
  const ctx = mockCtx();
  const rescue = createContinuityRescue(ctx, store);
  const session = fakeSession("s1", [userEvent(1, "指令")]);
  // 边缘只记「有没有」这一件事，序号允许为 null。把「取到的值」当真假判断（`if (!edge.get(id))`
  // 那种写法）会把这条边缘当成不存在：既不注入，也不清理。
  ctx.fire("session/event", session, { type: "compaction/end" });
  const decision = await ctx.fire("agent/pre-step", { agent: { session } }, async () => ({ kind: "enter", messages: [] }));
  assert.equal(decision.messages.length, 1, "序号缺失不影响注入");
  assert.equal(store.getContinuityProposal("s1", KIND).edge_seq, null, "序号缺失就如实记 null，不编一个数");
  rescue.dispose();
});

test("#249 N3：判重按当前表面——被折叠出表面的旧注入不算「已注入」", async () => {
  const store = createStore(":memory:");
  const ctx = mockCtx();
  const rescue = createContinuityRescue(ctx, store);
  const old = renderContinuityNotice({ currentWork: "指令", nextStep: "回复" });
  // seq 0 是上一次注入的快照：还在 append-only 日志里，但已被一次压缩 replace 折叠出表面。
  const events = [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: old }], source: { kind: "plugin", plugin: "dsh-mneme" } } },
    userEvent(1, "指令"),
    assistantEvent(2, "回复")
  ];
  const session = fakeSession("s1", events, [1, 2]);
  ctx.fire("session/event", session, { type: "compaction/end", seq: 9 });
  const decision = await ctx.fire("agent/pre-step", { agent: { session } }, async () => ({ kind: "enter", messages: [] }));
  // 按日志判重会在这里静默跳过（同文本命中已折叠的旧事件），注入那一半就空了一次；
  // 按表面判重才补得上——这正是双落点的 ② 存在的理由。
  assert.equal(decision.messages.length, 1, "日志里有同文本、表面里没有 → 这一次仍要补");
  rescue.dispose();
});

test("#249 N3：落库失败不打断宿主的一步（本函数的不变量）", async () => {
  const ctx = mockCtx();
  const broken = { saveContinuityProposal() { throw new Error("boom"); } };
  const rescue = createContinuityRescue(ctx, broken);
  const session = fakeSession("s1", [userEvent(1, "指令")]);
  ctx.fire("session/event", session, { type: "compaction/end", seq: 3 });
  const decision = await ctx.fire("agent/pre-step", { agent: { session } }, async () => ({ kind: "enter", messages: [] }));
  // 写不进去也要把注入那一半做出来：追加不依赖库；更关键的是可选插件的故障绝不该把
  // agent 的这一步变成失败（磁盘满 / busy 超时 / 库损坏都会走到这里）。
  assert.equal(decision.messages.length, 1, "库写不进去，注入那一半照做");
  assert.equal(ctx.warnings.length, 1, "失败要留痕，不静默");
  assert.match(ctx.warnings[0], /not recorded/);
  rescue.dispose();
});

test("#249 N3：队列满的丢弃必须留痕（§8 触发率口径）", async () => {
  const store = createStore(":memory:");
  const ctx = mockCtx();
  const rescue = createContinuityRescue(ctx, store);
  for (let i = 0; i < 200; i += 1) {
    store.saveContinuityProposal({ sessionId: `filler-${i}`, kind: KIND, currentWork: "占位" });
  }
  const session = fakeSession("s1", [userEvent(1, "指令")]);
  ctx.fire("session/event", session, { type: "compaction/end", seq: 3 });
  const decision = await ctx.fire("agent/pre-step", { agent: { session } }, async () => ({ kind: "enter", messages: [] }));
  assert.equal(store.getContinuityProposal("s1", KIND), null, "满队列弃新：本次触发不落库");
  assert.equal(decision.messages.length, 1, "但注入那一半照做（两半各自独立）");
  assert.ok(ctx.warnings.some((w) => w.includes("queue full")), "丢弃是静默失效的那一类，必须报出来");
  rescue.dispose();
});

test("#249 N3：门控不调模型（静态锁）与挂载点的父开关在前", () => {
  // §11「门控不调 LLM」：本模块只 import 消息工厂。静态锁而不是运行时断言——真去调模型的
  // 回归不会从返回值露出来，只会让这一步变慢、变贵。
  const src = readFileSync(new URL("../src/continuity.js", import.meta.url), "utf8");
  assert.deepEqual(src.match(/^import .*$/gm), ['import { createUserMessage } from "@deepseek-ai/dsh-llm";']);
  // 挂载点（`src/index.js`）是本功能唯一的生产入口：父开关必须在前、子项在后，否则「默认关」
  // 只剩 Config 里的默认值撑着，接线漏一次没人发现。
  const index = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(index, /if \(cfg\.autoInject && injectChildEnabled\(cfg, "continuityRescueEnabled"\)\) \{/);
  assert.match(index, /disposers\.push\(createContinuityRescue\(ctx, store\)\)/);
});

test("#249 N3：reject 放行且不消费边缘；缺 session 不抛", async () => {
  const store = createStore(":memory:");
  const ctx = mockCtx();
  const rescue = createContinuityRescue(ctx, store);
  const session = fakeSession("s1", [userEvent(1, "指令")]);
  ctx.fire("session/event", session, { type: "compaction/end", seq: 3 });

  const rejected = { kind: "reject", feedback: "no" };
  const viaReject = await ctx.fire("agent/pre-step", { agent: { session } }, async () => rejected);
  assert.equal(viaReject, rejected, "reject 原样返回——这一步不该发生，塞消息没有意义");
  assert.equal(store.countContinuityProposals(), 0, "边缘没被消费");
  const after = await ctx.fire("agent/pre-step", { agent: { session } }, async () => ({ kind: "enter", messages: [] }));
  assert.equal(after.messages.length, 1, "边缘留给下一次真正的步骤");

  ctx.fire("session/event", fakeSession("s2", []), { type: "compaction/end", seq: 4 });
  const noAgent = await ctx.fire("agent/pre-step", {}, async () => ({ kind: "enter", messages: [] }));
  assert.deepEqual(noAgent.messages, [], "拿不到 session 就什么都不做");
  rescue.dispose();
});

test("#249 N3：契约——默认关、父关不生效、轻量档压掉、降级规则只在开启时进描述", () => {
  assert.equal(Config({}).continuityRescueEnabled, false, "新增注入表面 → opt-in 默认关");
  assert.equal(applyLightModePreset({ lightMode: true }).continuityRescueEnabled, false, "轻量档压掉（同 injectGuidanceEnabled）");
  assert.equal(injectChildEnabled({ autoInject: false, continuityRescueEnabled: true }, "continuityRescueEnabled"), false, "父关则不生效");

  const plain = toolDescriptions({ continuityRescueEnabled: false });
  const on = toolDescriptions({ autoInject: true, continuityRescueEnabled: true });
  const gated = toolDescriptions({ autoInject: false, continuityRescueEnabled: true });
  assert.notEqual(on.get("memory_save"), plain.get("memory_save"), "开启时 memory_save 描述补降级规则");
  assert.equal(gated.get("memory_save"), plain.get("memory_save"), "父关 → 描述逐字节回到未开状态");
  assert.equal(on.get("memory_search"), plain.get("memory_search"), "其它工具的描述不受牵连");
  // 降级规则本身是可读的持久规则（宿主无压缩前时机时由 agent 自判），不是一句口号。
  for (const field of ["current_work", "next_step"]) {
    assert.ok(on.get("memory_save").includes(field), `降级规则要点名 ${field}`);
  }
});

test("#249 N3：存量库启动即建表（幂等迁移），重开后提案还在", () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-continuity-"));
  const path = join(dir, "memory.db");
  let store;
  let reopened;
  try {
    store = createStore(path);
    store.saveContinuityProposal({ sessionId: "s1", kind: KIND, currentWork: "重启前" });
    assert.equal(store.getContinuityProposal("s1", KIND).current_work, "重启前");
    reopened = createStore(path);
    assert.equal(reopened.getContinuityProposal("s1", KIND).current_work, "重启前", "SCHEMA 的 IF NOT EXISTS 让存量库重开也不用迁移");
    assert.equal(reopened.countContinuityProposals({ status: "pending" }), 1);
  } finally {
    // 先关句柄再删目录：断言失败时若还开着库，Windows 的 rmSync 会抛 EPERM 盖掉真因。
    try { reopened?.close(); } catch { /* 关闭失败不该掩盖断言差异 */ }
    try { store?.close(); } catch { /* 同上 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
