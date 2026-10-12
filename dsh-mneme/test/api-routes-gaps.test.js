import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { createMaintenance } from "../src/maintenance.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 覆盖 PR#73 删测后遗留的三个存活 API 空白（v0.7.16 回归补测）：
//   /api/dsh-mneme/delete         面板删记忆（POST + auth + 存在性 404）
//   /api/dsh-mneme/entities       实体目录（只读、limit 夹取）
//   /api/dsh-mneme/external-api   独立服务配置（GET 发 token / PUT 校验）
// 这三个路由在 src/api.js 里一直在跑，只是丢了测试。

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

// ---------------------------------------------------------------------------
// /api/dsh-mneme/delete
// ---------------------------------------------------------------------------
test("delete is auth-gated and rejects non-POST", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/delete");

  // 未带 token → 401
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/delete", "POST", { id: "x" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, "unauthorized");

  // 带 token 但 GET → 404
  res = new FakeRes();
  const ok = req("/api/dsh-mneme/delete", "GET");
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 404);
});

test("delete validates id and reports missing/unknown 404", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/delete");

  // 空 id → 400
  let res = new FakeRes();
  let ok = req("/api/dsh-mneme/delete", "POST", { id: "  " });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "missing-id");

  // 不存在的 id → 404（store.remove 静默，靠前置 getById 区分）
  res = new FakeRes();
  ok = req("/api/dsh-mneme/delete", "POST", { id: "no-such-memory" });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "not-found");

  // 确认没被误删
  assert.equal(service.count(), 0);
});

test("delete removes an existing memory", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/delete");

  const { memory } = service.saveWithDedupe({ type: "project", title: "要删的", content: "删掉我" });
  assert.ok(service.getById(memory.id));

  const res = new FakeRes();
  const ok = req("/api/dsh-mneme/delete", "POST", { id: memory.id });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(service.getById(memory.id), undefined);
  assert.equal(service.count(), 0);
});

// ---------------------------------------------------------------------------
// /api/dsh-mneme/entities
// ---------------------------------------------------------------------------
test("entities directory is read-only and returns empty list", async () => {
  const { routes } = setup();
  const route = handler(routes, "/api/dsh-mneme/entities");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/entities"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { entities: [], total: 0 });
});

test("entities lists seeded entities without auth", async () => {
  const { routes, service } = setup("secret-token"); // 有 token 但读路由不校验
  service.createEntity({ name: "SQLite", type: "technology" });
  service.createEntity({ name: "记忆", type: "concept" });

  const route = handler(routes, "/api/dsh-mneme/entities");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/entities"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.total, 2);
  const names = data.entities.map((e) => e.name).sort();
  assert.deepEqual(names, ["SQLite", "记忆"]);
  for (const e of data.entities) {
    assert.ok(e.type, "each entity carries a type");
    assert.ok(Number.isInteger(e.mention_count));
  }
});

test("entities clamps limit to [1, 1000]", async () => {
  const { routes, service } = setup();
  for (let i = 0; i < 5; i++) service.createEntity({ name: `e${i}`, type: "concept" });
  const route = handler(routes, "/api/dsh-mneme/entities");

  // 夹取语义：NaN/0 先被 `|| 500` 兜底成 500（0 不再走 max(1,) 下限），
  // 负数才被夹到 1，超限（>1000）夹到 1000。断言按真实实现收紧。
  for (const [qs, want] of [["limit=abc", 5], ["limit=0", 5], ["limit=-10", 1], ["limit=5000", 5]]) {
    const res = new FakeRes();
    await route.handler(req(`/api/dsh-mneme/entities?${qs}`), res);
    const data = JSON.parse(res.body);
    assert.equal(data.entities.length, want, `${qs} → ${want} (got ${data.entities.length})`);
  }
});

// ---------------------------------------------------------------------------
// /api/dsh-mneme/external-api
// ---------------------------------------------------------------------------
test("external-api GET materializes and persists a token", async () => {
  const { routes, settings } = setup();
  const route = handler(routes, "/api/dsh-mneme/external-api");

  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/external-api"), res);
  assert.equal(res.statusCode, 200);
  const cfg = JSON.parse(res.body).config;
  assert.ok(typeof cfg.token === "string" && cfg.token.length >= 16, "token is generated");

  // 持久化后二次 GET 返回同一 token
  const res2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/external-api"), res2);
  assert.equal(JSON.parse(res2.body).config.token, cfg.token);
  assert.ok(settings.getExternalApi().token, "token persisted to settings kv");
});

