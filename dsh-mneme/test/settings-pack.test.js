// 设置快照（#778）：人格卡 + 相关开关 + 规则的复制粘贴搬运。
//
// 这个文件锁四件事，都是「搬运」这件事最容易撒谎的地方：
// 1. 导出取的是**生效值**，不是 overrides——不然「本机开着、对方默认也开着」的键
//    搬过去会悄悄变回去；
// 2. 干跑与真写对同一份包给出同一份判断（预览说会改三处，实际就只该改三处）；
// 3. 导入是**合并**不是覆盖：本机独有的人格卡不许被包顺手抹掉；
// 4. 跨机器对不上的 byAgent 卡要被点名（unmatched），不许静默丢掉——丢掉之后
//    用户在对面机器上看到的是「人格没了」，而包里明明有。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";
import {
  buildSettingsPack,
  parseSettingsPack,
  planSettingsPack,
  planHasChanges,
  applySettingsPack,
  PACK_KIND,
  PACK_VERSION
} from "../src/settings-pack.js";
import { FAKE_API_TOKEN } from "./helpers/fake-auth-values.js";
import { testConfig } from "./helpers/test-config.js";

const AUTH = { authorization: `Bearer ${FAKE_API_TOKEN}` };

class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.body = "";
  }
  setHeader(key, value) {
    this.headers[String(key).toLowerCase()] = value;
  }
  writeHead(status, headers) {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  end(chunk) {
    if (chunk) this.body += chunk;
    this.emit("finish");
  }
  json() {
    try {
      return JSON.parse(this.body);
    } catch {
      return null;
    }
  }
}

/** 造一个只有 settings 的最小 api 装配，返回 settings 与路由查找器。 */
function mount({ config = testConfig({}) } = {}) {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  const mounted = [];
  createApi(
    { webServer: { register(route) { mounted.push(route); return () => {}; } } },
    createService({ store, mirror: null, config }),
    settings,
    { add() {}, remove() {}, list: () => [] },
    null,
    undefined,
    FAKE_API_TOKEN,
    config
  );
  const routes = new Map(mounted.map((route) => [route.path, route]));
  const call = (path, method = "GET", body = null, headers = {}) => new Promise((resolve) => {
    const route = routes.get(path.split("?")[0]);
    assert.ok(route, `没有装配出 ${path} 这条路由`);
    const req = new EventEmitter();
    req.method = method;
    req.url = path;
    req.headers = headers;
    const res = new FakeRes();
    res.on("finish", () => resolve(res));
    const pending = route.handler(req, res);
    if (pending && typeof pending.then === "function") pending.catch(() => {});
    if (body !== null) {
      req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
    }
    req.emit("end");
  });
  return { settings, call, routes };
}

const PACK_PATH = "/api/dsh-mneme/settings-pack";

// ---------------------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------------------

test("导出取生效值：overrides 里没有、但 cfg 生效的键也要进包", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  settings.setFeatureFlags({ personaEnabled: true });

  const pack = buildSettingsPack({
    settings,
    // 生效值：personaEnabled 真开了，injectTimePrefix 由 cfg 决定为 false。
    effectiveFlags: { personaEnabled: true, injectTimePrefix: false }
  });
  assert.equal(pack.kind, PACK_KIND);
  assert.equal(pack.version, PACK_VERSION);
  assert.equal(pack.featureFlags.personaEnabled, true);
  assert.equal(pack.featureFlags.injectTimePrefix, false,
    "生效值里的 false 也必须带出去——否则对方机器上默认 true 的键会悄悄变回 true");
});

test("导出只带本包负责的开关，别的开关一个都不带", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  // 一个明显不属于「人格/注入/画像」面的开关。
  settings.setFeatureFlags({ diaryEnabled: true });

  const pack = buildSettingsPack({ settings, effectiveFlags: settings.getFeatureFlags() });
  assert.equal("diaryEnabled" in pack.featureFlags, false,
    "设置快照是搬人格用的，不是「把一台机器的全部调参覆盖到另一台」");
});

