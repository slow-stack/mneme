// issue #386 第 6 条（面板 bootstrap 入口）与第 7 条（配置键覆盖面）的服务端契约。
//
// 这一层要钉住的不是「路由存在」，而是三件容易在改动里悄悄走样的事：
//   1. /bootstrap 的 policy 是 token（写库），且先判 body 形状、再判能力接线——
//      顺序反了会把「你没给目录」报成「能力没接线」，把人引去查错的排查方向。
//   2. /config-keys 只回键名与计数，一个值都不回。apiToken 的名字必须出现（那正是
//      用户想知道它存在的原因），值必须不出现（那会是一处新泄漏面）。
//   3. 三份清单是真算出来的：panelEditable = 有默认值的白名单键，
//      fileOnly = schema 声明 − 白名单，undefaulted = 白名单 − 有默认值。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { Config } from "../src/config.js";
import { describeConfigKeys, schemaLeafKeys, defaultedLeafKeys, flagKeysFromSpec } from "../src/config-keys.js";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path, { method = "GET", body = null } = {}) {
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = {};
  // readBody 是事件式的（data/end），不是 async iterable：必须真的把事件发出去，
  // 否则 handler 会永远挂在那个 Promise 上（第一版测试就是这么挂死的）。
  setImmediate(() => {
    if (body !== null) r.emit("data", Buffer.from(body, "utf8"));
    r.emit("end");
  });
  return r;
}

function setup({ config = {}, apiToken = "" } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken, config);
  return { store, service, settings, routes };
}

const BOOTSTRAP = "/api/dsh-mneme/bootstrap";
const CONFIG_KEYS = "/api/dsh-mneme/config-keys";

async function call(routes, path, opts) {
  const route = routes.find((r) => r.path === path);
  assert.ok(route, `route ${path} must be registered`);
  const res = new FakeRes();
  await route.handler(req(path, opts), res);
  return { route, res, json: res.body ? JSON.parse(res.body) : null };
}

// --- /bootstrap -------------------------------------------------------------

test("bootstrap route is registered with the token policy", () => {
  const { routes } = setup({ apiToken: "secret-token" });
  const route = routes.find((r) => r.path === BOOTSTRAP);
  assert.ok(route, "route must be registered");
  // 它写库（虽然幂等），所以不能是 open；也不该借 token-write 的读写双义——这条
  // 路由没有 GET 分支，声明 token-write 只会让 SECURITY.md 的开放读清单多一条假的。
  assert.equal(route.policy, "token");
});

test("bootstrap demands a token when one is configured", async () => {
  const { routes } = setup({ apiToken: "secret-token" });
  const { res } = await call(routes, BOOTSTRAP, { method: "POST", body: JSON.stringify({ dir: "/tmp" }) });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, "unauthorized");
});

test("bootstrap rejects GET with 404 (no read branch exists)", async () => {
  const { routes } = setup();
  const { res } = await call(routes, BOOTSTRAP, { method: "GET" });
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "not-found");
});

test("bootstrap separates malformed JSON from a non-object body", async () => {
  const { routes } = setup();
  const bad = await call(routes, BOOTSTRAP, { method: "POST", body: "{not json" });
  assert.equal(bad.res.statusCode, 400);
  assert.equal(bad.json.error, "invalid-json");
  // 数组是合法 JSON 但不是「对象」：两个码分开，调用方才知道该改哪里。
  const arr = await call(routes, BOOTSTRAP, { method: "POST", body: "[]" });
  assert.equal(arr.res.statusCode, 400);
  assert.equal(arr.json.error, "invalid-body");
});

test("bootstrap validates dir before it decides whether the capability is wired", async () => {
  // 这条是顺序锁：给一个没有 saveWithDedupe 的装配 + 缺 dir 的 body。若先判能力，
  // 用户会看到「能力没接线」——而真正的问题是他没填目录。
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, {}, settings, { add: () => {}, remove: () => {}, list: () => [] }, null, undefined, "", {});
  const { res, json } = await call(routes, BOOTSTRAP, { method: "POST", body: JSON.stringify({}) });
  assert.equal(res.statusCode, 400);
  assert.equal(json.error, "missing-dir", "缺 dir 必须报 missing-dir，不能报 bootstrap-unavailable");
});

test("bootstrap reports the coded error when the directory does not exist", async () => {
  const { routes, service } = setup();
  const { res, json } = await call(routes, BOOTSTRAP, {
    method: "POST",
    body: JSON.stringify({ dir: "/definitely/not/here/386-bootstrap" })
  });
  assert.equal(res.statusCode, 400);
  assert.equal(json.error, "dir-not-found");
  // 失败路径不能留下半截记忆：目录都没读到，一条都不该落库。
  assert.equal(service.count({}), 0);
});

