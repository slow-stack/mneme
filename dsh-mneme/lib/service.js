import { createHash, randomUUID } from "node:crypto";
import { TYPE_FILE, MIRROR_READONLY_TYPES } from "./mirror.js";
import { updatedAtBounds } from "./store.js";
import { normalizeExplicitScope, scopeKeyOf } from "./scope.js";
import { STR, langOf } from "./lang.js";
import { computeHeat } from "./heat.js";
import { recallStats } from "./recall-stats.js";
import { evaluateMemoryQuality } from "./quality-filter.js";
import { applyDecisions } from "./dream/decisions.js";
import { createDocumentRegistrar } from "./document.js";
import { createOrganizer } from "./organize.js";
import { createBM25Index } from "./search/bm25.js";
import { adaptiveThreshold } from "./search/adaptive.js";
import { anchorSeeds, normalizePath, cascadeDepths, HOP_QUOTA } from "./graph/anchoring.js";

const INJECT_TYPES = new Set(["preference", "project", "decision", "summary", "rejected_solution", "pitfall", "constraint"]);

// document 摘要行（#230）：仅 documentMemoryEnabled 开启时进注入候选。独立
// 集合而非常改共享 Set——INJECT_TYPES 本身是「类型可注入」的静态事实，flag
// 是运行时状态，两者不能搅在一起。
const INJECT_TYPES_WITH_DOCUMENT = new Set([...INJECT_TYPES, "document"]);

// 编码记忆类型（codingRetrospect）：rejected_solution / pitfall / constraint
// 只在编码任务时注入（防噪声污染其他业务），且编码场景下按 codingBoostFactor
// 加权排序提前。
const CODING_MEMORY_TYPES = new Set(["rejected_solution", "pitfall", "constraint"]);

// pin 池类型（#249 第一批）：约束与偏好是「对谁都成立的边界」，需要逐字保真
// 而不是相关性排序——它们与情景日志同池同速率摘要会被静默降级（立项依据）。
// 注意 constraint 同时属于 CODING_MEMORY_TYPES，非编码任务里已被 codingGate
// 滤掉，pin 池同样拿不到它；是否豁免该门控是待维护者拍板的口径问题，本批次
// 不动既有门控（不放大行为面）。
// 导出给写入准入（#254 的穿透口）与注入侧共用一份定义：两处各写一份 list 迟早
// 漂移成「pin 池豁免了、预算没豁免」这类两套口径。
export const PINNED_MEMORY_TYPES = new Set(["constraint", "preference"]);

/**
 * 判断一段文本是否编码类任务（关键词匹配，codingRetrospect 读取侧门控）。
 * 纯函数，无副作用，便于单测。
 */
export function isCodingTask(text, keywords = []) {
  const t = String(text ?? "").toLowerCase();
  return keywords.some((kw) => t.includes(String(kw).toLowerCase()));
}

// Epistemic trust weights (v0.4.5): when config.trustEpistemicWeighting is on,
// each recall candidate's existing score is multiplied by the weight of its
// epistemic_status before ranking — measured facts outrank guesses. Missing /
// unknown statuses are unscaled (×1). Off by default, so nothing changes.
const EPISTEMIC_WEIGHTS = { observation: 1.0, inferred: 0.85, subjective: 0.7 };

// Bug5: content version history cap (FIFO — the newest 20 versions are kept,
// older ones dropped). Entries are {content, source, updated_at}; source marks
// how the version was superseded (auto_merge | human_override | overwrite).
const CONTENT_HISTORY_MAX = 20;

// Issue #135 附属发现 2：质量过滤器写下的系统信号标签（「为什么被降权/归档」的
// 唯一审计线索）。更新路径整组替换 tags 会把它们抹掉——更新时按此清单并集保留。
// 清单必须与 quality-filter.js 的写入端对齐（6 个，含 type 自指的 self_referential）；
// evidence_degraded 是 #230 注册端的求交标记（quality-filter 不写它，但同样
// 不许被更新抹掉）。
const SIGNAL_TAGS = ["low_quality", "duplicate", "meta", "repetitive", "short_content", "self_referential", "evidence_degraded"];

// scopeKeyOf 已上提到 ./scope.js（v0.8.1，issue #170 第 2 步）：与 sleep 的跨
// scope 配对共用同一把比较钥匙，避免两处定义漂移。

// v0.8.0 A2（issue #17）scope 检索加权系数：两维都无法确立 foreign 的候选
// （命中行、未标注行、当前侧维度解析不到的行）→ 加成；只有确立了 foreign
// （记忆带标注 + 当前维度可解析 + 值不等）→ 降权但保留可见（硬过滤是 A3
// strictScope）。即未标注行与命中行同列、不吃惩罚，但注意它们吃的是 BOOST
// 而非 ×1 中性。系数是模块常量而非配置项：A2 只定性行为，数值要等线上检索
// 质量反馈再调（加配置面=提前优化）。
const SCOPE_MATCH_BOOST = 1.25;
const SCOPE_FOREIGN_PENALTY = 0.5;

/**
 * 单条候选的 scope 乘数。匹配语义与去重键一致（scopeKeyOf）：记忆侧未标注视同
 * 该维度命中（全局记忆对谁都可见）；当前会话侧某维度解析不到则该维度不参与
 * 比较（无法比较 ≠ 不匹配）。
 */
function scopeMultiplier(m, current) {
  const agentForeign = scopeKeyOf(m.agent_scope) !== null
    && current.agent_scope !== null
    && scopeKeyOf(m.agent_scope) !== current.agent_scope;
  const workspaceForeign = scopeKeyOf(m.workspace_scope) !== null
    && current.workspace_scope !== null
    && scopeKeyOf(m.workspace_scope) !== current.workspace_scope;
  return (agentForeign || workspaceForeign) ? SCOPE_FOREIGN_PENALTY : SCOPE_MATCH_BOOST;
}

/**
 * v0.8.0 A2：occurred_at 后置过滤谓词（搜索融合池用）。行侧取
 * COALESCE(occurred_at, created_at)——与 store.list 的 SQL 过滤同口径，未标注
 * 行回退创建时间；时间戳损坏的行保留（宁可放宽也不误杀，同 summarize inWindow）。
 */
function inOccurredBounds(m, bounds) {
  const t = Date.parse(String(m.occurred_at ?? m.created_at ?? ""));
  if (!Number.isFinite(t)) return true;
  if (bounds.from && t < Date.parse(bounds.from)) return false;
  if (bounds.to && t > Date.parse(bounds.to)) return false;
  return true;
}

/**
 * v0.8.0 A3（issue #17）strictScope 可见性谓词：issue 的四象限可见性公式
 * （agent 不对称可见性）——记忆对当前会话可见 ⇔ (agent 维：未标注 或 命中当前
 * agent) AND (workspace 维：未标注 或 命中当前 workspace)。NULL=未标注=全局；
 * 当前会话某维度解析不到时，该维度带标注的记忆一律不可见（fail-closed：身份
 * 不明的会话只见全局，不冒认）。sensitivity 是标签不参与可见性判定（其语义
 * 留给后续批次）。store.list 的 SQL 过滤与此谓词同口径（见 store.js visibility）。
 */
function isVisibleInScope(m, current) {
  // v0.8.1 第 3 步（issue #170 4.3，作者已确认）：硬过滤只认显式声明。某维
  // 仅当「该维有标注且来源为 explicit」才构成硬墙；auto（含 v0.8.0 存量的
  // NULL 来源行）只吃 A2 软加权（foreign ×0.5 保留可见），不进硬过滤。
  // 显式全局（值 NULL + source explicit）与未标注同形，天然恒可见。
  if (m.agent_scope_source === "explicit") {
    const agent = scopeKeyOf(m.agent_scope);
    if (agent !== null && (current.agent_scope === null || agent !== current.agent_scope)) return false;
  }
  if (m.workspace_scope_source === "explicit") {
    const ws = scopeKeyOf(m.workspace_scope);
    if (ws !== null && (current.workspace_scope === null || ws !== current.workspace_scope)) return false;
  }
  return true;
}

/** Prepend the previous content to a memory's content_history (FIFO capped). */
function pushContentHistory(existing, source) {
  const history = Array.isArray(existing?.content_history) ? existing.content_history : [];
  return [
    { content: existing?.content ?? "", source, updated_at: new Date().toISOString() },
    ...history
  ].slice(0, CONTENT_HISTORY_MAX);
}

/** Bug5: same-title merge appends the new content under a timestamped `---`
 *  separator instead of overwriting, so a re-noted memory never loses history.
 *  The `---` line is compatible with the mirror's readHumanEdits (which strips
 *  only the LAST structural `---` when parsing the human-editable file). */
function appendContent(oldContent, newContent) {
  const ts = new Date().toISOString();
  return `${oldContent}\n\n---\n[${ts}] ${newContent}`;
}

/**
 * Standard retrieval-quality metrics over the ordered candidate ids actually
 * returned vs the ids the evaluator marked relevant (方案 B). Pure + total, so
 * callers (and tests) get deterministic numbers without touching a store:
 *   precision = |relevant ∩ retrieved| / |retrieved|
 *   recall    = |relevant ∩ retrieved| / |expected|
 *   mrr       = 1 / rank of the first relevant doc (0 when none retrieved)
 * hit_count is the raw intersection size. Values are rounded to 4 decimals so
 * repeated divisions (e.g. 1/3) never surface binary-float noise.
 */
export function computeRetrievalMetrics(actualIds, expectedIds) {
  const expected = new Set(Array.isArray(expectedIds) ? expectedIds : []);
  const actual = Array.isArray(actualIds) ? actualIds : [];
  const relevant = actual.filter((id) => expected.has(id)).length;
  const round4 = (x) => Math.round(x * 10000) / 10000;
  let mrr = 0;
  for (let i = 0; i < actual.length; i++) {
    if (expected.has(actual[i])) { mrr = 1 / (i + 1); break; }
  }
  return {
    precision: round4(actual.length ? relevant / actual.length : 0),
    recall: round4(expected.size ? relevant / expected.size : 0),
    mrr: round4(mrr),
    hit_count: relevant
  };
}

