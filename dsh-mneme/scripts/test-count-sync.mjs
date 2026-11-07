// 测试数在双 README 里以多种形状重复出现：shields.io 徽章 URL，以及四种 `# N …测试`
// 注释（`# N 个测试` / `# 运行 N 个测试` / `# N 个 node:test 测试` / `# N tests`）。
// 所有出现处必须永远报同一个数。
//
// 这些规则原先在两条写入路径里各存一份，且形状集合不同：
//   - scripts/release-prep.mjs（Release Prep 工作流，自动，每次发版跑）
//   - dsh-mneme/scripts/sync-test-badge.mjs（npm run badge:sync，手动）
// release-prep 当时只 replace 徽章 URL，于是 v0.8.11 发版时徽章自动跳到 1437，
// 四条注释留在 1431 —— 自动路径反而成了漂移的来源。规则收在这里共用，
// 由 test/test-count-sync.test.js 锁住形状集合与「双 README 同数」这条不变量。
//
// 徽章正则刻意不带尾随 `-`：`tests-N%20total` 既能命中 `…total-3E63DD`（root）
// 也能命中 `…total-success`（包 README），将来出现无后缀写法也不会静默漏改。
//
// 徽章报的是**套件总数**不是通过数，所以字面量写 `total` 而不是 `passed`（#599 评审指出）：
// 本地 Windows 未开开发者模式时有一条符号链接用例被条件跳过，pass 数会比总数少 1，
// 而徽章口径是 CI（ubuntu）的套件总数——写 `passed` 就在非 CI 平台上多报了一个通过。

const BADGE = /tests-\d+%20total/g;
const COMMENT_CJK = /(#\s*(?:运行\s*)?)\d+( 个(?:\s*node:test)?\s*测试)/g;
const COMMENT_EN = /(#\s*)\d+( tests)/g;

/** 把一段文本里所有测试数出现处刷成 count（含徽章与四种注释形状）。 */
export function applyTestCount(text, count) {
  return text
    .replace(BADGE, `tests-${count}%20total`)
    .replace(COMMENT_CJK, `$1${count}$2`)
    .replace(COMMENT_EN, `$1${count}$2`);
}

/**
 * 只读地抽出文本里所有测试数字面量及其形状，供「处处一致」断言使用。
 * 历史版本表里的「745 测试全绿」不带 `#` 前缀，刻意不在两种口径内——那是各版本
 * 当时的真实记录，不该被后续发版改写。
 */
export function readTestCounts(text) {
  const found = [];
  for (const m of text.matchAll(/tests-(\d+)%20total/g)) {
    found.push({ shape: "badge", value: Number(m[1]) });
  }
  for (const m of text.matchAll(/#\s*(?:运行\s*)?(\d+)\s*个(?:\s*node:test)?\s*测试/g)) {
    found.push({ shape: "comment-cjk", value: Number(m[1]) });
  }
  for (const m of text.matchAll(/#\s*(\d+)\s+tests/g)) {
    found.push({ shape: "comment-en", value: Number(m[1]) });
  }
  return found;
}
