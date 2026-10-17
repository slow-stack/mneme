/**
 * M.O. 沉淀链（nudge）：让手法**自己从数据里长出来**。
 *
 * 这一层补的是读侧之外缺的那一头。`pipeline.js` 能把人手写的 JSON 渲染成图、能从
 * 运行记录算状态；但「一条新手法从哪来」在那之前一直是零代码。本文件就是那个来源：
 *
 *   会话/记忆里的观察  →  反复出现的同一段序列（候选）  →  反事实判据（请人回答）
 *                      →  status:"draft" 的草稿  →（人点头）→ active
 *
 * **三条不许越的分界线**（这三条比功能完整度重要，写在这里免得后来人图省事）：
 *
 * 1. **机器只写它真观察到的东西。** 步骤、次数、时间、风险下限、要问的问题，这些是
 *    数据里读出来的；人话（`when` / `done` / 触发器那句话）一律留 `（待补）`。把
 *    「这一步为什么存在」编圆了，比留白危险得多——它会让人以为判据已经答过了。
 * 2. **反事实判据不自动给结论。** 判据是「没有这条流程，这次会不会漏步/失败」。
 *    日志里能读到「这一步被跳过」这个**动作**，读不到「跳过之后出事没出事」这个
 *    **结果**；那个结果恰恰就是判据本身。所以本模块只做两件事：把能观察到的对照
 *    摆出来（有这一步几次 / 没有这一步几次），把答不出来的那部分写成**给几个选项的
 *    问题**。`counterfactual.verdict` 永远是 null。
 * 3. **只产草稿，绝不产 active。** 提议自动、固化要人点头（v0.9.0 设计备忘 §4）。
 *    `writeDraftPipeline` 见到 `status !== "draft"` 直接拒写，这条没有开关。
 *
 * 另外四条是**边界性质**，不只靠产者自觉（专家团复核后补齐，见各函数注释）：
 *   · 空回答不算「已答」（`applyAnswers` 一条都没接受就不推进状态）；
 *   · 支持度**只在同一个工作区桶内累加**，且扫全部会话时不许声称候选属于某个项目；
 *   · 提议/草稿一律**原子落盘**（tmp + rename），半截文件不能把整层工作流带走；
 *   · `validateProposal` 拒绝任何非 null 的 `counterfactual.verdict`。
 *
 * 候选的家**分两处**，因为它们的两条命不同：
 *   · 机器产出的候选/问题 → `<memoryDir>/proposals/<项目键>/nudge-*.json`（本地，不进仓库；
 *     一天能长十条、死九条，进仓库就是垃圾，与 `candidates.js` 的绕行候选同一套理由）
 *   · 通过校验的草稿     → `<项目>/.mneme/pipelines/<id>.json`（要能 review、能 PR）
 *
 * **与 `candidates.js` 的关系**（那份是基线里已有的绕行候选层，能复用的一律照它来）：
 *   · 复用它的 `projectKey`（分桶键一律「目录名 + 路径哈希」，绝不含绝对路径）与
 *     `scanIrreversible`（风险兜底清单只有一份，不另立第二份）；
 *   · 分桶约定一致，只是目录名取 `proposals/` 而不是 `candidates/`：那边是「图上没有的
 *     路被走通了」，这边是「还没上过图的重复序列」，两者的状态机（`collecting → proposed
 *     → promoted` 对 `proposed → answered → drafted`）与判据都不同；混进一张表里，
 *     「这条到底有没有被跑过」就查不清了。真正的合并要动 `candidates.js` 的 `origin`
 *     白名单与 `validateCandidate`，那不在本文件写域内。
 *
 * **没有复用 `src/session-usage.js`**：它只存在于隔壁**未合并**的车道，本车道与 main
 * 都没有这个文件，import 会当场炸。所以这里自带一份**只够 nudge 用**的读取器（会话 →
 * 按回合排的调用序列），并把它做成可替换的形状：那个模块并进来之后，
 * `segmentObservations` 之前那一段可以整体换掉，`mineRepeatedPatterns` 以下不用改。
 *
 * **草稿只写 `validatePipeline` 留得住的那 13 个键**：落盘前一律过一遍校验器，写下去的是
 * 它归一化后的形状，所以 `assert` / `onFailure` / `retries` 这类会被静默丢弃的键
 * 一个都不在这条链上。机器算出的风险下限与重复次数留在 memoryDir 的提议文件里
 * ——那里没有白名单。
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";
import { validatePipeline, projectPipelineDir, projectLabel, suggestRetirements } from "./pipeline.js";
import { projectKey, scanIrreversible } from "./candidates.js";

/**
 * 提议门槛：同一段序列要在**至少两个不同的会话**里出现。
 * 这个 2 不是新发明的数——`candidates.js` 的 `PROMOTE_MIN_SEEN` 已经是同一个理由：
 * **复用第二次才算类型，第一次只是一个实例**。同一次但因为「一个会话里重复出现」
 * 就够格的话，一条被复制粘贴的命令就能造出一条假候选。
 */
export const NUDGE_MIN_SUPPORT = 2;

/** 太短的序列没有「步骤关系」可言（两步以内就是「用了 A 又用了 B」），太长则是整场会话。 */
export const NUDGE_MIN_LENGTH = 2;
export const NUDGE_MAX_LENGTH = 4;

/** 一次挖掘最多交回多少条候选。候选是给人看的，一次推两百条等于没推。 */
export const NUDGE_MAX_CANDIDATES = 20;

/**
 * 默认挖哪些层的调用：**能力级（技能 / MCP）**，不挖内置工具级。
 *
 * 这不是想当然定的，是拿本机 520 份真实会话日志跑出来的：工具级序列的支持度高得离谱
 * （`read → pwsh` 出现在 322 个会话、`write → pwsh` 253 个），但它们全是 agent 的
 * 通用动作习惯，不是项目手法——按那个口径挖，推给人的前八条全是这类噪音。
 * 能力级稀疏得多（真实数据里同一段能力序列只有两三个会话支持），但每一条都是
 * 「有人特意选了这个技能」的选择，那才可能是手法。
 *
 * 想挖工具级就显式传 `kinds: ["tool", ...]` 或 `kinds: null`（不过滤）——**别改默认值**，
 * 默认值一改，面板第一屏就变回噪音。
 */
export const DEFAULT_NUDGE_KINDS = ["skill", "mcp"];

/** 单次扫描最多读多少会话文件（目录膨胀时宁可报截断，也不要把一次刷新变成全盘扫描）。 */
const MAX_SESSION_FILES = 2000;

/** 会话日志文件名前缀。**不写死版本号**：本机同一棵树下并存 v4 / v3 / 无版本号三种。 */
const SESSION_FILE_PREFIX = "session";

/** zstd 帧头 magic：多帧文件靠它切帧，见 forEachZstdFrame 的注释。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 候选（提议）自己的状态机。与 `candidates.js` 的候选状态刻意不同名，免得两套账混起来。 */
export const PROPOSAL_STATUSES = ["proposed", "answered", "drafted", "dismissed"];

/**
 * 反事实的**答案选项**。为什么是固定选项而不是自由文本：
 * 这是准入判据，将来要参与「这条草稿能不能升成 active」的清点；自由文本没法清点，
 * 而清点不了的判据最后一定会退化成人情。`unknown` 必须留一个——**逼人二选一
 * 会造出假答案**，而假答案比空答案更贵。
 */
export const COUNTERFACTUAL_CHOICES = [
  { id: "would-skip", label: "会漏掉这一步" },
  { id: "would-fail", label: "会失败（或做返工）" },
  { id: "no-harm", label: "那只是省事，不会出事" },
  { id: "unknown", label: "答不上来" }
];