test("external-api PUT requires auth and validates port/host", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/external-api");

  // 未带 token → 401
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/external-api", "PUT", { enabled: true }), res);
  assert.equal(res.statusCode, 401);

  // 端口越界 → 400
  res = new FakeRes();
  let ok = req("/api/dsh-mneme/external-api", "PUT", { port: 70000 });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-port");

  // host 带协议 → 400
  res = new FakeRes();
  ok = req("/api/dsh-mneme/external-api", "PUT", { host: "https://example.com" });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-host");
});

test("external-api PUT applies valid config and echoes it", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/external-api");

  const res = new FakeRes();
  const ok = req("/api/dsh-mneme/external-api", "PUT", { enabled: true, port: 8790, host: "127.0.0.1" });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 200);
  const cfg = JSON.parse(res.body).config;
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.port, 8790);
  assert.equal(cfg.host, "127.0.0.1");
  assert.ok(typeof cfg.token === "string");
});

// ---------------------------------------------------------------------------
// /api/dsh-mneme/create（#386 第 5 条：面板手动新增记忆）
// ---------------------------------------------------------------------------
// 这些用例锁的是「面板建行」与「工具建行」必须同语义：同一条 saveWithDedupe
// 路径、同一套去重键。历史缺口是面板只有看/改/删/导入，用户想手写一条必须开
// 终端或调外部 API——两条旁路都绕开了面板的去重提示。
test("create is auth-gated and rejects non-POST", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");
  assert.ok(route, "route must be registered");

  // 未带 token → 401（写路由与 /update、/delete 同口径）
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/create", "POST", { type: "project", title: "t", content: "c" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, "unauthorized");

  // 带 token 但 GET → 404（不是 405：与既有写路由一致，避免探测路由存在性）
  res = new FakeRes();
  const ok = req("/api/dsh-mneme/create", "GET");
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 404);
});

test("create validates type/title/content and refuses document rows", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");
  const post = async (body) => {
    const r = req("/api/dsh-mneme/create", "POST", body);
    r.headers = { authorization: "Bearer secret-token" };
    const res = new FakeRes();
    await route.handler(r, res);
    return res;
  };

  // 未知类型 → 400（TYPES 是唯一真相源，面板不得自己维护第二份白名单）
  let res = await post({ type: "not-a-type", title: "t", content: "c" });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-type");

  // document 是 registerDocument 的专属铸造口（#230）→ 干净 400，不落成 500
  res = await post({ type: "document", title: "t", content: "c" });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "document-requires-register");

  // 空白标题 / 空白正文 → 400（面板是人工输入，空正文只可能是误操作）
  res = await post({ type: "project", title: "   ", content: "c" });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-title");
  res = await post({ type: "project", title: "t", content: "  \n " });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-content");

  // importance 越界 / tags 非字符串数组 → 400，宁拒绝不静默纠正
  res = await post({ type: "project", title: "t", content: "c", importance: 9 });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-importance");
  res = await post({ type: "project", title: "t", content: "c", tags: [1, 2] });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-tags");

  // 全部被拒后一条都没落库
  assert.equal(service.count(), 0);
});

test("create saves a memory and reports action=created with 201", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");

  const r = req("/api/dsh-mneme/create", "POST", {
    type: "constraint",
    title: "面板手写一条",
    content: "正文",
    importance: 4,
    tags: ["panel"]
  });
  r.headers = { authorization: "Bearer secret-token" };
  const res = new FakeRes();
  await route.handler(r, res);

  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.action, "created");
  assert.equal(body.type, "constraint");
  assert.equal(body.title, "面板手写一条");
  assert.equal(body.importance, 4);
  assert.deepEqual(body.tags, ["panel"]);
  // source 必须能一眼认出是面板写的——详情抽屉把它当「来源」显示
  assert.equal(body.source, "panel");
  assert.ok(service.getById(body.id), "row really exists in the store");
});

