/**
 * M.O. 候选层（candidates）：图上没有的路走过之后，先落在这里。
 *
 * 为什么要有这一层（设计约定，见 docs/WORKFLOWS.md 与本地形状草稿）：
 * 一张只会被照着走的图，会让 agent 失去自主性——它要么沉默地服从，要么沉默地偏离。
 * 所以图上必须留一个**合法的出口**：agent 可以判断「这条路这次可能不对」，
 * 按风险档选择记账先走（R0/R1）或停下问人（R2/R3）。
 * 走出来的那段路**不直接进仓库**，而是先变成这里的候选。
 *
 * 三层的关系，一句话：
 *   绕行 → 候选（本文件，住本地） → 定稿（<项目>/.mneme/pipelines/，进仓库）
 * 候选是定稿的**唯一入口**，而定稿只放人亲手批过的东西。
 *
 * 为什么候选不进仓库：
 * 它是草稿，一天可能长十条、死掉九条；进仓库就是垃圾，也会被当成规程引用。
 * 它的生命周期（没被再走到就归档）和记忆条目（留痕）本来就不同。
 *
 * 为什么候选的校验比定稿松：
 * 草稿本来就该是松的。定稿那边的 validatePipeline 要求 id/name/project/version/status/
 * done/trigger 与每一步的 phase/when/do/done/why 一个不缺——那是「要跑的东西」的标准。
 * 候选只有「一段走通了的路 + 为什么」，缺的字段在**升格那一刻**才补齐，
 * 并且补齐后照样要过 validatePipeline 那一关（见 promoteCandidate）。
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { validatePipeline, RISK_LEVELS } from "./pipeline.js";

/** 候选的状态机。`collecting` 还在攒次数，`proposed` 够格了在等人点头。 */
export const CANDIDATE_STATUSES = ["collecting", "proposed", "promoted", "dropped"];

/** 升格门槛：走过两次才算「不是偶然」——这条来自「复用第二次才算类型，第一次只是实例」。 */
export const PROMOTE_MIN_SEEN = 2;

/** 只走过一次、且这么久没再被走到 → 归档。归档不删文件，留着当负清单的邻居。 */
export const STALE_AFTER_DAYS = 30;

/**
 * 风险档的来源。自报是必须的，但**不能只靠自报**：
 * 「模型在自己上下文里给自己打分，会漏掉自己绝大多数错误」——
 * 所以除风险档之外还有一份机械的、可按字节审计的兜底清单（见 IRREVERSIBLE_PATTERNS）。
 */
export const RISK_SOURCES = ["self", "blacklist"];

/**
 * 不可逆/对外动作的**机械兜底清单**：绕行动作里只要命中任何一条，
 * 一律按最高档（R2）处理、停下问人，**不看它自报了什么风险档**。
 *
 * 为什么是清单而不是「让模型再判一次」：
 * 清单可以审计、可以 diff、可以事后追责；再判一次只是把同一个错误问两遍。
 * 判定只看**命令/工具调用的原文**（大小写与多余空白归一后做子串匹配），
 * 这是一条纯函数，不依赖任何模型判断。
 *
 * ⚠️ 两个坑，都在第一次冒烟里现形过：
 *
 * **其一，必须看子命令，不能只看工具名。** `gh pr` 既可能是 `view` / `list` / `checks`
 * （只读，随便跑），也可能是 `create` / `merge` / `close`（对外，必须拦）——差一个子命令，
 * 性质完全相反。第一版把 `gh pr` 整条写成 `requires`，结果「看一眼 PR」也被拦下了。
 * 所以条目拆成三层：`commands`（工具名）、`requires`（要求出现的子命令）、
 * `forbids`（出现就排除，用于兜住 `view`/`list` 这类只读子命令）。
 *
 * **其二，宁可漏报也不误报。** 误报会把只读绕行也推给人，直接毁掉「自主性住在 R0/R1」。
 * 所以每条只认准自己那个动作的词形，不做宽泛匹配。
 *
 * 这份清单是**准入判据**的一部分，改动要走 PR：加条目容易，删条目要能说清为什么。
 */