const CHOICE_IDS = COUNTERFACTUAL_CHOICES.map((c) => c.id);
const CHOICE_LABELS = new Map(COUNTERFACTUAL_CHOICES.map((c) => [c.id, c.label]));

/**
 * 会改本机文件/状态的内置工具 → 风险下限 R1。
 * 这是一份**机械清单**，与 `candidates.js` 的 `IRREVERSIBLE_PATTERNS` 同一个思路：
 * 能审计、能 diff，不看模型自报。
 */
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "notebook_edit"]);

/** 反事实那一条问题的原文。它出现在每一张问题上，所以在这里只写一次。 */
const COUNTERFACTUAL_QUESTION = "没有这一步，那次会不会漏步、会不会失败？";

/** 展开 `~`。候选层与 `memoryDir` 一样是本地状态，不是仓库内容。 */
function expandHome(p) {
  const s = String(p || "");
  if (s === "~") return homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(homedir(), s.slice(2));
  return s;
}

/** 会话根目录。默认由 `DSH_HOME` 推导，**不写死本机路径**——仓库里出现盘符是红线。 */
export function resolveSessionDir({ dshHome = process.env.DSH_HOME || join(homedir(), ".dsh") } = {}) {
  return join(String(dshHome), "sessions");
}

/**
 * 逐帧解一个**多帧** zstd buffer，边解边回调。
 *
 * 为什么不能直接 `zstdDecompressSync(buf)`：它只返回**第一帧**，不报错、不警告。
 * 实测一个 1.5 MB 的会话文件只解出 291 字节，99% 的内容没被扫到，于是得出「零命中」
 * 的假结论——这类错在本仓历史上出现过，所以这里自己按 magic 切帧。
 *
 * 为什么用回调而不是返回整串：一次读上百个会话文件会 OOM，逐帧交给回调，内存只留一帧。
 *
 * 关于**截断帧**：zstd 是流式格式，尾部被截断的帧会解出「部分文本」而不抛错。这里
 * **不猜帧的完整性**，改在行这一层兜底——残缺帧的尾巴一定是半行，而 jsonl 本来就要求
 * 整行是合法 JSON，半行会解析失败被丢掉。取舍是**宁可少一条，不要错一条**。
 */
export function forEachZstdFrame(buf, onText) {
  let offset = 0;
  let frames = 0;
  let failed = 0;
  while (offset < buf.length) {
    const start = buf.indexOf(ZSTD_MAGIC, offset);
    if (start === -1) break;
    let end = buf.indexOf(ZSTD_MAGIC, start + 4);
    if (end === -1) end = buf.length;
    try {
      onText(zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8"));
      frames += 1;
    } catch {
      // 帧头坏了：计入 failed 继续后面的帧——「解不出来」要被报出来，不能被当成「没有内容」。
      failed += 1;
    }
    offset = end;
  }
  return { frames, failed };
}

/**
 * 递归找出会话日志文件。
 *
 * **先收全、再排序、最后截断**（早前是先截断再排序，于是「留下哪几个」由遍历顺序决定，
 * 而遍历顺序里带着工作区目录名——截断量会报，**选择偏差不会报**，实测这正是评分表上
 * 「2000 文件上限按遍历序截断」那一条）。路径本身是短字符串，收全的代价可以忽略；
 * 真正的内存护栏在读取层（`readSessionObservations` 逐帧解、读完即 `buf.fill(0)`）。
 *
 * `totalFiles` 是真总数、`files` 是截断后的结果、`truncated` 说明两者不同——
 * 三个数一起给，「只扫了一部分」才看得见。
 */
export function findSessionFiles(dir, { limit = MAX_SESSION_FILES } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_SESSION_FILES;
  const result = { files: [], unreadable: [], present: false, truncated: false, totalFiles: 0 };
  if (!existsSync(dir)) return result;
  result.present = true;
  const all = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      // 「目录不可读」与「目录是空的」必须能分辨，否则读数上同形——那正是本仓反复防的那类错。
      result.unreadable.push({ dir: current, detail: `目录读失败：${error.message}` });
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      // 符号链接要单独认：Dirent 对 symlink 的 isDirectory() 返回 false。
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          result.unreadable.push({ dir: full, detail: "符号链接目标不可达" });
          continue;
        }
      }
      if (isDir) walk(full);
      else if (entry.name.startsWith(SESSION_FILE_PREFIX)) all.push(full);
    }
  };
  walk(dir);
  all.sort();
  result.totalFiles = all.length;
  result.truncated = all.length > cap;
  result.files = all.slice(0, cap);
  return result;
}

/**
 * 一次工具调用 → 一次观察。三类调用**判定方式故意不同**（照宿主各自契约）：
 *   · `skill` → 参数里的 `name` 是技能名；
 *   · `mcp__<server>__<tool>` → 中间那段是 server；
 *   · 其余内置工具（read / pwsh / write …）→ 工具名本身就是它的身份。
 *
 * `command` 只为**风险下限**与**措辞**服务，原文带本机路径，所以下游一律先过
 * `safeCommandTokens` 的清洗，绝不整条进草稿文件。
 *
 * `bucket` 是**工作区桶**（会话文件往上数第三层目录名）。为什么非要带上它：
 * 会话目录在 DSH 侧按工作区分桶，`sessionId` 只是桶内那个会话目录名——两条不同工作区
 * 里的会话会拿到两个不同的 `sessionId`，于是一段序列在两个项目里各出现一次，就会被
 * 并成「支持度 2 的同一手法」。那是把两个项目的账合成一本，实测过（复核报告 §2.6）。
 * 带上 bucket 之后，支持度只在同一个桶内累加。
 */
export function observationsFromCalls(calls, { sessionId = null, bucket = null } = {}) {
  const out = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    if (!call || typeof call.name !== "string" || call.name === "") continue;
    const args = call.args && typeof call.args === "object" ? call.args : {};
    let kind = "tool";
    let name = call.name;
    if (call.name === "skill") {
      const skill = typeof args.name === "string" ? args.name.trim() : "";
      if (skill === "") continue;
      kind = "skill";
      name = skill;
    } else if (call.name.startsWith("mcp__")) {
      const parts = call.name.split("__");
      if (!parts[1]) continue;
      kind = "mcp";
      name = parts[1];
    }
    const command =
      typeof args.command === "string" ? args.command
      : typeof args.cmd === "string" ? args.cmd
      : typeof args.file_path === "string" ? args.file_path
      : "";
    const at = Number.isFinite(call.time) ? new Date(call.time).toISOString() : null;
    out.push({ sessionId, bucket, turn: call.turn ?? null, at, tool: call.name, kind, name, command });
  }
  return out;
}

/** 一行 jsonl 里的 tool-call 全部抽出来（形状见 session 日志：`data.message.content[]`）。 */
export function toolCallsInLine(line) {
  if (typeof line !== "string" || !line.includes('"tool-call"')) return [];
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const content = obj?.data?.message?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const item of content) {
    if (!item || item.type !== "tool-call" || typeof item.name !== "string") continue;
    let args = null;
    // 参数是 **JSON 字符串**（不是对象，也不叫 parameters）——取错字段会得到 null，
    // 看着像「调用了但没记参数」。
    if (typeof item.arguments === "string") {
      try {
        args = JSON.parse(item.arguments);
      } catch {
        args = null;
      }
    } else if (item.arguments && typeof item.arguments === "object") {
      args = item.arguments;
    }
    out.push({ name: item.name, args, turn: obj?.data?.turn ?? null, time: Number.isFinite(obj?.time) ? obj.time : null });
  }
  return out;
}

