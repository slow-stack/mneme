// OpenAI-compatible embedding client for vector search. DSH's LLM service is
// chat-only, so dsh-mneme calls an external `/embeddings` endpoint itself.
// Works with OpenAI, SiliconFlow, Zhipu, local Ollama (via OpenAI-compatible
// proxy) and any provider exposing the standard embeddings API.
const DEFAULT_TIMEOUT_MS = 15000;

/** djb2 — stable, fast fingerprint for a provider/model string. Mirrors the
 *  hash used by the local embedders so all backends share one fingerprint
 *  format (model#hex) for vector_meta consistency checks. */
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Full provider+model fingerprint used for index-consistency checks. */
function modelHashOf(model) {
  return `${model}#${hashString(model)}`;
}

/** Normalize a configured baseUrl into the full embeddings endpoint URL. */
function embeddingsUrl(baseUrl) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  // Accept both "https://host/v1" and a full path ending in /embeddings.
  if (/\/embeddings$/i.test(base)) return base;
  return `${base}/embeddings`;
}

/**
 * Call the embeddings API for one text. Resolves to a Float64 array, or null
 * when the provider is not configured, the call fails, or the response is
 * unusable. Never throws: failures degrade to keyword search.
 */
export async function embedText({ baseUrl, apiKey, model }, text) {
  const url = embeddingsUrl(baseUrl);
  if (!url || !apiKey || !model || !text) return null;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, input: String(text).slice(0, 8000) }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const vec = body?.data?.[0]?.embedding;
  return Array.isArray(vec) && vec.length ? Array.from(vec) : null;
}

/**
 * Embedder bound to the current settings + store: on each write it re-embeds
 * the row's title+content and stores the vector. Failures are swallowed so a
 * flaky embedding endpoint never breaks memory writes.
 *
 * `vectorIndex` (optional) is the vector_meta fingerprint holder: after any
 * successful embed the model that produced the vectors is recorded, so the
 * index can detect drift and the auto-reindex backfill knows what to rebuild.
 */
/**
 * Bounded receipt ring for embedding attempts.
 *
 * Why a ring instead of llm_audit_logs: a full backfill is thousands of
 * attempts, and one audit row each would bury the LLM calls that table exists
 * to trace. What the user actually needs in order to answer "is the vector
 * layer silently dead right now?" is the recent window plus running totals —
 * which costs nothing and cannot flood.
 */
const RECEIPT_LIMIT = 200;

function createReceiptLedger() {
  const recent = [];
  const totals = { ok: 0, failed: 0, skipped: 0 };
  let lastOkAt = null;
  let lastFailAt = null;
  let lastFailReason = null;
  return {
    record(entry) {
      recent.push(entry);
      if (recent.length > RECEIPT_LIMIT) recent.shift();
      if (entry.status in totals) totals[entry.status]++;
      if (entry.status === "ok") lastOkAt = entry.at;
      else if (entry.status === "failed") {
        lastFailAt = entry.at;
        lastFailReason = entry.reason ?? null;
      }
    },
    snapshot() {
      return {
        totals: { ...totals },
        lastOkAt,
        lastFailAt,
        lastFailReason,
        recent: recent.slice(-RECEIPT_LIMIT)
      };
    }
  };
}

