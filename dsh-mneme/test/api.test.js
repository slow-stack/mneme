import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { createVectorIndex } from "../src/vector-index.js";
import { Config } from "../src/config.js";
import { parseHumanEdits } from "../src/mirror.js";

// 解析后的 schema 默认值，作为 /features effective 的 bundle 配置侧样本。
const FLAGS_CFG = Config({});

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path, method = "GET", body = null) {
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = {};
  if (body !== null) {
    process.nextTick(() => {
      r.emit("data", Buffer.from(JSON.stringify(body)));
      r.emit("end");
    });
  }
  return r;
}

function setup(embedder, apiToken = "", config = null, semantic = undefined) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = {
    add: (def) => settings.addCommand(def),
    remove: (id) => settings.removeCommand(id),
    list: () => settings.listCommands()
  };
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };
  const api = createApi(ctx, service, settings, commands, embedder, semantic, apiToken, config);
  return { store, service, routes, api, settings, apiToken };
}

function findHandler(routes, path) {
  const route = routes.find((r) => r.path === path || (r.kind === "prefix" && path.startsWith(r.path)));
  return route;
}

test("registers list, search, and get prefix routes", () => {
  const { routes } = setup();
  const paths = routes.map((r) => r.path);
  assert.ok(paths.includes("/api/dsh-mneme/list"));
  assert.ok(paths.includes("/api/dsh-mneme/search"));
  assert.ok(paths.includes("/api/dsh-mneme"));
});

test("GET /api/dsh-mneme/list returns memories as JSON", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?type=preference"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].title, "语言");
});

test("GET /api/dsh-mneme/search?q= returns matches", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "SQLite 中文搜索" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/search");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/search?q=%E4%B8%AD%E6%96%87"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
});

test("unknown route under prefix returns 404 json", async () => {
  const { routes } = setup();
  const route = findHandler(routes, "/api/dsh-mneme");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/nope"), res);
  assert.equal(res.statusCode, 404);
});

test("list total excludes forgotten entries", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "正常", content: "可见" });
  const forgotten = service.saveWithDedupe({ type: "preference", title: "遗忘", content: "隐藏" });
  service.saveWithDedupe({ type: "project", title: "项目", content: "其他类型" });
  service.setForget(forgotten.memory.id, true);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?type=preference"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
  assert.equal(data.total, 1, "total matches visible items, forgotten excluded");
});

test("list honors limit/offset", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "a", content: "1" });
  service.saveWithDedupe({ type: "preference", title: "b", content: "2" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?limit=1&offset=0"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
  assert.equal(data.total, 2);
});

test("responses carry application/json content-type", async () => {
  const { routes } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list"), res);
  assert.match(res.headers["Content-Type"], /application\/json/);
});

test("handler errors return 500 json instead of leaking to host", async () => {
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };
  const service = {
    list() { throw new Error("boom"); },
    count() { throw new Error("boom"); },
    search() { throw new Error("boom"); },
    toApiList() { return []; }
  };
  createApi(ctx, service, {}, { add: () => { throw new Error("x"); }, remove: () => false, list: () => [] });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list"), res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: "internal" });
});

test("GET /api/dsh-mneme/profile returns stored profile", async () => {
  const { routes, settings } = setup();
  settings.setProfile("我是前端");
  const route = routes.find((r) => r.path === "/api/dsh-mneme/profile");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/profile"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).profile, "我是前端");
});

test("PUT /api/dsh-mneme/profile saves profile", async () => {
  const { routes, settings } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/profile");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/profile", "PUT", { profile: "新画像" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).profile, "新画像");
  assert.equal(settings.getProfile(), "新画像");
});

test("GET /api/dsh-mneme/rules returns stored rules", async () => {
  const { routes, settings } = setup();
  settings.setRules(["规则1", "规则2"]);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/rules");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/rules"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).rules, ["规则1", "规则2"]);
});

test("PUT /api/dsh-mneme/rules saves rules", async () => {
  const { routes, settings } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/rules");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/rules", "PUT", { rules: ["a", "b"] }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(settings.getRules(), ["a", "b"]);
});

// --- panel mode (light/standard) ---

test("GET /api/dsh-mneme/mode defaults to standard", async () => {
  const { routes } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/mode");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/mode"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { mode: "standard" });
});

test("PUT /api/dsh-mneme/mode validates the enum and persists", async () => {
  const { routes, settings } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/mode");

  const put = new FakeRes();
  await route.handler(req("/api/dsh-mneme/mode", "PUT", { mode: "light" }), put);
  assert.equal(put.statusCode, 200);
  assert.deepEqual(JSON.parse(put.body), { mode: "light" });
  assert.equal(settings.getPanelMode(), "light");

  const back = new FakeRes();
  await route.handler(req("/api/dsh-mneme/mode", "PUT", { mode: "standard" }), back);
  assert.deepEqual(JSON.parse(back.body), { mode: "standard" });

  const bad = new FakeRes();
  await route.handler(req("/api/dsh-mneme/mode", "PUT", { mode: "turbo" }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(settings.getPanelMode(), "standard", "invalid value not persisted");
});

test("PUT /api/dsh-mneme/mode is token-gated like other settings writes", async () => {
  const { routes } = setup(undefined, "secret-token");
  const route = routes.find((r) => r.path === "/api/dsh-mneme/mode");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/mode", "PUT", { mode: "light" }), res);
  assert.equal(res.statusCode, 401);
  const ok = new FakeRes();
  const authed = req("/api/dsh-mneme/mode", "PUT", { mode: "light" });
  authed.headers = { authorization: "Bearer secret-token" };
  await route.handler(authed, ok);
  assert.equal(ok.statusCode, 200);
});

test("GET /api/dsh-mneme/commands lists commands", async () => {
  const { routes, settings } = setup();
  settings.addCommand({ name: "agenda", instruction: "x" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/commands");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/commands"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).commands.length, 1);
});

test("POST /api/dsh-mneme/commands adds a command; DELETE removes", async () => {
  const { routes } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/commands");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/commands", "POST", { name: "fmt", description: "d", instruction: "格式化" }), res);
  assert.equal(res.statusCode, 200);
  const { command } = JSON.parse(res.body);
  assert.equal(command.name, "fmt");
  const del = new FakeRes();
  await route.handler(req(`/api/dsh-mneme/commands?id=${command.id}`, "DELETE"), del);
  assert.equal(JSON.parse(del.body).removed, true);
});

test("POST /api/dsh-mneme/commands rejects invalid name with 400", async () => {
  const { routes } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/commands");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/commands", "POST", { name: "Bad Name", instruction: "x" }), res);
  assert.equal(res.statusCode, 400);
});

// --- vector search routes ---

function setupWithEmbedder(embedder) {
  const base = setup(embedder);
  base.settings.setVectorConfig({
    enabled: true,
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "text-embedding-v3"
  });
  return base;
}

test("vector-config defaults and round-trips through PUT/GET", async () => {
  const { routes, settings } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/vector-config");

  const get1 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config"), get1);
  assert.equal(JSON.parse(get1.body).config.enabled, false);

  const put = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config", "PUT", { enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "sk-x", model: "text-embedding-3-small" }), put);
  assert.equal(JSON.parse(put.body).config.model, "text-embedding-3-small");
  assert.equal(settings.getVectorConfig().enabled, true);
});

test("search mode=vector merges vector results when embedder returns a vector", async () => {
  const embedder = {
    embed: async () => [1, 0, 0],
    reindexMissing: async () => ({ indexed: 0, skipped: 0 })
  };
  const { routes, store, service } = setupWithEmbedder(embedder);
  const v = service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫" });
  store.setEmbedding(v.memory.id, [1, 0, 0]);
  service.saveWithDedupe({ type: "preference", title: "狗", content: "喜欢狗" });

  const route = routes.find((r) => r.path === "/api/dsh-mneme/search");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/search?q=%E7%8C%AB&mode=vector"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.mode, "vector");
  assert.equal(data.items.length, 1, "keyword hit + vector fill merged");
  assert.equal(data.items[0].title, "猫");
});

test("search falls back to keyword when embedder disabled or unavailable", async () => {
  // embedder that resolves null (disabled provider)
  const embedder = { embed: async () => null, reindexMissing: async () => ({ indexed: 0, skipped: 0 }) };
  const { routes, service } = setupWithEmbedder(embedder);
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文交流" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/search");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/search?q=%E4%B8%AD%E6%96%87"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.mode, "keyword");
  assert.equal(data.items.length, 1);
});

test("vector-reindex calls embedder and returns counts", async () => {
  const embedder = { reindexMissing: async () => ({ indexed: 2, skipped: 1 }) };
  const { routes } = setupWithEmbedder(embedder);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/vector-reindex");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-reindex"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.indexed, 2);
  assert.equal(data.skipped, 1);
});

