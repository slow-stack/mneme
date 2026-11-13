#!/usr/bin/env node
// 发布准备自动化：bump 版本号（dsh-mneme/package.json + package-lock 两处）+ 同步双 README 测试徽章
// + CHANGELOG 顶部空节。
//
// 分工（本脚本最重要的约定）：**机械的归机器，判断的归人**。
//   - 机器：版本号、测试数、CHANGELOG 空节（把 [Unreleased] 攒的条目整段搬进去）
//   - 人：CHANGELOG 条目的**措辞与取舍**、SECURITY.md 支持版本表的跨 minor 挪格
//     （那是维护策略的判断，写错就是「0.9.x 已停止支持」这种真事故）
// 版本历史不进 README（2026-11-13）：两份 README 都不再放版本表，每版改了什么由 CHANGELOG
// 与 GitHub Releases 承担。原先给表插占位行的 syncReadmeTables 已随表格删除。
// 所以 SECURITY.md 只核对不改写：表没跟上就硬失败、PR 不生成，而不是替人写一句可能很危险的
// 版本声明。核对逻辑在 dsh-mneme/scripts/release-docs.mjs，与测试共用同一份。
//
// 用法: node scripts/release-prep.mjs <版本号，如 0.9.1> [测试数，如 2137]
"use strict";

import fs from "node:fs";
import { applyTestCount } from "../dsh-mneme/scripts/test-count-sync.mjs";
import { insertReleaseSection } from "../dsh-mneme/scripts/changelog-prep.mjs";
import { checkSupportTable } from "../dsh-mneme/scripts/release-docs.mjs";

const version = (process.argv[2] || "").replace(/^v/, "");
const testCount = process.argv[3];
// 预发布版（0.14.0-beta.1）也是一等版本：release.yml 早就按 tag 发、release-notes 也已认后缀，
// 唯独这里是三段式硬校验——于是 beta 版只能手工做这一步，而手工最容易漏的就是 CHANGELOG 小节
// （漏了 release.yml 的 verify 直接红）。放宽成与 release-notes 同一条规则。
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("用法: node scripts/release-prep.mjs <版本号> [测试数]");
  process.exit(1);
}
// 预发布版不是「一次 minor 发布」：它不占 README 版本表、也不挪 SECURITY 支持表。
// 判断只做一次，下面各步共用，避免三处各写一遍再漂移。
const isPrerelease = version.includes("-");

const PKG = "dsh-mneme/package.json";
const LOCK = "dsh-mneme/package-lock.json";
const CHANGELOG = "dsh-mneme/CHANGELOG.md";
const SECURITY = "SECURITY.md";
const READMES = ["README.md", "dsh-mneme/README.md"];
const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
// 核对 SECURITY.md 时记下的问题：不中断，但必须在收尾时再喊一次，否则很容易被上面的 ✓ 淹没。
const supportTableProblems = [];

// ── 0. 核对 SECURITY.md 支持版本表（只报告，不改写）──
// 为什么不硬失败：跨 minor 时这张表要向下挪一格，而挪格前后的状态在 CI 眼里都是红的——
// 表先改、版本号后改 → package.json 仍是旧的，test/security-doc.test.js 红；版本号先改、
// 表后改 → 表落后，同样红。所以硬失败会让跨 minor 发版彻底走不通（本地也一样），
// 那才是最坏的结果：人会绕过脚本手工发版。这里如实警告 + 让 PR 带着红进来，
// 由 PR 里那句「必须人来写」的清单把改动落到同一次合并里。
{
  const r = checkSupportTable(fs.readFileSync(SECURITY, "utf8"), version);
  if (r.skipped === "prerelease") {
    console.log("· " + SECURITY + " 支持版本表不随预发布版 " + version + " 变动（beta 不是受支持的稳定版本）");
  } else if (r.ok) {
    console.log("✓ " + SECURITY + " 支持版本表首行已是 " + r.expected);
  } else {
    console.warn("! " + SECURITY + " 的支持版本表还没跟上 " + version + "（应为 " + r.expected + "）：");
    for (const problem of r.problems) console.warn("    - " + problem);
    console.warn("  这是维护策略的判断，脚本不替你写。请在本次 PR 里改中英两张表（含停止维护通知那一段）——");
    console.warn("  改完之前 test/security-doc.test.js 会是红的，这正是它该红的时候。");
    supportTableProblems.push(...r.problems);
  }
}

