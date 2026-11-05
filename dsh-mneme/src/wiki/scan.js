// dsh-mneme/src/wiki/scan.js
// T0 的确定性输入面（spec §6 步 2–3）：文件清单 + JS/TS import 图。
// 全程零模型、零网络，输出排序稳定——同一仓库状态两次扫描给出逐项相同的结构。
//
// 范围口径（决策 D9）：v1 只做 JS/TS 生态（ESM 静态/动态、CJS require、Vue SFC 的
// <script>、package.json 的 workspaces 与 exports）。Java/Python 仓库退化为目录
// 启发式——这是 spec 拍板过的取舍（四语言全上等于四个生态各做 40%）。
//
// import 提取用正则不用 AST：T0 要的是「这个文件依赖谁」的图，不是逐语句语义；
// 正则在模板字符串/注释里偶有误报，代价是把一条边多画一次，而引入一个完整 parser
// 依赖（acorn 等）违背本包的依赖纪律。解析失败的单文件记 skipped 不中断（spec
// 降级表第三行）。
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { createHash } from "node:crypto";

// T0 关心的文件集：代码 + 能直接反映约定的配置/文档。清单列它们，图只由代码扩展名构成。
export const SCAN_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue",
  ".json", ".md", ".css", ".scss", ".less", ".html",
]);

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue"]);

// 默认排除（spec 步 2「跳过 node_modules、构建产物、二进制」）：plan.yaml 的
// exclude 是追加而不是替代——用户排除是表达意图，这份是卫生底线。
//
// 点开头目录整类排除（V2 实测回填，见 docs/plans/2026-11-04-chorography-m0.md）：
// 会话产物的落盘习惯就是把东西塞进 .qoder-credits / .superpowers / .shots / .zcode /
// .dsh-ops / .v2c 这类点目录，而里面常常是提问原文、调试快照与第三方工具缓存——
// baleen 上它们占 15 个模块里的 6 个，study-desk 上占 5 个里的 3 个。逐个点名厂商等于
// 把一台机器的工具链钉进发布包，换个工具又漏；「点开头即非仓库内容」这条更短的规则
// 与三处实测的分布一致，也不随工具换代失效。
// 代价如实写在这里：.vitepress/theme、.docusaurus 这类确实把真源码放在点目录里的仓库
// 会漏掉那部分，且**拉不回来**——扫描阶段的排除先于 plan.include 白名单生效。
// 只按目录名判，点开头的**文件**（.eslintrc.json 之类）照旧扫：那是仓库配置，不是产物。
export const DEFAULT_EXCLUDE_DIRS = Object.freeze([
  "node_modules", "dist", "build", "out", "coverage",
]);

function isDefaultExcludedDir(name) {
  return name.startsWith(".") || DEFAULT_EXCLUDE_DIRS.includes(name);
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".avif", ".bmp", ".pdf",
  ".zip", ".gz", ".tar", ".7z", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".mp3", ".webm", ".wav", ".ogg", ".mov", ".sqlite", ".db", ".wasm",
]);

// 噪声锁文件：体积大、内容是依赖锁，对「模块是什么」零贡献。
const NOISE_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

// Node 内置模块清单（够用的小集合；node: 前缀之外的老写法也拦住）。
const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "dns", "domain", "events", "fs", "http", "http2",
  "https", "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "sqlite", "stream", "string_decoder",
  "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

/* ------------------------------ 文件清单 ------------------------------ */

/**
 * 列出仓库内 T0 关心的文件。返回 POSIX 风格相对路径的排序数组。
 * exclude 走极小 gitignore 子集：# 注释、空行、尾 `/` 目录、前导 `/` 锚定、
 * `!` 反选、`*` / `**` / `?`。（spec §4：plan.exclude 是 gitignore 语法。）
 */
export function listFiles(repoRoot, { exclude = [] } = {}) {
  const matcher = compileExclude(exclude);
  const files = [];
  walk(repoRoot, "", matcher, files);
  return files.sort();
}

function walk(absRoot, relDir, matcher, out) {
  let entries;
  try {
    entries = readdirSync(join(absRoot, relDir), { withFileTypes: true });
  } catch {
    return; // 无权限/符号链接悬空：跳过整个目录，不中断
  }
  for (const entry of entries) {
    const rel = relDir ? posix.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (isDefaultExcludedDir(entry.name)) continue;
      if (matcher.excludedDir(rel)) continue;
      walk(absRoot, rel, matcher, out);
    } else if (entry.isFile()) {
      const ext = posix.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;
      if (NOISE_FILES.has(entry.name)) continue;
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      if (matcher.excludedFile(rel)) continue;
      out.push(rel);
    }
  }
}

