import { STR, langOf } from "../lang.js";
// System-level sleep (v0.4.0): an idle-triggered, LLM-assisted deep pass over
// the memory store. Four independent, fail-safe phases:
//   1. conflict resolution — high-similarity same-type pairs are either parked
//      for review (freeze mode) or adjudicated by the LLM (winner kept / loser
//      archived), reusing the dream conflict machinery. Strictness-graded.
//      v0.8.1 (issue #170): cross-scope pairs are ALWAYS parked for human
//      ownership review with a dedicated reason — never auto-adjudicated.
//   2. archival demotion — memories unreferenced past sleepArchiveDays shrink
//      to a one-line summary with the full body moved to _full_content; past
//      sleepCompressDays they are archived outright.
//   3. pattern discovery — the LLM scans the most recent memories and mints
//      type=pattern entries carrying evidence id references.
//   4. relation completion — orphan entities (zero relations) get implied
//      relations completed from memory co-occurrence.
// Each phase is wrapped so one failure never aborts the others, and a missing
// LLM route / semantic embedder only skips the phases that need it. A run is
// abortable via an AbortController signal (user activity) — phases check the
// signal between batches so a running cycle yields promptly.
import { randomUUID, createHash } from "node:crypto";
import { validateDecisions, applyDecisions, ACTIONS } from "./decisions.js";
import { findPotentialConflicts, cosineSimilarity } from "./clustering.js";
import { scopeKeyOf } from "../scope.js";
import { buildReceipt, describeStreamFailure, resolveDreamEffort, withEffortFallback, withMaxTokensFallback, maintainIndexAfterDream, fenceListBody, parseFailureMeta } from "../dream.js";
import { computeHeat } from "../heat.js";
// 四个相位读的都是行池，而动行的写手不经汇流口：phaseDemotion 直接 setArchived /
// demoteToSummary，phasePatterns 还会 mint 出新行，所以这条契约要在每处各挡一遍
// （清单与静态锁见 test/share-imported-guard.test.js）。
import { isImportedRow } from "../memory-source.js";
// Issue #533：查账本时要拿两侧当前的正文哈希，与 applyDifferentiate 记账时的口径同源。
import { contentHashOf } from "../content-hash.js";

// Issue #126 review（Copilot）：默认档（sleepActionSet="conflict"）允许的动作 = 全局
// ACTIONS 去掉 #126 新增的两个。从 ACTIONS 派生而非硬编码，将来再扩动作集时自动跟随。
// 只换 prompt 挡不住模型自发输出新动作，必须由校验器按档位收口。
const LEGACY_ACTIONS = [...ACTIONS].filter((a) => a !== "supersede" && a !== "differentiate");

const SUMMARY_MAX = 120;
// Conflict similarity threshold per strictness level (v0.4.0):
//   gentle     only high-confidence pairs (0.92) — first-time users
//   normal     standard dream-level (0.85) — default
//   aggressive low-confidence pairs too (0.75) — bloated stores
const CONFLICT_THRESHOLDS = { gentle: 0.92, normal: 0.85, aggressive: 0.75 };

// Issue #529（C 项的替代实现）：连续失败时最小间隔的封顶。基数默认 8 小时，
// 2^3 就到 64 小时——不封顶的话模型持续失败会让 sleep 事实上停摆好几天，而
// 用户完全看不出来。24 小时 = 「最多一天试一次」，与 #292 给 autoDream 的
// 30 分钟封顶同一意图（封顶值不同是因为两个调度的基数差一个数量级）。
const FAILURE_BACKOFF_CAP_MS = 24 * 3600000;

function parseJsonArray(text) {
  if (typeof text !== "string") return undefined;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Same stream consumption contract as dream.js.
 *
 * `onUsage`（optional, issue #250）receives any usage chunk for token accounting.
 * dream.js 那份一直有它；sleep 这份副本没有，导致 conflict / pattern 两条链路的
 * token 从未进 llm_audit_logs（面板因此只看到 autoDream 与 autoSummarize）。
 */
async function streamText(ctx, options, onUsage, onStreamError) {
  if (!ctx?.llm?.stream) return undefined;
  let text = "";
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    // DSH 的 StreamChunk 契约把用量嵌在 chunk.usage（TokenUsage：inputTokens /
    // outputTokens / totalTokens）；兼容直接平铺在 chunk 上的旧形态。归一放在
    // 这里，调用侧的 reporter 只需认平铺形状——与 dream.js:239 同一处理。
    if (chunk.type === "usage" && typeof onUsage === "function") onUsage(chunk.usage ?? chunk);
    if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
      // Same rc.1 error-as-finish-chunk behavior as dream.js — surface the
      // cause instead of discarding it.
      if (typeof onStreamError === "function") {
        try { onStreamError(chunk.reason); } catch { /* diagnostics only */ }
      }
      return undefined;
    }
  }
  return text;
}

/**
 * Issue #250：给 sleep 的一条 LLM 调用记一笔 llm_audit_logs（token / 时长 / 状态 /
 * 触发源）。与 dream.js 的 runAuditedLlm 同口径但各自独立一份——dream 那两个
 * checker 的调用形状绑定着它自己的排程细节，硬抽共享抽象只会收敛回 dream 的形态。
 *
 * 记账是 best-effort：写审计行失败只 warn，绝不反噬 sleep 本体（CONTRIBUTING 的
 * fail-safe 硬约定）。`body(reportUsage)` 负责真实消费流，usage chunk 经
 * reportUsage 上报。
 *
 * 审计诚实性：流被中止/报错时 body 返回 undefined，记 status='error'；流式成功但
 * 输出不可用时 `spec.auditError` 给出原因，同样记 error——否则同一轮调用会在
 * 「phase 报 failed」与「audit 报 success」之间自相矛盾（CONTRIBUTING 的审计诚实性
 * 硬约定）。`auditError` 必须是**纯判据函数**：调用方的控制流不能依赖它的副作用，
 * 因为审计关闭时这里整段早退、钩子根本不会被调用（dream 正是那样踩的，见 PR 正文）。
 */
async function auditedSleepLlm(ctx, service, config, logger, spec, body) {
  if (config?.llmAudit?.enabled === false || typeof service?.saveLlmAudit !== "function") {
    return body(() => {});
  }
  const startedAt = Date.now();
  const timestamp = new Date(startedAt).toISOString();
  let inputTokens = 0;
  let outputTokens = 0;
  let status = "success";
  let errorMessage = null;
  // 提到 try 之外：finally 里的 metadataFrom 要读这一轮的原始输出（dream.js 的
  // runAuditedLlm 就是这么声明的）。留在 try 里，finally 看不见它，读数会静默变空。
  let result;
  try {
    result = await body((usage) => {
      if (!usage) return;
      const i = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens;
      const o = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens;
      if (Number.isFinite(i)) inputTokens = i;
      if (Number.isFinite(o)) outputTokens = o;
    });
    if (result === undefined) {
      status = "error";
      const streamErr = typeof spec.streamError === "function" ? String(spec.streamError() ?? "") : "";
      errorMessage = streamErr ? `llm stream aborted or errored (${streamErr})` : "llm stream aborted or errored";
    } else if (typeof spec.auditError === "function") {
      // 流式成功但输出不可用，仍然是一次失败的调用——记 error，不与调用方的
      // failed 返回值打架。
      const message = spec.auditError(result);
      if (message) {
        status = "error";
        errorMessage = message;
      }
    }
    return result;
  } catch (error) {
    status = "error";
    errorMessage = String(error?.message ?? error);
    throw error;
  } finally {
    // spec.metadataFrom(result)：与 dream.js 的 runAuditedLlm 同一形状（这里是一份并行
    // 实现，不是同一个函数——两份审计写法的字段必须一致，否则面板按 operation_type
    // 筛出来的读数会时有时没有）。判据函数只读 result，不读闭包，理由同 dream.js。
    let metadata;
    if (result !== undefined && typeof spec.metadataFrom === "function") {
      try {
        metadata = spec.metadataFrom(result) ?? undefined;
      } catch {
        metadata = undefined;
      }
    }
    try {
      service.saveLlmAudit({
        timestamp,
        trigger_source: spec.triggerSource,
        operation_type: spec.operationType,
        model_id: spec.modelId,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cost_usd: 0,
        duration_ms: Date.now() - startedAt,
        status,
        error_message: errorMessage,
        related_memory_ids: spec.relatedMemoryIds ?? [],
        ...(metadata ? { metadata } : {})
      });
    } catch (auditError) {
      logger?.warn?.(`dsh-mneme sleep: llm audit write failed: ${String(auditError)}`);
    }
  }
}

