// 锁发布准备里「改文档表格」这一段的三件事，它们各自都静默失效过或随时会：
//
// 1. 根 README 的路线图版本列写的是两段式 **v0.9**，旧实现只认三段式 **v0.9.0**，于是
//    对根 README 一个字节没改，打印的却是「无版本表格行，跳过」——把「没做」说成「不需要做」。
// 2. 往 CRLF 文件里插一行而不显式保行尾，会把文件混成一半 CRLF 一半 LF（changelog-prep 踩过）。
// 3. SECURITY.md 的支持版本表跨 minor 时必须由人挪格。脚本只核对；核对一旦退化成永真，
//    0.10.0 就能带着「0.9.x 活跃开发中」的表格发出去——那是安全策略文档里的谎话。
//
// 前两类直接读真实 README 断言（正则被改窄时，用户会静默看到「跳过」，而测试必须变红）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkSupportTable, scanReleaseRows, syncReadmeTables } from "../scripts/release-docs.mjs";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(pkgRoot);
const rootReadme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
const pkgReadme = readFileSync(path.join(pkgRoot, "README.md"), "utf8");
const securityDoc = readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
const { version } = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));

const CRLF = "\r\n";
const crlf = (...lines) => lines.join(CRLF) + CRLF;

test("两份真实 README 的版本表都还认得出（根按 minor、子按 patch）", () => {
  const root = scanReleaseRows(rootReadme);
  assert.ok(root.two.length >= 3, `根 README 的路线图应解析出至少 3 行两段式版本行，实际 ${root.two.length}`);
  assert.equal(root.three.length, 0,
    "根 README 的路线图按 minor 排，不该出现三段式版本行——出现了说明表格形状变了，插入位置需要重算");
  const sub = scanReleaseRows(pkgReadme);
  assert.ok(sub.three.length >= 1, `子 README 的版本历史应解析出至少 1 行三段式版本行，实际 ${sub.three.length}`);
});

test("根 README 的两段式路线图能插进新 minor 占位行（旧实现零命中）", () => {
  const sample = crlf(
    "| 版本 | 主题 | 状态 |",
    "|------|------|------|",
    "| **v0.8** | 生态化 | ✅ 已发布（至 v0.8.16） |",
    "| **v0.9** | 手法 beta | ✅ 已发布（v0.9.0） |",
  );
  const { text, actions } = syncReadmeTables(sample, "0.10.0", "2026-11-01");
  assert.equal(actions.filter((a) => a.kind === "insert").length, 1, "应插入且只插入一行");
  assert.match(text, /\| \*\*v0\.10\*\* \| （待填） \| ✅ 已发布（v0\.10\.0） \|/,
    "占位行按 minor 写 v0.10，状态写这次要发出去的完整版本");
  // 插在 v0.9 之后，而不是表尾——表尾将来会有更高的计划行
  assert.ok(text.indexOf("**v0.10**") > text.indexOf("**v0.9**"), "占位行应排在 v0.9 之后");
});

test("真实根 README 的中英两张路线图各插一行（同一版本号，不能只插一张）", () => {
  // 两张表版本行完全一样，旧实现把全文件版本行合成一个数组判断「已存在」，
  // 于是先插的中文表会让英文表被跳过——英文读者永远等不到那一行。
  const { actions } = syncReadmeTables(rootReadme, "0.10.0", "2026-11-01");
  const inserts = actions.filter((a) => a.kind === "insert");
  assert.equal(inserts.length, 2, "中英路线图各一行，实际：" + JSON.stringify(actions));
});

