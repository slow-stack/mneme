// 断言 src/ 与 lib/ 一致——发布前的平价闸门。
//
// npm 包实际加载 lib/（package main → lib/index.js）。历史教训：PR #60 只改了 src
// 忘了同步 lib，v0.7.8 发出去的 npm 包跑的还是旧代码，用户侧静默失效（issue #65）。
//
// 注意这里**只校验、不同步**：prepack 钩子跑的是 `npm run sync`（把 src 覆盖到
// lib），同步后必然一致，所以它永远不会因漂移失败。真正的闸门是这道脚本，跑在
// CI 每个 PR 与 release.yml 的 test job 里——让漂移在合并前就红，而不是等到发布。
//
// 用法：node scripts/check-sync.js （CI 与 release.yml 调用，非 prepack）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url))); // dsh-mneme/
const srcDir = join(root, "src");
const libDir = join(root, "lib");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const bad = [];
for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file);
  const dest = join(libDir, rel);
  if (!existsSync(dest)) {
    bad.push(`missing  lib/${rel}`);
  } else if (!readFileSync(file).equals(readFileSync(dest))) {
    bad.push(`differ   lib/${rel}`);
  }
}
if (bad.length) {
  console.error(`✗ src/ 与 lib/ 不一致（${bad.length} 处）——npm 包实际加载 lib/，请先 npm run sync 并提交：`);
  for (const line of bad) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`✓ src/ 与 lib/ 一致（${walk(srcDir).length} 个文件）`);
