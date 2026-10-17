// 路由鉴权的结构锁（2026-10 审计 P0 的修法验证）。
// 这批用例锁的不是「某条路由要不要 token」，而是**鉴权不再靠人记得写**：
//   1. 新路由漏声明 policy → createApi / register 直接抛（起不来，而不是静默开放）
//   2. 同一路径重复登记 → 抛（防复制粘贴出两条同路径、其中一条没人管）
//   3. 三种 policy 的运行时语义（open / token / token-write）
//   4. 装配后的每条路由都带 policy，且 count() 与实际挂载数一致
// 之所以不写「39 条路由 × 方法的权限矩阵」：缺声明这条已经是装配期错误，
// 矩阵要抓的那类回归在结构上写不出来。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi, createRouteRegistrar, ROUTE_POLICIES } from "../src/api.js";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function fakeWebServer(mounted) {
  return { register(route) { mounted.push(route); return () => {}; } };
}

function req(method) {
  const r = new EventEmitter();
  r.url = "/x";
  r.method = method;
  r.headers = {};
  return r;
}

function registrar(apiToken = "secret-token") {
  const mounted = [];
  const { register, count } = createRouteRegistrar(fakeWebServer(mounted), apiToken, []);
  return { register, count, mounted };
}

test("漏声明 policy 的路由起不来（不是默认开放）", () => {
  const { register } = registrar();
  assert.throws(
    () => register({ kind: "exact", path: "/api/dsh-mneme/nope", handler() {} }),
    /必须声明 policy/
  );
  assert.throws(
    () => register({ kind: "exact", path: "/api/dsh-mneme/nope", policy: "public", handler() {} }),
    /必须声明 policy/
  );
});

test("同一 kind+path 重复登记会抛", () => {
  const { register } = registrar();
  register({ kind: "exact", path: "/api/dsh-mneme/dup", policy: "open", handler() {} });
  assert.throws(
    () => register({ kind: "exact", path: "/api/dsh-mneme/dup", policy: "open", handler() {} }),
    /重复登记/
  );
});

test("open：配了 token 也放行", () => {
  const { register, mounted } = registrar();
  let called = 0;
  register({ kind: "exact", path: "/api/dsh-mneme/open", policy: "open", handler() { called++; } });
  const res = new FakeRes();
  mounted[0].handler(req("GET"), res);
  assert.equal(called, 1);
  assert.equal(res.statusCode, 200);
});

test("token：任何方法都要 Bearer，handler 根本进不去", () => {
  const { register, mounted } = registrar();
  let called = 0;
  register({ kind: "exact", path: "/api/dsh-mneme/gated", policy: "token", handler() { called++; } });
  const denied = new FakeRes();
  mounted[0].handler(req("GET"), denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(called, 0);

  const okReq = req("GET");
  okReq.headers = { authorization: "Bearer secret-token" };
  const ok = new FakeRes();
  mounted[0].handler(okReq, ok);
  assert.equal(called, 1);
});

test("token-write：GET 开放、POST 要 Bearer", () => {
  const { register, mounted } = registrar();
  let called = 0;
  register({ kind: "exact", path: "/api/dsh-mneme/half", policy: "token-write", handler() { called++; } });
  mounted[0].handler(req("GET"), new FakeRes());
  assert.equal(called, 1, "GET 无 token 也放行");
  const denied = new FakeRes();
  mounted[0].handler(req("POST"), denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(called, 1, "POST 无 token 不进 handler");
});

test("装配后每条路由都带 policy，count() 与实际挂载数一致", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const mounted = [];
  const ctx = { webServer: fakeWebServer(mounted) };
  const api = createApi(ctx, service, settings, { add() {}, remove() {}, list: () => [] }, null, undefined, "secret-token");
  assert.ok(mounted.length >= 30, "路由数异常：" + mounted.length);
  for (const route of mounted) {
    assert.ok(ROUTE_POLICIES.includes(route.policy), route.path + " 的 policy 非法：" + route.policy);
    assert.equal(typeof route.handler, "function");
  }
  assert.equal(api.routes, mounted.length, "createApi 汇报的路由数必须等于实际挂载数");
});
