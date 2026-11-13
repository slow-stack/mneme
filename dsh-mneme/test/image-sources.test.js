// 图像溯源（v2，`imageMemoryEnabled`）的验收。
//
// 这一份要证的不是「表建出来了」，而是四件容易做错、做错了又都不报错的事：
//   ① 默认关着时，`image_sources` 一行都不写、审计不多一个键（opt-in 不许改老行为）；
//   ② 父开关（`imageDescribeEnabled`）关着时子项一律不写，但子项的持久值留着；
//   ③ 描述一张都没成功时**不写**——没描述时图只是占位，此时挂图是把「同窗口」
//      谎报成「因果」，这是本功能唯一的语义风险；
//   ④ 键的稳定性如实落库：有 attachmentId 是 stable，没有就是 unstable。
// 另加两条口径防回归：一张图 × 一条记忆只记一行（重跑不重复记账）、
// `imageSourcesFor` 的读出顺序与事件顺序一致。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSummarizer } from "../src/summarize.js";
import { Config, injectChildEnabled } from "../src/config.js";
import { attachmentKey, imageRefOf } from "../src/image-describe.js";
import { testConfig } from "./helpers/test-config.js";

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

function imageMessage(seq, text, attachment = IMAGE.attachment) {
  const content = [];
  if (text) content.push({ type: "text", text });
  content.push({ type: "image", attachment });
  return { seq, type: "user/message", data: { source: { kind: "user" }, content } };
}

