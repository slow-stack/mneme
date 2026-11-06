// 「Agent 眼中的你」自动事实（2026-11-06）：逐卡事实清单 + dream 后自动维护轮 +
// 面板手动轮 + 注入段。单独立用例文件的理由与 profile-extract.test.js 同源——这条链
// 的产品承诺很窄也很硬，全是「做错了界面上看不出来」的那类，逐条锁：
// ① 手填画像神圣：任何路径都不写 user_settings（事实住 profile_facts 独立三表）；
// ② 没有增量输入就不调模型（游标之后没有新行 = noop，回执可查）；
// ③ 模型吐的不是可用 ops JSON 就 failed，绝不冒充「这轮跑过了」；
// ④ 失败不推进游标——failed 轮之后重跑同一窗口（蒸馏游标同款纪律）；
// ⑤ 卡间不互串：输入行按 agent_scope 严格分区（store 层），注入按 strict 寻址
//    （user-settings 层），LLM 幻觉出的别卡 id 落不进本卡（apply 层）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";
import { createProfileFacts, ProfileFactsError, parseFactOps, isValidFactOps } from "../src/profile-facts.js";
import { renderUserSettingsBlock, resolveFactsCard } from "../src/user-settings.js";

// 假的 ctx.llm：协议与 profile-extract.test.js 的 fakeLlm 同款（用量嵌在 chunk.usage）。
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

const okOps = (ops) => [
  { type: "text-delta", text: "```json\n" },
  { type: "text-delta", text: JSON.stringify({ ops }) },
  { type: "text-delta", text: "\n```" },
  { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } },
  { type: "finish", reason: { kind: "stop" } }
];

function setup(chunks, opts = {}) {
  const { config = {} } = opts;
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const fake = fakeLlm(chunks);
  const logger = { info() {}, warn() {}, error() {} };
  const facts = createProfileFacts({
    ctx: { ...fake, agentDefaultModel: { currentSelection: () => null } },
    service,
    store,
    config: { dreamProvider: "fake", dreamModel: "m1", ...config },
    logger
  });
  return { store, service, settings, facts, fake, logger };
}

/** 种记忆行；updated_at 由 save() 铸造（不接受传值），所以游标断言一律读行取值。 */
function seedRows(store, n, over = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `m-${over.agent_scope ?? "d"}-${i}`;
    store.save({ id, type: "project", title: `行 ${i}`, content: `第 ${i} 行的正文`, ...over });
    ids.push(id);
  }
  return ids;
}

test("解析器：围栏 JSON 可取；未知 op / 缺 content / 非 JSON 一律 null，绝不冒充空成功", () => {
  assert.deepEqual(parseFactOps('{"ops":[]}'), [], "空 ops 是合法的「没什么可改」");
  assert.equal(parseFactOps("我觉得她很好。"), null);
  assert.equal(parseFactOps('{"ops":[{"op":"delete","id":"x"}]}'), null, "delete 不在 v1 op 集里");
  assert.equal(parseFactOps('{"ops":[{"op":"add"}]}'), null, "add 缺 content = 形状不合格");
  assert.equal(parseFactOps('{"ops":[{"op":"update"}]}'), null, "update 缺 id = 形状不合格");
  // update 缺 content 是评审 P1 实测复现的洞：String(undefined) 会把「undefined」
  // 写进事实正文并从此每帧注入。谓词一份皮，解析层与 /apply 的 400 闸同源。
  assert.equal(parseFactOps('{"ops":[{"op":"update","id":"x"}]}'), null, "update 缺 content 同样不合格");
  assert.equal(isValidFactOps([{ op: "update", id: "x" }]), false);
  assert.equal(isValidFactOps([{ op: "update", id: "x", content: "  " }]), false, "空白 content 不算有");
  assert.equal(isValidFactOps([]), false, "空数组走「没什么可改」的合法路径，但谓词口径是待写入批必须非空");
  const bare = parseFactOps('[{"op":"add","content":"裸数组也收"}]');
  assert.equal(bare[0].content, "裸数组也收", "宽取对裸数组同样生效");
});

