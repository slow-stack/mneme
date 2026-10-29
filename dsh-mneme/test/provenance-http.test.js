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
  PROVENANCE_UNAVAILABLE,
  isDistillRecordsEnabled,
  parseProvenanceQuery,
  provenanceReply
} from "../src/provenance-http.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 开着开关的 cfg：这个端点返回蒸馏窗口的逐字原文，所以测试里的「正常路径」必须
// 显式把开关打开——不传就是关（fail-closed），没有「默认开」这回事。
const RECORDS_ON = { distillRecords: { enabled: true } };

function fakeService(over = {}) {
  return {
    provenanceFor: (id) => over.links ?? [],
    distillRecordsFor: (sessionId, from, to) => over.records ?? [],
    ...over.service
  };
}

test("parseProvenanceQuery：空/缺失 id 报 400，非空原样通过", () => {
  for (const raw of [null, undefined, "", "   "]) {
    const r = parseProvenanceQuery(raw);
    assert.equal(r.ok, false, `${JSON.stringify(raw)} 不该通过`);
    assert.equal(r.status, 400);
    assert.equal(r.error, "missing-id");
  }
  assert.deepEqual(parseProvenanceQuery(" m1 "), { ok: true, id: "m1" }, "id 两端空白要裁掉");
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
  const r = provenanceReply({ service, id: "m1", config: RECORDS_ON });
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

test("provenanceReply：没有链接是有效答案——空 windows，200 不是 404", () => {
  const r = provenanceReply({ service: fakeService(), id: "m1", config: RECORDS_ON });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { memoryId: "m1", windows: [] });
});

test("provenanceReply：方法没接线是装配坏了——503，不与「没有来源」混为一个读数", () => {
  // headless / 旧装配：service 上没有这两个方法。
  const r = provenanceReply({ service: {}, id: "m1", config: RECORDS_ON });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, PROVENANCE_UNAVAILABLE);
});

test("provenanceReply：读抛错只 warn 并回 500，不把异常漏给调用方", () => {
  const warnings = [];
  const service = {
    provenanceFor: () => { throw new Error("db locked"); },
    distillRecordsFor: () => []
  };
  const r = provenanceReply({ service, id: "m1", config: RECORDS_ON, warn: (m) => warnings.push(m) });
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
    const r = provenanceReply({ service: fakeService(), id: "m1", config: cfg });
    assert.equal(r.status, 409, `${JSON.stringify(cfg)} → 409`);
    assert.deepEqual(r.body, { error: DISTILL_RECORDS_DISABLED },
      "body 只准有 error 一个键——不带 memoryId / windows，调用方不会把「功能关了」读成「这条记忆没有来源」");
  }
});

test("provenanceReply：409 赢 503——「用户关了」比「装配坏了」更具体", () => {
  // 关着 + service 上连方法都没有：报 503 会让人去查一个没坏的部署。
  const r = provenanceReply({ service: {}, id: "m1", config: { distillRecords: { enabled: false } } });
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
  provenanceReply({ service, id: "m1", config: null });
  assert.equal(touched, 0);
});

test("provenanceReply：开关开着才读得到——200 与 409 是同一把门的两个方向", () => {
  const service = fakeService({ links: [{ session_id: "s1", seq_start: 1, seq_end: 1, created_at: "t" }], records: [{ seq: 1 }] });
  const on = provenanceReply({ service, id: "m1", config: RECORDS_ON });
  assert.equal(on.status, 200);
  assert.equal(on.body.windows.length, 1);
  const off = provenanceReply({ service, id: "m1", config: { distillRecords: { enabled: false } } });
  assert.equal(off.status, 409);
  assert.deepEqual(off.body, { error: DISTILL_RECORDS_DISABLED });
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
    assert.match(src, /provenanceReply\(\{ service, id: parsed\.id, config,/,
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
