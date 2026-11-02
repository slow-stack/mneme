// 记忆级溯源读出口的 HTTP 口径 —— 共用模块自己的锁。
//
// 这个文件盯三类回归：
//   a) 口径本身（id 解析、两种「空」的区分、窗口形状、原文按序）；
//   b) distillRecords.enabled 门（#509 评审整改）：判据 fail-closed、409 赢 503、
//      关着时一次都不碰 service；
//   c) **不许再长出第二份实现**。#509 第一版曾把整段复製到 api.js 与
//      api-standalone.js 各一份，维护者在 review 里点名（本仓 #411 之后不收这个
//     形状）。静态锁把三件事写成断言：口径字面量与开关判据只许出现在本模块、两个
//     壳都真的把 config 转交进来、读侧判据与写侧 summarize.js 逐字同源。谁要是再
//     复制一段出去，这里直接转红。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISTILL_RECORDS_DISABLED,
  PROVENANCE_DEFAULT_WINDOWS,
  PROVENANCE_MAX_WINDOWS,
  PROVENANCE_UNAVAILABLE,
  isDistillRecordsEnabled,
  parseProvenanceLimit,
  parseProvenanceSelector,
  provenanceReply
} from "../src/provenance-http.js";

// 方向 1 的选择器：绝大多数用例只关心「读出去的那一侧」，方向本身用这个常量固定。
const MEM = { mode: "memory", memoryId: "m1", limit: PROVENANCE_DEFAULT_WINDOWS };
const SES = { mode: "session", sessionId: "s1", limit: PROVENANCE_DEFAULT_WINDOWS };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 开着开关的 cfg：这个端点返回蒸馏窗口的逐字原文，所以测试里的「正常路径」必须
// 显式把开关打开——不传就是关（fail-closed），没有「默认开」这回事。
const RECORDS_ON = { distillRecords: { enabled: true } };

function fakeService(over = {}) {
  return {
    provenanceFor: (id) => over.links ?? [],
    // #524 方向 2 的存储读法：按会话列窗口（store 侧 GROUP BY 成一行一窗口）。
    distillWindowsFor: (sessionId, limit) => over.windows ?? [],
    distillRecordsFor: (sessionId, from, to) => over.records ?? [],
    ...over.service
  };
}

// --- 入参：两个互斥主键 + limit（#524）---------------------------------------
// 方向 2 复用同一条路径，于是「哪个主键说了算」必须是个**显式**判断：都缺是请求
// 不成立（400 missing-id），都给也要 400——择一意味着调用方发一个自己也不知道会
// 读哪个主键的请求，而两个方向的结果形状不同（memoryId / sessionId 各有自己的键）。

test("parseProvenanceSelector：两个主键都缺 → 400 missing-id", () => {
  for (const params of [
    {}, { memoryId: null, sessionId: null }, { memoryId: "", sessionId: "" },
    { memoryId: "   ", sessionId: "\t" }
  ]) {
    const r = parseProvenanceSelector(params);
    assert.equal(r.ok, false, `${JSON.stringify(params)} 不该通过`);
    assert.equal(r.status, 400);
    assert.equal(r.error, "missing-id");
  }
});

