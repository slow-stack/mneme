// 绑会话的人格卡（#606）。为什么需要这一维：人格卡原本只有 agentPreset 一个寻址键，
// 而 DS Bot 这类宿主把它写成常量——实测 bot 工作区 50 个会话里 43 个是 "standard"，
// 四条主 bot（Amarre / Ephor / Loom / Persis）全部相同，但它们的 session.id 各不相同。
// 所以「一个 bot 一张卡」只能用会话 id 当键。
//
// 本文件锁四件事：
// 1. 纯加法：没有 bySession 的老数据读回仍是空对象，注入文本逐字节不变。
// 2. 优先级：bySession > byAgent > default（会话比预设具体）。
// 3. 严格寻址的两维合判：只建了 bySession 卡时，按 byAgent 寻址的会话也不许被兜底。
// 4. scenario / mesExample：未设置零输出，设置后排在 replyStyle 之后。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { resolvePersonaCard, renderUserSettingsBlock } from "../src/user-settings.js";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path, method = "GET") {
  return { url: path, method, headers: {}, on() {}, emit() {} };
}

// 注入器 + API 共用同一份 settings/config（同源纪律），两边都能按 {agentPreset, sessionId} 寻址。
function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const contexts = [];
  const ctx = { systemPrompt: { context(def) { contexts.push(def); return () => {}; } } };
  createInjector(ctx, service, settings, config);
  const settingsCtx = contexts.find((c) => c.name === "user-settings");
  // 造 ctx：只给要测的那几个键，缺省不给（模拟宿主解析不到）。
  const makeCtx = ({ agentPreset = null, sessionId = null } = {}) => {
    if (!agentPreset && !sessionId) return {};
    const session = {};
    if (sessionId) session.id = sessionId;
    if (agentPreset) session.header = { agentPreset };
    return { agent: { session } };
  };
  const injectorText = (opts) => settingsCtx.text(makeCtx(opts));
  const routes = [];
  createApi(
    { webServer: { register: (route) => { routes.push(route); return () => {}; } } },
    service,
    settings,
    { add: () => {}, remove: () => {}, list: () => [] },
    undefined,
    undefined,
    "",
    config
  );
  const route = routes.find((r) => r.path === "/api/dsh-mneme/persona");
  const preview = async ({ agent = null, session = null } = {}) => {
    const qs = [];
    if (agent) qs.push(`agent=${encodeURIComponent(agent)}`);
    if (session) qs.push(`session=${encodeURIComponent(session)}`);
    const res = new FakeRes();
    await route.handler(req(`/api/dsh-mneme/persona${qs.length ? `?${qs.join("&")}` : ""}`), res);
    return JSON.parse(res.body);
  };
  return { store, settings, settingsCtx, injectorText, preview };
}

function seed(settings) {
  settings.setProfile("用户是规划背景");
  settings.setPersona({ name: "Amarre", personality: "轻松幽默", enabled: true }); // default
  settings.setPersonaFor("standard", { name: "标准卡", personality: "通用", enabled: true }); // byAgent
}

// ---- 1. 纯加法：老数据零变化 -------------------------------------------------

test("老数据（只有 {default, byAgent}）读回 bySession 为空对象，注入文本逐字节不变", () => {
  const { store, settings } = setup({ personaEnabled: true });
  // 直写 v1.2 形（无 bySession 键）模拟存量库
  store.db.prepare("INSERT INTO user_settings (key, value) VALUES ('persona', ?)")
    .run(JSON.stringify({
      default: { name: "Amarre", enabled: true },
      byAgent: { standard: { name: "标准卡", enabled: true } }
    }));
  const got = settings.getPersona();
  assert.deepEqual(got.bySession, {}, "缺 bySession 键必须读成空对象，不是 undefined");
  assert.equal(got.default.name, "Amarre");
  assert.equal(got.byAgent.standard.name, "标准卡");
  // 寻址结果与改动前一致：按 preset 命中 byAgent，不因多了这一维而变
  assert.equal(resolvePersonaCard(settings, "standard").source, "byAgent");
  assert.equal(resolvePersonaCard(settings, "unknown").source, "default");
  store.close();
});

