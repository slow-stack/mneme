// receive（入库 / 整包退出）的 HTTP 口径 + 两张皮的装配与反分叉锁。
//
// 三类回归，分三段（按标题顺序，不数条数——数出来的数字会比正文先过期）：
//   口径层——这张脸有两个入口（宿主内面板路由、standalone Bearer 数据面），任何一处松掉
//   都会同时污染两侧，所以边界跑全量：body 解析、干跑默认、错误码 → 状态码的映射（含一条
//   从 share.js 源码推码集的静态锁，第 9 个码进来时它要能同时抓「没登记」和「表里的死条目」）、
//   503 与 500 的分工，以及「这一层从不抛」——连 warn 自己坏也算在内。
//   面板路由层——锁的是共用层管不着的那半：policy 归类、非 POST 的 405、readBody 返回 null
//   时不许再写一次响应（#410 那一类双写）、以及「500 必须留下日志迹，而记日志那一环自己坏了
//   也得回一个 500」。
//   数据面与跨面——C6 把 Bearer 那半接上之后才补的：数据面自己的 .catch（#410 的形状在数据面
//   才真的要命：链上没人返回 promise，输不掉就一个字节都不回）与一条**跨面**反分叉静态锁
//   （两面都调同一批共用 builder）。src() helper 被三条静态锁各自消费——口径层的码集推导锁、
//   「共用层只守卫 warn 一次」那把，与末尾这条跨面锁；本段说的 .catch 全是行为咬的，不扫源码。
//   车道 A 的同款先例是 test/share-http.test.js 末尾那条，它也是两张皮都接上之后才补的。
//
// 装配台照 test/share-routes.test.js 的 shareSetup（同一套 api-routes-gaps 形状）并
// **落文件库**：收侧吃的是真实 store 的两列身份与部分 UNIQUE 索引，`:memory:` 那个口径
// 摸不到真的行；真装配 createApi 才锁得到 policy 与 readBody 这两处只在这里存在的东西。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";
import { createStandaloneApi } from "../src/api-standalone.js";
import { deriveExternalId, SHARE_KIND, validateSharePack } from "../src/share.js";
import {
  parseReceiveBody,
  receiveReply,
  parseUndoBody,
  undoReply,
  SHARE_IMPORT_ERRORS,
  SHARE_IMPORT_UNAVAILABLE
} from "../src/share-http.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(resolve(here, "../src", f), "utf8");
const RECEIVE_PATH = "/api/dsh-mneme/receive";
const UNDO_PATH = "/api/dsh-mneme/receive/undo";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PACK_ID = "f0f0f0f0f0f0f0f0";

// over 排在派生之后（照 test/share-validate.test.js 的同款夹具）：要造
// external-id-mismatch 就得让 external_id 这一格被换成别的值，而其余字段仍然合格。
const entry = (over = {}) => {
  const base = { type: "decision", title: "t", content: "c", tags: [], importance: 3, content_hash: "h" };
  return { ...base, external_id: deriveExternalId(PACK_ID, base.type, base.title, base.content_hash), ...over };
};
const packOf = (memories, over = {}) => ({
  kind: SHARE_KIND, pack_id: PACK_ID, alias: "桉", generated_at: "x", source_version: "0.9.4",
  report: { included: memories.length, skipped: {}, skip_list: [], deduped: 0 }, memories, ...over
});
const goodPack = () => packOf([entry()]);

// --- 口径层 -------------------------------------------------------------------

test("the body must carry a pack; a bare pack is refused", () => {
  // 空 body 与「没带包」在这里是两件事：出包侧空 body 是合法的（整库口径），收侧空 body
  // 一个字节都没得写，静默当成 `{}` 再往下走只会拿到一个看不懂的 400。
  for (const empty of ["", "   ", undefined, null]) {
    assert.equal(parseReceiveBody(empty).error, "invalid-body", `body=${JSON.stringify(empty)} 没有包`);
  }
  assert.equal(parseReceiveBody("{oops").error, "invalid-json", "发坏了 ≠ 发错了形状");
  for (const wrong of ["[1,2]", "null", '"x"']) {
    assert.equal(parseReceiveBody(wrong).error, "invalid-body", `${wrong} 顶层就不是对象`);
  }
  assert.equal(parseReceiveBody("{}").error, "missing-pack");
  for (const noPack of ['{"pack":null}', '{"pack":"abc"}', '{"pack":123}']) {
    assert.equal(parseReceiveBody(noPack).error, "missing-pack", `${noPack} 的 pack 那一格不是对象`);
  }
  const written = parseReceiveBody(JSON.stringify({ pack: goodPack(), confirm: true }));
  assert.equal(written.ok, true);
  assert.equal(written.dryRun, false, "confirm:true means really write");
  assert.equal(parseReceiveBody(JSON.stringify({ pack: goodPack() })).dryRun, true, "no confirm means dry-run");
  // confirm 只认真布尔（同 readReclaimFields 的 confirm）。字符串 "true" 不是点头——
  // 这一面写的是收件人的库，把「像是点了头」读成点头就是替她决定。
  assert.equal(parseReceiveBody(JSON.stringify({ pack: goodPack(), confirm: "true" })).dryRun, true);
  // 第二个「要不要写」的旋钮不存在。reclaim 的 body 形状是 {dryRun:false,confirm:true}，
  // 手熟的人会顺手把 dryRun 一起发来：这里必须读成「没点头」，而不是 dryRun:false 覆盖默认。
  assert.equal(parseReceiveBody(JSON.stringify({ pack: goodPack(), dryRun: false })).dryRun, true,
    "dryRun 不是收侧的旋钮：只有 confirm 才写");
  // 包本身不在这里判：整包闸门住在 share.js、由 service 调（判据只许有一处）。
  // 一个数组当 pack 照样往下交——本层若自己校验一次，两张皮就各有一套合格标准了。
  const arrayPack = parseReceiveBody('{"pack":[]}');
  assert.equal(arrayPack.ok, true);
  assert.deepEqual(arrayPack.pack, []);
});