test("create merges into an existing row with the same (type, title) and says so", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");
  service.saveWithDedupe({ type: "project", title: "同标题", content: "原来的正文" });

  const r = req("/api/dsh-mneme/create", "POST", { type: "project", title: "同标题", content: "追加的正文" });
  r.headers = { authorization: "Bearer secret-token" };
  const res = new FakeRes();
  await route.handler(r, res);

  // 200 而非 201：并入了既有行，没有新行诞生。面板据此提示「已并入」而不是
  // 「新建成功」——两者对用户是不同的事实。
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.action, "merged");
  assert.equal(service.count(), 1, "no second row was minted");
  assert.ok(service.getById(body.id).content.includes("追加的正文"));
});

test("create maps a denied write to 422 instead of leaking a 500", async () => {
  // #254 写入准入今天在无会话身份时放行（write-admission.js 首行早退），面板路由
  // 恰好不带 _sessionKey，所以这条分支当前到不了。仍然要锁：一旦有人把会话身份接
  // 进面板，落回 toApiList([null]) 会把「被拒」伪装成「服务器出错」——用户看到的
  // 是「新建失败」，实际是准入拒绝，两者的处置完全不同。
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");
  const original = service.saveWithDedupe;
  service.saveWithDedupe = () => ({ action: "denied", reason: "too-many-writes", memory: null });
  try {
    const r = req("/api/dsh-mneme/create", "POST", { type: "project", title: "t", content: "c" });
    r.headers = { authorization: "Bearer secret-token" };
    const res = new FakeRes();
    await route.handler(r, res);
    assert.equal(res.statusCode, 422);
    const body = JSON.parse(res.body);
    assert.equal(body.error, "write-rejected");
    assert.equal(body.reason, "too-many-writes", "the reason must survive: it is what makes the rejection actionable");
  } finally {
    service.saveWithDedupe = original;
  }
});

test("create returns 500 (not a leaked throw) when the store rejects the write", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");
  // 绕过路由校验直达 saveWithDedupe 的守卫：document 行会 throw。这里用打桩
  // 模拟「路由认为合法、存储层仍然拒绝」的那类情况（类型白名单漂移等）。
  const original = service.saveWithDedupe;
  service.saveWithDedupe = () => { throw new Error("invalid memory type: whatever"); };
  try {
    const r = req("/api/dsh-mneme/create", "POST", { type: "project", title: "t", content: "c" });
    r.headers = { authorization: "Bearer secret-token" };
    const res = new FakeRes();
    await route.handler(r, res);
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).error, "internal");
  } finally {
    service.saveWithDedupe = original;
  }
});

// ---------------------------------------------------------------------------
// /api/dsh-mneme/maintenance/reclaim（#386 第 4 条：存储回收的面板入口）
// ---------------------------------------------------------------------------
// 这条路由与 standalone 数据面的 POST /maintenance/reclaim 是同一个能力的两张皮，
// 底下是同一份 src/maintenance.js。锁盯的是两类回归：
//   a) 口径漂移——状态码、错误码字符串、默认值必须与 src/api-standalone.js:485-535
//      逐字一致，否则同一个动作在两个入口上给出不同的答复，客户端只能各写一套；
//   b) 最坏解释——dry-run 路径必须一个字节都不改；畸形输入绝不能被静默读成
//      olderThanDays=0（0 在这里的含义是「清掉全部快照」）。
const RECLAIM_PATH = "/api/dsh-mneme/maintenance/reclaim";

/**
 * 回收测试台。必须落在**文件库**上：`:memory:` 库的 storageStats().fileBytes 是
 * null（store.js:2134），而报告的口径就是「按 VACUUM 前后体积量」——用内存库测，
 * 体积那几格永远测不到数字。
 */