test("parseProvenanceSelector：两个主键都给 → 400 ambiguous-id（不静默择一）", () => {
  const r = parseProvenanceSelector({ memoryId: "m1", sessionId: "s1" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.error, "ambiguous-id");
});

test("parseProvenanceSelector：两端空白裁掉，方向按哪个主键非空确定，limit 缺省 20", () => {
  assert.deepEqual(parseProvenanceSelector({ memoryId: " m1 " }), {
    ok: true,
    selector: { mode: "memory", memoryId: "m1", limit: PROVENANCE_DEFAULT_WINDOWS }
  });
  assert.deepEqual(parseProvenanceSelector({ sessionId: " s1 ", memoryId: "  " }), {
    ok: true,
    selector: { mode: "session", sessionId: "s1", limit: PROVENANCE_DEFAULT_WINDOWS }
  }, "另一侧是空白串时按缺省处理，不算「都给」");
});

test("parseProvenanceLimit：只收十进制整数字面量，畸形与越界都算 400", () => {
  assert.equal(parseProvenanceLimit(null).limit, PROVENANCE_DEFAULT_WINDOWS, "不带就是缺省");
  assert.equal(parseProvenanceLimit("1").limit, 1);
  assert.equal(parseProvenanceLimit(String(PROVENANCE_MAX_WINDOWS)).limit, PROVENANCE_MAX_WINDOWS);
  // 两端空白是**裁掉**而不是判畸形——与 id 的处理保持一致（"  12 " 就是 12）。
  // 但裁完必须是纯十进制字面量。
  assert.equal(parseProvenanceLimit(" 12 ").limit, 12, "两端空白裁掉，与 id 一致");
  // 下面这些如果走 Number()，"" / " " 会化成 0 个窗口，十六进制与指数写法也会被
  // 静默接受——一个畸形输入拿到最坏解释。所以这里逐个钉住。
  for (const raw of [
    "", "   ", "0", "-1", "1.5", "1e3", "0x10", "abc", "+1", "12abc",
    String(PROVENANCE_MAX_WINDOWS + 1), "99999999999999999999"
  ]) {
    const r = parseProvenanceLimit(raw);
    assert.equal(r.ok, false, `${JSON.stringify(raw)} 不该通过`);
    assert.equal(r.status, 400);
    assert.equal(r.error, "invalid-limit");
  }
});

test("parseProvenanceSelector：limit 畸形时连着主键一起 400（入参形状先于功能开关）", () => {
  const r = parseProvenanceSelector({ sessionId: "s1", limit: "abc" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.error, "invalid-limit");
});

test("provenanceReply：一个链接一个窗口，原文按 seq 升序且不越界", () => {
  const seen = [];
  const service = {
    provenanceFor: () => [{ session_id: "s1", seq_start: 10, seq_end: 12, created_at: "2026-10-23T00:00:00Z" }],
    distillRecordsFor: (sessionId, from, to) => {
      seen.push([sessionId, from, to]);
      return [{ seq: 12 }, { seq: 10 }, { seq: 11 }];
    }
  };
  const r = provenanceReply({ service, selector: MEM, config: RECORDS_ON });
  assert.equal(r.status, 200);
  assert.equal(r.body.memoryId, "m1");
  assert.equal(r.body.windows.length, 1);
  const w = r.body.windows[0];
  assert.equal(w.session_id, "s1");
  assert.equal(w.seq_start, 10);
  assert.equal(w.seq_end, 12);
  assert.equal(w.created_at, "2026-10-23T00:00:00Z");
  assert.deepEqual(w.records.map((x) => x.seq), [12, 10, 11], "次序由 store 的 ORDER BY seq 保证，答复层不改序");
  assert.deepEqual(seen, [["s1", 10, 12]], "区间原样透传给 store");
});

test("provenanceReply #512：窗口带得动归属的那一轮 run，读不到就整组缺省而不是猜", () => {
  const runs = new Map([["r1", { run_type: "autoSummarize", trigger_source: "autoSummarize", status: "ok" }]]);
  const service = {
    provenanceFor: () => [
      { session_id: "s1", seq_start: 10, seq_end: 12, created_at: "2026-11-02T00:00:00Z", distill_run_id: "r1" },
      // 改造之前写下的链接：distill_run_id 是 NULL。
      { session_id: "s1", seq_start: 20, seq_end: 22, created_at: "2026-09-01T00:00:00Z", distill_run_id: null }
    ],
    distillRecordsFor: () => [],
    getDistillRun: (id) => runs.get(id),
    mintsFor: () => [{ run_id: "d1", run_type: "dream", trigger_source: "autoDream", created_at: "2026-11-01T00:00:00Z" }]
  };
  const r = provenanceReply({ service, selector: MEM, config: RECORDS_ON });
  assert.equal(r.status, 200);
  const [fresh, legacy] = r.body.windows;
  assert.equal(fresh.distill_run_id, "r1");
  assert.equal(fresh.run_type, "autoSummarize");
  assert.equal(fresh.trigger_source, "autoSummarize");
  assert.equal(fresh.run_status, "ok");
  // 历史链接：id 为 null，三个派生字段也必须是 null——不许拿区间或时间戳反推一轮。
  assert.equal(legacy.distill_run_id, null);
  assert.equal(legacy.run_type, null, "没有 run 就不给类型，否则等于替用户编了一次归因");
  assert.equal(legacy.trigger_source, null);
  assert.equal(legacy.run_status, null);
  assert.equal(r.body.mints.length, 1);
  assert.equal(r.body.mints[0].run_type, "dream");
});

test("provenanceReply #512：service 没有 run 读取能力时，窗口字段照旧齐全但归因为空", () => {
  // headless / 旧装配：provenanceFor 与 distillRecordsFor 在，getDistillRun / mintsFor 不在。
  const service = {
    provenanceFor: () => [{ session_id: "s1", seq_start: 1, seq_end: 2, created_at: "2026-11-02T00:00:00Z", distill_run_id: "r9" }],
    distillRecordsFor: () => []
  };
  const r = provenanceReply({ service, selector: MEM, config: RECORDS_ON });
  assert.equal(r.status, 200, "读 run 的能力缺一档不算装配坏——窗口本身仍可读");
  assert.equal(r.body.windows[0].distill_run_id, "r9");
  assert.equal(r.body.windows[0].run_type, null);
  assert.deepEqual(r.body.mints, []);
});

test("provenanceReply：没有链接是有效答案——空 windows，200 不是 404", () => {
  const r = provenanceReply({ service: fakeService(), selector: MEM, config: RECORDS_ON });
  assert.equal(r.status, 200);
  // #524 的 truncated 与 #512 的 mints 都是答复级读数，各自独立缺省。
  assert.deepEqual(r.body, { memoryId: "m1", windows: [], truncated: false, mints: [] });
});

test("provenanceReply：方法没接线是装配坏了——503，不与「没有来源」混为一个读数", () => {
  // headless / 旧装配：service 上没有这两个方法。
  const r = provenanceReply({ service: {}, selector: MEM, config: RECORDS_ON });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, PROVENANCE_UNAVAILABLE);
});

test("provenanceReply：读抛错只 warn 并回 500，不把异常漏给调用方", () => {
  const warnings = [];
  const service = {
    provenanceFor: () => { throw new Error("db locked"); },
    distillRecordsFor: () => []
  };
  const r = provenanceReply({ service, selector: MEM, config: RECORDS_ON, warn: (m) => warnings.push(m) });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "internal");
  assert.equal(warnings.length, 1, "失败要留痕");
  assert.match(warnings[0], /memory provenance read failed/);
});

