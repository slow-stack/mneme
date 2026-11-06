// 锁「本地工具状态目录不得再进库」这条预防层，以及它配套的那条公开记档。
//
// 背景：2026-11-05 分支 feat/choro-panel-run-and-vectors 有一次粗粒度 git add 把 .mimosa/
// （本地扫描钩子的状态目录，22 个文件）吸进了功能提交。文件两个提交后删掉了，但 blob 留在历史里、
// 仓库是 PUBLIC，其中一条 hook-status 记着一台机器的绝对路径。删文件不是补偿——删只把暴露从
// 目录树挪进对象存储（详见 SECURITY.md 的 2026-11-05 条目）。所以真正的防线只有两层：
//
//   1. 忽略规则（本文件第 1 组用例）——两个 .gitignore 都必须有。仓库里有两个 .mimosa 前缀
//      （仓库根与 dsh-mneme/），只写一处时另一处照样会被 add 进来；历史重写那次就栽在这里。
//   2. 忽略规则若被谁「顺手清掉」，本文件必须变红——否则下一次 add -A 又是同一个坑。
//
// 第 2 组用例守的是记档本身：SECURITY.md 要中英各一条（两份文档都在同一文件里，缺一边等于
// 一种语言的读者看不到这件事），且条目里不得出现任何本机绝对路径——一份记录泄露的文档
// 自己再泄露一次就是二次事故。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(pkgRoot);

// 两个前缀都必须覆盖：历史上漏的就是「只写了 dsh-mneme/.mimosa」。
const gitignores = [
  { label: "仓库根 .gitignore", file: path.join(repoRoot, ".gitignore") },
  { label: "dsh-mneme/.gitignore", file: path.join(pkgRoot, ".gitignore") },
];

for (const { label, file } of gitignores) {
  test(`${label} 忽略 .mimosa/（本地工具状态不进库）`, () => {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim());
    assert.ok(
      lines.includes(".mimosa/"),
      `${label} 缺少 .mimosa/ 忽略规则。少了它，下一次 git add -A 会把钩子状态目录再带进库——` +
        "2026-11-05 已经发生过一次，且 blob 至今仍可从历史取到。两处都要写：本仓有两个 .mimosa 前缀。"
    );
  });
}

test("SECURITY.md 有这次暴露的中英双份记档，且记档本身不含本机绝对路径", () => {
  const doc = readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
  const headings = doc.split(/\r?\n/).filter((l) => l.startsWith("### 2026-11-05 — "));
  assert.equal(
    headings.length,
    2,
    `SECURITY.md 应有中英各一条「### 2026-11-05 — 」记档，实际 ${headings.length} 条。` +
      "只写一边等于另一种语言的读者看不到这条已知暴露。"
  );

  // 记档里点名的是「本机目录结构」这件事本身，不能反过来把路径抄进去：
  // 一条记录泄露的条目自己再泄露一次，就是把事故重演一遍。
  // 只扫记档那两段（每条从标题到下一个 `### `），别拿整篇文档去撞历史遗留的行。
  const lines = doc.split(/\r?\n/);
  const section = [];
  let inside = false;
  for (const l of lines) {
    if (l.startsWith("### ")) inside = l.startsWith("### 2026-11-05 — ");
    if (inside) section.push(l);
  }
  const leaked = section.filter((l) =>
    /[A-Za-z]:\\Users\\/.test(l) || l.includes("/Users/") || l.includes("AppData")
  );
  assert.deepEqual(leaked, [], `记档不得出现本机绝对路径，实际命中：${leaked.join(" | ")}`);
});
