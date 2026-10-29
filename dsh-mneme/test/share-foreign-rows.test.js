// 外来区的服务端读数锁：面板要能「只筛外来行」并且「知道每行属于哪个包」。
// 盯三件事：
//   a) /list 的 source=imported 是**精确匹配**（src/store.js:1658），且 total 同口径——
//      面板的「外来」chip 直接吃这个参数，分页与计数不许各算一套；
//   b) /list 的面板行在**有包号时**才带 share_pack_id，普通行不带这个键（不是 null）。
//      这是抽屉「收起这个包」按钮的自门控依据，缺了它按钮就不该出现；
//   c) /search 的 DTO **既不带** share_pack_id，它的 `source` 也**不是**行来源——
//      service.searchMemories 给每条候选盖上召回渠道（`source: "keyword"|"vector"|"bm25"`，
//      src/service.js:939/966/974），把行自己的 provenance 覆盖掉了，所以搜索态压根读不出
//      「这条是不是外来的」。这一条锁住的是那个事实，不是待实现的功能，它同时是 D4 那条
//      「外来 chip 只管浏览态」裁定的凭据。哪天有人把召回渠道改名让开 `source`（那是另一刀，
//      牵动 recall_runs 的回执形状），这条会红，D4 的裁定届时要一起重看。
// 扩展点住在 HTTP 层不是 toApiList：模型工具严格复用后者（src/service.js:2094），
// archived/quality_score/heat 都在这同一处补，包号跟着走同一条路。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";
import { IMPORTED_SOURCE } from "../src/memory-source.js";
import { deriveExternalId } from "../src/share.js";

const PACK_ID = "0123456789abcdef";

class FakeRes {
  constructor() {
    this.statusCode = 0;
    this.body = "";
    this.headers = {};
  }
  writeHead(code, headers) {
    this.statusCode = code;
    this.headers = headers || {};
    return this;
  }
  end(text) {
    this.body = text ?? "";
    return this;
  }
}

function foreignSetup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-foreign-rows-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { logger: null, webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, "secret-token", null, null);
  return {
    store,
    service,
    routes,
    route(path) { return routes.find((r) => r.path === path); },
    close() {
      // 闭包拿 store，不用 this：裸调用下 this 是 undefined，异常被吞就变成
      // 「库没关就删目录」的 EPERM（同 share-routes.test.js 的理由）。
      try { store.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** GET 用的最小假 req：/list 与 /search 都是 policy open，不读 body。 */
function getReq(url) {
  return { method: "GET", url, headers: {} };
}

async function call(route, url) {
  const res = new FakeRes();
  await route.handler(getReq(url), res);
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
}

/** 造一条外来行，字段与真实入库路径同一套（src/share-import.js 的落值）。
 *  注意 store.save 直接返回**那一行**（`insertMemoryRow` 的结果，见 src/store.js:1180-1185），
 *  而 service.saveWithDedupe 返回 `{ action, memory }`——两个形状不一样，别混。 */
function foreignRow(store, title) {
  return store.save({
    type: "decision",
    title,
    content: "对方库里的原文，本机不巩固它。",
    tags: ["from-桉桉"],
    source: IMPORTED_SOURCE,
    share_pack_id: PACK_ID,
    share_external_id: deriveExternalId(PACK_ID, "decision", title, "deadbeef"),
    epistemic_status: "confirmed"
  });
}

test("list?source=imported returns only foreign rows and counts the same set", async () => {
  const h = foreignSetup();
  try {
    h.service.saveWithDedupe({ type: "decision", title: "我自己的决定", content: "本机原文", tags: [] });
    foreignRow(h.store, "外来决定一");
    foreignRow(h.store, "外来决定二");
    const out = await call(h.route("/api/dsh-mneme/list"), "/api/dsh-mneme/list?source=imported");
    assert.equal(out.status, 200);
    assert.equal(out.data.items.length, 2, "只回外来行");
    assert.equal(out.data.total, 2, "total 与行同口径，否则分页的 has-more 会算错");
    assert.ok(out.data.items.every((m) => m.source === IMPORTED_SOURCE));
    const all = await call(h.route("/api/dsh-mneme/list"), "/api/dsh-mneme/list");
    assert.equal(all.data.items.length, 3, "不带 source 时三条都在");
  } finally { h.close(); }
});

test("list puts share_pack_id on foreign panel rows and omits the key on own rows", async () => {
  const h = foreignSetup();
  try {
    const own = h.service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", tags: [] });
    foreignRow(h.store, "外来决定");
    const out = await call(h.route("/api/dsh-mneme/list"), "/api/dsh-mneme/list");
    assert.equal(out.status, 200);
    const foreign = out.data.items.find((m) => m.source === IMPORTED_SOURCE);
    const ownRow = out.data.items.find((m) => m.id === own.memory.id);
    assert.ok(foreign, "筛选结果里要有那条外来行");
    assert.ok(ownRow, "筛选结果里要有那条本机行");
    assert.equal(foreign.share_pack_id, PACK_ID);
    // 键**不存在**而不是 null：面板的按钮按 `memory.share_pack_id` 真值门控，
    // 一个 null 与一个 undefined 在 JSON 里是两种形状，锁死成一种。
    assert.equal("share_pack_id" in ownRow, false, "自己的行不许带包号键");
  } finally { h.close(); }
});

test("search DTO carries neither the pack id nor the row's own source", async () => {
  const h = foreignSetup();
  try {
    foreignRow(h.store, "外来检索命中");
    const out = await call(h.route("/api/dsh-mneme/search"), "/api/dsh-mneme/search?q=%E5%A4%96%E6%9D%A5%E6%A3%80%E7%B4%A2%E5%91%BD%E4%B8%AD");
    assert.equal(out.status, 200);
    assert.ok(out.data.items.length > 0, "关键词路径要能命中这条");
    assert.equal("share_pack_id" in out.data.items[0], false, "search 的 DTO 不带包号");
    // 召回渠道把行的 provenance 盖掉了（src/service.js:939/966/974）：这一格在搜索态**不是**
    // 行来源，所以「这条是不是外来的」在这张 DTO 上读不出来。D4 的外来 chip 因此只管浏览态。
    // 别把这条断言当 bug 去「修」——它是那条裁定的凭据，真要修的是召回侧的字段命名。
    assert.match(String(out.data.items[0].source), /^(keyword|vector|bm25)$/,
      "search 的 source 是召回渠道，不是行来源——正因为它有值且是渠道名，provenance 才读不出来");
  } finally { h.close(); }
});