test("no-route：抛错、零模型调用，且 failed 回执已落库、游标未推进", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const facts = createProfileFacts({
    ctx: { agentDefaultModel: { currentSelection: () => null } },
    service, store, config: {}, logger: { warn() {}, info() {}, error() {} }
  });
  seedRows(store, 2);
  await assert.rejects(() => facts.runFor("", { trigger: "manual" }),
    (err) => err instanceof ProfileFactsError && err.code === "no-route");
  const runs = store.listProfileFactRuns("", { limit: 5 });
  assert.equal(runs.length, 1, "failed 轮照样落回执（账面上留痕）");
  assert.equal(runs[0].status, "failed");
  assert.equal(store.profileFactsCursor(""), null, "失败不推进游标");
  store.close();
});

test("noop：游标之后没有新行就不调模型，回执 noop、游标不动", async () => {
  const { store, facts, fake } = setup(okOps([]));
  const ids = seedRows(store, 1);
  const rows = store.listFactInputRows("", { since: null, limit: 10 });
  // 手动把游标推到这行的 updated_at 之后：模拟「上一轮已经看过它」。
  store.insertProfileFactRun({
    id: "r-seed", agentKey: "", triggerSource: "manual", status: "ok",
    cursor: rows[0].updated_at, inputCount: 1, opsApplied: 0, detail: null,
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z"
  });
  const receipt = await facts.runFor("", { trigger: "manual" });
  assert.equal(receipt.status, "noop");
  assert.equal(fake.calls.length, 0, "没有增量输入就不该花这次调用");
  assert.equal(store.profileFactsCursor(""), rows[0].updated_at);
  store.close();
});

test("成功路径：ops 落库、账本逐 op、审计一行、游标推进到本轮消费点；重跑即 noop", async () => {
  const { store, service, settings, facts, fake } = setup(okOps([
    { op: "add", content: "用户在准备考研", source_ids: ["m-d-0"] },
    { op: "add", content: "用户在准备考研" }, // 与上一条精确重复：跳过不落
    { op: "add", content: "幻觉事实" }
  ]));
  const ids = seedRows(store, 2);
  settings.setProfile("手写原文，不许动");
  const profileBefore = settings.getProfile();
  const receipt = await facts.runFor("", { trigger: "auto" });
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.opsApplied, 2, "重复 add 被跳过，不落库");
  assert.equal(receipt.detail.dupsSkipped, 1);
  const active = store.listProfileFacts("", { includeArchived: false });
  assert.equal(active.length, 2);
  assert.equal(store.profileFactsCursor(""), receipt.cursor, "ok 轮推进游标");
  const rows = store.listFactInputRows("", { since: null, limit: 10 });
  assert.equal(receipt.cursor, rows.map((r) => r.updated_at).sort().at(-1), "游标 = 本轮窗口内最大的 updated_at");
  const journal = store.listProfileFactJournal("", { limit: 10 });
  assert.equal(journal.length, 2, "每条落地的 op 一行账");
  assert.equal(journal[0].op, "add");
  assert.equal(journal[0].actor, "auto");
  assert.ok(journal[0].run_id, "自动轮的账带 run_id");
  const audits = service.listLlmAudits({ limit: 10 });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].trigger_source, "profileFacts");
  assert.equal(audits[0].status, "success");
  assert.equal(audits[0].input_tokens, 100, "用量从 chunk.usage 取");
  // listLlmAudits 的读侧已把 related_memory_ids 解回数组；输入行按 updated_at
  // DESC 喂给模型，比对时排序对齐。
  assert.deepEqual([...audits[0].related_memory_ids].sort(), [...ids].sort(), "审计关联到本轮输入行");
  // 手填画像神圣：维护轮跑得再热闹，user_settings 一个字节没动。
  assert.equal(settings.getProfile(), profileBefore);
  assert.equal(store.listActiveFactsGrouped().default.length, 2);
  // 游标已推进、没有新行：重跑必须 noop（幂等），不再花模型。
  const again = await facts.runFor("", { trigger: "auto" });
  assert.equal(again.status, "noop");
  assert.equal(fake.calls.length, 1);
  store.close();
});

test("update/archive 只认本卡的事实：LLM 幻觉出的 id 落进 failures，不误伤别卡", async () => {
  const { store, facts } = setup(okOps([
    { op: "update", id: "ghost-id", content: "改写不存在的事实" },
    { op: "archive", id: "ghost-id" }
  ]));
  seedRows(store, 1);
  // 另一张卡上真实存在一条事实——幻觉 id 恰好不该碰到它。
  facts.applyManualOps("botA", [{ op: "add", content: "botA 卡的事实" }]);
  const receipt = await facts.runFor("", { trigger: "manual" });
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.opsApplied, 0);
  assert.equal(receipt.detail.failures.length, 2);
  assert.equal(store.listProfileFacts("botA", { includeArchived: true })[0].content, "botA 卡的事实", "别卡的行不许被动");
  store.close();
});