export const IRREVERSIBLE_PATTERNS = [
  // ── 推送与远端分支 ──────────────────────────────────────────────
  { id: "git-push", commands: ["git push"], why: "推到远端即离开本机（含 --tags / --force）" },
  // 轻量 tag 也是写（`git tag v1.0` 不带任何参数）——所以用 forbids 列**只读**特征，
  // 默认拦。第一版写成 requires:["-a","-s","-d","-f","-m"]，结果 `git tag v1.0.0` 漏过去了。
  { id: "git-tag-write", commands: ["git tag"], forbids: ["-l", "--list", "-n ", "-v ", "--verify"], why: "打 tag 是发布链的入口" },
  // ── GitHub ─────────────────────────────────────────────────────
  // 只读子命令明确排除；其余按写处理（`gh pr` 后面接的不是已知只读词，就当它要写）。
  { id: "gh-pr-write", commands: ["gh pr"], forbids: ["view", "list", "checks", "diff", "status"], why: "开/改/合 PR 是对外动作" },
  { id: "gh-release-write", commands: ["gh release"], forbids: ["view", "list"], why: "发 Release 是对外发布" },
  { id: "gh-issue-write", commands: ["gh issue"], forbids: ["view", "list", "status"], why: "提/改 issue 是对外说话" },
  // `gh api` 的默认是 GET（只读）——**不写方法就放行**，所以这条必须用 requires：
  // 只有显式写出写方法才拦。用 forbids 表达不了「默认安全」这件事（不写方法时两个特征
  // 都不出现，forbids 不成立、规则照样命中，于是只读调用被误拦）。
  // 教训：**requires 表达「必须出现才算数」，forbids 表达「出现就排除」——
  // 对「默认安全、显式才危险」的动作只能用 requires。**
  { id: "gh-api-write", commands: ["gh api"], requires: ["-x post", "-x put", "-x patch", "-x delete", "-f ", "--field", "--input", "-x post"], why: "gh api 默认 GET 只读，显式写方法与字段才算写" },
  { id: "gh-workflow-run", commands: ["gh workflow run"], why: "触发工作流（可能发布）" },
  { id: "gh-repo-write", commands: ["gh repo"], forbids: ["view", "list"], why: "改仓库设置" },
  // ── 发布 ───────────────────────────────────────────────────────
  { id: "npm-publish", commands: ["npm publish"], why: "registry 不允许覆盖已发布版本" },
  { id: "yarn-publish", commands: ["yarn publish"], why: "同上" },
  { id: "pnpm-publish", commands: ["pnpm publish"], why: "同上" },
  // ── 对外写请求 ─────────────────────────────────────────────────
  { id: "curl-write", commands: ["curl"], requires: ["-x post", "-x put", "-x patch", "-x delete", "--request post", "--request put", "--request patch", "--request delete", "--data", "-d "], why: "对外写请求" },
  { id: "wget-post", commands: ["wget"], requires: ["--post-data", "--post-file"], why: "对外写请求" },
  // ── 凭据与权限 ─────────────────────────────────────────────────
  { id: "gh-secret", commands: ["gh secret"], why: "改凭据" },
  { id: "gh-auth-write", commands: ["gh auth"], forbids: ["status", "token"], why: "改鉴权身份（status/token 是只读）" },
  // ── 破坏性删除 ─────────────────────────────────────────────────
  { id: "rm-rf", commands: ["rm -rf", "rm -fr"], why: "不可逆删除" },
  { id: "rmdir-recursive", commands: ["rmdir /s"], why: "Windows 递归删除" },
  { id: "remove-item-recurse", commands: ["remove-item"], requires: ["-recurse"], why: "PowerShell 递归删除" },
  { id: "drop-table", commands: ["drop table"], why: "删数据" }
];

