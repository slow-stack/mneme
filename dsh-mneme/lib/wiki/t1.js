// dsh-mneme/src/wiki/t1.js
// chorography T1 生成轮（spec §6 步 9–12 + 降级表；实现计划 P14–P22）：
// 逐模块一轮 headless 会话，产出四段语义正文 + 溯源 claims，写回骨架页。
//
// 与 T0 的分工：T0 是确定性骨架（零模型、必有产出），T1 是花钱的语义层（逐模块、
// 可跳过、可失败）。T1 **只手动触发**（CLI `--t1`），没有定时器、没有 hook——
// 降级表第一行「headless 根本起不来」在这里是环境级中止，不是页级失败。
//
// 成本纪律（spec 步 11 的三重上限，P15）：工具调用次数 / 输出字节 / 墙钟超时，
// 全部在 `--json` NDJSON 事件流上边读边计数——超限即刻 kill 子进程，不是事后
// 解析（事后解析意味着钱已经花完）。
//
// 输出契约（P16）：章程要求模型只输出一个 JSON 对象；解析失败、或 claims 的
// sourcePath 不在该模块文件清单里 → 该轮 failed（fail_count++，连续两次 →
// status=failed，骨架原样保留）。**编造的锚点比没有更伤**，所以正文与锚点要么
// 同过要么同拒。
//
// 边界（P22，如实声明）：headless 会话的工具集由宿主管，章程里「只读、不修改
// 文件」是软约束不是安全边界。T1 的硬保证只有三条：人发起（CLI 显式 --t1）、
// 本进程写路径断言在 .chorography/** 之内、越界动作 git diff 可见。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, sep, resolve } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { extractHumanBlocks, injectHumanBlocks, T1_SECTION_START, T1_SECTION_END } from "./render.js";
// issue #607：拒绝文案里的 CLI 命令要给绝对路径入口（profile 装的插件没有全局
// shim，光写 `dsh-mneme-choro` 用户照抄只会 command not found）。
import { choroCliCommandFrom } from "./cli-hint.js";

// 标记的单一来源在 render.js（页面格式的家）；这里转出去，调用方与测试继续从
// t1.js 取，不必知道它住在哪。
export { T1_SECTION_START, T1_SECTION_END };
export const T1_FAIL_THRESHOLD = 2;
export const DEFAULT_T1_MODEL = "xdpool/deepseek-v4.1-flash";

// #607：拒绝文案里的命令串推导一次（本文件在 src/wiki/ 与 lib/wiki/ 同一层）。
const T1_CLI = choroCliCommandFrom(import.meta.url, "<repo>");

// 三重上限缺省（实现计划 P15）：单模块预算——timeout 墙钟、工具调用次数、
// 累计输出字节。真实成本实测见 V1（10s/次任务），这里给的是上限不是预期。
export const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 240000,
  maxToolCalls: 40,
  maxOutputBytes: 512000,
});

export class T1Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "T1Refusal";
    this.code = code;
  }
}

/** 环境级失败 vs 模块级失败的判据（P18）：runner 用 kind 区分，编排层据此分叉。 */
export function isEnvironmentFailure(result) {
  return result?.kind === "environment";
}

/* --------------------------- 真实 headless runner --------------------------- */