// --- distillRecords.enabled 门（#509 评审整改）--------------------------------
// 写侧（src/summarize.js:988）早就吃这个开关，读出口此前一处都不读：关着时历史
// 原文照旧留在库里、还多一个能读出去的口。门加在共用模块里，两个壳都吃它。

test("isDistillRecordsEnabled：只认严格的 true，其余一律算关（fail-closed）", () => {
  assert.equal(isDistillRecordsEnabled({ distillRecords: { enabled: true } }), true);
  for (const cfg of [
    null, undefined, {}, { distillRecords: null }, { distillRecords: {} },
    { distillRecords: { enabled: false } },
    // 非布尔值：字符串 / 数字都不该被当成开——那是配置写错了，不是用户开了
    { distillRecords: { enabled: "true" } },
    { distillRecords: { enabled: 1 } }
  ]) {
    assert.equal(isDistillRecordsEnabled(cfg), false, `${JSON.stringify(cfg)} 必须算关`);
  }
});

test("provenanceReply：开关没开 → 409 distill-records-disabled，一个键都不多带", () => {
  // config 整个缺失（旧调用方直连、daemon 最小 cfg）也走这一格：默认方向必须是关。
  for (const cfg of [null, undefined, {}, { distillRecords: { enabled: false } }]) {
    const r = provenanceReply({ service: fakeService(), selector: MEM, config: cfg });
    assert.equal(r.status, 409, `${JSON.stringify(cfg)} → 409`);
    assert.deepEqual(r.body, { error: DISTILL_RECORDS_DISABLED },
      "body 只准有 error 一个键——不带 memoryId / windows，调用方不会把「功能关了」读成「这条记忆没有来源」");
  }
});

