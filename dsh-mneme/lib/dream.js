import { validateDecisions, applyDecisions } from "./dream/decisions.js";
import { clusterMemories, findPotentialConflicts, cosineSimilarity } from "./dream/clustering.js";
import { clusterByTag, intersectEvidence } from "./dream/narratives.js";
import { scopeKeyOf } from "./scope.js";
// Issue #239（第 4 项）镜像到巩固：错峰时段解析与「最近的高峰结束时刻」从独立的
// 零依赖模块 peak-hours.js 取（该模块从 summarize.js 抽出，PR #320 review）——
// 不另写一份解析器，两份实现漂移会让「同一个时段串在两处行为不同」，那比没有
// 这个功能更糟。此前直接 import summarize.js，#316 后 summarize 反向依赖 dream
// （withEffortFallback 复用），会成真循环，故抽模块。
import { isInPeakWindow, nextOffPeakAt } from "./peak-hours.js";
import { createHash, randomUUID } from "node:crypto";
import { STR, langOf } from "./lang.js";
export { validateDecisions, applyDecisions, withEffortFallback, describeStreamFailure, resolveDreamEffort, resolveRoute };

// Extract the first JSON array from LLM output, tolerating markdown fences,
// leading/trailing prose, and common wrapper noise. Returns an array or null.
function extractJsonArray(text) {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  // 1. Strip markdown code fences (```json ... ``` or ``` ... ```).
  let cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1");
  cleaned = cleaned.trim();

  // 2. Find the first '[' and the matching last ']' that yields valid JSON.
  const start = cleaned.indexOf("[");
  if (start === -1) return null;
  for (let end = cleaned.lastIndexOf("]"); end > start; end = cleaned.lastIndexOf("]", end - 1)) {
    const candidate = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Light repair: remove trailing commas before ] or }.
      try {
        const repaired = candidate.replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(repaired);
      } catch {
        // keep searching backwards
      }
    }
  }

  // 3. Fallback: a broader regex extraction.
  try {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch {
    // fall through
  }
  return null;
}
function totalChars(memories) {
  return memories.reduce((sum, m) => sum + (m.title?.length ?? 0) + (m.content?.length ?? 0), 0);
}

// ---------------------------------------------------------------- audit

/**
 * Canonical digest of the consolidation input snapshot. Built from stable
 * fields sorted by id, so identical inputs always yield the same hash — the
 * basis for replaying/verifying a recorded decision (receipt check).
 */
export function hashSnapshot(memories) {
  const canon = memories
    .map((m) => [m.id, m.type, m.title, m.content, m.importance, m.updated_at])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((parts) => parts.map((p) => String(p ?? "")).join("\u0001"))
    .join("\u0002");
  return createHash("sha256").update(canon).digest("hex");
}

/**
 * Compact machine-verifiable receipt for one autoDream run. Format:
 *   dsh-mneme:run:<runId>:<status>:<snapshotHash(12)>:<inputCount>:<applied>:<summaryFlag>
 * Enough to correlate a run with its persisted audit row and to spot silent
 * drift (same snapshot hash + same decisions must reproduce the same outcome).
 */
export function buildReceipt({ runId, status, snapshotHash, inputCount, applied, summaryStored }) {
  return `dsh-mneme:run:${runId}:${status}:${snapshotHash.slice(0, 12)}:${inputCount}:${applied}:${summaryStored ? 1 : 0}`;
}

/**
 * Parse a receipt back into fields; returns undefined for malformed input.
 */
export function parseReceipt(receipt) {
  if (typeof receipt !== "string") return undefined;
  const parts = receipt.split(":");
  if (parts.length !== 8 || parts[0] !== "dsh-mneme" || parts[1] !== "run") return undefined;
  const [, , runId, status, snapshotHash, inputCount, applied, summaryStored] = parts;
  // reconcile = decisions validated but one or more did not commit (CAS
  // conflict / transaction rollback) — the store diverges from the decision
  // list and the run must be reconciled, never reported as a fake ok.
  if (!runId || !/^(ok|noop|degraded|reconcile|failed)$/.test(status)) return undefined;
  const count = Number(inputCount);
  const appliedN = Number(applied);
  if (!Number.isInteger(count) || !Number.isInteger(appliedN)) return undefined;
  return { runId, status, snapshotHash, inputCount: count, applied: appliedN, summaryStored: summaryStored === "1" };
}

/**
 * Derive the per-id disposition (keep / merge-keep / merge-archived /
 * archived / conflict-winner / conflict-archived) from a validated decision
 * list. Stored in the audit row so a run can be replayed without re-running
 * the LLM.
 */
export function buildOutcome(decisions) {
  const byId = {};
  for (const d of decisions ?? []) {
    if (d.action === "keep") {
      for (const id of d.ids) byId[id] = "keep";
    } else if (d.action === "archive") {
      for (const id of d.ids) byId[id] = "archived";
    } else if (d.action === "merge") {
      for (const id of d.ids) byId[id] = id === d.keepSource ? "merge-keep" : "merge-archived";
    } else if (d.action === "conflict") {
      byId[d.winner] = "conflict-winner";
      byId[d.loser] = "conflict-archived";
    } else if (d.action === "update") {
      for (const id of d.ids) byId[id] = "updated";
    } else if (d.action === "supersede") {
      // Issue #126 review（Copilot）：新动作此前在 outcome.byId 里没有 disposition，
      // 审计行产了 receipt 却看不出这些目标被如何处置。
      byId[d.winner] = "supersede-winner";
      byId[d.loser] = "superseded-archived";
    } else if (d.action === "differentiate") {
      for (const id of d.ids ?? []) byId[id] = "differentiated";
    }
  }
  return { byId };
}

/**
 * Content-addressed digest of the memories a verdict was decided against
 * (id + title + content + importance), sorted by id so identical inputs always
 * hash the same. This is the per-record "判定依据" fingerprint: a receipt whose
 * digest cannot be reproduced from the involved memories is a bare claim, and a
 * digest match with a divergent outcome pinpoints drift to the exact record.
 */
export function hashDecisionInput(memories) {
  const canon = (memories ?? [])
    .map((m) => [m.id, m.title, m.content, m.importance])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((p) => p.map((x) => String(x ?? "")).join(""))
    .join("");
  return createHash("sha256").update(canon).digest("hex");
}

/**
 * Build the per-record receipts for a run's actually-committed mutable verdicts
 * (merge/conflict/update) — one row per verdict in the receipt_chain. Inputs
 * are drawn from the run snapshot (what the LLM actually arbitrated against),
 * and the idempotency counters count_before → count_after come from the
 * committed sub-step, so replaying the same decision must reproduce the same
 * numbers. verdict starts "live"; a later policy_epoch upgrade will batch-mark
 * older verdicts "historical" (a receipt_chain rewrite driven by the store's
 * getLatestPolicyEpoch — out of scope for this pass), while "revoked" is
 * reserved for verdicts later overturned by an explicit human decision.
 */
function buildRecordReceipts({ runId, committed, snapshot, policyEpoch }) {
  const at = (id) => snapshot?.get?.(id);
  const receipts = [];
  for (const c of committed ?? []) {
    const base = {
      run_id: runId,
      verdict: "live",
      count_before: c.count_before,
      count_after: c.count_after,
      policy_epoch: policyEpoch,
      created_at: new Date().toISOString()
    };
    if (c.action === "merge") {
      receipts.push({
        ...base,
        receipt_id: randomUUID(),
        record_id: c.keepSource,
        kind: "merge",
        input_digest: hashDecisionInput((c.ids ?? []).map(at).filter(Boolean)),
        keep_source: c.keepSource,
        sources: c.ids
      });
    } else if (c.action === "conflict") {
      receipts.push({
        ...base,
        receipt_id: randomUUID(),
        record_id: c.winner,
        kind: "conflict",
        input_digest: hashDecisionInput([at(c.winner), at(c.loser)].filter(Boolean)),
        winner_id: c.winner,
        loser_id: c.loser
      });
    } else if (c.action === "update") {
      receipts.push({
        ...base,
        receipt_id: randomUUID(),
        record_id: c.ids[0],
        kind: "update",
        input_digest: hashDecisionInput([at(c.ids[0])].filter(Boolean))
      });
    } else if (c.action === "supersede") {
      // Issue #126：演进型裁决——record 记被取代的一方。winner 正文未被改动，
      // 不需要自己的 receipt；loser 归档并追加"已被取代"注记。
      receipts.push({
        ...base,
        receipt_id: randomUUID(),
        record_id: c.loser,
        kind: "supersede",
        input_digest: hashDecisionInput([at(c.winner), at(c.loser)].filter(Boolean)),
        winner_id: c.winner,
        loser_id: c.loser
      });
    } else if (c.action === "differentiate") {
      // Issue #126：互补型裁决——两条都保留，各记一条 receipt。数量没有变化，
      // count_before/after 固定 1/1（该记录只是被追加了差异注记）。
      for (const id of c.ids ?? []) {
        receipts.push({
          ...base,
          receipt_id: randomUUID(),
          record_id: id,
          kind: "differentiate",
          input_digest: hashDecisionInput([at(id)].filter(Boolean)),
          count_before: 1,
          count_after: 1
        });
      }
    }
  }
  return receipts;
}

