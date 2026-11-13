// dsh-mneme/src/bootstrap.js
// 冷启动（issue #220）：从既有仓库文件反向构建初始记忆，让新装实例不用等会话
// 积累就有可用的项目记忆（对照 hindsight-coding-agents 的 per-repo bank）。
//
// 纯确定性解析（零 LLM，必有产出）；v1 不含 commit 聚类的 LLM 总结——standalone
// API 层没有 LLM 句柄，待后续接入（确定性部分不依赖它）。
//
// 幂等骑在 saveWithDedupe 的 (type, title, scope) 去重上：同标题重跑走
// _overwrite 原地刷新（content_history 记 overwrite），不产生重复行。全部产物
// source='bootstrap'、tags 带 'bootstrap'、content 尾部带来源文件路径。
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const READ_LIMIT = 1200;  // README/CONTRIBUTING 摘录上限（字符）
const TOP_DIRS_MAX = 20;  // 顶层目录条目上限
const WORKFLOW_MAX = 8;   // CI workflow 文件数上限
const COMMIT_MAX = 20;    // git log 主题条目上限
const GIT_TIMEOUT_MS = 5000;

/** 带 code 的输入错误：standalone 路由按 code 映射 400。 */
export class BootstrapError extends Error {
  constructor(code) {
    super(code);
    this.name = "BootstrapError";
    this.code = code;
  }
}

/** 读文件前 READ_LIMIT 字符；失败（不存在/不可读）返回 null。 */
function readHead(path) {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > READ_LIMIT ? text.slice(0, READ_LIMIT) : text;
  } catch {
    return null;
  }
}

/** 顶层目录名（跳过依赖与构建产物，截 TOP_DIRS_MAX）。 */
function topDirs(root) {
  try {
    const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".cache"]);
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP.has(e.name))
      .map((e) => e.name)
      .slice(0, TOP_DIRS_MAX);
  } catch {
    return [];
  }
}

/** .github/workflows 下的工作流文件名（yml/yaml，截 WORKFLOW_MAX）。 */
function workflowNames(root) {
  const dir = join(root, ".github", "workflows");
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
      .slice(0, WORKFLOW_MAX);
  } catch {
    return [];
  }
}

/** 最近 COMMIT_MAX 条提交主题；非 git 仓库 / git 不可用 → null。 */
async function recentCommitSubjects(root) {
  if (!existsSync(join(root, ".git"))) return null;
  try {
    const { stdout } = await execFileAsync(
      "git", ["-C", root, "log", `-${COMMIT_MAX}`, "--pretty=%s"],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true }
    );
    const lines = String(stdout).split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines : null;
  } catch {
    return null;
  }
}

function bullets(lines) {
  return lines.map((l) => `- ${l}`).join("\n");
}

/**
 * 收集确定性产物：每个来源一条候选（来源缺失返回 null 占位，由主流程过滤）。
 * 顺序固定，方便验收断言「五类齐全」。
 */
