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
  assert.ok(r.text.startsWith("# Changelog\n\n## [0.8.13] - 2026-10-03"), "没有 [Unreleased] 时插在标题之后");
  assert.ok(r.text.includes("- （待填）"), "带 release.yml verify 要的占位节");
  assert.ok(r.text.includes("## [0.8.12] - 2026-10-01"), "旧内容不动");
  assert.equal(r.text.includes("\r\n"), false, "不该往 LF 文件里混 CRLF");
});

test("有 [Unreleased] 时插在它下面，不插在上面", () => {
  // Keep a Changelog 的约定：未发布区在最上，新版本节排在它下面。
  // 插反了会得到「[0.9.1] 在 [Unreleased] 之上」——v0.9.0 那次就是靠事后人工提交
  // （77df0fb）掰回来的，机器算得对的事不该留给人补。
  const src = "# Changelog\n\n## [Unreleased]\n\n## 🐛 修复\n\n- 攒着的条目\n\n## [0.9.0] - 2026-10-17\n\n- 旧版本\n";
  const r = insertReleaseSection(src, "0.9.1", "2026-10-18");
  assert.equal(r.ok, true);
  assert.ok(
    r.text.indexOf("## [Unreleased]") < r.text.indexOf("## [0.9.1] - 2026-10-18"),
    "[Unreleased] 必须排在前面"
  );
  assert.ok(
    r.text.indexOf("## [0.9.1] - 2026-10-18") < r.text.indexOf("## [0.9.0] - 2026-10-17"),
    "新版本节又必须排在上一版之前"
  );
  assert.ok(r.text.includes("- 攒着的条目"), "[Unreleased] 里攒的条目不许丢");
  assert.ok(r.text.includes("- 旧版本"), "旧版本节不许丢");
  assert.equal(r.text.includes("\r\n"), false, "这组输入是 LF，不该混进 CRLF");
});

test("[Unreleased] 攒着条目时整段搬进新版本节，不留空占位节", () => {
  // 原先只插一个「🐛 修复 / （待填）」占位，攒着的条目原地不动：发版后文件里同时存在
  // 「新版本节是空的」和「旧条目还挂在 Unreleased 名下」，搬运这一步照样要人工补
  // （v0.9.0 的 77df0fb 干的就是这件事）。搬位置不搬内容——原样移动、一个字不改。
  const src =
    "# Changelog\n\n## [Unreleased]\n\n## 🐛 修复\n\n- 条目甲\n- 条目乙\n\n## 🔐 安全\n\n- 条目丙\n\n## [0.9.0] - 2026-10-17\n\n- 旧版本\n";
  const r = insertReleaseSection(src, "0.9.1", "2026-10-18");
  assert.equal(r.ok, true);
  assert.equal(r.moved, 3, "三条条目都要搬过去");
  assert.equal(r.movedContent, true, "搬了正文与条目，两个字段都该为真");
  assert.equal(r.text.includes("（待填）"), false, "搬了真条目就不该再留空占位");
  // Unreleased 立刻接新版本节，中间不夹任何内容
  assert.ok(r.text.startsWith("# Changelog\n\n## [Unreleased]\n\n## [0.9.1] - 2026-10-18\n\n## 🐛 修复\n\n- 条目甲"));
  assert.ok(r.text.includes("## 🔐 安全\n\n- 条目丙"), "多个小节整体搬，小节结构不动");
  assert.ok(r.text.indexOf("- 条目丙") < r.text.indexOf("## [0.9.0]"), "全都搬进新节里，不留一条挂在 Unreleased 名下");
});

test("[Unreleased] 正文非空但没有 `- ` 条目时，movedContent 仍为 true（moved 只是计数）", () => {
  // 用 moved 当「有没有搬」的判据是错的：正文非空、但一条 `- ` 都没有时 moved 是 0，
  // 入口会打印「占位节（[Unreleased] 本来是空的）」——而它显然不空。两个字段必须分开用。
  const src = "# Changelog\n\n## [Unreleased]\n\n一段没有条目的说明正文。\n\n## [0.9.0] - 2026-10-17\n\n- 旧版本\n";
  const r = insertReleaseSection(src, "0.9.1", "2026-10-18");
  assert.equal(r.ok, true);
  assert.equal(r.moved, 0, "没有 `- ` 开头的行为，条目数是 0");
  assert.equal(r.movedContent, true, "但正文确实搬了，这个字段才是「有没有搬」的判据");
  assert.ok(r.text.includes("一段没有条目的说明正文。"), "正文不许丢");
  assert.equal(r.text.includes("（待填）"), false, "不该在搬了正文之后还留空占位");
});

test("[Unreleased] 首行是缩进代码块时保留前导空格（原样搬，不 trim）", () => {
  // body.trim() 会把首行的四空格吃掉，Markdown 代码块降级成普通段落——
  // 那就不是「整段搬、一个字不改」了。只许剥掉节边界上的空行。
  const src = "# Changelog\n\n## [Unreleased]\n\n    npm run sync\n\n## [0.9.0] - 2026-10-17\n\n- 旧版本\n";
  const r = insertReleaseSection(src, "0.9.1", "2026-10-18");
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("\n    npm run sync\n"), "四空格缩进必须原样保留：\n" + JSON.stringify(r.text));
});

test("[Unreleased] 为空时插占位节，且不产生多余空行", () => {
  const src = "# Changelog\r\n\r\n## [Unreleased]\r\n## [0.9.0] - 2026-10-17\r\n\r\n- x\r\n";
  const r = insertReleaseSection(src, "0.9.1", "2026-10-18");
  assert.equal(r.ok, true, "CRLF 检出上也要能插");
  assert.equal(r.moved, 0, "Unreleased 是空的，没有可搬的");
  assert.equal(r.movedContent, false, "Unreleased 空时才该走占位节分支");
  assert.ok(
    r.text.startsWith(
      "# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [0.9.1] - 2026-10-18\r\n\r\n## 🐛 修复\r\n\r\n- （待填）\r\n\r\n## [0.9.0] - 2026-10-17\r\n"
    ),
    "空的 Unreleased 后面接占位节，再接上一版"
  );
  assert.equal(/\n\n\n/.test(r.text.replace(/\r\n/g, "\n")), false, "不许出三连空行");
  assert.equal(hasBareLf(r.text), false);
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