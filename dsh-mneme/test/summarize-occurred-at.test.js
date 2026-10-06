import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSummarizer, parseSummaryJson } from "../src/summarize.js";

// 蒸馏的时间锚定（SimpleMem，arXiv 2601.02553：抽取与时间锚定在同一次生成里完成，
// 消融去掉后时间类问题 F1 掉 56.7%）。这组用例防的是三类回归：
//   1) occurred_at 在解析层被吞掉（历史形状里没有这个字段，改 prompt 时容易只改
//      提示词、忘记映射）；
//   2) 解析不出来的时间被写成 null / "" 而不是省略键——空值会被下游当成「已锚定」，
//      污染 occurred_from/occurred_to 过滤与时间排序；
//   3) 模型瞎填的未来时间原样落库（store.normalizeOccurredAt 只判可解析性，拦不住）。
// 时间一律按「相对当下」构造：锁死某个日期会让用例在时钟走过该日期后变成反向断言。
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 带 +08:00 偏移的同刻 ISO 写法：证明归一真的解析过时区，而不是原样搬运字符串。 */
function isoWithOffset(ms) {
  return `${new Date(ms + 8 * HOUR_MS).toISOString().slice(0, 23)}+08:00`;
}

function setup(entries, deps = {}) {
  const store = createStore(":memory:");
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
        const json = JSON.stringify(entries);
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: json };
          yield { type: "block-end", block: { type: "text" } };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  createSummarizer(ctx, service, { autoSummarize: true }, deps);
  return { store, service, calls, handler: events.find((e) => e.name === "session/event").fn };
}

function turnEndSession(text = "上周把 occurred_at 接进蒸馏链路") {
  return {
    id: "s-time",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } },
      { seq: 2, type: "turn/end" }
    ]
  };
}

test("parseSummaryJson keeps a parseable occurred_at, normalized to UTC ISO", () => {
  const past = Date.now() - 30 * DAY_MS;
  const parsed = parseSummaryJson(JSON.stringify([
    { type: "history", title: "时间锚定", content: "上周把 occurred_at 接进蒸馏", importance: 2, occurred_at: isoWithOffset(past) }
  ]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].occurred_at, new Date(past).toISOString(), "带偏移的绝对时间归一为 UTC ISO");
});

test("parseSummaryJson omits occurred_at when it is unparseable, non-string, or beyond the 1-day future tolerance", () => {
  const now = Date.now();
  const parsed = parseSummaryJson(JSON.stringify([
    { type: "history", title: "脏字符串", content: "模型给了自然语言时间", importance: 2, occurred_at: "昨天下午" },
    { type: "history", title: "空白串", content: "模型给了空串", importance: 2, occurred_at: "   " },
    { type: "history", title: "非字符串", content: "模型给了 epoch 数字", importance: 2, occurred_at: 1757000000000 },
    { type: "history", title: "未来时间", content: "模型编了个两年后的时间", importance: 2, occurred_at: new Date(now + 730 * DAY_MS).toISOString() },
    { type: "history", title: "略晚于当下", content: "时区/时钟偏移内的未来时间", importance: 2, occurred_at: new Date(now + HOUR_MS).toISOString() },
    { type: "history", title: "没给时间", content: "最普通的条目", importance: 2 }
  ]));
  assert.equal(parsed.length, 6);
  for (const i of [0, 1, 2, 3, 5]) {
    assert.equal("occurred_at" in parsed[i], false, `${parsed[i].title}：必须整条省略该键（不是 null、不是空串）`);
  }
  // 1 天容忍内的未来时间保留：真实时钟与模型给出的时区写法会有小时级偏差，不是瞎填。
  assert.equal(parsed[4].occurred_at, new Date(now + HOUR_MS).toISOString(), "容忍窗口内的时间照常保留");
});

test("distilled occurred_at is visible in the store, dirty/future values are dropped", async () => {
  const past = Date.now() - 3 * HOUR_MS;
  const { store, handler } = setup([
    { type: "decision", title: "时间锚定", content: "蒸馏产物带绝对时间 occurred_at", importance: 4, occurred_at: isoWithOffset(past) },
    { type: "history", title: "脏时间", content: "模型给了不可解析的时间", importance: 2, occurred_at: "上周三" },
    { type: "history", title: "未来时间", content: "模型编了个两年后的时间", importance: 2, occurred_at: new Date(Date.now() + 730 * DAY_MS).toISOString() },
    { type: "history", title: "无时间", content: "条目里根本没有时间依据", importance: 2 }
  ]);
  await handler(turnEndSession(), { seq: 2, type: "turn/end" });

  const rows = store.all();
  const byTitle = (title) => {
    const row = rows.find((r) => r.title === title);
    assert.ok(row, `记忆「${title}」应当落库`);
    return row;
  };
  // 落库可见：解析层的归一值原样进 memories.occurred_at（saveWithDedupe 普通路径）。
  assert.equal(byTitle("时间锚定").occurred_at, new Date(past).toISOString());
  // 丢弃：不可解析与超容忍的未来时间都不落列（NULL），不是字符串化后硬存。
  assert.equal(byTitle("脏时间").occurred_at, undefined);
  assert.equal(byTitle("未来时间").occurred_at, undefined);
  assert.equal(byTitle("无时间").occurred_at, undefined);
});

test("the distill system prompt carries the wall-clock anchor relative times are converted against", async () => {
  const fixed = new Date("2026-05-04T03:02:01.000Z");
  const { calls, handler } = setup([
    { type: "history", title: "锚点", content: "会话里只说了「昨天」", importance: 2 }
  ], { now: () => fixed.getTime() });
  await handler(turnEndSession("昨天部署了 v0.8.4"), { seq: 2, type: "turn/end" });

  const system = calls[0].messages.find((m) => m.role === "system")?.content?.[0]?.text ?? "";
  assert.ok(system.includes("occurred_at"), "系统提示的形状串里给出可选时间字段");
  assert.ok(system.includes("严格") || system.includes("严禁编造"), "提示词写明编造禁令");
  // 锚点取自可注入时钟：没有它，「昨天」永远换算不出绝对值。
  assert.ok(system.includes(`当前时间：${fixed.toISOString()}`), "系统提示末尾带上会话发生时间");
});