test("receive without confirm answers the dry-run shape, with confirm the same shape marked applied", () => {
  const calls = [];
  const service = {
    importSharePack: (pack, opts) => {
      calls.push({ pack, opts });
      return { pack_id: pack.pack_id, alias: pack.alias, created: 1, skipped_existing: 0, unchanged: 0, title_conflicts: [], conflicts_checked: 1 };
    }
  };
  const pack = goodPack();
  const out = receiveReply({ service, pack });
  assert.equal(out.status, 200);
  assert.equal(out.body.created, 1);
  assert.equal(out.body.dry_run, true, "没给 dryRun 就是干跑，答复要自己承认没写");
  assert.deepEqual(calls, [{ pack, opts: { dryRun: true } }], "干跑要作为 opts 交给 service，不是本层自己算数");
  // 不加包装层：对面（CLI 的打印器）直接读这几格，套一层 {report} 会打断它。
  for (const key of ["pack_id", "alias", "created", "skipped_existing", "unchanged", "title_conflicts", "conflicts_checked"]) {
    assert.ok(key in out.body, `${key} must pass through untouched`);
  }
  const applied = receiveReply({ service, pack, dryRun: false });
  assert.equal(applied.body.dry_run, false);
  // title_conflicts 是 advisory 读数、conflicts_checked 只是包里的条数：本层只透传，
  // 不许在这儿把它读成「无冲突」再补一个布尔——那等于把「这批里没有新撞名」说成「库里没有同名行」。
  assert.deepEqual(applied.body.title_conflicts, []);
  assert.equal(applied.body.conflicts_checked, 1);
  // 本层不校验包：一个闸门一眼看穿的坏包也要原样交给 service，由它抛带码的错、由码表回 400。
  const junk = { kind: "nope" };
  assert.equal(validateSharePack(junk).ok, false, "前提：这个包在闸门那儿确实不合格");
  const junkOut = receiveReply({ service, pack: junk, dryRun: false });
  assert.equal(junkOut.status, 200, "service 说成了，本层就不许自己先拒——判据只许有一处");
  assert.equal(calls.at(-1).pack, junk);
});

test("every import error code maps to exactly one status", () => {
  // 码集不重抄一份清单。FIXTURES 的键**由两处推出来**：一张是映射表
  // SHARE_IMPORT_ERRORS，另一处是把闸门（src/share.js 的 validateSharePack）源码里的
  // error 字面量扫出来。为什么两处都要：只对着表写夹具，闸门哪天多一格而表忘了登记，
  // 全套用例照样绿——那个新码从此静默落进「500 + 日志」，把发件人的坏包报成我们的故障
  // （C5 评审点的名）。反过来只对着闸门扫、不看表，表里的死码又没人管。
  const gate = src("share.js");
  const at = gate.indexOf("export function validateSharePack(");
  assert.ok(at > 0, "src/share.js 里应有 validateSharePack 这一段可扫");
  const region = gate.slice(at);
  assert.ok(region.includes("{ ok: true, pack"), "扫到的那一段确实止于 validateSharePack 的放行分支");
  const gateCodes = [...new Set([...region.matchAll(/error:\s*"([a-z-]+)"/g)].map((m) => m[1]))];

  // over 排在派生之后（见上面的 entry 注释）：要造 external-id-mismatch 就得让 external_id
  // 这一格被换成别的值，而其余字段仍然合格。
  const FIXTURES = {
    "invalid-kind": () => packOf([entry()], { kind: "nope" }),
    "invalid-pack-id": () => packOf([entry()], { pack_id: "nope" }),
    "invalid-memories": () => packOf([entry()], { memories: "x" }),
    "empty-pack": () => packOf([]),
    "invalid-type": () => packOf([entry({ type: "summary" })]),
    "invalid-entry": () => packOf([entry({ title: "  " })]),
    "external-id-mismatch": () => packOf([entry({ external_id: "0000000000000000" })]),
    "duplicate-external-id": () => packOf([entry(), entry()])
  };
  const required = [...new Set([...Object.keys(SHARE_IMPORT_ERRORS), ...gateCodes])].sort();
  assert.deepEqual(Object.keys(FIXTURES).sort(), required,
    "每一个码（表里的 + 闸门里抛的）都要有一条真夹具，一条都不许多；新码进来时先把这条改红，别绕过去");

  for (const code of required) {
    assert.equal(SHARE_IMPORT_ERRORS[code], 400, `${code} 必须在映射表里登记成 400：闸门能抛它而表里没有，它就落成 500`);
    assert.equal(validateSharePack(FIXTURES[code]()).error, code, `闸门该回 ${code}`);
    const throwing = {
      importSharePack: () => {
        const e = new Error(`share import: ${code}`);
        e.code = code;
        throw e;
      }
    };
    const out = receiveReply({ service: throwing, pack: goodPack(), dryRun: false });
    assert.equal(out.status, 400, `${code} must answer 400`);
    assert.deepEqual(out.body, { error: code }, `${code} 的答复只有一个码`);
  }
  assert.ok(Object.isFrozen(SHARE_IMPORT_ERRORS), "两张皮共用一张表，运行时谁都不许改它");
  // detail 是闸门给的那一格（哪个字段、哪个坏类型），只转发不加工；没有就不造这一格。
  const detailed = receiveReply({
    service: { importSharePack: () => { const e = new Error("x"); e.code = "invalid-entry"; e.detail = "content"; throw e; } },
    pack: goodPack(), dryRun: false
  });
  assert.deepEqual(detailed.body, { error: "invalid-entry", detail: "content" });
  // 不在表里的码不许混进 400，也不许只回个状态码就走：认不出的码只剩日志这一条线索。
  const logs = [];
  const unknown = receiveReply({
    service: { importSharePack: () => { const e = new Error("database is locked"); e.code = "SQLITE_BUSY"; throw e; } },
    pack: goodPack(), dryRun: false, warn: (m) => logs.push(String(m))
  });
  assert.equal(unknown.status, 500);
  assert.deepEqual(unknown.body, { error: "internal" });
  assert.equal(logs.length, 1);
});