// V1 实测配方（2026-11-05）：绕过 .cmd wrapper（Git Bash 下引号会碎）直接调 exe；
// 模型路由走 --patch 临时 overlay 指池模型（bili-scroll 同款，零配置改动）。
// exe 定位：env DSH_EXE > process.execPath（本身是 Harness exe，即已在宿主 CLI 内）>
// 标准安装位。定位不到 → environment 失败（降级表第一行），不猜测。
export function makeHeadlessRunner({ profile = "headless", onOverlay = null } = {}) {
  return async function runSession({ cwd, task, model, timeoutMs, maxToolCalls, maxOutputBytes }) {
    const exe = locateDshExe();
    if (!exe) {
      return {
        ok: false,
        kind: "environment",
        reason: "找不到 DeepSeek Harness 主程序（设 DSH_EXE 环境变量，或用 --dsh-exe 显式指定）",
      };
    }
    const cliJs = locateCliJs(exe);
    if (!cliJs) {
      return { ok: false, kind: "environment", reason: `在 ${dirname(exe)} 下找不到 dsh-desktop-host 的 cli.js` };
    }
    const [provider, modelName] = String(model).split("/");
    const overlayPath = writeModelOverlay(provider ?? "xdpool", modelName ?? "deepseek-v4.1-flash", onOverlay);
    let proc = null;
    try {
      const args = [
        "--expose-internals", cliJs,
        "--profile", profile,
        "--patch", overlayPath,
        "--json",
        "headless",
        task,
      ];
      proc = spawn(exe, args, {
        cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return await consumeHeadlessStream(proc, { timeoutMs, maxToolCalls, maxOutputBytes });
    } catch (err) {
      return { ok: false, kind: "environment", reason: String(err?.message ?? err) };
    } finally {
      if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill();
      try { rmSync(dirname(overlayPath), { recursive: true, force: true }); } catch { /* 临时目录 */ }
    }
  };
}

function locateDshExe() {
  if (process.env.DSH_EXE && existsSync(process.env.DSH_EXE)) return process.env.DSH_EXE;
  const exePath = process.execPath ?? "";
  if (basename(exePath).toLowerCase() === "deepseek harness.exe") return exePath;
  const standard = join(process.env["ProgramFiles"] ?? "C:\\Program Files", "DeepSeek Harness", "DeepSeek Harness.exe");
  return existsSync(standard) ? standard : null;
}

function locateCliJs(exe) {
  // cli.js 固定在 exe 相对路径的 app.asar 内部。**不能 existsSync 校验**：CLI 进程
  // 是普通 node，没有 asar 支持 stat 不进包内——而 exe 自己（V1 实测）加载这个
  // 路径没问题。位置是安装器定的，直接给出去。
  return join(dirname(exe), "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
}

// overlay 只含 provider/model 名（红线 4：不落 key）；一次性临时目录，finally 里删。
function writeModelOverlay(provider, model, onOverlay) {
  const dir = mkdtempSync(join(tmpdir(), "mneme-choro-t1-"));
  const p = join(dir, "model-overlay.yml");
  const body = [
    "- id: agent-default-model",
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    "  config:",
    `    provider: ${provider}`,
    `    model: ${model}`,
    "",
  ].join("\n");
  writeFileSync(p, body, "utf8");
  if (onOverlay) onOverlay(p);
  return p;
}

// NDJSON 事件流消费：三重上限在读取循环里计数，超限 kill。headless --json 的事件
// 形状以宿主实现为准——工具调用按「事件名含 tool_call/tool_use」的宽匹配计数，
// 计不出就退化为只用 timeout/bytes 两道上限（如实降级，不假装第三道存在）。
function consumeHeadlessStream(proc, { timeoutMs, maxToolCalls, maxOutputBytes }) {
  return new Promise((resolvePromise) => {
    let out = "";
    let bytes = 0;
    let toolCalls = 0;
    let scannedLines = 0; // 已计过数的完整行数——每块只扫新增部分，否则事件被平方级重复计数（实测 11s 撞 40 上限的假象就是这么来的）
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const finish = (result) => {
      clearTimeout(timer);
      resolvePromise(result);
    };
    proc.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        proc.kill();
        finish({ ok: false, kind: "module", reason: `输出超过 ${maxOutputBytes} 字节上限` });
        return;
      }
      out += chunk.toString("utf8");
      // headless --json 的真实事件形状（V1 实测）：{type:"tool_call"|"tool_result"|
      // "status"|"text"|"final"|"session", ...}。计数只认 tool_call——tool_result
      // 是同一对调用的另一半，一起数等于把上限折半。
      const lines = out.split("\n");
      const complete = lines.length - 1; // 末行可能是半截，留给下一块
      for (let i = scannedLines; i < complete; i++) {
        try {
          const event = JSON.parse(lines[i]);
          if (event?.type === "tool_call") {
            toolCalls++;
            if (toolCalls > maxToolCalls) {
              proc.kill();
              finish({ ok: false, kind: "module", reason: `工具调用超过 ${maxToolCalls} 次上限` });
              return;
            }
          }
        } catch { /* 非 JSON 行（最终答案等）直接进 out */ }
      }
      scannedLines = complete;
    });
    proc.stderr.on("data", () => { /* 诊断进 stderr，不影响结果 */ });
    proc.on("error", (err) => finish({ ok: false, kind: "environment", reason: `spawn 失败：${String(err?.message ?? err)}` }));
    proc.on("close", (code) => {
      if (timedOut) { finish({ ok: false, kind: "module", reason: `超过 ${timeoutMs}ms 墙钟上限` }); return; }
      // 最终答案：--json 流里最后一个非事件行；流解析失败就取 stdout 去掉事件行后的文本。
      const text = extractFinalText(out);
      if (code !== 0) {
        const envHint = /MISSING_CREDENTIAL|NO_ADAPTER|UNKNOWN_MODEL|EADDR|cannot find/i.test(out) ? "environment" : "module";
        finish({ ok: false, kind: envHint, reason: `headless 退出码 ${code}：${(text || "").slice(0, 200) || "(无输出)"}` });
        return;
      }
      if (!text.trim()) { finish({ ok: false, kind: "module", reason: "headless 没有产出可解析的最终回答" }); return; }
      finish({ ok: true, text });
    });
  });
}