/** LLM route (Issue #25): explicit sleepProvider/Model wins, then the dream
 *  route as a shared explicit fallback, then the agent default model. Sleep
 *  can pin a cheaper model for its bulk passes without disturbing the dream
 *  route. Explicit config first — otherwise the config routes are dead code
 *  whenever agentDefaultModel resolves (see resolveRoute in dream.js). */
function resolveSleepRoute(ctx, config, logger) {
  if (config.sleepProvider && config.sleepModel) return { provider: config.sleepProvider, model: config.sleepModel };
  if (config.dreamProvider && config.dreamModel) return { provider: config.dreamProvider, model: config.dreamModel };
  try {
    const sel = ctx?.agentDefaultModel?.currentSelection?.();
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
  } catch { /* fall through to warn */ }
  logger?.warn?.("dsh-mneme sleep: no llm route available");
  return undefined;
}

function makeSummary(m) {
  const text = (m.content ?? "").trim();
  if (!text) return (m.title ?? "").trim();
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX)}…`;
}

// issue #471 政策轴：被按下的作用域也不参与睡眠整理。与 dream.js 的 withoutPaused
// 同源（那里记着「判定只许有一份实现」的理由），但这里是**单独一处**而不是复用：
// 两个模块各被独立装配（runSleep / runDream 各自接 service），任何一个被换进只
// 实现了一半 service 的夹具时都该各自降级，而不是因为对方模块没装而双双失效。
//
// 睡眠侧比日间加固侧更要紧：这几个相位不只读——phaseDemotion 会 setArchived 与
// demoteToSummary（真改归档面），phasePatterns 会 mint 出 type=pattern 的新行
// （凭空给被按下的作用域生出衍生记忆）。只挡日间那几处读入口的话，闸门开着而每
// 6 小时一次的睡眠照样动手，那等于「按下」只是让它在白天看不见。
//
// service 上取不到 filterPaused 时（老装配、测试夹具）原样返回，与改动前一致。
function withoutPaused(service, rows) {
  if (typeof service?.filterPaused !== "function") return rows;
  return service.filterPaused(rows);
}

// ---------------------------------------------------------------- phases

/**
 * Phase 1 — conflict resolution. Needs a semantic embedder + vector index.
 * In freeze mode (conflictFreezeEnabled) conflicting pairs are parked in
 * conflict_pending for human review (no LLM). Otherwise the LLM adjudicates:
 * each pair → winner kept / loser archived. Returns a per-run summary.
 */
async function phaseConflicts(ctx, service, config, logger, runId, semantic = null, signal = null) {
  const language = langOf(config);
  const embedder = semantic?.embedder;
  const vectorIndex = semantic?.vectorIndex;
  if (!embedder || !vectorIndex || typeof embedder.embed !== "function") {
    return { status: "skipped", reason: "no semantic embedder" };
  }
  const strictness = config.sleepConflictStrictness ?? "normal";
  const threshold = CONFLICT_THRESHOLDS[strictness] ?? CONFLICT_THRESHOLDS.normal;
  const memories = withoutPaused(service, service.all().filter((m) => !isImportedRow(m) && !m.archived && !m.forgotten && m.type !== "summary" && m.type !== "document"));
  if (memories.length < 2) return { status: "skipped", reason: "too few memories" };
  if (signal?.aborted) return { status: "aborted", reason: "user activity" };

  // Backfill + collect vectors for every eligible memory (best effort).
  const vectors = new Array(memories.length);
  const missing = [];
  for (let i = 0; i < memories.length; i++) {
    const cached = vectorIndex.getEmbedding?.(memories[i].id);
    if (cached) vectors[i] = cached;
    else missing.push(i);
  }
  if (missing.length) {
    try {
      const texts = missing.map((i) => [memories[i].title, memories[i].content].filter(Boolean).join("\n"));
      const rows = await embedder.embed(texts);
      missing.forEach((mi, j) => {
        if (rows[j]?.length) {
          vectors[mi] = rows[j];
          vectorIndex.saveEmbedding?.(memories[mi].id, rows[j]);
        }
      });
    } catch (error) {
      logger?.warn?.(`dsh-mneme sleep: conflict vector backfill failed: ${String(error)}`);
    }
  }
  const usable = [];
  for (let i = 0; i < memories.length; i++) {
    if (vectors[i]?.length) usable.push(i);
  }
  if (usable.length < 2) return { status: "skipped", reason: "no usable vectors" };
  const usableMemories = usable.map((i) => memories[i]);
  const usableVectors = usable.map((i) => vectors[i]);

  // Issue #126：动作集档位既要决定 prompt，也要决定**校验器允许的动作集合**（见下方
  // allowedActions），并且在候选构造阶段就要知道——full 档需要补跨类型对。因此在这里
  // 解析，而不是等到拼 prompt 时。
  const actionSet = config.sleepActionSet ?? "conflict";
  const pairs = findPotentialConflicts(usableMemories, usableVectors, threshold);
  if (actionSet === "full") {
    // Issue #126 review（Copilot）：findPotentialConflicts 只看同类型，而 full 档的
    // prompt 明确宣传 differentiate 用于互补型——互补本来就常跨类型（同一事实的项目侧
    // 与偏好侧）。不补这一遍，那条路径永远选不到。merge 的类型守卫不受影响：它拦在
    // validateDecisions 里（allowCrossTypeMerge），不在候选生成。
    for (let i = 0; i < usableMemories.length; i++) {
      for (let j = i + 1; j < usableMemories.length; j++) {
        if (usableMemories[i].type === usableMemories[j].type) continue;
        const sim = cosineSimilarity(usableVectors[i], usableVectors[j]);
        if (sim > threshold) pairs.push({ a: usableMemories[i], b: usableMemories[j], similarity: sim });
      }
    }
  }
  if (pairs.length === 0) return { status: "skipped", reason: "no conflicts found" };

  // Dedupe: each memory participates in at most one pair, highest similarity
  // first — overlapping pairs would violate validateDecisions' "one claim".
  pairs.sort((a, b) => b.similarity - a.similarity);

  // Issue #533：已经裁决过「互补、两条都留」的对不再重判。
  //
  // 过滤必须发生在 used 去重**之前**：若先占位再丢弃，一条已裁决的记忆会把
  // 名额占住，而它真正的对手又是自己人，这一轮就白跑——抑制一对不该顺带压掉
  // 另一对候选。判据与 applyDifferentiate 的幂等同源：账本里有这对、且两侧正文
  // 的 content_hash 与记账时一致（任一侧改过 = 结论可能不再成立，重判）。
  // 存量兼容走同一格：旧版本把注记写进正文却没账本行，两侧都还带着注记块也算
  // 已裁决，免得升级后第一轮把所有老对重判一遍。
  const alreadyDifferentiated = (p) => {
    const a = service.getById(p.a.id);
    const b = service.getById(p.b.id);
    if (!a || !b) return false;
    if (typeof service.findDifferentiatedPair === "function") {
      const record = service.findDifferentiatedPair(a.id, b.id);
      if (record) {
        const [ha, hb] = a.id <= b.id
          ? [contentHashOf(a), contentHashOf(b)]
          : [contentHashOf(b), contentHashOf(a)];
        // 账本行没记 hash（存量/异常写入）时不下结论，宁可多判一次。
        return record.hash_a != null && record.hash_b != null
          && record.hash_a === ha && record.hash_b === hb;
      }
    }
    return STR.differentiatedNoteRe.test(String(a.content ?? ""))
      && STR.differentiatedNoteRe.test(String(b.content ?? ""));
  };
  const fresh = [];
  let suppressed = 0;
  for (const p of pairs) {
    if (alreadyDifferentiated(p)) {
      suppressed += 1;
      continue;
    }
    fresh.push(p);
  }
  if (fresh.length === 0) {
    // 与 "no conflicts found" 分开报：一对都没检测到 vs 检测到但全都裁决过，
    // 是完全不同的两件事，混成一句会让「sleep 是不是没在干活」读不出来。
    return { status: "noop", reason: "all candidate pairs already differentiated", suppressed };
  }

  // Issue #529：输入侧预算。此前 samePairs 是**全部**同 scope 相似对，一次拼成一个
  // prompt——实测单请求 163,054 输入 token（服务端 --ctx-size 163,840），撞墙后按冷却
  // 重排，下一轮送进去的还是同一份输入，于是 23 轮连续失败。
  //
  // 预筛掉「已经判过且两侧都没动过」的对：判 keep 曾经是彻底的 no-op，既不留痕也不
  // 影响下一轮的候选池，同一对每个冷却周期都被重新送审一遍。台账（conflict_reviewed）
  // 记的是"这段输入被看过"，两侧任一 updated_at 晚于 judged_at 就重新入池——与
  // conflict_pending 复核项 4 同一条宽松代理：任何字段更新都算值得再看一眼。
  //
  // Issue #536 review（CodeRabbit ①）：预筛必须发生在下面的 used 去重**之前**，理由与
  // #533 那条一模一样——先占位再去掉，一条已审的记忆会把自己的配对名额占住，而它真正
  // 的对手（另一条没审过的记忆）因此进不了这一轮。三条边界：
  //   · 只筛同 scope 对：跨 scope 对本来就要停车进人工队列，不能被台账吞掉；
  //   · freeze 模式不筛：那一档只停车不送 LLM，台账与它无关（ledgerSkipped 记 0）；
  //   · ledgerSkipped 在这里一次数清，后面 candidates 直接取 samePairs，不再二次过滤。
  const isCrossScopePair = (p) =>
    scopeKeyOf(p.a.agent_scope) !== scopeKeyOf(p.b.agent_scope)
    || scopeKeyOf(p.a.workspace_scope) !== scopeKeyOf(p.b.workspace_scope);
  const ledger = typeof service.loadConflictReviewed === "function"
    ? (service.loadConflictReviewed() ?? new Map())
    : new Map();
  const pairKey = (p) => (p.a.id < p.b.id ? `${p.a.id}\u0000${p.b.id}` : `${p.b.id}\u0000${p.a.id}`);
  const alreadyJudged = (p) => {
    const rec = ledger.get(pairKey(p));
    if (!rec?.judged_at) return false;
    return (p.a.updated_at ?? "") <= rec.judged_at && (p.b.updated_at ?? "") <= rec.judged_at;
  };
  const selectionPairs = config.conflictFreezeEnabled === true
    ? fresh
    : fresh.filter((p) => isCrossScopePair(p) || !alreadyJudged(p));
  const ledgerSkipped = fresh.length - selectionPairs.length;

  const used = new Set();
  const selected = [];
  for (const p of selectionPairs) {
    if (used.has(p.a.id) || used.has(p.b.id)) continue;
    used.add(p.a.id);
    used.add(p.b.id);
    selected.push(p);
  }

  // v0.8.1（issue #170 第 2 步）：跨 scope 相似对分流。同一内容落在两个归属下
  // （任一维标注键不等即算，NULL=未标注=全局也参与比较——「全局副本 + 专属副本
  // 并存」正是收窄/提升裁决的典型候选）不能自动裁决：归档败者可能销毁该内容在
  // 某个归属下的唯一副本，LLM 也无从替用户决定归属。一律停车到冲突待确认队列
  // （专属 reason），同 scope 对维持既有路径（freeze 停车 / LLM 裁决）。
  const crossPairs = selected.filter(isCrossScopePair);
  const samePairs = selected.filter((p) => !isCrossScopePair(p));
  const parkPair = (p, reason) => {
    try {
      // 返回 undefined = 该对已被人工裁决且两侧内容未变（复核项 4）——不算停车。
      return service.saveConflictPending({ run_id: runId, memory_a: p.a.id, memory_b: p.b.id, reason }) != null;
    } catch (error) {
      logger?.warn?.(`dsh-mneme sleep: failed to park conflict ${p.a.id}/${p.b.id}: ${String(error)}`);
      return false;
    }
  };
  const scopeReason = (p) => STR.scopeCandidateReason[language](p.similarity.toFixed(2));
  const simReason = (p) => STR.similarityReason[language](p.similarity.toFixed(2));

  // Freeze mode: park pairs for manual review, no LLM required. Cross-scope
  // pairs carry the dedicated scope-candidate reason so the queue reads them
  // as ownership decisions rather than plain duplicates.
  if (config.conflictFreezeEnabled === true) {
    let frozen = 0;
    for (const p of selected) {
      if (parkPair(p, isCrossScopePair(p) ? scopeReason(p) : simReason(p))) frozen++;
    }
    return { status: frozen > 0 ? "ok" : "noop", frozen, scopeCandidates: crossPairs.length, pairs: selected.length };
  }

  // 非 freeze：跨 scope 对先停车（绝不进 LLM 裁决），同 scope 对照常走 LLM。
  let scopeParked = 0;
  for (const p of crossPairs) {
    if (parkPair(p, scopeReason(p))) scopeParked++;
  }
  if (samePairs.length === 0) {
    // 没有可送 LLM 的同 scope 对：可能一对都没检测到，也可能全被台账挡下了
    // （ledgerSkipped）。两种都要如实报，否则「sleep 怎么什么都不干」读不出来。
    return {
      status: scopeParked > 0 ? "ok" : "noop",
      frozen: 0,
      scopeCandidates: scopeParked,
      pairs: selected.length,
      batches: 0,
      ledgerSkipped
    };
  }

  // LLM adjudication（仅同 scope 对）。
  const route = resolveSleepRoute(ctx, config, logger);
  if (!route) return { status: "skipped", reason: "no llm route", scopeCandidates: scopeParked, pairs: selected.length, batches: 0, ledgerSkipped };
  // 每轮总上限：分批解决的是单请求撞墙，不是"一个 449 对的池子该在一轮里跑完"。
  // 没进这一轮的对留在下一轮（它们既没被丢弃，也不在台账里）。
  const perRunCap = config.sleepConflictMaxPairsPerRun ?? 60;
  const pool = perRunCap > 0 ? samePairs.slice(0, perRunCap) : samePairs;
  const perRunSkipped = samePairs.length - pool.length;
  const sleepEffort = await resolveDreamEffort(ctx, route, config.sleepReasoningEffort, logger);
  let conflictStreamFailure = "";
  // actionSet 已在候选构造前解析（跨类型候选需要它），这里只按档位选 prompt：
  // 默认档保持只有 conflict/keep 的窄 prompt，"full" 才开放六分支。
  const conflictPrompt = actionSet === "full" ? STR.prompts.conflictFull[language] : STR.prompts.conflict[language];
  const runConflict = (batch, withEffort, tokens) => {
    conflictStreamFailure = "";
    const listText = batch.map((p) => STR.candidateConflicts[language](p)).join("\n\n");
    return auditedSleepLlm(ctx, service, config, logger, {
      triggerSource: "sleep",
      operationType: "sleep_conflict",
      modelId: `${route.provider}:${route.model}`,
      // 候选对的双方 id：面板的活动流用 related_memory_ids 解析「沉淀条数」。
      // 分批后必须取**这一批**的 id：整轮的 60 对一次写进每一批的审计行，面板会把
      // 同一个「沉淀条数」重复累加五遍。
      relatedMemoryIds: batch.flatMap((p) => [p.a.id, p.b.id]),
      streamError: () => conflictStreamFailure,
      // 纯判据：输出里没有 JSON 数组 ⇒ 这轮是失败的调用，审计记 error。**不要**把
      // 解析结果存进闭包给下面的控制流用——审计关闭时 auditedSleepLlm 整段早退、
      // 这个钩子不会被调用，控制流会跟着失效（dream 的既有坑）。代价是审计开启时
      // 多解析一次，换来两条路径彻底解耦。
      auditError: (text) => (parseJsonArray(text) ? null : "no json array in llm output"),
      // 纯判据，与 auditError 同一条约定：重解析一次、不读闭包（审计关掉时那些闭包
      // 根本不会被赋值，读它会让「审计说了什么」依赖调用方走到了哪一行）。
      metadataFrom: (text) => (parseJsonArray(text) ? null : parseFailureMeta(text))
    }, (reportUsage) => streamText(ctx, {
    provider: route.provider,
    model: route.model,
    purpose: "sleep-conflict",
    maxTokens: tokens,
    ...(withEffort && sleepEffort ? { reasoningEffort: sleepEffort } : {}),
    messages: [
      { role: "system", content: [{ type: "text", text: conflictPrompt }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
      { role: "user", content: [{ type: "text", text: fenceListBody(language, listText) }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
    ]
  }, reportUsage, (reason) => { conflictStreamFailure = describeStreamFailure(reason); }));
  };
  // 单批的完整往返：送 → 解析 → 校验 → 应用 → 记账。抽成函数是为了让失败只影响
  // 自己这一批（下面的循环），而不是把整轮判死。
  const adjudicateBatch = async (batch, updateBudget) => {
    // Issue #536 review（CodeRabbit ③）：judged_at 是**发送时刻**，不是落地时刻。
    const judgedAt = new Date().toISOString();
    const text = await withMaxTokensFallback(ctx, config.sleepMaxTokens ?? 2048, (tokens) => withEffortFallback(ctx, sleepEffort, () => runConflict(batch, true, tokens), () => runConflict(batch, false, tokens), () => conflictStreamFailure), () => conflictStreamFailure);
    if (text === undefined) {
      if (conflictStreamFailure) ctx.logger?.warn?.(`dsh-mneme sleep: conflict stream aborted or errored (${conflictStreamFailure})`);
      return { status: "failed", error: "llm failed", failure: conflictStreamFailure || undefined };
    }
    const decisions = parseJsonArray(text);
    if (!decisions) return { status: "failed", error: "invalid decisions json" };
    // 本批的 snapshot 只含本批的 id。validateDecisions 要求每个 snapshot id 恰好被
    // claim 一次，拿整轮的 snapshot 校验单批输出会把其余 48 对判成"未裁决"。
    const batchSnapshot = new Map();
    for (const p of batch) {
      batchSnapshot.set(p.a.id, p.a);
      batchSnapshot.set(p.b.id, p.b);
    }
    // v0.4.4 起 validateDecisions 本身就会为未覆盖的 id 自动补 keep（dreamImplicitKeep
    // 默认开启），这里保留显式预填作为防御性双保险——漏判读作"未裁决冲突"而非
    // "冲突阶段整体失败"。
    const covered = new Set();
    for (const d of decisions) {
      // Issue #126 review（Copilot）：supersede 同样用 winner/loser 定位（没有 ids），
      // 此前只认 conflict → 它的两个目标都没进 covered → 被补成 implicit keep → 与
      // supersede 的 claim 冲突：严格模式整单拒绝，宽容模式把合成的 keep 记成 skipped。
      if (d?.action === "conflict" || d?.action === "supersede") {
        if (typeof d?.winner === "string") covered.add(d.winner);
        if (typeof d?.loser === "string") covered.add(d.loser);
      } else if (Array.isArray(d?.ids)) {
        for (const id of d.ids) covered.add(id);
      }
    }
    for (const id of batchSnapshot.keys()) {
      if (!covered.has(id)) decisions.push({ action: "keep", ids: [id] });
    }
    // Issue #126：sleep 是多对批量裁决，严格模式"一票否决"太脆（一对非法就丢掉整轮
    // 成果）→ 与 dream 对齐透传 skipInvalid：非法的那一对只跳过自己，合法子集照常
    // 应用，run 记 degraded。update 上限与保护期同样取 dream 的同一组配置，保证两个
    // 模块对"什么算合法"的判据一致。
    const { ok, errors, skipped } = validateDecisions(decisions, batchSnapshot, {
      // Issue #536 review（CodeRabbit ②）：reflectionUpdateMaxPerRun 是**整轮**上限，
      // 分批后不能每批都拿整份额度——那样 N 批就是 N 倍上限。这里用的是本轮的剩余额度。
      maxUpdatePerRun: updateBudget,
      minAgeHours: config.reflectionUpdateMinAgeHours,
      skipInvalid: config.dreamSkipInvalid !== false,
      allowCrossTypeMerge: config.allowCrossTypeMerge === true,
      // issue #339 / E8：guarded 类型 merge 护栏（默认开，dreamMergeGuard），
      // 与 dream 主链路同一判据。
      mergeGuard: config.dreamMergeGuard === true,
      // Issue #126 review（Copilot）：默认档必须真的只放行旧动作集——只换 prompt 挡不住
      // 模型自发输出 supersede / differentiate，那样"opt-in 零行为变化"就不成立。
      allowedActions: actionSet === "full" ? null : LEGACY_ACTIONS
    });
    if (!ok) return { status: "failed", error: `invalid decisions: ${errors.join("; ")}`, skipped };
    // 同 phasePatterns——本相位的 create 也落 source=sleep（默认档的
    // LEGACY_ACTIONS 含 create，理论上可 mint）。
    const { applied, failures, conflicts } = applyDecisions(
      // runId 让 differentiate 的账本行能追到是哪一轮 sleep 判的（issue #533）。
      decisions, service, logger, batchSnapshot, { ...config, mintSource: "sleep", runId }
    );
    // Issue #536 review（CodeRabbit ②）：本轮剩余的 update 额度按本批**通过校验的**
    // update 数扣减——validateDecisions 已把非法条目从 decisions 就地 splice 掉，
    // 所以数到的都是真的会落地的那些。落地时被 CAS 挡下的也算：额度宁可少发一次，
    // 也不能让"多批各扣一次满额"把整轮上限架空。
    const updateUsed = decisions.filter((d) => d?.action === "update").length;
    // Issue #126 review（Copilot）：事务内 service.update 会跳过 scheduleEmbed（txDepth>0），
    // 而 sleep 路径此前没有 dream 那样的 post-apply 索引维护——differentiate 的差异注记与
    // supersede 的归档都反映不到缓存向量，"注记进 embedding 防再判重复"就是空承诺。
    if (applied > 0 && semantic?.embedder && semantic?.vectorIndex) {
      try {
        await maintainIndexAfterDream(decisions, service, semantic);
      } catch (error) {
        logger?.warn?.(`dsh-mneme sleep: index maintenance failed: ${String(error)}`);
      }
    }
    // 台账：本批**全部送审对**都记一行，不只记被判成冲突的那几对。判 keep 的那一对
    // 正是 #529 里"下一轮原样再送"的元凶，只记有动作的对等于没记。
    if (typeof service.saveConflictReviewed === "function") {
      // judged_at 取的是**发送之前**的时刻（见函数开头），不是落地之后：LLM 往返
      // 期间若一侧被外部改动，它的 updated_at 会晚于 judged_at，下一轮自然重新入池；
      // 模型看到的本来就是旧快照，按"已审"封盘等于用陈旧结论锁死这一对。
      const outcomeOf = new Map();
      for (const d of decisions) {
        const action = d?.action ?? "keep";
        if (action === "conflict" || action === "supersede") {
          if (typeof d?.winner === "string") outcomeOf.set(d.winner, action);
          if (typeof d?.loser === "string") outcomeOf.set(d.loser, action);
        } else if (Array.isArray(d?.ids)) {
          for (const id of d.ids) outcomeOf.set(id, action);
        }
      }
      // Issue #536 review（CodeRabbit ③）：未落地的对不记账。skipped（非法被跳）、
      // failures（写入失败）、conflicts（CAS 冲突）里出现过的 id，说明那条决策没生效；
      // 把它记成"已审"会让下一轮的 alreadyJudged 为真，这一对从此不再送审——
      // 沉默地永久压制一个真实冲突，比多送一轮贵得多。
      const unsettled = new Set();
      for (const f of [...(failures ?? []), ...(conflicts ?? []), ...(skipped ?? [])]) {
        for (const id of f?.ids ?? []) unsettled.add(id);
      }
      for (const p of batch) {
        if (unsettled.has(p.a.id) || unsettled.has(p.b.id)) continue;
        try {
          service.saveConflictReviewed({
            run_id: runId,
            memory_a: p.a.id,
            memory_b: p.b.id,
            // 一对两端的动作可能不同（conflict 的胜/败、merge 的两端），取**非 keep
            // 的那一侧**：keep/keep 才代表"看过、不冲突"，这正是我们要留痕的结论。
            outcome: [outcomeOf.get(p.a.id), outcomeOf.get(p.b.id)]
              .find((x) => x && x !== "keep") ?? "keep",
            judged_at: judgedAt
          });
        } catch (error) {
          logger?.warn?.(`dsh-mneme sleep: failed to record reviewed conflict ${p.a.id}/${p.b.id}: ${String(error)}`);
        }
      }
    }
    // Issue #126 review（Copilot）：有决策被跳过时不能报 ok——与 dream 的 degraded 契约
    // 对齐（"合法子集已应用"是 degraded 而非 ok），否则消费方分不清整轮与残轮。
    return { status: applied > 0 ? (skipped.length > 0 ? "degraded" : "ok") : failures.length ? "failed" : "noop", applied, failures, conflicts, skipped, updateUsed };
  };
  // 分批：每批独立往返，坏批只记 degraded 不中断。此前一次全送，任何一处理由
  // （撞上下文、输出截断、JSON 坏掉）都是整轮 failed——而整轮 failed 又不带 pairs，
  // 事后看不出它到底送了什么。
  const batchSize = config.sleepConflictMaxPairs ?? 12;
  const batches = batchSize > 0
    ? Array.from({ length: Math.ceil(pool.length / batchSize) }, (_, i) => pool.slice(i * batchSize, (i + 1) * batchSize))
    : [pool];
  let applied = 0;
  const failures = [];
  const conflicts = [];
  const skipped = [];
  let failedBatches = 0;
  // 用户活动打断时**不能**落进下面那条 noop：noop 的语义是「看过，没冲突」，而被打断
  // 的那几批根本没送出去。用与入口处（signal 一开始就是 aborted）同一个词汇，避免
  // 同一件事两个状态名。
  let interrupted = false;
  // Issue #536 review（CodeRabbit ②）：reflectionUpdateMaxPerRun 是**整轮**上限。
  // 校验器本身不跨批记忆，每批各拿一份满额就等于 N 倍上限，所以额度由这里持有：
  // 每批只领剩余额度，校验通过后按**本批通过校验的** update 数扣减。额度用尽的
  // 那几批若还含 update，会被校验器整单拒绝（记 failed），其余批照常继续——
  // 与"一批坏掉不判死整轮"的既有契约一致。
  let updateLeft = config.reflectionUpdateMaxPerRun ?? 2;
  for (let i = 0; i < batches.length; i++) {
    if (signal?.aborted) { interrupted = true; break; }
    const res = await adjudicateBatch(batches[i], updateLeft);
    if (res.status === "failed") {
      failedBatches++;
      failures.push(...(res.failures ?? []));
      skipped.push(...(res.skipped ?? []));
      // 失败批的原始理由（stream 层的 abort/error 原文）要进审计：只写 "llm failed"
      // 的话，运维分不清是上下文超限、模型拒收还是用户活动打断。
      logger?.warn?.(`dsh-mneme sleep: conflict batch ${i + 1}/${batches.length} failed: ${res.error}${res.failure ? ` (${res.failure})` : ""}`);
      continue;
    }
    applied += res.applied;
    updateLeft = Math.max(0, updateLeft - (res.updateUsed ?? 0));
    failures.push(...(res.failures ?? []));
    conflicts.push(...(res.conflicts ?? []));
    skipped.push(...(res.skipped ?? []));
  }
  const degraded = skipped.length > 0 || failedBatches > 0;
  // 一批都没成功才算整轮失败；只要有一批落地，如实记 degraded——这跟 deriveStatus
  // 的契约一致（degraded 也算有产出）。
  const allFailed = failedBatches === batches.length;
  // 有一批没走通时整轮**绝不能报 noop**：noop 的语义是「看过，没冲突」，而踩了
  // llm failed 的那批其实没看过。这是 #529 里最误导人的一处——23 轮失败期间
  // applied 恒为 0，若再叠上 noop，运维只会以为库里没冲突。
  const status = interrupted
    ? "aborted"
    : allFailed
    ? "failed"
    : applied > 0
      ? (degraded ? "degraded" : "ok")
      : failures.length
        ? "failed"
        : failedBatches > 0
          ? "degraded"
          : "noop";
  return {
    status,
    // Issue #529 D：失败轮也要带 pairs/batches——此前只有成功路径带 pairs，85 条
    // 失败审计行全是"送了个寂寞"，连送了多少对都查不到。
    pairs: selected.length,
    // #533：这一轮被账本压掉、没送 LLM 的候选对数——不记的话「pairs 变小了」
    // 分不清是没检测到还是已经裁决过。
    suppressed,
    batches: batches.length,
    ledgerSkipped,
    perRunSkipped,
    applied,
    failures,
    conflicts,
    // Issue #126：#104 同向——被跳过的逐对明细要进审计行，否则事后无法判断
    // 是哪一对、因何被跳过（此前只进 logger.warn，splice 后就地消失）。
    skipped
  };
}

/**
 * Phase 2 — archival demotion. No LLM: tiering is time-based, summaries are
 * truncations, and the full body is preserved in _full_content so nothing is
 * lost. Deterministic and cheap, so it runs even with no LLM route.
 */
function phaseDemotion(service, config, logger, runId, signal = null) {
  const archiveDays = config.sleepArchiveDays ?? 30;
  const compressDays = config.sleepCompressDays ?? 90;
  const archiveCut = Date.now() - archiveDays * 86400000;
  const compressCut = Date.now() - compressDays * 86400000;
  const demoted = [];
  const archived = [];
  // 政策轴在这里尤其要紧：下面两行会真改归档面（setArchived / demoteToSummary）。
  // 把过滤放在循环之外、而不是在循环体里 continue：一旦将来有人在循环体里加
  // 副作用（现已有），漏掉那条 continue 就是静默改到被按下的行。
  // 外来行也在循环之外挡掉，同一个理由：它不经本方蒸馏，时间分层无权动它的原文或
  // 归档面；而下面两行动作（setArchived / demoteToSummary）不经 saveWithDedupe，
  // 汇流口那道闸门到这里已经管不到了。
  for (const m of withoutPaused(service, service.all().filter((m) => !isImportedRow(m)))) {
    if (signal?.aborted) break;
    if (m.archived || m.forgotten) continue;
    const ref = m.last_accessed_at ?? m.created_at;
    if (!ref) continue;
    const t = new Date(ref).getTime();
    if (Number.isNaN(t)) continue;
    // v0.7.0 热联合判定（仅 heatEnabled 时启用；默认关则退回纯时间分层，
    // 与 v0.7.12 行为一致）：时间窗之外再加两道保护闸——热度低于
    // sleepHeatThreshold 且 importance<5 才允许降级。λ=0 的免疫类型 heat 恒
    // 1.0 天然豁免（preference/pattern/summary 永不因 sleep 降级）；importance
    // ≥5 的紧要记忆无论多冷都保留。`冷但重要` 与 `热但低值` 均不满足条件。
    const heatOn = config.heatEnabled !== false;
    if (heatOn) {
      const heat = computeHeat(m, Date.now(), config);
      const heatProtected = heat >= (config.sleepHeatThreshold ?? 0.05);
      const important = (m.importance ?? 0) >= 5;
      if (heatProtected || important) continue;
    }
    if (t < compressCut) {
      service.setArchived(m.id, true);
      archived.push(m.id);
    } else if (t < archiveCut) {
      // minRefTimeMs re-checks freshness inside demoteToSummary's transaction:
      // a recall touch landing after this snapshot must not demote the memory.
      service.demoteToSummary(m.id, makeSummary(m), { minRefTimeMs: archiveCut });
      demoted.push(m.id);
    }
  }
  return {
    status: demoted.length || archived.length ? "ok" : "noop",
    demoted,
    archived
  };
}

/**
 * Phase 3 — pattern discovery. The LLM scans the most recent memories and
 * mints type=pattern entries (create actions) with evidence references.
 * The empty snapshot is intentional: create claims no existing id, so the
 * "every id claimed" invariant is trivially satisfied for pure-create lists.
 */
async function phasePatterns(ctx, service, config, logger, runId, signal = null) {
  const language = langOf(config);
  const route = resolveSleepRoute(ctx, config, logger);
  if (!route) return { status: "skipped", reason: "no llm route" };
  const limit = config.sleepPatternMinMemories ?? 100;
  // #230：document 在查询层排除（excludeTypes）而不是截断后过滤——LIMIT 200
  // 先生效的话，指针行一多就会把普通记忆挤出扫描窗，池子饿到门槛以下。
  // 政策轴同理必须排在 `.slice(0, limit)` **之前**，否则被按下的行照样占掉
  // sleepPatternMinMemories 的名额，而它们既不会被扫、也不该挤掉别人（#471）。
  //
  // archived 这一轴不在下面出现，不是漏了：list() 默认就带 `archived = 0`
  // （store.js list 的 includeArchived 默认 false、onlyArchived 默认 false），
  // 旧写法那句 `!m.archived` 一直是重复过滤——查询层已经把它挡在外面。
  // 窗口至少等于本次要扫的名额：`sleepPatternMinMemories` 的合法上限是 1000
  // （src/config.js:612）。窗口若还是死的 200，那么把这个值配到 200 以上的人
  // **每一轮**都会触发下面那次无界重取，跟闸门按没按下无关——那是把这条修复
  // 从「按需」变成「常付」。
  const poolQuery = {
    limit: Math.max(200, limit), includeForgotten: false,
    // 三条政策轴全部下推到查询层：留在 LIMIT 之后过滤，等于让被丢掉的行为窗口占名额
    // （模式扫描池会因此饿到 sleepPatternMinMemories 以下而静默跳过）。同一取舍见
    // #230 的 document 轴与本文件 #471 的暂停轴，src/service.js:2247 那条注释记着前例。
    excludeTypes: ["document", "summary", "pattern"],
    excludeImported: true
  };
  const gather = (query) => withoutPaused(service, service.list(query));
  let pool = gather(poolQuery);
  // #515：暂停闸门要读 scope_state 并按「这一维有标注」匹配，下推进 SQL 就等于让判定
  // 长出第二份实现（issue 里写过为什么否掉，`*` 那一行是关键的不可下推处）。所以这里
  // 不动判定、只放宽取数：**只有窗口过滤后不够本次要扫的名额**才不带窗口重取一次。
  // 常态仍只付一次有界查询；多付的那一次恰好就是原本会静默跳过的那一次——
  // 症状从「库里没东西可扫」变成「扫了」，这才是这条闸门该有的行为。
  if (pool.length < limit) pool = gather({ ...poolQuery, limit: null });
  const memories = pool
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, limit);
  if (memories.length === 0) return { status: "skipped", reason: "no memories to scan" };
  if (signal?.aborted) return { status: "aborted", reason: "user activity" };
  const listText = memories
    .map((m) => `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}`)
    .join("\n");
  const maxPatterns = config.sleepMaxPatternPerRun ?? 3;
  const sleepEffort = await resolveDreamEffort(ctx, route, config.sleepReasoningEffort, logger);
  let patternStreamFailure = "";
  const runPattern = (withEffort, tokens) => {
    patternStreamFailure = "";
    return auditedSleepLlm(ctx, service, config, logger, {
      triggerSource: "sleep",
      operationType: "sleep_pattern",
      modelId: `${route.provider}:${route.model}`,
      // 本轮扫描的记忆 id：与 dream 的 relatedMemoryIds 同义，供面板解析沉淀条数。
      relatedMemoryIds: memories.map((m) => m.id),
      streamError: () => patternStreamFailure,
      // 纯判据，同 conflict 阶段：不把解析结果存进闭包供控制流使用。
      auditError: (text) => (parseJsonArray(text) ? null : "no json array in llm output"),
      // 纯判据，与 auditError 同一条约定：重解析一次、不读闭包（审计关掉时那些闭包
      // 根本不会被赋值，读它会让「审计说了什么」依赖调用方走到了哪一行）。
      metadataFrom: (text) => (parseJsonArray(text) ? null : parseFailureMeta(text))
    }, (reportUsage) => streamText(ctx, {
    provider: route.provider,
    model: route.model,
    purpose: "sleep-pattern",
    maxTokens: tokens,
    ...(withEffort && sleepEffort ? { reasoningEffort: sleepEffort } : {}),
    messages: [
      { role: "system", content: [{ type: "text", text: STR.prompts.pattern[language].replace("N", String(maxPatterns)) }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
      { role: "user", content: [{ type: "text", text: fenceListBody(language, listText) }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
    ]
  }, reportUsage, (reason) => { patternStreamFailure = describeStreamFailure(reason); }));
  };
  const text = await withMaxTokensFallback(ctx, config.sleepMaxTokens ?? 2048, (tokens) => withEffortFallback(ctx, sleepEffort, () => runPattern(true, tokens), () => runPattern(false, tokens), () => patternStreamFailure), () => patternStreamFailure);
  if (text === undefined) {
    if (patternStreamFailure) ctx.logger?.warn?.(`dsh-mneme sleep: pattern stream aborted or errored (${patternStreamFailure})`);
    return { status: "failed", error: "llm failed" };
  }
  const decisions = parseJsonArray(text);
  if (!decisions || decisions.length === 0) return { status: "skipped", reason: "no patterns found" };
  // Evidence ids are provenance refs; an LLM-fabricated id would mint a dead
  // ev:tag pointing nowhere. Intersect evidence with the scanned set so only
  // real memory references survive.
  const scannedIds = new Set(memories.map((m) => m.id));
  for (const d of decisions) {
    if (d?.action === "create" && Array.isArray(d.evidence)) {
      d.evidence = d.evidence.filter((id) => typeof id === "string" && scannedIds.has(id));
    }
  }
  const snapshot = new Map();
  const { ok, errors } = validateDecisions(decisions, snapshot, {
    maxCreatePerRun: maxPatterns
  });
  if (!ok) return { status: "failed", error: `invalid decisions: ${errors.join("; ")}` };
  // 本相位的 create 落 source=sleep。来源从管道给而非从决策对象取——见
  // applyDecisions 的 @param config。
  const { applied, failures, conflicts } = applyDecisions(
    decisions, service, logger, snapshot, { ...config, mintSource: "sleep" }
  );
  return {
    status: applied > 0 ? "ok" : "noop",
    scanned: memories.length,
    applied,
    failures,
    conflicts
  };
}

/**
 * Phase 4 — entity relation completion. Detects orphan entities (zero
 * relations) and completes implied relations from memory co-occurrence:
 * entities named in the same memory → related_to; container kinds
 * (project/module) → part_of; tech-ish pairs → depends_on. Deterministic,
 * no LLM — cheap, so it runs even without a route. saveRelation is
 * bookkeeping (no write hook), so it never re-triggers the scheduler.
 */
function inferRelationType(a, b) {
  if ((a.type === "project" || a.type === "module") && a.type !== b.type) return "part_of";
  if ((b.type === "project" || b.type === "module") && b.type !== a.type) return "part_of";
  if (/npm|plugin|api|sdk|lib|framework|package|deps?|build/i.test(`${a.name} ${b.name}`)) return "depends_on";
  return "related_to";
}

function phaseRelations(service, config, logger, runId, signal = null) {
  const entities = service.listEntities({ limit: 1000 }) ?? [];
  if (entities.length < 2) return { status: "skipped", reason: "too few entities" };
  const orphans = entities.filter((e) => (service.getRelations(e.id) ?? []).length === 0);
  if (orphans.length === 0) return { status: "skipped", reason: "no orphan entities" };
  const memories = withoutPaused(service, service.all().filter((m) => !isImportedRow(m) && !m.archived && !m.forgotten));
  const seen = new Set();
  const related = [];
  const MAX_RELATIONS_PER_ORPHAN = 3;
  for (const o of orphans) {
    if (signal?.aborted) break;
    let made = 0;
    for (const m of memories) {
      if (signal?.aborted || made >= MAX_RELATIONS_PER_ORPHAN) break;
      const text = `${m.title ?? ""} ${m.content ?? ""}`;
      if (!text.includes(o.name)) continue;
      for (const other of entities) {
        if (other.id === o.id || other.name === o.name) continue;
        const key = [o.id, other.id].sort().join("|");
        if (seen.has(key)) continue;
        if (!text.includes(other.name)) continue;
        const relationType = inferRelationType(o, other);
        try {
          service.saveRelation({ from_entity: o.id, to_entity: other.id, relation_type: relationType, memory_id: m.id, metadata: { source: "sleep_relation_completion" } });
          seen.add(key);
          related.push({ from: o.id, to: other.id, type: relationType });
          made++;
        } catch (error) {
          logger?.warn?.(`dsh-mneme sleep: relation ${o.id}/${other.id} failed: ${String(error)}`);
        }
      }
    }
  }
  return {
    status: related.length > 0 ? "ok" : "noop",
    orphanCount: orphans.length,
    related
  };
}

// ---------------------------------------------------------------- run

function deriveStatus(phases) {
  const list = Object.values(phases);
  if (list.length === 0) return "noop";
  const anyError = list.some((p) => p.status === "failed" || p.status === "error");
  // Issue #126 review（Copilot）：phase 自身可以是 degraded（合法子集已应用但有条目被
  // 跳过），它同样算"有产出"——否则整轮会被误判成 noop，把真实变更报成空轮。
  const anyWork = list.some((p) => p.status === "ok" || p.status === "degraded");
  const anyDegraded = list.some((p) => p.status === "degraded");
  // Issue #529：被打断（用户恢复活动）既不是失败也不是"没活干"。相位层已经用
  // aborted 区分了这两种，整轮层若回落到 noop，审计行就又把"没跑完"记成"跑过、
  // 没什么事"——所以这里也给它一个自己的名字。只在没有任何产出时生效：真的落了
  // 东西就是 ok/degraded，真的报错就是 failed，二者都比 aborted 值得优先播报。
  const anyAborted = list.some((p) => p.status === "aborted");
  if (anyDegraded) return "degraded";
  if (anyWork && anyError) return "degraded";
  if (anyError) return "failed";
  if (anyWork) return "ok";
  if (anyAborted) return "aborted";
  return "noop";
}

/**
 * Run one full sleep cycle. Best-effort across all phases; writes a
 * run_type='sleep' audit row (same dream_runs table) so sleep activity is
 * observable alongside consolidation runs.
 */
export async function runSleep(ctx, service, config, logger, semantic = null, signal = null) {
  const runId = randomUUID();
  // Issue #89：开跑时刻——审计行 created_at 的基准（= 冷却种子），run 耗时
  // （LLM 各 phase）不应计入重启后的冷却窗口。
  const sleepStartedAt = Date.now();
  const phases = {};
  const attempt = async (name, fn) => {
    if (signal?.aborted) return; // user resumed activity — stop before next phase
    try {
      phases[name] = await fn();
    } catch (error) {
      phases[name] = { status: "failed", error: error?.message ?? String(error) };
      logger?.warn?.(`dsh-mneme sleep: ${name} phase failed: ${error?.message ?? error}`);
    }
  };
  await attempt("conflicts", () => phaseConflicts(ctx, service, config, logger, runId, semantic, signal));
  await attempt("demotion", () => phaseDemotion(service, config, logger, runId, signal));
  await attempt("patterns", () => phasePatterns(ctx, service, config, logger, runId, signal));
  await attempt("relations", () => phaseRelations(service, config, logger, runId, signal));

  const status = deriveStatus(phases);
  const route = resolveSleepRoute(ctx, config, logger);
  const totalApplied = Object.values(phases).reduce((n, p) => n + (Number.isInteger(p?.applied) ? p.applied : 0), 0);
  // Issue #126（与 #104 同向）：把各 phase 的跳过明细汇总成一行审计数据，带 phase
  // 名（同一次 run 里 conflicts 与 patterns 都可能产出 skipped）。全空时写 NULL，
  // 不落空数组——审计行只记真实发生过的跳过。
  const skippedDetail = Object.entries(phases).flatMap(([phase, p]) =>
    Array.isArray(p?.skipped) ? p.skipped.map((s) => ({ phase, ...s })) : []
  );
  const snapshotHash = createHash("sha256").update(JSON.stringify(phases)).digest("hex");
  const receipt = buildReceipt({
    runId,
    status,
    snapshotHash,
    inputCount: 0,
    applied: totalApplied,
    summaryStored: false
  });
  try {
    service.saveDreamRun({
      id: runId,
      // Issue #89：审计行记开跑时刻而非完成时刻——run 耗时（含 LLM 各 phase）
      // 不该计入重启后的 sleep 冷却种子。
      created_at: new Date(sleepStartedAt).toISOString(),
      status,
      provider: route?.provider,
      model: route?.model,
      snapshot_hash: snapshotHash,
      input_count: 0,
      input: null,
      decisions: phases,
      outcome: phases,
      applied: totalApplied,
      summary_stored: false,
      receipt,
      policy_epoch: config.policyEpoch ?? 0,
      run_type: "sleep",
      skipped: skippedDetail.length ? skippedDetail : undefined
    });
  } catch (error) {
    logger?.warn?.(`dsh-mneme sleep: failed to record audit run: ${String(error)}`);
  }
  return { ok: status === "ok" || status === "degraded", status, runId, phases, receipt };
}

// ---------------------------------------------------------------- scheduler

/**
 * Idle-triggered scheduler. DSH plugins have no resident cron, so a sleep run
 * fires when: sleep is enabled, the store has been quiet for sleepIdleMinutes,
 * and the previous run is older than sleepMinIntervalHours. noteWrite() is
 * called on every store write and (re)arms an idle timer that re-checks at the
 * exact moment the idle window elapses — no polling, no cron.
 *
 * A `now` clock can be injected for tests; it defaults to Date.now.
 */
export function createSleepScheduler({
  service,
  config,
  logger,
  onRun = null,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  // Issue #89 同族：冷却时刻由调用方从 dream_runs 审计表恢复（run_type='sleep'）——
  // 内存变量进程重启即归零，冷却闸对新实例放行 → 重启后立即进入 sleep 冷却盲区。
  // 测试注入 0（默认）即保持旧行为。
  lastRunAtSeed = 0
}) {
  let lastWriteAt = now();
  let lastRunAt = lastRunAtSeed;
  let running = false;
  let disposed = false;
  let idleTimer = null;
  let sleepAbort = null;
  // Issue #529（C 项）：同一进程内的连续失败计数。失败（run 报 status="failed"
  // 或抛错）+1，其余一律清零（ok/degraded/noop——noop 说明 LLM 通路是好的，
  // 只是没活干，不该被当成失败拖着退避）。纯内存变量、宿主重启归零：跨重启的
  // 冷却本来就由 lastRunAtSeed（#89/#291）负责，两者不重叠。
  let consecutiveFailures = 0;

  // Issue #529：有效最小间隔 = 基数 × 2^连续失败数，封顶 24 小时。关闭或尚无
  // 失败时逐字节返回基数（默认关 = 行为与现状一致）。封顶取 max(基数, cap)，
  // 指数再大也不会把用户配的大基数压小。
  function effectiveMinIntervalMs() {
    const base = (config.sleepMinIntervalHours ?? 8) * 3600000;
    if (config.sleepFailureBackoff !== true || consecutiveFailures <= 0) return base;
    const cap = Math.max(base, FAILURE_BACKOFF_CAP_MS);
    return Math.min(base * 2 ** consecutiveFailures, cap);
  }

  function armIdleTimer() {
    if (disposed || idleTimer) return;
    if (config.sleepModeEnabled !== true) return;
    const idleMs = (config.sleepIdleMinutes ?? 5) * 60000;
    const delay = Math.max(0, idleMs - (now() - lastWriteAt)) + 1000;
    idleTimer = setTimeoutFn(async () => {
      idleTimer = null;
      // Issue #187：false = 撞上 CD（或 run 失败）——此前这里直接丢弃，"CD 到期"
      // 成了没有监听者的时刻，要等下一次写入才救回来。改为按剩余窗口重排。
      const ran = await maybeSchedule();
      if (!ran) armNextWindow();
    }, delay);
    idleTimer.unref?.();
  }

  // Issue #187：撞 CD / run 失败后的补挂表——按「剩余 CD / 剩余静默」里更晚的
  // 到点时刻重排一次，回调里重复同样的判断所以不会空转。跑成了一轮就不重排：
  // 安静的库没有要处理的新东西，触发权交还给下一次写入的 noteWrite。
  function armNextWindow() {
    if (disposed || idleTimer) return;
    if (config.sleepModeEnabled !== true) return;
    // lastRunAt === 0 表示从未跑过（此路径不该出现，防御性返回）。
    if (lastRunAt <= 0) return;
    const idleMs = (config.sleepIdleMinutes ?? 5) * 60000;
    // Issue #529：这里必须和 shouldRun 用同一个有效间隔，否则退避期里重排的闹钟
    // 会在基数到点就响、然后被 shouldRun 否掉再重排——空转一串没有意义的定时器。
    const cdMs = effectiveMinIntervalMs();
    const delay = Math.max(
      lastRunAt + cdMs - now(),
      lastWriteAt + idleMs - now(),
      0
    ) + 1000;
    idleTimer = setTimeoutFn(async () => {
      idleTimer = null;
      const ran = await maybeSchedule();
      if (!ran) armNextWindow();
    }, delay);
    idleTimer.unref?.();
  }

  function shouldRun(at = now()) {
    if (disposed || running) return false;
    if (config.sleepModeEnabled !== true) return false;
    if (at - lastWriteAt < (config.sleepIdleMinutes ?? 5) * 60000) return false;
    // lastRunAt === 0 means never ran — the min-interval check must not block
    // the very first cycle (a real run stamps a nonzero timestamp).
    // Issue #529：连败退避开启时改用指数放大的有效间隔——恒定失败的模型不再按
    // 固定节奏连发（#529 实测连续 23 轮 llm failed），只会越打越稀。
    if (lastRunAt > 0 && at - lastRunAt < effectiveMinIntervalMs()) return false;
    return true;
  }

  /** Called on writes: resets the idle clock and re-arms the fire timer. The
   *  pending timer is cleared first — a stale timer armed against the old idle
   *  window would otherwise fire early, fail shouldRun, and leave nothing armed
   *  for the next window (a missed trigger until the next write).
   *
   *  While a sleep run is executing (running=true) the in-flight AbortController
   *  is NOT aborted: the run's own writes (demoteToSummary / setArchived ride
   *  the normal write-hook path) would otherwise self-abort the cycle. External
   *  activity during the run still resets the idle clock here, so no new cycle
   *  fires until the store is quiet again. */
  function noteWrite() {
    lastWriteAt = now();
    if (!running && sleepAbort) {
      sleepAbort.abort(); // user resumed activity — interrupt an idle run
    }
    if (idleTimer) {
      clearTimeoutFn(idleTimer);
      idleTimer = null;
    }
    armIdleTimer();
  }

  async function maybeSchedule() {
    if (!shouldRun()) return false;
    running = true;
    const abort = new AbortController();
    sleepAbort = abort;
    try {
      lastRunAt = now();
      const result = await service.enqueue(() =>
        onRun ? onRun(abort.signal) : Promise.resolve({ ok: true, skipped: true })
      );
      // Issue #529：连败计数只在这里加减。判据优先看 result.status——runSleep 的
      // ok 只在 ok/degraded 时为真，noop（LLM 通路正常、只是没活干）和用户活动
      // 打断都会给出 ok:false，把它当失败会让退避在自己工作良好的库里越退越长。
      // 回落到 !result.ok 只是为了兼容注入的 no-op 桩（没有 status 字段）。
      // result 为空（最小测试替身）＝完成且无失败，不动计数，与 #292 口径一致。
      if (result) {
        const failed = typeof result.status === "string" ? result.status === "failed" : !result.ok;
        consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
      }
      return !!(result && result.ok);
    } catch (error) {
      logger?.warn?.(`dsh-mneme sleep: run failed: ${error?.message ?? error}`);
      consecutiveFailures += 1; // Issue #529：抛错同样计入连败
      return false;
    } finally {
      sleepAbort = null;
      running = false;
    }
  }

  async function dispose() {
    disposed = true;
    if (idleTimer) {
      clearTimeoutFn(idleTimer);
      idleTimer = null;
    }
    if (sleepAbort) {
      sleepAbort.abort();
      sleepAbort = null;
    }
  }

  // Issue #187（同族缺陷）：构造即挂表——重启后只要没发生过写入，此前永远没有
  // 闹钟，安静多久都不会触发。lastWriteAt 已在构造时设为当前时刻，shouldRun 的
  // 静默条件自然生效：重启后静默满 idleMinutes 才可能起跑。
  armIdleTimer();

  return { noteWrite, maybeSchedule, shouldRun, dispose };
}