/**
 * Consume an LLM stream and return the accumulated text. Direct text-delta
 * accumulation covers both the real protocol ({type:"text-delta", index, text})
 * and looser test doubles ({type:"text-delta", text}); a terminal error/abort
 * surfaces as undefined. The caller decides how to treat an empty result.
 * `onUsage` (optional, Bug8) receives any usage chunk for token accounting.
 */
async function streamText(ctx, options, onUsage, onStreamError) {
  let text = "";
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    // DSH 的 StreamChunk 契约把用量嵌在 chunk.usage（TokenUsage：inputTokens /
    // outputTokens / …），chunk 顶层没有 token 字段——把整个 chunk 当用量对象交给
    // reporter，input/output 恒为 undefined，审计行落 0（v0.8.4 实测：7 天 49 次
    // success 调用 token 全 0，面板「LLM 消耗」长期显示 0）。`?? chunk` 兜底把用量
    // 平铺在顶层的替身。
    if (chunk.type === "usage" && typeof onUsage === "function") onUsage(chunk.usage ?? chunk);
    if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
      // dsh-llm rc.1 turns adapter-stage failures (unknown provider route,
      // UNSUPPORTED_REASONING_EFFORT from resolveCallWithInfo, …) into a
      // terminal finish chunk instead of a throw — the cause rides in
      // chunk.reason.failure {message, code}. Surface it, never swallow it.
      if (typeof onStreamError === "function") {
        try { onStreamError(chunk.reason); } catch { /* diagnostics only */ }
      }
      return undefined;
    }
  }
  return text;
}

/** One-line human-readable cause from a finish-chunk failure reason. */
function describeStreamFailure(reason) {
  const failure = reason?.failure ?? reason ?? {};
  const code = failure.code ? String(failure.code) : "";
  const message = String(failure.message ?? failure.error ?? "");
  if (code && message) return message.includes(code) ? message : `${code}: ${message}`;
  return code || message;
}

/**
 * Bug8: wrap a background LLM call so its token/time/status are recorded in the
 * llm_audit_logs table. Best-effort bookkeeping: a failure to WRITE the audit
 * row is swallowed (never blocks the LLM call), while a failure of the call
 * itself is captured as status='error' and re-thrown so the caller keeps its
 * existing error path. `spec` carries the static metadata (trigger_source,
 * operation_type, model_id, related_memory_ids); `body(reportUsage)` performs
 * the actual stream consumption and is handed a usage reporter for the chunks.
 */
async function runAuditedLlm(ctx, service, config, spec, body) {
  const audit = config?.llmAudit;
  if (audit?.enabled === false || typeof service?.saveLlmAudit !== "function") return body(() => {});
  const startedAt = Date.now();
  const timestamp = new Date(startedAt).toISOString();
  let inputTokens = 0;
  let outputTokens = 0;
  let status = "success";
  let errorMessage = null;
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
      // stream aborted/errored: the caller treats undefined as a failed run;
      // record it as error here so the audit shows the truth. spec.streamError
      // (a getter) lets the caller attach the finish-chunk cause so the audit
      // row names it instead of a bare "aborted".
      status = "error";
      const streamErr = typeof spec.streamError === "function" ? String(spec.streamError() ?? "") : "";
      errorMessage = errorMessage ?? (streamErr ? `llm stream aborted or errored (${streamErr})` : "llm stream aborted or errored");
    } else if (typeof spec.auditError === "function") {
      // A stream that returned text but yields nothing usable is still a
      // failed call — record it as error, not the default success, so the
      // audit no longer contradicts a failed run (dream "no json array").
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
      ctx.logger?.warn?.(`dsh-mneme: llm audit write failed: ${String(auditError)}`);
    }
  }
}

/**
 * Reasoning-effort rejection fallback (v0.8.1): a configured dreamReasoningEffort
 * / sleepReasoningEffort may be rejected by the provider (volcano-engine returns
 * UNSUPPORTED_REASONING_EFFORT for values it does not accept — "off" is known
 * rejected there). When that happens, retry once WITHOUT the reasoning field
 * instead of hard-failing the run, so effort config is safe to experiment with:
 * accepted → reasoning capped; rejected → provider default (old behavior),
 * logged so the rejection is observable.
 */
// Issue #315：effort 拒收判别式的单一来源。summarize 的流失败以 aborted 结果
// 返回，需在折叠成 undefined 前用同一甄别（各处手写会漂移）。
export const EFFORT_REJECT_RE = /reasoning[\s_]*effort|UNSUPPORTED_REASONING_EFFORT/i;
async function withEffortFallback(ctx, effort, attempt, fallback, getStreamError) {
  if (!effort || effort === "none") return attempt();
  try {
    const result = await attempt();
    if (result === undefined) {
      // dsh-llm rc.1 streams a provider effort-rejection as a terminal error
      // finish chunk (adapterStream catches everything, never throws) — match
      // on the chunk's failure reason here or the retry below is dead code
      // for the stream path.
      const reason = String(getStreamError?.() ?? "");
      if (EFFORT_REJECT_RE.test(reason)) {
        ctx.logger?.warn?.(`dsh-mneme dream: reasoningEffort "${effort}" rejected via stream (${reason}); retrying without it`);
        return fallback();
      }
    }
    return result;
  } catch (error) {
    // dispose/取消中止直接放行，绝不能被误判成 effort 拒收而触发 fallback
    //（取消后重打一次不带 effort 的调用是浪费，且可能掩盖真实的取消意图）。
    if (error?.name === "AbortError") throw error;
    const message = String(error?.message ?? error);
    // matches both "reasoning effort" (natural language) and the bare
    // "UNSUPPORTED_REASONING_EFFORT" error code (underscore).
    if (!EFFORT_REJECT_RE.test(message)) throw error;
    ctx.logger?.warn?.(`dsh-mneme dream: reasoningEffort "${effort}" rejected (${message}); retrying without it`);
    return fallback();
  }
}

/** 向量索引同步（总览与叙述条共用）：fail-safe，失败只 warn 不反噬主流程。 */
async function reEmbedMemory(semantic, memory, logger) {
  if (!semantic?.embedder || !semantic?.vectorIndex || !memory) return;
  try {
    const v = await semantic.embedder.embedSingle([memory.title, memory.content].filter(Boolean).join("\n"));
    if (v?.length) semantic.vectorIndex.saveEmbedding(memory.id, v);
    if (semantic.embedder.modelHash) semantic.vectorIndex.markModel?.(semantic.embedder.modelHash, semantic.embedder.dimension);
  } catch (error) {
    logger?.warn?.(`dsh-mneme dream: re-embed failed: ${String(error)}`);
  }
}

/**
 * 叙述条阶段（#164 对齐，opt-in dreamNarrativeEnabled）：共享 tag 主题聚类 →
 * 单次 LLM 调用按簇合成叙述 → 证据求交（防捏造，dream/narratives.js 纯函数）
 * → saveWithDedupe(source="narrative", _overwrite) 落库。按需检索不常驻注入。
 * 任何失败降级为 0 条，绝不反噬 dream 主流程。
 */
