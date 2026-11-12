// 图像描述档（docs/DISTILL.md:346）的验收：这一份要证的不是「函数能跑」，
// 而是三件容易做错的事——
//   ① 默认关着时，蒸馏发给模型的那条消息**逐字节不变**（#611 的行为不能被
//      一个 opt-in 功能顺手改掉）；
//   ② 开着时，描述真的并进了转录，而不是只发生在某个局部变量里；
//   ③ 描述失败绝不连累蒸馏（描述是增强，不是前置条件）。
// 另外两条属于防回归：300 字天花板（否则四张图能把正文挤出窗口）、
// 以及「模型明确不能看图时不发这个调用」（省一次必然换回占位白花的钱）。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSummarizer } from "../src/summarize.js";
import { imageLabel } from "../src/attachment-text.js";
import {
  MAX_DESCRIPTION_CHARS,
  appendDescriptions,
  canSeeImages,
  describeImages,
  imageBlocks
} from "../src/image-describe.js";

const IMAGE = {
  type: "image",
  attachment: {
    attachmentId: "sha256:abc123",
    mediaType: "image/png",
    width: 1543,
    height: 983,
    name: "屏幕截图 2026-10-19 072000.png"
  }
};

function imageMessage(seq, text) {
  const content = [];
  if (text) content.push({ type: "text", text });
  content.push({ ...IMAGE });
  return { seq, type: "user/message", data: { source: { kind: "user" }, content } };
}

// 一个能同时扮演「描述调用」与「蒸馏调用」的假 llm：按 purpose 分流，
// 并且把每次调用都记下来，让用例能断言「到底发了几次、发给谁」。
function fakeLlm({ description = "一张表格截图，两列数据对比", modalities = ["text", "image"], throwOnDescribe = false } = {}) {
  const calls = [];
  return {
    calls,
    resolveModelInfo: async () => ({ inputModalities: modalities }),
    stream(options) {
      calls.push(options);
      if (options.purpose === "image-description") {
        if (throwOnDescribe) throw new Error("vision route down");
        return (async function* () {
          yield { type: "text-delta", delta: description };
          yield { type: "finish", kind: "ok" };
        })();
      }
      const json = JSON.stringify([
        { type: "history", title: "看过一张截图", content: "用户发了一张截图问数据对比", importance: 3 }
      ]);
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: json };
        yield { type: "block-end", block: { type: "text" } };
        yield { type: "finish", kind: "ok" };
      })();
    }
  };
}

function setup(over = {}, llm = fakeLlm()) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const events = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    llm
  };
  const config = { autoSummarize: true, distillRateLimitIntervalMs: 0, ...over };
  const summarizer = createSummarizer(ctx, service, config, {});
  return { store, service, events, ctx, llm, summarizer };
}

async function distill(setupResult, session) {
  const handler = setupResult.events.find((e) => e.name === "session/event").fn;
  await handler(session, { seq: session.events.at(-1).seq, type: "turn/end" });
}

function sessionOf(id, events) {
  return {
    id,
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events
  };
}

function transcriptOf(call) {
  return call.messages.find((m) => m.role === "user").content[0].text;
}

// ── 准入判定 ─────────────────────────────────────────────────────────────

test("准入：inputModalities 缺席是「未知」，不是「不支持」", async () => {
  const unknown = { llm: { resolveModelInfo: async () => ({}) } };
  assert.equal(await canSeeImages(unknown, "p", "m"), "unknown",
    "老适配器不声明能力时必须按未知处理，交给宿主决定");
  const notArray = { llm: { resolveModelInfo: async () => ({ inputModalities: "image" }) } };
  assert.equal(await canSeeImages(notArray, "p", "m"), "unknown", "非数组同属未知");
  const noApi = { llm: {} };
  assert.equal(await canSeeImages(noApi, "p", "m"), "unknown", "连查询接口都没有也是未知");
});

test("准入：只有明确声明了且不含 image 才是确凿的看不到", async () => {
  const textOnly = { llm: { resolveModelInfo: async () => ({ inputModalities: ["text"] }) } };
  assert.equal(await canSeeImages(textOnly, "p", "m"), false);
  const vision = { llm: { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) } };
  assert.equal(await canSeeImages(vision, "p", "m"), true);
});

