// 知识库 HTTP 面的形状锁（契约 §3.6 的路径表）。这些用例防的是三类回归：
// 1) 路径/方法/请求体字段与 C 线面板对不上（两边各自发挥 → 面板「点了没反应」）；
// 2) 漏声明 policy 或同一 kind+path 重复登记（src/api.js 的 registrar 会直接抛，
//    插件起不来——所以这里用真的 registrar 语义手搓一个会抛的假 register）；
// 3) 应答把错误吞掉（来源找不到却回 200 + ok:true，面板就会显示「已入库」）。
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createStore } from "../src/store.js";
import { createKb } from "../src/kb/index.js";
import { registerKbRoutes } from "../src/kb/routes.js";
import { kbToolDefinitions } from "../src/kb/tools.js";

const POLICIES = ["open", "token", "token-write"];

async function rmTempEventually(dir) {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
}

/** 手搓一个与 createRouteRegistrar 同语义的假 register（校验 policy + 拒重复）。 */
function makeRegistrar() {
  const seen = new Map();
  const routes = [];
  const register = (route) => {
    assert.ok(POLICIES.includes(route.policy), `路由 ${route.path} 漏了 policy`);
    const key = `${route.kind}:${route.path}`;
    assert.ok(!seen.has(key), `路由 ${key} 被重复登记`);
    seen.set(key, route);
    routes.push(route);
  };
  return { register, routes };
}

function makeReq({ method = "GET", url = "/", body = null } = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body, "utf8")]);
  req.method = method;
  req.url = url;
  return req;
}

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false };
  res.setHeader = () => {};
  res.writeHead = (code) => { res.statusCode = code; res.headersSent = true; return res; };
  res.end = (payload) => { if (payload) res.body = JSON.parse(String(payload)); };
  return res;
}

const sendJson = (res, status, payload) => {
  res.writeHead(status);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
};

/**
 * 装好路由并直接调 handler。install 的 readBody/parseBody 与 src/api.js 的同名
 * 函数同语义（超限回 null、坏 JSON 回 {}），这样测的是真分支而不是理想化输入。
 */
function install({ kb, gate, cfg = {} } = {}) {
  const { register, routes } = makeRegistrar();
  registerKbRoutes(register, {
    kb,
    cfg,
    sendJson,
    gate,
    readBody: async (req) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return Buffer.concat(chunks).toString("utf8");
    },
    parseBody: (text) => {
      try { return JSON.parse(text || "{}"); } catch { return {}; }
    }
  });
  const byPath = (path) => {
    const found = routes.filter((r) => r.path === path);
    assert.equal(found.length, 1, `路径 ${path} 应有且仅有一条`);
    return found[0];
  };
  const call = async (path, opts) => {
    // 注册表按无 query 的路径索引；调用点传的是「路径 + query」的完整 URL。
    const route = byPath(path.split("?")[0]);
    const req = makeReq({ url: path, ...opts });
    const res = makeRes();
    await route.handler(req, res);
    return res;
  };
  return { routes, call, byPath };
}

function newKb() {
  const store = createStore(":memory:");
  return { store, kb: createKb({ store, cfg: {} }) };
}

test("六条路由全在场，路径与 policy 严格照 §3.6 的表", () => {
  const { store, kb } = newKb();
  try {
    const { routes } = install({ kb });
    const table = routes.map((r) => `${r.kind}:${r.path}:${r.policy}`).sort();
    assert.deepEqual(table, [
      "exact:/api/dsh-mneme/kb/collections:token-write",
      "exact:/api/dsh-mneme/kb/doc:token",
      "exact:/api/dsh-mneme/kb/docs:token",
      "exact:/api/dsh-mneme/kb/ingest:token-write",
      "exact:/api/dsh-mneme/kb/search:token-write"
    ].sort());
  } finally {
    store.close();
  }
});

test("kb 未装配时全部 503，不抛也不静默 200", async () => {
  const { call } = install({ kb: null });
  for (const [path, opts] of [
    ["/api/dsh-mneme/kb/collections", { method: "GET" }],
    ["/api/dsh-mneme/kb/docs", { method: "GET", url: "/api/dsh-mneme/kb/docs?collection=c" }],
    ["/api/dsh-mneme/kb/doc", { method: "GET", url: "/api/dsh-mneme/kb/doc?collection=c&relKey=x" }],
    ["/api/dsh-mneme/kb/ingest", { method: "POST", body: "{}" }],
    ["/api/dsh-mneme/kb/search", { method: "POST", body: "{}" }]
  ]) {
    const res = await call(path, opts);
    assert.equal(res.statusCode, 503, `${path} 应 503`);
    assert.equal(res.body.error, "unavailable");
  }
});

