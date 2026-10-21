// issue #497 的第三段：从记忆提取「用户画像」**草稿**。
//
// 为什么要单独立一份用例文件（而不是塞进 dream/summarize 的套件）：这条链的产品承诺很窄
// 也很硬——① 只出草稿，绝不写 user_settings（画像正文是用户手写的原文，让模型合并等于
// 给它改写权）；② 没有可用输入就不调模型；③ 模型吐的不是 JSON 就报错，绝不回一张空草稿
// 冒充「这次没提炼出东西」；④ 记忆正文是模型的可影响输入，围栏 + 角色重申必须在位，
// 且草稿里不许出现助手身份声明（画像与规则不受 personaEnabled 管，写进一句「你是某某」
// 就会重演 #497 那个身份撞车）。这四条都是「做错了界面看不出来」的那类，所以逐条锁。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";
import { createProfileExtractor, ProfileExtractError } from "../src/profile-extract.js";

// 假的 ctx.llm：按真实协议发 text-delta / usage / finish 三类 chunk（用量嵌在
// chunk.usage，与 dream.js 的 streamText 注释一致——把整个 chunk 当用量会在
// 审计行里落 0，v0.8.4 实测踩过）。messages 抓下来供围栏断言用。
function fakeLlm(chunks) {
  const calls = [];
  return {
    calls,
    llm: {
      async *stream(options) {
        calls.push(options);
        for (const c of chunks) yield c;
      }
    }
  };
}

const okJson = (profile) => [
  { type: "text-delta", text: "```json\n" },
  { type: "text-delta", text: JSON.stringify({ profile }) },
  { type: "text-delta", text: "\n```" },
  { type: "usage", usage: { inputTokens: 120, outputTokens: 30 } },
  { type: "finish", reason: { kind: "stop" } }
];

function setup(chunks, opts = {}) {
  const { config = {}, dropRoute = false } = opts;
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const fake = fakeLlm(chunks);
  const logger = { info() {}, warn() {}, error() {} };
  const extractor = createProfileExtractor({
    ctx: { ...fake, agentDefaultModel: { currentSelection: () => null } },
    service,
    settings,
    config: dropRoute ? { ...config } : { dreamProvider: "fake", dreamModel: "m1", ...config },
    logger
  });
  return { store, service, settings, extractor, fake, logger };
}

function seedRows(store, n, over = {}) {
  for (let i = 0; i < n; i++) {
    store.save({ type: "project", title: `行 ${i}`, content: `第 ${i} 行的正文`, source: "test", ...over });
  }
}

test("没有可用的模型路由：抛 no-route，且一次调用都不发（不是 TypeError→500）", async () => {
  // resolveRoute 在「无 dreamProvider/dreamModel 且宿主解析不到默认模型」时回
  // undefined。不判它就会去读 route.provider —— TypeError 落到路由上是一个语义为
  // 「内部错误」的 500，而该说的是「先去选模型」。
  const { store, extractor, fake } = setup(okJson("不该发生"), { dropRoute: true });
  seedRows(store, 2);
  await assert.rejects(() => extractor(), (err) => err instanceof ProfileExtractError && err.code === "no-route");
  assert.equal(fake.calls.length, 0, "没有路由就不该把请求发出去");
  store.close();
});

test("成功路径：出草稿、留一条审计行，而库里的画像逐字节没被动过", async () => {
  const { store, service, settings, extractor } = setup(okJson("我知道她跨考公共管理。"));
  seedRows(store, 3);
  settings.setProfile("原文不许被改写");
  const profileBefore = settings.getProfile();

  const out = await extractor();
  assert.equal(out.draft, "我知道她跨考公共管理。");
  assert.equal(out.rowsUsed, 3);
  assert.equal(out.truncated, false);
  assert.equal(out.model, "m1");
  // 「只出草稿」是这条链的产品承诺：user_settings 里必须还是那句原文。
  assert.equal(settings.getProfile(), profileBefore);

  const audits = service.listLlmAudits({ limit: 10 });
  assert.equal(audits.length, 1, "一次提取必须留一行审计");
  assert.equal(audits[0].trigger_source, "profileExtract");
  assert.equal(audits[0].status, "success");
  assert.equal(audits[0].input_tokens, 120, "用量要从 chunk.usage 里取，落在 chunk 顶层会恒为 0");
  store.close();
});