async function generateNarratives({ ctx, service, config, route, language, effort, semantic, logger }) {
  const inputs = service.all().filter((m) => !m.archived && !m.forgotten && m.type !== "summary" && m.type !== "document");
  const clusters = clusterByTag(inputs, { minCluster: config.dreamNarrativeMinCluster ?? 3 });
  if (!clusters.length) return 0;

  const listing = clusters
    .map(({ tag, members }) =>
      [`# ${tag}`, ...members.map((m) => `- id=${m.id} | title=${m.title} | ${m.content}`)].join("\n"))
    .join("\n\n");
  let streamFailure = "";
  const runNarratives = (withEffort) => {
    streamFailure = "";
    return runAuditedLlm(ctx, service, config, {
      triggerSource: "autoDream",
      operationType: "dream_narrative",
      modelId: `${route.provider}:${route.model}`,
      relatedMemoryIds: clusters.flatMap((c) => c.members.map((m) => m.id)),
      streamError: () => streamFailure
    }, (reportUsage) => streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: "compaction",
      maxTokens: config.dreamMaxTokens ?? 2048,
      ...(withEffort && effort ? { reasoningEffort: effort } : {}),
      messages: [
        { role: "system", content: [{ type: "text", text: STR.prompts.narrative[language] }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
        { role: "user", content: [{ type: "text", text: listing }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
      ]
    }, reportUsage, (reason) => { streamFailure = describeStreamFailure(reason); }));
  };
  const text = await withEffortFallback(ctx, effort, () => runNarratives(true), () => runNarratives(false), () => streamFailure);

  const entries = extractJsonArray(text);
  if (!Array.isArray(entries)) return 0;
  const clusterByOfferedTag = new Map(clusters.map((c) => [c.tag, c]));
  const now = new Date().toISOString();
  let stored = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const cluster = clusterByOfferedTag.get(typeof entry.tag === "string" ? entry.tag : "");
    const content = String(entry.content ?? "").trim();
    if (!cluster || !content) continue; // 未提供的 tag / 空叙述 → 跳过
    const evidenceIds = intersectEvidence(entry.evidence, cluster.members);
    const { memory } = service.saveWithDedupe({
      type: "summary",
      title: STR.narrativeTitle[language](cluster.tag),
      content,
      importance: 3,
      tags: [cluster.tag],
      source: "narrative",
      evidence: evidenceIds.map((id) => ({ memory_id: id, op: "support", at: now })),
      _overwrite: true
    });
    if (!memory) continue;
    stored++;
    // 叙述条按需可检索：向量索引同步（与总览共用 reEmbedMemory，fail-safe）。
    await reEmbedMemory(semantic, memory, logger);
  }
  return stored;
}

/**
 * Resolve the reasoning effort to actually send for a dream/sleep route.
 *
 * Reasoning-effort config that the provider does not accept trips the harness's
 * UNSUPPORTED_REASONING_EFFORT, and the defaultEffort trap makes retrying
 * "without the field" useless: the harness substitutes `reasoning.defaultEffort`,
 * which may itself be unsupported (DSH Desktop volcano-engine adapter declares
 * defaultEffort=low that its model rejects). So instead of blind retries, ask
 * the harness for the model's declared capability and pick a value that is
 * actually accepted — or omit the field entirely when the model declares no
 * reasoning capability at all.
 *
 * Unset vs explicit 'none' (Issue #135 建议 4/5): these are different intents.
 * Explicit 'none' = the user asked to omit the field (provider default
 * applies). Unset is the out-of-the-box state — dream/sleep calls must produce
 * JSON, and omission lets the harness substitute the model's defaultEffort
 * (thinking-type models often default to high), which drains the token budget
 * and returns an empty body. So unset resolves to the LOWEST effort the model
 * declares instead of omitting; when the capability query is unavailable the
 * field stays omitted (fail-safe, retry guard unchanged).
 *
 * @returns a supported effort id, or null when no effort should be sent, or the
 *   configured value unchanged when the capability query is unavailable.
 */

// 常识档位排序（越靠前推理开销越低）；未知档位排最后（宁可交给显式配置）。
const EFFORT_RANK = { minimal: 0, off: 0, low: 1, medium: 2, high: 3, max: 4 };

function lowestSupportedEffort(reasoning) {
  const ids = (reasoning?.efforts ?? []).map((e) => e?.id).filter(Boolean);
  if (ids.length === 0) return null;
  return [...ids].sort((a, b) => (EFFORT_RANK[a] ?? 99) - (EFFORT_RANK[b] ?? 99))[0];
}

async function resolveDreamEffort(ctx, route, configuredEffort, logger) {
  // 显式 'none'：用户要求省略字段（服务商自带默认生效），照旧。
  if (configuredEffort === "none") return null;
  if (!configuredEffort) {
    // 未配置（开箱默认）：取模型声明的最低档，避免 defaultEffort 顶上（建议 4/5）。
    if (typeof ctx?.llm?.resolveModelInfo !== "function") return null;
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
      const reasoning = info?.reasoning;
      if (!reasoning) return null; // 无推理声明：省略即安全（无 defaultEffort 可顶上）
      const lowest = lowestSupportedEffort(reasoning);
      if (!lowest) return null;
      logger?.info?.(`dsh-mneme dream: no reasoningEffort configured for ${route.provider}:${route.model}; using lowest supported "${lowest}" instead of the model default "${reasoning.defaultEffort ?? "n/a"}"`);
      return lowest;
    } catch (error) {
      // 能力查询失败：省略字段（fail-safe），withEffortFallback 照旧兜底。
      logger?.warn?.(`dsh-mneme dream: resolveModelInfo failed (${String(error?.message ?? error)}); omitting reasoningEffort`);
      return null;
    }
  }
  // Capability query unavailable (older harness / minimal mocks): forward the
  // configured value as before — absence of the API proves nothing about the
  // model, and withEffortFallback still guards against rejection.
  if (typeof ctx?.llm?.resolveModelInfo !== "function") return configuredEffort;
  try {
    const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
    const reasoning = info?.reasoning;
    if (!reasoning) {
      // Model declares no reasoning capability: the harness rejects ANY
      // explicit effort for such a model, and omitting the field is safe
      // (no reasoning capability → no defaultEffort substitution).
      logger?.warn?.(`dsh-mneme dream: model ${route.provider}:${route.model} declares no reasoning capability; ignoring configured effort "${configuredEffort}"`);
      return null;
    }
    const supported = reasoning.efforts?.map((effort) => effort.id) ?? [];
    if (supported.includes(configuredEffort)) return configuredEffort;
    // Configured effort unsupported → pick defaultEffort if it is supported,
    // else the first declared effort, so the run never trips
    // UNSUPPORTED_REASONING_EFFORT (nor the defaultEffort trap: we always
    // pass an explicit value, so the harness never falls back to a poison
    // default).
    const picked = reasoning.defaultEffort && supported.includes(reasoning.defaultEffort)
      ? reasoning.defaultEffort
      : supported[0];
    if (picked) {
      logger?.warn?.(`dsh-mneme dream: model ${route.provider}:${route.model} does not support effort "${configuredEffort}" (supported: ${supported.join(", ")}); using "${picked}"`);
      return picked;
    }
    return null;
  } catch (error) {
    // Capability query failed — forward the configured value; withEffortFallback
    // still retries on rejection as before.
    logger?.warn?.(`dsh-mneme dream: resolveModelInfo failed (${String(error?.message ?? error)}); forwarding effort as configured`);
    return configuredEffort;
  }
}

/**
 * Resolve the LLM route (Issue #25): an explicit plugin config
 * (dreamProvider/dreamModel) is the user's declared override and wins; the
 * agent default model (deployment) is only a fallback when no config route is
 * set. In a standard DSH install agentDefaultModel always resolves, so without
 * this ordering the config route would be dead code and dreamProvider/dreamModel
 * could never take effect (v0.7.11 regressed this; README §config documents
 * config-first). Falls through to undefined when no route exists — runDream
 * then fails safe. A config→default switch is logged so it is observable.
 */
function resolveRoute(ctx, config, logger) {
  if (config.dreamProvider && config.dreamModel) return { provider: config.dreamProvider, model: config.dreamModel };
  try {
    const sel = ctx.agentDefaultModel?.currentSelection?.();
    if (sel?.provider && sel?.model) {
      logger?.info?.("dsh-mneme dream: no dreamProvider/dreamModel config, falling back to agent default");
      return { provider: sel.provider, model: sel.model };
    }
    logger?.warn?.("dsh-mneme dream: agentDefaultModel unavailable, no config route either");
  } catch (error) {
    logger?.warn?.(`dsh-mneme dream: agentDefaultModel lookup failed: ${String(error)}`);
  }
  return undefined;
}

// ------------------------------------------------------- semantic enhancement
// Best-effort: any failure here degrades to plain consolidation. The dream
// path must never be broken by an unavailable embedder/index.

/** Backfill + return vectors for every memory; null when impossible. */
async function collectVectors(memories, semantic) {
  const { embedder, vectorIndex } = semantic;
  if (!embedder || !vectorIndex || typeof embedder.embedSingle !== "function") return null;
  const vectors = new Array(memories.length);
  const missing = [];
  for (let i = 0; i < memories.length; i++) {
    const cached = vectorIndex.getEmbedding?.(memories[i].id);
    if (cached) vectors[i] = cached;
    else missing.push(i);
  }
  if (missing.length) {
    const texts = missing.map((i) => [memories[i].title, memories[i].content].filter(Boolean).join("\n"));
    const rows = await embedder.embed(texts);
    missing.forEach((mi, j) => {
      if (rows[j]?.length) {
        vectors[mi] = rows[j];
        vectorIndex.saveEmbedding(memories[mi].id, rows[j]);
      }
    });
  }
  return vectors.some((v) => !v) ? null : vectors;
}

