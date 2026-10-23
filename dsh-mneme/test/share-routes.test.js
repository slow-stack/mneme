// 分享包的**两张皮**路由锁。盯四件事：
//   a) policy 归对（token —— 它是全库级读取，与 /export 同门，见 2026-10 审计 P0）；
//   b) token 配上时**不带 token 必须 401**，不是静默放行；
//   c) readBody 返回 null（超 4 MiB，它自己已答 413）时 handler 必须直接 return，
//      不能再答一次 —— 双写响应是 #410 那一类故障；
//   d) 500 必须留下日志：shareReply 把抛错兜成 500，不接 warn 回调时那条 500 是静默的
//      （现场只剩「内部错误」，查不出是哪一次打包炸的）。同款契约见 reclaim 的 500 用例。
// 装配台照 test/api-routes-gaps.test.js 的 reclaimSetup，**必须落文件库**：`:memory:`
// 与文件库在 store.all() 的读侧口径上没差别，但分享包吃的正是「全库含归档/已遗忘」，
// 用内存库时归档位的字节口径与体积水位都摸不到真实数字（同 reclaim 报告的理由）。
//
// 后半截是 Bearer 数据面（src/api-standalone.js）的真 HTTP 装配，起服务与读 token 的
// 形状照 test/standalone-api.test.js。放同一份文件里是有意的：#411 说两张皮只许差在
// 鉴权与路径，那么「同一份答复」就是两侧共同的不变量——分开两个文件时，改一侧的人
// 看不见另一侧锁着什么。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";
import { createStandaloneApi } from "../src/api-standalone.js";

const SHARE_PATH = "/api/dsh-mneme/share";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

class FakeRes extends EventEmitter {
  constructor({ failFirstHead = false } = {}) {
    super();
    this.statusCode = 0;
    this.body = "";
    this.headers = null;
    // writeHead 计数：双写响应的故障形态是「第二次 writeHead 覆盖掉第一次的状态码」，
    // 只看最终 statusCode 抓不住（413 之后又被 200 盖掉时 body 也换了），要数次数。
    this.heads = 0;
    // 一次性坏掉的 sink：真 socket 上「一个响应两写」的现场形态就是第二次 writeHead 抛
    // ERR_HTTP_HEADERS_SENT（Node 的 writeHead 当场把头发出去）。这里让第一次抛、第二次
    // 正常，好把「promise 链上的错误到底有没有人接」单独问出来；抛掉的那一次不计数，
    // 因为它一个字节都没写出去。
    this.failFirstHead = failFirstHead;
    // 数据面的 handler 不返回 promise（那条链是 `void readBody(...)`），所以等答复只能靠
    // 这一声 end：配超时竞速，缺 .catch 时用例红得干脆，而不是把文件挂死在无限超时上。
    this.settled = new Promise((resolve) => { this.settle = resolve; });
  }
  writeHead(code, headers) {
    if (this.failFirstHead) {
      this.failFirstHead = false;
      throw new Error("sink on fire");
    }
    this.statusCode = code;
    this.headers = headers;
    this.heads += 1;
    return this;
  }
  end(text) {
    this.body = text ?? "";
    this.emit("end");
    this.settle?.("ended");
    return this;
  }
}