test("导入别人的包时，包里有、但本包不管的开关要被点名跳过（不静默吃下）", () => {
  const parsed = parseSettingsPack({
    kind: PACK_KIND,
    version: PACK_VERSION,
    featureFlags: { personaEnabled: true, diaryEnabled: true }
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.pack.featureFlags.personaEnabled, true);
  assert.equal("diaryEnabled" in parsed.pack.featureFlags, false);
  const warning = parsed.warnings.find((w) => w.code === "flags-out-of-scope");
  assert.deepEqual(warning?.keys, ["diaryEnabled"], "跳过的键必须列出来，用户才知道少了什么");
});

test("单卡形（v1 老包或手写 JSON）被读成 default 卡", () => {
  const parsed = parseSettingsPack({ persona: { name: "手写卡", personality: "话少" } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.pack.persona.default.name, "手写卡");
  assert.deepEqual(parsed.pack.persona.byAgent, {});
});

test("坏包各有各的错误码，不是一句 invalid", () => {
  assert.equal(parseSettingsPack("{oops").error, "invalid-json");
  assert.equal(parseSettingsPack({ kind: "something-else", persona: {} }).error, "wrong-kind");
  assert.equal(parseSettingsPack({ kind: PACK_KIND, version: 99 }).error, "unsupported-version");
  assert.equal(parseSettingsPack({ kind: PACK_KIND, version: PACK_VERSION }).error, "empty-pack");
  assert.equal(parseSettingsPack({ persona: [] }).error, "invalid-persona");
  assert.equal(parseSettingsPack({ rules: "不是数组" }).error, "invalid-rules");
});

test("干跑与真写对同一份包给同一份判断", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  const pack = parseSettingsPack({
    kind: PACK_KIND,
    version: PACK_VERSION,
    persona: { default: { name: "Amarre" } },
    rules: ["别叫您"]
  }).pack;

  const plan = planSettingsPack({ settings, pack });
  assert.equal(planHasChanges(plan), true, "空库导入一份有内容的包，一定有事可做");

  applySettingsPack({ settings, pack });
  // 写完再算一次计划：应当变成「什么都没得改」。
  const after = planSettingsPack({ settings, pack });
  assert.equal(planHasChanges(after), false,
    "真写之后再干跑必须说「没变化」——说「还有变化」就是预览与实际不同源");
});

test("导入是合并：本机独有的 byAgent 卡不许被包顺手抹掉", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  settings.setPersona({
    default: { name: "本机默认" },
    byAgent: { "local-only": { name: "本机独有卡" } },
    bySession: {}
  });

  const pack = parseSettingsPack({
    kind: PACK_KIND,
    version: PACK_VERSION,
    persona: { byAgent: { "from-other-machine": { name: "搬来的卡" } } }
  }).pack;

  const plan = planSettingsPack({ settings, pack });
  assert.deepEqual(plan.sections.persona.keptLocal.byAgent, ["local-only"],
    "计划里要写明「本机这几张卡不在包里、会被保留」");

  applySettingsPack({ settings, pack });
  const after = settings.getPersona();
  assert.equal(after.byAgent["local-only"]?.name, "本机独有卡", "本机独有的卡必须还在");
  assert.equal(after.byAgent["from-other-machine"]?.name, "搬来的卡", "包里的卡要写进去");
});

test("跨机器对不上的 byAgent 卡被点名，而不是静默丢掉", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  const pack = parseSettingsPack({
    kind: PACK_KIND,
    version: PACK_VERSION,
    persona: { byAgent: { "bot-a": { name: "A" }, standard: { name: "标准" } } }
  }).pack;

  // 这台机器只见过 standard。
  const plan = planSettingsPack({ settings, pack, knownAgents: ["standard"] });
  assert.deepEqual(plan.sections.persona.byAgent.unmatched, ["bot-a"],
    "对不上的卡要单独列出来，面板据此提示用户");
  assert.ok(plan.warnings.some((w) => w.code === "persona-unmatched-agents"));

  // 用户选「只保留能对上的」时，对不上的卡不写。
  applySettingsPack({ settings, pack, knownAgents: ["standard"], dropUnmatched: true });
  const after = settings.getPersona();
  assert.equal(after.byAgent.standard?.name, "标准");
  assert.equal(after.byAgent["bot-a"], undefined, "dropUnmatched 时对不上的卡不该落库");
});

