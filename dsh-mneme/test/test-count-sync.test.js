import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTestCount, readTestCounts } from "../scripts/test-count-sync.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const REPO_ROOT = join(PKG_ROOT, "..");
const READMES = [join(REPO_ROOT, "README.md"), join(PKG_ROOT, "README.md")];

// 双 README 是发布门面，同一个数字在里面重复出现三到五次（一个 shields.io 徽章 +
// 每条开发命令注释一处，root 是双语所以中英各一条）。它们必须永远同数——否则
// 「这个项目有多少测试」取决于读者恰好看了哪一行。
//
// v0.8.11 实际漂移过：徽章 1437、四条注释留在 1431。本用例就是那次漂移的回归锁，
// 跑在真实 README 上（不是 fixture），所以它能在发版前拦住同类漂移。
test("双 README 的测试数处处一致（徽章与所有注释同数）", () => {
  for (const f of READMES) {
    const counts = readTestCounts(readFileSync(f, "utf8"));
    const shapes = new Set(counts.map((c) => c.shape));
    assert.ok(counts.length >= 2, `${f} 抽到的测试数出现处太少：${JSON.stringify(counts)}`);
    assert.ok(shapes.has("badge"), `${f} 没抽到徽章：${JSON.stringify(counts)}`);
    const values = [...new Set(counts.map((c) => c.value))];
    assert.equal(values.length, 1, `${f} 测试数不一致：${JSON.stringify(counts)}`);
  }
});

// v0.8.11 的真实漂移样本（徽章已 1437、注释仍 1431）。锁住「徽章 + 四种注释形状」
// 全覆盖：少任何一种，就会有一处静默落后——release-prep.mjs 原先只覆盖徽章 URL，
// 自动发版路径因此反倒成了漂移来源。
test("applyTestCount 覆盖徽章与全部四种注释形状（真实漂移样本）", () => {
  const drifted = [
    '<img src="https://img.shields.io/badge/tests-1431%20total-3E63DD?style=flat-square" alt="tests">',
    "[![tests](https://img.shields.io/badge/tests-1431%20total-success)](https://github.com/slow-stack/mneme)",
    "npm test        # 1431 个测试",
    "npm test           # 运行 1431 个测试",
    "test/                 # 1431 个 node:test 测试（审计与三轴线压测不变量）",
    "npm test        # 1431 tests"
  ].join("\n");
  const fixed = applyTestCount(drifted, 1437);
  assert.ok(!/\b1431\b/.test(fixed), "仍有 1431 未被替换：\n" + fixed);
  const counts = readTestCounts(fixed);
  assert.equal(counts.length, 6, "六处出现都该被认出来：" + JSON.stringify(counts));
  assert.deepEqual([...new Set(counts.map((c) => c.value))], [1437]);
});

test("applyTestCount 幂等：同一个数重复施加不再产生变化", () => {
  const once = applyTestCount("tests-9%20total-3E63DD\n# 9 个测试\n# 9 tests", 12);
  assert.equal(applyTestCount(once, 12), once);
});

// 历史版本表里的「745 测试全绿」「790 通过」是各版本当时的真实记录（sync-test-badge
// 的注释也写明了刻意不改它们）。替换规则只认徽章 URL 与 `#` 前缀注释两种形状，
// 这条用例锁住那个边界，免得将来放宽正则把历史改写掉。
test("applyTestCount 不碰历史版本表里的「N 测试全绿」", () => {
  const history = "| **v0.8.0** | 745 测试全绿 |\n| **v0.7.9** | 790 通过 |\n| v0.2.7 | 263 |";
  assert.equal(applyTestCount(history, 1437), history);
});
// 徽章报的是套件总数（`ℹ tests N`），不是通过数：本地 Windows 未开开发者模式时有一条
// 符号链接用例被条件跳过，pass 数会比总数少 1。徽章字面量若退回 `%20passed`，读者会把它
// 读成「N 个用例都通过了」，而它其实只表示「跑了 N 个套件」——#599 评审指出这一处措辞
// 与实际口径不符。这条用例锁住那个词，改回 `passed` 立刻转红。
test("双 README 的徽章字面量报总数（total），不谎称全部通过（passed）", () => {
  for (const f of READMES) {
    const text = readFileSync(f, "utf8");
    assert.ok(/tests-\d+%20total/.test(text), `${f} 徽章必须写 %20total：${text.match(/tests-\d+%20\w+/)}`);
    assert.ok(!/tests-\d+%20passed/.test(text), `${f} 徽章不得退回 %20passed`);
  }
});
