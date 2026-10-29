import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Context } from "@deepseek-ai/cordis";
import * as mneme from "../src/index.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSummarizer, parseSummaryJson, parsePeakSpec, isInPeakWindow, nextOffPeakAt } from "../src/summarize.js";
import { createSettings } from "../src/settings.js";

// Issue #239 第 4 项：可注入的假时钟 + 定时器——错峰队列的测试必须能「推进时间」，
// 真实 setTimeout 会让补跑路径要么测不到、要么拖慢测试。
function fakeClock(start) {
  let current = start.getTime();
  const timers = [];
  const deps = {
    now: () => current,
    setTimeoutFn: (fn, ms) => {
      const entry = { fn, at: current + ms };
      timers.push(entry);
      return entry;
    },
    clearTimeoutFn: (entry) => {
      const i = timers.indexOf(entry);
      if (i !== -1) timers.splice(i, 1);
    }
  };
  const flush = async () => {
    // 补跑是异步链（enqueueDistill → stream）：推完时间要给微任务与一轮宏任务机会。
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    deps,
    pending: () => timers.length,
    async advanceTo(date) {
      current = date.getTime();
      for (const entry of [...timers].sort((a, b) => a.at - b.at)) {
        if (entry.at > current) continue;
        timers.splice(timers.indexOf(entry), 1);
        entry.fn();
      }
      await flush();
    },
    async advance(ms) {
      await this.advanceTo(new Date(current + ms));
    }
  };
}

function setup(over = {}, opts = {}) {
  const store = opts.store ?? createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const events = [];
  const calls = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {
        const i = events.findIndex((e) => e.name === name && e.fn === fn);
        if (i !== -1) events.splice(i, 1);
      };
    },
    llm: {
      stream(options) {
        calls.push(options);
        if (opts.stream) return opts.stream(options);
        const json = JSON.stringify([
          { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 },
          { type: "preference", title: "语言", content: "用户喜欢中文交流", importance: 5 }
        ]);
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: json };
          yield { type: "block-end", block: { type: "text" } };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  const config = { autoSummarize: true, ...over };
  const summarizer = createSummarizer(ctx, service, config, opts.deps ?? {});
  return { store, service, events, calls, summarizer };
}

// A realistic direct human prompt event (source.kind === "user").
function userMessage(text, seq) {
  const event = {
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] }
  };
  if (seq !== undefined) event.seq = seq;
  return event;
}

function toolResultEvent(text, isError, seq) {
  return {
    seq,
    type: "tool/result",
    data: {
      message: {
        source: { kind: "tool", callId: `call-${seq}` },
        content: [{
          type: "tool-result",
          toolCallId: `call-${seq}`,
          isError,
          content: [{ type: "text", text }]
        }]
      }
    }
  };
}

// DSH 0.2.x 内核对工具结果的实际投递形状：内核给的是 `role:"tool"` 消息本身，
// content 里只有 `type:"text"` 块、isError 挂在消息上，不再有 tool-result 块。
// 蒸馏曾只认旧块形状，于是真实会话里的工具输出与工具报错全部被静默丢弃。
function toolRoleResultEvent(text, isError, seq) {
  return {
    seq,
    type: "tool/result",
    data: {
      message: {
        role: "tool",
        source: { kind: "tool", callId: `call-${seq}` },
        toolCallId: `call-${seq}`,
        content: [{ type: "text", text }],
        isError
      }
    }
  };
}

function codeDispatchEvent(text, isError, seq) {
  return {
    seq,
    type: "tool/code-dispatch",
    data: {
      isError,
      content: [{ type: "text", text }]
    }
  };
}

function inboxMessage(id, kind, text) {
  return {
    id,
    role: "user",
    source: { kind },
    content: [{ type: "text", text }]
  };
}

test("parseSummaryJson extracts valid entries and skips malformed ones", () => {
  const parsed = parseSummaryJson(`前导文字 {"a":1}
  [
    {"type":"decision","title":"t1","content":"c1","importance":4},
    {"type":"nonsense","title":"bad","content":"x"},
    "garbage",
    {"type":"preference","title":"t2","content":"c2","importance":2}
  ]`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].type, "decision");
  assert.equal(parsed[1].type, "preference");
});

// --- issue #339 / E8 考卷：JSON 崩溃窗口的 salvage（失败路径修复，默认开）-----
// E8 实测 10-20% 的窗口输出了含约束的完整对象，只因中段一处语法错误被整窗
// JSON.parse 拒收 → 生产行为 = 游标卡死 + 温度 0 重试同错 = 静默丢失。

test("parseSummaryJson salvages complete objects from a malformed array (issue #339)", () => {
  // E8 现场同款：闭合数组、中段对象含杂散引号（stray quote）。
  const raw = `[
    {"type":"constraint","title":"预算","content":"总额 $12,400","importance":4},
    { " "type": "history", "title": "坏对象", "content": "语法错误" },
    {"type":"preference","title":"硬件","content":"只要 brushed brass"}
  ]`;
  const parsed = parseSummaryJson(raw);
  assert.equal(parsed.length, 2, "the broken middle object is dropped, both survivors kept");
  assert.equal(parsed[0].content, "总额 $12,400");
  assert.equal(parsed[1].title, "硬件");
});

test("parseSummaryJson salvage finding nothing stays a failure (no fake empty success)", () => {
  // 只有一个语法坏掉的对象 → 救回 0 条：不得按「显式空数组」放行消费窗口。
  const raw = `[
    { " "type": "history", "title": "坏", "content": "语法错误" }
  ]`;
  const parsed = parseSummaryJson(raw);
  assert.deepEqual(parsed, []);
});

test("subscribes to session/event when autoSummarize enabled", () => {
  const { events } = setup();
  assert.ok(events.some((e) => e.name === "session/event"));
});

test("does not subscribe when autoSummarize disabled", () => {
  const { events } = setup({ autoSummarize: false });
  assert.ok(!events.some((e) => e.name === "session/event"));
});

test("turn/end event triggers summarization and stores entries", async () => {
  const { events, store } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s1",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("帮我选型"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 2);
  const all = store.all();
  assert.ok(all.some((m) => m.type === "decision"));
  assert.ok(all.some((m) => m.type === "preference"));
});

