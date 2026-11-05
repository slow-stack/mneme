// dsh-mneme/src/wiki/plan.js
// chorography 的 plan.yaml 正面控制（spec §4 / 决策 D7）：白黑名单、每页模板、
// 作图笔记。这是用户手写的文件，机器只读不写。
//
// 为什么校验是「未知键整轮不跑」而不是「忽略并继续」（spec 降级表第一行）：拼错
// 一个键名（include 写成 includes）等于那条控制整段失效，而用户以为它在生效——
// 静默忽略的代价是生成结果和用户意图悄悄分叉，正是 D7 要防的事。整轮拒绝 + 报出
// 键名与允许列表，把拼错变成一次可修正的显式失败。
//
// 校验收全部 issue 后一次报出，不 fail-fast：人改配置通常一次错多处，逐个试错
// 只会多跑几轮生成。
//
// 依赖 `yaml`（实现计划 P1）：plan.yaml 是用户配置，手写子集解析器会在注释 /
// 锚点 / 多行字符串上静默错解，错解配置比拒绝配置更伤。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

export const PLAN_ALLOWED_KEYS = Object.freeze([
  "include", "exclude", "pages", "templates", "max_files_per_page",
]);
export const PLAN_PAGE_ALLOWED_KEYS = Object.freeze(["path", "title", "template", "notes"]);
export const DEFAULT_MAX_FILES_PER_PAGE = 40;

// plan.yaml 不存在时的启发式默认（spec §6 步 1）：全量 include、零 exclude 追加
// （目录级排除由 scan.js 的默认排除表承担：node_modules/构建产物 + 一切点开头目录，
// 见 DEFAULT_EXCLUDE_DIRS 上方注释——所以空 plan 也不是「什么都读」）、
// 无页面白名单（划分结果全建页）。
export function defaultPlan() {
  return {
    include: null,
    exclude: [],
    pages: null,
    templates: {},
    maxFilesPerPage: DEFAULT_MAX_FILES_PER_PAGE,
  };
}

/** plan.yaml 的内容指纹（无文件时对空串取 hash，保证「没带 plan」也是一个可记账状态）。 */
export function planFingerprint(rawText) {
  return createHash("sha256").update(rawText ?? "", "utf8").digest("hex");
}