function shareSetup(apiToken = "secret-token", { logger = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-share-api-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { logger, webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken, null, null);
  return {
    store, service, routes,
    // 闭包拿 store，不用 this：裸函数调用下 this 是 undefined，异常被吞掉就会变成
    // 「库没关就删目录」的 EPERM（清理失败还说不清原因）。
    close() {
      try { store.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * 字节必须在 listener 挂上之后再 emit：EventEmitter 不排队，在 `route.handler` 里
 * readBody 注册 data/end 之前 emit 出去等于什么都没发，readBody 的 promise 永不
 * resolve，整个用例会挂到超时——失败原因还完全看不出跟分享有关。
 */
function shareReq({ method = "POST", url = SHARE_PATH, body = "", authorized = true } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = authorized ? { authorization: "Bearer secret-token" } : {};
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

async function callShare(route, opts = {}) {
  const res = new FakeRes({ failFirstHead: opts.failFirstHead === true });
  let rejection = null;
  try {
    await route.handler(shareReq(opts), res);
  } catch (error) {
    // 把 rejection 收成读数而不是让它冒出去：少了 .catch 时这里就是 #410 的形状——
    // 断言「rejection 必须为 null」比让用例以一个看不懂的异常挂掉说得清得多。
    rejection = String(error);
  }
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
    headers: res.headers,
    heads: res.heads,
    rejection
  };
}

function shareRoute(setup) {
  const route = setup.routes.find((r) => r.path === SHARE_PATH);
  assert.ok(route, "route must exist");
  return route;
}

test("share route is registered with policy token", () => {
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    assert.equal(route.policy, "token");
    assert.equal(route.kind, "exact");
  } finally { s.close(); }
});

test("a configured token gates the share route", async () => {
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    s.store.save({ type: "decision", title: "选 SQLite", content: "正文", tags: [] });
    const denied = await callShare(route, { authorized: false, body: "" });
    assert.equal(denied.status, 401);
    const allowed = await callShare(route, { authorized: true, body: "" });
    assert.equal(allowed.status, 200);
    const pack = allowed.body;
    assert.equal(pack.kind, "mneme.share/v1");
    assert.equal(pack.report.included, 1);
    assert.ok(!("id" in pack.memories[0]));
    // 本侧 sendJson 有 headers 第四参（数据面没有）：Content-Disposition 是面板这张脸
    // 独有的那半，共用层只回 {status, body}，文件名由这里拼——锁它，防止哪天把
    // shareFilename 的连接也一起「统一」掉。
    assert.match(allowed.headers["Content-Disposition"], /^attachment; filename="dsh-mneme-share-\d{8}-[0-9a-f]{8}\.json"$/);
    // 空 body 与「一个字节都不发」同口径：分享的主用法就是按整库口径打。
    const alias = await callShare(route, { body: JSON.stringify({ alias: "桉桉的库" }) });
    assert.equal(alias.status, 200);
    assert.equal(alias.body.alias, "桉桉的库");
    assert.match(alias.body.source_version, /\d/, "包要记下发送方版本，对面按它判兼容");
    assert.ok(Number.isFinite(Date.parse(alias.body.generated_at)));
  } finally { s.close(); }
});

test("GET on the share route is not an open read", async () => {
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    s.store.save({ type: "decision", title: "选 SQLite", content: "正文", tags: [] });
    const out = await callShare(route, { method: "GET", body: "" });
    // 状态码锁死 405，不留 404 这个后门：#411 说两张皮只许差在鉴权与路径，
    // 而数据面那半（本文件末尾）已经只认 405。这里容忍 404 就等于让「面板哪天
    // 掉回末尾 404」也算通过——两张皮悄悄多出一处差别，没人报警。
    assert.equal(out.status, 405, `GET 必须回 405，got ${out.status}`);
    assert.ok(!out.body || !("memories" in out.body), "GET 不许把包交出去");
  } finally { s.close(); }
});

test("a body this layer cannot read is a 400 with one code, not a pack", async () => {
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    s.store.save({ type: "decision", title: "选 SQLite", content: "正文", tags: [] });
    for (const raw of ["{oops", "[1,2]", "null"]) {
      const out = await callShare(route, { body: raw });
      assert.equal(out.status, 400, `${raw} 必须被拒`);
      assert.equal(out.headers?.["Content-Type"], "application/json; charset=utf-8");
      assert.ok(!("memories" in out.body), "拒答里绝不带包体");
    }
  } finally { s.close(); }
});

test("an oversize body answers 413 exactly once", async () => {
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    s.store.save({ type: "decision", title: "选 SQLite", content: "正文", tags: [] });
    // readBody 超限时会自己答 413 并把 text 解析成 null。handler 若没有
    // `if (text === null) return`，它会拿 null 继续往下走：parseShareBody(null) 是
    // 合法的「空 body」，于是整库进包、再答一次 200 —— 一个响应两写，客户端按
    // 状态码分支时看到的是最后那一次（#410 修过的同一类故障）。
    const out = await callShare(route, { body: "x".repeat(MAX_BODY_BYTES + 1) });
    assert.equal(out.heads, 1, "超限时只许有一次响应写");
    assert.equal(out.status, 413);
    assert.equal(out.body.error, "payload-too-large");
  } finally { s.close(); }
});

test("a throwing pack build answers 500 and leaves a log line", async () => {
  // 不带 logger 也照答 500（shareReply 的 warn 是可选的），但带时必须真的写日志：
  // 否则「500 且无迹可查」这条现场就无从下手。
  const warnings = [];
  const s = shareSetup("secret-token", { logger: { warn: (m) => warnings.push(String(m)) } });
  try {
    const route = shareRoute(s);
    s.service.all = () => { throw new Error("database is locked"); };
    const out = await callShare(route, { body: "" });
    assert.equal(out.status, 500);
    assert.deepEqual(out.body, { error: "internal" }, "对外只有一个码，不带原始错误文本");
    assert.match(warnings.join(" "), /share pack failed/);
    assert.match(warnings.join(" "), /database is locked/, "原始错误文本要留在日志里");
  } finally { s.close(); }
});

test("the panel /share chain answers once when the sink fails mid-write", async () => {
  // 车道 A 的这条路由只有外层 try，而外层 try 在 .then 的回调里早已退栈：回调里抛出的错
  // （这里是 sendJson 的 writeHead 抛——真 socket 上「一个响应两写」的第二次就是这个形状）
  // 没人接，就是一个 unhandled rejection 加「一个字节都没回」（#410）。数据面的同名路由
  // （本文件末尾）一直带着那一声 .catch，两条皮在这里本该只差鉴权与路径（#411），
  // 所以补的是面板这一侧。C6 之后 warn 已被共用层守卫包住，日志坏掉那条路走不到这里，
  // 这个 sink 形状是 .catch 唯一还能被独立问到的入口。
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    s.store.save({ type: "decision", title: "选 SQLite", content: "正文 here", tags: [] });
    const out = await callShare(route, { body: "", failFirstHead: true });
    assert.equal(out.rejection, null, "回调里抛出的错必须由链上的 .catch 接住");
    assert.equal(out.status, 500, "sink 坏了也要把答复交出去");
    assert.deepEqual(out.body, { error: "internal" });
    assert.equal(out.heads, 1, "抛掉的那一次没写出去，成功的只许有一次");
  } finally { s.close(); }
});