/**
 * gitignore 子集编译成谓词。规则（与真 gitignore 的差异在此声明）：
 * - 只实现 目录匹配（尾 /）、锚定（前导 /）、反选（!）、*、**、?；
 * - 不含中段斜杠的模式按真 gitignore 语义匹配任意层级（"*​.md" 也命中子目录里的）；
 * - 中段 ** 跨段；不支持字符组与转义（模式原文进 receipt，用户能看见是哪条没生效）。
 */
export function compileExclude(patterns) {
  const rules = patterns
    .map((raw) => String(raw).trim())
    .filter((raw) => raw !== "" && !raw.startsWith("#"))
    .map((raw) => {
      const negate = raw.startsWith("!");
      const body = negate ? raw.slice(1) : raw;
      const anchored = body.startsWith("/");
      const dirOnly = body.endsWith("/");
      const clean = body.replace(/^\/+/, "").replace(/\/+$/, "");
      const re = globToRegExp(clean, { anchored });
      return { negate, dirOnly, re };
    });

  return {
    excludedDir(rel) {
      return matchRules(rules, rel, true) === true;
    },
    excludedFile(rel) {
      return matchRules(rules, rel, false) === true;
    },
  };
}

function matchRules(rules, rel, isDir) {
  // gitignore 语义：后一条规则赢；父目录被排除时文件也应排除（前缀目录逐级试）。
  const segments = rel.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join("/");
    const last = i === segments.length;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir && last) continue;
      if (rule.re.test(prefix)) return !rule.negate ? true : false;
    }
  }
  return false;
}

