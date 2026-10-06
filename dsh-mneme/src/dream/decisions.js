import { STR, langOf } from "../lang.js";

// Issue #126：sleepActionSet="full" 时新增两个动作——supersede（演进：新版取代
// 旧版）与 differentiate（互补：两条都留、各追加差异注记）。两者的校验与执行都
// 复用既有 merge/conflict 的机制（winner/loser、casGuard、transaction、receipt）。
// 调用方（sleep）按档位派生「本档允许的动作集合」时需要读它，故导出。
export const ACTIONS = new Set(["keep", "merge", "archive", "conflict", "update", "create", "supersede", "differentiate"]);

// Epistemic trust (v0.4.5): when config.trustEpistemicWeighting is on, merge
// keepSource and conflict winners prefer the higher-trust memory. Higher value
// = preferred. observation (measured) > inferred (derived) > subjective (guess).
const EPISTEMIC_PRIORITY = { observation: 3, inferred: 2, subjective: 1 };

// Issue #104 方向 2：archive 类型护栏的长保留类型集合——这些类型的存在意义
// 就是长期保存（踩坑记录、约束、用户偏好、挖掘出的模式），LLM 以「价值判断」
// 类理由批量归档它们时误伤损失最大。conflict 裁决的败者归档不经过 archive
// action（走 applyDecisions 的 conflict 分支），不受此护栏影响。
const ARCHIVE_GUARDED_TYPES = new Set(["preference", "pattern", "rejected_solution", "constraint", "pitfall"]);
// 「重复 / 过时」类理由的关键词（中英双语）。命中才允许归档长保留类型；
// 词表宁可放宽也不误拦——护栏只跳过单条并落明细，不整单拒绝。
const ARCHIVE_RATIONALE_RE = /重复|过时|陈旧|过期|已被取代|被取代|冗余|不再使用|旧版|废弃|stale|outdated|obsolete|dup(?:licate|licat)?|superseded|redundant|deprecated|expired|replaced/i;

/**
 * Validate a dream decision list against a snapshot of eligible memories.
 * @param decisions - LLM-produced decision list. In skipInvalid mode, invalid
 *   entries are spliced out of this array in place (the caller reuses the same
 *   reference downstream for apply/audit); implicit keeps are appended here too.
 * @param snapshot - Map<id, memory> of eligible (non-archived, non-summary) entries.
 * @returns {{ok: boolean, errors: string[], skipped?: Array<{index, action, ids, error}>,
 *   resolvedShortIds?: number}}
 */