test("vector-config masks apiKey; empty/masked key on PUT keeps existing", async () => {
  const { routes, settings } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/vector-config");

  // PUT stores the real key but responds masked
  const put = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config", "PUT", {
    enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "sk-abcdefghijklmnop", model: "m1"
  }), put);
  const putBody = JSON.parse(put.body);
  assert.equal(putBody.config.apiKey, "sk-***mnop", "PUT response masked");
  assert.equal(settings.getVectorConfig().apiKey, "sk-abcdefghijklmnop", "storage keeps the real key");

  // GET returns masked key, other fields intact
  const get = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config"), get);
  const getBody = JSON.parse(get.body);
  assert.equal(getBody.config.apiKey, "sk-***mnop");
  assert.equal(getBody.config.baseUrl, "https://api.openai.com/v1");
  assert.equal(getBody.config.enabled, true);

  // PUT with empty apiKey keeps the previous key
  const put2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config", "PUT", {
    enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "", model: "m2"
  }), put2);
  assert.equal(settings.getVectorConfig().apiKey, "sk-abcdefghijklmnop", "empty key keeps existing");
  assert.equal(JSON.parse(put2.body).config.model, "m2");

  // PUT with a masked apiKey (client round-trip) also keeps the previous key
  const put3 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config", "PUT", {
    enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "sk-***mnop", model: "m3"
  }), put3);
  assert.equal(settings.getVectorConfig().apiKey, "sk-abcdefghijklmnop", "masked key keeps existing");
});

test("apiToken protects write/secret endpoints while read endpoints stay open", async () => {
  const { routes } = setup(undefined, "secret-token");
  const list = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const profile = routes.find((r) => r.path === "/api/dsh-mneme/profile");
  const vec = routes.find((r) => r.path === "/api/dsh-mneme/vector-config");
  const reindex = routes.find((r) => r.path === "/api/dsh-mneme/vector-reindex");

  // read-only endpoint stays open without a token
  const resList = new FakeRes();
  await list.handler(req("/api/dsh-mneme/list"), resList);
  assert.equal(resList.statusCode, 200, "list stays open");

  // secret endpoint without token → 401
  const resVec = new FakeRes();
  await vec.handler(req("/api/dsh-mneme/vector-config"), resVec);
  assert.equal(resVec.statusCode, 401, "vector-config GET requires token");

  // write endpoint without token → 401
  const resProfile = new FakeRes();
  await profile.handler(req("/api/dsh-mneme/profile", "PUT", { profile: "x" }), resProfile);
  assert.equal(resProfile.statusCode, 401, "profile PUT requires token");

  // reindex without token → 401
  const resReindex = new FakeRes();
  await reindex.handler(req("/api/dsh-mneme/vector-reindex"), resReindex);
  assert.equal(resReindex.statusCode, 401, "vector-reindex requires token");

  // with a Bearer token everything is allowed
  const authReq = (path, method = "GET", body = null) => {
    const r = req(path, method, body);
    r.headers = { authorization: "Bearer secret-token" };
    return r;
  };
  const resVecOk = new FakeRes();
  await vec.handler(authReq("/api/dsh-mneme/vector-config"), resVecOk);
  assert.equal(resVecOk.statusCode, 200, "vector-config GET with token");
  const resProfileOk = new FakeRes();
  await profile.handler(authReq("/api/dsh-mneme/profile", "PUT", { profile: "hi" }), resProfileOk);
  assert.equal(resProfileOk.statusCode, 200, "profile PUT with token");

  // wrong token → 401
  const bad = req("/api/dsh-mneme/vector-config");
  bad.headers = { authorization: "Bearer wrong" };
  const resBad = new FakeRes();
  await vec.handler(bad, resBad);
  assert.equal(resBad.statusCode, 401, "wrong token rejected");
});

test("no apiToken configured keeps all endpoints open", async () => {
  const { routes } = setup();
  const vec = routes.find((r) => r.path === "/api/dsh-mneme/vector-config");
  const res = new FakeRes();
  await vec.handler(req("/api/dsh-mneme/vector-config"), res);
  assert.equal(res.statusCode, 200, "open when apiToken is unset");
});

// --- #118: /semantic exposes embedder readiness for the status card ----------

test("GET /api/dsh-mneme/semantic reports ready state per embedder", async () => {
  const fetchSem = async (embedder) => {
    const { routes } = setup(embedder);
    const sem = routes.find((r) => r.path === "/api/dsh-mneme/semantic");
    const res = new FakeRes();
    await sem.handler(req("/api/dsh-mneme/semantic"), res);
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.body);
  };
  // no embedder → everything null
  assert.equal((await fetchSem(undefined)).embedProvider, null);
  assert.equal((await fetchSem(undefined)).ready, null, "no embedder → ready null");

  // Ollama-style embedder mid-init (ready:false) → ready false
  class OllamaEmbedder { constructor() { this.ready = false; } }
  const mid = await fetchSem(new OllamaEmbedder());
  assert.equal(mid.embedProvider, "OllamaEmbedder");
  assert.equal(mid.ready, false, "not-yet-ready embedder → ready false");

  // ready after init
  const ready = new OllamaEmbedder(); ready.ready = true;
  assert.equal((await fetchSem(ready)).ready, true);

  // legacy OpenAI embedder has no `ready` prop → treated as ready
  assert.equal((await fetchSem({ embed() {} })).ready, true, "no ready prop → assumed ready");

  // legacy embedder carries an explicit display name (constructor.name of a
  // literal is "Object", which the status card must not render verbatim)
  const named = await fetchSem({ name: "OpenAI", embed() {} });
  assert.equal(named.embedProvider, "OpenAI", "explicit name beats constructor.name");
  assert.equal(named.ready, true);
});

// --- #135: /semantic must tell "not configured" apart from "degraded" ---------

test("GET /api/dsh-mneme/semantic reports configured/coverage/degraded", async () => {
  const fetchSem = async (embedder, semantic) => {
    const { routes } = setup(embedder, "", null, semantic);
    const sem = routes.find((r) => r.path === "/api/dsh-mneme/semantic");
    const res = new FakeRes();
    await sem.handler(req("/api/dsh-mneme/semantic"), res);
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.body);
  };
  // Stats double: `total` is the memory count, `embedded` the indexed count.
  const index = (embeddedCount, totalCount) => ({
    vectorIndex: { getStats: () => ({ embeddedCount, totalCount }) }
  });
  const openai = (ready, configured) => ({
    name: "OpenAI",
    get ready() { return ready; },
    get configured() { return configured; },
    embed() {}
  });

  // No embedder at all → everything reports absence, not a false green.
  const none = await fetchSem(undefined, index(0, 0));
  assert.equal(none.configured, null);
  assert.equal(none.reason, "no-embedder");
  assert.equal(none.degraded, false);
  assert.deepEqual(none.coverage, { embedded: 0, total: 0, ratio: null },
    "empty store → ratio null (0 would read as 'nothing embedded')");

  // Configured embedder still initializing: unreachable ≠ unconfigured.
  assert.equal((await fetchSem(openai(false, true), index(0, 346))).reason, "initializing");

  // Never configured: reported as such even though the index has memories.
  const unconfigured = await fetchSem(openai(false, false), index(0, 346));
  assert.equal(unconfigured.ready, false);
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.reason, "not-configured");
  assert.equal(unconfigured.degraded, false, "unconfigured was never meant to index");
  assert.equal(unconfigured.coverage.ratio, 0);

  // Configured, memories present, zero vectors — the state this machine sat in
  // for weeks while the card showed a healthy provider.
  const degraded = await fetchSem(openai(true, true), index(0, 346));
  assert.equal(degraded.reason, null, "a complete config has no abnormal reason");
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.coverage.ratio, 0);

  // Healthy index.
  const ok = await fetchSem(openai(true, true), index(173, 346));
  assert.equal(ok.degraded, false);
  assert.equal(ok.coverage.ratio, 0.5);

  // Adapters without a `configured` field (third-party/test doubles) keep the
  // old contract: assumed configured, `ready` decides.
  const legacy = await fetchSem({ embed() {} }, index(5, 10));
  assert.equal(legacy.configured, true);
  assert.equal(legacy.reason, null);
  assert.equal(legacy.ready, true);

  // No stats provider (no vector index) must not throw — coverage falls back
  // to zeros and an empty store is never "degraded".
  const noIndex = await fetchSem(openai(true, true), null);
  assert.deepEqual(noIndex.coverage, { embedded: 0, total: 0, ratio: null });
  assert.equal(noIndex.degraded, false);
});

// --- Bug8: llm-audit API (pagination + stats) --------------------------------