/** 校验拒绝：issues 是人可读的中文清单，CLI 原样透出（spec 降级表：报出键名与允许列表）。 */
export class PlanInvalidError extends Error {
  constructor(issues, { planPath } = {}) {
    const lines = issues.map((it) => `  - ${it}`);
    super(
      `plan.yaml 校验不通过，本轮未运行${planPath ? `（${planPath}）` : ""}：\n${lines.join("\n")}\n` +
      `允许的顶层键：${PLAN_ALLOWED_KEYS.join(" / ")}`
    );
    this.name = "PlanInvalidError";
    this.issues = issues;
  }
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function expectType(value, want, label, issues) {
  const got = typeOf(value);
  if (got !== want) {
    issues.push(`${label} 需要 ${want === "array" ? "数组" : want === "string" ? "字符串" : want}，实际是 ${got}`);
    return false;
  }
  return true;
}

/**
 * 解析并校验 plan.yaml。rawText 为空（文件不存在）时返回默认启发式。
 * 任何校验失败抛 PlanInvalidError（收集全部 issue）。
 */
export function loadPlan(rawText, { planPath } = {}) {
  if (rawText == null || String(rawText).trim() === "") return { plan: defaultPlan(), fingerprint: planFingerprint("") };

  const doc = parseDocument(rawText);
  const issues = [];
  if (doc.errors.length > 0) {
    for (const err of doc.errors) issues.push(`YAML 语法错误：${String(err.message ?? err)}`);
    throw new PlanInvalidError(issues, { planPath });
  }
  const root = doc.toJS({ maxAliasCount: 200 });

  if (root === null || root === undefined) {
    throw new PlanInvalidError(["文件是空的：要么删掉 plan.yaml 走默认启发式，要么写一条配置"], { planPath });
  }
  if (typeof root !== "object" || Array.isArray(root)) {
    throw new PlanInvalidError([`顶层必须是键值映射（mapping），实际是 ${Array.isArray(root) ? "数组" : typeof root}`], { planPath });
  }

  const known = new Set(PLAN_ALLOWED_KEYS);
  for (const key of Object.keys(root)) {
    if (!known.has(key)) {
      const near = nearestKey(key);
      issues.push(
        `未知键 "${key}"（本轮拒绝运行：拼错的键等于失效的控制，不能静默忽略）` +
        (near ? `；如果你要写的是 "${near}"，请改正键名` : "")
      );
    }
  }

  const plan = defaultPlan();

  if (root.include !== undefined) {
    if (expectType(root.include, "array", "include", issues)) plan.include = root.include.map(String);
  }
  if (root.exclude !== undefined) {
    if (expectType(root.exclude, "array", "exclude", issues)) plan.exclude = root.exclude.map(String);
  }
  if (root.max_files_per_page !== undefined) {
    const v = root.max_files_per_page;
    if (!Number.isInteger(v) || v <= 0) {
      issues.push(`max_files_per_page 需要正整数，实际是 ${JSON.stringify(v)}`);
    } else {
      plan.maxFilesPerPage = v;
    }
  }
  if (root.templates !== undefined) {
    if (expectType(root.templates, "object", "templates", issues) && !Array.isArray(root.templates)) {
      for (const [name, body] of Object.entries(root.templates)) {
        if (typeof body !== "string") {
          issues.push(`templates.${name} 的值需要字符串（模板正文），实际是 ${typeOf(body)}`);
        } else {
          plan.templates[name] = body;
        }
      }
    } else if (Array.isArray(root.templates)) {
      issues.push("templates 需要键值映射（模板名 → 正文），实际是数组");
    }
  }
  if (root.pages !== undefined) {
    if (expectType(root.pages, "array", "pages", issues)) {
      const seen = new Set();
      plan.pages = [];
      root.pages.forEach((entry, i) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          issues.push(`pages[${i}] 需要键值映射（path/title/template/notes），实际是 ${typeOf(entry)}`);
          return;
        }
        for (const key of Object.keys(entry)) {
          if (!PLAN_PAGE_ALLOWED_KEYS.includes(key)) {
            issues.push(`pages[${i}] 有未知键 "${key}"；页级允许：${PLAN_PAGE_ALLOWED_KEYS.join(" / ")}`);
          }
        }
        const path = typeof entry.path === "string" ? entry.path.trim() : "";
        if (path === "") {
          issues.push(`pages[${i}] 缺 path（页面标识，对应模块 slug）`);
          return;
        }
        if (seen.has(path)) issues.push(`pages 里 path "${path}" 重复出现`);
        seen.add(path);
        if (entry.title !== undefined && typeof entry.title !== "string") {
          issues.push(`pages["${path}"].title 需要字符串，实际是 ${typeOf(entry.title)}`);
        }
        if (entry.template !== undefined && typeof entry.template !== "string") {
          issues.push(`pages["${path}"].template 需要字符串（模板名），实际是 ${typeOf(entry.template)}`);
        }
        if (entry.notes !== undefined && typeof entry.notes !== "string") {
          issues.push(`pages["${path}"].notes 需要字符串，实际是 ${typeOf(entry.notes)}`);
        }
        plan.pages.push({
          path,
          title: typeof entry.title === "string" ? entry.title : undefined,
          template: typeof entry.template === "string" ? entry.template : undefined,
          notes: typeof entry.notes === "string" ? entry.notes : undefined,
        });
      });
    }
  }

  if (issues.length > 0) throw new PlanInvalidError(issues, { planPath });
  return { plan, fingerprint: planFingerprint(rawText) };
}

/** 从磁盘读 plan.yaml。<repoRoot>/.chorography/plan.yaml 是唯一位置（spec §4）。 */
export function loadPlanFromRepo(repoRoot) {
  const planPath = join(repoRoot, ".chorography", "plan.yaml");
  if (!existsSync(planPath)) return { plan: defaultPlan(), fingerprint: planFingerprint(""), planPath: null, raw: "" };
  const raw = readFileSync(planPath, "utf8");
  return { ...loadPlan(raw, { planPath }), planPath, raw };
}

// 编辑距离只用来给「未知键」提示一个最近候选；实现取经典 DP，规模只有几个键，
// 不值得引库。距离不够近（超过键长一半或大于 2）就不猜，猜错提示比没有提示更吵。
function nearestKey(key) {
  let best = null;
  let bestDist = Infinity;
  for (const candidate of PLAN_ALLOWED_KEYS) {
    const dist = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return bestDist <= Math.max(2, Math.floor(key.length / 2)) ? best : null;
}

function editDistance(a, b) {
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let carry = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, carry + (a[i - 1] === b[j - 1] ? 0 : 1));
      carry = tmp;
    }
  }
  return prev[b.length];
}
