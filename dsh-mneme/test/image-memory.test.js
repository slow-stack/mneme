// Issue #611：图片记忆端到端——一张图真的走进蒸馏转录。
//
// 单元用例（attachment-text.test.js）只证明「块 → 文本」这一步是对的。这一份锁的是
// 另一半：**collectMessages 真的会把它拼进发给模型的那条消息里**，并且这个数会落进
// 审计 metadata。改动前三处 textOf 都返回空串，图-only 消息连一行都不会产出——所以
// 这条用例在旧代码上必然红，这是它存在的理由。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSummarizer } from "../src/summarize.js";

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const events = [];
  const calls = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    llm: {
      stream(options) {
        calls.push(options);
        const json = JSON.stringify([
          { type: "history", title: "看过一张截图", content: "用户发了一张 1543x983 的截图并问数据对比", importance: 3 }
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
  const config = { autoSummarize: true, distillRateLimitIntervalMs: 0, ...over };
  const summarizer = createSummarizer(ctx, service, config, {});
  return { store, service, events, calls, summarizer };
}

function imageMessage(seq, text) {
  const content = [];
  if (text) content.push({ type: "text", text });
  content.push({
    type: "image",
    attachment: {
      attachmentId: "sha256:abc123",
      mediaType: "image/png",
      width: 1543,
      height: 983,
      name: "屏幕截图 2026-10-19 072000.png"
    }
  });
  return { seq, type: "user/message", data: { source: { kind: "user" }, content } };
}


test("#611 图+文消息：蒸馏转录里同时有文字与图片占位", async () => {
  const { events, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s611-mixed",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      imageMessage(1, "能有那种数据对比吗"),
      { seq: 2, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 2, type: "turn/end" });

  assert.equal(calls.length, 1, "这一窗应当发起一次蒸馏");
  const transcript = calls[0].messages.find((m) => m.role === "user").content[0].text;
  assert.ok(transcript.includes("能有那种数据对比吗"), "文字照旧进转录");
  assert.ok(transcript.includes("[图:"), "图片必须留下占位，而不是消失");
  assert.ok(transcript.includes("屏幕截图 2026-10-19 072000.png"), "文件名要能对上原始附件");
  assert.ok(transcript.includes("1543x983"), "尺寸要留下");
});

test("#611 图-only 消息不再被整条丢弃（改动前窗口里一行都没有）", async () => {
  const { events, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s611-image-only",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [imageMessage(1, null), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });

  assert.equal(calls.length, 1, "图-only 窗口现在也要蒸馏——旧版这里直接 noop");
  const transcript = calls[0].messages.find((m) => m.role === "user").content[0].text;
  assert.ok(transcript.includes("[图:"), "占位就是这一窗的全部可提炼内容");
});

test("#611 图片张数落进审计 metadata，off 档与静默丢弃可区分", async () => {
  const { events, service } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s611-audit",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      imageMessage(1, "第一张"),
      imageMessage(2, "第二张"),
      { seq: 3, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 3, type: "turn/end" });

  const row = service.listLlmAudits().find((r) => r.status === "success");
  assert.ok(row, "成功行要存在");
  assert.equal(row.metadata?.imageCount, 2, "两张图必须被数出来");
});

test("#611 没有图时不写 imageCount（零行为变化）", async () => {
  const { events, service } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s611-no-image",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      { seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "只有文字" }] } },
      { seq: 2, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 2, type: "turn/end" });

  const row = service.listLlmAudits().find((r) => r.status === "success");
  assert.ok(row);
  assert.equal(row.metadata?.imageCount, undefined, "没图就别写这个键，老档位逐字节不变");
});
test("#611 被挡掉的注入消息里的图不计入（CodeRabbit 2026-11-08 指出）", async () => {
  // 计量的口径必须是「真正进了转录的图」，不是「窗口事件里出现过几张图」。
  // 这条用例造一条带图的插件注入消息：它会被 publicTranscriptParts 整条挡掉
  // （转录里没有它），所以 imageCount 不该把它算进去——否则审计会报「这窗有 1 张图」
  // 而模型根本没看到这张图。
  const { events, service, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const injected = {
    seq: 1,
    type: "user/message",
    data: {
      source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" },
      content: [
        { type: "text", text: "插件注入的机器内容" },
        {
          type: "image",
          attachment: { attachmentId: "sha256:zzz", mediaType: "image/png", width: 10, height: 10, name: "不该被数.png" }
        }
      ]
    }
  };
  const session = {
    id: "s611-injected",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      injected,
      { seq: 2, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "真人的一句" }] } },
      { seq: 3, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 3, type: "turn/end" });

  assert.equal(calls.length, 1, "窗口里有真人文本，照常蒸馏");
  const transcript = calls[0].messages.find((m) => m.role === "user").content[0].text;
  assert.ok(transcript.includes("真人的一句"));
  assert.ok(!transcript.includes("插件注入的机器内容"), "注入消息本来就不进转录");
  const row = service.listLlmAudits().find((r) => r.status === "success");
  assert.ok(row);
  assert.equal(row.metadata?.imageCount, undefined, "被挡掉的注入消息里的图不该被数进去");
});