test("GET /api/dsh-mneme/semantic/llm-audit returns paginated rows", async () => {
  const { routes, service } = setup();
  for (let i = 0; i < 5; i++) {
    service.saveLlmAudit({ trigger_source: "autoDream", operation_type: "dream_consolidate", model_id: "m1", input_tokens: 10, output_tokens: 5, status: "success", related_memory_ids: [] });
  }
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/llm-audit");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit?page=2&pageSize=2"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.total, 5);
  assert.equal(data.page, 2);
  assert.equal(data.pageSize, 2);
  assert.equal(data.items.length, 2, "second page of 2");
});

test("GET /api/dsh-mneme/semantic/llm-audit filters by source", async () => {
  const { routes, service } = setup();
  service.saveLlmAudit({ trigger_source: "autoDream", operation_type: "dream_consolidate", model_id: "m1", status: "success" });
  service.saveLlmAudit({ trigger_source: "autoSummarize", operation_type: "summarize_compress", model_id: "m2", status: "success" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/llm-audit");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit?source=autoSummarize"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.total, 1);
  assert.equal(data.items[0].operation_type, "summarize_compress");
});

test("GET /api/dsh-mneme/semantic/llm-audit/stats aggregates tokens by source and status", async () => {
  const { routes, service } = setup();
  service.saveLlmAudit({
    trigger_source: "autoDream", operation_type: "dream_consolidate", model_id: "m1",
    input_tokens: 100, output_tokens: 50, total_tokens: 150, duration_ms: 12, status: "success", related_memory_ids: []
  });
  service.saveLlmAudit({
    trigger_source: "autoSummarize", operation_type: "summarize_compress", model_id: "m2",
    input_tokens: 20, output_tokens: 10, total_tokens: 30, duration_ms: 5, status: "error", error_message: "boom", related_memory_ids: []
  });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/llm-audit/stats");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit/stats?days=7"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.total_calls, 2);
  assert.equal(data.input_tokens, 120);
  assert.equal(data.output_tokens, 60);
  assert.equal(data.total_tokens, 180);
  assert.equal(data.total_duration_ms, 17);
  assert.ok(data.by_source.some((s) => s.source === "autoDream" && s.total_tokens === 150), "autoDream aggregate present");
  assert.ok(data.by_status.some((s) => s.status === "error" && s.c === 1), "error status counted");
});

// --- issue #10: vector-reindex with an embed-only OpenAI-compatible embedder --

test("Bug10: vector-reindex with an embed-only OpenAI-compatible embedder returns the real count and records the model fingerprint", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const vectorIndex = createVectorIndex({ store });
  const embedder = {
    embed: async (text) => [0.1, 0.2, 0.3], // OpenAI-compatible single-text embed
    modelHash: "text-embedding-3#abc",
    dimension: 3
  };
  // A pre-index row written before the embedder is attached (so it still has no vector).
  service.saveWithDedupe({ type: "project", title: "待回填", content: "缺少向量的存量记忆" });
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, { add() {}, remove() {}, list() { return []; } }, embedder, { vectorIndex }, "");
  const route = routes.find((r) => r.path === "/api/dsh-mneme/vector-reindex");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-reindex"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.indexed, 1, "actual indexed count, not 0");
  assert.equal(data.skipped, 0);
  assert.equal(vectorIndex.modelHash(), "text-embedding-3#abc", "model_hash written to vector_meta");
  assert.equal(vectorIndex.dimension(), 3, "dimension written to vector_meta");
  assert.equal(vectorIndex.getEmbedding(service.all()[0].id).length, 3, "embedding persisted");
});

// --- /info（反馈预填的插件版本）-----------------------------------------------

test("GET /api/dsh-mneme/info returns the package version for feedback prefills", async () => {
  const { routes } = setup(undefined);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/info");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/info"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  // 与插件根 package.json 的版本一致（反馈 issue/邮件的预填环境信息依赖它）。
  const expected = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(data.version, expected);
});

// --- feature flags（/features：overrides + effective）------------------------

test("GET /api/dsh-mneme/features returns empty overrides and effective config defaults", async () => {
  const { routes } = setup(undefined, "", FLAGS_CFG);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/features");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.deepEqual(data.overrides, {});
  // effective 覆盖全部 52 个白名单键（含 v0.7.20 heatEnabled、Issue #89 新增
  // dreamSkipInvalid/allowCrossTypeMerge/dreamMinIntervalMinutes、面板可调的
  // dreamMaxTokens、睡眠路由 sleepProvider/sleepModel、PR1 新增的
  // recallFusion/signalTransparency、issue #109 新增的实体抽取路由
  // entityExtractionProvider/entityExtractionModel/entityExtractionReasoning、
  // issue #127 新增的 summarize 五键、issue #126 新增的 sleepActionSet，
  // 以及 issue #125 新增的候选集三键、issue #17（v0.8.0 A1/A3）新增的
  // scopeEnabled/strictScope、issue #194 新增的 resilientModelDownload），
  // 未覆盖时取 bundle 配置的解析默认值；
  // dreamProvider/dreamModel 无 schema 默认值（Config({}) 解析为 undefined），
  // 不编造给前端 → 62 - 2 = 60（issue #164① 新增 injectContentMaxChars，
  // issue #164 叙述条批次新增 dreamNarrativeEnabled/dreamNarrativeMinCluster，
  // issue #239 新增 summarizeMinWindowChars/summarizeMaxRunsPerSession、
  // 第 4 项的 summarizePeakHours/summarizePeakMaxDeferMinutes 与
  // 第 5 项的 injectUncertaintyAdaptive、
  // issue #257 新增 sleepMaxTokens、issue #258 新增总览路由两键与
  // dreamSummaryMaxInputs、issue #230 新增 documentMemoryEnabled/
  // documentInjectBudget、issue #249 第一批新增 injectGuidanceEnabled/
  // pinnedInjectBudget、issue #249 N3 新增 continuityRescueEnabled，
  // v0.8.5 新增 disableMemorySearch/disableMemoryArchive，
  // 本地嵌入池化新增 localEmbedPooling，issue #315 新增 summarizeReasoningEffort，
  // issue #239 第 4 项镜像到巩固新增 dreamPeakHours/dreamPeakMaxDeferMinutes，
  // issue #292 新增 autoDreamFailureBackoff、
  // issue #254 新增 writeAdmission.enabled/writeAdmission.enforce，
  // issue #34 恢复（#333）新增 injectTimePrefix、
  // issue #24 块1 新增 graphAnchoringEnabled/graphSeedCap/graphCascadeDepth、
  // 块2 新增 graphWeightEnabled/graphWeightDelta、块3 新增 graphInjectHint/graphInjectBudget、
  // 块4 新增 graphPassiveConfirm、
  // issue #339 新增 dreamMergeGuard、
  // issue #218/E5 新增 injectHeatEnabled、
  // issue #164 A2 新增 sensitiveScanEnabled（顶层扁平键，走 configFlagValue 默认分支）、
  // issue #380 新增 preInjectGate.enabled/preInjectGate.enforce（点号键，+2））
  assert.equal(Object.keys(data.effective).length, 59 + 3 + 2 + 1 + 2 + 2 + 2 + 1 + 1 + 1 + 2 + 1 + 2 + 1 + 3 + 2 + 2 + 1 + 1 + 1 + 1 + 2);
  assert.equal(data.effective["preInjectGate.enabled"], false);
  assert.equal(data.effective["preInjectGate.enforce"], false);
  assert.equal(data.effective.dreamSkipInvalid, true);
  assert.equal(data.effective.allowCrossTypeMerge, false);
  assert.equal(data.effective.dreamMergeGuard, true);
  assert.equal(data.effective.injectHeatEnabled, false);
  assert.equal(data.effective.dreamMinIntervalMinutes, 0);
  assert.equal(data.effective.autoDreamFailureBackoff, false);
  assert.equal(data.effective.dreamMaxTokens, 131072);
  assert.equal(data.effective.sleepProvider, "");
  assert.equal(data.effective.sleepModel, "");
  assert.equal(data.effective.autoInject, true);
  assert.equal(data.effective.codingRetrospect, false);
  assert.equal(data.effective.distillMaxChars, 24000);
  assert.equal(data.effective.codingBoostFactor, 2);
  // 新增布尔键（含嵌套点号键）从 bundle 配置的对象子字段/顶层取默认值
  assert.equal(data.effective.bm25SearchEnabled, true);
  assert.equal(data.effective.conflictFreezeEnabled, false);
  assert.equal(data.effective.trustEpistemicWeighting, false);
  assert.equal(data.effective.reflectionFailureTracking, true);
  assert.equal(data.effective["memoryQualityFilter.enabled"], true);
  assert.equal(data.effective["llmAudit.enabled"], true);
  // #254：写入准入两个键都默认关（默认路径零行为变化），面板可逐项启停。
  assert.equal(data.effective["writeAdmission.enabled"], false);
  assert.equal(data.effective["writeAdmission.enforce"], false);
  // #164 A2：密钥/PII 判据自己的闸，同样默认关（#332 的行为逐字节保留）。
  assert.equal(data.effective.sensitiveScanEnabled, false);
  // 新增字符串 / URL / 枚举键
  assert.equal(data.effective.localEmbedModel, "Xenova/bge-small-zh-v1.5");
  assert.equal(data.effective.ollamaBaseUrl, "http://localhost:11434");
  assert.equal(data.effective.ollamaModel, "nomic-embed-text");
  assert.equal(data.effective.embedProvider, "openai");
  // PR1：融合配方枚举 + 信号透明布尔（均有默认值，故计入 effective 计数）
  assert.equal(data.effective.recallFusion, "blend");
  assert.equal(data.effective.signalTransparency, false);
  // issue #109：实体抽取路由三键（均有默认值，故计入 effective 计数）
  assert.equal(data.effective.entityExtractionProvider, "");
  assert.equal(data.effective.entityExtractionModel, "");
  assert.equal(data.effective.entityExtractionReasoning, "none");
  // issue #315：蒸馏思考强度（默认 none = 不发送字段，行为不变）
  assert.equal(data.effective.summarizeReasoningEffort, "none");
  // issue #127：summarize 节流五键（均有默认值，故计入 effective 计数）
  assert.equal(data.effective.summarizeMinIntervalMinutes, 0);
  assert.equal(data.effective.summarizeMaxEntriesPerRun, 0);
  assert.equal(data.effective.summarizeDedupeMode, "off");
  assert.equal(data.effective.summarizeDedupeMinSim, 0.92);
  assert.equal(data.effective.summarizeDedupeWindowHours, 24);
  // issue #126：sleep 动作集（默认 conflict = 现状；面板可切 full）
  assert.equal(data.effective.sleepActionSet, "conflict");
  // issue #125：候选集三键（默认 window / 0 / 0.85）
  assert.equal(data.effective.dreamCandidateMode, "window");
  assert.equal(data.effective.dreamCandidateMax, 0);
  assert.equal(data.effective.dreamCandidateMinSim, 0.85);
});

