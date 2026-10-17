/**
 * M.O. 的**执行窗口**：一次 run 从「有人决定按这条工作流走一遍」开始记账，到这一遍结束为止。
 *
 * ## 为什么是「窗口」而不是「自动观察一切」
 *
 * 这是本模块存在的核心理由，也是接线前必须先想清楚的一件事：
 *
 * 宿主钩子（`tools/pre-execute` 等）能看到「这次调了什么工具」，但它**看不到「正在走哪条
 * 工作流」**。工作流的 `trigger` 字段是人话（`{kind:"phrase", value:"发版"}`），今天没有任何
 * 代码消费它；想靠它自动判定「用户说这句话就意味着开始走某条流程」，只能猜——而猜错的代价
 * 是把一条**从没跑过的流程**记成跑过。那正是本仓反复防的「伪造正面证据」。
 *
 * 所以窗口的边界由**显式动作**划：有人（或按人指令的 agent）说明「现在按 X 走一遍」，窗口才开；
 * 窗口内的工具调用才可能被记账；窗口一关就 flush 成一条 run。**窗口之外发生的一切一个字都不记**
 * ——漏记账是可接受的，编造账不是。
 *
 * ## 一次观察有三种结局，必须分开
 *
 * - **归属成功**：写进这次 run 的 `steps`
 * - **归属不了**：进 `unattributed`。它在图上是「没走这条路的痕迹」，即绕开的候选——
 *   但它**还没被确认**是这条流程的一步，所以不进 `steps`
 * - **归属有歧义**：进 `ambiguous`，**不猜**，留给人消歧
 *
 * 三者分开报的纪律与账本那边一致：**「认不出来」与「没做」必须长得不一样**，
 * 否则一份全是 unattributed 的账会被读成「这次什么也没做」。
 *
 * ## 唯一没被记下来的东西：失败
 *
 * 账本契约要求一条 run 至少有一个步骤（`run.steps 至少要有一条`），所以「开了窗口、
 * 一步都没走成」目前**落不成账**。这是已知缺口，本模块如实返回 `reason:"no-steps"`，
 * 不伪造一条空 run 去凑。要真正表示失败，得先改账本契约（让零步 run 合法）。
 */

import { attributionCandidates } from "./pipeline-attribution.js";

/** 一次观察被拒的三种原因；调用方据此决定要不要请人消歧。 */
export const OBSERVED = "observed";
export const UNATTRIBUTED = "unattributed";
export const AMBIGUOUS = "ambiguous";

function toIso(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error("时间必须能解析成 ISO");
  return new Date(ms).toISOString();
}

/**
 * 开一个记录窗口。
 *
 * `pipeline` 是这次要走的**那一条**工作流（由调用方点名，不由本模块猜）。
 * `by` / `triggeredBy` 落进 run 的描述字段：账本里「谁做的」「为什么这次会跑」要有出处。
 */
export function openRun({ pipeline, by = "main", triggeredBy = "", now = () => new Date() } = {}) {
  if (!pipeline || !Array.isArray(pipeline.steps)) {
    throw new Error("openRun 需要一条工作流（含 steps）");
  }

  const startedAt = toIso(now());
  /** stepId → { at, refuted, repeats }；同一步在一个窗口里只计一次，重复的进 repeats。 */
  const steps = new Map();
  const unattributed = [];
  const ambiguous = [];
  let observations = 0;
  let closed = null;

  /** 记下一步。同一步重复出现时不重复计数（`tallyRuns` 按 run 计数，重复会让 uses 虚高）。 */
  function record(stepId, at, refuted) {
    const existing = steps.get(stepId);
    if (existing) {
      existing.repeats += 1;
      // 任何一次失败都算被推翻过——「跑砸过一次」不该被后来的成功抹掉。
      if (refuted) existing.refuted = true;
      return existing;
    }
    const entry = { id: stepId, at, refuted, repeats: 0 };
    steps.set(stepId, entry);
    return entry;
  }

  return {
    /**
     * 观察一次工具动作。
     *
     * `stepId` 是**人确认过的归属**：给了就直接记，不再走匹配（人说了算）。
     * 不给则按归属规则自动判——只有 `exact` 且唯一时才自动记账；
     * 多候选或只有 weak 一律进 `ambiguous`，**绝不自选一条**。
     */
    observe(observation, { stepId = null, at = null } = {}) {
      if (closed) return { accepted: false, result: "run-closed" };
      observations += 1;
      const when = toIso(at ?? now());
      const failed = observation && observation.ok === false;

      if (stepId) {
        record(stepId, when, failed);
        return { accepted: true, result: OBSERVED, stepId, resolved: "explicit" };
      }

      const candidates = attributionCandidates(observation, pipeline);
      if (candidates.length === 0) {
        unattributed.push({ observation, at: when });
        return { accepted: false, result: UNATTRIBUTED };
      }

      const exact = candidates.filter((c) => c.confidence === "exact");
      if (candidates.length === 1 && exact.length === 1) {
        record(exact[0].stepId, when, failed);
        return { accepted: true, result: OBSERVED, stepId: exact[0].stepId, resolved: "exact" };
      }

      // 弱匹配、多候选都走这里：图省事挑一条就是替人做决定，而挑错的代价是染色错误的一步。
      ambiguous.push({ observation, at: when, candidates });
      return { accepted: false, result: AMBIGUOUS, candidates };
    },

    /** 只看状态，不结账。给「这一遍走到哪了」这种实时查询用。 */
    state() {
      return {
        open: closed === null,
        pipelineId: pipeline.id,
        startedAt,
        observations,
        recorded: [...steps.values()].map((s) => s.id),
        unattributed: unattributed.length,
        ambiguous: ambiguous.length
      };
    },

    /**
     * 结账：产出一条**还没落盘**的 run（落盘由调用方做 `appendRun`，本模块不碰文件系统）。
     *
     * `steps` 里只有**真被观察到**的步骤。没观察到的步骤既不写 `skipped` 也不写 `used`——
     * 缺席不等于跳过（可能是归属没认出来），把它写成跳过就是编造。它们进 `unobserved`，
     * 让人自己看。
     */
    close() {
      if (closed) return closed;
      const runSteps = [...steps.values()].map((s) => ({
        id: s.id,
        at: s.at,
        skipped: false,
        detoured: false,
        refuted: s.refuted === true,
        note: s.repeats > 0 ? `这一步在窗口内被观察到 ${s.repeats + 1} 次，只计一次` : ""
      }));
      const observedIds = new Set(runSteps.map((s) => s.id));
      const unobserved = pipeline.steps.map((s) => s.id).filter((id) => !observedIds.has(id));

      const base = {
        startedAt,
        endedAt: toIso(now()),
        pipelineId: pipeline.id,
        observations,
        unattributed,
        ambiguous,
        unobserved
      };

      if (runSteps.length === 0) {
        // 契约要求至少一步，所以这一步落不成账。如实说，不伪造。
        closed = { ...base, run: null, reason: "no-steps" };
        return closed;
      }

      closed = {
        ...base,
        run: { at: startedAt, by, triggeredBy, steps: runSteps },
        reason: null
      };
      return closed;
    }
  };
}