/**
 * 扫会话日志，产出**按会话排好的观察串**（这是候选的唯一原始材料）。
 *
 * 会话 id 取文件名上面那一层目录名（DSH 侧一个会话一个目录），工作区桶取再上面那一层；
 * 取不到就落 null——落 null 的观察只会让支持度算不出来，不会假装成「同一个会话」
 * 或「同一个项目」。
 */
export function readSessionObservations({ sessionDir = resolveSessionDir(), limit = MAX_SESSION_FILES } = {}) {
  const found = findSessionFiles(sessionDir, { limit });
  const files = found.files.slice(0, limit);
  const totalFiles = Number.isFinite(found.totalFiles) ? found.totalFiles : found.files.length;
  const result = {
    sessionDir,
    present: found.present,
    // 「目录在」与「目录真能列出来」分开报：否则「不可读」与「空目录」同形。
    readable: found.present && found.unreadable.length === 0,
    truncated: found.truncated === true || totalFiles > files.length,
    totalFiles,
    scannedFiles: 0,
    frames: 0,
    failedFrames: 0,
    lines: 0,
    calls: 0,
    observations: [],
    unreadable: [...found.unreadable]
  };

  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch (error) {
      result.unreadable.push({ file, detail: `读失败：${error.message}` });
      continue;
    }
    result.scannedFiles += 1;
    const parts = file.split(/[\\/]/);
    const sessionId = parts.slice(-2, -1)[0] || null;
    const bucket = parts.slice(-3, -2)[0] || null;
    const stat = forEachZstdFrame(buf, (text) => {
      for (const line of text.split("\n")) {
        if (!line.trim() || !line.includes('"tool-call"')) continue;
        result.lines += 1;
        const calls = toolCallsInLine(line);
        if (!calls.length) continue;
        result.calls += calls.length;
        result.observations.push(...observationsFromCalls(calls, { sessionId, bucket }));
      }
    });
    result.frames += stat.frames;
    result.failedFrames += stat.failed;
    buf.fill(0);
  }

  return result;
}

/**
 * 观察串 → 段。两件事：
 *   · **按回合切段**：同一回合里的连续调用才是「一次怎么做事」，跨回合是两次事件；
 *   · **折叠连续同一步**：同一能力连调四次不是「四步序列」，是这一步很重。折叠但把
 *     `repeats` 记下来——次数是事实，丢掉就少一个信号。
 */
export function segmentObservations(observations) {
  const segments = [];
  let current = null;
  for (const obs of Array.isArray(observations) ? observations : []) {
    // 桶也进切段键：两个工作区里的同名会话目录绝不能被当成同一段。
    const sameSegment =
      current && current.sessionId === obs.sessionId && current.turn === obs.turn && current.bucket === obs.bucket;
    if (!sameSegment) {
      current = { sessionId: obs.sessionId, bucket: obs.bucket ?? null, turn: obs.turn, steps: [] };
      segments.push(current);
    }
    const key = `${obs.kind}:${obs.name}`;
    const last = current.steps[current.steps.length - 1];
    if (last && last.key === key) {
      last.repeats += 1;
      last.at = obs.at || last.at;
      continue;
    }
    current.steps.push({ key, kind: obs.kind, name: obs.name, tool: obs.tool, command: obs.command, at: obs.at, repeats: 1 });
  }
  return segments;
}

/**
 * 一段里某个位置的观察样本怎么并进模式：命令**取并**——风险下限要看过全部命令才敢说
 * 「没命中兜底清单」，只看第一条会把第三条里的 `git push` 漏掉。
 * 上限 12 条是内存护栏：同一个位置出现几百种不同命令时，它是噪音不是手法。
 */
const MAX_COMMANDS_PER_POSITION = 12;

/** 省略痕迹里的工具名最多记几个：只为了让人看懂「夹的是什么」，不是完整清单。 */
const MAX_ELIDED_TOOLS = 4;

/**
 * 把一批被抽掉的步骤并成一条**省略痕迹**。
 * `head` 表示这些步骤在保留序列的第一个步骤之前——那一步不是这一段的入口，
 * 「这一段入口」这句话本身也要跟着改（见 planStep）。
 */
function elidedFrom(pending) {
  if (!pending.length) return null;
  const count = pending.reduce((acc, s) => acc + (s.repeats || 1), 0);
  const tools = [];
  for (const s of pending) {
    const label = `${s.kind}:${s.name}`;
    if (!tools.includes(label) && tools.length < MAX_ELIDED_TOOLS) tools.push(label);
  }
  return { count, tools, head: false };
}

/** 同一次省略在多次出现里取「最保守」的读法：次数取最大、工具取并。 */
function mergeElided(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    count: Math.max(a.count, b.count),
    tools: [...new Set([...a.tools, ...b.tools])].slice(0, MAX_ELIDED_TOOLS),
    head: a.head && b.head
  };
}

function mergePosition(target, step) {
  target.repeats = Math.max(target.repeats, step.repeats);
  if (target.tool === null) target.tool = step.tool;
  if (step.command && !target.commands.includes(step.command) && target.commands.length < MAX_COMMANDS_PER_POSITION) {
    target.commands.push(step.command);
  }
  // 同一个位置在有的会话里夹着别的调用、有的没有 → 按「夹着」记（保守：宁可多说一句
  // 「中间还有东西」，也不要断言一个其实不成立的相邻关系）。
  target.elided = mergeElided(target.elided, step.elided || null);
}

/**
 * 从步名里取出可进仓库的短词。**这不是美化，是清洗**：命令原文里有本机路径与用户名，
 * 而草稿文件是要提交、要 review 的。白名单式的取词能机械地保证这一点：
 *   · 只收 `[A-Za-z][A-Za-z0-9._-]*` —— 盘符（带冒号）、路径（带分隔符）、非 ASCII
 *     （本机用户名常含非 ASCII）全被这条挡在外面；
 *   · 再挡一次家目录名本身，以及 `users` / `home` 这类路径段；
 *   · 取不到就返回空数组，**宁可这一步没词，也不猜**。
 */
export function safeCommandTokens(command, { maxTokens = 2 } = {}) {
  const homeParts = homedir().split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
  const banned = new Set([...homeParts, "users", "home", "desktop", "documents", "appdata"]);
  const out = [];
  for (const raw of String(command || "").split(/\s+/)) {
    const token = raw.replace(/^["']+|["']+$/g, "");
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,23}$/.test(token)) continue;
    if (banned.has(token.toLowerCase())) continue;
    out.push(token);
    if (out.length >= maxTokens) break;
  }
  return out;
}

/**
 * 这一步的**风险下限**——刻意叫「下限」不叫「风险档」：它只由机械清单算出，
 * 不假装看懂了这个动作的全部含义（一个叫 `ef-broadcast` 的技能能对外发布，名字里
 * 却没有任何危险词）。
 *
 * 判法两条，都可以按字节审计：
 *   1. 观察到的命令原文命中 `IRREVERSIBLE_PATTERNS` → R2（与绕行候选同一份清单）；
 *   2. 会改本机文件的内置工具 → R1。
 * 其余落 R0。**R3 永远不由机器给**——那一档的定义就是「得人来定」，机器给出来就是假的。
 */
