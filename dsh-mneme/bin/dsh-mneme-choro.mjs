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
// T1（--t1）沿用同一条纪律，且以「花不花钱」再加一道：dry-run 只列候选模块与跳过
// 原因，--apply 才真开 headless 会话（吃宿主模型额度）。
//
// stdout 纪律：一次成功/dry-run 的 receipt 走 stdout（人读或 --json 机器读），错误
// 与拒绝走 stderr；exit 0 = dry-run 或成功，exit 1 = 拒绝/失败。
import fs, { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../lib/store.js";
import { runChoroT0, ChoroRefusal } from "../lib/wiki/t0.js";
import { createT1, DEFAULT_T1_MODEL, T1Refusal } from "../lib/wiki/t1.js";

const BIN_NAME = "dsh-mneme-choro";
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

const USAGE = `${BIN_NAME} — 仓库地志（chorography）：T0 确定性骨架 + T1 语义生成轮

用法:
  ${BIN_NAME} <repo-path> [选项]

选项:
  --apply        实际写入 <repo>/.chorography/ 并落库（缺省 dry-run，只报数字）
  --t1           T1 语义生成轮：逐模块一轮 headless 会话补四段语义正文 + claims。
                 缺省 dry-run 只列候选；--apply 才开会话（花宿主模型额度）
  --module <slug>      只跑一个模块（T1）
  --model <p/m>        T1 模型路由（缺省 xdpool/deepseek-v4.1-flash）
  --timeout <秒>       T1 单模块墙钟上限（缺省 240s）
  --retry-failed       把 failed 页拉进来重试（T1；成功后计数清零）
  --dsh-exe <路径>     DeepSeek Harness 主程序定位（缺省走 DSH_EXE / 标准安装位）
  --db <path>    memory.db 路径（缺省 ~/.dsh/memory/memory.db，前导 ~ 会展开）
  --json         receipt 用机器可读 JSON 输出
  -h, --help     本帮助
  -V, --version  版本

T0 是确定性骨架（零模型、可离线）：文件树 + import 图 → 模块划分 → 骨架页。
T1 用 headless 会话补语义段落与溯源 claims（逐模块、三重上限、失败不推进）。

页面里 CHORO:HUMAN 标记块的内容在重生成时逐字节保留；块外手改不保留。
`;

function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--t1") flags.t1 = true;
    else if (arg === "--retry-failed") flags.retryFailed = true;
    else if (arg === "--module" || arg === "--model" || arg === "--dsh-exe") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} 需要一个参数`);
      }
      flags[arg.slice(2)] = next;
      i++;
    } else if (arg === "--timeout") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--timeout 需要一个秒数");
      }
      // 现算一次：NaN 会一路混进 spawn 的 timeoutMs，表现成「上限不生效」而不是报错。
      const secs = Number(next);
      if (!Number.isFinite(secs) || secs <= 0) throw new Error(`--timeout 需要正数秒：${next}`);
      flags.timeout = secs;
      i++;
    } else if (arg === "--db") {
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

async function main() {
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
    if (flags.t1) {
      // T1 档（M2）：缺省 dry-run 只列候选模块与章程预览（零会话零写入）；
      // --apply 才真开会话花钱。三重上限与降级表在 createT1 里。
      const t1 = createT1({ store });
      const receipt = await t1.runT1({
        repoRoot: repoPath,
        model: flags.model ?? DEFAULT_T1_MODEL,
        moduleSlug: flags.module ?? null,
        retryFailed: flags.retryFailed === true,
        dryRun: flags.apply !== true,
        dshExe: flags["dsh-exe"] ?? null,
        limits: flags.timeout ? { timeoutMs: flags.timeout * 1000 } : null,
      });
      console.log(flags.json ? JSON.stringify(receipt, null, 2) : renderT1Receipt(receipt, { apply: flags.apply === true }));
      return;
    }
    const receipt = runChoroT0({ repoRoot: repoPath, store, apply: flags.apply === true });
    console.log(flags.json ? JSON.stringify(receipt, null, 2) : renderReceipt(receipt));
  } catch (err) {
    if (err instanceof ChoroRefusal || err instanceof T1Refusal) {
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

function renderT1Receipt(r, { apply }) {
  const lines = [];
  const head = r.dryRun ? "T1 dry-run（未开任何会话；确认后加 --apply）" : "T1 已跑";
  lines.push(`${head} · ${r.repoName} · 模型 ${r.model}`);
  if (r.t1Unavailable) {
    lines.push(`T1 整档不可用（环境级，页状态未动）：${r.t1Unavailable}`);
    lines.push("候选模块仍在下面，环境修好后重跑即可。");
    lines.push("");
  }
  if (r.dryRun) {
    lines.push(`将富化的模块（${r.candidates.length}）：`);
    for (const c of r.candidates) lines.push(`  ${c.slug.padEnd(24)} ${String(c.fileCount).padStart(4)} 文件 · ${c.status}`);
    lines.push(`跳过（${r.skipped.length}）：`);
    for (const s of r.skipped) lines.push(`  ${s.slug} — ${s.reason}`);
    lines.push(`三重上限：${r.limits.timeoutMs}ms 墙钟 / ${r.limits.maxToolCalls} 次工具 / ${r.limits.maxOutputBytes}B 输出`);
    lines.push("");
    lines.push("每个模块一轮 headless 会话，会花宿主模型额度；确认后加 --apply。");
  } else {
    lines.push(`富化 ${r.enriched.length} · 失败 ${r.failed.length} · 跳过 ${r.skipped.length}${r.t1Unavailable ? " · 整档中止（见上）" : ""}`);
    for (const e of r.enriched) lines.push(`  ✓ ${e.slug}（${e.sections.join("/")} · claims ×${e.claims}）`);
    for (const f of r.failed) lines.push(`  ✗ ${f.slug} — ${f.reason}${f.marked ? "（连续失败达阈值，标记 failed）" : ""}`);
    for (const s of r.skipped) lines.push(`  · ${s.slug} — ${s.reason}`);
  }
  for (const w of r.warnings ?? []) lines.push(`提示：${w}`);
  return lines.join("\n");
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

// 直接运行才进 main（import 只取 parseArgv 做单测时必须安静）：npm 全局安装走
// node_modules/.bin 的符号链接，argv[1] 是链接路径而非真身，所以 realpath 两侧再比。
const invokedDirectly = (() => {
  if (process.argv[1] == null) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}

export { parseArgv };