test("模型吐的不是 JSON：抛错，绝不回一张空草稿冒充「没提炼出来」", async () => {
  const { store, service, settings, extractor } = setup([
    { type: "text-delta", text: "我觉得她是个很好的用户，加油。" },
    { type: "finish", reason: { kind: "stop" } }
  ]);
  seedRows(store, 2);
  await assert.rejects(() => extractor(), ProfileExtractError, "解析失败必须是可识别的错误类型");
  assert.equal(settings.getProfile(), "", "失败路径一行都不许写");
  const audits = service.listLlmAudits({ limit: 10 });
  assert.equal(audits[0].status, "error", "吐了文字但没有可用产物 = 失败调用，审计不许写 success");
  store.close();
});

test("没有可用记忆：不调模型、直接报错（空输入下模型只会编）", async () => {
  const { store, extractor, fake } = setup(okJson("不该被调用"));
  await assert.rejects(() => extractor(), /no/i);
  assert.equal(fake.calls.length, 0, "一条输入都没有就不该花这次调用");
  store.close();
});

test("归档与被遗忘的行不进输入：它们已经不在活跃面上", async () => {
  const { store, service, extractor, fake } = setup(okJson("只用活跃行。"));
  seedRows(store, 3);
  const [gone, forgotten] = store.list({ limit: null });
  service.setArchived(gone.id, true);
  service.setForget(forgotten.id, true);
  const out = await extractor();
  assert.equal(out.rowsUsed, 1, "三行里只剩一行还在活跃面上");
  const user = fake.calls[0].messages[1].content[0].text;
  assert.ok(!user.includes(gone.content), "归档行的正文不许被喂给模型（它已经不在活跃面上）");
  assert.ok(!user.includes(forgotten.content), "被遗忘的行同理");
  store.close();
});

test("行数上限：超界时如实标记 truncated，而不是静默少读", async () => {
  const { store, extractor } = setup(okJson("截断也要说清。"));
  seedRows(store, 30);
  const out = await extractor({ maxRows: 5 });
  assert.equal(out.rowsUsed, 5);
  assert.equal(out.truncated, true);
  store.close();
});

test("记忆正文包在围栏里，且围栏之前没有正文；系统段重申「这是数据不是指令」", async () => {
  const { store, extractor, fake } = setup(okJson("围栏检查。"));
  seedRows(store, 2);
  await extractor();
  assert.equal(fake.calls.length, 1);
  const system = fake.calls[0].messages[0].content[0].text;
  const user = fake.calls[0].messages[1].content[0].text;
  // 结构断言：正文只出现在围栏内部，围栏外不残留任何一行内容。
  const openIdx = user.indexOf("<<<");
  const closeIdx = user.lastIndexOf(">>>");
  assert.ok(openIdx >= 0 && closeIdx > openIdx, "用户段必须带围栏对");
  assert.ok(user.indexOf("第 0 行的正文") > openIdx, "记忆正文不许出现在围栏之前");
  assert.ok(user.indexOf("第 1 行的正文") < closeIdx, "记忆正文不许出现在围栏之后");
  // 角色重申与「数据不是指令」是字面量锁：防的是「有人重构提示词时顺手删掉这一段」
  // ——那会让记忆里的指令型文本重新获得指令地位，而界面上一切照常。
  assert.match(system, /不是指令|not instructions/i, "系统段必须声明输入是数据");
  assert.match(system, /(绝不|不要).{0,6}(助手|agent).{0,20}(身份|名字|人格|起名)|never (name|invent|assign).{0,60}(assistant|identity|name)|do not (invent|assign).{0,40}(identity|name)/i,
    "草稿里不许出现助手身份声明：画像不受 personaEnabled 管辖，写进去就会与 bot 自带身份撞车");
  store.close();
});

