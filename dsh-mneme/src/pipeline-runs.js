/**
 * M.O.（Modus Operandi · 手法）工作流的**运行账**。
 *
 * 读侧（`src/pipeline.js`）已经能把「一条工作流跑了怎么样」算成四态，但账本一直没人写，
 * 于是 `runs` 恒为空数组、节点状态恒为 `candidate`。本模块补的就是这一环：把一次 run
 * 落到盘上、再读回来成读侧认得的那份形状。
 *
 * **落点为什么跟手写的 `.json` 分开**：`<项目>/.mneme/pipelines/<id>.json` 是人手写、
 * 要 review、要提交的；账本是每跑一次就追加一行的流水。挤进同一个文件，一次 run 就会
 * 把人的 diff 冲掉，而人改过的内容与机器追加的内容此后再也分不开。
 *
 * **为什么是 JSONL 不是一个大 JSON 数组**：追加一条要重写整个数组，而这个文件会被
 * 「刚刚跑完一次」这种**不能失败**的动作写。一行一条时，写到一半断电只毁最后一行；
 * 整份重写时，同样的故障会毁掉全部历史。
 *
 * 形状以读侧的 `tallyRuns` 为准（那里是权威）：只有 `skipped` 与 `detoured` 都为假才算
 * 一次 `uses`，两者各自独立累加，`refuted` 只当布尔用，`step.at` 取最大值当 `lastUsedAt`。
 *
 * **读盘与写盘刻意不共用一条校验路径**（两者要的东西不一样）：
 *   - 写盘是**我们自己在说话**，缺的字段意思明确（没写就是没有），补默认值是替它把话说完；
 *   - 读盘是**听别人说话**，缺一个布尔就等于「这一步照图走了」这条正面证据是凭空来的
 *     ——读侧宁可不认这条记录（报噪 + 跳过），也不能替它补一个含义。
 * 早期版本两处共用一个函数，于是一行只有 `{id, at}` 的记录被算成一次成功使用、把节点
 * 染成 `trusted`：账本没说话，面板却在作证。这类错比读不出来严重得多。
 *
 * **一批读不出来 ≠ 整份账本报废**：读盘逐行收，坏行进 `problems`、好行照收。一份账本
 * 因为一行被截断就永久读不出来，等于让一次断电抹掉全部历史，而写侧还会继续报成功。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ACTORS } from "./pipeline.js";

/** 账本的后缀：与手写工作流的 `.json` 分开，正是为了避免同 id 撞名。 */
export const RUNS_SUFFIX = ".runs.jsonl";

/**
 * 账本的五种状态。存在的理由是**「读不出来」与「还没跑过」在节点状态上完全同形**
 * （都是全体 `candidate`）：不把它们分开，面板就会把一次「历史读不出来了」画成
 * 「这条工作流还没被验证过」——这是两种完全不同的说法，而后者让人安心。
 *
 *   absent   盘上没有这个账本文件
 *   empty    文件在、一条 run 都没有（有人碰过它，但还没写进一次运行）
 *   ok       读得干净，至少一条 run
 *   partial  收到一部分，另有一些行读不出来（行号在 problems 里）
 *   broken   文件在，但一条可用的 run 都收不到（含整份读不进来）
 */
export const RUNS_STATES = ["absent", "empty", "ok", "partial", "broken"];

/** 校验失败的统一出口。名字与 `PipelineError` 成对：一个是工作流写坏了，一个是账本写坏了。 */
export class RunError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunError";
  }
}

const bad = (msg) => {
  throw new RunError(msg);
};

/** 报错时回显原始行/值的上限：账本行可能很长，别把整份文件塞进一条错误。 */
const MAX_ECHO = 120;

const echo = (value) => JSON.stringify(value).slice(0, MAX_ECHO);

/**
 * id 只当**一个文件名片段**用，绝不当路径用。
 *
 * 拒掉而不是清洗：清洗会把 `../../x` 悄悄变成 `x`，于是写到了调用方没指定的文件上
 * ——那类错在界面上看不出来，是最难查的一种。`..` 单独一个也要拒：它合法地通过
 * 「无分隔符」检查，却仍然指向上级目录。
 */