test("skips summarization for events other than turn/end", async () => {
  const { events, store, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = { id: "s1", requestHeader: () => ({ config: {} }), events: [] };
  await handler(session, { seq: 1, type: "user/message" });
  assert.equal(store.count(), 0);
  assert.equal(calls.length, 0);
});

// DSH ≥0.1.2-rc removed Session.events; the session object only exposes
// snapshotEvents(). Regression for #59: with only the old .events path the
// collector saw an empty log and no LLM call ever happened.
test("reads events from snapshotEvents() when Session.events is absent", async () => {
  const { events, store, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s1",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    snapshotEvents: () => [userMessage("帮我选型"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "an LLM call must be made");
  assert.equal(store.count(), 2);
});

// --- Issue #239：成本感知级联（零 LLM 预判）与有界检查点 ---------------------
// 验收对齐 #239：日志可见 skip 原因、默认配置下行为零变化、开启后调用量下降。

test("#239 预判默认关：阈值为 0 时不改变现状，照常发起调用", async () => {
  const { events, calls, store } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s239-default",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("短", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "默认不预判：再短的窗口也照常蒸馏");
  assert.equal(store.count(), 2);
});

test("#239 窗口过短：零 LLM 预判拦下调用，留 skip 审计并消费游标", async () => {
  const { events, calls, service, store } = setup({ summarizeMinWindowChars: 1000 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s239-small",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("好", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 0, "短窗口不得发起 LLM 调用");
  assert.equal(store.count(), 0, "被拦下就不该写入记忆");
  const rows = service.listLlmAudits();
  assert.equal(rows[0].status, "skipped");
  assert.equal(rows[0].error_message, "window-too-small", "skip 原因必须可观测");

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 0);
  assert.equal(service.listLlmAudits().length, 1, "游标已消费：同一窗口不重复评估、不重复审计");
});

// #239 定标埋点：窗口字符数必须落进审计，否则下一级预判规则的阈值无从选起。
// 第二条才是本改动的目的——预判开关关着（默认档位）时行为逐字节不变，但从这一刻
// 起成功行开始留数，验收 4「默认配置下调用量可量化下降」才有账可对。
test("#239 计量：window-too-small 的 skip 行带 distillChars 与阈值", async () => {
  const { events, service } = setup({ summarizeMinWindowChars: 1000 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s239-metric-skip",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("好", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  const row = service.listLlmAudits()[0];
  assert.equal(row.error_message, "window-too-small");
  // 计的是**真正发给模型的转录文本**长度（含角色前缀：一条 1 字的「好」实测记 4），
  // 与闸门比较的口径同一个数，定标才对得上。这里不锁字面量，锁语义：短于阈值才该 skip。
  assert.ok(Number.isInteger(row.metadata?.distillChars) && row.metadata.distillChars > 0,
    "skip 行必须带窗口字符数");
  assert.equal(row.metadata.minWindowChars, 1000, "阈值随行落档，事后能复核是哪条闸门拦的");
  assert.ok(row.metadata.distillChars < row.metadata.minWindowChars, "skip 的前提：窗口短于阈值");
});

test("#239 计量：预判开关关闭时成功行仍记录 distillChars", async () => {
  const { events, service } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s239-metric-success",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("今天决定把窗口字符数记进审计", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  const row = service.listLlmAudits()[0];
  assert.equal(row.status, "success");
  assert.ok(Number.isInteger(row.metadata?.distillChars) && row.metadata.distillChars > 0,
    "默认档位下也要留数，否则验收 4 无从对账");
});

test("#239 窗口达到阈值时预判放行（不误杀）", async () => {
  const { events, calls } = setup({ summarizeMinWindowChars: 5 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s239-pass",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("这是一段足够长的用户输入", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
});

test("#239 每会话 run 预算：额度用尽后不再调用，审计写明原因", async () => {
  const { events, calls, service } = setup({ summarizeMaxRunsPerSession: 1, distillRateLimitIntervalMs: 0 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s239-cap",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("第一轮", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "第一次在预算内");

  session.events.push(userMessage("第二轮", 3), { seq: 4, type: "turn/end" });
  await handler(session, { seq: 4, type: "turn/end" });
  assert.equal(calls.length, 1, "预算用尽后不得再调用");
  const rows = service.listLlmAudits();
  assert.equal(rows[0].status, "skipped");
  assert.equal(rows[0].error_message, "max-runs-per-session");
});

test("#239 预算只计真实调用：被预判拦下的窗口不消耗额度", async () => {
  const { events, calls } = setup({ summarizeMaxRunsPerSession: 1, summarizeMinWindowChars: 10, distillRateLimitIntervalMs: 0 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s239-budget",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("短", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 0, "第一轮被零 LLM 预判拦下");

  session.events.push(userMessage("第二轮写得足够长，应该放行并消耗唯一的一次额度", 3), { seq: 4, type: "turn/end" });
  await handler(session, { seq: 4, type: "turn/end" });
  assert.equal(calls.length, 1, "零成本窗口不该吃掉预算");
});

// --- Issue #239 第 4 项：错峰队列 -------------------------------------------------

test("#239-4 高峰时段解析：合法 / 多段 / 跨零点 / 星期前缀 / 非法一律按未配置", () => {
  assert.equal(parsePeakSpec(""), null);
  assert.equal(parsePeakSpec("   "), null);
  assert.deepEqual(parsePeakSpec("09:00-18:00"), { days: null, windows: [{ start: 540, end: 1080 }] });
  assert.deepEqual(parsePeakSpec("09:00-12:00, 14:00-18:00"), {
    days: null,
    windows: [{ start: 540, end: 720 }, { start: 840, end: 1080 }]
  });
  assert.deepEqual(parsePeakSpec("23:00-06:00"), { days: null, windows: [{ start: 1380, end: 360 }] });
  // 星期前缀：ISO 1=周一…7=周日，也认 mon..sun；支持列表与跨周环绕
  assert.deepEqual(parsePeakSpec("mon-fri 08:00-12:00,14:00-18:00"), {
    days: [1, 2, 3, 4, 5],
    windows: [{ start: 480, end: 720 }, { start: 840, end: 1080 }]
  });
  assert.deepEqual(parsePeakSpec("1-5 08:00-12:00").days, [1, 2, 3, 4, 5]);
  assert.deepEqual(parsePeakSpec("sat,sun 10:00-12:00").days, [6, 7]);
  assert.deepEqual(parsePeakSpec("fri-mon 10:00-12:00").days, [1, 5, 6, 7], "跨周环绕");
  // 排程是省钱手段，绝不该因为写错格式把蒸馏停掉：任何非法写法都当作「关闭」。
  for (const bad of ["09:00~18:00", "24:00-06:00", "09:60-18:00", "09:00-09:00", "abc", "09:00-18:00,oops", "weekday 09:00-18:00", "8 09:00-18:00"]) {
    assert.equal(parsePeakSpec(bad), null, `${bad} 应视为未配置`);
  }
});

test("#239-4 高峰判定与补跑时刻（跨零点、右开区间）", () => {
  const at = (h, m) => new Date(2026, 8, 19, h, m, 30);
  assert.equal(isInPeakWindow(at(10, 0), "09:00-18:00"), true);
  assert.equal(isInPeakWindow(at(18, 0), "09:00-18:00"), false, "右开区间：18:00 已出高峰");
  assert.equal(isInPeakWindow(at(3, 0), "23:00-06:00"), true, "跨零点时段");
  assert.equal(isInPeakWindow(at(12, 0), "23:00-06:00"), false);
  assert.equal(isInPeakWindow(at(10, 0), ""), false, "未配置 = 永不高峰");
  const next = nextOffPeakAt(at(10, 30), "09:00-18:00");
  assert.equal(next.getHours(), 18);
  assert.equal(next.getMinutes(), 0);
  assert.equal(nextOffPeakAt(at(3, 0), "23:00-06:00").getHours(), 6, "跨零点取次日 06:00 结束点");
  assert.equal(nextOffPeakAt(at(20, 0), "09:00-18:00"), null, "非高峰时刻无需补跑");
});

// 夹具：按 ISO 星期几（1=周一…7=周日）从当月 1 号推算出日期，避免把星期写死在测试里。
function dateOnIsoDay(isoDay, hour, minute) {
  const first = new Date(2026, 8, 1, hour, minute, 0);
  const firstIso = first.getDay() === 0 ? 7 : first.getDay();
  return new Date(2026, 8, 1 + ((isoDay - firstIso + 7) % 7), hour, minute, 0);
}

test("#239-4 星期过滤：工作日高峰不误伤周末（跨零点段按「开窗那天」认星期）", () => {
  const spec = "mon-fri 08:00-12:00,14:00-18:00";
  assert.equal(dateOnIsoDay(1, 9, 0).getDay(), 1, "夹具自检：周一");
  assert.equal(dateOnIsoDay(6, 9, 0).getDay(), 6, "夹具自检：周六");
  assert.equal(isInPeakWindow(dateOnIsoDay(1, 9, 0), spec), true, "工作日 09:00 在高峰");
  assert.equal(isInPeakWindow(dateOnIsoDay(1, 12, 30), spec), false, "工作日午休不在高峰");
  assert.equal(isInPeakWindow(dateOnIsoDay(6, 9, 0), spec), false, "周六同刻不在高峰（按周计费）");
  assert.equal(isInPeakWindow(dateOnIsoDay(7, 15, 0), spec), false, "周日下午不在高峰");
  assert.equal(nextOffPeakAt(dateOnIsoDay(1, 9, 0), spec).getHours(), 12, "工作日顺延到 12:00");
  assert.equal(nextOffPeakAt(dateOnIsoDay(6, 9, 0), spec), null, "周末无需顺延");
  // 跨零点段：周五 23:00 开的窗口延续到周六凌晨，仍算高峰；周六开的则不覆盖周日
  const overnight = "mon-fri 23:00-06:00";
  assert.equal(isInPeakWindow(dateOnIsoDay(6, 2, 0), overnight), true, "周六 02:00 属周五开的窗口");
  assert.equal(isInPeakWindow(dateOnIsoDay(7, 2, 0), overnight), false, "周日 02:00 属周六开的窗口（周六不在集合内）");
});

test("#239-4 默认关：未配置高峰时行为与现状一致", async () => {
  const clock = fakeClock(new Date(2026, 8, 19, 10, 0, 0));
  const { events, calls } = setup({}, { deps: clock.deps });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s239-peak-off",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("普通一轮", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "未配置高峰 → 照常蒸馏");
  assert.equal(clock.pending(), 0, "不该挂补跑定时器");
});

test("#239-4 高峰内不调模型：skip 审计 + 不消费游标，非高峰补跑整窗", async () => {
  const clock = fakeClock(new Date(2026, 8, 19, 10, 0, 0));
  const { events, calls, service, store } = setup(
    { summarizePeakHours: "09:00-18:00", distillRateLimitIntervalMs: 0 },
    { deps: clock.deps }
  );
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s239-peak",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("高峰里的第一段", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 0, "高峰期不得调模型");
  assert.equal(store.count(), 0, "不该写入记忆");
  const rows = service.listLlmAudits();
  assert.equal(rows[0].status, "skipped");
  assert.equal(rows[0].error_message, "peak-hours", "skip 原因必须可观测");
  assert.equal(clock.pending(), 1, "应挂一个补跑定时器");

  // 高峰期间又来一轮：游标未消费 → 窗口累积；仍不调模型、定时器不叠加
  session.events.push(userMessage("高峰里的第二段", 3), { seq: 4, type: "turn/end" });
  await handler(session, { seq: 4, type: "turn/end" });
  assert.equal(calls.length, 0);
  assert.equal(clock.pending(), 1, "每会话只挂一个定时器");

  // 推到非高峰：一次补跑，且蒸到的是累积后的整窗
  await clock.advanceTo(new Date(2026, 8, 19, 18, 0, 5));
  assert.equal(calls.length, 1, "非高峰补跑一次");
  const prompt = JSON.stringify(calls[0].messages);
  assert.ok(prompt.includes("高峰里的第一段") && prompt.includes("高峰里的第二段"),
    "补跑应蒸馏累积后的完整窗口");
  assert.ok(store.count() > 0, "补跑真的写入了记忆");
});

test("#239-4 顺延上限：长高峰到点照跑，不饿死蒸馏", async () => {
  const clock = fakeClock(new Date(2026, 8, 19, 9, 0, 0));
  const { events, calls } = setup(
    { summarizePeakHours: "09:00-18:00", summarizePeakMaxDeferMinutes: 30, distillRateLimitIntervalMs: 0 },
    { deps: clock.deps }
  );
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s239-peak-cap",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("长高峰里的一轮", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 0, "高峰内先顺延");
  await clock.advance(31 * 60000);
  assert.equal(calls.length, 1, "上限到点仍处高峰也照跑（bypassPeak）");
});

test("does not call the LLM when no event was added after the last successful seq", async () => {
  const { events, calls } = setup({ distillRateLimitIntervalMs: 0 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const transcript = [userMessage("首轮", 1), { seq: 2, type: "turn/end" }];
  const ranges = [];
  const session = {
    id: "s-noop",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    snapshotEvents(fromSeq, toSeq) {
      ranges.push([fromSeq, toSeq]);
      return transcript;
    }
  };

  await handler(session, { seq: 2, type: "turn/end" });
  await handler(session, { seq: 2, type: "turn/end" });

  assert.equal(calls.length, 1, "a successful window must not be distilled twice");
  assert.equal(ranges[1][0], 2, "the successful event seq is passed as the next snapshot lower bound");
});

test("resumes a persisted seq cursor after the summarizer is restarted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-distill-cursor-"));
  const dbPath = join(dir, "memory.db");
  let firstStore;
  let firstSummarizer;
  let secondStore;
  let secondSummarizer;
  try {
    firstStore = createStore(dbPath);
    const first = setup({ distillRateLimitIntervalMs: 0 }, { store: firstStore });
    firstSummarizer = first.summarizer;
    const session = {
      id: "s-restart",
      requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
      events: [userMessage("重启前的窗口", 1), { seq: 2, type: "turn/end" }]
    };
    const firstHandler = first.events.find((e) => e.name === "session/event").fn;
    await firstHandler(session, { seq: 2, type: "turn/end" });
    assert.equal(first.calls.length, 1);
    assert.equal(firstStore.getDistillCursor("s-restart").last_seq, 2);

    firstSummarizer.dispose();
    firstStore.close();
    firstSummarizer = undefined;
    firstStore = undefined;

    secondStore = createStore(dbPath);
    const second = setup({ distillRateLimitIntervalMs: 0 }, { store: secondStore });
    secondSummarizer = second.summarizer;
    const secondHandler = second.events.find((e) => e.name === "session/event").fn;
    await secondHandler(session, { seq: 2, type: "turn/end" });

    assert.equal(second.calls.length, 0, "a restarted summarizer must reuse the persisted cursor");
    assert.equal(secondStore.count(), 2, "the restart must not duplicate memories");
    assert.equal(secondStore.getDistillCursor("s-restart").last_seq, 2);
  } finally {
    secondSummarizer?.dispose();
    secondStore?.close();
    firstSummarizer?.dispose();
    firstStore?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("treats a valid empty summary as a successful cursor commit", async () => {
  const { events, store, calls } = setup(
    { distillRateLimitIntervalMs: 0 },
    { stream: streamOf([]) }
  );
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-empty-summary",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("这一轮没有可保存的长期记忆", 1), { seq: 2, type: "turn/end" }]
  };

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(store.count(), 0);
  assert.equal(store.getDistillCursor(session.id).last_seq, 2);

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "a valid empty summary must consume the window once");
});

test("advances the cursor to the window end for mixed valid and invalid entries", async () => {
  const valid = { type: "history", title: "有效摘要", content: "只保存这一条", importance: 3 };
  const { events, store, calls } = setup(
    { distillRateLimitIntervalMs: 0 },
    { stream: streamOf([valid, { type: "unknown", title: "无效摘要", content: "忽略" }, null]) }
  );
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-mixed-summary",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("混合摘要窗口", 1), { seq: 2, type: "assistant/message" }, { seq: 3, type: "turn/end" }]
  };

  await handler(session, { seq: 3, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(store.count(), 1);
  assert.equal(store.all()[0].title, valid.title);
  assert.equal(store.getDistillCursor(session.id).last_seq, 3);

  await handler(session, { seq: 3, type: "turn/end" });
  assert.equal(calls.length, 1, "a mixed summary must consume the window once");
});

test("distills only new seq events and keeps the recent tail when a window exceeds distillMaxChars", async () => {
  const { events, calls } = setup(
    { distillMaxChars: 80, distillRateLimitIntervalMs: 0 },
    { stream: streamOf([]) }
  );
  const handler = events.find((e) => e.name === "session/event").fn;
  const transcript = [
    userMessage(`OLD_BEGINNING ${"x".repeat(160)} OLD_RECENT`, 1),
    { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "旧回复" }] } } },
    { seq: 3, type: "turn/end" }
  ];
  const session = {
    id: "s-incremental",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    snapshotEvents: () => transcript
  };

  await handler(session, { seq: 3, type: "turn/end" });
  const firstInput = calls[0].messages.find((message) => message.role === "user").content[0].text;

  transcript.push(
    userMessage(`NEW_BEGINNING ${"y".repeat(160)} NEW_RECENT`, 4),
    { seq: 5, type: "assistant/message", data: { message: { content: [{ type: "text", text: "新回复" }] } } },
    { seq: 6, type: "turn/end" }
  );
  await handler(session, { seq: 6, type: "turn/end" });
  const secondInput = calls[1].messages.find((message) => message.role === "user").content[0].text;

  assert.notEqual(firstInput, secondInput, "successive distills must receive different windows");
  assert.ok(secondInput.includes("NEW_RECENT"), "the newest event content remains in the bounded window");
  assert.ok(!secondInput.includes("OLD_BEGINNING"), "the second window must not restart at the session beginning");
  assert.ok(!secondInput.includes("OLD_RECENT"), "the previous successful window must not be repeated");
});

test("dispose unsubscribes and stops later turn/end events from summarizing", async () => {
  const { events, summarizer, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  summarizer.dispose();
  // The ctx.on() disposer must have removed the listener.
  assert.ok(!events.some((e) => e.name === "session/event"));
  const session = {
    id: "s1",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("你好"), { seq: 2, type: "turn/end" }]
  };
  // Even a stale handler reference must not start a new LLM call.
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 0);
});

test("excludes plugin-injected user/message events from summarization input", async () => {
  const { events, store, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s2",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      {
        seq: 1,
        type: "user/message",
        data: { source: { kind: "plugin" }, content: [{ type: "text", text: "AGENTS.md 内容" }] }
      },
      userMessage("帮我看看这个报错"),
      { seq: 3, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 3, type: "turn/end" });
  assert.equal(calls.length, 1);
  const userMessages = calls[0].messages.filter((m) => m.role === "user");
  assert.equal(userMessages.length, 1);
  assert.ok(!JSON.stringify(calls[0].messages).includes("AGENTS.md"));
  assert.equal(store.count(), 2);
});

test("aborted finish does not store entries and leaves the seq window retryable", async () => {
  let attempt = 0;
  const { events, store, calls } = setup({ distillRateLimitIntervalMs: 0 }, {
    stream() {
      attempt++;
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        if (attempt === 1) {
          yield { type: "text-delta", delta: "[]" };
          yield { type: "finish", kind: "aborted" };
          return;
        }
        yield { type: "text-delta", delta: JSON.stringify([{ type: "history", title: "重试", content: "保留原窗口", importance: 3 }]) };
        yield { type: "finish", kind: "ok" };
      })();
    }
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s3",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("继续", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1); // the stream was actually reached
  assert.equal(store.count(), 0);
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "an aborted window must be retried instead of being marked consumed");
  assert.equal(store.count(), 1);
});

test("a stream failure leaves the seq window retryable", async () => {
  let attempt = 0;
  const { events, store, calls } = setup({ distillRateLimitIntervalMs: 0 }, {
    stream() {
      attempt++;
      if (attempt === 1) {
        return (async function* () {
          throw new Error("temporary stream failure");
        })();
      }
      return streamOf([{ type: "history", title: "重试成功", content: "失败窗口未丢失", importance: 3 }])();
    }
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-stream-failure",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("保留失败窗口", 1), { seq: 2, type: "turn/end" }]
  };

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(store.count(), 0);
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "a failed stream must be retried even without new events");
  assert.equal(store.count(), 1);
});

test("invalid summary JSON leaves the seq window retryable", async () => {
  let attempt = 0;
  const { events, store, calls } = setup({ distillRateLimitIntervalMs: 0 }, {
    stream() {
      attempt++;
      const output = attempt === 1 ? "not a JSON array" : "[]";
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: output };
        yield { type: "finish", kind: "ok" };
      })();
    }
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-parse-failure",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("保留解析窗口", 1), { seq: 2, type: "turn/end" }]
  };

  await handler(session, { seq: 2, type: "turn/end" });
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "a parse failure must not advance the seq cursor");
  assert.equal(store.count(), 0, "the valid empty retry remains a no-op");
});

test("a JSON-crashed window with salvageable objects is recovered, consumed once, and audited (issue #339)", async (t) => {
  const malformed = `[
    {"type":"constraint","title":"预算","content":"总额 $12,400","importance":4},
    { " "type": "history", "title": "坏对象", "content": "语法错误" },
    {"type":"preference","title":"硬件","content":"只要 brushed brass"}
  ]`;
  const { events, service, store, calls, summarizer } = setup({ distillRateLimitIntervalMs: 0 }, {
    stream() {
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: malformed };
        yield { type: "finish", kind: "ok" };
      })();
    }
  });
  t.after(() => { summarizer.dispose(); store.close(); });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-salvage",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("带语法错误的蒸馏窗口", 1), { seq: 2, type: "turn/end" }]
  };

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(service.count(), 2, "the two intact objects are written, the broken one dropped");
  const titles = service.list().map((m) => m.title).sort();
  assert.deepEqual(titles, ["硬件", "预算"]);
  assert.equal(calls.length, 1, "salvage consumed the window: no same-window retry");
  const audit = service.listLlmAudits().find((r) => r.status === "success");
  assert.ok(audit, "salvaged run is audited as a success");
  assert.equal(audit.metadata?.json_salvaged, true, "salvage is observable in the audit trail");

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "the consumed window is not re-distilled");
  assert.equal(service.count(), 2, "no duplicate writes on the second turn/end");
});