function normCommand(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim().toLowerCase();
}

/** 单条规则是否命中：工具名要出现，`requires` 至少一个要出现，`forbids` 一个都不许出现。 */
function matchesPattern(text, entry) {
  const commands = Array.isArray(entry.commands) ? entry.commands : [entry.commands];
  if (!commands.some((c) => text.includes(normCommand(c)))) return false;
  if (Array.isArray(entry.forbids) && entry.forbids.some((f) => text.includes(normCommand(f)))) return false;
  if (Array.isArray(entry.requires) && !entry.requires.some((r) => text.includes(normCommand(r)))) return false;
  return true;
}

/**
 * 扫一段绕行动作里有没有不可逆/对外的信号。
 * @returns {{hit: boolean, matches: Array<{id: string, why: string}>}}
 */
export function scanIrreversible(actions) {
  const list = Array.isArray(actions) ? actions : [actions];
  const matches = [];
  for (const raw of list) {
    const text = normCommand(typeof raw === "string" ? raw : raw && (raw.command || raw.tool));
    if (!text) continue;
    for (const entry of IRREVERSIBLE_PATTERNS) {
      if (matchesPattern(text, entry) && !matches.some((m) => m.id === entry.id)) {
        matches.push({ id: entry.id, why: entry.why });
      }
    }
  }
  return { hit: matches.length > 0, matches };
}

const RISK_ORDER = { R0: 0, R1: 1, R2: 2, R3: 3 };
const maxRisk = (a, b) => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);

/**
 * 绕行的分档判定——**这一刀的核心规则**（2026-10-16 定档：B 档）。
 *
 *   自报风险档 ∈ {R0, R1} 且 不跨闸门 且 兜底清单没命中
 *       → "model"：记账先走（自主性住在这里）
 *   否则
 *       → "human"：停下等点头（刚性只住在这里）
 *
 * 三条各自独立、都要过：
 *  1. **风险档**：这是自报的，单靠它不够。
 *  2. **兜底清单**：机械匹配，不看自报——自报说 R0 但命令里有 `git push`，照样拦。
 *     这正是「模型给自己打分不可靠」的直接应用，不是不信任，是不给单点。
 *  3. **闸门保护**：这条绕行如果走下去，图上某个 gate 会不会永远不被经过？
 *     会 → 拦住。**与风险档无关**：闸门本来就放在「错了很难撤」的地方，
 *     绕开它等于把安全阀绕掉，哪怕这条绕行本身全是只读动作。
 */
export function decideDetour({ risk = "R0", actions = [], crossesGate = false } = {}) {
  const selfRisk = RISK_LEVELS.includes(risk) ? risk : "R2"; // 自报非法 → 按最保守的档
  const scan = scanIrreversible(actions);
  const blockedByBlacklist = scan.hit;
  const blockedByGate = crossesGate === true;
  const blockedByRisk = RISK_ORDER[selfRisk] >= RISK_ORDER.R2;

  const reasons = [];
  if (blockedByRisk) reasons.push(`自报风险档 ${selfRisk}`);
  if (blockedByBlacklist) reasons.push(`兜底清单命中：${scan.matches.map((m) => m.id).join(" / ")}`);
  if (blockedByGate) reasons.push("会让图上的闸门永远不被经过");

  if (!reasons.length) {
    return {
      decidedBy: "model",
      risk: selfRisk,
      reason: "R0/R1 且不跨闸门、兜底清单未命中：记账先走",
      scan
    };
  }
  // 停下问人时，风险档按「自报与命中项的较高者」记，便于结算卡上看得准。
  const effective = blockedByBlacklist || blockedByGate ? maxRisk(selfRisk, "R2") : selfRisk;
  return { decidedBy: "human", risk: effective, reason: reasons.join("；"), scan };
}