// ── 1. 版本号同步：package.json 1 处 + package-lock 顶层/包根两处 ──
for (const f of [PKG, LOCK]) {
  if (!fs.existsSync(f)) {
    console.error("缺少 " + f);
    process.exit(1);
  }
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  p.version = version;
  if (p.packages && p.packages[""]) p.packages[""].version = version;
  fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
  console.log("✓ " + f + " → " + version);
}

// ── 2. 测试数同步（两个 README：徽章 + 4 种注释形状）──
// 规则收在 dsh-mneme/scripts/test-count-sync.mjs，与手动路径 sync-test-badge.mjs 共用。
// 原先两条路径各存一份、形状集合还不同——本脚本只 replace 徽章 URL，于是 v0.8.11 发版时
// 徽章跳到 1437 而四条注释留在 1431，自动路径反倒成了漂移来源。
if (testCount && /^\d+$/.test(testCount)) {
  for (const f of READMES) {
    const t = fs.readFileSync(f, "utf8");
    const n = applyTestCount(t, testCount);
    if (n !== t) {
      fs.writeFileSync(f, n);
      console.log("✓ " + f + " 测试数 → " + testCount);
    }
  }
}

// ── 3. CHANGELOG 版本节：把 [Unreleased] 攒的条目整段搬进来（满足 release.yml verify 的 ^## [V] 检查）──
// 规则收在 dsh-mneme/scripts/changelog-prep.mjs（可测、行尾两种都吃）。两个容易写错的位置
// 都在那次修正里定死了：新版本节排在 [Unreleased] **下面**；[Unreleased] 里的条目**整段搬走**、
// 留空（原先只插「🐛 修复 /（待填）」空占位、条目原地不动，于是发版后文件里同时有「新节是空的」
// 和「旧条目还挂在 Unreleased 名下」，搬运这一步还得人工补——v0.9.0 的 77df0fb 就是补这件事的）。
// 匹配不上直接报错退出：原先用 /^(# Changelog\n\n)/ 匹配文件头，CRLF 检出上命中不了 →
// replace 退化成 no-op 却照样打印 ✓，git status 里看不出任何异常，发版时最怕这种假成功。
{
  const t = fs.readFileSync(CHANGELOG, "utf8");
  const r = insertReleaseSection(t, version, date);
  if (r.ok) {
    fs.writeFileSync(CHANGELOG, r.text);
    // 判据是 movedContent 而不是 moved：正文非空但一条 `- ` 都没有时 moved 是 0，
    // 用 moved 判断会把「搬了一整段正文」说成「[Unreleased] 本来是空的」——日志撒谎。
    console.log(
      r.movedContent
        ? "✓ " + CHANGELOG + " 新版本节：" +
          (r.moved ? r.moved + " 条从 [Unreleased] 搬入" : "正文整段从 [Unreleased] 搬入（其中没有 `- ` 条目）") +
          "，[Unreleased] 已清空"
        : "✓ " + CHANGELOG + " 占位节（[Unreleased] 本来是空的）"
    );
  } else if (r.reason === "already-present") {
    console.log("- " + CHANGELOG + " 已含 " + version + "，跳过");
  } else {
    console.error("✗ " + CHANGELOG + " 顶部没匹配到 \"# Changelog\" 标题，未插入占位节（reason=" + r.reason + "）——请人工检查文件形状");
    process.exit(1);
  }
}

// ── 4. 版本历史不进 README ──
// 两份 README 都不再放版本表（2026-11-13）：入口页只回答「它是什么、怎么装、凭什么信」，
// 每版改了什么由 CHANGELOG 与 GitHub Releases 承担。原先往表里插占位行的
// syncReadmeTables 已随表格一起删除——留着它只会对一份没有表格的 README 报告「跳过」，
// 正是它自己注释里记的那类静默失效。
console.log("- 两份 README 均不含版本表（版本历史在 CHANGELOG 与 Releases）");
console.log("");
console.log("完成。还需要人写的：");
console.log("  1. dsh-mneme/CHANGELOG.md 新节条目的**措辞与取舍**（[Unreleased] 攒的已整段搬过去，不用手搬）");
if (supportTableProblems.length) {
  console.log("");
  console.log("⚠ 还有一件必须先做，否则这个 PR 的 CI 会是红的：");
  console.log("   SECURITY.md 的支持版本表要挪到 " + version.split(".").slice(0, 2).join(".") + ".x");
  console.log("   中英两张表 + 下面那段停止维护通知一起改（旧版本降一格、新版本进活跃行）。");
}