export function validateDecisions(decisions, snapshot, options = {}) {
  const errors = [];
  // Issue #89 回归修复（v0.6.9 / Issue #26 的 skipInvalid 路径原样移植，该路径
  // 在 v0.7.11 重写中丢失）：skipInvalid 开启时，单条非法决策只跳过该条（记录
  // 到 skipped、不 claim 任何 id），合法子集照常应用，调用方据此把 run 记为
  // degraded。全局信号（update/create 上限、显式覆盖率下限）依旧整单拒绝——
  // 刷爆上限或覆盖率不达标的输出是模型坏了，不是轻微 schema 漂移。
  const skipped = [];
  const survivors = [];
  const skipInvalid = options.skipInvalid === true;
  const maxUpdatePerRun = options.maxUpdatePerRun ?? 2;
  const minAgeHours = options.minAgeHours ?? 24;
  // Issue #126 review（Copilot）：档位白名单。sleepActionSet 默认档只换 prompt 是
  // 不够的——ACTIONS 是两个模块共用的，模型自发出 supersede / differentiate 时校验器
  // 照样放行，"opt-in 零行为变化"就成了空话。省略 / null = 不限制（沿用全局 ACTIONS）。
  const allowedActions = Array.isArray(options.allowedActions) ? new Set(options.allowedActions) : null;
  if (!Array.isArray(decisions)) {
    return { ok: false, errors: ["decision list must be an array"], resolvedShortIds: 0 };
  }
  // 空决策 = 模型完整评估后确认无需操作（CONSOLIDATION_PROMPT 明确允许"无问题的
  // 条目无需输出"）。合法 JSON [] 不是空体（那是无输出/截断），也不是"残缺输出"
  // ——显式短路直接 ok，避免隐式 keep 的覆盖率检查把 0% 误判为模型坏了。与
  // sleep 的空模式（skipped no-op）语义对齐：下游 applied=0、audit 记 ok。
  if (decisions.length === 0) {
    return { ok: true, errors: [], skipped: [], resolvedShortIds: 0 };
  }
  // Issue #135：模型常把 36 位 UUID 回填成前缀（实测 78/78 个 8 位前缀都能唯一
  // 对应窗口内真实记忆，且 few-shot 示例的 "m1"/"m2" 占位符在诱导这种缩写），而
  // 下方校验用 snapshot.get(id) 整串精确匹配 → 全部 unknown id → claimed=0 →
  // 覆盖率闸整单拒绝，一整轮语义成果被丢。校验前先把「唯一前缀」解析回完整 id
  // （git 短哈希式）：仅在 snapshot 内解析，有歧义或匹配不到就原样保留，仍由下
  // 方 unknown id 校验如实报错。就地改写 ids / keepSource / winner / loser，下
  // 游 applyDecisions 与审计拿到的同样是完整 id。
  let resolvedShortIds = 0;
  const resolveShortId = (value) => {
    if (typeof value !== "string" || snapshot.has(value)) return value;
    // 太短不猜（歧义概率高）；长度 ≥36 说明不是前缀缩写，交给校验如实报错。
    if (value.length < 8 || value.length >= 36) return value;
    let hit = null;
    let matches = 0;
    for (const id of snapshot.keys()) {
      if (id.startsWith(value)) {
        hit = id;
        if (++matches > 1) return value; // 有歧义，不解析
      }
    }
    if (matches === 1) {
      resolvedShortIds++;
      return hit;
    }
    return value;
  };
  for (const d of decisions) {
    if (!d || typeof d !== "object") continue;
    if (Array.isArray(d.ids)) d.ids = d.ids.map(resolveShortId);
    if (typeof d.keepSource === "string") d.keepSource = resolveShortId(d.keepSource);
    if (typeof d.winner === "string") d.winner = resolveShortId(d.winner);
    if (typeof d.loser === "string") d.loser = resolveShortId(d.loser);
  }
  const claimed = new Set();
  for (const [index, d] of decisions.entries()) {
    const at = `decision[${index}]`;
    // 单条校验错误先进 local：skipInvalid 模式下整条跳过，严格模式下才并入
    // 全局 errors（沿用 v0.6.9 的双轨结构）。
    const local = [];
    // Issue #126：supersede 与 conflict 一样用 winner/loser 定位双方（沿用同一套
    // 字段，校验与 receipt 逻辑因此可以直接复用）。
    const ids = d && (d.action === "conflict" || d.action === "supersede") ? [d.winner, d.loser] : (d?.ids ?? []);
    if (!d || typeof d !== "object" || !ACTIONS.has(d.action)) {
      local.push(`${at}: invalid action ${JSON.stringify(d?.action)}`);
    } else if (allowedActions && !allowedActions.has(d.action)) {
      // 动作本身合法，但不在当前档位允许的集合里（例如默认档收到 supersede）。
      local.push(`${at}: action ${JSON.stringify(d.action)} not allowed in this mode`);
    } else if (d.action === "conflict" || d.action === "supersede") {
      if (!d.winner || !d.loser || d.winner === d.loser) {
        local.push(`${at}: ${d.action} needs distinct winner and loser`);
      }
    } else if (d.action === "differentiate") {
      // Issue #126：互补型——两条都留下、各追加差异注记。ids 必须 ≥2（随后走下方
      // 通用 id 校验：unknown / archived / summary / 重复 claim），distinctions 必须
      // 非空，否则会写出空注记（写了等于没写，还会污染正文）。
      if (!Array.isArray(d.ids) || d.ids.length < 2) {
        local.push(`${at}: differentiate needs at least two ids`);
      } else if (!Array.isArray(d.distinctions) || !d.distinctions.some((s) => typeof s === "string" && s.trim())) {
        local.push(`${at}: differentiate needs a non-empty distinctions array`);
      }
    } else if (d.action === "create") {
      // Mint a fresh memory (sleep pattern discovery). Claims no existing id,
      // so it skips the claiming loop below; evidence is optional provenance
      // (already filtered to real ids by the caller) and is stored in content.
      if (typeof d.title !== "string" || !d.title.trim()) {
        local.push(`${at}: create needs non-empty title`);
      }
      if (typeof d.content !== "string" || !d.content.trim()) {
        local.push(`${at}: create needs non-empty content`);
      }
      if (d.importance !== undefined && (!Number.isInteger(d.importance) || d.importance < 1 || d.importance > 5)) {
        local.push(`${at}: create importance must be an integer 1-5 when provided`);
      }
      if (typeof d.type !== "string" || !d.type.trim()) {
        local.push(`${at}: create needs non-empty type`);
      }
    } else if (!Array.isArray(d.ids) || d.ids.length === 0) {
      local.push(`${at}: ${d.action} needs non-empty ids`);
    }
    // update-specific field validation runs BEFORE claiming ids, so a failing
    // update never pollutes the claimed set (which drives the "every id must
    // appear in a decision" check below).
    // Issue #104 方向 2：archive 类型护栏。长保留类型的 archive 决策必须携带
    // 「重复 / 过时」类理由（提示词对 archive 的定义本就如此），「价值判断」类
    // 理由（保持整洁、参考价值低……）不放行——单条跳过记 skipped（run 记
    // degraded，明细进 dream_runs.skipped），绝不整单拒绝。未知 id 在下方通用
    // 校验里另行报错，这里 snapshot.get 为 undefined 时跳过护栏判断。
    if (local.length === 0 && d?.action === "archive") {
      const guardedTypes = new Set();
      for (const id of d.ids) {
        const mem = snapshot.get(id);
        if (mem && ARCHIVE_GUARDED_TYPES.has(mem.type)) guardedTypes.add(mem.type);
      }
      if (guardedTypes.size > 0 && !ARCHIVE_RATIONALE_RE.test(String(d.reason ?? ""))) {
        local.push(`${at}: archive of long-retention type(s) ${[...guardedTypes].join(", ")} needs a duplicate/outdated rationale (重复/过时), got: ${JSON.stringify(String(d.reason ?? "")).slice(0, 60)}`);
      }
    }
    if (local.length === 0 && d?.action === "update") {
      // 只能更新单条
      if (!Array.isArray(d.ids) || d.ids.length !== 1) {
        local.push(`${at}: update must target exactly one id`);
      } else {
        // 必须产生实际变化
        const mem = snapshot.get(d.ids[0]);
        const hasChange = (d.title !== undefined && d.title !== mem?.title)
          || (d.content !== undefined && d.content !== mem?.content)
          || (d.importance !== undefined && d.importance !== mem?.importance);
        if (!hasChange) {
          local.push(`${at}: update must change at least one field`);
        } else if (mem?.type === "summary") {
          // 不能更新 summary
          local.push(`${at}: cannot update summary via update action`);
        } else {
          // 保护期：新建记忆不可立即被 update（可配置）
          const ageHours = (Date.now() - new Date(mem?.created_at).getTime()) / 3600000;
          if (ageHours < minAgeHours) {
            local.push(`${at}: memory too young (< ${minAgeHours}h)`);
          }
        }
      }
    }
    if (local.length === 0 && d && d.action !== "create") {
      // seen 捕获同一条决策内的重复 id；claimed 只含先前存活决策的 id
      // （被跳过的决策不 claim，其目标留给其它合法决策/隐式 keep）。
      const seen = new Set();
      for (const id of ids) {
        const mem = snapshot.get(id);
        if (!mem) {
          local.push(`${at}: unknown id ${JSON.stringify(id)}`);
        } else if (mem.archived || mem.type === "summary") {
          local.push(`${at}: id ${JSON.stringify(id)} is archived or summary (not eligible)`);
        }
        if (claimed.has(id) || seen.has(id)) {
          local.push(`${at}: id ${JSON.stringify(id)} claimed by multiple decisions`);
        }
        seen.add(id);
      }
      if (local.length === 0 && d.action === "merge") {
        if (!d.keepSource || !d.ids.includes(d.keepSource)) {
          local.push(`${at}: merge keepSource must be one of ids`);
        }
        if (typeof d.title !== "string" || !d.title.trim() || typeof d.content !== "string" || !d.content.trim()) {
          local.push(`${at}: merge needs non-empty title and content`);
        }
        if (d.importance !== undefined && (!Number.isInteger(d.importance) || d.importance < 1 || d.importance > 5)) {
          local.push(`${at}: merge importance must be an integer 1-5 when provided`);
        }
        // Merging across types would blur preference/project/decision boundaries
        // in the injected context; the snapshot carries each entry's type.
        // Issue #26 (P1)：默认禁止跨类型合并。用户显式开启 allowCrossTypeMerge
        // 后放宽该检查，类型边界由用户自行承担。
        const mergeTypes = new Set(d.ids.map((id) => snapshot.get(id)?.type));
        if (mergeTypes.size > 1 && options.allowCrossTypeMerge !== true) {
          local.push(`${at}: merge ids span multiple types (${[...mergeTypes].join(", ")})`);
        }
        // issue #339 / E8 考卷：merge 护栏（默认开，dreamMergeGuard）。巩固损耗
        // 实测里 10/26 条被丢约束已归位 guarded 类型仍被 merge 吃掉——archive
        // 护栏（上方）只挡 archive 不挡 merge，而 merge 的「更精炼摘要」恰是
        // 约束失真的主通道。开启后被合并对象命中 ARCHIVE_GUARDED_TYPES 的
        // merge 决策整条跳过（与 archive 护栏同款通道：skipInvalid 时 skipped
        // 明细、严格模式整单拒绝）。
        if (local.length === 0 && options.mergeGuard === true) {
          const guardedTypes = new Set();
          for (const id of d.ids) {
            const mem = snapshot.get(id);
            if (mem && ARCHIVE_GUARDED_TYPES.has(mem.type)) guardedTypes.add(mem.type);
          }
          if (guardedTypes.size > 0) {
            local.push(`${at}: merge of long-retention type(s) ${[...guardedTypes].join(", ")} is blocked by dreamMergeGuard`);
          }
        }
      }
    }
    if (local.length > 0) {
      if (skipInvalid) {
        // 单条非法 → 跳过该决策，不 claim id（其目标记忆留给其它合法决策/隐式
        // keep），并记录到 skipped 供调用方日志/审计。信息性跳过绝不写入全局
        // errors，否则会误触发下方的整单拒绝。
        skipped.push({ index, action: d?.action, ids, error: local.join("; ") });
      } else {
        errors.push(...local);
      }
      continue;
    }
    if (d.action !== "create") {
      for (const id of ids) claimed.add(id);
    }
    survivors.push(d);
  }
  // Cap update churn: too many edits in one cycle signals a runaway model.
  // 全局信号——skipInvalid 模式下依旧整单拒绝（见函数头注释）。
  const updateCount = survivors.filter((d) => d.action === "update").length;
  if (updateCount > maxUpdatePerRun) {
    errors.push(`too many update decisions: ${updateCount} > ${maxUpdatePerRun}`);
  }
  // Cap pattern minting per run (sleepMaxPatternPerRun passes through here).
  const createCount = survivors.filter((d) => d.action === "create").length;
  const maxCreatePerRun = options.maxCreatePerRun ?? 5;
  if (createCount > maxCreatePerRun) {
    errors.push(`too many create decisions: ${createCount} > ${maxCreatePerRun}`);
  }
  // Issue #104 方向 2：archive 批量上限——一次性大扫除（12 条互不相关主题被
  // 批量归档）是失控信号，与 update 上限同一类全局闸门：skipInvalid 也不豁免，
  // 超限整单拒绝；正常的大规模清理由用户调高 dreamMaxArchivePerRun。
  const archiveCount = survivors.filter((d) => d.action === "archive").length;
  const maxArchivePerRun = options.maxArchivePerRun ?? 8;
  if (archiveCount > maxArchivePerRun) {
    errors.push(`too many archive decisions: ${archiveCount} > ${maxArchivePerRun}`);
  }
  // Issue #89 防洗白核心（#104 方向 1 重审后保留）：全部决策都被跳过、合法
  // 子集为空时仍整单拒绝——宽容的前提是「有合法子集可应用」；模型输出整体
  // 非法（如全部幻觉 id）是真故障，不能被隐式 keep 洗成 ok。#104 只豁免
  // 「有合法子集但覆盖率不足」的良性挑重点（见下方 coverageShortfall）。
  if (options.skipInvalid === true && skipped.length > 0 && survivors.length === 0 && errors.length === 0) {
    errors.push(`all ${skipped.length} decision(s) invalid — nothing valid survived validation`);
    return { ok: false, errors, skipped, resolvedShortIds };
  }
  // v0.4.4: 隐式 keep。默认（dreamImplicitKeep !== false）下，未 claim 的
  // snapshot 记忆自动补 {action:"keep"}，而不是整体拒绝——大记忆量下 LLM 漏报
  // 一两条就全拒（636 记忆 → 677 errors）会白白浪费整轮 run。设 false 则保留
  // 旧的严格"全量覆盖"校验。补齐的 keep 直接 append 到 decisions，调用方
  // （runDream/applyDecisions/audit）复用同一数组即可覆盖全部 snapshot 记忆。
  //
  // v0.4.4 fix（残缺输出防洗白）→ Issue #104 方向 1 重审：显式覆盖率护栏的
  // 初衷是拦「输出截断 → 只 claim 少量 → 其余被隐式 keep 洗白」，但它无法区分
  // 恶性截断与良性挑重点——而提示词硬性规则本身要求「无问题的条目无需输出」，
  // 挑重点正是要求的行为。官方路由 + 强模型的实测（heptaspirit：81 轮 failed
  // 全是 coverage，LLM 调用本身成功、applied=0）证明这是常规路径而非边角。
  // 处置：覆盖率不足不再 ok:false 整单拒绝，改为返回 coverageShortfall 理由、
  // 照常补齐隐式 keep——调用方把 run 记 degraded（合法子集已应用），护栏以
  // 状态暴露而非一票否决，与 skipInvalid 同一宽容哲学。明确异常信号（create
  // 上限等硬错误）保持整单拒绝。要恢复旧行为可设 dreamImplicitKeep:false
  // （严格模式，缺失即 error）或 dreamMinExplicitCoverage: 0（关护栏）。
  // 非覆盖类硬错误（create 上限溢出、严格模式缺失 id）仍然先整单拒绝——
  // #104 方向 1 只豁免 coverage 这一个信号，防洗白语义对它们原样保留。
  if (errors.length > 0) {
    return { ok: false, errors, skipped, resolvedShortIds };
  }
  const minCoverage = options.dreamMinExplicitCoverage ?? 0.5;
  let coverageShortfall = null;
  if (options.dreamImplicitKeep !== false) {
    const coverage = snapshot.size > 0 ? claimed.size / snapshot.size : 1;
    if (coverage < minCoverage) {
      coverageShortfall = `explicit decision coverage ${Math.round(coverage * 100)}% < minimum ${Math.round(minCoverage * 100)}%`;
    }
    for (const id of snapshot.keys()) {
      if (!claimed.has(id)) survivors.push({ action: "keep", ids: [id] });
    }
  } else {
    for (const id of snapshot.keys()) {
      if (!claimed.has(id)) errors.push(`memory ${JSON.stringify(id)} missing from decisions`);
    }
    if (errors.length > 0) return { ok: false, errors, skipped, resolvedShortIds };
  }
  // 调用方下游（apply/audit）复用同一 decisions 引用：就地同步为 survivors——
  // 在 skipInvalid 模式下去掉被跳过的非法决策；在隐式 keep 下追加补齐的 keep。
  // 不能以 survivors.length !== decisions.length 作为是否 splice 的判据：
  // 当"被跳过的非法决策数 == 隐式补齐的 keep 数"时长度回到相等但内容已变，
  // 被跳过的决策会残留进 apply/audit。一律无条件 splice 最安全。
  decisions.splice(0, decisions.length, ...survivors);
  return { ok: true, errors, skipped, resolvedShortIds, coverageShortfall };
}