export function riskFloorForStep({ tool = "", commands = [] } = {}) {
  const hits = [];
  for (const command of Array.isArray(commands) ? commands : []) {
    const scan = scanIrreversible(command);
    if (scan.hit) hits.push(...scan.matches.map((m) => m.id));
  }
  if (hits.length) return { risk: "R2", source: "blacklist", hits: [...new Set(hits)].sort() };
  if (WRITE_TOOLS.has(tool)) return { risk: "R1", source: "write-tool", hits: [] };
  return { risk: "R0", source: "default", hits: [] };
}

/** 一步的措辞：观察到的部分照实写，人话一律留 `（待补）`（见文件头第 1 条分界线）。 */
function planStep(position, index, prevTitle) {
  const words = safeCommandTokens(position.commands[0] || "");
  const id = `S${index + 1}`;
  let title;
  let doText;
  if (position.kind === "skill") {
    title = `技能：${position.name}`;
    doText = `调用技能 ${position.name}`;
  } else if (position.kind === "mcp") {
    title = `MCP：${position.name}`;
    doText = `调用 ${position.name} 服务器上的能力`;
  } else {
    title = words.length ? `${position.tool}：${words.join(" ")}` : `工具：${position.tool}`;
    doText = words.length ? `调用 ${position.tool}，形如「${words.join(" ")}」` : `调用 ${position.tool}`;
  }
  const risk = riskFloorForStep({ tool: position.tool, commands: position.commands });
  return {
    id,
    phase: "观察段",
    title,
    // **相邻关系只在真的相邻时才断言**：按层过滤（见 filterSegmentsByKinds）会把夹在中间的
    // 调用抽掉，而过滤后的相邻不等于观察到的相邻——原始观察里中间可能隔着 4 次工具调用。
    // 机器只写观察到的：夹着东西就把夹着的东西一起写出来（`elided`），不写就说明真没夹。
    when: adjacencyWording(position, prevTitle),
    do: doText,
    who: "main",
    tool: position.tool,
    // 完成判据是准入判据的一半，机器给不了。
    done: "（待补）这一步怎么算完成",
    risk: risk.risk,
    riskSource: risk.source,
    riskHits: risk.hits,
    repeats: position.repeats,
    // 省略痕迹原样带进提议文件：草稿那边会被 validatePipeline 的白名单丢掉，所以
    // 「这一步在过滤前长什么样」只有提议文件里查得到。
    elided: position.elided || null,
    needs: index === 0 ? [] : [`S${index}`],
    // 反事实对照**故意留空**：它是准入判据，不是备注；没人回答之前宁可是空的。
    // 面板会把空对照节点的边画得虚一点（见 pipeline.js 的 counterfactual 投影）。
    why: "（待补）为什么必须有这一步——由 nudge 从重复观察里提出，还没人回答",
    evidence: [],
    gate: false
  };
}

/** 相邻关系的措辞。三档：真相邻 / 过滤后相邻（要说清夹着什么）/ 同一步。 */
function adjacencyWording(position, prevTitle) {
  const elided = position.elided || null;
  const tail = elided ? `（中间还有 ${elided.count} 次其他调用：${elided.tools.join("、")}）` : "";
  if (!prevTitle) {
    return elided
      ? `（待补）它在过滤后的序列里是第一个保留的步骤，它之前还有 ${elided.count} 次其他调用：${elided.tools.join("、")}`
      : "（待补）这一段的入口";
  }
  return elided
    ? `（待补）观察中它在「${prevTitle}」之后${tail}，相邻关系是过滤后的`
    : `（待补）观察中它紧跟在「${prevTitle}」之后`;
}

/**
 * 按层过滤段，**并重新折叠**：抽掉中间的内置工具调用之后，原本被它隔开的两个同能力
 * 调用会变成相邻——那是一次「很重的同一步」，不是两步。不重折叠就会把 `A → pwsh → A`
 * 记成两处步骤，支持度与形状全歪。
 *
 * **抽掉的东西要留痕**（`elided`）：过滤后的相邻不是观察到的相邻。痕迹挂在后一个保留
 * 步骤上——`{ count, tools, head }`，`head: true` 表示被抽掉的都在它之前（那么它也不是
 * 「这一段的入口」）。不留痕就会生成「紧跟在 A 之后」这种机器其实没观察到的断言。
 */
export function filterSegmentsByKinds(segments, kinds) {
  if (!Array.isArray(kinds)) return segments;
  const wanted = new Set(kinds);
  const out = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const steps = [];
    let pending = [];
    for (const step of segment.steps || []) {
      if (!wanted.has(step.kind)) {
        pending.push(step);
        continue;
      }
      const last = steps[steps.length - 1];
      if (last && last.key === step.key) {
        last.repeats += step.repeats;
        last.at = step.at || last.at;
        // 同一步被夹开也算省略：`A → pwsh → A` 折成一步时，中间那次 pwsh 一样是「夹着的」。
        last.elided = mergeElided(last.elided, elidedFrom(pending));
        pending = [];
        continue;
      }
      const elided = elidedFrom(pending);
      if (elided && steps.length === 0) elided.head = true;
      steps.push({ ...step, elided: elided || null });
      pending = [];
    }
    if (steps.length) out.push({ sessionId: segment.sessionId, bucket: segment.bucket ?? null, turn: segment.turn, steps });
  }
  return out;
}

/**
 * 挖「同一段序列反复出现」。返回的每一条都已经带好步骤草稿（`steps`）与它自己那份
 * **极大模式**的交代。
 *
 * 极大模式（maximal pattern）：`A → B` 与 `A → B → C` 支持度相同时，只留长的那条。
 * 理由：`A → B` 是 `A → B → C` 的一段前缀，两条都推给人就是把同一条手法说两遍。
 * 判据是**包含 + 会话集是子集**——只按字符串包含会把「支持度更低的短模式」也吞掉。
 *
 * **支持度只在同一个工作区桶内累加**（`key` 前缀带 bucket）：两个不同项目里各见过一次
 * 的同一段序列，不是「支持度 2 的同一手法」，而是两条各自只有一次的观察。混桶会凭空
 * 造出候选，并把别人的手法算到这个项目头上（复核报告 §2.6 实测过）。
 */
export function mineRepeatedPatterns(segments, { minSupport = NUDGE_MIN_SUPPORT, minLength = NUDGE_MIN_LENGTH, maxLength = NUDGE_MAX_LENGTH, maxResults = NUDGE_MAX_CANDIDATES, kinds = DEFAULT_NUDGE_KINDS } = {}) {
  const scoped = filterSegmentsByKinds(segments, kinds);
  const byKey = new Map();
  for (const segment of scoped) {
    const steps = segment.steps || [];
    const bucket = segment.bucket ?? null;
    for (let len = minLength; len <= maxLength; len += 1) {
      for (let i = 0; i + len <= steps.length; i += 1) {
        const window = steps.slice(i, i + len);
        const names = window.map((s) => `${s.kind}:${s.name}`);
        const key = `${bucket ?? ""}\u0000${names.join(" → ")}`;
        let entry = byKey.get(key);
        if (!entry) {
          entry = {
            key,
            bucket,
            names,
            sessions: new Set(),
            occurrences: 0,
            turns: new Set(),
            firstSeenAt: null,
            lastSeenAt: null,
            positions: window.map((s) => ({ kind: s.kind, name: s.name, tool: s.tool, commands: [], repeats: 0, elided: null }))
          };
          byKey.set(key, entry);
        }
        entry.occurrences += 1;
        if (segment.sessionId) entry.sessions.add(segment.sessionId);
        if (segment.turn !== null && segment.turn !== undefined) entry.turns.add(`${segment.sessionId ?? ""}#${segment.turn}`);
        for (let k = 0; k < window.length; k += 1) mergePosition(entry.positions[k], window[k]);
        for (const at of names.map((_, k) => window[k].at).filter(Boolean)) {
          if (!entry.firstSeenAt || at < entry.firstSeenAt) entry.firstSeenAt = at;
          if (!entry.lastSeenAt || at > entry.lastSeenAt) entry.lastSeenAt = at;
        }
      }
    }
  }

  const candidates = [...byKey.values()]
    .filter((e) => e.sessions.size >= minSupport)
    // 长的、支持度高的先看：极大模式筛选取这个顺序，输出也按这个顺序。
    .sort((a, b) => b.names.length - a.names.length || b.sessions.size - a.sessions.size || a.key.localeCompare(b.key));

  const kept = [];
  for (const entry of candidates) {
    // 极大模式只在同一个桶内比较：跨桶的「包含」不是包含，是两回事。
    const subsumed = kept.some(
      (k) =>
        k.bucket === entry.bucket &&
        k.names.length > entry.names.length &&
        containsSequence(k.names, entry.names) &&
        isSubset(entry.sessions, k.sessions)
    );
    if (!subsumed) kept.push(entry);
  }
  kept.sort((a, b) => b.sessions.size - a.sessions.size || b.names.length - a.names.length || a.key.localeCompare(b.key));

  return kept.slice(0, maxResults).map((entry) => toCandidate(entry));
}

