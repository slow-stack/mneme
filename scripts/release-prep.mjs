#!/usr/bin/env node
// 发布准备自动化：bump 版本号（dsh-mneme/package.json + package-lock 两处）+ 同步双 README 测试徽章
// + CHANGELOG 顶部空节 + 双 README 版本历史/路线图占位行（描述留空待人工填写）。
// 用法: node scripts/release-prep.mjs <版本号，如 0.7.30> [测试数，如 744]
"use strict";

import fs from "node:fs";
import { applyTestCount } from "../dsh-mneme/scripts/test-count-sync.mjs";
import { insertReleaseSection } from "../dsh-mneme/scripts/changelog-prep.mjs";

const version = (process.argv[2] || "").replace(/^v/, "");
const testCount = process.argv[3];
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("用法: node scripts/release-prep.js <版本号> [测试数]");
  process.exit(1);
}

const PKG = "dsh-mneme/package.json";
const LOCK = "dsh-mneme/package-lock.json";
const CHANGELOG = "dsh-mneme/CHANGELOG.md";
const READMES = ["README.md", "dsh-mneme/README.md"];

// ── 1. 版本号同步：package.json 1 处 + package-lock 顶层/包根两处 ──
for (const f of [PKG, LOCK]) {
  if (!fs.existsSync(f)) {
    console.error(`缺少 ${f}`);
    process.exit(1);
  }
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  p.version = version;
  if (p.packages && p.packages[""]) p.packages[""].version = version;
  fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
  console.log(`✓ ${f} → ${version}`);
}

// ── 2. 测试数同步（两个 README：徽章 + 4 种 `# N …测试` 注释形状）──
// 规则收在 dsh-mneme/scripts/test-count-sync.mjs，与手动路径 sync-test-badge.mjs
// 共用。原先两条路径各存一份、形状集合还不同——本脚本只 replace 徽章 URL，于是
// v0.8.11 发版时徽章跳到 1437 而四条注释留在 1431，自动路径反倒成了漂移来源。
if (testCount && /^\d+$/.test(testCount)) {
  for (const f of READMES) {
    const t = fs.readFileSync(f, "utf8");
    const n = applyTestCount(t, testCount);
    if (n !== t) {
      fs.writeFileSync(f, n);
      console.log(`✓ ${f} 测试数 → ${testCount}`);
    }
  }
}

// ── 3. CHANGELOG 顶部空节（满足 release.yml verify 的 ^## [V] 检查）──
// 规则收在 dsh-mneme/scripts/changelog-prep.mjs（可测、行尾两种都吃）。原先这段用
// /^(# Changelog\n\n)/ 匹配文件头，CRLF 检出上命中不了 → replace 退化成 no-op 却照样
// 打印 ✓，git status 里看不出任何异常——发版时最怕这种假成功。现在匹配不上直接报错
// 退出，绝不假装写成功。
{
  const t = fs.readFileSync(CHANGELOG, "utf8");
  // 按东八区取日期（与历史 CHANGELOG 日期惯例一致）
  const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const r = insertReleaseSection(t, version, date);
  if (r.ok) {
    fs.writeFileSync(CHANGELOG, r.text);
    console.log(`✓ ${CHANGELOG} 占位节`);
  } else if (r.reason === "already-present") {
    console.log(`- ${CHANGELOG} 已含 ${version}，跳过`);
  } else {
    console.error(`✗ ${CHANGELOG} 顶部没匹配到 "# Changelog" 标题，未插入占位节（reason=${r.reason}）——请人工检查文件形状`);
    process.exit(1);
  }
}

// ── 4. 双 README 版本历史/路线图占位行（插在最新版本行之后；幂等）──
{
  const cellCount = (line) => line.split("|").filter((c) => c.trim()).length;
  const hasCJK = (s) => /[一-鿿]/.test(s);
  // 按表格列数生成占位行：2 列=版本历史，3 列=root 路线图（按语言），4 列=dsh-mneme 路线图
  const rowFor = (line, v) => {
    const n = cellCount(line);
    if (n <= 2) return `| **v${v}** | （待填） |`;
    if (n === 3)
      return hasCJK(line) ? `| **v${v}** | （待填） | 🚧 准备中 |` : `| **v${v}** | TBD | 🚧 In prep |`;
    return `| **v${v}** | 🚧 准备中 | （待填） | （待填） |`;
  };
  const semverGt = (a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    return pa[0] > pb[0] || (pa[0] === pb[0] && (pa[1] > pb[1] || (pa[1] === pb[1] && pa[2] > pb[2])));
  };
  const semverLt = (a, b) => semverGt(b, a);

  for (const f of READMES) {
    const t = fs.readFileSync(f, "utf8");
    if (t.includes(`**v${version}**`)) {
      console.log(`- ${f} 已含 v${version}，跳过占位行`);
      continue;
    }
    const rows = [];
    for (const line of t.split("\n")) {
      const m = line.match(/^\|\s*\*\*v(\d+\.\d+\.\d+)\*\*/);
      if (m) rows.push({ line, ver: m[1] });
    }
    if (!rows.length) {
      console.log(`- ${f} 无版本表格行，跳过`);
      continue;
    }
    // 取「小于目标版本」的最新版本行（路线图表可能已含 v0.8.0 这类计划行，不能插到它后面）
    const lower = rows.filter((r) => semverLt(r.ver, version));
    const pool = lower.length ? lower : rows;
    const maxVer = pool.reduce((a, b) => (semverGt(b.ver, a.ver) ? b : a)).ver;
    const out = [];
    for (const line of t.split("\n")) {
      out.push(line);
      if (line.includes(`**v${maxVer}**`) && cellCount(line) >= 2) out.push(rowFor(line, version));
    }
    fs.writeFileSync(f, out.join("\n"));
    console.log(`✓ ${f} 占位行 v${version}`);
  }
}

console.log("完成。请 git diff 检查后提交。");