/** Marker thrown when a decision target changed since the run snapshot. */
export class CasConflictError extends Error {
  constructor(action, ids, reason) {
    super(`cas conflict: ${action} targets changed since snapshot (${reason})`);
    this.name = "CasConflictError";
    this.action = action;
    this.ids = ids;
  }
}

function decisionIds(d) {
  return d.action === "conflict" || d.action === "supersede" ? [d.winner, d.loser] : (d.ids ?? []);
}

/**
 * CAS guard (item ①): every target memory must still match what the run
 * snapshot captured — otherwise the decision was computed against stale state
 * and applying it would overwrite a concurrent edit. Snapshotless replays skip
 * the guard entirely (per-action idempotency checks handle those). Throws
 * CasConflictError on the first mismatch; the caller's transaction rolls back.
 */
function casGuard(service, snapshot, ids) {
  if (!snapshot) return;
  for (const id of ids) {
    const expect = snapshot.get(id);
    if (!expect) continue; // not in snapshot: validated elsewhere, skip guard
    const current = service.getById(id);
    if (!current) {
      throw new CasConflictError("deleted", [id], `memory ${id} was removed`);
    }
    const changed = expect.updated_at !== undefined
      ? current.updated_at !== expect.updated_at
      : current.content !== expect.content || current.title !== expect.title;
    if (changed) {
      throw new CasConflictError(
        "changed",
        [id],
        `memory ${id} was concurrently modified (expected updated_at=${expect.updated_at}, got ${current.updated_at})`
      );
    }
  }
}