test("准入：能力查询抛错按未知处理（不因为一次 RPC 失败就整档不跑）", async () => {
  const boom = { llm: { resolveModelInfo: async () => { throw new Error("nope"); } } };
  assert.equal(await canSeeImages(boom, "p", "m"), "unknown");
});

// ── 默认关：逐字节不变 ───────────────────────────────────────────────────

test("默认关：即使配了描述模型，也不发描述调用、转录逐字节不变", async () => {
  const base = setup({});
  await distill(base, sessionOf("img-off", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  assert.equal(base.llm.calls.length, 1, "只该有一次蒸馏调用");
  assert.equal(base.llm.calls[0].purpose, "summarization");
  const baseline = transcriptOf(base.llm.calls[0]);

  // 配了路由但开关没开：不该有任何变化。
  const off = setup({ imageDescribeProvider: "vision", imageDescribeModel: "v1" });
  await distill(off, sessionOf("img-off2", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  assert.equal(off.llm.calls.length, 1, "开关关着就不该有描述调用");
  assert.equal(transcriptOf(off.llm.calls[0]), baseline, "关着时转录必须与 #611 的行为逐字节一致");
});

test("开关开着但路由留空 = 整档不跑（不是跟随主模型）", async () => {
  const r = setup({ imageDescribeEnabled: true });
  await distill(r, sessionOf("img-noroute", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  assert.equal(r.llm.calls.length, 1, "路由留空只该有一次蒸馏调用");
  assert.equal(r.llm.calls[0].purpose, "summarization");
});

test("开关开着但模型明确不能看图：不发描述调用", async () => {
  const r = setup(
    { imageDescribeEnabled: true, imageDescribeProvider: "text", imageDescribeModel: "t1" },
    fakeLlm({ modalities: ["text"] })
  );
  await distill(r, sessionOf("img-blind", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  assert.equal(r.llm.calls.length, 1, "已知看不到还发调用，只会换回一行占位");
  assert.equal(r.llm.calls[0].purpose, "summarization");
});

test("能力未知（老适配器不声明 inputModalities）时照发，不替宿主决定", async () => {
  // 这条与上一条是同一个判据的两侧：false 才跳过，"unknown" 必须照发。
  // 抹掉这条，实现里把判据写成 `sight === true` 也照样全绿——那等于把所有
  // 不声明能力的老适配器一律当成瞎子，功能在真机上永远不生效。
  const r = setup(
    { imageDescribeEnabled: true, imageDescribeProvider: "vision", imageDescribeModel: "v1" },
    // null 而不是 undefined：解构默认值只在 undefined 时生效，传 undefined 等于
    // 又拿回默认的 ["text","image"]，这条用例会变成「能看图也能过」的假绿。
    fakeLlm({ modalities: null, description: "一张截图" })
  );
  await distill(r, sessionOf("img-unknown", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  assert.equal(
    r.llm.calls.filter((c) => c.purpose === "image-description").length,
    1,
    "能力未知时必须照发——宿主那侧对未知是不投影，照原样交给适配器"
  );
});

// ── 开着：描述真的进了转录 ───────────────────────────────────────────────

test("开着：描述并进转录，占位与文件名都还在", async () => {
  const r = setup(
    { imageDescribeEnabled: true, imageDescribeProvider: "vision", imageDescribeModel: "v1" },
    fakeLlm({ description: "一张两列数据的表格截图" })
  );
  await distill(r, sessionOf("img-on", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));

  const describeCalls = r.llm.calls.filter((c) => c.purpose === "image-description");
  assert.equal(describeCalls.length, 1, "一张图一次描述调用");
  // 描述调用里必须带的是**真 image 块**：字节由宿主按 inputModalities 决定编不编。
  const content = describeCalls[0].messages[0].content;
  assert.equal(content[0].type, "image");
  assert.equal(content[0].attachment.attachmentId, "sha256:abc123", "图块原样转发，不改写");
  assert.equal(content[1].type, "text", "提示词与图块同一条消息，图在图前");

  const distillCall = r.llm.calls.find((c) => c.purpose === "summarization");
  const transcript = transcriptOf(distillCall);
  assert.ok(transcript.includes("一张两列数据的表格截图"), "描述必须真的进转录");
  assert.ok(transcript.includes("[图:"), "占位不能被描述替换掉");
  assert.ok(transcript.includes("屏幕截图 2026-10-19 072000.png"), "文件名溯源要留");
  assert.ok(transcript.includes("1543x983"), "尺寸要留");
  assert.ok(transcript.includes("描述："), "描述行有前缀，才能与正文区分");
});

test("同一张图在一次蒸馏里只描述一次（重复贴图不重复付费）", async () => {
  const r = setup(
    { imageDescribeEnabled: true, imageDescribeProvider: "vision", imageDescribeModel: "v1" },
    fakeLlm({ description: "同一张图" })
  );
  const dup = imageMessage(2, "再看一眼");
  await distill(r, sessionOf("img-dup", [imageMessage(1, "看下这个"), dup, { seq: 3, type: "turn/end" }]));
  assert.equal(
    r.llm.calls.filter((c) => c.purpose === "image-description").length,
    1,
    "相同 attachmentId 只该描述一次"
  );
});

test("描述调用失败：蒸馏照跑，转录退回 #611 的占位形态", async () => {
  const r = setup(
    { imageDescribeEnabled: true, imageDescribeProvider: "vision", imageDescribeModel: "v1" },
    fakeLlm({ throwOnDescribe: true })
  );
  await distill(r, sessionOf("img-fail", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));

  const distillCall = r.llm.calls.find((c) => c.purpose === "summarization");
  assert.ok(distillCall, "描述挂了也必须继续蒸馏");
  const transcript = transcriptOf(distillCall);
  assert.ok(transcript.includes("[图:"), "占位照旧");
  assert.ok(!transcript.includes("描述："), "没有描述就别留空壳");
});

// ── 单元：长度与拼接 ─────────────────────────────────────────────────────

test("描述超过 300 字被截断，不把正文挤出窗口", async () => {
  const long = "长".repeat(MAX_DESCRIPTION_CHARS + 200);
  const ctx = { llm: { stream: () => (async function* () { yield { type: "text-delta", delta: long }; })() } };
  const got = await describeImages(ctx, { provider: "v", model: "v1" }, {}, [IMAGE]);
  const text = [...got.values()][0];
  assert.ok(text, "应当产出描述");
  assert.ok(text.length <= MAX_DESCRIPTION_CHARS, `截断后不该超上限，实得 ${text.length}`);
  assert.ok(text.endsWith("…"), "截断要留省略号，别让人以为原文就这么短");
});

test("描述里的换行被压成空格（一行一条，不破坏转录结构）", async () => {
  const ctx = { llm: { stream: () => (async function* () { yield { type: "text-delta", delta: "第一行\n\n第二行" }; })() } };
  const got = await describeImages(ctx, { provider: "v", model: "v1" }, {}, [IMAGE]);
  const text = [...got.values()][0];
  assert.equal(text, "第一行 第二行", "换行会让转录多出假的一行「用户：…」");
});

test("appendDescriptions 不动没有描述的块，且只替换第一处", () => {
  // 占位文本按 attachment-text 的真实输出写（标签是「文件名 mediaType 宽x高」），
  // 别自己编一个更短的形状——那会让这条用例在没有真实占位时也变绿。
  const placeholder = `[图: ${imageLabel(IMAGE)}]`;
  const text = `${placeholder}\n${placeholder}`;
  const one = new Map([["sha256:abc123", "描述内容"]]);
  const out = appendDescriptions(text, [IMAGE, IMAGE], one);
  assert.equal(out, `${placeholder}\n  描述：描述内容\n${placeholder}`);
  assert.equal(appendDescriptions(text, [IMAGE], new Map()), text, "没有描述时原样返回");
});

test("imageBlocks 只挑带 attachment 的 image 块", () => {
  const content = [
    { type: "text", text: "hi" },
    { type: "image", attachment: IMAGE.attachment },
    { type: "image" },
    { type: "reasoning", text: "私有推理" }
  ];
  assert.equal(imageBlocks(content).length, 1, "没有 attachment 的 image 块无从描述");
  assert.deepEqual(imageBlocks(null), [], "非数组返回空，不抛");
});

// ── 审计：整档静默失效必须在 metadata 里留下痕迹 ─────────────────────────
// 这一组的理由：这条链路上原先只有 imageCount（图块数），于是「开了开关但一次
// 都没跑成」与「这个窗口本来没有图」在审计里长得一模一样。四条用例分别钉住
// 「跑成了」「试了失败」「开着没路由」「默认关着不写」四种结局，少任何一条，
// 下次有人把计数删了都不会有测试变红。

function auditRow(service) {
  return service.listLlmAudits().find((r) => r.status === "success");
}

test("审计：开着且跑成，写 imageDescribed 与 imageDescribeFailed=0", async () => {
  const r = setup(
    { imageDescribeEnabled: true, imageDescribeProvider: "vision", imageDescribeModel: "v1" },
    fakeLlm({ description: "一张截图" })
  );
  await distill(r, sessionOf("img-audit-ok", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  const row = auditRow(r.service);
  assert.ok(row, "成功行要存在");
  assert.equal(row.metadata?.imageDescribed, 1, "跑成一张就记 1");
  assert.equal(row.metadata?.imageDescribeFailed, 0, "失败数必须是显式的 0，不能缺键");
  assert.equal(row.metadata?.imageDescribeError, undefined, "没失败就不写原因");
  assert.equal(row.metadata?.imageCount, 1, "图块数照旧");
});

test("审计：描述调用失败，写 imageDescribeFailed 与首条错误原文", async () => {
  const r = setup(
    { imageDescribeEnabled: true, imageDescribeProvider: "vision", imageDescribeModel: "v1" },
    fakeLlm({ throwOnDescribe: true })
  );
  await distill(r, sessionOf("img-audit-fail", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  const row = auditRow(r.service);
  assert.ok(row, "描述挂了，蒸馏本身仍是成功行");
  assert.equal(row.metadata?.imageDescribed, 0, "一张都没成");
  assert.equal(row.metadata?.imageDescribeFailed, 1, "试了一张、失败一张");
  assert.ok(
    String(row.metadata?.imageDescribeError ?? "").includes("vision route down"),
    "首条错误要留原文，否则只知道失败了不知道为什么"
  );
});

test("审计：开着但路由留空，写 imageDescribeSkipped=no route", async () => {
  const r = setup({ imageDescribeEnabled: true, imageDescribeProvider: "", imageDescribeModel: "" });
  await distill(r, sessionOf("img-audit-noroute", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  const row = auditRow(r.service);
  assert.equal(row.metadata?.imageDescribeSkipped, "no route", "「我开了但没配」必须能看见");
  assert.equal(row.metadata?.imageDescribed, undefined, "没试过就不该有尝试数");
});

test("审计：模型明确不能看图，写 imageDescribeSkipped=model-cannot-see-images", async () => {
  const r = setup(
    { imageDescribeEnabled: true, imageDescribeProvider: "text", imageDescribeModel: "t1" },
    fakeLlm({ modalities: ["text"] })
  );
  await distill(r, sessionOf("img-audit-blind", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  const row = auditRow(r.service);
  assert.equal(row.metadata?.imageDescribeSkipped, "model-cannot-see-images");
});

test("审计：默认关着时不写任何 imageDescribe* 键（老档位逐字节不变）", async () => {
  const r = setup({ imageDescribeProvider: "vision", imageDescribeModel: "v1" });
  await distill(r, sessionOf("img-audit-off", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  const row = auditRow(r.service);
  assert.equal(row.metadata?.imageCount, 1, "图块数照旧要数");
  const extra = Object.keys(row.metadata ?? {}).filter((k) => k.startsWith("imageDescribe"));
  assert.deepEqual(extra, [], `关闭态不该多出任何键，实得多出 ${extra.join(",")}`);
});
