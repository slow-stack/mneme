// #275 存储生命周期第一批：无损回收的维护入口。
//
// 为什么是「手动入口 + dry-run + receipt」而不是后台任务：这两步都是不可逆的内容
// 丢弃（历史 run 的输入快照置空、归档行的向量置空），该由人在看得见数字的时候按下
// （维护者 2026-09-23 拍板：不挂启动自动跑，VACUUM 约 0.8s 说明它就该是个随手跑的
// 东西）。所以模块里没有任何定时器，挂点只有两个：standalone 数据面的
// `POST /maintenance/reclaim` 与它上面的 `dsh-mneme reclaim` 子命令。
//
// 三项都零价值判断、零条数变化：
//   A `dream_runs.input` 置空。这一列的含义按 run_type 分叉：auto / sleep 的 run 存的
//     是当时的记忆库快照，可由记忆库重建；**organize 的 run 存的是 apply 的重放载荷**，
//     置空会让那次 apply 静默空转并把报告锁死，所以 organize 行不在可清范围内（谓词
//     在 store.dreamRunInputStats / clearDreamRunInputs 里）。run 的骨架、LLM 决策原文
//     与 receipt 一律保留，行永不删（拍板 3：裁列同意、删行不同意）。
//   B 归档行向量置空：检索 SQL 恒带 `archived = 0`，这部分向量按定义不可达。它不是
//     单程票——取消归档时 service 会重新排队嵌入（archiveMemory 的还原分支）。
//   C #399 蒸馏原文记录按 distilled_at 到期删除：记录是蒸馏那次调用的凭证，越旧越
//     没有复核价值，而它按定义就是整段对话原文（本入口里唯一的「真删内容」项，所以
//     它有自己的保留期配置键 distillRecords.retentionDays，不跟 A 的 7 天走）。链接
//     （memory_provenance）**不在可清范围内**：保留指向空区间即「来源已过期」，删链
//     接等于假装这条记忆从来没有过出处——那是篡改历史，不是回收。
//
// 报告口径（拍板 2）：收益按 VACUUM 前后体积量，不按列字节估——实际释放来自溢出页与
// 索引页回收，列文本大小只是上界，所以两个数分开报，不混成一个「省了多少」。
//
// 与 #254 的分界（拍板 4）：本入口止体积、不止重复。归档区里同主题堆积是出口问题，
// 归 #254 的写入准入与后续的整理动作面，这里一条记忆都不碰。
export const RECLAIM_TRIGGER_SOURCE = "maintenance";
export const RECLAIM_OPERATION_TYPE = "storage_reclaim";
// 输入快照的默认保留窗口：7 天内仍可能被离线回放（近期 run 的决策上下文），更早的
// 重建成本低于留存成本。窗口由调用方显式给，不做成配置键——配置键意味着有个周期性
// 消费者，而本批次刻意不接周期动作。
export const DEFAULT_INPUT_RETENTION_DAYS = 7;

/**
 * 无损回收（#275 第一批）。返回一个函数：同一条代码路径跑 dry-run 与执行，dry-run
 * 只是不落 UPDATE/VACUUM，所以「报出来的数字」与「执行时的数字」出自同一处统计。
 *
 * @param {object} deps
 * @param {object} deps.store 存储层（dreamRunInputStats / clearDreamRunInputs /
 *   archivedEmbeddingStats / clearArchivedEmbeddings / distillRecordStats /
 *   clearDistillRecords / storageStats / vacuum / saveLlmAudit）
 * @param {object} [deps.config] 已解析配置（读 llmAudit.enabled：关掉 audit 时不落 receipt）
 * @param {object} [deps.logger]
 * @param {() => number} [deps.now] 时钟注入（测试用）
 */
