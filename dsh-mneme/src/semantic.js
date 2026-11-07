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
  // #604: a failed row stays stale, so the next pick() hands it straight back
  // and it eats the budget again — measured 9 of 20 slots burned on one
  // permanently failing row, and with maxTotal: 0 the loop never terminated
  // (the failed row never leaves the queue, so "done" never reaches a bound
  // that does not exist). Remembering what THIS run already tried makes the
  // queue strictly shrink, which fixes both shapes with one mechanism.
  //
  // Deliberately in-memory only: a transient provider outage must not become a
  // permanent exclusion. A row skipped here is retried on the next boot, which
  // is the same contract #128 established for the fingerprint gate.
  const attempted = new Set();
  // #604 follow-up: a fixed-size window starves the queue tail. pick() is
  // ORDER BY updated_at DESC and a failed row is never written, so its
  // updated_at never moves: a batch of permanently failing rows at the head is
  // re-selected every round, filtered out by `attempted`, and the run ends
  // `stalled` with every healthy row behind it never tried once. Measured on
  // this code: 20 rows (10 good written first, 10 failing at the head),
  // maxTotal 500 / batchSize 10 → {indexed: 0, finishReason: "stalled"},
  // okCalls 0. Widening the window by the number already tried keeps the dead
  // prefix in view and always reaches past it, so the budget is spent on real
  // work. Still memory-only, still no persistent blacklist.
  // The window is bounded: widening by the whole dead prefix is what makes the
  // tail reachable, but an unbounded window turns "provider down, every row
  // fails" into a quadratic walk that materialises the entire table once per
  // round. 500 rows keeps the query cheap (≈ the default maxTotal) and still
  // tolerates hundreds of permanent failures at the head before honestly
  // reporting `stalled`.
  const maxWindow = Math.max(batchSize, 500);
  const pickFresh = (n) => pick(Math.min(n + attempted.size, maxWindow));
  let indexed = 0;
  let processed = 0;
  let failed = 0;
  let stalled = false;
  const failureReasons = Object.create(null);
  const noteFailure = (reason) => {
    failed++;
    failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
  };
  for (let done = 0; unlimited || done < maxTotal;) {
    const picked = pickFresh(batchSize);
    if (!picked.length) break;
    const rows = picked.filter((row) => !attempted.has(row.id)).slice(0, batchSize);
    if (!rows.length) {
      // Everything still queued already failed during this run. Stop instead of
      // spinning; the next boot starts with a fresh ledger.
      stalled = true;
      break;
    }
    for (const row of rows) {
      attempted.add(row.id);
      try {
        const text = [row.title, row.content].filter(Boolean).join("\n");
        const vector = await embedder.embedSingle(text);
        if (vector?.length) {
          store.setEmbedding(row.id, vector, model);
          indexed++;
        } else {
          // legacy OpenAI-compatible adapters signal failure by returning null
          // and drop the detailed reason inside embedText(), which only returns
          // the vector. "no vector came back" is all we can honestly claim.
          noteFailure("empty-vector");
        }
      } catch (error) { noteFailure(`error:${String(error)}`); }
    }
    done += rows.length;
    processed += rows.length;
    // Rate limit: space out batches so the provider is not hammered.
    if (pick(1).length) await new Promise((r) => setTimeout(r, rateLimitMs));
  }
  if (indexed > 0 && model) vectorIndex.markModel?.(model, embedder.dimension);
  // Two independent dimensions, because one number cannot answer both
  // questions the caller actually has:
  //   finishReason — why the loop stopped;
  //   failed/failureReasons — what was lost along the way.
  //
  // The old ternary had an unreachable branch: "all-failed" required
  // `!stillStale && failed > 0`, but a failed row is never written, so it is
  // still stale and `stillStale` is always true once anything failed. Four
  // failing rows out of four reported "capped" — as if the budget had run out
  // with work to spare. Invariant worth stating: failed > 0 implies
  // stillStale === true, therefore "drained" is only reachable with zero
  // failures.
  //
  // "capped" must mean *real work is left and the budget stopped us*, because
  // the scheduler re-runs on it. Two ways to be stuck without having made
  // progress, and both have to report "stalled":
  //   - `stalled`: the pick window held nothing but rows already attempted
  //     this run (small dead prefix, exhausted);
  //   - `indexed === 0`: a whole run produced not one vector. Measured on a
  //     dead prefix of >= maxWindow rows: every round's window is filled by
  //     failing rows, so `rows` is never empty, the loop exits on the budget
  //     with `stalled === false`, and "capped" made the scheduler re-run 21
  //     times — 10,500 provider calls, 0 rows embedded. With `indexed === 0`
  //     folded into "stalled", that run stops and the next boot is the retry
  //     point, exactly like any other no-progress run.
  // A run that embedded *something* and ran out of budget is still "capped":
  // the tail behind the dead prefix may well be reachable next round.
  //
  // But "no progress" alone cannot tell a dead row from a dead provider. Ten
  // healthy rows that all hit a 503 in one batch produce the same indexed === 0
  // as ten permanently broken ones — and reporting "stalled" for the former
  // sends the retry to the next boot, minutes or hours away, when the provider
  // was back a second later. The distinction is already in failureReasons:
  // adapter throws land in `error:`-prefixed buckets (transient), while a null
  // vector lands in `empty-vector` (permanent for that row, as far as we can
  // tell). So a no-progress run splits in two:
  //   - `errored`: nothing got through AND at least one throw — the provider
  //     was unreachable. Worth another round, but a much smaller budget than
  //     "capped", because a genuinely dead provider must not become an endless
  //     retry loop.
  //   - `stalled`: nothing got through and every failure was permanent. The
  //     next boot is the honest retry point.
  const stillStale = pick(1).length > 0;
  const transient = Object.keys(failureReasons).some((reason) => reason.startsWith("error:"));
  const noProgress = stalled || indexed === 0;
  const finishReason = !stillStale
    ? "drained"
    : noProgress
      ? (transient ? "errored" : "stalled")
      : "capped";
  logger?.info?.(
    `[dsh-mneme] auto-reindex backfilled ${indexed} embeddings (processed=${processed}, failed=${failed}, finish=${finishReason})`
  );
  return {
    indexed, processed, failed, finishReason, stillStale,
    // Keep this flag consistent with finishReason: a run that embedded nothing
    // also made no progress, and callers should not have to know that it got
    // there via the budget rather than via an exhausted window.
    stalled: finishReason === "stalled",
    // Only the reasons we can name; absent when nothing failed.
    failureReasons: failed > 0 ? { ...failureReasons } : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    model: model ?? null
  };
}

