// src/semantic.js —— embedder/reranker 装配与 boot 自动回填。
// 纯搬移自 src/index.js(2026-10,PR2):backfillMissingEmbeddings(原 :150-186)与
// 装配段(原 :311-477),行为逐字节对齐,仅两处已注记的机械差异(ctx.logger → 注入
// logger;boot 回填的首查计时器纳入 dispose)。搬移原因:daemon(dsh-mneme-serve,
// #363)与宿主要共用同一套语义装配——「向量检索开箱即用」的承诺落在两侧同一份
// 代码上,而不是 daemon 复刻一份会漂移的副本。拆法遵循 AGENTS.md 尺寸约定:
// 纯搬移独立 PR、原文件调用方零改动(backfill 经 index.js barrel 再出口,测试照旧)。
//
// 时序契约(搬移前即如此,由 index.js 全量测试与 reindex-backfill.test.js 锁):
//   lightMode / openai / 同步构造失败 → applyHumanEdits 立即;
//   local|ollama → init 成功后 applyHumanEdits;#118 重试(1 + 4×15s)耗尽 →
//   setEmbedder(null) 检索降级关键词,随后仍 applyHumanEdits;
//   reranker 异步 init 失败只降级 rerank 自身,绝不影响 search。
import { createEmbedder } from "./embedding.js";
import { createEmbedderByProvider } from "./local-embedder.js";
import { LocalReranker } from "./reranker.js";

/**
 * Issue #128: bounded backfill of rows still missing an embedding (active rows
 * only — needsEmbedding filters archived/forgotten). Exported for tests.
 *
 * Runs regardless of the model fingerprint: the old call-site gate returned
 * early when vector_meta already held the embedder's hash, permanently
 * orphaning rows whose embed failed at write time (embedder not ready /
 * provider rate limit) — one successful embed was enough to never backfill
 * again. markModel is idempotent when the fingerprint already matches, so
 * re-running costs nothing beyond the actually-missing rows.
 */
export async function backfillMissingEmbeddings({
  store, embedder, vectorIndex, logger,
  // maxTotal: 0 = no cap (drain the whole backlog this run). The default stays
  // modest so a boot never floods a provider, but the cap is a caller choice
  // now instead of a hardcoded one — the fixed 500 meant a 4k-row backlog
  // needed nine restarts to clear, and nothing reported that it had been cut.
  maxTotal = 500, batchSize = 10, rateLimitMs = 200
}) {
  const startedAt = new Date().toISOString();
  // Model-aware selector: rows whose vector came from another model (or
  // predate per-row provenance) must be re-embedded too, otherwise a model
  // switch leaves uncomparable vectors in the index forever.
  const model = embedder.modelHash;
  const pick = (n) => (typeof store.needsEmbeddingFor === "function"
    ? store.needsEmbeddingFor(model, n)
    : store.needsEmbedding(n));
  const unlimited = !(maxTotal > 0);
  let indexed = 0;
  let processed = 0;
  let failed = 0;
  for (let done = 0; unlimited || done < maxTotal;) {
    const rows = pick(batchSize);
    if (!rows.length) break;
    for (const row of rows) {
      try {
        const text = [row.title, row.content].filter(Boolean).join("\n");
        const vector = await embedder.embedSingle(text);
        if (vector?.length) {
          store.setEmbedding(row.id, vector, model);
          indexed++;
        } else {
          failed++;
        }
      } catch { failed++; /* skip the bad row, but count it */ }
    }
    done += rows.length;
    processed += rows.length;
    // Rate limit: space out batches so the provider is not hammered.
    if (pick(1).length) await new Promise((r) => setTimeout(r, rateLimitMs));
  }
  if (indexed > 0 && model) vectorIndex.markModel?.(model, embedder.dimension);
  // stillStale answers "did it actually finish?". The old return value was a
  // bare indexed count, so a run that hit the cap looked exactly like a run
  // that drained the backlog.
  const stillStale = pick(1).length > 0;
  const finishReason = stillStale ? "capped" : (failed > 0 && indexed === 0 ? "all-failed" : "drained");
  logger?.info?.(
    `[dsh-mneme] auto-reindex backfilled ${indexed} embeddings (processed=${processed}, failed=${failed}, finish=${finishReason})`
  );
  return {
    indexed, processed, failed, finishReason, stillStale,
    startedAt,
    finishedAt: new Date().toISOString(),
    model: model ?? null
  };
}

