// dsh-mneme/src/wiki/render.js
// T0 骨架页与 index.md 的确定性渲染（spec §6 步 6），以及混合所有权的保留区机制
// （spec §4：`<!-- CHORO:HUMAN -->` 标记块重生成时逐字节保留）。
//
// 确定性纪律（spec §9 可重建不变量）：正文零时间戳、零随机——所有列表先排序再拼；
// 页面唯一的时刻 frontmatter.generatedAt 由 t0.js 从 state.json 沿用（实现计划
// P3：时刻收进 state.json，失败不推进，页面字节才可能跨 run 稳定）。
//
// 保留区规则（写死、可测）：
//   1. 抽取：START…END 之间连同两行标记整体抽出，一个字节不动；
//   2. 回填：新正文之后按原相对顺序接回全部块；
//   3. 重生成永不删块、永不改写块内内容（包括缩进与格式）——红线 6；
//   4. 没有块时整页覆盖（spec：人在块外的手改不保证存活，是明说语义不是事故）。

export const TEMPLATE_VERSION = "1";

export const HUMAN_START = "<!-- CHORO:HUMAN:START -->";
export const HUMAN_END = "<!-- CHORO:HUMAN:END -->";

// T1 语义段的包装标记。写的人是 t1.js，读的人还有 t0.js——重跑 T0 时它要能认出
// 「这页已经被富化过」，否则 enriched → skeleton 的退回是静默的。标记随页面格式
// 走，所以与 HUMAN 标记同住这里，t1.js 转出给调用方。
export const T1_SECTION_START = "<!-- CHORO:T1:START -->";
export const T1_SECTION_END = "<!-- CHORO:T1:END -->";

/** 抽出全部保留区。返回 { blocks: string[]（含标记本身，原样）, count }。 */
export function extractHumanBlocks(pageText) {
  if (typeof pageText !== "string") return { blocks: [], count: 0 };
  const blocks = [];
  const re = new RegExp(`${escapeRegExp(HUMAN_START)}[\\s\\S]*?${escapeRegExp(HUMAN_END)}`, "g");
  let m;
  while ((m = re.exec(pageText)) !== null) blocks.push(m[0]);
  return { blocks, count: blocks.length };
}

/** 新正文 + 保留区（按原顺序接在页尾，各隔一个空行）。 */
export function injectHumanBlocks(newContent, blocks) {
  if (!blocks || blocks.length === 0) return newContent;
  return `${newContent.replace(/\n*$/, "\n")}\n${blocks.join("\n\n")}\n`;
}

/**
 * 渲染一页骨架。meta: { slug, title, parents[], sourceFiles[], gitBaseline,
 * generatedAt, status }；mod 是 partition 的产物。
 */
export function renderSkeletonPage(mod, meta) {
  const lines = [];
  lines.push("---");
  lines.push("choro: v1");
  lines.push(`slug: ${meta.slug}`);
  lines.push(`title: ${yamlScalar(meta.title)}`);
  if (meta.parents && meta.parents.length > 0) {
    lines.push("parents:");
    for (const p of meta.parents) lines.push(`  - ${p}`);
  } else {
    lines.push("parents: []");
  }
  lines.push("sourceFiles:");
  for (const f of meta.sourceFiles) lines.push(`  - ${f}`);
  lines.push(`gitBaseline: ${meta.gitBaseline}`);
  lines.push(`templateVersion: ${TEMPLATE_VERSION}`);
  lines.push(`language: ${meta.language ?? "zh"}`);
  lines.push(`status: ${meta.status}`);
  lines.push(`generatedAt: ${meta.generatedAt}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${meta.title}`);
  lines.push("");
  // 注意：这行说明里**不得出现成对的标记字面量**——抽取用的是全局正则，说明行
  // 里一旦同时含 START 与 END，下一轮重生成就会把它当成一块保留区接在页尾
  // （实测：第二轮页面凭空多两行）。所以说标记时用名字，不用原文。
  lines.push(
    `> 确定性骨架（T0，零模型）：由文件树与 import 图生成。` +
    `CHORO:HUMAN 标记对（START/END 两个 HTML 注释）包住的内容在重生成时逐字节保留；` +
    `标记对之外的手改不保留（想保住一段就把它挪进标记对里）。`
  );
  lines.push("");
  lines.push(`## 文件清单（${mod.fileCount} 个）`);
  lines.push("");
  lines.push("| 文件 | 行数 |");
  lines.push("| --- | ---: |");
  for (const [file, lines2] of mod.fileLines) lines.push(`| ${file} | ${lines2} |`);
  lines.push("");
  lines.push("## 入口");
  lines.push("");
  if (mod.entries.length > 0) {
    for (const e of mod.entries) lines.push(`- \`${e}\``);
  } else {
    lines.push("- 无（没有 index/main 命名的文件，也不是包入口）");
  }
  lines.push("");
  lines.push("## 内部依赖");
  lines.push("");
  if (mod.upstream.length > 0) {
    lines.push(`- 上游依赖（本模块引用的模块）：${mod.upstream.map((s) => `\`${s}\``).join("、")}`);
  }
  if (mod.downstream.length > 0) {
    lines.push(`- 下游（引用本模块的模块）：${mod.downstream.map((s) => `\`${s}\``).join("、")}`);
  }
  if (mod.upstream.length === 0 && mod.downstream.length === 0) {
    lines.push("- 无内部依赖边（孤立模块）");
  }
  lines.push("");
  lines.push("## 外部依赖");
  lines.push("");
  if (mod.externalDeps.length > 0) {
    for (const d of mod.externalDeps) lines.push(`- \`${d.pkg}\` ×${d.count}`);
  } else {
    lines.push("- 无外部 npm 依赖");
  }
  lines.push("");
  lines.push("## 生成说明");
  lines.push("");
  lines.push(
    `- 模块划分：目录初稿 + 兄弟组内聚合并（内部边 ≥3），超上限逐级下切；` +
    `本组 ${mod.fileCount} 个文件。`
  );
  if (mod.unresolvedCount > 0) {
    lines.push(`- ${mod.unresolvedCount} 条相对引用没有解析到仓库内文件（别名/动态路径），未计入依赖图。`);
  }
  lines.push("");
  return lines.join("\n");
}