function reclaimSetup(apiToken = "secret-token", { logger = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-reclaim-api-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { logger, webServer: { register(route) { routes.push(route); return () => {}; } } };
  const maintenance = createMaintenance({ store, config: {}, logger });
  createApi(ctx, service, settings, commands, null, undefined, apiToken, null, maintenance);
  return {
    store, service, routes, maintenance,
    // 闭包拿 store，不用 this：裸函数调用下 this 是 undefined，异常被吞掉就会变成
    // 「库没关就删目录」的 EPERM（清理失败还说不清原因）。
    close() {
      try { store.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** 一条窗口外（30 天前）的 run 输入快照 + 一行带向量的归档行：让 planned/cleared
 *  都有非零数字，否则「cleared 非零」这类锁在恒零的报告上也能通过。 */
function seedReclaim(store) {
  store.saveDreamRun({
    id: "api-old-run",
    created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
    status: "ok",
    snapshot_hash: "h-api-old",
    input_count: 1,
    input: JSON.stringify([{ id: "m1", content: "x".repeat(600) }]),
    decisions: JSON.stringify([{ action: "keep", ids: ["m1"] }]),
    receipt: "dsh-mneme:run:api-old-run:ok:h-api-old"
  });
  const archived = store.save({ type: "project", title: "归档行", content: "归档内容" });
  store.setEmbedding(archived.id, [0.5, 0.25, 0.125]);
  store.setArchived(archived.id, true);
  return archived;
}

/**
 * 把三个「真会改数据」的原语换成计数器 + 透传。dry-run 的锁要说的都是同一句话：
 * 「这条路径上一行都没改」。只看返回数字不够——返回的 0 也可能是「改了但没报」。
 */
function spyWrites(store) {
  const calls = { clearDreamRunInputs: 0, clearArchivedEmbeddings: 0, vacuum: 0 };
  const orig = {
    clearDreamRunInputs: store.clearDreamRunInputs,
    clearArchivedEmbeddings: store.clearArchivedEmbeddings,
    vacuum: store.vacuum
  };
  store.clearDreamRunInputs = (...args) => { calls.clearDreamRunInputs += 1; return orig.clearDreamRunInputs(...args); };
  store.clearArchivedEmbeddings = (...args) => { calls.clearArchivedEmbeddings += 1; return orig.clearArchivedEmbeddings(...args); };
  store.vacuum = (...args) => { calls.vacuum += 1; return orig.vacuum(...args); };
  return {
    calls,
    restore() {
      store.clearDreamRunInputs = orig.clearDreamRunInputs;
      store.clearArchivedEmbeddings = orig.clearArchivedEmbeddings;
      store.vacuum = orig.vacuum;
    }
  };
}

/** 原始 body 版请求：畸形 JSON 锁要发的是**不能**被 JSON.stringify 出来的文本。 */
function reqRaw(path, method, text, headers = {}) {
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = headers;
  process.nextTick(() => {
    r.emit("data", Buffer.from(text));
    r.emit("end");
  });
  return r;
}

async function callReclaim(route, {
  path = RECLAIM_PATH, method = "GET", body = null, raw = false, token = "secret-token"
} = {}) {
  const sendBody = body !== null || raw;
  const r = sendBody
    ? reqRaw(path, method, raw ? body : JSON.stringify(body))
    : req(path, method);
  if (token !== null) r.headers = { authorization: `Bearer ${token}` };
  const res = new FakeRes();
  await route.handler(r, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

/** 从 `(` 起做括号配平扫描，返回整段调用的文本。路由调用里嵌着对象字面量与箭头
 *  函数，用 indexOf(");") 会先停在内层 `throw new Error(...)` 上。 */
function callText(src, start) {
  const open = src.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

test("reclaim is auth-gated on both methods and GET returns a dry-run", async () => {
  const bench = reclaimSetup();
  try {
    seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);
    assert.ok(route, "route must be registered on the panel API");

    // 不可逆内容丢弃的入口，两个方法都不能有例外。
    let out = await callReclaim(route, { token: null });
    assert.equal(out.status, 401);
    assert.equal(out.body.error, "unauthorized");

    out = await callReclaim(route, { method: "POST", body: {}, token: null });
    assert.equal(out.status, 401);

    out = await callReclaim(route);
    assert.equal(out.status, 200);
    assert.equal(out.body.dryRun, true, "GET 是只读预估，恒为 dry-run");
    assert.equal(out.body.olderThanDays, 7, "缺省用 DEFAULT_INPUT_RETENTION_DAYS");
  } finally {
    bench.close();
  }
});

test("reclaim GET honours olderThanDays and rejects malformed windows", async () => {
  const bench = reclaimSetup();
  try {
    seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);

    let out = await callReclaim(route, { path: `${RECLAIM_PATH}?olderThanDays=3` });
    assert.equal(out.status, 200);
    assert.equal(out.body.olderThanDays, 3);

    // 只收十进制整数字面量。`Number()` 会把 ""/[]/" " 化成 0，而 0 在这里是
    // 「清掉全部快照」——最坏解释绝不能从一个畸形输入静默拿到。
    for (const bad of ["abc", "-1", "", " ", "3.5", "0x2", "1e3", "[]", "null", "3d"]) {
      out = await callReclaim(route, { path: `${RECLAIM_PATH}?olderThanDays=${encodeURIComponent(bad)}` });
      assert.equal(out.status, 400, `olderThanDays=${JSON.stringify(bad)} 必须被拒`);
      assert.equal(out.body.error, "invalid-older-than-days");
    }

    // 边界值 0 是**合法**的（含义就是清全部），不能被上面那条锁顺手误伤。
    out = await callReclaim(route, { path: `${RECLAIM_PATH}?olderThanDays=0` });
    assert.equal(out.status, 200);
    assert.equal(out.body.olderThanDays, 0);

    // 量级也要挡：十进制字面量不保证是能算日期的数，400 位数字会化成 Infinity，
    // 而 maintenance 会拿它算 `now() - days * 86400000` 再 toISOString() 抛 RangeError。
    for (const huge of ["1" + "0".repeat(400), "100000000000000000000", "3651"]) {
      out = await callReclaim(route, { path: `${RECLAIM_PATH}?olderThanDays=${huge}` });
      assert.equal(out.status, 400, `olderThanDays=${huge} 必须被拒`);
      assert.equal(out.body.error, "invalid-older-than-days");
    }
    out = await callReclaim(route, { path: `${RECLAIM_PATH}?olderThanDays=3650` });
    assert.equal(out.status, 200, "上界本身是合法的");
    assert.equal(out.body.olderThanDays, 3650);
  } finally {
    bench.close();
  }
});

test("reclaim POST defaults to dry-run and writes nothing", async () => {
  const bench = reclaimSetup();
  try {
    seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);
    const spy = spyWrites(bench.store);
    try {
      const out = await callReclaim(route, { method: "POST", body: {} });
      assert.equal(out.status, 200);
      assert.equal(out.body.dryRun, true, "不显式要求就不执行");
      assert.equal(out.body.planned.dream_run_inputs, 1);
      assert.equal(spy.calls.clearDreamRunInputs, 0);
      assert.equal(spy.calls.clearArchivedEmbeddings, 0);
      assert.equal(spy.calls.vacuum, 0);
      assert.equal(bench.store.listLlmAudits().length, 0, "dry-run 不落回执");
    } finally {
      spy.restore();
    }
  } finally {
    bench.close();
  }
});

test("reclaim POST without confirm refuses to execute but hands back the dry-run report", async () => {
  const bench = reclaimSetup();
  try {
    seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);
    const spy = spyWrites(bench.store);
    try {
      const out = await callReclaim(route, { method: "POST", body: { dryRun: false, vacuum: true } });
      assert.equal(out.status, 400);
      assert.equal(out.body.error, "confirm-required");
      assert.match(out.body.hint, /dryRun/);
      assert.ok(out.body.report, "确认的依据就是这份数字，必须一并回给调用方");
      // 报告描述的必须是**将要执行的那个动作**：这里带了 vacuum 去执行，看到的
      // 数字就得是「会 VACUUM」的那一份，否则调用方照着「不 VACUUM」的估算按下去。
      assert.equal(out.body.report.vacuum.requested, true);
      assert.equal(out.body.report.dryRun, true);
      assert.equal(spy.calls.clearDreamRunInputs, 0, "拒绝执行就是真的一行都没改");
      assert.equal(spy.calls.clearArchivedEmbeddings, 0);
      assert.equal(spy.calls.vacuum, 0);
    } finally {
      spy.restore();
    }
  } finally {
    bench.close();
  }
});

test("reclaim POST with confirm executes and reports what it cleared", async () => {
  const bench = reclaimSetup();
  try {
    const archived = seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);

    const out = await callReclaim(route, {
      method: "POST",
      body: { dryRun: false, confirm: true, olderThanDays: 7, vacuum: false }
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.dryRun, false);
    assert.equal(out.body.olderThanDays, 7);
    assert.equal(out.body.cleared.dream_run_inputs, 1, "窗口外的输入快照真的被清了");
    assert.equal(out.body.cleared.archived_embeddings, 1);
    // 行数不变（这项回收只置列，不删行）——它「无损」的全部含义就在这里。
    assert.equal(bench.store.db.prepare("SELECT count(*) AS c FROM dream_runs").get().c, 1);
    assert.equal(bench.store.db.prepare("SELECT input FROM dream_runs WHERE id = 'api-old-run'").get().input, null);
    assert.equal(bench.store.db.prepare("SELECT embedding FROM memories WHERE id = ?").get(archived.id).embedding, null);
  } finally {
    bench.close();
  }
});

test("reclaim POST rejects a non-boolean vacuum", async () => {
  const bench = reclaimSetup();
  try {
    seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);

    for (const bad of ["yes", 1, 0, {}, []]) {
      const out = await callReclaim(route, { method: "POST", body: { vacuum: bad } });
      assert.equal(out.status, 400, `vacuum=${JSON.stringify(bad)} 必须被拒`);
      assert.equal(out.body.error, "invalid-vacuum");
    }
    // 显式 false 是合法的：面板的 checkbox 默认关，传的就是它。
    const ok = await callReclaim(route, { method: "POST", body: { vacuum: false } });
    assert.equal(ok.status, 200);
  } finally {
    bench.close();
  }
});

test("reclaim POST separates invalid-json from invalid-body", async () => {
  const bench = reclaimSetup();
  try {
    const route = handler(bench.routes, RECLAIM_PATH);

    // 发坏了（解析不了）与发成了非对象（null/数组）是两种不同的错，处置也不同：
    // 前者查客户端序列化，后者查调用方把数组当 body 传了。
    let out = await callReclaim(route, { method: "POST", raw: true, body: "{not json" });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "invalid-json");

    out = await callReclaim(route, { method: "POST", body: [] });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "invalid-body");

    out = await callReclaim(route, { method: "POST", raw: true, body: "null" });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "invalid-body");

    out = await callReclaim(route, { method: "POST", raw: true, body: "\"str\"" });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "invalid-body");
  } finally {
    bench.close();
  }
});