/**
 * 组装语义管线(embedder + reranker)并挂到 service 上,随后调度 boot 自动回填。
 * @param {object} opts
 *   store/service/settings/vectorIndex — 宿主与 daemon 同形传入;
 *   cfg            — 宿主传合并后的完整配置;daemon 传语义子集(默认值锚定 config.js);
 *   logger         — console 形状(原代码读 ctx.logger,搬移后注入);
 *   applyHumanEdits— 人改镜像合并回调(index.js 闭包,读 mirror.readHumanEdits);
 *                    在哪个分支何时被调是时序契约的一部分,见文件头;
 *   lightMode      — 轻量档:整条向量管线关闭,无 embedder/reranker、不回填。
 * @returns {{embedder, reranker, dispose}} embedder 构造失败(同步抛)时为 null;
 *   init 异步失败经 #118 重试后 service 侧降级,此处引用仍在(dream/sleep 语义面
 *   与搬移前一致)。dispose 清两个引导期计时器。
 */
export function createSemantic({ store, service, settings, cfg, logger, vectorIndex, applyHumanEdits, lightMode = false }) {
  let embedder = null;
  let reranker = null;
  // #118: pending embedder-init retry timer, cleared on unload.
  let embedRetryTimer = null;
  // boot 回填首查计时器。搬移前在 index.js 是裸 setTimeout(不参与卸载清理);
  // 纳入 dispose 是修悬挂,不改变启动行为。
  let reindexTimer = null;
  // Last boot-backfill summary, exposed via backfillStatus() so "did it
  // finish?" has an answer other than a log line.
  let lastBackfill = null;

  if (lightMode) {
    // Light mode: the whole vector pipeline stays off — no embedder (nothing
    // pulls in ONNX/transformers), no reranker, no boot backfill (the preset
    // also cleared autoReindexOnBoot). Recall degrades to keyword search and
    // human mirror edits still merge on boot.
    applyHumanEdits();
  } else if (cfg.embedProvider === "openai") {
    // vectorIndex is passed so the legacy OpenAI embedder records the producing
    // model fingerprint after each successful embed (Bug3).
    embedder = createEmbedder({ store, settings, logger, vectorIndex });
    service.setEmbedder(embedder);
    // issue #135: 未配置时明确告警一次。此前 legacy OpenAI embedder 恒报
    // ready=true，向量层「绿的但全哑」可以静默存在很久（本机持续了数周）。
    // 只记日志、不阻断启动：轻量模式与「先跑起来再补配置」都是正当用法。
    if (embedder.configured === false) {
      logger?.warn?.(
        "[dsh-mneme] 向量层未配置（vector-config 的 enabled/baseUrl/apiKey/model 有缺）："
        + "语义召回、语义去重、rerank、sleep 冲突检测将静默失效，"
        + "dream 的语义聚类会退化为全量窗口兜底。"
        + "请在设置面板补全 embedding 端点与模型，或把 embedProvider 改为 local/ollama。"
      );
    }
    // legacy OpenAI embedder needs no async init → human edits apply right away
    applyHumanEdits();
  } else {
    try {
      embedder = createEmbedderByProvider(cfg.embedProvider, {
        model: cfg.embedProvider === "ollama" ? cfg.ollamaModel : cfg.localEmbedModel,
        dimension: cfg.localEmbedDimension,
        device: cfg.localEmbedDevice,
        batchSize: cfg.localEmbedBatchSize,
        // 池化方式必须与模型的训练口径一致（BGE 系 = CLS）。它既进 embed() 的调用，
        // 也进 modelHash —— 池化改了就是换向量空间，既有索引会被判失配并重建。
        pooling: cfg.localEmbedPooling,
        cacheDir: cfg.embedModelCacheDir,
        runtimeDir: cfg.runtimeDir,
        // #188：embedModelMirror 接成 transformers 的下载镜像（此前死配置）。
        remoteHost: cfg.embedModelMirror,
        resilientModelDownload: cfg.resilientModelDownload,
        baseUrl: cfg.ollamaBaseUrl,
        logger
      });
      service.setEmbedder(embedder);
      // issue #6: wait for extractor init before applying human edits, so
      // scheduled embeddings see a ready embedder.
      const bootEmbedder = () => embedder.init()
        .then(() => { applyHumanEdits(); return true; })
        .catch(() => false);
      // #118: the old one-shot probe permanently degraded search to keyword
      // when Ollama was briefly unreachable at boot (recoverable only by
      // restart). Retry briefly (5 attempts total: 1 initial + 4 × 15s);
      // search degrades to keyword meanwhile because per-query embed failures
      // are swallowed.
      bootEmbedder().then((ok) => {
        if (ok) return;
        let tries = 4;
        const retry = () => {
          if (tries-- <= 0) {
            logger?.warn?.("[dsh-mneme] embedder init retries exhausted, search degrades to keyword");
            service.setEmbedder(null);
            applyHumanEdits();
            return;
          }
          embedRetryTimer = setTimeout(async () => {
            if (await bootEmbedder()) return;
            retry();
          }, 15_000);
        };
        logger?.warn?.("[dsh-mneme] embedder init failed, retrying");
        retry();
      });
    } catch (error) {
      logger?.warn?.(`[dsh-mneme] embedder unavailable, search degrades to keyword: ${String(error)}`);
      applyHumanEdits();
    }
  }

  // Cross-encoder rerank over recall candidates. Best-effort: a failed model
  // load only disables reranking, never search itself. Explicit opt-in only
  // (rerankEnabled defaults to false): constructing LocalReranker is what pulls
  // in onnxruntime, so the default config never loads it (item ⑥).
  if (cfg.rerankEnabled && cfg.rerankProvider === "local") {
    try {
      reranker = new LocalReranker({
        model: cfg.rerankModel,
        batchSize: cfg.rerankBatchSize,
        maxCandidates: cfg.rerankMaxCandidates,
        scoreThreshold: cfg.rerankScoreThreshold,
        device: cfg.localEmbedDevice,
        cacheDir: cfg.embedModelCacheDir,
        runtimeDir: cfg.runtimeDir,
        // #188：量化档默认 q8（此前不传 dtype 会去要 1GB 级 fp32 模型）；
        // embedModelMirror 此前是死配置，现接成 transformers 的下载镜像。
        useDtype: cfg.rerankDtype,
        remoteHost: cfg.embedModelMirror,
        resilientModelDownload: cfg.resilientModelDownload,
        logger
      });
      service.setReranker(reranker);
      reranker.init().catch((error) => {
        logger?.warn?.(`[dsh-mneme] reranker init failed, rerank disabled: ${String(error)}`);
        service.setReranker(null);
      });
    } catch (error) {
      logger?.warn?.(`[dsh-mneme] reranker unavailable, rerank disabled: ${String(error)}`);
    }
  }

  // Bug2: lazy auto-backfill of missing embeddings on boot. When the vector API
  // is configured and rows still lack an embedding (e.g. written before vector
  // search was enabled), the backfill runs in the background after a short
  // delay. Gated on cfg.autoReindexOnBoot; rate-limited in small batches so a
  // large backlog never floods the provider. Failures degrade silently —
  // search stays keyword.
  function scheduleAutoReindex() {
    if (cfg.autoReindexOnBoot === false) return;
    const attempt = (tries) => {
      try {
        if (!embedder || typeof embedder.embedSingle !== "function") return;
        if ("ready" in embedder && embedder.ready !== true) {
          // Local/ollama embedders init asynchronously; give them a moment
          // before giving up on this boot (next boot retries).
          // CodeRabbit on #365:嵌套重试计时器同样入册,否则 dispose 后仍可能
          // 对已关库跑 needsEmbedding(有 try/catch 兜底只是日志噪声,但状态要收干净)。
          if (tries > 0) reindexTimer = setTimeout(() => attempt(tries - 1), 2000);
          return;
        }
        const model = embedder.modelHash;
        const stale = typeof store.hasStaleEmbedding === "function"
          ? store.hasStaleEmbedding(model)
          : store.needsEmbedding(1).length > 0;
        if (!stale) return; // nothing missing and nothing from another model
        // Issue #128: no fingerprint gate here anymore — a matching fingerprint
        // used to return early and permanently orphan rows whose embed failed
        // at write time. See backfillMissingEmbeddings().
        // Cap and pacing are configuration now (reindexMaxPerBoot /
        // reindexBatchSize / reindexRateLimitMs) instead of hardcoded 500/10/200.
        lastBackfill = {
          state: "running", startedAt: new Date().toISOString(),
          maxTotal: cfg.reindexMaxPerBoot, batchSize: cfg.reindexBatchSize
        };
        backfillMissingEmbeddings({
          store, embedder, vectorIndex, logger,
          maxTotal: cfg.reindexMaxPerBoot,
          batchSize: cfg.reindexBatchSize,
          rateLimitMs: cfg.reindexRateLimitMs
        })
          .then((summary) => {
            lastBackfill = { ...summary, state: "finished" };
          })
          .catch((error) => {
            lastBackfill = { state: "error", error: String(error), startedAt: lastBackfill?.startedAt };
            logger?.warn?.(`[dsh-mneme] auto-reindex failed: ${String(error)}`);
          });
      } catch (error) {
        logger?.warn?.(`[dsh-mneme] auto-reindex failed: ${String(error)}`);
      }
    };
    reindexTimer = setTimeout(() => attempt(5), 5000);
  }
  scheduleAutoReindex();

  return {
    embedder,
    reranker,
    /** Last backfill run: { state, indexed, failed, finishReason, stillStale, ... }. */
    backfillStatus() {
      return lastBackfill;
    },
    dispose() {
      if (embedRetryTimer !== null) { clearTimeout(embedRetryTimer); embedRetryTimer = null; }
      if (reindexTimer !== null) { clearTimeout(reindexTimer); reindexTimer = null; }
    }
  };
}
