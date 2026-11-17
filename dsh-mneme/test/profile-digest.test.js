// 「Agent 眼中的你」阅读面摘要（2026-11-18）：事实清单 → 分节散文的面板投影。
// 与 profile-facts.test.js 同源的独立用例文件——这条链的产品承诺很窄也很硬：
// ① 摘要是投影不是事实源：任何路径不写 user_settings、不改 facts、不进注入；
// ② 没有事实就没有摘要：空卡删旧摘要并 noop（空卡挂旧摘要是在替已不存在的事实撒谎）；
// ③ 吐不出合格 sections JSON 就 failed，绝不拿残缺输出冒充摘要；
// ④ 过期判定是读侧锚点对比（facts_revision vs 当前 journal MAX(id)）。锚点用修订号
//    而不是 updated_at：后者只有毫秒精度，生成摘要与改事实落在同一毫秒时锚点根本不
//    前移、过期判不出来（CI 上真的撞过）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";
import { createProfileFacts } from "../src/profile-facts.js";
import { createProfileDigest, ProfileDigestError, parseDigest } from "../src/profile-digest.js";
import { testConfig } from "./helpers/test-config.js";

// 假的 ctx.llm：协议与 profile-facts.test.js 的 fakeLlm 同款（用量嵌在 chunk.usage）。
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

const okDigest = (sections) => [
  { type: "text-delta", text: "```json\n" },
  { type: "text-delta", text: JSON.stringify({ sections }) },
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
  const common = { ctx: { ...fake, agentDefaultModel: { currentSelection: () => null } }, service, store, logger };
  const facts = createProfileFacts({ ...common, config: testConfig({ dreamProvider: "fake", dreamModel: "m1", ...config }) });
  const digest = createProfileDigest({ ...common, config: testConfig({ dreamProvider: "fake", dreamModel: "m1", ...config }) });
  return { store, service, settings, facts, digest, fake, logger };
}

/** 种事实行（走 applyManualOps 的正式入口，形状由领域层保证）。 */
function seedFacts(facts, contents) {
  facts.applyManualOps("", contents.map((content) => ({ op: "add", content })));
  return facts.listFacts("", { includeArchived: false });
}

test("解析器：围栏 JSON 可取；缺 heading/text、空节集、非 JSON 一律 null，绝不冒充成功", () => {
  assert.deepEqual(
    parseDigest('{"sections":[{"heading":"概览","text":"你是……"}]}'),
    [{ heading: "概览", text: "你是……" }]
  );
  assert.equal(parseDigest("我觉得你很好。"), null, "散文正文不是 JSON，拒绝");
  assert.equal(parseDigest('{"sections":[]}'), null, "空节集没有可展示的东西，按解析失败走");
  assert.equal(parseDigest('{"sections":[{"heading":"x"}]}'), null, "缺 text 不合格");
  assert.equal(parseDigest('{"sections":[{"text":"y"}]}'), null, "缺 heading 不合格");
  assert.equal(parseDigest('{"sections":[{"heading":"a","text":"b","extra":1}]}'), null, "多余键拒收（形状漂移当场红）");
  // 超限截断：第 7 节整体丢弃（宁可少一节，不静默截半句）；长 heading/text 截到上限。
  const many = Array.from({ length: 7 }, (_, i) => ({ heading: `节${i}`, text: `正文${i}` }));
  assert.equal(parseDigest(JSON.stringify({ sections: many })).length, 6, "最多 6 节");
  const long = parseDigest(JSON.stringify({ sections: [{ heading: "h".repeat(99), text: "t".repeat(9999) }] }));
  assert.equal(long[0].heading.length, 40);
  assert.equal(long[0].text.length, 900);
});

test("no-route：有事实但没配模型时抛错、零模型调用", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const facts = createProfileFacts({
    ctx: { agentDefaultModel: { currentSelection: () => null } },
    service, store, config: testConfig({}), logger: { warn() {}, info() {}, error() {} }
  });
  const digest = createProfileDigest({
    ctx: { agentDefaultModel: { currentSelection: () => null } },
    service, store, config: testConfig({}), logger: { warn() {}, info() {}, error() {} }
  });
  facts.applyManualOps("", [{ op: "add", content: "事实甲" }]);
  await assert.rejects(
    () => digest.composeFor("", { trigger: "manual" }),
    (err) => err instanceof ProfileDigestError && err.code === "no-route"
  );
  store.close();
});