function extractFinalText(ndjsonOut) {
  // 主路径：final 事件的 text（V1 实测 {type:"final", text:"…"}）。兜底：首个 text
  // 事件 → 非 JSON 行（流没按事件形状来时的最后防线）。
  let textEvent = "";
  const nonEvents = [];
  for (const line of ndjsonOut.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "final" && typeof event.text === "string") textEvent = event.text;
      else if (event?.type === "text" && typeof event.text === "string") textEvent = textEvent || event.text;
    } catch {
      nonEvents.push(line);
    }
  }
  if (textEvent.trim()) return textEvent.trim();
  return nonEvents.join("\n").trim();
}

/* ------------------------------- 编排层 ------------------------------- */

/**
 * @param {object} opts
 * @param {object} opts.store createStore 产物
 * @param {Function} [opts.runSession] 注入的会话执行器（P14）；缺省真实 headless runner
 * @param {object} [opts.limits] 三重上限
 * @param {() => string} [opts.now]
 */
export function createT1({ store, runSession = null, limits = DEFAULT_LIMITS, now = () => new Date().toISOString() }) {
  const runner = runSession ?? makeHeadlessRunner();

  /**
   * @param {object} args
   * @param {string} args.repoRoot 仓库路径（realpath 后必须与已登记仓库一致）
   * @param {string} [args.model] "provider/model"
   * @param {string} [args.moduleSlug] 只跑一个模块
   * @param {boolean} [args.retryFailed] 把 failed 页也拉进来重试（成功后 fail_count 清零）
   * @param {boolean} [args.dryRun] 只列将跑的模块与章程预览，零写入零会话
   * @param {string} [args.dshExe] 透传给真实 runner 的 exe 定位（CLI --dsh-exe）
   */
  async function runT1({ repoRoot, model = DEFAULT_T1_MODEL, moduleSlug = null, retryFailed = false, dryRun = false, dshExe = null, limits: limitsOverride = null }) {
    const cap = { ...limits, ...limitsOverride };
    const rootPath = realpathSync(resolve(repoRoot));
    const repo = store.db.prepare("SELECT * FROM choro_repos WHERE root_path = ?").get(rootPath);
    if (!repo) {
      throw new T1Refusal("not-registered", `${rootPath} 还没有登记：先跑一次 T0（${T1_CLI ?? "dsh-mneme-choro <repo> --apply"}）`);
    }

    // 选模块：skeleton 必跑；failed 只在 retryFailed 时；enriched 跳过（重富化留待显式 --module）。
    const pages = store.db.prepare(
      `SELECT p.id, p.status, p.fail_count, m.slug, m.title, m.file_count
         FROM choro_pages p JOIN choro_modules m ON p.module_id = m.id
        WHERE m.repo_id = ?
        ORDER BY m.slug`
    ).all(repo.id);
    const candidates = pages.filter((p) =>
      p.status === "skeleton"
      || (retryFailed && p.status === "failed")
      || (moduleSlug !== null && p.slug === moduleSlug)
    ).filter((p) => (moduleSlug !== null ? p.slug === moduleSlug : true));
    const skipped = pages
      .filter((p) => !candidates.some((c) => c.slug === p.slug))
      .map((p) => ({ slug: p.slug, reason: p.status === "enriched" ? "already-enriched" : p.status === "failed" ? "failed(用 --retry-failed 重试)" : `status=${p.status}` }));

    if (dryRun) {
      return {
        dryRun: true,
        repoName: repo.name,
        model,
        candidates: candidates.map((p) => ({ slug: p.slug, title: p.title, fileCount: p.file_count, status: p.status })),
        skipped,
        limits: cap,
      };
    }

    // 模块文件清单从 DB 指纹侧拿不到（M0 没存文件集），从骨架页正文解析——页面
    // 本来就是文件清单的真源渲染物，这样 T1 与面板看到的内容永远一致。
    const receipt = {
      dryRun: false,
      repoName: repo.name,
      model,
      enriched: [],
      failed: [],
      skipped,
      t1Unavailable: null,
    };
    const runnerWithExe = dshExe
      ? async (call) => {
          process.env.DSH_EXE = dshExe;
          return runner(call);
        }
      : runner;

    for (const candidate of candidates) {
      const slug = candidate.slug;
      const pageRow = store.choroPageBySlug(repo.id, slug);
      if (!pageRow) { receipt.failed.push({ slug, reason: "page-row-missing" }); continue; }

      const pageFile = join(rootPath, pageRow.rel_path);
      if (!existsSync(pageFile)) {
        receipt.failed.push({ slug, reason: "page-missing(先重跑 T0)" });
        continue;
      }
      const files = parseSkeletonFileList(readFileSync(pageFile, "utf8"));
      const task = buildCharter(repo.name, slug, candidate.title, files);
      const result = await runnerWithExe({
        cwd: rootPath, task, model,
        timeoutMs: cap.timeoutMs, maxToolCalls: cap.maxToolCalls, maxOutputBytes: cap.maxOutputBytes,
      });

      // 降级表第一行：环境级失败 → 整档中止，页状态不动，receipt 带原因。
      if (!result.ok && isEnvironmentFailure(result)) {
        receipt.t1Unavailable = result.reason;
        break;
      }
      if (!result.ok) {
        const after = store.recordChoroPageFailure(pageRow.id, T1_FAIL_THRESHOLD);
        receipt.failed.push({ slug, reason: result.reason, failCount: after.fail_count, marked: after.status === "failed" });
        continue;
      }

      // 输出契约（P16）：严格 JSON + claims 锚点对账。
      let parsed;
      try {
        parsed = parseT1Output(result.text);
      } catch (err) {
        const after = store.recordChoroPageFailure(pageRow.id, T1_FAIL_THRESHOLD);
        receipt.failed.push({ slug, reason: `输出契约不满足：${String(err?.message ?? err)}`, failCount: after.fail_count, marked: after.status === "failed" });
        continue;
      }
      const allowed = new Set(files);
      const badClaims = parsed.claims.filter((c) => !allowed.has(normPath(c.sourcePath)));
      if (badClaims.length > 0) {
        const after = store.recordChoroPageFailure(pageRow.id, T1_FAIL_THRESHOLD);
        receipt.failed.push({
          slug,
          reason: `claims 引用了模块外的文件：${badClaims.map((c) => c.sourcePath).slice(0, 3).join("、")}`,
          failCount: after.fail_count,
          marked: after.status === "failed",
        });
        continue;
      }

      // 富化 + 双落（P19/P20）。写路径断言复用 t0 的机械面语义：只许动
      // .chorography/** 下的页面与 evidence。
      const generatedAt = now();
      enrichPageFile(pageFile, parsed.sections);
      writeEvidenceFile(rootPath, slug, parsed.claims, generatedAt);
      store.saveChoroPageClaims(pageRow.id, parsed.claims.map((c) => ({ ...c, createdAt: generatedAt })));
      store.markChoroPageEnriched(pageRow.id, generatedAt);
      receipt.enriched.push({ slug, sections: Object.keys(parsed.sections), claims: parsed.claims.length });
    }
    return receipt;
  }

  return { runT1 };
}