/**
 * Apply a validated decision list to the service. Caller must validate first.
 * Each decision runs inside its own SQLite transaction (item ②): the multi-step
 * mutation of a decision is atomic, so a merge can never leave "keeper updated
 * but source not archived" or vice versa — a throwing sub-step rolls the whole
 * decision back.
 *
 * @param decisions - validated decision list.
 * @param service - memory service (saveWithDedupe/getById/update/setArchived/transaction).
 * @param logger - optional logger ({ warn }); per-decision failures are logged.
 * @param snapshot - optional Map<id, memory> captured before the LLM call; when
 *   provided, every decision target is CAS-checked against it and a decision
 *   computed from stale state is skipped and reported as a conflict instead of
 *   overwriting concurrent writes (item ①).
 * @returns {{ applied: number, conflicts: Array, failures: Array, committed: Array }}
 *   applied    - number of decisions/memories actually committed (archive counts
 *                each archived memory as one, merge/conflict/update count one).
 *   conflicts  - decisions skipped because a target changed since the snapshot.
 *   failures   - decisions that threw mid-transaction (fully rolled back).
 *   committed  - the decisions that actually landed, for outcome/receipt based
 *                on real committed sub-steps rather than the raw LLM list.
 */
export function applyDecisions(decisions, service, logger = null, snapshot = null, config = {}) {
  let applied = 0;
  const conflicts = [];
  const failures = [];
  const committed = [];
  for (const [i, d] of decisions.entries()) {
    try {
      // keep is a confirmed no-op: it commits nothing but still records the
      // per-id disposition so the outcome covers every snapshot memory.
      if (d.action === "keep") {
        committed.push({ action: "keep", ids: d.ids });
        continue;
      }
      const outcome = applyOne(d, service, snapshot, config);
      if (outcome === "skipped") continue;
      applied += outcome.applied;
      committed.push(outcome.committed);
    } catch (error) {
      if (error instanceof CasConflictError) {
        conflicts.push({ index: i, action: d.action, ids: error.ids, reason: error.message });
        logger?.warn?.(`dsh-mneme dream: ${error.message}`);
      } else {
        failures.push({ index: i, action: d.action, ids: decisionIds(d), reason: error.message });
        logger?.warn?.(`dsh-mneme dream: failed to apply ${d.action} at index ${i}: ${error.message}`);
      }
    }
  }
  return { applied, conflicts, failures, committed };
}