function containsSequence(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let ok = true;
    for (let k = 0; k < needle.length; k += 1) {
      if (haystack[i + k] !== needle[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function isSubset(a, b) {
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** 模式 → 候选（含步骤草稿）。id 由「工作区桶 + 步骤形状」定，所以同一段路再挖到会落到同一条上。 */
function toCandidate(entry, { now = Date.now() } = {}) {
  const steps = [];
  entry.positions.forEach((position, index) => {
    steps.push(planStep(position, index, index === 0 ? null : steps[index - 1].title));
  });
  const shape = `${entry.bucket ?? ""}|${entry.names.join("|")}`;
  return {
    id: `nudge-${createHash("sha256").update(shape).digest("hex").slice(0, 12)}`,
    origin: "nudge",
    status: "proposed",
    // 候选来自哪个工作区桶：**桶名是路径的有损变形，所以它是本机私有数据**，
    // 只进 memoryDir 的提议文件（那本来就不进仓库），不进草稿文件。
    bucket: entry.bucket ?? null,
    names: entry.names.slice(),
    steps,
    support: entry.sessions.size,
    occurrences: entry.occurrences,
    sessions: [...entry.sessions].sort(),
    turns: entry.turns.size,
    firstSeenAt: entry.firstSeenAt,
    lastSeenAt: entry.lastSeenAt,
    createdAt: new Date(now).toISOString(),
    counterfactual: null
  };
}

/**
 * 每一步的「有它 / 没它」对照——**这是本模块唯一能自动算出来的反事实材料**。
 *
 * 做法：同一段序列，有的会话走全了，有的会话中间少了某一步（`A→B→C` 与 `A→C` 都
 * 出现过）。这两种都**真发生过**，所以「少走一步的次数」是观察，不是推测。
 *
 * 边界要写清：
 *   · **只有中间的步骤算得出这种对照**。首尾两步的「省略」等价于「这段序列没发生过」，
 *     那是另一件事，硬算会造出一堆假对照。所以首尾不计——这个留白是有意的。
 *   · 统计范围是**所有段**，不是「候选出现过的那些会话」：少走了中间这一步的会话，
 *     按定义就不在候选的会话集里。只用后者会永远数出 `withoutStep = 0`，
 *     也就是把一个真观察说成「从来没有过反例」——那正是判据变假的样子。
 *   · 只看**候选自己用到的那几层**（候选是能力级，就只数能力级）：否则中间夹着的
 *     一次内置工具调用会把相邻两步拆开，`A→B→C` 在一次真实走过它的会话里也会被
 *     数成「没走全」。口径必须与挖掘时一致，这里用候选自己的语汇来定，省得调用方
 *     还要记得把过滤后的段传进来。
 *   · 只看**候选自己那个工作区桶**：别的项目里的 `A→C` 不是这条候选的反例，
 *     它是另一个项目的事。混进来说明「少走这一步」的次数，等于拿别人的账本记账。
 *
 * **长度为 2 的序列这里一定是空的**，而且不是「没有反例」——是这种对照对它不适用。
 * 早前那种「静默变空」在面板上看起来跟「反例为零」一模一样，所以现在显式带
 * `empty` 与 `note` 两个字段，把「留白」和「零」分开（复核报告 §3 那一行）。
 */
export function omissionContrast(candidate, segments) {
  const names = candidate.names || [];
  const out = [];
  const all = (Array.isArray(segments) ? segments : []).filter(
    (s) => candidate.bucket === undefined || candidate.bucket === null || (s.bucket ?? null) === candidate.bucket
  );
  const kindsInScope = new Set(names.map((n) => String(n).split(":")[0]));
  for (let i = 1; i < names.length - 1; i += 1) {
    const reduced = names.filter((_, k) => k !== i);
    let withStep = 0;
    let withoutStep = 0;
    for (const segment of all) {
      const seq = (segment.steps || [])
        .filter((s) => kindsInScope.has(s.kind))
        .map((s) => `${s.kind}:${s.name}`);
      if (containsSequence(seq, names)) withStep += 1;
      else if (containsSequence(seq, reduced)) withoutStep += 1;
    }
    out.push({
      stepId: candidate.steps[i] ? candidate.steps[i].id : `S${i + 1}`,
      title: candidate.steps[i] ? candidate.steps[i].title : names[i],
      withStep,
      withoutStep
    });
  }
  const empty = out.length === 0;
  return {
    steps: out,
    interiorOnly: true,
    empty,
    // 「空」的两种含义必须分开：这段序列没有中间步骤（长度 2），还是中间步骤暂时没有对照数据。
    // 首尾不计这条规矩写在这里，免得看的人把留白读成「反例为零」。
    note: empty
      ? "这段序列没有可算缺席对照的中间步骤（长度为 2 时首尾的省略等价于整段没发生）——留白，不是「反例为零」"
      : ""
  };
}

/**
 * 给候选配上运行记录里的三态计数。匹配靠**标题或步骤 id**：已生效工作流的 runs 里记的是
 * 它自己的 id（`A1` 之类），而候选的步骤是 `S1…`，两者不同源，所以对不上就返回 null
 * ——**宁可报「没对上」，也不要把别人的 run 算到这条候选头上**。
 */
function runsForCandidate(candidate, runs) {
  const wanted = new Set((candidate.steps || []).map((s) => s.title));
  const totals = { uses: 0, skipped: 0, detoured: 0, refuted: 0, matched: 0 };
  for (const run of Array.isArray(runs) ? runs : []) {
    for (const step of run?.steps || []) {
      if (!wanted.has(step.title) && !wanted.has(step.id)) continue;
      totals.matched += 1;
      const detoured = step.detoured === true || step.kind === "detour";
      const skipped = step.skipped === true;
      if (detoured) totals.detoured += 1;
      if (skipped) totals.skipped += 1;
      if (!detoured && !skipped) totals.uses += 1;
      if (step.refuted) totals.refuted += 1;
    }
  }
  return totals.matched ? totals : null;
}

/**
 * 反事实判据的**全部内容**：能观察的摆出来，不能观察的写成问题。
 *
 * `verdict` 永远是 null，这不是没做完，是设计（见文件头第 2 条）。谁要是把这里改成
 * 自动给一个「会漏步」，那一定是错的：日志里没有「跳过之后出事没出事」的标签。
 *
 * 能给的证据三类：
 *   · 复现：同一段序列在几个会话、几次回合、什么时间跨度里出现过（硬事实）；
 *   · 缺席对照：中间那一步「走过几次 / 少走几次」（硬事实，见 omissionContrast）；
 *   · 运行记录与失败记录：如果这条手法已经有 runs，或者人喂了记忆侧的失败行，一并报数。
 *
 * `failures` 传 `null`（默认）表示**记忆侧的失败记录还没接进来**，与「接进来了、
 * 确实一条都没有」是两件事，所以这里不给 `null`，而是给 `{ available, reason }`
 * ——会话源那侧早就是这么做的（`present` 与 `readable` 分开报），同一套纪律。
 */
export function buildCounterfactual(candidate, { segments = [], runs = [], failures = null, now = Date.now() } = {}) {
  const omission = omissionContrast(candidate, segments);
  const runTotals = runsForCandidate(candidate, runs);
  const failuresWired = Array.isArray(failures);
  const failureRows = failuresWired ? failures : [];
  const ask = (candidate.steps || []).map((step) => ({
    proposalId: candidate.id,
    stepId: step.id,
    title: step.title,
    question: COUNTERFACTUAL_QUESTION,
    choices: COUNTERFACTUAL_CHOICES.map((c) => c.id),
    choiceLabels: Object.fromEntries(CHOICE_LABELS),
    // 答案写到哪：草稿里这一步的 evidence[]。写在那里是有讲究的——`toPipelineV1` 会把
    // 它投影成 `counterfactual.contrast`，答不出来的步骤在图上就比答得出来的虚。
    writeTo: "steps[].evidence[]"
  }));

  return {
    verdict: null,
    verdictNote:
      "判据不自动判：日志里读得到「这一步被跳过」这个动作，读不到「跳过之后出事没出事」这个结果——而那个结果正是判据本身。所以这里只摆证据、只问问题。",
    generatedAt: new Date(now).toISOString(),
    observable: {
      recurrence: {
        support: candidate.support,
        occurrences: candidate.occurrences,
        turns: candidate.turns ?? null,
        sessions: candidate.sessions ? candidate.sessions.slice(0, 10) : [],
        firstSeenAt: candidate.firstSeenAt || null,
        lastSeenAt: candidate.lastSeenAt || null
      },
      omission,
      runs: runTotals,
      // 「没接线」与「确实一条都没有」必须能分辨（同模块会话源那套 present/readable）。
      failures: failuresWired
        ? { available: true, count: failureRows.length, kinds: [...new Set(failureRows.map((f) => f && f.failure_type).filter(Boolean))].sort() }
        : { available: false, reason: "not-wired", note: "记忆侧的失败记录还没接进来——这不是「没有失败记录」" },
      bucket: candidate.bucket ?? null
    },
    unobservable: [
      "没有这一步「这次会不会漏步」——需要人回答",
      "没有这一步「这次会不会失败/返工」——需要人回答",
      "这一步的完成判据与触发语——需要人补"
    ],
    ask
  };
}

/**
 * 人的回答并进候选：写进那一步的 `evidence[]`（准入判据的载体），并留痕。
 *
 * 两条硬规矩：
 *   · 非法选项**直接拒**，不静默当 `unknown`——静默降级会把一个打错的答案变成一个人的判断；
 *   · **一条回答都没接受就什么都不推进**：`applyAnswers(candidate, {})` 早前返回
 *     `{ok:true, status:"answered", applied:0}`——无人回答却「已答」。今天没有下游消费者，
 *     但这条通路的名字就叫「人点头」，将来只要有人写出「answered 才准升格」，那个假状态
 *     立刻生效。所以空回答按失败处理，`status` 一步都不许动。
 */
export function applyAnswers(candidate, answers, { now = Date.now() } = {}) {
  const problems = [];
  const answeredAt = new Date(now).toISOString();
  const steps = (candidate.steps || []).map((s) => ({ ...s, evidence: Array.isArray(s.evidence) ? s.evidence.slice() : [] }));
  const applied = [];
  for (const [stepId, raw] of Object.entries(answers || {})) {
    const step = steps.find((s) => s.id === stepId);
    if (!step) {
      problems.push(`回答指向了不存在的步骤 ${stepId}`);
      continue;
    }
    const choice = typeof raw === "string" ? raw : raw && raw.choice;
    const note = typeof raw === "object" && raw ? String(raw.note || "").trim() : "";
    if (!CHOICE_IDS.includes(choice)) {
      problems.push(`${stepId} 的答案「${String(choice)}」不在选项里（${CHOICE_IDS.join(" / ")}）`);
      continue;
    }
    const text = `人答（${answeredAt.slice(0, 10)}）：没有它，${CHOICE_LABELS.get(choice)}${note ? `——${note}` : ""}`;
    step.evidence = [text];
    applied.push({ stepId, choice, text });
  }
  if (problems.length) return { ok: false, candidate: null, applied: [], unanswered: [], problems };
  if (applied.length === 0) {
    return {
      ok: false,
      candidate: null,
      applied: [],
      unanswered: steps.filter((s) => s.evidence.length === 0).map((s) => s.id),
      problems: ["没有任何一条回答被接受——空回答不算「已答」，状态不推进"]
    };
  }

  const next = { ...candidate, steps, status: "answered", answeredAt };
  const unanswered = steps.filter((s) => s.evidence.length === 0).map((s) => s.id);
  return { ok: true, candidate: next, applied, unanswered, problems: [] };
}

/** 草稿里的占位符只在这里出现一次，方便一眼看出「哪些还是机器留的白」。 */
const TODO = "（待补）";

/**
 * 候选 → `status:"draft"` 的草稿，**过 validatePipeline**。
 *
 * 为什么 status 写死 draft：提议自动、固化要人点头。这个函数没有 active 分支，
 * 也不接 `status` 参数——想升格就得有人动手，那条路不在这个文件里。
 *
 * 三个必填字段（`done` / `trigger` / 步骤的人话）机器给不了，所以填成显眼的 `（待补）`：
 * **一个看起来像成品、其实没人回答过判据的草稿，比一个明摆着是半成品的草稿危险。**
 */
export function draftFromCandidate(candidate, { project = "", name = "", done = "", trigger = null, version = 0 } = {}) {
  if (!candidate || !Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    return { ok: false, pipeline: null, problems: ["候选没有步骤，不能成草稿"], unanswered: [] };
  }
  const raw = {
    id: String(candidate.id || ""),
    name: name || `（待补）由重复观察提出的手法：${(candidate.names || []).join(" → ")}`,
    project: project || TODO,
    version,
    status: "draft",
    done: done || `${TODO}整条怎么算完成`,
    trigger: Array.isArray(trigger) && trigger.length ? trigger : [{ kind: "phrase", value: `${TODO}什么话该触发这条手法` }],
    steps: candidate.steps.map((s, index) => ({
      id: s.id || `S${index + 1}`,
      phase: s.phase || "观察段",
      title: s.title,
      when: s.when,
      do: s.do,
      who: s.who || "main",
      tool: s.tool || "",
      done: s.done,
      risk: s.risk || "R0",
      needs: Array.isArray(s.needs) ? s.needs : index === 0 ? [] : [`S${index}`],
      why: s.why,
      evidence: Array.isArray(s.evidence) ? s.evidence.slice() : [],
      gate: s.gate === true
    }))
  };
  try {
    const pipeline = validatePipeline(raw, `${candidate.id}.json`);
    return {
      ok: true,
      pipeline,
      problems: [],
      unanswered: pipeline.steps.filter((s) => s.evidence.length === 0).map((s) => s.id)
    };
  } catch (error) {
    return { ok: false, pipeline: null, problems: error.problems || [String(error && error.message)], unanswered: [] };
  }
}

/**
 * **原子整文件写**：先写同目录的临时文件，再 `rename` 覆盖目标。
 *
 * 为什么非这样不可：读侧（`loadPipelines`）是「整目录校验，任一条坏就整层抛」，所以
 * 一个写到一半的文件会让**整个项目层的工作流一起从面板消失**——合法的那几条也一起没，
 * 而且因为「已存在就跳过」的规矩还不会自愈（复核报告 §2.9 实测过这个组合）。
 * `rename` 在同一文件系统内是原子的：读者要么看到旧的完整内容，要么看到新的完整内容。
 *
 * 临时文件必须**同目录**（跨盘 rename 会退化成拷贝，就不再原子了），并且带 pid 与随机后缀，
 * 免得两个进程同时写同一个目标时互相吃掉临时文件。
 *
 * `beforeRename` 是**给测试用的注入口**（生产路径不传）：它让「rename 之前崩掉」这个窗口
 * 可以被真的模拟一次，从而证明「失败不会留下半个目标文件」。没有它，测试只能断言
 * 「代码里出现了 tmp 字样」，那证明不了这条修复要证明的事。
 */
export function writeFileAtomic(file, text, { beforeRename = null } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, text, "utf8");
    if (typeof beforeRename === "function") beforeRename(tmp);
    renameSync(tmp, file);
  } catch (error) {
    // 崩在中途：把临时文件收掉（目标文件一个字节都没动过，读者看到的还是旧内容）。
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 收不掉也不该改判原错误——真正要报的是上面那个。
    }
    throw error;
  }
  return file;
}

/**
 * 把草稿写进 `<项目>/.mneme/pipelines/<id>.json`。
 *
 * 三条硬规矩：
 *   · `status` 不是 `draft` 就拒写——沉淀链只产草稿，固化是人的动作；
 *   · 目标文件已存在就拒写（`force` 才覆盖）——**已经在人手里的文件不能被机器改写**，
 *     否则人改过的措辞会被下一次挖掘悄悄冲掉；
 *   · 落盘走 `writeFileAtomic`——写一半就崩不能把整层工作流带走。
 */
export function writeDraftPipeline({ projectRoot, pipeline, force = false } = {}) {
  if (!projectRoot || String(projectRoot).trim() === "") return { ok: false, reason: "no-project-root", file: null };
  if (!pipeline || pipeline.status !== "draft") return { ok: false, reason: "not-draft", file: null, detail: "沉淀链只产 draft，升格要人点头" };
  let validated;
  try {
    validated = validatePipeline(pipeline, "<nudge-draft>");
  } catch (error) {
    return { ok: false, reason: "invalid", file: null, problems: error.problems || [String(error && error.message)] };
  }
  const dir = projectPipelineDir(projectRoot);
  const file = join(dir, `${validated.id}.json`);
  if (existsSync(file) && force !== true) return { ok: false, reason: "exists", file, id: validated.id };
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return { ok: true, reason: "written", file, id: validated.id, pipeline: validated };
}

/** 提议（候选）的家：`<memoryDir>/proposals/<项目键>/`——与绕行候选同一套分桶约定。 */
export function proposalDir({ memoryDir, projectRoot } = {}) {
  const key = projectKey(projectRoot);
  if (!key) return null;
  const base = expandHome(memoryDir && String(memoryDir).trim() ? memoryDir : "~/.dsh/memory");
  return join(base, "proposals", key);
}

/**
 * 提议的形状校验。比定稿松（它还不是工作流），但**判据那一栏的形状一个都不能少**。
 *
 * `counterfactual.verdict` 在这里**必须恰好是 `null`**（键也必须在，缺键 = `undefined` 也拒）。
 * 为什么这条要落在校验层、而不只靠产者自觉：`summarizeProposal` 会把 `verdict` 投影给面板，
 * 于是一份被人手改过、或被别的写入方塞进来的提议就能让面板显示一个机器给的判据结论——
 * 那正是本模块的头号红线。产者守规矩只是「产者的性质」，校验层拒绝才是「边界的性质」。
 */
export function validateProposal(raw) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: ["顶层必须是一个对象"] };
  if (typeof raw.id !== "string" || !/^nudge-[a-z0-9-]{4,64}$/.test(raw.id)) bad("id 必须是 nudge- 开头的小写 kebab");
  if (!PROPOSAL_STATUSES.includes(raw.status)) bad(`status 必须是 ${PROPOSAL_STATUSES.join(" / ")}`);
  if (!Array.isArray(raw.names) || raw.names.length === 0) bad("names 是序列本身，不能为空");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) bad("steps 至少要有一步");
  if (!Number.isInteger(raw.support) || raw.support < 1) bad("support 必须是正整数");
  // 反事实那一栏**必须存在**：可以是 null（还没算），但不能没有——没有它的候选不是候选。
  if (raw.counterfactual !== null) {
    if (typeof raw.counterfactual !== "object" || Array.isArray(raw.counterfactual)) {
      bad("counterfactual 要么是 null，要么是对象");
    } else if (raw.counterfactual.verdict !== null) {
      bad("counterfactual.verdict 必须是 null：判据只能由人回答，机器不许给出结论");
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 写一条提议（同 id 覆盖：同一段路再挖到应当并进同一条，而不是长出第二份）。落盘同样是原子的。 */
export function saveProposal(dir, proposal) {
  if (!dir) throw new Error("proposalDir 为空：拿不到项目根或 memoryDir");
  const v = validateProposal(proposal);
  if (!v.ok) throw new Error(v.problems.join("; "));
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, `${proposal.id}.json`), `${JSON.stringify(proposal, null, 2)}\n`);
  return proposal;
}