test("PUT /api/dsh-mneme/features round-trips, overrides effective and persists", async () => {
  const { routes, settings } = setup(undefined, "", FLAGS_CFG);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/features");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features", "PUT", { autoDream: false, distillMaxChars: 48000 }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.deepEqual(data.overrides, { autoDream: false, distillMaxChars: 48000 });
  assert.equal(data.effective.autoDream, false, "override wins over config default");
  assert.equal(data.effective.distillMaxChars, 48000);
  assert.equal(data.effective.autoInject, true, "keys not in the patch still report config");
  assert.deepEqual(settings.getFeatureFlags(), { autoDream: false, distillMaxChars: 48000 });
});

test("PUT /api/dsh-mneme/features round-trips nested, string, url and enum keys", async () => {
  const { routes, settings } = setup(undefined, "", FLAGS_CFG);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/features");
  const patch = {
    "memoryQualityFilter.enabled": false,
    "llmAudit.enabled": false,
    // #254：新点号键必须同时进 settings 白名单**和** api.js 的 NESTED_FLAG_PATHS。
    // 只加白名单时 configFlagValue("writeAdmission.enabled") 取的是 cfg 顶层的
    // 同名字符串（不存在）→ effective 静默少键、PUT 存了也读不回来，且面板无感。
    // 这里往返一次就是钉这件事的（计数锁只钉数量，钉不住值）。
    "writeAdmission.enabled": true,
    "writeAdmission.enforce": true,
    // #380：同上一条的防线——新点号键的 NESTED_FLAG_PATHS 往返锁。
    "preInjectGate.enabled": true,
    "preInjectGate.enforce": true,
    // #164 A2：顶层扁平键（不是对象子字段），与上面两个点号键走同一条往返；
    // 它的默认值断言在计数锁那一条里，这里钉的是「PUT 存进去、effective 读得回」。
    sensitiveScanEnabled: true,
    embedProvider: "local",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    dreamProvider: "  siliconflow  ",
    dreamModel: ""
  };
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features", "PUT", patch), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.deepEqual(data.overrides, {
    "memoryQualityFilter.enabled": false,
    "llmAudit.enabled": false,
    "writeAdmission.enabled": true,
    "writeAdmission.enforce": true,
    "preInjectGate.enabled": true,
    "preInjectGate.enforce": true,
    sensitiveScanEnabled: true,
    embedProvider: "local",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    dreamProvider: "siliconflow",
    dreamModel: ""
  }, "nested keys persist flat, free strings are trimmed");
  // #380 新点号键同样平铺持久化
  assert.equal(data.overrides["preInjectGate.enabled"], true);
  assert.equal(data.overrides["preInjectGate.enforce"], true);
  // 嵌套键的覆盖值压过 bundle 配置的对象子字段
  assert.equal(data.effective["memoryQualityFilter.enabled"], false);
  assert.equal(data.effective["llmAudit.enabled"], false);
  assert.equal(data.effective["writeAdmission.enabled"], true);
  assert.equal(data.effective["writeAdmission.enforce"], true);
  assert.equal(data.effective["preInjectGate.enabled"], true, "#380 dotted key round-trips");
  assert.equal(data.effective["preInjectGate.enforce"], true, "#380 dotted key round-trips");
  assert.equal(data.effective.sensitiveScanEnabled, true);
  assert.equal(data.effective.embedProvider, "local");
  assert.equal(data.effective.ollamaBaseUrl, "http://127.0.0.1:11434");
  assert.equal(data.effective.dreamProvider, "siliconflow");
  assert.equal(data.effective.dreamModel, "", "empty string is a legal override");
  assert.deepEqual(settings.getFeatureFlags(), data.overrides, "overrides persisted");

  // 非法枚举 / 非 http 协议的 URL → 400 且不落库
  const badEnum = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features", "PUT", { embedProvider: "bogus" }), badEnum);
  assert.equal(badEnum.statusCode, 400);
  assert.match(JSON.parse(badEnum.body).error, /embedProvider/);

  const badUrl = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features", "PUT", { ollamaBaseUrl: "ftp://localhost:11434" }), badUrl);
  assert.equal(badUrl.statusCode, 400);
  assert.match(JSON.parse(badUrl.body).error, /ollamaBaseUrl/);

  assert.deepEqual(settings.getFeatureFlags(), data.overrides, "rejected writes persist nothing");
});

test("PUT /api/dsh-mneme/features rejects unknown keys, bad types and bad ranges with 400", async () => {
  const { routes, settings } = setup(undefined, "", FLAGS_CFG);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/features");

  const unknown = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features", "PUT", { noSuchFlag: true }), unknown);
  assert.equal(unknown.statusCode, 400);
  assert.match(JSON.parse(unknown.body).error, /noSuchFlag/);

  const badType = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features", "PUT", { autoInject: "yes" }), badType);
  assert.equal(badType.statusCode, 400);
  assert.match(JSON.parse(badType.body).error, /autoInject/);

  const badRange = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features", "PUT", { codingBoostFactor: 9 }), badRange);
  assert.equal(badRange.statusCode, 400);
  assert.match(JSON.parse(badRange.body).error, /codingBoostFactor/);

  // 空 patch 不携带任何意图，直接 400
  const empty = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features", "PUT", {}), empty);
  assert.equal(empty.statusCode, 400);

  assert.deepEqual(settings.getFeatureFlags(), {}, "failed writes persist nothing");
});

test("PUT /api/dsh-mneme/features is token-gated; GET stays open", async () => {
  const { routes } = setup(undefined, "secret-token", FLAGS_CFG);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/features");

  const get = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features"), get);
  assert.equal(get.statusCode, 200, "read stays open without token");

  const put = new FakeRes();
  await route.handler(req("/api/dsh-mneme/features", "PUT", { autoDream: false }), put);
  assert.equal(put.statusCode, 401);

  const ok = req("/api/dsh-mneme/features", "PUT", { autoDream: false });
  ok.headers = { authorization: "Bearer secret-token" };
  const okRes = new FakeRes();
  await route.handler(ok, okRes);
  assert.equal(okRes.statusCode, 200);
});

// --- 交互式记忆库面板：日期过滤 / update / memories/entities / export / import / dream-status ---

