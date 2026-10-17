// 2026-10 供应链与代码安全审计的回归锁（宿主内 API 面）。
// 锁的是四件事，防的回归各写在各用例注释里：
//   1. /export 不再对任何调用方开放（审计 P0：配了 apiToken 也照旧全库导出）
//   2. /external-api 的 GET 与 PUT 同门（审计 P0：未鉴权 GET 会明文回吐 8790 的
//      Bearer，而且顺手把 token 铸造进库——一条不需要凭证的写路径）
//   3. list/search 的分页参数有上界（免鉴权读面 + 浏览器简单请求 = 廉价 DoS）
//   4. readBody 不再无界累积（4 MiB 上限，超限走 400 而不是把内存交给调用方）
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";

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

function setup(apiToken = "") {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken);
  return { store, service, routes, settings };
}

function handler(routes, path) {
  return routes.find((r) => r.path === path);
}

test("/export 在配置 apiToken 后必须带 Bearer", async () => {
  // 审计 P0：这条路由长期没有鉴权分支，即使配了 token 也把全库（含
  // archived/forgotten 全字段）交给任何能打到端口的人。
  const { routes, service } = setup("secret-token");
  service.saveWithDedupe({ type: "preference", title: "甲", content: "内容甲" });
  const route = handler(routes, "/api/dsh-mneme/export");

  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/export"), res);
  assert.equal(res.statusCode, 401, "无 token → 401");
  assert.equal(JSON.parse(res.body).error, "unauthorized");

  res = new FakeRes();
  const ok = req("/api/dsh-mneme/export?format=json");
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 200, "带对 token → 200");
  assert.equal(JSON.parse(res.body).count, 1);
});

test("/external-api 的 GET 与 PUT 同门，未鉴权不铸造 token", async () => {
  // 两个回归一起锁：①未鉴权 GET 能把 8790 的 Bearer 明文读走；②那次 GET 还会
  // 顺手 randomBytes 铸造并持久化一个 token——没有凭证的写路径。
  const { routes, settings } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/external-api");

  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/external-api"), res);
  assert.equal(res.statusCode, 401);
  assert.equal(settings.getExternalApi()?.token, undefined, "未鉴权请求不得铸造 token");

  const ok = req("/api/dsh-mneme/external-api");
  ok.headers = { authorization: "Bearer secret-token" };
  const res2 = new FakeRes();
  await route.handler(ok, res2);
  assert.equal(res2.statusCode, 200);
  assert.ok(JSON.parse(res2.body).config.token.length >= 16, "鉴权后照旧发 token");
});

test("list 的 limit 被上界钳制", async () => {
  // 上界是防御：limit 直接进 SQL LIMIT，?limit=100000 会让一次免鉴权 GET 把
  // 全库序列化出来（浏览器 <img> 就能触发）。
  const { routes, service } = setup();
  let seen = null;
  const original = service.list;
  service.list = (args) => { seen = args; return []; };
  const res = new FakeRes();
  await handler(routes, "/api/dsh-mneme/list").handler(req("/api/dsh-mneme/list?limit=100000"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.limit, 1000);
  service.list = original;
});

test("search 的 topK 被上界钳制", async () => {
  const { routes, service } = setup();
  let seen = null;
  const original = service.searchMemories;
  service.searchMemories = (q, opts) => { seen = opts; return []; };
  const res = new FakeRes();
  await handler(routes, "/api/dsh-mneme/search").handler(req("/api/dsh-mneme/search?q=abc&topK=100000"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.topK, 200);
  service.searchMemories = original;
});

function oversizedPost(path, method = "POST") {
  const huge = Buffer.from("{\"content\":\"" + "x".repeat(5 * 1024 * 1024) + "\"}");
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = {};
  process.nextTick(() => { r.emit("data", huge); r.emit("end"); });
  return r;
}

test("超大请求体回 413，且不落库", async () => {
  // 4 MiB 上限。断言必须是**明确的 413**：旧写法只断言 notEqual(200)，而 /create
  // 成功时回 201——一个真被写进去的超限请求也能让那条断言通过（评审指出的空断言）。
  const { routes, service } = setup();
  const before = service.all().length;
  const res = new FakeRes();
  await handler(routes, "/api/dsh-mneme/create").handler(oversizedPost("/api/dsh-mneme/create"), res);
  assert.equal(res.statusCode, 413);
  assert.equal(JSON.parse(res.body).error, "payload-too-large");
  assert.equal(service.all().length, before, "超限请求不得留下任何记忆");
});

test("超大请求体不会清空画像／规则", async () => {
  // 这是最要命的一条：readBody 旧实现超限回空串 → parseBody 得到 {} →
  // setProfile("") / setRules([]) 把既有内容静默清掉。413 必须在碰 store 之前。
  const { routes, settings } = setup("secret-token");
  settings.setProfile("原有画像");
  settings.setRules(["原有规则"]);

  for (const [path, method] of [["/api/dsh-mneme/profile", "PUT"], ["/api/dsh-mneme/rules", "PUT"]]) {
    const res = new FakeRes();
    const req = oversizedPost(path, method);
    req.headers = { authorization: "Bearer secret-token" };
    await handler(routes, path).handler(req, res);
    assert.equal(res.statusCode, 413, path + " 超限应回 413");
  }
  assert.equal(settings.getProfile(), "原有画像", "超限请求不得清空画像");
  assert.deepEqual(settings.getRules(), ["原有规则"], "超限请求不得清空规则");
});