function applyOne(d, service, snapshot, config = {}) {
  switch (d.action) {
    case "archive": return applyArchive(d, service, snapshot);
    case "merge": return applyMerge(d, service, snapshot, config);
    case "conflict": return applyConflict(d, service, snapshot, config);
    case "supersede": return applySupersede(d, service, snapshot, config);
    case "differentiate": return applyDifferentiate(d, service, snapshot, config);
    case "create": return applyCreate(d, service, config);
    default: return applyUpdate(d, service, snapshot, config);
  }
}

/**
 * Highest-epistemic-priority UNARCHIVED id among `ids` (ties break toward
 * `preferred`). Archived memories are never eligible keepers — promoting one
 * would demote the real keepSource to a source and then hit the archived-keeper
 * guard in applyMerge, silently skipping the whole merge. When `preferred`
 * itself is archived (or missing), fall back to any unarchived candidate.
 */
function pickBestKeeper(ids, preferred, service) {
  let best = null;
  let bestP = -1;
  for (const id of ids) {
    const mem = service.getById(id);
    if (!mem || mem.archived) continue; // archived/missing: ineligible keeper
    const p = EPISTEMIC_PRIORITY[mem.epistemic_status] ?? 0;
    if (p > bestP || (p === bestP && id === preferred)) {
      bestP = p;
      best = id;
    }
  }
  return best ?? preferred;
}

