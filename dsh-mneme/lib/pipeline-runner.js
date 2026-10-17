/**
 * M.O. 的**执行记录器**：把「谁在什么时候按哪条工作流走了一遍」记成一条账。
 *
 * ## 它在整条链里的位置
 *
 *     session/event → pairObservations → attributionCandidates → openRun → appendRun
 *      （宿主事件）    （事件→观察）        （观察→哪一步）        （窗口）   （落盘）
 *
 * 前四段都已各自成模块并被测过。本模块是**把它们串起来的那一层**，也是唯一持有
 * 「当前有哪些窗口开着」这个状态的地方。
 *
 * ## 四个刻意的取舍
 *
 * 1. **窗口按会话开，一个会话同时只允许一个**。一次执行是「这条流程走一遍」，不是
 *    「同时走两条」。再开一个会被**拒**（`already-open`）而不是顶掉前一个——顶掉会让
 *    前一次的执行悄无声息地消失，那比拒绝难查得多。
 *
 * 2. **事件先缓冲、到 stop 才配对**。`tool/call` 与 `tool/result` 靠 callId 配对，结果
 *    可能比调用晚很久；边到边配会把「还没等到结果」误判成「没有这个调用」。
 *
 * 3. **v1 只在显式 stop 时结账**，不在回合结束时自动关。一条流程常常跨多个回合
 *    （跑测试 → 等人点头 → 再继续），按回合关会把一次执行切成好几条半截账。
 *    代价是忘了 stop 会一直开着——所以缓冲有上限，超了标 `truncated` 并如实写出。
 *
 * 4. **热路径上永不抛**。挂的是宿主每个会话事件的通道，本仓对此有明文不变量
 *    （`continuity.js` 的「可选插件的可选能力把 agent 的一步带崩，比丢一次抢救严重
 *    得多」）。所有异常只 `warn`，绝不让宿主的一步失败。
 *
 * ## 一个尚未实测的前提
 *
 * `session/event` 的实时通道是否**逐条**投递 `tool/call` 与 `tool/result`，我没有在
 * 活宿主上验过（本仓现有消费者只用 `turn/end` 与压缩边缘；工具事件是从**日志文件**
 * 读的）。事件类型联合与落盘日志都包含它们，所以同一通道应当也带——但这是**推断**，
 * 接线后要用一次真实执行验证（开窗走一遍，看账里有没有步骤）。本模块把这件事做成
 * 可观测的：`stop()` 的返回里给出缓冲到多少条事件，一条都没缓冲到时会有
 * `reason:"no-observations"`，而不是写一条空账假装成功。
 */

import { loadPipelines, pipelineSources } from "./pipeline.js";
import { appendRun } from "./pipeline-runs.js";
import { openRun } from "./pipeline-exec.js";
import { pairObservations } from "./pipeline-observe.js";
import { tallyActivities } from "./pipeline-activities.js";
import { buildProposal, runFromAnswers } from "./pipeline-confirm.js";
import { observationDir, saveObservations, toolMismatches } from "./pipeline-observations.js";
import { projectKey } from "./candidates.js";

/** 一个窗口最多缓冲多少条会话事件。忘了 stop 时，这是内存的兜底。 */
export const MAX_BUFFERED_EVENTS = 4000;

/**
 * 会话的工作目录。与 `scope.js` 同一口径：`session.header` 是创建时冻结的那份
 * （含 `cwd`），**不能先读 `requestHeader()`** —— 那返回请求级模型路由头，会把
 * `cwd` 遮蔽掉（scope.js 里记着本地 web 实测踩中过）。
 */
export function projectRootOf(session) {
  const header = session?.header ?? session?.requestHeader?.()?.config ?? null;
  const cwd = header?.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd : null;
}

/**
 * 默认的工作流解析：项目层优先、全局层兜底（与 `readPipelineDoc` 同一优先级）。
 *
 * 坏文件按 `loadPipelines` 的纪律**照抛**，由调用方兜住并如实回报——静默跳过会让
 * 「这条流程读不出来」与「没有这条流程」长得一样。
 */
export function defaultResolvePipeline(projectRoot, pipelineId) {
  for (const source of pipelineSources({ projectRoot })) {
    const list = loadPipelines(source.dir, { scope: source.scope, label: source.label });
    const hit = list.find((p) => p.id === pipelineId);
    if (hit) return hit;
  }
  return null;
}

/** 所有工作流的 id 清单（给命令的用法提示与「你指的是哪条」用）。 */
export function listPipelineIds(projectRoot) {
  const ids = [];
  try {
    for (const source of pipelineSources({ projectRoot })) {
      for (const p of loadPipelines(source.dir, { scope: source.scope, label: source.label })) {
        if (!ids.includes(p.id)) ids.push(p.id);
      }
    }
  } catch {
    // 清单只是提示信息，读不出来不该让命令本身失败。
  }
  return ids;
}