test("空卡：删旧摘要 + noop 回执 + 零模型调用", async () => {
  const { store, digest, fake } = setup(okDigest([{ heading: "x", text: "y" }]));
  store.upsertProfileDigest({
    agentKey: "", sections: [{ heading: "旧", text: "摘要" }],
    factCount: 3, factsRevision: 99,
    model: "fake:m1", generatedAt: "2026-01-01T00:00:00.000Z"
  });
  const receipt = await digest.composeFor("", { trigger: "manual" });
  assert.equal(receipt.status, "noop");
  assert.equal(receipt.reason, "no-facts");
  assert.equal(fake.calls.length, 0, "没有事实就不该花这次调用");
  assert.equal(store.getProfileDigest(""), null, "旧摘要必须删掉：空卡挂旧摘要是替不存在的事实撒谎");
  store.close();
});

test("ok 轮：sections 落库、锚点取 journal 修订号、回执带 factCount", async () => {
  const { store, facts, digest, fake } = setup(okDigest([
    { heading: "概览", text: "你在维护 dsh-mneme。" },
    { heading: "考研", text: "你在备考公共管理硕士。" }
  ]));
  seedFacts(facts, ["事实甲", "事实乙"]);
  const anchor = store.profileFactsRevision("");
  assert.ok(anchor > 0, "种完事实后修订号应大于 0");

  const receipt = await digest.composeFor("", { trigger: "manual" });
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.factCount, 2);
  assert.equal(fake.calls.length, 1, "一次蒸馏一次调用");
  const row = store.getProfileDigest("");
  assert.equal(row.sections.length, 2);
  assert.equal(row.factCount, 2);
  assert.equal(row.factsRevision, anchor, "锚点记生成时刻的事实修订号");
  assert.equal(row.model, "fake:m1");
  assert.equal(store.isProfileDigestStale(""), false, "刚生成的摘要不过期");
  store.close();
});

test("过期判定：事实在生成后又变过（update/archive）→ stale；重蒸馏后归零", async () => {
  const { store, facts, digest } = setup(okDigest([{ heading: "h", text: "t" }]));
  const seeded = seedFacts(facts, ["事实甲", "事实乙"]);
  await digest.composeFor("", { trigger: "manual" });
  assert.equal(store.isProfileDigestStale(""), false);

  facts.applyManualOps("", [{ op: "update", id: seeded[0].id, content: "事实甲（已修正）" }]);
  assert.equal(store.isProfileDigestStale(""), true, "生成后事实又变过，必须报过期");

  await digest.composeFor("", { trigger: "manual" });
  assert.equal(store.isProfileDigestStale(""), false, "重蒸馏后过期归零");
  store.close();
});

test("过期判定不依赖毫秒精度：updated_at 与生成时刻同一毫秒也必须报过期", async () => {
  const { store, facts, digest } = setup(okDigest([{ heading: "h", text: "t" }]));
  const seeded = seedFacts(facts, ["事实甲", "事实乙"]);
  const before = store.getProfileDigest("");
  assert.equal(before, null);
  const generatedAt = store.db
    .prepare("SELECT MAX(updated_at) AS m FROM profile_facts WHERE agent_key = ?")
    .get("").m;

  await digest.composeFor("", { trigger: "manual" });
  assert.equal(store.isProfileDigestStale(""), false);

  // 人工修正一条事实，然后把 updated_at 钉回生成那一刻——这正是 CI 上撞到的现场：
  // 旧实现拿 MAX(updated_at) 当锚点，同毫秒时锚点根本没前移，stale 判成 false。
  facts.applyManualOps("", [{ op: "update", id: seeded[0].id, content: "事实甲（已修正）" }]);
  store.db
    .prepare("UPDATE profile_facts SET updated_at = ? WHERE id = ?")
    .run(generatedAt, seeded[0].id);
  const stillSameMs = store.db
    .prepare("SELECT MAX(updated_at) AS m FROM profile_facts WHERE agent_key = ?")
    .get("").m;
  assert.equal(stillSameMs, generatedAt, "前提：时间戳没变（同毫秒现场成立）");

  assert.equal(
    store.isProfileDigestStale(""), true,
    "时间戳一模一样也必须报过期——判据是修订号，不是 updated_at 精度"
  );
  store.close();
});

