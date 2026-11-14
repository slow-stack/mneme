// #606 绑会话卡：/api/dsh-mneme/persona/session 单卡读写。
//
// 锁四件事：一，绑定真的落进 bySession，解绑真的把它删掉；二，未知卡/停用卡不许
// 静默建一张空卡；三，source 五档（session / parent / agent / default / none）由
// resolvePersonaCard 算出来，路由不另写一套优先级；四，绑完之后注入文本真的变了
// ——比对 renderUserSettingsBlock 的输出（预览与注入同源），不自己拼字符串断言。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { renderUserSettingsBlock } from "../src/user-settings.js";
import { testConfig } from "./helpers/test-config.js";

const PATH = "/api/dsh-mneme/persona/session";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path, method = "GET", body = null, headers = {}) {
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = headers;
  if (body !== null) {
    process.nextTick(() => {
      r.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
      r.emit("end");
    });
  }
  return r;
}

function setup(extra = {}, apiToken = "") {
  const config = testConfig({ personaEnabled: true, ...extra });
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const commands = { add() {}, remove() {}, list() { return []; } };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, undefined, undefined, apiToken, config);
  const route = routes.find((r) => r.path === PATH);
  return { store, settings, route, config };
}

// 两张身份卡（一开一关）+ 一张默认卡：停用那张专门用来验「不许绑上去」。
function seed(settings) {
  settings.setPersona({
    default: { name: "Fallback", personality: "兜底", enabled: true },
    byAgent: {
      ptc: { name: "Ptc", personality: "轻松", enabled: true },
      off: { name: "Off", personality: "停着", enabled: false }
    }
  });
}

async function call(route, path, method = "GET", body = null, headers = {}) {
  const res = new FakeRes();
  await route.handler(req(path, method, body, headers), res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

test("route declares the same write guard as /persona", () => {
  const { store, route } = setup();
  assert.ok(route, "route must be registered");
  assert.equal(route.kind, "exact");
  assert.equal(route.policy, "token-write");
  store.close();
});

test("PUT binds a session card and GET reports it as the effective source", async () => {
  const { store, settings, route } = setup();
  seed(settings);
  const put = await call(route, `${PATH}?session=s1`, "PUT", { sessionId: "s1", card: "ptc" });
  assert.equal(put.status, 200);
  assert.equal(put.json.source, "bySession");
  assert.equal(put.json.card, "Ptc");
  assert.equal(put.json.key, "s1");
  assert.equal(put.json.enabled, true);
  assert.deepEqual(settings.listPersonaSessions(), ["s1"]);

  const get = await call(route, `${PATH}?session=s1`);
  assert.equal(get.status, 200);
  assert.equal(get.json.source, "bySession");
  assert.equal(get.json.card, "Ptc");
  store.close();
});

test("PUT with an empty card unbinds and the session falls back", async () => {
  const { store, settings, route } = setup();
  seed(settings);
  await call(route, `${PATH}?session=s1`, "PUT", { sessionId: "s1", card: "ptc" });
  assert.deepEqual(settings.listPersonaSessions(), ["s1"]);

  const unbound = await call(route, `${PATH}?session=s1`, "PUT", { sessionId: "s1", card: "" });
  assert.equal(unbound.status, 200);
  assert.equal(unbound.json.source, "default");
  assert.equal(unbound.json.card, "Fallback");
  assert.deepEqual(settings.listPersonaSessions(), []);
  store.close();
});

test("unknown, disabled and malformed cards are rejected without writing", async () => {
  const { store, settings, route } = setup();
  seed(settings);

  const unknown = await call(route, `${PATH}?session=s1`, "PUT", { sessionId: "s1", card: "nope" });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, "unknown-card");

  const disabled = await call(route, `${PATH}?session=s1`, "PUT", { sessionId: "s1", card: "off" });
  assert.equal(disabled.status, 400);
  assert.equal(disabled.json.error, "card-disabled");

  const noSession = await call(route, `${PATH}?session=`, "PUT", { card: "ptc" });
  assert.equal(noSession.status, 400);
  assert.equal(noSession.json.error, "sessionId");

  const badCard = await call(route, `${PATH}?session=s1`, "PUT", { sessionId: "s1", card: { name: "x" } });
  assert.equal(badCard.status, 400);
  assert.equal(badCard.json.error, "card");

  // 一条都不许落库：拒绝就是拒绝，不是「建了一张空卡」。
  assert.deepEqual(settings.listPersonaSessions(), []);
  store.close();
});

test("GET reports all five sources, computed by resolvePersonaCard", async () => {
  const { store, settings, route } = setup();
  seed(settings);
  await call(route, `${PATH}?session=s1`, "PUT", { sessionId: "s1", card: "ptc" });

  const session = await call(route, `${PATH}?session=s1`);
  assert.equal(session.json.source, "bySession");

  // 子会话自己不建卡：继承父会话那张（与注入器同一档）。
  const parent = await call(route, `${PATH}?session=s2&parent=s1`);
  assert.equal(parent.json.source, "parentSession");
  assert.equal(parent.json.card, "Ptc");

  const agent = await call(route, `${PATH}?session=s3&agent=ptc`);
  assert.equal(agent.json.source, "byAgent");
  assert.equal(agent.json.key, "ptc");

  const fallback = await call(route, `${PATH}?session=s4`);
  assert.equal(fallback.json.source, "default");
  assert.equal(fallback.json.key, null);
  store.close();

  // none 要严格寻址才可能出现：建过卡、有身份、但这一身份没卡。
  const strict = setup({ personaStrictAddressing: true });
  seed(strict.settings);
  const none = await call(strict.route, `${PATH}?session=s5&agent=off`);
  assert.equal(none.json.source, "none");
  assert.equal(none.json.card, "");
  strict.store.close();
});

test("binding changes the injected text, and the route agrees with the injector", async () => {
  const { store, settings, route, config } = setup();
  seed(settings);

  const before = renderUserSettingsBlock({ settings, config, sessionId: "s1" });
  assert.equal(before.source, "default");
  assert.doesNotMatch(before.text, /Ptc/);

  await call(route, `${PATH}?session=s1`, "PUT", { sessionId: "s1", card: "ptc" });

  const after = renderUserSettingsBlock({ settings, config, sessionId: "s1" });
  assert.equal(after.source, "bySession");
  assert.notEqual(after.text, before.text);
  assert.match(after.text, /Ptc/);

  // 同源纪律：路由报的 source / 名字必须与注入器算出来的那份逐字一致。
  const get = await call(route, `${PATH}?session=s1`);
  assert.equal(get.json.source, after.source);
  assert.equal(get.json.card, "Ptc");
  store.close();
});

test("a write without the token is rejected and leaves the store alone", async () => {
  const { store, settings, route } = setup({}, "secret-token");
  seed(settings);
  const res = await call(route, `${PATH}?session=s1`, "PUT", { sessionId: "s1", card: "ptc" });
  assert.equal(res.status, 401);
  assert.deepEqual(settings.listPersonaSessions(), []);

  const authorized = await call(route, `${PATH}?session=s1`, "PUT", { sessionId: "s1", card: "ptc" },
    { authorization: "Bearer secret-token" });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.json.source, "bySession");
  store.close();
});