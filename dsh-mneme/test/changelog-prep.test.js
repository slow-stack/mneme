// scripts/changelog-prep.mjs 的回归测试。
//
// 这一步的价值全在「别假成功」上：发布准备原先在 CRLF 检出上匹配不到 CHANGELOG 文件头，
// replace 退化成 no-op 却照样打印 ✓，git status 里看不出任何异常——CI 跑在 ubuntu（LF），
// 所以只有本机发版会中招（v0.8.13 那次就是这么踩到的，最后靠人工补的占位节）。
// 下面用 LF / CRLF / BOM 三种输入各钉一遍，并锁住「匹配不上要如实回报」这条契约：
// 调用方靠 reason 决定 exit 1，退回「返回原文」就等于退回假成功。
import test from "node:test";
import assert from "node:assert/strict";

import { detectEol, insertReleaseSection } from "../scripts/changelog-prep.mjs";

const LF_HEAD = "# Changelog\n\n## [0.8.12] - 2026-10-01\n\n## 🐛 修复\n\n- 旧条目\n";
const CRLF_HEAD = LF_HEAD.replace(/\n/g, "\r\n");
/** 有没有「裸 LF」（前面不是 CR 的 \n）——混排行尾的判据。 */
const hasBareLf = (text) => /(^|[^\r])\n/.test(text);

test("LF 输入：插入占位节，行尾保持 LF，旧内容原样保留", () => {
  const r = insertReleaseSection(LF_HEAD, "0.8.13", "2026-10-03");
  assert.equal(r.ok, true);
  assert.ok(r.text.startsWith("# Changelog\n\n## [0.8.13] - 2026-10-03"), "插在标题之后");
  assert.ok(r.text.includes("- （待填）"), "带 release.yml verify 要的占位节");
  assert.ok(r.text.includes("## [0.8.12] - 2026-10-01"), "旧内容不动");
  assert.equal(r.text.includes("\r\n"), false, "不该往 LF 文件里混 CRLF");
});

test("CRLF 输入：同样能插（原先这里静默 no-op —— 本模块存在的首要理由）", () => {
  const r = insertReleaseSection(CRLF_HEAD, "0.8.13", "2026-10-03");
  assert.equal(r.ok, true, "CRLF 检出上必须也能插入");
  assert.notEqual(r.text, CRLF_HEAD, "绝不返回原文——那正是当初的假成功");
  assert.ok(r.text.includes("## [0.8.13] - 2026-10-03"));
  assert.equal(hasBareLf(r.text), false, "插入的内容也要用 CRLF，不混行尾");
});

test("带 BOM 的输入也能插（`^#` 匹配不到属同一类形状漂移）", () => {
  const r = insertReleaseSection("\uFEFF" + LF_HEAD, "0.8.13", "2026-10-03");
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("## [0.8.13] - 2026-10-03"));
});

test("已含该版本：幂等跳过，并如实回报 already-present", () => {
  const once = insertReleaseSection(LF_HEAD, "0.8.13", "2026-10-03");
  assert.equal(once.ok, true);
  assert.deepEqual(insertReleaseSection(once.text, "0.8.13", "2026-10-03"), { ok: false, reason: "already-present" });
});

test("文件头不匹配：回报 header-not-found，而不是静默返回原文", () => {
  // 这条锁的是契约本身。若有人把实现改回「返回原文 + 入口照旧打印 ✓」，它会红。
  assert.deepEqual(insertReleaseSection("# ChangelogX\n\n## [0.8.12]\n", "0.8.13", "2026-10-03"), {
    ok: false,
    reason: "header-not-found"
  });
  assert.deepEqual(insertReleaseSection("", "0.8.13", "2026-10-03"), { ok: false, reason: "header-not-found" });
});

test("detectEol：认两种行尾，无换行时按 LF 处理", () => {
  assert.equal(detectEol("a\nb"), "\n");
  assert.equal(detectEol("a\r\nb"), "\r\n");
  assert.equal(detectEol("a"), "\n");
});