/** 读一个项目下的全部提议；坏文件不静默跳过（与定稿同一纪律，静默少一条最难查）。 */
export function loadProposals(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`${file}: JSON 解析失败：${error.message}`);
    }
    const v = validateProposal(raw);
    if (!v.ok) throw new Error(`${file}: ${v.problems.join("; ")}`);
    out.push(raw);
  }
  return out;
}

/** 清单行：面板与 agent 共用（与 `pipeline.js` 的 available[]、`candidates.js` 的清单对齐）。 */
export function summarizeProposal(proposal) {
  const cf = proposal.counterfactual || {};
  // 整条的风险取下限里的最高档：一段路的最坏情况才是它该被看待的档位。
  const rank = { R0: 0, R1: 1, R2: 2, R3: 3 };
  const riskFloor = (proposal.steps || []).reduce(
    (acc, s) => ((rank[s.risk] ?? 0) > rank[acc] ? s.risk : acc),
    "R0"
  );
  return {
    id: proposal.id,
    origin: proposal.origin || "nudge",
    status: proposal.status,
    sequence: (proposal.names || []).slice(),
    steps: (proposal.steps || []).length,
    support: proposal.support,
    occurrences: proposal.occurrences ?? null,
    firstSeenAt: proposal.firstSeenAt || null,
    lastSeenAt: proposal.lastSeenAt || null,
    // 反事实覆盖率：答过几步 / 一共几步。19/19 与 6/19 是两条不同的手法，清单上就该看得出来。
    contrast: {
      answered: (proposal.steps || []).filter((s) => Array.isArray(s.evidence) && s.evidence.length > 0).length,
      total: (proposal.steps || []).length
    },
    // 判据**永远**是 null，这里照实投影，免得有人以为它只是还没算。
    verdict: cf.verdict ?? null,
    riskFloor
  };
}