test("同批 [update A→B, add B] 只落一条：去重集合要跟上 update 的新值（评审 P2）", () => {
  const { store, facts } = setup(okOps([]));
  facts.applyManualOps("", [{ op: "add", content: "旧表述 A" }]);
  const id = store.listProfileFacts("", { includeArchived: false })[0].id;
  const out = facts.applyManualOps("", [
    { op: "update", id, content: "新表述 B" },
    { op: "add", content: "新表述 B" }
  ]);
  assert.equal(out.applied, 1, "update 落地，add 撞上去重集被跳过");
  assert.equal(out.dupsSkipped, 1);
  const active = store.listProfileFacts("", { includeArchived: false });
  assert.equal(active.length, 1, "不收新值的话这里会是两条相同事实");
  assert.equal(active[0].content, "新表述 B");
  store.close();
});

test("unparseable：审计记 error、failed 回执落库、游标不动——下一轮重跑同一窗口", async () => {
  const { store, service, facts } = setup([
    { type: "text-delta", text: "我觉得用户挺好的。" },
    { type: "finish", reason: { kind: "stop" } }
  ]);
  seedRows(store, 2);
  await assert.rejects(() => facts.runFor("", { trigger: "manual" }),
    (err) => err instanceof ProfileFactsError && err.code === "unparseable");
  const audits = service.listLlmAudits({ limit: 10 });
  assert.equal(audits[0].status, "error", "吐了文字但没有可用产物 = 失败调用");
  assert.equal(store.profileFactsCursor(""), null, "失败不消费窗口");
  assert.equal(store.listFactInputRows("", { since: null, limit: 10 }).length, 2, "同一窗口还在等下一轮");
  store.close();
});

test("输入行严格分区：agent 卡只吃自己 scope 的行，default 只吃 NULL 行，外来行整体排除", async () => {
  const { store } = setup(okOps([]));
  seedRows(store, 2, { agent_scope: "botA", agent_scope_source: "auto" });
  seedRows(store, 2);
  store.save({ type: "project", title: "外来", content: "别人导入的原文", source: "imported" });
  store.save({ type: "project", title: "外来A", content: "别人导入的 botA 行", source: "imported", agent_scope: "botA", agent_scope_source: "explicit" });
  const def = store.listFactInputRows("", { since: null, limit: 50 });
  const a = store.listFactInputRows("botA", { since: null, limit: 50 });
  assert.equal(def.length, 2, "default 卡只有 NULL scope 的本方行");
  assert.equal(a.length, 2, "botA 卡只有自己 scope 的本方行");
  assert.ok(def.every((r) => r.agent_scope === undefined || r.agent_scope === null));
  assert.ok(a.every((r) => !r.content.includes("导入")));
  store.close();
});

test("autoPassCandidates：有增量输入的卡在名单里，没输入的不在；'' 恒在候选集里被评估", async () => {
  const { store, facts } = setup(okOps([]));
  seedRows(store, 1);
  seedRows(store, 1, { agent_scope: "botA", agent_scope_source: "auto" });
  let cands = facts.autoPassCandidates();
  assert.ok(cands.includes(""));
  assert.ok(cands.includes("botA"));
  // 手动把两张卡都推到「已消费」：名单清空。
  for (const key of ["", "botA"]) {
    const rows = store.listFactInputRows(key, { since: null, limit: 10 });
    store.insertProfileFactRun({
      id: `seed-${key || "d"}`, agentKey: key, triggerSource: "manual", status: "ok",
      cursor: rows.map((r) => r.updated_at).sort().at(-1), inputCount: rows.length,
      opsApplied: 0, detail: null, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z"
    });
  }
  cands = facts.autoPassCandidates();
  assert.deepEqual(cands, [], "没有增量输入就没有自动轮（连 noop 回执都不落）");
  store.close();
});