test("v1 单对象老数据：读作 default，bySession 为 {}（零迁移）", () => {
  const { store, settings } = setup();
  store.db.prepare("INSERT INTO user_settings (key, value) VALUES ('persona', ?)")
    .run(JSON.stringify({ name: "Amarre", personality: "轻松幽默", enabled: true }));
  const got = settings.getPersona();
  assert.equal(got.default.name, "Amarre");
  assert.deepEqual(got.byAgent, {});
  assert.deepEqual(got.bySession, {});
  store.close();
});

test("没设 scenario / mesExample 时，注入文本与历史版本逐字节一致", () => {
  const { store, settings, injectorText } = setup({ personaEnabled: true });
  settings.setProfile("用户是规划背景");
  settings.setRules(["不提及用户名"]);
  settings.setPersona({ name: "Amarre", personality: "轻松幽默", replyStyle: "先结论后展开", enabled: true });
  const text = injectorText({});
  assert.equal(text, [
    "[用户设置] 来自 dsh-mneme 的用户画像与规则：",
    "- 你的人格名字：Amarre",
    "- 人格性格设定：轻松幽默",
    "- 回复要求：先结论后展开",
    "- 用户画像：用户是规划背景",
    "- 规则：不提及用户名"
  ].join("\n"), "两个新字段都没设时不许留下空标签或空行");
  store.close();
});

// ---- 2. 存储往返 -------------------------------------------------------------

test("bySession 存取往返：写入 → 读回 → 列出 → 删除", () => {
  const { store, settings } = setup();
  const card = { name: "Ephor", personality: "审计口径", enabled: true };
  assert.equal(settings.setPersonaForSession("session-389faaa7", card), true);
  assert.deepEqual(resolvePersonaCard(settings, null, { sessionId: "session-389faaa7" }).card, card);
  assert.deepEqual(settings.listPersonaSessions(), ["session-389faaa7"]);
  // 与 byAgent 互不干扰
  settings.setPersonaFor("standard", { name: "标准卡", enabled: true });
  assert.deepEqual(settings.listPersonas(), ["standard"]);
  assert.deepEqual(settings.listPersonaSessions(), ["session-389faaa7"]);
  // 删
  assert.equal(settings.removePersonaForSession("session-389faaa7"), true);
  assert.deepEqual(settings.listPersonaSessions(), []);
  assert.equal(settings.removePersonaForSession("session-389faaa7"), false, "删不存在的卡返回 false");
  store.close();
});

test("setPersonaForSession 拒绝空 id 与 default（兜底位不可被顶替）", () => {
  const { store, settings } = setup();
  assert.equal(settings.setPersonaForSession("", { name: "x" }), false);
  assert.equal(settings.setPersonaForSession("   ", { name: "x" }), false);
  assert.equal(settings.setPersonaForSession(null, { name: "x" }), false);
  assert.equal(settings.setPersonaForSession("default", { name: "x" }), false);
  assert.deepEqual(settings.listPersonaSessions(), []);
  store.close();
});

test("写空卡等于删除该会话卡（与 setPersonaFor 同形）", () => {
  const { store, settings } = setup();
  settings.setPersonaForSession("s1", { name: "甲", enabled: true });
  assert.deepEqual(settings.listPersonaSessions(), ["s1"]);
  settings.setPersonaForSession("s1", {});
  assert.deepEqual(settings.listPersonaSessions(), [], "空卡不留空壳键");
  store.close();
});

test("setPersona 单对象形只改 default，bySession 保留", () => {
  const { store, settings } = setup();
  settings.setPersonaForSession("s1", { name: "会话卡", enabled: true });
  settings.setPersona({ name: "Amarre-新", enabled: true }); // 旧面板写法
  const got = settings.getPersona();
  assert.equal(got.default.name, "Amarre-新");
  assert.equal(got.bySession.s1.name, "会话卡", "bySession 必须活过一次 legacy 形写入");
  store.close();
});

test("多卡形全量替换：带 bySession 键即整份替换", () => {
  const { store, settings } = setup();
  settings.setPersonaForSession("old", { name: "旧卡", enabled: true });
  settings.setPersona({ default: { name: "新默认", enabled: true }, byAgent: {}, bySession: { new: { name: "新卡", enabled: true } } });
  assert.deepEqual(settings.listPersonaSessions(), ["new"]);
  store.close();
});

// ---- 3. 寻址优先级 -----------------------------------------------------------