test("a JSON-crashed window with nothing salvageable stays retryable (issue #339)", async (t) => {
  const hopeless = `[
    { " "type": "history", "title": "坏", "content": "语法错误" }
  ]`;
  let attempt = 0;
  const { events, service, store, calls, summarizer } = setup({ distillRateLimitIntervalMs: 0 }, {
    stream() {
      const output = attempt++ === 0 ? hopeless : `[
        {"type":"history","title":"重试成功","content":"干净窗口","importance":3}
      ]`;
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: output };
        yield { type: "finish", kind: "ok" };
      })();
    }
  });
  t.after(() => { summarizer.dispose(); store.close(); });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-salvage-none",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("救不回的窗口", 1), { seq: 2, type: "turn/end" }]
  };

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(service.count(), 0, "zero salvage is not a fake success");
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "the window stays retryable");
  assert.equal(service.count(), 1);
  assert.ok(service.listLlmAudits().some(
    (r) => r.status === "error" && r.error_message === "invalid summary JSON"
  ), "zero-salvage run keeps the error audit");
});

test("an all-invalid summary leaves the same window retryable until valid memories are saved", async (t) => {
  for (const invalid of [
    [{}],
    [{ type: "unknown", title: "无效类型", content: "不能消费窗口" }],
    [{ type: "history", title: " ", content: "不能消费窗口" }, null, "garbage"]
  ]) {
    await t.test(JSON.stringify(invalid), async (t) => {
      let attempt = 0;
      const valid = { type: "history", title: "重试成功", content: "全无效摘要后仍保留原窗口", importance: 3 };
      const { events, service, store, calls, summarizer } = setup({ distillRateLimitIntervalMs: 0 }, {
        stream() {
          return streamOf(attempt++ === 0 ? invalid : [valid])();
        }
      });
      t.after(() => { summarizer.dispose(); store.close(); });
      const handler = events.find((e) => e.name === "session/event").fn;
      const session = {
        id: "s-all-invalid",
        requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
        events: [userMessage("保留原窗口", 1), { seq: 2, type: "turn/end" }]
      };

      await handler(session, { seq: 2, type: "turn/end" });
      assert.equal(service.count(), 0);
      await handler(session, { seq: 2, type: "turn/end" });
      assert.equal(calls.length, 2, "all-invalid entries must not consume the window");
      const firstTranscript = calls[0].messages.find((message) => message.role === "user").content[0].text;
      const retryTranscript = calls[1].messages.find((message) => message.role === "user").content[0].text;
      assert.equal(retryTranscript, firstTranscript, "retry receives the original transcript");
      assert.equal(service.count(), 1);
      assert.equal(service.list()[0].content, valid.content);
      // #502：这一族（JSON 合法、条目全被枚举滤掉）从此报成 filtered-empty 的专属消息，
      // 不再与「模型压根没写数组」共用 invalid summary JSON。状态与「窗口可重试」不变，
      // 所以下面三条断言一条都不放松。
      assert.ok(service.listLlmAudits({ source: "autoSummarize" }).some(
        (audit) => audit.status === "error" && audit.error_message === `no valid summary entries (arr=${invalid.length}, valid=0)`
      ), "an all-invalid summary must be audited as an error, named as a filtered-empty window");
      // metadata 读回来可能是串也可能是对象（store 存的是 JSON 串，列表接口按形状
      // 解析过），两种形状都归一成串再判——否则这条锁会随下游解析行为假红。
      const metaText = (audit) => {
        const m = audit.metadata;
        if (typeof m === "string") return m;
        try { return JSON.stringify(m ?? ""); } catch { return ""; }
      };
      assert.ok(service.listLlmAudits({ source: "autoSummarize" }).some(
        (audit) => audit.status === "error" && metaText(audit).includes("filtered-empty")
      ), "metadata 要能说出是滤空而不是没写格式（sample_types 带着模型自造的分类词）");

      await handler(session, { seq: 2, type: "turn/end" });
      assert.equal(calls.length, 2, "the successfully retried window is consumed once");
      assert.equal(service.count(), 1);
    });
  }
});