test("账本裁剪：每卡只留最近 200 条，旧的删掉、新的完好", () => {
  const store = createStore(":memory:");
  for (let i = 0; i < 250; i++) {
    store.insertProfileFactJournal({ at: "2026-11-06T00:00:00.000Z", agentKey: "", op: "add", after: `第 ${i} 条`, actor: "auto" });
  }
  const pruned = store.pruneProfileFactJournal("", 200);
  assert.equal(pruned, 50);
  const left = store.listProfileFactJournal("", { limit: 1000 });
  assert.equal(left.length, 200);
  assert.equal(left[0].after, "第 249 条", "保留的是最近的");
  assert.equal(left.at(-1).after, "第 50 条");
  store.close();
});

// ---- 注入渲染（renderUserSettingsBlock 的 factsProvider 半边） ----------------

const settingsStub = {
  getProfile: () => "手填画像原文",
  getRules: () => ["规则一"],
  getPersona: () => ({ default: { enabled: false }, byAgent: {} })
};
const configOn = { language: "zh", profileFactsEnabled: true };

test("注入顺序：人格 → 手填画像 → 自动事实 → 规则；事实段带表头与逐条行", () => {
  const provider = () => ({ default: ["事实甲", "事实乙"], byAgent: {} });
  const out = renderUserSettingsBlock({ settings: settingsStub, config: configOn, agentId: null, factsProvider: provider });
  const t = out.text;
  const iProfile = t.indexOf("用户画像：");
  const iFacts = t.indexOf("关于用户的观察记录");
  const iRules = t.indexOf("规则：规则一");
  assert.ok(iProfile >= 0 && iFacts > iProfile && iRules > iFacts, "设计稿⑥顺序的延伸：画像 < 事实 < 规则");
  assert.ok(t.includes("  - 事实甲") && t.includes("  - 事实乙"), "事实逐条行");
  assert.ok(t.includes("（2 条，自动维护）"), "表头带条数");
});

test("strict 寻址：有身份没卡时不落 default 的事实（两 bot 的认知不互串的注入半边）", () => {
  const provider = () => ({ default: ["默认卡事实"], byAgent: { botA: ["botA 卡事实"] } });
  const byAgent = renderUserSettingsBlock({ settings: settingsStub, config: configOn, agentId: "botA", factsProvider: provider });
  assert.ok(byAgent.text.includes("botA 卡事实"));
  assert.ok(!byAgent.text.includes("默认卡事实"));
  const strictNone = renderUserSettingsBlock({
    settings: settingsStub,
    config: { ...configOn, personaStrictAddressing: true },
    agentId: "botB", factsProvider: provider
  });
  assert.ok(!strictNone.text.includes("默认卡事实"), "strict 下没卡的 bot 不吃 default 事实");
  const loose = renderUserSettingsBlock({ settings: settingsStub, config: configOn, agentId: "botB", factsProvider: provider });
  assert.ok(loose.text.includes("默认卡事实"), "非 strict 落 default（与人格寻址同口径）");
  const resolved = resolveFactsCard(provider(), "botA", { strict: false });
  assert.equal(resolved.source, "byAgent");
});

test("开关关着：注入文本与「从没装配过事实」逐字节一致（关 = 零读数，provider 都不调）", () => {
  let reads = 0;
  const provider = () => { reads += 1; return { default: ["事实甲"], byAgent: {} }; };
  const off = renderUserSettingsBlock({
    settings: settingsStub, config: { ...configOn, profileFactsEnabled: false },
    agentId: null, factsProvider: provider
  });
  const never = renderUserSettingsBlock({ settings: settingsStub, config: { ...configOn, profileFactsEnabled: false }, agentId: null });
  assert.equal(off.text, never.text, "关着时输出必须与无 provider 时逐字节一致");
  assert.equal(reads, 0, "「关」是零读数：provider 一次都不该被调");
});

test("注入预算：40 行帽 + 尾注如实报数；事实里的 {{ }} 被转义（宿主模板插值的雷）", () => {
  const many = Array.from({ length: 50 }, (_, i) => `事实${i}`);
  const long = renderUserSettingsBlock({
    settings: settingsStub, config: configOn, agentId: null,
    factsProvider: () => ({ default: many, byAgent: {} })
  });
  assert.ok(long.text.includes("另有 10 条未注入"), "截断不静默");
  assert.ok(!long.text.includes("事实49\n- 规则"), "第 41 条之后不注入");
  const braces = renderUserSettingsBlock({
    settings: settingsStub, config: configOn, agentId: null,
    factsProvider: () => ({ default: ["模板 {{x}} 事实"], byAgent: {} })
  });
  assert.ok(!braces.text.includes("{{x}}"), "裸 {{ 必须被转义，否则宿主模板插值会整轮崩");
});