test("provenanceReply：409 赢 503——「用户关了」比「装配坏了」更具体", () => {
  // 关着 + service 上连方法都没有：报 503 会让人去查一个没坏的部署。
  const r = provenanceReply({ service: {}, selector: MEM, config: { distillRecords: { enabled: false } } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, DISTILL_RECORDS_DISABLED);
});

test("provenanceReply：开关关着时一次 SQL 都不发（不碰 service）", () => {
  // 门要在读之前：关着还被调用方当成「能读」是次要的，白跑一趟库才是真浪费。
  let touched = 0;
  const service = fakeService({ service: {
    provenanceFor: () => { touched++; return []; },
    distillRecordsFor: () => { touched++; return []; }
  } });
  provenanceReply({ service, selector: MEM, config: null });
  assert.equal(touched, 0);
});

test("provenanceReply：开关开着才读得到——200 与 409 是同一把门的两个方向", () => {
  const service = fakeService({ links: [{ session_id: "s1", seq_start: 1, seq_end: 1, created_at: "t" }], records: [{ seq: 1 }] });
  const on = provenanceReply({ service, selector: MEM, config: RECORDS_ON });
  assert.equal(on.status, 200);
  assert.equal(on.body.windows.length, 1);
  const off = provenanceReply({ service, selector: MEM, config: { distillRecords: { enabled: false } } });
  assert.equal(off.status, 409);
  assert.deepEqual(off.body, { error: DISTILL_RECORDS_DISABLED });
});

// --- 方向 2：会话 → 窗口（#524）--------------------------------------------

test("provenanceReply（session 方向）：一行一窗口，原文按区间取，答复带 sessionId", () => {
  const asked = [];
  const service = {
    distillWindowsFor: (sid, limit) => {
      asked.push([sid, limit]);
      return [
        { session_id: "s1", seq_start: 5, seq_end: 9, created_at: "t2", link_count: 2 },
        { session_id: "s1", seq_start: 1, seq_end: 4, created_at: "t1", link_count: 1 }
      ];
    },
    distillRecordsFor: (sid, from, to) => [{ seq: from }, { seq: to }]
  };
  const r = provenanceReply({ service, selector: SES, config: RECORDS_ON });
  assert.equal(r.status, 200);
  assert.equal(r.body.sessionId, "s1", "session 方向的答复用 sessionId 认领，不冒充 memoryId");
  assert.equal(r.body.truncated, false);
  assert.deepEqual(r.body.windows.map((w) => [w.seq_start, w.seq_end]), [[5, 9], [1, 4]],
    "次序由 store 的 ORDER BY seq_start 保证，答复层不改序");
  assert.deepEqual(r.body.windows[0].records.map((x) => x.seq), [5, 9], "每个窗口装自己区间的原文");
  assert.equal(r.body.windows[0].link_count, 2, "同一窗口派生了 2 条记忆——这个计数是「按窗口看」的第二维");
  // 多取一行判截断：store 侧只照 limit 取，不替调用方判断「还有没有」。
  assert.deepEqual(asked, [["s1", PROVENANCE_DEFAULT_WINDOWS + 1]]);
});

test("provenanceReply：撞上 limit 时 truncated=true，且多出来的那条不许漏出去", () => {
  // 少了这个读数，被截断的答复与「本来就只有这么多」逐字节相同——调用方会把半份
  // 转录当成全部，这正是这张脸最容易骗人的地方。
  const service = {
    distillWindowsFor: () => [1, 2, 3].map((n) => ({
      session_id: "s1", seq_start: n, seq_end: n, created_at: "t", link_count: 1
    })),
    distillRecordsFor: () => []
  };
  const r = provenanceReply({ service, selector: { ...SES, limit: 2 }, config: RECORDS_ON });
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, true);
  assert.equal(r.body.windows.length, 2, "limit=2 就只许回 2 个窗口，探针那一条不能混进答复");
});

test("provenanceReply：memory 方向也带 truncated（两个方向共一个读数）", () => {
  const service = {
    provenanceFor: () => [1, 2].map((n) => ({
      session_id: "s1", seq_start: n, seq_end: n, created_at: "t"
    })),
    distillRecordsFor: () => []
  };
  const r = provenanceReply({ service, selector: { ...MEM, limit: 1 }, config: RECORDS_ON });
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, true);
  assert.equal(r.body.windows.length, 1);
  assert.equal(r.body.memoryId, "m1");
});