test("传入的 gate 原样生效（关着时 409 由 gate 回，路由自己不再判）", async () => {
  const { store, kb } = newKb();
  try {
    let gateCalls = 0;
    const { call } = install({
      kb,
      gate: (_req, res) => {
        gateCalls += 1;
        sendJson(res, 409, { error: "disabled", reason: "kb-not-enabled" });
        return false;
      }
    });
    const res = await call("/api/dsh-mneme/kb/collections", { method: "GET" });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.reason, "kb-not-enabled");
    assert.equal(gateCalls, 1, "每个请求过且只过一次 gate");
  } finally {
    store.close();
  }
});

test("集合：POST 建 → GET 列出 → DELETE 按 query key 删，重复删 deleted:false", async () => {
  const { store, kb } = newKb();
  try {
    const { call } = install({ kb });

    let res = await call("/api/dsh-mneme/kb/collections", {
      method: "POST",
      body: JSON.stringify({ key: "manual", title: "手册", description: "内部" })
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, key: "manual" });

    res = await call("/api/dsh-mneme/kb/collections", { method: "GET" });
    assert.equal(res.body.collections.length, 1);
    assert.equal(res.body.collections[0].key, "manual");
    assert.equal(res.body.collections[0].docs, 0);

    // 缺 key 是 400，不是默默建一个空 key 的集合。
    res = await call("/api/dsh-mneme/kb/collections", { method: "POST", body: "{}" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "key-required");

    res = await call("/api/dsh-mneme/kb/collections?key=manual", { method: "DELETE" });
    assert.deepEqual(res.body, { ok: true, deleted: true });

    res = await call("/api/dsh-mneme/kb/collections?key=manual", { method: "DELETE" });
    assert.deepEqual(res.body, { ok: true, deleted: false }, "重复删是 false 不是 500");
  } finally {
    store.close();
  }
});

test("ingest：成功回 ok:true + skipped 语义透出；坏 body / 缺字段 / 拼错集合各走各的码", async () => {
  const { store, kb } = newKb();
  const dir = mkdtempSync(join(tmpdir(), "kb-routes-"));
  try {
    const { call } = install({ kb });
    await call("/api/dsh-mneme/kb/collections", {
      method: "POST",
      body: JSON.stringify({ key: "c", title: "C" })
    });
    const src = join(dir, "a.md");
    writeFileSync(src, "## 节\n路由测试内容 router\n", "utf8");

    let res = await call("/api/dsh-mneme/kb/ingest", {
      method: "POST",
      body: JSON.stringify({ collection: "c", kind: "file", source: src })
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.skipped, false);
    assert.ok(res.body.chunks >= 1);
    assert.ok(res.body.docId > 0);

    // 再入库：skipped 必须透传到 HTTP 面（面板据此不显示「重新索引了」）。
    res = await call("/api/dsh-mneme/kb/ingest", {
      method: "POST",
      body: JSON.stringify({ collection: "c", kind: "file", source: src })
    });
    assert.equal(res.body.skipped, true);

    // 缺字段 → 400。
    res = await call("/api/dsh-mneme/kb/ingest", { method: "POST", body: "{}" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "collection-kind-source-required");

    // 坏 JSON 不崩：parseBody 回 {} → 同样落到缺字段 400。
    res = await call("/api/dsh-mneme/kb/ingest", { method: "POST", body: "{not json" });
    assert.equal(res.statusCode, 400);

    // 拼错集合 → 404（且不凭空建集合）。
    res = await call("/api/dsh-mneme/kb/ingest", {
      method: "POST",
      body: JSON.stringify({ collection: "ghost", kind: "file", source: src })
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, "collection-not-found");
    assert.equal(kb.listCollections().length, 1);

    // kind 非法 → 400。
    res = await call("/api/dsh-mneme/kb/ingest", {
      method: "POST",
      body: JSON.stringify({ collection: "c", kind: "pdf", source: src })
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "bad-kind");

    // 来源不存在 → **200 + ok:false**：kb_docs 已留 error 行，面板要能显示原因；
    // 回 4xx 会让面板当成「请求错了」把那条记录丢掉。
    res = await call("/api/dsh-mneme/kb/ingest", {
      method: "POST",
      body: JSON.stringify({ collection: "c", kind: "file", source: join(dir, "nope.md") })
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "file-not-found");

    const docs = await call("/api/dsh-mneme/kb/docs?collection=c", { method: "GET" });
    assert.equal(docs.body.docs.length, 2);
    assert.equal(docs.body.docs.filter((d) => d.status === "error").length, 1);
  } finally {
    await rmTempEventually(dir);
    store.close();
  }
});

test("search / doc：命中形状与 readDoc 走 query 参数；查不到回 404", async () => {
  const { store, kb } = newKb();
  const dir = mkdtempSync(join(tmpdir(), "kb-routes-"));
  try {
    const { call } = install({ kb });
    await call("/api/dsh-mneme/kb/collections", {
      method: "POST",
      body: JSON.stringify({ key: "c", title: "C" })
    });
    const src = join(dir, "s.md");
    const original = "# 题\n\n## 检索\n这里有 needle 这个词。\n";
    writeFileSync(src, original, "utf8");
    await call("/api/dsh-mneme/kb/ingest", {
      method: "POST",
      body: JSON.stringify({ collection: "c", kind: "file", source: src })
    });

    let res = await call("/api/dsh-mneme/kb/search", {
      method: "POST",
      body: JSON.stringify({ query: "needle" })
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.hits.length, 1);
    assert.deepEqual(res.body.unreadable, []);
    assert.equal(res.body.hits[0].collection, "c");
    assert.equal(res.body.hits[0].relKey, src);
    assert.equal(res.body.hits[0].heading, "检索");

    // 空 query 是 400：回 200 + 空 hits 会让模型以为「库里没这个」。
    res = await call("/api/dsh-mneme/kb/search", { method: "POST", body: JSON.stringify({ query: "  " }) });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "query-required");

    // GET 打 search 是 405（不是静默 200）。
    res = await call("/api/dsh-mneme/kb/search", { method: "GET" });
    assert.equal(res.statusCode, 405);

    res = await call(
      `/api/dsh-mneme/kb/doc?collection=c&relKey=${encodeURIComponent(src)}`,
      { method: "GET" }
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.content, original);
    assert.equal(res.body.title, "s.md");

    res = await call("/api/dsh-mneme/kb/doc?collection=c&relKey=nope", { method: "GET" });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, "doc-not-found");

    res = await call("/api/dsh-mneme/kb/doc?collection=c", { method: "GET" });
    assert.equal(res.statusCode, 400);
  } finally {
    await rmTempEventually(dir);
    store.close();
  }
});

test("三个工具的形状：名字/只读性/execute 在 kb 缺席时给人话", async () => {
  const { store, kb } = newKb();
  const dir = mkdtempSync(join(tmpdir(), "kb-tools-"));
  try {
    const defs = kbToolDefinitions({ kb, cfg: {} });
    assert.deepEqual(defs.map((d) => d.name).sort(), ["kb_list_collections", "kb_read_doc", "kb_search"]);
    for (const d of defs) {
      assert.equal(typeof d.description, "string");
      assert.ok(d.description.length > 20, `${d.name} 的描述要能指导模型`);
      assert.equal(typeof d.parameters, "object");
      assert.equal(typeof d.output?.schema, "object");
      assert.equal(typeof d.output?.render, "function");
      assert.equal(typeof d.execute, "function");
      // 只读红线：参数里不许出现任何「写」味的东西（工具侧只有读口）。
      assert.ok(!/ingest|upsert|delete|write/i.test(d.name));
    }

    await kb.upsertCollection({ key: "c", title: "C" });
    const src = join(dir, "t.md");
    writeFileSync(src, "## 节\ntool content\n", "utf8");
    await kb.ingest({ collection: "c", kind: "file", source: src });

    const [list, search, read] = [
      defs.find((d) => d.name === "kb_list_collections"),
      defs.find((d) => d.name === "kb_search"),
      defs.find((d) => d.name === "kb_read_doc")
    ];

    const listed = await list.execute({});
    assert.equal(listed.collections.length, 1);
    assert.equal(listed.collections[0].key, "c");

    const hit = await search.execute({ query: "tool" });
    assert.equal(hit.hits.length, 1);
    assert.deepEqual(hit.unreadable, []);

    const doc = await read.execute({ collection: "c", relKey: src });
    assert.equal(doc.content, "## 节\ntool content\n");
    assert.equal(doc.title, "t.md");

    // 查不到要抛（模型看到的是「不存在」而不是空串——空串会被当成空文档继续编）。
    await assert.rejects(() => read.execute({ collection: "c", relKey: "/nope" }), /was not found/);
    await assert.rejects(() => search.execute({ query: "  " }), /query is required/);
    await assert.rejects(() => read.execute({ collection: "c" }), /both required/);

    // render 不能因为空结果就炸（回执里 hits/collections 可能是空数组）。
    assert.ok(list.output.render({}, { collections: [] })[0].text.includes("0 collections"));
    assert.ok(search.output.render({}, { hits: [] })[0].text.includes("0 hits"));

    // 未装配：不返回 undefined.name，而是明确抛一句人话。
    const orphan = kbToolDefinitions({ kb: null })[0];
    await assert.rejects(() => orphan.execute({}), /not available/);
  } finally {
    await rmTempEventually(dir);
    store.close();
  }
});