test("GET /api/dsh-mneme/list supports updatedFrom/updatedTo and count matches", async () => {
  const { routes, service, store } = setup();
  service.saveWithDedupe({ type: "preference", title: "旧", content: "1" });
  service.saveWithDedupe({ type: "preference", title: "中", content: "2" });
  service.saveWithDedupe({ type: "preference", title: "新", content: "3" });
  const setAt = (title, at) => store.db.prepare("UPDATE memories SET updated_at = ? WHERE title = ?").run(at, title);
  setAt("旧", "2026-08-01T00:00:00.000Z");
  setAt("中", "2026-09-01T12:00:00.000Z");
  setAt("新", "2026-09-15T23:00:00.000Z");
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");

  const from = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?updatedFrom=2026-09-01"), from);
  const fromData = JSON.parse(from.body);
  assert.equal(fromData.items.length, 2);
  assert.equal(fromData.total, 2, "count filter matches list filter");
  assert.deepEqual(fromData.items.map((m) => m.title).sort(), ["中", "新"]);

  // date-only updatedTo 闭区间含当天全天（中 09-01T12:00 命中）
  const range = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?updatedFrom=2026-08-01&updatedTo=2026-09-01"), range);
  const rangeData = JSON.parse(range.body);
  assert.equal(rangeData.items.length, 2);
  assert.equal(rangeData.total, 2);

  const to = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?updatedTo=2026-08-31"), to);
  const toData = JSON.parse(to.body);
  assert.equal(toData.items.length, 1);
  assert.equal(toData.items[0].title, "旧");

  // 非法日期值 → 忽略（不报错、不过滤）
  const bad = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?updatedFrom=not-a-date&updatedTo=%E4%B9%B1"), bad);
  const badData = JSON.parse(bad.body);
  assert.equal(badData.items.length, 3);
  assert.equal(badData.total, 3);

  // 完整时间戳同样生效
  const ts = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?updatedFrom=2026-09-02T00:00:00.000Z"), ts);
  const tsData = JSON.parse(ts.body);
  assert.equal(tsData.items.length, 1);
  assert.equal(tsData.items[0].title, "新");
});

test("POST /api/dsh-mneme/update edits title/importance and archives", async () => {
  const { routes, service } = setup();
  const created = service.saveWithDedupe({ type: "preference", title: "原始", content: "原始内容" });
  const id = created.memory.id;
  const route = routes.find((r) => r.path === "/api/dsh-mneme/update");

  const edit = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id, title: "改名", importance: 5 }), edit);
  assert.equal(edit.statusCode, 200);
  const row = JSON.parse(edit.body).memory;
  assert.equal(row.title, "改名");
  assert.equal(row.importance, 5);
  assert.equal(row.archived, false, "archived booleanized in the response row");
  assert.notEqual(row.updated_at, created.memory.updated_at, "updated_at advances");

  const archive = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id, archived: true }), archive);
  assert.equal(archive.statusCode, 200);
  assert.equal(JSON.parse(archive.body).memory.archived, true);
  assert.equal(service.getById(id).archived, true);
});

test("POST /api/dsh-mneme/update archives replaced content into content_history", async () => {
  const { routes, service } = setup();
  const created = service.saveWithDedupe({ type: "preference", title: "历史", content: "第一版" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/update");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id: created.memory.id, content: "第二版" }), res);
  assert.equal(res.statusCode, 200);
  const row = service.getById(created.memory.id);
  assert.equal(row.content, "第二版");
  assert.equal(row.content_history[0].content, "第一版");
  assert.equal(row.content_history[0].source, "human_override");
});

test("POST /api/dsh-mneme/update returns 400/404 for bad requests", async () => {
  const { routes, service } = setup();
  const created = service.saveWithDedupe({ type: "preference", title: "存在", content: "x" });
  const id = created.memory.id;
  const route = routes.find((r) => r.path === "/api/dsh-mneme/update");

  const missing = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { title: "无 id" }), missing);
  assert.equal(missing.statusCode, 400);

  const noFields = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id }), noFields);
  assert.equal(noFields.statusCode, 400);

  const emptyTitle = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id, title: "   " }), emptyTitle);
  assert.equal(emptyTitle.statusCode, 400);

  const emptyContent = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id, content: "" }), emptyContent);
  assert.equal(emptyContent.statusCode, 400);

  const badImportance = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id, importance: 9 }), badImportance);
  assert.equal(badImportance.statusCode, 400);

  const badTags = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id, tags: "x" }), badTags);
  assert.equal(badTags.statusCode, 400);

  const badArchived = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id, archived: "yes" }), badArchived);
  assert.equal(badArchived.statusCode, 400);

  const gone = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id: "no-such-id", title: "x" }), gone);
  assert.equal(gone.statusCode, 404);
  assert.deepEqual(JSON.parse(gone.body), { error: "not-found" });

  assert.equal(service.getById(id).title, "存在", "failed writes persist nothing");
});

test("POST /api/dsh-mneme/update is token-gated", async () => {
  const { routes } = setup(undefined, "secret-token");
  const route = routes.find((r) => r.path === "/api/dsh-mneme/update");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/update", "POST", { id: "x", title: "y" }), res);
  assert.equal(res.statusCode, 401);
});

test("GET /api/dsh-mneme/memories/entities returns entities linked to a memory", async () => {
  const { routes, service } = setup();
  const a = service.saveWithDedupe({ type: "project", title: "A", content: "提到甲" });
  const b = service.saveWithDedupe({ type: "project", title: "B", content: "无关" });
  const entity = service.createEntity({ name: "甲", type: "person" });
  // 同一记忆两次提及同一实体（两条 attr）→ 去重后只出现一次
  service.saveAttr({ entity_id: entity.id, attr_key: "角色", attr_value: "负责人", memory_id: a.memory.id });
  service.saveAttr({ entity_id: entity.id, attr_key: "团队", attr_value: "前端", memory_id: a.memory.id });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/memories/entities");

  const res = new FakeRes();
  await route.handler(req(`/api/dsh-mneme/memories/entities?memoryId=${a.memory.id}`), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.entities.length, 1, "deduped by mention");
  assert.equal(data.entities[0].name, "甲");
  assert.equal(data.entities[0].type, "person");

  const none = new FakeRes();
  await route.handler(req(`/api/dsh-mneme/memories/entities?memoryId=${b.memory.id}`), none);
  assert.deepEqual(JSON.parse(none.body), { entities: [] });

  const missing = new FakeRes();
  await route.handler(req("/api/dsh-mneme/memories/entities"), missing);
  assert.equal(missing.statusCode, 400);
});

test("GET /api/dsh-mneme/export json carries full rows and version", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "甲", content: "内容甲" });
  const hidden = service.saveWithDedupe({ type: "preference", title: "乙", content: "内容乙" });
  service.setForget(hidden.memory.id, true);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/export");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/export"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.count, 2, "export includes forgotten rows");
  assert.equal(data.memories.length, 2);
  assert.equal(typeof data.version, "string", "version comes from package.json");
  assert.ok(data.exported_at);
  assert.equal(data.memories.every((m) => typeof m.archived === "boolean" && typeof m.forgotten === "boolean"), true);
  const times = data.memories.map((m) => m.updated_at);
  assert.deepEqual(times, [...times].sort().reverse(), "updated_at DESC");
  assert.match(res.headers["Content-Disposition"], /attachment; filename="dsh-mneme-export-\d{8}\.json"/);
});

