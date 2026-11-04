#!/usr/bin/env node
// bin/dsh-mneme-choro.mjs —— chorography（仓库地志）T0 确定性骨架的命令行入口。
//
// 为什么独立成 bin 而不是 cli.mjs 的子命令：CONTRIBUTING「The CLI is dependency-free
// by contract」禁止给 bin/cli.mjs 加 import，而 T0 要挂 lib/ 的扫描/划分/渲染与
// store（写 choro_* 表）；命名循 dsh-mneme-serve / dsh-mneme-mcp 先例。
//
// 为什么缺省 dry-run、--apply 才写：会动仓库磁盘的东西先给数字再执行（reclaim 同款
// 纪律）。dry-run 零写入，receipt 里有「会写哪些文件、各多大」。
//
// stdout 纪律：一次成功/dry-run 的 receipt 走 stdout（人读或 --json 机器读），错误
// 与拒绝走 stderr；exit 0 = dry-run 或成功，exit 1 = 拒绝/失败。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../lib/store.js";
import { runChoroT0, ChoroRefusal } from "../lib/wiki/t0.js";

const BIN_NAME = "dsh-mneme-choro";
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

const USAGE = `${BIN_NAME} — 仓库地志（chorography）T0 确定性骨架生成

用法:
  ${BIN_NAME} <repo-path> [选项]

选项:
  --apply        实际写入 <repo>/.chorography/ 并落库（缺省 dry-run，只报数字）
  --db <path>    memory.db 路径（缺省 ~/.dsh/memory/memory.db，前导 ~ 会展开）
  --json         receipt 用机器可读 JSON 输出
  -h, --help     本帮助
  -V, --version  版本

T0 是确定性骨架（零模型、可离线）：文件树 + import 图 → 模块划分 → 骨架页。
语义段落（架构/约定/技术栈）由 T1 headless 生成轮补（M2，本入口暂无）。

页面里 CHORO:HUMAN 标记块的内容在重生成时逐字节保留；块外手改不保留。
`;

function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--db") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--db 需要一个路径参数");
      }
      flags.db = next;
      i++;
    } else if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "-V" || arg === "--version") flags.version = true;
    else if (arg.startsWith("--")) throw new Error(`未知选项: ${arg}`);
    else positionals.push(arg);
  }
  return { positionals, flags };
}

// 前导 ~ 展开，语义与 src/serve.js 同款（~ 只在开头、后面跟 / 或 \ 或结尾）。
function expandHome(path) {
  const home = homedir();
  return String(path).replace(/^~(?=$|[\\/])/, home);
}

function defaultDbPath() {
  return expandHome("~/.dsh/memory/memory.db");
}

function main() {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
  const { positionals, flags } = parsed;
  if (flags.version) {
    console.log(PKG.version);
    return;
  }
  if (flags.help) {
    console.log(USAGE.trimEnd());
    return;
  }
  if (positionals.length === 0) {
    console.error(USAGE.trimEnd());
    console.error(`\n缺仓库路径：${BIN_NAME} <repo-path> [--apply]`);
    process.exit(1);
  }
  if (positionals.length > 1) {
    console.error(`多余的位置参数：${positionals.slice(1).join(" ")}（仓库路径只有一个，含空格请加引号）`);
    process.exit(1);
  }

  const repoPath = resolve(positionals[0]);
  const dbPath = resolve(expandHome(flags.db ?? defaultDbPath()));

  let store;
  try {
    store = createStore(dbPath);
  } catch (err) {
    console.error(`打开 memory.db 失败（${dbPath}）：${String(err?.message ?? err)}`);
    process.exit(1);
  }

  try {
    const receipt = runChoroT0({ repoRoot: repoPath, store, apply: flags.apply === true });
    console.log(flags.json ? JSON.stringify(receipt, null, 2) : renderReceipt(receipt));
  } catch (err) {
    if (err instanceof ChoroRefusal) {
      console.error(`拒绝运行（${err.code}）：${err.message}`);
    } else {
      console.error(`${BIN_NAME} 失败：${err?.stack ?? String(err)}`);
    }
    process.exitCode = 1;
  } finally {
    try { store.close(); } catch { /* WAL 关闭异常不遮蔽主结果 */ }
  }
  if (process.exitCode) process.exit(process.exitCode);
}

function renderReceipt(r) {
  const lines = [];
  const head = r.dryRun ? "dry-run（未写任何东西；确认后加 --apply）" : "已写入";
  lines.push(`${head} · ${r.repoName} @ ${r.repoPath}`);
  lines.push(`git 基线 ${r.gitBaseline} · 计划 ${r.planPath ?? "（无 plan.yaml，走默认启发式）"}`);
  lines.push(
    `扫描 ${r.fileCount} 个文件 → ${r.moduleCount} 个模块 → ${r.pageCount} 页` +
    (r.skippedByWhitelist > 0 ? `（白名单挡掉 ${r.skippedByWhitelist} 页）` : "") +
    ` · generatedAt ${r.generatedAt}${r.reusedGeneratedAt ? "（沿用上次）" : ""}`
  );
  if (r.skippedFiles.length > 0) {
    lines.push(`跳过 ${r.skippedFiles.length} 个读不了的文件：`);
    for (const s of r.skippedFiles.slice(0, 5)) lines.push(`  · ${s.file} — ${s.reason}`);
    if (r.skippedFiles.length > 5) lines.push(`  … 共 ${r.skippedFiles.length} 个`);
  }
  if (r.unresolvedCount > 0) lines.push(`${r.unresolvedCount} 条相对引用未解析（别名/动态路径），未计入依赖图。`);
  lines.push("");
  lines.push("模块划分：");
  for (const m of r.moduleSummary) {
    lines.push(`  ${m.slug.padEnd(28)} ${String(m.fileCount).padStart(4)} 文件 · ${m.internalEdges} 边 · ${m.externalDeps} 外部依赖 · ${m.title}`);
  }
  lines.push("");
  if (r.dryRun) {
    lines.push("将写入：");
    for (const w of r.wouldWrite) lines.push(`  ${w.path}（${w.bytes} B）`);
    lines.push(`会保留的 CHORO:HUMAN 保留区：${r.humanBlocksSeen} 块`);
    lines.push("");
    lines.push("确认无误后加 --apply 执行。");
  } else {
    lines.push(`写入 ${r.bytes} B；保留区 ${r.humanBlocksPreserved} 块逐字节未动；choro_* 表已整仓替换。`);
  }
  for (const w of r.warnings) lines.push(`提示：${w}`);
  return lines.join("\n");
}

main();