test("优先级：bySession 盖过 byAgent（会话比预设具体）", () => {
  const { store, settings, injectorText } = setup({ personaEnabled: true });
  seed(settings); // default=Amarre, byAgent.standard=标准卡
  settings.setPersonaForSession("session-abc", { name: "会话专属", personality: "只在这次会话", enabled: true });
  const text = injectorText({ agentPreset: "standard", sessionId: "session-abc" });
  assert.ok(text.includes("你的人格名字：会话专属"), "会话卡必须赢");
  assert.ok(!text.includes("标准卡"), "byAgent 卡不该同时出现");
  assert.ok(!text.includes("Amarre"), "default 更不该出现");
  store.close();
});

test("优先级：会话卡被关掉时落回 byAgent（不是直接跳 default）", () => {
  const { store, settings, injectorText } = setup({ personaEnabled: true });
  seed(settings);
  settings.setPersonaForSession("session-abc", { name: "会话专属", enabled: false });
  const text = injectorText({ agentPreset: "standard", sessionId: "session-abc" });
  assert.ok(text.includes("你的人格名字：标准卡"), "关掉的会话卡让位给身份卡");
  assert.ok(!text.includes("会话专属"));
  store.close();
});

test("优先级：没有会话卡时按 byAgent 走（老行为不变）", () => {
  const { store, settings } = setup({ personaEnabled: true });
  seed(settings);
  const hit = resolvePersonaCard(settings, "standard", { sessionId: "session-unknown" });
  assert.equal(hit.source, "byAgent");
  assert.equal(hit.card.name, "标准卡");
  store.close();
});

test("两个键都没有：落 default", () => {
  const { store, settings } = setup({ personaEnabled: true });
  seed(settings);
  const hit = resolvePersonaCard(settings, null, { sessionId: null });
  assert.equal(hit.source, "default");
  assert.equal(hit.card.name, "Amarre");
  store.close();
});

test("只给 sessionId、不给 agentId 也能命中会话卡（宿主可能只有会话 id）", () => {
  const { store, settings, injectorText } = setup({ personaEnabled: true });
  seed(settings);
  settings.setPersonaForSession("session-only", { name: "仅会话卡", enabled: true });
  const text = injectorText({ sessionId: "session-only" });
  assert.ok(text.includes("你的人格名字：仅会话卡"));
  store.close();
});

// ---- 4. 严格寻址：两维合判 ---------------------------------------------------

test("strict：只建了 bySession 卡时，按 byAgent 寻址的会话也不许被兜底", () => {
  // #587 的例外是「一张卡都没建」才回落 default。用户建了会话卡就已经做过分区，
  // 此时一个没建卡的 preset 会话再拿 default 去兜，等于把分区抹掉一半。
  const { store, settings } = setup();
  settings.setPersona({ name: "Amarre", enabled: true });
  assert.deepEqual(settings.getPersona().byAgent, {}, "前提：byAgent 为空");
  assert.deepEqual(settings.getPersona().bySession, {}, "前提：bySession 也为空");
  // 两维都空 → 仍回落 default（#587 例外保持）
  assert.equal(resolvePersonaCard(settings, "standard", { strict: true }).source, "default");
  // 只建会话卡之后，例外立即失效
  settings.setPersonaForSession("session-x", { name: "会话卡", enabled: true });
  assert.equal(resolvePersonaCard(settings, "standard", { strict: true }).source, "none");
  // 而那张会话卡自己仍然命中
  assert.equal(resolvePersonaCard(settings, null, { strict: true, sessionId: "session-x" }).source, "bySession");
  store.close();
});

test("strict：只建了 byAgent 卡时，按会话寻址的会话也不许被兜底", () => {
  const { store, settings } = setup();
  settings.setPersona({ name: "Amarre", enabled: true });
  settings.setPersonaFor("standard", { name: "标准卡", enabled: true });
  // 有会话 id 但没建会话卡 → none（用户已经做过 byAgent 分区）
  assert.equal(resolvePersonaCard(settings, null, { strict: true, sessionId: "session-y" }).source, "none");
  store.close();
});

test("strict：两个键都解析不到时仍用 default（无名会话是 default 的受众）", () => {
  const { store, settings } = setup();
  settings.setPersona({ name: "Amarre", enabled: true });
  settings.setPersonaForSession("session-x", { name: "会话卡", enabled: true });
  assert.equal(resolvePersonaCard(settings, null, { strict: true }).source, "default");
  store.close();
});