test("provenanceReply：503 按方向判——只缺 session 那侧的方法时，memory 查询照旧 200", () => {
  // 把一个方向的问题报成整张脸坏了，会让人去查一个没坏的部署。
  const onlyMemory = {
    provenanceFor: () => [],
    distillRecordsFor: () => []
  };
  const ses = provenanceReply({ service: onlyMemory, selector: SES, config: RECORDS_ON });
  assert.equal(ses.status, 503);
  assert.equal(ses.body.error, PROVENANCE_UNAVAILABLE);
  const mem = provenanceReply({ service: onlyMemory, selector: MEM, config: RECORDS_ON });
  assert.equal(mem.status, 200, "缺的只是方向 2 的方法，方向 1 不该跟着坏");
});

test("provenanceReply：开关关着时 session 方向也 409，且一次 SQL 都不发", () => {
  let touched = 0;
  const service = {
    distillWindowsFor: () => { touched++; return []; },
    distillRecordsFor: () => { touched++; return []; }
  };
  const r = provenanceReply({ service, selector: SES, config: { distillRecords: { enabled: false } } });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: DISTILL_RECORDS_DISABLED }, "方向不同，门是同一把");
  assert.equal(touched, 0);
});

test("🔴 静态锁：口径字面量与共用答复只许出现在本模块，两个入口都要真的走它", () => {
  // #509 第一版把整段复制到了两张皮各一份——本仓 #411 之后不收这个形状。
  for (const name of ["api.js", "api-standalone.js"]) {
    const src = readFileSync(join(ROOT, "src", name), "utf8");
    assert.ok(src.includes("provenance-http.js"), `src/${name} 必须从共用模块取口径`);
    assert.ok(src.includes("provenanceReply("), `src/${name} 要真的走共用答复`);
    assert.ok(!src.includes("provenance-unavailable"), `src/${name} 不准自己写错误码字面量`);
    assert.ok(!src.includes("distill-records-disabled"), `src/${name} 不准自己写「功能关了」的错误码字面量`);
    // 判据也不许重写：两个壳各自算一遍 config?.distillRecords?.enabled === true，
    // 就是读写两道门漂移的形状（本文件上面的注释写过这笔账）。
    assert.ok(!src.includes("distillRecords?.enabled === true"),
      `src/${name} 不准自己写开关判据——只许把 config 转交给共用模块`);
    // 而且要真的转交了：壳里调 provenanceReply 时必须带上 config。
    assert.match(src, /provenanceReply\(\{ service, selector: parsed\.selector, config,/,
      `src/${name} 要把本入口的 config 传给共用模块，否则门永远读不到用户的开关`);
  }
});

test("🔴 静态锁：读侧判据与写侧 src/summarize.js 逐字同源", () => {
  // 「读写两道门永不分歧」不能只活在注释里：写侧那句话在 summarize.js，读侧在本
  // 模块，两边必须是同一个字符串。谁改了其中一边，这里转红。
  const shared = readFileSync(join(ROOT, "src", "provenance-http.js"), "utf8");
  const writeSide = readFileSync(join(ROOT, "src", "summarize.js"), "utf8");
  const readSide = readFileSync(join(ROOT, "src", "index.js"), "utf8");
  const criterion = "config?.distillRecords?.enabled === true";
  assert.ok(shared.includes(criterion), "共用模块要写判据（读侧唯一一份）");
  assert.ok(writeSide.includes(criterion), "写侧 summarize.js 要还在用同一个判据");
  // 读侧只准有一份：两个壳各写一遍的漂移形状，静态锁上一节已经禁了壳，这里禁
  // 共用模块自己长出第二份。
  assert.equal(shared.split(criterion).length - 1, 1, "共用模块里判据只许出现一次");
  // 写侧那一处（启动期裁剪）与它同源，所以三处各一份、彼此逐字相同。
  assert.ok(readSide.includes("cfg.distillRecords?.enabled === true"), "index.js 的启动裁剪判据应保持同族");
});