/**
 * Issue #125：把高相似对聚成**连通分量组**——一个簇 = 一个候选单元。直接按对展开
 * 会把同一簇拆成互相抢占的多个决策（校验器有 one-claim 规则），成组才是正确粒度
 * （与 sleep 冲突阶段的贪心"每记忆每轮最多进一对"同理）。
 * 组内最小相似度用于组间排序：最该处理的簇先入选。
 */
function similarityGroups(pairs) {
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    return root;
  };
  for (const p of pairs) {
    if (!parent.has(p.a.id)) parent.set(p.a.id, p.a.id);
    if (!parent.has(p.b.id)) parent.set(p.b.id, p.b.id);
    const ra = find(p.a.id);
    const rb = find(p.b.id);
    if (ra !== rb) parent.set(ra, rb);
  }
  const byRoot = new Map();
  for (const p of pairs) {
    for (const m of [p.a, p.b]) {
      const root = find(m.id);
      if (!byRoot.has(root)) byRoot.set(root, new Map());
      byRoot.get(root).set(m.id, m);
    }
  }
  return [...byRoot.values()].map((members) => {
    const list = [...members.values()];
    const ids = new Set(list.map((m) => m.id));
    let minSim = 1;
    for (const p of pairs) {
      if (ids.has(p.a.id) && ids.has(p.b.id)) minSim = Math.min(minSim, p.similarity);
    }
    return { members: list, minSim };
  });
}

/**
 * Issue #125：为候选构造收集向量。与 collectVectors 的差别是**允许部分缺失**——
 * 全量库只要有几条嵌入失败就整场返回 null，会让 hybrid 在真实库上几乎永远回落；
 * 拿不到向量的条目只是不参与比较（cosineSimilarity 对非数组返回 0，不会误判）。
 */
async function collectCandidateVectors(memories, semantic, logger) {
  const { embedder, vectorIndex } = semantic;
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
      logger?.warn?.(`[dsh-mneme] dream hybrid vector backfill failed: ${String(error)}`);
    }
  }
  return vectors;
}

/**
 * Issue #125：hybrid 候选成员，按"组内最小相似度"降序展平（高价值簇排前面，
 * 受上限截断时先入选）。同类型比较沿用 findPotentialConflicts；仅当
 * allowCrossTypeMerge 显式开启时再补跨类型高相似对。
 * 任何失败都返回空数组——调用方回落纯窗口，dream 路径绝不因向量层而失败。
 */
async function hybridCandidateMembers(allMemories, config, semantic, logger) {
  try {
    const vectors = await collectCandidateVectors(allMemories, semantic, logger);
    const minSim = config.dreamCandidateMinSim ?? 0.85;
    const pairs = findPotentialConflicts(allMemories, vectors, minSim);
    if (config.allowCrossTypeMerge === true) {
      for (let i = 0; i < allMemories.length; i++) {
        for (let j = i + 1; j < allMemories.length; j++) {
          if (allMemories[i].type === allMemories[j].type) continue; // 同类型已由上面覆盖
          const sim = cosineSimilarity(vectors[i], vectors[j]);
          if (sim > minSim) pairs.push({ a: allMemories[i], b: allMemories[j], similarity: sim });
        }
      }
    }
    if (pairs.length === 0) return [];
    return similarityGroups(pairs)
      .sort((g1, g2) => g2.minSim - g1.minSim)
      .flatMap((g) => g.members);
  } catch (error) {
    logger?.warn?.(`[dsh-mneme] dream hybrid candidate expansion failed (falling back to window): ${String(error)}`);
    return [];
  }
}

/**
 * Rebuild the vector index after dream decisions so the store and the index
 * stay in sync: merged-away/archived/conflict-loser rows lose their vectors,
 * the merge keeper gets a fresh one.
 */
export async function maintainIndexAfterDream(decisions, service, semantic) {
  const { embedder, vectorIndex } = semantic;
  if (!embedder || !vectorIndex || typeof embedder.embedSingle !== "function") return;
  const rebuild = new Map();
  for (const d of decisions ?? []) {
    if (d.action === "merge") {
      for (const id of d.ids ?? []) {
        if (id !== d.keepSource) vectorIndex.deleteEmbedding(id);
      }
      if (d.keepSource) {
        const keeper = service.getById(d.keepSource);
        if (keeper) rebuild.set(keeper.id, [keeper.title, keeper.content].filter(Boolean).join("\n"));
      }
    } else if (d.action === "archive" || d.action === "conflict") {
      for (const id of d.ids ?? [d.loser]) vectorIndex.deleteEmbedding(id);
    } else if (d.action === "supersede") {
      // Issue #126 review（Copilot）：被取代的一方已归档 → 移除其向量（与 conflict 的
      // loser 同等处置）。winner 正文未变化，向量保持有效。
      vectorIndex.deleteEmbedding(d.loser);
    } else if (d.action === "differentiate") {
      // Issue #126 review（Copilot）：双方正文都被追加了差异注记，而 update 在事务内
      // 会因 txDepth>0 跳过 scheduleEmbed —— 不在这里重嵌，注记就进不了 embedding，
      // 注释里承诺的"下一轮不再判成重复"就不成立。
      for (const id of d.ids ?? []) {
        const mem = service.getById(id);
        if (mem) rebuild.set(id, [mem.title, mem.content].filter(Boolean).join("\n"));
      }
    } else if (d.action === "update") {
      const id = d.ids[0];
      const mem = service.getById(id);
      if (mem) {
        vectorIndex.deleteEmbedding(id);
        try {
          const text = [mem.title, mem.content].filter(Boolean).join("\n");
          const v = await embedder.embedSingle(text);
          if (v?.length) vectorIndex.saveEmbedding(id, v);
        } catch { /* best-effort */ }
      }
    }
  }
  for (const [id, text] of rebuild) {
    try {
      const v = await embedder.embedSingle(text);
      if (v?.length) vectorIndex.saveEmbedding(id, v);
    } catch { /* best-effort */ }
  }
  if (embedder.modelHash) vectorIndex.markModel?.(embedder.modelHash, embedder.dimension);
}

// Issue #292：连续失败退避的间隔封顶（30 分钟）。封顶只拦指数「增长」，不把
// 用户配得比这更大的 dreamMinIntervalMinutes 基数压小（见 effectiveMinIntervalMs）。
const FAILURE_BACKOFF_CAP_MS = 30 * 60 * 1000;