// ---- 5. scenario / mesExample ------------------------------------------------

test("scenario / mesExample 设置在 replyStyle 之后渲染", () => {
  const { store, settings, injectorText } = setup({ personaEnabled: true });
  settings.setPersona({
    name: "Amarre",
    personality: "轻松幽默",
    replyStyle: "先结论后展开",
    scenario: "深夜陪你赶论文",
    mesExample: "桉桉：好累。Amarre：先睡，剩下的我盯着。",
    enabled: true
  });
  const text = injectorText({});
  const idxReply = text.indexOf("回复要求：先结论后展开");
  const idxScene = text.indexOf("场景设定：深夜陪你赶论文");
  const idxExample = text.indexOf("对话示例：桉桉：好累。");
  assert.ok(idxReply > -1 && idxScene > -1 && idxExample > -1, "三段都在");
  assert.ok(idxScene > idxReply, "场景在语气之后：身份 → 语气 → 场景 → 示例");
  assert.ok(idxExample > idxScene, "示例在场景之后");
  store.close();
});

test("scenario 只设一个字段时只出一行，不牵连另一个", () => {
  const { store, settings, injectorText } = setup({ personaEnabled: true });
  settings.setPersona({ name: "Amarre", scenario: "只在夜里出现", enabled: true });
  const text = injectorText({});
  assert.ok(text.includes("场景设定：只在夜里出现"));
  assert.ok(!text.includes("对话示例"), "没设 mesExample 就不出那一行");
  store.close();
});

test("卡里存着空白 scenario / mesExample 时不出空标签（未设置零输出）", () => {
  // 未设置的字段被 parsePersona 白名单挡在外面，但「存了空白」是另一条路：
  // 卡里确实有这个键、值是空白串。这一行必须整行不出现，不能渲染成「场景设定：」。
  const { store, settings, injectorText } = setup({ personaEnabled: true });
  settings.setPersona({ name: "Amarre", scenario: "   ", mesExample: "\t ", enabled: true });
  const card = settings.getPersona().default;
  assert.equal(card.scenario, "   ", "空白串仍被存下（白名单不负责裁空白）");
  const text = injectorText({});
  assert.ok(!text.includes("场景设定"), "空白 scenario 不许渲染出标签");
  assert.ok(!text.includes("对话示例"), "空白 mesExample 不许渲染出标签");
  assert.ok(text.includes("你的人格名字：Amarre"), "其余段落照常");
  store.close();
});

test("scenario / mesExample 走同一个转义（花括号不许漏出去）", () => {
  const { store, settings, injectorText } = setup({ personaEnabled: true });
  settings.setPersona({ name: "Amarre", scenario: "{{evil}}", mesExample: "{{x}}", enabled: true });
  const text = injectorText({});
  assert.ok(!text.includes("{{"), "no raw {{ in user-settings block");
  assert.ok(!text.includes("}}"), "no raw }} in user-settings block");
  store.close();
});

test("scenario / mesExample 只在卡 enabled 时渲染（关掉的卡一个字都不出）", () => {
  const { store, settings, injectorText } = setup({ personaEnabled: true });
  settings.setPersona({ name: "Amarre", scenario: "深夜", enabled: false });
  settings.setProfile("有画像");
  const text = injectorText({});
  assert.ok(!text.includes("场景设定"), "卡关着时新字段同样不渲染");
  assert.ok(text.includes("用户画像："));
  store.close();
});

test("scenario / mesExample 过字段白名单（未知字段仍被丢弃）", () => {
  const { store, settings } = setup();
  settings.setPersona({ name: "Amarre", scenario: "场景", mesExample: "示例", sneaky: "x" });
  const card = settings.getPersona().default;
  assert.equal(card.scenario, "场景");
  assert.equal(card.mesExample, "示例");
  assert.equal("sneaky" in card, false, "白名单没放宽");
  store.close();
});

// ---- 6. 端到端：注入链路 + 预览路由 ------------------------------------------