function isSafeSegment(id) {
  if (typeof id !== "string") return false;
  const value = id.trim();
  if (value === "" || value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (isAbsolute(value)) return false;
  return true;
}

/**
 * 账本的家：`<项目>/.mneme/pipelines/`。目录名与读侧同一处来源（同一段路径拼接），
 * 免得两边各写一份常量、改一处漏一处。
 */
export function runsDir(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    bad("projectRoot 必须是项目根的路径");
  }
  return join(projectRoot, ".mneme", "pipelines");
}

/** 一个 id 的账本文件：`<项目>/.mneme/pipelines/<id>.runs.jsonl`。 */
export function runsPath(projectRoot, id) {
  const dir = runsDir(projectRoot);
  if (!isSafeSegment(id)) bad(`id 不是合法的文件名片段：${echo(id)}`);
  const full = resolve(dir, id.trim() + RUNS_SUFFIX);
  // 双保险：片段检查已经挡掉了穿越，这里再确认落点确实在账本目录里
  // ——将来有人放宽上面的检查时，这一层会先变红。
  if (!full.startsWith(resolve(dir))) bad(`id 会写到账本目录之外：${echo(id)}`);
  return full;
}

/**
 * 时间戳收成规范的 ISO 毫秒 UTC 串。
 *
 * 收成**唯一一种**形状是刻意的：`step.at` 会被读侧按字符串比较取最大值当 `lastUsedAt`，
 * 同一条账里混着 `2026-10-15T09:00:01Z` 与 `2026-10-15T09:00:01.500Z` 时，比较结果
 * 与人对时间先后的直觉不一致。写进来/读回来的那一刻就把它们拉齐。
 */
function normalizeAt(value, where) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) bad(`${where} 是一个无效的 Date`);
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") bad(`${where} 不能是空字符串`);
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) bad(`${where} 不是能解析的时间：${echo(value)}`);
    return new Date(ms).toISOString();
  }
  bad(`${where} 必须是 ISO 时间串、Date 或毫秒数，收到 ${value === null ? "null" : typeof value}`);
}

function requireRecord(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad(`${where} 必须是一个对象`);
  return value;
}

/**
 * 写盘的布尔：缺了补 `false`。调用方是「我们自己」，没写就是不打算标注。
 */
function writeBool(value, where) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") bad(`${where} 必须是布尔`);
  return value;
}

/**
 * 读盘的布尔：**缺了就是错**，绝不补默认。
 *
 * 补 `false` 的后果不是「少一个标注」而是「多一条证据」：`tallyRuns` 只有看到两个布尔
 * 都为假才算一次 `uses`，于是缺字段的行会被读成「照图走了」，节点由 `candidate` 变
 * `trusted`。账本没说话，面板却在作证——这是读侧能犯的最重的一类错。
 */
function readBool(step, key, where) {
  if (typeof step[key] !== "boolean") {
    bad(`${where}.${key} 缺失或不是布尔——账本必须自己说清这一步的结局，读侧不替它补`);
  }
  return step[key];
}

/**
 * `kind` 是绕行的**旧写法别名**（读侧 `tallyRuns` 至今认 `step.kind === "detour"`）。
 *
 * 别名只有被认下来才有意义：归一化只留契约那六个键，一个不认识的 `kind` 被默默丢掉时，
 * 丢掉的是**这一步的结局本身**——一次绕行会在「写→读」往返后变成一次成功使用。
 * 所以这里不但要认 `"detour"`，还要把不认识的取值当场拒掉，而不是放它过去。
 */
function isDetourAlias(step, where) {
  if (step.kind === undefined || step.kind === null) return false;
  if (step.kind === "detour") return true;
  bad(`${where}.kind 只认 "detour"（其余取值读侧会忽略，等于丢掉这一步的结局），收到 ${echo(step.kind)}`);
}