test("a service that cannot receive answers unavailable, not 500", () => {
  // 「这条路没接」与「我发坏了」必须分得开：headless/旧装配里没有这两个方法，
  // 报 500 是把接线问题伪装成服务端故障，报 400 是把对面打发去改一个没错的包。
  const cases = [
    ["receive", () => receiveReply({ service: {}, pack: goodPack() })],
    ["undo", () => undoReply({ service: {}, packId: PACK_ID })],
    ["receive/undefined", () => receiveReply({ service: undefined, pack: goodPack() })],
    ["undo/wrong-shape", () => undoReply({ service: { deleteSharePack: "not-a-function" }, packId: PACK_ID })]
  ];
  for (const [name, run] of cases) {
    const out = run();
    assert.equal(out.status, 503, `${name} 该回 503`);
    assert.deepEqual(out.body, { error: "share-import-unavailable" }, "对面按这一个码分支");
    assert.equal(out.body.error, SHARE_IMPORT_UNAVAILABLE);
  }
});

test("an unexpected throw is logged and answered as internal", () => {
  const logs = [];
  const boom = (message) => ({
    importSharePack: () => { throw new Error(message); },
    deleteSharePack: () => { throw new Error(message); }
  });
  const out = receiveReply({ service: boom("database is locked"), pack: goodPack(), dryRun: false, warn: (m) => logs.push(String(m)) });
  assert.equal(out.status, 500);
  assert.deepEqual(out.body, { error: "internal" }, "对外只有一个码，不带原始错误文本");
  assert.equal(logs.length, 1, "a swallowed 500 must leave a trace");
  assert.match(logs[0], /share import failed/);
  assert.match(logs[0], /database is locked/, "原始文本留在日志里，否则现场无从下手");
  // 退出那一侧同一件事，文案不同（查的人按这两条认是哪一面炸的），对外同样只有一个码。
  const undoLogs = [];
  const undone = undoReply({ service: boom("no such column"), packId: PACK_ID, dryRun: false, warn: (m) => undoLogs.push(String(m)) });
  assert.deepEqual(undone, { status: 500, body: { error: "internal" } });
  assert.match(undoLogs[0], /share undo failed/);
  // 没有 logger 也不许把异常漏出去：#410 的形态就是客户端拿到「一个字节都没回」。
  assert.equal(receiveReply({ service: boom("x"), pack: goodPack(), dryRun: false }).status, 500);
  assert.equal(undoReply({ service: boom("x"), packId: PACK_ID }).status, 500);
});

test("a warn that throws is the layer's problem, not the surface's", () => {
  // 「这一层从不抛」必须是**层的契约**，不是每个调用面的运气（C5 评审裁定）：日志那一环
  // 自己坏时，已经算好的 500 不许跟着一起漏出去——从 catch 块里再抛出去就是没人接的
  // rejection，对面拿到的不是 500 而是「一个字节都没回」（#410 的原始形态）。
  // 出包那侧的 shareReply 过去是裸调，本条同时把三个构造器钉成同一种脾气：不对称的地方
  // 就是下一个读者会照抄的那一处。
  const boom = (message) => ({
    importSharePack: () => { throw new Error(message); },
    deleteSharePack: () => { throw new Error(message); }
  });
  const screaming = () => { throw new Error("log sink on fire"); };
  assert.deepEqual(receiveReply({ service: boom("database is locked"), pack: goodPack(), dryRun: false, warn: screaming }),
    { status: 500, body: { error: "internal" } }, "日志环坏了也要把 500 交出去");
  assert.deepEqual(undoReply({ service: boom("disk i/o error"), packId: PACK_ID, dryRun: false, warn: screaming }),
    { status: 500, body: { error: "internal" } });
  // 认得出的码那一支也要走同一把守卫：它不记日志，但「构造器从不抛」不分工况。
  const coded = () => {
    const e = new Error("x");
    e.code = "invalid-kind";
    throw e;
  };
  assert.deepEqual(receiveReply({ service: { importSharePack: coded }, pack: goodPack(), dryRun: false, warn: screaming }),
    { status: 400, body: { error: "invalid-kind" } });
});

