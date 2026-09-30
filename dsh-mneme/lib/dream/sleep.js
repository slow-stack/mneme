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
import { buildReceipt, describeStreamFailure, resolveDreamEffort, withEffortFallback, maintainIndexAfterDream } from "../dream.js";
import { computeHeat } from "../heat.js";

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
  try {
    const result = await body((usage) => {
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
        related_memory_ids: spec.relatedMemoryIds ?? []
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
  const memories = service.all().filter((m) => !m.archived && !m.forgotten && m.type !== "summary" && m.type !== "document");
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
  const used = new Set();
  const selected = [];
  for (const p of pairs) {
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
  const isCrossScopePair = (p) =>
    scopeKeyOf(p.a.agent_scope) !== scopeKeyOf(p.b.agent_scope)
    || scopeKeyOf(p.a.workspace_scope) !== scopeKeyOf(p.b.workspace_scope);
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
    return { status: scopeParked > 0 ? "ok" : "noop", frozen: 0, scopeCandidates: scopeParked, pairs: selected.length };
  }

  // LLM adjudication（仅同 scope 对）。
  const route = resolveSleepRoute(ctx, config, logger);
  if (!route) return { status: "skipped", reason: "no llm route", scopeCandidates: scopeParked, pairs: selected.length };
  const snapshot = new Map();
  for (const p of samePairs) {
    snapshot.set(p.a.id, p.a);
    snapshot.set(p.b.id, p.b);
  }
  const listText = samePairs.map((p) =>
    STR.candidateConflicts[language](p)
  ).join("\n\n");
  const sleepEffort = await resolveDreamEffort(ctx, route, config.sleepReasoningEffort, logger);
  let conflictStreamFailure = "";
  // actionSet 已在候选构造前解析（跨类型候选需要它），这里只按档位选 prompt：
  // 默认档保持只有 conflict/keep 的窄 prompt，"full" 才开放六分支。
  const conflictPrompt = actionSet === "full" ? STR.prompts.conflictFull[language] : STR.prompts.conflict[language];
  const runConflict = (withEffort) => {
    conflictStreamFailure = "";
    return auditedSleepLlm(ctx, service, config, logger, {
      triggerSource: "sleep",
      operationType: "sleep_conflict",
      modelId: `${route.provider}:${route.model}`,
      // 候选对的双方 id：面板的活动流用 related_memory_ids 解析「沉淀条数」。
      relatedMemoryIds: samePairs.flatMap((p) => [p.a.id, p.b.id]),
      streamError: () => conflictStreamFailure,
      // 纯判据：输出里没有 JSON 数组 ⇒ 这轮是失败的调用，审计记 error。**不要**把
      // 解析结果存进闭包给下面的控制流用——审计关闭时 auditedSleepLlm 整段早退、
      // 这个钩子不会被调用，控制流会跟着失效（dream 的既有坑）。代价是审计开启时
      // 多解析一次，换来两条路径彻底解耦。
      auditError: (text) => (parseJsonArray(text) ? null : "no json array in llm output")
    }, (reportUsage) => streamText(ctx, {
    provider: route.provider,
    model: route.model,
    purpose: "sleep-conflict",
    maxTokens: config.sleepMaxTokens ?? 2048,
    ...(withEffort && sleepEffort ? { reasoningEffort: sleepEffort } : {}),
    messages: [
      { role: "system", content: [{ type: "text", text: conflictPrompt }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
      { role: "user", content: [{ type: "text", text: listText }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
    ]
  }, reportUsage, (reason) => { conflictStreamFailure = describeStreamFailure(reason); }));
  };
  const text = await withEffortFallback(ctx, sleepEffort, () => runConflict(true), () => runConflict(false), () => conflictStreamFailure);
  if (text === undefined) {
    if (conflictStreamFailure) ctx.logger?.warn?.(`dsh-mneme sleep: conflict stream aborted or errored (${conflictStreamFailure})`);
    return { status: "failed", error: "llm failed" };
  }
  const decisions = parseJsonArray(text);
  if (!decisions) return { status: "failed", error: "invalid decisions json" };
  // validateDecisions 要求每个 snapshot id 恰好被 claim 一次。v0.4.4 起它本身
  // 就会为未覆盖的 id 自动补 keep（dreamImplicitKeep 默认开启），这里保留显式
  // 预填作为防御性双保险——漏判读作"未裁决冲突"而非"冲突阶段整体失败"。
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
  for (const id of snapshot.keys()) {
    if (!covered.has(id)) decisions.push({ action: "keep", ids: [id] });
  }
  // Issue #126：sleep 是多对批量裁决，严格模式"一票否决"太脆（一对非法就丢掉整轮
  // 成果）→ 与 dream 对齐透传 skipInvalid：非法的那一对只跳过自己，合法子集照常
  // 应用，run 记 degraded。update 上限与保护期同样取 dream 的同一组配置，保证两个
  // 模块对"什么算合法"的判据一致。
  const { ok, errors, skipped } = validateDecisions(decisions, snapshot, {
    maxUpdatePerRun: config.reflectionUpdateMaxPerRun,
    minAgeHours: config.reflectionUpdateMinAgeHours,
    skipInvalid: config.dreamSkipInvalid !== false,
    allowCrossTypeMerge: config.allowCrossTypeMerge === true,
    // issue #339 / E8：guarded 类型 merge 护栏（opt-in，dreamMergeGuard），
    // 与 dream 主链路同一判据。
    mergeGuard: config.dreamMergeGuard === true,
    // Issue #126 review（Copilot）：默认档必须真的只放行旧动作集——只换 prompt 挡不住
    // 模型自发输出 supersede / differentiate，那样"opt-in 零行为变化"就不成立。
    allowedActions: actionSet === "full" ? null : LEGACY_ACTIONS
  });
  if (!ok) return { status: "failed", error: `invalid decisions: ${errors.join("; ")}`, skipped };
  const { applied, failures, conflicts } = applyDecisions(decisions, service, logger, snapshot, config);
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
  // Issue #126 review（Copilot）：有决策被跳过时不能报 ok——与 dream 的 degraded 契约
  // 对齐（"合法子集已应用"是 degraded 而非 ok），否则消费方分不清整轮与残轮。
  const degraded = skipped.length > 0;
  return {
    status: applied > 0 ? (degraded ? "degraded" : "ok") : failures.length ? "failed" : "noop",
    pairs: selected.length,
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
  for (const m of service.all()) {
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
  const memories = service
    .list({ limit: 200, includeForgotten: false, excludeTypes: ["document"] })
    .filter((m) => !m.archived && m.type !== "summary" && m.type !== "pattern")
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
  const runPattern = (withEffort) => {
    patternStreamFailure = "";
    return auditedSleepLlm(ctx, service, config, logger, {
      triggerSource: "sleep",
      operationType: "sleep_pattern",
      modelId: `${route.provider}:${route.model}`,
      // 本轮扫描的记忆 id：与 dream 的 relatedMemoryIds 同义，供面板解析沉淀条数。
      relatedMemoryIds: memories.map((m) => m.id),
      streamError: () => patternStreamFailure,
      // 纯判据，同 conflict 阶段：不把解析结果存进闭包供控制流使用。
      auditError: (text) => (parseJsonArray(text) ? null : "no json array in llm output")
    }, (reportUsage) => streamText(ctx, {
    provider: route.provider,
    model: route.model,
    purpose: "sleep-pattern",
    maxTokens: config.sleepMaxTokens ?? 2048,
    ...(withEffort && sleepEffort ? { reasoningEffort: sleepEffort } : {}),
    messages: [
      { role: "system", content: [{ type: "text", text: STR.prompts.pattern[language].replace("N", String(maxPatterns)) }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
      { role: "user", content: [{ type: "text", text: listText }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
    ]
  }, reportUsage, (reason) => { patternStreamFailure = describeStreamFailure(reason); }));
  };
  const text = await withEffortFallback(ctx, sleepEffort, () => runPattern(true), () => runPattern(false), () => patternStreamFailure);
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
  const { applied, failures, conflicts } = applyDecisions(decisions, service, logger, snapshot, config);
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
  const memories = service.all().filter((m) => !m.archived && !m.forgotten);
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
  if (anyDegraded) return "degraded";
  if (anyWork && anyError) return "degraded";
  if (anyError) return "failed";
  if (anyWork) return "ok";
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
    const cdMs = (config.sleepMinIntervalHours ?? 8) * 3600000;
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
    if (lastRunAt > 0 && at - lastRunAt < (config.sleepMinIntervalHours ?? 8) * 3600000) return false;
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
      return !!(result && result.ok);
    } catch (error) {
      logger?.warn?.(`dsh-mneme sleep: run failed: ${error?.message ?? error}`);
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
