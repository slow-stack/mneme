// 接收侧的格式闸门。锁三件事：
//   a) 一个不合规的包**整包**不合格（车道 C 不许半途入库）；
//   b) 键必须可重算——包是别人发来的，重算对不上就是被人改过，幂等键失效；
//   c) 允许的类型集合不许偷偷跟着 mirror 扩：这里刻意重述一遍，并由静态锁比对
//      TYPE_FILE 的键集减去两个排除项，将来加第 9 类时它会转红提醒人来决定。
import test from "node:test";
import assert from "node:assert/strict";
// 静态锁用真仪器而不是源码正则：test/mirror-types.test.js 已经是 import TYPE_FILE +
// Object.keys 的先例。在**测试**里 import 它不花钱——src/share.js 的重述字面集照旧，
// 那是接收侧的兼容契约，不是漂移。
import { TYPE_FILE } from "../src/mirror.js";
import {
  PACK_ID_RE, SHARE_ALLOWED_TYPES, SHARE_READONLY_TYPES, SHARE_EXCLUDED_TYPES,
  importedTagFor, validateSharePack, deriveExternalId, SHARE_KIND
} from "../src/share.js";

const entry = (over = {}) => {
  const base = { type: "decision", title: "选 SQLite", content: "正文正文", tags: ["x"], importance: 4,
    epistemic_status: "subjective", created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", content_hash: "ab" };
  return { ...base, external_id: deriveExternalId("f0f0f0f0f0f0f0f0", base.type, base.title, base.content_hash), ...over };
};
const packOf = (memories, over = {}) => ({
  kind: SHARE_KIND, pack_id: "f0f0f0f0f0f0f0f0", alias: "桉", generated_at: "2026-10-22T00:00:00.000Z",
  source_version: "0.9.4", report: { included: memories.length, skipped: {}, skip_list: [], deduped: 0 },
  memories, ...over
});

test("pack_id is exactly 16 lowercase hex", () => {
  assert.match("f0f0f0f0f0f0f0f0", PACK_ID_RE);
  assert.doesNotMatch("f0f0f0f0f0f0f0", PACK_ID_RE);       // 车道 A 铸的是 16 位，不是 12
  assert.doesNotMatch("F0F0F0F0F0F0F0F0", PACK_ID_RE);
  // 后两条只验 {16} 那个量词，验不到两个锚：锚一掉，「16 位以内」就成了「正文里含 16 位」，
  // 于是 18 位的串和带空白的串都能过——而这两种恰好是手改包与编码包的形状。
  assert.doesNotMatch("f0f0f0f0f0f0f0f0ff", PACK_ID_RE);
  assert.doesNotMatch(" f0f0f0f0f0f0f0f0", PACK_ID_RE);
});

test("a well-formed pack validates and reports its count", () => {
  const out = validateSharePack(packOf([entry()]));
  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
});

test("every rejection names a code and never a partial success", () => {
  assert.equal(validateSharePack({}).error, "invalid-kind");
  assert.equal(validateSharePack(packOf([entry()], { kind: "other" })).error, "invalid-kind");
  assert.equal(validateSharePack(packOf([entry()], { pack_id: "nope" })).error, "invalid-pack-id");
  assert.equal(validateSharePack(packOf([])).error, "empty-pack");
  assert.equal(validateSharePack({ ...packOf([entry()]), memories: "x" }).error, "invalid-memories");
  const badType = validateSharePack(packOf([entry({ type: "document" })]));
  assert.equal(badType.error, "invalid-type");
  assert.equal(badType.index, 0);
  assert.equal(validateSharePack(packOf([entry({ title: "  " })])).error, "invalid-entry");
  assert.equal(validateSharePack(packOf([entry({ content: "" })])).error, "invalid-entry");
  assert.equal(validateSharePack(packOf([entry({ importance: "high" })])).error, "invalid-entry");
});

test("a recomputed key that disagrees means the pack was edited by hand", () => {
  const out = validateSharePack(packOf([entry({ external_id: "0000000000000000" })]));
  assert.equal(out.ok, false);
  assert.equal(out.error, "external-id-mismatch");
  assert.equal(out.index, 0);
});

test("duplicate external_id inside one pack is rejected, not folded here", () => {
  // 折叠是出包侧的义务（§3 的 deduped）；收到重复键说明包被人改过，按不合格处置。
  const dup = packOf([entry(), entry({ content: "另一条" })]);
  assert.equal(validateSharePack(dup).error, "duplicate-external-id");
});

test("the tag is derived in one place and never from the sharer's identity", () => {
  assert.equal(importedTagFor("桉"), "from-桉");
  assert.equal(importedTagFor(""), "from-shared");
  assert.equal(importedTagFor(undefined), "from-shared");
  assert.equal(importedTagFor("   "), "from-shared");         // 全空白别名走中性值，不许剩 `from--`
  assert.equal(importedTagFor("a\nb  c"), "from-a-b-c");      // 空白游程一律折成一个 -，标签不许带换行
  assert.equal(importedTagFor("x".repeat(80)).length, 32);    // 上限：别人的字符串不许无限长
});

test("folding keeps the word boundary: a newline alias is not the squashed spelling", () => {
  // 上一版对同一类字符开两条规则：换行/制表符**删除**、其余空白折成 -。删除那一侧
  // 恰恰制造了它自己测试要防的撞名——"a\nb" 与 "ab" 读出同一个标签，而对面看到的
  // 来源读数还丢了词缝。裁定：整类空白（含 \r\n\t）折成一个 -（mirror.js 的
  // oneLine() 同是先例：只折不删）。单行的要求折叠同样满足。
  assert.equal(importedTagFor("a\nb"), "from-a-b");
  assert.equal(importedTagFor("ab"), "from-ab");
  assert.notEqual(importedTagFor("a\nb"), importedTagFor("ab"));
  assert.equal(importedTagFor("a\tb"), "from-a-b");           // 制表符与换行同一条规则
  assert.equal(importedTagFor("a\r\nb"), "from-a-b");         // \r\n 游程折成**一个** -
});

test("the allowed type set is the mirror's minus the two exclusions", () => {
  // 真仪器读真数据：TYPE_FILE import 进来直接 Object.keys()。源码正则有两类静默失明——
  // 不匹配 `[a-z_]+: "….md"` 形状的键（大写、连字符、带引号的键名）会被无声丢掉，
  // 而缩进/换行这类纯排版改动同样能让它一条都不解析。断言本体不变：新键进 TYPE_FILE
  // 而没在这里被决定过，这条必须转红。
  const keys = Object.keys(TYPE_FILE);
  assert.ok(keys.length >= 8, `TYPE_FILE should expose its keys to the lock, got ${keys.length}`);
  const minus = new Set(keys.filter((k) => !SHARE_READONLY_TYPES.has(k) && !SHARE_EXCLUDED_TYPES.has(k)));
  assert.deepEqual([...SHARE_ALLOWED_TYPES].sort(), [...minus].sort());
});
