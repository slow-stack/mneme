/**
 * M.O. 的人确认层：把「本次观察到什么」变成「哪几步真的走了」。
 *
 * ## 为什么必须由人来说
 *
 * 自动归属被实测否决（详见 mneme-research 的 08/09）：
 * - 拿单条命令匹配手写步骤表，唯一归属只有 **14.2%**；非发版会话也有 4.4%，**区分力仅 3 倍**
 * - 放宽到"包含匹配"，天花板仍 14%，且大头是 `git log` / `git diff` 这类通用命令
 * - 工作流里的关键步骤 `gh pr merge --rebase` 在 21723 次调用里**出现 0 次**——
 *   说明清单本身可能与实际行为脱节
 *
 * 归到本文档的一句话：**机器猜不准，而猜错的代价是把没走过的步骤记成走过**
 * （`deriveState` 会据此把它染成 `trusted`）。所以这一步交给人。
 *
 * ## 三个设计决定
 *
 * 1. **提案不改动任何东西**。`buildProposal` 是纯函数，产出的是"给人看的待确认清单"。
 *    写账只发生在 `confirm` 之后，且只写人点过的步骤。
 * 2. **"不确定"是一个合法的答案**。人可以对某一步说"我不知道"——它既不记为走过，
 *    也不记为跳过。这与账本那边「缺字段的行不许被算成 uses」是同一条纪律：
 *    **没确认 ≠ 没发生，也 ≠ 发生**。
 * 3. **必须能报"整条流程都没走"**。人可以说"这次什么都没做"，那就是一条**零步 run**
 *    ——但账本契约要求 `run.steps` 至少一项（见 `pipeline-runs` 的校验），所以那种情况
 *    本模块如实返回 `{ kind: "nothing" }` 而不是伪造一条空 run。
 */

/**
 * 造一份确认提案（纯函数，不落盘、不改任何状态）。
 *
 * 输入：
 * - `pipeline`：本次要走的流程（含 steps）
 * - `activities`：P1 产出的业务动作清单（`[{key, count, flags}]`），给人当参照
 * - `hints`：自动归属的候选（可空），**只作提示**
 *
 * 输出刻意把两类信息分开：
 * - `steps`：**流程自己的**步骤表（人在这里勾）
 * - `activities`：**观察到的**业务动作（人在这对照）
 * 两者不做自动配对——那正是被否决的那件事。
 */
export function buildProposal({ pipeline, activities = [], hints = null } = {}) {
  if (!pipeline || !Array.isArray(pipeline.steps)) {
    return { ok: false, reason: "no-pipeline" };
  }

  const steps = pipeline.steps.map((s) => ({
    id: s.id,
    title: s.title,
    // 步骤表里人写的 tool 原文——给对照用，不是匹配依据
    declared: typeof s.tool === "string" ? s.tool : "",
    // 机器给的候选提示：**只给一个次数**，不给命令行原文（原文含绝对路径）。
    // 它只是提示，不预选——人仍然要自己说这一步做没做。
    hintCount: Number.isFinite(hints?.[s.id]) ? hints[s.id] : 0
  }));

  return {
    ok: true,
    pipelineId: pipeline.id,
    steps,
    activities: activities.map((a) => ({ key: a.key, count: a.count, flags: a.flags || [] }))
    // 不返回 answers 词表：命令层有自己的解析表，写死两份只会漂。
    // 也不返回 pipelineTitle / observations：零消费者（ponytail 复核点名的两处）。
  };
}

/**
 * 校验并归一人的回答。
 *
 * `answers` 形如 `{ "P6": "done", "V2": "notDone" }`。
 * **只认三类值**，其余一律拒——静默把非法值当"没发生"是编造的一种。
 */