test("rolls back partial memory writes so retrying a failed window does not duplicate entries", async () => {
  const { events, store, service, calls } = setup(
    { distillRateLimitIntervalMs: 0 },
    {
      stream: streamOf([
        { type: "history", title: "第一条", content: "第一条内容", importance: 3 },
        { type: "decision", title: "第二条", content: "第二条内容", importance: 4 }
      ])
    }
  );
  const originalSave = service.saveWithDedupe.bind(service);
  let failOnSecondEntry = true;
  service.saveWithDedupe = (memory) => {
    const result = originalSave(memory);
    if (failOnSecondEntry && memory.title === "第二条") {
      failOnSecondEntry = false;
      throw new Error("simulated memory write failure");
    }
    return result;
  };
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-partial-write",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("不要丢失这个窗口", 1), { seq: 2, type: "turn/end" }]
  };

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(store.count(), 0, "a failed write transaction must leave no partial memory");
  assert.equal(store.getDistillCursor("s-partial-write"), undefined, "a failed write must not advance the cursor");

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "the failed seq window must be retried");
  assert.equal(store.count(), 2);
  assert.equal(store.getDistillCursor("s-partial-write").last_seq, 2);
  assert.equal(store.all().find((memory) => memory.title === "第一条")?.content, "第一条内容");

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "a successfully retried window must not be distilled again");
  assert.equal(store.count(), 2);
});

test("rolls back memory writes when persisting the cursor fails", async () => {
  const { events, store, service, calls } = setup(
    { distillRateLimitIntervalMs: 0 },
    { stream: streamOf([{ type: "history", title: "游标失败", content: "事务应回滚", importance: 3 }]) }
  );
  const originalSetCursor = service.setDistillCursor.bind(service);
  let failOnce = true;
  service.setDistillCursor = (sessionId, lastSeq) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("simulated cursor write failure");
    }
    return originalSetCursor(sessionId, lastSeq);
  };
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-cursor-write-failure",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("游标写入失败也不能丢窗口", 1), { seq: 2, type: "turn/end" }]
  };

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(store.count(), 0, "cursor failure must roll back the memory write");
  assert.equal(store.getDistillCursor(session.id), undefined);
  const failedAudit = service.listLlmAudits({ source: "autoSummarize" }).find(
    (audit) => audit.error_message === "simulated cursor write failure"
  );
  assert.equal(failedAudit?.status, "error", "cursor failure must not be audited as success");

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "the failed cursor window must be retryable");
  assert.equal(store.count(), 1);
  assert.equal(store.getDistillCursor(session.id).last_seq, 2);
});

test("falls back to the in-memory cursor when service lacks setDistillCursor", async () => {
  // 旧版 service（#274 之前）没有持久化游标：缺方法必须降级为内存游标照常蒸馏，
  // 而不是抛错打断每轮蒸馏。方法存在但抛错走的是上一条回滚用例，两者不可混淆。
  const { events, store, service, calls } = setup(
    { distillRateLimitIntervalMs: 0 },
    { stream: streamOf([{ type: "history", title: "降级游标", content: "缺方法也能蒸馏", importance: 3 }]) }
  );
  delete service.setDistillCursor; // 模拟旧版 service：实例属性，直接删掉
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-no-cursor-api",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("旧宿主没有游标接口", 1), { seq: 2, type: "turn/end" }]
  };

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "distillation must still run without a persisted cursor");
  assert.equal(store.count(), 1, "the memory itself must be saved");
  assert.equal(store.getDistillCursor(session.id), undefined, "nothing may be persisted without the API");

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "the in-memory cursor must prevent re-distillation in this process");
});