export function createMaintenance({ store, config, logger, now = Date.now } = {}) {
  const warn = (msg) => {
    try {
      logger?.warn?.(msg);
    } catch { /* 日志故障不能影响回收本身 */ }
  };

  /** receipt 落到 llm_audit_logs（既有 bookkeeping 表，不触发写钩子）。 */
  function writeReceipt(report) {
    if (config?.llmAudit?.enabled === false) return null;
    try {
      const row = store.saveLlmAudit({
        trigger_source: RECLAIM_TRIGGER_SOURCE,
        operation_type: RECLAIM_OPERATION_TYPE,
        // 不是模型调用，但该列 NOT NULL——用显式占位串，免得混进按路由分组的花费统计。
        model_id: "-",
        status: "success",
        metadata: {
          older_than_days: report.olderThanDays,
          cleared: report.cleared,
          size_before: report.size.before_bytes,
          size_after: report.size.after_bytes,
          vacuum: report.vacuum.ran,
          duration_ms: report.duration_ms
        }
      });
      return row?.id ?? null;
    } catch (e) {
      // 回执失败只 warn：清理已经发生了，不能因为记不上账就当作没发生（也不能反噬）。
      warn(`[dsh-mneme] storage reclaim receipt failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.olderThanDays] 输入快照的保留窗口（天）；0 = 清掉全部快照
   * @param {boolean} [opts.vacuum] 是否在清理后 VACUUM（默认否：它要排他锁，由人决定）
   * @param {boolean} [opts.dryRun] 默认 true——只报数字，不改一个字节
   * @returns {object} 报告（dry-run 与执行同形状，执行时多 receipt 字段）
   */
  function reclaim({ olderThanDays = DEFAULT_INPUT_RETENTION_DAYS, vacuum = false, dryRun = true } = {}) {
    const days = Number.isFinite(olderThanDays) && olderThanDays >= 0 ? olderThanDays : DEFAULT_INPUT_RETENTION_DAYS;
    const cutoff = new Date(now() - days * 86400000).toISOString();
    const started = now();
    const before = store.storageStats();
    const inputs = store.dreamRunInputStats(cutoff);
    const embeddings = store.archivedEmbeddingStats();
    // #399：蒸馏原文记录与上面两项同款——按 distilled_at 到期裁剪。链接
    // （memory_provenance）不在此列：它保留指向空区间，显示「来源已过期」。
    const records = store.distillRecordStats(cutoff);
    const report = {
      dryRun,
      olderThanDays: days,
      cutoff,
      // planned = 这次会动几行；cleared = 实际动了几行（dry-run 恒 0）
      planned: {
        dream_run_inputs: inputs.runs,
        archived_embeddings: embeddings.rows,
        distill_records: records.rows
      },
      // 列文本大小：上界，不是回收量（真实释放看下面的 size 差值）
      column_bytes: {
        dream_run_inputs: inputs.bytes,
        archived_embeddings: embeddings.bytes,
        distill_records: records.bytes
      },
      cleared: { dream_run_inputs: 0, archived_embeddings: 0, distill_records: 0 },
      size: {
        before_bytes: before.fileBytes,
        after_bytes: before.fileBytes,
        // 空闲页就是「现在 VACUUM 能立刻收回来的那部分」，带上它 dry-run 才有个能
        // 参照的量（真实数字仍然只有做完才知道）
        freelist_pages: before.freelistCount,
        freelist_bytes: before.freelistCount * before.pageSize,
        page_count: before.pageCount
      },
      vacuum: { requested: vacuum === true, ran: false, duration_ms: null, error: null },
      receipt: null,
      duration_ms: 0
    };
    if (dryRun) {
      report.duration_ms = now() - started;
      return report;
    }
    report.cleared.dream_run_inputs = store.clearDreamRunInputs(cutoff);
    report.cleared.archived_embeddings = store.clearArchivedEmbeddings();
    report.cleared.distill_records = store.clearDistillRecords(cutoff);
    if (report.vacuum.requested) {
      // VACUUM 失败不能把前面的清理一起吞掉：两个 UPDATE 已经各自提交了，此时抛出去
      // 就是「数据已经不可逆地清了，但没有任何回执」。所以失败记进报告、回执照写，
      // 让调用方看到「清了 N 行，VACUUM 没跑成」——锁被别的进程占着（SQLITE_BUSY）是
      // 最常见的成因，重跑一次 --apply --vacuum 即可（清理是幂等的）。
      try {
        const result = store.vacuum();
        report.vacuum.ran = true;
        report.vacuum.duration_ms = result.duration_ms;
      } catch (e) {
        report.vacuum.error = String(e);
        warn(`[dsh-mneme] storage reclaim vacuum failed: ${String(e)}`);
      }
    }
    const after = store.storageStats();
    report.size.after_bytes = after.fileBytes;
    report.size.freelist_pages = after.freelistCount;
    report.size.freelist_bytes = after.freelistCount * after.pageSize;
    report.size.page_count = after.pageCount;
    report.duration_ms = now() - started;
    report.receipt = writeReceipt(report);
    return report;
  }

  return { reclaim };
}
