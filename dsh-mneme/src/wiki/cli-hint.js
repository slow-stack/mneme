// dsh-mneme/src/wiki/cli-hint.js
// issue #607：面板空态让用户「在仓库目录里跑 `dsh-mneme-choro <仓库路径> --apply`」，
// 但插件是装在 profile 依赖里的，npm 只为**全局**安装把 shim 放进 PATH。profile 的
// shim 落在 `<profile>/node_modules/.bin`，那里不在 PATH 上 —— 用户照着抄必然
// command not found。issue 作者实测后的原话是「完全就是 AI 自己编的」。
//
// 所以提示里的命令必须**能直接粘贴就跑**：给绝对路径的入口，而不是一个只对全局
// 安装成立的光名字。入口从插件自身位置推导（不信 PATH、不信 cwd）。
//
// 做法是逐级向上找「同时存在 bin/dsh-mneme-choro.mjs 与 package.json」的目录，
// 而不是固定 dirname 几次：本仓库的 src 与 lib 是同一层，但 wiki/ 是第二层，
// bin/ 里的脚本又在第一层 —— 写死层数的推导只要有一处调用方挪个位置就悄悄算错，
// 而算错的表现正是「又给出一条跑不起来的命令」，与这条 issue 的病因同源。
//
// 这条对 hoisted 与 pnpm isolated 两种 linker 都成立：后者的真实路径在
// `.pnpm/<pkg>/node_modules/@modusensus/dsh-mneme/`，包根照样是它的父目录。
//
// 刻意**只给 `node <entry>` 这一种形态**：`.bin` 的 shim 在 hoisted 布局下位于
// 包根的 `../../../node_modules/.bin`，isolated 布局下却在 profile 根 —— 猜错就是
// 再给一条跑不起来的命令。宁可只给一条一定对的，也不并列两条一条错的。
//
// 找不到入口就返回 null（源码树被裁剪、或调用方在包外），调用方退回通用说法，
// 不硬编一个假路径。
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_BASENAME = "dsh-mneme-choro.mjs";
// 从 `src/wiki/` 到包根是 2 层，从 `bin/` 是 1 层；留到 6 层是为了 pnpm 的
// `.pnpm/<pkg>/node_modules/@modusensus/<name>/` 这种深路径，同时不至于一路走到盘符。
const MAX_LEVELS = 6;

/**
 * choro CLI 入口的绝对路径；找不到（源码树被裁剪、调用方在包外）返回 null。
 *
 * @param {string} fromModuleUrl - 调用方自己的 `import.meta.url`。
 * @returns {string|null}
 */
export function choroCliEntry(fromModuleUrl) {
  let dir;
  try {
    dir = dirname(fileURLToPath(fromModuleUrl));
  } catch {
    return null;
  }
  for (let level = 0; level <= MAX_LEVELS; level += 1) {
    const entry = join(dir, "bin", ENTRY_BASENAME);
    // 两个条件都要：只有 bin/ 没有 package.json 的目录可能是别人的同名 bin；
    // 只有 package.json 没有 bin/ 的是源码树被裁剪（`files` 少了 bin）。
    if (existsSync(entry) && existsSync(join(dir, "package.json"))) return entry;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * 给一句可直接粘贴的命令。只负责引号与形态，仓库路径由调用方给（面板给
 * `<仓库路径>` 占位符，工具报错给 `<repo>`）。
 *
 * 引号按平台分：Windows 的 cmd / PowerShell 用双引号；POSIX 用单引号并把内嵌
 * 单引号转成 `'\''` —— 安装路径里带空格是常态（`C:\Program Files\`），不带引号的
 * 示例等于又给人一条跑不起来的命令。
 *
 * @param {string|null} entry - `choroCliEntry()` 的产物。
 * @param {string} repoPlaceholder - 仓库路径占位符的展示形态。
 * @param {string} [platform] - 覆盖 `process.platform`（测试用）。
 * @returns {string|null}
 */
export function choroCliCommand(entry, repoPlaceholder, platform = process.platform) {
  if (!entry) return null;
  const quoted = platform === "win32"
    ? `"${entry}"`
    : `'${entry.replace(/'/g, "'\\''")}'`;
  return `node ${quoted} ${repoPlaceholder} --apply`;
}

/**
 * 一站式的便捷口：从调用方的 `import.meta.url` 直接拿到命令串。
 * 找不到入口返回 null，调用方据此选通用说法。
 *
 * @param {string} fromModuleUrl
 * @param {string} repoPlaceholder
 * @param {string} [platform]
 * @returns {string|null}
 */
export function choroCliCommandFrom(fromModuleUrl, repoPlaceholder, platform = process.platform) {
  return choroCliCommand(choroCliEntry(fromModuleUrl), repoPlaceholder, platform);
}