/**
 * 已经在跑的工作流的自精简提议：跳过 ≥3 次 → 提议删掉这一步；绕开 ≥3 次 → 提议重画路径。
 * 计数与阈值全部来自 `pipeline.js`（那份是权威），这里只做两件事：把提议包成
 * **要人点头的形状**（带一个封闭问题），并把它和「新手法候选」放进同一条通路。
 */
export function retirementProposals(pipeline, { runs = [], now = Date.now() } = {}) {
  const items = suggestRetirements(pipeline, { runs, now }).map((s) => ({
    kind: s.kind,
    pipelineId: pipeline.id,
    stepId: s.stepId,
    title: s.title,
    because: s.because,
    effect: s.effect,
    question:
      s.kind === "drop-step"
        ? "这一步被跳过这么多次，是「这几次正好不需要」还是「它对这条流程已经没用了」？"
        : "从这一步岔出去已经成了常态，是这条路径过时了，还是岔路该并进图里？",
    choices: s.kind === "drop-step" ? ["这次不需要", "这一步没用了", "不知道"] : ["路径过时了", "岔路该并进来", "不知道"],
    writeTo: s.kind === "drop-step" ? "steps[].removedBy（人批后改 status/version）" : "新版本的 steps[]"
  }));
  return { contract: "mneme.nudge/v1", pipelineId: pipeline.id, generatedAt: new Date(now).toISOString(), items };
}