/**
 * Boot 回填调度器（#604）。
 *
 * 抽成模块级函数而不是留在 createSemantic 闭包里，是因为闭包形态此前**零测试
 * 覆盖**（全仓只有 index.js / serve.js 引用 createSemantic），而「一次启动只跑
 * 一轮、撞 cap 就停」正是靠这个缺口活了很久：没有任何用例能观察到「第二轮没
 * 排上」。
 *
 * 续排规则：
 *   - finishReason === "capped"（队列还有、额度用完）→ 排下一轮；
 *   - finishReason === "errored"（一条都没嵌上、且失败里有抛错）→ 排下一轮，
 *     但走更小的 maxErrorContinuations（默认 3）：瞬时 503 值得重试，provider
 *     真挂了不能靠 20 轮 × 500 行陪着耗；
 *   - finishReason === "stalled"（剩下的本轮全失败且都是永久性失败）→ 不排，
 *     下一轮启动再试；
 *   - 抛错 → 也排，但走同一个计数器，硬故障不会变成无限重试；
 *   - 计数到 maxContinuations 就停并告警。
 *
 * 计时器只有一个槽位：dispose 清它，且 disposed 后任何已排的回调都不再执行
 * —— 否则会对已关闭的库继续查 needsEmbedding（#365 CodeRabbit 踩过同一坑）。
 *
 * @param {object} opts
 *   store / vectorIndex / logger / cfg — 与 createSemantic 同形；
 *   getEmbedder()  — 取当前 embedder（可能为 null 或尚未 ready）；
 *   onStatus(next) — 接收 running / finished / error 快照；
 *   timing         — 仅供测试压缩等待：initialDelayMs / continueDelayMs /
 *                    maxContinuations / maxErrorContinuations /
 *                    readyRetryDelayMs，默认值与生产一致。
 * @returns {{ dispose: () => void, status: () => object|null }}
 */