test("reclaim POST validates olderThanDays as a JSON number, not a string", async () => {
  const bench = reclaimSetup();
  try {
    seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);

    // POST 侧收的是 JSON 数字域：字符串 "3" 不是数字，必须拒——与 GET 的 query
    // 域口径不同（那边只有字符串可收）。两边都放宽等于把「畸形」重新放进来。
    // NaN 不在此列表里：JSON 表达不了它，stringify 会把它变成 null，而 null 在这里
    // 与缺省同义（落默认窗口）——拿它当坏输入只会测到 null 那条规则。
    for (const bad of ["3", -1, 3.5, true, {}, []]) {
      const out = await callReclaim(route, { method: "POST", body: { olderThanDays: bad } });
      assert.equal(out.status, 400, `olderThanDays=${JSON.stringify(bad)} 必须被拒`);
      assert.equal(out.body.error, "invalid-older-than-days");
    }
    // 量级也是「坏输入」：1e20 是整数，却会让 maintenance 算日期时抛 RangeError
    // （#410 评审）。400 位数字不在此列——它化成 Infinity，而 JSON.stringify 把
    // Infinity 写成 null，落进「与缺省同义」那条规则（GET 侧才测得到它）。
    for (const huge of [1e20, 1e21, 3651]) {
      const out = await callReclaim(route, { method: "POST", body: { olderThanDays: huge } });
      assert.equal(out.status, 400, `olderThanDays=${String(huge)} 必须被拒`);
      assert.equal(out.body.error, "invalid-older-than-days");
    }
    let ok = await callReclaim(route, { method: "POST", body: { olderThanDays: 0 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.olderThanDays, 0);
    ok = await callReclaim(route, { method: "POST", body: { olderThanDays: 3650 } });
    assert.equal(ok.status, 200, "上界本身是合法的");
    assert.equal(ok.body.olderThanDays, 3650);
    ok = await callReclaim(route, { method: "POST", body: { olderThanDays: null } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.olderThanDays, 7, "null 与缺省同义：落默认窗口，不是 0");
  } finally {
    bench.close();
  }
});

test("reclaim without the maintenance dependency answers 503 instead of crashing", async () => {
  // 既有 14 处 createApi(...) 调用全是位置传参、不传第 9 个。它们必须继续工作：
  // 「没接线」要如实报 unavailable，而不是把 undefined.reclaim 落成崩溃。
  const { routes } = setup("secret-token");
  const route = handler(routes, RECLAIM_PATH);
  assert.ok(route, "路由注册与接线无关，少传依赖也要注册出来");

  let out = await callReclaim(route);
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "maintenance-unavailable");

  out = await callReclaim(route, { method: "POST", body: {} });
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "maintenance-unavailable");

  // 顺序也是契约：端点整个没接线时，报「窗口不合法」是误导——调用方会去改窗口，
  // 改完照样 503。所以 503 必须赢过字段校验（数据面同一条，见 maintenance.test.js）。
  out = await callReclaim(route, { method: "POST", body: { olderThanDays: 1e20 } });
  assert.equal(out.status, 503, "没接线要赢过字段校验");
  assert.equal(out.body.error, "maintenance-unavailable");

  out = await callReclaim(route, { path: `${RECLAIM_PATH}?olderThanDays=abc` });
  assert.equal(out.status, 503, "GET 侧同样：没接线要赢过窗口校验");
  assert.equal(out.body.error, "maintenance-unavailable");
});