// --- Bearer 数据面（src/api-standalone.js）-----------------------------------

function standaloneSetup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-share-std-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  // 起法照 test/standalone-api.test.js：这个模块没有 start()/stop()，监听在构造里
  // 发起、由 ready 兑现，端口是 OS 给的（port: 0），token 挂在 api 上。
  const api = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: 0 });
  return api.ready.then(() => {
    const base = `http://127.0.0.1:${api.port}`;
    return {
      api, store, service, base, auth: { authorization: `Bearer ${api.token}` },
      close() {
        // 拆掉 keep-alive 连接，否则 node --test 的循环排不干净（同那份文件）。
        api.server.closeIdleConnections?.();
        api.server.close();
        try { store.close(); } catch { /* already closed */ }
        rmSync(dir, { recursive: true, force: true });
      }
    };
  });
}

test("standalone /share answers the pack for a Bearer caller and 401 otherwise", async () => {
  const h = await standaloneSetup();
  try {
    h.store.save({ type: "decision", title: "选 SQLite", content: "正文 here", tags: [] });
    const anon = await fetch(`${h.base}/share`, { method: "POST", body: "{}" });
    assert.equal(anon.status, 401, "这一面除 GET /health 外一律要 token，没有 policy 名可绕");
    assert.deepEqual(await anon.json(), { error: "unauthorized" });

    const ok = await fetch(`${h.base}/share`, {
      method: "POST", headers: h.auth, body: JSON.stringify({ alias: "桉" })
    });
    assert.equal(ok.status, 200);
    const pack = await ok.json();
    assert.equal(pack.kind, "mneme.share/v1", "两张皮交出去的是同一个包形状");
    assert.equal(pack.alias, "桉");
    assert.equal(pack.report.included, 1);
    // 本面**没有** Content-Disposition：它的 sendJson 连 headers 参数都没有，CLI 拿
    // JSON 自己落盘。锁「不许冒出来」，防止哪天有人为了对齐面板而改那个签名。
    assert.equal(ok.headers.get("content-disposition"), null);

    // 读不懂的 body 在这侧同样是 400 一个码，而不是掉回末尾的 404。
    for (const raw of ["{oops", "[1,2]", "null"]) {
      const bad = await fetch(`${h.base}/share`, { method: "POST", headers: h.auth, body: raw });
      assert.equal(bad.status, 400, `${raw} 必须被拒`);
      assert.ok(!("memories" in await bad.json()), "拒答里绝不带包体");
    }
  } finally { await h.close(); }
});

test("standalone GET /share answers 405, matching the panel", async () => {
  // 这一条**故意**与 /maintenance/reclaim 不同（那边 GET 掉到末尾 404）。#411 的口径
  // 是「两张皮只许差在鉴权与路径」，状态码差一次就是第三处差别，所以这里跟着面板回
  // 405 —— 一致性优先于照抄这份文件里的邻居。
  const h = await standaloneSetup();
  try {
    h.store.save({ type: "decision", title: "选 SQLite", content: "正文 here", tags: [] });
    const out = await fetch(`${h.base}/share`, { headers: h.auth });
    assert.equal(out.status, 405);
    const body = await out.json();
    assert.ok(!("memories" in body), "GET 不许把包交出去");
  } finally { await h.close(); }
});

test("the standalone /share chain answers once when the sink fails mid-write", async () => {
  // 本面这条链一直带着 .catch，但**从来没有任何用例走到得过它**：共用层从不抛、日志也
  // 被守卫吞掉之后，剩下的入口只有面自己写答复这一步（真 socket 上「一个响应两写」的
  // 第二次 writeHead 就是这里的形状）。与上面面板那条同名用例是一对——两张皮的 .catch
  // 各锁各的，少一边就只有一边会红（#411）。假 sink 第一次抛、第二次正常；等得到答复
  // 就说明链上有主，等不到（输给超时）就是 #410 的「一个字节都没回」。
  const h = await standaloneSetup();
  try {
    h.store.save({ type: "decision", title: "选 SQLite", content: "正文 here", tags: [] });
    const handlers = h.api.server.listeners("request");
    assert.equal(handlers.length, 1, "这台面上只许挂着一个 request handler，否则不知道在驱动谁");
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/share";
    req.headers = { authorization: `Bearer ${h.api.token}` };
    const res = new FakeRes({ failFirstHead: true });
    handlers[0](req, res);
    process.nextTick(() => {
      req.emit("data", Buffer.from("{}"));
      req.emit("end");
    });
    const settled = await Promise.race([res.settled, new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
    assert.equal(settled, "ended", "缺了 .catch 就永远等不到答复");
    assert.equal(res.statusCode, 500);
    assert.equal(res.heads, 1, "抛掉的那一次没写出去，成功的只许有一次");
  } finally { await h.close(); }
});