export function scheduleBootBackfill({
  store, vectorIndex, logger, cfg,
  getEmbedder, onStatus = () => {},
  timing = {}
}) {
  const initialDelayMs = timing.initialDelayMs ?? 5000;
  const continueDelayMs = timing.continueDelayMs ?? 3000;
  const readyRetryDelayMs = timing.readyRetryDelayMs ?? 2000;
  // Hard stop on continuations: a provider that fails every row must not turn
  // into an endless retry loop for the life of the process. Reset per boot.
  const maxContinuations = timing.maxContinuations ?? 20;
  // Transient outages get their own, much smaller budget. A 503 that clears in
  // seconds deserves a retry; a provider that stays down must not be retried 20
  // times × 500 rows just because the failures look like throws rather than
  // nulls. Three rounds is enough to ride out a restart or a rate-limit blip.
  const maxErrorContinuations = timing.maxErrorContinuations ?? 3;

  let timer = null;
  let disposed = false;
  let continuations = 0;
  let errorContinuations = 0;
  let status = null;

  const publish = (next) => { status = next; onStatus(next); };
  const scheduleNext = (fn, delay) => {
    if (disposed) return;
    timer = setTimeout(fn, delay);
  };

  const attempt = (tries) => {
    if (disposed) return;
    try {
      const embedder = getEmbedder();
      if (!embedder || typeof embedder.embedSingle !== "function") return;
      if ("ready" in embedder && embedder.ready !== true) {
        // Local/ollama embedders init asynchronously; give them a moment
        // before giving up on this boot (next boot retries).
        // CodeRabbit on #365:嵌套重试计时器同样入册,否则 dispose 后仍可能
        // 对已关库跑 needsEmbedding(有 try/catch 兜底只是日志噪声,但状态要收干净)。
        if (tries > 0) scheduleNext(() => attempt(tries - 1), readyRetryDelayMs);
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
      const startedAt = new Date().toISOString();
      publish({
        state: "running", startedAt,
        maxTotal: cfg.reindexMaxPerBoot, batchSize: cfg.reindexBatchSize,
        continuation: continuations
      });
      backfillMissingEmbeddings({
        store, embedder, vectorIndex, logger,
        maxTotal: cfg.reindexMaxPerBoot,
        batchSize: cfg.reindexBatchSize,
        rateLimitMs: cfg.reindexRateLimitMs
      })
        .then((summary) => {
          if (disposed) return;
          publish({ ...summary, state: "finished", continuation: continuations });
          // Only "capped" means real work is left AND the budget ran out.
          // "stalled" means everything left already failed permanently this
          // run — trying again immediately would just burn the same rows, so
          // the next boot is the honest retry point.
          // "errored" means nothing got through because the provider threw:
          // that is worth a retry, but on its own short leash (see
          // maxErrorContinuations) so a provider that stays down cannot keep
          // the process busy for the life of the boot.
          if (summary.finishReason === "errored") {
            if (errorContinuations < maxErrorContinuations) {
              errorContinuations++;
              continuations++;
              scheduleNext(() => attempt(0), continueDelayMs);
            } else {
              logger?.warn?.(
                `[dsh-mneme] auto-reindex: the embedder kept failing (${maxErrorContinuations} retries); `
                + `${summary.indexed} embedded, the rest waits for the next start`
              );
            }
            return;
          }
          if (summary.finishReason !== "capped") return;
          if (continuations < maxContinuations) {
            continuations++;
            scheduleNext(() => attempt(0), continueDelayMs);
          } else {
            logger?.warn?.(
              `[dsh-mneme] auto-reindex hit the continuation limit (${maxContinuations}); `
              + `${summary.indexed} embedded, the rest waits for the next start`
            );
          }
        })
        .catch((error) => {
          if (disposed) return;
          publish({
            state: "error", error: String(error),
            startedAt: status?.startedAt ?? startedAt,
            continuation: continuations
          });
          logger?.warn?.(`[dsh-mneme] auto-reindex failed: ${String(error)}`);
          // A throwing backfill (closed database, bug) is retried too, but
          // under the same cap so a hard failure cannot loop forever.
          if (continuations < maxContinuations) {
            continuations++;
            scheduleNext(() => attempt(0), continueDelayMs);
          }
        });
    } catch (error) {
      // Synchronous throw before the promise exists: record it, otherwise the
      // panel shows "never ran" instead of "ran and failed".
      publish({
        state: "error", error: String(error),
        startedAt: status?.startedAt ?? new Date().toISOString(),
        continuation: continuations
      });
      logger?.warn?.(`[dsh-mneme] auto-reindex failed: ${String(error)}`);
    }
  };

  if (cfg.autoReindexOnBoot !== false) scheduleNext(() => attempt(5), initialDelayMs);

  return {
    dispose() {
      disposed = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
    status: () => status
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
  //
  // #604: a capped run used to be the end of the road until the next process
  // start — the boot backfill fired once, wrote lastBackfill, and nothing ever
  // rescheduled it. On this machine that meant a 500-row cap cleared the
  // backlog only across several restarts, and the only trace was a log line
  // nobody could see from the panel. The scheduler now continues inside the
  // same boot (bounded), and records why it stopped where it did.
  const backfill = scheduleBootBackfill({
    store, vectorIndex, logger, cfg,
    getEmbedder: () => embedder,
    onStatus: (next) => { lastBackfill = next; }
  });

  return {
    embedder,
    reranker,
    /** Last backfill run: { state, indexed, failed, finishReason, stillStale, ... }. */
    backfillStatus() {
      return lastBackfill;
    },
    /**
     * Embedding diagnostics for the status endpoint (#604): "is the vector
     * layer silently dead right now?" had no answer outside the process.
     * backfillStatus() covers the boot sweep, embedReceipts() covers writes.
     * Both are read-only snapshots; neither touches the database.
     */
    embeddingDiagnostics() {
      const receipts = typeof embedder?.embedReceipts === "function"
        ? embedder.embedReceipts()
        : null;
      return {
        backfill: lastBackfill,
        receipts: receipts
          ? {
            totals: receipts.totals,
            lastOkAt: receipts.lastOkAt,
            lastFailAt: receipts.lastFailAt,
            lastFailReason: receipts.lastFailReason,
            recent: Array.isArray(receipts.recent) ? receipts.recent.slice(-20) : []
          }
          : null
      };
    },
    dispose() {
      if (embedRetryTimer !== null) { clearTimeout(embedRetryTimer); embedRetryTimer = null; }
      // #604: the backfill scheduler owns its own (single) timer slot and its
      // own disposed flag, so a continuation that was already queued cannot
      // fire against a closed database after unload.
      backfill.dispose();
    }
  };
}
