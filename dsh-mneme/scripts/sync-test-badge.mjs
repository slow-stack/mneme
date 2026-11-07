// 发版前对齐徽章（手动跑 npm run badge:sync；release.yml 不再有 badge job ——
// main 受保护，github-actions[bot] 的 GITHUB_TOKEN 绕过不了 required status
// checks，push 必被 GH006 拒）。
//
// 做三件事：
//   1. 跑一遍全量测试（npm test），取套件总数（`ℹ tests N` 汇总行）；
//   2. 把双 README 的 tests 徽章（img.shields.io/badge/tests-N%20total）与
//      开发命令注释（# N 个测试 / # 运行 N 个测试 / # N 个 node:test 测试 /
//      # N tests）刷成该数字——形状集合收在 scripts/test-count-sync.mjs，与发版
//      自动路径 scripts/release-prep.mjs 共用（两条路径各存一份曾导致 v0.8.11
//      徽章与注释不同数）；
//   3. 有变化就写回文件（由调用方决定是否 commit/push），无变化静默退出。
//
// 测试失败（fail>0 或进程非零退出）时以非零退出且不改任何文件——徽章永远
// 不可能指向一次没跑绿的套件。历史版本表里的「N 测试全绿」是各版本当时的
// 真实记录，刻意不在替换范围内（正则只打徽章与 `#` 注释两种形状）。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTestCount } from "./test-count-sync.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

// 1) 全量测试
let output;
try {
  output = execSync("npm test", {
    cwd: join(repoRoot, "dsh-mneme"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
} catch (error) {
  const tail = String(error.stdout ?? "").split("\n").slice(-25).join("\n");
  console.error("npm test 未跑绿，徽章不更新：\n" + tail);
  process.exit(1);
}

// 2) 取套件总数（spec reporter 的 `ℹ tests N`；取最后一处防逐用例行干扰）
//    用总数而非 `pass N`：平台条件跳过的用例（如 Windows 未开开发者模式时的
//    符号链接断言）在 pass 里不计、在 tests 里计入，而徽章报的是 CI（ubuntu）
//    口径 —— 用总数则本地在 Windows 跑也得到同一个数，不必手工修。
const matches = [...output.matchAll(/ℹ tests (\d+)/g)];
const count = matches.length ? Number(matches[matches.length - 1][1]) : 0;
if (!count) {
  console.error("无法从测试输出解析套件总数，徽章不更新");
  process.exit(1);
}

// 3) 刷双 README（徽章 + 四种开发命令注释形状）
// 形状集合与 release-prep.mjs（发版自动路径）共用，收在 scripts/test-count-sync.mjs —
// 两条路径各自维护一份规则正是 v0.8.11 注释漂移的根因。
const targets = [
  join(repoRoot, "README.md"),
  join(repoRoot, "dsh-mneme", "README.md")
];
let changed = 0;
for (const file of targets) {
  const text = readFileSync(file, "utf8");
  const next = applyTestCount(text, count);
  if (next !== text) {
    writeFileSync(file, next);
    changed += 1;
    console.log(`updated: ${file}`);
  }
}
console.log(`tests=${count}, files changed=${changed}`);