function globToRegExp(glob, { anchored }) {
  // 无中段斜杠的模式（含纯目录名）匹配任意层级：^ 前置 (?:[^/]+/)*，段边界靠
  // 尾部 (?:/.*)? 的斜杠要求与 [^/]+ 的段内限定撑住——「temp」不得命中
  // 「mytemp/x」这类子串（^ 是这条性质的前提）。
  const prefix = `^${!anchored && !glob.includes("/") ? "(?:[^/]+/)*" : ""}`;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** ：跨段（允许吃掉 / ）或尾段（等同 *）。
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:[^/]+/)*"; }
        else re += ".*";
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${prefix}${re}(?:/.*)?$`);
}

/**
 * 正向 include 匹配（plan.include 白名单，gitignore 语法的肯定面）：文件命中任意
 * 一条模式即收入。与 compileExclude 的区别：没有反选语义，模式即意图。
 */
export function compileInclude(patterns) {
  const rules = patterns
    .map((raw) => String(raw).trim())
    .filter((raw) => raw !== "" && !raw.startsWith("#"))
    .map((raw) => {
      const anchored = raw.startsWith("/");
      const dirOnly = raw.endsWith("/");
      const clean = raw.replace(/^\/+/, "").replace(/\/+$/, "");
      return { dirOnly, re: globToRegExp(clean, { anchored }) };
    });
  return {
    matchesFile(rel) {
      if (rules.length === 0) return true;
      const segments = rel.split("/");
      for (let i = 1; i <= segments.length; i++) {
        const prefix = segments.slice(0, i).join("/");
        for (const rule of rules) {
          if (rule.re.test(prefix)) return true;
        }
      }
      return false;
    },
  };
}

/* ------------------------------ import 图 ------------------------------ */

const IMPORT_PATTERNS = [
  // import x from 'a'；import type {x} from 'a'（静态带 from）
  /\bimport\s+(?:type\s+)?[^;'"()]*?\bfrom\s*["']([^"']+)["']/g,
  // import 'a'（副作用导入）
  /\bimport\s*["']([^"']+)["']/g,
  // import('a')（动态导入）
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  // export {x} from 'a'；export * from 'a'（再导出）
  /\bexport\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s*from\s*["']([^"']+)["']/g,
  // require('a')（CJS）
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/**
 * 解析文件清单里的 import 图。返回：
 *   edges      [{from, to}]  内部边（to 是清单内文件的 POSIX 相对路径）
 *   external   Map<pkg, Set<fromFile>>
 *   unresolved [{from, spec}] 相对/绝对路径但没解析到清单内文件
 *   skipped    [{file, reason}] 读取/解析失败（不中断，spec 降级表）
 */
export function parseImportGraph(repoRoot, files) {
  const fileSet = new Set(files);
  const codeFiles = files.filter((f) => CODE_EXTENSIONS.has(posix.extname(f).toLowerCase()));
  const edges = [];
  const external = new Map();
  const unresolved = [];
  const skipped = [];

  for (const rel of codeFiles) {
    let text;
    try {
      text = readFileSync(join(repoRoot, rel), "utf8");
    } catch (err) {
      skipped.push({ file: rel, reason: `读取失败：${String(err?.message ?? err)}` });
      continue;
    }
    // Vue SFC：只取 <script> 块；模板里的资源引用不是 import 图的一部分。
    const sources = posix.extname(rel).toLowerCase() === ".vue" ? extractVueScripts(text) : [text];
    const specs = new Set();
    for (const src of sources) {
      for (const re of IMPORT_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) specs.add(m[1]);
      }
    }
    for (const spec of specs) {
      const resolved = resolveSpecifier(spec, rel, fileSet);
      if (resolved === "external") {
        const pkg = packageNameOf(spec);
        if (!pkg) continue; // 空说明符等病态输入：忽略
        if (isNodeBuiltin(pkg)) continue;
        if (!external.has(pkg)) external.set(pkg, new Set());
        external.get(pkg).add(rel);
      } else if (resolved === "unresolved") {
        unresolved.push({ from: rel, spec });
      } else if (resolved !== null && resolved !== rel) {
        edges.push({ from: rel, to: resolved });
      }
    }
  }

  return { edges, external, unresolved, skipped };
}

function extractVueScripts(text) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function packageNameOf(spec) {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return spec;
  }
  return spec.split("/")[0];
}

function isNodeBuiltin(pkg) {
  if (pkg.startsWith("node:")) return true;
  return NODE_BUILTINS.has(pkg);
}

function resolveSpecifier(spec, fromFile, fileSet) {
  let base;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  } else if (spec.startsWith("/")) {
    base = spec.replace(/^\/+/, ""); // 仓库根绝对引用（少数配置型写法）
  } else {
    return "external"; // 裸说明符：npm 包或别名；别名 v1 不解析（实现计划记录）
  }
  base = base.split("\\").join("/");
  if (fileSet.has(base)) return base;
  for (const ext of [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".json"]) {
    if (fileSet.has(base + ext)) return base + ext;
  }
  for (const ext of [".js", ".ts", ".tsx", ".jsx", ".mjs", ".vue"]) {
    const idx = posix.join(base, "index" + ext);
    if (fileSet.has(idx)) return idx;
  }
  return "unresolved";
}

/** 整个仓库状态的指纹（文件清单 + 边集）：state.json 的 moduleFingerprint 用它。 */
export function repoFingerprint(files, edges) {
  const hash = createHash("sha256");
  for (const f of files) hash.update(`f:${f}\n`);
  for (const e of edges) hash.update(`e:${e.from}>${e.to}\n`);
  return hash.digest("hex");
}

/** 文件行数（骨架页「文件清单」表用）。读失败记 0，不中断。 */
export function countLines(repoRoot, rel) {
  try {
    const text = readFileSync(join(repoRoot, rel), "utf8");
    const n = text.split("\n").length;
    return text.endsWith("\n") ? n - 1 : n;
  } catch {
    return 0;
  }
}

/** 读 package.json（根部），取 scripts / workspaces / exports。没有或坏 JSON 返回 null（不中断）。 */
export function readRootPackage(repoRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    return {
      name: typeof pkg.name === "string" ? pkg.name : null,
      scripts: pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {},
      workspaces: Array.isArray(pkg.workspaces) ? pkg.workspaces.map(String) : [],
      entries: collectEntries(pkg),
    };
  } catch {
    return null;
  }
}

function collectEntries(pkg) {
  const out = [];
  if (typeof pkg.main === "string") out.push(pkg.main);
  if (typeof pkg.bin === "string") out.push(pkg.bin);
  if (pkg.bin && typeof pkg.bin === "object") out.push(...Object.values(pkg.bin).filter((v) => typeof v === "string"));
  if (pkg.exports && typeof pkg.exports === "object") {
    const walkExports = (node) => {
      if (typeof node === "string") out.push(node);
      else if (node && typeof node === "object") for (const v of Object.values(node)) walkExports(v);
    };
    for (const v of Object.values(pkg.exports)) walkExports(v);
  }
  return [...new Set(out.filter((v) => typeof v === "string" && !v.startsWith("#")))].map(
    (v) => v.replace(/^\.\//, "")
  );
}

// 把 workspace glob 展开成已知目录前缀：v1 只认「目录名 + 尾部星段」的写法
// （pnpm/npm 工作区最常见的那一种），其余模式忽略并跳过。返回排序数组。
export function workspacePrefixes(workspaces) {
  const prefixes = new Set();
  for (const pattern of workspaces) {
    if (typeof pattern !== "string") continue;
    if (pattern.endsWith("/*")) prefixes.add(pattern.slice(0, -2));
    else prefixes.add(pattern.replace(/\/+$/, ""));
  }
  return [...prefixes].sort();
}