// ---- HTTP 面（GET /apply /run 三条路由） --------------------------------------

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.headers = null; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function httpReq(method, body = null, url = "/api/dsh-mneme/profile-facts") {
  const r = new EventEmitter();
  r.method = method;
  r.url = url;
  r.headers = {};
  if (body !== null) {
    process.nextTick(() => {
      r.emit("data", Buffer.from(JSON.stringify(body)));
      r.emit("end");
    });
  }
  return r;
}

function setupApi({ config = {}, facts = null, apiToken = "" } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register: (route) => { routes.push(route); return () => {}; } }, logger: { warn() {}, info() {}, error() {} } };
  createApi(ctx, service, settings, { add: () => {}, remove: () => {}, list: () => [] },
    undefined, undefined, apiToken, config, null, null, null, facts);
  const find = (p) => routes.find((r) => r.path === p);
  return { store, service, settings, routes, getRoute: find };
}

/** 真 facts 装配（带真 store），路由层用。 */
function realFacts({ config = {} } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const facts = createProfileFacts({
    ctx: { agentDefaultModel: { currentSelection: () => null } },
    service, store, config, logger: { warn() {}, info() {}, error() {} }
  });
  return { store, service, facts };
}

test("GET：无装配回 503；有装配回 cards/facts/journal/runs 四件，flag 关着也照读", async () => {
  const route = setupApi({ facts: null }).getRoute("/api/dsh-mneme/profile-facts");
  const res404 = new FakeRes();
  await route.handler(httpReq("GET"), res404);
  assert.equal(res404.statusCode, 503);

  const { store, facts } = realFacts();
  facts.applyManualOps("", [{ op: "add", content: "事实甲" }]);
  const { getRoute } = setupApi({ facts, config: {} });
  const res = new FakeRes();
  await getRoute("/api/dsh-mneme/profile-facts").handler(httpReq("GET", null, "/api/dsh-mneme/profile-facts"), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.cards.includes(""));
  assert.equal(body.facts.length, 1);
  assert.equal(body.journal.length, 1);
  assert.equal(body.runs.length, 0);
  store.close();
});

test("apply：405 / 400（空 ops 与非法 op）/ 200（applied+failures+回读 facts）", async () => {
  const { store, facts } = realFacts();
  const { getRoute } = setupApi({ facts });
  const route = getRoute("/api/dsh-mneme/profile-facts/apply");
  let res = new FakeRes();
  await route.handler(httpReq("GET", null, "/api/dsh-mneme/profile-facts/apply"), res);
  assert.equal(res.statusCode, 405);

  res = new FakeRes();
  await route.handler(httpReq("POST", { agent: "", ops: [] }, "/api/dsh-mneme/profile-facts/apply"), res);
  assert.equal(res.statusCode, 400);

  res = new FakeRes();
  await route.handler(httpReq("POST", { agent: "", ops: [{ op: "nuke" }] }, "/api/dsh-mneme/profile-facts/apply"), res);
  assert.equal(res.statusCode, 400, "非法 op 形状在路由层就拒，不进领域层");

  res = new FakeRes();
  await route.handler(httpReq("POST", { agent: "", ops: [{ op: "update", id: "x" }] }, "/api/dsh-mneme/profile-facts/apply"), res);
  assert.equal(res.statusCode, 400, "update 缺 content 在 400 闸就拒（评审 P1：会写成 undefined 正文）");

  res = new FakeRes();
  await route.handler(httpReq("POST", {
    agent: "",
    ops: [{ op: "add", content: "事实甲" }, { op: "update", id: "ghost", content: "x" }]
  }, "/api/dsh-mneme/profile-facts/apply"), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.applied, 1);
  assert.equal(body.failures.length, 1, "幽灵 id 如实回 failures，不冒充成功");
  assert.equal(body.facts.length, 1, "回读最新事实，面板不用二次 GET");
  store.close();
});

