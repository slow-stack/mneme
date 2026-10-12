// 存储回收（maintenance/reclaim）的 HTTP 口径 —— 共用模块自己的锁。
//
// 这个文件盯两类回归：
//   a) 口径本身（解析、校验、答复形状）。表驱动跑全量边界，因为这张脸有两个入口，
//      任何一处口径松掉都会同时污染面板与数据面；
//   b) **不许再长出第二份实现**。历史上两个入口是整段复制的，于是 #410 修好面板侧
//      之后数据面还停在旧形态（#411）。下面的静态锁把「校验字面量只许出现在本模块」
//      写成断言：谁要是再复制一段出去，这里直接转红。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_RECLAIM_WINDOW_DAYS,
  RECLAIM_CONFIRM_HINT,
  parseReclaimQuery,
  parseReclaimJson,
  readReclaimFields,
  reclaimReply
} from "../src/reclaim-http.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 假 maintenance：记下每次调用的实参，回一个固定报告对象（用来锁「不加包装层」）。 */
function fakeMaintenance(report = { dryRun: true, planned: { dream_run_inputs: 1 } }) {
  const calls = [];
  return {
    calls,
    reclaim(options) {
      calls.push(options);
      return report;
    }
  };
}

// ---------------------------------------------------------------------------
// GET 侧：query 是字符串域
// ---------------------------------------------------------------------------
test("parseReclaimQuery: 只收十进制整数字面量，缺省才落默认窗口", () => {
  assert.deepEqual(parseReclaimQuery(null), { ok: true, olderThanDays: undefined }, "不传 = 落默认窗口");
  assert.deepEqual(parseReclaimQuery("0"), { ok: true, olderThanDays: 0 }, "0 是合法值（清全部快照）");
  assert.deepEqual(parseReclaimQuery("3"), { ok: true, olderThanDays: 3 });
  assert.deepEqual(parseReclaimQuery(String(MAX_RECLAIM_WINDOW_DAYS)), { ok: true, olderThanDays: MAX_RECLAIM_WINDOW_DAYS }, "上界本身合法");
});

test("parseReclaimQuery: 畸形输入一律 400，绝不被静默读成 0", () => {
  // Number() 会把 ""/[]/" " 都化成 0，而 0 在这里是「清掉全部快照」——最坏解释绝不能
  // 从一个畸形输入静默拿到。所以这里的每一条都必须拒，而不是回落。
  for (const bad of ["", " ", "3.5", "-1", "1e3", "0x10", "٣", "3 ", "+3", "abc"]) {
    assert.deepEqual(
      parseReclaimQuery(bad),
      { ok: false, error: "invalid-older-than-days" },
      `olderThanDays=${JSON.stringify(bad)} 必须被拒`
    );
  }
});

test("parseReclaimQuery: 量级超界被拒（十进制字面量不保证是个能算日期的数）", () => {
  // 400 位十进制字面量会化成 Infinity，maintenance 拿它算日期直接抛 RangeError。
  for (const huge of [String(MAX_RECLAIM_WINDOW_DAYS + 1), "100000000000000000000", "9".repeat(400)]) {
    assert.deepEqual(parseReclaimQuery(huge), { ok: false, error: "invalid-older-than-days" }, `olderThanDays=${huge.slice(0, 12)}… 必须被拒`);
  }
});

// ---------------------------------------------------------------------------
// POST 侧：JSON 数字域
// ---------------------------------------------------------------------------
test("parseReclaimJson: invalid-json 与 invalid-body 是两个不同的错", () => {
  assert.deepEqual(parseReclaimJson(""), { ok: true, body: {} }, "空 body 等价于 {}");
  assert.deepEqual(parseReclaimJson('{"a":1}'), { ok: true, body: { a: 1 } });
  assert.deepEqual(parseReclaimJson("{bad"), { ok: false, error: "invalid-json" }, "发坏了");
  assert.deepEqual(parseReclaimJson("null"), { ok: false, error: "invalid-body" }, "发成了 null");
  assert.deepEqual(parseReclaimJson("[]"), { ok: false, error: "invalid-body" }, "发成了数组");
  assert.deepEqual(parseReclaimJson('"x"'), { ok: false, error: "invalid-body" }, "发成了字符串");
});