/**
 * 造一个记录器。
 *
 * 除了 `ctx` 之外的所有依赖都可注入（`resolvePipeline` / `persistRun` / `now`），
 * 这样测试不必碰真文件系统，也能精确控制时间。
 */
export function createExecutionRecorder({
  ctx,
  logger = null,
  resolvePipeline = defaultResolvePipeline,
  persistRun = appendRun,
  now = () => new Date(),
  maxBufferedEvents = MAX_BUFFERED_EVENTS,
  // P3（丙）：观察旁挂的根目录。null = 不落旁挂（P3 静默关闭）。
  // 与 resolvePipeline/persistRun 同款依赖注入——runner 不读 config，测试不碰真文件系统。
  memoryDir = null
} = {}) {
  const windows = new Map(); // sessionId → { pipeline, projectRoot, run, events, truncated }
  // 已结账、等人确认的会话：sessionId → { pipeline, projectRoot, proposal, stats }
  const pending = new Map();

  const unsubscribe = ctx?.on?.("session/event", (session, event) => {
    try {
      const id = session?.id;
      if (!id) return;
      const w = windows.get(id);
      // 没有开窗 = 一个字都不记。这是整个设计的地基：漏记可接受，编造不可。
      if (!w) return;
      const type = event?.type;
      if (type !== "tool/call" && type !== "tool/result") return;
      if (w.events.length >= maxBufferedEvents) {
        w.truncated = true;
        return;
      }
      w.events.push(event);
    } catch (error) {
      logger?.warn?.(`dsh-mneme: 执行记录器读事件失败：${String(error)}`);
    }
  });

  return {
    /**
     * 开窗。`pipelineId` 由调用方点名——**本模块不猜**「用户刚才那句话是不是意味着
     * 开始走某条流程」。猜错会把一条从没跑过的流程记成跑过。
     */
    start({ session, pipelineId } = {}) {
      const id = session?.id;
      if (!id) return { ok: false, reason: "no-session" };
      const open = windows.get(id);
      if (open) return { ok: false, reason: "already-open", pipelineId: open.pipeline.id };

      const projectRoot = projectRootOf(session);
      if (!projectRoot) return { ok: false, reason: "no-project-root" };

      let pipeline;
      try {
        pipeline = resolvePipeline(projectRoot, pipelineId);
      } catch (error) {
        return { ok: false, reason: "pipeline-unreadable", detail: String(error?.message ?? error) };
      }
      if (!pipeline) {
        return { ok: false, reason: "pipeline-not-found", available: listPipelineIds(projectRoot) };
      }

      const run = openRun({ pipeline, by: "main", triggeredBy: String(pipelineId ?? ""), now });
      windows.set(id, { pipeline, projectRoot, run, events: [], truncated: false });
      return { ok: true, pipelineId: pipeline.id, steps: pipeline.steps.length };
    },

    /**
     * 结账：**不再自动写账**，改成产出一份「请你确认哪几步走了」的提案。
     *
     * 这是 P2 的契约变更，理由是被实测否决的自动归属（详见 pipeline-confirm 的文件头）：
     * 机器唯一归属只有 14.2%，而**猜错的代价是把没走过的步骤记成走过**
     * （`deriveState` 会据此把它染成 trusted）。所以写账这一步必须有人确认。
     *
     * 自动归属的结果**降级成 hint**：仍然算出来，但只作提示、不预选、不落盘。
     * 同时给出 P1 那份「观察到的业务动作清单」，让人对照着勾。
     */
    stop({ session } = {}) {
      const id = session?.id;
      if (!id) return { ok: false, reason: "no-session" };
      const w = windows.get(id);
      if (!w) return { ok: false, reason: "no-open-window" };
      windows.delete(id);

      const { observations, dangling, notCommands } = pairObservations(w.events);

      // 自动归属只用来产 hint：唯一 exact 的那一步给出来，其余不给。
      // 它不进账——这一版的账只有人能写。
      const hints = {};
      for (const observation of observations) {
        const r = w.run.observe(observation);
        if (r.result === "observed" && r.stepId) {
          // hint 只记「这次见到过相近的命令」这个事实，**不存命令行原文**：
          // 完整命令行含绝对路径（路径含本机用户名），而这条 hint 会流到命令回执里。
          hints[r.stepId] = (hints[r.stepId] || 0) + 1;
        }
      }

      const activityTally = tallyActivities(observations);
      const proposal = buildProposal({
        pipeline: w.pipeline,
        activities: activityTally.activities,
        hints
      });

      // 待确认状态挂在会话上：人在下一次调用里回答。
      // stats 只留**确认阶段真的会渲染**的三个字段（ponytail 复核：另外三个零读取）。
      pending.set(id, {
        pipeline: w.pipeline,
        projectRoot: w.projectRoot,
        proposal,
        // P3（丙）：把本次观察清单带进待确认状态。confirm 时它有三个用途：
        // 旁挂落盘 / tool 不符检出 / 回执展示。memoryDir 为空时不带（P3 关）。
        activities: activityTally.activities,
        stats: {
          truncated: w.truncated,
          notCommands,
          shellNoise: activityTally.shellNoise
        }
      });

      return {
        ok: true,
        state: "awaiting-confirmation",
        proposal,
        activities: activityTally.activities,
        shellNoise: activityTally.shellNoise,
        bufferedEvents: w.events.length,
        truncated: w.truncated,
        observations: observations.length,
        notCommands,
        dangling: dangling.length
      };
    },

    /**
     * 人确认后落盘。**这是唯一会写账的入口。**
     *
     * `answers` 形如 `{ "P6": "done", "V2": "notDone" }`；未提到的步骤什么都不写
     * （"没确认"不等于"没发生"，见 pipeline-confirm 的注释）。
     */
    confirm({ session, answers } = {}) {
      const id = session?.id;
      if (!id) return { ok: false, reason: "no-session" };
      const p = pending.get(id);
      if (!p) return { ok: false, reason: "nothing-to-confirm" };

      const result = runFromAnswers({
        pipeline: p.pipeline,
        answers,
        by: "human",
        triggeredBy: String(p.pipeline.id ?? ""),
        now
      });

      if (result.kind === "error") {
        // 回答非法：**保留待确认状态**，让人重答，而不是把它丢掉。
        return { ok: false, reason: result.reason, stepId: result.stepId, value: result.value, ...p.stats };
      }

      if (result.kind === "nothing") {
        // 什么都没确认：没有信息可记，如实说，且不留一个悬着的待确认状态。
        pending.delete(id);
        return {
          ok: false,
          reason: "no-answers",
          notDone: result.notDone,
          unanswered: result.unanswered,
          unsure: result.unsure,
          ...p.stats
        };
      }

      pending.delete(id);
      try {
        persistRun(p.projectRoot, p.pipeline.id, result.run);
      } catch (error) {
        return { ok: false, reason: "write-failed", detail: String(error?.message ?? error), ...p.stats };
      }

      // ── P3：人确认过的事实，与本次观察到的动作对一遍 ──────────────────
      // ① tool 不符检出：人说了 done、但声明的 tool 在本次动作里没出现。
      //    这是「步骤表可能与实际行为脱节」的信号（实测：gh pr merge --rebase 在
      //    21723 次调用里出现 0 次）。**只报告，不改步骤表**——改表是人的动作。
      const doneIds = new Set(result.run.steps.filter((s) => !s.skipped).map((s) => s.id));
      let toolMismatchesResult = { ok: true, items: [] };
      if (Array.isArray(p.activities)) {
        toolMismatchesResult = toolMismatches({
          pipeline: p.pipeline,
          confirmedDone: doneIds,
          activities: p.activities
        });
      }
      // ② 观察旁挂（丙）：memoryDir 给了才落。写失败**不连累记账**——旁挂是
      // 可再生的辅助数据（同一 run 重走一遍就有），账本才是唯一事实。
      let observationsSaved = null;
      if (memoryDir && Array.isArray(p.activities)) {
        const key = projectKey(p.projectRoot);
        const odir = observationDir({ memoryDir, projectKey: key });
        if (odir) {
          try {
            observationsSaved = saveObservations({
              dir: odir,
              pipelineId: p.pipeline.id,
              confirmAt: result.run.at,
              activities: p.activities
            });
          } catch (error) {
            logger?.warn?.(`dsh-mneme: 观察旁挂写入失败（不影响记账）：${String(error)}`);
          }
        }
      }

      return {
        ok: true,
        pipelineId: p.pipeline.id,
        steps: result.run.steps.length,
        // 三类如实分开：「确认没做」「说不知道」「压根没答」是三种不同的信息
        notDone: result.notDone,
        unsure: result.unsure,
        unanswered: result.unanswered,
        // P3 的两个产出：不符清单（人判「声明该改还是本来不必敲」）与旁挂回执
        toolMismatches: toolMismatchesResult.ok ? toolMismatchesResult.items : [],
        observationsSaved: observationsSaved
          ? { ok: true, file: observationsSaved.file, lines: observationsSaved.lines, duplicate: observationsSaved.duplicate === true }
          : { ok: false, skipped: true },
        ...p.stats
      };
    },

    /** 只看状态，不结账。要能分辨「窗口开着」与「等你确认」两种状态。 */
    status({ session } = {}) {
      const id = session?.id;
      if (pending.has(id)) {
        const p = pending.get(id);
        return { open: false, awaitingConfirmation: true, pipelineId: p.pipeline.id, steps: p.proposal.steps.length, ...p.stats };
      }
      const w = windows.get(id);
      if (!w) return { open: false };
      return { ...w.run.state(), bufferedEvents: w.events.length, truncated: w.truncated };
    },

    dispose() {
      try {
        unsubscribe?.();
      } catch {
        /* 重复 dispose 不报错 */
      }
      windows.clear();
      pending.clear();
    }
  };
}