test("GET /api/dsh-mneme/export markdown feeds straight back through import", async () => {
  const { routes, service } = setup();
  const a = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文优先" });
  const b = service.saveWithDedupe({ type: "preference", title: "风格", content: "简洁" });
  const exportRoute = routes.find((r) => r.path === "/api/dsh-mneme/export");
  const importRoute = routes.find((r) => r.path === "/api/dsh-mneme/import");

  const res = new FakeRes();
  await exportRoute.handler(req("/api/dsh-mneme/export?format=markdown"), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Content-Type"], /text\/markdown/);
  assert.match(res.headers["Content-Disposition"], /attachment; filename="dsh-mneme-export-\d{8}\.md"/);
  const md = res.body;
  assert.ok(md.includes("- **ID**: `" + a.memory.id + "`"), "anchor line present (readHumanEdits-compatible)");

  // 导出是一个文档（#278 审查 F1/F3）：frontmatter 只能有一份并在最前，分节不带
  // 各自的文件头；而且它的覆盖声明必须与正文条目数一致——「说一套写一套」比没有
  // 这个字段更糟，外部工具会照着它聚合。
  assert.equal([...md.matchAll(/^type: /gm)].length, 1, "只有一个 frontmatter 的 type 键");
  assert.match(md, /^type: memory-export$/m);
  assert.match(md, /^coverage: all$/m, "导出含归档/已遗忘行，声明要说实话");
  assert.equal(
    Number(md.match(/^covered: (\d+)$/m)[1]),
    (md.match(/^- \*\*ID\*\*: /gm) ?? []).length,
    "covered 必须等于实际导出的条目数"
  );

  // 黄金用例：导出文本原样导入 → 解析出全部条目，且字段无漂移
  const back = new FakeRes();
  await importRoute.handler(req("/api/dsh-mneme/import", "POST", { type: "preference", markdown: md }), back);
  assert.equal(back.statusCode, 200);
  const data = JSON.parse(back.body);
  assert.equal(data.type, "preference");
  assert.ok(data.merged >= 2, "both memories parsed back");
  assert.equal(service.getById(a.memory.id).title, "语言");
  assert.equal(service.getById(a.memory.id).content, "中文优先");
  assert.equal(service.getById(b.memory.id).title, "风格");
  assert.equal(service.getById(b.memory.id).content, "简洁");
});

test("POST /api/dsh-mneme/import validates type/markdown and tolerates zero edits", async () => {
  const { routes } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/import");

  const badType = new FakeRes();
  await route.handler(req("/api/dsh-mneme/import", "POST", { type: "preferences", markdown: "x" }), badType);
  assert.equal(badType.statusCode, 400, "TYPE_FILE keys are singular, plural is rejected");

  const badMd = new FakeRes();
  await route.handler(req("/api/dsh-mneme/import", "POST", { type: "preference", markdown: "" }), badMd);
  assert.equal(badMd.statusCode, 400);

  const zero = new FakeRes();
  await route.handler(req("/api/dsh-mneme/import", "POST", { type: "preference", markdown: "# 空镜像" }), zero);
  assert.equal(zero.statusCode, 200);
  assert.deepEqual(JSON.parse(zero.body), { merged: 0, type: "preference" });
});

test("POST /api/dsh-mneme/import is token-gated", async () => {
  const { routes } = setup(undefined, "secret-token");
  const route = routes.find((r) => r.path === "/api/dsh-mneme/import");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/import", "POST", { type: "preference", markdown: "x" }), res);
  assert.equal(res.statusCode, 401);
});

test("GET /api/dsh-mneme/dream-status returns runs and pending conflict ids", async () => {
  const { routes, service } = setup();
  service.saveDreamRun({ created_at: "2026-01-01T00:00:00.000Z", status: "ok", provider: "ollama", model: "qwen", snapshot_hash: "h1", input_count: 2, receipt: "r1" });
  service.saveDreamRun({ created_at: "2026-01-02T00:00:00.000Z", status: "failed", error: "boom", snapshot_hash: "h2", input_count: 0, receipt: "r2" });
  const pending = service.saveConflictPending({ memory_a: "aaaa", memory_b: "bbbb", reason: "矛盾" });

  const route = routes.find((r) => r.path === "/api/dsh-mneme/dream-status");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/dream-status"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.runs.length, 2);
  assert.equal(data.runs[0].created_at, "2026-01-02T00:00:00.000Z", "created_at DESC");
  assert.deepEqual(data.lastRun, data.runs[0]);
  assert.deepEqual(Object.keys(data.lastRun).sort(), ["created_at", "demotion", "error", "model", "provider", "run_type", "status"]);
  assert.equal(data.lastRun.run_type, "auto", "default run_type is auto");
  assert.equal(data.lastRun.demotion, null, "no demotion info for non-sleep runs");
  assert.equal(data.runs[0].error, "boom");
  assert.equal(data.runs[1].provider, "ollama");
  assert.equal(data.pendingConflicts, 1);
  assert.deepEqual(data.pendingMemoryIds.sort(), ["aaaa", "bbbb"]);

  // 解决后队列清空
  service.resolveConflictPending(pending.id, { winner: "aaaa" });
  const after = new FakeRes();
  await route.handler(req("/api/dsh-mneme/dream-status"), after);
  const afterData = JSON.parse(after.body);
  assert.equal(afterData.pendingConflicts, 0);
  assert.deepEqual(afterData.pendingMemoryIds, []);
});

// v0.8.0 冲突集中处理：GET /conflicts 队列联表 + POST /conflicts/resolve 人工确认。
test("GET /api/dsh-mneme/conflicts joins both sides of unresolved conflicts", async () => {
  const { routes, service } = setup();
  const a = service.saveWithDedupe({ type: "history", title: "界面暗色偏好", content: "用户当前使用暗色界面主题", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "history", title: "界面亮色切换", content: "用户界面亮色切换计划", importance: 3 }).memory;
  service.saveConflictPending({ memory_a: a.id, memory_b: b.id, reason: "主题偏好前后矛盾" });

  const route = routes.find((r) => r.path === "/api/dsh-mneme/conflicts");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/conflicts"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
  assert.equal(data.total, 1);
  assert.equal(data.items[0].reason, "主题偏好前后矛盾");
  // saveConflictPending 会按 id 字典序归一 A/B 侧位——断言集合而非位置。
  assert.deepEqual(
    [data.items[0].memory_a.title, data.items[0].memory_b.title].sort(),
    ["界面亮色切换", "界面暗色偏好"]
  );
  assert.equal(data.items[0].memory_a.archived, false);
  assert.equal(data.items[0].memory_b.archived, false);
  // 幽灵侧容忍缺失
  service.saveConflictPending({ memory_a: a.id, memory_b: "ghost-id", reason: "对方已删" });
  const res2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/conflicts"), res2);
  const data2 = JSON.parse(res2.body);
  assert.equal(data2.items.length, 2);
  assert.equal(data2.items.find((x) => x.reason === "对方已删").memory_b.missing, true);
});

test("POST /api/dsh-mneme/conflicts/resolve stamps and applies the disposition", async () => {
  const { store, routes, service } = setup();
  const a = service.saveWithDedupe({ type: "history", title: "界面暗色偏好", content: "用户当前使用暗色界面主题", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "history", title: "界面亮色切换", content: "用户界面亮色切换计划", importance: 3 }).memory;
  const pending = service.saveConflictPending({ memory_a: a.id, memory_b: b.id, reason: "主题偏好前后矛盾" });

  // store 会把 pair 按 id 字典序归一——从队列行反查「界面亮色切换」所在侧再选。
  const queueRoute = routes.find((r) => r.path === "/api/dsh-mneme/conflicts");
  const queueRes = new FakeRes();
  await queueRoute.handler(req("/api/dsh-mneme/conflicts"), queueRes);
  const queued = JSON.parse(queueRes.body).items.find((x) => x.id === pending.id);
  const keepSide = queued.memory_a.id === b.id ? "a" : "b";
  // loser 恒为 a（keeper 恒为「界面亮色切换」= b），与 A/B 侧位字母无关
  const loserId = a.id;

  const route = routes.find((r) => r.path === "/api/dsh-mneme/conflicts/resolve");
  // 保留「界面亮色切换」所在侧（apply 默认 true）→ 该侧保留，另一侧归档
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/conflicts/resolve", "POST", { id: pending.id, winner: keepSide }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(data.conflict.resolved_winner, b.id);
  assert.equal(data.conflict.disposition.ok, true);
  assert.equal(store.getById(b.id).archived, false, "winner kept");
  assert.equal(store.getById(loserId).archived, true, "loser archived by apply");

  // 处理过的 id 再 resolve → 幂等重盖（仍是 200；队列视图只列未解决行，
  // 正常 UI 不会再发这个请求，但接口层保持幂等）
  const res2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/conflicts/resolve", "POST", { id: pending.id, winner: "a" }), res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(JSON.parse(res2.body).ok, true);

  // 未知 id → 404；缺 id → 400
  const res3 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/conflicts/resolve", "POST", { id: "nope", winner: "a" }), res3);
  assert.equal(res3.statusCode, 404);
  const res4 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/conflicts/resolve", "POST", {}), res4);
  assert.equal(res4.statusCode, 400);

  // apply:false 只盖章不处置
  const c = service.saveWithDedupe({ type: "decision", title: "丙", content: "内容丙" }).memory;
  const d = service.saveWithDedupe({ type: "decision", title: "丁", content: "内容丁" }).memory;
  const p2 = service.saveConflictPending({ memory_a: c.id, memory_b: d.id, reason: "r2" });
  const res5 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/conflicts/resolve", "POST", { id: p2.id, apply: false }), res5);
  assert.equal(res5.statusCode, 200);
  assert.equal(JSON.parse(res5.body).conflict.disposition, null);
  assert.equal(store.getById(c.id).archived, false);
  assert.equal(store.getById(d.id).archived, false);
});

test("parseHumanEdits is the pure core of readHumanEdits (CRLF tolerant)", () => {
  const digest = "0".repeat(64);
  const text = [
    "# x\r\n",
    "\r\n",
    "## 标题\r\n",
    "\r\n",
    "- **ID**: `m1`\n",
    "- **类型**: preference\n",
    "- **重要性**: 3\n",
    "- **标签**: \n",
    "- **更新时间**: 2026-01-01T00:00:00.000Z\n",
    "\n",
    `<!-- mirror-digest: ${digest} -->\n`,
    "正文一段\n",
    "\n",
    "---\n",
    "\n",
    "## 另一条\n",
    "\r\n",
    "- **ID**: `m2`\n",
    "- **类型**: preference\n",
    "- **重要性**: 4\n",
    "- **标签**: \n",
    "- **更新时间**: 2026-01-02T00:00:00.000Z\n",
    "\n",
    "内容二\n",
    "\n",
    "---\n"
  ].join("");
  const edits = parseHumanEdits(text);
  assert.equal(edits.length, 2);
  assert.equal(edits[0].id, "m1");
  assert.equal(edits[0].title, "标题");
  assert.equal(edits[0].content, "正文一段");
  assert.equal(edits[1].id, "m2");
  assert.equal(edits[1].content, "内容二");
});

test("GET /api/dsh-mneme/list?archived=only lists just archived rows; default list hides them", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "在用", content: "keep" });
  service.saveWithDedupe({ type: "project", title: "已归档", content: "gone" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const upd = routes.find((r) => r.path === "/api/dsh-mneme/update");

  const def0 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list"), def0);
  const target = JSON.parse(def0.body).items.find((m) => m.title === "已归档");

  const arch = new FakeRes();
  await upd.handler(req("/api/dsh-mneme/update", "POST", { id: target.id, archived: true }), arch);
  assert.equal(arch.statusCode, 200);

  const def = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list"), def);
  assert.equal(JSON.parse(def.body).total, 1, "default list hides archived rows");

  const only = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?archived=only"), only);
  const onlyData = JSON.parse(only.body);
  assert.equal(onlyData.total, 1, "archived-only count matches rows");
  assert.deepEqual(onlyData.items.map((m) => m.title), ["已归档"]);
  assert.equal(onlyData.items[0].archived, true);

  // 恢复（unarchive）后归档视图清空、默认列表重新可见
  const restore = new FakeRes();
  await upd.handler(req("/api/dsh-mneme/update", "POST", { id: target.id, archived: false }), restore);
  assert.equal(restore.statusCode, 200);
  const empty = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?archived=only"), empty);
  assert.equal(JSON.parse(empty.body).total, 0);
  const back = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list"), back);
  assert.equal(JSON.parse(back.body).total, 2);
});