export function normalizeAnswers(answersResult, pipeline) {
  if (!pipeline || !Array.isArray(pipeline.steps)) return { ok: false, reason: "no-pipeline" };
  if (!answersResult || typeof answersResult !== "object" || Array.isArray(answersResult)) {
    return { ok: false, reason: "bad-answers" };
  }
  const ids = new Set(pipeline.steps.map((s) => s.id));
  const clean = {};
  for (const [id, value] of Object.entries(answersResult)) {
    if (!ids.has(id)) return { ok: false, reason: "unknown-step", stepId: id };
    if (value !== "done" && value !== "notDone" && value !== "unsure") {
      return { ok: false, reason: "bad-answer-value", stepId: id, value };
    }
    clean[id] = value;
  }
  return { ok: true, answers: clean };
}

/**
 * 把确认结果变成一条 run（**仍然不落盘**，落盘由调用方做）。
 *
 * 三种结局分得很清：
 * - `kind:"run"`：**至少一条记录**（`done` 或 `notDone`）→ 产出一条 run
 * - `kind:"nothing"`：**什么记录都没有**（全 unsure / 全没答）→ 不产 run
 * - `kind:"error"`：回答非法
 *
 * ⚠️ 一处容易写错的语义（本文档的注释最初就写错过，被测试抓出来）：
 * **「全部 notDone」不等于「零步」**。人确认"这两步这次都没做"是一条**合法且完整**的
 * 记录（两条 `skipped`），它描述的事实是"走了这条流程、但一步都没执行"。
 * 真正进 `nothing` 的只有**什么都没确认**（人没开口）——那才是没有信息可记。
 *
 * 关于 `notDone` 与 `unsure` 的差别（这是本模块最要紧的语义）：
 * - 人明确说 **notDone**（这一步这次没做）→ 记 `skipped: true`
 * - 人 **没回答**或说 **unsure** → **什么都不写**（既不 skipped 也不 uses）
 *   因为"没确认"与"确认没做"是两回事，混起来会把"忘了勾"记成"这步被跳过"，
 *   而跳过计数正是 `RETIRE_AFTER_SKIPS` 提议删步的依据——错一次就多一条错提议。
 */
export function runFromAnswers({ pipeline, answers, by = "human", triggeredBy = "", now = () => new Date() } = {}) {
  const normalized = normalizeAnswers(answers, pipeline);
  if (!normalized.ok) return { kind: "error", reason: normalized.reason, stepId: normalized.stepId, value: normalized.value };

  const at = new Date(now()).toISOString();
  const steps = [];
  for (const step of pipeline.steps) {
    const answer = normalized.answers[step.id];
    if (answer === "done") {
      steps.push({ id: step.id, at, skipped: false, detoured: false, refuted: false, note: "" });
    } else if (answer === "notDone") {
      steps.push({ id: step.id, at, skipped: true, detoured: false, refuted: false, note: "人确认这次没做" });
    }
    // unsure / 无回答 → 不写任何东西（见函数头注释）
  }

  if (steps.length === 0) {
    return {
      kind: "nothing",
      reason: "no-steps-confirmed",
      // 如实回报：哪些是"人确认没做"、哪些是"没答"
      notDone: pipeline.steps.filter((s) => normalized.answers[s.id] === "notDone").map((s) => s.id),
      unanswered: pipeline.steps.filter((s) => normalized.answers[s.id] === undefined).map((s) => s.id),
      unsure: pipeline.steps.filter((s) => normalized.answers[s.id] === "unsure").map((s) => s.id)
    };
  }

  return {
    kind: "run",
    run: { at, by, triggeredBy, steps },
    // 没写进账的两种原因分开报——「确认没做」与「没答」不该长得一样
    notDone: pipeline.steps.filter((s) => normalized.answers[s.id] === "notDone").map((s) => s.id),
    unanswered: pipeline.steps.filter((s) => normalized.answers[s.id] === undefined).map((s) => s.id),
    unsure: pipeline.steps.filter((s) => normalized.answers[s.id] === "unsure").map((s) => s.id)
  };
}