/**
 * Mint a fresh memory (pattern discovery). No existing target, so no CAS guard.
 * Evidence ids ride in the content so a pattern stays traceable to its source
 * memories. saveWithDedupe dedupes identical mints (idempotent replay-safe).
 */
function applyCreate(d, service, config = {}) {
  const language = langOf(config);
  const title = String(d.title ?? "").trim();
  const content = String(d.content ?? "").trim();
  const importance = Number.isInteger(d.importance) ? d.importance : 3;
  const type = typeof d.type === "string" ? d.type : "pattern";
  const evidence = Array.isArray(d.evidence)
    ? d.evidence.filter((id) => typeof id === "string")
    : [];
  const body = evidence.length > 0
    ? STR.evidenceSuffix[language](content, evidence)
    : content;
  const created = service.saveWithDedupe({ type, title, content: body, importance });
  const memory = created?.memory;
  if (!memory) return "skipped"; // deduped/subsumed: nothing minted, clean no-op
  return { applied: 1, committed: { action: "create", id: memory.id, type } };
}

function applyArchive(d, service, snapshot) {
  const targets = d.ids.filter((id) => {
    const mem = service.getById(id);
    return mem && !mem.archived; // existing, not-yet-archived rows only
  });
  if (targets.length === 0) return "skipped"; // all already archived: idempotent replay
  service.transaction(() => {
    casGuard(service, snapshot, d.ids);
    for (const id of d.ids) {
      const mem = service.getById(id);
      if (mem && !mem.archived) service.setArchived(id, true);
    }
  });
  return { applied: targets.length, committed: { action: "archive", ids: targets } };
}