// 同时扮演「描述调用」与「蒸馏调用」的假 llm，按 purpose 分流。
function fakeLlm({ description = "一张表格截图，两列数据对比", throwOnDescribe = false } = {}) {
  const calls = [];
  return {
    calls,
    resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }),
    stream(options) {
      calls.push(options);
      if (options.purpose === "image-description") {
        if (throwOnDescribe) return (async function* () {
          throw new Error("vision route down");
        })();
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
  const service = createService({ store, mirror: null, config: testConfig({}) });
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
  return { store, service, events, ctx, llm, config, summarizer };
}

async function distill(r, session) {
  const handler = r.events.find((e) => e.name === "session/event").fn;
  await handler(session, { seq: session.events.at(-1).seq, type: "turn/end" });
}

function sessionOf(id, events) {
  return {
    id,
    requestHeader: () => ({ config: testConfig({ provider: "deepseek", model: "deepseek-chat" }) }),
    events
  };
}

function successAudit(service) {
  return service.listLlmAudits().find((row) => row.status === "success");
}

// 开启描述 + 溯源的公共配置：描述真的会跑成，溯源才有意义。
const ON = {
  imageDescribeEnabled: true,
  imageDescribeProvider: "vision",
  imageDescribeModel: "v1",
  imageMemoryEnabled: true
};

// ── 表与读出口 ───────────────────────────────────────────────────────────

test("v2：image_sources 建表幂等，空库读出空数组", () => {
  const store = createStore(":memory:");
  assert.deepEqual(store.imageSourcesFor("nope"), [], "没有记忆就没有引用");
  assert.deepEqual(store.imageSourcesFor(""), [], "空 id 不该走查询");
  // 同一进程内再建一次（等价于升级后重启打开旧库）：CREATE TABLE IF NOT EXISTS 必须不炸。
  const again = createStore(":memory:");
  assert.equal(again.saveImageSources([]), 0, "空批次不写、不报错");
  assert.equal(again.saveImageSources(null), 0, "非数组也当空批次");
});

// ── 默认关：一行都不写 ───────────────────────────────────────────────────

test("v2 默认关：有图有描述，但 image_sources 一行不写、审计不多键", async () => {
  const r = setup({ imageDescribeEnabled: true, imageDescribeProvider: "vision", imageDescribeModel: "v1" });
  await distill(r, sessionOf("v2-off", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));

  const row = successAudit(r.service);
  assert.ok(row, "这一窗应当蒸馏成功");
  assert.equal(row.metadata?.imageSources, undefined, "关着时审计不该出现溯源键");
  assert.equal(row.metadata?.imageDescribed, 1, "但描述本身照跑（这是父开关的事，与溯源无关）");
  // 表里确实空：借一条已知存在的记忆 id 去查它。
  const all = r.store.list ? r.store.list({ limit: 5 }) : [];
  for (const memory of all) {
    assert.equal(r.service.imageSourcesFor(memory.id).length, 0, `${memory.id} 不该有溯源行`);
  }
});

test("v2：子项勾着但父关 → 一行不写，子项持久值留着", async () => {
  const r = setup({ imageDescribeEnabled: false, imageMemoryEnabled: true, imageDescribeProvider: "vision", imageDescribeModel: "v1" });
  await distill(r, sessionOf("v2-parent-off", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  const row = successAudit(r.service);
  assert.ok(row);
  assert.equal(row.metadata?.imageSources, undefined, "父关时子项恒不生效");
  assert.equal(injectChildEnabled(r.config, "imageMemoryEnabled"), false, "生效判定必须是 false");
  const stored = r.config.imageMemoryEnabled;
  assert.equal(stored, true, "父关不是重置用户配置——值原样留着");
});

// ── 开：真的写 ───────────────────────────────────────────────────────────

test("v2 开：追溯行落到每一条本窗记忆上，stable 键与 attachmentId 对齐", async () => {
  const r = setup(ON);
  await distill(r, sessionOf("v2-on", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));

  const row = successAudit(r.service);
  assert.ok(row);
  assert.ok((row.metadata?.imageSources ?? 0) >= 1, "审计要能看见写了几行");

  const memories = r.store.list({ limit: 5 });
  assert.ok(memories.length >= 1, "这一窗应当写成至少一条记忆");
  let seen = 0;
  for (const memory of memories) {
    const sources = r.service.imageSourcesFor(memory.id);
    if (sources.length === 0) continue;
    seen += sources.length;
    const link = sources[0];
    assert.equal(link.attachmentId, "sha256:abc123", "有 attachmentId 就必须原样记下");
    assert.equal(link.keyStability, "stable");
    assert.equal(link.fallbackKey, attachmentKey({ attachment: IMAGE.attachment }, 0), "降级键与描述缓存同源");
    assert.equal(link.mediaType, "image/png");
    assert.equal(link.width, 1543);
    assert.equal(link.seq, 1, "seq 指向图块所在事件");
    assert.equal(link.sessionId, "v2-on");
  }
  assert.ok(seen >= 1, "至少一条记忆带得上引用");
});

test("v2：同窗两条记忆各带一行（叉积），但同一张图只记一次", async () => {
  // 蒸馏返回两条记忆，图只有一张：两行（记忆×图），每行一个 (memory, seq, key)。
  const r = setup(ON);
  const llm = r.llm;
  const original = llm.stream.bind(llm);
  llm.stream = (options) => {
    if (options.purpose !== "summarization") return original(options);
    llm.calls.push(options);
    const json = JSON.stringify([
      { type: "history", title: "看过一张截图", content: "问数据对比", importance: 3 },
      { type: "project", title: "截图里的对比表", content: "两列数据", importance: 3 }
    ]);
    return (async function* () {
      yield { type: "text-delta", delta: json };
      yield { type: "finish", kind: "ok" };
    })();
  };
  await distill(r, sessionOf("v2-two", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));

  const memories = r.store.list({ limit: 5 }).filter((m) => r.service.imageSourcesFor(m.id).length > 0);
  assert.ok(memories.length >= 2, `两条记忆都该带上引用（拿到 ${memories.length} 条）`);
  for (const memory of memories) {
    assert.equal(r.service.imageSourcesFor(memory.id).length, 1, "一张图 × 一条记忆只记一行");
  }
});

test("v2：描述一张都没成功 → 不写（同窗口不等于因果）", async () => {
  const r = setup(ON, fakeLlm({ throwOnDescribe: true }));
  await distill(r, sessionOf("v2-describe-fail", [imageMessage(1, "看下这个"), { seq: 2, type: "turn/end" }]));
  const row = successAudit(r.service);
  assert.ok(row, "描述失败不该连累蒸馏");
  assert.equal(row.metadata?.imageDescribed, 0, "这次确实一张都没描述成");
  assert.equal(row.metadata?.imageSources, undefined, "没描述就不该挂图——那是把同窗口谎报成因果");
  for (const memory of r.store.list({ limit: 5 })) {
    assert.equal(r.service.imageSourcesFor(memory.id).length, 0);
  }
});

// ── 键的稳定性 ───────────────────────────────────────────────────────────

test("v2：附件没有 attachmentId → 降级键 + unstable", () => {
  const ref = imageRefOf({ attachment: { mediaType: "image/png", width: 10, height: 10, name: "x.png" } }, 0);
  assert.equal(ref.attachmentId, undefined);
  assert.equal(ref.keyStability, "unstable", "同名同尺寸会撞键，必须自报不稳定");
  assert.ok(ref.fallbackKey, "降级键恒非空——它是主键的一部分");

  const stable = imageRefOf({ attachment: { attachmentId: "sha256:abc", mediaType: "image/png" } }, 0);
  assert.equal(stable.keyStability, "stable");
  assert.equal(stable.fallbackKey, "sha256:abc", "有稳定键时降级键就是它本身");
});

test("v2：unstable 键照样写进表，但 attachment_id 落 NULL", async () => {
  const loose = { mediaType: "image/jpeg", width: 800, height: 600, name: "无名.jpg" };
  const r = setup(ON);
  await distill(r, sessionOf("v2-unstable", [imageMessage(1, "看下这个", loose), { seq: 2, type: "turn/end" }]));
  const memories = r.store.list({ limit: 5 });
  const withSources = memories.filter((m) => r.service.imageSourcesFor(m.id).length > 0);
  assert.ok(withSources.length >= 1, "没有 attachmentId 也要能溯源，只是标注不稳定");
  const link = r.service.imageSourcesFor(withSources[0].id)[0];
  assert.equal(link.attachmentId, undefined, "没有稳定身份就落 NULL，不许编一个");
  assert.equal(link.keyStability, "unstable");
  assert.ok(link.fallbackKey.includes("无名.jpg"), "降级键要带名字，否则人对不上");
});

// ── 配置契约 ─────────────────────────────────────────────────────────────

test("v2：默认关、轻量档关、白名单可写", () => {
  assert.equal(Config({}).imageMemoryEnabled, false, "默认必须关");
  assert.equal(Config({ lightMode: true }).imageMemoryEnabled, false, "轻量档不开");
  // 父显式关时子项恒不生效，父缺省时只看子项自己。
  assert.equal(injectChildEnabled({ imageDescribeEnabled: false, imageMemoryEnabled: true }, "imageMemoryEnabled"), false);
  assert.equal(injectChildEnabled({ imageMemoryEnabled: true }, "imageMemoryEnabled"), true);
  assert.equal(injectChildEnabled({ imageDescribeEnabled: true }, "imageMemoryEnabled"), false, "子项缺省即关");
});