test("uses summarizeProvider/summarizeModel config override when set", async () => {
  const { events, calls } = setup({
    summarizeProvider: "aliyun",
    summarizeModel: "qwen3.6-plus"
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s4",
    // Session header has a different model — config override should win.
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-v4-pro" } }),
    events: [userMessage("测试覆盖"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "aliyun");
  assert.equal(calls[0].model, "qwen3.6-plus");
});

test("falls back to session header when summarize config is empty", async () => {
  const { events, calls } = setup({
    summarizeProvider: "",
    summarizeModel: ""
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s5",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("回退测试"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "deepseek");
  assert.equal(calls[0].model, "deepseek-chat");
});

// ── v0.7.11：智能调速器（429 保护）+ 完整转录/原子记忆 ─────────────────────

test("serializes distill LLM calls across sessions (global queue, no concurrency)", async () => {
  const timeline = [];
  const { events, store } = setup({ distillRateLimitIntervalMs: 0 }, {
    stream() {
      return (async function* () {
        timeline.push(`start:${Date.now()}`);
        await new Promise((r) => setTimeout(r, 8));
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: "[]" };
        yield { type: "finish", kind: "ok" };
        timeline.push(`end:${Date.now()}`);
      })();
    }
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const mkSession = (id) => ({
    id,
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage(`问题${id}`), { seq: 2, type: "turn/end" }]
  });
  // 两个会话几乎同时 turn/end → 必须排队，第二个请求不能与第一个并发。
  await Promise.all([
    handler(mkSession("a"), { seq: 2, type: "turn/end" }),
    handler(mkSession("b"), { seq: 2, type: "turn/end" })
  ]);
  assert.equal(timeline.length, 4); // 每个流 start + end
  const starts = timeline.filter((t) => t.startsWith("start")).map((t) => Number(t.slice(6)));
  const ends = timeline.filter((t) => t.startsWith("end")).map((t) => Number(t.slice(4)));
  assert.ok(starts[1] >= ends[0], "second distill must start only after the first finished (serial queue)");
});

test("retries with exponential backoff on 429 and still stores entries", async () => {
  let attempts = 0;
  const { events, store } = setup(
    { distillRateLimitRetries: 3, distillRateLimitBaseDelayMs: 5, distillRateLimitIntervalMs: 0 },
    {
      stream() {
        return (async function* () {
          attempts++;
          if (attempts < 3) throw Object.assign(new Error("rate limit exceeded"), { status: 429 });
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: JSON.stringify([{ type: "history", title: "重试成功", content: "第三次请求成功", importance: 3 }]) };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  );
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s9",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("限流测试"), { seq: 2, type: "turn/end" }]
  };
  const startedAt = Date.now();
  await handler(session, { seq: 2, type: "turn/end" });
  // 429 两次 → 退避重试（5ms + 10ms），第三次成功入库。
  assert.equal(attempts, 3);
  assert.ok(Date.now() - startedAt >= 15, "backoff waits should be visible");
  assert.equal(store.count(), 1);
  assert.equal(store.all()[0].title, "重试成功");
});

test("distills full transcript (tool calls, results, code output) with atomic-memory prompt", async () => {
  const { events, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s10",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      userMessage("帮我修这个 bug"),
      { seq: 2, type: "tool/call", data: { name: "Bash", arguments: "node test.js" } },
      toolResultEvent("TypeError: x is not a function", true, 3),
      codeDispatchEvent("fixed", false, 4),
      { seq: 5, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 5, type: "turn/end" });
  const transcript = JSON.stringify(calls[0].messages);
  assert.ok(transcript.includes("修这个 bug"));
  assert.ok(transcript.includes("TypeError: x is not a function"));
  assert.ok(transcript.includes("代码执行"));
  // 原子记忆 prompt：不再"硬压 2-3 条"，而是按需多提、贴近原始细节。
  assert.ok(calls[0].messages[0].content[0].text.includes("原子记忆"));
});

test("collects real tool result and code dispatch payloads with failure status", async () => {
  const { events, calls } = setup({ distillRateLimitIntervalMs: 0 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-real-payloads",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      userMessage("检查真实事件形状", 1),
      toolResultEvent("TypeError: tool failed", true, 2),
      codeDispatchEvent("代码执行结果", false, 3),
      { seq: 4, type: "turn/end" }
    ]
  };

  await handler(session, { seq: 4, type: "turn/end" });
  const transcript = calls[0].messages.find((message) => message.role === "user").content[0].text;
  assert.match(transcript, /工具结果（失败）：TypeError: tool failed/);
  assert.match(transcript, /代码执行（成功）：代码执行结果/);
});

test("collects tool results delivered as role:tool messages, keeping the legacy block shape", async () => {
  const { events, calls } = setup({ distillRateLimitIntervalMs: 0 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-tool-role-shape",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      userMessage("检查工具结果两种形状", 1),
      toolResultEvent("旧形状载荷", false, 2),
      toolRoleResultEvent("新形状载荷", false, 3),
      toolRoleResultEvent("TypeError: tool crashed", true, 4),
      { seq: 5, type: "turn/end" }
    ]
  };

  await handler(session, { seq: 5, type: "turn/end" });
  const transcript = calls[0].messages.find((message) => message.role === "user").content[0].text;
  assert.match(transcript, /工具结果（成功）：旧形状载荷/);
  assert.match(transcript, /工具结果（成功）：新形状载荷/);
  assert.match(transcript, /工具结果（失败）：TypeError: tool crashed/);
});

test("keeps prefix trimming for tool results delivered as role:tool messages", async () => {
  const { events, calls } = setup({ distillRateLimitIntervalMs: 0 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-tool-role-trim",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      userMessage("检查新形状截断", 1),
      toolRoleResultEvent(`OUT_START ${"c".repeat(550)} OUT_END`, false, 2),
      { seq: 3, type: "turn/end" }
    ]
  };

  await handler(session, { seq: 3, type: "turn/end" });
  const transcript = JSON.stringify(calls[0].messages);
  assert.ok(transcript.includes("OUT_START"));
  assert.ok(!transcript.includes("OUT_END"), "role:tool 结果同样走 500 字符前缀截断");
});

test("collects subagent delivery once across inbox and user-message views", async () => {
  const { events, calls } = setup({ distillRateLimitIntervalMs: 0 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const delivery = inboxMessage("delivery-1", "subagent-settled", "子会话 closing message");
  const agentMessage = inboxMessage("delivery-2", "agent-message", "子代理补充报告");
  const injectedInstruction = inboxMessage("instruction-1", "agent-instructions", "不要把这条注入指令沉淀为记忆");
  const session = {
    id: "s-agent-delivery",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      userMessage("检查子会话交付", 1),
      { seq: 2, type: "agent/inbox/spliced", data: { inserted: [delivery, agentMessage, injectedInstruction] } },
      { seq: 3, type: "user/message", data: delivery },
      { seq: 4, type: "turn/end" }
    ]
  };

  await handler(session, { seq: 4, type: "turn/end" });
  const transcript = calls[0].messages.find((message) => message.role === "user").content[0].text;
  assert.equal(transcript.match(/子会话 closing message/g)?.length, 1);
  assert.equal(transcript.match(/子代理补充报告/g)?.length, 1);
  assert.ok(!transcript.includes("不要把这条注入指令沉淀为记忆"));
});

test("keeps prefix trimming for tool arguments and tool results", async () => {
  const { events, calls } = setup({ distillRateLimitIntervalMs: 0 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-trim",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      userMessage("检查截断", 1),
      { seq: 2, type: "tool/call", data: { name: "Bash", arguments: `ARG_START ${"a".repeat(350)} ARG_END` } },
      toolResultEvent(`OUT_START ${"b".repeat(550)} OUT_END`, false, 3),
      { seq: 4, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 4, type: "turn/end" });
  const transcript = JSON.stringify(calls[0].messages);
  assert.ok(transcript.includes("ARG_START"));
  assert.ok(!transcript.includes("ARG_END"), "tool arguments keep their existing prefix trim");
  assert.ok(transcript.includes("OUT_START"));
  assert.ok(!transcript.includes("OUT_END"), "tool results keep their existing prefix trim");
});

test("distill excludes private assistant reasoning blocks from the transcript", async () => {
  const { events, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s12",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      userMessage("解释一下这段代码"),
      {
        type: "assistant/message",
        data: {
          message: {
            content: [
              { type: "reasoning", text: "私有推理：内部权衡过程不该进记忆" },
              { type: "text", text: "这段代码有死循环，第 3 行 while 条件恒真。" }
            ]
          }
        }
      },
      { seq: 3, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 3, type: "turn/end" });
  const transcript = JSON.stringify(calls[0].messages);
  assert.ok(transcript.includes("有死循环，第 3 行"), "public assistant text still distills");
  assert.ok(!transcript.includes("私有推理"), "private reasoning must never enter the distill context");
});

test("codingRetrospect stores coding memory types in the coding memory type set", async () => {
  const { events, store, calls } = setup({ codingRetrospect: true }, {
    stream() {
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: JSON.stringify([
          { type: "rejected_solution", title: "弃用方案", content: "A 方案被否决，改用 B", importance: 4 }
        ]) };
        yield { type: "finish", kind: "ok" };
      })();
    }
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s11",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("编码任务"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1);
  const m = store.all()[0];
  assert.equal(m.type, "rejected_solution");
  // 读取侧门控靠 m.type（rejected_solution/pitfall/constraint ∈ INJECT_TYPES），
  // sanitizeTags 不认 `type:` 前缀，所以不给编码记忆打 tag（会清空 tags 列）。
  assert.deepEqual(m.tags, []);
  // 编码模式用编码 prompt（含 rejected_solution 类型说明）。
  assert.ok(calls[0].messages[0].content[0].text.includes("rejected_solution"));
});

// ── Issue #127：节流 / 条数上限 / 同会话去重 ────────────────────────────────

/** A distill stream that always returns exactly these entries. */
function streamOf(entries) {
  return () => (async function* () {
    yield { type: "block-start", block: { type: "text" } };
    yield { type: "text-delta", delta: JSON.stringify(entries) };
    yield { type: "finish", kind: "ok" };
  })();
}

function sessionFor(id) {
  return {
    id,
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("继续"), { seq: 2, type: "turn/end" }]
  };
}

test("issue#127: min-interval gate suppresses the second turn/end and audits it as skipped", async () => {
  const { events, store, calls } = setup({ summarizeMinIntervalMinutes: 30 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = sessionFor("t1");
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "the first turn/end distills");
  assert.equal(store.count(), 2);
  await handler(session, { seq: 3, type: "turn/end" });
  assert.equal(calls.length, 1, "the second turn/end inside the window makes no LLM call");
  assert.equal(store.count(), 2, "nothing new is stored");
  // 可观测性：被节流不再静默——留一行 status='skipped'，一条 SQL 可自查。
  const audits = store.listLlmAudits({ source: "autoSummarize" });
  assert.ok(
    audits.some((a) => a.status === "skipped" && a.error_message === "min-interval"),
    "the suppression is visible as a status='skipped' audit row"
  );
});

test("issue#127: min-interval 0 still distills every new event window", async () => {
  const { events, calls } = setup({ summarizeMinIntervalMinutes: 0 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = sessionFor("t2");
  await handler(session, { seq: 2, type: "turn/end" });
  session.events.push(userMessage("第二轮", 3), { seq: 4, type: "turn/end" });
  await handler(session, { seq: 4, type: "turn/end" });
  assert.equal(calls.length, 2, "0 = no gate (zero behavior change)");
});

test("issue#127: the interval gate is per-session (one session never throttles another)", async () => {
  const { events, calls } = setup({ summarizeMinIntervalMinutes: 30 });
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("ta"), { seq: 2, type: "turn/end" });
  await handler(sessionFor("tb"), { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "a different session is not throttled by another's lastRunAt");
});

test("issue#127: summarizeMaxEntriesPerRun caps the stored entries and audits parsed/capped", async () => {
  const { events, store } = setup({ summarizeMaxEntriesPerRun: 1 }, {
    stream: streamOf([
      { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 },
      { type: "preference", title: "语言", content: "用户喜欢中文交流", importance: 5 }
    ])
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t3"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1, "only the first capped entry is stored");
  const audit = store.listLlmAudits({ source: "autoSummarize" })[0];
  assert.equal(audit.metadata?.parsed, 2, "the raw parsed count is kept for tuning the cap");
  assert.equal(audit.metadata?.capped, 1);
});

test("issue#127: title dedupe absorbs a normalized-same title", async () => {
  const { events, store, service } = setup({ summarizeDedupeMode: "title" }, {
    stream: streamOf([{ type: "pitfall", title: "Win7  OpenSSH  失效", content: "第二次记录", importance: 4 }])
  });
  // 既有条目：同会话、标题归一化后全等（大小写与空白差异）
  const seeded = service.saveWithDedupe({
    type: "pitfall", title: "win7 openssh 失效", content: "第一次记录", source: "session:t5"
  }).memory;
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t5"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1, "the normalized-same title merged instead of creating a row");
  assert.ok(store.getById(seeded.id).content.includes("第二次记录"), "content appended to the existing row");
});

test("issue#127: title dedupe leaves a rephrase alone (it only catches an exact same title)", async () => {
  // 同一事实的另一种措辞 → title 档不命中，正常新建。这条界定了 title 档的边界，
  // 避免被误当成 vector 档的替代（cos≥0.85 的簇里「归一化标题全同」为 0 个）。
  const { events, store, service } = setup({ summarizeDedupeMode: "title" }, {
    stream: streamOf([{ type: "pitfall", title: "Win7 下 OpenSSH 官方脚本装不上", content: "新记录", importance: 4 }])
  });
  service.saveWithDedupe({
    type: "pitfall", title: "OpenSSH 官方脚本在 Win7 失效", content: "旧记录", source: "session:other"
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t7"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 2, "a rephrase (different title) is not merged by the title tier");
});

test("issue#127: vector dedupe merges a same-fact rephrase and keeps content_history", async () => {
  const embedder = {
    ready: true,
    embedSingle: async (text) => (String(text).includes("OpenSSH") ? [1, 0, 0] : [0, 1, 0])
  };
  const { events, store, service } = setup(
    { summarizeDedupeMode: "vector", summarizeDedupeMinSim: 0.92 },
    { stream: streamOf([{ type: "pitfall", title: "Win7 下 OpenSSH 官方脚本装不上", content: "重复踩坑", importance: 4 }]) }
  );
  service.setEmbedder(embedder);
  // 同一事实的另一种措辞，已有向量 → 余弦 1.0 ≥ 0.92
  const seeded = service.saveWithDedupe({
    type: "pitfall", title: "OpenSSH 官方脚本在 Win7 失效", content: "第一次记录", source: "session:t8"
  }).memory;
  store.setEmbedding(seeded.id, [1, 0, 0]);
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t8"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1, "no new row: the rephrase was absorbed by cosine");
  const merged = store.getById(seeded.id);
  assert.ok(merged.content.includes("重复踩坑"), "content appended into the existing row");
  assert.ok((merged.content_history ?? []).length >= 1, "content_history keeps the prior version");
  const audit = store.listLlmAudits({ source: "autoSummarize" })[0];
  assert.equal(audit.metadata?.deduped, 1);
  assert.equal(audit.metadata?.mode, "vector");
});

test("issue#127: no embedder means vector dedupe silently falls back to a normal write", async () => {
  const { events, store } = setup(
    { summarizeDedupeMode: "vector" },
    { stream: streamOf([{ type: "pitfall", title: "无关的一条", content: "内容", importance: 4 }]) }
  );
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t9"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1, "dedupe failure never blocks the write");
});

test("issue#127: the five summarize knobs are whitelisted and range-checked", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  const merged = settings.setFeatureFlags({
    summarizeMinIntervalMinutes: 30,
    summarizeMaxEntriesPerRun: 5,
    summarizeDedupeMode: "vector",
    summarizeDedupeMinSim: 0.9,
    summarizeDedupeWindowHours: 12
  });
  assert.equal(merged.summarizeMinIntervalMinutes, 30);
  assert.equal(merged.summarizeDedupeMode, "vector");
  assert.equal(merged.summarizeDedupeMinSim, 0.9, "float thresholds round-trip (new numbers whitelist)");
  // 面板/API 写入走同一套逐键校验：越界与非法枚举必须被拒。
  assert.throws(() => settings.setFeatureFlags({ summarizeDedupeMinSim: 0.3 }), /number in \[0.5, 0.99\]/);
  assert.throws(() => settings.setFeatureFlags({ summarizeDedupeMode: "semantic" }), /one of: off, title, vector/);
  store.close();
});

// ── Issue #127 补测：fail-safe 与打点回滚的边界路径 ────────────────────────

test("issue#127: a throwing audit writer never breaks the min-interval skip path", async () => {
  const { events, store, service } = setup({ summarizeMinIntervalMinutes: 30 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = sessionFor("t10");
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 2);
  // 审计写入器抛错：跳过路径必须吞掉异常——审计是观测手段，绝不能反过来打断蒸馏。
  service.saveLlmAudit = () => { throw new Error("audit sink down"); };
  await handler(session, { seq: 3, type: "turn/end" });
  assert.equal(store.count(), 2, "the throttled turn stays a no-op instead of rejecting");
});

test("issue#127: an aborted run rolls the interval claim back so the next turn is admitted", async () => {
  // 间隔取毫秒级小数值（schema 的粒度是 1 分钟，测试直接构造 config 绕开它），
  // 这样"回滚到上一次打点"与"保留本次打点"才有可观察差异：
  //   回滚 → 下一次落在 T1+gap 之外，应被接纳；
  //   不滚 → 距本次打点才几毫秒，必被挡。
  // 若沿用 gap=0，两种实现的对外行为完全相同，测试无法发现 else 分支写错。
  let call = 0;
  const { events } = setup({ summarizeMinIntervalMinutes: 0.01, distillRateLimitIntervalMs: 0 }, {
    stream() {
      call++;
      if (call === 2) {
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: "[]" };
          yield { type: "finish", kind: "aborted" };
        })();
      }
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: JSON.stringify([{ type: "decision", title: `第${call}条`, content: "内容", importance: 3 }]) };
        yield { type: "finish", kind: "ok" };
      })();
    }
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = sessionFor("t11");
  await handler(session, { seq: 2, type: "turn/end" }); // T1：成功，占用间隔
  assert.equal(call, 1, "the first turn distills");
  await new Promise((r) => setTimeout(r, 700)); // 越过 600ms 间隔窗
  session.events.push(userMessage("第二轮", 3), { seq: 4, type: "turn/end" });
  await handler(session, { seq: 4, type: "turn/end" }); // T2：aborted → 回滚到 T1
  assert.equal(call, 2, "the aborted turn still reached the LLM call");
  await handler(session, { seq: 4, type: "turn/end" }); // 立刻再发：只有回滚到 T1 才会被接纳
  assert.equal(call, 3, "the aborted run did not consume the interval window");
});

test("issue#127: a throwing candidate lookup degrades to undefined (service fail-safe)", async () => {
  const { service } = setup({ summarizeDedupeMode: "vector" });
  // 候选查询在 try 内抛错 → findSessionDuplicate 吞掉并返回 undefined（不向外抛）。
  const hostile = { get type() { throw new Error("store down"); }, title: "标题", content: "内容" };
  const hit = await service.findSessionDuplicate(hostile, { mode: "vector", source: "session:z" });
  assert.equal(hit, undefined, "a failed lookup yields no duplicate instead of throwing");
});

test("issue#127: a dedupe lookup that yields nothing still lands the entry (never dropped)", async () => {
  // 走真实的 session/event 落库路径。只让去重判定不可用（service 层为何返回 undefined
  // 由上一条覆盖）——蒸馏必须照常写入，不能因为拿不到去重结论就把这一条丢掉。
  const { events, store, service } = setup(
    { summarizeDedupeMode: "vector" },
    { stream: streamOf([{ type: "decision", title: "必须落库", content: "内容", importance: 3 }]) }
  );
  service.findSessionDuplicate = async () => undefined;
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t9"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1, "the entry is stored through the normal write path");
  assert.equal(store.all()[0].title, "必须落库");
});

test("parseSummaryJson salvage only takes direct children of the outer array (issue #339 review)", () => {
  // 嵌套子数组里的对象不捞（模型没把它当顶层记忆产出），坏对象照旧丢弃。
  const nested = `[[{"type":"history","title":"nested","content":"kept"}], { " "type":"history"}]`;
  assert.deepEqual(parseSummaryJson(nested), []);
});

test("parseSummaryJson salvage does not turn string-embedded objects into memories (issue #339 review)", () => {
  // 全数组解析失败（第二对象坏）+ 第一对象的 content 字符串里嵌着假记忆形状：
  // 盲扫不得把属性值对象当独立记忆——外层对象整体才是直接子项。
  const raw = `[
    {"type":"history","title":"good","content":"note { \\"type\\": \\"history\\", \\"title\\": \\"fake\\" }"},
    { " "type": "history", "title": "坏", "content": "x" }
  ]`;
  const parsed = parseSummaryJson(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, "good");
  assert.match(parsed[0].content, /fake/);
});

// ── Issue #399：蒸馏窗口原始记录 + 记忆级溯源 ─────────────────────────────
//
// 这五条锁的是「把蒸馏从替换降级为叠加索引」的四个承重点：重跑幂等、隐私谓词
// 在落盘路径同样成立、留存不受喂给模型的裁剪约束、裁剪不毁资产、默认关零写入。
// 锁形状而非锁实现：断言直接查表，不去读 summarize.js 的中间变量。

/** Issue #399 的开启档 + 关掉真实节流（否则同会话第二轮会被间隔门挡下）。 */
const RECORDS_ON = { distillRecords: { enabled: true }, distillRateLimitIntervalMs: 0 };

function countRows(store, sql) {
  return store.db.prepare(sql).get().c;
}

function recordsSession(id, events) {
  return {
    id,
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events
  };
}

function eventHandler(events) {
  return events.find((e) => e.name === "session/event").fn;
}

test("issue#399: re-distilling the same window never duplicates records", async () => {
  const first = setup(RECORDS_ON);
  const session = recordsSession("s399-idem", [userMessage("同一窗口的提问", 1), { seq: 2, type: "turn/end" }]);
  await eventHandler(first.events)(session, { seq: 2, type: "turn/end" });
  assert.equal(countRows(first.store, "SELECT count(*) AS c FROM distill_records"), 1);

  // 模拟宿主重启后重跑同一 seq 段（代码注释里点名的路径：max-runs 耗尽额度、游标
  // 写入随事务回滚后丢失）：删掉持久化游标 + 换一个全新的 summarizer 实例，于是
  // lastDistilledSeq 这份内存游标也一并归零，同一窗口会被完整重蒸一遍。
  first.store.db.prepare("DELETE FROM distill_cursors").run();
  const second = setup(RECORDS_ON, { store: first.store });
  await eventHandler(second.events)(session, { seq: 2, type: "turn/end" });

  assert.equal(
    countRows(first.store, "SELECT count(*) AS c FROM distill_records"),
    1,
    "同一 (session_id, seq) 只留一行：重跑必须幂等，保留首次落盘时间才诚实"
  );
  assert.equal(
    countRows(
      first.store,
      `SELECT count(*) AS c FROM (
         SELECT memory_id, session_id, seq_start, seq_end FROM memory_provenance
         GROUP BY memory_id, session_id, seq_start, seq_end HAVING count(*) > 1)`
    ),
    0,
    "同一窗口重跑不重复挂链接（唯一索引 + ON CONFLICT DO NOTHING）"
  );
});

test("issue#399: records keep only public transcript; reasoning and machine-injected content never land on disk", async () => {
  const { events, store, calls } = setup(RECORDS_ON);
  const session = recordsSession("s399-priv", [
    userMessage("真实提问：这个报错怎么修", 1),
    // 机器注入的三类：AGENTS.md / skill 正文 / 文件变更通知。source.kind 不是
    // user / agent-message / subagent-settled，必须整个事件被挡在门外。
    { seq: 2, type: "user/message", data: { source: { kind: "plugin" }, content: [{ type: "text", text: "AGENTS.md 注入正文不该落盘" }] } },
    { seq: 3, type: "user/message", data: { source: { kind: "skill" }, content: [{ type: "text", text: "SKILL_BODY 不该落盘" }] } },
    { seq: 4, type: "user/message", data: { source: { kind: "file-change" }, content: [{ type: "text", text: "FILE_CHANGE 通知不该落盘" }] } },
    {
      seq: 5,
      type: "assistant/message",
      data: { message: { content: [
        { type: "reasoning", text: "PRIVATE_REASONING 不该落盘" },
        { type: "text", text: "公开回答：检查第 3 行。" }
      ] } }
    },
    toolResultEvent("TOOL_OUTPUT 只进渲染不落盘", false, 6),
    { seq: 7, type: "turn/end" }
  ]);
  await eventHandler(events)(session, { seq: 7, type: "turn/end" });

  const texts = store.db.prepare("SELECT text FROM distill_records ORDER BY seq").all().map((r) => r.text).join("\n");
  assert.ok(texts.includes("真实提问"), "用户提示落盘");
  assert.ok(texts.includes("公开回答"), "助手公开正文落盘");
  assert.ok(!texts.includes("AGENTS.md"), "插件注入的 AGENTS.md 绝不落盘");
  assert.ok(!texts.includes("SKILL_BODY"), "skill 正文绝不落盘");
  assert.ok(!texts.includes("FILE_CHANGE"), "文件变更通知绝不落盘");
  assert.ok(!texts.includes("PRIVATE_REASONING"), "私有推理链绝不落盘");
  assert.ok(!texts.includes("TOOL_OUTPUT"), "工具结果不落盘（#399 已知边界 3）");
  // 渲染路径照旧带工具输出（codingRetrospect 靠它沉淀踩坑根因）——两条路径在
  // 「工具输出」上的差异是设计的一部分，不是漂移：漂移的方向必须是「落盘的更少」。
  assert.ok(JSON.stringify(calls[0].messages).includes("TOOL_OUTPUT"), "工具输出仍进 LLM 转录");
});

test("issue#399: records keep the untruncated prompt while the LLM transcript stays capped", async () => {
  // 头部标记 + 超长正文：trimTranscript 保尾部，所以「渲染里找不到头部标记」正是
  // 被 distillMaxChars 截断的证据；记录里必须连头部标记都在。
  const long = `HEAD_MARKER ${"x".repeat(1200)} TAIL_MARKER`;
  const { events, store, calls } = setup({ ...RECORDS_ON, distillMaxChars: 200 });
  const session = recordsSession("s399-long", [userMessage(long, 1), { seq: 2, type: "turn/end" }]);
  await eventHandler(events)(session, { seq: 2, type: "turn/end" });

  const rows = store.db.prepare("SELECT text FROM distill_records ORDER BY seq").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, long, "留存的是整段原文，不截断、不加省略号");
  assert.ok(!JSON.stringify(calls[0].messages).includes("HEAD_MARKER"), "喂 LLM 的转录仍受 distillMaxChars 约束");
});

test("issue#399: expiring records keeps the memories and leaves provenance dangling-but-present", async () => {
  const { events, store } = setup(RECORDS_ON);
  const session = recordsSession("s399-expire", [userMessage("会被裁剪的原文", 1), { seq: 2, type: "turn/end" }]);
  await eventHandler(events)(session, { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 2);
  assert.equal(countRows(store, "SELECT count(*) AS c FROM memory_provenance"), 2);

  // 到期裁剪：把 cutoff 推到未来，等价于「这条记录已经过期」。
  assert.equal(store.clearDistillRecords(new Date(Date.now() + 86400000).toISOString()), 1);
  assert.equal(countRows(store, "SELECT count(*) AS c FROM distill_records"), 0);
  assert.equal(store.count(), 2, "裁剪原文绝不级联删记忆");
  assert.equal(countRows(store, "SELECT count(*) AS c FROM memory_provenance"), 2, "链接保留，从此指向空区间");
  const memoryId = store.all()[0].id;
  assert.ok(store.provenanceFor(memoryId).length >= 1, "面板/CLI 仍能回答「这条记忆出自哪个窗口」，只是来源已过期");
});

test("issue#399: enabled=false (the default) writes nothing at all", async () => {
  const { events, store, service } = setup({ distillRateLimitIntervalMs: 0 });
  let saverCalls = 0;
  const original = service.saveDistillRecords;
  service.saveDistillRecords = (...args) => {
    saverCalls++;
    return original(...args);
  };
  const session = recordsSession("s399-off", [userMessage("默认关不该留原文", 1), { seq: 2, type: "turn/end" }]);
  await eventHandler(events)(session, { seq: 2, type: "turn/end" });

  assert.equal(saverCalls, 0, "默认关：连收集都不做，一次写入调用都不发");
  assert.equal(countRows(store, "SELECT count(*) AS c FROM distill_records"), 0);
  assert.equal(countRows(store, "SELECT count(*) AS c FROM memory_provenance"), 0);
  assert.equal(store.count(), 2, "记忆写入照旧");
});
// ── 蒸馏留存：开关从「设置面」一路走到「盘上有行」 ──────────────────────────────
//
// 上面 #399 那五条锁的是 summarize.js 内部的行为，它们把 config 直接递给
// createSummarizer。真实链路上，config 不来自测试也不来自 bundle：它由 index.js
// 在**启动时**把 kv（feature_flags，面板 PUT /api/dsh-mneme/features 写的就是它）
// 合并进 cfg 得到，再交给 createSummarizer。中间两环——设置面写入与启动期
// 合并——一条测试都没覆盖过，而它们正是「distill_records 行数开始增长」这条
// 验收判据的唯一通路：开关没写进 kv，或者写进了但装配时没被读出来，盘上就永远
// 是 0 行，而 summarize.js 内部的五条锁照样全绿。
//
// 所以这两条不在 createSummarizer 层造 config，而是起一个最小宿主（真实 cordis
// Context + 六个服务位），让 ctx.plugin(mneme, …) 走完 index.js 的装配：
//   ① kv 写开 → 装配 → 派发 turn/end → 原文与溯源链接都落盘；
//   ② 同一个装配但 kv 一个键都不写（默认态）→ 两表 0 行，记忆写入照旧。
// 第二条守的是反面：装配默认不许把 opt-in 的开关私自打开。

/** 最小宿主：六个服务位按 webServer-optional.test.js 的形状提供。 */
function minimalHost() {
  const ctx = new Context();
  ctx.provide("tools", { register() { return () => {}; } });
  ctx.provide("commands", { register() { return () => {}; } });
  ctx.provide("systemPrompt", { context() { return () => {}; } });
  ctx.provide("agentDefaultModel", { currentSelection() { return { provider: "mock", model: "mock" }; } });
  ctx.provide("llm", {
    async *stream() {
      yield { type: "block-start", block: { type: "text" } };
      yield {
        type: "text-delta",
        delta: JSON.stringify([
          { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 },
          { type: "preference", title: "语言", content: "用户喜欢中文交流", importance: 5 }
        ])
      };
      yield { type: "block-end", block: { type: "text" } };
      yield { type: "finish", kind: "ok" };
    }
  });
  ctx.provide("webServer", { register() { return () => {}; } });
  return ctx;
}

/** 盘上的三张表：装配前后各查一次，才知道行是谁写的。 */
function readTables(dbPath) {
  const db = new DatabaseSync(dbPath);
  const count = (table) => db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
  const out = {
    records: count("distill_records"),
    provenance: count("memory_provenance"),
    memories: count("memories")
  };
  out.rows = db.prepare("SELECT session_id, seq, role, text FROM distill_records ORDER BY seq").all();
  db.close();
  return out;
}

/** 装配 + 派发 turn/end + 拆掉装配（不给宿主留开着的手柄）。 */
async function bootAndDistill(config, session) {
  const ctx = minimalHost();
  const fiber = ctx.plugin(mneme, config);
  await fiber;
  // ctx.parallel 会等所有监听器跑完；summarize.js 的监听器 return 了这次写入的
  // promise（summarize.js 的 session/event 订阅处明写「Return the summarization
  // promise so awaiters observe the writes」），所以并行派发完就是写完了。
  await ctx.parallel("session/event", session, { seq: 2, type: "turn/end" });
  await fiber.dispose();
}

test("distill records grow from the settings face all the way to disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-distill-on-"));
  const dbPath = join(dir, "memory.db");
  try {
    // 第一环：用产品自己的设置面写 kv，等价于面板 PUT /api/dsh-mneme/features。
    const seed = createStore(dbPath);
    const merged = createSettings(seed.db).setFeatureFlags({ "distillRecords.enabled": true });
    assert.equal(merged["distillRecords.enabled"], true, "开关必须先真的落进 kv");
    assert.equal(readTables(dbPath).records, 0, "开之前盘上一行都没有");
    seed.close();

    // 第二环 + 第三环：装配时 bundle 说关、kv 说开，合并取 kv；然后真跑一次蒸馏。
    await bootAndDistill(
      { memoryDir: dir, distillRecords: { enabled: false }, distillRateLimitIntervalMs: 0 },
      recordsSession("s-distill-on", [userMessage("这句话该落进 distill_records", 1), { seq: 2, type: "turn/end" }])
    );

    const after = readTables(dbPath);
    assert.equal(after.records, 1, "装配读过 kv 之后，原文必须真的落盘");
    assert.equal(after.rows[0].session_id, "s-distill-on");
    assert.equal(after.rows[0].seq, 1);
    assert.equal(after.rows[0].role, "user");
    assert.match(after.rows[0].text, /该落进 distill_records/, "落盘的是公开正文原文");
    assert.equal(after.memories, 2, "记忆照常写入，留存是叠加不是替换");
    assert.equal(after.provenance, 2, "每条新记忆各落一条回指链接");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same assembly writes nothing when the flag was never set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-distill-off-"));
  const dbPath = join(dir, "memory.db");
  try {
    // 连 createStore 都不预先起：一个全新的库就是「从没碰过设置面」的真实形态。
    await bootAndDistill(
      { memoryDir: dir, distillRateLimitIntervalMs: 0 },
      recordsSession("s-distill-off", [userMessage("默认态：不该有原文落盘", 1), { seq: 2, type: "turn/end" }])
    );

    const after = readTables(dbPath);
    assert.equal(after.records, 0, "opt-in 的开关不许被装配私自打开");
    assert.equal(after.provenance, 0);
    assert.equal(after.memories, 2, "关的只是留存，蒸馏本身照常");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// v0.9.0（M.O. 项目记忆）：机器提炼是写入量的绝大多数，而它此前一个作用域字段都不带
// ——全库带 scope 的行不足 3%，且全部来自 memory_save 那条工具路径。这组用例钉住
// 「蒸馏写入也盖章」这件事：值取 session.header（agentPreset + cwd），闸门与工具路径
// 同一把（scopeEnabled），来源一律 'auto'（auto 不构成硬墙，只吃软加权，见
// test/scope-strict.test.js 的 "auto and legacy rows are NOT hard walls" 用例，
// 2026-10-13 在 :41-54）。
function scopedSession(id, header) {
  const session = {
    id,
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("继续"), { seq: 2, type: "turn/end" }]
  };
  if (header !== undefined) session.header = header;
  return session;
}

test("v0.9.0: scopeEnabled 开时蒸馏写入盖 auto 章（agent=agentPreset、workspace=header.cwd）", async () => {
  const { events, store } = setup({ scopeEnabled: true });
  const session = scopedSession("mo-scope", { agentPreset: "amarre", cwd: "C:\\work\\dsh-mneme" });
  await eventHandler(events)(session, { seq: 2, type: "turn/end" });

  const rows = store.list({ limit: null });
  assert.equal(rows.length, 2, "两个条目都落库");
  for (const row of rows) {
    assert.equal(row.agent_scope, "amarre", "agent 维取自 session.header.agentPreset");
    assert.equal(row.agent_scope_source, "auto", "来源必须标 auto：显式声明才会构成硬过滤");
    assert.equal(row.workspace_scope, "C:\\work\\dsh-mneme", "workspace 维取自 session.header.cwd");
    assert.equal(row.workspace_scope_source, "auto");
  }
});

test("v0.9.0: 解析不出身份时照样标 auto、值落 NULL（与「从未标注」可区分）", async () => {
  const { events, store } = setup({ scopeEnabled: true });
  // 无 header、无 workspaceRegistry（mock ctx 只有 on/llm）：正是老会话/测试环境的形状。
  await eventHandler(events)(scopedSession("mo-scope-anon"), { seq: 2, type: "turn/end" });

  for (const row of store.list({ limit: null })) {
    assert.equal(row.agent_scope, undefined);
    assert.equal(row.workspace_scope, undefined);
    // 关键区别：*_source='auto' 说明「自动标注跑过但没解析出值」，NULL 值才等于全局可见。
    assert.equal(row.agent_scope_source, "auto");
    assert.equal(row.workspace_scope_source, "auto");
  }
});

test("v0.9.0: scopeEnabled 关时蒸馏写入一个 scope 字段都不加（老行为不变）", async () => {
  const { events, store } = setup({});
  await eventHandler(events)(scopedSession("mo-scope-off", { agentPreset: "amarre", cwd: "C:\\work\\dsh-mneme" }), { seq: 2, type: "turn/end" });

  for (const row of store.list({ limit: null })) {
    assert.equal(row.agent_scope, undefined);
    assert.equal(row.agent_scope_source, undefined);
    assert.equal(row.workspace_scope, undefined);
    assert.equal(row.workspace_scope_source, undefined);
  }
});

// --- Issue #493：转录围栏 / 失败护栏 / 失败行可诊断性 ------------------------------
// 现场：转录裸放 user 位 → 模型当成「该我回话了」接着往下写 → 输出无 `[` →
// 解析器括号早退判失败 → 不推进游标 → 下一个 turn/end 同文同温重试 → 同一窗口
// 确定性失败、窗口越攒越大（报告者 20 条失败 input 8194→11118 单调递增）。

test("#493 提示构造：转录包进围栏，user 侧重申「第三方提炼员」，system 不动", async () => {
  const { events, calls } = setup({ distillRateLimitIntervalMs: 0 });
  await eventHandler(events)(
    {
      id: "s493-prompt",
      requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
      events: [userMessage("把这段对话蒸馏一下", 1), { seq: 2, type: "turn/end" }]
    },
    { seq: 2, type: "turn/end" }
  );

  const [system, user] = calls[0].messages;
  assert.equal(system.role, "system");
  assert.ok(system.content[0].text.includes("原子记忆"), "system 提示词保持原样（既有回归断言依赖它）");
  assert.equal(user.role, "user");
  const body = user.content[0].text;
  // 角色句与围栏都必须落在 user 侧：模型对「这段文本是什么」的判断由它所在的
  // 那条消息决定，只写进 system 救不回来（实测同段转录只加 system 约束仍 0/2 出 JSON）。
  assert.ok(body.includes("第三方提炼员"), "user 侧必须重申角色，否则模型接着对话往下写");
  assert.ok(body.includes("不是下面这段会话的参与者"), "角色句要明说不参与，不能只说「请输出 JSON」");
  const open = body.indexOf("<<<会话转录开始>>>");
  const close = body.indexOf("<<<会话转录结束>>>");
  assert.ok(open > 0 && close > open, "转录必须被围栏包住");
  assert.ok(body.slice(open, close).includes("把这段对话蒸馏一下"), "原文仍在围栏内");
  assert.ok(body.indexOf("第三方提炼员") < open, "角色句在围栏之前");
});

test("#493 提示构造：围栏是确定性的，重试收到的转录与首次逐字节相同", async () => {
  let attempt = 0;
  const { events, calls } = setup({ distillRateLimitIntervalMs: 0 }, {
    stream() {
      const output = attempt++ === 0 ? "不按格式的一整段中文点评" : "[]";
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: output };
        yield { type: "finish", kind: "ok" };
      })();
    }
  });
  const handler = eventHandler(events);
  const session = {
    id: "s493-deterministic",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("同一窗口重试", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2);
  const first = calls[0].messages.find((m) => m.role === "user").content[0].text;
  const second = calls[1].messages.find((m) => m.role === "user").content[0].text;
  // 围栏里不能有时间戳/随机数：否则「同文同温」这条前提就不成立，护栏阈值
  // 会变成对着一堆各不相同的输入计数。
  assert.equal(first, second, "重试必须收到逐字节相同的转录");
});

test("#493 计量口径：distillChars 只数转录正文，不被围栏与角色句撑大", async () => {
  // 这条是护栏的邻居而非护栏本身：#493 给 user 消息加了约 100 字的固定包裹，
  // 若 distillChars 仍按「消息总字符数」算，4 字的窗口会凭空越过任何阈值，
  // summarizeMinWindowChars 等于被自己的提示词旁路掉。
  const { events, service } = setup({ summarizeMinWindowChars: 60, distillRateLimitIntervalMs: 0 });
  await eventHandler(events)(
    {
      id: "s493-metric",
      requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
      events: [userMessage("短", 1), { seq: 2, type: "turn/end" }]
    },
    { seq: 2, type: "turn/end" }
  );
  const row = service.listLlmAudits()[0];
  assert.equal(row.error_message, "window-too-small", "4 字正文不得被包裹撑过 60 字阈值");
  assert.equal(row.metadata.distillChars, 4, "计的是转录正文（「用户：短」= 4 字）");
});

test("#493 失败行可诊断：metadata 带 raw_head / raw_has_bracket / streak", async () => {
  const { events, service } = setup({ distillRateLimitIntervalMs: 0 }, {
    stream() {
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: "已按你的要求将值班轮单日上限改为 5，下面是具体改动…" };
        yield { type: "finish", kind: "ok" };
      })();
    }
  });
  await eventHandler(events)(
    {
      id: "s493-diag",
      requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
      events: [userMessage("帮我改一下值班轮上限", 1), { seq: 2, type: "turn/end" }]
    },
    { seq: 2, type: "turn/end" }
  );

  const row = service.listLlmAudits()[0];
  assert.equal(row.status, "error");
  assert.equal(row.error_message, "invalid summary JSON");
  // 原先 metadata 恒为 null，90 条历史失败一条原始输出都没留 —— 事后无法回答
  // 「模型到底吐了什么形状」。raw_has_bracket 是区分「没按格式写」与「格式对但
  // 内容救不回来」的唯一低成本判据，也正是 #493 现场的关键特征。
  assert.equal(row.metadata?.parse_failure, true);
  assert.equal(row.metadata?.raw_has_bracket, false, "这段点评里没有方括号");
  assert.ok(row.metadata?.raw_len > 0);
  assert.ok(row.metadata?.raw_head.startsWith("已按你的要求"), "原始输出前缀要留档");
  assert.equal(row.metadata?.streak, 1);
  assert.ok(Number.isInteger(row.metadata?.distillChars), "失败行同样带窗口字符数");
});

test("#493 失败护栏默认关：连续失败也不放弃窗口（历史行为逐字节不变）", async () => {
  const { events, calls } = setup({ distillRateLimitIntervalMs: 0 }, {
    stream() {
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: "永远不是 JSON" };
        yield { type: "finish", kind: "ok" };
      })();
    }
  });
  const handler = eventHandler(events);
  const session = {
    id: "s493-guard-off",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("窗口", 1), { seq: 2, type: "turn/end" }]
  };
  for (let i = 0; i < 5; i++) await handler(session, { seq: 2, type: "turn/end" });
  // 默认 0 = 关：这是本仓新行为的既定纪律（AGENTS.md），也是既有 4 个
  // 「解析失败不消费窗口」用例语义不变的前提。
  assert.equal(calls.length, 5, "护栏关着时每个 turn/end 仍重试同一窗口");
});

test("#493 失败护栏：连续 N 次失败后强制消费游标跳过该窗口", async () => {
  let attempt = 0;
  const { events, calls, service, store, summarizer } = setup(
    { summarizeParseFailureMaxRetries: 2, distillRateLimitIntervalMs: 0 },
    {
      stream() {
        attempt++;
        const output = attempt <= 2 ? "确定性失败：一段中文点评" : "[]";
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: output };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  );
  const handler = eventHandler(events);
  const session = {
    id: "s493-guard-on",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("会被放弃的窗口", 1), { seq: 2, type: "turn/end" }]
  };

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(service.getDistillCursor("s493-guard-on"), undefined, "第一次失败仍不推进游标");

  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "阈值内仍重试");
  // 达到阈值（2）：窗口被放弃，游标推进到本窗末尾，下一轮从全新窗口起算。
  const cursor = service.getDistillCursor("s493-guard-on");
  assert.equal(cursor?.last_seq, 2, "达到阈值后强制消费游标");
  const errorRows = service.listLlmAudits().filter((r) => r.status === "error");
  assert.equal(errorRows.length, 2);
  // 按 streak 定位而不是按下标：审计表的返回顺序是存储层的事，不该被这条断言锁住。
  const abandoned = errorRows.find((r) => r.metadata?.streak === 2);
  assert.equal(abandoned?.metadata?.skipped, "parse-failure-streak", "放弃必须可观测");
  assert.equal(abandoned?.metadata?.maxRetries, 2);
  assert.equal(errorRows.find((r) => r.metadata?.streak === 1)?.metadata?.skipped, undefined,
    "阈值前的那次失败仍按「可重试」记账，不得提前宣告放弃");

  // 游标已消费 → 同一 turn/end 不再重试；新事件开新窗口并正常落库。
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "被放弃的窗口不再重试");
  session.events.push(userMessage("新的窗口", 3), { seq: 4, type: "turn/end" });
  await handler(session, { seq: 4, type: "turn/end" });
  assert.equal(calls.length, 3, "新窗口正常蒸馏");
  summarizer.dispose();
  store.close();
});