/**
 * 把一条 run 收成契约形状（**写盘路径**）：缺的补默认、多余的丢掉、坏的直接抛。
 *
 * 「坏的直接抛」与读侧 `loadPipelines` 同一纪律：**静默跳过最难查**——账本里少一条，
 * 面板上看起来只是「这条工作流好像没跑过」，而真相是有一次运行丢了。
 *
 * `expectedStepIds` 给的是「图上有哪些步骤」。给了却不查，写错的 step id 会落盘、能被
 * 读出来，却没有任何节点拿到它——症状与「从没跑过」同形，比丢掉更隐蔽。
 */
export function normalizeRun(raw, { expectedStepIds = null } = {}) {
  const run = requireRecord(raw, "run");
  const at = normalizeAt(raw.at, "run.at");

  const by = typeof raw.by === "string" ? raw.by.trim() : raw.by;
  if (!ACTORS.includes(by)) bad(`run.by 必须是 ${ACTORS.join(" / ")} 之一，收到 ${echo(raw.by)}`);

  const triggeredBy = raw.triggeredBy === undefined || raw.triggeredBy === null ? "" : raw.triggeredBy;
  if (typeof triggeredBy !== "string") {
    bad(`run.triggeredBy 必须是字符串（trigger.value 或空串），收到 ${typeof raw.triggeredBy}`);
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    bad("run.steps 至少要有一条——一次什么步骤都没走过的 run 不提供任何账");
  }
  const steps = normalizeSteps(raw.steps, { expectedStepIds, writing: true });
  return { at, by, triggeredBy, steps };
}

/**
 * 绕行有两个来源：`detoured:true` 与旧写法 `kind:"detour"`（读侧至今认它）。
 * 两者是**或**的关系，所以「只给了 kind」不算缺字段；但一个都不给、给错类型、
 * 或者给了一个读侧不认识的 kind，都必须当场报出来——那丢的是这一步的结局本身。
 */
function detouredOf(step, where, writing) {
  const alias = isDetourAlias(step, where);
  if (writing) return writeBool(step.detoured, `${where}.detoured`) || alias;
  if (typeof step.detoured === "boolean") return step.detoured || alias;
  if (alias) return true;
  bad(`${where}.detoured 缺失或不是布尔——账本必须自己说清这一步的结局，读侧不替它补`);
}

/**
 * 步骤表的**共同骨架**：写盘（补默认）与读盘（缺就报错）只差「布尔缺了怎么办」，
 * 其余校验两边必须一致——不一致的地方就是语义分叉的地方。
 */
function normalizeSteps(rawSteps, { expectedStepIds = null, writing = false } = {}) {
  const expected = expectedStepIds ? new Set(expectedStepIds) : null;
  const seen = new Set();
  return rawSteps.map((rawStep, i) => {
    const where = `run.steps[${i}]`;
    const step = requireRecord(rawStep, `${where} 必须是一个对象`);
    const id = typeof step.id === "string" ? step.id.trim() : step.id;
    if (!isSafeSegment(id)) bad(`${where}.id 不是合法的步骤 id：${echo(step.id)}`);
    // 同一条 run 里重复的 step id 会被 `tallyRuns` 数两次，使用次数于是虚高。
    if (seen.has(id)) bad(`${where}.id "${id}" 在同一条 run 里出现了两次`);
    seen.add(id);
    // 图里没有的步骤 id：账落在一个没有节点的地方——数得出来，面板上永远看不见。
    if (expected && !expected.has(id)) {
      bad(`${where}.id "${id}" 不在工作流的步骤表里（${[...expected].join(" / ")}）`);
    }
    const boolAt = (key) => (writing ? writeBool(step[key], `${where}.${key}`) : readBool(step, key, where));
    const note = step.note === undefined || step.note === null ? "" : step.note;
    if (typeof note !== "string") bad(`${where}.note 必须是字符串`);
    if (writing && step.at === undefined) bad(`${where}.at 缺失——时间不做「补默认」：一次 run 什么时候跑的只有调用方知道`);
    return {
      id,
      at: normalizeAt(step.at, `${where}.at`),
      skipped: boolAt("skipped"),
      detoured: detouredOf(step, where, writing),
      refuted: boolAt("refuted"),
      note
    };
  });
}

