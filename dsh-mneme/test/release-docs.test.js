// 锁发布准备里「改文档」这一段的两件事，它们各自都静默失效过或随时会：
//
// 1. 版本历史不再写进 README（2026-11-13 决定）。根 README 是入口页，回答「它是什么、
//    怎么装、凭什么信」；每版改了什么由 CHANGELOG 与 GitHub Releases 承担。原先根 README
//    有两张路线图、子 README 有一张版本历史，发版脚本靠往表里插占位行维持——而那条路
//    恰好静默失效过：根 README 的版本列是两段式 **v0.9**，旧实现只认三段式 **v0.9.0**，
//    于是对一个字节没改的 README 报告「无版本表格行，跳过」。表格删掉，插行逻辑一起删；
//    这里反向锁住「别把表加回来」，否则它又会变成发版脚本的依赖。
//
// 2. SECURITY.md 的支持版本表跨 minor 时必须由人挪格。脚本只核对；核对一旦退化成永真，
//    0.10.0 就能带着「0.9.x 活跃开发中」的表格发出去——那是安全策略文档里的谎话。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as releaseDocs from "../scripts/release-docs.mjs";
import { checkSupportTable } from "../scripts/release-docs.mjs";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(pkgRoot);
const rootReadme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
const pkgReadme = readFileSync(path.join(pkgRoot, "README.md"), "utf8");
const securityDoc = readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
const { version } = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));

test("两份 README 都不再承载版本表（版本历史在 CHANGELOG 与 Releases）", () => {
  const versionRow = /^\|\s*\*\*v\d+\.\d+/m;
  for (const [label, text] of [["根 README", rootReadme], ["子 README", pkgReadme]]) {
    assert.equal(versionRow.test(text), false,
      `${label} 里又出现了版本行（| **v0.x**）：版本历史归 CHANGELOG 与 Releases，` +
        "加回 README 会让发版脚本重新依赖一个没人读、又常年漂的表格");
  }
  assert.equal(pkgReadme.includes("## 📜 版本历史"), false, "子 README 的版本历史一节已删除，不要再加回来");
  assert.equal("syncReadmeTables" in releaseDocs, false,
    "syncReadmeTables 已随版本表一起删除：留着它只会对没有表格的 README 报告「跳过」");
});

test("SECURITY.md 支持版本表：同 minor 通过，跨 minor 如实报出中英两处", () => {
  const sameMinor = checkSupportTable(securityDoc, version);
  assert.equal(sameMinor.ok, true, `真实 SECURITY.md 应与 package.json ${version} 一致：${sameMinor.problems.join("；")}`);
  if (version.includes("-")) {
    // 预发布版不占支持表的格：beta 不是受支持的稳定版本，挪过去等于对外宣称它已活跃维护。
    // 显式断言 skipped，而不是让它悄悄走 ok 分支——否则「不检查」和「检查通过」长得一样。
    assert.equal(sameMinor.skipped, "prerelease",
      `预发布版 ${version} 应显式标 skipped=prerelease，实际 ${sameMinor.skipped}`);
  } else {
    assert.equal(sameMinor.skipped, null, `稳定版 ${version} 不该被当成预发布版跳过`);
  }

  const nextMinor = `${version.split(".")[0]}.${Number(version.split(".")[1]) + 1}.0`;
  const crossing = checkSupportTable(securityDoc, nextMinor);
  assert.equal(crossing.ok, false, "跨 minor 时必须报错——否则会带着过时的支持范围发版");
  assert.equal(crossing.problems.length, 2, "中英两张表各报一条：" + crossing.problems.join("；"));
  assert.ok(crossing.problems.every((p) => p.includes(crossing.expected)),
    "每条问题都要写出期望值，否则人不知道改成什么：" + crossing.problems.join("；"));
});

test("预发布版不把支持表首行挪到自己头上（beta 不是受支持的稳定版）", () => {
  // 样本取「当前 minor 的下一个 minor 的 beta」：那个 minor 一定还没发布过稳定版，
  // 所以支持表首行不该是它。原先这里写死 0.14.0-beta.1，该 minor 一转正这条就变成
  // 假红——而它要防的恰恰是「预发布版占格」，不是「某个版本号出现」。
  const [major, minor] = version.split(".");
  const nextMinor = Number(minor) + 1;
  const betaVersion = `${major}.${nextMinor}.0-beta.1`;
  const betaRow = `${major}.${nextMinor}.x`;
  const r = checkSupportTable(securityDoc, betaVersion);
  assert.equal(r.ok, true);
  assert.equal(r.expected, betaRow, "expected 仍按 major.minor 算，只是不拿来要求表");
  const body = securityDoc.slice(securityDoc.indexOf("## Supported Versions"));
  const firstRow = body.split(/\r?\n/).filter((l) => /^\|\s*[\d<]/.test(l))[0].split("|")[1].trim();
  assert.notEqual(firstRow, betaRow,
    `支持表首行不该是 ${betaRow}——预发布版占格等于宣称它已在活跃维护`);
});

test("SECURITY.md 支持版本表：节缺失或表格形状变了也报错（不能静默通过）", () => {
  assert.equal(checkSupportTable("# Security\n\n## 别的节\n", "0.9.0").ok, false);
  const noRows = "## Supported Versions\r\n\r\n没有表格\r\n\r\n## 支持版本\r\n\r\n没有表格\r\n";
  assert.equal(checkSupportTable(noRows, "0.9.0").ok, false,
    "解析不出任何版本行时必须失败：正则失配不能变成永真");
});