test("readReclaimFields: 默认值与透传", () => {
  assert.deepEqual(
    readReclaimFields({}),
    { ok: true, dryRun: true, olderThanDays: undefined, vacuum: false, confirm: false },
    "缺省 = dry-run、默认窗口、不 VACUUM、未确认"
  );
  assert.deepEqual(
    readReclaimFields({ dryRun: false, olderThanDays: 30, vacuum: true, confirm: true }),
    { ok: true, dryRun: false, olderThanDays: 30, vacuum: true, confirm: true }
  );
  assert.deepEqual(readReclaimFields({ olderThanDays: null }).olderThanDays, undefined, "null 与缺省同义：落默认窗口，不是 0");
  assert.deepEqual(readReclaimFields({ olderThanDays: 0 }).olderThanDays, 0, "0 是合法值");
  assert.deepEqual(readReclaimFields({ olderThanDays: MAX_RECLAIM_WINDOW_DAYS }).olderThanDays, MAX_RECLAIM_WINDOW_DAYS);
});

test("readReclaimFields: 只收 JSON 数字，量级与形状都要过", () => {
  for (const bogus of ["", [], false, "3", true, 3.5, -1]) {
    assert.deepEqual(
      readReclaimFields({ olderThanDays: bogus }),
      { ok: false, error: "invalid-older-than-days" },
      `olderThanDays=${JSON.stringify(bogus)} 必须被拒`
    );
  }
  // 上界与 GET 侧同一条：1e20 也是「整数」，但 maintenance 拿它算日期会抛 RangeError。
  for (const huge of [MAX_RECLAIM_WINDOW_DAYS + 1, 1e20, 1e21]) {
    assert.deepEqual(readReclaimFields({ olderThanDays: huge }), { ok: false, error: "invalid-older-than-days" });
  }
  assert.deepEqual(readReclaimFields({ vacuum: "true" }), { ok: false, error: "invalid-vacuum" }, "vacuum 只收布尔");
  assert.equal(readReclaimFields({ confirm: "true" }).confirm, false, "confirm 只认真布尔：字符串不算确认");
});

// ---------------------------------------------------------------------------
// 答复：两个入口共用的那一份
// ---------------------------------------------------------------------------
test("reclaimReply: 没接线时 503，且根本不碰 maintenance", () => {
  const out = reclaimReply({ maintenance: null, dryRun: true });
  // 字面量而不是常量：这是调用方要分支的错误码，改一个字母就是对外行为变更。
  assert.deepEqual(out, { status: 503, body: { error: "maintenance-unavailable" } });
});

test("reclaimReply: dry-run 报原样透传，不加包装层", () => {
  const report = { dryRun: true, planned: { dream_run_inputs: 1 }, olderThanDays: 7 };
  const maintenance = fakeMaintenance(report);
  const out = reclaimReply({ maintenance, dryRun: true, olderThanDays: 7 });
  assert.equal(out.status, 200);
  assert.equal(out.body, report, "报告必须原样回，套一层 {report} 会打断既有消费方");
  assert.deepEqual(maintenance.calls, [{ olderThanDays: 7, vacuum: false, dryRun: true }]);
});