/**
 * 读盘路径的校验：**一条记录的形状**。缺布尔、缺 step、id 越界、kind 不认识，都抛
 * （由 `readRuns` 收成 problems 里的行号 + 原因）。
 *
 * `by` 只在**给了**的时候校验：它是描述字段，读侧投影不消费它；而 `at` 与三个布尔是
 * 被消费的、会让计数变样的字段，必须齐。
 */
function readStoredRun(raw, { expectedStepIds = null } = {}) {
  const run = requireRecord(raw, "顶层必须是一个对象");
  if (run.at === undefined) bad("run.at 缺失");
  const at = normalizeAt(run.at, "run.at");
  if (run.by !== undefined) {
    const by = typeof run.by === "string" ? run.by.trim() : run.by;
    if (!ACTORS.includes(by)) bad(`run.by 必须是 ${ACTORS.join(" / ")} 之一，收到 ${echo(run.by)}`);
  }
  const triggeredBy = run.triggeredBy === undefined || run.triggeredBy === null ? "" : run.triggeredBy;
  if (typeof triggeredBy !== "string") bad("run.triggeredBy 必须是字符串");
  if (!Array.isArray(run.steps) || run.steps.length === 0) bad("run.steps 至少要有一条");
  return {
    at,
    by: run.by === undefined || run.by === null ? "" : String(run.by).trim(),
    triggeredBy,
    steps: normalizeSteps(run.steps, { expectedStepIds, writing: false })
  };
}

/** 一行的问题：行号（文件级问题为 null）、是否只是一截尾巴、给人看的原因。 */
function problem(line, detail, truncated) {
  return { line, truncated: truncated === true, detail };
}

function stateOf(runs, problems) {
  if (problems.length === 0) return runs.length ? "ok" : "empty";
  return runs.length ? "partial" : "broken";
}

/**
 * 读一个项目的账本，**逐行收**：好行照收，坏行进 `problems`，并给出一个 `state`。
 *
 * 为什么坏行不再「一条就抛」：一条被截断的尾行（写到一半断电、编辑器只保存了一半）
 * 会让整份账本永久读不出来，而写侧还在继续报成功——一次断电就抹掉全部历史。
 * 那条尾行是**可判定**的（最后一行 + 文件不以换行结尾），所以报噪、跳过、其余照收；
 * 中间的坏行同样报噪跳过，不再判死整份文件。**报噪 ≠ 静默**：行号与原因都在 `problems` 里，
 * 端点把它带成 `runsErrors`，状态降成 partial/broken。
 *
 * 目录不存在、文件不存在、文件是空的 → 空数组 + `absent`/`empty`：一条工作流还没跑过
 * 是正常状态，面板据此画空态而不是画成「读不出来」。
 */
export function readRuns(projectRoot, id, { expectedStepIds = null } = {}) {
  const file = runsPath(projectRoot, id);
  if (!existsSync(file)) return { runs: [], problems: [], state: "absent" };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // 文件在、读不出来：这是「坏了」，不是「还没跑过」——两者在面板上必须分得开。
    return { runs: [], problems: [problem(null, `读不出来：${error.message}`, false)], state: "broken" };
  }
  // UTF-8 BOM 不是数据，但它会让第一行 `JSON.parse` 失败、整份账本从此读不出来。
  // 这是**可修复**的故障：BOM 是写文件的工具塞进去的，不是账本的内容。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === "") return { runs: [], problems: [], state: "empty" };

  const endsWithNewline = /(\r\n|\n|\r)$/.test(text);
  const lines = text.split(/\r\n|\n|\r/);
  // 文件末尾的空行没有数据（多按一次回车就会产生），不算「一行账」；
  // **中间**的空行是坏行，下面照报。
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  const runs = [];
  const problems = [];
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (line.trim() === "") {
      problems.push(problem(lineNo, "空行", false));
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      // 可判定的截断：最后一行 + 文件不以换行结尾。这只可能是写到一半断了，
      // 与「中间某行是垃圾」不是一回事，但两者都只影响自己这一行。
      const truncated = index === lines.length - 1 && !endsWithNewline;
      problems.push(problem(
        lineNo,
        `${truncated ? "末行被截断" : "JSON 解析失败"}（${error.message}）；这一行是 ${line.slice(0, MAX_ECHO)}`,
        truncated
      ));
      return;
    }
    try {
      runs.push(readStoredRun(parsed, { expectedStepIds }));
    } catch (error) {
      problems.push(problem(lineNo, error.message, false));
    }
  });

  return { runs, problems, state: stateOf(runs, problems) };
}

