// dsh-mneme/src/wiki/t0.js
// T0 编排（spec §6 步 1–8）：读 plan → 列文件 → 解析 import 图 → 划分模块 →
// 渲染骨架 → dry-run 报告或 apply 写盘 + 落库 + state.json 收尾。
//
// 全程零模型、零网络、可离线（spec：T0「秒级、可离线、必有产出」）。所有磁盘写入
// 被限定在 `<repo>/.chorography/` 之内（红线 1 的机械面：写路径断言 + 不碰
// .github/.gitignore/AGENTS.md，契约测试对整个仓库做树快照比对）。
//
// 失败语义（红线 5）：中途任何一步失败，state.json 不写（保持上一次成功 run 的
// 内容），库侧 replaceChoroGraph 是单事务——半截失败整体回滚到上一次成功 run。
// 重跑幂等：同样的输入得到同样的划分、同样的页面字节、同样的行数。
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, realpathSync, readdirSync } from "node:fs";
import { join, posix, sep, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadPlanFromRepo } from "./plan.js";
import {
  listFiles, parseImportGraph, repoFingerprint, countLines,
  readRootPackage, workspacePrefixes, compileInclude,
} from "./scan.js";
import { partitionModules } from "./partition.js";
import { portableKeyFor, hostId } from "./portable.js";
import {
  renderSkeletonPage, renderIndex, extractHumanBlocks, injectHumanBlocks,
  TEMPLATE_VERSION, T1_SECTION_START,
} from "./render.js";

export const CHORO_DIR = ".chorography";

/** 拒绝类：CLI 据此透出人话并 exit 1（不写任何东西就退）。 */
export class ChoroRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChoroRefusal";
    this.code = code;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot 仓库路径（内部 realpath）
 * @param {object|null} opts.store createStore 产物（apply 时必传；dry-run 可为 null）
 * @param {boolean} [opts.apply=false] false = dry-run（零写入）
 * @param {boolean} [opts.guardT1Loss=false] 会丢掉已有语义段时整轮拒绝（自动刷新用）
 * @param {() => string} [opts.now] ISO 时刻（测试注入假时钟）
 */