test("run：405 / 409（flag 关）/ noop 200；错误码映射 no-route→503、unparseable→502", async () => {
  const { store, facts } = realFacts();
  const { getRoute } = setupApi({ facts, config: { profileFactsEnabled: false } });
  let res = new FakeRes();
  await getRoute("/api/dsh-mneme/profile-facts/run").handler(httpReq("POST", { agent: "" }, "/api/dsh-mneme/profile-facts/run"), res);
  assert.equal(res.statusCode, 409);

  const { getRoute: getRoute2 } = setupApi({ facts, config: { profileFactsEnabled: true } });
  const run = getRoute2("/api/dsh-mneme/profile-facts/run");
  res = new FakeRes();
  await run.handler(httpReq("GET", null, "/api/dsh-mneme/profile-facts/run"), res);
  assert.equal(res.statusCode, 405, "run 无读分支，GET 必须被挡（policy token 的前提）");

  // noop 路径：种游标消费掉全部输入后 run 回 200 noop。
  const rows = store.listFactInputRows("", { since: null, limit: 10 });
  store.insertProfileFactRun({
    id: "seed", agentKey: "", triggerSource: "manual", status: "ok",
    cursor: "2999-12-31T00:00:00.000Z", inputCount: rows.length, opsApplied: 0,
    detail: null, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z"
  });
  res = new FakeRes();
  await run.handler(httpReq("POST", { agent: "" }, "/api/dsh-mneme/profile-facts/run"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, "noop");

  // 错误映射：把 facts.runFor 换成抛错的桩，逐 code 对状态码。
  for (const [code, status] of [["no-route", 503], ["unparseable", 502], ["stream-failed", 502]]) {
    const stub = { runFor: async () => { throw new ProfileFactsError(code, code); }, applyManualOps() {}, listFacts() { return []; }, listJournal() { return []; }, listRuns() { return []; }, cardKeys() { return [""]; }, factsProvider() { return { default: [], byAgent: {} }; } };
    const { getRoute: getRoute3 } = setupApi({ facts: stub, config: { profileFactsEnabled: true } });
    const r = new FakeRes();
    await getRoute3("/api/dsh-mneme/profile-facts/run").handler(httpReq("POST", { agent: "" }, "/api/dsh-mneme/profile-facts/run"), r);
    assert.equal(r.statusCode, status, `${code} 的状态码`);
    assert.equal(JSON.parse(r.body).error, code);
  }
  store.close();
});

test("run 的 policy 是 token：配了 token 又不带 token 的 POST 被挡在维护轮之前", async () => {
  const { store, facts } = realFacts();
  let called = 0;
  const stub = { ...facts, runFor: async () => { called += 1; return { status: "ok" }; } };
  const { getRoute } = setupApi({ facts: stub, config: { profileFactsEnabled: true }, apiToken: "sekret" });
  const res = new FakeRes();
  await getRoute("/api/dsh-mneme/profile-facts/run").handler(httpReq("POST", { agent: "" }, "/api/dsh-mneme/profile-facts/run"), res);
  assert.equal(res.statusCode, 401);
  assert.equal(called, 0, "鉴权必须在这次模型调用之前");
  store.close();
});

test("strict 寻址：事实一张身份卡都没建时仍落 default（#587 例外，与人格同口径）", () => {
  // 人格那张例外同样适用于事实：只建了别的身份卡、没这一张 → 不落 default（上面
  // 那条已锁）；一张都没建 → default 是唯一那份认知，不能因为开了严格寻址就丢掉。
  const onlyDefault = () => ({ default: ["默认卡事实"], byAgent: {} });
  const strictEmpty = renderUserSettingsBlock({
    settings: settingsStub,
    config: { ...configOn, personaStrictAddressing: true },
    agentId: "standard",
    factsProvider: onlyDefault
  });
  assert.ok(strictEmpty.text.includes("默认卡事实"), "byAgent 整体为空时严格寻址仍落 default 事实");
  assert.equal(resolveFactsCard(onlyDefault(), "standard", { strict: true }).source, "default");
  // 一旦建过任意一张身份卡，例外失效，严格语义恢复
  const withOne = () => ({ default: ["默认卡事实"], byAgent: { botA: ["botA 卡事实"] } });
  assert.equal(resolveFactsCard(withOne(), "standard", { strict: true }).source, "none");
  assert.equal(resolveFactsCard(withOne(), "botA", { strict: true }).source, "byAgent");
  // 关着的身份卡也算「建过」
  const closedOne = () => ({ default: ["默认卡事实"], byAgent: { botA: [] } });
  assert.equal(resolveFactsCard(closedOne(), "standard", { strict: true }).source, "none");
});
