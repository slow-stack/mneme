#!/usr/bin/env node
// 发布准备自动化：bump 版本号（dsh-mneme/package.json + package-lock 两处）+ 同步双 README 测试徽章
// + CHANGELOG 顶部空节 + 双 README 版本表占位行与路线图状态回填。
//
// 分工（本脚本最重要的约定）：**机械的归机器，判断的归人**。
//   - 机器：版本号、测试数、CHANGELOG 空节、占位行、路线图状态格（"已发布 vX.Y.Z" 是事实）
//   - 人：CHANGELOG 与版本表里的**主题描述**、根 README 的 News 头条、SECURITY.md 支持版本表的
//     跨 minor 挪格（那是维护策略的判断，写错就是「0.9.x 已停止支持」这种真事故）
// 所以 SECURITY.md 只核对不改写：表没跟上就硬失败、PR 不生成，而不是替人写一句可能很危险的
// 版本声明。核对逻辑在 dsh-mneme/scripts/release-docs.mjs，与测试共用同一份。
//
// 用法: node scripts/release-prep.mjs <版本号，如 0.9.1> [测试数，如 2137]
"use strict";

import fs from "node:fs";
import { applyTestCount } from "../dsh-mneme/scripts/test-count-sync.mjs";
import { insertReleaseSection } from "../dsh-mneme/scripts/changelog-prep.mjs";
import { checkSupportTable, scanReleaseRows, syncReadmeTables } from "../dsh-mneme/scripts/release-docs.mjs";

const version = (process.argv[2] || "").replace(/^v/, "");
const testCount = process.argv[3];
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("用法: node scripts/release-prep.mjs <版本号> [测试数]");
  process.exit(1);
}

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
  if (r.ok) {
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

// ── 3. CHANGELOG 顶部空节（满足 release.yml verify 的 ^## [V] 检查）──
// 规则收在 dsh-mneme/scripts/changelog-prep.mjs（可测、行尾两种都吃）。原先这段用
// /^(# Changelog\n\n)/ 匹配文件头，CRLF 检出上命中不了 → replace 退化成 no-op 却照样打印 ✓，
// git status 里看不出任何异常——发版时最怕这种假成功。现在匹配不上直接报错退出。
{
  const t = fs.readFileSync(CHANGELOG, "utf8");
  const r = insertReleaseSection(t, version, date);
  if (r.ok) {
    fs.writeFileSync(CHANGELOG, r.text);
    console.log("✓ " + CHANGELOG + " 占位节");
  } else if (r.reason === "already-present") {
    console.log("- " + CHANGELOG + " 已含 " + version + "，跳过");
  } else {
    console.error("✗ " + CHANGELOG + " 顶部没匹配到 \"# Changelog\" 标题，未插入占位节（reason=" + r.reason + "）——请人工检查文件形状");
    process.exit(1);
  }
}

// ── 4. 双 README 的版本表占位行 + 路线图状态回填（幂等）──
// 旧实现只认三段式 **v0.9.0**，而根 README 的路线图写的是两段式 **v0.9**：于是根 README
// 一个字节没改，打印的却是「无版本表格行，跳过」——把「没做」说成了「不需要做」。
// 现在两种写法分开认，且每张表单独报告做了什么、或为什么没做。
let touched = 0;
for (const f of READMES) {
  const t = fs.readFileSync(f, "utf8");
  const r = syncReadmeTables(t, version, date);
  if (!r.actions.length) {
    const scanned = scanReleaseRows(t);
    if (!scanned.three.length && !scanned.two.length) {
      console.log("- " + f + " 没有版本表格（既无三段式也无两段式版本行），跳过");
    } else {
      console.log("- " + f + " 版本表已是最新，跳过");
    }
    continue;
  }
  if (r.text === t) {
    // 只在真有变更时才返回新文本；相等说明是逻辑 bug，宁可硬失败也不静默发布。
    console.error("✗ " + f + " 报告了 " + r.actions.length + " 项变更但文本未变——这是脚本 bug，请勿合并");
    process.exit(1);
  }
  fs.writeFileSync(f, r.text);
  touched += 1;
  for (const a of r.actions) {
    if (a.kind === "insert") console.log("✓ " + f + " " + a.table + "：在 v" + a.after.replace(/^v/, "") + " 之后插入占位行");
    else console.log("✓ " + f + " " + a.table + "：状态 " + a.from + " → " + a.to);
  }
}

// 机械部分一句话收口：让人一眼看出还剩下什么要自己写。
// 机器能做的到此为止，剩下三件都是判断/编辑，写进同一个清单比散在三处提示里可靠。
console.log("");
console.log(touched ? "完成（" + touched + " 份 README 有改动）。还需要人写的：" : "完成（README 无需改动）。还需要人写的：");
console.log("  1. dsh-mneme/CHANGELOG.md 新节里的条目（现在只有一条「- （待填）」）");
console.log("  2. 双 README 版本表占位行里的主题描述");
console.log("  3. 根 README 的「📰 最近更新」与「📰 Recent updates」表各加一行头条（纯编辑内容，脚本不碰）");
if (supportTableProblems.length) {
  console.log("");
  console.log("⚠ 还有一件必须先做，否则这个 PR 的 CI 会是红的：");
  console.log("   SECURITY.md 的支持版本表要挪到 " + version.split(".").slice(0, 2).join(".") + ".x");
  console.log("   中英两张表 + 下面那段停止维护通知一起改（旧版本降一格、新版本进活跃行）。");
}