test("bootstrap imports deterministic artifacts from a real directory", async () => {
  const { routes, service } = setup();
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mneme-386-"));
  try {
    fs.writeFileSync(path.join(dir, "README.md"), "# sample project\n\nA tiny fixture.\n", "utf8");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sample", scripts: { build: "tsc -p ." } }), "utf8");
    const { res, json } = await call(routes, BOOTSTRAP, { method: "POST", body: JSON.stringify({ dir }) });
    assert.equal(res.statusCode, 200);
    assert.ok(json.created >= 2, `expected at least 2 imported rows, got ${JSON.stringify(json)}`);
    assert.equal(json.dir, fs.realpathSync(dir));
    // 「返回成功不等于生效」：去看库里到底有没有那几行。
    const rows = service.list({ limit: 20, includeArchived: false });
    assert.ok(rows.length >= 2, "the response must correspond to rows that actually exist");
    assert.ok(rows.every((m) => (m.tags || []).includes("bootstrap")), "every imported row carries the bootstrap tag");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- /config-keys -----------------------------------------------------------

test("config-keys route is open and read-only", async () => {
  const { routes } = setup({ apiToken: "secret-token" });
  const { route, res } = await call(routes, CONFIG_KEYS, { method: "GET" });
  assert.equal(route.policy, "open");
  assert.equal(res.statusCode, 200, "read-only route must not demand a token");
});

test("config-keys rejects non-GET", async () => {
  const { routes } = setup();
  const { res } = await call(routes, CONFIG_KEYS, { method: "POST", body: "{}" });
  assert.equal(res.statusCode, 404);
});

test("config-keys returns key names but never the apiToken value", async () => {
  const { routes } = setup({ config: { apiToken: "super-secret-value" }, apiToken: "super-secret-value" });
  const { res } = await call(routes, CONFIG_KEYS, { method: "GET" });
  assert.equal(res.statusCode, 200);
  // 名字必须在：用户正是要靠这份清单知道「apiToken 只能改配置文件」。
  assert.ok(res.body.includes("apiToken"), "the key name must be listed");
  // 值必须不在：这条断言是这整条路由存在的安全边界。
  assert.ok(!res.body.includes("super-secret-value"), "the value must never leave the server");
});

test("config-keys only reads the schema — it never echoes a configured value", async () => {
  // 上一条锁的是「没漏出去」，这条锁的是「不是靠脱敏才没漏」：即便装了一个
  // 非敏感键的值，响应里也不该出现它——这份清单只谈键名与计数。
  const { routes } = setup({ config: { memoryDir: "/unique/marker/path/386" } });
  const { res } = await call(routes, CONFIG_KEYS, { method: "GET" });
  assert.ok(!res.body.includes("/unique/marker/path/386"), "no configured value may appear in this response");
});

test("config-keys partitions the two source lists without losing anything", async () => {
  const d = describeConfigKeys();
  const declared = schemaLeafKeys();
  const defaulted = defaultedLeafKeys();
  const flags = flagKeysFromSpec();
  assert.equal(d.counts.schemaLeaf, declared.length);
  assert.equal(d.counts.flag, flags.length);
  // 并集必须正好铺满「schema 声明 ∪ 白名单」，一个键都不许漏在三个桶之外。
  const union = new Set([...d.panelEditable, ...d.fileOnly, ...d.undefaulted]);
  const expected = new Set([...declared, ...flags]);
  assert.deepEqual([...union].sort(), [...expected].sort());
  // 两个等式同时成立，才说明三个桶互不相交且覆盖完整。注意第一个等式要把
  // undefaulted 也加进去：dreamProvider / dreamModel 既是 schema 声明的键、又挂在
  // 白名单上，它既不属于 panelEditable（没默认值）也不属于 fileOnly（白名单有它），
  // 只落在 undefaulted 这一个桶里。
  assert.equal(d.panelEditable.length + d.fileOnly.length + d.undefaulted.length, declared.length);
  assert.equal(d.panelEditable.length + d.undefaulted.length, flags.length);
  // 白名单里每个键都必须在 schema 里声明过——否则那是登记了一个不存在的键。
  for (const key of flags) assert.ok(expected.has(key), `flag ${key} is not declared in the schema`);
  // 有默认值的键必须都被 schema 声明覆盖（反向包含，防 schema 漏声明）。
  for (const key of defaulted) assert.ok(declared.includes(key), `defaulted key ${key} is missing from the schema declaration`);
});

test("config-keys flags keys that the whitelist registers without a schema default", async () => {
  const d = describeConfigKeys();
  // dreamProvider / dreamModel 在 settings.js 白名单里，但 config.js 只有
  // z.string().description(...) 没有 .default()。面板因此有个永远不进 effective 的
  // 输入框——这正是 #386 第 7 条说的「不对称」，必须被告知而不是被悄悄抹平。
  assert.deepEqual(d.undefaulted.sort(), ["dreamModel", "dreamProvider"]);
});

test("config-keys lists file-only keys that users actually hit (apiToken, memoryDir, maxInjectedItems)", async () => {
  const d = describeConfigKeys();
  // apiToken 是最要紧的一个：它没有默认值，所以「拿解析结果当 schema」的写法会把它
  // 整个漏掉——第一版正是这么错的，这条用例是那个错的回归锁。
  assert.ok(d.fileOnly.includes("apiToken"), "apiToken must be visible as file-only");
  // 另外两个是 issue 原文点名的键：用户能理解、却在面板上找不到。
  assert.ok(d.fileOnly.includes("memoryDir"));
  assert.ok(d.fileOnly.includes("maxInjectedItems"));
  // 反向：一个面板确实能改的键，绝不能被列进 fileOnly。
  assert.ok(!d.fileOnly.includes("autoInject"));
});