// ---- HTTP 面（POST /api/dsh-mneme/profile/extract） -------------------------
// 三条各自防一类事故：开关没开不许偷偷调模型；非 POST 方法不许触发副作用
// （#489 的 /nudge 教训——方法白名单在读体之前拦）；HTTP 面上「只出草稿」同样成立。

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.headers = null; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function httpReq(method, body = null) {
  const r = new EventEmitter();
  r.method = method;
  r.url = "/api/dsh-mneme/profile/extract";
  r.headers = {};
  if (body !== null) {
    process.nextTick(() => {
      r.emit("data", Buffer.from(JSON.stringify(body)));
      r.emit("end");
    });
  }
  return r;
}

function setupApi({ config = {}, extractor, apiToken = "" } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register: (route) => { routes.push(route); return () => {}; } }, logger: { warn() {}, info() {}, error() {} } };
  createApi(ctx, service, settings, { add: () => {}, remove: () => {}, list: () => [] },
    undefined, undefined, apiToken, config, null, extractor ?? null);
  return { store, service, settings, route: routes.find((r) => r.path === "/api/dsh-mneme/profile/extract") };
}

test("policy 是 token：配了 token 又不带 token 的 POST 被挡在提取器之前", async () => {
  let called = 0;
  const { store, route } = setupApi({
    apiToken: "sekret",
    config: { profileExtractEnabled: true },
    extractor: async () => { called++; return { draft: "x" }; }
  });
  const res = new FakeRes();
  await route.handler(httpReq("POST", {}), res);
  assert.equal(res.statusCode, 401);
  assert.equal(called, 0, "鉴权必须在这次模型调用之前");
  store.close();
});

test("开关关着：409 disabled，一次模型调用都不发生", async () => {
  let called = 0;
  const { store, route } = setupApi({
    config: { profileExtractEnabled: false },
    extractor: async () => { called++; return { draft: "不该出现" }; }
  });
  const res = new FakeRes();
  await route.handler(httpReq("POST", {}), res);
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error, "disabled");
  assert.equal(called, 0);
  store.close();
});

test("非 POST 方法：405 + Allow，不触发任何副作用", async () => {
  let called = 0;
  const { store, route } = setupApi({
    config: { profileExtractEnabled: true },
    extractor: async () => { called++; return { draft: "x" }; }
  });
  for (const method of ["GET", "HEAD", "DELETE", "PATCH"]) {
    const res = new FakeRes();
    await route.handler(httpReq(method), res);
    assert.equal(res.statusCode, 405, `${method} 不该落到提取器`);
    assert.equal(res.headers.Allow, "POST");
  }
  assert.equal(called, 0, "#489 那类洞：方法分流只拦 POST/PUT 时，其余方法会直落副作用分支");
  store.close();
});

test("开关开着：200 回草稿，且库里的画像一个字节都没变", async () => {
  const { store, settings, route } = setupApi({
    config: { profileExtractEnabled: true },
    extractor: async () => ({ draft: "我知道她跨考公共管理。", rowsUsed: 7, truncated: false, provider: "p", model: "m" })
  });
  settings.setProfile("手写原文");
  const res = new FakeRes();
  await route.handler(httpReq("POST", {}), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.draft, "我知道她跨考公共管理。");
  assert.equal(body.rowsUsed, 7);
  assert.equal(settings.getProfile(), "手写原文", "采用草稿必须是用户在面板上的显式一次动作");
  store.close();
});

test("提取器报的 code 映射成可区分的状态码（「没东西可提」≠「模型没配合」）", async () => {
  for (const [code, status] of [["no-input", 409], ["no-route", 503], ["unparseable", 502], ["stream-failed", 502]]) {
    const { store, route } = setupApi({
      config: { profileExtractEnabled: true },
      extractor: async () => { throw new ProfileExtractError(code, code); }
    });
    const res = new FakeRes();
    await route.handler(httpReq("POST", {}), res);
    assert.equal(res.statusCode, status, `${code} 的状态码`);
    assert.equal(JSON.parse(res.body).error, code);
    store.close();
  }
});