test("reclaim maps a throwing maintenance.reclaim to 500 instead of leaking", async () => {
  // 带 logger 跑：契约里 500 与 logger.warn 是一起要求的（没有日志的 500 在现场
  // 只剩一个「内部错误」，查不出是哪次回收炸的）。GET 那侧尤其要注意——外层 catch
  // 也能兜成 500，所以只断言状态码抓不住内层 catch 的消失，必须看日志。
  const warnings = [];
  const bench = reclaimSetup("secret-token", { logger: { warn: (m) => warnings.push(String(m)) } });
  try {
    const route = handler(bench.routes, RECLAIM_PATH);
    const original = bench.maintenance.reclaim;
    bench.maintenance.reclaim = () => { throw new Error("database is locked"); };
    try {
      let out = await callReclaim(route);
      assert.equal(out.status, 500);
      assert.equal(out.body.error, "internal");

      out = await callReclaim(route, { method: "POST", body: { dryRun: false, confirm: true } });
      assert.equal(out.status, 500);
      assert.equal(out.body.error, "internal");

      // confirm-required 那条也要算上：它在 readBody 的回调里算 dry-run 报告，外层 try
      // 那时已经退栈，漏了这道守卫就变成一个没人接的 rejection——客户端拿到的是「一个
      // 字节都没回」而不是 500（#410 评审指出的正是这条）。
      out = await callReclaim(route, { method: "POST", body: { dryRun: false } });
      assert.equal(out.status, 500, "confirm-required 的报告抛错必须回 500，不能无响应");
      assert.equal(out.body.error, "internal");

      assert.equal(warnings.length, 3, "三条会调 reclaim 的路径各留一条 warn");
      for (const w of warnings) {
        assert.match(w, /storage reclaim failed/);
        assert.match(w, /database is locked/, "原始错误文本要留住，否则现场无从下手");
      }
    } finally {
      bench.maintenance.reclaim = original;
    }
  } finally {
    bench.close();
  }
});