test("GET /api/dsh-mneme/list?deposited=only lists dream-touched memories (receipts ∪ source=dream)", async () => {
  const { routes, service } = setup();
  const plain = service.saveWithDedupe({ type: "preference", title: "无关", content: "plain" });
  const merged = service.saveWithDedupe({ type: "project", title: "被巩固", content: "merged" });
  const updated = service.saveWithDedupe({ type: "decision", title: "被更新", content: "updated" });
  service.saveWithDedupe({ type: "summary", title: "总览", content: "overview", source: "dream" });
  const ids = [plain, merged, updated].map((r) => r.memory.id);

  // 巩固账本：merge 落在 keepSource、update 落在目标；conflict 只仲裁不落
  // 内容，不算沉淀。verdict='live' 才有效。
  service.saveReceipt({
    receipt_id: "r-merge", run_id: "run-1", record_id: merged.memory.id, kind: "merge",
    input_digest: "d1", keep_source: merged.memory.id, sources: [merged.memory.id, ids[0]],
    verdict: "live", count_before: 2, count_after: 1, policy_epoch: 0,
    created_at: new Date().toISOString()
  });
  service.saveReceipt({
    receipt_id: "r-update", run_id: "run-1", record_id: updated.memory.id, kind: "update",
    input_digest: "d2", verdict: "live", count_before: 1, count_after: 1,
    policy_epoch: 0, created_at: new Date().toISOString()
  });
  service.saveReceipt({
    receipt_id: "r-conflict", run_id: "run-1", record_id: "winner-x", kind: "conflict",
    input_digest: "d3", winner_id: "winner-x", loser_id: "loser-y", verdict: "live",
    count_before: 2, count_after: 2, policy_epoch: 0, created_at: new Date().toISOString()
  });

  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?deposited=only"), res);
  const data = JSON.parse(res.body);
  assert.deepEqual(
    data.items.map((m) => m.title).sort(),
    ["总览", "被巩固", "被更新"],
    "deposited view = receipt merge/update records ∪ source=dream writes"
  );
  assert.equal(data.total, 3, "total honors the deposited filter");

  // 默认列表不受 deposited 过滤影响
  const def = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list"), def);
  assert.equal(JSON.parse(def.body).total, 4);

  // 与 archived=only 可叠加：归档的沉淀记忆才出现在交集视图里
  const upd = routes.find((r) => r.path === "/api/dsh-mneme/update");
  const arch = new FakeRes();
  await upd.handler(req("/api/dsh-mneme/update", "POST", { id: merged.memory.id, archived: true }), arch);
  assert.equal(arch.statusCode, 200);
  const both = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?deposited=only&archived=only"), both);
  const bothData = JSON.parse(both.body);
  assert.deepEqual(bothData.items.map((m) => m.title), ["被巩固"]);
  assert.equal(bothData.total, 1);
});

test("GET /api/dsh-mneme/list projects per-memory heat only when heatEnabled=true", async () => {
  // 默认（heatEnabled=false）：heat 字段整体缺省——前端徽章据此自动隐藏
  const off = setup();
  off.service.saveWithDedupe({ type: "preference", title: "免疫型", content: "immune" });
  const r0 = new FakeRes();
  await off.routes.find((r) => r.path === "/api/dsh-mneme/list").handler(req("/api/dsh-mneme/list"), r0);
  const d0 = JSON.parse(r0.body);
  assert.equal(d0.total, 1);
  assert.equal("heat" in d0.items[0], false, "heat must be absent from the wire DTO when the flag is off");

  // heatEnabled=true：逐条投影。λ=0 免疫类型（preference）恒 1.0；其余落在
  // [0,1] 区间（新建记忆 Δt≈0 接近满格，衰减数学由 heat.test.js 看门）。
  const on = setup(null, "", { heatEnabled: true });
  on.service.saveWithDedupe({ type: "preference", title: "免疫型", content: "immune" });
  on.service.saveWithDedupe({ type: "history", title: "会话历史", content: "recent" });
  const r1 = new FakeRes();
  await on.routes.find((r) => r.path === "/api/dsh-mneme/list").handler(req("/api/dsh-mneme/list"), r1);
  const d1 = JSON.parse(r1.body);
  assert.equal(d1.total, 2);
  const byTitle = Object.fromEntries(d1.items.map((m) => [m.title, m.heat]));
  assert.equal(byTitle["免疫型"], 1, "λ=0 immune types stay at full heat");
  for (const v of Object.values(byTitle)) {
    assert.ok(typeof v === "number" && v >= 0 && v <= 1, "heat values stay within [0,1]");
  }
});

// ---------------------------------------------------------------- llm-providers / test-model
// Settings-panel support: enumerate host-registered providers/models so the
// panel can offer a dropdown over real models, and probe connectivity with a
// minimal LLM call (same harness path the consolidation uses).

function setupLlm(llm, apiToken = "", extraCtx = {}, config = null) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    llm,
    ...extraCtx
  };
  const api = createApi(ctx, service, settings, commands, undefined, undefined, apiToken, config);
  return { routes };
}

const MOCK_LLM = {
  listProviders: () => [
    { id: "deepseek", name: "DeepSeek" },
    { id: "broken", name: "Broken Adapter" }
  ],
  listModels: async (provider) => {
    if (provider === "broken") throw new Error("provider not reachable");
    return [{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner", name: "DeepSeek Reasoner" }];
  },
  async *stream(options) {
    MOCK_LLM.lastOptions = options;
    if (options.model === "bad-model") {
      yield {
        type: "finish",
        reason: { kind: "error", failure: { code: "AUTH_FAILED", message: "invalid api key" } }
      };
      return;
    }
    if (options.reasoningEffort === "reject") {
      throw new Error('UNSUPPORTED_REASONING_EFFORT: provider "mock" model "mock-model" does not support reasoning effort "reject"');
    }
    yield { type: "text-delta", index: 0, text: " ok " };
    yield { type: "finish", reason: { kind: "stop" } };
  }
};

test("GET /api/dsh-mneme/llm-providers lists host providers with models, per-provider best effort", async () => {
  const { routes } = setupLlm(MOCK_LLM);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/llm-providers");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/llm-providers"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.providers.length, 2);
  const deepseek = data.providers.find((p) => p.provider === "deepseek");
  assert.deepEqual(deepseek.models.map((m) => m.id), ["deepseek-chat", "deepseek-reasoner"]);
  const broken = data.providers.find((p) => p.provider === "broken");
  assert.deepEqual(broken.models, [], "a provider whose model list throws degrades to empty, not a hard fail");
});

test("GET /api/dsh-mneme/llm-providers without ctx.llm returns 501", async () => {
  const { routes } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/llm-providers");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/llm-providers"), res);
  assert.equal(res.statusCode, 501);
  assert.equal(JSON.parse(res.body).error, "llm-unavailable");
});