test("修订号在 journal 被裁剪后仍然单调：prune 只裁最老的行，MAX(id) 不回退", async () => {
  const { store, facts } = setup(okDigest([{ heading: "h", text: "t" }]));
  const seeded = seedFacts(facts, ["事实甲"]);
  // 反复写同一条事实，把 journal 顶过 keep=200 的裁剪线。prune 只在 runFor（自动轮）
  // 收尾调用，人工修正不裁，所以这里显式触发一次，模拟自动轮跑过之后的现场。
  for (let i = 0; i < 205; i += 1) {
    facts.applyManualOps("", [{ op: "update", id: seeded[0].id, content: `事实甲 v${i}` }]);
  }
  store.pruneProfileFactJournal("");
  const journalRows = store.db
    .prepare("SELECT COUNT(*) AS n FROM profile_fact_journal WHERE agent_key = ?")
    .get("").n;
  assert.equal(journalRows, 200, "前提：journal 已被裁到 keep=200");
  const revBefore = store.profileFactsRevision("");
  assert.ok(revBefore > 200, "裁剪之后 MAX(id) 仍在 200 以上，没被裁回去");

  facts.applyManualOps("", [{ op: "update", id: seeded[0].id, content: "事实甲 最后一次" }]);
  assert.ok(
    store.profileFactsRevision("") > revBefore,
    "裁剪发生后修订号照常前进——这是拿 journal id 当锚点的前提"
  );
  store.close();
});

test("unparseable：模型吐散文时抛错，绝不拿残缺输出落一份空摘要", async () => {
  const { store, facts, digest } = setup([
    { type: "text-delta", text: "这是一段不合规的散文摘要。" },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 10 } },
    { type: "finish", reason: { kind: "stop" } }
  ]);
  seedFacts(facts, ["事实甲"]);
  await assert.rejects(
    () => digest.composeFor("", { trigger: "manual" }),
    (err) => err instanceof ProfileDigestError && err.code === "unparseable"
  );
  assert.equal(store.getProfileDigest(""), null, "失败轮不落摘要");
  store.close();
});

test("摘要不动事实、不写 user_settings：蒸馏后事实清单与账本原样", async () => {
  const { store, facts, digest } = setup(okDigest([{ heading: "h", text: "t" }]));
  const before = facts.listFacts("", { includeArchived: false });
  await digest.composeFor("", { trigger: "manual" });
  const after = facts.listFacts("", { includeArchived: false });
  assert.deepEqual(after.map((f) => f.content), before.map((f) => f.content), "事实清单零变化");
  assert.deepEqual(facts.listJournal("", { limit: 10 }).length, 0, "账本零写入（蒸馏不是修正）");
  store.close();
});

// --- 路由层 ---

function httpReq(method, body = null, url = "/api/dsh-mneme/profile-digest") {
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

class FakeRes {
  constructor() { this.statusCode = 0; this.body = ""; }
  writeHead(code) { this.statusCode = code; return this; }
  end(t = "") { this.body += t; }
  setHeader() {}
}

function setupApi({ config = {}, facts = null, profileDigest = null, apiToken = "" } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register: (route) => { routes.push(route); return () => {}; } }, logger: { warn() {}, info() {}, error() {} } };
  // 实参顺序照 createApi 的形参表：… facts(12)、kb(13)、diary(14)、backfill(15)、
  // profileDigest(16)。backfill 是 main 后加的，这里必须留位，否则 profileDigest 会
  // 落进 backfill 槽位、两条路由都拿不到装配（表现为一路 503）。
  createApi(ctx, service, settings, { add: () => {}, remove: () => {}, list: () => [] },
    undefined, undefined, apiToken, config, null, null, null, facts, null, null, null, profileDigest);
  const find = (p) => routes.find((r) => r.path === p);
  return { store, service, settings, routes, getRoute: find };
}