test("reclaim rejects non-GET/POST methods with 404", async () => {
  const bench = reclaimSetup();
  try {
    seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);
    const spy = spyWrites(bench.store);
    try {
      for (const method of ["PUT", "DELETE", "PATCH", "HEAD"]) {
        const out = await callReclaim(route, { method, body: { dryRun: false, confirm: true } });
        assert.equal(out.status, 404, `${method} 不该在这个路由上有语义`);
        assert.equal(out.body.error, "not-found");
      }
      assert.equal(spy.calls.clearDreamRunInputs, 0, "被 404 挡掉的方法一个字节都不能改");
    } finally {
      spy.restore();
    }
  } finally {
    bench.close();
  }
});

test("reclaim report has no wrapper layer: fields sit at the top level", async () => {
  const bench = reclaimSetup();
  try {
    seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);

    const out = await callReclaim(route);
    assert.equal(out.status, 200);
    // 报告形状由 src/maintenance.js 决定，路由只做搬运：加一层 { report } 会让
    // 面板与 standalone 两个客户端对不上同一个字段路径。
    assert.equal(typeof out.body.size.before_bytes, "number", "文件库必须给出真实体积");
    assert.ok(out.body.size.before_bytes > 0);
    assert.equal(typeof out.body.size.freelist_pages, "number");
    assert.equal(typeof out.body.duration_ms, "number");
    assert.deepEqual(Object.keys(out.body.planned).sort(), ["archived_embeddings", "dream_run_inputs"]);
    assert.deepEqual(Object.keys(out.body.vacuum).sort(), ["duration_ms", "error", "ran", "requested"]);
    assert.ok("receipt" in out.body);
    assert.ok("cutoff" in out.body);
  } finally {
    bench.close();
  }
});


