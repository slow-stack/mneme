/**
 * M.O. 自动沉淀的**触发侧**：让「这个项目又重复走了一遍同一套动作」变成自动发生的观察，
 * 而不是等人想起来去点一下。
 *
 * 为什么单独一个文件：pipeline-nudge.js 是纯函数式的挖掘 / 落盘层（不碰宿主上下文，
 * 测试可以直接驱动）；触发时机、冷却、去重、错误兜底是**宿主接线**问题，混进那一层会
 * 让它不再纯粹。
 *
 * 三条执行侧边界（口径与 pipeline-nudge.js 的 NUDGE_BOUNDARIES 一致）：
 * - 只产 draft，且**自动跑一律不落草稿**（materialize 恒 false）——往别人仓库里塞文件
 *   必须是人的显式动作；
 * - 落进 memoryDir 的只是「提议」（proposal），升格成工作流仍然要人批；
 * - 一次跑不完就带着已读到的部分收工并如实标 budgetExceeded，**不重试、不排队补跑**：
 *   沉淀是锦上添花，卡住宿主是事故。
 */
import { projectRootOf } from "./pipeline-runner.js";
import { nudgeForProject, NUDGE_AUTO_BUDGET_MS, NUDGE_AUTO_MIN_INTERVAL_MS } from "./pipeline-nudge.js";

/**
 * 冷却不是防重复写盘（saveProposal 同 id 覆盖，本来就幂等），而是**观测新鲜度**：
 * 同一个项目的会话日志十分钟内不会长出新的重复模式，重跑只是把同样的解压开销再付一次。
 */
export function createNudgeAutoRun({
  ctx = null,
  memoryDir = null,
  logger = null,
  sessionGate = null,
  now = () => Date.now(),
  runNudge = nudgeForProject,
  minIntervalMs = NUDGE_AUTO_MIN_INTERVAL_MS,
  budgetMs = NUDGE_AUTO_BUDGET_MS,
  maxFiles = null
} = {}) {
  const log = logger || (ctx && ctx.logger) || null;
  let disposed = false;
  let timer = null;
  // 每个项目一条冷却记录；键是归一化后的项目根。
  const lastRunAt = new Map();
  // 已排队但还没跑的项目：同一个项目连来十个 turn/end，只跑最后一次。
  const pending = new Set();

  const normalize = (p) => {
    let s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[a-zA-Z]:\//.test(s)) s = s.toLowerCase();
    return s;
  };

  const runOne = (projectRoot) => {
    pending.delete(projectRoot);
    if (disposed) return null;
    lastRunAt.set(normalize(projectRoot), now());
    try {
      const doc = runNudge({
        projectRoot,
        memoryDir,
        // 自动跑：永不落草稿。它只在记忆库的 proposals 分桶里留提议。
        materialize: false,
        persistProposals: true,
        sessionGate,
        budgetMs,
        ...(maxFiles ? { maxFiles } : {})
      });
      // 静默是默认，但不许无声无息：只有真挖到东西时才说一句。
      if (doc && doc.counts && doc.counts.savedProposals > 0) {
        log?.info?.("[dsh-mneme] M.O. 自动沉淀：" + projectRoot + " 记录到 " + doc.counts.savedProposals + " 条重复模式（待人工确认）");
      }
      return doc;
    } catch (error) {
      // 自动跑的失败绝不能冒泡到 session/event——那条链上还挂着摘要与续期。
      log?.warn?.("[dsh-mneme] M.O. 自动沉淀失败（" + projectRoot + "）：" + String((error && error.message) || error));
      return null;
    }
  };

  // 队列里一个一个推进：一次 setTimeout 里连跑多个项目会把一帧拉长。
  const flush = () => {
    timer = null;
    if (disposed) return;
    const first = pending.values().next();
    if (first.done) return;
    runOne(first.value);
    if (pending.size > 0 && !disposed) defer();
  };

  const defer = () => {
    if (disposed || timer) return;
    // 解压会话日志是同步 I/O（本机 118 份实测 16.2s）。绝不在这里直接跑：当前这一帧
    // 是宿主的 turn/end 处理链，占住它等于让整个回合收尾卡住。setTimeout(0) 把它挪到
    // 下一个宏任务，宿主先收尾。
    timer = setTimeout(flush, 0);
    if (typeof timer.unref === "function") timer.unref();
  };

  const schedule = (projectRoot) => {
    const key = normalize(projectRoot);
    const last = lastRunAt.get(key);
    if (last !== undefined && now() - last < minIntervalMs) return;
    if (pending.has(projectRoot)) return;
    pending.add(projectRoot);
    defer();
  };

  const onSessionEvent = (session, event) => {
    if (disposed) return;
    if (sessionGate?.isOff(session)) return;
    // 只认 turn/end：一轮结束才算一个观测窗口，中途记的是半截。
    if (!event || event.type !== "turn/end") return;
    const projectRoot = projectRootOf(session);
    if (!projectRoot) return;
    schedule(projectRoot);
  };

  const unsubscribe = ctx && typeof ctx.on === "function" ? ctx.on("session/event", onSessionEvent) : null;

  const dispose = () => {
    disposed = true;
    pending.clear();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof unsubscribe === "function") unsubscribe();
  };
  // 手动入口与测试都要能直接驱动一次（不起 timer、不走冷却）。
  dispose.runNow = (projectRoot) => (disposed || !projectRoot ? null : runOne(projectRoot));
  dispose.pendingCount = () => pending.size;
  dispose.lastRunAt = (projectRoot) => lastRunAt.get(normalize(projectRoot));
  return dispose;
}