test("the shared layer guards warn exactly once, for all three builders", () => {
  // 静态锁，盯的是**对称**而不是某一处实现：本层只许出现一次裸的 warn 调用（就在守卫
  // 函数体里），三个构造器各自都必须经守卫调用它。将来谁加第四个构造器时裸写 warn，
  // 或者把某一侧的守卫「优化」掉，这条会红——而 behavioural 的用例只会告诉它「反正
  // 面板有 .catch 兜着」，那是把层的契约推给面。
  const layer = src("share-http.js");
  assert.equal((layer.match(/warn\?\.\(/g) ?? []).length, 1, "裸的 warn?.( 只许住在守卫里");
  assert.equal((layer.match(/warnSafely\(/g) ?? []).length, 4, "一处定义 + shareReply / receiveReply / undoReply 三处调用");
});

test("undo takes a pack_id and answers the same shape", () => {
  // 顶层形状与「有没有 id」是两个错，与 receive 侧同一口径（invalid-json /
  // invalid-body / 缺字段），三个码让对面分得清是自己发坏了还是没填。
  assert.equal(parseUndoBody("").error, "invalid-body");
  assert.equal(parseUndoBody("{oops").error, "invalid-json");
  for (const wrong of ["[1,2]", "null"]) {
    assert.equal(parseUndoBody(wrong).error, "invalid-body", `${wrong} 顶层就不是对象`);
  }
  assert.equal(parseUndoBody("{}").error, "missing-pack-id");
  assert.equal(parseUndoBody('{"packId":"   "}').error, "missing-pack-id", "空白 id 不是要收起的那一批");
  assert.equal(parseUndoBody('{"packId":123}').error, "missing-pack-id", "非字符串不进删除那条路");
  const parsed = parseUndoBody(JSON.stringify({ packId: `  ${PACK_ID}  `, confirm: true }));
  assert.equal(parsed.packId, PACK_ID, "在这里 trim，与 deleteSharePack 首行同一把尺");
  assert.equal(parsed.dryRun, false);
  assert.equal(parseUndoBody(JSON.stringify({ packId: PACK_ID })).dryRun, true, "缺 confirm 同样是干跑");
  const calls = [];
  const service = {
    deleteSharePack: (packId, opts) => {
      calls.push({ packId, opts });
      return { pack_id: packId, deleted: 2, sample: [{ type: "decision", title: "t" }] };
    }
  };
  const out = undoReply({ service, packId: PACK_ID, dryRun: true });
  assert.equal(out.status, 200);
  assert.equal(out.body.deleted, 2);
  assert.equal(out.body.dry_run, true);
  assert.deepEqual(calls, [{ packId: PACK_ID, opts: { dryRun: true } }]);
  assert.ok(Array.isArray(out.body.sample), "sample 是前缀清单，deleted 才是全集");
  // pack_id 这一格是 service 的读数，不是请求的回显：非字符串/空白那一支它回 ""。
  // 本层不许替它兜底或改写，否则「收起的是哪一批」就有了第二个答案。
  assert.equal(out.body.pack_id, PACK_ID);
});

// --- 面板路由层 ---------------------------------------------------------------

class FakeRes extends EventEmitter {
  constructor({ failFirstHead = false } = {}) {
    super();
    this.statusCode = 0;
    this.body = "";
    // writeHead 计数：双写响应的故障形态是「第二次 writeHead 盖掉第一次的状态码」，
    // 只看最终 statusCode 抓不住（413 之后又被 400 盖掉时 body 也换了），要数次数。
    this.heads = 0;
    // 一次性坏掉的 sink：真 socket 上「一个响应两写」的现场形态就是第二次 writeHead 抛
    // ERR_HTTP_HEADERS_SENT（Node 在 writeHead 里就把头发出去了）。这里让第一次抛、第二次
    // 正常，为的是把「promise 链上的错误有没有人接住」这件事单独问出来——它不计数，那一次
    // 什么都没写出去。
    this.failFirstHead = failFirstHead;
    // 数据面的 handler 是 `void readBody(...).then(...)`，它不返回 promise，测试没法
    // await 到链尾——答复写完的这一声就是唯一的等待点（配一个超时竞速，缺 .catch 时
    // 用例要红得干脆，而不是把整个文件挂死在无限超时上）。
    this.settled = new Promise((resolve) => { this.settle = resolve; });
  }
  writeHead(code) {
    if (this.failFirstHead) {
      this.failFirstHead = false;
      throw new Error("sink on fire");
    }
    this.statusCode = code;
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

function receiveSetup(apiToken = "secret-token", { logger = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-receive-api-"));
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
 * readBody 注册 data/end 之前 emit 等于什么都没发，promise 永不 resolve，用例会挂到
 * 超时——失败原因还完全看不出跟入库有关。
 */
function receiveReq({ method = "POST", url = RECEIVE_PATH, body = "", authorized = true } = {}) {
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

async function call(route, opts = {}) {
  const { failFirstHead = false, ...request } = opts;
  const res = new FakeRes({ failFirstHead });
  // 把 rejection 收成读数而不是让它冒出去：面板 handler 的形状是
  // `try { return readBody(...).then(...) } catch`，外层 try 在 .then 的回调里早已退栈，
  // 回调里抛出（或哪天 .catch 被删）时这里拿到的是一条看不懂的原始错误。收成字段后断言
  // 才说得出「回调里的错没人接 = 一个字节都没回」（#410）。
  let rejection = null;
  try {
    await route.handler(receiveReq(request), res);
  } catch (error) {
    rejection = String(error);
  }
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
    heads: res.heads,
    rejection
  };
}

function receiveRoute(setup, path) {
  const route = setup.routes.find((r) => r.path === path);
  assert.ok(route, `${path} must be registered`);
  return route;
}

const rowsOf = (store) => store.list({ limit: null });

test("both receive routes register as token-write and gate the write behind the token", async () => {
  const s = receiveSetup();
  try {
    for (const path of [RECEIVE_PATH, UNDO_PATH]) {
      const route = receiveRoute(s, path);
      assert.equal(route.kind, "exact");
      // 写库的一面，与 /import 同门；漏声明 policy 在装配期就抛，这条锁的是「归对那一类」。
      assert.equal(route.policy, "token-write", path);
    }
    const receive = receiveRoute(s, RECEIVE_PATH);
    const anon = await call(receive, { body: JSON.stringify({ pack: goodPack(), confirm: true }), authorized: false });
    assert.equal(anon.status, 401, "POST 不带 token 一步都不许往下走");
    assert.equal(rowsOf(s.store).length, 0, "被拒的请求根本进不到 handler");
    // token-write 的 GET 分支不鉴权：它是「进 handler 拿 405」这条路存在的唯一理由。
    // 哪天有人把它收紧成 token（更安全的外观），这里会从 405 变 401——两张皮的差别
    // 就多出一处鉴权之外的东西（#411），这条断言就是那声报警。
    const anonGet = await call(receive, { method: "GET", authorized: false });
    assert.equal(anonGet.status, 405, `GET 不带 token 也要走到 405，got ${anonGet.status}`);
  } finally { s.close(); }
});

test("receive through the panel previews by default and writes only on confirm", async () => {
  const s = receiveSetup();
  try {
    const route = receiveRoute(s, RECEIVE_PATH);
    const dry = await call(route, { body: JSON.stringify({ pack: goodPack() }) });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dry_run, true);
    assert.equal(dry.body.created, 1);
    assert.equal(dry.body.conflicts_checked, 1);
    assert.ok(Array.isArray(dry.body.title_conflicts), "撞名读数要透传出去：那是「不改别人」唯一的可见性");
    assert.equal(rowsOf(s.store).length, 0, "一个字节都没点，一个字都不许写");
    const applied = await call(route, { body: JSON.stringify({ pack: goodPack(), confirm: true }) });
    assert.equal(applied.body.dry_run, false);
    assert.equal(applied.body.created, 1);
    assert.equal(applied.body.pack_id, PACK_ID);
    const rows = rowsOf(s.store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].share_pack_id, PACK_ID, "落的是带包身份的外来行，退出与守卫都靠这一格");
    assert.equal(rows[0].source, "imported");
    const again = await call(route, { body: JSON.stringify({ pack: goodPack(), confirm: true }) });
    assert.equal(again.body.created, 0);
    assert.equal(again.body.skipped_existing, 1, "幂等是这条路由的常态用法，不是 service 的私事");
    assert.equal(rowsOf(s.store).length, 1, "重跑一行都不多");
  } finally { s.close(); }
});

test("a non-POST on the receive routes answers 405, not 404", async () => {
  const s = receiveSetup();
  try {
    for (const path of [RECEIVE_PATH, UNDO_PATH]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const out = await call(receiveRoute(s, path), { method, url: path, body: "" });
        assert.equal(out.status, 405, `${method} ${path} got ${out.status}`);
        assert.deepEqual(out.body, { error: "method-not-allowed" });
      }
    }
    assert.equal(rowsOf(s.store).length, 0, "405 那几条一个字节都没写");
    // 这**故意**与隔壁 /maintenance/reclaim 不同（那边非 GET/POST 掉到末尾 404；GET 是它
    // 自己的面板预览入口，另一回事）。理由在 #411：每条 receive 都还有个数据面双胞胎（C6），
    // 那里只认 405，状态码差一次就是第三处差别。
    const reclaim = receiveRoute(s, "/api/dsh-mneme/maintenance/reclaim");
    assert.equal((await call(reclaim, { method: "PUT", url: "/api/dsh-mneme/maintenance/reclaim" })).status, 404,
      "邻居仍是 404：这条锁的不是全局面，是 receive 这两条与它们双胞胎的一致性");
  } finally { s.close(); }
});

test("an oversize body answers 413 exactly once on both receive routes", async () => {
  const s = receiveSetup();
  try {
    for (const path of [RECEIVE_PATH, UNDO_PATH]) {
      // readBody 超限时自己答 413 并把 text 解析成 null。handler 少了 `if (text === null) return`
      // 就会拿 null 继续走：两侧都是 400，于是**一个响应两写**，客户端按状态码分支看到的
      // 是最后那一次（#410 修过的同一类故障）。
      const out = await call(receiveRoute(s, path), { url: path, body: "x".repeat(MAX_BODY_BYTES + 1) });
      assert.equal(out.heads, 1, `${path} 超限时只许有一次响应写`);
      assert.equal(out.status, 413);
      assert.equal(out.body.error, "payload-too-large");
    }
    assert.equal(rowsOf(s.store).length, 0);
  } finally { s.close(); }
});

test("the receive routes answer the gate's code, a logged 500, and unavailable", async () => {
  const warnings = [];
  const s = receiveSetup("secret-token", { logger: { warn: (m) => warnings.push(String(m)) } });
  try {
    const receive = receiveRoute(s, RECEIVE_PATH);
    const undo = receiveRoute(s, UNDO_PATH);
    // 闸门住在 service：本层不重跑校验，只把带码的错映射成状态码（判据只许有一处）。
    const rejected = await call(receive, { body: JSON.stringify({ pack: packOf([entry()], { kind: "nope" }), confirm: true }) });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "invalid-kind");
    assert.equal(rowsOf(s.store).length, 0, "整包不合格 = 一行都不落");
    // 坏 body 与坏包是两个形状，都是 400 但码不同：调用方据此知道改哪一头。
    assert.equal((await call(receive, { body: "[1,2]" })).body.error, "invalid-body");
    assert.equal((await call(undo, { body: "{}" })).body.error, "missing-pack-id");
    // 抛错兜在共用层里，但日志迹要接到宿主 logger——不接就是一条静默的 500，现场只剩 internal。
    s.service.importSharePack = () => { throw new Error("database is locked"); };
    s.service.deleteSharePack = () => { throw new Error("disk i/o error"); };
    const boom = await call(receive, { body: JSON.stringify({ pack: goodPack(), confirm: true }) });
    assert.equal(boom.status, 500);
    assert.deepEqual(boom.body, { error: "internal" }, "对外不带原始错误文本");
    assert.match(warnings.join(" "), /share import failed/);
    assert.match(warnings.join(" "), /database is locked/, "原始文本要留在日志里");
    const boomUndo = await call(undo, { body: JSON.stringify({ packId: PACK_ID, confirm: true }) });
    assert.equal(boomUndo.status, 500);
    assert.match(warnings.join(" "), /share undo failed/);
    // 方法整个不在（headless/旧装配）是 503，不是 500：这条路根本没接线。
    delete s.service.importSharePack;
    delete s.service.deleteSharePack;
    for (const [path, body] of [
      [RECEIVE_PATH, JSON.stringify({ pack: goodPack(), confirm: true })],
      [UNDO_PATH, JSON.stringify({ packId: PACK_ID, confirm: true })]
    ]) {
      const out = await call(receiveRoute(s, path), { url: path, body });
      assert.equal(out.status, 503, path);
      assert.deepEqual(out.body, { error: "share-import-unavailable" });
    }
  } finally { s.close(); }
});

test("a logger that throws on the 500 path still gets exactly one reply", async () => {
  // 这一条问的是**端到端**：日志那一环坏掉时，宿主这张脸仍须恰好回一次 500。
  // C6 把守卫还回共用层（warnSafely）之后，它不再顺带证明面板的 .catch——回调里根本
  // 不会再抛出来了。.catch 由下面那条「sink 自己坏」的用例单独咬（那是它唯一还能被
  // 走到的路径），两层各挡一类，谁都不是装饰。
  const s = receiveSetup("secret-token", { logger: { warn: () => { throw new Error("log sink on fire"); } } });
  try {
    s.service.importSharePack = () => { throw new Error("database is locked"); };
    s.service.deleteSharePack = () => { throw new Error("disk i/o error"); };
    for (const [path, body] of [
      [RECEIVE_PATH, JSON.stringify({ pack: goodPack(), confirm: true })],
      [UNDO_PATH, JSON.stringify({ packId: PACK_ID, confirm: true })]
    ]) {
      const out = await call(receiveRoute(s, path), { url: path, body });
      assert.equal(out.heads, 1, `${path} 日志故障也只许写一次响应`);
      assert.equal(out.status, 500, `${path} 日志故障不许把答复一起带走`);
      assert.deepEqual(out.body, { error: "internal" });
      assert.equal(out.rejection, null, `${path} 的 promise 链不该把错误漏给调用方`);
    }
    assert.equal(rowsOf(s.store).length, 0);
  } finally { s.close(); }
});

test("a sink that fails mid-write is caught by the chain's own .catch", async () => {
  // 共用层现在从不抛，日志也被守卫包住，所以 .catch 唯一还能被走到的路径是**面自己**
  // 在写出答复时抛：sendJson 先 writeHead 再 end(JSON.stringify(...))，真 socket 上
  // 「一个响应两写」的第二次 writeHead 就抛在这里（Node 的 writeHead 当场把头发出去，
  // 所以第二次写会撞上 ERR_HTTP_HEADERS_SENT）。这类抛错发生在 .then 的回调里，外层那个
  // 同步 try 早已退栈——没有 .catch 就是一个没人接的 rejection、客户端一个字节都收不到
  // （#410）。C5 的第 13 条不再能咬它，这条是它独立的锁。
  const s = receiveSetup();
  try {
    const receive = receiveRoute(s, RECEIVE_PATH);
    const undo = receiveRoute(s, UNDO_PATH);
    // 两条都走干跑：这条用例问的只有「答复阶段抛出的错谁接」，不想把「写已经落了、
    // 回给对面却失败」这件事混进同一句断言里（那是 C7 CLI 重入时要面对的另一种形状）。
    const cases = [
      [receive, RECEIVE_PATH, JSON.stringify({ pack: goodPack() })],
      [undo, UNDO_PATH, JSON.stringify({ packId: PACK_ID })]
    ];
    for (const [route, path, body] of cases) {
      const out = await call(route, { url: path, body, failFirstHead: true });
      assert.equal(out.rejection, null, `${path} 回调里抛出的错必须由 .catch 接住`);
      assert.equal(out.status, 500, `${path} sink 坏了也要把答复交出去`);
      assert.deepEqual(out.body, { error: "internal" });
      assert.equal(out.heads, 1, "第一次 writeHead 抛的那一次什么都没写出去，成功的只许有一次");
    }
    assert.equal(rowsOf(s.store).length, 0);
  } finally { s.close(); }
});

test("undo through the panel counts before it deletes and needs confirm to delete", async () => {
  const s = receiveSetup();
  try {
    const receive = receiveRoute(s, RECEIVE_PATH);
    const undo = receiveRoute(s, UNDO_PATH);
    const nothing = await call(undo, { body: "{}" });
    assert.equal(nothing.status, 400);
    assert.equal(nothing.body.error, "missing-pack-id", "没有 id 就不许碰删除那条路");
    await call(receive, { body: JSON.stringify({ pack: goodPack(), confirm: true }) });
    assert.equal(rowsOf(s.store).length, 1);
    const preview = await call(undo, { body: JSON.stringify({ packId: PACK_ID }) });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.deleted, 1);
    assert.equal(preview.body.dry_run, true);
    assert.equal(preview.body.sample.length, 1, "清点清单是给人核对「收起的是哪一批」的");
    assert.equal(rowsOf(s.store).length, 1, "预览那一次一行都没删");
    const gone = await call(undo, { body: JSON.stringify({ packId: PACK_ID, confirm: true }) });
    assert.equal(gone.body.dry_run, false);
    assert.equal(gone.body.deleted, 1);
    assert.equal(rowsOf(s.store).length, 0, "退出是物删，不归档");
    const again = await call(undo, { body: JSON.stringify({ packId: PACK_ID, confirm: true }) });
    assert.equal(again.status, 200);
    assert.equal(again.body.deleted, 0, "重跑说 0，不报错");
  } finally { s.close(); }
});

// --- Bearer 数据面（src/api-standalone.js）-----------------------------------
//
// 这一面没有 policy 名：除 GET /health 外每条路由都要自己的 Bearer token（面板那半的
// token-write 在这里压根不存在）。真 HTTP 照 test/standalone-api.test.js:18 与车道 A 的
// 起法（port 0 + ready + api.token + server.close），库仍要落文件——收侧吃的是
// share_pack_id / external_id 那两列与部分 UNIQUE 索引，`:memory:` 摸不到真的行。
// 偶发的 Windows EACCES（保留端口段）是环境性的，重跑即可，不改代码去迁就它。

function standaloneSetup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-receive-std-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const api = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: 0 });
  return api.ready.then(() => {
    const handlers = api.server.listeners("request");
    assert.equal(handlers.length, 1, "这台面上只许挂着一个 request handler，否则下面那条锁问不出是谁");
    return {
      api, store, service,
      base: `http://127.0.0.1:${api.port}`,
      auth: { authorization: `Bearer ${api.token}` },
      handler: handlers[0],
      close() {
        api.server.closeIdleConnections?.();
        api.server.close();
        try { store.close(); } catch { /* already closed */ }
        rmSync(dir, { recursive: true, force: true });
      }
    };
  });
}