/**
 * 只看账本**尾 1 字节**：上一条有没有以换行收尾。
 *
 * 为什么不能整份读：这是每次追加都要做的一步，而账本只增不减——整份读会让热路径的
 * 代价随历史长度线性增长（一次 run 一次全文读）。尾字节用 open + fstat + read 取，
 * 与账本多大无关。
 *
 * 读尾字节失败时退回「不补换行」：这里不是失败该现形的地方，真正的写入失败会在
 * `appendFileSync` 那一步抛出来。
 */
function tailNeedsNewline(file) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return false; // 文件还不存在 = 空账本，不需要补
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const tail = Buffer.allocUnsafe(1);
    readSync(fd, tail, 0, 1, size - 1);
    return tail[0] !== 0x0a; // 0x0a = "\n"
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * 追加一条 run（一次 run 一行）。返回值是归一化后的那条，便于调用方回执。
 *
 * 补换行的理由：少了它，追加会把上一条与本条**粘成一行**，于是一行坏 JSON 让整个
 * 账本读不出来——而账本是「刚刚跑完一次」时才动的文件，恰恰最不该在这种地方失败。
 *
 * 写入是严格的：`expectedStepIds` 给了就当场拒（写错的 step id 落到盘上之后，
 * 面板上跟「从没跑过」长得一模一样，那时再查就晚了）。
 */
export function appendRun(projectRoot, id, run, { expectedStepIds = null } = {}) {
  const file = runsPath(projectRoot, id);
  const normalized = normalizeRun(run, { expectedStepIds });
  mkdirSync(runsDir(projectRoot), { recursive: true });
  const prefix = tailNeedsNewline(file) ? "\n" : "";
  try {
    appendFileSync(file, prefix + JSON.stringify(normalized) + "\n", "utf8");
  } catch (error) {
    throw new RunError(`${id}${RUNS_SUFFIX}: 写不进去：${error.message}`);
  }
  return normalized;
}

/**
 * 一次问一批 id 的账本，供 `/pipeline` 端点喂给 `readPipelineDoc`。
 *
 * 一条账本坏了不该让整个面板打不开（与「项目层坏一个 .json 不拖死全局层」同一口径），
 * 但**也不能假装它没坏**：坏行改从 `errors` 里如实回来（带行号），状态经由 `statesById`
 * 显式带出去。缺账本与坏账本因此长得不一样。
 *
 * `expectedStepIdsById` 是「每条工作流的步骤表」：给了就顺手把「账本里写了图上没有的
 * step id」变成可见的噪音——那种行能落盘、能数出来，却没有任何节点拿到它。
 */
export function loadRunsById(projectRoot, ids, { expectedStepIdsById = null } = {}) {
  const runsById = Object.create(null);
  const statesById = Object.create(null);
  const errors = [];
  for (const id of ids || []) {
    const expected = expectedStepIdsById && expectedStepIdsById[id] ? expectedStepIdsById[id] : null;
    try {
      const { runs, problems, state } = readRuns(projectRoot, id, { expectedStepIds: expected });
      runsById[id] = runs;
      statesById[id] = state;
      for (const p of problems) {
        errors.push({
          id,
          line: p.line,
          truncated: p.truncated,
          detail: `${id}${RUNS_SUFFIX}${p.line === null ? "" : ` 第 ${p.line} 行`}: ${p.detail}`
        });
      }
    } catch (error) {
      // 连文件都定位不到（id 本身不安全之类）：如实记一条，状态按「读不出来」算。
      runsById[id] = [];
      statesById[id] = "broken";
      errors.push({ id, line: null, truncated: false, detail: String((error && error.message) || error) });
    }
  }
  return { runsById, errors, statesById };
}
