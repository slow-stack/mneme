// 冲突分诊（issue #641 beta 第一阶段，shadow 档）：把 findPotentialConflicts 送进
// 冲突相位的每一对，先过确定性分诊，落进 conflict_ledger 账本。
//
// 为什么分诊先行：真实库 788 对人审队列的全量分类（只读挖掘，口径见 #641 正文）
// ——46% 近重复 + 20% 跨作用域重复 + 5% 时序演进，真矛盾只有 ~27%。前 71% 是该被
// 机械处置（merge / 去重 / 取代链）的工作量，现行窄 prompt（conflict/keep 二选一）
// 把它们全逼成了「输赢」，再由人来逐对裁决（≈30 条/天，且 92% 的对从未两侧同场）。
// 分诊把「谁该机械处理、谁才是真矛盾」从 LLM 手里拿回来：E13b 实测 winner-take-all
// 裁决 P(毒胜出)=86.8%，LLM 在这条链上只允许降级为分类器。
//
// 四档判据（全部确定性，本文件是唯一实现；enforce 阶段的处置接线另有 PR，本文件
// 在 shadow 档只产分类与信号，不做任何记忆行处置）：
//   cross-scope-dup  任一 scope 维键不同——同一内容落两个归属（#170 scopeReason 口径，
//                    真实库占 20%）
//   dup              同 scope + sim ≥ dupMin + created_at 差 < 24h——同日双录
//                    （真实库 76% 的对两侧差 <1 天；#616 实测 55-57% 的新条反而更短，
//                    新鲜度对这类对无区分力，后续处置按信息量裁决）
//   evolution        同 scope + created_at 差 ≥ 7 天——时序演进展期（T3 superseded_by
//                    取代链的候选池，enforce 阶段接线；entity_attrs 失效信号并入也在
//                    那一步，见 #585）
//   conflict         其余——真矛盾残余（真实库 ~27%；账本标记，消解推迟到检索时/
//                    会话纠正/巩固重蒸馏三时刻）
//
// 「未标注 scope」不算跨作用域：scopeKeyOf 把 NULL 归一成 null，两条都未标注时
// null !== null 为 false、判同档——#616 指出这个判据用于**自动归档**是洞（归属未知
// ≠归属相同），但在 shadow 分诊里零处置、无害；signals.annotated=false 显式落账，
// 让分析时能把「未标注」切出来，而不是让它静默混进同 scope 桶。
import { scopeKeyOf } from "../scope.js";

const DAY_MS = 86_400_000;

// T1（dup）与 T3（evolution）的时间界。24h 来自真实库分布（76% 的对 <1 天，且
// 1-7 天区间的「疑似同日双录」残留在 1-7 天档里很难与快速演进区分，宁保守归
// conflict——分诊错档在 shadow 期只是统计噪音，enforce 后错档会错杀）；7 天是
// 演进展期的保守下限，真实库 7 天以上的对仅 0.5%（4/788）。
export const DUP_MAX_AGE_MS = DAY_MS;
export const EVOLUTION_MIN_AGE_MS = 7 * DAY_MS;

export const LEDGER_TIERS = ["dup", "cross-scope-dup", "evolution", "conflict"];

/**
 * Classify one candidate pair into a ledger tier. Pure function — no I/O, no
 * config dependency beyond the tunables passed in, so the same verdict is
 * reproducible from the recorded signals alone.
 *
 * @param {object} a candidate side A (needs agent_scope, workspace_scope, created_at)
 * @param {object} b candidate side B
 * @param {number} similarity detector cosine similarity (pair already passed the
 *        detection threshold, so ≥ ~0.75-0.92 depending on strictness)
 * @param {{dupMinSimilarity?: number, now?: number}} opts dupMin 默认 0.90（#616
 *        重测：0.95 在现库覆盖为 0，真实库 reason 相似度回声集中在 0.85-0.93，
 *        0.90 是把回声带接进 dup 档的落点）；now 仅测试注入
 * @returns {{tier: string, signals: object}}
 */