function applyMerge(d, service, snapshot, config = {}) {
  // Epistemic trust (v0.4.5): when enabled, prefer an observation keeper over a
  // subjective/inferred one. Mutating the decision keeps the receipt + committed
  // record aligned with the actual keeper.
  if (config.trustEpistemicWeighting === true) {
    const best = pickBestKeeper(d.ids, d.keepSource, service);
    if (best && best !== d.keepSource) d.keepSource = best;
  }
  const sources = d.ids.filter((id) => id !== d.keepSource);
  // Idempotent replay: if every other source is already archived, this merge
  // already landed — skip so a replayed/concurrent decision never double-counts
  // or re-applies (guard against duplicate merges).
  if (sources.every((id) => service.getById(id)?.archived)) return "skipped";
  service.transaction(() => {
    casGuard(service, snapshot, d.ids);
    const keeper = service.getById(d.keepSource);
    if (!keeper || keeper.archived) return; // missing keeper: no write, still a clean commit
    service.update(d.keepSource, {
      title: d.title,
      content: d.content,
      importance: d.importance ?? Math.max(keeper.importance, ...d.ids.map((id) => service.getById(id)?.importance ?? 1))
    });
    for (const id of sources) {
      const mem = service.getById(id);
      if (mem && !mem.archived) service.setArchived(id, true);
    }
    // 4.3.2 迁移实体关联（opt-in）：将 loser（source）记忆关联的 entity_attrs 的
    // memory_id 迁移到 keeper；keeper 已有同 entity+key 的当前属性时 loser 行被
    // 失效。单个 source 迁移失败只告警，绝不能导致整个 merge 事务回滚（fail-safe）。
    if (config.entityExtractionEnabled && typeof service.migrateAttrsToMemory === "function") {
      for (const id of sources) {
        try {
          service.migrateAttrsToMemory(id, d.keepSource, new Date().toISOString());
        } catch (error) {
          logger?.warn?.(`dsh-mneme dream: failed to migrate attrs from ${id} to ${d.keepSource}: ${error.message}`);
        }
      }
    }
  });
  return {
    applied: 1,
    committed: { action: "merge", ids: d.ids, keepSource: d.keepSource, title: d.title, content: d.content, importance: d.importance, count_before: d.ids.length, count_after: 1 }
  };
}

function applyConflict(d, service, snapshot, config = {}) {
  const language = langOf(config);
  // Epistemic trust (v0.4.5): when enabled, the observation side of a conflict
  // is preferred as winner over a subjective/inferred one.
  if (config.trustEpistemicWeighting === true) {
    const pw = EPISTEMIC_PRIORITY[service.getById(d.winner)?.epistemic_status] ?? 0;
    const pl = EPISTEMIC_PRIORITY[service.getById(d.loser)?.epistemic_status] ?? 0;
    if (pl > pw) [d.winner, d.loser] = [d.loser, d.winner];
  }
  const winner = service.getById(d.winner);
  const loser = service.getById(d.loser);
  if (!winner || !loser) return "skipped";
  // Idempotent replay: an already-archived loser means the conflict was already
  // adjudicated — skip so the provenance note is never re-appended and the loser
  // is not re-archived.
  if (loser.archived) return "skipped";
  service.transaction(() => {
    casGuard(service, snapshot, [d.winner, d.loser]);
    const winnerNow = service.getById(d.winner);
    const loserNow = service.getById(d.loser);
    if (!winnerNow || !loserNow || loserNow.archived) return;
    service.update(d.winner, {
      content: STR.supersededSuffix[language](winnerNow.content, [...loserNow.content].slice(0, 100).join(""))
    });
    service.setArchived(d.loser, true);
  });
  return { applied: 1, committed: { action: "conflict", winner: d.winner, loser: d.loser, count_before: 2, count_after: 1 } };
}

/**
 * supersede（Issue #126，sleepActionSet="full"）：演进型重复——新版本取代旧版本。
 * 与 conflict 的关键差别：**注记追加到 loser（被取代方）而不是 winner**。conflict
 * 把"已否决旧信息"写进赢家正文，赢家因此被污染——这正是 #126 的原始抱怨；
 * supersede 把可追溯性留在被归档的那一侧，赢家正文一字不动。
 *
 * 幂等：loser 已归档即视为该决策已落地（重放/并发不会重复追加注记或重复归档）。
 */