export function createService({ store, mirror, config, onWrite, logger, documentIndex, writeAdmission }) {
  const language = langOf(config);
  // Optional dream scheduler hook, installed via setDreamHook after creation
  // (the scheduler holds a reference back to the service, so it cannot be
  // passed in the constructor). Fired on the same write events as onWrite.
  let dreamHook = null;

  // Optional sleep scheduler hook (v0.4.0), installed via setSleepHook after
  // creation. Fired on the same write events as onWrite: it tells the sleep
  // scheduler the store just changed so the idle-detection clock resets.
  let sleepHook = null;

  // Optional vector embedder, installed via setEmbedder after creation. After
  // any content write it fire-and-forgets a re-embed of the row so vector
  // search stays in sync; failures are swallowed inside the embedder.
  let embedder = null;

  // Optional entity extractor, installed via setEntityExtractor after creation
  // (index.js injects it so the service never depends on the LLM directly).
  // After a new memory is saved it fire-and-forgets an extraction pass for the
  // entity gene (v0.3.0); failures are swallowed so a broken extraction never
  // surfaces as a write failure. Extraction only runs when
  // config.entityExtractionEnabled is true.
  let entityExtractor = null;
  let vectorIndex = null;
  let reranker = null;

  // Optional recall recorder, installed via setRecallRecorder after creation.
  // When searchMemories is called with recordRecall=true it receives the
  // actual merged recall scene (candidates + scores + source + threshold) so
  // the retrieval layer can be audited/replayed — the sibling of the dream
  // judgment-layer audit trail (dream_runs).
  let recallRecorder = null;

  // Bug4: semantic recall cache for the injection path. The system-prompt
  // interpolator renders context synchronously, so injectCandidates cannot
  // fire a fresh async embed. The most recent searchMemories recall is cached
  // here (query + ordered candidates) and reused when the injection query
  // matches, giving semantic-first injection without breaking the sync render.
  let lastSemanticRecall = null;

  // Transaction nesting depth. Inside service.transaction the per-mutation side
  // effects (mirror render, write notify, re-embed) are deferred so a ROLLBACK
  // never leaves the mirror file diverged from the database; transaction()
  // replays them exactly once against the committed state.
  let txDepth = 0;

  // Serial task queue (sleep v0.4.0). Long-running background passes — dream
  // consolidation, sleep cycles — must never overlap: two sleep runs racing
  // would double-demote or double-mint patterns. enqueue chains the task onto
  // a promise tail so N callers can queue work that runs strictly one at a
  // time. A task that rejects doesn't poison the queue (the tail swallows the
  // rejection) but the rejection still propagates to that caller.
  let queueTail = Promise.resolve();
  function enqueue(fn) {
    const next = queueTail.then(fn, fn);
    queueTail = next.catch(() => {});
    return next;
  }

  // issue #6 (part 2): startup race defense. A local embedder (LocalEmbedder /
  // Ollama) exposes an async init(), so between `setEmbedder` and init()
  // resolving there is a window where embedSingle would throw "not initialized"
  // and the re-embed would be silently dropped. When the embedder carries a
  // `ready` flag we queue writes in embedPending until init sets ready=true,
  // then flush them through the embedder's real interface. Embedders without a
  // `ready` flag (legacy OpenAI, instantly usable) keep their old behavior.
  let embedPending = [];
  let embedReadyTimer = null;
  const EMBED_PENDING_MAX = 100; // bound the queue; drop oldest beyond this
  const EMBED_READY_POLL_MS = 100;
  const EMBED_READY_POLL_LIMIT = 30; // ~3s ceiling; never poll forever

  /** Flush the queued re-embeds once the embedder is ready. Fail-safe. */
  function flushEmbedPending() {
    if (!embedder || embedPending.length === 0) return;
    const batch = embedPending.splice(0, embedPending.length);
    for (const memory of batch) {
      try {
        if (!memory?.id) continue;
        if (typeof embedder.schedule === "function") {
          embedder.schedule(memory);
        } else if (typeof embedder.embedSingle === "function") {
          const text = [memory.title, memory.content].filter(Boolean).join("\n");
          if (!text) continue;
          embedder
            .embedSingle(text)
            .then((vec) => {
              if (Array.isArray(vec) && vec.length) {
                store.setEmbedding(memory.id, vec);
              }
            })
            .catch((err) => {
              logger?.warn?.("flushEmbedPending embedSingle failed:", err);
            });
        }
      } catch (err) {
        logger?.warn?.("flushEmbedPending failed:", err);
      }
    }
  }

  function stopEmbedReadyPolling() {
    if (embedReadyTimer) {
      clearInterval(embedReadyTimer);
      embedReadyTimer = null;
    }
  }

  function scheduleEmbed(memory) {
    try {
      if (txDepth > 0) return; // deferred to the transaction's commit
      if (!embedder || !memory?.id) return;

      // Readiness gate: embedder exposes `ready` (async init) and is not ready
      // yet — queue instead of firing embedSingle into a half-built extractor.
      const hasReady = "ready" in embedder;
      if (hasReady && embedder.ready !== true) {
        if (embedPending.length >= EMBED_PENDING_MAX) embedPending.shift();
        embedPending.push(memory);
        return;
      }

      if (typeof embedder.schedule === "function") {
        embedder.schedule(memory);
        return;
      }

      if (typeof embedder.embedSingle === "function") {
        const text = [memory.title, memory.content].filter(Boolean).join("\n");
        if (!text) return;

        embedder
          .embedSingle(text)
          .then((vec) => {
            if (Array.isArray(vec) && vec.length) {
              store.setEmbedding(memory.id, vec);
            }
          })
          .catch((err) => {
            logger?.warn?.("scheduleEmbed embedSingle failed:", err);
          });
      }
    } catch (err) {
      logger?.warn?.("scheduleEmbed failed:", err);
    }
  }

  /**
   * Fire-and-forget entity extraction for a freshly saved memory (entity gene
   * v0.3.0). Opt-in via config.entityExtractionEnabled; the extractor is
   * injected as a hook so the service never needs a direct LLM reference.
   * The hook itself is expected to resolve to { ok:boolean } and never throw;
   * a thrown rejection is swallowed here as a final fail-safe.
   */
  // #372: 事务内的抽取曾经被这里直接丢弃（注释写 deferred，实际 transaction()
  // 从不补跑）——自动蒸馏的所有写入都裹在 service.transaction() 里，session:* 来源
  // 的记忆因此 100% 抽不到实体。改为入队，事务提交后由 transaction() 的 drain 补跑。
  // 队列不设上限：元素只是对已落库行的引用（内存成本≈0），而 cap 丢最旧等于把
  // 「抽取被静默丢弃」这个本修复要消灭的 bug 换个量级带回来；上限实际由事务内
  // 写入批量决定。回滚时由 transaction() 截断到事务前的基线（见 ROLLBACK 路径）。
  const pendingEntity = [];

  function scheduleEntityExtraction(memory) {
    if (txDepth > 0) {
      pendingEntity.push(memory);
      return;
    }
    if (!config.entityExtractionEnabled || !entityExtractor) return;
    try {
      entityExtractor(memory).catch((err) => {
        logger?.warn?.("entity extraction failed:", err);
      });
    } catch (err) {
      logger?.warn?.("entity extraction failed:", err);
    }
  }

  /**
   * Cross-encoder rerank over a candidate list (best effort). Reranker
   * failures degrade to the original candidate order — reranking is an
   * accuracy upgrade, never a correctness gate.
   */
  async function rerankCandidates(query, candidates, topK) {
    if (!reranker || !candidates.length) return candidates.slice(0, topK);
    try {
      const scored = await reranker.rerank(query, candidates.map((c) => ({ id: c.id, title: c.title, content: c.content })));
      if (!Array.isArray(scored)) return candidates.slice(0, topK);
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const out = [];
      for (const s of scored) {
        const c = byId.get(s.id);
        if (c) { out.push({ ...c, score: s.score, source: "rerank" }); if (out.length >= topK) break; }
      }
      return out.length ? out : candidates.slice(0, topK);
    } catch {
      return candidates.slice(0, topK);
    }
  }

  /**
   * v0.8.0 A3（issue #17）strictScope 硬过滤的**唯一实现**。三处共用：融合池、
   * `entity:` 与 `attr:` 两条前缀路。
   *
   * 抽成单一实现是为了让「过滤点写在哪」不再漂移——那两条前缀路在 searchMemories
   * 的入口就 return（见那里的路由块），早于融合池那道过滤，曾经整条绕过硬墙；三处
   * 各写一份判断，只会让下一个新增通路再漏一次（同 #349 把阈值口径收进
   * activeStoreSize 的理由：两处各写一份过滤条件，漂移只在某条路径上显形）。
   *
   * strictScope 关（默认）或 scope 解析不到时原样返回：行为与改动前逐字节一致。
   */
  function gateByScope(rows, scope) {
    if (config?.strictScope !== true || !scope) return rows;
    return rows.filter((m) => isVisibleInScope(m, scope));
  }

  /**
   * Search for memories attached to a named entity (v0.3.0 Phase 3).
   * 合并优先级：entity_attrs.memory_id 精确关联 = 1.0 > 关键词提及 = 0.7；
   * attr 命中不覆盖，keyword 只补充召回，最后按 _score 降序取 topK。
   * @param {string} entityName
   * @param {object} [options]
   * @param {number} [options.topK=20]
   * @param {object|null} [options.scope] 当前会话 scope，供 strictScope 闸门使用
   * @returns {any[]}
   */
  function searchByEntity(entityName, { topK = 20, scope = null } = {}) {
    const entity = store.findEntityByName(entityName);
    if (!entity) return [];
    const attrs = store.getCurrentAttrs(entity.id);
    const memoryIds = [...new Set(attrs.map((a) => a.memory_id).filter(Boolean))];
    const attrHits = memoryIds.map((id) => store.getById(id)).filter(Boolean);
    // 关键词这一路的窗口取两倍：闸门在截断之前生效，出局的候选会让位，窗口按最终条数
    // 取就会不够（与融合路给向量检索取 lim * 2 同一个理由）。没有候选被闸掉时结果与
    // 取 topK 逐字节一致——多出来的是排在后面的低分候选，进不了 topK。
    const keywordHits = store.search(entityName, { limit: topK * 2 });
    const merged = new Map();
    for (const mem of attrHits) merged.set(mem.id, { ...mem, _source: "entity_attr", _score: 1.0 });
    for (const mem of keywordHits) {
      if (!merged.has(mem.id)) merged.set(mem.id, { ...mem, _source: "keyword", _score: 0.7 });
    }
    // 先过闸、再截 topK：反过来做的话，出局的候选会占掉名额、可见的补不进来——topK=1
    // 而首位出局时直接返回空数组。排序本身不动，只是把闸门插在截断之前，与融合池那条
    // 路同序（那边也是先 filter 后 slice）。
    const ranked = Array.from(merged.values()).sort((a, b) => b._score - a._score);
    const visible = gateByScope(ranked, scope).slice(0, topK);
    // 闸门还必须在 touchRecalled **之前**：放在后面的话，一次越权检索照样会给出局的
    // 行刷回温时钟，并在被动确认开启时 bump 它们的关联边——命中反馈落到了调用方
    // 本不该看见的行上。
    touchRecalled(visible);
    return visible;
  }

  /**
   * Search for memories by attribute key/value (v0.3.0 Phase 3).
   * value 为空时由 store.findMemoriesByAttr 返回该 key 的全部有效记忆。
   * @param {string} key
   * @param {string | undefined} value
   * @param {object} [options]
   * @param {number} [options.topK=20]
   * @param {object|null} [options.scope] 当前会话 scope，供 strictScope 闸门使用
   * @returns {any[]}
   */
  function searchByAttr(key, value, { topK = 20, scope = null } = {}) {
    if (!key) return [];
    // value 可能为 undefined（attr:key 无 = 值）：归一为空串后交给
    // store.findMemoriesByAttr —— 空 value 契约 = 返回该 attr_key 的全部
    // 当前有效记忆（v0.3.0，store.js 已实现）。
    const rows = store.findMemoriesByAttr(key, value ?? "");
    // 同 searchByEntity：先过闸再截 topK，且闸门在 touchRecalled 之前。
    const visible = gateByScope(rows, scope).slice(0, topK);
    touchRecalled(visible);
    return visible;
  }

  /**
   * Semantic-aware memory search: keyword recall (store.search) plus optional
   * vector recall + rerank. mode:
   *   auto    (default) keyword first, vector fills remaining slots (legacy)
   *   hybrid  vector first, keyword fills remaining slots
   *   vector  vector only, falls back to keyword when unavailable
   *   keyword text only, never touches the embedder
   * useRerank runs the cross-encoder over the merged list when a reranker is
   * installed; results carry an extra `score` when reranked.
   */
  // Weighted blend factor for hybrid search; exposed so callers can tune it.
  const DEFAULT_HYBRID_WEIGHTS = { vector: 0.6, keyword: 0.4 };

  // Cosine over two plain arrays (shared by the search-time semantic dedup).
  function cosineVec(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * BM25 third recall path (v0.5.0 1.1). Scores the query tokens against the
   * live non-archived rows and returns the top `limit` hits with scores
   * normalized to [0,1]. Failures degrade to [] — BM25 is a recall booster,
   * never a correctness gate.
   */
  function bm25Recall(q, limit) {
    if (config?.bm25SearchEnabled === false) return [];
    try {
      const docs = store.list({ limit: 500, includeForgotten: false }).filter((m) => !m.archived);
      if (!docs.length) return [];
      return createBM25Index(docs).search(q, { limit });
    } catch {
      return [];
    }
  }

  /**
   * Graph fourth recall path (issue #219 → #24 块1 锚定层). When the query text
   * mentions a known entity name, memories linked to that entity (attrs +
   * relations) join the fusion pool as a confirm/backfill signal — same standing
   * as BM25, never dominating the semantic ranking. Tier scores: attr-linked
   * 1.0 (direct evidence, same source searchByEntity trusts) > relation edge
   * 0.9. Archived/forgotten rows never participate. Failures degrade to [] —
   * a recall booster, never a correctness gate (same contract as bm25Recall).
   *
   * #24 升级（graphAnchoringEnabled）：命中实体作为锚定种子，沿 entity_relations
   * 级联扩散邻居（默认深度 2），邻居挂联的记忆以 hop 配额权重参与——把「关系是
   * 用出来的」延伸成检索信号：查询命中的不只有直接挂联，还有跳跃可达的活跃子图。
   * 邻居权重 = HOP_QUOTA[hop] × linked tier（attr 1.0 / relation 0.9），仍低于
   * 直达种子的满权，绝不喧宾夺主。
   */
  function entityRecall(q, limit) {
    if (config?.entityRecallEnabled !== true) return [];
    try {
      const entities = store.findEntitiesMentionedIn(q);
      if (!entities.length) return [];
      // 关闭锚定级联=逐字节复用 #219 单跳轴：种子裁剪/重排/截断全是 #24 新增的
      // 行为，默认关时一条都不许漏进旧路径（graphSeedCap 也只在开启后生效——
      // 无论 cap 调多小，关档时命中实体仍全量挂联）。
      if (config?.graphAnchoringEnabled !== true) {
        const linked = store.getLinkedMemoryIds(entities.map((e) => e.id));
        if (!linked.size) return [];
        const hits = [];
        for (const [id, tier] of linked) {
          const row = store.getById(id);
          if (!row || row.archived || row.forgotten) continue;
          hits.push({ ...row, score: tier === "attr" ? 1.0 : 0.9, source: "entity" });
          if (hits.length >= limit * 2) break;
        }
        return hits;
      }
      // 锚定种子（精确名布尔通路——命名实体逻辑上是离散匹配，不参与 min-max）。
      const exact = normalizePath(entities.map((e) => e.id), { path: "exact" });
      const seeds = anchorSeeds({ paths: [exact], cap: config?.graphSeedCap ?? 12 });
      if (!seeds.length) return [];
      // 0-hop 直达：挂联记忆按 tier 定分（attr 1.0 / relation 0.9）——与 #219
      // 单跳轴同分。MAX 语义：同一条记忆被多实体挂联时保留最高分。
      const scored = new Map();
      const push = (memId, score) => {
        if (scored.has(memId) && scored.get(memId) >= score) return;
        const row = store.getById(memId);
        if (!row || row.archived || row.forgotten) return;
        scored.set(memId, score);
      };
      const seedLinked = store.getLinkedMemoryIds(seeds.map((s) => s.id));
      for (const [memId, tier] of seedLinked) {
        push(memId, tier === "attr" ? 1.0 : 0.9);
      }
      // 级联：沿 entity_relations 走 BFS，邻居挂联的记忆以 hop 配额权重补位——
      // 不覆盖种子直达分（MAX 语义保证），只填「种子里没有但邻居可达」的槽。
      const seedIds = seeds.map((s) => s.id);
      const adjacency = store.getEntityNeighbors(seedIds);
      const depths = cascadeDepths({
        seeds,
        // 逐节点懒取邻居：初次查询只带种子那一层的邻接，BFS 走到 1-hop 节点时
        // 必须按需再拉一层，否则 >1 跳永远拿到空邻居、graphCascadeDepth≥2 形同
        // 虚设。节点数随图度数增长，热路径上以 graphCascadeDepth≤3 为天然上界，
        // 真遇到大图再考虑查询配额。
        adjacencyOf: (id) => {
          if (!adjacency.has(id)) adjacency.set(id, store.getEntityNeighbors([id]).get(id) ?? []);
          return adjacency.get(id);
        },
        maxDepth: config?.graphCascadeDepth ?? 2
      });
      let neighborsSeen = 0;
      const neighborCap = (config?.graphSeedCap ?? 12) * HOP_QUOTA[1]; // 1-hop 配额即为邻居总量上界
      for (const [nid, hop] of depths) {
        if (hop < 1) continue;
        if (neighborsSeen >= Math.max(1, Math.floor(neighborCap))) break;
        neighborsSeen++;
        const neighborLinked = store.getLinkedMemoryIds([nid]);
        for (const [memId, tier] of neighborLinked) {
          const tierW = tier === "attr" ? 1.0 : 0.9;
          push(memId, HOP_QUOTA[Math.min(hop, 3)] * tierW);
        }
      }
      const hits = [...scored.entries()]
        .map(([id, score]) => {
          const row = store.getById(id);
          return { ...row, score, source: "entity" };
        })
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return hits.slice(0, limit * 2);
    } catch {
      return [];
    }
  }

  /**
   * Search-time semantic dedup (v0.5.0 2.3): greedy pass dropping candidates
   * whose embedding similarity to an already-kept row exceeds the threshold.
   * Rows without a stored embedding are always kept (no signal = no drop).
   */
  function semanticDeduplicate(candidates) {
    // Opt-in aggressive mode (default off): collapsing near-duplicates can
    // drop legitimately distinct rows on small embedding models, so it ships
    // behind searchSemanticDedup=true.
    if (config?.searchSemanticDedup !== true || candidates.length < 2) return candidates;
    const threshold = config?.searchSemanticDedupThreshold ?? 0.95;
    try {
      const vecs = store.getEmbeddings(candidates.map((c) => c.id));
      if (vecs.size < 2) return candidates;
      const kept = [];
      for (const c of candidates) {
        const v = vecs.get(c.id);
        if (!v) { kept.push(c); continue; }
        const dup = kept.some((k) => {
          const kv = vecs.get(k.id);
          return kv && cosineVec(v, kv) > threshold;
        });
        if (!dup) kept.push(c);
      }
      return kept;
    } catch {
      return candidates;
    }
  }

  /**
   * Give a keyword-hit row a relevance score in [0,1]: title hits score
   * higher than content hits, then scaled by importance (1-5). This lets
   * keyword results participate in weighted hybrid blends.
   */
  function scoreKeyword(row, q) {
    const ql = q.toLowerCase();
    const title = (row.title ?? "").toLowerCase();
    const content = (row.content ?? "").toLowerCase();
    const titleHit = title.includes(ql);
    const base = titleHit ? 1 : content.includes(ql) ? 0.6 : 0.3;
    return base * (0.5 + (row.importance ?? 3) / 10);
  }

  /**
   * Recall touch (v0.4.0 sleep; v0.7.0 heat gating): any memory surfaced by
   * recall or auto-injection gets its last_accessed_at bumped, so the "unrecalled
   * N days → demote/archive" tiering counts real access — and the heat clock
   * resets (heat ref = last_accessed_at). Best-effort and gated on
   * config.heatEnabled — when heat is off this is a complete no-op (no writes
   * on the hot recall path). A touch failure must never break search/inject.
   */
  function touchRecalled(memories) {
    if (!Array.isArray(memories) || memories.length === 0) return;
    // heatEnabled=false 只关 touchLastAccess 的热度消费（既有语义），但 #24
    // 块4 被动确认独立于 heat——graphPassiveConfirm 开时照常 bump 关联边。
    // graphWeightEnabled 是块2 立的演化总闸：它关着时任何触达都不该改边权，被动
    // 确认只是它底下的一个通道（后续块还会接别的确认通道），两键同开才 bump，
    // 否则单开通道键就等于绕过「演化默认关」的承诺。
    // 两条路径都 best-effort，失败绝不阻断检索/注入。
    const heatOn = config?.heatEnabled !== false;
    const passive = config?.graphPassiveConfirm === true && config?.graphWeightEnabled === true;
    const delta = config?.graphWeightDelta ?? 0.1;
    for (const m of memories) {
      if (!m?.id) continue;
      try {
        if (heatOn) store.touchLastAccess(m.id);
        if (passive) {
          // 正常触达=对该记忆挂联关系边的被动确认；bump 只加不减封顶 1.0，
          // 自激回路由封顶天然遏制。「仅异常路径暴露给用户复核」的确认记录
          // 侧在此落地，复核 UI 留后续块。
          for (const rel of store.getRelationsByMemory(m.id)) {
            store.bumpRelationWeight(rel.id, delta);
          }
        }
      } catch { /* touch is best effort */ }
    }
  }

  /**
   * Recall fusion (plan #1). Turns the three ranked signal lists (keyword,
   * vector, BM25) into a single merged list. Three recipes, selected by
   * config.recallFusion:
   *  - blend (default): legacy behavior — weighted sum for vector/hybrid, union
   *    backfill for auto. Byte-identical to pre-fusion code, so enabling the
   *    config never regresses anybody.
   *  - rrf: Reciprocal Rank Fusion — Σ 1/(k + rank + 1) over each list a row
   *    appears in. Rank-based, so the unit mismatch (raw cosine vs keyword
   *    score vs normalized IDF) is irrelevant.
   *  - minmax: min-max normalize each source list's scores to [0,1] then take
   *    the weighted sum — a scale-aware version of `blend`.
   * Returns { merged, signals }, where signals is Map<id, {keyword, vector,
   * bm25}> so searchMemories can decorate rows when signalTransparency is on.
   */
  function fuseRecall({ keyword, vector, bm25, entity, lim, mode, wv, wk, wb, we }) {
    const recipe = config?.recallFusion ?? "blend";

    // Per-source scores are recorded for every recipe so signalTransparency
    // works regardless of how the ranking was produced.
    const signals = new Map();
    const addSig = (id, field, sc) => {
      const cur = signals.get(id) ?? {};
      cur[field] = sc;
      signals.set(id, cur);
    };
    for (const m of keyword) addSig(m.id, "keyword", m.score ?? 0);
    for (const m of vector) addSig(m.id, "vector", m.score ?? 0);
    for (const m of bm25) addSig(m.id, "bm25", m.score ?? 0);
    for (const m of entity) addSig(m.id, "entity", m.score ?? 0);

    const vectorIds = new Set(vector.map((m) => m.id));
    const keywordIds = new Set(keyword.map((m) => m.id));

    // Mode contract (aligns rrf/minmax with blend): keyword-only searches must
    // stay keyword-only regardless of recipe, so enabling an opt-in recipe can
    // never pull vector/BM25 rows into a mode="keyword" request. This mirrors
    // the blend branch's `mode === "keyword"` short-circuit (byte-for-byte).
    if (mode === "keyword") {
      return { merged: keyword.slice(0, lim), signals };
    }

    let merged;
    if (recipe === "rrf") {
      // Rank-based: only the position of a row inside each surviving source
      // list matters, so no cross-signal scale calibration is needed.
      const k = 60; // standard RRF constant (plan #1 documents k=60)
      const rows = new Map();
      const addList = (list) => list.forEach((m, idx) => {
        const s = 1 / (k + idx + 1);
        const cur = rows.get(m.id);
        if (cur) cur.score += s;
        else rows.set(m.id, { ...m, score: s });
      });
      addList(keyword);
      addList(vector);
      addList(bm25);
      addList(entity);
      merged = [...rows.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, lim);
    } else if (recipe === "minmax") {
      // Scale-aware weighted sum: each source list is min-max normalized to
      // [0,1] before blending, so raw cosine and keyword score live on the
      // same footing.
      const norm = (list) => {
        if (!list.length) return new Map();
        let min = Infinity, max = -Infinity;
        for (const m of list) { const s = m.score ?? 0; if (s < min) min = s; if (s > max) max = s; }
        const range = max - min;
        const out = new Map();
        for (const m of list) out.set(m.id, range > 0 ? ((m.score ?? 0) - min) / range : 0.5);
        return out;
      };
      const kw = norm(keyword), ve = norm(vector), bm = norm(bm25), en = norm(entity);
      const rows = new Map();
      const seed = (m) => { if (!rows.has(m.id)) rows.set(m.id, { ...m, score: 0 }); };
      for (const m of keyword) seed(m);
      for (const m of vector) seed(m);
      for (const m of bm25) seed(m);
      for (const m of entity) seed(m);
      for (const [id, row] of rows) {
        const k = kw.get(id) ?? 0;
        const v = ve.get(id) ?? 0;
        const b = bm.get(id) ?? 0;
        const e = en.get(id) ?? 0;
        row.score = v * wv + k * wk + b * wb + e * we;
      }
      merged = [...rows.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, lim);
    } else {
      // blend — the pre-existing per-mode behavior, extracted verbatim.
      if (mode === "keyword") {
        merged = keyword;
      } else if (mode === "vector" || mode === "hybrid") {
        const byId = new Map();
        for (const m of vector) {
          const rec = byId.get(m.id);
          byId.set(m.id, rec ? { ...rec, score: Math.max(rec.score ?? 0, m.score ?? 0) } : m);
        }
        for (const m of keyword) {
          const rec = byId.get(m.id);
          if (rec) {
            byId.set(m.id, { ...rec, score: (rec.score ?? 0) * wv + (m.score ?? 0) * wk });
          } else {
            byId.set(m.id, m);
          }
        }
        for (const m of bm25) {
          const rec = byId.get(m.id);
          if (rec) {
            if (keywordIds.has(m.id)) continue;
            byId.set(m.id, { ...rec, score: (rec.score ?? 0) + wb * (m.score ?? 0) });
          } else {
            byId.set(m.id, { ...m, score: wb * (m.score ?? 0) });
          }
        }
        // Entity axis (#219): same confirm/backfill contract as BM25 —
        // seen rows get a weighted bonus, unseen ids backfill at we·score.
        for (const m of entity) {
          const rec = byId.get(m.id);
          if (rec) {
            byId.set(m.id, { ...rec, score: (rec.score ?? 0) + we * (m.score ?? 0) });
          } else {
            byId.set(m.id, { ...m, score: we * (m.score ?? 0) });
          }
        }
        const ranked = [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        merged = ranked.slice(0, lim);
        if (merged.length < lim && !merged.length) {
          merged = keyword.slice(0, lim);
        }
      } else {
        // auto: keyword leads, vector + BM25 + entity fill remaining slots.
        merged = keyword.slice(0, lim);
        const seen = new Set(merged.map((m) => m.id));
        for (const m of vector) {
          if (merged.length >= lim) break;
          if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
        }
        for (const m of bm25) {
          if (merged.length >= lim) break;
          if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
        }
        for (const m of entity) {
          if (merged.length >= lim) break;
          if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
        }
      }
    }

    // Mode contract, auto (aligns rrf/minmax with blend): keyword leads, the
    // recipe fills the remaining slots. blend.auto already front-loads keyword;
    // rrf/minmax rank across sources, so re-apply the same "keyword first"
    // ordering here to preserve the pre-fusion auto contract — the keyword
    // hit list keeps its power, and only slots it couldn't fill go to the
    // recipe's ranking.
    if (recipe !== "blend" && mode === "auto" && keyword.length) {
      const head = keyword.slice(0, lim);
      const seen = new Set(head.map((m) => m.id));
      const tail = merged.filter((m) => !seen.has(m.id)).slice(0, Math.max(0, lim - head.length));
      merged = head.concat(tail);
    }

    return { merged, signals };
  }

  /**
   * Search memories for a query. Merges up to four recall sources (keyword,
   * vector, BM25, and — when config.entityRecallEnabled is on — entity-linked
   * memories whose entity names the query mentions; see fuseRecall) according
   * to config.recallFusion (blend/rrf/minmax — see
   * fuseRecall), then optionally decorates rows with per-source signals
   * (config.signalTransparency), applies semantic dedup (non-keyword modes),
   * reranking, and epistemic trust re-weighting, and finally hands the merged
   * list to the recall-layer recorder.
   *
   * options:
   *   mode          — 'auto' (default) | 'keyword' | 'vector' | 'hybrid'
   *   topK          — max rows (default 20)
   *   threshold     — explicit vector score floor (overrides adaptive)
   *   useRerank     — apply the reranker if available (default true)
   *   recordRecall  — write a recall_runs audit row (default from config)
   *
   * Returns an array of memory rows { id, title, content, score, source, ... },
   * with `signals` added when config.signalTransparency is on. Never throws:
   * a vector/rerank failure degrades to keyword results.
   */
  async function searchMemories(query, options = {}) {
    const {
      mode = "auto",
      topK = 20,
      threshold,
      useRerank = true,
      // v0.8.0 A2（issue #17）：当前会话 scope（工具层从 exec 解析后传入）与
      // occurred_at 时间窗。两者都只在显式传入时生效，既有调用方（注入/梦/评测）
      // 不传 → 行为与 A2 前一致。
      scope = null,
      occurredFrom = null,
      occurredTo = null,
      recordRecall = options.recordRecall ?? (config?.recallRecordDefault ?? true)
    } = options;
    const q = String(query ?? "").trim();
    if (!q) return [];

    // entity:/attr: 前缀路由（v0.3.0 Phase 3）。entitySearchEnabled 关闭时走原逻辑。
    if (config?.entitySearchEnabled) {
      if (q.startsWith("entity:")) {
        return searchByEntity(q.slice(7).trim(), options);
      }
      if (q.startsWith("attr:")) {
        const [key, value] = q.slice(5).split("=");
        return searchByAttr(key, value, options);
      }
    }

    const lim = topK > 0 ? topK : 20;

    // Keyword results, decorated with a score so they can be weight-blended
    // with vector results and reported uniformly. source tracks where each
    // candidate came from for the recall layer receipt.
    const rawKeyword = store.search(q, { limit: lim });
    const keyword = rawKeyword.map((m) => ({ ...m, score: scoreKeyword(m, q), source: "keyword" }));
    const wantVector = mode === "vector" || mode === "hybrid" || (mode === "auto" && !!embedder);
    let vector = [];
    if (wantVector && embedder) {
      try {
        // Legacy embedders expose embed(query); local ones expose embedSingle.
        const embedSingle = typeof embedder.embedSingle === "function"
          ? embedder.embedSingle.bind(embedder)
          : embedder.embed.bind(embedder);
        const qv = await embedSingle(q);
        if (qv?.length) {
          // Adaptive threshold (v0.5.0 1.2): the fetch runs at the loosest
          // branch floor so the head-gap rule can still re-admit the tail;
          // the final cutoff is computed against the fetched score
          // distribution. Explicit `threshold` wins; disabled → legacy 0.
          const adaptive = config?.adaptiveThresholdEnabled !== false;
          const fetchThreshold = adaptive && threshold === undefined
            ? Math.min(0.5, adaptiveThreshold(q))
            : (threshold ?? 0);
          const search = vectorIndex
            ? vectorIndex.search(qv, { limit: lim * 2, threshold: fetchThreshold })
            : store.searchVector(qv, { limit: lim * 2, threshold: fetchThreshold });
          const finalThreshold = adaptive && threshold === undefined
            ? adaptiveThreshold(q, search)
            : (threshold ?? 0);
          vector = search
            .filter((m) => (m.score ?? 1) >= finalThreshold)
            .map((m) => ({ ...m, vector: true, source: "vector" }));
        }
      } catch { /* vector unavailable: keep keyword results */ }
    }

    // BM25 third path (v0.5.0 1.1): IDF-weighted token overlap recalls rows
    // whose query terms are scattered — the gap LIKE substring matching
    // cannot close. Scores are already normalized to [0,1].
    const bm25 = bm25Recall(q, lim).map((m) => ({ ...m, source: "bm25" }));
    // Loose blend weight: BM25 confirms and backfills, never dominates the
    // semantic signal. Same-memory overlap boosts, unseen ids backfill.
    const wb = 0.3;

    // Graph fourth path (issue #219, opt-in entityRecallEnabled): query-
    // mentioned entities pull their linked memories into the pool. Keyword
    // mode stays text-only per the mode contract, so the axis is skipped
    // there even when enabled.
    const entity = mode === "keyword" ? [] : entityRecall(q, lim);
    // Entity axis shares BM25's backfill weight (we = wb) until #217 recall
    // data justifies a distinct entity weight.

    // Hybrid blending weights from config when provided.
    const wv = config?.hybridSearchVectorWeight ?? DEFAULT_HYBRID_WEIGHTS.vector;
    const wk = config?.hybridSearchKeywordWeight ?? DEFAULT_HYBRID_WEIGHTS.keyword;

    const { merged: fusedMerged, signals } = fuseRecall({ keyword, vector, bm25, entity, lim, mode, wv, wk, wb, we: wb });
    let merged = fusedMerged;
    // v0.8.0 A3（issue #17）：strictScope 硬过滤——他 scope 的候选直接出局
    // （区别于 A2 的降权保留可见）；未标注行与命中行保留。strict 与 A2 加权
    // 叠加：过滤后剩下的命中行仍吃加成。scope 未传（flag 关）或完全解析不到
    // 时跳过——identity 为空的对象（{null,null}）按 fail-closed 过滤。
    merged = gateByScope(merged, scope);
    // v0.8.0 A2：occurred_at 时间过滤——在融合池上先滤再 dedup/slice，rerank
    // 只看窗内候选，topK 槽位不被窗外行占用。
    const occurredBounds = updatedAtBounds(occurredFrom, occurredTo);
    if (occurredBounds.from || occurredBounds.to) {
      merged = merged.filter((m) => inOccurredBounds(m, occurredBounds));
    }
    // Signal transparency (#2): decorate each returned row with its per-source
    // scores and the final fused score. Purely additive — never changes rank.
    if (config?.signalTransparency === true) {
      merged = merged.map((m) => ({ ...m, signals: { ...(signals.get(m.id) ?? {}), final: m.score ?? 0 } }));
    }

    // Search-time semantic dedup (v0.5.0 2.3): near-duplicate rows are
    // dropped before the reranker sees them, so topK slots carry distinct
    // information instead of the same memory twice. Keyword mode is exempt —
    // it is the documented text-only path and must not be altered by
    // embedding state.
    merged = mode === "keyword" ? merged : semanticDeduplicate(merged);
    merged = merged.slice(0, lim);
    let result = useRerank && reranker && merged.length
      ? await rerankCandidates(q, merged, lim)
      : merged;
    // Epistemic trust (v0.4.5): opt-in re-weighting of the final candidate
    // scores by source credibility. When off (default) `result` is returned
    // untouched — exactly the legacy behavior.
    if (config.trustEpistemicWeighting === true) {
      result = result
        .map((m) => ({
          ...m,
          score: (m.score ?? 0) * (EPISTEMIC_WEIGHTS[m.epistemic_status] ?? 1)
        }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, lim);
    }

    // v0.8.0 A2（issue #17）：scope 检索加权——两维都无法确立 foreign 的候选
    // （命中/未标注/当前侧解析不到）加成，确立 foreign 的候选降权但保留可见
    // （硬过滤是 A3 strictScope）；未标注行与命中行同列吃 BOOST、不被压制。
    // flag 关或调用方未传 scope 时不动分，排序与 A2 前逐字节一致。与
    // epistemic 加权同款收尾：乘分 → 降序 → 截 topK。
    if (config.scopeEnabled === true && scope && (scope.agent_scope || scope.workspace_scope)) {
      result = result
        .map((m) => ({ ...m, score: (m.score ?? 0) * scopeMultiplier(m, scope) }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, lim);
    }

    // Recall layer receipt: with recordRecall on, hand the actual merged
    // candidate list (id/title/content/score/source) to the injected recorder
    // before returning, making the retrieval scene replayable — the sibling of
    // the dream judgment-layer audit trail. Recorder failures must never break
    // the search itself.
    if (recordRecall && recallRecorder) {
      try {
        recallRecorder({
          query: q,
          mode,
          topK: lim,
          threshold: threshold ?? null,
          // Per-source 信号随回执落盘（fuseRecall 本就无条件计算，此前只服务
          // signalTransparency 展示）：复用侧查询画像（query 型 → 各路权重的
          // 离线聚合，AssoMem arXiv 2510.10397 消融所示收益大头）需要这份原料。
          // 纯加字段——recall_runs 无 schema 变更，旧行 candidates 缺该键照常读。
          candidates: result.map((m) => ({
            id: m.id,
            title: m.title,
            content: m.content,
            score: m.score ?? null,
            source: m.source ?? "keyword",
            signals: signals.get(m.id) ?? {}
          })),
          createdAt: new Date().toISOString()
        });
      } catch { /* recall receipt is best effort */ }
    }
    // Bug4: cache the latest semantic recall so the sync injection path can
    // reuse it when the injection query matches (no async embed available).
    lastSemanticRecall = { query: q, items: result };
    touchRecalled(result);
    return result;
  }

  /**
   * Retrieval evaluation (方案 B): run one search for `query`, compare the ids
   * it actually returned against `expectedIds`, and return the computed
   * metrics. When persistence is on (config.evalPersistTestResults, or an
   * explicit `persist` override per call) the snapshot is written to the
   * recall_evals table — a SEPARATE store from the recall_runs production audit,
   * so test/eval data never inflates the production trail.
   *
   * options:
   *   mode/topK/threshold/useRerank — passed through to searchMemories
   *   evalType                      — label for the snapshot (default 'manual')
   *   recordRecall                  — also write a recall_runs audit row for the
   *                                   same scene and link it via recall_run_id
   *                                   (default false: eval stays unlinked)
   *   recallRunId                   — explicit link to an existing recall_runs id
   *   persist                       — override the config gate for this call
   *
   * Returns { metrics, actualIds, expectedIds, recallRunId, persisted }.
   * Never throws on persistence failures: a broken eval write must not break
   * the retrieval quality measurement.
   */
  async function evaluateRetrieval(query, expectedIds, options = {}) {
    const q = String(query ?? "").trim();
    const expected = Array.isArray(expectedIds) ? expectedIds : [];
    const {
      mode = "auto",
      topK = 20,
      threshold,
      useRerank = true,
      evalType = "manual",
      recordRecall = false,
      recallRunId = null,
      persist = config.evalPersistTestResults === true
    } = options;
    if (!q) {
      const empty = computeRetrievalMetrics([], expected);
      return { metrics: empty, actualIds: [], expectedIds: expected, recallRunId: null, persisted: false };
    }

    const rows = await searchMemories(q, { mode, topK, threshold, useRerank, recordRecall: false });
    const actualIds = rows.map((m) => m.id);
    const metrics = computeRetrievalMetrics(actualIds, expected);

    // Optional recall_runs audit for the same scene; the eval row then links to
    // it. Kept separate from the production recorder (which fires only on
    // recordRecall=true inside searchMemories) — eval never double-records.
    // An explicit recallRunId wins; recordRecall only mints a NEW audit run when
    // the caller did not already link one (never clobber an existing link).
    let runId = recallRunId ?? null;
    if (recordRecall && runId === null) {
      try {
        const run = store.saveRecallRun({
          query: q,
          mode,
          topK,
          threshold: threshold ?? null,
          candidates: rows.map((m) => ({
            id: m.id,
            title: m.title,
            content: m.content,
            score: m.score ?? null,
            source: m.source ?? "keyword"
          })),
          created_at: new Date().toISOString()
        });
        runId = run.id;
      } catch { /* non-fatal: the eval itself still succeeds */ }
    }

    let persisted = false;
    if (persist) {
      try {
        store.saveRecallEval({
          recall_run_id: runId,
          query: q,
          expected_ids: expected,
          actual_ids: actualIds,
          metrics,
          eval_type: evalType,
          created_at: new Date().toISOString()
        });
        persisted = true;
      } catch { /* non-fatal: measurement survives a failed eval write */ }
    }
    return { metrics, actualIds, expectedIds: expected, recallRunId: runId, persisted };
  }

  /**
   * Fire-and-forget write notification; errors are swallowed to keep write
   * paths clean. The store mutation has already committed, so a throwing
   * subscriber must not surface as a write failure. Archive/forget flags are
   * state toggles, not content writes, so they never notify.
   */
  function notifyWrite() {
    if (txDepth > 0) return; // deferred to the transaction's commit
    if (onWrite) {
      try { onWrite(); } catch { /* ignore */ }
    }
    if (dreamHook) {
      try { dreamHook(); } catch { /* ignore */ }
    }
    if (sleepHook) {
      try { sleepHook(); } catch { /* ignore */ }
    }
  }

  /**
   * Run several store mutations atomically (SQLite BEGIN/COMMIT/ROLLBACK) and
   * fire the deferred side effects once against the committed state. A throwing
   * body rolls the whole batch back — no partial writes, no diverged mirror.
   * Errors propagate to the caller. NOTE: the commit path re-renders the mirror
   * and notifies subscribers, but re-embedding is left to the caller (the dream
   * flow re-embeds through maintainIndexAfterDream).
   */
  function transaction(fn) {
    store.db.exec("BEGIN");
    txDepth++;
    // #372: 记住本层事务开始时的队列深度——回滚时截断回这里。本层（及更深的
    // 嵌套层）入队的抽取随回滚一并丢弃，外层已提交未 drain 的条目不受牵连。
    const baseline = pendingEntity.length;
    let committed = false;
    try {
      const result = fn();
      store.db.exec("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      try { store.db.exec("ROLLBACK"); } catch { /* store may be closed */ }
      // 回滚：丢弃本层入队的抽取请求，绝不对已回滚的行抽实体（CodeRabbit
      // 复审抓出：仅靠 committed 门挡 drain 时，回滚条目会滞留队列、被下一个
      // 成功事务误抽）。外层未提交的条目在 baseline 之前，原样保留。
      pendingEntity.length = baseline;
      throw error;
    } finally {
      txDepth--;
      // Sync failures are surfaced, not swallowed (peer blocker 2): the mirror
      // debt was already recorded by markMirrorDirty inside syncMirror, so a
      // restart recovers — but the operator must see it now, not after restart.
      const syncResult = syncMirror();
      if (!syncResult?.success && !syncResult?.deferred) {
        logger?.warn?.("mirror sync failed after transaction:", syncResult?.error);
      }
      notifyWrite();
      // #372: 补跑事务内排队的实体抽取——只在 COMMIT 成功后（此时 txDepth 已归零，
      // scheduleEntityExtraction 走正常触发路径）。嵌套事务的内层提交不 drain
      // （txDepth 仍 >0 时 schedule 会重新入队，与 drain 形成自旋）——条目等最外层
      // COMMIT 后统一补跑。
      if (committed && txDepth === 0) drainPendingEntityExtraction();
    }
  }

  function drainPendingEntityExtraction() {
    while (pendingEntity.length) {
      scheduleEntityExtraction(pendingEntity.shift());
    }
  }

  /**
   * Embed an arbitrary query text and return its vector (null on failure / no
   * embedder). Used by the injector to prefetch the semantic-first recall
   * vector for the current user message — the system-prompt render is
   * synchronous, so the vector must be cached in advance (Bug4).
   */
  async function embedQuery(query) {
    const q = String(query ?? "").trim();
    if (!q || !embedder) return null;
    try {
      const embedSingle = typeof embedder.embedSingle === "function"
        ? embedder.embedSingle.bind(embedder)
        : embedder.embed.bind(embedder);
      const vector = await embedSingle(q);
      return Array.isArray(vector) && vector.length ? vector : null;
    } catch {
      return null;
    }
  }

  /**
   * 写入端同会话语义去重（Issue #127，opt-in，默认 off）：落库前把新条目与
   * 「同会话 + 时间窗」内已落库的记忆比对，命中即并入既有条目，不再新造一行。
   *
   * 分层：title 档走零成本的标题归一化；vector 档复用已有 embedding 列做近邻，
   * 新条目的向量由 embedder 现算（embedQuery），全程无 LLM 调用。embedder 不可用
   * 或向量缺失一律返回 undefined 回落正常写入——去重是增强，绝不能成为写入依赖。
   *
   * 作用域刻意限定「同会话」：跨会话的同类事实仍交给 autoDream / sleep 的批量裁决。
   * 比对逻辑与并入动作分别复用 cosineVec 与 saveWithDedupe 的 _mergeInto 分支。
   *
   * @returns {{action: "merged", memory: object, sim: number}|undefined} 命中则返回
   *          并入目标与相似度；未命中（含任何异常）返回 undefined。
   */
  async function findSessionDuplicate(memory, { mode = "off", minSim = 0.92, windowHours = 24, source } = {}) {
    if (mode === "off" || !source || !memory?.title) return undefined;
    try {
      const sinceMs = windowHours > 0 ? Date.now() - windowHours * 3600000 : 0;
      const inWindow = (m) => {
        if (sinceMs <= 0) return true;
        const t = Date.parse(m.created_at ?? "");
        return !Number.isFinite(t) || t >= sinceMs; // 时间戳损坏时不误杀
      };
      const candidates = store
        .list({ type: memory.type, source, limit: 200 })
        .filter((m) => !m.archived && inWindow(m));
      if (!candidates.length) return undefined;

      if (mode === "title") {
        const norm = (s) => String(s ?? "").toLowerCase().replace(/[\s\p{P}]+/gu, "");
        const key = norm(memory.title);
        if (!key) return undefined;
        const hit = candidates.find((m) => norm(m.title) === key);
        return hit ? { action: "merged", memory: hit, sim: 1 } : undefined;
      }
      if (mode !== "vector") return undefined;

      const vecs = store.getEmbeddings(candidates.map((m) => m.id));
      if (!vecs.size) return undefined;
      const probe = await embedQuery([memory.title, memory.content].filter(Boolean).join("\n"));
      if (!probe) return undefined;
      let best;
      for (const m of candidates) {
        const v = vecs.get(m.id);
        if (!v) continue; // 无向量的既有行不参与比对（无信号 = 不判定）
        const sim = cosineVec(probe, v);
        if (sim >= minSim && (!best || sim > best.sim)) best = { action: "merged", memory: m, sim };
      }
      return best;
    } catch {
      return undefined; // 去重失败绝不阻塞写入
    }
  }

  /**
   * Save a memory, merging into an existing one when title matches within the same type.
   *
   * Bug5: a same-title merge no longer overwrites — the new content is appended
   * under a timestamped `---` separator (`旧内容\n\n---\n[时间戳] 新内容`) and the
   * previous content is archived into content_history (source: auto_merge, FIFO
   * capped at 20). importance takes the max of both (capped at 5). Callers that
   * truly replace a row (dream summary regeneration) pass `_overwrite: true` to
   * overwrite directly while still archiving the old version (source: overwrite).
   * mergeHumanEdits entry points pass `_humanEdited: true` — same direct
   * overwrite semantics, source: human_override.
   *
   * Bug7 (memory quality filter): when config.memoryQualityFilter.enabled, the
   * memory is scored after dedupe, before write:
   *   score >= degradeThreshold        → stored normally (score persisted)
   *   archiveThreshold <= score < 60   → persisted + ranked degraded
   *   score < archiveThreshold         → archived + tagged low_quality (still
   *                                      explicitly searchable via includeArchived)
   * @returns {{action: "created"|"merged", memory: object}}
   */
  function saveWithDedupe(memory) {
    // #230 写入权分离：document 行只能经 registerDocument 铸造（注册校验 +
    // doc_path + evidence 三样俱全）。通用保存路径（memory_save 工具 / MCP /
    // standalone API / bootstrap）一律拒绝——防止绕过注册校验造出无指针无
    // 回链的伪 document 行。与 updateMemory 的同款守卫构成双保险。
    if (memory?.type === "document") {
      throw new Error("type 'document' is minted only via registerDocument (summary + doc_path + evidence)");
    }
    // Bug7: score quality once (after dedupe lookup, before write). Failures
    // inside the evaluator are impossible (pure function), but the write that
    // records the score must never fail the save — wrap defensively.
    const qf = config.memoryQualityFilter;
    let quality = null;
    if (qf?.enabled === true) {
      try {
        const recentContents = store.all().slice(0, 20).map((m) => m.content ?? "");
        quality = evaluateMemoryQuality(memory, {
          minContentLength: qf.minContentLength ?? 10,
          recentContents
        });
      } catch { /* quality scoring is best-effort */ }
    }
    // dream 总览按 source 身份去重，而非本地化标题：memory.language 切换后
    // 标题变化，若仍按 (type, title) 匹配会出现两个活跃的 summary 同时注入。
    // 其余类型维持 (type, title) 匹配不变。
    const candidates = store.list({ type: memory.type, limit: 100 });
    // v0.8.0 A1（issue #17）：去重键由 (type, title) 扩展为
    // (type, title, agent_scope, workspace_scope, sensitivity)——不同作用域的同
    // 标题记忆绝不互相物理合并（旧逻辑跨 agent/workspace 并行，事后无法拆分）。
    // NULL 归一为「未标注」：未标注行之间互相匹配（含存量行），与已标注行不
    // 匹配。
    // v0.8.1（issue #170 复核项 1）：比较不再受 scopeEnabled 门控——显式声明
    // flag 关也生效（工具层明写「读了自动标注也生效」，去重必须同口径），否则
    // 关自动标注后同标题不同 scope 的行会物理合并进第一行的归属。存量全 NULL
    // 行互相匹配，A1 前行为不变。
    const scopeMatches = (m) =>
      scopeKeyOf(m.agent_scope) === scopeKeyOf(memory.agent_scope) &&
      scopeKeyOf(m.workspace_scope) === scopeKeyOf(memory.workspace_scope) &&
      scopeKeyOf(m.sensitivity) === scopeKeyOf(memory.sensitivity);
    // Issue #127：写入端语义去重命中时，调用方用 _mergeInto 指定并入目标——复用
    // 下面这段并入逻辑（appendContent + content_history + 质量处置），不另写第二份
    // 实现。目标已被并发删除时回落到常规匹配。显式目标同样过 scope 门：跨作用域
    // 的语义相似不并入（防泄漏），回落为独立新行。
    const explicitTarget = memory._mergeInto ? store.getById(memory._mergeInto) : undefined;
    const existing = explicitTarget
      ? (scopeMatches(explicitTarget) ? explicitTarget : undefined)
      : (memory.type === "summary" && memory.source === "dream")
        ? (candidates.find((m) => m.source === "dream" && scopeMatches(m))
          ?? candidates.find((m) => scopeMatches(m) && m.title.trim() === String(memory.title).trim()))
        : (memory.type === "summary" && memory.source === "narrative")
          // 叙述条（#164）按主题键去重而非本地化标题：标题随语言变
          // （叙述：X / Narrative: X），title 匹配在语言切换后会残留同 tag 双行。
          // tag 存于 tags[0]（generateNarratives 落库），跨语言稳定 → 原地刷新。
          ? (candidates.find((m) => m.source === "narrative" && m.tags?.[0] === memory.tags?.[0] && scopeMatches(m))
            ?? candidates.find((m) => scopeMatches(m) && m.title.trim() === String(memory.title).trim()))
        : candidates.find((m) => scopeMatches(m) && m.title.trim() === String(memory.title).trim());
    if (existing) {
      const newContent = String(memory.content ?? "");
      if (!newContent.trim()) {
        // Nothing to merge: the row stays untouched.
        return { action: "merged", memory: existing };
      }
      const direct = memory._overwrite === true || memory._humanEdited === true;
      const content = direct
        ? newContent
        : appendContent(existing.content, newContent);
      const importance = Math.min(5, Math.max(existing.importance, memory.importance ?? existing.importance));
      // v0.8.1 底座（issue #170）：去重命中=scope 值完全同键，此时显式写入把
      // 被并入行的同维来源升级为 explicit（用户刚刚显式声明了同一归属），
      // 并刷新 scope_decided_at。仅升级来源、不改值——值改变会走新行。
      const scopeUpgrade = {};
      if (memory.agent_scope_source === "explicit" && existing.agent_scope_source !== "explicit") {
        scopeUpgrade.agent_scope_source = "explicit";
      }
      if (memory.workspace_scope_source === "explicit" && existing.workspace_scope_source !== "explicit") {
        scopeUpgrade.workspace_scope_source = "explicit";
      }
      if (Object.keys(scopeUpgrade).length) scopeUpgrade.scope_decided_at = new Date().toISOString();
      const merged = store.update(existing.id, {
        content,
        importance,
        tags: memory.tags ?? existing.tags,
        title: memory.title ?? existing.title,
        ...(memory.evidence !== undefined ? { evidence: memory.evidence } : {}),
        content_history: pushContentHistory(existing, direct
          ? (memory._humanEdited === true ? "human_override" : "overwrite")
          : "auto_merge"),
        ...scopeUpgrade,
        ...(quality ? { quality_score: quality.score } : {})
      });
      // v0.8.1（issue #170 review 3）：来源升级也是归属性质改变——与
      // updateMemory 的显式修正同等待遇，落一行 scope_changes（actor=tool：
      // 只有 memory_save 的显式参数会带 explicit 来源走到这里）。审计失败只
      // warn 不反噬合并。升级只在来源首次变化时触发，不会每次并入都写。
      if (Object.keys(scopeUpgrade).length) {
        try {
          store.saveScopeChange({
            memory_id: existing.id,
            actor: "tool",
            prev_agent_scope: existing.agent_scope ?? null,
            prev_workspace_scope: existing.workspace_scope ?? null,
            next_agent_scope: merged.agent_scope ?? null,
            next_workspace_scope: merged.workspace_scope ?? null,
            agent_scope_source: merged.agent_scope_source ?? null,
            workspace_scope_source: merged.workspace_scope_source ?? null,
            decided_at: scopeUpgrade.scope_decided_at
          });
        } catch (e) {
          try { logger?.warn?.(`[dsh-mneme] scope upgrade audit failed: ${String(e)}`); } catch { /* 不反噬 */ }
        }
      }
      // Bug7: a degraded/archived result is applied on top of the merged row.
      const result = applyQualityDisposition(merged, quality, qf);
      afterSync("write");
      notifyWrite();
      scheduleEmbed(result);
      // #372: 合并分支此前不触发抽取——并入的新内容永远不进实体面，目标行若当初
      // 也是事务内创建的就彻底没有实体。saveAttr 按 (entity_id, attr_key) 先失活旧值
      // 再插入，重抽幂等（重抽同键只会刷新值，不堆重复行）。
      scheduleEntityExtraction(result);
      return { action: "merged", memory: result };
    }
    // #254 写入准入：决策形状由 write-admission.js 一次定死（阶段一定死、之后只加
    // 分支），这里只做两件事——先问决策，再在 enforce 命中时**在 store.save 之前**
    // 返回。放在 store.save 之前是这条闸门的意义所在：写进去再删等于没拦，而且中间
    // 那一瞬的注入/检索面已经暴露了。
    // 计量是旁路，拒绝不是：evaluate 抛异常按「不判定」处理（宁可漏拦也不能让判据
    // 故障把写入变成不可用），record 抛异常同样只 warn（审计失败不能反噬写入）。
    let admission = null;
    if (writeAdmission) {
      try {
        admission = writeAdmission.evaluate({ memory, sessionKey: memory._sessionKey });
      } catch (e) {
        try { logger?.warn?.(`[dsh-mneme] write admission evaluate failed: ${String(e)}`); } catch { /* 不反噬 */ }
      }
    }
    // 第 1 级硬拒（enforce 打开且判据命中）：这次写入不落库、不通知、不排嵌入、
    // 不抽实体。审计行仍然要落——拒绝面是这条闸门唯一可解释性的来源（验收第 2 条
    // 「被拒写入有审计与明确原因、可解释不静默丢弃」）。memoryId 传 null：这次写入
    // 没有产生任何行，related_memory_ids 必须空着，挂一个不存在的 id 就是造虚账。
    // reason 随返回值透出，工具层据此给模型一句可行动的拒绝理由。
    if (admission?.decision === "deny") {
      try {
        writeAdmission.record({
          sessionKey: memory._sessionKey,
          verdict: admission,
          memoryId: null
        });
      } catch (e) {
        try { logger?.warn?.(`[dsh-mneme] write admission record failed: ${String(e)}`); } catch { /* 不反噬 */ }
      }
      return { action: "denied", reason: admission.deny?.reason ?? "denied", deny: admission.deny ?? null, memory: null };
    }
    const created = store.save({
      type: memory.type,
      title: memory.title,
      content: memory.content,
      tags: memory.tags ?? [],
      importance: memory.importance ?? 3,
      source: memory.source ?? "manual",
      // epistemic_status 必须显式透传：省略时 store 会回退到内容标记推断
      // （中文正则），英文/无标记内容一律落 subjective——E2 四臂实验当场抓到
      // （trustEpistemicWeighting 的重排对 saveWithDedupe 写入的记忆整体空转，
      // R+ 臂与 A 臂注入序逐条相同）。undefined 保持推断行为，显式值优先。
      epistemic_status: memory.epistemic_status,
      ...(memory.evidence !== undefined ? { evidence: memory.evidence } : {}),
      // v0.8.0 A1：scope 标注透传（store 端归一化，未标注落 NULL）。
      // v0.8.1 底座：来源（auto/explicit）与决策时间随行透传。
      agent_scope: memory.agent_scope,
      workspace_scope: memory.workspace_scope,
      agent_scope_source: memory.agent_scope_source,
      workspace_scope_source: memory.workspace_scope_source,
      scope_decided_at: memory.scope_decided_at,
      sensitivity: memory.sensitivity,
      occurred_at: memory.occurred_at,
      ...(quality ? { quality_score: quality.score } : {})
    });
    const result = applyQualityDisposition(created, quality, qf);
    if (admission) {
      try {
        writeAdmission.record({
          sessionKey: memory._sessionKey,
          verdict: admission,
          memoryId: created.id
        });
      } catch (e) {
        try { logger?.warn?.(`[dsh-mneme] write admission record failed: ${String(e)}`); } catch { /* 不反噬 */ }
      }
    }
    afterSync("write");
    notifyWrite();
    scheduleEmbed(result);
    scheduleEntityExtraction(result);
    return { action: "created", memory: result };
  }

  /**
   * Bug7: apply the quality verdict to a freshly written row. Below the archive
   * threshold the memory is archived + tagged low_quality (still searchable
   * explicitly via includeArchived); between archive and degrade thresholds the
   * score is already persisted and only the injection ranking is affected
   * (importance × score/100). Best-effort: a disposition write failure must
   * never fail the save. Returns the (possibly refreshed) memory row so callers
   * see the archived/tagged state, not the pre-disposition snapshot.
   *
   * Issue #135 附属发现 1：importance ≥ memoryQualityFilter.exemptImportance
   * （默认 4）的记忆不参与静默自动归档——评分与信号标签照常写入（可观测），
   * 注入排序照常按 importance × score/100 降权，但 setArchived 跳过。报告实测
   * 150 条低分归档里 128 条 importance ≥ 4（51 条 = 5）：一条被显式标为重要的
   * 记忆不该被规则分静默归档、无感知无豁免。
   */
  function applyQualityDisposition(memory, quality, qf) {
    if (!quality || qf?.enabled !== true) return memory;
    const archiveThreshold = qf.archiveThreshold ?? 30;
    // Signal tags (meta / repetitive / duplicate / short_content / low_quality)
    // are merged onto the stored row in every assessed band so the verdict is
    // observable, not just the numeric score. Below the archive threshold the
    // memory is additionally archived (still explicitly searchable) — unless
    // its importance reaches the exemption floor (kept active, demoted only).
    const tags = [...new Set([...(memory.tags ?? []), ...(quality.tags ?? [])])];
    const exemptImportance = qf.exemptImportance ?? 4;
    const importanceExempt = Number.isInteger(memory.importance) && memory.importance >= exemptImportance;
    if (tags.length === (memory.tags?.length ?? 0) && (quality.score >= archiveThreshold || importanceExempt)) {
      return memory; // no tag drift and not archived → nothing extra to write
    }
    try {
      store.update(memory.id, { tags, quality_score: quality.score });
      if (quality.score < archiveThreshold && !importanceExempt) {
        store.setArchived(memory.id, true);
      } else if (quality.score < archiveThreshold) {
        logger?.info?.(`[dsh-mneme] quality filter: memory ${memory.id} scored ${quality.score} < ${archiveThreshold} but importance ${memory.importance} >= exemptImportance ${exemptImportance}; demoted, not archived`);
      }
      return store.getById(memory.id);
    } catch {
      return memory;
    }
  }

  /**
   * Candidate memories for automatic context injection:
   * summaries first, then all preferences, then non-forgotten items with
   * importance >= threshold. History is never auto-injected. Archived entries
   * are excluded (store.list already filters them by default; the extra
   * !m.archived check is kept as double insurance).
   *
   * Bug4 (hybridInject): when a non-empty `query` is available and a matching
   * semantic recall was cached by the last searchMemories, the vector hits
   * lead the selection (up to maxItems*2 candidates) and the rule-based pick
   * fills + dedupes the remaining slots. Empty query / no cached recall /
   * hybridInject off → pure legacy rule-based selection.
   *
   * #249 第一批（B1 pin 池）：`pinnedInjectBudget` > 0 时，约束/偏好类先按相关性
   * 取满独立预算、再从候选里摘除（于是轮换重排碰不到它们），由调用方前置到块
   * 头。`pinnedStats` 是可选出参：回报实际 pin 条数与超预算未展示条数，不改变
   * 本函数「返回数组」的既有契约。预算为 0 时整段不执行，行为逐字节不变。
   *
   * Issue #380（preInjectGate）：可选的 `gate` 在这里消费——判定与滤除必须发生在
   * `touchRecalled` **之前**（与 strictScope 同纪律，见 :419-422 的注释：闸门放
   * 在记账之后，出局的条目照样吃了曝光）。`gateStats` 是可选出参，回报本帧的闸门
   * 状态给调用方做面板快照；`gate` 缺席（检索侧/独立服务调用）时逐字节等于改前。
   */
  function injectCandidates({ query = "", maxItems = 5, threshold = 3, queryVector, scope = null, rotate = null, rotateWindow = 0, pinnedStats = null, gate = null, gateStats = null } = {}) {
    const q = String(query ?? "").trim();
    // codingRetrospect 读取侧门控：编码记忆（rejected_solution / pitfall /
    // constraint）只在编码任务时注入，防噪声污染其他业务；编码任务时按
    // codingBoostFactor 加权，让编码记忆在编码场景更靠前。
    const isCoding = isCodingTask(q, config.codingKeywords ?? []);
    const codingGate = (m) => isCoding || !CODING_MEMORY_TYPES.has(m.type);
    // Bug7: quality-weighted importance in the rule-based tier. Unassessed rows
    // (quality_score null) count as 100 (weight 1), so legacy stores keep their
    // exact summary>preference>importance ordering.
    const qualityWeight = (m) => (m.quality_score != null ? m.quality_score / 100 : 1);
    // Issue #205 补测：候选池必须比轮换窗口大——窗口 N 需要 maxItems×(N+1) 张
    // 不同的牌，池子只有 maxItems×2 时窗口一开就被吃光、只剩回填（重复率的
    // 结构性下限由池子大小决定）。无轮换时保持既有 maxItems×2 不变；规则路
    // 的 200 条上限同样给轮换让路（上限翻倍也只是多读一次 SQL LIMIT）。
    const rotateWindowN = Number.isInteger(rotateWindow) && rotateWindow > 0 ? rotateWindow : 0;
    const poolSize = rotateWindowN > 0
      ? Math.max(maxItems * 2, maxItems * (rotateWindowN + 1))
      : maxItems * 2;
    // #230 拍板：注入档位合并设计（叙述条次优先档 + document 摘要行预算）。
    // ①叙述条（source=narrative）从纯按需解禁进注入候选，落次优先档——但受
    // 生成总闸 dreamNarrativeEnabled 约束（flag 关 = 该类行不再注入，存量行
    // 仍可检索）；②document 摘要行同落次优先档，另有独立预算（见下方选取）。
    const injectTypes = config?.documentMemoryEnabled === true ? INJECT_TYPES_WITH_DOCUMENT : INJECT_TYPES;
    // #230 拍板：叙述条解禁进注入受生成总闸约束——门必须对全部候选路径一致
    // （规则/向量/缓存/BM25），只锁规则路的话语义路仍会漏进 narrative 行。
    const allowNarrative = config?.dreamNarrativeEnabled === true;
    const filtered = store.list({ limit: Math.max(200, poolSize), includeForgotten: false })
      .filter((m) => !m.archived && injectTypes.has(m.type) && !m.forgotten &&
        // 叙述条：#228 落地为纯按需检索；#230 合并拍板解禁为次优先档注入
        // （per-topic 叙述常驻位仍只留给 dream 总览 source=dream）。
        (m.source !== "narrative" || allowNarrative) &&
        codingGate(m) &&
        (m.type === "summary" || m.type === "preference" || m.importance >= threshold));
    // #218 v1: heat 乘数——heatEnabled 时在优先级层内给 importance×quality 乘
    // heat（同级内的乘数；priority 分层、store 的 order=chrono 分页序与召回融
    // 合序都不动）。heat 关闭时不建表、不算 heat，权重恒 1，排序与改动前一致。
    // selectiveInject 相似度重排（下方）开启且向量可用时相似度优先——heat 只
    // 生效于规则路排序与语义路回填序。
    // issue #218 / E5 效用考卷：heat 乘进注入排序在真实年龄混合下饿死老约束
    // （现行量级 ≡ 拟合参数，importance-only 遵从 +12.7pp），故注入侧 heat 拆出
    // 独立开关 injectHeatEnabled（默认关）：不开时权重恒 1，排序与 heat 关闭
    // 逐字节一致；召回侧时钟（touchLastAccess）与 sleep 降级联判不受影响。
    const heatMap = config?.heatEnabled === true && config?.injectHeatEnabled === true
      ? new Map(filtered.map((m) => [m.id, computeHeat(m, Date.now(), config)]))
      : null;
    const heatOf = (m) => (heatMap ? heatMap.get(m.id) ?? 1 : 1);
    // v0.8.x（issue #339 / E7 实测）：A2 软加权补齐到注入通道。此前 ×0.5/×1.25
    // 只作用于 searchMemories——E7 考卷里「explicit 标注 + 软档」的注入集与无标注
    // 逐条相同（80/80），主泄露面上软档形同虚设。门控与检索侧同款：scopeEnabled
    // 且当前会话至少一维可解析；strictScope 硬过滤在下方先行，硬墙开启时被滤行
    // 不会到这里被二次降权。未激活时乘 1，排序与改动前逐字节一致。
    const softScopeActive = config?.scopeEnabled === true && scope != null &&
      Boolean(scope.agent_scope || scope.workspace_scope);
    const scopeMultOf = (m) => (softScopeActive ? scopeMultiplier(m, scope) : 1);
    const items = filtered.sort((a, b) => {
        // 编码记忆在编码任务时优先于普通 decision（与 preference 同级），
        // importance 乘 codingBoostFactor 加权（封顶 5，保持 importance 语义）。
        const priority = (m) => {
          // #230：叙述条与 document 摘要行同为次优先档——蒸馏摘要（0）仍最
          // 先，指针型聚合产物（1）先于普通 project/decision（2）。叙述条是
          // type=summary，判 source 必须在判 type 之前。
          if (m.source === "narrative") return 1;
          if (m.type === "summary") return 0;
          if (m.type === "preference") return 1;
          if (m.type === "document") return 1;
          if (isCoding && CODING_MEMORY_TYPES.has(m.type)) return 1;
          return 2;
        };
        const effImportance = (m) =>
          (isCoding && CODING_MEMORY_TYPES.has(m.type))
            ? Math.min(5, m.importance * (config.codingBoostFactor ?? 2))
            : m.importance;
        const pa = priority(a);
        const pb = priority(b);
        // 软加权乘在层内数值积上（priority 档位不动）：foreign ×0.5 后压不过
        // 同档自己行——E7 的同 importance 档设计正是这个场景。
        return pa - pb ||
          (effImportance(b) * qualityWeight(b) * heatOf(b) * scopeMultOf(b)) -
          (effImportance(a) * qualityWeight(a) * heatOf(a) * scopeMultOf(a));
      });
    let candidates = items;
    if (config.hybridInject !== false && q) {
      // Bug4: semantic-first recall. Vector hits (queryVector, cached by the
      // injector's async prefetch) lead when present; otherwise the last
      // searchMemories recall for the exact same query is reused. Rule-based
      // items fill + dedupe the remaining slots. Empty query / no vector /
      // no cached recall → pure legacy rule-based selection.
      const semanticItems = [];
      if (Array.isArray(queryVector) && queryVector.length && vectorIndex) {
        try {
          const hits = vectorIndex.search(queryVector, { limit: poolSize, threshold: 0 });
          for (const m of hits) {
            if (m && !m.archived && injectTypes.has(m.type) && !m.forgotten &&
              (m.source !== "narrative" || allowNarrative) &&
              codingGate(m) &&
              (m.type === "summary" || m.type === "preference" || m.importance >= threshold)) {
              semanticItems.push(m);
            }
          }
        } catch { /* vector unavailable: fall through to the recall cache */ }
      }
      if (!semanticItems.length && lastSemanticRecall?.query === q && lastSemanticRecall.items?.length) {
        for (const m of lastSemanticRecall.items) {
          if (m && !m.archived && injectTypes.has(m.type) && !m.forgotten &&
            (m.source !== "narrative" || allowNarrative) && codingGate(m)) semanticItems.push(m);
        }
      }
      // Issue #198：首轮（无向量、无缓存召回）的同步兜底——BM25 词法召回领位。
      // 注入渲染是同步的（宿主 systemPrompt 的 contexts 不支持异步 text），
      // 查询向量只能异步 prefetch 给下一轮，首轮必 miss；此时纯静态排序会让
      // 老的高重要性 summary/preference 占满槽位，当前话题的 decision/project
      // 进不来。查询文本本身就在手上，BM25 是纯进程内同步计算，词法相关性
      // 足以把当前话题顶到前排；门控与向量路径一致（含 importance 阈值）。
      // 语义向量命中时本分支不参与，行为不变。
      if (!semanticItems.length) {
        for (const hit of bm25Recall(q, poolSize)) {
          if (hit && !hit.archived && injectTypes.has(hit.type) && !hit.forgotten &&
            (hit.source !== "narrative" || allowNarrative) &&
            codingGate(hit) &&
            (hit.type === "summary" || hit.type === "preference" || hit.importance >= threshold)) {
            semanticItems.push(hit);
          }
        }
        // issue #339（CodeRabbit review on #350）：首轮 BM25 兜底领跑合并池，
        // 而 selectiveInject 相似度重排要等查询向量就绪才执行——软加权必须
        // 在这里就位，否则 foreign 命中绕过降权直接占注入位。
        if (softScopeActive) {
          semanticItems.sort((a, b) =>
            (b.score ?? 0) * scopeMultOf(b) - (a.score ?? 0) * scopeMultOf(a));
        }
      }
      if (semanticItems.length) {
        const seen = new Set();
        const merged = [];
        const push = (m) => {
          if (seen.has(m.id)) return;
          seen.add(m.id);
          merged.push(m);
        };
        for (const m of semanticItems) {
          push(m);
          if (merged.length >= poolSize) break;
        }
        for (const m of items) {
          if (merged.length >= poolSize) break;
          push(m);
        }
        candidates = merged;
      }
    }
    // Topic-ranked selection (v0.5.0 2.2): when the current query's vector is
    // available the whole candidate list is re-ordered by similarity to that
    // vector, so the injected slots go to memories on the current topic
    // rather than to the rule-based order. Rows the index did not return
    // keep their relative order after the scored ones.
    if (config?.selectiveInjectEnabled !== false && Array.isArray(queryVector) && queryVector.length && vectorIndex) {
      try {
        const hits = vectorIndex.search(queryVector, { limit: 200, threshold: 0 });
        const sim = new Map(hits.map((m) => [m.id, m.score ?? 0]));
        if (sim.size) {
          // 软加权作用在真实 sim 上；未命中的规则候选保持 -1 沉底（缺失项
          // 乘乘数会让 foreign 缺失项反而排到自己的缺失项之上，故不乘）。
          const scopedSim = (m) => {
            const s = sim.get(m.id);
            return s === undefined ? -1 : s * scopeMultOf(m);
          };
          candidates = [...candidates].sort((a, b) => scopedSim(b) - scopedSim(a));
        }
      } catch { /* topic re-rank unavailable: keep rule-based order */ }
    }
    // #24 块3：图召回候选打标。entityRecall 只在 entityRecallEnabled 开启时
    // 有产出，这里为命中者贴 graphHint 标签——注入侧据此（a）graphInjectHint
    // 开=标成 [检索线索] 前缀的线索行（独立预算），（b）关=线索行只参与排序
    // 不改变注入块（保守档）。与检索侧共用同一图闸：块1 #341 把 entityRecall
    // 升级成级联后，注入侧自动吃到同样的扩散信号，无需再改。只在语义/规则候选
    // 为空时兜底检索，避免注入路径双倍候选成本。
    if (config?.entityRecallEnabled === true && q) {
      try {
        const graphHits = entityRecall(q, maxItems * 2);
        if (graphHits.length) {
          const graphIds = new Set(graphHits.map((m) => m.id));
          candidates = [
            ...candidates.map((m) => graphIds.has(m.id) ? { ...m, graphHint: true } : m),
            ...graphHits
              .filter((m) => !candidates.some((c) => c.id === m.id))
              .map((m) => ({ ...m, graphHint: true }))
          ];
        }
      } catch { /* graph hint is best-effort */ }
    }
    // v0.8.0 A3（issue #17）：strictScope 硬过滤同样作用于自动注入——scoped 记忆
    // 泄进无关注入上下文是最典型的越权通道，检索侧过滤挡不住这里。
    // 位置纪律：必须在**图召回合并之后**、pin 池之前——entityRecall 不做 scope
    // 门控，过滤放在它前面时，出局行会被图召回重新打上 graphHint 带回候选池
    // （graphInjectHint 开时作为线索行进注入块；CodeRabbit on #371 的可达性分析，
    // /context 与宿主注入同受影响）。pin 池 eligible 取自本过滤之后的候选，
    // 顺带保证越权行进不了 pin。
    if (config?.strictScope === true && scope) {
      candidates = candidates.filter((m) => isVisibleInScope(m, scope));
    }
    // #249 第一批：B1 pin 池。取在相关性排序之后、轮换之前——取谁按此刻的候选
    // 次序（即相关性次序），取到后从候选中摘除，于是下面的轮换重排碰不到它们
    // （验收：pin 不参与跨轮轮换）。独立预算的两层意义：pin 既不占 maxItems
    // 名额、也不被 document 预算截断，因此不会把当前任务需要的情景候选挤出去；
    // 超预算的条数回报给调用方，在块内如实标注（绝不静默省略）。
    const pinnedBudget = Math.max(0, Math.min(5, Math.floor(config?.pinnedInjectBudget ?? 0)));
    // eligible 留到块外：未展示条数要等 general 槽选完才算得准（见 selected 之后）。
    // graphHint 行不进 pin 池：pin 是「每轮必进的约束/偏好」，而线索行按定义是
    // 「链路信息、非事实断言」，且 pin 长在候选池遍历之前——不排除的话，保守档
    // （graphInjectHint 关）也能从 pin 侧把它放回注入块，线索开关就被绕过去了。
    const eligible = pinnedBudget > 0 ? candidates.filter((m) => PINNED_MEMORY_TYPES.has(m.type) && m.graphHint !== true) : [];
    let pinned = [];
    if (pinnedBudget > 0 && eligible.length > 0) {
      pinned = eligible.slice(0, pinnedBudget);
      const pinnedIds = new Set(pinned.map((m) => m.id));
      candidates = candidates.filter((m) => !pinnedIds.has(m.id));
    }
    // Issue #205：注入位跨轮轮换。rotate = 最近 N 轮注入过的 id 集合（由注入层
    // 按会话维护并传入）：这些条目本轮不再优先——新鲜者前置（各自内部相对次序
    // 保持），不足时按原序回填，槽位数与 touchRecall 语义均不变。rotate 为空时
    // 行为与既有排序完全一致。
    if (rotate && rotate.size > 0 && candidates.length > 0) {
      const fresh = candidates.filter((m) => !rotate.has(m.id));
      if (fresh.length > 0) candidates = [...fresh, ...candidates.filter((m) => rotate.has(m.id))];
    }
    // #230 拍板：document 摘要行预算——次优先档内最多 documentInjectBudget
    // 条，超预算的 document 行跳过、由后续候选补位（不占槽）。预算只约束
    // 注入不约束检索：指针行价值在「按需读全文」，常驻注入若不设界就会把
    // 注入块变成文档目录（#164 失败判据：批量把历史塞进上下文）。
    const documentBudget = config?.documentInjectBudget ?? 2;
    let documentSeen = 0;
    // #24 块3：图线索行（graphHint）按独立预算 graphInjectBudget 进块；所谓
    // 独立=既不受 document 预算约束、也不挤占 maxItems 槽位。graphInjectHint
    // 关（默认保守档）时线索行**不进注入块**——它们只参与候选池排序（对融合无
    // 影响，因为候选池生成的唯一用途就是注入），桥接信号不污染常驻文本；开时
    // 才作为 [检索线索] 前缀行进入。与 document/pin 同构：预算只约束注入。
    const hintOpen = config?.graphInjectHint === true;
    let graphSeen = 0;
    const graphBudget = hintOpen ? Math.max(0, Math.floor(config?.graphInjectBudget ?? 1)) : 0;
    const general = [];
    for (const m of candidates) {
      if (m.graphHint === true) {
        if (!hintOpen) continue;      // 保守档：线索只排序不进块
        if (graphSeen >= graphBudget) continue; // 独立预算内放行
        graphSeen++;
      } else if (general.length >= maxItems) {
        break; // 普通候选受 maxItems 槽位上界
      }
      if (m.type === "document") {
        if (documentSeen >= documentBudget) continue;
        documentSeen++;
      }
      general.push(m);
    }
    // #249 第一批：pin 前置到块内相关性排序之前（验收项），且不占 maxItems 名额。
    // pinned 为空时 selected 就是 general 本身——关闭态与改动前逐字节一致。
    const selected = pinned.length > 0 ? [...pinned, ...general] : general;
    if (pinnedStats) {
      // 「未展示」只数**真的没进块**的 pin 类条目：被 pin 预算挤下来的条目会回到
      // 候选池，仍可能被 general 槽选中——那就是展示了。按 eligible - pinned 直接
      // 相减会把它们也算成未展示，块头那一行于是虚报（评审实测：pref#2 已在块内，
      // 仍报「另有 2 条未展示」）。所以统一按「有没有进 selected」判。
      const shownIds = new Set(selected.map((m) => m.id));
      pinnedStats.shown = pinned.length;
      pinnedStats.suppressed = eligible.filter((m) => !shownIds.has(m.id)).length;
    }
    // Issue #380：注入前判定（preInjectGate）在这里消费——**必须在 touchRecalled
    // 之前**，与 strictScope 同纪律（见本文件 :419-422 的注释：闸门放在记账之后，
    // 出局的条目照样吃了曝光）。滤除若留给调用方（inject.js）做，被标记的记忆仍会
    // 刷温时钟（heat + injectHeat 时进排序权重）并落 mode='inject' 曝光账，反馈环
    // 会把闸门想压下的意见记忆重新顶上来。判定与过滤只作用于一般记忆槽：pin 池
    // （#249 逐字保真）与 graphHint 线索行豁免（豁免在下面 judgedPart 的切片里）。
    // 帧状态经 gateStats 出参回给调用方做面板快照（同 pinnedStats 口径，不动
    // 「返回数组」契约）；gate 缺席（检索侧/独立服务调用）= 逐字节等于改前。
    let injected = selected;
    if (gate) {
      const judgedPart = selected.filter((m, i) => i >= pinned.length && m.graphHint !== true);
      const gateFrame = gate.forFrame(query, judgedPart);
      if (gateFrame?.state === "filtered" && gateFrame.flaggedIds) {
        injected = selected.filter((m) => !gateFrame.flaggedIds.has(m.id));
      }
      if (gateStats) gateStats.frame = { ...gateFrame, judged: judgedPart.length };
    }
    touchRecalled(injected);
    // #217 口径（2026-09-19 拍板）：注入是曝光型访问事件，与检索命中同表分账
    // （mode='inject'，candidates 存实际注入集）。跟随 recallRecordDefault——
    // 与检索侧同门，不设新配置键；heat 关闭时照写，留痕与消费解耦（两 issue
    // 独立验收）。空选不记（没有访问发生）；记账失败不影响注入本身。**实际注入集**
    // = 闸门滤除之后的集合（#380 评审：被滤掉的记忆没有曝光，不能记成已注入）。
    if ((config?.recallRecordDefault ?? true) && recallRecorder && injected.length > 0) {
      try {
        recallRecorder({
          // recall_runs.query 是 NOT NULL（store.js:61）：注入是主动曝光、
          // 没有查询词，用空串而非 null——SQLite 改列约束需重建表，不值得。
          query: "",
          mode: "inject",
          topK: maxItems,
          threshold: null,
          candidates: injected.map((m) => ({
            id: m.id,
            title: m.title,
            content: m.content,
            score: m.score ?? null,
            source: m.source ?? "keyword"
          })),
          createdAt: new Date().toISOString()
        });
      } catch { /* recall receipt is best effort */ }
    }
    return injected;
  }

  /**
   * Merge human edits parsed from a mirror file back into the store.
   * Only content/title are taken; structure fields stay machine-owned.
   */
  function mergeHumanEdits(type, edits) {
    // #296：只读 type 的结构性守卫。调用点（启动合并 / reconcileHumanEdits）都已
    // 跳过它们，但这条不变量属于「人改回填」本身——将来多一个调用点不该重开这个口
    // （指针行文本被当正文写回 document 行会污染摘要）。
    if (MIRROR_READONLY_TYPES.has(type)) return 0;
    let applied = 0;
    for (const edit of edits) {
      if (!edit.id) continue; // corrupt/malformed edit: skip it, keep merging the rest
      const existing = store.getById(edit.id);
      if (!existing || existing.type !== type) continue;
      const patch = {};
      if (typeof edit.title === "string" && edit.title.trim()) patch.title = edit.title.trim();
      if (typeof edit.content === "string" && edit.content.trim()) patch.content = edit.content.trim();
      if (Object.keys(patch).length) {
        // 启动回灌（F-NEW-01）：digest 存在且匹配 = 文件自渲染后无人触碰（旧机器
        // 镜像），机器 wins，DB 的 New 必须保留，静默改回 Old 是 bug。
        const digestMatches = typeof edit.digest === "string"
          && typeof edit.title === "string"
          && typeof edit.content === "string"
          && createHash("sha256").update(`${edit.title}\x00${edit.content}`).digest("hex") === edit.digest;
        if (digestMatches) continue;
        // 文件 == store（无实际变化）时不覆盖，也不计入 applied。
        const hasDiff = (patch.title !== undefined && existing.title !== patch.title)
          || (patch.content !== undefined && existing.content !== patch.content);
        if (!hasDiff) continue;
        // 人工编辑回灌后触发 re-embed（issue #3 残留修复）：向量必须与
        // 新 title/content 一致。scheduleEmbed 为 fire-and-forget，
        // 内部 try/catch 吞错，失败不影响主流程。
        // Bug5: human edits overwrite directly, but the machine version is
        // archived into content_history (source: human_override) before being
        // replaced, so a manual correction never silently destroys the old value.
        const merged = store.update(edit.id, {
          ...patch,
          content_history: patch.content !== undefined && existing.content !== patch.content
            ? pushContentHistory(existing, "human_override")
            : existing.content_history
        });
        applied++;
        scheduleEmbed(merged);
      }
    }
    if (applied) {
      afterSync("write");
      notifyWrite();
    }
    return applied;
  }

  /**
   * v0.8.0 冲突集中处理（issue 反馈：冻结冲突没有人工出口——store 的
   * resolveConflictPending 此前无任何 API/UI 调用）。人工确认一条待审冲突：
   * 盖章 resolved_at/resolved_winner（审计），可选按 dream 非冻结 conflict
   * 路径**同款**处置落地——复用 applyDecisions 的 conflict 分支，CAS 快照 +
   * 事务 + 胜者追加已否决注记 + 败者归档 + 幂等全部同源，不另写第二份裁决。
   *
   * @param {string} id conflict_pending 行 id
   * @param {{winner?: "a"|"b"|null, apply?: boolean}} opts
   *   winner: 选哪一方保留（a = memory_a，冻结时 LLM 的建议胜者；b = memory_b）；
   *   null = 仅盖章标记已读、不落地处置。人工选择是权威裁决：传入
   *   applyDecisions 的 config 关掉 trustEpistemicWeighting——可信度自动换位
   *   只应作用于 LLM 提议对，不能推翻人工选择。
   * @returns {object|undefined} 盖章后的冲突行 + disposition 摘要；未知 id 返回 undefined
   */
  function resolveConflictPending(id, { winner = null, apply = true } = {}) {
    const rows = store.listConflictPending({ includeResolved: true, limit: 500 });
    const row = rows.find((r) => r.id === id);
    if (!row) return undefined;
    const winnerId = winner === "a" ? row.memory_a : winner === "b" ? row.memory_b : null;
    const loserId = winner === "a" ? row.memory_b : winner === "b" ? row.memory_a : null;
    let disposition = null;
    if (apply && winnerId && loserId) {
      const snapshot = new Map();
      for (const m of [store.getById(row.memory_a), store.getById(row.memory_b)]) {
        if (m) snapshot.set(m.id, { updated_at: m.updated_at, content: m.content, title: m.title });
      }
      // applyDecisions 需要一个 service 形状的参数（getById/update/setArchived/
      // transaction）——委托给闭包内的同名实现，mirror/通知/嵌入与主写路径同源。
      const applyService = {
        getById: (mid) => store.getById(mid),
        update: (mid, patch) => updateMemory(mid, patch),
        setArchived: (mid, v) => archiveMemory(mid, v),
        transaction: (fn) => transaction(fn)
      };
      const { committed, failures } = applyDecisions(
        [{ action: "conflict", winner: winnerId, loser: loserId, reason: row.reason ?? "" }],
        applyService,
        logger,
        snapshot,
        { ...config, trustEpistemicWeighting: false }
      );
      // Review 发现：处置必须**先于**盖章。原实现先 resolveConflictPending 盖章、
      // 再 applyDecisions——若 CAS 拒掉（确认前双方被并发更新），行已 resolved 从
      // 队列消失、前端仍显示成功，审计却记了"已确认"且无法重试。现在失败时不盖章
      // 直接返回：行留在队列待重试，审计不被污染。
      if (failures.length) {
        return { ...row, disposition: { ok: false, failures } };
      }
      disposition = { ok: true, committed };
    }
    // 处置成功（或纯标记）后才盖章。幂等重放（败者已归档 → skipped）也走这里：
    // 处置本就存在，标记已审即可。
    const stamped = store.resolveConflictPending(id, { winner: winnerId });
    if (!stamped) return undefined;
    return { ...stamped, disposition };
  }

  /**
   * v0.8.0 冲突队列视图数据源：未解决冲突行，联表带出双方的当前状态（标题/
   * 内容/类型/重要性/归档标记），面板一处即可集中审阅，不必按徽章逐条找。
   * 参与记忆被删除/失联时该侧返回 {missing: true}（队列不因此丢行）。
   */
  function listConflictQueue({ limit = 50, offset = 0 } = {}) {
    const rows = store.listConflictPending({ limit, offset, includeResolved: false });
    const side = (id) => {
      const m = store.getById(id);
      if (!m) return { id, missing: true };
      return {
        id,
        title: m.title,
        type: m.type,
        importance: m.importance,
        content: m.content,
        // 裁决依据：两侧的新旧与重要度是「该留哪条」的客观信号。此前 side() 不带
        // 时间戳，面板只能显示 A 方/B 方两个标签，用户没有依据就整对删掉或乱选
        // （面板冲突裁决窗可读性报障）。
        created_at: m.created_at ?? null,
        updated_at: m.updated_at ?? null,
        archived: m.archived === true,
        forgotten: m.forgotten === true
      };
    };
    return rows.map((r) => ({
      id: r.id,
      run_id: r.run_id ?? null,
      reason: r.reason ?? null,
      created_at: r.created_at,
      memory_a: side(r.memory_a),
      memory_b: side(r.memory_b)
    }));
  }

  function toApiList(rows) {
    return rows.map((m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      content: m.content,
      tags: m.tags,
      importance: m.importance,
      source: m.source,
      created_at: m.created_at,
      updated_at: m.updated_at,
      // v0.8.0 A2：scope 标注与事件发生时间透出——条件展开（未标注行不带键，
      // DTO 与 A2 前逐字节同形；带 undefined 键会被 in-process schema 校验
      // 判违规，JSON 序列化虽会丢弃但形状不稳定）。
      // v0.8.1 底座：scope 来源与决策时间随行透出（同样条件展开）。
      ...(m.agent_scope !== undefined ? { agent_scope: m.agent_scope } : {}),
      ...(m.workspace_scope !== undefined ? { workspace_scope: m.workspace_scope } : {}),
      ...(m.agent_scope_source !== undefined ? { agent_scope_source: m.agent_scope_source } : {}),
      ...(m.workspace_scope_source !== undefined ? { workspace_scope_source: m.workspace_scope_source } : {}),
      ...(m.scope_decided_at !== undefined ? { scope_decided_at: m.scope_decided_at } : {}),
      ...(m.sensitivity !== undefined ? { sensitivity: m.sensitivity } : {}),
      ...(m.occurred_at !== undefined ? { occurred_at: m.occurred_at } : {}),
      // #230：document 指针行的文件定位随行透出——「全文按需读」的入口就是
      // 这个路径；普通行恒不带键，DTO 与 #230 前逐字节同形。
      ...(m.doc_path !== undefined && m.doc_path !== null ? { doc_path: m.doc_path } : {})
    }));
  }

  /**
   * Three-way merge of in-flight human mirror edits before a re-render.
   * Runs on every syncMirror, so a human edit made between two store writes is
   * never silently overwritten by the next sync (human priority is not limited
   * to startup). Per edited entry:
   *   - file changed only → human wins; the edit is merged back into the store.
   *   - file AND store changed → real three-way conflict: keep the human edit
   *     and append a marker preserving the store's concurrent version, so no
   *     side is dropped.
   *   - store changed only → store wins (the file is simply re-rendered).
   * Only title/content are taken (structure fields stay machine-owned, matching
   * mergeHumanEdits). Returns the memory list to render.
   */
  function reconcileHumanEdits(memories) {
    if (!mirror) return memories;
    const byType = new Map();
    for (const m of memories) {
      if (!byType.has(m.type)) byType.set(m.type, []);
      byType.get(m.type).push(m);
    }
    const result = [];
    for (const type of Object.keys(TYPE_FILE)) {
      const list = byType.get(type) ?? [];
      if (list.length === 0) continue;
      const editsById = new Map(mirror.readHumanEdits(type).map((e) => [e.id, e]));
      for (const m of list) {
        const edit = editsById.get(m.id);
        if (!edit) { result.push(m); continue; }
        const humanChanged = (typeof edit.title === "string" && edit.title !== m.title)
          || (typeof edit.content === "string" && edit.content !== m.content);
        if (!humanChanged) { result.push(m); continue; }
        // 判断文件是否被人工动过：digest 存在且匹配则无人触碰，否则视为人工动过。
        // digest 是渲染时对 sha256(title \x00 content) 的记录；机器 store 更新后
        // 镜像还没重渲染时读到旧内容，digest 仍匹配 → 机器 wins，不会误判为
        // 并发人工编辑导致机器写丢失 + 伪冲突标记。
        const digestMatches = typeof edit.digest === "string"
          && typeof edit.title === "string"
          && typeof edit.content === "string"
          && createHash("sha256").update(`${edit.title}\x00${edit.content}`).digest("hex") === edit.digest;
        if (digestMatches) {
          // 无人触碰，机器 wins，走原样
          result.push(m);
          continue;
        }
        // 人工动过（digest 不存在=老文件/手工文件保守视为人工动过），走三方合并
        // （保留现有 storeChanged 逻辑）
        const storeChanged = edit.updated_at !== undefined && m.updated_at !== edit.updated_at;
        if (storeChanged) {
          // 三方合并保留双方时的冲突批注：随实例语言，写进记忆正文。
          const marker = STR.serviceConflictMarker[language](m.updated_at, m.content);
          store.update(m.id, { title: edit.title, content: `${edit.content}${marker}` });
        } else {
          store.update(m.id, { title: edit.title, content: edit.content });
        }
        const merged = store.getById(m.id);
        scheduleEmbed(merged);
        result.push(merged);
      }
    }
    return result;
  }

  /**
   * Re-render the human-editable mirror after any store mutation, merging any
   * in-flight human edits first (never silently overwriting them). Only
   * non-forgotten memories are mirrored: forgotten entries must not reach the
   * human-editable file (a human "edit" could otherwise resurrect them).
   */
  // #296 第二批：documentDir/index.md 的写后语。与注册入口共用同一个
  // documentMemoryEnabled 闸（默认关）：闸开时只列活跃指针行（正文永远不进这个
  // 文件），闸关时把索引删掉——document 子系统整体退出，留一份陈旧索引会列出已
  // 归档的行，正是镜像侧 documents.md 在闸关时被删掉要避免的那种「看着还在、其实
  // 已关」的视图。两步都只 warn：索引是机器产物，不能让触发它的业务写失败。
  function syncDocumentIndex() {
    if (!documentIndex) return;
    if (config?.documentMemoryEnabled !== true) {
      const removed = documentIndex.remove();
      if (!removed?.ok) logger?.warn?.("document index remove failed:", removed?.error);
      return;
    }
    try {
      const result = documentIndex.sync(store.list({ type: "document", limit: null }));
      if (!result?.ok) logger?.warn?.("document index sync failed:", result?.error);
    } catch (error) {
      logger?.warn?.("document index sync failed:", error);
    }
  }

  // syncMirror: 同步 mirror，并在失败/成功时持久记录 dirty 状态；保证自身不抛出。
  // v0.3.6（audit peer 4 阻断）：
  //   - 开始时 incrementGeneration 绑定本次期望轮次 gen；成功用
  //     markMirrorCleanForGeneration(gen, now) CAS/fence 清 dirty——旧 worker
  //     （gen 已过期）不会误清另一 worker 未恢复的故障债务；
  //   - 失败写 markMirrorDirty（递增 desired 绑定新债务），下次 recover 恢复；
  //   - 逐 type 用 setTypeStatus 记录部分成功/失败（type_status JSON）；
  //   - 所有 store 状态写入各自 try/catch，失败只 warn，绝不向外抛（F-NEW-03）。
  function syncMirror() {
    if (txDepth > 0) return { success: true, deferred: true }; // deferred to the transaction's commit
    // #296 第二批：documentDir/index.md 走同一条写后语——它与镜像一样是「从库渲染
    // 的机器产物」，同样只在内容变化时落盘、同样自己吞掉失败。放在 !mirror 短路
    // 之前：索引在不在，不该取决于镜像是否装配（无镜像的宿主与测试同样要有它）。
    syncDocumentIndex();
    if (!mirror) return { success: true, deferred: true };
    const now = new Date().toISOString();
    let gen;
    try {
      // desired generation 已在业务写事务中原子递增（peer blocker 1）；这里
      // 直接读当前值作为本次同步的目标轮次，不再自行 incrementGeneration。
      const state = store.getMirrorState();
      gen = state?.generation ?? 0;
    } catch (stateError) {
      logger?.warn?.("syncMirror: getMirrorState failed:", stateError);
      return { success: false, error: stateError?.message ?? String(stateError) };
    }
    // coveredTypes 提到 try 外初始化：即使 store.list 先抛错，catch 分支也有
    // 合法的空 Set 可迭代，保证 syncMirror 自身绝不抛（fail-safe）。
    const coveredTypes = new Set();
    try {
      // 预先取本次要覆盖的全部活跃行（只读一次）。这里曾经是
      // store.list({ limit: 500 })——活跃集超过 500 时镜像会静默少掉尾部记忆，
      // 而文件本身没有任何提示（#278 第一批）。store.list 的 limit 默认值只有
      // 50，比原来显式传的 500 更小，所以改用 all() 并在这里做同一套过滤
      // （forgotten/archived 都不进镜像，与 includeForgotten:false + 默认
      // includeArchived:false 等价）。
      // 代价是全表读，且落在每次业务写后的最热路径上（#202 自记 all() 5k 行
      // 231ms → ~135ms）。要压这一层得换按 type 分页取，属另一批的事；
      // 在这里退回任何截断都不行——「宣称覆盖活跃集」与静默截断不能共存。
      const list = store.all().filter((m) => !m.forgotten && !m.archived
        // #296 第二批：镜像里的 documents.md 与 index.md 共用 documentMemoryEnabled
        // 闸。关掉时把 document 行也从渲染集里去掉——sync 对「空 type」的既有处理
        // 会把陈旧的 documents.md 删掉，不留一个「看着还在、其实已关」的视图。
        && (m.type !== "document" || config?.documentMemoryEnabled === true));
      for (const memory of list) {
        if (memory?.type && TYPE_FILE[memory.type]) {
          coveredTypes.add(memory.type);
        }
      }

      // Per-type physical outcome (audit peer D): mirror.sync writes each type
      // file independently and reports per-type success/failure. A type whose
      // file was physically committed must be marked committed even when a
      // sibling type errors — the old code batch-failed every type on any error,
      // leaving committed files mislabeled as failed and masking partial state.
      // Absent entries (a type with no memories) count as success: sync prunes
      // the stale file, which is itself a completed physical state.
      let allOk = true;
      const results = mirror.sync(reconcileHumanEdits(list)) ?? {};
      for (const type of Object.keys(TYPE_FILE)) {
        const r = results[type];
        const ok = !r || r.ok === true;
        if (!ok) allOk = false;
        try {
          if (ok) {
            store.setTypeStatus(type, { status: "committed", applied_gen: gen, last_error: null });
          } else {
            store.setTypeStatus(type, { status: "failed", last_error: r.error ?? "mirror sync failed" });
          }
        } catch (stateError) {
          logger?.warn?.(`syncMirror: setTypeStatus(${type}) failed:`, stateError);
        }
      }

      // 全部 type 物理收敛：CAS/fence 绑定到本地 gen，旧 worker（gen 已过期）会被
      // 拦截。此步失败说明核心 clean 状态没写成功，向上层报失败（不再静默）。
      if (allOk) {
        try {
          store.markMirrorCleanForGeneration(gen, now);
        } catch (stateError) {
          logger?.warn?.("syncMirror: markMirrorCleanForGeneration failed:", stateError);
          return { success: false, error: stateError?.message ?? String(stateError) };
        }
        return { success: true };
      }

      // 部分 type 失败：持久 dirty（债务绑定到新轮次），下次 recover 只补未收敛
      // 的 type。committed 的 type 已应用本轮 gen，不因兄弟失败被回滚。
      const failedTypes = Object.entries(results)
        .filter(([, r]) => r && r.ok === false)
        .map(([t]) => t);
      try {
        store.markMirrorDirty(`mirror sync failed for: ${failedTypes.join(", ")}`, now);
      } catch (stateError) {
        logger?.warn?.("syncMirror: markMirrorDirty failed:", stateError);
      }
      return { success: false, error: `mirror sync failed for: ${failedTypes.join(", ")}` };
    } catch (error) {
      const errMsg = error?.message ?? String(error);
      logger?.warn?.("syncMirror failed:", error);
      try {
        // 债务绑定到新的一轮（desired generation 原子递增；即便 dirty 写失败，
        // generation 已推进，recoverMirror 仍能捕获，不产生 false-clean）。
        store.markMirrorDirty(errMsg, now);
      } catch (stateError) {
        logger?.warn?.("syncMirror: markMirrorDirty failed:", stateError);
      }
      // 逐 type 标记为 failed（applied_gen 不动）
      for (const type of coveredTypes) {
        try {
          store.setTypeStatus(type, { status: "failed", last_error: errMsg });
        } catch (stateError) {
          logger?.warn?.(`syncMirror: setTypeStatus(${type}) failed:`, stateError);
        }
      }
      return { success: false, error: errMsg };
    }
  }

  // afterSync: run syncMirror and surface a failure to the operator instead of
  // swallowing it (peer blocker 2 + audit peer B). The mirror debt has already
  // been persisted by markMirrorDirty inside syncMirror, so a restart recovers —
  // but the calling write path must not report clean while the mirror is
  // known-stale. Returns the sync result so the caller can attach an explicit
  // degraded/pending receipt to its return value instead of faking success.
  function afterSync(label) {
    const r = syncMirror();
    if (!r?.success && !r?.deferred) {
      logger?.warn?.(`${label}: mirror sync failed (will recover on restart):`, r?.error);
    }
    return r;
  }

  // recoverMirror: 启动/手动 reconcile 时根据持久 dirty 状态决定是否恢复同步
  // （F-NEW-03 + v0.3.6）。触发条件不只是 dirty——还检查
  // generation > applied_generation（有未应用的债务），这样 COMMIT→dirty 崩溃
  // 窗口（DB 提交后、markMirrorDirty/clean 前进程退出 → dirty=false 但
  // generation 不一致）也能被捕获。有界重试（最多 3 次）重跑 syncMirror 收敛；
  // 某次成功后 dirty=false 且无更新债务（generation <= applied_generation）
  // 立即停止。返回 { recovered, error } 供 index.js 启动 / api.js health 判断。
  // 一切 fail-safe，绝不向外抛。
  function recoverMirror() {
    const MAX_ATTEMPTS = 3;
    let lastError = null;
    let recovered = false;

    try {
      const state = store.getMirrorState();
      // 崩溃窗口检测：dirty 或 generation > applied_generation（COMMIT→dirty 窗口）
      if (!state?.dirty && !(state.generation > state.applied_generation)) {
        // 本来就干净：无需恢复，视为成功
        return { recovered: true, error: null };
      }

      // 有 dirty 或有未应用债务：最多尝试 3 次 sync
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          syncMirror(); // syncMirror 内部已 catch，不会向外抛
          const currentState = store.getMirrorState();
          // 成功条件：dirty 为 false 且没有更新一轮的债务
          // （generation <= applied_generation，恢复后由 syncMirror 里
          //   markMirrorCleanForGeneration 自动把 applied 跟上）
          if (!currentState?.dirty && currentState.generation <= currentState.applied_generation) {
            recovered = true;
            lastError = null;
            break;
          }
          // 仍 dirty 或仍有更新债务：记录最后一次错误供重试耗尽后上报。
          // 注意：若别的 worker 又失败产生新债务（dirty 仍 true），这是"新债务"
          // 不是本次失败，继续重试直到耗尽次数。
          lastError = currentState.last_error || `Sync attempt ${attempt + 1} left mirror dirty or has pending debt`;
        } catch (syncError) {
          // syncMirror 理论不抛，fail-safe 兜底
          const errMsg = syncError?.message ?? String(syncError);
          logger?.warn?.("recoverMirror: sync attempt failed:", errMsg);
          lastError = errMsg;
        }
      }

      if (!recovered) {
        logger?.warn?.("dsh-mneme mirror: recover failed after", MAX_ATTEMPTS, "attempts");
      } else {
        logger?.warn?.("dsh-mneme mirror: recovered from dirty/pending state");
      }
    } catch (error) {
      // fail-safe：任何意外异常不向外抛
      lastError = error?.message ?? String(error);
      logger?.warn?.("dsh-mneme mirror: recover failed with unexpected error:", error);
    }

    return { recovered, error: recovered ? null : lastError };
  }

  // getMirrorHealth: 暴露 mirror 同步健康状态，供 api.js /health 使用
  // （F-NEW-03）。把 DB 的 dirty 0/1 转成 boolean；fail-safe，绝不向外抛。
  function getMirrorHealth() {
    try {
      const state = store.getMirrorState();
      if (!state) {
        // 无状态行：返回安全默认值
        return {
          dirty: false,
          last_error: null,
          last_attempt: null,
          success_at: null
        };
      }
      return {
        dirty: Boolean(state.dirty),
        last_error: state.last_error ?? null,
        last_attempt: state.last_attempt ?? null,
        success_at: state.success_at ?? null
      };
    } catch (error) {
      // fail-safe：状态读取失败也不向外抛，但必须显式表达"未知"而非伪装成
      // 干净（peer blocker 5：真实读取失败要显式 unknown，不得归一为 dirty:false）。
      logger?.warn?.("getMirrorHealth failed:", error);
      return {
        dirty: null,
        last_error: error?.message ?? String(error),
        last_attempt: null,
        success_at: null
      };
    }
  }

  // 返回字面量与内部裁决器（resolveConflictPending → applyDecisions 的 conflict
  // 处置）共用的写路径：mirror 同步、写通知、嵌入调度全部同源，不能各写一份。
  function updateMemory(id, p, ctx = {}) {
    const old = store.getById(id);
    // #230 写入权分离（与 saveWithDedupe 同款守卫）：document 行只能经
    // registerDocument 铸造。既有 document 行的摘要修复（memory_update 改
    // content/title——设计定案的更新通道）照常放行，type 不许改入 document。
    if (p?.type === "document" && old?.type !== "document") {
      throw new Error("type 'document' is minted only via registerDocument (summary + doc_path + evidence)");
    }
    // Issue #135 附属发现 2：质量过滤器把「为什么被降权/归档」写在系统信号标签
    // 上（SIGNAL_TAGS，applyQualityDisposition 以并集写入），而这里整组替换
    // tags——任何带 tags 的更新都会抹掉这条唯一的审计线索（报告实测 150 条低分
    // 记忆里恰好缺的 2 条就是被 update 过的，并因此误判过归档来源）。把 existing
    // 的系统信号标签并集保留；用户自传的标签照常生效。
    let patch = (p && Array.isArray(p.tags) && old && Array.isArray(old.tags))
      ? { ...p, tags: [...new Set([...p.tags, ...old.tags.filter((t) => SIGNAL_TAGS.includes(t))])] }
      : p;
    // v0.8.1 底座（issue #170）：显式 scope 修正。patch 携带 agent_scope /
    // workspace_scope 键（undefined=该维不动）时归一化并盖 explicit 章 +
    // scope_decided_at，随后写 scope_changes 审计行（actor：tool=模型侧 /
    // panel=人工侧）。审计失败只 warn，不反噬主写入。
    const nextAgentScope = p && p.agent_scope !== undefined ? normalizeExplicitScope(p.agent_scope) : undefined;
    const nextWorkspaceScope = p && p.workspace_scope !== undefined ? normalizeExplicitScope(p.workspace_scope) : undefined;
    const scopeChanged = nextAgentScope !== undefined || nextWorkspaceScope !== undefined;
    if (scopeChanged) {
      const decidedAt = new Date().toISOString();
      patch = { ...patch };
      if (nextAgentScope !== undefined) {
        patch.agent_scope = nextAgentScope;
        patch.agent_scope_source = "explicit";
      }
      if (nextWorkspaceScope !== undefined) {
        patch.workspace_scope = nextWorkspaceScope;
        patch.workspace_scope_source = "explicit";
      }
      patch.scope_decided_at = decidedAt;
    }
    const updated = store.update(id, patch);
    if (scopeChanged && old && updated) {
      try {
        store.saveScopeChange({
          memory_id: id,
          actor: ctx.actor === "panel" ? "panel" : "tool",
          prev_agent_scope: old.agent_scope ?? null,
          prev_workspace_scope: old.workspace_scope ?? null,
          next_agent_scope: updated.agent_scope ?? null,
          next_workspace_scope: updated.workspace_scope ?? null,
          agent_scope_source: updated.agent_scope_source ?? null,
          workspace_scope_source: updated.workspace_scope_source ?? null,
          decided_at: patch.scope_decided_at
        });
      } catch (e) {
        try { ctx.logger?.warn?.(`[dsh-mneme] scope change audit failed: ${String(e)}`); } catch { /* 同样不反噬 */ }
      }
    }
    // Record a user correction when any meaningful field changed and the
    // reflection failure tracker is enabled. expected = what it became,
    // actual = what it was before; query (when provided) captures the
    // user's original intent so later reflection can reason about recall.
    const hasMeaningfulChange = old && updated && (
      old.content !== updated.content ||
      old.title !== updated.title ||
      old.importance !== updated.importance
    );
    if (hasMeaningfulChange && config.reflectionFailureTracking) {
      store.saveFailure({
        id: randomUUID(),
        query: ctx.query ?? null,
        expected: updated.content,
        actual: old.content,
        before: { title: old.title, content: old.content, importance: old.importance },
        failure_type: "user_correction",
        memory_id: id
      });
    }
    const sync = afterSync("write");
    notifyWrite();
    scheduleEmbed(updated);
    // Audit peer B: when the mirror sync failed, the store write landed but
    // the mirror did not converge — return an explicit degraded receipt rather
    // than a plain success. Non-enumerable so existing deepEqual assertions on
    // the memory shape keep passing.
    if (!sync?.success && !sync?.deferred) {
      Object.defineProperty(updated, "_mirror", {
        value: { status: "degraded", error: sync?.error ?? "mirror sync failed" },
        enumerable: false,
        configurable: true
      });
    }
    return updated;
  }

  function archiveMemory(id, f) {
    const updated = store.setArchived(id, f);
    afterSync("write");
    // #275 B 项：归档行的向量会被手动回收清掉（检索恒带 archived = 0，按定义不可达），
    // 还原回活跃面时补一次嵌入——否则那行只剩关键词可检索，回收就成了单程票。
    // 判据用真值（`!f`）而不是 `f === false`：store.setArchived 自己就是按真值归一
    // （`archived ? 1 : 0`），API/工具传 0 或空串同样会把行放回活跃面，口径必须同一把尺。
    // 排队语义与写入路径同一处（txDepth / 未就绪由 scheduleEmbed 自己挡）。
    if (!f) scheduleEmbed(updated);
    return updated;
  }

  // document 型记忆注册（#230）：内聚块在 src/document.js（AGENTS.md 尺寸
  // 约定，同 recallStats 先例），这里只做依赖注入 + barrel 出口，调用方零改动。
  // 写后语只做重嵌入：镜像同步与写通知由 transaction 的 commit 路径统一执行
  // （notifyWrite 在 txDepth>0 时 deferred 到 finally），这里再调就是双份。
  const registerDocument = createDocumentRegistrar({
    store,
    config,
    embedQuery,
    pushContentHistory,
    transaction,
    // #275 拍板 5：升格吸收的 evidence 行随之归档，但 pinned 池（#249）永不自动归档
    // ——注册器不 import 这个集合，方向反了会成环，所以在这里注入。
    pinnedTypes: PINNED_MEMORY_TYPES,
    finalize: (rows) => {
      for (const row of rows) scheduleEmbed(row);
    }
  });

  // agent 主动整理接口（#231）：dryRun 比对报告 → agent 判断 → apply 落库，筛除项
  // 进归档不删，全程复用 dream_runs 的 receipt 语义（不新建审计面）。走
  // saveWithDedupe 落库 = 复用常规写路径的镜像/通知语；重嵌入由 finalize 在事务
  // 提交后补（事务里的 scheduleEmbed 被 txDepth 挡掉）——document 同款先例。
  const { organize } = createOrganizer({
    store,
    embedQuery,
    saveWithDedupe,
    transaction,
    finalize: (rows) => {
      for (const row of rows) scheduleEmbed(row);
    }
  });

  return {
    saveWithDedupe,
    registerDocument,
    // agent 主动整理接口（#231）：内聚块在 src/organize.js，这里只做依赖注入 +
    // barrel 出口。刻意不加 opt-in 开关（维护者口径：功能本体不做开关，与 #249
    // 同批暴露时再定配置面），也不进工具列表——工具注册在 #249 那批。
    organize,
    recoverMirror,
    getMirrorHealth,
    getMirrorState: () => store.getMirrorState(),
    injectCandidates,
    mergeHumanEdits,
    toApiList,
    isVisibleInScope,
    transaction,
    getDistillCursor: (sessionId) => store.getDistillCursor(sessionId),
    setDistillCursor: (sessionId, lastSeq) => store.setDistillCursor(sessionId, lastSeq),
    enqueue,
    setDreamHook(fn) { dreamHook = fn; },
    setSleepHook(fn) { sleepHook = fn; },
    setEmbedder(emb) {
      embedder = emb;
      if (!emb) {
        // embedder removed (init failed in index.js): stop polling and drop
        // queued re-embeds — search just degrades to keyword.
        stopEmbedReadyPolling();
        embedPending = [];
        return;
      }
      if (emb.ready === true) {
        flushEmbedPending();
        return;
      }
      // Async-initializing embedder: poll `ready` until it flips, then flush.
      if ("ready" in emb && embedReadyTimer === null) {
        let attempts = 0;
        embedReadyTimer = setInterval(() => {
          attempts++;
          if (emb.ready === true || attempts >= EMBED_READY_POLL_LIMIT) {
            stopEmbedReadyPolling();
            if (emb.ready === true) flushEmbedPending();
            else embedPending = []; // init never landed: drop the queue
          }
        }, EMBED_READY_POLL_MS);
      }
    },
    setEntityExtractor(fn) { entityExtractor = fn; },
    setVectorIndex(vi) { vectorIndex = vi; },
    setReranker(rn) { reranker = rn; },
    setRecallRecorder(fn) { recallRecorder = fn; },
    searchMemories,
    // recallStats（#217）实现在 src/recall-stats.js：service.js 过 2000 行参考线，
    // 新内聚块独立成模块（AGENTS.md 尺寸约定）；这里只留 barrel 出口，调用方
    // （api 层）零改动。纯读聚合，见模块注释的口径说明。
    recallStats: (options) => recallStats(store, options),
    embedQuery,
    findSessionDuplicate,
    evaluateRetrieval,
    computeRetrievalMetrics,
    // passthroughs used by tools and api layers; mutations keep the mirror in sync
    search: (q, o) => store.search(q, o),
    searchVector: (v, o) => store.searchVector(v, o),
    embeddedCount: () => store.embeddedCount(),
    list: (o) => store.list(o),
    all: () => store.all(),
    count: (type, opts) => store.count(type, opts),
    getById: (id) => store.getById(id),
    remove: (id) => {
      store.remove(id);
      afterSync("write");
      notifyWrite();
    },
    update: updateMemory,
    // v0.8.1 底座：scope 归属修正审计（单条记忆，新→旧）。
    listScopeChanges: (memoryId, opts) => store.listScopeChanges(memoryId, opts),
    // Compare-and-set update: applies the patch only when the row still carries
    // `expectedUpdatedAt`. Returns undefined on a miss (no write) so the caller
    // can re-read and retry — the primitive that prevents lost updates across
    // concurrent read-modify-write (see scripts/stress-dsh.js axis 3).
    compareAndUpdate: (id, expectedUpdatedAt, patch, ctx = {}) => {
      const old = store.getById(id);
      const updated = store.compareAndUpdate(id, expectedUpdatedAt, patch);
      if (updated === undefined) return undefined; // CAS miss: no write, no side effects
      const hasMeaningfulChange = old && updated && (
        old.content !== updated.content ||
        old.title !== updated.title ||
        old.importance !== updated.importance
      );
      if (hasMeaningfulChange && config.reflectionFailureTracking) {
        store.saveFailure({
          id: randomUUID(),
          query: ctx.query ?? null,
          expected: updated.content,
          actual: old.content,
          before: { title: old.title, content: old.content, importance: old.importance },
          failure_type: "user_correction",
          memory_id: id
        });
      }
      const sync = afterSync("write");
      notifyWrite();
      scheduleEmbed(updated);
      // Audit peer B: mirror sync failure on a CAS write must surface too.
      if (!sync?.success && !sync?.deferred) {
        Object.defineProperty(updated, "_mirror", {
          value: { status: "degraded", error: sync?.error ?? "mirror sync failed" },
          enumerable: false,
          configurable: true
        });
      }
      return updated;
    },
    setForget: (id, f) => {
      const updated = store.setForget(id, f);
      afterSync("write");
      return updated;
    },
    setArchived: archiveMemory,
    // sleep-mode storage (v0.4.0). demoteToSummary / restoreContent mutate
    // content so they ride the normal write-hook path (mirror re-renders).
    // touchLastAccess is a read-stamp — deliberately NO write hook (a recall
    // must not dirty the mirror). getUnrecalledSince is a pure read.
    demoteToSummary: (id, summary, opts) => {
      const updated = store.demoteToSummary(id, summary, opts);
      afterSync("write");
      return updated;
    },
    restoreContent: (id) => {
      const updated = store.restoreContent(id);
      afterSync("write");
      return updated;
    },
    touchLastAccess: (id, at) => store.touchLastAccess(id, at),
    getUnrecalledSince: (cutMs, opts) => store.getUnrecalledSince(cutMs, opts),
    // autoDream audit trail: passthroughs deliberately bypass write hooks —
    // an audit write is bookkeeping, and notifyWrite would loop back into the
    // dream scheduler that just recorded the run.
    saveDreamRun: (run) => store.saveDreamRun(run),
    getDreamRun: (id) => store.getDreamRun(id),
    listDreamRuns: (opts) => store.listDreamRuns(opts),
    // Per-record receipt chain (same bookkeeping semantics as saveDreamRun: an
    // audit write, never a write-hook-triggering memory mutation).
    saveReceipt: (r) => store.saveReceipt(r),
    getReceipt: (id) => store.getReceipt(id),
    listReceipts: (opts) => store.listReceipts(opts),
    // Conflict freeze bookkeeping (same semantics as the audit passthroughs
    // above: an audit write, never a write-hook-triggering memory mutation).
    saveConflictPending: (r) => store.saveConflictPending(r),
    listConflictPending: (opts) => store.listConflictPending(opts),
    listConflictQueue,
    resolveConflictPending,
    countConflictPending: () => store.countConflictPending(),
    // Recall evaluation trail (方案 B): audit-bookkeeping semantics like the
    // dream/recall passthroughs above — a recall_evals write is a snapshot, not
    // a memory mutation, so it never triggers write hooks.
    saveRecallEval: (r) => store.saveRecallEval(r),
    getRecallEval: (id) => store.getRecallEval(id),
    listRecallEvals: (opts) => store.listRecallEvals(opts),
    // LLM audit trail (Bug8): bookkeeping semantics like the recall/dream
    // passthroughs — a saveLlmAudit write never triggers write hooks.
    saveLlmAudit: (entry) => store.saveLlmAudit(entry),
    listLlmAudits: (opts) => store.listLlmAudits(opts),
    countLlmAudits: (opts) => store.countLlmAudits(opts),
    getLlmAuditStats: (opts) => store.getLlmAuditStats(opts),
    deleteOldLlmAudits: (before) => store.deleteOldLlmAudits(before),
    // Entity gene (v0.3.0) passthroughs for the autoDream apply path
    // (applyDecisions): records supersedes relations after an update and
    // migrates entity_attrs on merge. Bookkeeping writes like the audit
    // passthroughs above — never write-hook-triggering memory mutations.
    saveRelation: (r) => store.saveRelation(r),
    listEntities: (o) => store.listEntities(o),
    getRelations: (id) => store.getRelations(id),
    // v0.7.0 实体热投影：实体热 = 关联记忆 heat 聚合（取 max）。无关联记忆
    // 或 heatEnabled=false 时返回 null；前端据此决定图谱节点大小/明暗。
    entityHeat: (entityId) => {
      if (config.heatEnabled === false) return null;
      const rels = store.getRelations(entityId) ?? [];
      let max = -Infinity;
      for (const rel of rels) {
        if (!rel.memory_id) continue;
        const mem = store.getById(rel.memory_id);
        if (!mem) continue;
        const h = computeHeat(mem, Date.now(), config);
        if (h > max) max = h;
      }
      return max === -Infinity ? null : max;
    },
    saveAttr: (r) => store.saveAttr(r),
    createEntity: (r) => store.createEntity(r),
    findEntityByName: (n) => store.findEntityByName(n),
    findEntityById: (id) => store.findEntityById(id),
    getAttrsByMemory: (id) => store.getAttrsByMemory(id),
    // 记忆详情侧栏：一条记忆关联到的实体（entity_attrs.memory_id 反查，纯读）。
    entitiesForMemory: (id) => store.entitiesForMemory(id),
    getCurrentAttrs: (id) => store.getCurrentAttrs(id),
    migrateAttrsToMemory: (fromId, toId, now) => store.migrateAttrsToMemory(fromId, toId, now)
  };
}