/** index.md：模块目录 + 仓库级信息。同样零时间戳（时刻在 state.json）。 */
export function renderIndex(modules, repoMeta) {
  const lines = [];
  lines.push("---");
  lines.push("choro: v1");
  lines.push(`repo: ${yamlScalar(repoMeta.name)}`);
  lines.push(`gitBaseline: ${repoMeta.gitBaseline}`);
  lines.push(`templateVersion: ${TEMPLATE_VERSION}`);
  lines.push(`generatedAt: ${repoMeta.generatedAt}`);
  lines.push("language: zh");
  lines.push("---");
  lines.push("");
  lines.push(`# ${repoMeta.name} · 仓库地志`);
  lines.push("");
  lines.push(
    `T0 确定性骨架（零模型）。页面在 \`modules/\` 下，真源是本目录的 Markdown；` +
    `本文件整页机器所有、可随时重算（spec §4）。`
  );
  lines.push("");
  lines.push(`- 扫描 ${repoMeta.fileCount} 个文件，划出 ${modules.length} 个模块。`);
  if (repoMeta.skipped > 0) lines.push(`- ${repoMeta.skipped} 个文件读取失败，已跳过（页脚与 receipt 都有记）。`);
  if (repoMeta.unresolved > 0) lines.push(`- ${repoMeta.unresolved} 条相对引用未解析（别名/动态路径），未计入依赖图。`);
  lines.push("");
  lines.push("## 模块目录");
  lines.push("");
  lines.push("| 模块 | 页面 | 文件数 | 内部边 | 外部依赖 |");
  lines.push("| --- | --- | ---: | ---: | ---: |");
  for (const mod of modules) {
    const pageRel = `modules/${mod.slug}.md`;
    lines.push(
      `| ${mod.title} | [${mod.slug}](${pageRel}) | ${mod.fileCount} | ` +
      `${mod.internalEdges.length} | ${mod.externalDeps.length} |`
    );
  }
  lines.push("");
  lines.push("## 脚本命令（根 package.json）");
  lines.push("");
  const scriptNames = Object.keys(repoMeta.scripts ?? {}).sort();
  if (scriptNames.length > 0) {
    lines.push("| 命令 | 内容 |");
    lines.push("| --- | --- |");
    for (const name of scriptNames) lines.push(`| \`${name}\` | ${escapeCell(String(repoMeta.scripts[name]))} |`);
  } else {
    lines.push("- 无 scripts 字段或没有根 package.json。");
  }
  lines.push("");
  return lines.join("\n");
}

// YAML 标量：含冒号/引号等特殊字符时加引号（frontmatter 里的 title/repo 是人名或
// 目录名，通常无害，但这层便宜且省掉转义 bug）。
function yamlScalar(text) {
  const s = String(text ?? "");
  return /[:#'\"[\]{},&*?|>%@`]/.test(s) || s.trim() !== s ? JSON.stringify(s) : s;
}

function escapeCell(text) {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