test("不知道本机有哪些身份时不瞎猜：knownAgents 为 null 就不标 unmatched", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  const pack = parseSettingsPack({
    kind: PACK_KIND,
    version: PACK_VERSION,
    persona: { byAgent: { "bot-a": { name: "A" } } }
  }).pack;

  const plan = planSettingsPack({ settings, pack, knownAgents: null });
  assert.deepEqual(plan.sections.persona.byAgent.unmatched, []);
  assert.equal(plan.warnings.some((w) => w.code === "persona-unmatched-agents"), false,
    "不知道就别下结论——面板显示「无法判断」比显示错的「全都对不上」好");
});

test("坏的开关值被逐条拒掉，好的照写（一个坏键不拖垮整批）", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  const pack = parseSettingsPack({
    kind: PACK_KIND,
    version: PACK_VERSION,
    // 三个键各有各的坏法：越界整数、类型不对的布尔、以及一个本包根本不管的键。
    featureFlags: {
      autoInject: true,
      personaEnabled: "yes",
      injectContentMaxChars: 999999,
      diaryEnabled: true
    }
  }).pack;

  const plan = planSettingsPack({ settings, pack });
  const rejected = plan.sections.featureFlags.rejected.map((r) => r.key);
  assert.ok(rejected.includes("injectContentMaxChars"), "越界的整数要被拒");
  assert.ok(rejected.includes("personaEnabled"), "类型不对的布尔要被拒");
  assert.equal("diaryEnabled" in pack.featureFlags, false,
    "本包不管的键在解析阶段就被摘掉了（另一条 warning 说），不该混在「值非法」里");
  assert.ok(plan.warnings.some((w) => w.code === "flag-rejected"));

  const applied = applySettingsPack({ settings, pack });
  assert.equal(applied.featureFlags, true, "有一个好键变了，整段就算写过了");
  const flags = settings.getFeatureFlags();
  assert.equal(flags.autoInject, true, "合法的那个仍要写进去");
  assert.equal(flags.personaEnabled, undefined, "被拒的那个不该落库");
  assert.equal(flags.injectContentMaxChars, undefined);
});

test("规则是整份替换（顺序也算变化），并报出加了什么删了什么", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  settings.setRules(["旧规则", "留着的"]);

  const pack = parseSettingsPack({
    kind: PACK_KIND, version: PACK_VERSION, rules: ["留着的", "新规则"]
  }).pack;
  const plan = planSettingsPack({ settings, pack });
  assert.equal(plan.sections.rules.action, "replace");
  assert.deepEqual(plan.sections.rules.added, ["新规则"]);
  assert.deepEqual(plan.sections.rules.removed, ["旧规则"]);

  applySettingsPack({ settings, pack });
  assert.deepEqual(settings.getRules(), ["留着的", "新规则"]);
});

// ---------------------------------------------------------------------------
// 路由层
// ---------------------------------------------------------------------------

test("GET /settings-pack 免 token 就能导出（与 /persona、/features 同一条开放读面）", async () => {
  const { call, settings } = mount();
  settings.setPersona({ default: { name: "Amarre" } });
  settings.setRules(["别叫您"]);

  const res = await call(PACK_PATH);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.pack.kind, PACK_KIND);
  assert.equal(body.pack.persona.default.name, "Amarre");
  assert.deepEqual(body.pack.rules, ["别叫您"]);
});

test("GET 的 sections 参数能把不要的段摘掉", async () => {
  const { call, settings } = mount();
  settings.setPersona({ default: { name: "Amarre" } });
  settings.setRules(["别叫您"]);

  const only = await call(`${PACK_PATH}?sections=persona`);
  assert.deepEqual(Object.keys(only.json().pack).filter((k) => !["kind", "version", "createdAt"].includes(k)), ["persona"],
    "点名只要 persona 时不该带 rules 或开关");
});