test("注入链路端到端：同一个 agentPreset、不同 sessionId 拿到不同人格", () => {
  // 这就是 #606 要解决的场景本身：DS Bot 里四个 bot 的 agentPreset 全是 standard。
  const { store, settings, injectorText } = setup({ personaEnabled: true });
  settings.setPersona({ name: "Amarre", enabled: true });
  settings.setPersonaForSession("session-d530e132", { name: "Amarre", personality: "主控", enabled: true });
  settings.setPersonaForSession("session-389faaa7", { name: "Ephor", personality: "审计", enabled: true });
  const a = injectorText({ agentPreset: "standard", sessionId: "session-d530e132" });
  const b = injectorText({ agentPreset: "standard", sessionId: "session-389faaa7" });
  assert.ok(a.includes("你的人格名字：Amarre"));
  assert.ok(b.includes("你的人格名字：Ephor"), "同一个 standard 预设下，会话卡必须分得开");
  assert.ok(!b.includes("你的人格名字：Amarre"));
  store.close();
});

test("预览路由支持 &session=，且与注入器逐字节同源", async () => {
  const { store, settings, injectorText, preview } = setup({ personaEnabled: true });
  seed(settings);
  settings.setPersonaForSession("session-abc", { name: "会话专属", personality: "只在这里", enabled: true });
  const fromInjector = injectorText({ agentPreset: "standard", sessionId: "session-abc" });
  const body = await preview({ agent: "standard", session: "session-abc" });
  assert.equal(body.preview.text, fromInjector, "预览必须等于注入器这一帧的输出");
  assert.equal(body.preview.source, "bySession");
  assert.equal(body.preview.session, "session-abc", "面板要靠它说清用的是哪张会话卡");
  assert.ok(body.preview.text.includes("你的人格名字：会话专属"));
  store.close();
});

test("预览只给 session 不给 agent 也走会话卡", async () => {
  const { store, settings, preview } = setup({ personaEnabled: true });
  seed(settings);
  settings.setPersonaForSession("session-only", { name: "仅会话卡", enabled: true });
  const body = await preview({ session: "session-only" });
  assert.equal(body.preview.source, "bySession");
  assert.equal(body.preview.agent, null);
  assert.equal(body.preview.session, "session-only");
  store.close();
});

test("预览的 session 参数在 strict 下同样生效（不许比注入更乐观）", async () => {
  const { store, settings, preview } = setup({ personaEnabled: true, personaStrictAddressing: true });
  seed(settings);
  const miss = await preview({ session: "session-unknown" });
  assert.equal(miss.preview.source, "none", "建过卡、这次会话没建 → 不兜底");
  assert.ok(!miss.preview.text.includes("Amarre"));
  settings.setPersonaForSession("session-hit", { name: "命中卡", enabled: true });
  const hit = await preview({ session: "session-hit" });
  assert.equal(hit.preview.source, "bySession");
  store.close();
});

// ---- 7. 健壮性 ---------------------------------------------------------------

test("session.id 取不到（宿主 accessor 抛错）时不影响 agentPreset 寻址", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  seed(settings);
  // session.id 是抛错的 getter，header 正常——两个键各自护住，不许互相拖累
  const hostile = {
    agent: {
      session: {
        get id() { throw new Error("no id accessor"); },
        header: { agentPreset: "standard" }
      }
    }
  };
  const text = settingsCtx.text(hostile);
  assert.ok(text.includes("你的人格名字：标准卡"), "id 抛错不该让 preset 也丢掉");
  store.close();
});

test("bySession 里的损坏卡（非对象）被丢弃，不抛错", () => {
  const { store, settings } = setup();
  store.db.prepare("INSERT INTO user_settings (key, value) VALUES ('persona', ?)")
    .run(JSON.stringify({ default: {}, byAgent: {}, bySession: { bad: "not a card", good: { name: "好卡", enabled: true } } }));
  const got = settings.getPersona();
  assert.equal("bad" in got.bySession, false, "坏卡读成空对象后不收（与 byAgent 同口径）");
  assert.equal(got.bySession.good.name, "好卡");
  store.close();
});

test("renderUserSettingsBlock 返回值带 session 字段（面板定位用）", () => {
  const { store, settings } = setup({ personaEnabled: true });
  settings.setPersona({ name: "Amarre", enabled: true });
  const out = renderUserSettingsBlock({ settings, config: { personaEnabled: true }, agentId: "standard", sessionId: "s1" });
  assert.equal(out.session, "s1");
  assert.equal(out.agent, "standard");
  assert.equal(out.source, "default");
  store.close();
});
