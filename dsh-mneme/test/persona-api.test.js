// Persona API routes: internal (/api/dsh-mneme/persona, requireAuth on write)
// and standalone (/persona behind the global Bearer gate).
// Locks: GET reads current value; unauthorized writes are rejected; a corrupt
// JSON body never lands in the store (design: reports/persona-page-design.md ②).
// Call shapes mirror test/api.test.js (route registry + FakeRes) and
// test/standalone-api.test.js (real server on port 0 + fetch).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { createStandaloneApi } from "../src/api-standalone.js";

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

function setupInternal(apiToken = "") {
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
  createApi(ctx, service, settings, commands, undefined, undefined, apiToken, {});
  const route = routes.find((r) => r.path === "/api/dsh-mneme/persona");
  return { store, settings, route, apiToken };
}

// ---- internal API（宿主内 /api/dsh-mneme/*） --------------------------------

test("internal GET /persona returns current persona without auth", async () => {
  const { store, settings, route } = setupInternal();
  settings.setPersona({ name: "Amarre", enabled: false });
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/persona"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).persona.name, "Amarre");
  store.close();
});

test("internal PUT /persona without token is rejected and store untouched", async () => {
  // setupInternal("t")：必须带 token 启动，无 token 的写请求才应被拒
  // （apiToken 为空时 isAuthorized 恒放行——与 /profile 的既有语义一致）。
  const { store, settings, route } = setupInternal("t");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/persona", "PUT", { persona: { name: "evil" } }), res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(settings.getPersona(), {});
  store.close();
});

test("internal PUT /persona with token round-trips; corrupt JSON body does not land", async () => {
  const { store, settings, route } = setupInternal("t");
  const headers = { authorization: "Bearer t" };
  const ok = new FakeRes();
  await route.handler(req("/api/dsh-mneme/persona", "PUT", { persona: { name: "Amarre", enabled: true } }, headers), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(settings.getPersona().name, "Amarre");
  const bad = new FakeRes();
  await route.handler(req("/api/dsh-mneme/persona", "PUT", "not json", headers), bad);
  // 路由层对坏 JSON 容错（parseBody 口径：坏体不清空库内值），原样回显现值
  assert.equal(bad.statusCode, 200);
  assert.equal(settings.getPersona().name, "Amarre");
  store.close();
});

// ---- standalone API（Bearer 数据面，真端口 + fetch） ------------------------

async function setupStandalone() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const api = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: 0 });
  await api.ready;
  const base = `http://127.0.0.1:${api.port}`;
  const auth = { authorization: `Bearer ${api.token}` };
  return {
    store, settings, base, auth,
    close: () => {
      api.server.closeIdleConnections?.();
      api.server.close();
      store.close();
    }
  };
}

test("standalone GET/PUT /persona behind Bearer gate round-trips", async () => {
  const t = await setupStandalone();
  try {
    const get1 = await fetch(`${t.base}/persona`, { headers: t.auth });
    assert.equal(get1.status, 200);
    assert.deepEqual((await get1.json()).persona, {});
    const put = await fetch(`${t.base}/persona`, {
      method: "PUT",
      headers: { ...t.auth, "content-type": "application/json" },
      body: JSON.stringify({ persona: { name: "Zelphi", enabled: false } })
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).persona.name, "Zelphi");
    const bad = await fetch(`${t.base}/persona`, {
      method: "PUT",
      headers: { ...t.auth, "content-type": "application/json" },
      body: "not json"
    });
    assert.equal(bad.status, 400);
    assert.equal(t.settings.getPersona().name, "Zelphi");
  } finally {
    t.close();
  }
});

test("standalone /persona without Bearer is 401", async () => {
  const t = await setupStandalone();
  try {
    const res = await fetch(`${t.base}/persona`, { method: "PUT", body: "{}" });
    assert.equal(res.status, 401);
    assert.deepEqual(t.settings.getPersona(), {});
  } finally {
    t.close();
  }
});