test("reclaim POST executes VACUUM when asked, and reports it ran", async () => {
  const bench = reclaimSetup();
  try {
    const archived = seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);

    // vacuum 是**执行时**才有的动作：dry-run 只报「会 VACUUM」，真执行才跑。这条锁住
    // 「勾了 VACUUM 却静默不跑」——请求体里带 true，报告里 requested 与 ran 都得是
    // true，否则用户以为文件缩回去了，其实只是清了列。
    const out = await callReclaim(route, {
      method: "POST",
      body: { dryRun: false, confirm: true, olderThanDays: 7, vacuum: true }
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.dryRun, false);
    assert.equal(out.body.vacuum.requested, true, "请求里的 vacuum:true 必须传到实现层");
    assert.equal(out.body.vacuum.ran, true, "确认执行时 VACUUM 必须真的跑");
    assert.equal(out.body.vacuum.error, null);
    assert.equal(out.body.cleared.dream_run_inputs, 1);
    assert.equal(bench.store.db.prepare("SELECT input FROM dream_runs WHERE id = 'api-old-run'").get().input, null);
    assert.equal(bench.store.db.prepare("SELECT embedding FROM memories WHERE id = ?").get(archived.id).embedding, null);
  } finally {
    bench.close();
  }
});

test("reclaim confirm-required hands back a report for the same window it was asked about", async () => {
  const bench = reclaimSetup();
  try {
    seedReclaim(bench.store);
    const route = handler(bench.routes, RECLAIM_PATH);

    // 确认的依据就是这份报告里的数字。窗口传了 30 却回一份 7 天的估算，用户就是照着
    // 错的数字按下去——对不可逆动作来说这是最坏的一种错位。
    const out = await callReclaim(route, {
      method: "POST",
      body: { dryRun: false, olderThanDays: 30, vacuum: true }
    });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "confirm-required");
    assert.equal(out.body.report.olderThanDays, 30, "报告必须复述调用方要的那个窗口");
    assert.equal(out.body.report.vacuum.requested, true, "报告必须描述将要执行的那个动作");
    assert.equal(out.body.report.dryRun, true, "拒绝执行时给出的仍是 dry-run 报告");
  } finally {
    bench.close();
  }
});

test("wiring: maintenance is built before the panel createApi call and passed into it", () => {
  // 接线锁。webServer 块在 index.js 里先于原来的构造点执行，实例一旦建晚了，面板
  // 路由拿到的就是 null——功能「看起来加了」但每次都回 503。
  const src = readFileSync(join(root, "src", "index.js"), "utf8");
  const buildAt = src.indexOf("createMaintenance({");
  const callAt = src.indexOf("createApi(ctx, service, settings");
  assert.ok(buildAt >= 0, "src/index.js 里找不到 createMaintenance 构造");
  assert.ok(callAt >= 0, "src/index.js 里找不到面板 createApi 调用");
  assert.ok(buildAt < callAt, "维护实例必须在面板 createApi 之前构造");
  assert.match(callText(src, callAt), /maintenance/, "面板 createApi 调用必须把维护实例传进去");

  // 另一头：standalone 那条路（既有功能）不能因为上移而丢掉。
  const standaloneAt = src.indexOf("createStandaloneApi({");
  assert.ok(standaloneAt >= 0);
  assert.match(callText(src, standaloneAt), /maintenance/);
});