async function collectCandidates(root) {
  const candidates = [];

  // 1) package.json scripts → 怎么跑测试/构建
  let scripts = null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
      const entries = Object.entries(pkg.scripts).filter(([, v]) => typeof v === "string" && v.trim());
      if (entries.length) scripts = entries;
    }
  } catch { /* 缺失或非法 package.json → 跳过该条 */ }
  if (scripts) {
    candidates.push({
      type: "project",
      title: "项目脚本命令",
      content: `npm scripts 一览（来源：package.json）：\n${bullets(scripts.map(([k, v]) => `${k}: ${v}`))}`
    });
  }

  // 2) README → 项目概览
  const readmeName = ["README.md", "README.zh-CN.md", "README.en.md", "README.txt"]
    .find((n) => existsSync(join(root, n)));
  if (readmeName) {
    const head = readHead(join(root, readmeName));
    if (head?.trim()) {
      candidates.push({
        type: "project",
        title: "项目概览",
        content: `${head.trim()}\n\n来源：${readmeName}（前 ${READ_LIMIT} 字符）`
      });
    }
  }

  // 3) CONTRIBUTING → 贡献规范
  const contributingName = ["CONTRIBUTING.md", "docs/CONTRIBUTING.md"]
    .find((n) => existsSync(join(root, n)));
  if (contributingName) {
    const head = readHead(join(root, contributingName));
    if (head?.trim()) {
      candidates.push({
        type: "constraint",
        title: "贡献规范",
        content: `${head.trim()}\n\n来源：${contributingName}（前 ${READ_LIMIT} 字符）`
      });
    }
  }

  // 4) CI 工作流清单
  const workflows = workflowNames(root);
  if (workflows.length) {
    candidates.push({
      type: "project",
      title: "CI 工作流清单",
      content: `.github/workflows 下的工作流文件（来源：.github/workflows）：\n${bullets(workflows)}`
    });
  }

  // 5) 顶层目录结构
  const dirs = topDirs(root);
  if (dirs.length) {
    candidates.push({
      type: "project",
      title: "顶层目录结构",
      content: `仓库顶层目录（来源：目录树，已跳过 node_modules/.git/dist 等产物）：\n${bullets(dirs)}`
    });
  }

  // 6) 近期提交主线（git log 原始主题，非 git 仓库静默跳过）
  const subjects = await recentCommitSubjects(root);
  if (subjects) {
    candidates.push({
      type: "history",
      title: "近期提交主线",
      content: `最近 ${subjects.length} 条提交主题（来源：git log）：\n${bullets(subjects)}`
    });
  }

  return candidates;
}

/**
 * 对 dir 指向的仓库目录执行冷启动构建。逐条经 saveWithDedupe 落库
 * （source='bootstrap'、_overwrite 原地刷新）。
 * 返回 { dir, created, merged, items: [{action, id, title}] }。
 * 输入错误抛 BootstrapError（code: missing-dir / dir-not-found / not-a-directory）。
 */
export async function bootstrapFromDirectory({ service, dir, logger } = {}) {
  if (typeof dir !== "string" || !dir.trim()) throw new BootstrapError("missing-dir");
  // 只 trim 判空，**不**把 trim 结果当路径（#386 第 6 条评审）：协议层 readBootstrapDir
  // 刻意回传原串，理由写着「两端空白交给 fs 报 dir-not-found 比静默改写更诚实」；这里
  // 若再 trim 一次，那个承诺就变成了空话——用户填 " /repo " 会被悄悄换成 "/repo"，
  // 读的是另一个目录，而他一无所知。路径不合法就让 statSync 去报。
  const root = dir;
  let st;
  try {
    st = statSync(root);
  } catch {
    throw new BootstrapError("dir-not-found");
  }
  if (!st.isDirectory()) throw new BootstrapError("not-a-directory");

  const candidates = await collectCandidates(root);
  const items = [];
  let created = 0;
  let merged = 0;
  let denied = 0;
  for (const item of candidates) {
    try {
      const { action, memory, reason } = service.saveWithDedupe({
        ...item,
        importance: 3,
        tags: ["bootstrap"],
        source: "bootstrap",
        _overwrite: true
      });
      // #663: bootstrap has no session, so only the level-1 admission judgment applies
      // here. Report the denial instead of letting a null `memory` fall into the outer
      // catch — that shape lost both the reason and the count.
      if (action === "denied") {
        denied++;
        items.push({ action, id: null, title: item.title, reason: reason ?? null });
        logger?.warn?.(`[dsh-mneme] bootstrap item "${item.title}" denied by admission (${reason ?? "unknown"})`);
        continue;
      }
      if (action === "created") created++;
      else merged++;
      items.push({ action, id: memory.id, title: memory.title });
    } catch (error) {
      // 单条失败不反噬整体（与冷启动「必有产出」的定位一致），但留 warn 可查。
      logger?.warn?.(`[dsh-mneme] bootstrap item "${item.title}" failed: ${String(error)}`);
    }
  }
  return { dir: root, created, merged, denied, items };
}