export function triagePair(a, b, similarity, opts = {}) {
  const dupMin = typeof opts.dupMinSimilarity === "number" ? opts.dupMinSimilarity : 0.9;
  const now = typeof opts.now === "number" ? opts.now : Date.now();

  const crossScope =
    scopeKeyOf(a.agent_scope) !== scopeKeyOf(b.agent_scope) ||
    scopeKeyOf(a.workspace_scope) !== scopeKeyOf(b.workspace_scope);
  const annotated = (a.agent_scope != null || a.workspace_scope != null) &&
    (b.agent_scope != null || b.workspace_scope != null);

  // created_at 缺失不下结论：宁归 conflict（账本里最保守的一档），也不编造时间信号。
  const createdA = Date.parse(a.created_at ?? "");
  const createdB = Date.parse(b.created_at ?? "");
  const gapKnown = Number.isFinite(createdA) && Number.isFinite(createdB);
  const gapDays = gapKnown ? Math.abs(createdA - createdB) / DAY_MS : null;

  let tier;
  if (crossScope) {
    tier = "cross-scope-dup";
  } else if (gapKnown && typeof similarity === "number" && similarity >= dupMin && gapDays < DUP_MAX_AGE_MS / DAY_MS) {
    tier = "dup";
  } else if (gapKnown && gapDays * DAY_MS >= EVOLUTION_MIN_AGE_MS) {
    tier = "evolution";
  } else {
    tier = "conflict";
  }

  return {
    tier,
    signals: {
      crossScope,
      annotated,
      gapDays: gapDays == null ? null : Math.round(gapDays * 1000) / 1000,
      dupMin,
      similarity: typeof similarity === "number" ? similarity : null
    }
  };
}

/**
 * Triage + record every selected pair into the conflict_ledger. Bookkeeping
 * only: a store failure on one pair must never fail the phase (same
 * best-effort discipline as saveConflictReviewed / saveDifferentiatedPair —
 * 记账本身绝不能反过来把巩固打断）。
 *
 * 分块 + 让出（#643 review）：候选池大时同步写完全部对会连续占用事件循环、
 * 延迟用户活动与取消信号的处理——每块之间 setImmediate 让出一次，并在每块
 * 开始前检查 signal.aborted。取消后停止记账，余下的对下一轮自然重见；**不用
 * 固定上限裁剪观察样本**（shadow 的分母必须完整，截断只来自取消，且在
 * tally.truncatedAt 可见——静默截断会让分布失真，比没有数据更糟）。
 *
 * @returns Promise<tally> {dup, cross-scope-dup, evolution, conflict, recorded,
 *          failed, truncatedAt} — truncatedAt 非 null 表示取消点（已处理的对数）
 */
export async function recordLedgerTriage(service, runId, pairs, opts = {}) {
  const tally = { dup: 0, "cross-scope-dup": 0, evolution: 0, conflict: 0, recorded: 0, failed: 0, truncatedAt: null };
  const CHUNK = 50;
  for (let start = 0; start < pairs.length; start += CHUNK) {
    // 块间让出事件循环（首块前不用——pairs 为空或单块时零额外宏任务）
    if (start > 0) await new Promise((resolve) => setImmediate(resolve));
    if (opts.signal?.aborted) {
      tally.truncatedAt = start;
      break;
    }
    for (const p of pairs.slice(start, start + CHUNK)) {
      try {
        const verdict = triagePair(p.a, p.b, p.similarity, opts);
        service.saveConflictLedgerEntry({
          run_id: runId,
          memory_a: p.a.id,
          memory_b: p.b.id,
          tier: verdict.tier,
          similarity: p.similarity,
          signals: verdict.signals
        });
        tally[verdict.tier] += 1;
        tally.recorded += 1;
      } catch (error) {
        tally.failed += 1;
        opts.logger?.warn?.(`dsh-mneme sleep: failed to record ledger triage for ${p.a?.id}/${p.b?.id}: ${String(error)}`);
      }
    }
  }
  return tally;
}