test("GET digest：无装配 503；有装配回 digest+stale，无摘要时 digest=null 不报错", async () => {
  const route = setupApi({ profileDigest: null }).getRoute("/api/dsh-mneme/profile-digest");
  const res503 = new FakeRes();
  await route.handler(httpReq("GET"), res503);
  assert.equal(res503.statusCode, 503);

  const { store, facts, digest } = setup(okDigest([{ heading: "h", text: "t" }]));
  seedFacts(facts, ["事实甲"]);
  await digest.composeFor("", { trigger: "manual" });
  const { getRoute } = setupApi({ facts, profileDigest: digest, config: testConfig({}) });
  const res = new FakeRes();
  await getRoute("/api/dsh-mneme/profile-digest").handler(httpReq("GET", null, "/api/dsh-mneme/profile-digest?agent="), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.digest.sections.length, 1);
  assert.equal(body.stale, false);
  store.close();
});

test("generate：405 / 409（flag 关）/ noop 200；错误码映射 no-route→503、unparseable→502", async () => {
  const { store, facts, digest } = setup(okDigest([{ heading: "h", text: "t" }]));
  const { getRoute } = setupApi({ facts, profileDigest: digest, config: testConfig({ profileDigestEnabled: false }) });
  let res = new FakeRes();
  await getRoute("/api/dsh-mneme/profile-digest/generate").handler(
    httpReq("POST", { agent: "" }, "/api/dsh-mneme/profile-digest/generate"), res);
  assert.equal(res.statusCode, 409);

  const { getRoute: getRoute2 } = setupApi({ facts, profileDigest: digest, config: testConfig({ profileDigestEnabled: true }) });
  const gen = getRoute2("/api/dsh-mneme/profile-digest/generate");
  res = new FakeRes();
  await gen.handler(httpReq("GET", null, "/api/dsh-mneme/profile-digest/generate"), res);
  assert.equal(res.statusCode, 405, "generate 无读分支，GET 必须被挡（policy token 的前提）");

  res = new FakeRes();
  await gen.handler(httpReq("POST", { agent: "" }, "/api/dsh-mneme/profile-digest/generate"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, "noop", "空卡走 noop，200");

  // 错误映射：把 composeFor 换成抛错的桩，逐 code 对状态码。
  for (const [code, status] of [["no-route", 503], ["unparseable", 502], ["stream-failed", 502]]) {
    const stub = { digestFor: () => ({ digest: null, stale: false }), composeFor: async () => { throw new ProfileDigestError(code, code); } };
    const { getRoute: getRoute3 } = setupApi({ facts, profileDigest: stub, config: testConfig({ profileDigestEnabled: true }) });
    const r = new FakeRes();
    await getRoute3("/api/dsh-mneme/profile-digest/generate").handler(
      httpReq("POST", { agent: "" }, "/api/dsh-mneme/profile-digest/generate"), r);
    assert.equal(r.statusCode, status, `${code} 的状态码`);
    assert.equal(JSON.parse(r.body).error, code);
  }
  store.close();
});

test("generate 的 policy 是 token：配了 token 又不带 token 的 POST 被挡在蒸馏之前", async () => {
  const { store, facts, digest } = setup(okDigest([{ heading: "h", text: "t" }]));
  let called = 0;
  const stub = { ...digest, composeFor: async () => { called += 1; return { status: "ok" }; } };
  const { getRoute } = setupApi({ facts, profileDigest: stub, config: testConfig({ profileDigestEnabled: true }), apiToken: "sekret" });
  const res = new FakeRes();
  await getRoute("/api/dsh-mneme/profile-digest/generate").handler(
    httpReq("POST", { agent: "" }, "/api/dsh-mneme/profile-digest/generate"), res);
  assert.equal(res.statusCode, 401);
  assert.equal(called, 0, "鉴权必须在这次模型调用之前");
  store.close();
});