export function createDreamScheduler({ onRun, thresholdCount = 10, thresholdChars = 5000, delayMs = 2000, minIntervalMs = 0, failureBackoff = false, logger, semantic = null, lastRunAtSeed = 0, peakHours = "", peakMaxDeferMinutes = 120, auditPeakSkip = null, now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  let pendingTimer = null;
  // Issue #239（第 4 项）镜像到巩固：高峰顺延定时器。与 pendingTimer 分开——两者
  // 语义不同（一个是「马上要跑」，一个是「等出高峰再跑」），合成一个变量会让
  // maybeSchedule 的守卫在顺延期间把新的写入触发误当成「已有待跑」而吞掉。
  let deferTimer = null;
  let running = false;
  let disposed = false;
  let baseline = { count: 0, chars: 0 };
  let inFlight = null;
  // Issue #89（请求 2）：上一次实际开跑时刻。失败/degraded 的 run 也占用
  // 最小间隔——节流的目的正是防止失败调用连发；间隔内的触发静默跳过。
  // lastRunAtSeed：调用方从 dream_runs 审计表读出的上次开跑时刻——
  // 内存变量进程重启即归零，闸门对新实例放行 → 重启后立刻连发（#89 根因）。
  let lastRunAt = lastRunAtSeed;
  // Issue #292（#135 派生）：同会话内连续失败计数。失败（onRun 抛错或返回
  // ok:false）+1，成功清零；无返回结果的 run（no-op 桩）视为完成且无失败，
  // 不动计数。纯内存变量、宿主重启归零——跨重启的冷却由 lastRunAtSeed（#291）
  // 持久化负责，两者不重叠。
  let consecutiveFailures = 0;

  // Issue #292：有效最小间隔 = 基数 × 2^连续失败数，封顶 30 分钟。退避关闭或
  // 尚无失败时逐字节返回基数（默认关 = 行为与现状一致）。基数 0 无闸可翻倍
  // （本键不自己产生间隔）；封顶取 max(基数, cap)，指数再大也不会把用户配的
  // 大基数压小。2^N 溢出成 Infinity 由 Math.min 兜到 cap，无需另设上限位数。
  function effectiveMinIntervalMs() {
    if (!failureBackoff || consecutiveFailures <= 0) return minIntervalMs;
    const cap = Math.max(minIntervalMs, FAILURE_BACKOFF_CAP_MS);
    return Math.min(minIntervalMs * 2 ** consecutiveFailures, cap);
  }

  function shouldTrigger(service) {
    const memories = service.all().filter((m) => !m.archived && m.type !== "summary" && m.type !== "document");
    const count = memories.length;
    const chars = totalChars(memories);
    const overBase = count >= baseline.count + thresholdCount || chars >= baseline.chars + thresholdChars;
    const overAbs = count >= thresholdCount || chars >= thresholdChars;
    return { trigger: overAbs && overBase, count, chars };
  }

  function maybeSchedule(service) {
    if (disposed || running || pendingTimer || deferTimer) return false;
    // Issue #89（请求 2）：最小触发间隔闸门。#292 退避开启时改用指数放大的
    // 有效间隔：连续失败越多，下次放行越晚（恒定失败的模型不再按固定节奏连发，
    // 只会越打越稀）。失败 run 本就占用间隔（lastRunAt 在开跑时刷新，见 #89），
    // 这里放大的是同一道闸，不新增任何状态面。间隔内的触发静默跳过：没有调用
    // 发生，也就没有可审计的对象（与 #89 口径一致，不写审计行）。
    if (minIntervalMs > 0 && now() - lastRunAt < effectiveMinIntervalMs()) return false;
    const { trigger, count, chars } = shouldTrigger(service);
    if (!trigger) return false;
    // Issue #239（第 4 项，错峰队列）镜像到巩固：命中高峰就不调模型。与蒸馏的差别
    // 在于巩固是**全局单实例**（蒸馏按会话各挂一个定时器），所以这里只需要一个
    // deferTimer，且不需要 deferredRuns 那套按会话去重。
    // baseline 刻意不刷新：阈值继续累积，留到非高峰一次性巩固（一次大 run 比多次
    // 小 run 省）。审计只登记一行 skip——「为什么不再做梦了」必须对用户可观测。
    if (isInPeakWindow(new Date(now()), peakHours)) {
      try {
        auditPeakSkip?.({ count, chars });
      } catch (error) {
        // 记账是 best-effort：写审计行失败只 warn，绝不反噬调度本身。
        logger?.warn?.(`dsh-mneme dream: peak-hours audit failed: ${String(error)}`);
      }
      scheduleDeferredRun(service);
      return false;
    }
    pendingTimer = setTimeoutFn(() => {
      pendingTimer = null;
      startRun(service);
    }, delayMs);
    return true;
  }

  /**
   * Issue #239：高峰内择时补跑——挂到「距当前最近的一个高峰结束时刻」，被
   * peakMaxDeferMinutes 截断时到点照跑（bypassPeak），长高峰不会把巩固饿死。
   * 定时器 unref：不阻止宿主退出。重复触发不叠加（deferTimer 已在 maybeSchedule
   * 的守卫里，这里再判一次以防从其它路径进来）。
   */
  function scheduleDeferredRun(service) {
    if (disposed || deferTimer) return;
    const at = nextOffPeakAt(new Date(now()), peakHours);
    if (!at) return;
    const maxDeferMs = (peakMaxDeferMinutes ?? 0) * 60000;
    let delay = Math.max(0, at.getTime() - now());
    const capped = maxDeferMs > 0 && delay > maxDeferMs;
    if (capped) delay = maxDeferMs;
    deferTimer = setTimeoutFn(() => {
      deferTimer = null;
      if (disposed) return;
      // 截断放行时仍在高峰：不再重新顺延（否则长高峰里会无限顺延，等于把巩固
      // 关掉）。直接开跑，与蒸馏的 bypassPeak 同口径。
      if (!capped && isInPeakWindow(new Date(now()), peakHours)) {
        // 理论上到点已出高峰；时钟跳变/时段串被改小可能落回高峰内，此时再顺延一次。
        scheduleDeferredRun(service);
        return;
      }
      logger?.info?.(`dsh-mneme dream: peak-hours deferred run firing (capped=${capped}, delayMs=${delay})`);
      startRun(service);
    }, delay);
    deferTimer.unref?.();
  }

  /**
   * 真正开跑。抽出来是因为两条路径都要用：写入触发的正常路径，与高峰顺延后的
   * 补跑路径。onRun 的调用刻意放在 Promise 里——同步抛出的异常若逃出 timer 回调
   * 会直接崩掉进程并跳过收尾。inFlight 让 dispose() 能等完这一轮再关库。
   */
  function startRun(service) {
    running = true;
    lastRunAt = now();
    inFlight = Promise.resolve()
      .then(() => (onRun ? onRun() : Promise.resolve({ ok: true, skipped: true })))
      .then((result) => {
        // Refresh the baseline only for a successful run (design §5.3: an
        // LLM failure must not move the baseline, so the next write can
        // immediately re-trigger a retry). A `{ok:false}` result or a throw
        // keeps the old baseline. A run that reports nothing is treated as
        // completed without failure (no-op hooks / minimal test doubles).
        if (result && result.ok) {
          consecutiveFailures = 0; // Issue #292：成功清零，下次触发回到基数间隔
          try {
            baseline = shouldTrigger(service);
          } catch (error) {
            // Store closed mid-flight: keep the last known baseline.
            logger?.warn?.(`dsh-mneme dream: baseline refresh failed: ${String(error)}`);
          }
        } else if (result) {
          // Issue #292：ok:false（LLM 失败 / 空体 / 整单拒绝）计入连败；degraded
          // 的 run 走 ok:true（LLM 本身成功了，只是决策被部分应用）→ 算成功、清零。
          // 退避关闭时该计数没有消费者，行为与此前逐字节一致。
          consecutiveFailures += 1;
        }
        // result 为空（no-op 桩 / 最小测试替身）＝完成且无失败：基线与连败计数都不动。
      })
      .catch((error) => {
        logger?.warn?.(`dsh-mneme dream: run failed: ${error?.message ?? error}`);
        // Failed runs do not refresh the baseline.
        consecutiveFailures += 1; // Issue #292：抛错同样计入连败
      })
      .finally(() => {
        running = false;
        inFlight = null;
      });
  }

  async function dispose() {
    disposed = true;
    if (pendingTimer) { clearTimeoutFn(pendingTimer); pendingTimer = null; }
    // Issue #239：高峰顺延定时器同样要清，否则进程关闭后仍会触发一次巩固。
    if (deferTimer) { clearTimeoutFn(deferTimer); deferTimer = null; }
    // An in-flight run is left to complete naturally (its LLM calls are
    // already paid for and aborting would discard the work). Await it so the
    // caller can close the store only after every write has landed.
    if (inFlight) await inFlight.catch(() => {});
  }

  async function runDream(ctx, service, config) {
    const language = langOf(config);
    const logger = ctx.logger;
    let memories = service.all().filter((m) => !m.archived && m.type !== "summary" && m.type !== "document");
    if (memories.length === 0) return { ok: true, applied: 0, skipped: true, summary: false };
    // Issue #89：开跑时刻既喂给审计行（created_at），也是调度器闸门的时间基准。
    const dreamStartedAt = Date.now();
    // v0.4.4 滑动窗口：只 consolidation 最近 dreamMaxSnapshotSize 条记忆，
    // 窗口外的旧记忆不进 snapshot（大记忆量下全量快照会撑爆 LLM 输入，配合
    // 隐式 keep 让 run 始终可收敛）。按 updated_at 倒序取前 maxSize 条。
    const maxSize = Number.isInteger(config.dreamMaxSnapshotSize) ? config.dreamMaxSnapshotSize : 200;
    const windowMemories = [...memories]
      .sort((a, b) => {
        const ta = String(a.updated_at ?? "");
        const tb = String(b.updated_at ?? "");
        if (ta < tb) return 1;
        if (ta > tb) return -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(0, Math.max(1, maxSize));
    // Issue #125：hybrid 档在窗口之外并入向量翻出的高相似组。候选**总量**仍由
    // maxSize（或显式 dreamCandidateMax）封顶、与库总量解耦——用"按相似度取候选"
    // 替代"调大窗口"，输入成本才不随库增长。封顶截断时向量组优先于窗口尾部，
    // 否则"该合并的一对"仍会被时间窗挤掉。
    let selected = windowMemories;
    if ((config.dreamCandidateMode ?? "window") === "hybrid" && semantic?.embedder && semantic?.vectorIndex) {
      const extra = await hybridCandidateMembers(memories, config, semantic, logger);
      if (extra.length > 0) {
        const cap = Math.max(
          Math.max(1, maxSize),
          Number.isInteger(config.dreamCandidateMax) && config.dreamCandidateMax > 0 ? config.dreamCandidateMax : 0
        );
        const merged = [];
        const seen = new Set();
        for (const m of [...extra, ...windowMemories]) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          merged.push(m);
          if (merged.length >= cap) break;
        }
        selected = merged;
        logger?.info?.(`[dsh-mneme] dream hybrid candidates: ${merged.length} (window ${windowMemories.length}, vector ${extra.length}, cap ${cap})`);
      }
    }
    memories = selected;
    const snapshot = new Map(memories.map((m) => [m.id, m]));
    const route = resolveRoute(ctx, config, logger);
    const runId = randomUUID();
    const snapshotHash = hashSnapshot([...snapshot.values()]);
    // Conflict freeze (opt-in): when enabled, conflict decisions are parked for
    // manual review instead of auto-adjudicated. Read once up front so the
    // prompt hint and the apply-split agree on the same gate.
    const freezeEnabled = config.conflictFreezeEnabled === true;
    // Every exit (success or failure) funnels through `finish`, which writes
    // the audit row + receipt. A record failure is logged, never thrown —
    // auditing must not break the consolidation path. Failed runs still
    // capture their decisions/outcome when the LLM produced a validated list
    // (e.g. summary step failed after consolidation), so the partial write is
    // replayable too.
    const finish = (result) => {
      // status is derived from what actually committed: ok only when the full
      // decision list landed (or a summary was refreshed); noop when nothing
      // changed; degraded when real changes landed without a summary;
      // reconcile when decisions were validated but some did not commit (CAS
      // conflict / rollback); failed on any LLM/validation error. No fake "ok"
      // for an empty or partial run.
      const status = result.status ?? (result.ok ? "ok" : "failed");
      const applied = result.applied ?? 0;
      const summaryStored = result.summary ?? false;
      const receipt = buildReceipt({ runId, status, snapshotHash, inputCount: snapshot.size, applied, summaryStored });
      try {
        service.saveDreamRun({
          id: runId,
          // Issue #89：审计行记开跑时刻而非完成时刻——lastDreamRunAt 以它做
          // 重启后的间隔种子，落完成时刻会让 run 耗时白白计入下一轮最小间隔。
          created_at: new Date(dreamStartedAt).toISOString(),
          status,
          error: result.error,
          provider: route?.provider,
          model: route?.model,
          snapshot_hash: snapshotHash,
          input_count: snapshot.size,
          // 裁决规则版本号：config.policyEpoch（默认 0）。规则升级后该行保留
          // 当时的 epoch，旧裁决据此降级为历史证据（store 层 getLatestPolicyEpoch
          // 只负责读取当前生效版本，写入由这里完成）。
          policy_epoch: config.policyEpoch ?? 0,
          // Full input snapshot (canonical fields) so the exact arbitration
          // input can be rebuilt offline from the audit row alone — the
          // digest + decisions + outcome triple makes silent errors locatable
          // even after the store has moved on.
          input: [...snapshot.values()].map((m) => ({
            id: m.id,
            type: m.type,
            title: m.title,
            content: m.content,
            importance: m.importance,
            updated_at: m.updated_at
          })),
          decisions: result.decisions,
          outcome: result.outcome,
          applied,
          summary_stored: summaryStored,
          receipt,
          // Issue #104：degraded（合法子集已应用）轮被跳过的决策明细。写成独立字段
          // 而非内联进 decisions——degraded 的 decisions 是合法子集，下游按「决策
          // 数组」消费，内联标记会污染其它读者（失败轮的 _validationFailed 是整单
          // 拒绝哨兵，语义与「部分应用」不同，也不复用）。
          skipped: result.skipped
        });
      } catch (error) {
        logger?.warn?.(`dsh-mneme dream: failed to record audit run: ${String(error)}`);
      }
      return { ...result, runId, receipt, snapshotHash };
    };
    if (!route) {
      logger?.warn?.("dsh-mneme dream: no llm route available");
      return finish({ ok: false, error: "no llm route", summary: false });
    }

    let listText;
    if (semantic?.embedder && semantic?.vectorIndex) {
      try {
        const vectors = await collectVectors(memories, semantic);
        if (vectors) {
          const k = Math.min(10, Math.max(1, Math.floor(Math.sqrt(memories.length / 2))));
          const clusters = clusterMemories(memories, vectors, k);
          const conflicts = findPotentialConflicts(memories, vectors, 0.85);
          const conflictIds = new Set(conflicts.flatMap((c) => [c.a.id, c.b.id]));
          const parts = [];
          clusters.forEach((cluster, ci) => {
            parts.push(STR.clusterHeader[language](ci + 1));
            for (const m of cluster) {
              parts.push(
                `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}` +
                (conflictIds.has(m.id) ? STR.conflictMark[language] : "")
              );
            }
          });
          listText = parts.join("\n");
          logger?.info?.(`[dsh-mneme] dream semantic pre-group: ${clusters.length} clusters, ${conflicts.length} conflict pairs`);
        }
      } catch (error) {
        logger?.warn?.(`[dsh-mneme] dream semantic pre-group failed: ${String(error)}`);
      }
    }
    if (!listText) {
      listText = [...snapshot.values()].map((m) =>
        `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}`
      ).join("\n");
    }

    // Freeze-aware prompt: in freeze mode the conflict branch still outputs
    // winner/loser (validation requires them) but they are treated as tentative
    // candidates — the human makes the final call, not the model.
    const consolidationPrompt = freezeEnabled
      ? STR.prompts.consolidation[language] + STR.prompts.freezeSuffix[language]
      : STR.prompts.consolidation[language];
    let decisionText;
    // 加固（v0.8.1）：配置的 reasoningEffort 被 provider 拒收时回退重试一次
    // （不带该字段），避免 thinking 模型配置 low/medium 直接整单失败。解析放
    // 在 auditError 检查器里、闭包交回主流程，避免二次解析；解析失败同时如实
    // 记 audit error 并在日志带原始输出前 300 字节，便于定位"推理吞预算返回空体"。
    const effort = await resolveDreamEffort(ctx, route, config.dreamReasoningEffort, logger);
    let decisions = null;
    let streamFailure = "";
    const runConsolidation = (withEffort) => {
      streamFailure = "";
      return runAuditedLlm(ctx, service, config, {
      triggerSource: "autoDream",
      operationType: "dream_consolidate",
      modelId: `${route.provider}:${route.model}`,
      relatedMemoryIds: [...snapshot.keys()],
      streamError: () => streamFailure,
      auditError: (text) => {
        decisions = extractJsonArray(text);
        return Array.isArray(decisions) ? null : "no json array in llm output";
      }
    }, (reportUsage) => streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: "compaction",
      maxTokens: config.dreamMaxTokens ?? 4096,
      ...(withEffort && effort ? { reasoningEffort: effort } : {}),
      messages: [
        { role: "system", content: [{ type: "text", text: consolidationPrompt }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
        { role: "user", content: [{ type: "text", text: listText }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
      ]
    }, reportUsage, (reason) => { streamFailure = describeStreamFailure(reason); }));
    };
    try {
      // Bug8: the consolidation call is audited (tokens/time/status). A throw
      // re-propagates to the catch below; an aborted stream returns undefined
      // and is treated as a failed run after the check below.
      decisionText = await withEffortFallback(ctx, effort, () => runConsolidation(true), () => runConsolidation(false), () => streamFailure);
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: consolidation llm call failed: ${String(error)}`);
      return finish({ ok: false, error: "llm failed", summary: false });
    }
    if (decisionText === undefined) {
      logger?.warn?.(`dsh-mneme dream: consolidation llm stream aborted or errored${streamFailure ? ` (${streamFailure})` : ""}`);
      return finish({ ok: false, error: "llm failed", summary: false });
    }
    if (!Array.isArray(decisions)) {
      const head = (decisionText ?? "").slice(0, 300).replace(/\s+/g, " ").trim();
      logger?.warn?.(`dsh-mneme dream: no json array in llm output (raw length ${decisionText?.length ?? 0}; head: ${head})`);
      return finish({ ok: false, error: "no json array in llm output", summary: false });
    }
    const { ok, errors, skipped, resolvedShortIds, coverageShortfall } = validateDecisions(decisions, snapshot, {
      maxUpdatePerRun: config.reflectionUpdateMaxPerRun,
      // Issue #104 方向 2：archive 批量上限（全局闸门，超限整单拒绝）。
      maxArchivePerRun: config.dreamMaxArchivePerRun,
      minAgeHours: config.reflectionUpdateMinAgeHours,
      // v0.4.4 fix：显式透传，用户配 dreamImplicitKeep:false 时严格模式必须
      // 真正生效，dreamMinExplicitCoverage 决定隐式 keep 下的覆盖率下限。
      dreamImplicitKeep: config.dreamImplicitKeep,
      dreamMinExplicitCoverage: config.dreamMinExplicitCoverage,
      // Issue #89：v0.6.9（Issue #26）的宽容路径在 v0.7.11 重写中丢失——单条
      // 非法决策重新只跳过该条、合法子集照常应用（run 记为 degraded）。
      skipInvalid: config.dreamSkipInvalid !== false,
      allowCrossTypeMerge: config.allowCrossTypeMerge === true
    });
    // Issue #135：模型把 UUID 缩写成前缀时，唯一前缀已在校验前被解析回完整 id。
    // 解析量是模型输出质量的一个直接信号（>0 意味着模型在缩写 id），记一条 info
    // 便于事后从日志侧观察该行为的分布。
    if (resolvedShortIds > 0) {
      logger?.info?.(`[dsh-mneme] dream: resolved ${resolvedShortIds} short id prefix(es) to full ids`);
    }
    if (!ok) {
      // Issue #135（观测缺口）：失败轮的逐条校验明细此前既不落库也基本不可见——
      // skipped 的 warn 写在 return 之后（失败路径到不了），dream_runs.decisions
      // 落 NULL，上百轮失败零现场。这里把明细前置到日志，并把
      // { _validationFailed, errors, skipped } 随失败行持久化，事后可从审计行
      // 直接定位「模型输出了什么、为何逐条非法」。
      logger?.warn?.(`dsh-mneme dream: invalid decisions: ${errors.join("; ")}`);
      if (skipped.length > 0) {
        logger?.warn?.(`dsh-mneme dream: ${skipped.length} invalid decision(s) skipped: ${skipped.map((s) => `decision[${s.index}]: ${s.error}`).join("; ")}`);
      }
      return finish({
        ok: false,
        error: `invalid decisions: ${errors.length} errors`,
        summary: false,
        decisions: [{ _validationFailed: true, errors, skipped }]
      });
    }
    const skippedInvalid = skipped.length > 0;
    if (skippedInvalid) {
      logger?.warn?.(`dsh-mneme dream: ${skipped.length} invalid decision(s) skipped (run degrades): ${skipped.map((s) => s.error).join("; ")}`);
    }
    // Issue #104 方向 1：覆盖率不足降级为 degraded（不再整单拒绝）——合法子集
    // 照常应用、未提及条目隐式 keep，理由随 outcome.degradations 落库供离线定位。
    const coverageDegraded = typeof coverageShortfall === "string" && coverageShortfall.length > 0;
    if (coverageDegraded) {
      logger?.warn?.(`dsh-mneme dream: ${coverageShortfall} (run degrades: valid subset applied, unclaimed ids kept implicitly)`);
    }

    // Capture pre-update snapshots so the audit records what each update changed.
    const updateSnapshots = {};
    for (const d of decisions) {
      if (d.action === "update") {
        const mem = snapshot.get(d.ids[0]);
        if (mem) updateSnapshots[d.ids[0]] = { title: mem.title, content: mem.content, importance: mem.importance };
      }
    }

    // Conflict freeze (opt-in): when enabled, conflict decisions are not
    // auto-adjudicated — no winner kept, no loser archived. The pair is parked
    // in conflict_pending for human review instead. Best-effort: a store
    // failure here must never block the run (fail-safe — the memories are left
    // untouched and nothing is arbitrated). The cap (conflictFreezeMaxPending)
    // bounds the review queue; overflow is skipped with a warning.
    let frozenCount = 0;
    const frozenIds = [];
    // v0.8.1（issue #170 复核项 3）：跨 scope 的 conflict 决策两种模式都一律
    // 停车人工裁决、绝不自动归档——否则普通 dream 的 LLM 能归档别的 scope 的
    // 唯一副本，sleep 路径（scope-candidate-queue）的保护在这里缺位。同 scope
    // 的 conflict 决策照旧：freeze 停车 / 非 freeze 自动裁决。
    const isCrossScopeDecision = (d) => {
      const a = snapshot.get(d.winner);
      const b = snapshot.get(d.loser);
      return !!a && !!b && (
        scopeKeyOf(a.agent_scope) !== scopeKeyOf(b.agent_scope)
        || scopeKeyOf(a.workspace_scope) !== scopeKeyOf(b.workspace_scope)
      );
    };
    const applyList = freezeEnabled
      ? decisions.filter((d) => d.action !== "conflict")
      : decisions.filter((d) => d.action !== "conflict" || !isCrossScopeDecision(d));
    if (freezeEnabled) {
      const conflictsToFreeze = decisions.filter((d) => d.action === "conflict");
      if (conflictsToFreeze.length > 0) {
        try {
          const maxPending = Number.isInteger(config.conflictFreezeMaxPending) ? config.conflictFreezeMaxPending : 100;
          const pendingNow = service.countConflictPending();
          const budget = Math.max(0, maxPending - pendingNow);
          const toFreeze = conflictsToFreeze.slice(0, budget);
          if (conflictsToFreeze.length > budget) {
            logger?.warn?.(`dsh-mneme dream: conflict freeze queue full (${pendingNow}/${maxPending}), skipped ${conflictsToFreeze.length - budget} conflict(s)`);
          }
          for (const d of toFreeze) {
            try {
              // 返回 undefined = 该对已被人工裁决且两侧内容未变（issue #170 复核
              // 项 4：内容变了才重新入队）——不算停车、不进 frozenIds。
              const parked = service.saveConflictPending({ run_id: runId, memory_a: d.winner, memory_b: d.loser, reason: d.reason });
              if (parked == null) continue;
              frozenCount++;
              frozenIds.push(d.winner, d.loser);
            } catch (error) {
              logger?.warn?.(`dsh-mneme dream: failed to freeze conflict ${d.winner}/${d.loser}: ${String(error)}`);
            }
          }
        } catch (error) {
          logger?.warn?.(`dsh-mneme dream: conflict freeze lookup failed: ${String(error)}`);
        }
      }
    } else {
      // 非 freeze：跨 scope conflict 停车（绝不进 applyDecisions）。带专属
      // reason + 模型给出的裁决理由，队列里读起来是「归属裁决」而非重复项。
      const crossScope = decisions.filter((d) => d.action === "conflict" && isCrossScopeDecision(d));
      for (const d of crossScope) {
        try {
          const parked = service.saveConflictPending({
            run_id: runId,
            memory_a: d.winner,
            memory_b: d.loser,
            reason: STR.scopeConflictParkReason[language](d.reason)
          });
          if (parked != null) {
            frozenCount++;
            frozenIds.push(d.winner, d.loser);
          }
        } catch (error) {
          logger?.warn?.(`dsh-mneme dream: failed to park cross-scope conflict ${d.winner}/${d.loser}: ${String(error)}`);
        }
      }
      if (crossScope.length > 0) {
        logger?.info?.(`[dsh-mneme] dream: parked ${crossScope.length} cross-scope conflict(s) for human ownership review`);
      }
    }

    // CAS-guarded, per-decision-transactional apply against the run snapshot:
    // a target changed during the LLM call is skipped and reported as a
    // conflict instead of being overwritten (item ①). Frozen conflicts are
    // excluded from this list (they are parked, not applied).
    const { applied, conflicts, failures, committed } = applyDecisions(applyList, service, logger, snapshot, config);
    // Per-record receipt chain: one row per actually-committed merge/conflict/
    // update verdict, stamped with the decision-basis digest + idempotency
    // counters (count_before → count_after). Written here, before the run audit
    // row, so the verdict trail always precedes the run trail it belongs to.
    // Bookkeeping: a write failure is logged and swallowed — it must never
    // block the consolidation flow.
    try {
      for (const r of buildRecordReceipts({ runId, committed, snapshot, policyEpoch: config.policyEpoch ?? 0 })) {
        service.saveReceipt(r);
      }
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: failed to write per-record receipt: ${String(error)}`);
    }
    // Attach the pre-update snapshot to the audit copy of each update decision
    // so the recorded row shows the before/after delta, not just the target.
    const auditDecisions = decisions.map((d) =>
      d.action === "update" && updateSnapshots[d.ids[0]]
        ? { ...d, _before: updateSnapshots[d.ids[0]] }
        : d
    );
    // Outcome is derived from the ACTUALLY committed sub-steps, never from the
    // raw LLM decision list — a merge whose archive step rolled back must not
    // claim "merge-archived" (item ②). Conflicts/failures ride along so the
    // audit row records why the run diverged.
    const outcome = { ...buildOutcome(committed), conflicts, failures };
    if (coverageDegraded) outcome.degradations = [coverageShortfall];
    // Frozen conflicts were not adjudicated: mark both sides pending in the
    // per-id outcome so the audit row shows they were parked, not skipped.
    if (frozenIds.length) {
      for (const id of frozenIds) outcome.byId[id] = "conflict-pending";
    }
    // Decisions validated but not fully committed → reconcile (not ok).
    const partial = conflicts.length > 0 || failures.length > 0;
    // No decision landed (all-keep, or every decision skipped as an idempotent
    // replay) → nothing substantive changed. Distinct from a success: such a
    // run must never be reported as ok, or the audit claims work that never
    // happened and the scheduler refreshes the baseline on a false positive.
    // Frozen conflicts are substantive output (parked for review), so a run
    // that only froze conflicts is not a noop.
    const noChange = frozenCount === 0 && applied === 0 && committed.every((c) => c.action === "keep");

    // Keep the vector index consistent with the post-dream store state.
    if (semantic?.embedder && semantic?.vectorIndex) {
      try {
        await maintainIndexAfterDream(applyList, service, semantic);
      } catch (error) {
        logger?.warn?.(`[dsh-mneme] dream index maintenance failed: ${String(error)}`);
      }
    }

    // Summary generation (second LLM call). A throwing stream is reported as
    // a failed run; summary:false marks a run that produced no summary.
    let summaryText;
    let summaryStreamFailure = "";
    const runSummary = (withEffort) => {
      summaryStreamFailure = "";
      // Issue #258：总览阶段可用 dreamSummaryProvider/dreamSummaryModel 走独立路由
      //（默认空 = 沿用 dream 路由）；输入侧有 dreamSummaryMaxInputs 硬上限，
      // 按窗口同款 updated_at 倒序保留最新的（见下方 summaryInputs）。
      const summaryRoute = (config.dreamSummaryProvider && config.dreamSummaryModel)
        ? { provider: config.dreamSummaryProvider, model: config.dreamSummaryModel }
        : route;
      return runAuditedLlm(ctx, service, config, {
      triggerSource: "autoDream",
      operationType: "dream_summarize",
      modelId: `${summaryRoute.provider}:${summaryRoute.model}`,
      relatedMemoryIds: [],
      streamError: () => summaryStreamFailure
    }, (reportUsage) => streamText(ctx, {
      provider: summaryRoute.provider,
      model: summaryRoute.model,
      purpose: "compaction",
      maxTokens: config.dreamMaxTokens ?? 2048,
      ...(withEffort && effort ? { reasoningEffort: effort } : {}),
      messages: [
        { role: "system", content: [{ type: "text", text: STR.prompts.dreamSummary[language] }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
        { role: "user", content: [{ type: "text", text: summaryInputs.map((m) => `- ${m.title}: ${m.content}`).join("\n") }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
      ]
    }, reportUsage, (reason) => { summaryStreamFailure = describeStreamFailure(reason); }));
    };
    // Resident status bar (#164 alignment): the overview is THE one resident
    // narrative — summary tier 0, refreshed every run via _overwrite (supersede
    // v1, content_history traceable). Its 口径 (what snapshot produced it) is
    // stamped into the content so the standing answer is always auditable; the
    // formal evidence column lands with the narrative-bars batch.
    // Issue #258：输入硬上限（条数）——原全库无界，把 dream 路由指向小 ctx
    // 模型时 120k token 当场 CONTEXT_WINDOW_EXCEEDED（#258 实测），且随库增长
    // 渐进恶化。倒序排序与 consolidate 窗口同款（updated_at desc, id tiebreak），
    // 保留最新的；0 = 关闭上限（回归全库行为，调用方自担 ctx）。
    // #230：document 指针行不进总览（与 dream/sleep 五个候选池的同款排除）。
    const summaryAll = service.all().filter((m) => !m.archived && m.type !== "summary" && m.type !== "document");
    const summaryMaxInputs = Number.isInteger(config.dreamSummaryMaxInputs) ? config.dreamSummaryMaxInputs : 0;
    const summaryInputs = summaryMaxInputs > 0 && summaryAll.length > summaryMaxInputs
      ? [...summaryAll]
        .sort((a, b) => {
          const ta = String(a.updated_at ?? "");
          const tb = String(b.updated_at ?? "");
          if (ta < tb) return 1;
          if (ta > tb) return -1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .slice(0, summaryMaxInputs)
      : summaryAll;

    const summaryScope = STR.summaryScope[language](
      summaryInputs.length,
      runId.slice(0, 8),
      new Date().toISOString().slice(0, 10)
    );
    try {
      // Bug8: the summary call is audited too (operation dream_summarize).
      summaryText = await withEffortFallback(ctx, effort, () => runSummary(true), () => runSummary(false), () => summaryStreamFailure);
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: summary llm call failed: ${String(error)}`);
      return finish({ ok: false, error: "llm failed", applied, decisions: auditDecisions, outcome, frozen: frozenCount, summary: false });
    }
    let summaryStored = false;
    if (summaryText !== undefined && summaryText.trim()) {
      // Bug5 carve-out: the library overview is regenerated every run, so it
      // must REPLACE the previous overview (not append — that would grow the
      // summary unboundedly). `_overwrite` still archives the old overview into
      // content_history before replacing it. Content carries the snapshot-scope
      // footer computed above — the resident bar states its own 口径.
      service.saveWithDedupe({ type: "summary", title: STR.summaryTitle[language], content: `${summaryText.trim()}${summaryScope}`, importance: 5, source: "dream", _overwrite: true });
      summaryStored = true;
      // Re-embed the fresh summary so the index stays in sync with the store.
      if (semantic?.embedder && semantic?.vectorIndex) {
        try {
          // source="dream" 限定：叙述条（source=narrative）同为 summary 类型，
          // 不加限定时 find 可能截胡，把总览的 re-embed 花在叙述条上。
          const summary = service.all().find((m) => m.type === "summary" && m.source === "dream");
          if (summary) await reEmbedMemory(semantic, summary, logger);
        } catch { /* best-effort */ }
      }
    }
    // Narrative bars (#164 alignment, opt-in dreamNarrativeEnabled): per-topic
    // on-demand narratives after consolidation + summary. Additive phase —
    // failures degrade to zero narratives, never break the run.
    let narrativesStored = 0;
    if (config.dreamNarrativeEnabled === true) {
      try {
        narrativesStored = await generateNarratives({ ctx, service, config, route, language, effort, semantic, logger });
      } catch (error) {
        logger?.warn?.(`dsh-mneme dream: narrative phase failed: ${String(error)}`);
      }
    }

    // Honest status assignment (never a fake ok):
    //   reconcile — some decisions validated but did not commit (CAS/rollback).
    //   noop      — nothing changed and no summary persisted: truly an empty
    //               run. ok:false keeps the scheduler from moving the baseline.
    //   ok        — either real changes landed, or a fresh summary was stored
    //               (all-keep + summary is a substantive summary refresh).
    //   degraded  — real consolidation landed but the run did not produce its
    //               full output: the summary came back empty/missing, or
    //               skipInvalid dropped individually-invalid decisions
    //               (Issue #89 — marked, not faked), or the explicit-decision
    //               coverage fell below dreamMinExplicitCoverage (Issue #104
    //               方向 1 — degrade, don't reject). The valid subset was
    //               absorbed (ok for the baseline).
    let status;
    let okResult;
    if (partial) {
      status = "reconcile";
      okResult = false;
    } else if (noChange) {
      status = summaryStored ? "ok" : "noop";
      okResult = summaryStored;
    } else {
      status = summaryStored && !skippedInvalid && !coverageDegraded ? "ok" : "degraded";
      okResult = true;
    }
    return finish({
      ok: okResult,
      status,
      applied,
      decisions: auditDecisions,
      outcome,
      conflicts,
      failures,
      frozen: frozenCount,
      summary: summaryStored,
      narratives: narrativesStored,
      // Issue #104：只有真发生跳过时才落库（degraded 也可能仅因 summary 为空），
      // ok 轮留 NULL，避免「空数组」与「无此字段」两种假明细占据审计行。
      skipped: skippedInvalid ? skipped : undefined
    });
  }

  return { maybeSchedule, runDream, dispose };
}