function applySupersede(d, service, snapshot, config = {}) {
  const language = langOf(config);
  // Epistemic trust（与 conflict 同款）：可信度更高的一侧优先作为取代方。
  if (config.trustEpistemicWeighting === true) {
    const pw = EPISTEMIC_PRIORITY[service.getById(d.winner)?.epistemic_status] ?? 0;
    const pl = EPISTEMIC_PRIORITY[service.getById(d.loser)?.epistemic_status] ?? 0;
    if (pl > pw) [d.winner, d.loser] = [d.loser, d.winner];
  }
  const winner = service.getById(d.winner);
  const loser = service.getById(d.loser);
  if (!winner || !loser) return "skipped";
  if (loser.archived) return "skipped"; // 幂等重放：已经取代过了
  service.transaction(() => {
    casGuard(service, snapshot, [d.winner, d.loser]);
    const winnerNow = service.getById(d.winner);
    const loserNow = service.getById(d.loser);
    if (!winnerNow || !loserNow || loserNow.archived) return;
    service.update(d.loser, {
      content: STR.supersededBySuffix[language](loserNow.content, winnerNow.title)
    });
    service.setArchived(d.loser, true);
  });
  return { applied: 1, committed: { action: "supersede", winner: d.winner, loser: d.loser, count_before: 2, count_after: 1 } };
}

/**
 * differentiate（Issue #126，sleepActionSet="full"）：互补型重复——两条各自成立、
 * 覆盖不同侧面，不该判输赢。双方都保留（不归档），各追加同一段差异注记；注记进
 * 正文 → 进注入与 embedding → 下一轮不会再被判成重复（这是本动作存在的意义）。
 *
 * 注记由插件按 distinctions 渲染，**不让模型整段重写 content**（重写有篡改/丢失
 * 风险）。幂等：注记已在正文里就不重复追加，否则同一决策重放会不断堆叠。
 */
function applyDifferentiate(d, service, snapshot, config = {}) {
  const language = langOf(config);
  const ids = Array.isArray(d.ids) ? d.ids : [];
  const notes = (Array.isArray(d.distinctions) ? d.distinctions : [])
    .filter((s) => typeof s === "string" && s.trim())
    .map((s) => s.trim());
  const marker = STR.differentiatedMarker[language](notes);
  const alive = ids.filter((id) => {
    const m = service.getById(id);
    return m && !m.archived;
  });
  if (alive.length < 2) return "skipped"; // 缺一条即已处理/不可用（幂等）
  if (alive.every((id) => String(service.getById(id)?.content ?? "").includes(marker))) {
    return "skipped"; // 同一条决策重放：注记已存在
  }
  service.transaction(() => {
    casGuard(service, snapshot, ids);
    for (const id of ids) {
      const m = service.getById(id);
      if (!m || m.archived) continue;
      if (String(m.content).includes(marker)) continue; // 单条已注记过
      service.update(id, { content: `${m.content}${marker}` });
    }
  });
  return {
    applied: 1,
    committed: { action: "differentiate", ids, count_before: ids.length, count_after: ids.length }
  };
}

function applyUpdate(d, service, snapshot, config = {}) {
  const id = d.ids[0];
  const mem = service.getById(id);
  if (!mem || mem.archived) return "skipped";
  // 幂等检查：如果字段已与目标一致则跳过
  const same = (d.title === undefined || d.title === mem.title)
    && (d.content === undefined || d.content === mem.content)
    && (d.importance === undefined || d.importance === mem.importance);
  if (same) return "skipped";
  service.transaction(() => {
    casGuard(service, snapshot, [id]);
    const cur = service.getById(id);
    if (!cur || cur.archived) return;
    service.update(id, {
      title: d.title ?? cur.title,
      content: d.content ?? cur.content,
      importance: d.importance ?? cur.importance
    });
  });
  // 4.3.1 supersedes 关系（opt-in）：事务提交成功后，为该记忆关联的每条实体属性
  // 建立自引用 supersedes 关系，表示"此属性版本已被替代"。仅记录、绝不阻断主流程
  // （fail-safe）：记录失败只告警，update 本身照常生效。
  if (config.entityExtractionEnabled && typeof service.saveRelation === "function" && typeof service.getAttrsByMemory === "function") {
    try {
      const oldAttrs = service.getAttrsByMemory(id);
      for (const attr of oldAttrs) {
        if (!attr.entity_id) continue;
        service.saveRelation({
          from_entity: attr.entity_id,
          to_entity: attr.entity_id,
          relation_type: "supersedes",
          memory_id: id,
          metadata: JSON.stringify({ attr_key: attr.attr_key, old_value: attr.attr_value })
        });
      }
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: failed to record supersedes relations for ${id}: ${error.message}`);
    }
  }
  return { applied: 1, committed: { action: "update", ids: [id], title: d.title, content: d.content, importance: d.importance, count_before: 1, count_after: 1 } };
}