/**
 * 一次完整的沉淀跑：读真实会话日志 → 挖候选 → 算能算的对照 → 把提议落进 memoryDir →
 * （可选）把草稿落进项目。
 *
 * 为什么默认不落草稿：落进仓库是会被 review、被提交的东西，一次自动跑就往里塞文件，
 * 会把「提议」变成「既成事实」。所以 `materialize` 默认 false——要落就得有人开口。
 *
 * **会话范围与项目归属是一件事，不是两件**：会话目录在 DSH 侧按工作区分桶，桶名是
 * 工作区路径的有损变形、规则不在本仓。所以「这个项目的手法」只有在调用方给出
 * **这个项目自己的 `sessionDir`** 时才成立。给了 `projectRoot` 却没给 `sessionDir`
 * 时，这一跑会被**降级成「无归属的普查」**：候选不带项目名、不写任何项目的提议桶、
 * 不落草稿——绝不允许拿全机会话去冒充某个项目的账（复核报告 §2.6）。
 */
export function nudgeFromSessions({
  sessionDir = null,
  dshHome = undefined,
  projectRoot = null,
  memoryDir = null,
  project = "",
  now = Date.now(),
  minSupport = NUDGE_MIN_SUPPORT,
  minLength = NUDGE_MIN_LENGTH,
  maxLength = NUDGE_MAX_LENGTH,
  maxResults = NUDGE_MAX_CANDIDATES,
  maxFiles = MAX_SESSION_FILES,
  failures = null,
  kinds = DEFAULT_NUDGE_KINDS,
  materialize = false
} = {}) {
  const scoped = typeof sessionDir === "string" && sessionDir.trim() !== "";
  const dir = scoped ? sessionDir : resolveSessionDir({ dshHome });
  // 扫描范围不在一个工作区内 → 不许有任何项目归属（连调用方自报的 project 也不认：
  // 那同样是「拿一批跨项目的观察去贴一个项目名」）。
  const attributionRefused = !scoped && Boolean(projectRoot || project);
  const allowedProjectRoot = attributionRefused ? null : projectRoot;
  const read = readSessionObservations({ sessionDir: dir, limit: maxFiles });
  const segments = segmentObservations(read.observations);
  const candidates = mineRepeatedPatterns(segments, { minSupport, minLength, maxLength, maxResults, kinds });
  const projectName = attributionRefused ? "" : project || (allowedProjectRoot ? projectLabel(allowedProjectRoot) : "");
  const failureSource = Array.isArray(failures) ? "caller" : "unwired";
  const enriched = candidates.map((c) => ({
    ...c,
    project: projectName,
    counterfactual: buildCounterfactual(c, { segments, failures, now })
  }));

  const propDir = attributionRefused ? null : proposalDir({ memoryDir, projectRoot: allowedProjectRoot });
  const saved = [];
  if (propDir) {
    for (const c of enriched) saved.push(saveProposal(propDir, c).id);
  }

  const drafts = [];
  const limit = materialize === true ? 1 : Number.isFinite(materialize) ? Math.max(0, Math.floor(materialize)) : 0;
  if (allowedProjectRoot && limit > 0) {
    for (const c of enriched.slice(0, limit)) {
      const made = draftFromCandidate(c, { project: projectName });
      if (!made.ok) {
        drafts.push({ id: c.id, ok: false, reason: "invalid", problems: made.problems, unanswered: made.unanswered });
        continue;
      }
      // `unanswered` 是草稿出口的一部分：调用方与面板据此知道「还有哪几步没人回答判据」。
      // 早前它被算出来又在出口丢掉，等于这条判据没有消费者。
      drafts.push({ id: c.id, unanswered: made.unanswered, ...writeDraftPipeline({ projectRoot: allowedProjectRoot, pipeline: made.pipeline }) });
    }
  }

  return {
    contract: "mneme.nudge/v1",
    generatedAt: new Date(now).toISOString(),
    // 归属被降级时把原因写在最外层：调用方不该错过这件事（它决定这批候选能不能信）。
    refused: attributionRefused
      ? {
          reason: "unscoped-sessions",
          detail: "给了 projectRoot/project 却没给 sessionDir：会话目录是按工作区分桶的，扫全部拿到的观察不属于任何单个项目。已按「无归属普查」处理——候选不带项目名、不写项目桶、不落草稿。要项目归属就传该项目自己的 sessionDir。"
        }
      : null,
    // 会话源的读数**原样带出来**：扫了几个文件、几帧解不出来、有没有被截断。
    source: {
      sessionDir: dir,
      scoped,
      present: read.present,
      readable: read.readable,
      truncated: read.truncated,
      totalFiles: read.totalFiles,
      scannedFiles: read.scannedFiles,
      frames: read.frames,
      failedFrames: read.failedFrames,
      observations: read.observations.length,
      unreadable: read.unreadable,
      // 失败记录是**没接线**还是**接进来了但一条都没有**，必须分开报（同 present/readable 那套）。
      failureSource
    },
    segments: segments.length,
    // 挖的是哪一层要跟着结果一起报出来：默认只有能力级，工具级要显式开。
    kinds: Array.isArray(kinds) ? kinds.slice() : null,
    project: projectName || null,
    proposalsDir: propDir,
    counts: {
      candidates: enriched.length,
      buckets: new Set(enriched.map((c) => c.bucket).filter(Boolean)).size,
      sessionsWithCandidates: new Set(enriched.flatMap((c) => c.sessions)).size,
      savedProposals: saved.length,
      draftsWritten: drafts.filter((d) => d.ok).length
    },
    available: enriched.map(summarizeProposal),
    drafts,
    // 「这一刀不做的事」写进契约里，免得以后有人以为忘了做。
    boundaries: {
      autoActivate: false,
      autoAnswerCounterfactual: false,
      writesOnlyDrafts: true,
      // 机器给的风险只是下限；R3 永远只能由人给。
      riskIsFloor: true,
      // 支持度只在同一个工作区桶内累加；跨桶不并账。
      crossProjectSupport: false
    }
  };
}