/**
 * 项目根 → 稳定的短键。**不把绝对路径写进文件名**（那里面是本机用户名），
 * 但又要同一个项目每次算到同一个键，所以取「目录名 + 路径哈希前 8 位」。
 */
export function projectKey(projectRoot) {
  const root = String(projectRoot || "").trim();
  if (root === "") return null;
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  // 两种分隔符都要认，**不能借 path.basename()**：它跟着运行平台走，posix 上
  // `\` 不是分隔符，一条 Windows 路径会被整条当成文件名——清洗后用户名的残片
  // 就进了目录名（Linux CI 实抓：C--Users-someone-Desktop-dsh-mne）。
  // Windows 腿对这条**结构性看不见**（win32.basename 两种分隔符都认），所以回归锁
  // 只在 ubuntu 矩阵腿上有杀伤力，别因为它在 Windows 上绿就以为它没用。
  const name = (root.split(/[\\/]/).filter((s) => s !== "").pop() || "project")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 32);
  return `${name}-${hash}`;
}

/** 展开 `~`；候选层跟 `memoryDir` 一样是本地状态，不是仓库内容。 */
function expandHome(p) {
  const s = String(p || "");
  if (s === "~") return homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(homedir(), s.slice(2));
  return s;
}

/** 候选层的家：`<memoryDir>/candidates/<项目键>/`。memoryDir 为空时退回默认。 */
export function candidateDir({ memoryDir, projectRoot } = {}) {
  const base = expandHome(memoryDir && memoryDir.trim() ? memoryDir : "~/.dsh/memory");
  const key = projectKey(projectRoot);
  if (!key) return null;
  return join(base, "candidates", key);
}

/**
 * 候选的形状校验——比定稿松，但**有几个字段一个都不能少**：
 * 没有 reason 的绕行不叫绕行，叫乱走；没有 outcome 的记录没法参与任何判断。
 */
export function validateCandidate(raw, file = "<candidate>") {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problems: ["顶层必须是一个对象"] };
  }
  if (typeof raw.id !== "string" || !/^cand-[a-z0-9-]{4,64}$/.test(raw.id)) {
    bad("id 必须是 cand- 开头的小写 kebab");
  }
  if (typeof raw.origin !== "string" || !["detour", "manual"].includes(raw.origin)) {
    bad("origin 必须是 detour / manual");
  }
  if (typeof raw.reason !== "string" || raw.reason.trim() === "") {
    // 这条是**硬要求**：写不出「为什么觉得这条路可能不对」，就不是绕行。
    bad("reason 必填——写不出理由就不许绕");
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    bad("steps 至少要有一步");
  } else {
    raw.steps.forEach((s, i) => {
      if (!s || typeof s !== "object") return bad(`steps[${i}] 必须是对象`);
      for (const key of ["title", "when", "do", "done"]) {
        if (typeof s[key] !== "string" || s[key].trim() === "") bad(`steps[${i}].${key} 必须是非空字符串`);
      }
      if (!RISK_LEVELS.includes(s.risk)) bad(`steps[${i}].risk 必须是 ${RISK_LEVELS.join(" / ")}`);
    });
  }
  if (!Array.isArray(raw.seen)) bad("seen 必须是数组（可以为空）");
  if (!CANDIDATE_STATUSES.includes(raw.status)) {
    bad(`status 必须是 ${CANDIDATE_STATUSES.join(" / ")}`);
  }
  return { ok: problems.length === 0, problems, file };
}

/** 一条候选的 id：按「项目 + 步骤形状」定，所以同一段路走两次会落到同一条候选上。 */
export function candidateId(steps) {
  const shape = (Array.isArray(steps) ? steps : [])
    .map((s) => `${s && s.title ? String(s.title).trim() : ""}`)
    .join(" → ");
  return `cand-${createHash("sha256").update(shape).digest("hex").slice(0, 12)}`;
}