export function runChoroT0({ repoRoot, store = null, apply = false, guardT1Loss = false, now = () => new Date().toISOString() }) {
  let rootPath;
  try {
    rootPath = realpathSync(resolve(repoRoot));
  } catch (err) {
    throw new ChoroRefusal("no-such-dir", `仓库路径不存在或不可达：${repoRoot}（${String(err?.message ?? err)}）`);
  }
  if (!statDir(rootPath)) {
    throw new ChoroRefusal("no-such-dir", `仓库路径不是目录：${rootPath}`);
  }

  // git 基线（spec 降级表第一行：不是 git 仓库 → 拒绝并说明原因，锚点无法核验）。
  const gitBaseline = gitHead(rootPath);
  if (!gitBaseline) {
    throw new ChoroRefusal(
      "not-git",
      `${rootPath} 不是 git 仓库（git rev-parse HEAD 失败）。chorography 的每条出处锚点都要能对着提交核验，非 git 目录拒绝生成。`
    );
  }

  // plan.yaml（用户所有，机器只读）：有 → 严格校验（未知键整轮拒绝）；无 → 默认启发式。
  const loaded = loadPlanFromRepo(rootPath);
  const plan = loaded.plan;

  // 扫描（spec 步 2–3）。include 白名单非空时文件还须命中任意一条。
  const includeMatcher = compileInclude(plan.include ?? []);
  let files = listFiles(rootPath, { exclude: plan.exclude ?? [] });
  if ((plan.include ?? []).length > 0) files = files.filter((f) => includeMatcher.matchesFile(f));
  const graph = parseImportGraph(rootPath, files);

  // 划分（spec 步 4）。workspace 前缀目前只作登记，不参与合并启发式（v1 保守）。
  const pkg = readRootPackage(rootPath);
  workspacePrefixes(pkg?.workspaces ?? []);
  const repoName = pkg?.name ?? rootPath.split(/[\\/]/).pop() ?? "repo";
  const modules = partitionModules({ files, graph, maxFilesPerPage: plan.maxFilesPerPage, repoName });

  // 模块级依赖边（M1 补口 P8）：文件级边按所属模块聚合，只留跨模块方向；排序
  // 进快照，库里的边集与页面字节一样可重建。
  const slugByFile = new Map();
  for (const mod of modules) {
    for (const f of mod.files) slugByFile.set(f, mod.slug);
  }
  const edgeAgg = new Map();
  for (const e of graph.edges) {
    const from = slugByFile.get(e.from);
    const to = slugByFile.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}|${to}`;
    edgeAgg.set(key, (edgeAgg.get(key) ?? 0) + 1);
  }
  const moduleEdges = [...edgeAgg.entries()]
    .map(([key, weight]) => {
      const [fromSlug, toSlug] = key.split("|");
      return { fromSlug, toSlug, weight };
    })
    .sort((a, b) =>
      a.fromSlug < b.fromSlug ? -1 : a.fromSlug > b.fromSlug ? 1 : a.toSlug < b.toSlug ? -1 : 1
    );

  // 页面白名单（D7 正面控制）：plan.pages 非空时只给列出的 slug 建页。
  const whitelist = plan.pages && plan.pages.length > 0 ? new Map(plan.pages.map((p) => [p.path, p])) : null;
  const warnings = [];
  if (whitelist) {
    for (const [path] of whitelist) {
      if (!modules.some((m) => m.slug === path)) {
        warnings.push(`plan.yaml pages 里的 "${path}" 没有对应的模块划分结果（划分会随代码漂移，这不是错误，只提示）。`);
      }
    }
  }

  // state.json：沿用上次成功 run 的 generatedAt（实现计划 P3）——只有当
  // plan 与仓库状态都没变时沿用，页面字节才逐字稳定（spec §9 可重建不变量）。
  const fingerprint = repoFingerprint(files, graph.edges);
  const prevState = readState(rootPath);
  const stateStable =
    prevState !== null &&
    prevState.planFingerprint === loaded.fingerprint &&
    prevState.repoFingerprint === fingerprint;
  const generatedAt = stateStable && prevState.generatedAt ? prevState.generatedAt : now();

  const unresolvedTotal = graph.unresolved.length;

  // 页面组装（spec 步 6）。
  const pageTargets = [];
  for (const mod of modules) {
    if (whitelist && !whitelist.has(mod.slug)) continue;
    const entry = assembleModuleView(mod, modules, graph, rootPath);
    const custom = whitelist?.get(mod.slug);
    let content = renderSkeletonPage(entry, {
      slug: mod.slug,
      title: custom?.title ?? mod.title,
      parents: parentChain(mod, modules),
      sourceFiles: mod.files,
      gitBaseline,
      generatedAt,
      status: "skeleton",
      language: "zh",
    });
    const extra = renderPlanExtras(custom, plan, warnings);
    if (extra) content = `${content.replace(/\n*$/, "\n")}\n${extra}`;
    pageTargets.push({ moduleSlug: mod.slug, relPath: `${CHORO_DIR}/modules/${mod.slug}.md`, content });
  }

  const indexRelPath = `${CHORO_DIR}/index.md`;
  // index 是「页面目录」：白名单挡掉的模块没有页，目录里也不列（列出会指向不存在的文件）。
  const indexedModules = modules.filter((m) => !whitelist || whitelist.has(m.slug));
  const indexContent = renderIndex(
    indexedModules.map((m) => ({
      ...m,
      fileLines: [],
    })),
    {
      name: repoName,
      gitBaseline,
      generatedAt,
      fileCount: files.length,
      skipped: graph.skipped.length,
      unresolved: unresolvedTotal,
      scripts: pkg?.scripts ?? {},
    }
  );

  // T0 重跑会把已富化的页退回骨架（P19：富化层不参与字节稳定不变量，重建整页丢弃
  // 重来）。丢弃本身是设计意图，静默不是：不清点的话，人看到的只是「跑完 T0，语义
  // 段落没了」，而 .chorography/evidence/*.json 还会变成没人引用的孤儿。这里只报，
  // 不改字节、不删 evidence——一条只读的清点，dry-run 与 apply 共用。
  const t1Loss = collectT1Loss(rootPath, pageTargets);
  if (t1Loss.pages.length > 0) {
    const names = t1Loss.pages.slice(0, 3).join("、");
    warnings.push(
      `${t1Loss.pages.length} 页含 T1 语义段（${names}${t1Loss.pages.length > 3 ? " 等" : ""}）：`
      + `本次会退回骨架、清空 choro_claims`
      + `${t1Loss.orphanEvidence > 0 ? `，${t1Loss.orphanEvidence} 份 evidence 文件会变成孤儿（不删）` : ""}。`
      + "要留住语义段就别在这里重跑 T0；需要时再用 --t1 重新富化。"
    );
  }
  if (t1Loss.unreadable.length > 0) {
    warnings.push(
      `${t1Loss.unreadable.length} 页读不出来`
      + `（${t1Loss.unreadable.slice(0, 3).map((u) => u.relPath).join("、")}${t1Loss.unreadable.length > 3 ? " 等" : ""}），`
      + "无法确认其中是否有 T1 语义段；自动刷新会因此拒绝，手动重建会按骨架重写这些页。"
    );
  }
  // guardT1Loss（自动刷新专用）：读路径上「顺手」重跑 T0 会把用户花模型调用换来的
  // 语义段和 claims 一起清掉——那不是顺手，那是在用户只点开一页的时候替他做了一次
  // 破坏性写盘。手动重建不受此限：用户点了按钮，回执里的 warnings 会如实列出丢了什么。
  //
  // 拒绝而不是「跳过有语义段的那几页」：T0 的整仓 replaceChoroGraph 是一次事务，
  // 只保几页会留下「页面有 T1 正文、库里 claims 已被清空」的半截状态，比整体不写更糟。
  //
  // 读不出来的页同样要拒绝：清点靠读盘，读失败就先不知道它有没有语义段。放行等于
  // 赌它没有，赌输就是把它那份语义段和 claims 一起抹掉；拒绝只是这次不刷新。
  if (guardT1Loss && (t1Loss.pages.length > 0 || t1Loss.unreadable.length > 0)) {
    const names = t1Loss.pages.slice(0, 3).join("、");
    const blockedBy = t1Loss.unreadable.length > 0
      ? `另有 ${t1Loss.unreadable.length} 页读不出来（${t1Loss.unreadable.slice(0, 3).map((u) => u.relPath).join("、")}`
        + `${t1Loss.unreadable.length > 3 ? " 等" : ""}），无法确认它们有没有语义段。`
      : "";
    throw new ChoroRefusal(
      "would-drop-t1",
      `这个仓库有 ${t1Loss.pages.length} 页已经富化过（${names}${t1Loss.pages.length > 3 ? " 等" : ""}）。`
      + blockedBy
      + "自动刷新会退回骨架、清空 claims，所以这次没有动："
      + "要保留语义段就先别刷新，确实要重建骨架请在面板里手动点「重建骨架」（回执会列出丢了哪几页）。"
    );
  }

  if (!apply) {
    return {
      dryRun: true,
      repoPath: rootPath,
      repoName,
      gitBaseline,
      planPath: loaded.planPath,
      planFingerprint: loaded.fingerprint,
      repoFingerprint: fingerprint,
      generatedAt,
      reusedGeneratedAt: stateStable,
      fileCount: files.length,
      moduleCount: modules.length,
      pageCount: pageTargets.length,
      skippedByWhitelist: whitelist ? modules.length - pageTargets.length : 0,
      skippedFiles: graph.skipped,
      unresolvedCount: unresolvedTotal,
      humanBlocksSeen: countExistingHumanBlocks(rootPath, pageTargets),
      t1Loss: { pages: t1Loss.pages, unreadable: t1Loss.unreadable, orphanEvidence: t1Loss.orphanEvidence },
      wouldWrite: [...pageTargets.map((p) => ({ path: p.relPath, bytes: Buffer.byteLength(p.content, "utf8") })),
        { path: indexRelPath, bytes: Buffer.byteLength(indexContent, "utf8") },
        { path: `${CHORO_DIR}/state.json`, bytes: 0 }],
      warnings,
      moduleSummary: modules.map((m) => ({
        slug: m.slug, title: m.title, fileCount: m.fileCount,
        internalEdges: m.internalEdges.length, externalDeps: m.externalDeps.length,
      })),
    };
  }

  if (!store) throw new ChoroRefusal("store-required", "apply 模式需要打开的 store（memory.db）。");

  // apply：写盘 → 落库 → state.json 收尾（红线 5：失败不推进 state）。
  const choroDir = join(rootPath, CHORO_DIR);
  mkdirSync(join(choroDir, "modules"), { recursive: true });

  let humanBlocksPreserved = 0;
  let bytes = 0;
  for (const target of pageTargets) {
    const abs = assertInsideChoro(rootPath, target.relPath);
    const finalContent = preserveHumanBlocks(abs, target.content);
    if (finalContent.humanBlocks > 0) humanBlocksPreserved += finalContent.humanBlocks;
    writeFileSync(abs, finalContent.content, "utf8");
    bytes += Buffer.byteLength(finalContent.content, "utf8");
  }
  const indexAbs = assertInsideChoro(rootPath, indexRelPath);
  writeFileSync(indexAbs, indexContent, "utf8");
  bytes += Buffer.byteLength(indexContent, "utf8");

  // 身份与位置一起登记（#581）：身份键从 remote URL 归一化（无 remote 退化根提交
  // 哈希），位置表按当前 host 落一行。T1 的登记校验与读侧的本机路径解析都吃这两样。
  const portableKey = portableKeyFor(rootPath);
  const repoRow = store.upsertChoroRepo(rootPath, repoName, loaded.fingerprint, gitBaseline, generatedAt, portableKey);
  store.upsertChoroRepoPath(portableKey, hostId(), rootPath, generatedAt);
  store.replaceChoroGraph(repoRow.id, {
    edges: moduleEdges,
    modules: modules.map((m) => ({
      slug: m.slug,
      title: (whitelist?.get(m.slug)?.title) ?? m.title,
      parentSlug: m.parentSlug,
      fileCount: m.fileCount,
      fingerprint: m.fingerprint,
    })),
    pages: pageTargets.map((p) => ({
      moduleSlug: p.moduleSlug,
      relPath: p.relPath,
      status: "skeleton",
      gitBaseline,
      templateVersion: TEMPLATE_VERSION,
      generatedAt,
      humanBlockCount: existingHumanBlockCount(join(rootPath, p.relPath)),
      claims: [],
    })),
    updatedAt: generatedAt,
  });

  const state = {
    choro: "v1",
    gitBaseline,
    templateVersion: TEMPLATE_VERSION,
    planFingerprint: loaded.fingerprint,
    repoFingerprint: fingerprint,
    generatedAt,
    moduleCount: modules.length,
    pageCount: pageTargets.length,
    fileCount: files.length,
  };
  const stateAbs = assertInsideChoro(rootPath, `${CHORO_DIR}/state.json`);
  writeFileSync(stateAbs, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  return {
    dryRun: false,
    repoPath: rootPath,
    repoName,
    gitBaseline,
    planPath: loaded.planPath,
    planFingerprint: loaded.fingerprint,
    repoFingerprint: fingerprint,
    generatedAt,
    reusedGeneratedAt: stateStable,
    fileCount: files.length,
    moduleCount: modules.length,
    pageCount: pageTargets.length,
    skippedByWhitelist: whitelist ? modules.length - pageTargets.length : 0,
    skippedFiles: graph.skipped,
    unresolvedCount: unresolvedTotal,
    humanBlocksPreserved,
    bytes,
    t1Loss: { pages: t1Loss.pages, unreadable: t1Loss.unreadable, orphanEvidence: t1Loss.orphanEvidence },
    warnings,
    moduleSummary: modules.map((m) => ({
      slug: m.slug, title: m.title, fileCount: m.fileCount,
      internalEdges: m.internalEdges.length, externalDeps: m.externalDeps.length,
    })),
  };
}

/* ------------------------------ 内部件 ------------------------------ */

function statDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function gitHead(repoRoot) {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function readState(repoRoot) {
  try {
    const raw = readFileSync(join(repoRoot, CHORO_DIR, "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// 组装渲染视图：行数、入口、模块级上/下游、逐模块 unresolved 计数。
function assembleModuleView(mod, modules, graph, rootPath) {
  const fileSet = new Set(mod.files);
  const fileLines = mod.files.map((f) => [f, countLines(rootPath, f)]);
  const entries = mod.files.filter((f) => /^(index|main)\.(js|mjs|cjs|ts|tsx|jsx|vue)$/.test(posix.basename(f)));
  const slugByFile = new Map();
  for (const other of modules) {
    for (const f of other.files) slugByFile.set(f, other.slug);
  }
  const upstream = new Set();
  const downstream = new Set();
  // 跨模块方向查全图：本模块文件引用别的模块 → upstream（本模块的依赖）；
  // 别的模块引用本模块文件 → downstream（谁依赖它）。模块内部边不计方向。
  for (const e of graph.edges) {
    if (slugByFile.get(e.from) === mod.slug && slugByFile.get(e.to) !== mod.slug) upstream.add(slugByFile.get(e.to));
    if (slugByFile.get(e.from) !== mod.slug && slugByFile.get(e.to) === mod.slug) downstream.add(slugByFile.get(e.from));
  }
  const unresolvedCount = graph.unresolved.filter((u) => fileSet.has(u.from)).length;
  return {
    ...mod,
    fileLines,
    entries: entries.sort(),
    upstream: [...upstream].filter((s) => s && s !== mod.slug).sort(),
    downstream: [...downstream].filter((s) => s && s !== mod.slug).sort(),
    unresolvedCount,
  };
}

function parentChain(mod, modules) {
  const chain = [];
  let current = mod;
  const bySlug = new Map(modules.map((m) => [m.slug, m]));
  while (current?.parentSlug) {
    const parent = bySlug.get(current.parentSlug);
    if (!parent) break;
    chain.push(parent.slug);
    current = parent;
  }
  return chain.reverse();
}

// plan.pages 的 template / notes 的 M0 确定性处理：模板正文与作图笔记原文追加为
// 页尾小节（零模型语义下「每页模板」能做到的就是把人写的话原样放进页里）。模板名
// 查不到时页里放占位、warnings 里也记一条——两头都看得见，不静默吞。
function renderPlanExtras(custom, plan, warnings) {
  if (!custom) return null;
  const parts = [];
  if (custom.template) {
    const body = plan.templates?.[custom.template];
    if (typeof body === "string") {
      parts.push(`## 模板：${custom.template}`);
      parts.push("");
      parts.push(body.replace(/\n*$/, ""));
      parts.push("");
    } else {
      warnings.push(`plan.yaml pages["${custom.path}"] 引用的模板 "${custom.template}" 在 templates 里没有定义，页里先放了占位。`);
      parts.push(`## 模板：${custom.template}`);
      parts.push("");
      parts.push(`> plan.yaml 引用的模板 "${custom.template}" 在 templates 里没有定义；这段先占位，模板补上后重跑即得正文。`);
      parts.push("");
    }
  }
  if (custom.notes) {
    parts.push("## 作图笔记（plan.yaml notes）");
    parts.push("");
    parts.push(custom.notes.replace(/\n*$/, ""));
    parts.push("");
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

// 写盘前的保留区保留：已有页面文件里的 CHORO:HUMAN 块整体抽出，逐字节接回新正文
// 页尾（实现计划 P6）。文件不存在（首轮）就当无块，直接用新正文。
function preserveHumanBlocks(absPath, newContent) {
  let blocks = [];
  if (existsSync(absPath)) {
    try {
      blocks = extractHumanBlocks(readFileSync(absPath, "utf8")).blocks;
    } catch {
      blocks = [];
    }
  }
  const content = blocks.length > 0 ? injectHumanBlocks(newContent, blocks) : newContent;
  return { content, humanBlocks: blocks.length };
}

function existingHumanBlockCount(absPath) {
  if (!existsSync(absPath)) return 0;
  try {
    return extractHumanBlocks(readFileSync(absPath, "utf8")).count;
  } catch {
    return 0;
  }
}

// 重跑 T0 会丢掉的东西：页面里已有的 T1 语义段，以及只被它引用的 evidence 文件。
// 返回值里的 pages 是相对路径（receipt 里人读），orphanEvidence 是 .chorography/
// evidence/ 下现有的 .json 个数——T0 apply 会清空 choro_claims，这些文件从此没有
// 引用者。两者都是「会失去什么」的清点，不构成阻止：丢弃是设计意图，静默才是 bug。
function collectT1Loss(rootPath, pageTargets) {
  const pages = [];
  const unreadable = [];
  for (const target of pageTargets) {
    const abs = join(rootPath, target.relPath);
    if (!existsSync(abs)) continue;
    try {
      if (readFileSync(abs, "utf8").includes(T1_SECTION_START)) pages.push(target.relPath);
    } catch (err) {
      // **读不了不等于没有**：权限、占用、编码错误都会走到这里，而「有没有 T1 语义段」
      // 恰恰要靠读那一眼才知道。吞成「没有」的直接后果是 guard 放行，然后一整仓
      // replaceChoroGraph 把读不到的页连同它可能有的语义段一起退回骨架、清空 claims。
      // 清点本身不该让 T0 失败（下面 warnings 只如实记一笔），但**守卫**必须把它当成
      // 「有会丢的东西、但我数不清」而拒绝——见 guardT1Loss 分支。
      unreadable.push({ relPath: target.relPath, reason: String(err?.code ?? err?.message ?? err) });
    }
  }
  let orphanEvidence = 0;
  const evidenceDir = join(rootPath, CHORO_DIR, "evidence");
  try {
    orphanEvidence = readdirSync(evidenceDir).filter((name) => name.endsWith(".json")).length;
  } catch {
    orphanEvidence = 0;
  }
  return { pages, unreadable, orphanEvidence };
}

function countExistingHumanBlocks(rootPath, pageTargets) {
  let n = 0;
  for (const target of pageTargets) {
    n += existingHumanBlockCount(join(rootPath, target.relPath));
  }
  return n;
}

// 红线 1 的机械面：所有写路径必须落在 <root>/.chorography/ 内。slug 由 slugify
// 生成（[a-z0-9-]），这条断言是保险层不是唯一防线——划分器改动时先撞这里。
function assertInsideChoro(rootPath, relPath) {
  const abs = resolve(rootPath, relPath.split("/").join(sep));
  const choroRoot = resolve(rootPath, CHORO_DIR);
  if (!(abs === choroRoot || abs.startsWith(choroRoot + sep))) {
    throw new ChoroRefusal(
      "write-outside-chorography",
      `写路径越出 ${CHORO_DIR}/：${relPath}（红线 1：chorography 绝不写仓库里任何别的位置）`
    );
  }
  return abs;
}