export function createEmbedder({ store, settings, logger, vectorIndex }) {
  // Dimension of the most recent successful embed, exposed for fingerprinting.
  let _dimension = 0;
  // Per-write embed receipts (see createReceiptLedger above).
  const ledger = createReceiptLedger();

  /** Record the producing model fingerprint in vector_meta (best-effort). */
  function markModel(cfg, dimension) {
    if (!vectorIndex || typeof vectorIndex.markModel !== "function") return;
    try {
      vectorIndex.markModel(modelHashOf(cfg.model), dimension);
    } catch { /* metadata write is best-effort */ }
  }

  // issue #135: 「配置是否齐备」的唯一判据 —— embed()/embedFor() 的守卫与下面
  // ready/configured 两个 getter 共用，避免以后改一处漏一处。
  const configComplete = (cfg) => !!(cfg?.enabled && cfg.baseUrl && cfg.apiKey && cfg.model);

  /**
   * Embed one memory and store the vector. Never throws — a flaky endpoint
   * must not break memory writes — but it now REPORTS what happened instead
   * of returning undefined on both success and failure. Callers that ignore
   * the result are unaffected; callers that care get a receipt.
   *
   * @returns {Promise<{status:"ok"|"failed"|"skipped", id:string,
   *   at:string, reason?:string, dim?:number, model?:string}>}
   */
  async function embedFor(id, title, content) {
    const at = new Date().toISOString();
    const cfg = settings.getVectorConfig();
    if (!configComplete(cfg)) {
      const entry = { status: "skipped", id, at, reason: "vector-config-incomplete" };
      ledger.record(entry);
      return entry;
    }
    const text = [title, content].filter(Boolean).join("\n");
    let vector = null;
    try {
      vector = await embedText(cfg, text);
    } catch (error) {
      const entry = { status: "failed", id, at, reason: String(error) };
      ledger.record(entry);
      logger?.warn?.(`[dsh-mneme] embed memory ${id} failed: ${String(error)}`);
      return entry;
    }
    if (!vector) {
      // embedText swallows the HTTP detail (404 / timeout / malformed body all
      // resolve to null). The receipt still has to say "no vector", which is
      // exactly the fact the write path never used to report.
      const entry = { status: "failed", id, at, reason: "embedding-request-returned-no-vector" };
      ledger.record(entry);
      logger?.warn?.(`[dsh-mneme] embed memory ${id} produced no vector`);
      return entry;
    }
    const model = modelHashOf(cfg.model);
    store.setEmbedding(id, vector, model);
    _dimension = vector.length;
    // Bug3: record which model produced the current vectors so the index can
    // detect drift and skip a redundant backfill when nothing changed.
    markModel(cfg, vector.length);
    const entry = { status: "ok", id, at, dim: vector.length, model };
    ledger.record(entry);
    logger?.info?.(`[dsh-mneme] embedded memory ${id} (dim=${vector.length})`);
    return entry;
  }

  return {
    // Display name for /semantic: a literal's constructor.name is "Object",
    // which the status card would render verbatim.
    name: "OpenAI",
    /**
     * issue #135: 这个 embedder 没有异步初始化，`"ready" in embedder` 的通用
     * 分支会把它恒判为可用 —— 而 vector-config 四项有缺时它一条都嵌不出来。
     * 对外报真实可用性，让 /semantic 的 ready 不再是「绿色假阳性」。
     * 用 getter 而非快照字段：设置面板改完配置无需重启即生效（与 embed() 同源读取）。
     */
    get ready() {
      return configComplete(settings.getVectorConfig());
    },
    /**
     * 与 ready 同源，分开两个名字是给 /semantic 用：local/ollama 的
     * ready=false 表示「还在初始化」，而这里的 false 表示「根本没配」。
     */
    get configured() {
      return configComplete(settings.getVectorConfig());
    },
    /**
     * Re-embed a memory after any write. Still non-blocking — the caller does
     * not have to await it — but it now RETURNS the receipt promise so a
     * caller that wants to know can. Previously this returned undefined and
     * swallowed the rejection, so "did this write get a vector?" had no answer
     * anywhere in the process. Swallowing still applies to the rejection
     * itself: a vector failure must never break the memory write.
     */
    schedule(memory) {
      if (!memory?.id) {
        return Promise.resolve({ status: "skipped", id: null, at: new Date().toISOString(), reason: "no-id" });
      }
      return embedFor(memory.id, memory.title, memory.content).catch((error) => ({
        status: "failed", id: memory.id, at: new Date().toISOString(), reason: String(error)
      }));
    },

    /** Recent embed receipts + running totals (see createReceiptLedger). */
    embedReceipts() {
      return ledger.snapshot();
    },

    /** Embed one text and return its vector (null on failure/disabled). */
    async embed(query) {
      const cfg = settings.getVectorConfig();
      if (!configComplete(cfg)) return null;
      const vector = await embedText(cfg, query);
      if (vector) _dimension = vector.length;
      return vector;
    },

    // Bug1: single-text adapter. Local/ollama embedders expose embedSingle
    // natively; the legacy OpenAI-compatible client only has embed. This
    // adapter unifies the interface so vector-index rebuildIndex (which guards
    // on `typeof embedder.embedSingle === "function"`) accepts this embedder.
    async embedSingle(text) {
      if (typeof this.embed === "function") return this.embed(text);
      return null;
    },

    /** Model fingerprint (model#hex), or undefined when not configured. */
    get modelHash() {
      const cfg = settings.getVectorConfig();
      return cfg?.enabled && cfg.model ? modelHashOf(cfg.model) : undefined;
    },

    /** Dimension of the last successful embed (0 when never embedded). */
    get dimension() {
      return _dimension || undefined;
    },

    /**
     * Batch re-index rows whose vector is missing OR came from another model.
     * Uses needsEmbeddingFor (not needsEmbedding) so a model switch actually
     * re-embeds the old vectors instead of leaving them eligible for "has a
     * vector" forever while they poison similarity ranking.
     */
    async reindexMissing(limit = 50) {
      const cfg = settings.getVectorConfig();
      if (!cfg?.enabled) return { indexed: 0, skipped: 0 };
      const model = modelHashOf(cfg.model);
      // Fall back to the plain selector for stores that predate the
      // provenance column (older hosts, test doubles).
      const rows = typeof store.needsEmbeddingFor === "function"
        ? store.needsEmbeddingFor(model, limit)
        : store.needsEmbedding(limit);
      let indexed = 0;
      for (const row of rows) {
        const text = [row.title, row.content].filter(Boolean).join("\n");
        const vector = await embedText(cfg, text);
        if (vector) {
          store.setEmbedding(row.id, vector, model);
          _dimension = vector.length;
          indexed++;
        }
      }
      if (indexed > 0) markModel(cfg, _dimension || undefined);
      return { indexed, skipped: rows.length - indexed };
    }
  };
}
