// 记忆级溯源读出口的 HTTP 口径 —— 共用模块自己的锁。
//
// 这个文件盯两类回归：
//   a) 口径本身（id 解析、两种「空」的区分、窗口形状、原文按序）；
//   b) **不许再长出第二份实现**。#509 第一版曾把整段复製到 api.js 与
//      api-standalone.js 各一份，维护者在 review 里点名（本仓 #411 之后不收这个
//     形状）。下面的静态锁把「口径字面量只许出现在本模块」写成断言：谁要是再复制
//     一段出去，这里直接转红。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVENANCE_UNAVAILABLE,
  parseProvenanceQuery,
  provenanceReply
} from "../src/provenance-http.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  const r = provenanceReply({ service, id: "m1" });
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
  const r = provenanceReply({ service: fakeService(), id: "m1" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { memoryId: "m1", windows: [] });
});

test("provenanceReply：方法没接线是装配坏了——503，不与「没有来源」混为一个读数", () => {
  // headless / 旧装配：service 上没有这两个方法。
  const r = provenanceReply({ service: {}, id: "m1" });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, PROVENANCE_UNAVAILABLE);
});

test("provenanceReply：读抛错只 warn 并回 500，不把异常漏给调用方", () => {
  const warnings = [];
  const service = {
    provenanceFor: () => { throw new Error("db locked"); },
    distillRecordsFor: () => []
  };
  const r = provenanceReply({ service, id: "m1", warn: (m) => warnings.push(m) });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "internal");
  assert.equal(warnings.length, 1, "失败要留痕");
  assert.match(warnings[0], /memory provenance read failed/);
});

test("🔴 静态锁：口径字面量与共用答复只许出现在本模块，两个入口都要真的走它", () => {
  // #509 第一版把整段复制到了两张皮各一份——本仓 #411 之后不收这个形状。
  for (const name of ["api.js", "api-standalone.js"]) {
    const src = readFileSync(join(ROOT, "src", name), "utf8");
    assert.ok(src.includes("provenance-http.js"), `src/${name} 必须从共用模块取口径`);
    assert.ok(src.includes("provenanceReply("), `src/${name} 要真的走共用答复`);
    assert.ok(!src.includes("provenance-unavailable"), `src/${name} 不准自己写错误码字面量`);
  }
});