/** 喂给 mounted handler 的假 req：与真 IncomingMessage 一样是 EventEmitter。 */
function standaloneReq({ method = "POST", url = "/receive", body = "", auth = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = auth ? { authorization: auth } : {};
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

test("the data plane gates receive, lands a pack and undoes it", async () => {
  const h = await standaloneSetup();
  // 一条死线，不是装饰：路由整个没接上时（变异探针实测——把非 POST 的 405 那一支删掉）
  // server 一个字都不答、连接一直悬着，用例要挂满 305 秒才红，那是在拖整条 CI 腿而不是
  // 在报回归。超时之后断言「必须得到答复」这一句，比一个 TimeoutError 堆栈有用得多。
  const viaHttp = async (p, init = {}) => {
    const res = await fetch(`${h.base}${p}`, { ...init, signal: AbortSignal.timeout(3000) }).catch(() => null);
    assert.ok(res, `${init.method ?? "GET"} ${p}：数据面必须在 3s 内给出答复（挂着不答 = 对面永远等不到）`);
    return res;
  };
  try {
    const packJson = JSON.stringify({ pack: goodPack() });
    // 本面除 /health 外一律要 Bearer：没有 policy 名可绕，401 是唯一的前门。
    for (const [path, body] of [["/receive", packJson], ["/receive/undo", JSON.stringify({ packId: PACK_ID })]]) {
      const anon = await viaHttp(path, { method: "POST", body });
      assert.equal(anon.status, 401, `POST ${path} 不带 token 一步都不许往下走`);
      assert.deepEqual(await anon.json(), { error: "unauthorized" });
    }

    const dry = await viaHttp("/receive", { method: "POST", headers: h.auth, body: packJson });
    assert.equal(dry.status, 200);
    const dryBody = await dry.json();
    assert.equal(dryBody.dry_run, true);
    assert.equal(dryBody.created, 1);
    assert.equal(rowsOf(h.store).length, 0, "没点确认就一个字都不许写");

    const real = await viaHttp("/receive", { method: "POST", headers: h.auth, body: JSON.stringify({ pack: goodPack(), confirm: true }) });
    assert.equal((await real.json()).created, 1);
    assert.equal(rowsOf(h.store).length, 1);
    assert.equal(rowsOf(h.store)[0].share_pack_id, PACK_ID, "落的必须是带包身份的外来行");

    const again = await viaHttp("/receive", { method: "POST", headers: h.auth, body: JSON.stringify({ pack: goodPack(), confirm: true }) });
    const againBody = await again.json();
    assert.equal(againBody.created, 0, "幂等要穿过 HTTP 这一层，不只是 service 内部");
    assert.equal(againBody.skipped_existing, 1);
    assert.equal(rowsOf(h.store).length, 1, "重跑一行都不多");

    // 非 POST 一律 405，与面板逐字同款（#411：两张皮只许差在鉴权、路径与面板独有的
    // disposition/logger，状态码不许是第四处差别）。带着 token 走一遍，问的正是
    // 「405 这一支不藏在 401 后面」。
    for (const [path, method] of [["/receive", "GET"], ["/receive", "PUT"], ["/receive/undo", "GET"], ["/receive/undo", "DELETE"]]) {
      const out = await viaHttp(path, { method, headers: h.auth });
      assert.equal(out.status, 405, `${method} ${path} 必须回 405，got ${out.status}`);
      assert.deepEqual(await out.json(), { error: "method-not-allowed" });
    }

    const badJson = await viaHttp("/receive", { method: "POST", headers: h.auth, body: "{oops" });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, "invalid-json", "发坏了 ≠ 发错了形状 ≠ 没带包");
    const badKind = await viaHttp("/receive", { method: "POST", headers: h.auth, body: JSON.stringify({ pack: { kind: "nope" } }) });
    assert.equal(badKind.status, 400);
    assert.equal((await badKind.json()).error, "invalid-kind", "闸门那半的码也要从这张脸上原样出来");
    const badUndo = await viaHttp("/receive/undo", { method: "POST", headers: h.auth, body: "{}" });
    assert.equal(badUndo.status, 400);
    assert.equal((await badUndo.json()).error, "missing-pack-id");

    const preview = await viaHttp("/receive/undo", { method: "POST", headers: h.auth, body: JSON.stringify({ packId: PACK_ID }) });
    const previewBody = await preview.json();
    assert.equal(previewBody.deleted, 1);
    assert.equal(previewBody.dry_run, true);
    assert.equal(rowsOf(h.store).length, 1, "预览那一次一行都没删");
    const gone = await viaHttp("/receive/undo", { method: "POST", headers: h.auth, body: JSON.stringify({ packId: PACK_ID, confirm: true }) });
    assert.equal((await gone.json()).deleted, 1);
    assert.equal(rowsOf(h.store).length, 0, "退出是物删，不归档");

    // 超限那一支：readBody 自己答 413 并把 text 解析成 null，handler 少那句 return 就会
    // 在已经发出的响应上再写一次（真 socket 上第二次 writeHead 抛 ERR_HTTP_HEADERS_SENT）。
    // 这里按状态码与答复体核对口径与面板一致（本面 sendJson 没有 headers 参数，也就
    // 没有 Content-Disposition 可锁）。
    const oversize = await viaHttp("/receive", { method: "POST", headers: h.auth, body: "x".repeat(MAX_BODY_BYTES + 1) });
    assert.equal(oversize.status, 413);
    assert.equal((await oversize.json()).error, "payload-too-large");
    assert.equal(oversize.headers.get("content-disposition"), null, "本面不出附件头");
  } finally { await h.close(); }
});

test("the data plane's own .catch answers when the sink fails mid-write", async () => {
  // 共用层从不抛、日志也已被守卫吞掉，所以本面这条链还能被走到的只剩**面自己**写答复
  // 那一步。真 socket 在这里帮不上忙（writeHead 一抛，头就已经发出去了，第二次写只会
  // 再抛一次），所以直接驱动挂在这个 server 上的那个 handler，让假 sink 第一次抛、
  // 第二次正常：能等到答复，就证明 .catch 在位。等不到（竞速输给超时）就是 #410 的
  // 「一个字节都没回」——那正是这份文件历史上反复出现的那一类故障。
  const h = await standaloneSetup();
  try {
    for (const [path, body] of [
      ["/receive", JSON.stringify({ pack: goodPack() })],
      ["/receive/undo", JSON.stringify({ packId: PACK_ID })]
    ]) {
      const res = new FakeRes({ failFirstHead: true });
      h.handler(standaloneReq({ url: path, body, auth: `Bearer ${h.api.token}` }), res);
      const settled = await Promise.race([res.settled, new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
      assert.equal(settled, "ended", `${path} 的 promise 链必须由 .catch 接住，否则永远等不到答复`);
      assert.equal(res.statusCode, 500, `${path} sink 坏了也要把答复交出去`);
      assert.deepEqual(res.body ? JSON.parse(res.body) : null, { error: "internal" });
      assert.equal(res.heads, 1, "抛掉的那一次没写出去，成功的只许有一次");
    }
    assert.equal(rowsOf(h.store).length, 0);
  } finally { await h.close(); }
});

// 两张皮都接上之后才补得了这一条（C5 时数据面还没有 /receive，锁无可锁）。车道 A 的
// 同款先例在 test/share-http.test.js 末尾。它管的是**方向**：上一段静态锁说「口径字面量
// 不许出现在面上」，这一条说反面——共用构造器必须真的被两侧各调一次。#411 那次的形状是
// 面板侧修好了、数据面停在复制的旧形态，而复制出去的代码不会留下任何让静态检查发现的痕迹。
test("both surfaces call the shared receive builders", () => {
  for (const file of ["api.js", "api-standalone.js"]) {
    const text = src(file);
    for (const needle of ["receiveReply(", "undoReply(", "parseReceiveBody(", "parseUndoBody("]) {
      assert.ok(text.includes(needle), `${file} must call ${needle}`);
    }
    assert.ok(!text.includes("share-import-unavailable"), `${file} must not re-implement the unavailable literal`);
    assert.ok(!text.includes("invalid-kind"), `${file} must not re-implement an import code`);
    assert.ok(!text.includes("missing-pack"), `${file} must not re-implement a parse code`);
  }
});