test("子 README 的版本历史插占位行时写完整 patch 号并带日期", () => {
  const sample = crlf(
    "| 版本 | 主题 |",
    "|------|------|",
    "| **v0.9.0**（2026-10-17） | 手法 beta |",
    "| **v0.8.x** | 作用域隔离 |",
  );
  const { text } = syncReadmeTables(sample, "0.9.1", "2026-10-18");
  assert.match(text, /\| \*\*v0\.9\.1\*\*（2026-10-18） \| （待填） \|/);
  assert.ok(text.indexOf("**v0.9.1**") < text.indexOf("**v0.8.x**"),
    "占位行要排在低于它的最新版本之后、概括行之前");
});

test("路线图里上一版留下的「🚧 准备中」在发版准备时回填成已发布", () => {
  const sample = crlf(
    "| 版本 | 主题 | 状态 |",
    "|------|------|------|",
    "| **v0.9** | 手法 beta | 🚧 准备中 |",
  );
  const { text } = syncReadmeTables(sample, "0.9.0", "2026-10-17");
  assert.match(text, /\| \*\*v0\.9\*\* \| 手法 beta \| ✅ 已发布（v0\.9\.0） \|/);
  // 已经写着已发布的行不动：脚本跑在打 tag 之前，改写补丁号等于提前宣布一个还没发出去的版本。
  const already = crlf(
    "| 版本 | 主题 | 状态 |",
    "|------|------|------|",
    "| **v0.9** | 手法 beta | ✅ 已发布（v0.9.0） |",
  );
  assert.equal(syncReadmeTables(already, "0.9.1", "2026-10-18").text, already,
    "已发布的补丁号由人在真正发出去之后更新，脚本不擅自提前改");
});

test("插入占位行不改变行尾风格（CRLF 文件不会混进裸 LF）", () => {
  const sample = crlf(
    "| 版本 | 主题 |",
    "|------|------|",
    "| **v0.9.0**（2026-10-17） | 手法 beta |",
  );
  const { text } = syncReadmeTables(sample, "0.9.1", "2026-10-18");
  const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
  assert.equal(bareLf, 0, `输出里出现了 ${bareLf} 个裸 LF——CRLF 文件被混写了一半 LF`);
});

test("重复跑是幂等的：已有目标的占位行就不再插第二行", () => {
  const sample = crlf(
    "| 版本 | 主题 |",
    "|------|------|",
    "| **v0.9.0**（2026-10-17） | 手法 beta |",
  );
  const once = syncReadmeTables(sample, "0.9.1", "2026-10-18").text;
  const twice = syncReadmeTables(once, "0.9.1", "2026-10-18");
  assert.equal(twice.text, once);
  assert.deepEqual(twice.actions, [], "第二次应报告零变更，而不是再插一行");
});

test("SECURITY.md 支持版本表：同 minor 通过，跨 minor 如实报出中英两处", () => {
  const sameMinor = checkSupportTable(securityDoc, version);
  assert.equal(sameMinor.ok, true, `真实 SECURITY.md 应与 package.json ${version} 一致：${sameMinor.problems.join("；")}`);

  const nextMinor = `${version.split(".")[0]}.${Number(version.split(".")[1]) + 1}.0`;
  const crossing = checkSupportTable(securityDoc, nextMinor);
  assert.equal(crossing.ok, false, "跨 minor 时必须报错——否则会带着过时的支持范围发版");
  assert.equal(crossing.problems.length, 2, "中英两张表各报一条：" + crossing.problems.join("；"));
  assert.ok(crossing.problems.every((p) => p.includes(crossing.expected)),
    "每条问题都要写出期望值，否则人不知道改成什么：" + crossing.problems.join("；"));
});

test("SECURITY.md 支持版本表：节缺失或表格形状变了也报错（不能静默通过）", () => {
  assert.equal(checkSupportTable("# Security\n\n## 别的节\n", "0.9.0").ok, false);
  const noRows = "## Supported Versions\r\n\r\n没有表格\r\n\r\n## 支持版本\r\n\r\n没有表格\r\n";
  assert.equal(checkSupportTable(noRows, "0.9.0").ok, false,
    "解析不出任何版本行时必须失败：正则失配不能变成永真");
});