test("reclaimReply: 缺 confirm 只回报告不执行，且报告描述的是将要执行的那个动作", () => {
  const report = { dryRun: true, vacuum: { requested: true, ran: false } };
  const maintenance = fakeMaintenance(report);
  const out = reclaimReply({ maintenance, dryRun: false, olderThanDays: 30, vacuum: true });
  assert.equal(out.status, 400);
  assert.equal(out.body.error, "confirm-required");
  assert.equal(out.body.hint, RECLAIM_CONFIRM_HINT, "提示是给调用方看的下一步动作，两个入口必须逐字一致");
  assert.equal(out.body.report, report);
  assert.deepEqual(
    maintenance.calls,
    [{ olderThanDays: 30, vacuum: true, dryRun: true }],
    "报告必须带 vacuum：否则调用方看到的是「不 VACUUM」的数字，却带着 vacuum 去执行"
  );
});

test("reclaimReply: 确认后按原样执行", () => {
  const maintenance = fakeMaintenance({ dryRun: false, cleared: { dream_run_inputs: 1 } });
  const out = reclaimReply({ maintenance, dryRun: false, olderThanDays: 30, vacuum: true, confirm: true });
  assert.equal(out.status, 200);
  assert.deepEqual(maintenance.calls, [{ olderThanDays: 30, vacuum: true, dryRun: false }]);
});

test("reclaimReply: 抛错回 500 并留日志，原始错误文本不能吞", () => {
  const warnings = [];
  const maintenance = {
    reclaim() { throw new Error("database is locked"); }
  };
  for (const input of [
    { dryRun: true },
    { dryRun: false, confirm: true },
    { dryRun: false } // confirm-required 那份报告也是这里算的（#410）
  ]) {
    const out = reclaimReply({ maintenance, ...input, warn: (m) => warnings.push(String(m)) });
    assert.equal(out.status, 500, "三条会调 reclaim 的路径都必须回 500，不能无响应");
    assert.deepEqual(out.body, { error: "internal" });
  }
  assert.equal(warnings.length, 3);
  for (const w of warnings) {
    assert.match(w, /storage reclaim failed/);
    assert.match(w, /database is locked/, "原始错误文本要留住，否则现场无从下手");
  }
});

test("reclaimReply: 没有 logger 也不许把异常漏出去", () => {
  // warn 是可选的（数据面可能没接 logger）。少一个回调不能让异常穿出去变成
  // unhandled rejection——那正是 #410 的形态：客户端拿到的是「一个字节都没回」。
  const maintenance = { reclaim() { throw new Error("boom"); } };
  const out = reclaimReply({ maintenance, dryRun: false });
  assert.equal(out.status, 500);
});

// ---------------------------------------------------------------------------
// 防分叉：口径只许有一份实现
// ---------------------------------------------------------------------------
test("两个入口都不许再自己写一份回收口径", () => {
  // 每个字面量都是这张脸独有的：出现第二次就意味着又复制了一段校验/答复出去。
  const FORKED = [
    '"invalid-older-than-days"',
    '"invalid-vacuum"',
    '"confirm-required"',
    '"maintenance-unavailable"',
    "storage reclaim failed",
    "MAX_RECLAIM_WINDOW_DAYS"
  ];
  for (const name of ["api.js", "api-standalone.js"]) {
    const src = readFileSync(join(ROOT, "src", name), "utf8");
    for (const literal of FORKED) {
      assert.equal(
        src.includes(literal),
        false,
        `src/${name} 里不该再出现 ${literal}——回收口径只有 src/reclaim-http.js 一份`
      );
    }
    // 反向也要锁：光删掉字面量、不调共用模块，等于把功能删了。
    assert.ok(src.includes("reclaim-http.js"), `src/${name} 必须从共用模块取口径`);
  }
  const panel = readFileSync(join(ROOT, "src", "api.js"), "utf8");
  const data = readFileSync(join(ROOT, "src", "api-standalone.js"), "utf8");
  assert.ok(panel.includes("reclaimReply("), "面板侧要真的走共用答复");
  assert.ok(data.includes("reclaimReply("), "数据面要真的走共用答复");
  assert.ok(panel.includes("readReclaimFields("), "面板侧 POST 要真的走共用校验");
  assert.ok(data.includes("readReclaimFields("), "数据面要真的走共用校验");
});