/** 读一个项目下的全部候选；坏文件不静默跳过（与定稿同一纪律）。 */
export function loadCandidates(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`${file}: JSON 解析失败：${error.message}`);
    }
    const v = validateCandidate(raw, file);
    if (!v.ok) throw new Error(`${file}: ${v.problems.join("; ")}`);
    out.push(raw);
  }
  return out;
}

/** 写一条候选（幂等：同 id 覆盖，但 seen 会合并去重）。 */
export function saveCandidate(dir, candidate) {
  if (!dir) throw new Error("candidateDir 为空：拿不到项目根或 memoryDir");
  const v = validateCandidate(candidate);
  if (!v.ok) throw new Error(v.problems.join("; "));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${candidate.id}.json`), JSON.stringify(candidate, null, 2), "utf8");
  return candidate;
}

/**
 * 记一次绕行。两次走同一段路会并进同一条候选——这正是「复用第二次才算类型」的落点。
 * 返回 `{ candidate, created, promotedNow }`。
 */
export function recordDetour(dir, { steps, reason, outcome = "unknown", evidence = [], runId = null, sessionId = null, now = Date.now() } = {}) {
  const id = candidateId(steps);
  const existing = loadCandidates(dir).find((c) => c.id === id) || null;
  const at = new Date(now).toISOString();
  const entry = { runId, sessionId, at, outcome, evidence: Array.isArray(evidence) ? evidence.slice() : [] };

  if (!existing) {
    const candidate = {
      id,
      origin: "detour",
      steps: (steps || []).map((s) => ({
        title: s.title, when: s.when, do: s.do, done: s.done, risk: s.risk
      })),
      reason,
      counterfactual: null,
      seen: [entry],
      status: "collecting",
      createdAt: at
    };
    saveCandidate(dir, candidate);
    return { candidate, created: true, promotedNow: false };
  }

  existing.seen = Array.isArray(existing.seen) ? existing.seen : [];
  existing.seen.push(entry);
  if (!existing.reason && reason) existing.reason = reason;
  const promotedNow = maybePropose(existing);
  saveCandidate(dir, existing);
  return { candidate: existing, created: false, promotedNow };
}

/**
 * 够格就翻成 `proposed`——**只是「够格被提议」，不是「自动进图」**。
 * 两条都要满足：走过两次（且至少一次 worked）、且写得出反事实。
 * 第二条不由代码判断（它是人话），所以这里只翻状态、把缺口标出来，由提议时补齐。
 */
export function maybePropose(candidate) {
  if (!candidate || candidate.status !== "collecting") return false;
  const seen = Array.isArray(candidate.seen) ? candidate.seen : [];
  const worked = seen.filter((s) => s && s.outcome === "worked").length;
  if (seen.length >= PROMOTE_MIN_SEEN && worked >= 1) {
    candidate.status = "proposed";
    candidate.proposedAt = new Date().toISOString();
    return true;
  }
  return false;
}

/** 长期没被再走到 → 归档。归档**不删文件**（留着当负清单的邻居），只换状态。 */
export function archiveStale(dir, { now = Date.now(), staleAfterDays = STALE_AFTER_DAYS } = {}) {
  const archived = [];
  for (const c of loadCandidates(dir)) {
    if (c.status !== "collecting") continue;
    const seen = Array.isArray(c.seen) ? c.seen : [];
    if (seen.length >= PROMOTE_MIN_SEEN) continue;
    const last = seen.length ? Date.parse(seen[seen.length - 1].at) : Date.parse(c.createdAt || "");
    if (!Number.isFinite(last)) continue;
    if ((now - last) / 86400000 > staleAfterDays) {
      c.status = "dropped";
      c.droppedReason = `只走过 ${seen.length} 次，${staleAfterDays} 天内没再被走到`;
      saveCandidate(dir, c);
      archived.push(c.id);
    }
  }
  return archived;
}

/**
 * 升格：把候选补成一份**合法的定稿**，但**只返回内容，不写盘**。
 *
 * 为什么不直接写进仓库：提交是 R1、推送是 R2，分开两档，人始终握着一道。
 * 调用方拿到 `{ ok, pipeline, problems }` 之后自己决定怎么落（写文件 + 请人 review + commit）。
 * 补出来的东西照样要过 validatePipeline——**升格不是降低标准，是补齐标准**。
 */
export function promoteCandidate(candidate, { name, project, done = "", trigger = [], steps = null } = {}) {
  const raw = {
    id: candidate.id.replace(/^cand-/, ""),
    name: name || candidate.reason || candidate.id,
    project: project || "",
    version: 0,
    status: "active",
    done: done || `${candidate.steps.length} 步全部有归属，且每一步的完成判据都被满足`,
    trigger: trigger.length ? trigger : [{ kind: "phrase", value: "走这条路" }],
    steps: (steps || candidate.steps).map((s, i) => ({
      id: s.id || `S${i + 1}`,
      phase: s.phase || "流程",
      title: s.title,
      when: s.when,
      do: s.do,
      who: s.who || "main",
      tool: s.tool || "",
      done: s.done,
      risk: s.risk,
      needs: Array.isArray(s.needs) ? s.needs : (i === 0 ? [] : [`S${i}`]),
      why: s.why || candidate.reason || "",
      // 反事实对照：候选上如果记了就用它——它是**准入判据**，不是备注。
      evidence: s.evidence || (candidate.counterfactual ? [candidate.counterfactual] : []),
      gate: s.gate === true
    }))
  };
  try {
    return { ok: true, pipeline: validatePipeline(raw, candidate.id), problems: [] };
  } catch (error) {
    return { ok: false, pipeline: null, problems: error.problems || [String(error && error.message)] };
  }
}

/** 候选的清单行（面板与 agent 共用的投影，与定稿的 available[] 对齐）。 */
export function summarizeCandidate(candidate) {
  const seen = Array.isArray(candidate.seen) ? candidate.seen : [];
  const worked = seen.filter((s) => s && s.outcome === "worked").length;
  const failed = seen.filter((s) => s && s.outcome === "failed").length;
  return {
    id: candidate.id,
    title: candidate.steps && candidate.steps[0] ? candidate.steps[0].title : candidate.id,
    origin: candidate.origin,
    reason: candidate.reason,
    status: candidate.status,
    steps: (candidate.steps || []).length,
    // 风险档取这条路上最高的那一档：整段路的「最坏情况」才是它该被看待的档位。
    risk: (candidate.steps || []).reduce((acc, s) => maxRisk(acc, s.risk || "R0"), "R0"),
    seen: seen.length,
    worked,
    failed,
    lastSeenAt: seen.length ? seen[seen.length - 1].at : null,
    counterfactual: candidate.counterfactual || null
  };
}

/** 面板与 agent 的公共入口：一个项目下的候选清单 + 各自的可用动作。 */
export function readCandidateDoc({ memoryDir, projectRoot, now = Date.now() } = {}) {
  const dir = candidateDir({ memoryDir, projectRoot });
  const items = dir ? loadCandidates(dir).map(summarizeCandidate) : [];
  return {
    contract: "mneme.candidates/v1",
    dir,
    projectKey: projectKey(projectRoot),
    counts: {
      collecting: items.filter((i) => i.status === "collecting").length,
      proposed: items.filter((i) => i.status === "proposed").length,
      promoted: items.filter((i) => i.status === "promoted").length,
      dropped: items.filter((i) => i.status === "dropped").length
    },
    available: items,
    // 「这一刀不做的事」也写进契约里，免得以后有人以为忘了做。
    boundaries: {
      autoPromote: false,
      autoApprove: false,
      injectIntoMemory: false
    }
  };
}

/** 删一条候选：只在人明确要求时用。 */
export function removeCandidate(dir, id) {
  const p = join(dir, `${id}.json`);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

export { dirname as _dirname };