test("POST /api/dsh-mneme/test-model succeeds and reports reply + latency", async () => {
  const { routes } = setupLlm(MOCK_LLM);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/test-model");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/test-model", "POST", { provider: "deepseek", model: "deepseek-chat" }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(data.reply, "ok", "reply trimmed");
  assert.ok(data.durationMs >= 0);
  assert.equal(data.modelId, "deepseek:deepseek-chat", "modelId reports the probed route");
  assert.equal(MOCK_LLM.lastOptions.provider, "deepseek");
  assert.equal(MOCK_LLM.lastOptions.purpose, "dsh-mneme-connectivity-test");
  // 回归：探测必须是一条 user 消息（带 source）。system-only 对话自
  // 0.1.6-alpha.1 起被官方 API 整单拒绝（「messages: at least one message
  // is required」），探测按钮会 502。
  assert.equal(MOCK_LLM.lastOptions.messages[0].role, "user");
  // issue #326：kind 必须是生产者自有值，裸 "plugin" 被 DSH 0.1.7 的 V4 写入准入拒绝。
  assert.equal(MOCK_LLM.lastOptions.messages[0].source?.kind, "plugin:dsh-mneme");
  assert.equal("reasoningEffort" in MOCK_LLM.lastOptions, false, "no effort configured -> field omitted");
});

test("POST /api/dsh-mneme/test-model forwards reasoningEffort verbatim", async () => {
  const { routes } = setupLlm(MOCK_LLM);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/test-model");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/test-model", "POST", { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(MOCK_LLM.lastOptions.reasoningEffort, "low", "effort forwarded to the probe call");
});

test("POST /api/dsh-mneme/test-model reports stream-level failure with 502", async () => {
  const { routes } = setupLlm(MOCK_LLM);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/test-model");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/test-model", "POST", { provider: "deepseek", model: "bad-model" }), res);
  assert.equal(res.statusCode, 502);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, false);
  assert.match(data.error, /AUTH_FAILED/, "stream failure reason surfaced like audit rows");
});

test("POST /api/dsh-mneme/test-model reports thrown failure with 502", async () => {
  const { routes } = setupLlm(MOCK_LLM);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/test-model");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/test-model", "POST", { provider: "mock", model: "mock-model", reasoningEffort: "reject" }), res);
  assert.equal(res.statusCode, 502);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, false);
  assert.match(data.error, /UNSUPPORTED_REASONING_EFFORT/, "throw path surfaces the harness rejection");
});

test("POST /api/dsh-mneme/test-model resolves empty body against the consolidation route", async () => {
  // Empty provider/model = "test whatever consolidation uses now": the route
  // falls back to agentDefaultModel (config dreamProvider/dreamModel absent),
  // the probe runs against that model, and modelId reports what was tested.
  const { routes } = setupLlm(MOCK_LLM, "", {
    agentDefaultModel: { currentSelection: () => ({ provider: "sel-provider", model: "sel-model" }) }
  });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/test-model");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/test-model", "POST", {}), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(data.modelId, "sel-provider:sel-model", "probe ran against the resolved consolidation route");
  assert.equal(MOCK_LLM.lastOptions.provider, "sel-provider");
  assert.equal(MOCK_LLM.lastOptions.model, "sel-model");
});

test("POST /api/dsh-mneme/test-model validates input and llm availability", async () => {
  const { routes } = setupLlm(MOCK_LLM);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/test-model");
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/test-model", "POST", { provider: "deepseek" }), res);
  assert.equal(res.statusCode, 400, "partial input (provider without model) rejected");
  assert.equal(JSON.parse(res.body).error, "missing-provider-or-model");

  // empty body with no route (no agentDefaultModel, no config route) -> no-route
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/test-model", "POST", {}), res);
  assert.equal(res.statusCode, 400, "empty body with no resolvable route rejected");
  assert.equal(JSON.parse(res.body).error, "no-route");

  const { routes: routesNoLlm } = setup();
  const routeNoLlm = routesNoLlm.find((r) => r.path === "/api/dsh-mneme/test-model");
  res = new FakeRes();
  await routeNoLlm.handler(req("/api/dsh-mneme/test-model", "POST", { provider: "deepseek", model: "deepseek-chat" }), res);
  assert.equal(res.statusCode, 501, "no ctx.llm -> llm-unavailable");
});

test("POST /api/dsh-mneme/test-model is auth-gated like other expensive endpoints", async () => {
  const { routes } = setupLlm(MOCK_LLM, "secret-token");
  const route = routes.find((r) => r.path === "/api/dsh-mneme/test-model");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/test-model", "POST", { provider: "deepseek", model: "deepseek-chat" }), res);
  assert.equal(res.statusCode, 401, "probe spends the user's API quota, so it must require auth");
});

test("GET /api/dsh-mneme/inject-status: suppressed only when minimal preset observed (issue #182)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  let onEvent = null;
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    },
    on(type, fn) {
      onEvent = fn;
      return () => {};
    }
  };
  const api = createApi(
    ctx,
    service,
    settings,
    { add() {}, remove() {}, list() { return []; } },
    undefined,
    undefined,
    "",
    Config({}) // autoInject default true
  );
  const route = routes.find((r) => r.path === "/api/dsh-mneme/inject-status");

  // 未观测到任何会话：agentPreset=null，不猜、不压制。
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/inject-status"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { autoInject: true, agentPreset: null, suppressed: false });

  // minimal 会话事件到达（session/event 的第一参为 session）→ suppressed。
  onEvent({ header: { agentPreset: "minimal" } });
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/inject-status"), res);
  assert.deepEqual(JSON.parse(res.body), { autoInject: true, agentPreset: "minimal", suppressed: true });

  // standard 会话 → 无提示。
  onEvent({ header: { agentPreset: "standard" } });
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/inject-status"), res);
  assert.deepEqual(JSON.parse(res.body), { autoInject: true, agentPreset: "standard", suppressed: false });

  // 头里没有 agentPreset（降级形状）→ 回落 null，静默不猜。
  onEvent({ header: {} });
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/inject-status"), res);
  assert.deepEqual(JSON.parse(res.body), { autoInject: true, agentPreset: null, suppressed: false });

  // 非 GET → 404（与其他只读端点同款）。
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/inject-status", "POST"), res);
  assert.equal(res.statusCode, 404);
});

test("inject-status: autoInject off is never suppressed (user's own choice, not a black box)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  let onEvent = null;
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    },
    on(type, fn) {
      onEvent = fn;
      return () => {};
    }
  };
  const api = createApi(
    ctx,
    service,
    settings,
    { add() {}, remove() {}, list() { return []; } },
    undefined,
    undefined,
    "",
    Config({ autoInject: false })
  );
  const route = routes.find((r) => r.path === "/api/dsh-mneme/inject-status");
  onEvent({ header: { agentPreset: "minimal" } });
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/inject-status"), res);
  assert.deepEqual(JSON.parse(res.body), { autoInject: false, agentPreset: "minimal", suppressed: false });
});

test("GET /api/dsh-mneme/inject-preview: returns last assembly snapshot (issue #179)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };
  const api = createApi(
    ctx,
    service,
    settings,
    { add() {}, remove() {}, list() { return []; } },
    undefined,
    undefined,
    "",
    Config({})
  );
  const route = routes.find((r) => r.path === "/api/dsh-mneme/inject-preview");
  assert.ok(route, "preview endpoint must be registered");

  // 无渲染发生：snapshot=null（新宿主/新会话/autoInject 关闭同形）。
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/inject-preview"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { snapshot: null });

  // 真实渲染一帧后：快照透传（api 层不做任何加工）。
  service.saveWithDedupe({ type: "preference", title: "语言", content: "用户用中文交流", importance: 5 });
  const contexts = [];
  const promptCtx = {
    systemPrompt: { context(def) { contexts.push(def); return () => {}; } }
  };
  const injector = createInjector(promptCtx, service, settings, Config({ maxInjectedItems: 3, importanceThreshold: 3 }));
  contexts[0].text({});
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/inject-preview"), res);
  const body = JSON.parse(res.body);
  assert.ok(body.snapshot, "snapshot present after a real render");
  assert.equal(body.snapshot.entries[0].title, "语言");
  assert.ok(body.snapshot.totalChars > 0);

  // 非 GET → 404（与 inject-status 同款）。
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/inject-preview", "POST"), res);
  assert.equal(res.statusCode, 404);
  injector(); // 快照是模块全局：用完即清，不污染后续用例
});