/* ------------------------------- 内部件 ------------------------------- */

function normPath(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 从骨架页「文件清单」表解析文件清单（T1 章程与 claims 对账的基准）。 */
function parseSkeletonFileList(pageText) {
  const files = [];
  let inTable = false;
  for (const line of pageText.split("\n")) {
    if (/^## /.test(line)) inTable = line.startsWith("## 文件清单");
    else if (inTable && /^\|\s*([^|]+)\s*\|/.test(line) && !/^\|\s*文件/.test(line) && !/^\|\s*---/.test(line)) {
      files.push(RegExp.$1.trim());
    }
  }
  return files;
}

function buildCharter(repoName, slug, title, files) {
  return [
    `你在为仓库 ${repoName} 的仓库地志模块页「${title}」（slug=${slug}）补写语义段落。`,
    "规则：只读。不修改、不创建、不删除任何文件；不执行任何脚本。",
    `该模块包含这些文件（claims 只许引用它们）：`,
    ...files.map((f) => `- ${f}`),
    "读这些文件后，只输出一个 JSON 对象（不要 markdown 围栏、不要任何多余文字）：",
    '{"architecture":"该模块的职责与内部结构（<=200字）","convention":"它在仓库里遵守的约定（命名/错误处理/风格）","techStack":"该模块用到的关键库与技术点","setup":"构建/测试命令里与该模块相关的部分","claims":[{"statement":"一句话结论","kind":"architecture","sourcePath":"相对路径","startLine":1,"endLine":1}]}',
    'kind 只允许 architecture / convention / tech-stack / setup；sourcePath 必须用上面列出的相对路径（正斜杠）；行号必须真实。',
    'claims 绝不允许引用上面清单之外的任何文件路径——跨模块的结论写进段落文字里即可，不带锚点。清单里的路径一个字都不要改写（不要加 ../../、不要换斜杠）。',
    "页面骨架里已有的文件清单、入口、依赖信息不要复述。",
  ].join("\n");
}

// 输出契约解析（P16）：容忍模型偶尔把 JSON 包进围栏/前言——先剥围栏，再取首个
// `{` 到末个 `}` 之间的内容；之后 schema 校验（四段全字符串、claims 形状与 kind 枚举）。
function parseT1Output(text) {
  let t = String(text ?? "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("没有找到 JSON 对象");
  let obj;
  try {
    obj = JSON.parse(t.slice(start, end + 1));
  } catch (err) {
    throw new Error(`JSON 解析失败：${String(err?.message ?? err).slice(0, 120)}`);
  }
  const sections = {};
  for (const key of ["architecture", "convention", "techStack", "setup"]) {
    const v = obj[key];
    if (typeof v !== "string" || v.trim() === "") throw new Error(`缺段落 ${key} 或不是字符串`);
    sections[key] = v.trim();
  }
  if (!Array.isArray(obj.claims)) throw new Error("缺 claims 数组");
  const kinds = new Set(["architecture", "convention", "tech-stack", "setup"]);
  const claims = obj.claims.map((c, i) => {
    if (typeof c?.statement !== "string" || !c.statement.trim()) throw new Error(`claims[${i}] 缺 statement`);
    if (!kinds.has(c?.kind)) throw new Error(`claims[${i}] kind 非法：${String(c?.kind)}`);
    if (typeof c?.sourcePath !== "string" || !c.sourcePath.trim()) throw new Error(`claims[${i}] 缺 sourcePath`);
    return {
      statement: c.statement.trim(),
      kind: c.kind,
      sourcePath: normPath(c.sourcePath),
      startLine: Number.isInteger(c.startLine) ? c.startLine : null,
      endLine: Number.isInteger(c.endLine) ? c.endLine : null,
      confidence: typeof c.confidence === "string" ? c.confidence : null,
    };
  });
  return { sections, claims };
}

// 富化（P19）：剥掉旧 T1 段 → 新段插在「## 生成说明」之前 → 保留区照旧页尾回填。
function enrichPageFile(pageFile, sections) {
  let content = readFileSync(pageFile, "utf8");
  // 剥旧 T1 段（含标记本身）
  const wrap = new RegExp(`${escapeRe(T1_SECTION_START)}[\\s\\S]*?${escapeRe(T1_SECTION_END)}\\n?`, "g");
  content = content.replace(wrap, "");
  const block = [
    "",
    T1_SECTION_START,
    "## 架构",
    "",
    sections.architecture,
    "",
    "## 约定",
    "",
    sections.convention,
    "",
    "## 技术栈",
    "",
    sections.techStack,
    "",
    "## 构建与测试",
    "",
    sections.setup,
    "",
    T1_SECTION_END,
    "",
  ].join("\n");
  const anchor = content.indexOf("## 生成说明");
  const base = anchor === -1
    ? `${content.replace(/\n*$/, "\n")}\n${block}`
    : content.slice(0, anchor) + block.replace(/^\n/, "") + content.slice(anchor);
  const { blocks } = extractHumanBlocks(base);
  const finalContent = blocks.length > 0 ? injectHumanBlocks(stripHumanBlocks(base), blocks) : base;
  writeFileSync(pageFile, finalContent, "utf8");
}

// injectHumanBlocks 会把块接回页尾——剥掉正文里已有的块再交给它，保证块只在页尾出现一次。
function stripHumanBlocks(text) {
  const re = new RegExp(`${escapeRe("<!-- CHORO:HUMAN:START -->")}[\\s\\S]*?${escapeRe("<!-- CHORO:HUMAN:END -->")}\\n?`, "g");
  return text.replace(re, "");
}

function writeEvidenceFile(repoRoot, slug, claims, generatedAt) {
  const rel = `${".chorography"}/evidence/${slug}.json`;
  const abs = insideChoro(repoRoot, rel);
  mkdirp(dirname(abs));
  writeFileSync(abs, `${JSON.stringify({ slug, generatedAt, claims }, null, 2)}\n`, "utf8");
}

function insideChoro(rootPath, relPath) {
  const abs = resolve(rootPath, relPath.split("/").join(sep));
  const choroRoot = resolve(rootPath, ".chorography");
  if (!(abs === choroRoot || abs.startsWith(choroRoot + sep))) {
    throw new T1Refusal("write-outside-chorography", `写路径越出 .chorography/：${relPath}（红线 1）`);
  }
  return abs;
}

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
}

function basename(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