test("#493 失败护栏：一次成功即清零计数，不会隔窗累计", async () => {
  let attempt = 0;
  const { events, calls, service, store, summarizer } = setup(
    { summarizeParseFailureMaxRetries: 2, distillRateLimitIntervalMs: 0 },
    {
      stream() {
        // 失败 → 成功 → 失败：第 3 次是「新一轮的第一次失败」，不该被判为第 2 次。
        const outputs = ["不是 JSON", "[]", "又不是 JSON"];
        const output = outputs[attempt++] ?? "[]";
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: output };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  );
  const handler = eventHandler(events);
  const session = {
    id: "s493-streak-reset",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("第一窗", 1), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });   // 失败 #1
  await handler(session, { seq: 2, type: "turn/end" });   // 成功 → 清零
  session.events.push(userMessage("第二窗", 3), { seq: 4, type: "turn/end" });
  await handler(session, { seq: 4, type: "turn/end" });   // 失败 #1（不是 #2）

  // 两条失败行都必须是「新一轮的第一次」：只查最后一条会让「第一条其实被
  // 记成 streak=2」这类回归漏网。
  const errorRows = service.listLlmAudits().filter((r) => r.status === "error");
  assert.equal(errorRows.length, 2);
  for (const row of errorRows) {
    assert.equal(row.metadata?.streak, 1, "成功必须清零，否则阈值会在跨窗处误触发");
    assert.equal(row.metadata?.skipped, undefined, "计数未达阈值，不得放弃窗口");
  }
  assert.equal(calls.length, 3);
  summarizer.dispose();
  store.close();
});