test("POST 没带 token 是 401，带了不带 confirm 只干跑", async () => {
  const { call, settings } = mount();
  settings.setPersona({ default: { name: "本机" } });
  const pack = buildSettingsPack({ settings });

  const denied = await call(PACK_PATH, "POST", { pack });
  assert.equal(denied.statusCode, 401, "写面必须与 /persona、/features 同一条门控");

  const dry = await call(PACK_PATH, "POST", { pack }, AUTH);
  assert.equal(dry.statusCode, 200);
  assert.equal(dry.json().dryRun, true, "没带 confirm 一律只报会改什么");
  assert.equal(dry.json().pack.persona.default.name, "本机");
});

test("POST 干跑不改库；带 confirm 才落库，且只写会变的开关", async () => {
  const { call, settings } = mount();
  const incoming = {
    kind: PACK_KIND,
    version: PACK_VERSION,
    persona: { default: { name: "搬来的" } },
    featureFlags: { personaEnabled: true }
  };
  const dry = await call(PACK_PATH, "POST", { pack: incoming }, AUTH);
  assert.equal(dry.json().hasChanges, true);
  assert.deepEqual(settings.getPersona().default, {}, "干跑一个字节都不该写");
  assert.deepEqual(settings.getFeatureFlags(), {});

  const done = await call(PACK_PATH, "POST", { pack: incoming, confirm: true }, AUTH);
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().dryRun, false);
  assert.deepEqual(done.json().applied, { persona: true, featureFlags: true, rules: false });
  assert.equal(settings.getPersona().default.name, "搬来的");
  assert.equal(settings.getFeatureFlags().personaEnabled, true);
});

test("同一份包再导一次是 noop，不假装「导入成功」", async () => {
  const { call } = mount();
  const incoming = { kind: PACK_KIND, version: PACK_VERSION, rules: ["别叫您"] };

  const first = await call(PACK_PATH, "POST", { pack: incoming, confirm: true }, AUTH);
  assert.equal(first.json().noop, undefined);

  const second = await call(PACK_PATH, "POST", { pack: incoming, confirm: true }, AUTH);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().noop, true, "什么都没改就不是「导入成功」——那会让用户以为搬了东西");
});

test("POST 的 dropUnmatched 透传给合并逻辑", async () => {
  const { call, settings } = mount();
  const pack = {
    kind: PACK_KIND,
    version: PACK_VERSION,
    persona: { byAgent: { "unknown-bot": { name: "对不上的卡" } } }
  };
  // 这个装配里没有任何会话事件，knownAgents 为 null → 不标 unmatched，也不该被丢掉。
  const res = await call(PACK_PATH, "POST", { pack, confirm: true, dropUnmatched: true }, AUTH);
  assert.equal(res.statusCode, 200);
  assert.equal(settings.getPersona().byAgent["unknown-bot"]?.name, "对不上的卡",
    "不知道本机有哪些身份时，dropUnmatched 不该变成「把卡全扔了」");
});

test("非 GET/POST 一律 405（与 /receive 同一个形状）", async () => {
  const { call } = mount();
  const res = await call(PACK_PATH, "PUT", null, AUTH);
  assert.equal(res.statusCode, 405);
  assert.equal(res.json().error, "method-not-allowed");
});

test("坏包回 400 带错误码，不写库", async () => {
  const { call, settings } = mount();
  const res = await call(PACK_PATH, "POST", { pack: "{oops" }, AUTH);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid-json");
  assert.deepEqual(settings.getPersona(), { default: {}, byAgent: {}, bySession: {} });
});

test("包体可以直接是包本身（不必套一层 pack），手写粘贴更省事", async () => {
  const { call, settings } = mount();
  const res = await call(PACK_PATH, "POST", {
    kind: PACK_KIND, version: PACK_VERSION, rules: ["直接贴"]
  }, AUTH);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().dryRun, true);
  assert.equal(res.json().plan.sections.rules.action, "replace");
  assert.deepEqual(settings.getRules(), [], "干跑仍然不写");
});
